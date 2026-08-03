---
name: cliflow-workflow-author
description: Use when writing a cliflow workflow YAML to orchestrate multiple OpenCLI adapters. Guides from user intent through DAG design, YAML generation, validation, and test run.
allowed-tools: Bash(opencli:*), Bash(cliflow:*), Read, Edit, Write, Grep
---

# cliflow-workflow-author

你是要写 cliflow workflow YAML 的 agent。这份 skill 目标：**从用户意图到一个可运行的 workflow YAML，30 分钟内闭环**。

Workflow 是一个 DAG（有向无环图）模型：每个步骤声明自己依赖谁（`depends_on`），引擎自动推导并行度。没有依赖关系的步骤自动并行执行。

---

## 前置：环境检查

```
[ ] 0. 查历史 memory：cliflow memory <workflow-name>（如果已经在迭代同名 workflow）+ 对计划用到的每个 adapter 跑 cliflow memory adapter <site> —— 命中就直接参考历史限制/方案，避免重复踩坑
[ ] 1. opencli doctor 返回 "Everything looks good"
[ ] 2. opencli list 查看可用 adapter 列表
[ ] 3. 确认目标 adapter 都已安装（如果缺，先用 opencli-adapter-author skill 补齐）
[ ] 4. 如果任务复杂（3+ adapter、跨多站点），先用 cliflow-task-planner skill 拆解
```

---

## Workflow YAML 结构总览

```yaml
name: workflow-name          # workflow 标识名
description: 做什么的         # 一句话描述

# 输入声明（Ports & Adapters — 让 workflow 可复用）
inputs:
  keyword: { type: string, required: true, description: "搜索关键词" }
  max_items: { type: number, default: 10 }

# 输出声明（只暴露这些变量给调用方）
outputs: [final_result]

# workflow 级默认值（可选，步骤级字段会覆盖它们）
timeout: 1800                # 整个 workflow 的截止时间（秒），默认 1800（30 分钟）
max_parallel: 10              # 同时运行的最大步骤数，默认 10
on_error: stop                # 步骤未显式设置 on_error 时的默认策略

# 步骤是 map（不是 array），key 是步骤名
steps:
  step-name:
    adapter: site/command     # 调用哪个 adapter
    args:                     # 传给 adapter 的参数
      query: $keyword
    output:                   # 输出配置
      as: result_var          # 变量名，下游通过 $result_var 引用
      map:                    # Anti-Corruption Layer：字段映射
        title: name           # 领域名: adapter原始字段名
        link: url
    depends_on: []            # 依赖的步骤名列表（空 = 无依赖，自动并行）
    foreach: $prev_result     # 对上游输出逐条执行
    concurrency: 5            # foreach 并发数（默认 1）
    delay: 200                # foreach 单个 worker 连续两条之间的限流延迟（ms，默认 0）
    flatten: true              # foreach 结果是否展平（默认 true）
    condition: $item.price > 100  # 条件表达式，为 true 才执行
    confirm: "确认执行此操作？"   # 执行前的人工确认门（可选，bool 或提示文案）
    on_error: stop             # 错误策略：stop | skip | retry
    retries: 2                 # on_error: retry 时的重试次数（默认 1）
    timeout: 60                # 步骤超时（秒，默认 300，覆盖 foreach 全部迭代耗时）
    auth:                      # 需要登录态的 adapter，触发浏览器登录交互重试
      timeout: 120              # 等待用户完成登录的超时（秒，默认 120）
      on_timeout: skip          # 超时后的处理：skip | abort（默认 skip）
      max_retries: 1            # 登录后重新尝试 adapter 的次数（默认 1）

  llm_step_name:
    adapter: dashscope/chat    # LLM 处理用 adapter，不是独立的 step type
    args:
      prompt: |
        根据以下商品列表，挑选性价比最高的 3 个，输出 JSON 数组：
        $prev_step
      json_mode: true          # 要求结构化输出时开启，返回值直接是解析后的 JSON
    output: llm_result
    depends_on: [prev_step]

  interact_step_name:
    interact:                  # 纯人机交互节点，不调用 adapter
      type: select              # confirm | select | multi-select | input
      from: $items               # select/multi-select 的候选列表来源
      display: name              # 用哪个字段做展示文案
      message: "请选择一项"
    output: chosen

  nested-flow:
    type: workflow            # 嵌套子 workflow
    workflow: ./sub-process.yaml
    foreach: $items
    args:
      item_id: "$item.id"
    output: processed
    depends_on: [prev_step]
```

