---
name: cliflow-workflow-debugger
description: Use when a cliflow workflow fails, produces unexpected results, or needs step-by-step debugging. Guides through failure diagnosis, output inspection, and checkpoint resume.
allowed-tools: Bash(opencli:*), Bash(cliflow:*), Read, Edit, Write, Grep
---

# cliflow-workflow-debugger

你在调试一个运行失败或输出不符预期的 workflow。这份 skill 目标：**定位问题根因，修复后重新运行成功**。

---

## 诊断流程

```
[ ] 0. 先查 memory：cliflow memory <workflow-name>，命中直接按历史方案处理
[ ] 1. 运行 preflight 获取完整诊断报告
[ ] 2. 根据 preflight 结果定位问题类别
[ ] 3. 隔离失败步骤，独立测试
[ ] 4. 修复问题
[ ] 5. 重新运行（或从 checkpoint 恢复）
[ ] 6. 把根因和修法记入 memory，供下次直接复用
```

---

## 第一步：Preflight 诊断

**开始前**：先查有没有历史记录——`cliflow memory <workflow-name>`。如果失败步骤对应的 adapter
有已知问题，`cliflow memory adapter <site>` 也查一下。命中就直接按历史方案处理，不用重新走
下面的排查流程。

**首选**：用 `cliflow preflight` 一次性检查所有前置条件（支持 `-f json` 输出）：

```bash
cliflow preflight my-workflow.yaml -f json
```

Preflight 会自动检查并报告：
- YAML 语法和 DAG 合法性
- 每个 adapter 的可用性（probe）
- args 是否匹配 adapter 声明
- output.map 字段名是否正确
- AI 环境变量和浏览器桥接状态
- 嵌套子 workflow 文件

如果 preflight 发现了问题，根据报告中的 category 和 detail 直接修复。

**补充诊断**（preflight 通过但运行时仍有问题时）：

```bash
# 运行并获取 JSON 结果
cliflow run my-workflow.yaml --auto-approve -f json --arg limit=3
```

从 JSON 输出中提取 `id`（runId）和 `status`。如果 `status !== "completed"`：

**先排除一种非故障情况**：`status === "paused"` 不是失败，是 `--agent-mode` 运行时在 interact 节点正常暂停（`terminationReason: "paused"`）。`pendingInteracts` 是数组，可能同时包含多个互相无依赖的 interact（批量收集，不是逐个暴露）——逐项看 `spec` 做决策，然后 `cliflow run --resume <id> --agent-mode --answer '{"<step>":<答案>,...}'` 一次性回答全部再继续，不要当成 bug 去排查。

真正的失败（`status === "failed"` 或 `"partial"`）：

```bash
# 用 trace --summary 获取 agent 友好的诊断报告
cliflow trace <runId> --summary
```

Trace summary 会显示：
- 每个步骤的状态、耗时、错误类型
- 错误 cause chain（逐层追溯根因）
- 被跳过步骤的原因（哪个依赖失败导致跳过）
- 数据流图（哪个变量被哪个步骤消费）
- foreach 的成功/失败项数

**根据 trace summary 中的 errorType 对照修复方向**：

| errorType | 含义 | 修复方向 |
|-----------|------|---------|
| `AuthRequiredError` | adapter 需要登录凭证 | `opencli <site> login` 或添加 `auth` 字段 |
| `TimeoutError` | 步骤超时 | 增加 `timeout`、降低 `concurrency` |
| `StepSkippedError` | 依赖步骤失败导致跳过 | 先修复上游失败步骤 |
| `CommandError` | adapter 命令执行失败 | 单独 `opencli <site> <cmd>` 测试，检查参数 |
| `GenericError` | 未分类错误 | 查看 cause chain 中的详细信息 |

### 错误信息解读

| 错误关键词 | 含义 | 排查方向 |
|-----------|------|---------|
| `requires input "xxx"` | 缺少必需的输入参数 | 检查 --arg 或父 workflow 的 args |
| `Adapter not found: site/command` | adapter 未注册 | `opencli list \| grep site` |
| `Command failed` | adapter 执行报错 | 单独运行 adapter 看详细错误 |
| `Step "xxx" timed out` | 步骤超时（默认 300s） | 降低 concurrency 或增加 timeout |
| `Cycle detected` | DAG 有循环依赖 | 检查 depends_on 声明 |
| `Variable resolution returned undefined` | 变量解析失败 | 检查变量名、depends_on 链 |
| `Nested workflow "xxx" failed` | 子 workflow 失败 | 单独运行子 workflow 排查 |

---

## 第二步：隔离测试

### 测试单个 adapter

```bash
# 确认 adapter 存在
opencli list | grep "site/command"

# 查看参数
opencli site command --help

# 用与 workflow 相同的参数运行
opencli site command --arg1 "value-from-workflow"

# JSON 格式查看完整输出字段
opencli site command --arg1 "value" -f json
```

