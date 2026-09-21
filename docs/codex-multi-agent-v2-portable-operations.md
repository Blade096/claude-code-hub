# Codex MultiAgentV2 Portable 运维与真实验收

本文面向 CCH 管理员，说明如何启用、验收、诊断和回滚 Codex MultiAgentV2 portable compatibility。该能力默认关闭，未完成真实 Provider 验收前不应在生产流量中启用。

## 1. 先理解数据边界

Portable 是协议兼容转换，不是解密。它只处理已经可读的 Codex MultiAgentV2 协作结构，把第三方 Responses Provider 无法接受的 schema 转成普通工具调用，再把响应恢复为 Codex 需要的结构。

启用 portable 后，委派任务、Agent 消息和工具调用相关正文会以明文经过 CCH，并发送给选中的第三方 Provider。管理员必须把 CCH、反向代理、第三方 Provider、日志和观测平台都纳入同一数据安全评估。不要把 portable 描述为端到端加密，也不要假设 CCH 无法读取任务正文。

默认的请求快照和普通日志会对 portable 正文做脱敏，但以下两项是现有的显式完整 payload 披露面：

- `STORE_SESSION_MESSAGES=true` 会原样保存 message 内容。仅在完成访问控制、保留期和删除流程评审后启用；不需要时保持默认的 `false`。
- 配置 `LANGFUSE_PUBLIC_KEY` 与 `LANGFUSE_SECRET_KEY` 会启用 Langfuse 追踪，实际转发的 payload 可能进入 Langfuse。应使用独立项目、最小权限、受控采样率和短保留期；不接受该风险时删除相关密钥并重启服务。

`STORE_SESSION_RESPONSE_BODY` 只控制 Redis 调试响应体是否保留，不会改变请求处理或统计读取。不要用它替代上述数据安全评审。

## 2. 开关与 Provider 模式

系统设置中的 `enableCodexMultiAgentV2Compatibility` 是总开关，默认值为 `false`。Provider 的 `codexMultiAgentV2Mode` 有三种取值：

| 模式 | 行为 | 适用条件 |
| --- | --- | --- |
| `native` | 总开关开启时，根请求会准备 collaboration 工具 schema 与命名空间，使 Codex 后续生成可读的委派消息；携带可读伪密文的 child envelope 会规范化为 `message/input_text`，真正不透明的原生密文保持原样透传 | OpenAI 原生端点，或已经完整支持 Codex MultiAgentV2 child 协议的端点 |
| `portable` | 在总开关开启且请求被可靠识别后，转换协作结构并恢复响应 | 明确支持 Responses API，但不支持 Codex opaque wrapper 的第三方端点 |
| `disabled` | 明确拒绝该 Provider 上的 MultiAgentV2 协作请求 | 未验收、数据策略不允许明文或已知不兼容的端点 |

只有 `providerType=codex` 的 Provider 能用于 Responses 路由。DeepSeek 类或 GLM 类端点也必须配置成 `codex`，不能因为厂商常见接口是 Chat Completions 就填 `openai-compatible`。能力以具体 endpoint 为单位配置，不按厂商名、模型名或 Base URL 猜测；同一个入口后面若存在不同能力，应拆成多个 Provider。

建议的启用顺序如下：

1. 新建或核对一个 `native` OpenAI 根 Provider，限制到明确的根模型。
2. 分别为 DeepSeek 类与 GLM 类 Responses endpoint 建立 `portable` Provider，配置精确模型白名单或独立分组，避免验收请求被其他 Provider 接走。
3. 保持系统总开关关闭，先完成普通 `/v1/responses` HTTP 与 SSE 连通性测试。
4. 在隔离环境开启总开关，运行本文的真实 qualification。确认机器证据、usage log 和普通日志后再逐步放量。

