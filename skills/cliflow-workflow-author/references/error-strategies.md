# on_error 错误处理策略

workflow 步骤的 `on_error` 字段决定步骤出错时的行为。默认是 `stop`。

---

## 三种策略

### stop（默认）

步骤出错后**立即终止整个 workflow**。所有未完成的步骤取消，已完成的步骤结果保留。

```yaml
critical_step:
  adapter: site/important-action
  args:
    id: $item.id
  on_error: stop     # 默认值，可省略
```

**适用场景**：
- 核心写操作（支付、发布、删除）——失败了必须立刻停下来人工检查
- 数据源获取——源头拿不到数据，后续所有步骤都没意义
- 有副作用的操作——继续执行可能导致数据不一致

**典型用例**：
```yaml
steps:
  transfer_money:
    adapter: bank/transfer
    args:
      amount: $item.amount
      to: $item.account
    foreach: $payment_list
    on_error: stop       # 转账失败必须停！
    depends_on: [validate]
```

---

### skip

步骤出错后**跳过该条记录，继续处理剩余记录**。失败的记录会被记录在日志里，但不影响整体流程。

```yaml
get_details:
  adapter: site/detail
  args:
    id: $item.id
  foreach: $items
  on_error: skip
```

**适用场景**：
- 批量读操作——个别商品下架/404 不影响整体采集
- 非关键步骤——某条数据丰富失败，用空值也能接受
- 大量数据处理——100 条里失败 2 条可以容忍

**行为细节**：
- foreach 里某条 skip 后，该条不会出现在 output 里
- 下游步骤收到的是过滤后的结果（不含 skip 的条目）
- skip 不是 silent 的——日志里会记录哪些条目被跳过及原因

**典型用例**：
```yaml
steps:
  fetch_prices:
    adapter: site-a/price
    args:
      id: $item.id
    foreach: $product_ids
    concurrency: 5
    on_error: skip       # 个别商品下架，跳过继续
    output: prices
    depends_on: [list_products]
```

---

### retry

步骤出错后**自动重试**，默认重试 1 次（`retries` 字段可显式配置次数），每次间隔指数退避（封顶 30 秒，带随机抖动）。全部重试失败后按 stop 处理（终止 workflow）。

```yaml
publish:
  adapter: site/publish
  args:
    title: $item.title
    content: $item.content
  foreach: $articles
  on_error: retry
  retries: 3        # 显式设置重试次数，不写默认只重试 1 次
```

**适用场景**：
- 网络不稳定——偶尔超时，重试大概率成功
- 限流/429——等一会儿再试
- 写操作要保证成功——发布、更新、同步

**行为细节**：
- 重试次数：`on_error: retry` 时默认 `retries ?? 1`（默认只重试 1 次，共执行最多 2 次）；显式设 `retries: N` 可以加大次数
- 退避策略：指数退避 `min(1000 * 2^(attempt-1), 30000)`，即 1s → 2s → 4s → 8s ... 封顶 30s，并叠加约 30% 的随机抖动（避免多个失败请求同时重试造成惊群）
- 网络类瞬时错误（超时、连接失败）即使没设 `on_error: retry` 也会自动重试至少 1 次
- 错误在重试过程中被重新分类为"配置错误"（如参数不合法）会提前终止重试，不会耗尽剩余次数
- 全部重试失败：按 stop 处理，终止 workflow
- foreach 里某条重试期间，其他条正常并发执行

**典型用例**：
```yaml
steps:
  sync_to_target:
    adapter: target-site/create
    args:
      title: $item.title
      price: $item.price
      url: $item.url
    foreach: $source_items
    concurrency: 2        # 写操作低并发
    on_error: retry        # 网络抖动自动重试
    retries: 2              # 最多重试 2 次
    output: sync_results
    depends_on: [fetch_source]
```

---

## 策略选择速查

| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| 支付 / 转账 / 删除 | **stop** | 有副作用，失败必须立刻人工介入 |
| 核心数据源获取 | **stop** | 源头没数据，后续全白跑 |
| 批量读取 / 采集 | **skip** | 个别失败可容忍 |
| 数据丰富 / 补充详情 | **skip** | 缺部分字段不影响主流程 |
| 发布 / 更新 / 同步 | **retry** | 网络问题导致的失败，重试通常能解决 |
| 调用外部 API | **retry** | 偶发超时/限流 |
| LLM adapter 调用 | **retry** | LLM 调用偶尔超时 |

---

## 组合使用

同一个 workflow 里不同步骤可以用不同策略：

