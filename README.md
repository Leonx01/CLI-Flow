<div align="center">

# cliflow

[![中文文档](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](./README.zh-CN.md)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-%3E%3D18-3c873a?style=flat-square)
[![Ink](https://img.shields.io/badge/UI-Ink-0f766e?style=flat-square)](https://github.com/vadimdemedes/ink)

**Agent-authored workflows over atomic CLI capabilities.**

[Overview](#overview) • [Getting started](#getting-started) • [Agent-friendly toolkit](#agent-friendly-toolkit) • [Skills](#skills) • [Execution surfaces](#execution-surfaces) • [Memory](#memory) • [Commands](#commands)

</div>

Describe a goal in natural language; an AI agent composes [OpenCLI](../opencli-fork) adapters into a
DAG, validates it, runs it, and repairs it — then you re-run the result unattended.

## Overview

cliflow is an agent-oriented workflow engine built on three ideas:

- **Atomic capabilities as CLIs** — every capability (a website, tool, or HTTP API) is an OpenCLI
  adapter addressed uniformly as `site/command`, with uniform args and `--format` output.
  Composition never special-cases where a capability comes from.
- **Agent-led composition** — you don't hand-write YAML. A coding agent (Claude Code, Cursor, …)
  authors, validates, runs, and debugs the workflow through the bundled skill set.
- **Deterministic orchestration** — adapters are wired into a DAG: parallel fan-out/in, `foreach`,
  `condition`, interact nodes, `on_error` policy, checkpoint resume, nested workflows.

> [!IMPORTANT]
> cliflow depends on **OpenCLI** (`@jackwener/opencli`) at runtime: it discovers and invokes
> adapters through it in-process, so a workflow step and a manual `opencli <site> <command>` call
> hit the exact same code path.

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

The toolchain exists so an **agent** can build, verify, and iterate a workflow on its own — not so
a human has to babysit it. Agent-generated pipelines tend to *look* right but fail at runtime;
cliflow attacks that with layered checks and machine-readable feedback at every stage.

**Layered validation — `validate` (static, no execution).**

1. **Syntax / schema** — the file parses into a well-formed workflow.
2. **DAG integrity** — cycle detection and dependency resolution across `depends_on`.
3. **Dataflow** — unknown `$var` references, a producer not in the dependency chain (missing
   `depends_on`), output-name collisions, illegal dashes in variable names.
4. **Correctness lint** — e.g. a `flatten:false` producer consumed via `$item.<field>` without
   `.flat()`. These are the exact traps that make agent YAML *parse* but *not run*.

**Preflight — `preflight` (live reachability).** Before execution, probes that every referenced
adapter is registered and its backend is reachable (public-API probe with retry; unreachable public
hosts degrade to a `warn` rather than a hard fail, since a declared domain may differ from the API
host).

**Trace.** Every run writes `~/.cliflow/traces/<runId>.trace.json`. `trace <id> --summary` replays
the run step by step — data shapes in/out, item counts, the failing step + error — so the agent
reads a diagnosis instead of scrolling logs.

**Pause & resume (ReAct).** `--agent-mode` pauses at each interact node and emits
`{status:"paused", pendingInteracts, context}`. The agent **observes** the context, **reasons**,
and **acts** via `--resume --answer '{...}'`. That observe→reason→act loop over pause/resume is
how the agent drives a run and self-iterates — no human sitting in the loop.

**`--strict`.** Turns silent failures — a skipped step, a `foreach` where every item failed, or an
empty declared output — into a non-zero exit, so the agent never mistakes a hollow run for success.
`--allow-skip <steps>` whitelists expected skips.

Together these make agent-generated YAML *provably* executable: static layers catch structure,
preflight catches environment, `--strict` + trace catch runtime, and memory (below) carries the
lesson to the next attempt.

## Skills

The real deliverable is the skill set, not the engine. Install them and hand the agent a **goal**,
not a script: it works as a goal-driven loop — write → validate → run → fix — iterating until the
goal is met, and only escalates to a human when auto-repair fails. This is the shape of task you
should delegate: an objective with acceptance criteria, not a step-by-step checklist.

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
`--agent-mode`, and delivers `radar.md`, `upgrade-plan.md`, `report.json`. It is then
cron-schedulable and re-runs with `--auto-approve`.

## Execution surfaces

One workflow, three ways to run — differing in who answers interact nodes and who reads output:

| Mode | Command | How it runs |
|------|---------|-------------|
| **TUI** (default, tty) | `run <f>` | Interactive: a human answers prompts and watches the live tree |
| **Unattended** | `run <f> --auto-approve -f json` | Runs on preset args, **agent out of the loop** — for cron / CI |
| **Agent-driven** | `run <f> --agent-mode -f json` | **Pause & resume + ReAct**: pauses at interact nodes, agent decides and `--resume`s — the self-iteration path |

> [!TIP]
> `-f json` disables the UI and emits machine-readable output.

### UI (Ink TUI)

In a tty, cliflow renders a live terminal UI built on **[Ink](https://github.com/vadimdemedes/ink)**
(React for the terminal): a workflow **tree** with per-step status and timing, parallel layers
shown side by side, and an **interact overlay** for `select` / `multi-select` / `input` /
`confirm` prompts. It is purely a human surface — `-f json` turns it off so machines and agents get
structured output instead.

## Memory

cliflow persists workflow-development knowledge across sessions under
`~/.cliflow/memory/<workflow>/`, so the next run (or the next agent) starts from what was learned:

| File | Written by | Contents |
|------|-----------|----------|
| `insights.json` | engine, every run | run count, success rate, avg duration, recent failures (+ trace paths) |
| `snapshots/` | engine, on success | the exact YAML archived by definition hash; `diff` any two versions |
| `notes.md` | agent / human | free-form notes tagged with the YAML's definition hash |
| `_adapters/<site>.md` | agent / human | per-adapter gotchas, shared across all workflows |

**When it updates.** `insights` and `snapshots` are written **automatically** after each run
(snapshot only on success, keyed by hash). Notes are written on demand — and cliflow decides *when*
to nudge via a context-aware **tool-hint** printed after a run (also surfaced as `memoryHint` in
JSON output):

- run failed **and** notes exist → *read the related notes first*
- run failed **and** the failing adapter has known-issue memory → *read the adapter gotchas*
- run failed → *after fixing, add a note*
- the YAML changed since a note was written → that note is flagged **stale**, *review it*

The skills instruct the agent to act on these hints, closing the learn-from-last-run loop: a
failure becomes a note, a note becomes context for the next attempt, and a changed workflow
retires the notes that no longer apply.

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
| `tech-stack-radar.yaml` | the flagship: dependency inventory → parallel enrichment → LLM verdicts → upgrade plan |
| `weather-travel-planner.yaml` | parallel fan-out/in, dataflow between steps, interact nodes |
| `chess-player-digest.yaml` | adapter chaining, LLM verdict steps |
| `interact-demo.yaml` | every interact type (`select` / `multi-select` / `input` / `confirm`) |
