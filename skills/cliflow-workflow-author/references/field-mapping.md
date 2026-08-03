# 跨站点字段映射规范

workflow 步骤间通过 `$item.<column_name>` 传递数据。如果上下游 adapter 用不同的字段名描述同一个概念，数据就断了。本文档规定跨站点通用的标准字段名。

---

## 标准字段名

以下字段名是 OpenCLI 的跨站点约定。adapter 的 `columns` 应优先使用这些名字。

### 通用实体字段

| 标准名 | 含义 | 类型 | 示例 |
|--------|------|------|------|
| `id` | 实体唯一标识 | string | `"12345"`, `"SKU-001"` |
| `title` | 标题/名称 | string | `"机械键盘 Cherry MX"` |
| `url` | 详情页链接 | string | `"https://..."` |
| `description` | 描述/摘要 | string | `"87键无线蓝牙..."` |
| `status` | 状态 | string | `"published"`, `"draft"`, `"sold_out"` |
| `created_at` | 创建时间 | string (ISO 8601) | `"2024-01-15T08:30:00Z"` |
| `updated_at` | 更新时间 | string (ISO 8601) | `"2024-03-20T14:00:00Z"` |
| `tags` | 标签列表 | string (逗号分隔) | `"电子,键盘,外设"` |
| `image_url` | 主图链接 | string | `"https://img.xxx/1.jpg"` |

### 商品/价格相关

| 标准名 | 含义 | 类型 | 单位/格式 |
|--------|------|------|----------|
| `price` | 价格 | number | 元（人民币），浮点数 |
| `original_price` | 原价 | number | 元 |
| `currency` | 币种 | string | `"CNY"`, `"USD"` |
| `stock` | 库存 | number | 整数 |
| `sales` | 销量 | number | 整数 |
| `rating` | 评分 | number | 0-5 或 0-10（adapter 文档注明） |
| `review_count` | 评价数 | number | 整数 |
| `category` | 分类 | string | `"电子产品"` |
| `brand` | 品牌 | string | `"Cherry"` |
| `seller` | 卖家/店铺名 | string | `"XX旗舰店"` |

### 内容/文章相关

| 标准名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| `author` | 作者 | string | |
| `content` | 正文内容 | string | 纯文本或 markdown |
| `publish_date` | 发布日期 | string (ISO 8601) | |
| `view_count` | 浏览量 | number | |
| `like_count` | 点赞数 | number | |
| `comment_count` | 评论数 | number | |
| `source` | 来源站点 | string | `"site-a"`, `"site-b"` |

### 操作结果相关

| 标准名 | 含义 | 类型 | 说明 |
|--------|------|------|------|
| `status` | 操作状态 | string | `"success"`, `"failed"`, `"skipped"` |
| `id` | 创建/更新后的实体 ID | string | |
| `url` | 创建后的详情页 URL | string | |
| `message` | 状态描述 | string | 成功/失败原因 |

---

## 映射规则

### 规则 1：adapter columns 优先使用标准名

写 adapter 时，如果数据含义和标准名匹配，直接用标准名。不要发明新名字。

```javascript
// 好
columns: ['id', 'title', 'price', 'url']

// 不好 — 下游要猜 product_name 就是 title
columns: ['product_id', 'product_name', 'product_price', 'product_url']
```

### 规则 2：用 output.map 归一化非标准字段（Anti-Corruption Layer）

当 adapter 已经存在且字段名非标准时，**不修改 adapter**，在 workflow 中用 `output.map` 归一化：

```yaml
# adapter 输出 {product_name, product_price, product_url}
# 通过 output.map 映射为标准字段名

fetch-products:
  adapter: site/list
  args: { category: "hot" }
  output:
    as: products
    map:
      title: product_name      # 映射为标准名
      price: product_price
      url: product_url

# 下游引用标准名
process:
  foreach: $products
  args:
    name: "$item.title"        # 不依赖 adapter 的 product_name
    link: "$item.url"
```

**换 adapter 只改 map**：

```yaml
# 换成另一个 adapter，字段名不同
fetch-products:
  adapter: another-site/list     # 换了 adapter
  args: { category: "hot" }
  output:
    as: products
    map:
      title: name              # 只改这里
      price: cost
      url: link
# 下游所有步骤不变
```

### 规则 3：站点特有字段用描述性命名

标准名覆盖不了的、站点特有的字段，用描述性命名即可：

```javascript
// 好 — 字段名自解释
columns: ['id', 'title', 'price', 'coupon_price', 'commission_rate']

// 不好 — 缩写不透明
columns: ['id', 'ttl', 'prc', 'cprc', 'cr']
```

### 规则 4：YAML 里做字段名映射（简单情况）

上下游 adapter 的字段名不一致但无需全局解耦时，在 `args` 里显式映射：

```yaml
publish:
  adapter: target-site/create
  args:
    name: $item.title     # title -> name
    link: $item.url       # url -> link
    cost: $item.price     # price -> cost
  foreach: $source_items
```

### 规则 5：LLM 步骤做复杂转换

字段需要计算/合并/拆分时，用 `adapter: dashscope/chat` + `json_mode: true` 处理：

```yaml
transform:
  adapter: dashscope/chat
  args:
    prompt: |
      将以下数据转换格式。对每条记录：
      1. 合并 first_name 和 last_name 为 full_name
      2. 将 price_cents 除以 100 转为 price（元）
      3. 保留 id, url 不变

      输出 JSON 数组，每条包含 id, full_name, price, url 字段。
      $raw_data
    json_mode: true
  output: transformed
  depends_on: [fetch]
```

---

## 常见陷阱

| 陷阱 | 现象 | 解法 |
|------|------|------|
| 字段名拼错 | `$item.tittle` 拿到 undefined | 跑 adapter --help 确认 columns |
| 大小写不一致 | `$item.URL` vs adapter 输出 `url` | 统一用小写 snake_case |
| 单位不一致 | 上游价格单位是"分"，下游期望"元" | LLM 步骤（dashscope/chat）做转换，或在 adapter 层统一 |
| 日期格式不一致 | 上游 `2024-01-15`，下游要 timestamp | LLM 步骤（dashscope/chat）转换 |
| 缺少 source 标识 | 多平台合并后分不清来源 | adapter 输出加 `source` 列 |
