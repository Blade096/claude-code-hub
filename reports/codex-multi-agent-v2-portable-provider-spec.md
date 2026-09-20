# 支持 Codex MultiAgentV2 第三方子代理

## Problem Statement

使用 Codex CLI/Desktop 的 `multi_agent_v2` 时，根 Agent 可以选择不同模型创建子 Agent。原生 OpenAI/Codex Responses 端点理解 collaboration namespace、加密工具参数和 `agent_message`，但 DeepSeek、GLM、Ollama 等第三方 Responses-compatible Provider 往往只实现公开的 portable Responses 结构。

当前 CCH 会尽量透明转发 Codex 请求，但透明转发不足以跨越两种 dialect：

- collaboration 工具的 `message.encrypted` 会让任务参数成为第三方无法理解的 opaque 内容；
- Codex 子线程使用 `agent_message` 和 `encrypted_content` 承载任务，而 portable Provider 通常只接受标准 `message`、`role: user`、`input_text`；
- 第三方 Provider 可能扁平化、省略或原样回显 collaboration namespace，Codex 随后无法识别工具调用；
- HTTP、SSE 和 WebSocket 若使用不同转换逻辑，会造成同一 Provider 在不同传输方式下行为不一致；
- 直接全局删除加密标记会破坏原生 OpenAI 路径的安全语义。

用户需要在不修改 Codex 客户端、不影响原生 OpenAI Provider、且不静默降级到 MultiAgentV1 的前提下，让明确配置为 portable 的第三方 Provider 能够作为 Codex MultiAgentV2 子代理。

## Solution

CCH 增加一层显式启用、Provider 级受控的 Codex MultiAgentV2 portable compatibility codec。

当系统开关开启、请求来自官方 Codex 客户端、请求确实包含 V2 collaboration 工具、且最终选中的 Provider 被标记为 `portable` 时，codec 在请求进入上游前执行以下行为：

1. 只从 `spawn_agent`、`send_message`、`followup_task` 的 `message` 参数 schema 中移除加密标记，使模型从源头生成可由代理转发的普通任务文本。
2. 将第三方 Provider 不支持的 collaboration namespace 转为碰撞受控的 portable 工具名称，并记录本请求的反向映射。
3. 将可确认属于 portable 流程的 `agent_message` 转为标准 user message，将可读任务内容转换为 `input_text`。
4. 在非流式 JSON、SSE 和 WebSocket 响应返回 Codex 前，使用请求级映射恢复原始 collaboration namespace 和工具名。
5. 只记录转换类型、Provider、模型和命中路径，不记录任务正文或 `encrypted_content`。

原生 OpenAI Provider 使用 `native` 模式，保持请求和响应语义不变。未启用、无法确认来源、发生保留名称冲突或遇到真正 opaque 内容时，系统明确拒绝兼容转换并返回可诊断错误，不执行静默降级。

## User Stories

