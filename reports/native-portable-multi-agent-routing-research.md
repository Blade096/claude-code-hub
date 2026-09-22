# Codex MultiAgentV2 原生与 portable 确定性分流研究

研究日期：2026-09-22。范围：只读源码、公开协议与本机版本检查。本文未修改配置、业务代码、数据库、凭证、生产服务或容器，未发起真实模型验收。

## 结论摘要

**同一根会话混用存在可实现的方案，但不能靠当前“所有根工具去掉 encrypted，子请求再按 provider 判断”的设计实现。推荐验证“公共 portable 工具 + 精确模型枚举 + Codex 已有明文标记”，保留 GPT→GPT 的原始加密路径。**

1. 找到此前容易漏掉的现有能力：Codex 对 `collaboration.spawn_agent/send_message/followup_task` 的响应，只有在 `encrypted_function_args` **显式为 `[]`** 时按明文交付；缺省和非空值走原有密文路径。它会生成真正的 `agent_message.content[].input_text`，无需把明文装进 `encrypted_content`。[C1][C2][C3]
2. 该能力由 `03edf16f0bce2c454fc9a8ddb382e9c23c114f7f`（2026-07-28，PR #35845）引入；逐个稳定 tag 核对，`0.146.1` 尚无，`0.147.0` 已有。现场外部 CLI 为 `0.155.0`，Desktop 包为 `26.915.3509.0`、运行内核为 `0.155.0-alpha.9`；对应源码均支持。**版本支持已核对，现场行为尚未执行验收。**[C4][C5][C6]
3. 仅暴露两套自由填写 `model/agent_type` 的工具，再用描述要求模型选对，仍不满足确定性要求。应把工具身份绑定到明确的目标配置，并在代码中验证；模型只选择任务目标，加密模式由目标映射决定。native 工具保留 `message.encrypted=true`；portable 工具没有该标记，响应恢复原工具名并附加 `encrypted_function_args: []`。错误目标组合直接拒绝，不能静默换模型或改加密模式。此为设计推断，尚需原型验收。
4. CCH 必须同时修正输入编解码：当前 portable 分支要求找到 `encrypted_content`，因此**会拒绝上述新客户端产生的全 `input_text` agent_message**。最小边界在现有 gate、序列化前 request codec、共享 response codec，以及新增的会话级工具调用/目标关联记录。[L1][L2][L3]
5. CPA 当前 main 不是完整参照答案。它全局移除根工具的 `message.encrypted`，而 native Codex executor 也会把真正的 `encrypted_content` 字符串直接改为 `input_text`。`is-compat=false` 只保留外层 `agent_message`，不等于保留密文。现有测试明确测试这种转换，不能证明 GPT→GPT 原生加密安全。[P1][P2][P3]
6. 公开 Responses schema 没有提供可验证的通用 decrypt/encrypt/re-envelope API。不能把“再请求一次 GPT 抄出明文”、普通 Base64 解码或代理自行包装字符串当作确定性解密。已加密后再知道目标的单一共享工具方案，仍缺少必要信息。[O1][O2][O3]

建议分阶段：先把 native 字段不变作为不可破坏约束；再用现有 CLI/Desktop 做隔离的“公共 portable 工具 + 精确模型枚举 + 明文标记”实验，覆盖同一根会话中的 GPT、DeepSeek、GLM 及三种消息动作；验证通过后再做完整状态、重放和传输支持。双根模式可以作为明确选择的独立产品模式，但它不满足“同根混用”，不能悄悄替代目标。

## 1. 证据范围与版本

| 对象 | 固定版本或现场状态 | 使用范围 |
| --- | --- | --- |
| openai/codex main | `f07aaf920b14d7a746e435add34b8bbd37da5da6`，2026-09-21 | 当前协议、工具 schema、派发、metadata |
| openai/openai-python main | `febbcdfe39f6887caeb4c3c18e5aabb4404ef59b`，2026-09-21 | 由官方 OpenAPI 生成的公开 Responses 类型与端点 |
| router-for-me/CLIProxyAPI main | `ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063`，2026-09-21 | 当前优化器、executor、配置与测试 |
| CCH 本地 HEAD | `64f099a38bff8fbd1a9cb5e12417c05c7ae32393` | 业务源码；本报告 `[L*]` 引用对应工作区具体行 |
| CCH 工作区 | 研究开始时已有文档和测试未提交改动 | e2e 结论以读到的工作区文件为准，不把未提交测试说成 HEAD 内容 |

官方文档网页 `developers.openai.com/api/docs/guides/{reasoning,function-calling,conversation-state}` 及 platform 同类页面本次读取返回 HTTP 403，网页搜索工具也返回上游 503。公开 API 部分改以 **OpenAI 自己维护、注明从 OpenAPI 生成的 SDK schema** 核对，未使用二手博客。关于“不存在公开解密 API”的准确表述是“在已核对的公开 schema、Responses 资源方法和 Codex 实现中未找到”，不推断 OpenAI 内部没有这种能力。[O1][O2][O3]

