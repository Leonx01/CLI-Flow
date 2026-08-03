# 能力盘点指南

拆解完任务后，第一件事是盘点当前系统已有的能力，避免重复造轮子。

---

## 1. 快速盘点命令

```bash
# 列出所有已注册 adapter
opencli list

# 按站点名过滤
opencli list | grep "hackernews"

# 查看某个 adapter 的参数和输出列
opencli hackernews top --help
#   重点看 "Output columns:" 行 —— 字段名用于 workflow 的 output.map

# 快速测试 adapter 是否可用（加 timeout 防 API 挂起）
timeout 15 opencli hackernews top --limit 3 -f json
```

---

## 2. API 可达性验证

**没有独立的批量探测命令**——批量探测逻辑（下面的状态表）现在只作为 `cliflow preflight`/
`cliflow probe` 的内部实现，触发它们需要先有一份 workflow YAML。分两个阶段验证：

**阶段 A：写 YAML 之前，逐个 adapter 真实小样本试跑**（用第 1 节的 `timeout 15 opencli
<site> <cmd> --limit 1 -f json`，能拿到真实可达性 + 真实字段名）。

**阶段 B：YAML 写出来之后，一次性批量检查所有步骤引用的 adapter**：

```bash
# 批量检查 YAML 中每个步骤对应的 adapter（复用同一套探测逻辑）
cliflow preflight my-workflow.yaml

# 检查 YAML 涉及的外部服务可达性 + 登录态（独立于 preflight，更聚焦在这一点）
cliflow probe my-workflow.yaml
```

### 探测状态含义（`cliflow preflight` 内部报告的分类）

| status | 含义 | 行动 |
|--------|------|------|
| `ok` | API 可达 | 可以使用 |
| `timeout` | API 无响应 | 标记为不可用，寻找替代 |
| `unreachable` | HTTP 5xx 错误 | 同上 |
| `no-bridge` | 浏览器 daemon 未就绪 | 先 `opencli daemon start` + 安装扩展 |
| `no-auth` | 需要登录 | 先 `opencli site login` |
| `not-found` | adapter 不存在 | 需要创建 |

`cliflow preflight` 的报告里同时包含每个 adapter 的 `columns`（输出字段列表）和 `args`
（参数列表），可直接用于编写 workflow 的 `output.map` 和 `args`。

---

## 3. 输出字段名获取（用于 output.map）

`cliflow preflight` 报告中的 `columns` 字段已经包含了 adapter 声明的输出列名。如果需要更精确的确认：

```bash
# 从 --help 获取
opencli site command --help
# 看 "Output columns:" 行

# 实际运行确认（pipeline adapter 可能有 --help 未列出的计算字段）
opencli site command --arg1 value --limit 1 -f json 2>/dev/null | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d[0].keys()) if d else '空')"
```
1. **用 `output.map` 映射**（推荐）— 字段名不同但数据有就行
2. **创建新 adapter** — 数据根本拿不到的情况

---

## 4. 缺失能力的创建路径

### Web 读取 adapter（需要 opencli-adapter-author skill）

创建流程：
1. `opencli browser analyze <url>` — 识别站点类型
2. `opencli browser network <url>` — 发现 API 端点
3. 选择 Strategy (PUBLIC → COOKIE → UI)
4. 编写 adapter，测试验证

**估计耗时**：15-45 分钟/adapter

### Web 写入 adapter（需要 opencli-adapter-author skill）

创建流程：
1. 分析目标表单/API 的提交方式
2. 通常需要 COOKIE 或 UI strategy（写操作往往需要登录）
3. 编写 adapter，用测试数据验证

**估计耗时**：30-60 分钟/adapter

### Local 处理 adapter（直接创建）

不需要完整的 adapter-author 流程。直接在 `clis/local/` 下创建 JS 文件：

```bash
ls clis/local/
# 查看已有的 local adapter 作为参考
```

常见的 local adapter 模板：

#### Excel 写入

```javascript
import { cli, Strategy } from '@jackwener/opencli/registry';
import * as XLSX from 'xlsx';
import * as fs from 'node:fs';

cli({
  site: 'local',
  name: 'excel-write',
  description: 'Write JSON data to Excel file',
  access: 'write',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'path', type: 'string', required: true, help: 'Output file path (.xlsx)' },
  ],
  columns: ['status', 'path', 'rowCount'],
  func: async (kwargs) => {
    const { path: filePath, ...dataArgs } = kwargs;
    const data = Object.values(dataArgs).find(v => {
      try { return Array.isArray(JSON.parse(v)); } catch { return false; }
    });
    const rows = data ? JSON.parse(data) : [];
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, filePath);
    return [{ status: 'success', path: filePath, rowCount: rows.length }];
  },
});
```

#### Excel 读取

```javascript
cli({
  site: 'local',
  name: 'excel-read',
  description: 'Read Excel file to JSON',
  access: 'read',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'path', type: 'string', required: true, help: 'Input file path (.xlsx)' },
    { name: 'sheet', type: 'string', default: 'Sheet1', help: 'Sheet name' },
  ],
  func: async (kwargs) => {
    const wb = XLSX.readFile(kwargs.path);
    const ws = wb.Sheets[kwargs.sheet || wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws);
  },
});
```

#### 数据过滤/排序

```javascript
cli({
  site: 'local',
  name: 'rank',
  description: 'Sort and rank JSON data by a field',
  access: 'read',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'data', type: 'string', required: true, help: 'JSON array string' },
    { name: 'by', type: 'string', required: true, help: 'Field to sort by' },
    { name: 'order', type: 'string', default: 'desc', help: 'asc or desc' },
    { name: 'top', type: 'int', default: 10, help: 'Number of top results' },
  ],
  func: async (kwargs) => {
    let data = JSON.parse(kwargs.data);
    const field = kwargs.by;
    const asc = kwargs.order === 'asc';
    data.sort((a, b) => asc ? a[field] - b[field] : b[field] - a[field]);
    return data.slice(0, kwargs.top).map((item, i) => ({ ...item, rank: i + 1 }));
  },
});
```

**估计耗时**：5-15 分钟/adapter

---

## 5. MCP Bridge 能力

如果目标能力已有 MCP Server 实现，可以通过 bridge 接入：

```bash
# 配置 MCP server
opencli bridge add my-service --transport stdio --command "node" --args "path/to/server.js"

# 发现可用工具
opencli bridge discover my-service

# 工具自动注册为 adapter，可在 workflow 中直接使用
```

---

## 6. 能力盘点清单模板

对每个需要的原子操作填写：

```
| # | 操作 | 需要的 adapter | 是否已存在 | 行动 | 优先级 |
|---|------|--------------|-----------|------|--------|
| 1 | 获取名单 | site-a/list | [ ] 是 [ ] 否 | [ ] 直接用 [ ] 创建 | P0 |
| 2 | 搜索信息 | site-b/search | [ ] 是 [ ] 否 | [ ] 直接用 [ ] 创建 | P0 |
| 3 | 写 Excel | local/excel-write | [ ] 是 [ ] 否 | [ ] 直接用 [ ] 创建 | P1 |
| 4 | 排名分析 | dashscope/chat | 是（内置） | [x] 直接用 | P1 |
| 5 | 上传结果 | site-c/upload | [ ] 是 [ ] 否 | [ ] 直接用 [ ] 创建 | P0 |
```

优先级：
- **P0**：workflow 核心路径，必须有
- **P1**：增强功能，可用 LLM 步骤（dashscope/chat）替代
- **P2**：锦上添花，可后续补充
