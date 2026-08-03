# 常见 DAG 模式

本文档列出 OpenCLI workflow 常用的 DAG 编排模式，每种附完整 YAML 示例。设计 workflow 时先找到最接近的模式，再根据实际需求修改。

**注意**：workflow 的输入声明字段是 `inputs`（不是 `params`），引用时用 `$varname`（不是 `$params.varname`）；引擎不识别顶层 `version` 字段。LLM 处理用 `adapter: dashscope/chat`（不是 `type: ai`）。

---

## 1. 线性链（A -> B -> C）

最简单的模式：步骤串行执行，上一步输出喂给下一步。

**适用场景**：搜索 -> 获取详情 -> 导出

```yaml
name: linear-chain-example
description: 搜索商品 -> 获取详情 -> 导出结果

inputs:
  keyword: { type: string, default: "机械键盘" }

steps:
  search:
    adapter: site-a/search
    args:
      query: $keyword
      limit: 20
    output: search_results

  get_details:
    adapter: site-a/detail
    args:
      id: $item.id
    foreach: $search_results
    concurrency: 3
    output: details
    depends_on: [search]

  export:
    adapter: local/export-csv
    args:
      data: $details
      filename: "products.csv"
    output: export_result
    depends_on: [get_details]
```

**要点**：
- 每步 `depends_on` 只写直接上游
- `foreach` 把列表拆成逐条处理
- `concurrency: 3` 控制对站点的请求并发

---

## 2. 扇出（Fan-out：A -> B, C, D 并行）

一个数据源分发给多个独立处理器。

**适用场景**：同一批数据要在多个站点查询/发布

```yaml
name: fan-out-example
description: 获取商品列表后同时在三个平台查价格

inputs:
  keyword: { type: string, default: "iPhone 16" }

steps:
  fetch_source:
    adapter: source-site/search
    args:
      query: $keyword
    output: source_items

  check_price_a:
    adapter: site-a/search
    args:
      query: $item.title
    foreach: $source_items
    concurrency: 3
    output: prices_a
    depends_on: [fetch_source]

  check_price_b:
    adapter: site-b/search
    args:
      query: $item.title
    foreach: $source_items
    concurrency: 3
    output: prices_b
    depends_on: [fetch_source]

  check_price_c:
    adapter: site-c/search
    args:
      query: $item.title
    foreach: $source_items
    concurrency: 3
    output: prices_c
    depends_on: [fetch_source]
```

**要点**：
- `check_price_a`、`check_price_b`、`check_price_c` 都只依赖 `fetch_source`，自动并行
- 三个步骤可以用不同的 adapter（不同站点）
- 各自独立输出，互不影响

---

## 3. 扇入（Fan-in：B, C, D -> E 合并）

多个并行步骤的结果汇总后统一处理。

**适用场景**：多平台比价后合并排序

```yaml
name: fan-in-example
description: 多平台比价后合并找最低价

inputs:
  keyword: { type: string, default: "AirPods Pro" }

steps:
  search_site_a:
    adapter: site-a/search
    args:
      query: $keyword
    output: results_a

  search_site_b:
    adapter: site-b/search
    args:
      query: $keyword
    output: results_b

  search_site_c:
    adapter: site-c/search
    args:
      query: $keyword
    output: results_c

  merge_and_rank:
    adapter: dashscope/chat
    args:
      prompt: |
        合并以下三个平台的搜索结果，去重后按价格从低到高排序。
        输出 JSON 数组，每条包含 id, title, price, url, source 字段。

        平台 A 结果：
        $results_a

        平台 B 结果：
        $results_b

        平台 C 结果：
        $results_c
      json_mode: true
    output: merged_results
    depends_on: [search_site_a, search_site_b, search_site_c]
```

**要点**：
- 三个搜索步骤无依赖，自动并行
- `merge_and_rank` 的 `depends_on` 列出所有上游，等全部完成后执行
- 用 `dashscope/chat` + `json_mode: true` 做合并/去重/排序，prompt 里引用多个上游变量，返回值直接是解析后的 JSON 数组