1. As a Codex user, I want to select a DeepSeek model for a child Agent, so that I can delegate bounded work to a lower-cost model.
2. As a Codex user, I want to select a GLM model for a child Agent, so that I can use heterogeneous models within one Agent tree.
3. As a Codex user, I want `spawn_agent` tasks to reach a portable third-party Provider as readable user input, so that the child Agent executes the assigned task instead of asking what to do.
4. As a Codex user, I want `send_message` updates to reach an already-running third-party child Agent, so that collaboration remains usable after initial spawn.
5. As a Codex user, I want `followup_task` instructions to reach an idle third-party child Agent, so that an existing child context can be reused.
6. As a Codex user, I want child Agent results to return through the original collaboration tool contract, so that the parent Agent can consume them without unsupported-tool errors.
7. As a Codex user, I want HTTP Responses requests to support third-party child Agents, so that the feature works with the default transport.
8. As a Codex user, I want SSE streaming to preserve the same collaboration behavior as non-streaming calls, so that enabling streaming does not change correctness.
9. As a Codex user, I want Responses WebSocket transport to preserve the same collaboration behavior, so that transport selection does not break child Agents.
10. As a Codex user, I want root and child Agents to remain separate logical threads, so that results cannot be delivered to the wrong Agent.
11. As an operator, I want portable compatibility to be disabled by default, so that an upgrade cannot silently weaken native OpenAI message protection.
12. As an operator, I want to enable the feature globally before any Provider can use it, so that rollout is deliberate and reversible.
13. As an operator, I want to classify each Provider as native, portable, or disabled for MultiAgentV2, so that capability is based on the actual endpoint rather than model-name guesses.
14. As an operator, I want Provider mode changes exposed through the existing management API and settings UI, so that configuration does not require direct database edits.
15. As an operator, I want clear warnings when portable mode makes delegated task text visible to CCH, so that I understand the security tradeoff.
16. As an operator, I want native OpenAI Providers to retain encrypted collaboration messages, so that compatibility changes do not reduce their existing protections.
17. As an operator, I want a compatibility error when CCH receives genuine opaque content on a portable path, so that ciphertext is never misrepresented as readable task text.
18. As an operator, I want a compatibility error when the reserved portable tool namespace collides with a client-defined tool, so that tool calls are never routed ambiguously.
19. As an operator, I want compatibility errors to include the request/session identifier but not task content, so that incidents are diagnosable without leaking prompts.
20. As an operator, I want the conversion recorded in usage-log special settings, so that I can prove which requests used portable compatibility.
21. As an operator, I want compatibility audit data to include requested and actual Provider/model information, so that cross-provider routing can be investigated.
22. As an operator, I want portable MultiAgentV2 requests to bypass fake streaming until the synthesized event stream is proven equivalent, so that CCH does not lose function-call or Agent metadata.
23. As an operator, I want remote compaction behavior to remain unchanged unless a regression test proves an interaction, so that this feature does not silently alter the existing compaction contract.
24. As a security reviewer, I want task content excluded from ordinary logs, Redis debug artifacts where possible, and UI audit summaries, so that portable mode does not create unnecessary plaintext copies.
25. As a security reviewer, I want only official Codex clients with recognizable V2 collaboration tools to trigger the codec, so that unrelated Responses traffic is not rewritten.
26. As a developer, I want request preparation and response restoration owned by one codec interface, so that HTTP, SSE and WebSocket cannot drift into separate implementations.
27. As a developer, I want the codec to return explicit transformation metadata, so that response restoration does not infer behavior from tool names alone.
28. As a developer, I want transformations to be idempotent, so that retries and layered proxy paths cannot repeatedly rewrite the same payload.
29. As a developer, I want top-level tools and `additional_tools` to behave identically, so that Codex protocol placement does not change compatibility.
30. As a developer, I want native, portable and disabled fixtures for each collaboration action, so that future Codex protocol changes fail visibly in CI.
31. As a developer, I want a mock-upstream end-to-end test at the `/v1/responses` boundary, so that the feature is tested through the real proxy pipeline rather than only through helper functions.
32. As a release owner, I want the feature delivered in small independent commits, so that database/configuration, codec, transports and observability can be reviewed or reverted separately.
33. As a release owner, I want an explicit rollback that only disables the feature flag or changes a Provider mode, so that rollback does not require a database downgrade.
34. As a support engineer, I want errors to distinguish unsupported Provider capability, opaque content, name collision and response-restore failure, so that remediation is actionable.
35. As a support engineer, I want documentation to state that portable compatibility does not guarantee model quality or tool-calling reliability, so that protocol support is not confused with model capability.

## Implementation Decisions

### 领域术语与状态模型

- 将这项能力命名为 **Codex MultiAgentV2 portable compatibility**，核心边界命名为 **portable compatibility codec**。
- Provider 的兼容模式只有三种：`native`、`portable`、`disabled`。
  - `native` 表示上游原生理解 Codex collaboration dialect，CCH 不改写请求或响应。
  - `portable` 表示上游只理解 portable Responses dialect，CCH 可在满足全部门禁条件时执行受控转换。
  - `disabled` 表示该 Provider 不允许承载 MultiAgentV2 collaboration 请求。
