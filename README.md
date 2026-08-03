# cliflow

CLI Flow Engine — 基于 OpenCLI 适配器的 DAG 工作流编排器。用 YAML 声明多步骤工作流
（并行采集、foreach 批处理、条件分支、人机交互节点、检查点续跑），把多个 CLI 适配器
的调用组织成可反复执行的管线。

## 快速开始

```bash
npm install
npm link @jackwener/opencli   # 链接本地 opencli（见 opencli-fork）
npm run build
node dist/cli/index.js --help
```

配置 LLM 步骤所需的环境变量：复制 `.env.example` 为 `.env` 并填入 `DASHSCOPE_API_KEY`
（或 `export`）。

## 常用命令

```bash
node dist/cli/index.js validate <file>              # 语法 + DAG + 变量校验
node dist/cli/index.js preflight <file>             # 适配器可达性预检
node dist/cli/index.js run <file> --auto-approve --strict -f json
node dist/cli/index.js trace <runId> --summary      # 失败诊断
```

`--strict`：任一步骤被跳过 / foreach 有失败项 / 声明的 output 为空时以退出码 2 结束，
把静默失败暴露出来；用 `--allow-skip <steps>` 豁免预期内的跳过。

## 示例工作流（`workflows/`）

- `tech-stack-radar.yaml` — 技术栈雷达：盘点依赖、查最新版/下载趋势/EOL、LLM 研判、出升级方案
- `chess-player-digest.yaml`、`interact-demo.yaml`、`weather-travel-planner.yaml` — 语法示例

## 私有内容

与部署环境耦合的私有适配器和工作流不在本仓库，需在本机 `~/.opencli/clis/` 与
`private-workflows/`（均已 gitignore）自行提供后再运行。
