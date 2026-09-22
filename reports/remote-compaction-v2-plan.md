# CCH 远程压缩 v2 合成方案调查与实施计划

> 调查基线：`claude-code-hub` v0.8.10；目标分支：`feat/remote-compaction`  
> 调查日期：2026-09-11  
> 文档性质：实施方案报告，不包含源码改动  
> 状态：调查与 A—G 方案已完成；待决策项见 J 节

## 0. 背景与已知约束

### 0.1 Codex 客户端的压缩路径判定

- 判定点位于 Codex 源码 `codex-rs/model-provider/src/provider.rs:353`。当 provider 的 `name` 为 `"OpenAI"`，或 `base_url` 符合 Azure 风格时，客户端选择 `RemoteCompactionSupport::V2`；否则为 `Unsupported`，走客户端本地压缩。
- 当前配置的 provider name 为 `"OpenAI"`，因此 Codex 会选择远程压缩 v2。本文不读取或记录 `config.toml` 中的 `experimental_bearer_token`。
- 当前客户端没有按模型区分远程压缩能力的开关，也没有官方 env/config 开关。2026-09-11 复核时，[#37010](https://github.com/openai/codex/issues/37010)、[#42313](https://github.com/openai/codex/issues/42313)、[#24418](https://github.com/openai/codex/issues/24418) 均仍为 Open；该状态仍应在实际实施前再次核验。

### 0.2 远程压缩 v2 协议

- 请求为 `POST /v1/responses` 的 SSE 流式请求。body 与普通响应请求同构，仍包含 `instructions`、`tools`、`input`，差异是 `input` 末尾多一个无 payload 的控制项：`{"type":"compaction_trigger"}`。
- 请求头包含 `x-codex-beta-features`，其中含 `remote_compaction_v2`；`x-codex-turn-metadata` 中的 `request_kind` 为 `compaction`。压缩请求不带 harness metadata 字段。
- 响应流必须通过一条 `response.output_item.done` 事件发出且只发出一个 compaction item：

  ```json
  {"type":"response.output_item.done","item":{"type":"compaction","id":"cmp_...","encrypted_content":"..."}}
  ```

  之后必须发送 `response.completed`。客户端只从 `response.completed` 中读取 response `id` 和 `usage`，不会扫描 `response.completed.response.output` 来寻找 compaction item。
- 关键客户端错误包括：
  - `remote compaction v2 expected exactly one compaction output item, got N from M output items`
  - `remote compaction v2 stream closed before response.completed`
- `encrypted_content` 对客户端是不透明载荷，客户端不解密、不校验，但会写入本地 rollout。单条记录超过 16 MiB 可能在迁移时被丢弃，参见上游 issue #44141。
- 压缩成功后客户端重写历史，只保留近期消息与 compaction item；后续请求会把 `{"type":"compaction","encrypted_content":"..."}` 原样放入 `input`。因此 CCH 必须在后续请求中恢复出上游模型可读的摘要，否则模型会失去被压缩的上下文。
- 客户端对压缩请求最多重试 2 次，且实际次数还受 provider 的 `stream_max_retries` 限制。远程压缩失败时不会自动切回本地压缩，只会尝试换模型重试，故失败路径需要专门设计。

### 0.3 CCH 版本现状与关键缺口

- 现网中转入口为 `https://cch.wingjoy.net/v1`。代码基座是 `ding113/claude-code-hub`，部署版本为 v0.8.10；上游标签顺序为 v0.8.9 → v0.8.10 → v0.9.0。
- 上游 v0.9.3 release note 所称“新增支持 OpenAI V2 远程压缩”，核心是协议识别与路由策略：`src/app/v1/_lib/proxy/remote-compaction.ts` 识别 `compaction_trigger`，将 managed endpoint 视为 `/v1/responses/compact`，应用 `raw_passthrough` 策略并按非计费端点处理。后续版本又在 `stream-gate/frame-classifier.ts` 识别 compaction item。上述改动并不生成摘要，也不合成 compaction 响应。
- 上游模型（包括当前使用的 deepseek 系列）不支持该协议，因此只移植透传逻辑无法完成目标。实施方案必须包含 CCH 侧的合成压缩，以及后续普通请求中的 compaction 回放展开。

### 0.4 必须先确认的前提：现网存在未公开的会话守卫

现网部署并非上游 v0.8.10 原版。普通请求会被强制要求携带唯一、非空且合法的 UUIDv7 会话标识，错误文本为“普通请求必须携带唯一且非空的 UUIDv7 会话标识”和“普通请求携带的会话标识必须是有效的 UUIDv7”。这两条文本在开源 v0.8.10 与上游 main 均不存在；上游只在 `session-completer.ts` 中对缺失会话标识进行自动补全。

因此，编码前必须先确认以下部署事实：

1. UUIDv7 守卫位于 CCH fork 内、反向代理/网关内，还是两处都有。
2. 守卫读取哪个 header/body 字段，如何区分“普通请求”“压缩请求”和非对话端点。
3. CCH 内部发起的摘要子请求是否会再次经过该守卫；若会，子请求如何生成并传递合法且可关联的 UUIDv7。
4. `/v1/responses/compact` 这一逻辑 managed endpoint 是否需要在守卫中显式放行，还是继续复用原始 `/v1/responses` 的会话标识。

如果实施阶段拿不到现网源码，补丁必须保持守卫兼容性：外部压缩请求沿用原请求的会话标识；摘要子请求默认走进程内 provider 调用而不是回环 HTTP；确需回环时必须显式生成独立 UUIDv7，并用 parent/request correlation 字段关联；逻辑上的非对话端点只改变 CCH 内部策略，不擅自改写对外 URL。任何“缺失时自动补全”“守卫放行”或“自动回退”均属于需要人工拍板的兜底策略，不作为本文默认既定行为。

### 0.5 调查边界与证据规则

- 只修改本报告；不修改任何源码、配置、数据库或其他项目。
- 主要证据取自目标 fork v0.8.10、已解包的上游 main 与 Codex 客户端源码；行号以调查时工作副本为准。
- 对未能由源码或测试确证的结论，明确标注“未确证”，并给出推断依据与建议验证方法。
- 所有失败兜底、自动降级和能力探测策略单列为待决策项，不默认启用。

## A. v0.8.10 请求链路实况

### A.1 基线与总链路

工作副本当前位于 `feat/remote-compaction`，HEAD 指向 v0.8.10；调查开始时除本报告外无工作区改动。项目未初始化 `.codegraph/`，CodeGraph 明确返回不可查询，因此本节改用目标 tag 的逐文件源码核查，未擅自创建索引。

`POST /v1/responses` 的真实调用链如下：

1. `src/app/v1/[...route]/route.ts:37-57` 以 Hono 建立 `/v1` base path，并在第 51 行把 `/responses` 交给 `handleProxyRequest`。
2. `src/app/v1/_lib/proxy-handler.ts:18-77` 通过 `ProxySession.fromContext()` 读 URL、headers 和 body，以实际 pathname 把格式识别为 `response`，然后执行 `normalizeResponseInput()`。
3. `src/app/v1/_lib/proxy/session.ts:239-318,1169-1235` 克隆并解码完整请求体，JSON 结果存入 `session.request.message`，原始字节保存在 `session.request.buffer`；构造函数在 `209-237` 立即冻结 endpoint policy。
4. `src/app/v1/_lib/proxy-handler.ts:79-86` 从 session policy 构建并执行 guard pipeline。
5. `src/app/v1/_lib/proxy-handler.ts:88-105` 对需要追踪的端点增加 Redis 并发计数，并建立实时请求状态。
6. `src/app/v1/_lib/proxy-handler.ts:109-129` 可能进入 fake streaming；未命中则继续。
7. `src/app/v1/_lib/proxy-handler.ts:131-135` 调用 `ProxyForwarder.send()`，随后由 `ProxyResponseHandler.dispatch()` 处理响应。
8. `src/app/v1/_lib/proxy-handler.ts:147-151` 在 finally 中释放会话并发计数。

### A.2 managed endpoint 与 endpoint policy 的实际行为

v0.8.10 **没有独立的 managed endpoint 概念**。`ProxySession` 只有以下行为：

- `src/app/v1/_lib/proxy/session.ts:236` 在构造时调用 `resolveSessionEndpointPolicy(init.requestUrl)`。
- `src/app/v1/_lib/proxy/session.ts:1121-1130` 的 `resolveSessionEndpointPolicy()` 只读取 `requestUrl.pathname`，不看 body、header 或 `request_kind`。
- `src/app/v1/_lib/proxy/session.ts:756-770` 的 `getEndpointPolicy()` 返回构造时冻结的 policy；`getEndpoint()` 仍只返回实际 pathname。

此版本已经认识**显式 URL** `/v1/responses/compact`：

- `src/app/v1/_lib/proxy/endpoint-paths.ts:3-10,56-58` 声明并识别该路径。
- `src/app/v1/_lib/proxy/endpoint-policy.ts:37-55,75-83` 将其与 `/v1/messages/count_tokens` 一起映射为 `raw_passthrough`。
- `src/app/v1/_lib/proxy/endpoint-family-catalog.ts:90-112` 把显式 compact 归为 `accountingTier: "none"`、raw passthrough，而普通 `/v1/responses` 归为 `required_usage`、非 raw。

但 v0.8.10 全仓没有 `compaction_trigger`、`remote_compaction_v2` 或 `encrypted_content` 的识别代码。因此“真实 wire endpoint 是 `/v1/responses`，管理语义视作 `/v1/responses/compact`”的映射尚不存在。

两类 policy 的差异位于 `src/app/v1/_lib/proxy/endpoint-policy.ts:22-50`：

| 行为 | 普通 `/v1/responses` | 显式 `/v1/responses/compact` |
|---|---|---|
| guard preset | `chat` | `raw_passthrough` |
| 同 provider 重试 / 切 provider | 允许 / 允许 | 默认均不允许 |
| 熔断计数 | 允许 | 不允许 |
| 并发请求追踪 | 开启 | 关闭 |
| 请求过滤器、forwarder 预处理、特殊设置、响应整流 | 全部启用 | 全部绕过 |
| endpoint pool | inherit | strict |

`src/app/v1/_lib/proxy/guard-pipeline.ts:199-225` 对应的 pipeline 为：

- 普通 chat：`auth → sensitive → client → model → version → probe → session → warmup → requestFilter → rateLimit → provider → providerRequestFilter → messageContext`。
- raw passthrough：默认是 `auth → client → model → version → probe → provider`；如果管理员明确启用了非对话端点跨 provider fallback，则改用 `auth → client → model → version → probe → session → provider → messageContext`。这是现有可选行为，不是本文建议默认开启的兜底。

### A.3 请求过滤器、整流器与出站序列

普通 `/v1/responses` 会经过下列可能改变请求的环节：

1. `src/app/v1/_lib/proxy/response-input-rectifier.ts:33-74,80-105`：把字符串或单对象 `input` 规范为数组；数组形式不改。v0.8.10 只修改 `request.message`，没有同步更新 raw `request.buffer`。这对普通序列化路径无碍，但与未来 raw passthrough 组合时会出现“内存对象已改、实际转发原始字节未改”的冲突。
2. `src/app/v1/_lib/proxy/request-filter.ts:13-25`：执行全局 guard-phase 过滤器。
3. `src/app/v1/_lib/proxy/provider-request-filter.ts:10-32`：选定 provider 后执行供应商/分组 guard-phase 过滤器。
4. `src/lib/request-filter-engine.ts:478-536,557-617,627-747,841-911`：上述过滤器及 final-phase 过滤器可以删改 header、按 JSON path 覆盖 body、递归文本替换、merge/insert/remove 数组项；错误默认 fail-open。若规则覆盖 `input`、删除匹配 item 或替换字符串，可能直接删除或破坏 `compaction_trigger`。
5. `src/app/v1/_lib/proxy/forwarder.ts:2373-2381`：应用模型重定向。
6. 对本请求必选的 `codex` provider，`src/app/v1/_lib/proxy/forwarder.ts:2544-2583` 会应用 Codex provider 参数覆写。Anthropic billing-header、cache TTL 等整流位于 `2585-2663`，由于 Responses 请求只会选到 codex provider，正常不会触发。
7. `src/app/v1/_lib/proxy/forwarder.ts:2833-2887`：递归删除 CCH 私有参数，再执行 final-phase request filter，补 OpenAI Chat usage 参数（仅适用时），最后重新 JSON 序列化并从 `stream === true` 判定流式。

显式 raw passthrough 则由 `src/app/v1/_lib/proxy/forwarder.ts:2770-2783` 直接发送 `session.request.buffer`，跳过以上业务预处理与过滤器。上游 main 为 object-form trigger 补 `syncRequestBodyFromMessage()`，正是为了解决此处 raw buffer 与内存 message 不一致；见 B 节。

### A.4 provider 选择

`src/app/v1/_lib/proxy/provider-selector.ts:91-127` 建立严格格式映射：`response → codex`，因此压缩请求不会被调度到 `openai-compatible`、Claude 或 Gemini 类型供应商。`ProxyProviderResolver.ensure()` 在 `129-207` 先尝试 Redis 会话复用，再按候选池选择；`218-307` 对选中 provider 执行原子并发检查。后续候选筛选还会叠加用户/Key provider group、启用状态、调度时间、allowed model、客户端限制、成本上限、provider/vendor 熔断状态与优先级/权重。

结论是：所谓“deepseek 系列上游”在 CCH 数据模型中必须配置成 `providerType: "codex"` 才能接到 `/v1/responses`；模型名本身不改变远程压缩语义，也不会让 CCH 自动改用另一种协议转换器。

### A.5 流式响应怎样返回，以及哪里可能改坏或判空

1. `src/app/v1/_lib/proxy/forwarder.ts:2724-2729,2991-2996,3148-3165` 保留原始 `/v1/responses` path，构造 headers/body，并通过 undici 获取上游响应。
2. `src/app/v1/_lib/proxy/forwarder.ts:5185-5237,5304-5389` 对 gzip 手工解压、删除失效的 content headers，并把 Node stream 转成 Web stream。
3. `src/app/v1/_lib/proxy/response-handler.ts:1308-1344` 先按 policy 决定是否运行 `ResponseFixer`，再根据 `Content-Type` 分到 SSE 或非流路径。
4. `src/app/v1/_lib/proxy/response-fixer/index.ts:258-276,344-466` 默认对 SSE 做 encoding、SSE 格式和 `data:` 行 JSON 截断修复；对 Responses 还会过滤被判为 inert 的 `chat.completion.chunk`。有效 `response.output_item.done`/`response.completed` 一般原样保留，但修复器会缓冲到换行、统一 SSE 格式，并在 malformed JSON 时改写内容。因此合成响应不应再穿过它，或必须以 raw policy 明确绕过。
5. `src/app/v1/_lib/proxy/response-output-normalizer.ts:146-187` 只处理成功的 JSON 非流响应，不处理 SSE。
6. `src/app/v1/_lib/proxy/response-handler.ts:2547-2562,2689-2739,3018-3076` 为普通 SSE 增加可控流、tee 成客户端与后台统计两路；客户端路原则上字节透传，后台路有界收集并在自然 EOF 后结算。收集上限为 `response-handler.ts:59-64` 的 10 MiB，超过后不保存完整调试正文，但仍继续把流发给客户端。

需要重点防范的失真/判空点：

- **协议本身为零项**：当前 CCH 不验证 compaction item。上游若把 `compaction_trigger` 当普通输入并返回文本输出，或返回 `response.completed` 但没有 `response.output_item.done` compaction item，CCH 会原样给客户端；最终由 Codex 报“expected exactly one ... got 0”。这是当前最主要的必现缺口。
- **Content-Type 错误**：如果合成或上游没有返回 `text/event-stream`，`response-handler.ts:1336-1343` 会走非流处理，客户端无法按远程压缩 v2 消费。
- **响应修复器改写**：普通 `/v1/responses` 默认经过 `ResponseFixer`。其合法流通常不变，但没有 compaction-aware 的不变量检查；不应依赖它“修好”合成 SSE。
- **流在 completed 前关闭**：`src/app/v1/_lib/proxy/node-stream-to-web.ts:60-94` 把 Node `end` 和 `close` 都映射为 Web stream `close`。若网络/解压链在 `response.completed` 前触发 close，客户端只看到正常 EOF，仍会报“stream closed before response.completed”。`node-stream-to-web.ts:96-112` 的 error 才会显式传递为 stream error。
- **CCH 后台判空不等于客户端响应被替换**：`src/lib/utils/upstream-error-detection.ts:335-349` 会把自然结束的空 body 标成 `FAKE_200_EMPTY_BODY`；`response-handler.ts:907-915,1045-1088` 据此进行内部失败、解绑和熔断结算。SSE 已开始后它不能追回客户端已收到的 HTTP 200 或字节。有效 compaction SSE不为空，且只要不含结构化非空 `error`，不会因“没有文本 delta”在 v0.8.10 被判空；此版本尚无 stream gate。
- **超时**：forwarder 按 `stream === true` 使用首字节超时，response handler 首块后改用 streaming idle timeout。两条事件之间若摘要生成耗时过长且没有 heartbeat，可能被中止，造成 completed 缺失。

### A.6 Redis 在该请求链路中的用途

Redis 不是历史消息的权威存储，但被广泛用于短期会话与运行态：

- `src/lib/session-manager.ts:283-302,428-567`：请求序号、基于客户端标识/消息指纹的 session ID 映射及 TTL。
- `src/lib/session-manager.ts:603-693` 与 `src/app/v1/_lib/proxy/provider-selector.ts:144-187,468-571`：session 到 provider 的粘性绑定、复用和清除。
- `src/lib/session-manager.ts:1011-1158,1544-2195`：session info/usage、请求 messages、请求/响应 body、headers、上下游 meta、before/after 调试快照，均有 TTL，并受高并发模式/存储开关影响。
- `src/lib/session-tracker.ts:84-221,650-682`：活跃 session 集合与每 session 并发计数。
- `src/app/v1/_lib/proxy/provider-selector.ts:218-307` 调用的 `RateLimitService`：provider session 并发引用；用户/Key 速率、成本等限制也依赖 Redis 原子计数。
- `src/lib/circuit-breaker.ts:4-14,280-359`：provider 熔断状态跨实例持久化与同步；endpoint/vendor 还有各自的 Redis 状态。
- `src/lib/redis/live-chain-store.ts:14-69`：实时 provider 决策链快照；响应侧另写成本/统计缓存。

这意味着 A 方案若把摘要放 Redis，可以复用现有连接和多实例共享能力，但不能直接复用上述 5 分钟 session 调试数据：其开关、截断策略、键语义与 compaction 生命周期都不满足“后续回放一定可解”的要求。

### A.7 本节结论

一个 body 末尾带 `{"type":"compaction_trigger"}` 的 `POST /v1/responses` 在 v0.8.10 上会被当成**普通 Responses 对话请求**：使用 default/chat policy，经过完整 guard、过滤器、Codex provider 覆写、计费记录、重试/切 provider、响应修复和 SSE 后台结算。它不会自动获得显式 `/v1/responses/compact` 的 raw、非计费、不熔断、不并发追踪语义。CCH 也不会合成或验证 compaction item；对于不支持协议的上游，最可能结果是“零个 compaction item”或在 `response.completed` 前断流。

### A.8 一手源码交叉核验

本节只记录两套一手源码可以直接支持的事实。Codex 证据来自本地 `codex-main` 快照；CCH 后续版本证据来自本地上游 main，`VERSION:1` 为 `0.9.5`。本地没有带 Git 历史的 v0.9.3 工作树，因此“功能最初随 v0.9.3 发布”沿用题设 release note，**未能独立确证每一行最早出现在哪个 tag**；下文精确行号均指本次读取的相应工作树。

#### A.8.1 Codex 如何选择 remote compaction v2

- `codex-rs/model-provider/src/provider.rs:44-50` 定义 `RemoteCompactionSupport::{Unsupported, V2}`；`ConfiguredModelProvider::capabilities` 在 `353-365` 只按 provider 判定：`info.is_openai()` 或 Azure Responses 风格为 `V2`，其余为 `Unsupported`。
- `codex-rs/model-provider-info/src/lib.rs:40,546-548` 进一步确证 `is_openai()` 是大小写敏感的 `name == "OpenAI"`；Azure 判定在 `codex-rs/codex-api/src/provider.rs:102-122`，接受 name 不区分大小写等于 `azure`，或 base URL 命中 Azure 标记。
- 手工压缩在 `codex-rs/core/src/tasks/compact.rs:28-68`、自动压缩在 `codex-rs/core/src/session/turn.rs:1397-1454` 按上述 capability 分到 remote v2 或本地压缩，分流处不读取模型名。当前快照有一个边界：两处都先检查实验性的 `token_budget`；它在 `codex-rs/features/src/lib.rs:1610-1615` 默认关闭。本文没有读取用户配置，因此严格结论是：**在默认未启用 `token_budget` 的前提下，name 为 `OpenAI` 的 provider 选择 remote v2**。
- 旧的 `remote_compaction_v2` feature 已在 `codex-rs/features/src/lib.rs:1752-1757` 标成 `Removed`，不再充当可关闭分流的开关；`codex-rs/core/src/session/mod.rs:1107-1124` 反而无条件把该 key 加入 beta feature header。这与“没有可按模型关闭 remote v2 的有效官方开关”一致。

#### A.8.2 请求的真实 wire 形态

- `run_remote_compact_v2_attempt` 位于 `codex-rs/core/src/compact_remote_v2_attempt.rs:31-132`。它从 `sess.clone_history()` 取得历史，在 `70-76` 把 envelope 拆成 `ResponseItem` 与仅供本地重建使用的 `CodexHarnessMetadata` sidecar，然后在 input 末尾追加 `ResponseItem::CompactionTrigger {}`；`77-85` 继续复用包含 instructions、tools、input 的普通 `Prompt`。
- `codex-rs/protocol/src/models.rs:1224-1229,3725-3745` 定义并测试 trigger 的序列化，结果恰为 `{"type":"compaction_trigger"}`，没有 payload。`codex-rs/core/src/client.rs:784-890` 的共享 `build_responses_request` 再把同一个 Prompt 组装为 `ResponsesApiRequest`，其中 `store=false`、`stream=true`；request schema 在 `codex-rs/codex-api/src/common.rs:259-285`。
- HTTP 实际由 `codex-rs/codex-api/src/endpoint/responses.rs:92-128` 以 POST 和 SSE 发出，集成测试 `codex-rs/core/tests/suite/compact_remote.rs:970-983` 确认最终路径为 `/v1/responses`。`x-codex-beta-features` 的构造和写入分别见 `core/src/session/mod.rs:1107-1124` 与 `core/src/client.rs:2048-2071`；`CodexResponsesRequestKind::Compaction` 在 `core/src/responses_metadata.rs:156-171,384-430` 生成 `request_kind="compaction"`，并由 `354-381` 投影为 `x-codex-turn-metadata` header。
- 所谓“不带 harness metadata”是指 `CodexHarnessMetadata` sidecar 不进入 provider input，不代表所有 `client_metadata` 都为空。实现证据是 `compact_remote_v2_attempt.rs:70-74` 只发送 `envelope.item`；测试辅助断言在 `core/tests/suite/compact_remote.rs:260-267,328-333` 明确拒绝 input item 中出现 `metadata` 或 `replacement_history_metadata`。

#### A.8.3 SSE 收集与硬校验

- `codex-rs/codex-api/src/sse/responses.rs:353-364` 只在 `response.output_item.done` 中把 `item` 解析为 `ResponseEvent::OutputItemDone`。`ResponseCompleted` 在 `118-125` 只有 id、usage、usage metadata 和 end_turn；`483-505` 转换 completed 事件时同样不读取 `response.output`。因此只把 compaction 放在 `response.completed.response.output` 中不能被客户端收集。
- `collect_compaction_output` 位于 `codex-rs/core/src/compact_remote_v2.rs:419-480`。它只统计 `OutputItemDone`，必须先观察到 `response.completed`，否则报 `remote compaction v2 stream closed before response.completed`；compaction item 数量不等于 1 时，报 `remote compaction v2 expected exactly one compaction output item, got N from M output items`。response id 和 token usage 只取 completed 事件。
- “恰好一个”约束的是 compaction item 数，不是所有 output item 总数；同文件 `1164-1228` 的单测允许另有 assistant item。`codex-rs/protocol/src/models.rs:1214-1223` 还表明 compaction 的 `id` 为可选字段，`encrypted_content` 才是必需字符串。实现仍应生成稳定的 `cmp_...` id，并只返回一个 output item，以缩小中转兼容面。
- `codex-rs/codex-api/src/sse/responses.rs:667-675` 收到 completed 即结束，不要求再发 `[DONE]`。最小可接受序列可直接参照 `core/tests/suite/compact_remote.rs:282-291`：一个含 compaction item 的 `response.output_item.done`，随后一个 `response.completed`。

#### A.8.4 重试、失败与历史回放

- `codex-rs/core/src/compact_remote_v2.rs:73-77,364-417` 把 remote v2 的 stream retry 上限设为 2，并取 `provider.stream_max_retries().min(2)`；只有 `is_retryable()` 的错误进入重试。这意味着最多是初次请求加两次重试，而不是总共两次请求。
- 同文件 `237-285` 的另一层机制是自动压缩失败后用已有的 fallback model context 再跑一次 remote v2；手工压缩在 `105-129` 传入 `fallback_step_context=None`。源码没有 remote→local 自动降级；最终失败由 `198-210` 发出带 `Error running remote compact task` 前缀的错误事件。是否增加 CCH 侧兜底仍须单独拍板。
- `build_v2_compacted_history` 在 `compact_remote_v2.rs:483-509` 筛选保留项、按预算截断，并把服务端返回的 compaction item直接追加到新历史末尾；保留条件见 `534-577`。`304-350` 随后调用 `replace_compacted_history`，后者在 `core/src/session/mod.rs:3933-4006` 把完整 replacement history 装回 session，并以 `RolloutItem::Compacted` 持久化。
- 后续普通请求在 `core/src/session/turn.rs:510-529` 通过 `clone_history().for_prompt(...)` 重新取历史；重试也在 `1571-1586` 这样做。`core/src/context_manager/history.rs:771-794` 明确将 `ResponseItem::Compaction` 视为可发给 API 的 item，`protocol/src/models.rs:1214-1223` 仅把 `encrypted_content` 当普通字符串。集成测试 `core/tests/suite/compact_remote.rs:328-338` 直接断言后续请求中的字符串与压缩响应完全相同。由“String 反序列化→原样入历史→原样回放”的正向链路可确证客户端不解密，也没有内容语义校验。

#### A.8.5 16 MiB 风险的准确边界

- `codex-rs/rollout/src/recorder.rs:2039-2073` 把每个 `RolloutItem` 序列化为单条 JSONL；`codex-rs/history/src/lib.rs:189-201` 的 `CompactedItem` 又内嵌完整 `replacement_history`，因此 `encrypted_content` 位于该单条记录内。
- `codex-rs/thread-store/src/local/rollout_migration.rs:73-75` 设置 `MAX_ROLLOUT_LINE_BYTES = 16 * 1024 * 1024`；`read_rollout_record` 在 `1207-1248` 对超过该值的记录读完后返回 `line: None`，即整条丢弃但继续迁移。`thread-store/src/local/rollout_migration_tests.rs:2528-2566` 有直接测试。
- 阈值针对**整条 JSONL record**，不是仅针对 `encrypted_content`。replacement history、JSON 转义和 metadata 都占空间，所以合成载荷必须显著小于 16 MiB，不能把 16 MiB 当可用的明文或密文预算。

#### A.8.6 CCH v0.9.3+ 实际增加了什么

上游 main 的生产代码显示，这批改动建立的是“识别 trigger→套用 compact 管理语义→原样透传”的路径，不包含摘要生成、摘要存储、加密 token 生成或后续解码：

1. 新增 `src/app/v1/_lib/proxy/remote-compaction.ts:7-24` 的 `isRemoteCompactionV2Request`。它只在规范化路径等于 `/v1/responses` 时，检查 input 单对象或数组中是否存在顶层精确 `type === "compaction_trigger"`。
2. 修改 `src/app/v1/_lib/proxy/session.ts`：新增 import（`1-3`）和 `managedEndpoint` 字段（`202-203`）；构造器在 `325-326` 先调用 `resolveSessionManagedEndpoint`，再按管理 endpoint 解析 policy；`getManagedEndpoint` 在 `1245-1251` 暴露管理语义；`resolveSessionManagedEndpoint` 在 `1614-1628` 把命中的真实 `/v1/responses` 映射为逻辑 `/v1/responses/compact`，并不改 `requestUrl`。
3. 修改 `src/app/v1/_lib/proxy/message-service.ts:31-33` 的 `ProxyMessageService.ensureContext`，把使用记录 endpoint 改为 managed endpoint；修改 `src/app/v1/_lib/proxy/response-handler.ts:1425-1427` 的 `isNonBillingUsageEndpoint`，让计费判断也使用 managed endpoint。
4. 为单对象 input 与 raw passthrough 的组合补同步：`src/app/v1/_lib/proxy/session.ts:1226-1243` 新增 `syncRequestBodyFromMessage`，`src/app/v1/_lib/proxy/response-input-rectifier.ts:80-99` 的 `normalizeResponseInput` 在整流后同步 `request.buffer` 和日志。否则内存对象虽变成数组，raw forwarder 仍会发送旧字节。
5. 后续 stream-gate 版本在 `src/app/v1/_lib/proxy/stream-gate/frame-classifier.ts:448-510` 的 `classifyParsedFrame`、`isResponsesCompactionContent` 与 `isNonEmptyCompactionItem` 中，把带非空 `encrypted_content` 的 done item，或 completed.output 中的同类 item，识别为 `content`，避免 gate 把只有 opaque state、没有文本 delta 的合法流判空。

透传性质有直接测试证据。`tests/unit/proxy/remote-compaction-v2.test.ts:87-101` 要求 wire endpoint 和原始 body 不变、managed endpoint 为 compact；`tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts:181-217` 模拟“上游已经返回合法 compaction SSE”，再断言 URL、body、beta header 和整个响应字节均原样透传。`tests/unit/proxy/proxy-handler-public-success.test.ts:202-226` 同样由 mock boundary 预先提供 compaction output，CCH 只负责路由。源码中不存在以历史为输入、调用模型生成摘要并构造 `encrypted_content` 的实现；因此把这批补丁移植到 deepseek 等不支持该协议的上游，只会从“普通对话处理”升级为“正确透传一个上游仍不支持的协议”。

#### A.8.7 在 v0.8.10 基线上的最小移植边界

- v0.8.10 已有前置设施，无须照搬后续版本整套 endpoint 框架：`src/app/v1/_lib/proxy/endpoint-paths.ts:3-17,56-58` 已定义 `/v1/responses/compact`；`endpoint-policy.ts:37-55,75-83` 已将其映射为 raw passthrough；`src/lib/utils/performance-formatter.ts:1-25` 已把它列为非计费端点。
- 因此协议识别移植的最小生产文件是 `remote-compaction.ts`、`session.ts`、`message-service.ts`、`response-handler.ts`，以及为 object-form trigger 同步 raw buffer 的 `response-input-rectifier.ts`。冲突集中在 v0.8.10 的 `ProxySession` 字段/构造器/endpoint getter，以及 response handler 与 message context 对真实 endpoint 的直接读取，不应整文件覆盖。
- v0.8.10 没有 `stream-gate/`。若本次合成压缩在 CCH 内直接返回合规 SSE，并绕开上游 stream gate，则 `frame-classifier.ts` 的 compaction 分类**不需要单独移植**；若未来连同 stream gate 整体回迁或让合成流进入其 prebuffer，则必须把 `classifyParsedFrame`、`isResponsesCompactionContent`、`isNonEmptyCompactionItem` 与对应测试一起迁入。仅复制这三个函数而没有整个 gate 调用链没有作用。
- 必须补同层测试而不能只依赖上游现成测试：分类器覆盖 trigger 数组、单对象、嵌套误报和 replay item；session 覆盖真实/管理 endpoint 分离及 raw policy；forwarder 覆盖原 URL、body、header 不变；message/response handler 覆盖 usage endpoint 与非计费判定。合成与回放属于上游未实现的新模块，不能从上述透传补丁推导出来，需在后续 C、D、F 节单独设计与验证。

## B. 从 v0.9.3 及之后回迁的清单

### B.1 先回迁“协议识别与管理语义”

这部分应按函数摘取，不应把 0.9.5 的整文件覆盖到 0.8.10。上游合并记录可交叉参照 [PR #1404](https://github.com/ding113/claude-code-hub/pull/1404)；v0.9.3 的发布说明只用于确认功能对外发布节点，见 [v0.9.3 release](https://github.com/ding113/claude-code-hub/releases/tag/v0.9.3)。本地没有 v0.9.3 Git 历史，具体行最早属于哪个 tag 仍标为未确证。

| 顺序 | 来源文件与函数（上游 main 0.9.5） | 0.8.10 等价落点 | 必要性与验收 |
|---|---|---|---|
| 1 | `src/app/v1/_lib/proxy/remote-compaction.ts:7-24`，`isRemoteCompactionV2Request` | 新增同路径纯函数 | 必须。只识别真实 `/v1/responses` 的顶层 input item；覆盖数组、单对象、嵌套对象不误报。|
| 2 | `session.ts:202-203,325-326,1245-1251,1614-1628`，`managedEndpoint`、`getManagedEndpoint`、`resolveSessionManagedEndpoint` | 在 0.8.10 `ProxySession` 字段、构造器和 `getEndpoint()` 邻近位置手工落点 | 必须。真实 URL 保持 `/v1/responses`，管理 endpoint 映射为 `/v1/responses/compact`，policy 因而为 raw passthrough。|
| 3 | `message-service.ts:31-33`，`ProxyMessageService.ensureContext` | 0.8.10 同函数创建 message context 处 | 必须。usage/message 记录写管理 endpoint，不能继续把压缩当普通 chat。|
| 4 | `response-handler.ts:1425-1427`，非计费端点判断 | 0.8.10 后台结算中读取 `session.getEndpoint()` 的位置 | 必须。改读 managed endpoint，继承既有 `isNonBillingUsageEndpoint` 对 compact 的零用户计费语义。|
| 5 | `session.ts:1226-1243`，`syncRequestBodyFromMessage`；`response-input-rectifier.ts:80-99`，`normalizeResponseInput` | 0.8.10 的 response input 整流成功分支 | 必须。单对象 input 被规范成数组后同步 `request.buffer`；否则 raw forwarder 仍发送旧字节。序列化失败要返回明确 400，并补 i18n error key。|
| 6 | `proxy-handler.ts:173-178`，fake streaming 条件 | 0.8.10 `handleProxyRequest` 中 `fakeStreamingResponse(...)` 前 | 必须。raw compact policy 不得被 fake streaming 包装；条件为“开关开启且 policy 非 raw passthrough”。|

0.8.10 已有 `endpoint-paths.ts` 中的 `/v1/responses/compact`、`endpoint-policy.ts` 中的 raw policy 和 `performance-formatter.ts` 中的非计费判断，因此这些是前置设施，不是待回迁代码。forwarder 也已经支持 raw buffer 透传，不需要照搬新版 forwarder。

### B.2 后续 stream-gate 改动的处理

上游后续修复见 [issue #1410](https://github.com/ding113/claude-code-hub/issues/1410) 与 [PR #1411](https://github.com/ding113/claude-code-hub/pull/1411)：`stream-gate/frame-classifier.ts:448-510` 的 `classifyParsedFrame`、`isResponsesCompactionContent`、`isNonEmptyCompactionItem` 把非空 compaction item 视为内容，避免“没有文本 delta”被判空。

本基线根本没有 `stream-gate/`，本次也计划让 CCH 合成结果从 handler 直接返回，不进入上游响应整流链。因此这三个函数当前**没有可调用的等价落点，也不需要孤立移植**。将来若整体引入 stream gate，须同时移植分类函数、调用链和单元/集成测试；只复制分类函数不会生效。即便未来 gate 接受 `response.completed.response.output` 中的 compaction，CCH 合成器仍必须发 `response.output_item.done`，因为 Codex 客户端不扫描 completed 的 output。

### B.3 冲突面与具体落地原则

- 0.9.5 的 `ProxySession` 已混入 affinity、replay 等 0.8.10 不存在的状态，构造顺序和字段明显不同。整文件 cherry-pick 风险高，只摘取 managed endpoint 这一条纵向能力。
- raw policy 的 guard preset 在 0.8.10 不建立 session/message context；仅做透传时够用，CCH 合成需要幂等、使用记录和自研 UUIDv7 守卫兼容，不能直接复用该 preset。C 节会给出专用 guard 路径。
- `response-input-rectifier` 的同步修改与 raw forwarding 强耦合，应与 session 方法作为同一批提交；没有同步就会出现“日志/内存已规范化、wire body 未规范化”的分裂状态。
- upstream 的 i18n 新错误键应按 0.8.10 现有语言文件结构补齐；不能只抛新版枚举而漏掉本基线的本地化映射。
- 上游 PR #1404 明确不提供 DeepSeek 摘要桥接、Base64 envelope 或跨 provider 转换。因此 B 批次通过的含义只是“路由语义正确”，不能作为功能完成标志。

### B.4 本批验证闸门

1. 对数组、单对象、无 trigger、嵌套伪 trigger 分别构造 `ProxySession`，断言 wire pathname 永远是 `/v1/responses`，只有前两种合法 trigger 的 managed endpoint 为 `/v1/responses/compact`。
2. 断言 compact policy 为 raw，fake streaming 不执行；单对象经整流后，`request.message` 与反序列化后的 `request.buffer` 完全一致。
3. 用 mock 上游回传现成合法 SSE，按字节断言 URL、body、`x-codex-beta-features`、`x-codex-turn-metadata` 与响应均未被改写。
4. 断言 message/usage endpoint 为 managed compact、用户计费为 0，并确认普通 Responses 回归用例不变。
5. 此闸门预计仍无法让 DeepSeek 完成压缩；该失败是预期现象，下一批 C 合成能力完成后才做端到端验收。

## C. CCH 侧合成压缩设计

### C.1 模块边界与插入层

建议新增一个“深模块” `RemoteCompactionService`：入口只接收已鉴权、已选 provider 的 `ProxySession` 和解析后的配置，返回 `Response | null`；内部隐藏历史规范化、摘要调用、编码、幂等和 SSE 组帧。生产实现与测试内存实现共用同一接口，避免把 Redis、密钥或上游凭据扩散到 handler。

建议文件边界如下：

- `src/app/v1/_lib/proxy/remote-compaction/service.ts`：`tryHandle(session, settings)`，编排全过程。
- `.../remote-compaction/history.ts`：移除 trigger、展开既有 CCH compaction、构造摘要输入。
- `.../remote-compaction/summary-adapter.ts`：调用已选 provider 的普通推理端点并抽取文本/usage；提供生产 adapter 与 in-memory test adapter。
- `.../remote-compaction/codec.ts`、`redis-codec.ts`、`aes-gcm-codec.ts`：统一 `seal/open` 接口和两个后端。
- `.../remote-compaction/idempotency.ts`：请求指纹、分布式锁与已完成结果缓存。
- `.../remote-compaction/sse.ts`：只负责协议事件和 heartbeat，不接触业务状态。

`proxy-handler.ts:74-86` 规范化 input 并运行 guard 后、`88-107` 普通并发/状态跟踪前，是合成入口的推荐位置。流程为：先判断 trigger 与生效模式，构建专用 guard；guard 成功且 provider 已选定后调用 `RemoteCompactionService.tryHandle`，命中就直接返回本地 SSE，未命中才进入原有普通路径。这样合成流不会经过 `ProxyForwarder.send`、`ProxyResponseHandler.dispatch`、fake streaming 或 `ResponseFixer`，协议不变量集中在一个模块内。

专用 pipeline 会创建父 `messageContext`，但 handler 在普通 `ProxyStatusTracker.startRequest` 之前返回，因此 service 必须拥有完整的异步生命周期：成功/失败都在 stream task 的 `finally` 中更新父 `message_request` 的 status/duration、保持 cost=0、结束专用状态跟踪并写 attempt；不能等待普通 response handler 代为结算，也不能留下永久 running 记录。

专用 guard 不应直接沿用 `RAW_PASSTHROUGH_PIPELINE`，因为后者在 `guard-pipeline.ts:219-225` 不建立 session/message context。建议新增 `REMOTE_COMPACTION_PIPELINE`：`auth → sensitive → client → model → version → probe → session → provider → messageContext`。它保留鉴权、敏感词、自研会话守卫、provider 选择和审计上下文，但跳过 warmup、普通 request/provider filters、用户 rate/cost 限制与普通响应结算。摘要调用的运营成本由本模块单独记录。是否仍纳入用户 rate limit 属于计费策略，不应顺手继承。

必须先处理一个失败分支：trigger 请求读取系统设置失败时应 fail closed，返回明确 503；不能套用当前 `proxy-handler.ts:31-39` 的默认设置继续当普通请求发给上游，否则会重新落回“零个 compaction item”。这不是自动降级，而是拒绝执行无法确定策略的压缩。

### C.2 历史取得与摘要请求

历史以 `session.request.message.input` 为唯一请求内事实来源，不从 5 分钟调试快照重建。具体步骤：

1. 接受 array 或已整流成 array 的 input；验证恰有一个顶层 `compaction_trigger` 且它位于最后，其他位置或多个 trigger 返回 400。上游识别函数可保持宽松以兼容，但合成执行器应收紧不变量。
2. 删除 trigger；若历史中已有 CCH 自己生成的 compaction item，先按 D 节原位展开。若出现未知/过期 token，停止并明确报错，不能把密文交给摘要模型，也不能静默丢历史。
3. 保留原始 `instructions` 作为上下文；将工具调用、工具输出、用户/助手消息按原顺序保留。新建摘要请求，不修改父 session 的 request body。
4. 在 input 末尾追加一个专用 user message，语义参考 `codex-rs/prompts/templates/compact/prompt.md`：让模型生成供下一个模型继续工作的 checkpoint，覆盖当前进展、关键决定、约束/偏好、未完成工作、下一步和关键引用。不要大段复制模板，便于跟踪上游语义而不形成隐性版权副本。
5. 摘要子请求使用已选中的同一 provider；默认沿用请求经 model redirect 后的模型，允许显式配置同 provider 内的 `summaryModel`。请求 `stream:false`、`tools:[]`，不携带 `compaction_trigger`、`previous_response_id`、Codex compaction headers 或父请求的 harness metadata。若某 provider 不支持 `tool_choice:"none"`，adapter 不发送该字段，而不是运行时试错切换协议。
6. 响应必须抽取出一段非空纯文本，记录 input/output tokens 与上游 request id；空文本、多个互相冲突的候选、超时或超过大小上限均判失败。建议默认 `max_output_tokens=4096`，明文摘要硬上限 `256 KiB`，两者均可配但 hard cap 不得关闭。

为了复用现有 provider URL、认证头、endpoint pool、格式转换和 model redirect，不建议从 CCH 再 HTTP 回环调用公开 `/v1/responses`：回环会重复鉴权/计费、再次触发自研 UUIDv7 守卫，并有递归风险。建议在 `forwarder.ts` 抽出一个窄的内部 transport seam，例如 `SelectedProviderRequestExecutor.execute(session, preparedRequest, { allowRetry:false, allowProviderSwitch:false })`，让普通 forwarder 与 `summary-adapter.ts` 共同调用。子请求带 `requestKind="remote_compaction_summary"`，继承父请求的 key/user/session 审计标识但生成独立 request id；它不是新的对话请求，因此自研守卫只校验父请求，子请求不得伪造或复用外部 header 穿过公开路由。

executor 应对**准备后的子请求副本**运行普通 Codex model override、provider request filter 与 final filter，再构建上游认证头；不能把这些 filter 直接作用于父 compaction body，也不能因为外层 managed policy 是 raw 就跳过子请求所需的普通 provider 兼容处理。测试 adapter 在相同接口处捕获最终子请求，验证过滤顺序。

摘要子请求默认**不切 provider、不自动重试**。客户端本身最多会把同一压缩任务再发两次；服务端若再做普通 forwarder 的 provider 切换，会放大成本并可能得到不一致摘要。瞬时重试或同 provider endpoint 重试是否开放，列入 C.6 待拍板项。

### C.3 成功 SSE 的唯一形态

handler 应尽快返回 `text/event-stream`，在摘要执行期间只发 SSE 注释 heartbeat；注释不会形成 output item。成功后只发以下两个业务事件，并按顺序关闭流：

```text
event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","id":"cmp_...","encrypted_content":"..."}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_...","usage":{"input_tokens":123,"output_tokens":45,"total_tokens":168}}}

```

`cmp_...` 和 `resp_...` 对同一幂等键保持稳定。`response.completed` 的 id/usage 应来自 CCH 合成记录，usage 使用摘要子请求的真实 token；不得再把 compaction 塞进 completed.output 充数。`[DONE]` 可不发，Codex 在 completed 即停止；为缩小代理兼容面，建议不额外发送 created、assistant output 或文本 delta。

失败时绝不能生成空摘要或“请重新开始”之类的假 compaction。若 SSE 已建立，发一个带 `response.error.code="remote_compaction_failed"` 的 `response.failed` 再关闭；Codex 当前解析会把未知服务错误归为 retryable。若错误发生在 Response 建立前则返回 5xx JSON。两种情况均要释放幂等锁并记录可关联的错误码。这里没有 remote→local 或 provider fallback。

### C.4 方案 A：Redis 存摘要，返回短 token

`encrypted_content` 可定义为 `cchc2.r.<随机 256 bit base64url>`；Redis key 只保存 token 的 HMAC/哈希，value 保存版本、摘要、创建/到期时间、租户或 Key 绑定、可选 session 绑定、provider/model、源请求 hash 和摘要 usage。写入使用 `SET NX EX`，读取后逐项校验绑定与版本。

优点：返回客户端的 token 很短；多实例共享天然成立；可以单 token 吊销、统计访问、延长 TTL；密钥只用于 HMAC token/索引而非存量摘要解密。缺点：Redis 成为长期回放的强依赖，重启本身无碍但 Redis 清库、淘汰、故障、TTL 到期都会让已落在 Codex rollout 中的历史永久不可读；摘要明文位于 Redis，需要单独访问控制、备份加密与数据保留策略。现有 session 调试 TTL 和键空间不能复用，应独立前缀、配额与告警。

若选择 A，建议默认 TTL 至少覆盖组织允许恢复旧 Codex 会话的最长周期，且禁止 `allkeys-lru` 对该键空间无告警淘汰。TTL 的具体天数是产品保留策略，不能由实现者擅定。

### C.5 方案 B：AES-GCM 自包含密文

`encrypted_content` 可定义为 `cchc2.g.<kid>.<base64url(nonce|ciphertext|tag)>`。使用 AES-256-GCM、每条 96-bit 随机 nonce；明文 envelope 至少含 `{version, summary, createdAt, providerId, model, sourceHash}`。AAD 绑定协议版本、`kid`、租户/Key 标识和经批准的会话绑定粒度。解密前先校验总长度、版本和 base64url，再认证解密，禁止先使用未认证明文。

优点：回放不依赖 Redis，跨实例和重启只要求所有实例持有同一 keyring；旧 rollout 可在服务端数据库/缓存丢失后继续恢复。缺点：所有实例必须从 secret manager 或环境变量获得相同密钥；轮换时必须保留旧 `kid` 的解密钥直至旧 rollout 过期；密钥泄露影响该 key 的全部存量；无法单独吊销一个 token。Base64 约增加三分之一体积，但在 4096 tokens 与 256 KiB hard cap 下仍远低于 16 MiB 整条 JSONL 限制。

密钥明文不得进入 Drizzle 表、管理 API、日志或前端 settings；数据库最多保存 active `kid`。启动时若 active key 缺失/长度错误，synthesize 模式必须拒绝就绪。密钥轮换顺序为“所有实例先装入新旧 key → 切 active kid → 观察 → 到保留期后移除旧 key”，不得滚动过程中让部分实例无法解密新 token。

### C.6 两方案取舍、幂等与待拍板项

建议把 **B（AES-GCM）作为首选设计**，因为 Codex rollout 的寿命不受 CCH Redis TTL 控制；把 A 保留给明确要求短 token、单条吊销和集中保留管理的部署。最终选择必须由运维、安全和产品共同拍板，不能在实现中自动互相降级。

两方案都应使用 Redis 做短期幂等协调，但职责不同：A 的 Redis 是回放必需存储；B 的 Redis 只用于防重复调用和复用已完成结果，丢失后不影响旧 token 解密。幂等键建议为 `HMAC(key/tenant + UUIDv7 会话标识 + providerId + effectiveModel + canonicalBodyWithoutTrigger)`。首次请求以 `SET NX PX` 取得锁；同键并发请求等待已完成结果而不再次调用上游；成功结果至少缓存到覆盖 Codex 两次重试的窗口。锁持有者崩溃后只能在 lease 到期重做，必须用 fencing token 防旧实例覆盖新结果。

需要人拍板的 C 节决策：

1. 选 A 还是 B；若选 A，确定 TTL、淘汰/备份策略；若选 B，确定 secret manager、key 保留期和灾备流程。
2. token 绑定到“租户/Key”还是进一步绑定 UUIDv7 session。强 session 绑定防跨会话窃用，但 Codex 恢复、fork 或现网子线程生成新 session id 时可能误拒绝；必须先取得自研守卫的真实规则。
3. 摘要运营成本是否计入用户额度/账单。建议首版用户侧非计费、运营侧独立记账和限额，但这是商业规则。
4. 是否允许摘要子请求在**同 provider 的另一个 endpoint**做一次瞬时重试。建议首版关闭；若开启，只能在未产出成功摘要时进行，并继续由幂等键保证客户端重试不重复生成。
5. 是否在加密前压缩明文。建议首版不启用；若启用，必须限制解压后大小和压缩比以防解压炸弹。这是容量优化，不是功能前提。

**明确不采纳为默认行为的兜底/降级**：请求时先透传、失败再合成；合成失败改走其他 provider；生成空/最小 compaction 让客户端继续；Redis 读不到就把 token 原样交给模型；AES 解密失败就忽略该历史。这些都会造成双重计费、已发 SSE 无法改道、跨模型语义漂移或静默失忆，若未来要做必须另立设计并经用户确认。

### C.7 本批验证闸门

1. 用 in-memory summary adapter 输入含早期 sentinel 的历史，断言子请求去掉 trigger、展开旧 token、保留顺序并追加 checkpoint prompt；父 session body 不变。
2. 对 Redis/AES 两个 codec 分别做 round-trip、篡改、错 key/租户、超限和版本不支持测试；AES 再做双 key 轮换测试。
3. 对同一幂等键发三次并发请求，断言上游只调用一次，三份 SSE 的 `cmp_...`、`resp_...`、encrypted_content 完全一致。
4. 字节级解析 SSE，断言恰有一个 done compaction、其后恰有一个 completed、没有其他 output item，且 heartbeat 不进入 JSON 事件计数。
5. 模拟摘要空结果、超时、上游 429/500、进程锁 lease 过期，断言不产生 compaction；已建立的流得到 response.failed，未建立的请求得到 5xx，并且锁与审计状态可恢复。

## D. 后续普通请求的回放展开

### D.1 识别、解封与原位替换

后续 `/v1/responses` 不带 trigger，managed endpoint 仍是普通 Responses。此时在 `input` 中扫描顶层 item，只有 `type === "compaction"`、`encrypted_content` 为非空字符串且前缀为本服务版本 `cchc2.r.` 或 `cchc2.g.` 的 item 才由 CCH 接管。不要对任意字符串尝试 Base64/AES，也不要递归扫描 tool payload 或 message content。

每个已识别 item 调用统一 `CompactionCodec.open`，验证版本、认证主体绑定、大小和完整性，再在**原索引**替换为：

```json
{
  "type": "message",
  "role": "user",
  "content": [
    {
      "type": "input_text",
      "text": "[CCH_COMPACTION_CHECKPOINT v2]\n<摘要正文>"
    }
  ]
}
```

选择 user message 是为了与 Codex 本地压缩的语义对齐：`codex-rs/core/src/compact.rs:628-635,712-752` 明确把本地 compaction summary 编成 user message。developer/system role 在部分非 OpenAI 上游并不等价，首版不采用。固定前缀用于调试和提示模型这是 checkpoint，不允许把摘要拼进顶层 `instructions`，否则会改变后续真实指令的优先级。

必须原位替换，不能一律放到 input 开头或末尾。Codex 压缩成功时会保留部分近期项并把 compaction item 追加到当时历史末尾；以后新消息位于其后。原位展开才能得到“保留的早期上下文 → 摘要 checkpoint → 压缩后的新消息”这一时间顺序。若合法历史中有多个 CCH token，逐个按出现顺序展开；产生新压缩时，也先展开全部旧 token，再对完整可读历史摘要。

### D.2 与 guard、整流和 provider 转发的协作顺序

回放需要 auth/session 信息校验 token，同时敏感词和请求过滤器又必须看到解出的明文。因此建议为“普通 Responses 且含 CCH token”增加专用 pipeline，而不是在 handler 鉴权前解密：

`auth → client → model → version → probe → session → compactionReplay → sensitive → warmup → requestFilter → rateLimit → provider → providerRequestFilter → messageContext`

其中新增 `GuardStepKey = "compactionReplay"`，实现委托给 `RemoteCompactionReplay.expand(session)`。不含 CCH token 的请求继续走原 `CHAT_PIPELINE`，不改变普通流量的 guard 次序。若最终选择只绑定租户/Key，可把 replay 提前到 auth 后；若选择强 session 绑定，则保持上述顺序。两者必须与 C.6 的人工作出的绑定决策一致。

完整数据流为：

1. `proxy-handler.ts:42-77` 先把请求识别为 response，并由 `normalizeResponseInput` 把 string/object 规范成 array。
2. 专用 pipeline 完成 auth/session 后，在 request filters 之前原位展开；展开后调用 B 节新增的 `session.syncRequestBodyFromMessage()`，使对象、wire buffer 和审计元数据一致。
3. `sensitive-word-guard.ts` 与 `request-filter.ts`/`request-filter-engine` 的 global 阶段看到明文摘要；provider 选定后，provider filter 和 forwarder final filter 也看到同一结构。这样敏感词不会被密文绕过，现有请求整流规则也能作用于摘要。
4. provider selector 在 `provider-selector.ts:91-127` 对 Responses 只选择 `providerType === "codex"`。展开结果本身就是标准 Responses message，无需新增跨格式转换；后续 model redirect、header 构造和普通 `/v1/responses` 转发照旧。
5. 上游收到的是文本 checkpoint，不再看到 `type:"compaction"`。下游普通 response 按现有 response handler 返回，不进入合成 SSE 路径。

不要在 provider final filter 之后才展开：那会让敏感词、审计和 body filter 都看不到真实上下文。也不要仅修改 `session.request.message` 而遗漏 buffer 同步，否则 raw/调试路径再次出现双重状态。

### D.3 未知 token、原生 token 与错误语义

模式必须显式决定 ownership：

- provider 生效模式为 `synthesize` 时，CCH 前缀 token 必须成功展开；篡改、未知 `kid`、Redis 已过期分别返回稳定错误码，例如 `REMOTE_COMPACTION_TOKEN_INVALID`（422）、`REMOTE_COMPACTION_KEY_UNAVAILABLE`（503）、`REMOTE_COMPACTION_TOKEN_EXPIRED`（410）。不得删除 item 后继续。
- 生效模式为 `passthrough` 时，所有 compaction item 原样交给原生支持该协议的上游，CCH 不尝试解封。
- synthesize 模式遇到没有 CCH 前缀的原生 OpenAI opaque token 时，默认返回 `REMOTE_COMPACTION_TOKEN_UNSUPPORTED`（422）。CCH 无法解密它，透传给 DeepSeek也无法恢复记忆。
- 同一 input 混用 CCH 与非 CCH token 时默认拒绝；自动拆分、部分展开或跨 provider 转换都不是安全的既定行为。

“未知 token 自动透传”“解不开就忽略”“插入一条 token 不可用提示”都属于会导致协议错配或静默失忆的兜底，本文不采纳。若需要支持从原生 OpenAI provider 迁移到 synthesize provider，应单独设计显式会话迁移流程，不能在一次普通请求中猜测。

### D.4 日志、缓存和审计

- codec 可按 token hash 做短期正缓存，不能缓存认证失败；Redis token 到期后本地缓存也必须失效。AES 解封缓存只能存于进程内、短 TTL，并设总字节上限。
- 日志只记录 request id、token 前缀版本、`kid`、摘要字节数、hash、展开项数和错误码；禁止记录完整 `encrypted_content`、摘要或密钥。
- v0.8.10 的 `SessionManager` 会按开关保存 request/response body、before/after 快照。实现时应在 `session.ts` 的同步/快照入口增加 compaction-aware redaction：运营日志保存 `"[REDACTED_COMPACTION_SUMMARY sha256=… bytes=…]"`，真实可转发 body 只存在请求内存。若产品明确要求保存调试正文，应作为高敏配置单独开启并受 TTL/权限约束。
- message detail 中增加 `remoteCompaction: { mode, codec, itemCount, summaryBytes, sourceHash, keyId, replayStatus }` 这类结构化元数据，不复用 `specialSettings` 存正文。

### D.5 本批验证闸门

1. 构造“旧消息、CCH token、新消息”三段历史，断言展开后索引和角色精确；多 token 仍保持相对顺序。
2. 让 sensitive/global/provider/final 四层 filter 记录所见 body，断言都能看见 checkpoint 文本，且上游 wire body 中已不存在 compaction item。
3. 覆盖 Redis 过期、AES 篡改、未知 `kid`、主体/session 不匹配、原生 token、混合 token，逐一断言状态码和稳定错误码，且上游调用次数为 0。
4. 关闭调试正文保存时检查 Redis session snapshots、数据库 message details 和日志捕获器，确认没有摘要或完整 encrypted_content。
5. 用一次已合成 token 发后续普通请求，要求 mock 上游复述压缩前 sentinel；能复述且请求只调用一次，才算回放链闭合。

## E. 开关、配置与 Drizzle 落点

### E.1 建议的配置粒度与解析规则

建议采用“全局总闸 + 全局默认模式 + provider 覆盖”，不要按模型散落布尔开关：

```ts
type RemoteCompactionMode = "reject" | "passthrough" | "synthesize";
type ProviderRemoteCompactionMode = "inherit" | RemoteCompactionMode;
```

解析顺序固定为：全局 `enabled=false` 时一律 `reject`；启用后，provider 非 `inherit` 就取 provider 值，否则取全局默认模式。`reject` 必须由识别层返回明确 501/503，不能等同于“不识别 trigger 后走普通 chat”。`passthrough` 只用于原生支持 v2 的上游；`synthesize` 使用 C、D 节模块。

建议新增全局字段：

| Drizzle 字段 | 类型与建议默认值 | 说明 |
|---|---|---|
| `remoteCompactionV2Enabled` | boolean，`false` | 紧急总闸；false 仍识别并明确拒绝，不把 trigger 发给不支持的上游。|
| `remoteCompactionV2DefaultMode` | varchar enum，`"reject"` | 全局默认；首轮上线不应一次性影响所有 codex provider。|
| `remoteCompactionV2Config` | JSONB，见下 | 放容量/超时/codec 参数，避免为每个数字加列。|

JSONB 建议使用严格版本化结构：

```ts
interface RemoteCompactionV2Config {
  version: 1;
  storage: "redis" | "aes_gcm";
  activeKeyId: string | null;            // 仅标识，不是密钥
  maxSummaryTokens: number;              // 默认 4096
  maxSummaryBytes: number;               // 默认 262144
  summaryTimeoutMs: number;              // 默认 120000
  heartbeatIntervalMs: number;            // 默认 10000
  idempotencyTtlSeconds: number;          // 默认 600
  redisRetentionSeconds: number | null;   // 选 Redis 时必须显式填写
  persistPlaintextDebug: boolean;         // 默认 false
}
```

provider 表只加两个字段：

- `remoteCompactionV2Mode`：varchar enum，默认 `"inherit"`。
- `remoteCompactionSummaryModel`：nullable varchar；null 表示沿用请求经 provider model redirect 后的 effective model，只允许同 provider 内模型名。

storage、active key 和 token 格式必须是全局一致的，不能按 provider 配置，否则一次会话切 provider 后可能无法回放。AES keyring 从环境变量或 secret manager 注入，例如由部署层提供 `kid → 32-byte key` 映射；**不得写入 Drizzle、settings API 或管理前端**。

### E.2 具体 schema/settings 修改面

系统设置路径需要同步修改以下位置，不能只加数据库列：

1. `src/drizzle/schema.ts:857-899` 附近增加总闸、默认模式和 JSONB config；按项目规范修改 schema 后运行 `bun run db:generate` 生成 migration，不手写 SQL。
2. `src/types/system-config.ts:27-145,179-250` 增加运行时与 update payload 类型，并在独立类型文件中定义/复用 config schema。
3. `src/repository/_shared/transformers.ts:234-284` 的 `toSystemSettings` 增加严格 normalize；未知 version/mode 归为 `reject`，不能宽松启用。
4. `src/repository/system-config.ts:142-185,223-256,258-318,449-580,680-733` 同步 fallback、selection、recent-column ladder、读取和 partial update。数据库未迁移或列缺失时 compaction 三字段必须回落到 `enabled=false`/`reject`。
5. `src/lib/config/system-settings-cache.ts:34-87` 把三字段纳入 `DEFAULT_SETTINGS` 与缓存投影；DB/Redis cache 读取失败时同样 fail closed。
6. `src/lib/api/v1/schemas/system-config.ts:83-192` 加严格 Zod 范围：tokens 256—16384、bytes 4096—262144、timeout 5000—300000、heartbeat 1000—30000 且小于 timeout、idempotency TTL 至少覆盖 timeout。只有在 `enabled=true` 且至少一个 effective mode 为 synthesize 时，选 Redis 才要求 retention、选 AES 才要求 activeKeyId；关闭状态允许保留 `activeKeyId=null` 的安全默认模板。
7. `src/actions/system-config.ts` 和对应 API mapper 接受/返回新字段并在更新后清 settings cache。UI 本期可以不做，但管理 API 不能丢字段。

这里有一个现成警示：`schema.ts:863-869`、`repository/system-config.ts:171` 和 transformer 对 `allowNonConversationEndpointProviderFallback` 的常态默认是 true，而 `system-settings-cache.ts:69-70` 在缓存失败时是 false。remote compaction 必须在 schema、transformer、repository fallback、cache fallback 四处统一为关闭/拒绝，不能复制这种默认不一致。

provider 路径需要修改：

1. `src/drizzle/schema.ts:181-226` 加两列。
2. `src/types/provider.ts:316-442,443-533,563-732` 的 `Provider`、display、create/update data 加 camelCase/snake_case 对应字段；如批量编辑不在本期范围，应明确不加入 batch patch，避免半支持。
3. `src/repository/_shared/transformers.ts:95` 的 `toProvider`，以及 `src/repository/provider.ts:194-260,639-724` 的 create/update 映射新字段。
4. `src/lib/validation/schemas.ts` 的 server action Create/Update schema、`src/lib/api/v1/schemas/providers.ts:27-167,354-524` 的响应和 REST create/update schema同步枚举、长度与“summary model 仅 codex provider 有效”的校验。
5. `src/actions/providers.ts` 的表单解析/审计映射和 `src/lib/cache/provider-cache.ts` 的失效流程覆盖新字段；provider 修改后跨实例缓存必须失效。

不实现 UI 时，仍需给管理 API 文档化示例和只读展示，确保运维能看见最终 effective mode；API 返回 `resolvedRemoteCompactionMode` 可由 service 层计算，不另存数据库。

单个 system settings 的 Zod schema 无法知道所有 provider override；它只做字段和同对象的交叉校验。是否存在 effective synthesize、keyring 是否覆盖所有实例等检查应由更新 service/readiness 联合查询 provider 后完成。

### E.3 默认值与上线方式

迁移后的安全默认是：`enabled=false`、全局 default=`reject`、provider=`inherit`、codec 配置按 AES-GCM 模板但 `activeKeyId=null`。这不会静默改变现网流量；对 trigger 返回明确“尚未启用”。部署 keyring 并通过启动自检后，先把目标 DeepSeek provider 设置为 `synthesize`，再打开全局总闸；原生支持 v2 的 provider 明确设为 `passthrough`。若希望所有未来 provider 默认合成，经过灰度后才把 global default 改为 `synthesize`。

配置更新应做原子前置校验：任何 effective `synthesize` 存在时，codec 必须就绪；Redis 模式需写读探针成功且 retention 合法，AES 模式需 active key 与 keyring 匹配。校验失败则拒绝配置变更，不能保存一个运行时必坏的组合。多实例发布还要提供只读 readiness 状态，确认每个实例拥有相同 config version/active `kid` 后再开闸。

### E.4 `auto` 与其他 fallback 选项（待拍板，不作为首版默认）

不建议首版提供 request-time `auto`。所谓“先把 trigger 透传，发现上游不支持再合成”存在四个结构性问题：上游可能已经计费；SSE 一旦向客户端发出状态/字节就不能切换；“零 compaction、重复 item、提前断流”只有读完整条流后才知道；客户端自身还会重试，容易放大成多次上游调用。

若业务强制需要 auto，建议只做**管理面能力探测**：用无用户历史的固定探针调用 provider，完整校验 done+completed，结果写成有时间戳的 capability 状态，随后仍解析为确定的 `passthrough` 或 `synthesize` 模式。是否定期重探、失败几次降级、探针成本和状态过期都需单独设计，并由管理员确认后切换；不能在用户请求中即时 fallback。

`allowNonConversationEndpointProviderFallback` 也不得自动作用于摘要子请求。本方案首版明确 `allowRetry=false, allowProviderSwitch=false`；若决定开放同 provider endpoint 重试，应新增 remote-compaction 专属字段，而不是借用语义过宽的旧开关。

### E.5 本批验证闸门

1. migration 前数据库、migration 后数据库、settings cache 冷启动/读取失败四种场景都断言 effective mode 为 reject，且不发送上游。
2. 对全局总闸、全局默认、provider override 做完整真值表测试；普通请求不受这些字段影响。
3. Zod/repository/cache round-trip 验证 JSONB 默认、边界值、未知版本、非法组合和 provider 类型限制。
4. 两实例订阅 provider/settings cache invalidation，修改模式后断言两边 effective mode 一致；AES 再校验 active `kid` readiness。
5. 审计/API 快照断言只出现 key id，不出现任何 key material。

## F. 测试与真实部署验证方案

### F.1 现有 Vitest 结构的落点

项目 `package.json:19-33` 已有默认 unit、`test:integration`、`test:e2e` 和 coverage 脚本。要注意 `tests/configs/integration.config.ts` 当前只显式包含两个 usage-ledger 文件，新建 integration 测试不会自动被 `bun run test:integration` 发现；实施时必须把新文件加入 `testFiles`，或新增专用 config 并纳入 CI。`tests/configs/e2e.config.ts` 已覆盖 `tests/e2e/**/*`，可直接新增用例。

建议文件清单：

- `tests/unit/proxy/remote-compaction-v2-detection.test.ts`
- `tests/unit/proxy/remote-compaction-history.test.ts`
- `tests/unit/proxy/remote-compaction-sse.test.ts`
- `tests/unit/proxy/remote-compaction-redis-codec.test.ts`
- `tests/unit/proxy/remote-compaction-aes-gcm-codec.test.ts`
- `tests/unit/proxy/remote-compaction-idempotency.test.ts`
- `tests/unit/proxy/remote-compaction-handler.test.ts`
- `tests/unit/validation/remote-compaction-settings.test.ts`
- `tests/integration/remote-compaction-v2-flow.test.ts`
- `tests/e2e/remote-compaction-v2-codex.test.ts`（真实 Codex CLI，环境变量显式 opt-in）
- `scripts/verify-remote-compaction-v2.mjs`（部署后只依赖 HTTP/SSE 的最小探针）

### F.2 单元测试矩阵

| 模块 | 必测用例 |
|---|---|
| trigger/managed endpoint | array 与 object-form；trigger 只在顶层、最后且恰一个；嵌套/字符串/其他路径不误报；wire 与 managed endpoint 分离。|
| 历史与摘要 builder | 去 trigger；旧 CCH token 先展开；消息、tool call/output 顺序不变；instructions 保留；追加 checkpoint prompt；父对象不被修改；未知 token fail closed。|
| 回放 | 一个/多个 token 原位变成 user message；旧消息/摘要/新消息位置；filters 都看到明文；上游不再看到 compaction item。|
| SSE | heartbeat 可忽略；恰一个 `response.output_item.done` compaction；completed 在后；id/usage 正确；没有 completed、0/2 个 item、空 encrypted_content 均由测试 parser 拒绝。|
| Redis codec | token 随机性、hash key、NX/TTL、主体绑定、过期、淘汰、错误不缓存、并发只写一次。|
| AES-GCM codec | round-trip、nonce 不重复、密文/nonce/tag/AAD 任一位篡改、错主体、错 key、未知 kid、旧新 key 轮换、base64/长度/版本上限。|
| 幂等 | 首次、并发等待、成功复用、失败释放、lease 过期与 fencing；同 body 不同 key/session/provider/model 不碰撞。|
| handler/guard | settings 失败返回 503；reject/passthrough/synthesize 真值表；合成绕开 fake streaming/forwarder/response fixer；普通请求回归。|
| 配置 | schema/repository/cache 默认一致；非法组合；provider override；API 不暴露 key material；migration 兼容。|

可以复用 `tests/unit/proxy/proxy-forwarder-raw-passthrough-regression.test.ts` 的 session 构造和私有 transport spy 风格，以及 `response-input-rectifier.test.ts`、`non-chat-endpoint-*.test.ts` 的现有 fixtures。新增模块的行、函数、语句和分支覆盖率至少 80%；codec、ownership 判定、幂等和 SSE 组帧属于安全关键路径，建议分支覆盖率目标 90%。

### F.3 mock 上游的集成测试

`tests/integration/remote-compaction-v2-flow.test.ts` 使用 `node:http.createServer` 启一个随机本地端口，模式可参考 `tests/unit/proxy/proxy-forwarder-nonok-body-hang.test.ts` 和 `tests/e2e/responses-ws-codex-cli-transport.test.ts:169-257`。mock 上游只实现普通 `/v1/responses`，故意不实现 compaction 协议：收到摘要子请求后断言 `stream === false`、无 trigger、无 tools/compaction headers，返回确定文本 `SUMMARY_WITH_SENTINEL` 和 usage。

集成测试从 CCH route boundary 发送：

```json
{
  "model": "deepseek-test",
  "stream": true,
  "input": [
    {"type":"message","role":"user","content":[{"type":"input_text","text":"SENTINEL-42"}]},
    {"type":"compaction_trigger"}
  ]
}
```

测试逐帧读取 CCH SSE，而不是把整段字符串做包含判断，并验证：

1. mock 上游恰收到一次普通摘要请求；外层真实 path 仍是 `/v1/responses`，管理/usage endpoint 是 `/v1/responses/compact`。
2. 下游 `content-type` 为 `text/event-stream`，先出现唯一 done compaction，再出现 completed；`encrypted_content` 非空但日志快照中不存在完整值。
3. 立即用该 token 加一条新 user message 再发普通请求；mock 上游第二次收到的是原位展开的 `SUMMARY_WITH_SENTINEL`，不含 opaque token，并返回正常 assistant SSE。
4. 用户侧 compact usage 为非计费；摘要的真实 tokens 进入运营侧 remote-compaction cost/metrics，二者 request id 可关联。
5. 相同外层请求并发三次，mock 摘要调用计数仍为 1；改变 session/key 后不复用。
6. mock 分别返回空文本、429、500、慢于 timeout、主动断开，断言没有成功 compaction，并得到明确 response.failed/5xx；普通 response 路径和现成 raw passthrough regression 全绿。

若要验证多实例，测试启动两个 handler 实例共享同一个 Redis test namespace：A 实例合成，B 实例回放；Redis 方案验证跨实例取摘要，AES 方案在清空幂等缓存后仍能跨实例解密。测试 teardown 只删除该测试随机前缀，不能 flush 整库。

### F.4 opt-in Codex CLI E2E

新增 E2E 可复用 `tests/e2e/responses-ws-codex-cli-transport.test.ts` 已有的 Codex 定位、spawn、stdout/stderr 收集方式，使用 `CCH_REMOTE_COMPACTION_E2E=1` 显式开启，避免默认 CI 依赖本机 Codex。测试配置一个 name 精确为 `OpenAI` 的临时 provider 指向本地 CCH，并用受控短 context 或显式 compact 操作触发 v2。

验收不只看进程退出码，还要同时断言：

- CCH 捕获到带 `compaction_trigger`、`x-codex-beta-features` 和 `request_kind=compaction` 的请求。
- Codex 随后的普通请求原样带回同一个 encrypted_content。
- 后续回复包含压缩前 sentinel。
- 本次运行的 stderr/事件流和开始时间之后的 Codex 日志均不含 `Error running remote compact task`、`expected exactly one compaction output item`、`stream closed before response.completed`。

不要扫描整个历史日志，否则会把修复前的旧错误误报为本次失败；用测试开始时间、临时 `CODEX_HOME` 或本次 thread id 限定范围。临时目录和凭据在 finally 中清理，日志输出只显示 token hash。

### F.5 真实部署最小脚本

计划新增的 `scripts/verify-remote-compaction-v2.mjs` 从环境变量读取 `CCH_BASE_URL`、`CCH_API_KEY`、`CCH_MODEL`，绝不读取或打印 `config.toml`。脚本本地生成一个 UUIDv7，并在同一会话的两次请求中同时设置 header `session_id`、`x-session-id` 和 body `prompt_cache_key`；这兼容开源 completer，也给现网自研守卫提供合法标识。若现网要求“每个子线程/请求一个新 UUIDv7”，须在 0.4 前提确认后以显式参数调整，脚本不能猜。

脚本执行两步：

1. 生成随机 sentinel，发“历史 message + trigger”；增量解析 SSE，忽略注释，严格断言唯一 done compaction、非空 token、随后唯一 completed。终端只打印 `cmp id`、token byte length 和 SHA-256 前缀。
2. 发“该 compaction item + 新 user message，请逐字返回 sentinel”的普通请求，断言正常 assistant 输出包含 sentinel。这样同时验证合成和回放，而不只是协议外壳。

建议调用形式：

```powershell
$env:CCH_BASE_URL = "https://cch.wingjoy.net/v1"
$env:CCH_API_KEY = "<从安全渠道注入>"
$env:CCH_MODEL = "<目标模型>"
bun scripts/verify-remote-compaction-v2.mjs
```

脚本 `PASS` 说明服务端 wire 协议和记忆回放成立，但不能单独证明某个 Codex 版本的 UI 行为；最后仍需在真实 Codex 会话中触发一次 `/compact`（或自然达到自动压缩阈值），只检查本次时间窗口，确认不再出现 `Error running remote compact task`，并继续追问压缩前 sentinel。三项全部通过才是部署验收。

### F.6 建议执行顺序

1. `bunx vitest run tests/unit/proxy/remote-compaction-*.test.ts tests/unit/validation/remote-compaction-settings.test.ts`
2. `bun run test:integration`（先确认 config 已纳入新文件）
3. `bun run test:e2e`；真实 Codex 用例只有设置 opt-in 环境变量才执行。
4. `bun run test:coverage`，并为新模块增加专用 coverage config/CI gate。
5. 测试环境运行最小脚本，再灰度实例，再真实 Codex；任何一步失败都保持全局总闸关闭。

## G. 风险、失败边界与长期维护

### G.1 失败时如何避免会话被“压坏”或永久卡死

Codex 只有在收到合法 completed 且恰一个 compaction item 后才替换本地历史。因此 CCH 合成失败时只要**不发假 compaction**，客户端原历史仍在，失败会暴露为错误而不是静默失忆。短期会话可能因为每次新 turn 都先触发压缩而显得“卡住”，但这是可恢复的服务故障：修复 CCH/codec/provider 后重试即可；伪造空摘要虽然能让 turn 继续，却会不可逆地丢上下文，风险更高。

错误需分成两类：

- 确定性错误，例如多个 trigger、未知 token、认证主体不匹配、摘要输入超过 hard cap，使用 `response.failed` 中 Codex 可识别为 invalid request 的错误 code，并给 CCH 稳定子码，避免客户端无意义重试。
- 瞬时错误，例如 Redis/secret manager 暂不可用、上游 429/5xx、timeout，使用 retryable 服务错误并给 `Retry-After`（HTTP 失败时）或 error message；客户端最多执行初次加 2 次 stream retry。CCH 不再叠加 provider switch。

heartbeat 必须小于代理/负载均衡器 idle timeout；摘要任务设绝对 deadline。若客户端在上游已开始后断开，建议后台继续到该 deadline并保存幂等结果，使客户端重连可复用；这会产生“客户端已走但上游仍计费”的小窗口，必须用 `delivery_aborted=true` 记录。是否改为立即取消属于成本/重试命中率取舍，需拍板。

若选择 Redis payload 方案且 token 已过期/丢失，没有安全的自动恢复手段，只能从备份恢复相应 key，或由用户在仍有原始 rollout 的前提下显式迁移。若选择 AES 但旧 key 被移除，同样只能恢复旧 key。两类灾难都应在删除数据/密钥前用历史 token 抽样回放做阻断检查。

### G.2 客户端重试、服务幂等和调用放大

`MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES = 2` 表示初次请求外最多再试两次；Codex 自动压缩还可能换 fallback model 再执行 remote v2，但不会改成本地压缩。服务端请求指纹必须排除 trigger、JSON 空白和无关 header，包含 auth 主体、会话标识、provider、effective model 与规范化历史 hash。

需要覆盖三个竞态：

1. CCH 已生成并发送 completed，但客户端没收到：重试必须返回同 token、cmp/resp id 和 usage。
2. 首次还在生成，重试/并发已到：后来的请求等待同一 promise/Redis 状态，不再调用上游；等待也要持续 heartbeat。
3. leader 崩溃：lease 到期后新 leader 生成，旧 leader 即使恢复也因 fencing token 不能覆盖新结果。

成功结果缓存至少 10 分钟；确定性失败可短暂负缓存以抑制风暴，瞬时错误不长期负缓存。AES 模式若幂等 Redis 丢失，正确性仍在但可能重复生成/计费；Redis payload 模式丢失则连回放正确性也失去。指标必须区分两者。

### G.3 缓存与容量边界

缓存分三类，禁止混用键空间和 TTL：

- payload store：仅 Redis 方案存在，是长期事实存储，受 retention/备份/SLO 约束。
- idempotency result/lock：两方案共有，短 TTL，保存最终 token、ids、usage 和状态，不保存日志正文。
- replay decode cache：可选的短期进程缓存，以 token hash + auth binding 为键，有条目数和总字节上限；认证失败不缓存。

`encrypted_content` hard cap 建议 256 KiB，SSE event hard cap 512 KiB，并同时统计最终整条 rollout record 的安全余量。16 MiB 是 Codex migration 的整条 JSONL 上限，不是目标容量。摘要请求本身仍可能因上游 context window 较小而失败；自动裁剪旧 tool output 是有损降级，首版不做。若未来需要预算裁剪，必须明确保留优先级、审计被裁字节数并单独批准。

### G.4 计费、限额与非计费端点

外层请求的 managed endpoint 为 `/v1/responses/compact`，沿用现有 `NON_BILLING_ENDPOINTS`，因此用户侧 `message_request` cost 应为 0，也不进入 `usage_ledger` 的 billable 聚合。可是摘要子请求对上游真实产生费用，不能假装为 0。

建议新增独立 `remote_compaction_attempt` 运营账表，最小字段为：`parentMessageRequestId`、`attemptId`、`idempotencyHash`、provider/model、upstream request id、status/error code、input/output/cache tokens、provider cost、duration、summary/payload bytes、codec/kid、created/finished time、`deliveryAborted`、`resultReused`。不存摘要和完整 token。这样既不污染用户 quota/排行榜，又能对账供应商账单；父 `message_request.specialSettings` 只存 attempt id 和摘要统计。

若产品决定向用户收费，需要重新定义 ledger 语义和价格展示，不能简单把 compact 从非计费列表删掉：否则外层零 usage 与内层真实 usage会错位，重试复用也可能重复记账。首版建议“用户非计费、运营成本记账、provider 运营限额单独保护”，最终仍需商业负责人确认。

### G.5 日志与可观测性

结构化日志使用 parent request id、attempt id 和 upstream request id 串联，默认只输出 hash/字节数。禁止用 session id、token、source hash 做 metrics label。建议指标：

- `remote_compaction_requests_total{mode,result,error_code,provider}`
- `remote_compaction_summary_duration_seconds`、`remote_compaction_summary_tokens_total`
- `remote_compaction_payload_bytes`、`remote_compaction_sse_completed_total`
- `remote_compaction_idempotency_hits_total`、`remote_compaction_lock_wait_seconds`
- `remote_compaction_replays_total{result,codec}`、`remote_compaction_decode_failures_total{reason}`
- `remote_compaction_key_readiness{kid,instance}`（只暴露 kid）

告警至少覆盖：5 分钟合成失败率、done 后无 completed、decode/key unavailable、Redis payload 淘汰/容量、幂等重复上游调用、实例 keyring 不一致、p95 duration 接近客户端/网关 timeout、payload 接近 hard cap。健康检查不能真的调用收费模型；readiness 只验证配置、codec 和 Redis/AES key 可用，真实能力由灰度探针验证。

### G.6 安全与语义风险

- 摘要是模型生成的用户级上下文，不是可信 system 指令；必须保持 user role并重新经过敏感词/请求过滤。摘要 prompt injection 仍可能被模型保留，不能提升优先级。
- tool call/output、代码、路径和秘密都可能进入摘要。Redis 明文和 AES key 的权限应按原始对话数据等级治理，日志 redaction 测试必须是发布门槛。
- 同 provider 的摘要模型也可能遗漏关键状态。F 节 sentinel 只能证明链路，不证明所有语义完整；需要收集人工回放样本，比较压缩前任务与压缩后续作质量。
- provider context window 可能小于 Codex 认为的模型窗口。首版失败显式暴露；任何自动截断/换模型均属待批准降级。
- 现网 UUIDv7 自研守卫仍是最高优先级未知项。拿不到源码时只能保证外层保留三个会话标识、内层不走公开路由并记录 parent/child id；不能宣称已兼容未见实现。

### G.7 未来升级 CCH 的冲突范围

升级到含 PR #1404 的版本时，上游已有 `remote-compaction.ts`、managed endpoint、非计费和 buffer sync，应删除本地重复 backport，只保留 CCH 合成/回放扩展。升级到含 PR #1411/stream gate 的版本时，要确认本地合成仍直接返回；若改为经过 gate，则保留 compaction classifier 和字节级测试。

预计高冲突文件：`proxy-handler.ts`、`proxy/session.ts`、`proxy/guard-pipeline.ts`、`proxy/response-input-rectifier.ts`、`proxy/message-service.ts`、`proxy/response-handler.ts`、`proxy/forwarder.ts`、`drizzle/schema.ts`、system settings/provider 的 types/repository/API schemas。低冲突面是新 `proxy/remote-compaction/` 目录、独立 codec/attempt repository、测试和验证脚本。实施时应把上游回迁、深模块、schema/config、观测分别成批提交，未来可逐批丢弃或重放。

升级验收不能只解决编译冲突；必须重跑协议字节测试、回放 sentinel、nonbilling ledger、stream gate 和真实 Codex。还要重新核对 Codex 的 `collect_compaction_output`、retry 和 rollout 上限，因为这些客户端细节没有服务器端版本协商。

### G.8 本节结论

本方案能做到“失败可见、历史不被假摘要破坏、成功可幂等回放”，但无法从服务端为 Codex补出客户端本地压缩。真正避免会话卡住依赖合成服务、codec/keyring 和所选 provider 的高可用；这也是为什么所有自动透传、自动换 provider、静默忽略 token 与有损裁剪都只列为待批准选项，而不写成默认路径。

## H. 分批实施顺序与每批验收

遵循本仓库 Windows 下多文件/大补丁分批落地约束，建议拆成以下可独立评审的批次；前一批未通过闸门，不进入后一批。

1. **现网前提勘察（不改业务）**：取得 UUIDv7 守卫所在源码/网关配置和真实请求样本，确认 header/body 字段、compaction 请求是否放行、子线程是否必须新 id、非对话计费口径。输出一页确认记录。若拿不到源码，用带合法 `session_id`、`x-session-id`、`prompt_cache_key` 的只读探针分别验证普通/trigger，所有未知项保持“未确证”。
2. **上游窄回迁**：落 B.1 的识别、managed endpoint、buffer sync、fake streaming 排除、message/response 非计费语义和测试。不引入 synthesis。验收 B.4，保留全局功能关闭。
3. **配置与密钥 readiness**：修改 Drizzle/types/repository/cache/API/env schema，生成 migration；实现 effective mode resolver 和 Redis/AES readiness，不接 handler。运行 migration validation、配置真值表、两实例 cache/keyring 测试。此批结束仍不向用户流量启用。
4. **纯合成核心**：新增 history、codec、idempotency、SSE、in-memory adapter 和单元测试；不连接真实 provider。以 C.7 前四项为闸门。
5. **内部 provider transport 与 handler 接线**：抽取 selected-provider executor，加入专用 compaction pipeline、attempt 运营账和 transient/deterministic failure 映射；禁止 HTTP 回环、provider switch 和普通 ResponseFixer。用 local HTTP mock 完成“trigger → 摘要 → 唯一 done → completed”。
6. **回放展开**：加入 `compactionReplay` guard 和 redaction；完成 token 原位展开、filters 可见性、未知 token 错误。以 D.5 和 sentinel 后续请求为闸门。
7. **全量回归与故障注入**：运行 unit/integration/e2e/coverage、Redis/AES 多实例、慢流/断流/429/500、幂等 leader 崩溃、migration 前后兼容。执行 `bun run lint`、`bun run typecheck`、`bun run build`；OpenAPI 先 `bun run openapi:generate` 更新产物，再 `bun run openapi:check`，并运行 migration/i18n audits。
8. **灰度发布**：先部署所有实例但保持 `enabled=false`；核对 readiness 与 active kid；只给一个内部 key/目标 provider 开启 synthesize（若当前配置不支持按 key 灰度，则用独立 provider group/实例），跑最小脚本和真实 Codex。观察至少一个完整业务周期后再扩大；回滚只关总闸并保留所有旧解密 key/Redis payload，绝不能随代码回滚删除历史状态。

第 8 步的“关总闸”会让已有需要压缩的 Codex 会话收到明确错误，它是事故隔离开关，不是让会话继续的功能降级。若业务要求关闸后仍可用，必须在上线前另行批准并实现确定的替代策略。

## I. 预计涉及文件清单

### I.1 上游回迁与代理主链

- `src/app/v1/_lib/proxy/remote-compaction.ts`（新增识别器）
- `src/app/v1/_lib/proxy/session.ts`
- `src/app/v1/_lib/proxy-handler.ts`
- `src/app/v1/_lib/proxy/guard-pipeline.ts`
- `src/app/v1/_lib/proxy/response-input-rectifier.ts`
- `src/app/v1/_lib/proxy/message-service.ts`
- `src/app/v1/_lib/proxy/response-handler.ts`
- `src/app/v1/_lib/proxy/forwarder.ts`（只抽内部 transport seam）
- `src/lib/utils/error-messages.ts`、`messages/*/errors.json`

`endpoint-paths.ts`、`endpoint-policy.ts`、`performance-formatter.ts` 在 0.8.10 已具备 compact 定义，预计只补测试、不改行为。`stream-gate/` 当前不存在，不在本次新增范围。

### I.2 新合成/回放模块

- `src/app/v1/_lib/proxy/remote-compaction/service.ts`
- `src/app/v1/_lib/proxy/remote-compaction/history.ts`
- `src/app/v1/_lib/proxy/remote-compaction/summary-adapter.ts`
- `src/app/v1/_lib/proxy/remote-compaction/selected-provider-executor.ts`（也可放 forwarder 邻层）
- `src/app/v1/_lib/proxy/remote-compaction/codec.ts`
- `src/app/v1/_lib/proxy/remote-compaction/redis-codec.ts`
- `src/app/v1/_lib/proxy/remote-compaction/aes-gcm-codec.ts`
- `src/app/v1/_lib/proxy/remote-compaction/idempotency.ts`
- `src/app/v1/_lib/proxy/remote-compaction/sse.ts`
- `src/app/v1/_lib/proxy/remote-compaction/replay.ts`
- `src/repository/remote-compaction-attempt.ts`

### I.3 配置、持久化与部署

- `src/drizzle/schema.ts` 与 `drizzle/` 下由 `bun run db:generate` 生成的 migration/meta
- `src/types/system-config.ts`、`src/types/provider.ts`，以及建议新增的 remote-compaction config 类型文件
- `src/repository/_shared/transformers.ts`
- `src/repository/system-config.ts`、`src/repository/provider.ts`
- `src/lib/config/system-settings-cache.ts`、`src/lib/config/env.schema.ts`
- `src/lib/cache/provider-cache.ts`
- `src/lib/validation/schemas.ts`
- `src/lib/api/v1/schemas/system-config.ts`、`src/lib/api/v1/schemas/providers.ts`
- `src/actions/system-config.ts`、`src/actions/providers.ts`
- `src/app/api/admin/system-config/route.ts` 及相关管理 API mapper/OpenAPI 生成产物
- 部署环境示例/secret 配置文档（只写 key 名与格式，不放真实值）

### I.4 测试与探针

F.1 列出的 unit/integration/e2e 文件、`tests/configs/integration.config.ts`、新增专用 coverage config（如采用）、`scripts/verify-remote-compaction-v2.mjs`。已有 `proxy-forwarder-raw-passthrough-regression.test.ts`、`response-input-rectifier.test.ts`、`non-chat-endpoint-*.test.ts` 和 `responses-ws-codex-cli-transport.test.ts` 需要作为回归集运行，原则上不改其原有断言。

## J. 实施前需要人拍板的决策清单

| 编号 | 决策 | 建议 | 不决定的后果 |
|---|---|---|---|
| D1 | 现网 UUIDv7 守卫真实位置与父/子线程规则 | 先拿源码/网关配置；拿不到就做显式探针并保留未确证标记 | 可能在合成前被拦，或内部子请求重复触发守卫。|
| D2 | payload 采用 Redis 引用还是 AES-GCM 自包含 | 首选 AES-GCM；Redis 仅在接受长期存储 SLO 时选 | codec、灾备、体积、吊销和 key 管理无法落地。|
| D3 | token 绑定粒度 | 先绑租户/Key；确认恢复/fork 语义后再考虑 session 强绑定 | 过松有窃用面，过严会误伤恢复/子线程。|
| D4 | 摘要运营成本是否向用户计费 | 首版用户非计费，独立运营账；由商业负责人确认 | 供应商账单无法对平，或用户被重复/不透明计费。|
| D5 | 客户端断开后是否继续摘要 | 建议在绝对 deadline 内继续并缓存，记录 deliveryAborted | 立即取消会降低浪费但更易在客户端重试时重复收费。|
| D6 | 是否允许同 provider endpoint 重试 | 首版关闭 | 开启会放大调用；关闭则瞬时 endpoint 故障更易暴露。|
| D7 | 是否提供 auto 能力探测/fallback | 首版不做 request-time auto；如需要，只做管理面探针并人工确认切换 | 即时 auto 可能双计费且 SSE 发出后无法改道。|
| D8 | Redis 方案 retention，或 AES 旧 key 保留期 | 与可恢复 Codex 会话的最长周期一致并设删除闸门 | 老 rollout 将不可回放。|
| D9 | 是否压缩密文前明文、是否对过长历史裁剪 | 首版均不做 | 做了有解压炸弹/有损失忆风险；不做会显式失败超限请求。|
| D10 | 摘要 prompt/model 与质量验收 | 默认同 provider effective model、4096 tokens；用真实任务样本人工评估 | 协议通过但任务续作质量可能不可接受。|
| D11 | 灰度粒度 | 首选独立 provider group/内部 key；不要一次全局打开 | 单纯全局开关会扩大故障半径。|

除 D1 外，其余均不能靠“自动兜底”代替决策。特别是 D2、D3、D4、D7、D8 会改变持久化或安全边界，应在写实现前形成 ADR；D1 未确证时可以先完成纯模块和 mock 测试，但不得进入现网灰度。