任务背景给出的生产现象为：全局去密方案出现 `Encrypted function output content could not be decrypted or decoded`，回滚基线后 GPT→GPT 成功。本文将其作为用户提供的现场事实；本轮没有连接生产复现或重新检查该日志。

## 2. 时序与 Codex 实际协议

### 2.1 根请求确实早于目标选择

`multi_agents_spec.rs` 为 spawn 的 `message` 加 `.with_encrypted()`，send/followup 同样如此；`model`、`agent_type` 是稍后由模型填写的独立字符串参数。可用模型和 agent role 的信息主要进入 description，并不是“本次调用已选择的目标”结构化字段。[C7][C16][C17]

客户端收到工具调用后，`spawn.rs:125-149` 才解析 `SpawnAgentArgs`，读取 `agent_type/model/fork_turns` 并调用 `prepare_agent_spawn_config`；随后创建通信对象并启动子线程。`child_config.rs:62-84` 先应用请求中的模型覆盖，再应用角色配置和运行约束，因此**仅看根响应中的 `model` 也不能代替最终生效配置**。[C8][C9]

时序如下。T1 已经必须决定是否加密，T2 才出现目标参数，T3 才确定子线程实际生效配置。

```text
T0 CCH 收到根请求：根模型、工具集合、当前线程 metadata
T1 CCH → GPT：提交已经确定的工具 schema
T2 GPT → CCH：function_call，包含工具身份、model/agent_type、message
T3 Codex：解析参数、套用角色配置、创建子线程
T4 子线程 → CCH：实际子模型、线程关系、agent_message
```

**推断：**如果 T1 只有一个对所有目标共用的 `message` schema，又没有第二个明文通道，那么 T2/T4 的目标信息无法倒流改变已生成的密文。任何解法都必须在 T1 提供多个可区分的生成通道，或在 T1 前完成目标选择，或扩展上游协议。

### 2.2 现成的明文标记是关键新证据

`ToolCall::direct_source()` 同时检查以下条件：[C1]

- namespace 为 `collaboration`；
- 工具名为 `spawn_agent`、`send_message` 或 `followup_task`；
- `encrypted_function_args` 存在且数组为空。

满足后派发来源为 `DirectPlaintextMessage`，handler 选择 `AgentMessage::Plaintext`；其他情况选择 `AgentMessage::Encrypted`。区别是结构化标志，不检查 message 是自然语言、Base64 还是某种前缀。[C1][C2]

明文分支通过 `InterAgentCommunication::new` 交付；`to_model_input_item()` 产生全 `input_text` 的 `agent_message`。密文分支用 `new_encrypted` 原样保存字符串，再产生包含 `encrypted_content` 的 `agent_message`。本地没有解密步骤。[C3][C10]

```json
{
  "type": "function_call",
  "namespace": "collaboration",
  "name": "spawn_agent",
  "call_id": "call_example",
  "arguments": "{\"task_name\":\"worker\",\"message\":\"明确的明文任务\",\"agent_type\":\"configured_portable_role\",\"fork_turns\":\"none\"}",
  "encrypted_function_args": []
}
```

以上只是协议形状说明，`configured_portable_role` 必须是实际登记的角色。空数组是 **function_call item 的字段**，不在 `arguments` 内；`null`、省略字段或只删 schema 都不等价。这个标记只能用于确认来自 portable 明文工具的调用，不能给现有 opaque 参数强行补 `[]`。[C1][C8]

上游已有 `multi_agent_v2_spawn_sends_agent_message_to_child` 集成测试，分别构造明文/密文响应，验证子请求 content 类型和明文标记的重放，并测试明文日志脱敏。它证明客户端行为，未证明 CCH 的双工具分流已经实现。[C11]

版本证据有一个容易误判的细节：引入 commit 日期早于 0.146.0 发布日期，但 release 分支不是简单的 main 时间截面；实际读取 `rust-v0.146.0`、`0.146.1` 的 router 都没有该分支，`rust-v0.147.0` 才有。0.147.0 发布于 2026-08-07。[C4][C5]

本机只读查询结果如下，未改变正在运行的进程。

| 表面 | 检查方式 | 结果与限度 |
| --- | --- | --- |
| CLI | `codex --version` | `codex-cli 0.155.0`；同 tag router 有明文支持 |
| Desktop 包 | Windows Appx 包查询 | `OpenAI.Codex 26.915.3509.0` |
| Desktop 实际运行内核 | 读取进程路径后，对对应 exe 执行 `--version` | `C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\cdef5aaf3e41ab53\codex.exe`，`0.155.0-alpha.9`；同 tag router 有明文支持 |

版本及同 tag 源码检查意味着具备采用条件，不能代替二进制行为验收或证明某次响应已携带 `[]`。这项标记也不是稳定公开 Responses API 对所有客户端的承诺。[C6][O1]

### 2.3 Header、client_metadata 与 agent 配置能提供什么

