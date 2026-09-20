# 08 — 完成真实 Provider 验收与运维文档

**What to build:** 用真实第三方 Provider 证明 portable MultiAgentV2 能完成完整子 Agent 生命周期，并为管理员提供启用、安全评估、故障诊断和快速回滚说明，使功能具备可发布、可运营的完成标准。

**Blocked by:** 06 — 补齐审计、错误和明文保护；07 — 保护 fake streaming 与 remote compaction

**Status:** ready-for-agent

- [ ] 使用一个 native OpenAI 根 Agent 和至少一个 DeepSeek 类 portable Provider 完成真实链路验收。
- [ ] 使用一个 native OpenAI 根 Agent 和至少一个 GLM 类 portable Provider 完成真实链路验收。
- [ ] 两类 Provider 均验证 `spawn_agent`、运行中的 `send_message`、完成后的 `followup_task` 以及父 Agent 接收结果。
- [ ] 验证不继承历史、继承最近若干轮和继承全部已完成历史三种上下文模式。
- [ ] 验证 Provider 实际支持的 HTTP/SSE 和 Responses WebSocket 传输；不支持的传输显示明确能力限制，不静默切换。
- [ ] 验证取消、超时、上游错误和重试不会将任务、结果或 transformation metadata 投递到其他逻辑线程。
- [ ] 检查真实验收产生的 usage log 与普通日志，确认审计摘要完整且不存在委派正文。
- [ ] 文档说明系统总开关、Provider 三种模式、默认关闭行为、适用条件和配置步骤。
- [ ] 文档明确 portable 模式让任务内容对 CCH 和第三方 Provider 可见，并说明这是一种协议兼容转换而非解密。
- [ ] 文档说明 opaque content、名称碰撞、恢复失败、传输能力不足等常见错误的诊断方法。
- [ ] 文档提供只关闭系统开关或切换 Provider 模式的回滚步骤，不要求数据库降级。
- [ ] 文档说明功能不保证第三方模型的推理质量、工具调用遵循度、上下文长度或并发可靠性。
- [ ] 真实 Provider 凭证仅通过现有 secrets 机制提供，不进入测试 fixture、日志、文档或提交记录。
- [ ] 发布前通过仓库规定的格式化、lint、类型检查、单元测试和相关 E2E 检查，新增功能满足覆盖率要求。
