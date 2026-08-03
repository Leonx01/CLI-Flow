<div align="center">

# cliflow

[![English](https://img.shields.io/badge/docs-English-0F766E?style=flat-square)](./README.md)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-3c873a?style=flat-square)
[![Ink](https://img.shields.io/badge/UI-Ink-0f766e?style=flat-square)](https://github.com/vadimdemedes/ink)

**由 Agent 编写、以原子 CLI 能力为积木的工作流。**

[概述](#概述) • [快速开始](#快速开始) • [Agent-friendly toolkit](#agent-friendly-toolkit面向-agent-的工具链) • [Skills](#skills) • [执行界面](#三种执行界面) • [Memory](#memory记忆机制) • [命令](#命令)

</div>

用自然语言描述目标，AI agent 把 [OpenCLI](../opencli-fork) 适配器组合成 DAG，替你校验、运行、
修错 —— 之后你就能无人值守地反复重跑。

## 概述

cliflow 是一个面向 agent 的工作流引擎，建立在三个理念上：

- **原子能力即 CLI** —— 每个能力（一个网站、工具或 HTTP API）都是一个 OpenCLI 适配器，
  统一寻址为 `site/command`，统一参数、统一 `--format` 输出。编排层从不关心某个能力来自哪里。
- **Agent 主导编排** —— 你不手写 YAML。由编码 agent（Claude Code、Cursor 等）借助内置
  skill 完成工作流的编写、校验、运行与调试。
- **确定性编排** —— 适配器被组织成 DAG：并行扇出扇入、`foreach`、`condition`、人机交互节点、
  `on_error` 策略、检查点续跑、嵌套子工作流。

> [!IMPORTANT]
> cliflow **运行时依赖 OpenCLI**（`@jackwener/opencli`）：在进程内通过它发现并调用适配器 ——
> 工作流里的一步，和你手动敲 `opencli <site> <command>`，走的是完全相同的代码路径。

## 快速开始

需要 [Node.js >= 18](https://nodejs.org) 和本地构建的 OpenCLI（见 `../opencli-fork`）。

```bash
npm install
npm link @jackwener/opencli      # 将本地 opencli 链接为运行时依赖
npm run build
node dist/cli/index.js --help
```

> [!NOTE]
> LLM 步骤读取 `DASHSCOPE_API_KEY` —— 复制 `.env.example` 为 `.env`，或直接 export。

```bash
# 用内置示例冒烟验证整条链路
node dist/cli/index.js validate workflows/weather-travel-planner.yaml
node dist/cli/index.js run workflows/interact-demo.yaml
```

## Agent-friendly toolkit（面向 agent 的工具链）

整套工具链的存在，是为了让 **agent** 自己构建、验证、迭代工作流 —— 而不是让人守着它。
agent 生成的管线的通病是「看起来对、跑起来挂」；cliflow 用分层校验 + 每一环的机器可读反馈
来解决这个问题。

**分层校验 —— `validate`（纯静态，不执行）。**

1. **语法 / schema** —— 文件能解析成结构合法的工作流。
2. **DAG 完整性** —— 环检测 + 沿 `depends_on` 的依赖解析。
3. **数据流** —— 未知 `$var` 引用、引用的产出步骤不在依赖链上（缺 `depends_on`）、
   输出名冲突、变量名里的非法短横线。
4. **正确性 lint** —— 例如 `flatten:false` 的产出被 `$item.<field>` 消费却没 `.flat()`。
   这些正是「能解析、但跑不通」的典型陷阱。

**Preflight —— `preflight`（运行前活性探测）。** 执行前探测每个引用的适配器是否已注册、
后端是否可达（公开 API 带重试探测；不可达的公开主机降级为 `warn` 而非硬失败，因为声明的
domain 可能不等于真实 API 主机）。

**Trace。** 每次运行写 `~/.cliflow/traces/<runId>.trace.json`。`trace <id> --summary` 逐步回放
这次运行 —— 每步输入/输出的数据形状、条目数、以及失败步骤与错误 —— 让 agent 读到的是诊断
而不是一堆日志。

**Pause & resume（ReAct）。** `--agent-mode` 在每个交互节点暂停，输出
`{status:"paused", pendingInteracts, context}`。agent **观察**上下文、**推理**、再通过
`--resume --answer '{...}'` **行动**。这个基于暂停/续跑的 observe→reason→act 循环，就是 agent
驱动运行并自我迭代的方式 —— 无需人守在中间。

**`--strict`。** 把静默失败 —— 步骤被跳过、`foreach` 全部条目失败、声明的 output 为空 ——
变成非零退出码，让 agent 绝不把一次空跑误判成成功。`--allow-skip <steps>` 豁免预期内的跳过。

这几层合起来让 agent 生成的 YAML **可证明可执行**：静态层管结构、preflight 管环境、
`--strict` + trace 管运行时，而 memory（见下）把教训带到下一次尝试。

## Skills

真正的交付物是 skill，不是引擎。装上它们，交给 agent 的是一个**目标**，而不是一份步骤清单：
agent 以 goal-driven 的方式跑「写 → 验 → 跑 → 修」循环，直到目标达成，只在自动修复失败时
才找人。这也是你应该委派给 agent 的任务形态：一个带验收标准的目标，而非逐步指令。

| Skill | 何时用 |
|-------|--------|
| **cliflow-task-planner** | 把一个真实任务拆成「补适配器 + 组合工作流 + 测试」；入口 skill，负责路由到下面几个 |
| **cliflow-workflow-author** | 把意图变成 DAG：设计 → 生成 YAML → 校验 → 试跑 |
| **cliflow-workflow-lifecycle** | 无人值守跑完整个闭环，只在自动修复失败时才找人 |
| **cliflow-workflow-debugger** | 诊断失败的运行、核查步骤输出、检查点续跑 |

**示例。** 任务：*"帮我盯住这个项目的依赖，有没有过时的、有没有生命周期风险，给我升级建议。"*
Agent 用 `opencli list` 发现 `npm` / `github-trending` / `endoflife` 适配器，设计出 DAG
（读 `package.json` → 并行 `{最新版, 周下载, EOL}` → 陈旧度打分 → 逐包 LLM 研判 → 出报告），
校验 + preflight，`--agent-mode` 下运行，交付 `radar.md`、`upgrade-plan.md`、`report.json`。
之后挂 cron，用 `--auto-approve` 无人值守重跑。

## 三种执行界面

同一个工作流，三种运行姿势 —— 区别在于「谁应答交互节点、输出给谁看」：

| 模式 | 命令 | 怎么跑 |
|------|------|--------|
| **TUI**（默认，tty） | `run <f>` | 交互式：由人应答提示、盯着实时进度树 |
| **无人值守** | `run <f> --auto-approve -f json` | 按预设参数运行，**agent 不在环路里** —— 给 cron / CI |
| **Agent 驱动** | `run <f> --agent-mode -f json` | **暂停/续跑 + ReAct**：在交互节点暂停，agent 决策后 `--resume` —— 自我迭代路径 |

> [!TIP]
> `-f json` 禁用 UI 并输出机器可读结果。

### UI（Ink TUI）

在 tty 下，cliflow 渲染一个基于 **[Ink](https://github.com/vadimdemedes/ink)**（终端版 React）的
实时终端界面：一棵带每步状态与耗时的工作流**树**、并排展示的并行层、以及用于
`select` / `multi-select` / `input` / `confirm` 的**交互浮层**。它纯粹是给人看的界面 ——
`-f json` 会关掉它，让机器和 agent 拿到结构化输出。

## Memory（记忆机制）

cliflow 把「工作流开发知识」跨会话持久化到 `~/.cliflow/memory/<workflow>/`，让下一次运行
（或下一个 agent）从已学到的东西起步：

| 文件 | 谁写 | 内容 |
|------|------|------|
| `insights.json` | 引擎，每次运行 | 运行次数、成功率、平均耗时、近期失败（含 trace 路径） |
| `snapshots/` | 引擎，成功时 | 按定义 hash 归档的确切 YAML；可 `diff` 任意两个版本 |
| `notes.md` | agent / 人 | 自由笔记，用该 YAML 的定义 hash 标记 |
| `_adapters/<site>.md` | agent / 人 | 单个适配器的踩坑记录，跨所有工作流共享 |

**何时更新 / 触发。** `insights` 和 `snapshots` 在每次运行后**自动**写入（快照仅在成功时、按
hash 落盘）。笔记则按需写入 —— 由 cliflow 在运行后打印一条上下文相关的 **tool-hint** 来决定
*何时* 提醒（在 JSON 输出里也作为 `memoryHint` 暴露）：

- 运行失败 **且** 已有笔记 → *先读相关笔记*
- 运行失败 **且** 出错的适配器有已知问题记录 → *读该适配器的踩坑记录*
- 运行失败 → *修好后，加一条笔记*
- 笔记写下后 YAML 变了 → 该笔记被标记为 **stale（过期）**，*去复核*

skill 会指示 agent 对这些 hint 采取行动，从而闭合「从上次运行中学习」的回路：一次失败变成
一条笔记，一条笔记成为下次尝试的上下文，而一次工作流改动会让不再适用的笔记退场。

## 命令

```bash
validate  <file>                                   # 静态：语法 + DAG + 数据流 + lint
preflight <file>                                   # 活性：适配器可达性
run       <file>                                   # 运行（tty 下走 Ink TUI）
run       <file> --auto-approve --strict -f json   # 无人值守 + 严格闸门
run       <file> --agent-mode -f json              # agent 驱动，交互处暂停
trace     <runId> --summary                        # 逐步失败诊断
memory    <workflow>                               # 某工作流的 笔记 / 洞察 / 快照
```

## 示例工作流

内置于 [`workflows/`](./workflows)：

| 工作流 | 演示点 |
|--------|--------|
| `tech-stack-radar.yaml` | 旗舰示例：依赖盘点 → 并行补全信息 → LLM 研判 → 升级方案 |
| `weather-travel-planner.yaml` | 并行扇出扇入、步骤间数据流、交互节点 |
| `chess-player-digest.yaml` | 适配器链式调用、LLM 研判步骤 |
| `interact-demo.yaml` | 全部交互类型（`select` / `multi-select` / `input` / `confirm`） |
