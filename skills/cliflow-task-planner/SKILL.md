---
name: cliflow-task-planner
description: Use when an agent receives a complex real-world automation task and needs to decompose it into adapter creation + workflow composition + testing. The entry point skill that routes to opencli-adapter-author and cliflow-workflow-author.
allowed-tools: Bash(opencli:*), Bash(cliflow:*), Read, Edit, Write, Grep
---

# cliflow-task-planner

你是一个接收到复杂自动化任务的 agent。这份 skill 的目标：**把一个自然语言描述的多步骤任务，拆解为可执行的工作计划，协调 adapter 创建和 workflow 组合，最终交付一个可运行的端到端 workflow**。

核心思路：**原子化思维**。每一个数据获取、数据处理、数据写入都是一个独立的 CLI adapter。Workflow 只负责把这些原子能力串联起来。

---

## 第一步：任务分析

拿到用户任务后，按这个框架拆解：

```
[ ] 1. 列出所有数据源（从哪里读数据）
[ ] 2. 列出所有数据处理步骤（转换、过滤、排序、分析）
[ ] 3. 列出所有数据输出（写到哪里）
[ ] 4. 画出数据流图：源 → 处理 → 输出
[ ] 5. 标记每个节点需要的 adapter 类型
```

### 节点分类

| 类型 | 说明 | adapter 形态 | 示例 |
|------|------|-------------|------|
| **Web 读取** | 从网站获取数据 | `site/command` (PUBLIC/COOKIE/UI) | `site-a/list-names` |
| **Web 写入** | 向网站提交数据 | `site/command` (COOKIE/UI) | `site-c/upload` |
| **数据处理** | 去重、聚合、排序、过滤、合并 | `local/command` (LOCAL) | 见下方「内置数据处理 adapter」 |
| **文件 I/O** | 文件读写、格式转换 | `local/command` (LOCAL) | `local/save-json`, `local/excel-write` |
| **AI 处理** | 需要语义理解的转换（分类、摘要、判断） | `adapter: dashscope/chat`（或 `llm/chat`） | 排名、分类、摘要 |
| **外部 API** | 第三方服务调用 | `service/command` (PUBLIC) | `openai/chat`, `email/send` |

### 内置数据处理 adapter（local/ 目录）

在拆解数据处理步骤时，先检查是否已有 local adapter 能满足需求：

| adapter | 用途 | 关键参数 |
|---------|------|---------|
| `local/unique` | 按字段去重，支持 `--sum`/`--max` 聚合 | `--data`, `--by`, `--sum`, `--max` |
| `local/score` | 按加权字段综合评分排名 | `--items`, `--weights`, `--top` |
| `local/merge` | 合并两个数组 | `--a`, `--b` |
| `local/save-json` | 保存 JSON 到文件 | `--path` + 声明过的数据参数 |

**不需要 AI 的操作**：排序、过滤、去重、聚合、计算评分——这些用 local adapter 更快更稳定。
**需要 AI 的操作**：文本分类、内容摘要、语义判断、多维度综合评价——这些无法用规则表达。

### LLM 前置检查

用 `adapter: dashscope/chat`（或 `llm/chat`）前**必须**确认环境变量：

```bash
# dashscope/chat（阿里百炼）
echo $DASHSCOPE_API_KEY       # 必须非空

# llm/chat（任意 OpenAI 兼容端点）
echo $LLM_ENDPOINT            # 或 $OPENCLI_AI_ENDPOINT，必须非空，如 https://api.openai.com/v1
echo $LLM_API_KEY             # 或 $OPENCLI_AI_KEY，可选，部分端点需要
```

如果对应环境变量为空，adapter 会直接报错（如 `DASHSCOPE_API_KEY environment variable not set`）。此时有两个选择：
1. 配置对应的 API key / 端点
2. 改用 `local/` adapter 做规则化处理（排序、过滤、聚合不需要 AI）

### 示例拆解

用户任务："从网站 A 获取名单，在网站 B 搜索这些人的信息，存到 Excel，分析排名，把排名最高的上传到网站 C"

```
数据流图：
  [site-a/list] → [site-b/search] → [local/excel-write] → [dashscope/chat] → [site-c/upload]
       ↓                ↓                                      ↓
    获取名单       逐人搜索信息                              排名分析
```