- codec 每次转换都生成 **transformation metadata**。它保存命中的协议形态、工具名反向映射、执行过的转换和恢复状态，但不保存任务正文。
- 一次根 Agent 或子 Agent 调用称为一个逻辑请求。HTTP/SSE 的 metadata 绑定到该请求；复用连接的 WebSocket 按 response/turn 标识分别绑定，不能挂在连接级全局变量上。

### 配置与持久化

- 增加系统级总开关 `enableCodexMultiAgentV2Compatibility`，默认关闭。Provider 的 `portable` 配置只有在总开关开启时才生效。
- 增加 Provider 级 `codexMultiAgentV2Mode`，取值为 `native | portable | disabled`，默认 `native`，保证升级后行为不变。
- 首版以 Provider 为最小能力单元，不按模型名、Base URL 片段或错误响应自动猜测。一个配置项若实际代理了能力不同的多个端点，管理员需要拆成多个 Provider。
- 配置必须进入现有 Provider 创建、编辑、读取、复制、批量操作、导入导出和运行时对象，避免 UI 已保存但代理层读不到，或复制 Provider 后丢失安全语义。
- 数据库变更使用仓库既有的 schema 与迁移生成流程，不手写迁移历史。
- 管理界面必须解释三种模式，并在选择 `portable` 时明确提示：委派任务会以明文经过 CCH 和第三方 Provider。
- 新增或修改的用户可见文本必须覆盖仓库支持的五种语言。

### 门禁与请求转换

- codec 只在以下条件同时满足时运行：系统总开关开启、最终 Provider 模式为 `portable`、请求可确认为官方 Codex 客户端的 Responses 请求、并且请求包含受支持的 V2 collaboration 工具结构。
- 官方客户端识别必须组合现有客户端识别结果、Responses 路由和工具 schema 特征，不能仅凭 `spawn_agent` 等名字触发，以免改写普通业务工具。
- 门禁在最终 Provider 选择完成后执行。codec 必须处理实际将要发送给该 Provider 的请求体，并先于 HTTP、SSE 或 WebSocket 的最终序列化。
- 同一 codec 同时遍历顶层 `tools` 与输入项中的 `additional_tools`，两种放置方式使用相同规则。
- 只有 `spawn_agent`、`send_message`、`followup_task` 三个 collaboration 工具的 `message` 参数允许移除 `encrypted` 标记。其他 schema 字段、工具参数和消息正文不得顺带改写。
- collaboration namespace 使用确定性的保留前缀编码成 portable 工具名，并在转换前检查与客户端工具、Provider 工具的名称碰撞。检测到碰撞时直接返回本地兼容错误。
- 输入消息转换只接受已确认的 portable 流程：把 `agent_message` 转为标准 `message`、把角色转为 `user`，并将其中可读的 `encrypted_content` 包装字段改为 `input_text`。此操作是协议重标记，不是密码学解密。
- 如果内容仍是不可读密文、结构不完整或 provenance 无法确认，codec 必须拒绝请求。不得把疑似密文当作明文发送，也不得静默回退到 MultiAgentV1 或其他 Provider。
- 转换必须可重复调用而不产生二次前缀、重复消息包装或额外字段删除。

### 响应恢复与传输一致性

- 响应恢复只能使用该请求产生的 transformation metadata，不能根据返回名称临时猜测是否需要恢复。
- 恢复器需要识别 Provider 常见的三类回显：保留 namespace 的结构化名称、点号扁平名称、双下划线扁平名称；若 Provider 省略 namespace，也只能在反向映射唯一时恢复。
- 非流式 JSON、SSE 和 Responses WebSocket 必须复用同一名称恢复逻辑。SSE 与 WebSocket 需要覆盖 function-call output item 的新增、增量和完成事件，而不只修改最终聚合响应。
- 恢复仅改变 codec 自己编码过的 collaboration 工具标识及必要的消息包装，不改写工具调用参数内容、普通业务工具或模型输出文本。
- 任何无法唯一恢复的名称、缺失的映射或不一致的响应结构都要产生明确错误，并把恢复失败写入不含正文的审计字段。
- portable MultiAgentV2 首版绕过 fake streaming。只有 fake-stream emitter 能通过同一事件矩阵测试后，才可另行开启。
- remote compaction 的触发条件、轮次和摘要语义保持不变。若压缩后的请求最终发往 portable Provider，仍在最终上游发送前经过同一 codec；该交互必须由回归测试锁定。

