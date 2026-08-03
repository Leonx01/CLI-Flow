# Workflow 组合与复用（Composability）

本文档覆盖 workflow 的组合机制：`inputs`/`outputs` 声明、`type: workflow` 嵌套调用、`output.map` 解耦。

---

## 1. inputs/outputs 声明（Ports & Adapters）

每个 workflow 应声明自己需要什么输入、暴露什么输出。这让 workflow 成为可复用的"组件"。

### 语法

```yaml
name: enrich-person
description: 对单个人进行信息丰富化

inputs:
  person_id:
    type: string
    required: true
    description: "人员 ID"
  person_name:
    type: string
    required: true
  include_social:
    type: boolean
    default: false
    description: "是否包含社交媒体信息"

outputs: [profile, social_links]

steps:
  # ...
```

### inputs 字段

| 属性 | 类型 | 说明 |
|------|------|------|
| `type` | string | `string` / `number` / `boolean` / `array` / `object` |
| `required` | boolean | 为 true 时，调用方必须提供此参数 |
| `default` | any | 调用方未提供时使用的默认值 |
| `description` | string | 参数描述（文档用途） |

### outputs 字段

```yaml
outputs: [enriched, summary]
```

- 字符串数组，列出要暴露的变量名
- 嵌套调用时，父 workflow 只能看到 outputs 中声明的变量
- 未声明 outputs 时，返回所有步骤输出（不推荐——暴露内部实现细节）

### CLI 调用

```bash
# --arg 对应 inputs 声明
cliflow run enrich.yaml --arg person_id=12345 --arg person_name="张三"

# 值会自动 JSON 解析：数字、布尔、数组、对象
cliflow run report.yaml --arg limit=10 --arg tags='["a","b"]'
```

---

## 2. 嵌套 Workflow（type: workflow）

将可复用的子流程封装为独立 YAML，父 workflow 通过 `type: workflow` 调用。

### 语法

```yaml
# parent.yaml
steps:
  process-each:
    type: workflow
    workflow: ./sub-process.yaml    # 相对于父 YAML 的路径
    args:                           # 传给子 workflow 的 inputs
      item_id: "$item.id"
      item_name: "$item.name"
    foreach: $items                 # 可选：对列表逐条调用子 workflow
    concurrency: 3                  # 可选：并发数
    output: results                 # 父上下文中的变量名
    depends_on: [list-items]
```

### 行为

1. **解析**：引擎解析子 YAML 文件（路径相对于父 YAML 所在目录）
2. **参数传递**：`args` 中的值通过 `resolveArgsTyped` 传递，**保留原始类型**（数组、对象不会被 stringify）
3. **独立执行**：子 workflow 有独立的 context，不会污染父的变量空间
4. **输出过滤**：如果子 workflow 声明了 `outputs`，只返回声明的变量
5. **foreach**：对列表每条记录分别创建子 workflow 实例，结果收集为数组

### 设计原则

**什么时候拆成子 workflow**：
- 同一套处理逻辑会被多个地方调用
- 处理逻辑本身有 3+ 步骤，独立封装降低复杂度
- 需要对列表中每条记录做相同的多步处理

**什么时候不拆**：
- 处理逻辑只有 1-2 步 → 直接写在父 workflow 里
- 处理逻辑不会被复用 → 拆出去增加了理解成本

### 三级嵌套示例

```
grandparent.yaml
  └─ type: workflow → mid-level.yaml (foreach: $batches)
       └─ type: workflow → leaf.yaml (foreach: $items)
            └─ adapter steps...
```

每层都声明 `inputs`/`outputs`，层间通过声明的接口通信，内部步骤互不可见。

---

## 3. output.map 解耦（Anti-Corruption Layer）

`output.map` 在 adapter 输出和 workflow 变量之间建立映射层。下游步骤依赖映射后的领域名，不依赖 adapter 的原始字段名。

### 语法

```yaml
output:
  as: packages         # 变量名（不带 map 时等同于 output: "packages"）
  map:
    pkg_name: name       # 领域名: adapter 原始字段名
    pkg_desc: description
    dl_count: weeklyDownloads
```

### 映射行为

| adapter 返回 | map 配置 | 映射后结果 |
|-------------|---------|-----------|
| `[{name: "react", description: "...", weeklyDownloads: 1000}]` | `{pkg_name: name, ...}` | `[{pkg_name: "react", pkg_desc: "...", dl_count: 1000}]` |

- 对数组中的每个元素应用映射
- 对单个对象也适用
- 只保留 map 中声明的字段（其余丢弃）
- 没有 map 时保留原始字段

### 什么时候用 output.map

| 场景 | 用不用 | 原因 |
|------|--------|------|
| adapter 可能被替换 | **用** | 换 adapter 只改 map，下游不变 |
| 多个 adapter 输出到同一个下游 | **用** | 统一字段名 |
| adapter 字段名太长/不规范 | **用** | 映射为简洁的领域名 |
| 单个简单 adapter，不会替换 | 可不用 | 过度设计 |

### 向后兼容

```yaml
# 旧写法（仍然支持）
output: result_var

# 等价于
output:
  as: result_var
```

---

## 4. 步骤名命名规范

- 步骤名可以用 **kebab-case**（推荐）：`fetch-products`、`generate-report`
- 步骤名中的 **dash 自动转为 underscore** 作为默认输出变量名：`fetch-products` → `$fetch_products`
- 显式 `output` 覆盖默认变量名
- **变量名不允许 dash**：`$batch_id` 合法，`$batch-id` 会被解析为 `$batch` 减去 `id`

---

## 5. 组合模式速查

| 模式 | 结构 | 适用场景 |
|------|------|---------|
| 线性 + foreach | A → B(foreach) → C | 获取列表 → 逐条处理 → 汇总 |
| 扇出 + map 统一 | A,B,C → merge | 多源数据用 map 统一字段后合并 |
| 嵌套 + foreach | A → workflow(foreach) → B | 每条记录走相同的多步流程 |
| 多级嵌套 | parent → mid → leaf | 层级化分解复杂任务 |
| 子 workflow 复用 | A 调 X，B 也调 X | 封装公共处理逻辑 |