当前 `CodexResponsesMetadata` 有 thread/session、agent_name、parent/root turn、subagent_kind 等字段；`x-openai-subagent=collab_spawn` 描述**当前发送请求的线程来源**，不是根 GPT 下一次将选择的子模型。HTTP compatibility headers 和 body `client_metadata` 都没有自动公布未来调用目标或完整角色解析表。[C12]

Codex model provider 配置允许 `http_headers/env_http_headers`。因此用户可预先选择一个 root routing profile，通过明确 header 传入 CCH，无需修改客户端源码。但该静态 header 只能传“允许的目标集合/模式”，不能预知每次工具调用选择。[C13]

app-server 的实验参数 `responsesapi_client_metadata` 允许调用方提交额外键值；当前实现把它们放入 `x-codex-turn-metadata` 的结构化内容，**并非任意顶层 client_metadata 键**，且限制键数、长度和保留键。自有 app-server 调用方可传 routing profile ID；这需要调用方配合，不能声称现成 Desktop UI 已会自动传角色映射。[C14][C12]

另一个重放约束：Codex 对非 OpenAI provider 发送历史时会清除 `encrypted_function_args`。所以 CCH 不能只靠“下轮请求里仍能看到空数组”来恢复 portable 工具身份；需要自己保存按 thread/call_id 关联的映射。[C15]

## 3. 公开 Responses 能力边界

公开 `FunctionToolParam` 的 parameters 是通用 JSON schema 字典；公开 `ResponseFunctionToolCall` 描述 arguments、call_id、name、namespace 等字段，并未给 `encrypted_function_args` 提供通用公开契约。已核对的公开 input item 联合类型没有 `agent_message`。因此 Codex 的这些能力必须按特定客户端/后端扩展对待，不能从“兼容 Responses”推出兼容 Codex 私有 item。[O1][O4][O5]

公开 `reasoning.encrypted_content` 的用途是把推理状态带入后续请求；官方 schema 要求流式使用完成 item 的值，added 事件中的值可能不完整。这与 collaboration message 的加密参数、agent_message 的密文 part、compaction 的 encrypted_content 是不同语境，不可以相互替换。[O2][C10]

公开 SDK 的 Responses 资源有 create/retrieve/delete/cancel/compact 和 input_items/input_tokens 等方法；已核对的 API 面没有把任意 Codex opaque payload 解密成文本、按目标重加密或签发兼容密文的方法。[O3]

**结论边界：**不能证明代理可本地解密或生成 OpenAI 认可的密文；也没有证据证明把密文交给一次普通 Responses 请求就能得到逐字、可验证的原文。后者即使在某个账号/模型上返回了文字，也属于新一轮模型生成，增加费用、延迟和任务偏差，且无法自动证明与原文完全一致。

## 4. CPA 当前 main 的实际作用与风险

`PrepareCodexMultiAgentV2Tools` 位于 Responses 入口，刷新工具描述并删除 collaboration message 的 encrypted 属性；入口在 HTTP/SSE 分发前调用它，测试也覆盖 WebSocket。该阶段不按本次未来目标模型分流。[P1][P4]

`OptimizeCodexMultiAgentV2Request` 的第一步是 `rewriteCodexAgentMessageContent`。后者对每个 agent_message 的 `encrypted_content` 字符串执行字段改名，成为 `input_text.text`，不验证来源、不解密、不区分真正 opaque 字符串。[P1][P7]

随后 `OptimizeCodexMultiAgentV2RequestForAuth` 检查 `CodexAPIKeyModelIsCompat`；true 再把外层 item 改为 `message`、role 改为 `user`。false 留下的是 `agent_message` 外壳。配置中“default false keeps agent_message unchanged”的注释，应结合这条调用链理解，不能解读为整个 item 字节不变。[P2][P5]

| CPA 路径 | 已核对行为 | 与本目标的关系 |
| --- | --- | --- |
| optimized 根 → 任意未来子目标 | 根 schema message 去 encrypted | GPT→GPT 原生生成已失去前提 |
| optimized native Codex executor | 内部 encrypted_content → input_text；外壳可仍为 agent_message | 可以避开某些“明文被当密文”错误，但真正密文会被当文本；不符合原生保留 |
| codex-api-key `is-compat=true` | 再转换外壳为标准 message/user | 解决部分第三方 Responses item 兼容，不解决加密路由 |
| Responses → 非 Codex/非 Responses 目标 | 翻译前转换 agent_message | 协议转换仍不等于解密 |

这意味着不能笼统断言“CPA 的每条 native 子路径都会把明文作为密文送出”：上面 native executor 的 content 改写可能已避免该具体错误形状。但同样不能声称它保护了真实 GPT 密文；对未经过 content 改写的路径，根去密、子透传的组合风险仍存在。这是按当前调用链作出的推断，不是生产复现。[P1][P2]

现有 `codex_executor_spawn_agent_test.go` 的 fixture 把 `"delegated task"` 放在 encrypted_content；启用优化后测试期待它变成 input_text。“native model keeps agent_message”检查的是外层类型，不能证明 opaque 字节保持。入口测试直接要求删除 encrypted。未在这些相关测试中发现“真实加密 GPT 根产生内容 → native GPT child 成功 + portable sibling 同会话成功”的验收。[P3][P4]