### 核心概念

| 概念 | 说明 |
|------|------|
| `steps` | map 结构，key 是步骤名（全局唯一），value 是步骤定义 |
| `adapter` | 格式 `site/command`，对应 `opencli <site> <command>` |
| `output` | 字符串（变量名）或对象（`{ as, map }`），下游用 `$varname` 引用 |
| `output.map` | Anti-Corruption Layer：adapter 原始字段 → 领域标准字段名 |
| `inputs` | Workflow 输入声明，支持 type/required/default/description |
| `outputs` | Workflow 输出声明，嵌套调用时只返回这些变量 |
| `type: workflow` | 嵌套调用另一个 YAML workflow |
| `depends_on` | 字符串数组，列出本步骤依赖的上游步骤名 |
| `foreach` | 引用上游输出变量，对每条记录执行本步骤 |
| `delay` | foreach 内单个 worker 连续两条之间的限流延迟（ms） |
| `flatten` | foreach 结果是否展平为一维数组，默认 `true` |
| `condition` | 表达式，引用 `$item` 或变量，为 true 才执行 |
| `confirm` | 执行前的人工确认门，`true` 或自定义提示文案 |
| `interact` | 纯人机交互节点：`confirm`/`select`/`multi-select`/`input`，不调用 adapter |
| `auth` | `true`/`"required"` 或 `{timeout, on_timeout, max_retries}`，触发登录交互重试 |
| `retries` | `on_error: retry` 时的重试次数，默认 1 |
| `timeout` | 步骤超时（秒），步骤级默认 300，workflow 级默认 1800 |
| `max_parallel` | workflow 级字段，同时运行的最大步骤数，默认 10 |
| LLM 处理 | 用 `adapter: dashscope/chat`（或 `llm/chat`）+ `args.prompt`，不是独立 step type |
| `$item.<field>` | foreach 内引用当前记录的字段 |
| `$varname` | 引用上游步骤的输出变量 |


---

## 顶层决策树

```
START
  |
  v
+-----------------------------+
| 用户意图明确吗？              |-- 不明确 --> 追问：要操作哪些站点？输入输出是什么？
+-----------------------------+
  | 明确
  v
+-----------------------------+
| opencli list 有需要的 adapter?|-- 缺 --> 先用 opencli-adapter-author 补齐
+-----------------------------+
  | 齐了
  v
+-----------------------------+
| 检查 adapter columns         |  opencli <site> <command> --help
| 确认字段名对得上             |  重点看 output columns
+-----------------------------+
  |
  v
+-----------------------------+
| 设计 DAG                    |  画步骤依赖关系
| 定 foreach / condition      |  哪些步骤要逐条？哪些要分支？
+-----------------------------+
  |
  v
+-----------------------------+
| 写 YAML                    |
+-----------------------------+
  |
  v
+-----------------------------+
| cliflow validate            |-- 失败 --> 修 YAML 格式 / 引用
+-----------------------------+
  | 通过
  v
+-----------------------------+
| cliflow run --dry-run       |-- 失败 --> 检查 adapter 参数 / 字段映射
+-----------------------------+
  | 通过
  v
+-----------------------------+
| 真实运行（去掉 --dry-run）    |
+-----------------------------+
  |
  v
DONE
```

---

## Runbook（一步一步勾选）

