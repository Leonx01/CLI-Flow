# 常见失败模式与排查

本文档按失败阶段分类，覆盖 workflow 生命周期中的典型故障。

---

## 阶段 1：解析失败（YAML 加载阶段）

### 1.1 YAML 语法错误

**报错**：`YAML parse error` / `invalid YAML`

**常见原因**：
- 缩进不一致（混用 tab 和空格）
- 字符串中有特殊字符未加引号（`:`, `#`, `{`, `}`）
- 数组语法错误

**修复**：
```yaml
# 错误：冒号后面直接跟中文
description: 做什么的：详细说明

# 正确：加引号
description: "做什么的：详细说明"

# 错误：$变量在无引号的值中
args:
  query: $keyword  # 可能被 YAML 解析器误解

# 正确：加引号
args:
  query: "$keyword"
```

### 1.2 步骤类型不匹配

**报错**：`Step "xxx" (type: adapter) must have an "adapter" field`

**原因**：`type: adapter` 步骤缺少 `adapter` 字段（也不是 `interact` 纯交互节点）

**修复**：检查每种类型的必需字段：
- `adapter` 步骤需要 `adapter: site/command`
- `workflow` 步骤需要 `workflow: ./path.yaml`
- 纯交互节点（无 `adapter`）需要 `interact: {type, message, ...}`

**旧版遗留**：如果看到 `type "ai" has been removed` 报错，说明用了已废弃的 `type: ai`。改用 `adapter: dashscope/chat`（或 `llm/chat`）+ `args: { prompt, json_mode: true }`，具体见 `cliflow-workflow-author` skill 的"LLM 处理"一节。

---

## 阶段 2：验证失败（validate 阶段）

### 2.1 循环依赖

**报错**：`Cycle detected: A → B → A`

**排查决策树**：
```
检查 depends_on 链
  ├─ 真的有循环 → 重新设计 DAG，引入中间步骤打破循环
  └─ 拼错步骤名导致误解析 → 修正步骤名
```

### 2.2 变量未定义

**报错**：`$xxx may be undefined (not produced before this step)`

**排查决策树**：
```
变量 $xxx 来自哪里？
  ├─ 来自上游步骤输出 → 检查 depends_on 是否包含该步骤
  ├─ 来自 workflow inputs → 检查 inputs 声明中是否有 xxx
  ├─ 来自 foreach 的 $item → 这是正常的，validator 会跳过 $item/$index
  └─ 拼写错误 → 修正变量名（注意不含 dash）
```

---

## 阶段 3：运行时失败

### 3.1 Adapter 不存在

**报错**：`Adapter not found: site/command`

**排查**：
```bash
# preflight 会提前发现这个问题
cliflow preflight my-workflow.yaml

# 手动检查
opencli list | grep "site"
```

### 3.2 参数错误

**报错**：`ArgumentError: Missing required argument "xxx"`

**排查**：
```bash
# 查看 adapter 期望的参数
opencli site command --help

# 对比 workflow YAML 中的 args
# 常见错误：参数名拼错、缺少 required 参数、类型不匹配
```

### 3.3 Adapter 运行时错误

**报错**：`CommandExecutionError: ...`

**排查决策树**：
```
单独运行 adapter 能成功吗？
  ├─ 能 → 问题在变量传递
  │    ├─ 检查 $variable 是否解析为预期值
  │    └─ 检查类型：adapter 步骤的 args 会 JSON.stringify 对象
  └─ 不能 → 问题在 adapter 本身
       ├─ 网络问题 → 检查网络连通性
       ├─ 认证问题 → 先 `opencli site login`
       ├─ 站点变更 → 用 opencli-autofix skill 修复 adapter
       └─ 限流 → 降低 concurrency
```

### 3.4 Required Input 缺失

**报错**：`Workflow "xxx" requires input "yyy"`

**排查**：
```
是顶层 workflow 还是嵌套子 workflow？
  ├─ 顶层 → 检查 CLI --arg 是否提供了所有 required inputs
  │         cliflow run xxx.yaml --arg yyy=value
  └─ 嵌套 → 检查父 workflow 的 type: workflow 步骤的 args
            args:
              yyy: "$item.some_field"  # 确保传递了所有 required 参数
```

### 3.5 超时

**报错**：`Step "xxx" timed out after Ns`

**排查决策树**：
```
单个 adapter 调用慢还是 foreach 整体慢？
  ├─ 单个慢 → 增加 timeout: 600（单步超时）
  ├─ foreach 整体慢 → 降低 concurrency 减轻目标压力
  └─ 整个 workflow 超时 → 检查全局 timeout 设置
```

### 3.6 数据类型问题

**报错**：步骤收到字符串而非对象/数组

**原因**：`resolveArgs()` 会 JSON.stringify 对象值，adapter 步骤收到的是字符串

