# 相似度检测契约

状态：产品语义事实源。

Optipass 的相似分析只负责找出可能表示同一真实账号或同一记录的 item。它不区分相似组、全等组和建议删除组，也不使用密码、凭据哈希、备注或完整内容指纹参与分组。

## 相似关系

两个 item 同时满足 identity 相同和 URL 相似时，建立相似关系：

```text
similar = identityMatch && urlMatch
```

### Identity 相同

username 和 email 共同组成显式 identity 集合。字段值只执行以下规范化：

```text
trim(value).toLowerCase()
```

- 丢弃规范化后的空字符串。
- username 可以与另一个 item 的 email 字段交叉匹配。
- 不执行模糊匹配、空白折叠或其他字符串改写。

title 使用同样的规范化方式单独比较。只有两个 item 都没有任何规范化后的 username/email identity 时，title 相同才能满足 identity 条件；只要任一 item 存在显式 identity，就不能通过 title 建立相似关系。是否包含 Passkey 不影响该规则。

因此：

```text
identityMatch = explicitIdentityIntersection
  || (bothExplicitIdentitySetsEmpty && normalizedTitleEqual)
```

### URL 相似

每个非空 URL 首先使用标准 URL 对象解析。只有解析结果包含 hostname 时才按结构化 URL 处理；没有 hostname 的结果使用原始字符串回退规则。

解析成功时，比较以下部分：

- scheme 相同；
- hostname 相同；
- 有效端口相同；
- path 相同；
- query 和 hash 不参与比较。

hostname 遵循 URL 对象的大小写规范化，不折叠 `www`，也不合并不同子域名。URL 对象会把显式默认端口与省略默认端口视为相同，例如 `https://example.com:443` 与 `https://example.com`。

非根 path 最末尾的一个 `/` 在比较前删除，因此 `/login` 与 `/login/` 相同；根路径仍保持为 `/`。不继续折叠多个尾斜杠。

解析失败时，退回以下字符串匹配：

```text
trim(rawUrl).toLowerCase()
```

回退字符串必须全等。此时不猜测 URL 结构，因此 query 和 hash 仍属于字符串内容。

item 包含多个 URL 时，只要双方存在一对相似 URL，就满足 URL 条件。没有任何非空 URL 的 item 不参与分组。

## 分组

相似分析把 item 视为节点，把相似关系视为无向边，最终输出图的连通分量：

```text
item = node
similar relation = edge
connected component = similarity group
```

传递关系仍适用于合法相似边，但缺少显式 identity 的 item 不能仅凭 title 连接到存在 identity 的账号组。

最终分组满足：

- 每个 item 最多属于一个组；
- 只输出至少包含两个 item 的组；
- 推荐保留项不影响组成员关系；
- 用户可以保留多条、归档或删除任意 item，也可以整组不保留或跳过整组；
- 整组永久删除仍遵循执行计划的显式删除确认协议。

## 明确排除

以下信息不参与相似关系和分组：

- 密码及其哈希；
- TOTP、Passkey 或其他凭据是否存在；
- 备注内容；
- 附件；
- 字段数量；
- item 是否全等；
- item 分类；
- 数据完整度和删除建议。