```
[ ] 0. 检查历史 memory：
       [ ] cliflow memory <workflow-name>（如果已经在迭代同名 workflow）
       [ ] 对每个计划用到的 adapter：cliflow memory adapter <site>
       [ ] 命中就直接参考历史限制/方案，跳过重复踩坑
[ ] 1. opencli doctor 返回 "Everything looks good"
[ ] 2. 理解用户意图：
       [ ] 输入数据来源（哪个站点 / 哪个命令）
       [ ] 处理逻辑（过滤 / 转换 / AI 判断）
       [ ] 输出目标（写入哪个站点 / 导出什么格式）
[ ] 3. 发现可用 adapter：
       [ ] opencli list -- 列出所有 adapter
       [ ] opencli <site> <command> --help -- 确认参数细节和 columns
       [ ] timeout 15 opencli <site> <command> --limit 1 -f json -- 小样本试跑，确认可达 + 真实字段名
[ ] 4. 检查 LLM 前置条件（如果计划用 dashscope/chat 或 llm/chat 做 LLM 处理）：
       [ ] echo $DASHSCOPE_API_KEY（用 dashscope/chat）或 echo $LLM_ENDPOINT / $OPENCLI_AI_ENDPOINT（用 llm/chat）— 必须非空
       [ ] 如果为空，改用 local/ adapter 做规则化处理
[ ] 5. 设计 DAG：
       [ ] 画出步骤依赖关系（哪些可以并行，哪些必须串行）
       [ ] 确定哪些步骤需要 foreach（逐条处理上游结果）
       [ ] 确定是否需要 condition（条件分支）
       [ ] 确定 on_error 策略（参考 references/error-strategies.md）
       [ ] 参考 references/dag-patterns.md 选择合适的 DAG 模式
       [ ] 不稳定步骤（外部 API）不放在关键路径上（防 skip 级联）
[ ] 6. 检查字段映射：
       [ ] 用 output.map 解耦 adapter 原始字段名
       [ ] $item.<field> 引用映射后的字段名（不是 adapter 原始字段名）
       [ ] workflow args 只能传 adapter 声明过的参数名
[ ] 7. 写 YAML：
       [ ] 文件放在项目根目录的 workflows/ 目录下
       [ ] 步骤名用 kebab-case（dash 自动转 underscore 作为变量名）
       [ ] output 变量名全局唯一
       [ ] timeout 按 foreach 总迭代量计算（不是单条超时）
[ ] 8. 验证 YAML：
       [ ] cliflow validate <file.yaml>
       [ ] 修复所有报错（循环依赖 / 引用不存在的步骤 / 字段不匹配）
[ ] 9. 预检（probing + args + env 全量检查）：
       [ ] cliflow preflight <file.yaml>
       [ ] 修复所有 errors，review 所有 warnings
[ ] 10. Dry-run 测试：
       [ ] cliflow run <file.yaml> --dry-run
       [ ] 检查每个步骤的模拟输出是否符合预期
[ ] 11. 真实运行：
       [ ] cliflow run <file.yaml>
       [ ] 检查最终输出
       [ ] 看命令末尾有没有 hint: 提示——有就照做（读历史笔记或记录本次发现）
```

---

## Adapter 发现与字段确认

写 YAML 前必须确认每个 adapter 的 columns。字段名是步骤间的数据契约，写错了下游拿到 undefined。

```bash
# 列出所有可用 adapter
opencli list

# 查看某个 adapter 的详情（args / columns / 用法）
opencli <site> <command> --help

# 试跑一次看真实输出
opencli <site> <command> [args...] --limit 3
```

重点关注：
- `columns` 列表——下游 `$item.<column_name>` 必须从这里选
- `args` 列表——`args:` 里只能传 adapter 支持的参数
- `browser: true/false`——browser adapter 在 workflow 里需要保持 browser 会话

---

## DAG 设计原则

### 1. 自动并行

没有 `depends_on` 的步骤自动并行执行。**不要人为串行化无依赖的步骤**。

```yaml
# 好：fetch_a 和 fetch_b 自动并行
steps:
  fetch_a:
    adapter: site-a/list
    output: items_a
  fetch_b:
    adapter: site-b/list
    output: items_b
  merge:
    depends_on: [fetch_a, fetch_b]
    # ...
```

### 2. depends_on 声明依赖

只有真正需要上游数据的步骤才加 `depends_on`。依赖多个上游用数组：

```yaml
merge:
  depends_on: [fetch_a, fetch_b, fetch_c]
```

### 3. foreach 逐条处理

对上游结果逐条执行某个操作：

```yaml
get_details:
  adapter: site/detail
  args:
    id: $item.id
  foreach: $search_results
  concurrency: 3
  output: details
  depends_on: [search]
```

- `$item` 代表当前遍历到的那条记录
- `concurrency` 控制并发数，默认 1，建议不超过 10（避免被站点限流）

### 4. condition 条件分支

```yaml
publish:
  adapter: site/publish
  args:
    id: $item.id
  foreach: $items
  condition: $item.score > 80
  depends_on: [score]
```

condition 为 false 的记录会被跳过，不报错。

### 5. LLM 处理

用 LLM 做中间处理（分类 / 摘要 / 决策）——**没有独立的 `type: ai` step type**，直接用 adapter 调用 LLM：

