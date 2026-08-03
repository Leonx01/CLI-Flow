---
name: cliflow-workflow-lifecycle
description: Use when an AI agent needs to autonomously build, test, debug, and deliver a working cliflow workflow. Orchestrates the full write → validate → test → fix loop without human intervention.
allowed-tools: Bash(opencli:*), Bash(cliflow:*), Read, Edit, Write, Grep
---

# cliflow-workflow-lifecycle

你是负责 **端到端交付一个可运行 workflow** 的 agent。这份 skill 的目标：**自主完成 "写 → 验 → 跑 → 修" 闭环，只在无法自动修复时才请求用户介入。**

不要手动做子 skill 能做的事。当需要写 YAML 时加载 `cliflow-workflow-author`，当需要深入调试时加载 `cliflow-workflow-debugger`。这个 skill 是 **编排层**，不是替代层。

---

## 闭环流程

```
Phase 1: 需求理解（含查 memory）
    |
Phase 2: 编写 YAML        ← cliflow-workflow-author skill
    |
Phase 3: 静态验证（≤3轮）  ← validate + preflight
    |
Phase 4: 运行验证（≤3轮）  ← run --auto-approve + trace
    |
Phase 5: 交付（含写 memory）
```

---

## Phase 1: 需求理解

```
[ ] 1. 明确用户意图：要自动化什么任务？输入是什么？期望输出是什么？
[ ] 2. cliflow memory <workflow-name> — 有没有历史记录，命中直接参考
[ ] 3. opencli list -f json — 确认所需 adapter 是否存在
[ ] 4. 如果 adapter 不存在 → 路由到 opencli-adapter-author skill 先补齐
[ ] 5. timeout 15 opencli <site> <cmd> --limit 1 -f json — 逐个确认关键 adapter 可达（没有批量探测命令，等 YAML 写出来后 preflight 会批量检查）
[ ] 6. 如果任务涉及 3+ adapter → 先用 cliflow-task-planner skill 拆解
```

---

## Phase 2: 编写 YAML

加载 `cliflow-workflow-author` skill 完成 YAML 编写。

写完后回到这个 skill 继续 Phase 3。

---

## Phase 3: 静态验证

最多 3 轮自修复。每轮：

```
[ ] 1. cliflow validate <file>
      - 通过 → 继续
      - 失败 → 读错误信息，修 YAML，重试

[ ] 2. cliflow preflight <file> -f json
      - 全部 pass → 继续
      - 有 fail → 根据 category 修复（见下表），重试
      - 只有 warn → 可继续，但记录 warning
```

### preflight 修复表

| category | 常见原因 | 修复方向 |
|----------|---------|---------|
| parse | YAML 语法错误 | 检查缩进、引号、特殊字符 |
| dag | 循环依赖 | 重新设计 depends_on |
| vars | 变量引用错误 | 检查 $varName 拼写、depends_on 链 |
| adapter | adapter 不存在或不可达 | 确认 adapter 名称、网络可达性 |
| args | 参数不匹配 adapter 声明 | opencli <site> <cmd> --help 查看可用参数 |
| output-map | map 字段不在 adapter columns 中 | 查看 adapter columns 修正字段名 |
| env | 浏览器桥接未就绪 | 需用户启动 Browser Bridge |
| nested | 嵌套 workflow 文件不存在 | 检查路径拼写 |

---

## Phase 4: 运行验证（机械化修复循环）

**核心原则：`status == "completed"` 不等于验证通过。** 引擎把「被 skip 的步骤」也计入 completed，把「foreach 里每一项都失败」的步骤也标成 ✓。只看 status 会让你在跳过了写操作、或 foreach 全军覆没的运行上宣布成功。**一律用 `--strict` 让这些静默失败变成非零退出码。**

```python
round = 0
while round < 3:
    # 1. 运行 —— 必须带 --strict。它在出现「被跳过的步骤 / foreach 项失败 / 声明的
    #    output 为空」时以退出码 2 结束，把静默失败暴露出来。
    #    确定某步骤按业务就该跳过时，用 --allow-skip <step1,step2> 显式豁免。
    result = cliflow run <file> --auto-approve --strict -f json
    exit_code = $?

    # 2. 只有「退出码 0」才算通过 —— 不是 status==completed。
    if exit_code == 0:
        break   # → Phase 5

    # 3. 诊断
    summary = cliflow trace <result.id> --summary   # 读计数用 dataFlow.itemCount，别信摘要里的截断预览
    # result.coverage 直接给出 executed / skipped / foreachFailed / emptyOutputs

    # 4. 判断是否可自动修复
    if errorType in ["AuthRequiredError"]: stop → 告知用户需要手动登录
    if preflight.category == "env":        stop → 告知用户需要启动 Browser Bridge

    # 5. 修复 YAML → cliflow validate <file>（validate 现在会静态报出 flatten:false 错配等问题）
    round += 1

if round >= 3:
    # 加载 cliflow-workflow-debugger 深度诊断；仍无法修复 → 告知用户，附最后一次 trace summary
```

### ⚠️ 验证纪律（每条都要做到，别靠记性）

```
[ ] 跑之前先写下每步的预期（条数 / 关键字段 / 非空），跑完逐条对照
[ ] 每个 foreach 步骤检查 trace 里 x/y/z 的第三个数字（失败数），非 0 就是有问题
[ ] 写操作、错误分支必须真实走通至少一次；
    禁止用「被 skip 掉的那条路径」声明验证通过（如 confirm 门答 false 跳过了 publish，就不算验证过 publish）
[ ] 交付时列出「本次运行未覆盖的分支」（直接抄 result.coverage.skipped）
[ ] 读 trace 输出的条数用 dataFlow.itemCount，不要用摘要里可能被截断的 preview 值
[ ] 修复后重新验证时不要用 --resume —— checkpoint 会跳过已完成步骤，你的修复不会重新执行；
    起一个全新的 run
```