系统总开关关闭、Provider 为 `disabled`、客户端/协议不匹配、opaque content、名称冲突、恢复失败和传输能力不足都会 fail closed。Portable compatibility 错误不会自动切换 Provider、不会改走另一种协议、不会降级 MultiAgentV1，也不会携带任务正文重试到其他 Provider。例外仅是 OpenAI native Responses WebSocket 原本已有的 WebSocket 到 HTTP 回退，它不是 portable Provider 的兜底路径。

## 3. HTTP/SSE、fake streaming 与 compaction

Portable qualification 只覆盖 HTTP non-stream 与 HTTP 上的 SSE。GLM、DeepSeek portable Provider 不声明、不探测也不桥接 Responses WebSocket。OpenAI native Provider 的既有 Responses WebSocket 路径不属于 portable qualification，继续由独立的原生传输测试覆盖。验收记录中的 `actualTransport` 才是实际传输，不能用客户端请求的 `stream` 字段或 Provider 厂商名代替。

- Portable V2 首版始终绕过 fake streaming，直接使用真实上游流。即使模型或 Provider 分组原本命中 fake streaming，也不会进入合成 emitter。
- Remote compaction 的触发条件、轮次、摘要、usage 和缓存语义不变。内部摘要请求不经过 portable codec；压缩后的最终正常请求在发送到 portable Provider 前只转换一次。
- Fake-stream bypass 和 compaction 隔离是产品语义，不是管理员可调的性能开关。

## 4. 真实 qualification 的安全前提

真实验收使用 `tests/e2e/codex-portable-real-qualification.test.ts`。默认 Vitest/CI 会跳过它。只有设置 `CCH_PORTABLE_QUALIFICATION=1` 并提供所有必需变量时才运行；缺少任一 Provider 身份、模型、故障模型或凭证都会在发请求前失败。

凭证只能来自运行环境或既有 secrets 管理。不要把真实 key 放进 `.env.example`、测试 fixture、命令行参数、文档、Issue、CI 日志或 Git。Harness 通过 Codex `env_key` 读取代理 key，不把 key 写进临时 `config.toml` 或进程参数。

必需配置如下：

| 变量 | 说明 |
| --- | --- |
| `CCH_PORTABLE_QUALIFICATION` | 必须精确为 `1` |
| `CCH_PORTABLE_QUALIFICATION_BASE_URL` | 已部署 CCH 根 URL；禁止凭证、query 和 fragment |
| `CCH_PORTABLE_QUALIFICATION_ADMIN_TOKEN` | 只读检查 usage log 所需的管理 token |
| `CCH_PORTABLE_QUALIFICATION_PROXY_KEY` | Codex CLI 调用 CCH 的代理 key |
| `CCH_PORTABLE_QUALIFICATION_EVIDENCE_PATH` | 仓库之外的绝对 JSONL 路径 |
| `CCH_PORTABLE_QUALIFICATION_LOG_PATHS_JSON` | 可读取的普通 CCH 日志文件绝对路径 JSON 数组；用于 secret/sentinel 扫描，至少一项 |
| `CCH_PORTABLE_QUALIFICATION_CODEX_VERSION` | `codex --version` 的精确输出，避免换版本后误复用结论 |
| `CCH_PORTABLE_QUALIFICATION_CCH_COMMIT` | 当前部署的完整或可唯一定位的 CCH commit |
| `..._NATIVE_TYPE` / `..._NATIVE_MODE` | 必须分别为 `codex` / `native` |
| `..._NATIVE_PROVIDER_ID` / `..._NATIVE_PROVIDER_NAME` / `..._NATIVE_MODEL` | 根 Agent 的实际 Provider 身份与模型 |
| `..._DEEPSEEK_TYPE` / `..._DEEPSEEK_MODE` | 必须分别为 `codex` / `portable` |
| `..._DEEPSEEK_PROVIDER_ID` / `..._PROVIDER_NAME` / `..._MODEL` | DeepSeek 类 endpoint 的实际身份与成功模型 |
| `..._DEEPSEEK_UPSTREAM_ERROR_MODEL` | 运维方预置、仍路由到该 Provider 且确定返回上游错误的测试模型别名 |
| `..._GLM_TYPE` / `..._GLM_MODE` | 必须分别为 `codex` / `portable` |
| `..._GLM_PROVIDER_ID` / `..._PROVIDER_NAME` / `..._MODEL` | GLM 类 endpoint 的实际身份与成功模型 |
| `..._GLM_UPSTREAM_ERROR_MODEL` | 运维方预置、仍路由到该 Provider 且确定返回上游错误的测试模型别名 |