```yaml
classify:
  adapter: dashscope/chat      # 或 llm/chat（走 OPENCLI_AI_ENDPOINT / LLM_ENDPOINT）
  args:
    prompt: |
      将以下商品按类别分组，输出 JSON 数组，每条包含原始 id 和 category 字段：
      $raw_items
    json_mode: true            # 要求结构化输出
  output: classified
  depends_on: [fetch]
```

`json_mode: true` 时返回值直接是解析后的 JSON（数组或单对象），下游可以直接用 `$classified` 引用、`foreach: $classified`，不需要解包。不加 `json_mode` 时返回 `{content, model, usage_tokens}`，`content` 是纯文本。

**使用前确认环境变量**：`dashscope/chat` 需要 `DASHSCOPE_API_KEY`；`llm/chat` 需要 `LLM_ENDPOINT`（或 `OPENCLI_AI_ENDPOINT`）指向 OpenAI 兼容的 base URL。

### 6. auth 需要登录的 adapter

COOKIE/UI 等需要登录态的 adapter，加 `auth` 触发登录交互重试流程：

```yaml
xhs-search:
  adapter: xiaohongshu/search
  args:
    query: $keyword
  auth: required            # 等价于 auth: true
  on_error: skip
```

引擎发现 `AuthRequiredError` 后会弹出登录交互，等待用户完成登录再重试 adapter。可选对象形式精细控制：

```yaml
xhs-search:
  adapter: xiaohongshu/search
  auth:
    timeout: 120             # 等待用户登录的超时（秒），默认 120
    on_timeout: skip         # 超时后 skip | abort，默认 skip
    max_retries: 1           # 登录后重试 adapter 的次数，默认 1
```

### 7. interact 人机交互节点

不调用 adapter，直接向用户要输入。四种类型：

```yaml
choose-shop:
  interact:
    type: select              # confirm | select | multi-select | input
    from: $shops               # select/multi-select 的候选列表
    display: name               # 候选项展示用哪个字段
    message: "选择要操作的店铺"
  output:
    as: target_shop
    map: { shop_id: id, shop_name: name }

enter-keyword:
  interact:
    type: input
    message: "输入搜索关键词"
    default: "electronics"      # 用户不输入时的默认值
  output: keyword
  depends_on: [choose-shop]
```

`confirm` 类型返回布尔值；`select` 返回选中的单条记录；`multi-select` 返回选中记录数组；`input` 返回用户输入的字符串。测试/无人值守运行时用 `cliflow run --auto-approve` 自动应答所有 interact（confirm→true，select→第一项，multi-select→全选，input→用 default）。

**如果 interact 的选择会实际影响下游结果**（不是随便选都行），不要用 `--auto-approve`——它选第一项/全选，很可能选错。改用 `cliflow run --agent-mode`：只有当所有可继续执行的 step 都卡在 interact 上时才真正暂停，并一次性输出 `{status:"paused", pendingInteracts:[{stepName,spec},...]}`（互相无依赖的并发 interact 会批量收集，不是发现一个就中断），基于每项的 `spec` 和已完成步骤的 `context` 做出判断后，`cliflow run --resume <id> --agent-mode --answer '{"<step>":<答案>,...}'` 一次性回答本轮全部再继续。详见 `cliflow-workflow-lifecycle` skill 的 `--agent-mode` 章节。

### 8. confirm 执行前确认门

给单个 adapter step 加执行前确认，和 `interact` 不同——`confirm` 挂在普通 adapter step 上，不是独立节点：

```yaml
save-report:
  adapter: local/save-json
  confirm: "分析完成，是否保存报告？"   # 也可以直接写 confirm: true 用默认提示文案
  args:
    path: "./output/report.json"
    data: "$results"
```

---

## 字段映射与解耦（Anti-Corruption Layer）

Workflow 步骤之间通过变量传递数据。**不要直接引用 adapter 的原始字段名**——换 adapter 会导致所有下游步骤断裂。

### 方式 1：output.map（推荐）

用 `output.map` 在输出时映射字段名，下游只引用映射后的名字：

```yaml
search:
  adapter: npm/search
  args: { query: react, limit: 5 }
  output:
    as: packages           # 变量名
    map:                   # Anti-Corruption Layer
      pkg_name: name       # adapter 返回 {name: "react"} → 变为 {pkg_name: "react"}
      pkg_desc: description
      downloads: weeklyDownloads

detail:
  adapter: npm/package
  foreach: $packages
  args:
    name: "$item.pkg_name"   # 引用映射后的名字，不依赖 npm/search 的原始字段
```

