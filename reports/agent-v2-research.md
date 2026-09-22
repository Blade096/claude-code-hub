# Codex MultiAgentV2 与 Responses Multi-agent 的 CCH 兼容性研究

> 修订日期：2026-09-20
> 当前 fork：`29abd32dcfb75bc47ed4d079533233e10fd4fd85`
> 对比上游：`upstream/main` = [`dfeb14331cb350f672e92a3684adecf1052dd476`](https://github.com/ding113/claude-code-hub/commit/dfeb14331cb350f672e92a3684adecf1052dd476)（v0.9.5）
> 最高权威来源：[OpenAI Responses Multi-agent 官方指南](https://developers.openai.com/api/docs/guides/responses-multi-agent)

## 结论

用户最初问的 `agent_v2` 是 **Codex CLI/Desktop 的 `multi_agent_v2`**。调研中还发现 OpenAI 已公开名字相近的 **Responses Multi-agent**。两者共享 `agent_message`、加密参数和 Agent 路径等协议元素，但执行位置不同，必须分开判断。

### 对当前 Codex `multi_agent_v2` 的结论

1. Codex 在本地执行 `spawn_agent`、`send_message`、`followup_task` 等工具，本地创建子线程；根线程和子线程分别向 CCH 发普通 `/v1/responses` 请求。官方 Codex 源码的 `spawn_agent` handler 会调用本地 `agent_control.spawn_agent_with_communication()`，见 [`multi_agents_v2/spawn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)。
2. CCH 不需要实现 Agent 调度器。当前 fork 的普通 HTTP/SSE 路径会保留未知 tool schema、`agent_message`、`encrypted_content` 以及 Codex 的 `session-id`、`thread-id` 等 headers，因此对“原生 OpenAI/Codex 上游”具备较好的透明转发基础。
3. 但目前仍只能称为**未经认证的部分支持**：仓库没有 V2 fixture 或真实 E2E；旧静态类型没有覆盖新 item；fake streaming 和请求转换没有 V2 回归测试；会话审计只使用共享路由 session，不能区分根/子线程。
4. 第三方 Responses provider 通常无法直接识别 V2 的 `agent_message`，但 CPA 已证明代理层可以兼容：在模型生成调用前移除 collaboration `message.encrypted` schema，使任务参数保持可读；随后只对显式标记为兼容端点的模型，把 `agent_message/encrypted_content` 改写为标准 `message/user/input_text`，并在响应方向恢复工具 namespace。当前 CCH 尚未实现这套双向转换，但不是技术上不可行。
5. Codex 根/子线程使用不同 `thread-id` 和 `x-client-request-id`，但在 API-key 模式下可共享 `session-id`/`prompt_cache_key`。当前 CCH 不读取标准 `thread-id`，会把它们汇总为一个 Hub session。这通常不阻断模型调用，却会影响并发语义、会话列表和故障归因。
6. V2 默认 `fork_turns="all"`，子线程可复制完整父历史。对 CCH 的直接压力是并发的大请求、Redis 调试工件、长 SSE 和取消后的缓冲保留。上游内存护栏值得吸收，但应在协议测试之后以小提交移植。

### 对新 Responses `multi_agent.enabled` 的结论

1. 这是 OpenAI Responses API 的服务端 hosted orchestration。应用不执行 `multi_agent_call`；服务端负责 Agent 树和邮箱。
2. 当前 CCH HTTP 仍只是**部分兼容**。`OpenAI-Beta`、`multi_agent` 和新 output item 能在普通直通路径保留，但 provider override 可能注入官方不支持的 `reasoning.summary`。
3. 当前 CCH WebSocket 不完整：客户端入口只接受 `response.create`，会拒绝官方 developer-defined tool 闭环所需的 `response.inject`。
4. fake streaming 会丢 Agent-attributed SSE 事件的顶层 `agent`；CCH remote compaction 也不应介入 hosted Agent 的独立上下文压缩。

所以，近期应先做 **Codex 本地 V2 的透明转发认证**；hosted Responses Multi-agent 作为第二条能力线单独加检测与 WebSocket 支持。两条线都不需要 CCH 自己实现 Agent 调度。

## 1. Codex CLI/Desktop `multi_agent_v2`

### 1.1 真实执行链

Codex V2 把协作工具作为普通 Responses function tools 提交给模型。模型返回 `function_call` 后，Codex 本地 handler 执行它：

- `spawn_agent` 在本地创建新的 Codex thread。
- `send_message` 和 `followup_task` 通过本地 Agent 控制层投递。
- 子 Agent 拥有自己的 `thread-id`，再单独调用模型端点。
- V2 的 `message` tool 参数可标记为 encrypted；本地运行时把它包装为 `agent_message` 交给接收方模型。

官方源码证据：

- [`multi_agents_v2/spawn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs) 调用本地 `agent_control.spawn_agent_with_communication()`，并创建新的 `ThreadId`。
- [`multi_agents_spec.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) 定义 V2 function tools，`message` 字段使用 encrypted schema。
- [`prompt_cache_key.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/tests/suite/prompt_cache_key.rs) 验证根/子线程的 `thread-id` 不同，而 API-key 模式下 `session-id` 和 `prompt_cache_key` 可共享。

因此，CCH 在这条链上是多条模型请求的代理，不是 Agent runtime。

### 1.2 当前 fork 已具备的基础

- `/v1/responses` 请求体以通用对象流转，`filterPrivateParameters()` 只递归删除 `_` 前缀字段，不会删除 `agent_message`、`author`、`recipient`、`encrypted_content` 或 encrypted tool schema（`src/app/v1/_lib/proxy/forwarder.ts:494-524`）。
- headers 默认透传，`session-id`、`thread-id`、`x-client-request-id`、`x-openai-subagent` 不在黑名单中（`src/app/v1/_lib/headers.ts:181-200`；`src/app/v1/_lib/proxy/forwarder.ts:5042-5123`）。
- 普通 upstream SSE 由代理转发；运行时没有把未知 response item 按旧 TypeScript union 重新白名单构造。
- 当前已吸收的 Responses WS ArrayBuffer/多行 SSE、cache-write 计费和 reasoning effort 展示改善了 Codex 基础兼容，但不是 V2 专项认证。

### 1.3 尚未认证的关键点

1. **缺少代表性协议测试**：没有包含 encrypted `spawn_agent` 参数、`agent_message` 输入、子线程 headers、tool output 和取消行为的 fixture。
2. **fake streaming 未验证**：它缓冲非流式结果后重建 SSE，只为普通 message 生成 delta。虽然任意 item 会出现在 `output_item.added/done`，但 V2 客户端是否接受缺少 function-argument delta 的合成序列尚无证据。识别到 encrypted V2 tool schema 或 `agent_message` 时，第一阶段应绕过 fake streaming。
3. **旧类型有维护风险**：`src/app/v1/_lib/codex/types/response.ts` 没有完整描述 `agent_message`、encrypted content 和新工具结构。当前不一定导致运行时丢字段，但未来转换代码容易误删。
4. **逻辑线程不可观测**：CCH 的 session 提取只使用 `session_id`、`x-session-id`、`prompt_cache_key` 等共享路由键，不读取 `thread-id`（`src/app/v1/_lib/codex/session-extractor.ts:40-99`）。应新增 `logicalThreadId` 审计维度，但不要改变 sticky provider/cache 使用的共享 routing session。
5. **浏览器 CORS**：allowlist 未包含 `session-id`、`thread-id`、`x-client-request-id`（`src/app/v1/_lib/cors.ts:1-5`）。原生 Codex CLI 不受影响，浏览器兼容客户端会受限。

### 1.4 第三方 provider 边界

原生 OpenAI 后端能够理解 V2 encrypted schema 和 `agent_message`。第三方 OpenAI-compatible provider 未必具备解密能力，甚至可能不识别 `agent_message` 类型。

CLIProxyAPI/CPA 当前主干已经实现一条可参考的兼容路径：

1. 全局显式开启 `codex.optimize-multi-agent-v2`。
2. 在 `spawn_agent`、`send_message`、`followup_task` 的 tool schema 到达模型前删除 `message.encrypted`，因此模型返回的是代理可读的任务参数，而不是事后破解密文。
3. 对第三方 Responses 模型显式设置 `is-compat: true`。
4. 将该模型收到的 `agent_message` 改写为标准 `message`、`role: user`、`input_text`。
5. 对为上游兼容而改名的 collaboration tool，在响应返回 Codex 前恢复原 namespace/name。

官方配置与实现证据：

- [CPA `config.example.yaml`](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml) 对 `optimize-multi-agent-v2` 和模型级 `is-compat` 有明确说明。
- [`optimize_multi_agent_v2.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go) 删除 encrypted schema、转换 `agent_message`，并恢复 collaboration tool 名称。
- [CPA issue #4801](https://github.com/router-for-me/CLIProxyAPI/issues/4801) 记录了 Responses→Responses 漏转换问题并已标记修复。
- [CPA issue #5524](https://github.com/router-for-me/CLIProxyAPI/issues/5524) 记录 HTTP 路径工具名恢复问题；修复已进入 v7.2.154。

这不是“解密已有密文”，而是提前改变工具契约，让任务从源头保持为代理可读文本。CCH 可以移植，但必须显式启用并按 provider/model 标记兼容能力，不能对原生 OpenAI 路径全局改写，也不能在无法确认内容可读时把真正的 opaque ciphertext 冒充成明文。

### 1.5 Codex V2 内存模型

V2 默认 `fork_turns="all"`，可把完整父历史复制到子线程。根/子线程随后分别请求 CCH，所以 fan-out 会直接增加：

- 同时在途的请求体和工具定义；
- Redis request body/messages/phase snapshot；
- SSE/WS buffer、断开后 detached stream；
- 相同共享 session 下的瞬时供应商并发。

`src/app/v1/_lib/proxy/session-guard.ts:172-207` 会保存完整请求体与 before snapshot；`src/app/v1/_lib/proxy/session.ts:1134-1147` 的日志优化只缩减 `system/messages/tools` 数组，不处理 Responses `input`。因此内存风险是 CCH 本地可验证的问题，不只是 Codex issue 的推测。

## 2. Responses API hosted Multi-agent

### 2.1 官方协议到底是什么

#### 2.1.1 服务端托管编排

官方文档说明，启用 `multi_agent.enabled` 后，Responses API 为根模型和子模型提供 hosted orchestration actions。根 Agent 名为 `/root`，子 Agent 使用 `/root/reviewer` 一类层级路径。服务端提供 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`interrupt_agent`、`list_agents` 六个协作动作。

这意味着：

- 应用只发起一个 Responses run，并接收其中所有 Agent 的事件。
- 子 Agent 不是分别向 CCH 发多个 HTTP 请求。
- CCH 不需要创建子线程、维护邮箱或实现 Agent 树数据库。
- `multi_agent_call` 和 `multi_agent_call_output` 是 hosted action 的记录，不是让应用执行的普通函数调用。

官方明确要求，应用收到 `multi_agent_call` 时**不要执行，也不要回传结果**；服务端会执行并返回对应 `multi_agent_call_output`。应用只执行自己声明的普通 `function_call`，然后提交匹配的 `function_call_output`。参见官方指南的 [How Multi-agent works](https://developers.openai.com/api/docs/guides/responses-multi-agent#how-multi-agent-works) 与 [New Multi-agent output items](https://developers.openai.com/api/docs/guides/responses-multi-agent#new-multi-agent-output-items)。

#### 2.1.2 启用条件

原始 HTTP 和 WebSocket 请求都必须携带：

```http
OpenAI-Beta: responses_multi_agent=v1
```

请求体必须包含：

```json
{
  "multi_agent": {
    "enabled": true
  }
}
```

`max_concurrent_subagents` 默认值为 `3`，官方推荐大多数工作负载维持该值。它限制整个 Agent 树同时活跃的子 Agent turn 数，不包含根 Agent；官方没有固定的树深或总子 Agent 数上限。参见官方 [Quickstart](https://developers.openai.com/api/docs/guides/responses-multi-agent#quickstart)。

#### 2.1.3 工具调用闭环

- HTTP：任何 Agent 产生 developer-defined `function_call` 后，应用执行函数，把原 output items 和 `function_call_output` 放入下一次 `responses.create`，必要时通过 `previous_response_id` 续接。
- WebSocket：应用执行函数后，必须在当前活动 response 上发送 `response.inject`，并处理 `response.inject.created` 或 `response.inject.failed`。如果 response 已完成，应把失败事件返回的 input 放入新的 `response.create`。

参见官方 [Inject tool outputs over WebSocket](https://developers.openai.com/api/docs/guides/responses-multi-agent#inject-tool-outputs-over-websocket)。

#### 2.1.4 新事件与归属信息

Multi-agent 新增：

- `multi_agent_call`
- `multi_agent_call_output`
- `agent_message`

Agent-attributed SSE 事件还有顶层 `agent` 字段；`response.created`、`response.completed` 这类整体生命周期事件没有。应用通常从 `response.output_item.added.item.agent.agent_name` 建立 `output_index -> agent` 映射，再给后续 delta 归属 Agent。

### 2.2 当前 CCH HTTP 兼容性

#### 2.2.1 已确认能保留的部分

普通 `/v1/responses` 路径没有按静态 `ResponseRequest` 白名单重建整个请求。出站前会从通用 `Record<string, unknown>` 序列化，所以未知的顶层 `multi_agent` 字段不会仅因类型定义较旧而消失。

请求头同样是基于客户端 headers 加工。黑名单主要是 `content-length`、`connection`、`transfer-encoding`、CCH 内部头和 `x-api-key`；`OpenAI-Beta` 不在黑名单中，因此普通路径会保留它：

- `src/app/v1/_lib/proxy/forwarder.ts:158-172`
- `src/app/v1/_lib/proxy/forwarder.ts:5042-5123`

递归私有字段过滤只删除以下划线开头的键，不会删除 `multi_agent`、`agent`、`encrypted_content`：

- `src/app/v1/_lib/proxy/forwarder.ts:494-524`

因此，HTTP 的基础 header/body 透明性成立。但后续仍存在主动转换，故结论只能是“部分兼容”。

#### 2.2.2 string input rectifier 是待验证风险

官方 Quickstart 合法使用字符串简写：

```json
{
  "input": "Review this diff...",
  "multi_agent": { "enabled": true }
}
```

当前 CCH 默认开启 `response-input-rectifier`，会把字符串改成：

```json
[
  {
    "role": "user",
    "content": [{ "type": "input_text", "text": "..." }]
  }
]
```

证据：`src/app/v1/_lib/proxy/response-input-rectifier.ts:4-10,33-64,80-104`。

这两种输入在普通 Responses 语义上通常等价，但官方 beta hosted orchestration 是否在开发者消息注入、缓存键、事件归属或输入回放上保持完全等价，当前没有真实探针证据。因此这是**兼容风险，不是已证实 bug**。第一阶段应在 Multi-agent 请求上优先保持原始 string input，并用官方端点做 A/B 探针后再决定是否恢复 rectifier。

#### 2.2.3 `reasoning.summary` 是确定冲突

官方限制明确写明：Multi-agent 启用时不支持 `reasoning.summary`。

当前 Codex provider override 在供应商配置 `codexReasoningSummaryPreference` 非 `inherit` 时，会无条件写入：

```ts
nextReasoning.summary = reasoningSummary;
```

证据：`src/lib/codex/provider-overrides.ts:357-369`；审计还会记录该覆写，见 `src/lib/codex/provider-overrides.ts:425-472`。

这是确定的协议冲突。对 `multi_agent.enabled === true` 必须禁止注入 `reasoning.summary`。建议保留客户端原值检测：如果客户端本身携带该字段，返回清晰的本地 400，或原样交给官方返回错误；不要静默删除而掩盖调用方问题。

#### 2.2.4 hosted action 与普通函数必须区分

CCH 的职责是透传 `multi_agent_call`/`multi_agent_call_output`/`agent_message`，不能把 `multi_agent_call` 当 developer-defined function 自动执行。当前 CCH 没有 Agent 工具执行器，这一点反而符合官方协议。

后续如增加通用 function-call 自动执行功能，必须只处理 `type: "function_call"`，明确排除 `multi_agent_call`。

### 2.3 WebSocket 当前为何不完整

#### 2.3.1 客户端 WebSocket 入口只接受 `response.create`

`server.js:221-254` 对每个客户端 frame 做硬校验：

```js
if (frame.type !== "response.create") {
  // unsupported_event_type
}
```

因此合法的 `response.inject` 会被拒绝。没有注入能力，任何 Agent 调用 developer-defined function 时都无法在同一个 hosted run 中恢复，官方完整 WebSocket 工具流程无法成立。

#### 2.3.2 upstream adapter 也是单向 create-to-SSE 桥

`src/app/v1/_lib/responses-ws/upstream-adapter.ts:334-363` 接收一个 HTTP body，并固定构造：

```ts
const frame = {
  type: "response.create",
  ...stripTransportOnlyFields(options.body),
};
```

随后它把 upstream WS 事件转换成一次 HTTP SSE response，直到终态。该接口没有接收后续客户端 frame 的通道，也没有 `response.inject` API。

所以需要区分：

- HTTP 客户端经 CCH 使用多次 `response.create` 做函数闭环，有可能兼容。
- CCH 自己把一次 HTTP 请求升级成 upstream WS 只能用于没有中途 developer function 注入的情况。
- 真正完整的 Multi-agent WS 需要端到端双向 frame relay 和 response 生命周期状态机，不能在现有单请求 adapter 上打一个小补丁解决。

### 2.4 fake streaming 的确定信息损失

fake streaming 会把一个已完成的 JSON response 重新合成为 SSE。`src/app/v1/_lib/proxy/fake-streaming/emitters.ts:287-351` 构造 `response.output_item.added` 和 `response.output_item.done` 时只有：

```ts
{
  type,
  output_index,
  item
}
```

它保留了 `item.agent`，但没有复制官方要求的事件顶层 `agent`。官方示例中的 Agent-attributed `response.output_item.done` 同时具有顶层 `agent` 和 `item.agent`。

此外，fake streaming 资格只按 model/provider group whitelist 判断，不检查 `multi_agent.enabled`：

- `src/app/v1/_lib/proxy/fake-streaming/eligibility.ts:18-40`
- `src/app/v1/_lib/proxy-handler.ts:124-143`

因此第一阶段应加硬性条件：`multi_agent.enabled === true` 时禁止 fake streaming。以后若要开放，必须完整复制顶层 `agent`、新 output item、函数调用和事件顺序，并用官方 fixture 验证。

### 2.5 remote compaction 必须绕过

官方限制：

- Multi-agent 启用时不支持 `/responses/compact`。
- 开启 `multi_agent.enabled` 会隐式开启服务端自动压缩。
- 根 Agent 和每个子 Agent 的上下文由服务端分别压缩。

当前 fork 的自定义 remote compaction 在 `/v1/responses` 中识别 `compaction_trigger`，生成 CCH 自有 `cch2.*` token，并在后续请求中展开：

- `src/app/v1/_lib/proxy/remote-compaction.ts:54-100,103-179`
- `src/app/v1/_lib/proxy/remote-compaction-synthesizer.ts:52-85`
- `src/app/v1/_lib/proxy-handler.ts:76-84,96-101`

现有检测没有排除 `multi_agent.enabled`。这会把 CCH 的单一请求历史摘要机制混入官方按 Agent 隔离的 hosted context，破坏服务端的上下文边界。

安全策略应是：

1. 检测到 `multi_agent.enabled === true` 时，不展开任何 CCH compaction replay token。
2. 不触发 CCH compaction synthesis。
3. 不把 Multi-agent 请求转发到 `/responses/compact`。
4. 原样保留官方 `context_management.compact_threshold`，让服务端处理。
5. 若请求同时出现 `multi_agent.enabled` 与 CCH `compaction_trigger`/`cch2.*`，返回明确 400，而不是猜测兼容方式。

## 3. 共同风险与上游护栏

### 3.1 两种 Multi-agent 的资源形态不同

- Codex 本地 V2 会让根/子线程分别请求 CCH。主要风险是 fan-out、完整历史复制、共享 routing session 上的瞬时并发和多份调试工件。
- Hosted Responses Multi-agent 通常是一个较长的 run。主要风险是更长的 output、多次 HTTP continuation 或 WS injection，以及断开后的流资源保留。

两者都需要监控请求/响应 bytes、Redis 大 key、长连接时长、取消后的 buffer/socket 释放。不能只看“是否 OOM”，还要确认压测后 RSS 和 Redis 占用能回落。

### 3.2 当前 fork 的本地风险

- session debug artifact 会保存 request body、messages 和 phase snapshot；Codex V2 的多个子请求会分别放大这些副本。
- `optimizeRequestMessage()` 不缩减 Responses `input`，大历史仍可能进入日志序列化。
- 长 Multi-agent output 会增加 SSE/WS queue、响应快照和日志正文。
- `agent_message.encrypted_content` 虽不可读，仍是敏感的可重放协议材料，不应额外打印到普通日志。

### 3.3 上游内存护栏应在协议认证后择优吸收

ding113 上游没有 Responses Multi-agent 专项提交，但有通用内存修复可在协议正确性完成后择优移植：

- [`e78f2c426`](https://github.com/ding113/claude-code-hub/commit/e78f2c42653c26a12514918361d54eeac74cafd2)：`SESSION_REQUEST_ARTIFACT_MAX_BYTES`，避免大 requestBody/messages/snapshot 写入 Redis。
- [`a28410182`](https://github.com/ding113/claude-code-hub/commit/a284101826b212c094cfbdd0e855d4faf547d15f) 与 [`8dc707a32`](https://github.com/ding113/claude-code-hub/commit/8dc707a322dc07c5da78d4753fd4cccbbc0ce4c1)：detached stream 预算和销毁。
- [`d6aa890f7`](https://github.com/ding113/claude-code-hub/commit/d6aa890f7e1bffc697d02b744ae0cca87ef346cb)：Redis session response body 去重。
- [`edbd2d937`](https://github.com/ding113/claude-code-hub/commit/edbd2d937921f0029b33012648212890641a49d7)：缺少 SSE content-type 时仍保留 Codex Responses 流。
- [`3724315b1`](https://github.com/ding113/claude-code-hub/commit/3724315b1acc06a03cb7c3d5eabd7d1cae8b70f6) 与 [`ecfac5419`](https://github.com/ding113/claude-code-hub/commit/ecfac54199fd4fcded61da06fcf0fc86c8a8dea6) 范围过大，与当前 remote-compaction `forwarder.ts`/`response-handler.ts` 主链冲突，不建议整体 cherry-pick。

这些护栏有价值，但不能替代 Codex V2 fixture/E2E，也不能替代 hosted 路径的 `reasoning.summary`、fake streaming、compaction 和 WS injection 修复。

### 3.4 开放 issue 的证据等级

以下均是 GitHub 用户报告，不是官方协议承诺，只可作为风险线索：

- [openai/codex#34268](https://github.com/openai/codex/issues/34268)：Codex 本地 MultiAgentV2 全历史 fork 与本地 rollout 存储膨胀。它支持“本地 V2 fan-out 需要资源护栏”的风险判断，不能直接推导 hosted API 会让 CCH 收到多个子请求。
- [openai/codex#28058](https://github.com/openai/codex/issues/28058)：加密 Agent 消息降低本地审计可读性。
- [openai/codex#26753](https://github.com/openai/codex/issues/26753)、[#36586](https://github.com/openai/codex/issues/36586)、[#37237](https://github.com/openai/codex/issues/37237)：特定 Codex 客户端、模型或第三方 Responses provider 对 encrypted Agent 消息/schema 的兼容问题。

这些问题不能覆盖或否定官方 Responses Multi-agent 文档。Codex 本地 V2 要以 Codex 源码和真实 CLI 流量验收，hosted 能力要以官方 Responses API 与 SDK 直连对照验收。

## 4. 实现范围

| 层面 | Codex 本地 V2 | Hosted Responses Multi-agent |
| --- | --- | --- |
| 配置 | 不新增 Hub 调度开关；识别 V2 协议特征用于审计与安全 bypass | 识别 `multi_agent.enabled`；禁止冲突 override |
| 数据库 | 第一阶段不迁移；先在现有 JSON 元数据记录 `thread-id` | 不建 Agent 树表，只记 run 元数据与 usage |
| HTTP | 验证每个根/子线程请求和加密 item 无损 | 验证 beta header、body、新 item 和 continuation |
| WebSocket | 验证 Codex 实际使用方式，不能拿 hosted injection 需求反推 | 完整支持必须实现 `response.inject` 双向 relay |
| UI | 暂不做 Agent 树；先让日志能区分 logical thread | 暂不做 Agent 树；可展示 run 级 Agent 元数据 |
| 审计 | routing session 与 logical thread 分离，不打印密文 | hosted action 只记录、不执行，不打印密文 |
| 测试 | Codex CLI fixture + 原生 OpenAI E2E + fan-out 压测 | 官方 API fixture + SDK 直连对照 + WS injection |

## 5. 分阶段实现方案

### 阶段 A：先认证用户实际需要的 Codex V2

只增加测试和必要的宽类型，不先改数据库或 UI：

1. fixture 覆盖 encrypted `spawn_agent`/`send_message` tool schema。
2. fixture 覆盖子线程 `agent_message`、`encrypted_content`、tool output。
3. 验证 `session-id`、`thread-id`、`x-client-request-id`、`x-openai-subagent` 出站不变。
4. 验证普通 HTTP/SSE 不重建或丢弃未知 item。
5. 对识别到的 Codex V2 流量先绕过 fake streaming，直到合成事件序列有真实 CLI 回归。

验收：固定 fixture 无损；现有 Codex、remote compaction、WS、计费测试无回归；`git diff --check` 通过。

### 阶段 A2：移植 CPA 的第三方子代理兼容层

在原生 OpenAI 透传路径保持不变的前提下，增加两个显式开关维度：全局 Codex V2 优化开关，以及 provider/model 的 portable Responses 能力标记。

实现至少包括：

1. 请求工具 schema 中只处理 `spawn_agent`、`send_message`、`followup_task` 的 `message.encrypted`。
2. 保存请求级“工具是否被优化、如何改名”的状态，供流式和非流式响应恢复。
3. 对 portable provider 把可读的 `agent_message` 转成标准 user message；真正 opaque 的内容必须明确失败，不能伪装为明文。
4. 同时覆盖顶层 `tools` 与 `input[].additional_tools`。
5. 覆盖 namespace 形式、扁平点号名称和双下划线名称的双向恢复。

验收：原生 OpenAI 请求字节语义不变；DeepSeek/GLM 一类显式标记的第三方子代理能收到 `spawn_agent`、`send_message`、`followup_task` 任务；HTTP/SSE/WS 返回的工具名均能被 Codex 识别；关闭开关后完全恢复原行为。

### 阶段 B：真实 Codex CLI E2E

用原生 OpenAI/Codex provider 运行最小的 1 根 + 2 子 Agent：

1. `spawn_agent`、`send_message`、`followup_task` 至少各成功一次。
2. 分别测试 `fork_turns=none`、最近 N 轮和 `all`。
3. 比较根/子 `thread-id`，确认共享 routing session 时响应不会串线。
4. 逐请求核对输入、缓存、输出 token 和计费。
5. 中断一个子 Agent，确认 SSE/WS、并发计数和资源能释放。

验收：任务内容正确到达子 Agent；根 Agent 能收到结果；没有加密解码错误；Hub 计费与上游 usage 一致。

### 阶段 C：线程审计与资源护栏

1. 把当前共享会话明确命名为 `routingSessionId`，继续用于 sticky provider 和 cache affinity。
2. 采集 `thread-id` 为 `logicalThreadId`，先进入现有 JSON 元数据和日志，不改变绑定键。
3. 手工移植 request/session artifact 大小上限。
4. 再独立移植 detached stream budget 和 Redis response body 去重。

验收：根/子请求可独立筛选且仍属于同一 routing session；超过阈值只跳过调试正文，不影响路由、计费和终态；压测后 RSS、socket、Redis key 回落。

### 阶段 D：hosted HTTP 安全兼容

新增严格检测：

```ts
request.multi_agent?.enabled === true
```

命中后：

- 禁止 provider override 注入 `reasoning.summary`。
- 禁止 fake streaming。
- 禁止 CCH remote compaction replay/synthesis。
- 原样保留 `OpenAI-Beta`、`multi_agent`、`context_management` 和未知字段。
- `multi_agent_call` 只透传，永不作为普通函数执行。

fixture 覆盖 `multi_agent_call`、`multi_agent_call_output`、`agent_message`、顶层 `agent`、HTTP continuation、`store:true/false` 和 `previous_response_id`。随后用官方 SDK 直连结果做小额 A/B 探针。

验收：CCH 与 SDK 直连 output items、usage 和错误边界一致；不丢 Agent attribution；不静默改写客户端错误参数。

### 阶段 E：hosted WebSocket `response.inject`

重构 `server.js` 和 upstream WS 层，让同一连接接收 `response.create` 与 `response.inject`，按活动 `response_id` 路由，原样转发 `response.inject.created/failed`，并覆盖 `response_already_completed`、`response_not_found`、背压和断开清理。

验收：完整复刻官方 WebSocket 示例；并发 response 的 injection 不串线；断开后无 retained socket/queue；Agent-attributed events 原样返回。

## 6. 最终建议

值得做，但顺序应以用户当前的 Codex V2 为先：

1. 先做阶段 A/B，确认当前透明转发到底能不能稳定承载原生 OpenAI 的 Codex `multi_agent_v2`。
2. 如果目标包含第三方子代理，紧接着做阶段 A2，按 CPA 的显式兼容模式移植双向转换。
3. 通过后做阶段 C，解决 `thread-id` 审计和内存护栏。
4. 只有明确要给普通 API 客户端开放 hosted Multi-agent 时，再做阶段 D/E。

暂缓 CCH 自己的 Agent 调度、邮箱、Agent 树数据库和 dashboard Agent 树，也不要整体合并上游大型 replay/stream 重构。

产品口径应分开写：

- 当前 Codex `multi_agent_v2`：**具备原生 OpenAI 透明转发基础，但尚未经过真实 E2E 认证；当前 CCH 还没有 CPA 已实现的第三方 portable Responses 转换。**
- 当前 hosted Responses Multi-agent：**HTTP 部分兼容，WebSocket 不完整。**

完成阶段 A/B 后，才可以宣称支持原生 OpenAI 上游的 Codex V2；完成阶段 A2 并通过真实第三方模型 E2E 后，才可以宣称支持对应 provider 的第三方子代理；完成阶段 D 后才可宣称 hosted HTTP 支持；完成阶段 E 后才可宣称 hosted WebSocket 工具闭环支持。