分解为 5 个原子 adapter：
1. `site-a/list` — 获取名单（Web 读取）
2. `site-b/search` — 搜索人员信息（Web 读取，foreach 逐条）
3. `local/excel-write` — 写入 Excel（本地处理）
4. `dashscope/chat`（`json_mode: true`） — 排名分析（LLM 处理，不需要单独建 adapter）
5. `site-c/upload` — 上传结果（Web 写入）

---

## 第二步：能力盘点

检查当前系统已有哪些 adapter，哪些需要新建：

```bash
# 查看所有已注册的 adapter
opencli list

# 按站点过滤
opencli list | grep "site-a"

# 查看某个 adapter 的参数和输出列
opencli site-a list --help

# 小样本试跑，确认可达 + 真实字段名（加 timeout 防止 API 挂起）
timeout 15 opencli site-a list --limit 1 -f json
```

**没有独立的批量探测命令**——YAML 还没写出来之前，逐个 adapter 用上面的方式确认。等第三步
写出最小 YAML 后，`cliflow preflight <file.yaml>` 会一次性批量检查所有步骤引用的 adapter。

对每个打算复用的 adapter，先查一下有没有已知限制：

```bash
cliflow memory adapter <site>   # 有没有记录过的限流/认证/字段坑
```

### 判断规则

| 情况 | 行动 |
|------|------|
| adapter 已存在且参数匹配 | 直接使用（先查 `cliflow memory adapter <site>` 有没有已知限制） |
| adapter 已存在但缺少参数 | 考虑扩展现有 adapter 或用 LLM 步骤（dashscope/chat）补充 |
| adapter 不存在，是公开网站 | 用 `opencli-adapter-author` skill 创建 |
| adapter 不存在，是本地处理 | 创建 `local/xxx` adapter（详见参考：`capability-check.md`）|
| 功能需要语义理解 | 用 `adapter: dashscope/chat` 直接调用，不需要新建 adapter |

详细的能力检查指南见 `references/capability-check.md`。

---

## 第三步：生成工作计划

按照依赖关系排列子任务。**先创建 adapter，再组合 workflow**：

```
工作计划模板：

阶段 1：Adapter 创建（可并行）
  1.1 创建 site-a/list adapter        → opencli-adapter-author skill
  1.2 创建 site-b/search adapter      → opencli-adapter-author skill
  1.3 创建 local/excel-write adapter   → 参考 local adapter 模板
  1.4 创建 site-c/upload adapter       → opencli-adapter-author skill

阶段 2：Adapter 验证（逐个测试）
  2.1 opencli site-a list --limit 5
  2.2 opencli site-b search --query "test-name"
  2.3 opencli local excel-write --data '[{"name":"test"}]' --path /tmp/test.xlsx
  2.4 opencli site-c upload --name "test" --data '{"score":100}'

阶段 3：Workflow 组合
  3.1 创建 workflow YAML              → cliflow-workflow-author skill
  3.2 静态校验 cliflow validate xxx.yaml
  3.3 Dry-run  cliflow run xxx.yaml --dry-run

阶段 4：端到端测试
  4.1 小数据集测试 cliflow run xxx.yaml --arg limit=3 -v
  4.2 检查中间输出 cliflow run xxx.yaml --arg limit=3 -f json
  4.3 修复问题                        → cliflow-workflow-debugger skill

阶段 5：正式执行
  5.1 cliflow run xxx.yaml --arg limit=100
```

详细的计划模板见 `references/decomposition-patterns.md`。

---

## 第四步：执行工作计划

按阶段执行，每个阶段完成后验证再进入下一阶段。

### 阶段 1 路由规则

| adapter 类型 | 路由到 | 关键输入 |
|-------------|--------|---------|
| Web 读取 (PUBLIC) | `opencli-adapter-author` skill | 目标 URL + 需要的字段 |
| Web 读取 (需登录) | `opencli-adapter-author` skill | 目标 URL + 登录方式 |
| Web 写入 | `opencli-adapter-author` skill | 目标表单/API + 提交字段 |
| 本地文件处理 | 直接写 `clis/local/xxx.js` | 输入格式 + 输出格式 |
| MCP 桥接 | 配置 MCP server | 服务端点 + 工具列表 |

### Local Adapter 快速创建模板

本地处理类 adapter 不需要完整的 adapter-author 流程，直接使用模板：

```javascript
import { cli, Strategy } from '@jackwener/opencli/registry';

cli({
  site: 'local',
  name: 'xxx',
  description: '做什么的',
  access: 'write',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'data', type: 'string', required: true, help: '输入数据（JSON 字符串）' },
    { name: 'path', type: 'string', required: true, help: '输出文件路径' },
  ],
  columns: ['status', 'path', 'message'],
  func: async (kwargs) => {
    const data = JSON.parse(kwargs.data);
    // 处理逻辑
    return [{ status: 'success', path: kwargs.path, message: `Processed ${data.length} items` }];
  },
});
```

