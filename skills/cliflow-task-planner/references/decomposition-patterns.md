# 任务分解模式

本文档覆盖常见的自动化任务类型及其分解策略。每种模式附完整的原子操作清单和 workflow 骨架。

---

## 模式 1：名单处理管线（List → Enrich → Filter → Output）

最常见的模式。从一个源获取列表，逐条丰富数据，过滤/排序后输出。

### 用户描述示例
- "从 XX 网站获取排行榜，搜索每个人的详细信息，找出评分最高的"
- "拿到商品列表，逐个查价格，比较后导出最便宜的"

### 原子分解

```
Step 1: 获取名单       → adapter: source-site/list
Step 2: 逐条搜索       → adapter: info-site/search (foreach)
Step 3: 排名/筛选      → adapter: dashscope/chat 或 local/rank
Step 4: 输出结果       → adapter: local/save-json 或 local/excel-write
Step 5: (可选)上传     → adapter: target-site/upload
```

### Workflow 骨架

```yaml
name: list-enrich-pipeline
inputs:
  query: { type: string, required: true }
  top_n: { type: number, default: 10 }
outputs: [ranked]

steps:
  fetch-list:
    adapter: source/list
    args:
      query: $query
      limit: 50
    output:
      as: candidates
      map:
        name: <source-field>
        id: <source-field>

  enrich:
    adapter: info-site/search
    foreach: $candidates
    concurrency: 3
    on_error: skip
    args:
      query: "$item.name"
    output:
      as: enriched
      map:
        name: <source-field>
        score: <source-field>
        detail_url: <source-field>
    depends_on: [fetch-list]

  rank:
    adapter: dashscope/chat
    args:
      prompt: |
        对以下人员按综合评分排名，取前 $top_n 名。
        输出 JSON 数组，每条包含 name, score, rank 字段。
        $enriched
      json_mode: true
    output: ranked
    depends_on: [enrich]

  save:
    adapter: local/save-json
    args:
      path: "output/ranked-results.json"
    depends_on: [rank]
```

**关键点**：
- `output.map` 映射 adapter 原始字段到领域名，下游引用 `$item.name` 而非 adapter 特有字段
- `on_error: skip` 用于 enrich 步骤，个别搜索失败不影响整体
- LLM 步骤（`dashscope/chat` + `json_mode: true`）做排名/筛选，不需要写 adapter
- 声明 `inputs`/`outputs`，workflow 可被嵌套复用

---

## 模式 2：多源聚合（Multi-Source Merge）

从多个来源收集数据，合并后统一处理。

### 用户描述示例
- "分别从 3 个平台搜索，合并后去重排序"
- "从 GitHub、HN、arXiv 收集技术动态"

### 原子分解

```
Step 1a: 源 A 获取      → adapter: site-a/search (并行)
Step 1b: 源 B 获取      → adapter: site-b/search (并行)
Step 1c: 源 C 获取      → adapter: site-c/search (并行)
Step 2:  合并去重排序   → adapter: dashscope/chat
Step 3:  输出          → adapter: local/save-json
```

### Workflow 骨架

```yaml
name: multi-source-merge
inputs:
  keyword: { type: string, required: true }

steps:
  search-a:
    adapter: site-a/search
    args: { query: $keyword, limit: 20 }
    output:
      as: results_a
      map: { title: <a-field>, url: <a-field>, score: <a-field> }

  search-b:
    adapter: site-b/search
    args: { query: $keyword, limit: 20 }
    output:
      as: results_b
      map: { title: <b-field>, url: <b-field>, score: <b-field> }

  search-c:
    adapter: site-c/search
    args: { query: $keyword, limit: 20 }
    output:
      as: results_c
      map: { title: <c-field>, url: <c-field>, score: <c-field> }

  merge:
    adapter: dashscope/chat
    args:
      prompt: |
        合并以下三个来源的搜索结果，按 score 降序去重排列。
        输出 JSON 数组，每条包含 title, url, score, source 字段。
        来源 A：$results_a
        来源 B：$results_b
        来源 C：$results_c
      json_mode: true
    output: merged
    depends_on: [search-a, search-b, search-c]
```

**关键点**：
- 三个搜索步骤无 `depends_on`，自动并行
- 每个源用 `output.map` 映射到统一字段名（title, url, score）
- 合并步骤扇入所有源，`depends_on` 列出全部上游
- LLM 步骤（`dashscope/chat` + `json_mode: true`）处理去重和排序