可选变量：`CCH_PORTABLE_QUALIFICATION_CODEX_BIN` 指定 Codex CLI；`CCH_PORTABLE_QUALIFICATION_CASE_TIMEOUT_MS` 调整单进程超时；`CCH_PORTABLE_QUALIFICATION_CANCEL_AFTER_MS` 调整观测到 `spawn_agent` 事件后再主动取消的延迟。故障模型必须是隔离环境里的显式配置，不能拿不存在的随意模型代替，否则只能证明路由失败，不能证明目标 Provider 的上游错误隔离。

PowerShell 运行命令如下。示例只展示变量名，不提供或暗示任何密钥值：

```powershell
bun run test:e2e:portable-qualification
```

Harness 会执行以下真实场景：

- native OpenAI 根 Agent 分别委派 DeepSeek 类与 GLM 类 portable child。
- 每类 Provider 都完成 `spawn_agent`、运行中的 `send_message`、完成后的 `followup_task`，且父 Agent 收到两轮结果。
- 每类 Provider 都验证 `fork_turns=none`、最近一轮和 `all`，使用只存在于已完成父轮次的随机 marker 判断历史边界。
- 每类 Provider 验证 HTTP non-stream 与 SSE；不生成 portable WebSocket 用例。
- 每类 Provider 验证主动取消、目标 child idle timeout、真实上游错误，随后立即在全新逻辑线程运行成功恢复用例，检查 session/response metadata 不串线。
- 真实上游错误用例会先用配置的故障模型执行一次轻量 SSE 探针；只有同传输形态确定返回 HTTP 400，或返回包含 `response.failed` 与 `model_not_found` 的 SSE 终止错误，才启动昂贵的 Codex 生命周期。普通 HTTP 200、`response.completed`、非 SSE 响应或其他错误码都会直接失败，避免把被透明路由或正常完成的模型别名误当成有效故障注入。
- 单独运行 native root control，确认命中指定 native Provider；总开关开启时允许记录根工具 schema/命名空间准备产生的兼容审计，但不得出现 portable child 的 `agent_message_input` 转换。

Harness 不会把原始 Codex JSONL、stderr、tool arguments 或上游 body 写成长期工件。为了恢复根会话并验证三种历史模式，Codex 必须在临时 `CODEX_HOME` 中保存 session；这个临时目录可能包含 prompt 明文，套件结束后会递归删除。应让系统临时目录位于加密、访问受控的磁盘，并在进程异常退出后检查和清理 `cch-portable-qualification-*` 残留目录。

## 5. 机器证据与验收判定

每个场景写一行 JSONL。字段白名单包含 case id、记录时间、Codex 版本、CCH commit、Provider id/name、requested/actual model、实际 transport、operation、history mode、result、稳定错误码、request/session/response id、usage 摘要、audit state、restore 状态和转换名称。

证据永远不包含 URL、key、Authorization、prompt、message、tool arguments、`encrypted_content`、stdout/stderr 或原始 body。写盘前会扫描管理 token、代理 key和全部随机 sentinel；任一受保护值出现都会 fail closed。证据路径必须在仓库之外，避免误提交。证据文件仍可能含内部 Provider/模型/关联 id，应按内部运维材料管理。

通过标准：

