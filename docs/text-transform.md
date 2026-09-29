# 域名与品牌文本保护

此功能在 CCH 实际发送请求前，把配置的原词转换为固定代称；收到 JSON 或 SSE 响应后还原。默认关闭。配置只保存在 CCH，不会作为提示词发给模型。

## 配置

后台入口为“设置 → 文本保护”（`/settings/text-transform`），仅管理员可访问。页面可管理启用状态、映射列表、大小写匹配和供应商范围，并提供三条 Wingjoy 示例。新增规则、编辑或删除后点击“保存配置”即可生效。

配置保存到 `text_transform_settings` 表，数据库记录优先于环境变量。尚未保存过时，兼容现有 `CCH_TEXT_TRANSFORM` 环境配置；两者都不存在时默认关闭。后台保存“关闭”后不会重新启用环境变量中的旧规则。

部署此版本前先执行迁移（或使用部署中的 `AUTO_MIGRATE`）：

```sh
bun run db:migrate
```

迁移 `0111_shocking_reptil.sql` 由 Drizzle 生成并增加幂等建表保护，不预置或启用任何规则。管理 API 为 `GET/PUT /api/v1/text-transform`，接入管理员认证和 Cookie CSRF 校验，API 文档包含配置结构。

保存使用版本号防止并发覆盖；过期页面收到冲突提示，编辑内容仍保留，只有明确重新加载才丢弃。代理读取缓存有效期为 5 秒，保存后本实例立即清除缓存，其他实例最多延迟 5 秒；已经发出的请求仍使用自己的配置快照。缓存过期后数据库读失败会返回 503，不使用旧配置或环境变量继续发送。

如果还没有后台记录，也可以在部署环境或 `.env` 中设置下面这一行，然后重启 CCH：

```dotenv
CCH_TEXT_TRANSFORM='{"enabled":true,"caseSensitive":true,"rules":[{"source":"wingjoy.net","target":"site-k7m2.a.invalid"},{"source":"wingjoy.cn","target":"site-k7m2.b.invalid"},{"source":"wingjoy","target":"site-k7m2"}]}'
```

配置字段如下。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 启用转换；未设置环境变量也不启用 |
| `rules` | 必填 | 最多 100 条 `{source,target}` 映射，每个字符串 1–256 字符；启用时至少一条 |
| `providerIds` | 省略 | 省略表示所有供应商；例如 `[1,2]` 只保护这两个供应商的发送 |
| `caseSensitive` | `true` | 按大小写精确匹配，适合代码和标识符；设置 `false` 会忽略 ASCII 字母大小写，返回时统一成 `source` 中的写法 |

要扩展词表，只需添加映射。原词和代称不允许双引号、反斜杠或控制字符，避免破坏工具 JSON 参数。每次上游 attempt 使用独立配置快照，串行重试、并行竞速和供应商切换不会共享可变映射。限定供应商后，未选中的供应商不执行保护，包括重试切换到这些供应商的情况。

精确匹配模式下 `WingJoy` 与 `wingjoy` 不同。如需保留大小写又覆盖变体，可以添加独立规则，例如 `WingJoy → Site-K7m2`，并保持域名变体的代称对应关系。忽略大小写模式不能保证代码标识符的原始大小写还原。

原词和代称都按字面子串匹配，不解释正则表达式。例如 `wingjoy_sdk` 会被转换。域名长规则先于品牌短规则，一次扫描完成，不会再次替换刚生成的内容；还原使用相同的最长匹配策略。

```text
https://api.wingjoy.cn/v1 → https://api.site-k7m2.b.invalid/v1
wingjoy_sdk              → site-k7m2_sdk
```

## 覆盖范围

- Claude Messages、OpenAI Chat Completions、Responses、Gemini 的系统指令、消息文本、工具描述、工具名称和参数文本。
- Claude 工具 `input` 与 Gemini 工具 `args/response` 的业务对象键和值。
- 普通 JSON 响应，以及 LF/CRLF 分帧的 SSE 响应。SSE 按 choice、content block、tool call 等通道保存可能未收全的代称尾部，支持代称跨网络 chunk 和跨 delta 事件拆分。
- `/v1/messages/count_tokens`、`/v1/responses/compact` 等透传端点仍经过出站转换。计数反映发送给上游的代称文本。
- multipart 请求中的语义文本字段（例如 `prompt`）转换，文件部分原样通过。
- 原有假流式路径也使用已还原的普通响应。转换在 Portable 响应恢复之前完成，顺序与请求侧相反。

ID、模型名、签名、缓存标识、加密内容和未识别字段不改写；若这些可读字段包含配置中的原词，拒绝发送。带签名的思考块不能随意修改，保留原内容；若请求侧含原词，同样拒绝发送。响应中的签名思考块可能保留代称。

图片、音频、文档和文件块，以及 Gemini `inlineData/fileData` 等附件字段整体透传。**这些块内部的字节、URL、文件名等元数据都不属于保护范围**，即使包含原词也不会被遮盖。此行为遵循“允许图片和附件通过”的约定。

## 错误行为

| 错误码 | 行为 |
| --- | --- |
| `text_transform_config` | 配置格式错误、重复原词/代称、原词与代称互相包含，拒绝发送 |
| `text_transform_collision` | 待处理文本已经包含保留代称，或替换后无法按规则往返还原，拒绝发送，不猜测其含义 |
| `text_transform_residual` | 不可修改字段、出站 URL/请求头或转换后的文本仍包含原词，拒绝发送 |
| `text_transform_unsupported` | 无法解析的请求正文或不支持的正文编码，拒绝发送 |
| `text_transform_response` | 响应 JSON/SSE 损坏或流式等待缓冲超限，终止还原，不回传未处理的原响应 |
| `text_transform_unavailable` | 配置存储不可用或无法读取生效配置，返回 503，拒绝发送 |

本地请求错误不自动切换供应商，不进入供应商熔断。错误消息提供五种语言，不包含原词、代称或请求正文。流式响应已发出后无法更改 HTTP 状态，后续还原失败会中断流。SSE 单帧或等待队列上限为 2 MiB 字符，避免无限缓冲。

修改正文后删除 Content-Length、ETag、Digest、Content-Digest、Repr-Digest、Content-MD5 等失效头。原有超时和客户端取消继续生效。

## 边界与日志

这是指定字段的字面文本保护，不是匿名化保证。模型可能从上下文推测身份，也可能改写代称或自行生成同样的代称。模型必须真实联网访问原域名的任务不适合启用此转换。任意 Base64、压缩内容、刻意拆写和嵌套编码不保证识别。

CCH 仍可能保存原始请求、还原后的响应和本地日志，本功能不改变现有存储策略。请求发送后的调试快照记录转换后的 JSON 正文；multipart 快照仍遵循原有记录方式。固定映射不会每轮随机变化，但首次启用或修改规则会改变上游前缀缓存内容。

## 验证

```sh
bunx vitest run --config tests/configs/text-transform.config.ts --coverage
bunx vitest run --config tests/configs/text-transform-ui.config.ts --coverage
bunx vitest run tests/unit/proxy/codex-portable-forwarder-seam.test.ts tests/unit/proxy/codex-portable-fake-streaming.test.ts tests/unit/proxy/portable-error-handler.test.ts
```

代理核心位于 `src/app/v1/_lib/proxy/text-transform/`；共享配置校验和缓存位于 `src/lib/text-transform/`；持久化位于 `src/repository/text-transform.ts`。页面与代理使用同一份映射校验，后续新增协议字段应同步扩展覆盖测试。
