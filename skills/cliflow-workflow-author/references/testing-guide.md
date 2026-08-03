# Workflow 测试指南

本文档覆盖 workflow 从编写到上线的完整测试流程。

---

## 1. 测试顺序

```
单个 adapter 测试 → 静态校验 → 小规模运行 → 全量运行
```

**不要跳步**。workflow 出错时最难定位的是"某个 adapter 参数传错了"——先确认每个 adapter 独立可用。

---

## 2. 单个 Adapter 测试

单独确认参数，再用小样本试跑确认可达（YAML 还没写时，没有独立的批量探测命令）：

```bash
# 查看参数和输出列
opencli site command --help

# 小样本试跑，确认可达 + 真实字段名（加 timeout 防止 API 挂起）
timeout 15 opencli site command --arg1 value --limit 1 -f json
```

### 记录表

把每个 adapter 的输入参数、输出字段记下来，供 workflow 编写时用：

```
| adapter | 输入参数 | 输出字段 | 试跑状态 |
|---------|---------|---------|-----------|
| site-a/list | query, limit | id, name, url | ok |
| site-b/search | q(位置参数), max_results | title, score, link | ok |
| local/save-json | path, data | path, size | ok |
```

---

## 2.5 Preflight 预检

写完 workflow YAML 后、运行之前，执行预检。这一步会**批量**探测 YAML 中引用到的所有 adapter
（等价于之前的 `adapter probe`，只是现在要先有 YAML 才能触发）：

```bash
cliflow preflight my-workflow.yaml
```

Preflight 会自动检查：
- YAML 语法 + DAG 合法性 + 变量引用
- 每个 adapter 步骤的可用性（probe）
- workflow args 是否匹配 adapter 声明的参数
- output.map 的字段名是否匹配 adapter 的 columns
- LLM adapter 的环境变量（`DASHSCOPE_API_KEY` 或 `LLM_ENDPOINT`/`OPENCLI_AI_ENDPOINT`）
- 浏览器桥接状态
- 嵌套子 workflow 文件是否存在

**一个命令替代之前所有手动检查**。只要 preflight 全通过，workflow 基本不会因为配置问题失败。
注意：`cliflow preflight` 没有 `-f json` 选项，只有纯文本输出。

---

## 3. 静态校验

```bash
cliflow validate my-workflow.yaml
```

校验器检查：
- YAML 语法
- 循环依赖（DAG 合法性）
- 变量引用有效性（`$varname` 对应一个已知的步骤输出或 input 声明）
- 依赖链完整性（引用的步骤在 `depends_on` 的传递闭包中）

### 常见校验报错

| 报错 | 原因 | 修复 |
|------|------|------|
| `Cycle detected` | 步骤互相依赖 | 检查 depends_on，打破循环 |
| `Unknown step in depends_on` | 步骤名拼错 | 检查步骤名拼写 |
| `$xxx may be undefined` | 引用了未声明的变量 | 添加 depends_on 或检查变量名 |

---

## 4. 小规模运行

**用最小数据量跑通整个流程**：

```bash
# 通过 --arg 传参限制数据量
cliflow run my-workflow.yaml --arg limit=3 -v

# JSON 格式查看完整输出（机器可读）
cliflow run my-workflow.yaml --arg limit=3 -f json

# YAML 格式（人类可读）
cliflow run my-workflow.yaml --arg limit=3 -f yaml
```

### 检查要点

1. **每个步骤是否 completed**：看控制台输出的步骤状态
2. **输出数据结构是否正确**：`-f json` 查看完整 context
3. **字段映射是否生效**：检查 output.map 后的变量是否包含正确的字段
4. **foreach 是否正常展开**：检查结果数组长度是否符合预期
5. **on_error: skip 的步骤**：检查是否有合理数量的跳过
6. **末尾的 `hint:` 提示**：有相关历史 memory 或值得记录本次发现时会打印，照做

---

## 5. 常见失败模式

### 5.1 变量 undefined

**现象**：步骤的 args 中 `$varname` 解析为 `undefined`

**排查**：
1. 检查上游步骤是否真的输出了这个变量名
2. 检查 `depends_on` 是否包含了上游步骤
3. 检查变量名拼写（注意 dash 不允许出现在变量名中）
4. 加 `-v` 看 debug 日志中的变量解析信息

### 5.2 adapter 报参数错误

**现象**：`ArgumentError` 或 adapter 返回错误

**排查**：
1. 单独运行 adapter 确认参数：`opencli site command --help`
2. 检查传入的参数值是否正确（类型、格式）
3. 注意 `resolveArgs` 会 JSON.stringify 对象——adapter 收到的是字符串

### 5.3 foreach 数据为空

**现象**：foreach 步骤跳过，输出为空数组

**排查**：
1. 检查上游步骤是否有数据输出
2. 检查 foreach 引用的变量名是否正确
3. 上游是否用了 `output.map` 导致变量名变了

### 5.4 嵌套 workflow 报 "requires input"

**现象**：`Workflow "xxx" requires input "yyy"`

**排查**：
1. 检查子 workflow 的 `inputs` 中哪些是 `required: true`
2. 检查父 workflow 的 `args` 是否提供了所有 required 输入
3. 检查 `$item.xxx` 是否在 foreach 上下文中正确解析

### 5.5 步骤超时

**现象**：步骤执行超过 300s 被终止

**排查**：
1. 降低 `concurrency` 避免触发站点限流
2. 添加 `timeout: 600` 增加单步超时时间
3. 对大数据集考虑分批处理

---

## 6. Checkpoint 与 Resume

长时间运行的 workflow 建议开启 checkpoint：

```yaml
name: long-running-pipeline
checkpoint: true    # 每步完成后保存进度

steps: ...
```

### 中断后恢复

```bash
# 查看已保存的 checkpoint
cliflow list

# 从 checkpoint 恢复
cliflow run my-workflow.yaml --resume <runId>
```

已完成的步骤不会重复执行，从中断点继续。

---

## 7. 测试清单

```
[ ] 每个 adapter 独立测试通过
[ ] 记录每个 adapter 的输出字段名
[ ] cliflow validate 无报错
[ ] --dry-run 查看执行计划合理
[ ] --arg limit=3 小规模运行通过
[ ] -f json 检查输出数据结构正确
[ ] output.map 映射后字段名正确
[ ] foreach 步骤结果数量符合预期
[ ] on_error: skip 步骤的跳过数量在合理范围
[ ] 全量运行通过
[ ] 运行结束的 hint: 提示已处理（记录发现或复查历史笔记）
```
