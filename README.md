<div align="center">

# cliflow

[![中文文档](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](./README.zh-CN.md)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-3c873a?style=flat-square)
[![Ink](https://img.shields.io/badge/UI-Ink-0f766e?style=flat-square)](https://github.com/vadimdemedes/ink)

**Build agent-authored workflows over atomic CLI capabilities.**

Turn a natural-language goal into a validated, runnable DAG powered by OpenCLI adapters.
cliflow helps agents write, verify, execute, and repair workflows — then re-run them unattended.

[Overview](#overview) • [Getting started](#getting-started) • [Agent-friendly toolkit](#agent-friendly-toolkit) • [Skills](#skills) • [Execution surfaces](#execution-surfaces) • [Memory](#memory) • [Commands](#commands)

</div>

## Overview

cliflow is an agent-oriented workflow engine for reliable automation.

### Why teams use it

- **From intent to execution** — an agent turns goals into DAG workflows instead of handing you raw scripts.
- **Built to survive real runs** — layered validation, preflight checks, strict runtime gates, and trace diagnostics.
- **Ready for repeatability** — run interactively, unattended in CI/cron, or in agent-driven pause/resume mode.

### Core model

- **Atomic capabilities as CLIs** — every capability (a website, tool, or HTTP API) is an OpenCLI adapter,
  addressed uniformly as `site/command`, with uniform args and `--format` output.
- **Agent-led composition** — you don't hand-write YAML. A coding agent (Claude Code, Cursor, …)
  authors, validates, runs, and debugs workflows through bundled skills.
- **Deterministic DAG orchestration** — parallel fan-out/in, `foreach`, `condition`, interact nodes,
  `on_error` policy, checkpoint resume, and nested workflows.

> [!IMPORTANT]
> cliflow depends on **OpenCLI** (`@jackwener/opencli`) at runtime: workflow steps and manual
> `opencli <site> <command>` calls execute the exact same adapter path.

## Getting started

You need [Node.js >= 18](https://nodejs.org) and a local build of OpenCLI (see `../opencli-fork`).

```bash
npm install
npm link @jackwener/opencli      # link the local opencli as runtime dependency
npm run build
node dist/cli/index.js --help
```

> [!NOTE]
> LLM steps read `DASHSCOPE_API_KEY`. Copy `.env.example` to `.env`, or export the variable.

```bash
# smoke-test the whole chain on a bundled example
node dist/cli/index.js validate workflows/weather-travel-planner.yaml
node dist/cli/index.js run workflows/interact-demo.yaml
```

## Agent-friendly toolkit

cliflow is designed so an **agent** can build and iterate workflows with minimal human intervention.
It combines layered checks with machine-readable feedback at every stage.

**Layered validation — `validate` (static, no execution).**

1. **Syntax / schema** — workflow parses into a valid structure.
2. **DAG integrity** — cycle detection + dependency resolution via `depends_on`.
3. **Dataflow checks** — unknown `$var` refs, missing producer dependency chain, output-name
   collisions, illegal dashes in variable names.
4. **Correctness lint** — catches common runtime traps (for example consuming `flatten:false`
   output via `$item.<field>` without `.flat()`).

**Preflight — `preflight` (live reachability).** Before execution, checks that referenced adapters
are registered and backends are reachable (with retry). Unreachable public hosts degrade to `warn`
rather than hard fail, because declared domains may differ from actual API hosts.

**Trace diagnostics.** Every run writes `~/.cliflow/traces/<runId>.trace.json`. Use
`trace <id> --summary` for step-by-step replay: data shape in/out, item counts, and precise failing
step + error.

**Pause & resume (ReAct).** `--agent-mode` pauses at interact nodes and emits
`{status:"paused", pendingInteracts, context}`. The agent observes, reasons, and continues with
`--resume --answer '{...}'`.

**`--strict` runtime gate.** Converts silent failure patterns (skipped steps, fully failed
`foreach`, empty declared outputs) into non-zero exits, so agents never treat hollow runs as
success. `--allow-skip <steps>` whitelists expected skips.

Together these make agent-authored YAML *provably executable*: static layers catch structure,
preflight catches environment, and `--strict` + trace catch runtime behavior.

## Skills

The product surface is the skill set, not only the engine. Give an agent a **goal**, not a script:
it loops through write → validate → run → fix, and escalates only when auto-repair fails.

| Skill | When to use |
|-------|------------|
| **cliflow-task-planner** | Decompose a real task into adapters + workflow + tests; entry point that routes to the others |
| **cliflow-workflow-author** | Turn intent into a DAG: design → generate YAML → validate → dry-run |
| **cliflow-workflow-lifecycle** | Drive the whole loop unattended; escalate to a human only when auto-repair fails |
| **cliflow-workflow-debugger** | Diagnose a failing run, inspect step output, resume from checkpoint |

**Example.** Task: *"track this project's dependencies for staleness and EOL risk, and suggest
upgrades."* The agent runs `opencli list` to discover `npm` / `github-trending` / `endoflife`
adapters, designs a DAG (read `package.json` → parallel `{latest, weekly-downloads, EOL}` →
staleness score → per-package LLM verdict → report), validates + preflights it, runs it under
`--agent-mode`, and delivers `radar.md`, `upgrade-plan.md`, `report.json`. Then it can be
re-scheduled via cron with `--auto-approve`.

## Execution surfaces

One workflow, three execution surfaces — choose by who answers interact nodes and who consumes the
output:

| Mode | Command | How it runs |
|------|---------|-------------|
| **TUI** (default, tty) | `run <f>` | Interactive: a human answers prompts and watches the live tree |
| **Unattended** | `run <f> --auto-approve -f json` | Runs on preset args, **agent out of the loop** — for cron / CI |
| **Agent-driven** | `run <f> --agent-mode -f json` | **Pause & resume + ReAct**: pauses at interact nodes, agent decides and `--resume`s — self-iteration path |

> [!TIP]
> `-f json` disables the UI and emits machine-readable output.

### UI (Ink TUI)

In a tty, cliflow renders a live terminal UI built on **[Ink](https://github.com/vadimdemedes/ink)**
(React for the terminal): a workflow **tree** with per-step status and timing, parallel layers
shown side by side, and an **interact overlay** for `select` / `multi-select` / `input` /
`confirm` prompts. It is a human surface only — `-f json` turns it off for structured outputs.

## Memory

cliflow persists workflow-development knowledge across sessions under
`~/.cliflow/memory/<workflow>/`, so the next run (or next agent) starts from what was learned:

| File | Written by | Contents |
|------|-----------|----------|
| `insights.json` | engine, every run | run count, success rate, avg duration, recent failures (+ trace paths) |
| `snapshots/` | engine, on success | exact YAML archived by definition hash; `diff` any two versions |
| `notes.md` | agent / human | free-form notes tagged with the YAML's definition hash |
| `_adapters/<site>.md` | agent / human | per-adapter gotchas, shared across all workflows |

**When it updates.** `insights` and `snapshots` are written **automatically** after each run
(snapshot only on success, keyed by hash). Notes are written on demand, and cliflow prints a
context-aware **tool-hint** after runs (also surfaced as `memoryHint` in JSON output):

- run failed **and** notes exist → *read related notes first*
- run failed **and** failing adapter has known issues → *read adapter gotchas*
- run failed → *after fixing, add a note*
- YAML changed since note creation → note marked **stale**, *review it*

Skills guide agents to act on these hints, closing the learn-from-last-run loop.

## Commands

```bash
validate  <file>                                   # static: syntax + DAG + dataflow + lint
preflight <file>                                   # live: adapter reachability
run       <file>                                   # run (Ink TUI when tty)
run       <file> --auto-approve --strict -f json   # unattended + strict gate
run       <file> --agent-mode -f json              # agent-driven, pauses at interact nodes
trace     <runId> --summary                        # step-by-step failure diagnosis
memory    <workflow>                               # notes / insights / snapshots for a workflow
```

## Sample workflows

Bundled under [`workflows/`](./workflows):

| Workflow | Shows |
|----------|-------|
| `tech-stack-radar.yaml` | flagship: dependency inventory → parallel enrichment → LLM verdicts → upgrade plan |
| `weather-travel-planner.yaml` | parallel fan-out/in, dataflow between steps, interact nodes |
| `chess-player-digest.yaml` | adapter chaining, LLM verdict steps |
| `interact-demo.yaml` | every interact type (`select` / `multi-select` / `input` / `confirm`) |
