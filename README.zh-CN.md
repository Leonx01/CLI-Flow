<div align="center">

# cliflow

[![English](https://img.shields.io/badge/docs-English-0F766E?style=flat-square)](./README.md)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-3c873a?style=flat-square)
[![Ink](https://img.shields.io/badge/UI-Ink-0f766e?style=flat-square)](https://github.com/vadimdemedes/ink)

**让 Agent 基于原子 CLI 能力编写可执行工作流。**

把自然语言目标转成可校验、可运行的 DAG：cliflow 帮 agent 写、验、跑、修，之后可无人值守重跑。

[概述](#概述) • [快速开始](#快速开始) • [Agent-friendly toolkit](#agent-friendly-toolkit面向-agent-的工具链) • [Skills](#skills) • [执行界面](#执行界面) • [Memory](#memory记忆机制) • [命令](#命令)

</div>

## 概述

cliflow 是一个面向 agent 的工作流引擎，目标是把自动化变得可靠、可复用。

### 为什么用它

- **从目标直接到执行** —— agent 把意图落成 DAG 工作流，而不是给你一堆脚本碎片。
- **为真实运行而设计** —— 分层校验、preflight 探测、严格运行闸门、可回放 trace 诊断。
- **天然适合重复执行** —— 可人机交互运行，也可在 CI/cron 中无人值守，或由 agent 暂停/续跑驱动。

### 核心模型

- **原子能力即 CLI** —— 每个能力（网站、工具或 HTTP API）都是 OpenCLI 适配器，统一寻址
  `site/command`，统一参数与 `--format` 输出。
- **Agent 主导编排** —— 你不必手写 YAML。编码 agent（Claude Code、Cursor 等）借助内置 skills
  完成工作流编写、校验、运行与调试。
- **确定性 DAG 编排** —— 支持并行扇出扇入、`foreach`、`condition`、交互节点、`on_error` 策略、
  检查点续跑与嵌套子工作流。

> [!IMPORTANT]
> cliflow 运行时依赖 **OpenCLI**（`@jackwener/opencli`）：工作流步骤与手动
> `opencli <site> <command>` 走的是同一条适配器调用路径。

## 快速开始

需要 [Node.js >= 18](https://nodejs.org) 和本地构建的 OpenCLI（见 `../opencli-fork`）。

```bash
npm install
npm link @jackwener/opencli      # 将本地 opencli 链接为运行时依赖
npm run build
node dist/cli/index.js --help
```

> [!NOTE]
> LLM 步骤读取 `DASHSCOPE_API_KEY`。复制 `.env.example` 为 `.env`，或直接 export。

```bash
# 用内置示例冒烟验证整条链路
node dist/cli/index.js validate workflows/weather-travel-planner.yaml
node dist/cli/index.js run workflows/interact-demo.yaml
```

## Agent-friendly toolkit（面向 agent 的工具链）

这套工具链的目标，是让 **agent** 自己构建并迭代工作流，而不是让人全程盯着。
cliflow 在每个阶段都提供分层检查与机器可读反馈。

**分层校验 —— `validate`（纯静态，不执行）。**

1. **语法 / schema** —— 文件能解析为结构合法的工作流。
2. **DAG 完整性** —— 环检测 + `depends_on` 依赖解析。
3. **数据流检查** —— 未知 `$var` 引用、产出步骤不在依赖链上、输出名冲突、变量名短横线非法。
4. **正确性 lint** —— 捕获典型运行陷阱（例如 `flatten:false` 产出被 `$item.<field>` 消费却未 `.flat()`）。

**Preflight —— `preflight`（运行前活性探测）。** 执行前检查引用适配器是否已注册、后端是否可达
（带重试）。公开主机不可达时降级为 `warn`，而非直接硬失败（声明域名可能不等于实际 API 主机）。

**Trace 诊断。** 每次运行写入 `~/.cliflow/traces/<runId>.trace.json`。使用
`trace <id> --summary` 可逐步回放：输入/输出数据形状、条目数、失败步骤与错误。

**Pause & resume（ReAct）。** `--agent-mode` 在交互节点暂停并输出
`{status:"paused", pendingInteracts, context}`。agent 观察上下文、推理后通过
`--resume --answer '{...}'` 继续执行。

**`--strict` 运行闸门。** 把静默失败（步骤跳过、`foreach` 全失败、声明 output 为空）转换为非零退出码，
防止 agent 将空跑误判为成功。`--allow-skip <steps>` 可豁免预期跳过步骤。

这些机制共同保证 agent 生成的 YAML **可证明可执行**：静态层管结构，preflight 管环境，
`--strict` + trace 管运行行为。

## Skills

真正的产品交付是 skill 组合，而不只是引擎本体。给 agent 一个**目标**而不是脚本，它会按
写 → 验 → 跑 → 修循环迭代，只有自动修复失败时才升级到人工。

| Skill | 何时使用 |
|-------|---------|
| **cliflow-task-planner** | 把真实任务拆成「补适配器 + 组合工作流 + 测试」；入口 skill，负责路由到下游技能 |
| **cliflow-workflow-author** | 把意图变成 DAG：设计 → 生成 YAML → 校验 → 试跑 |
| **cliflow-workflow-lifecycle** | 无人值守跑完整闭环；仅在自动修复失败时找人 |
| **cliflow-workflow-debugger** | 诊断失败运行、检查步骤输出、从检查点续跑 |

**示例。** 任务：*“帮我跟踪项目依赖是否过时、是否有生命周期风险，并给出升级建议。”*
agent 先 `opencli list` 发现 `npm` / `github-trending` / `endoflife` 适配器，再设计 DAG
（读 `package.json` → 并行 `{latest, weekly-downloads, EOL}` → 陈旧度打分 → 逐包 LLM 研判 → 报告），
完成校验 + preflight 后在 `--agent-mode` 下运行，交付 `radar.md`、`upgrade-plan.md`、`report.json`，
随后可在 cron 中配合 `--auto-approve` 周期重跑。

## 执行界面

同一个工作流，三种执行界面 —— 区别在于谁应答交互节点、谁消费输出：

| 模式 | 命令 | 运行方式 |
|------|------|---------|
| **TUI**（默认，tty） | `run <f>` | 交互式：人工应答提示并查看实时进度树 |
| **无人值守** | `run <f> --auto-approve -f json` | 按预设参数运行，**agent 不在环路里**，适合 cron / CI |
| **Agent 驱动** | `run <f> --agent-mode -f json` | **暂停/续跑 + ReAct**：交互处暂停，agent 决策后 `--resume` 继续 |

> [!TIP]
> `-f json` 会关闭 UI 并输出机器可读结果。

### UI（Ink TUI）

在 tty 下，cliflow 基于 **[Ink](https://github.com/vadimdemedes/ink)**（终端版 React）渲染实时界面：
带步骤状态与耗时的工作流树、并排并行层、以及 `select` / `multi-select` / `input` / `confirm`
交互浮层。这个界面仅面向人；`-f json` 用于给机器和 agent 提供结构化输出。

## Memory（记忆机制）

cliflow 将工作流开发知识跨会话持久化到 `~/.cliflow/memory/<workflow>/`，让下一次运行
（或下一个 agent）从已学经验起步：

| 文件 | 谁写 | 内容 |
|------|------|------|
| `insights.json` | 引擎，每次运行 | 运行次数、成功率、平均耗时、近期失败（含 trace 路径） |
| `snapshots/` | 引擎，成功时 | 按定义 hash 存档精确 YAML；可 `diff` 任意两个版本 |
| `notes.md` | agent / 人 | 自由笔记，用 YAML 定义 hash 标记 |
| `_adapters/<site>.md` | agent / 人 | 单适配器踩坑记录，跨工作流共享 |

**何时更新。** `insights` 与 `snapshots` 会在运行后**自动**写入（快照仅成功时、按 hash 落盘）。
笔记按需写入，cliflow 会在运行后输出上下文相关 **tool-hint**（JSON 里也有 `memoryHint`）：

- 运行失败 **且** 已有笔记 → *先读相关笔记*
- 运行失败 **且** 失败适配器有已知记录 → *读适配器踩坑*
- 运行失败 → *修复后补一条笔记*
- 写笔记后 YAML 发生变化 → 笔记标记为 **stale（过期）**，*需要复核*

skills 会引导 agent 根据这些 hint 行动，闭合“从上次运行学习”的回路。

## 命令

```bash
validate  <file>                                   # 静态：语法 + DAG + 数据流 + lint
preflight <file>                                   # 活性：适配器可达性
run       <file>                                   # 运行（tty 下走 Ink TUI）
run       <file> --auto-approve --strict -f json   # 无人值守 + 严格闸门
run       <file> --agent-mode -f json              # agent 驱动，交互处暂停
trace     <runId> --summary                        # 逐步失败诊断
memory    <workflow>                               # 某工作流的笔记 / 洞察 / 快照
```

## 示例工作流

内置于 [`workflows/`](./workflows)：

| 工作流 | 演示点 |
|--------|--------|
| `tech-stack-radar.yaml` | 旗舰示例：依赖盘点 → 并行信息补全 → LLM 研判 → 升级方案 |
| `weather-travel-planner.yaml` | 并行扇出扇入、步骤间数据流、交互节点 |
| `chess-player-digest.yaml` | 适配器链式调用、LLM 研判步骤 |
| `interact-demo.yaml` | 全部交互类型（`select` / `multi-select` / `input` / `confirm`） |
