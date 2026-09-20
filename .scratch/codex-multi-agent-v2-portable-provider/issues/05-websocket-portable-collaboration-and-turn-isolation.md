# 05 — 实现 WebSocket 兼容与 turn 隔离

**What to build:** 让启用 Responses WebSocket 的 Codex 用户也能使用 portable 第三方子 Agent，并保证复用连接上的每个 response/turn 使用自己的转换映射，避免并发、取消或失败导致任务和工具身份串线。

**Blocked by:** 03 — 覆盖完整 collaboration 动作与输入形态

**Status:** ready-for-agent

- [ ] WebSocket 发往上游的每个 V2 请求复用同一 request/input codec，不维护独立的工具改写规则。
- [ ] 每次转换产生的 metadata 以 response/turn 标识绑定，不能只保存在连接级单例状态中。
- [ ] function-call 相关 WebSocket frame 使用与非流式、SSE 相同的名称恢复器，覆盖创建、增量、完成和最终结果。
- [ ] 同一连接上的连续 turn 不会复用上一 turn 的反向映射。
- [ ] 同一连接上存在交错或并发 response 时，各自的 collaboration 工具名、错误和结果不会互相污染。
- [ ] response 完成、客户端取消、上游关闭、协议错误和超时都会清理相应 metadata，同时保留仍在运行的其他 response 状态。
- [ ] 某个 response 恢复失败时只终止或标记该逻辑 response，不把错误映射应用到后续 turn。
- [ ] portable Provider 不支持 WebSocket 时返回明确的 Provider 能力错误，不静默切换传输或 Provider。
- [ ] WebSocket E2E 测试覆盖单 turn、连续 turn、交错 response、取消后继续以及错误后继续。
- [ ] E2E 测试同时检查上游收到的 portable payload 和 Codex 收到的恢复后 frame。
- [ ] `native`、`disabled` 和普通非 Codex WebSocket 请求保持各自既有行为。
- [ ] 测试证明连接释放后不存在遗留的 transformation metadata 或任务正文引用。