```yaml
steps:
  # 源头数据必须拿到
  fetch_source:
    adapter: source/list
    args:
      category: $params.category
    output: items
    on_error: stop          # 源头失败 = 整个 workflow 没意义

  # 批量获取详情，个别失败可跳过
  get_details:
    adapter: source/detail
    args:
      id: $item.id
    foreach: $items
    concurrency: 5
    on_error: skip           # 个别 404 没关系
    output: details
    depends_on: [fetch_source]

  # 发布到目标站点，要确保写入成功
  publish:
    adapter: target/create
    args:
      title: $item.title
      price: $item.price
    foreach: $details
    concurrency: 2
    on_error: retry          # 写操作重试保成功
    output: results
    depends_on: [get_details]
```

---

## 常见陷阱

| 陷阱 | 后果 | 解法 |
|------|------|------|
| 写操作用 skip | 部分数据没写入，但 workflow 显示成功 | 写操作用 retry 或 stop |
| 读操作用 stop | 一条 404 导致整个采集中断 | 批量读用 skip |
| retry 没降 concurrency | 重试加原本高并发 = 更严重的限流 | retry 搭配 concurrency: 2-3 |
| 全部步骤都用 stop | workflow 很脆弱，任何小错都中断 | 按场景区分策略 |
| 全部步骤都用 skip | 大面积失败被静默吞掉 | 核心步骤必须 stop 或 retry |
| skip 导致级联崩溃 | 整步失败后输出变量 undefined，下游全部跟着失败 | 见下方「skip 级联效应」 |
| timeout 设太短 | foreach 还没跑完就整步超时 | 按 foreach 总迭代计算 timeout |

---

## timeout 语义

`timeout` 是**步骤级别**的超时，覆盖整个步骤的执行时间（包括 foreach 的全部迭代），不是每条迭代的超时。

```
foreach 20 items × concurrency 5 → 4 轮
每轮最慢的那条需要 10s → 4 轮 × 10s = 40s 最小总耗时
timeout 应设为 40 × 1.5 ≈ 60（留余量）
```

**计算公式**：`timeout ≈ ceil(items / concurrency) × per_item_time × 1.5`

```yaml
# 错误：20 条 × concurrency 3 → 7 轮 × 10s = 70s 最少，但只给了 30s
get-details:
  foreach: $items      # 20 items
  concurrency: 3
  timeout: 30          # 太短！

# 正确：
get-details:
  foreach: $items      # 20 items
  concurrency: 3
  timeout: 120         # 7 轮 × 10s × 1.7 ≈ 120
```

---

## skip 级联效应

当一个使用 `on_error: skip` 的步骤**整步失败**（不是 foreach 中的单条失败）时：

1. 该步骤的输出变量**不会被设置**（值为 undefined）
2. 所有依赖该变量的下游步骤引用到 undefined → 也失败 → 也被 skip
3. 形成级联失败链，但 workflow 最终显示 "completed"（因为所有失败都被 skip 吞了）

```
真实案例：
  get-profiles (on_error: skip) → 502 全超时 → $profiles = undefined
  rank-authors (depends_on: get-profiles) → $profiles undefined → 失败 → skip
  save-report (depends_on: rank-authors) → $ranking undefined → 保存空文件
  workflow status: "completed" ← 看起来成功了，实际什么有效数据都没有
```

### 防御策略

**1. 核心路径不用 skip**

数据源获取步骤用 `stop`——源头没数据，后续全是空转：

```yaml
fetch-source:
  adapter: site/list
  on_error: stop    # 源头失败 = 必须停下来，不要假装成功
```

**2. 下游只依赖"一定能产出数据"的步骤**

如果步骤 A 不稳定（可能整步失败），不要让关键下游直接依赖它。设计降级路径：

```yaml
# 错误：rank 依赖不稳定的 get-profiles
rank:
  args: { items: "$profiles" }    # profiles 可能 undefined
  depends_on: [get-profiles]

# 正确：rank 依赖一定有数据的 extract-authors
rank:
  args: { items: "$authors" }     # authors 来自 local adapter，稳定
  depends_on: [extract-authors]
```

**3. 补充数据作为并行增强，不放在关键路径上**

```yaml
# search-papers 是"锦上添花"，失败不影响主流程
search-papers:
  on_error: skip
  depends_on: [extract-authors]

rank-authors:
  depends_on: [extract-authors]    # 不依赖 search-papers

save-report:
  depends_on: [rank-authors, search-papers]  # save 等两者都完成，但 papers 为空也没关系
```