**换 adapter 只改一处**：
```yaml
search:
  adapter: pypi/search       # 换了 adapter
  output:
    as: packages
    map:
      pkg_name: info.name    # 只改映射
      pkg_desc: info.summary
# ↓ 所有下游步骤不变 ↓
```

### 方式 2：args 内映射（简单情况）

上下游字段名不同但不需要全局解耦时，直接在 args 里映射：

```yaml
publish:
  adapter: target-site/create
  args:
    name: $item.title       # 上游叫 title，下游参数叫 name
    link: $item.url         # 上游叫 url，下游叫 link
  foreach: $source_items
```

### 方式 3：LLM 步骤做复杂转换

字段需要计算、合并、拆分时，用 `adapter: dashscope/chat` + `json_mode: true` 处理。

### 选择规则

| 场景 | 方式 | 原因 |
|------|------|------|
| adapter 输出字段名不规范 | `output.map` | 从源头归一化 |
| 多个 adapter 可替换 | `output.map` | 换 adapter 只改 map |
| 上下游参数名不同（一对一） | args 映射 | 简单直接 |
| 需要计算/合并/格式转换 | LLM 步骤 | map 只做重命名，不做计算 |

详细规范见 [`references/field-mapping.md`](./references/field-mapping.md)。

---

## 验证与测试

### 静态验证

```bash
cliflow validate my-workflow.yaml
```

检查项：
- YAML 语法正确
- 所有 `depends_on` 引用的步骤名存在
- 无循环依赖
- 变量引用有效（`$varname` 和 `${{ args.xxx }}` 语法都会检查）
- `adapter` 格式为 `site/command`
- `inputs` 声明的变量不会被误报为未定义

### Dry-run 测试

```bash
cliflow run my-workflow.yaml --dry-run
```

展示 DAG 执行层级和步骤依赖关系，不真正调用 adapter。

### 小规模测试

```bash
# 传参限制数据量
cliflow run my-workflow.yaml --arg limit=3 -v

# JSON 格式查看完整输出
cliflow run my-workflow.yaml --arg limit=3 -f json
```

**先用小数据集跑通，再放大数据量**。`--arg` 传入的参数对应 `inputs` 声明。

### 真实运行

```bash
cliflow run my-workflow.yaml --arg keyword="搜索词" --arg limit=100
```

加 `-v` 查看每个步骤的详细日志。加 `-f json` 获取机器可读输出。运行结束后如果末尾出现
`hint:` 提示，照着执行——这是引擎发现有相关历史 memory 或值得记录本次发现时打印的。

### 遇到问题

切换到 `cliflow-workflow-debugger` skill 进行排查。

---

## Workflow 组合与复用

Workflow 可以被其他 workflow 嵌套调用。声明 `inputs` / `outputs` 让 workflow 成为可复用的组件。

详细指南见 [`references/composability.md`](./references/composability.md)。

### 快速示例

```yaml
# sub-process.yaml — 子 workflow
name: enrich-item
inputs:
  item_id: { type: string, required: true }
  item_name: { type: string, required: true }
outputs: [enriched]

steps:
  fetch-detail:
    adapter: site/detail
    args: { id: $item_id }
    output: detail

  enrich:
    adapter: site/enrich
    args: { id: $item_id, data: $detail }
    output: enriched
    depends_on: [fetch-detail]
```

```yaml
# parent.yaml — 父 workflow
steps:
  list:
    adapter: site/list
    output: items

  process:
    type: workflow
    workflow: ./sub-process.yaml
    foreach: $items
    concurrency: 3
    args:
      item_id: "$item.id"
      item_name: "$item.name"
    output: results
    depends_on: [list]
```

---

## 常见 DAG 模式

详细示例见 [`references/dag-patterns.md`](./references/dag-patterns.md)。

| 模式 | 适用场景 | 关键点 |
|------|---------|--------|
| 线性链 | A 的输出喂给 B，B 的输出喂给 C | 每步 depends_on 上一步 |
| 扇出（Fan-out） | 一个数据源分发给多个处理器 | 多个步骤 depends_on 同一个上游 |
| 扇入（Fan-in） | 多个结果合并后统一处理 | 一个步骤 depends_on 多个上游 |
| 条件分支 | 按条件走不同处理路径 | condition 表达式 |
| Foreach 并发 | 对列表逐条调用 | foreach + concurrency |