### 测试子 workflow

```bash
# 直接运行子 workflow（提供 required inputs）
cliflow run sub-process.yaml --arg item_id=test-1 --arg item_name="test" -v
```

### 测试变量解析

在 `-v` 模式下观察日志中的变量解析信息。如果看到 `Variable resolution returned undefined`：

1. 检查变量名拼写
2. 检查上游步骤的 `output` 是否正确声明
3. 检查 `depends_on` 是否包含产出该变量的步骤
4. 如果用了 `output.map`，检查映射后的字段名

---

## 第三步：常见问题修复

### 问题 1：$varname 为 undefined

**症状**：步骤 args 中的 `$varname` 解析为 undefined

**检查清单**：
```
[ ] 变量名拼写正确？（注意变量名不含 dash）
[ ] 上游步骤有 output 声明？
[ ] depends_on 包含了上游步骤？
[ ] 上游步骤实际执行了？（可能被 condition 跳过）
[ ] 上游用了 output.map？（变量名可能变了）
```

**修复**：确保 depends_on 链完整，变量名匹配。

### 问题 2：$item.xxx 为 undefined

**症状**：foreach 内部 `$item.xxx` 解析为 undefined

**检查清单**：
```
[ ] 字段名拼写正确？（大小写敏感）
[ ] 上游 adapter 实际输出了这个字段？（opencli site command -f json 确认）
[ ] 如果用了 output.map，引用的是映射后的字段名吗？
[ ] foreach 引用的变量是数组吗？
```

**修复**：运行 `opencli site command -f json` 确认实际字段名。

### 问题 3：adapter 认证失败

**症状**：`AuthRequiredError` 或 403/401

**修复**：
```bash
# 先手动登录一次
opencli site login

# 或检查环境变量
echo $OPENCLI_XXX_TOKEN
```

### 问题 4：步骤超时

**症状**：`Step "xxx" timed out after 300s`

**修复方案**：
```yaml
# 方案 1：增加单步超时
slow-step:
  adapter: site/heavy-command
  timeout: 600        # 10 分钟

# 方案 2：降低并发（减轻目标站点压力）
batch-fetch:
  foreach: $items
  concurrency: 2      # 从 5 降到 2

# 方案 3：拆分数据量
# 在 inputs 中加 limit 参数，先用小数据集测试
```

### 问题 5：数据为空

**症状**：某步骤输出为空数组 `[]`

**检查清单**：
```
[ ] 上游 adapter 有数据返回？（单独运行确认）
[ ] foreach 引用的变量名正确？
[ ] condition 是否过滤掉了所有记录？
[ ] on_error: skip 是否跳过了所有记录？
```

### 问题 6：output.map 后字段丢失

**症状**：映射后的数据缺少字段

**原因**：map 只保留声明的字段，未声明的会丢弃

**修复**：在 map 中补充遗漏的字段：
```yaml
output:
  as: items
  map:
    title: name
    price: cost
    url: link        # 补充遗漏的字段
```

### 修复后：记录到 memory

问题定位并验证修复后，把根因和修法写进 memory，供下次直接复用：

```bash
cliflow memory <workflow-name> add "<症状 + 根因 + 修法>" --file my-workflow.yaml
```

如果是某个 adapter 通用的限制（不是这个 workflow 特有的），额外记一条：

```bash
cliflow memory adapter <site> add "<发现>"
```

---

## 第四步：Checkpoint 恢复

如果 workflow 开启了 `checkpoint: true`，中断后可以恢复：

```bash
# 查看已保存的 checkpoint
cliflow list

# 从中断点恢复
cliflow run my-workflow.yaml --resume cfrun_1721734200000_abc12345
```

已完成的步骤不会重复执行。修复导致失败的步骤后恢复，只重跑失败步骤及其下游。

---

## 第五步：预防措施

修复问题后，加以下防护措施避免再次发生：

```yaml
# 1. 开启 checkpoint（长时间运行的 workflow）
checkpoint: true

# 2. 合理设置 on_error
steps:
  fetch:
    on_error: stop       # 源头失败 = 终止
  enrich:
    on_error: skip       # 个别失败可跳过
  publish:
    on_error: retry      # 写操作重试

# 3. 限制并发
  batch-step:
    concurrency: 3       # 不超过 5

# 4. 声明 inputs 约束
inputs:
  limit: { type: number, default: 10, description: "控制数据量，测试时设小值" }
```

---

## 参考文件

| 文件 | 什么时候翻 |
|------|----------|
| `references/failure-patterns.md` | 遇到特定错误模式时，查完整的排查决策树 |

详细的常见失败模式和解决方案见 [`references/failure-patterns.md`](./references/failure-patterns.md)。