issue #4801 是第三方 Responses item 兼容问题的第一手报告，明确要求 native 保留和 opaque 不伪装明文；它不是 OpenAI 协议文档，也没有证明当前组合已安全修复。其报告版本为 CLI 0.146.0，正好早于上述明文标记支持的首个稳定版。[P6][C5]

## 5. CCH 当前边界与需要改变的内容

| 当前位置 | 已核对行为 | 所需变化方向 |
| --- | --- | --- |
| gate `isPortableCodexMultiAgentV2Request` | 总开关开启后，native 请求只要带官方 collaboration schema，也被判断为需 portable 处理 | 区分“当前 provider 能力”和“该根允许哪些委派路线”；native 默认不因含工具就改 schema |
| request codec `rewriteCollaborationTools` | 删除三个 message.encrypted，重命名整个 namespace | native 工具保留；portable 目标工具独立生成 |
| request codec `rewriteAgentMessages` | 用前缀/字符模式猜 opaque；需要至少一个可转换的 encrypted_content | 接受明确的全 input_text agent_message；portable 收到真正 encrypted_content 明确失败；取消靠自然语言/密文外观决定分流 |
| forwarder `2925-2939` | provider overrides/final filter 后、JSON 序列化前做 request preparation | 可作为最终目标能力核验和请求编码边界，不能把它当未来目标已知的边界 |
| response codec | 还原工具 identity、校验 call/item/response 关联；参数 delta 当前透传 | 增加目标绑定校验、仅 portable 的明文标记、必要的完整调用缓存和跨请求关联 |

证据见 gate、request codec、forwarder 和 response codec 的具体实现。[L1][L2][L3][L4]

native 无工具子请求在 `request-codec.ts:441-443` 提前返回；带工具请求则可能同时改 schema 和输入。当前 `preserveOpaque` 是按内容外观决定是否保留，不是 native 密文的强类型保证。用户提供的故障与“根 schema 被改、子叶 envelope 提前返回”组合相符；本轮不据此宣称已唯一确定生产每个报错请求的路径。[L2]

现有 e2e harness 很适合扩展：它用隔离 Codex home、明确 root/child model_provider、关闭客户端重试并检查 provider、model、usage 和生命周期。工作区已新增一个独立 native child lifecycle case，但 native root control 的提示词仍是 `Do not use tools`，不能当加密委派验收。还需要“同一 root 同时创建 native 和 portable 目标”的场景，及逐字段密文保留断言。[L5][L6]

## 6. 候选方案逐项评估

以下为设计评估，不表示已经实施或通过上游验收。

### A. 双根模式、显式 header 或模型别名

- **可行性与混用：**现有客户端可用 provider headers 明确选择 native-root 或 portable-root，无需修改源码；两个根分别可靠运行是可实现的。静态单根模式不能同时满足原生加密 GPT child 和 portable child。模型别名只有在明确绑定模式、且不被模型池重定向打破时才等价于 header。[C13]
- **风险/成本：**低实现成本、额外维护两个会话；根会话上下文不能自动共享。portable-root 下 GPT child 即使也被统一转成明文，仍不满足本题 GPT→GPT 加密要求。
- **CCH 改动：**入口解析明确 profile，gate 不再用当前 provider=native 推断所有未来孩子可去密；模式变更时显式处理会话连续性，不暗中切换。
- **自动验收：**两个 profile 使用同一 GPT 模型和原凭证；native profile 三种工具保持 encrypted，portable profile 使用明文标记并只接受批准的 portable 目标；缺省 profile 不改变 native 字段。
- **结论：**可作为用户明确选择的阶段性交付；不能宣称完成同根目标，也不能作为失败后的自动兜底。

### B. 同时暴露 native 和 portable 工具，响应恢复原名

**B1：两套同构工具 + 描述约定，不推荐。** 如果两套都允许随意填写同一 `model/agent_type/target`，就有四种组合，其中 native 工具→portable 目标和 portable 工具→native 目标不符合本题。描述不提供强制约束；响应阶段拒绝可防止错误发送，却不能保证任务成功。

**B2：绑定目标的 portable 工具 + 保持 native 工具，推荐做原型。**