**修复**：
- 如果 adapter 期望 JSON 字符串 → 这是正确行为
- 如果是 workflow→workflow 传值 → 引擎已使用 `resolveArgsTyped()`，自动保留类型
- 如果需要在 adapter 中接收对象 → adapter 的 func 中需要 `JSON.parse`

### 3.7 Adapter 收不到 workflow 传的参数

**症状**：adapter 的 func 中 `kwargs` 缺少 workflow `args` 里明确传的参数

**原因**：**workflow args 只能传 adapter 声明过的参数名**。未在 adapter 的 `args: [...]` 中声明的参数会被执行层丢弃。

**修复**：在 adapter 的 `cli({...})` 中添加缺失的参数声明：

```javascript
// 错误：只声明了 path，workflow 传的 data 参数被丢弃
args: [
  { name: 'path', type: 'string', required: true, help: 'Output path' },
],

// 正确：声明所有需要接收的参数
args: [
  { name: 'path', type: 'string', required: true, help: 'Output path' },
  { name: 'data', type: 'string', required: true, help: 'JSON data to save' },
],
```

修改 adapter 后需要重建 manifest：`npx tsx src/build-manifest.ts`

### 3.8 新建 adapter 不被发现

**报错**：`Adapter not found: local/xxx`（但文件明明存在）

**原因**：CLI 使用 `cli-manifest.json` 缓存做快速启动。新建的 adapter 不在缓存中。

**修复**：
```bash
npx tsx src/build-manifest.ts
# 重建后重新运行即可
```

---

## 阶段 4：输出不符预期

### 4.1 输出字段缺失

**现象**：下游步骤的 `$item.xxx` 为 undefined，但 workflow 未报错

**排查**：
```bash
# 用 JSON 格式查看上游步骤的实际输出
cliflow run xxx.yaml --arg limit=1 -f json

# 检查输出中是否有预期的字段
# 如果用了 output.map，检查映射是否正确
```

### 4.2 output.map 映射错误

**现象**：映射后字段值全是 null/undefined

**原因**：map 中的 adapter 字段名（值）写错了

**修复**：
```bash
# 先确认 adapter 的实际输出字段名
opencli site command -f json | head -5

# 对比 output.map 中的值是否匹配
output:
  as: items
  map:
    title: name        # "name" 必须是 adapter 实际输出的字段名
```

### 4.3 嵌套 workflow 返回不完整

**现象**：子 workflow 有 4 个步骤输出，但只返回了部分

**原因**：子 workflow 声明了 `outputs`，只返回声明的变量

**确认**：检查子 workflow 的 `outputs` 字段，添加遗漏的变量名

### 4.4 foreach 结果数量不对

**现象**：预期 10 条记录，实际只有 7 条

**排查**：
```
on_error 策略是什么？
  ├─ skip → 3 条失败被跳过（检查 -v 日志确认）
  ├─ condition → 3 条不满足条件被过滤
  └─ adapter 返回空 → 3 个输入对应的查询无结果
```

---

## 快速排查速查表

| 症状 | 最可能原因 | 第一步排查 |
|------|-----------|-----------|
| 重复出现的老问题 | 之前踩过但没记住 | `cliflow memory <workflow-name>` / `cliflow memory adapter <site>` |
| 整个 workflow 直接报错 | YAML 语法 / 循环依赖 | `cliflow validate` |
| 第一个步骤就失败 | adapter 不存在 / 参数错 | `opencli list \| grep site` |
| 新 adapter 不被发现 | manifest 缓存未更新 | `npx tsx src/build-manifest.ts` |
| 中间步骤失败 | 变量未定义 / 字段映射错 | 加 `-v` 看变量解析日志 |
| 写入步骤反复失败 | 认证过期 / 限流 | `opencli site login` + 降低 concurrency |
| 输出数据为空 | 上游无数据 / foreach 变量名错 | 单独运行上游 adapter |
| 输出字段全是 null | output.map 字段名拼错 | adapter `-f json` 确认字段名 |
| 子 workflow 报 requires input | 父 args 漏传参数 | 对比子 inputs 声明和父 args |
| adapter 收不到参数 | 参数未在 adapter args 中声明 | 检查 adapter 的 `args: [...]` |
| 多步 skip 但显示 completed | skip 级联：整步失败 → 输出 undefined → 下游级联 | 核心步骤改 `on_error: stop` |
| foreach 步骤超时 | timeout 是整步级别，不是每条 | `timeout ≈ ceil(items/concurrency) × per_item × 1.5` |
| LLM adapter 直接报错 | `DASHSCOPE_API_KEY` 或 `LLM_ENDPOINT`/`OPENCLI_AI_ENDPOINT` 未设置 | `echo $DASHSCOPE_API_KEY` / `echo $LLM_ENDPOINT` |