---

## 降级路径（某步卡住跳到哪）

| 卡在 | 现象 | 跳去 |
|------|------|------|
| Step 3 adapter 发现 | `opencli list` 没有需要的 adapter | 用 opencli-adapter-author skill 写一个 |
| Step 6 字段映射 | 上游 columns 和下游 args 对不上 | 检查 adapter --help；可能需要加 LLM 步骤（dashscope/chat）做转换 |
| Step 8 validate 失败 | 循环依赖 | 检查 depends_on 有没有互相引用 |
| | 引用不存在的步骤 | 检查步骤名拼写 |
| | 字段不匹配 | 回 Step 3 重新确认 adapter columns |
| Step 10 dry-run 失败 | adapter 参数错误 | opencli <site> <command> --help 重新确认 args |
| | foreach 展开后无数据 | 检查上游步骤是否有输出 |
| Step 11 真实运行失败 | adapter 报 AuthRequiredError | 先手动登录一次：opencli <site> login |
| | 某步骤超时 | 降低 concurrency / 加 on_error: retry |

---

## 参考文件

| 文件 | 什么时候翻 |
|------|----------|
| `references/dag-patterns.md` | 设计 DAG 时：线性链 / 扇出 / 扇入 / 条件分支 / foreach 并发 |
| `references/field-mapping.md` | 字段映射时：跨站点标准字段名 + output.map 用法 |
| `references/error-strategies.md` | 选 on_error 策略时：stop / skip / retry 语义 |
| `references/composability.md` | 需要 workflow 嵌套复用时：inputs/outputs 声明 + type: workflow |
| `references/testing-guide.md` | 测试和调试时：单步测试 + 输出检查 + 常见失败 |

### 真实示例（可直接参考真实写法）

| 文件 | 演示内容 |
|------|---------|
| `workflows/auth-verify-advanced.yaml` | 综合能力演示：四路并行采集、`auth: required` 登录交互、`interact`/`confirm`、`retries`、`dashscope/chat` 做 LLM 分析、多级本地计算链 |
| `workflows/interact-demo.yaml` | `interact` 全部四种类型：`select`/`multi-select`/`input`/`confirm` |
| `workflows/tech-pulse.yaml` | 多源并行采集 + foreach 嵌套 workflow 详情丰富化 + `on_error: skip` 容错 |

---

## 关键约定

- **steps 是 map 不是 array**：key 是步骤名，不要用 `- step_name:` 的 array 语法
- **步骤名可用 kebab-case**：`fetch-products`，输出变量自动转为 `fetch_products`（dash → underscore）
- **output 变量名全局唯一**：不能两个步骤用同一个 output 名
- **用 output.map 解耦**：下游不要直接引用 adapter 原始字段名，用 map 映射到领域名
- **声明 inputs/outputs**：每个 workflow 都应声明输入输出，让它可被嵌套复用
- **$item 只在 foreach 内有效**：没有 foreach 的步骤里写 `$item.xxx` 会报错
- **需要 json_mode: true 才能结构化引用 LLM 输出**：prompt 里明确要求输出 JSON，并加 `json_mode: true`，否则下游拿到的是纯文本 `content`
- **concurrency 不要设太高**：建议 3-5，最多 10，避免被站点限流
- **on_error 默认是 stop**：如果某些步骤失败可以容忍，显式设 skip 或 retry
- **禁止循环依赖**：A depends_on B 且 B depends_on A 会被 validate 拒绝
- **变量名不含 dash**：`$batch_id` 合法，`$batch-id` 不合法（dash 被解析为减号）

---

## 卡住了

- DAG 设计不确定：翻 `references/dag-patterns.md`，找最接近的模式
- 字段映射不确定：翻 `references/field-mapping.md`，用标准字段名
- 错误处理不确定：翻 `references/error-strategies.md`，按场景选策略
- adapter 不存在：切到 opencli-adapter-author skill 先写 adapter
- validate 报错看不懂：贴完整报错，逐条修

不要猜字段名。`$item.title` 还是 `$item.name`，翻 adapter --help 确认。猜错了 dry-run 能过但真实运行拿到 undefined。