1. 建立明确的 routing profile，例如登记 `deepseek_reader` 对应哪一个 Codex role、模型和 provider 能力。profile 通过配置文件/环境或显式 header 选定；无需新建生产数据库字段。禁止从 role 的自然语言 description 猜模型。
2. GPT 上游看到原有 native `collaboration` 工具，其 message 仍 encrypted；另有公共 portable 工具，例如 `collaboration-optimize.spawn_portable_agent`。portable 工具的 `model` 只允许当前用户可见的精确模型枚举，CCH 在恢复调用前再次校验；不允许模型覆盖到枚举之外。
3. 响应编解码器按**工具 identity**选路线，校验全部参数。portable 调用恢复为 `collaboration.spawn_agent` 并加 `encrypted_function_args: []`；native 调用的参数、密文和加密元数据原样保留。原有 native 工具若指定了 portable/未知目标，明确拒绝，不把已生成密文转走。
4. 在向客户端释放可执行调用前，记录 `{root/thread, call_id, task_path, routing_profile_version, expected_model/provider_capability, message_mode}`。spawn 成功后以实际 child request 的线程关系、author/recipient 和模型/provider 做二次核对；不匹配就拒绝。
5. send/followup 使用已登记的目标路径生成可接受目标集合，或每个目标一个 portable 函数；native 通道拒绝 portable 目标。相对路径必须按 Codex 规则规范化，不能只做字符串前缀匹配。

**确定性的准确含义：**协议层可以保证“每个被接受的工具调用，其目标和编码模式唯一且一致”。模型仍然在选择要执行哪个任务、调用哪个目标工具，不能保证它永远理解用户意图或永远选择某一个工具。如果要求“同一自然语言提示每次都必然选择预定模型”，任何允许模型自行选目标的方案都无法给出这种保证；需要调用方指定目标或二阶段目标选择。B2 消除的是模型额外决定 native/portable 编码的自由度，并非把模型采样变为确定算法。

- **可行性与混用：**现有支持 `[]` 的客户端具备关键派发能力，可在同根的不同调用上混用；代理新增目标工具和恢复 identity 是可实现的设计，但完整组合尚未实测。[C1][C3][L4]
- **协议风险：**native 工具尽量保持原名及加密字段，避免假设密文与改名无关；portable 所有 HTTP/SSE item 表示必须一致。不能在 arguments 尚未完整时就承诺目标。客户端历史保存恢复后的原名，而上游看到 portable 名，因此需要按 call_id 重写后续历史及工具结果关联；不能全局替换字符串。[C15][L4]
- **安全风险：**明文会经过根模型、CCH 和目标 provider，属于显式跨 provider 委派；日志应按明文消息脱敏。routing profile 必须限定到已授权用户/会话，不能把任意外部 header 当权限。状态丢失、配置漂移、未知目标均返回明确错误。
- **成本/兼容：**通常不增加额外模型请求；增加工具 token、路由状态和流式缓存复杂度。首版限定 direct collaboration 调用、HTTP/SSE、portable `fork_turns=none`。跨 provider fork 若包含 native reasoning/compaction/agent 密文不能转成文本，不允许静默丢历史；后续单独扩展并验收。[C10][C15]
- **CCH 改动：**新增 root profile 和目标注册表；请求侧生成 portable 工具；响应侧校验、还原、补 `[]`；输入侧支持全明文 agent_message；重放关联必须跨请求存活。当前 per-attempt metadata 不足以独立承担这些职责。[L1][L2][L4]
- **自动验收：**见第 7 节，必须包括不合法交叉目标、并发调用、历史重放、配置漂移，以及同根 native/portable 生命周期。

portable 子代理发回 GPT 根的消息也需要纳入协议：第三方模型不会生成 OpenAI 密文，它的 collaboration 调用应走明确明文标记；GPT 根可以接收 `agent_message` 的 input_text 形态。GPT→GPT 才要求保留加密；不能把“接收方是 GPT”误等同为所有来源都必须有密文。[C3][C10]

### C. 根响应回来后再按 model/agent_type 处理

- **可行性与混用：**保留原始单套 encrypted schema 时，响应后才能知道 portable 目标，已经太晚；只能把 native 密文继续原样转发或明确拒绝 portable 调用。全局生成明文再按目标补密文，也没有公开加密接口。单独采用不可行。[C7][C8][O3]
- **风险/成本：**仅做校验成本低，但会产生明确失败；靠内容猜测或再让模型抄写会破坏确定性和数据语义。
- **CCH 改动：**可增加响应期目标核验，作为 B 的拒绝错误组合机制；不可把它宣传为解密转换。
- **自动验收：**native opaque 字符串逐字段不变；同样 payload 指定 portable 目标必须在子上游发出前失败，零明文伪装、零静默换模型。

### D. agent_type 配置或 client_metadata 提前传目标

- **可行性与混用：**角色配置能预先确定“若选该 role，目标是什么”，但现有根请求只暴露描述信息，实际 role 配置仍在客户端本地，且本次 role 由响应决定。单靠 agent_type 配置不能解决时序。显式传 routing profile/结构化角色表可为 B 提供确定映射；不能靠解析 description。[C7][C8][C9][C12]
- **无需改客户端的部分：**provider `http_headers` 可传 profile ID；自有 app-server 调用方可用实验 metadata 参数。不能假设 Desktop 用户界面已经提供该入口。[C13][C14]
- **风险/成本：**结构化表与客户端 role 配置可能漂移；必须版本化并核验最终 child 的 actual model/provider。模型别名/模型池按实际能力验证，不能只检查字符串含 `gpt`。
- **CCH 改动：**读取并消费 profile 信号；不要把内部路由字段无意义地转发给上游；把 profile 与目标映射附着于会话。
- **自动验收：**传入 profile 后 root 工具集合可预测；child role 文件故意改变模型或 provider 时明确拒绝；保留键不可覆盖；未知 profile 不触发全局 portable 转换。