### --auto-approve 的含义

自动应答所有 interact 步骤（confirm→true，select→选第一项，multi-select→全选，input→用 default）。`-f json` 输出 JSON 并禁用 TUI 进度树。

JSON 输出中的关键字段：
- `status`: "completed" | "failed"
- `id`: runId，用于 `cliflow trace <id> --summary`
- `memoryHint`: 建议的 memory 操作（可能为 null）
- `traceFile`: trace 文件路径

### --agent-mode：需要真实决策时的 interact 处理

如果 workflow 里的 interact 节点需要基于上下文做有意义的选择（不是随便选第一项），**不要用 --auto-approve**（会机械选择，可能选错），改用 `--agent-mode`：

```bash
# 1. 遇到 interact 就暂停。只有当"当前没有任何 step 能继续推进"（所有 ready 的 step
#    都卡在 interact 上）才会真正暂停——如果有多个互相无依赖的 interact 节点在同一批
#    并行调度到，会一次性全部收集，不是发现第一个就中断。
result = cliflow run <file> --agent-mode -f json
# result.status === "paused" 时，result.pendingInteracts 是一个数组，每项:
#   { stepName, spec: { type, message, options? } }
# result.context 包含已完成步骤的输出，供你参考做决策

# 2. 基于 pendingInteracts 里每一项的 spec 和 context 做出判断，
#    一次性给出本轮所有 step 的答案（map 形式），带着恢复：
result = cliflow run <file> --resume <result.id> --agent-mode -f json --answer '{
  "<stepName1>": <答案1>,
  "<stepName2>": <答案2>
}'
# 答案格式随对应 step 的 spec.type 而定:
#   confirm      → true / false
#   select       → 选中的 option.value（完整对象，不是 label）
#   multi-select → option.value 数组
#   input        → 字符串
# 如果本轮只有一个 pendingInteracts 条目，map 里也只需一个键。
# 若还有下一批 interact（例如刚回答的 step 的下游又是新的 interact），
# 会再次 status:"paused"，重复第 2 步直到 status:"completed"。
```

**判断用哪种模式**：
- interact 只是走个流程、选哪个都无所谓（如"选第一个默认配置"）→ `--auto-approve`
- interact 的选择会影响下游结果、需要看数据做判断（如"从搜索结果里选最相关的几条"）→ `--agent-mode`

### 运行失败修复表

| trace 中的 errorType | 含义 | 修复方向 |
|---------------------|------|---------|
| AuthRequiredError | 需要登录 | **无法自动修复** — 告知用户需要手动登录 |
| TimeoutError | 超时 | 增大 step.timeout 或加 on_error: retry |
| StepSkippedError | 步骤被跳过 | 检查 condition 表达式或 depends_on |
| GenericError | adapter 执行失败 | 检查 args 是否正确，加载 `cliflow-workflow-debugger` 深入诊断 |

### 无法自动修复的情况

遇到以下情况立即停止重试，报告用户：

- `AuthRequiredError` — 需要用户登录浏览器
- `env` preflight 失败 — 需要用户启动 Browser Bridge
- 连续 3 轮修复失败 — 加载 `cliflow-workflow-debugger` 深入诊断后仍无法解决

---

## Phase 5: 交付

```
[ ] 1. 告知用户 workflow 已通过验证
[ ] 2. 给出运行命令：
      cliflow run <file>
[ ] 3. 如果有 interact 步骤，提示：
      "此 workflow 包含交互步骤，运行时会提示用户输入。
       测试时使用了 --auto-approve 自动应答。"
[ ] 4. 说明关键输入参数（如果有 inputs 声明）
[ ] 5. 如果 Phase 4 过程中有值得记住的发现（且还没记）：
      cliflow memory <workflow-name> add "<发现>" --file <file>
```

---

## 命令速查

| 目的 | 命令 |
|------|------|
| 查看可用 adapter | `opencli list -f json` |
| 单个 adapter 小样本试跑 | `timeout 15 opencli <site> <cmd> --limit 1 -f json` |
| 查看 adapter 参数 | `opencli <site> <cmd> --help` |
| 语法 + DAG + 变量校验 | `cliflow validate <file>` |
| 全面预检 | `cliflow preflight <file> -f json` |
| 看执行计划 | `cliflow run <file> --dry-run` |
| 无人值守运行 | `cliflow run <file> --auto-approve -f json` |
| 严格验证运行（推荐） | `cliflow run <file> --auto-approve --strict -f json`；skip/foreach失败/空输出 → 退出码 2；用 `--allow-skip <steps>` 豁免预期内的 skip |
| 预检 + 运行 | `cliflow run <file> --preflight --auto-approve -f json` |
| 需要决策的 interact | `cliflow run <file> --agent-mode -f json`，暂停后 `--resume <id> --agent-mode --answer '{"<step>":<答案>,...}'` 继续（一次答完本轮全部 pendingInteracts） |
| 失败诊断 | `cliflow trace <runId> --summary` |
| 查历史 memory | `cliflow memory <workflow-name>` |
| 记录发现 | `cliflow memory <workflow-name> add "<text>" --file <file>` |

---

## 与其他 skill 的关系

```
cliflow-workflow-lifecycle（本 skill：编排层）
  ├─ Phase 1 → cliflow-task-planner（复杂任务拆解）
  ├─ Phase 2 → cliflow-workflow-author（写 YAML）
  ├─ Phase 2 → opencli-adapter-author（补缺 adapter）
  └─ Phase 4 → cliflow-workflow-debugger（深度调试）
```