---

## 4. 条件分支（Conditional Branch）

按条件走不同处理路径，最终合并。

**适用场景**：根据分类结果分别处理，然后汇总

```yaml
name: conditional-branch-example
description: 获取商品 -> LLM 分类 -> 按类别分别处理 -> 汇总

steps:
  fetch:
    adapter: site/list
    args:
      category: all
      limit: 50
    output: all_items

  classify:
    adapter: dashscope/chat
    args:
      prompt: |
        对以下商品分类，给每条加一个 category 字段（electronics / clothing / food）。
        输出 JSON 数组，保留原始所有字段。
        $all_items
      json_mode: true
    output: classified_items
    depends_on: [fetch]

  process_electronics:
    adapter: electronics-site/enrich
    args:
      id: $item.id
      title: $item.title
    foreach: $classified_items
    condition: $item.category == "electronics"
    concurrency: 5
    output: enriched_electronics
    depends_on: [classify]

  process_clothing:
    adapter: clothing-site/enrich
    args:
      id: $item.id
      title: $item.title
    foreach: $classified_items
    condition: $item.category == "clothing"
    concurrency: 5
    output: enriched_clothing
    depends_on: [classify]

  process_food:
    adapter: food-site/enrich
    args:
      id: $item.id
      title: $item.title
    foreach: $classified_items
    condition: $item.category == "food"
    concurrency: 3
    output: enriched_food
    depends_on: [classify]

  summarize:
    adapter: dashscope/chat
    args:
      prompt: |
        汇总以下三类商品的处理结果，生成一份报告。
        输出 JSON 对象，包含 total_count, by_category (各类别数量), highlights (每类前3) 字段。

        电子产品：$enriched_electronics
        服装：$enriched_clothing
        食品：$enriched_food
      json_mode: true
    output: report
    depends_on: [process_electronics, process_clothing, process_food]
```

**要点**：
- `condition` 对 foreach 的每条记录求值，为 false 则跳过
- 三个 process 步骤都 `depends_on: [classify]`，自动并行
- 最终 `summarize` 扇入所有分支结果
- condition 用 `==` 做字符串比较，用 `>` / `<` 做数值比较

---

## 5. Foreach 并发

对列表逐条执行操作，控制并发度。

**适用场景**：批量操作（批量发布 / 批量查询详情 / 批量下载）

```yaml
name: foreach-concurrency-example
description: 批量获取商品详情并发布到目标站点

inputs:
  source_category: { type: string, default: "热销" }

steps:
  list_products:
    adapter: source-site/list
    args:
      category: $source_category
      limit: 100
    output: products

  get_details:
    adapter: source-site/detail
    args:
      id: $item.id
    foreach: $products
    concurrency: 5
    on_error: skip
    output: product_details
    depends_on: [list_products]

  publish:
    adapter: target-site/publish
    args:
      title: $item.title
      price: $item.price
      url: $item.url
    foreach: $product_details
    concurrency: 2
    on_error: retry
    retries: 2
    output: publish_results
    depends_on: [get_details]
```

**要点**：
- `concurrency` 控制同时执行的任务数
- 读操作（get_details）可以适当高并发（5）
- 写操作（publish）用低并发（2），避免触发限流
- 读操作用 `on_error: skip`（单条失败不影响整体）
- 写操作用 `on_error: retry`（确保数据写入成功），配合 `retries` 显式设置重试次数

---

## 模式组合

实际 workflow 通常是多种模式的组合。常见组合：

| 组合 | 结构 | 典型场景 |
|------|------|---------|
| 线性 + foreach | A -> B(foreach) -> C | 搜索 -> 逐条详情 -> 汇总 |
| 扇出 + 扇入 | A -> B,C,D -> E | 多平台采集 -> 合并 |
| 条件 + foreach | A -> classify -> B(condition) | 分类后按类处理 |
| 扇出 + 条件 + 扇入 | A -> classify -> B,C,D(condition) -> E | 完整的分类处理管线 |

设计时先画出步骤关系图，再对号入座选模式。