### E. 请 OpenAI/Responses 解密或 re-envelope 一次

- **可行性与混用：**未找到公开、可验证、可供代理调用的接口，因此不能作为可落地方案。[O1][O2][O3]
- **风险/成本：**普通额外模型调用有一次延迟/费用、结果可能改写内容、凭证及后端是否接受原密文也没有公共保证。不能用一次“看起来解出来了”的输出作为逐字解密证明。
- **CCH 改动：**现阶段无合理实现范围；不应加入密文前缀解码、模型抄写或凭证轮换。
- **自动验收：**只有上游先提供稳定契约、授权边界、错误语义以及可验证往返测试后，才可立项；目前缺少这个前置条件。

### F. 修改或扩展 Codex 客户端协议

- **可行性与混用：**可行，但“仅在 spawn 执行时检查目标 provider 并把密文标成明文”仍然无效。客户端需在建工具时暴露按目标能力拆分的工具，或先执行 `prepare_agent(target)` 再按确定目标生成 message，或公开携带版本化 role/capability manifest；随后用已存在的 Plaintext/Encrypted 类型派发。[C1][C3][C7]
- **风险/成本：**需要维护 CLI 与 Desktop 内核兼容，可能增加一次模型往返（二阶段方案），需处理目标配置更新和恢复线程。优点是最终角色解析和线程状态由客户端直接拥有，减少代理复制这些规则。
- **CCH 改动：**从猜测目标转为验证明确协议字段，并按 endpoint 能力处理标准 message；继续原样传递 native 密文。
- **自动验收：**客户端单测覆盖目标解析→schema→DirectPlaintextMessage/Encrypted 的完整链；针对两个版本的 capability handshake 验证未知版本失败，不能自动降级到全局去密。
- **结论：**长期上游方向，但当前现场客户端已有 `[]` 能力，不必为了明文 envelope 本身先 fork 客户端。

### G. 更好的组合与其他边界

**优先组合是 B2 + 已有 `encrypted_function_args: []` + D 的明确 profile。** 它把“生成加密内容还是明文”的选择提前到工具定义，把“本次到底选哪个目标”的验证放在响应期，又使用客户端已有的强类型明文路径。这是本次研究最值得先验证的路线。

如果产品要求所有调用都必须在生成 message 前由程序确定目标，采用 **二阶段目标绑定**：第一步只接受结构化目标选择，客户端/编排层解析实际配置，第二步只暴露该目标对应的 message schema。这能消除并列自由工具的错选组合，代价是新的客户端/代理编排状态和通常额外一次模型请求。代理若自行执行隐藏的准备工具，已从透明代理扩大为编排器，应单独设计和批准，不能顺手塞进兼容 codec。

另一条独立产品路线是给 GPT 保留 native collaboration，同时通过显式 MCP 工具运行 portable worker。普通工具本来可接收明文参数，但它不自动拥有 Codex 的子线程、fork、wait/send/followup 语义，不能把“根会话能调用一个外部 worker”冒充“同一原生 multi_agent_v2 树混用”。本轮不建议在没有确认产品语义的情况下切换到它。

## 7. 自动化验收设计

测试必须分别证明“编码/分流是确定的”和“真实端点能执行”，不能只看模型最后回复“完成”。下面是建议验收，不是本轮已运行的结果。

| 层次 | 必须证明的内容 | 自动失败条件 |
| --- | --- | --- |
| schema/codec 单元 | native message.encrypted 保留；portable 目标绑定；只有 portable 响应加 `[]`；接受全 input_text agent_message | native 字段被删、未知目标被猜测、密文被改标文本 |
| 确定性负例 | 同一模型/role 不能走两个冲突模式；假的 target、role+model 冲突、provider 能力漂移均拒绝 | 更换模型/凭证、重新生成任务、按自然语言尝试另一条路线 |
| 本地 Codex 协议测试 | 用固定 mock SSE 分别返回缺省、`[]`、非空标记；捕获下一次 child request | `[]` 未产生 input_text，缺省/非空未保留原始 encrypted_content |
| SSE/HTTP 编解码 | added、参数 delta/done、item.done、completed 中 identity 和标记一致；完整参数验证后才可执行 | 部分流已执行错误调用、call_id/output_index 串线 |
| 目标关联 | 多个 child 并发创建；同名 task 不同 root；相对/绝对路径；idle followup；运行中 send | 仅按模型名/任务名跨会话匹配，状态丢失时猜测 |
| 历史与恢复 | native opaque 内容保留；portable 历史工具 identity 恢复；客户端清除历史标记后仍正确关联 | 重新加载后把 portable 调用当 native 或反过来 |
| 同根真实验收 | 同一 GPT 根依次/并发创建 GPT、DeepSeek、GLM；三者收到独立随机任务标记并执行可核对结果 | 只创建 root、只检查工具成功、仅便捷的独立会话通过 |
| 原生加密证据 | 捕获 native 根响应 message 与 GPT child 的 encrypted_content，内存比较相等；根 schema encrypted=true，调用未注入明文标记 | 用“看起来像密文”的正则或一次成功回复代替协议证据 |
| portable 正向证据 | child 上游只有标准 message/input_text；任务来自指定 portable 调用；实际 model/provider 符合 profile | child 无任务、opaque 被作为正文、模型池静默改变能力 |
| 非泄漏 | 审计只记模式、目标标识、版本和错误分类 | 日志输出明文任务、完整密文、凭证或 token |