---

## 模式 3：数据迁移管线（Extract → Transform → Load）

从源系统提取，转换格式，加载到目标系统。

### 用户描述示例
- "把旧系统的商品搬到新平台上"
- "从 Excel 读数据，批量上传到网站"

### 原子分解

```
Step 1: 提取数据       → adapter: source/export 或 local/read-excel
Step 2: 转换格式       → adapter: dashscope/chat 或 local/transform
Step 3: 批量写入       → adapter: target/create (foreach + retry)
Step 4: 汇总报告       → adapter: dashscope/chat
```

### Workflow 骨架

```yaml
name: data-migration
inputs:
  source_path: { type: string, required: true }

steps:
  extract:
    adapter: local/read-excel
    args: { path: $source_path }
    output:
      as: raw_items
      map: { name: <excel-col>, value: <excel-col> }

  transform:
    adapter: dashscope/chat
    args:
      prompt: |
        将以下数据转换为目标格式。每条记录需要：
        - title: 名称（不超过 50 字）
        - description: 描述（不超过 200 字）
        - price: 价格（数值）
        输出 JSON 数组。
        $raw_items
      json_mode: true
    output: transformed
    depends_on: [extract]

  load:
    adapter: target-site/create
    foreach: $transformed
    concurrency: 2
    on_error: retry
    args:
      title: "$item.title"
      description: "$item.description"
      price: "$item.price"
    output: results
    depends_on: [transform]
```

**关键点**：
- 写操作用低并发 `concurrency: 2` + `on_error: retry`
- 转换步骤可以用 LLM（dashscope/chat）或本地 adapter，视复杂度而定
- 简单转换（字段重命名）用 `output.map`，复杂转换（计算、合并）用 LLM 步骤

---

## 模式 4：监控 + 条件处理（Watch → Classify → Route）

定期检查状态，按条件执行不同操作。

### 用户描述示例
- "监控价格，降到阈值以下就自动下单"
- "检查库存，缺货的自动补货"

### 原子分解

```
Step 1: 检查状态       → adapter: site/check
Step 2: 分类          → adapter: dashscope/chat
Step 3a: 路径 A 处理   → adapter: site/action-a (condition)
Step 3b: 路径 B 处理   → adapter: site/action-b (condition)
Step 4: 通知          → adapter: local/notify 或 email/send
```

---

## 模式 5：嵌套组合（Workflow 调 Workflow）

将可复用的子流程封装为独立 workflow，父 workflow 通过 `type: workflow` 调用。

### 用户描述示例
- "对每个商品执行一套标准的审核流程"
- "每个人先做背景调查，再做评分"

### 分解策略

1. 识别可复用的子流程（对每条记录做相同处理）
2. 子流程封装为独立 YAML，声明 `inputs` / `outputs`
3. 父 workflow 用 `type: workflow` + `foreach` 调用

```yaml
# parent.yaml
steps:
  fetch:
    adapter: source/list
    output: items

  process-each:
    type: workflow
    workflow: ./sub-process.yaml
    foreach: $items
    concurrency: 3
    args:
      item_id: "$item.id"
      item_name: "$item.name"
    output: processed
    depends_on: [fetch]
```

```yaml
# sub-process.yaml
name: sub-process
inputs:
  item_id: { type: string, required: true }
  item_name: { type: string, required: true }
outputs: [result]

steps:
  validate: ...
  enrich: ...
  score: ...
```

**关键点**：
- 子 workflow 必须声明 `inputs`（required 约束）和 `outputs`（返回范围）
- 父 workflow 用 `resolveArgsTyped` 传参，保留原始类型
- 子 workflow 只返回 `outputs` 声明的变量，不暴露内部步骤

---

## 分解决策树

```
用户任务
  ├─ 有几个数据源？
  │   ├─ 1 个 → 模式 1（线性管线）
  │   └─ 多个 → 模式 2（多源聚合）
  │
  ├─ 需要写入目标系统？
  │   ├─ 批量写入 → 模式 3（ETL）
  │   └─ 条件触发 → 模式 4（监控+条件）
  │
  ├─ 有可复用的子流程？
  │   └─ 是 → 模式 5（嵌套组合）
  │
  └─ 混合型 → 组合多个模式
```

实际任务通常是多个模式的组合。先识别主干模式，再嵌入其他模式作为子步骤。