**创建后必须重建 manifest**：

```bash
npx tsx src/build-manifest.ts
```

如果不重建，`opencli list` 里不会出现新 adapter，workflow 也找不到它。这一步不能跳过。

**args 声明决定 workflow 能传什么参数**：

workflow 步骤的 `args` 只能传 adapter 通过 `args: [...]` 声明过的参数名。未声明的参数会被执行层忽略。如果 adapter 需要接收动态数据，必须在 `args` 数组中声明对应的参数。

```javascript
// 错误：只声明了 path，workflow 传的 data/ranking 等参数会被丢弃
args: [
  { name: 'path', type: 'string', required: true, help: 'Output path' },
],

// 正确：声明所有需要接收的参数
args: [
  { name: 'path', type: 'string', required: true, help: 'Output path' },
  { name: 'data', type: 'string', required: true, help: 'JSON data to save' },
],
```

### 阶段 2 验证要点

每个 adapter 必须通过独立测试后才能用于 workflow：

```bash
# 1. 重建 manifest（如果刚创建了新 adapter）
npx tsx src/build-manifest.ts

# 2. 小样本试跑确认可达 + 字段（没有独立的批量探测命令）
timeout 15 opencli site command --arg1 test-value --limit 1 -f json
```

试跑输出里的字段名，直接用于编写 workflow 的 `output.map` 和 `args`。写出最小 YAML 后，
`cliflow preflight <file.yaml>` 能一次性批量检查所有步骤引用的 adapter。

### 阶段 3 组合要点

切换到 `cliflow-workflow-author` skill，关键输入：
- 已验证的 adapter 列表 + 每个的输入参数和输出字段
- 数据流图（步骤间如何传递数据）
- 使用 `output.map` 解耦 adapter 原始字段名（详见 `cliflow-workflow-author` skill 的 `composability.md`）
- 声明 `inputs` / `outputs` 让 workflow 可复用

---

## 常见任务模式速查

| 任务模式 | 典型描述 | DAG 结构 | 参考 |
|---------|---------|---------|------|
| 单源采集 + 处理 | "从 A 获取数据，处理后存到 B" | 线性链 | `dag-patterns.md` §1 |
| 多源聚合 | "从 A、B、C 分别获取，合并分析" | 扇出→扇入 | `dag-patterns.md` §3 |
| 名单逐条处理 | "拿到名单后逐个搜索" | 线性 + foreach | `dag-patterns.md` §5 |
| 分类处理 | "按类别分别走不同流程" | 条件分支 | `dag-patterns.md` §4 |
| 数据迁移 | "从旧系统搬到新系统" | 线性 + foreach + retry | `error-strategies.md` |
| 监控上报 | "定期检查状态，异常时通知" | 线性 + condition | `dag-patterns.md` §4 |

详细的分解模式见 `references/decomposition-patterns.md`。

---

## 反模式

| 反模式 | 问题 | 正确做法 |
|--------|------|---------|
| 一个 adapter 做太多事 | 不可复用，难测试 | 拆成多个原子 adapter |
| 跳过 adapter 独立测试 | workflow 里出错难定位 | 每个 adapter 先独立跑通 |
| 跳过 API 可达性检查 | 运行时才发现 502/超时，浪费时间 | `timeout 15 opencli ... -f json` 先验证 |
| 在 workflow 里硬编码字段名 | 换 adapter 全炸 | 用 `output.map` 映射 |
| 不声明 inputs/outputs | 子 workflow 不可复用 | 每个 workflow 都加声明 |
| LLM 步骤做所有事 | 贵、慢、不稳定 | LLM 只做需要语义理解的步骤，规则化操作用 local adapter |
| 未检查 LLM 环境变量 | 运行时 LLM adapter 直接报错 | 先 `echo $DASHSCOPE_API_KEY` 或 `echo $LLM_ENDPOINT` |
| 直接跑大数据量 | 失败代价大 | 先用 `--arg limit=3` 小规模测试 |
| 创建 adapter 后不重建 manifest | adapter 不被发现 | `npx tsx src/build-manifest.ts` |
| adapter 不声明数据参数 | workflow 传的参数被执行层丢弃 | 所有需要接收的参数都写在 `args` 里 |