本地 CLI 行为测试应复用隔离 home 和 mock endpoint，不访问生产；Desktop 需要单独验证它实际使用的 app-server 内核以及事件流。CCH 当前 e2e harness 可以扩展相应 fixture，但本轮只读权限不允许启动会写会话文件的测试实例，因此没有执行。[L5][C11]

跨 provider `fork_turns=all` 或截取历史不是首版的隐含承诺。测试应显式构造带 native reasoning/compaction/agent 密文的历史，确认返回“此路由不支持该历史内容”的明确错误；不能删除历史后继续。WebSocket、Responses Lite、code mode 等入口应逐项建立支持证据，在未实现前明确拒绝该组合，不能偷偷改 HTTP 或移除工具。[C10][C15][L3]

## 8. 推荐的分阶段落地

### 阶段 0：恢复并固定 native 契约

将“native 根工具不去 encrypted、native 密文不改字节/字段”写入回归标准；总开关不能自动把所有 GPT 根转成 portable。此阶段只是避免破坏 native，不宣称 portable 混用已经成功。现有启用开关后的 native 去密断言需改为明确 routing profile 的行为。[L1][L2][L6]

### 阶段 1：无客户端源码修改的隔离原型

使用现场已有 CLI 0.155.0 和 Desktop 0.155.0-alpha.9；本地 routing profile 固定 GPT、DeepSeek、GLM 目标。实现 B2 所需的最小工具转换、portable `[]` 和标准输入转换，先限制 direct 调用、HTTP/SSE、portable fork none。native schema 保留，不动凭证、不改生产数据库。

先用 mock 固定函数调用内容，证明协议不依赖模型选择运气；再运行真实端点同根用例，评估模型是否能稳定选择目标工具。**前者证明安全与正确分流，后者评估任务完成率，两项必须分别报告。**

### 阶段 2：补足产品级状态与传输

建立可恢复的目标关联、profile 版本、重放映射、流式完整调用验证、取消/并发/异常处理。覆盖 GPT→GPT、GPT→portable、portable→GPT 和兄弟代理通信。扩展 fork/WS/Lite 前单独确认协议要求和验收结果。任何不支持情形均显式失败，继续保留用户指定模型与凭证。

### 阶段 3：上游协议收敛

向 Codex 上游讨论公开的目标能力 manifest、正式 message encoding 标志与按目标构建的工具。当前 `encrypted_function_args: []` 已解决一部分客户端问题，但公开 Responses schema 尚无通用契约；协议演进应减少 CCH 对私有字段和客户端角色优先级的复制。[C1][C9][O1]

**现在无需改客户端源码即可着手的范围：**明确 root profile、原生保留、portable 定向工具及 `[]`、标准明文输入转换、现有 CLI/Desktop 的隔离验收。**必须改客户端/上游或自行增加编排层的范围：**自动发布可信角色能力表、程序在 message 生成前锁定任意动态目标、统一且公开的编码协商、通用解密/re-envelope。没有必要先以“代理可以解密”作为设计前提。

### 最小实现切片与阻断性验收

第一张实现票应只覆盖一个固定 GPT root、一个原生 GPT role、一个 portable role、direct 工具、SSE/HTTP 和 portable fork none，随后用同一套协议扩展到另一个 portable provider。

1. 新增一个严格的 routing profile 解析器和会话目标关联模块；保持用户现有凭证和模型，不引入数据库迁移。gate 用明确 profile 决定是否生成 portable 工具。
2. `request-codec.ts` 保留 native 工具，增加固定 portable 目标工具；对 portable 子输入只接受明确 input_text，并转换为标准 message；encrypted part 明确拒绝。
3. `response-codec.ts` 按工具身份验证目标，portable 还原原名并补 `[]`，native 内容不变；保存跨请求 call_id/目标绑定。未知映射、冲突参数、状态丢失均终止该调用。
4. 在现有隔离 harness 增加本地 mock 协议案例，以及同根 GPT+portable 的真实生命周期案例。该切片不包含生产发布、自动重试另一种协议或更换 provider。

以下任意一项未通过，均不能把混用功能标为可部署：