### 会话、审计与安全

- 请求级 metadata 由现有代理会话状态承载；WebSocket 连接复用时必须以 response/turn 为键隔离，避免并发响应串用映射。
- usage log 的 special settings 记录：功能模式、Provider、请求模型、实际模型、执行过的转换、响应恢复结果和错误类别。不得记录任务正文、工具参数正文或 `encrypted_content` 内容。
- 常规日志、错误日志和调试日志只能输出结构摘要、字段路径、哈希或长度等非内容信息。任何已有的完整请求转储能力都必须继续受其原有显式开关控制，并在 portable 模式说明明文风险。
- 错误类型至少区分：全局功能未启用、Provider 禁用、客户端或协议不匹配、opaque content、名称碰撞、响应恢复失败。
- 所有错误都保留请求/会话关联标识，方便排查，但不包含委派文本。
- 首次发布保持总开关关闭；启用和回滚只需修改功能开关或 Provider 模式，不依赖数据库回退。

### 交付拆分

1. 配置、数据库、管理 API、管理 UI 与五语文案。
2. 无传输依赖的 request/input codec、transformation metadata 和 fixture tests。
3. 非流式与 SSE 响应恢复、审计和错误模型。
4. WebSocket response/turn 隔离与事件恢复。
5. 代理边界 E2E、真实 Provider 验证、运维文档与发布说明。

每一阶段应保持可独立评审和回滚；在对应阶段的测试通过前，不把后续传输路径标记为受支持。

## Testing Decisions

### 主要测试缝

主要验收缝选择现有 `/v1/responses` 代理边界，并使用可检查收发 payload 的 mock upstream。这个层级能够一次覆盖客户端识别、Provider 选择、请求改写、上游转发、响应恢复和返回 Codex 的最终结构，是最接近用户行为、同时又能稳定自动化的现有缝。

HTTP 非流式、SSE 和 WebSocket 各保留一组高层协议测试，但三者不重复穷举所有字段组合。所有转换组合集中在无传输依赖的 codec fixture tests 中验证，从而让高层测试证明接线正确、低层测试证明矩阵完整。

### 自动化覆盖

- Provider 配置测试覆盖默认值、三种模式、系统总开关、创建/编辑/读取/复制/批量操作/导入导出，以及 UI 表单与五语文案键。
- native 模式建立“不转换”回归样例，确认 collaboration 请求和响应在语义上保持原样，尤其不得移除 `encrypted`。
- disabled 模式确认 V2 collaboration 请求在本地失败，并返回可诊断且不含正文的错误。
- portable request fixtures 覆盖三个工具、顶层 `tools`、`additional_tools`、存在/不存在 namespace、重复执行和非 collaboration 同名业务工具。
- input fixtures 覆盖合法明文包装、真实 opaque 内容、缺字段、错误角色、混合内容项和已转换输入。
- response fixtures 覆盖结构化 namespace、点号扁平名、双下划线扁平名、省略 namespace、普通工具同名、未知名称、缺失映射和重复恢复。
- 非流式高层测试校验实际发给 mock upstream 的 portable payload，以及返回客户端的原始 Codex collaboration 工具名。
- SSE 高层测试校验 function-call item 的开始、参数增量、完成与最终响应事件使用一致映射，且普通文本 delta 不被修改。
- WebSocket 高层测试校验同一连接上的连续 turn、并发 response 标识隔离、错误后下一 turn 可继续，以及映射不会跨 response 泄漏。
- fake streaming 测试确认命中 portable V2 时绕过合成流，其他既有请求的 eligibility 不变。
- remote compaction 回归测试确认 codec 不改变压缩触发、摘要内容和 usage 计算，并确认压缩后的最终请求仍正确转换。
- 可观测性测试确认 special settings 包含模式与结果，但任务文本、工具正文和 `encrypted_content` 不出现在普通日志或审计对象中。
- 故障测试覆盖保留名称碰撞、opaque content、恢复歧义和 Provider 返回畸形事件；所有情况都必须 fail closed，不能更换 Provider 或协议版本继续执行。
- 新增模块的单元测试覆盖率不得低于仓库规定的 80%。