1. 所有 success case 的 usage log 都有 `response_restored` / `restored` 审计，requested/actual Provider、模型和 transport 与配置一致。
2. 每个 child 的初始轮次和 follow-up 轮次都有独立关联 id；故障后的 recovery 不复用 fault session/response metadata。
3. usage log API 返回值中不含任一任务/history/nonce sentinel；普通服务日志也要由运维侧按同一 sentinel 复核。
4. native control 命中指定 native Provider；若产生兼容 special setting，只能反映根工具 schema/命名空间准备，不得出现 `agent_message_input` 转换或切换到 portable Provider。
5. 真实执行的 JSONL 证据与部署 commit、Codex version 对应；被跳过或缺凭证不能记为通过。

当前仓库没有随附任何真实 endpoint、Provider 数据或凭证。没有安全配置的环境时，结论必须写成“未执行，缺少真实资格环境”，不能用 mock、示例 key 或本地 transport probe 冒充真实验收。

## 6. 错误诊断

先使用客户端错误中的 `cch_session_id`，或审计里的 request/session/response id 查询 usage log；不要用正文搜索日志。关注 `codex_multi_agent_v2_portable` special setting 的 `state`、requested/actual Provider/模型、transport、`transformations`、`responseRestore` 和 `errorCategory`。

| 稳定错误码 | 常见原因 | 处理方向 |
| --- | --- | --- |
| `compatibility_feature_disabled` | 系统总开关仍关闭 | 确认数据评审和 qualification 已完成，再开启总开关 |
| `compatibility_provider_disabled` | Provider mode 为 `disabled` | 选择已验收 Provider；不要自动换 Provider |
| `compatibility_client_or_protocol_mismatch` | 非受支持 Codex/MultiAgentV2 请求或协议形状不符 | 核对 Codex 版本、Responses endpoint 和客户端标识 |
| `compatibility_opaque_content` | Portable 输入仍含 CCH 无法读取的 opaque content | 改用 `native` endpoint，或停止在该 Provider 上使用 portable |
| `compatibility_name_collision` | 请求工具名与 portable 保留名称冲突 | 检查请求工具声明；不要手工猜测或重写保留名称 |
| `compatibility_restore_failed` | 上游响应缺失映射、名称无法唯一恢复，或返回结构与本次 request/turn metadata 不一致 | 按 response id 检查 endpoint 协议实现；确认没有并发串线 |
| `compatibility_transport_unsupported` | Portable Provider 收到 WebSocket 等未支持传输 | 改用 HTTP non-stream 或 HTTP SSE；不要为 GLM、DeepSeek portable Provider 启用 WebSocket 或自动兜底 |

取消、超时和普通上游 4xx/5xx 还应核对下一条 recovery 记录。如果 recovery 的 session/response id 或 actual Provider 与 fault 记录相同，应视为 metadata 生命周期缺陷，不可继续放量。

## 7. 快速回滚

回滚不需要数据库降级，也不应自动改协议或 Provider：

1. 最快的全局止血方式是在系统设置中关闭 `enableCodexMultiAgentV2Compatibility`。已经在途的请求按现有取消/错误路径结束，新 portable 请求会 fail closed。
2. 只隔离单个 endpoint 时，把该 Provider 的 `codexMultiAgentV2Mode` 从 `portable` 改成 `disabled`。如果 endpoint 已被证明原生兼容，可经单独验收后改成 `native`；不能把 `native` 当作绕过错误的临时 fallback。
3. 清理路由缓存后运行普通 Responses smoke 和 native root control，确认非 portable 流量不受影响。
4. 保留脱敏 qualification evidence 和关联 id，撤销临时故障模型/测试分组，轮换仅用于验收的 secrets。

数据库字段和审计记录可保留。不要回滚 migration，也不要删除历史 usage log 来完成回滚。

## 8. 能力边界

Portable compatibility 只保证协议转换、响应恢复、fail-closed 和审计边界。它不保证第三方模型的推理质量、指令遵循、工具调用正确率、上下文长度、速率限制、计费一致性、并发可靠性或服务可用性。一次通过也只代表记录中的 Provider endpoint、模型、Codex 版本、CCH commit 和时间点；任一项变化后都应重新运行 qualification。
