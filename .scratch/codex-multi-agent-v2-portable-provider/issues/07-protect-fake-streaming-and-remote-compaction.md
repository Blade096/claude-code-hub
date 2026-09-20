# 07 — 保护 fake streaming 与 remote compaction

**What to build:** 让启用 CCH fake streaming 或 remote compaction 的部署能够安全引入 portable MultiAgentV2，而不改变既有压缩语义、usage 统计或普通请求行为。portable V2 在尚无等价事件保证时绕过 fake streaming，压缩后的最终上游请求仍经过同一 codec。

**Blocked by:** 04 — 实现 SSE 流式兼容；05 — 实现 WebSocket 兼容与 turn 隔离

**Status:** ready-for-agent

- [ ] 已确认命中 portable MultiAgentV2 的请求不进入 fake-stream 合成器，避免 function-call 和 Agent metadata 在合成事件中丢失或失真。
- [ ] 不属于 portable MultiAgentV2 的请求继续使用现有 fake-stream eligibility 与输出行为。
- [ ] 绕过 fake streaming 后仍遵守客户端请求的实际传输契约；若 Provider 不支持所需传输，返回明确错误而非伪造兼容流。
- [ ] remote compaction 的触发条件、轮次判定、摘要生成、上下文替换和 usage 计算保持原有语义。
- [ ] 压缩流程最终选择 portable Provider 时，实际发送给该 Provider 的最终请求仍在正确时点经过 codec。
- [ ] 压缩流程使用 native Provider 时，加密标记和 Codex collaboration 消息包装保持原样。
- [ ] codec 不重复转换已经处理过的压缩后请求，也不把 compaction 内部调用误识别为 collaboration 请求。
- [ ] 回归测试覆盖 portable 与 native、启用与关闭 fake streaming、触发与不触发 compaction 的关键组合。
- [ ] 高层测试确认压缩摘要内容、工具映射、最终 Codex 响应和 usage 统计都符合各自既有契约。
- [ ] 取消、上游错误和 compaction 失败不会导致 codec metadata 泄漏到重试或下一逻辑请求。
- [ ] 本票不顺带改变 compaction 算法或处理无证据关联的内存问题；发现独立缺陷时另行记录。