- 对**现场两个实际二进制**证明：固定 mock 返回 `[]` 后子请求为全 input_text；缺省/非空仍保留 opaque。
- 同一个根会话完成原生 GPT 与 portable 的 spawn、运行中 send、完成后 followup；native 根 schema 始终保留 encrypted，native 委派密文进入对应 child 时逐字段不变。
- portable 上游收到标准明文任务，实际 model/provider 与 profile 一致；不合法交叉调用和状态丢失在子上游发送前失败。
- 第二个根 turn、并发工具调用和一次会话恢复之后，identity、call_id 与消息模式仍一致；日志无任务正文与凭证。

以上全部仍为待实现/待运行验收。本报告给出了源码证据和实现边界，没有把原型可行性等同于已通过端到端验证。

## 一手证据索引

源码链接固定到本次读取的 commit；稳定版差异使用明确 tag。CCH 链接是本机路径与行号，HEAD 与工作区状态见第 1 节。

[C1]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/router.rs#L36-L70
[C2]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_v2.rs#L54-L65
[C3]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/agent/control/delivery.rs#L21-L51
[C4]: https://github.com/openai/codex/commit/03edf16f0bce2c454fc9a8ddb382e9c23c114f7f
[C5]: https://github.com/openai/codex/releases/tag/rust-v0.147.0
[C6]: https://github.com/openai/codex/blob/rust-v0.155.0-alpha.9/codex-rs/core/src/tools/router.rs#L44-L59
[C7]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L100-L144
[C8]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs#L125-L218
[C9]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/agent/child_config.rs#L50-L108
[C10]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/protocol/src/protocol.rs#L825-L915
[C11]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/tests/suite/subagent_notifications.rs#L2200-L2427
[C12]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/responses_metadata.rs#L224-L425
[C13]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/model-provider-info/src/lib.rs#L163-L171
[C14]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L182-L191
[C15]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/client.rs#L920-L942
[C16]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L630-L664
[C17]: https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L185-L242
[O1]: https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/response_function_tool_call.py#L28-L64
[O2]: https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/response_reasoning_item.py#L31-L61
[O3]: https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/resources/responses/responses.py
[O4]: https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/response_input_item_param.py
[O5]: https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/function_tool_param.py#L19-L53
[P1]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go#L109-L149
[P2]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/internal/runtime/executor/helps/codex_multi_agent_v2.go#L140-L148
[P3]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/internal/runtime/executor/codex_executor_spawn_agent_test.go#L110-L301
[P4]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/sdk/api/handlers/openai/openai_responses_multi_agent_test.go#L23-L178
[P5]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/config.example.yaml#L519-L529
[P6]: https://github.com/router-for-me/CLIProxyAPI/issues/4801
[P7]: https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go#L783-L848
[L1]: K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/codex-multi-agent-v2-gate.ts:161
[L2]: K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/codex-portable-compatibility/request-codec.ts:205
[L3]: K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/forwarder.ts:2925
[L4]: K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/codex-portable-compatibility/response-codec.ts:109
[L5]: K:/Personal/claude-code-hub-fork/tests/e2e/_helpers/portable-qualification-invocation.ts:53
[L6]: K:/Personal/claude-code-hub-fork/tests/e2e/codex-portable-real-qualification.test.ts:282

补充定位：

- [spawn message 的 encrypted 定义](https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L630-L664)；[send/followup 定义](https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L185-L242)。
- [0.146.1 router](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/core/src/tools/router.rs)；[0.147.0 router](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/tools/router.rs)；[0.155.0 router](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/tools/router.rs#L44-L59)。
- [Codex agent_message 类型与拒绝把 encrypted part 当明文的 helper](https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/protocol/src/models.rs#L905-L924)；[function_call 的加密元数据字段](https://github.com/openai/codex/blob/f07aaf920b14d7a746e435add34b8bbd37da5da6/codex-rs/protocol/src/models.rs#L1075-L1091)。
- [公开 function tool schema](https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/function_tool_param.py#L19-L53)；[公开 input item 联合类型](https://github.com/openai/openai-python/blob/febbcdfe39f6887caeb4c3c18e5aabb4404ef59b/src/openai/types/responses/response_input_item_param.py)。
- [CPA 把 encrypted_content 直接改为 input_text 的完整函数](https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/internal/client/codex/optimize-multi-agent-v2/optimize_multi_agent_v2.go#L783-L848)；[入口预处理位置](https://github.com/router-for-me/CLIProxyAPI/blob/ffe6ad3c5fcf0a5eedd2198cd2e04b0249dc5063/sdk/api/handlers/openai/openai_responses_handlers.go#L536-L605)。
- [CCH 明文/opaque 判断及空 readableTaskParts 拒绝](K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/codex-portable-compatibility/request-codec.ts:263)；[native 子请求提前返回](K:/Personal/claude-code-hub-fork/src/app/v1/_lib/proxy/codex-portable-compatibility/request-codec.ts:441)；[e2e case 集合，含工作区新增 native child lifecycle](K:/Personal/claude-code-hub-fork/tests/e2e/_helpers/portable-qualification.ts:312)。