### 真实链路验收

在自动化测试通过后，使用一个 native OpenAI 根 Agent 和至少一个明确配置为 portable 的第三方子 Agent 做人工验收：

1. 分别以 DeepSeek 和 GLM 类 Provider 执行 `spawn_agent`。
2. 覆盖不继承历史、继承最近若干轮和继承完整已完成历史三种上下文模式。
3. 对运行中的子 Agent 执行 `send_message`，对子 Agent 完成后执行 `followup_task`。
4. 验证父 Agent 能收到结果，子 Agent 看得到明文任务，Codex 能识别恢复后的工具调用。
5. 分别验证 HTTP/SSE 与 Responses WebSocket；若某 Provider 不支持某传输，应显示为 Provider 能力限制，而不是静默切换。
6. 验证取消、超时、Provider 错误和重试不会把任务或映射投递到其他逻辑线程。
7. 检查 usage log 与普通日志，确认存在审计摘要且不存在委派正文。

提交前执行仓库既有的格式化、lint、类型检查、单元测试和相关 E2E 命令；任何真实 Provider 测试凭证只通过现有 secrets 机制注入，不进入 fixture、日志或提交记录。

## Out of Scope

- 实现 CCH 自己的 Agent 树、调度器、邮箱、等待状态或跨任务持久化系统。
- 解密由 OpenAI 或其他系统产生的真正密文；本功能只在上游生成前关闭指定字段的加密请求，并转换已可读内容的协议包装。
- 自动降级到 MultiAgentV1、自动更换 Provider，或在兼容失败时重试到未获授权的端点。
- 根据模型名、厂商名或一次探测错误自动启用 portable 模式。
- 保证第三方模型的推理质量、工具调用遵循度、上下文长度或并发可靠性。
- 提供 Agent 树可视化、实时子 Agent 控制台或新的任务管理 UI。
- 针对单个模型编写 prompt 补丁、工具说明改写或供应商专属业务逻辑。
- 首版为 portable MultiAgentV2 启用 fake streaming。
- 改写 remote compaction 的产品语义或顺带处理上游已报告的内存问题；如回归测试发现真实耦合，应另开问题处理。
- 实现 hosted Responses API 的其他多代理扩展字段，除非它们是 Codex collaboration codec 的必要协议组成。

## Further Notes

- CLIProxyAPI 已提供可验证的先例：其 `codex.optimize-multi-agent-v2` 通过关闭指定 collaboration 参数的加密请求、转换 portable 输入包装并恢复工具名，使第三方 Provider 能参与 Codex MultiAgentV2。CCH 应复用协议思路，不照搬其配置结构或把转换扩散到所有 Provider。
- 参考配置：<https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml>
- 参考实现：<https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go>
- 相关背景、上游行为和 CCH 现状记录在同仓库的 Agent V2 研究报告中。
- portable 模式的核心安全变化是任务内容对 CCH 和第三方 Provider 可见。产品文案、运维文档和发布说明必须使用一致表述，不能称为“解密”。
- 若未来 Codex 改变 collaboration schema，fixture 应先失败，再以新增明确版本分支适配；不要通过宽松递归改写未知字段追赶协议。
- 规格发布后只添加 `ready-for-agent` 标签，不混入其他流程标签。当前 fork 必须先具备可用的 Issues 和该标签，才能完成发布步骤。
