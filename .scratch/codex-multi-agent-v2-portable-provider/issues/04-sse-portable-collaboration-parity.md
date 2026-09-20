# 04 — 实现 SSE 流式兼容

**What to build:** 让 Codex 通过 SSE 流式 Responses 调用 portable Provider 时获得与非流式路径相同的 MultiAgentV2 行为。用户可以流式创建、更新和继续第三方子 Agent，Codex 最终看到的仍是原始 collaboration 工具契约。

**Blocked by:** 03 — 覆盖完整 collaboration 动作与输入形态

**Status:** ready-for-agent

- [ ] SSE 请求复用已经验证的 request/input codec，不复制一套仅供流式路径使用的转换规则。
- [ ] transformation metadata 与当前逻辑请求绑定，并持续到流式响应完成、失败或取消后再释放。
- [ ] function-call output item 的新增、参数增量、完成和最终响应事件均使用同一反向映射恢复工具标识。
- [ ] Provider 返回的结构化 namespace、点号扁平名、双下划线扁平名和可唯一恢复的无 namespace 名称在 SSE 中与非流式行为一致。
- [ ] 普通文本 delta、reasoning 内容、usage 数据、工具参数正文和非 collaboration 工具事件不被恢复器修改。
- [ ] 流中出现未知名称、缺失映射、畸形事件或不一致的工具身份时，连接以可诊断错误结束，不继续输出可能被 Codex 误解的事件。
- [ ] 客户端取消或上游中断后清理本请求 metadata，不影响后续请求。
- [ ] mock-upstream SSE 测试分别覆盖 `spawn_agent`、`send_message` 和 `followup_task` 的关键事件序列。
- [ ] 高层测试检查实际发送到上游的 portable 请求以及返回 Codex 的恢复后事件，而不只测试聚合后的最终对象。
- [ ] 对照测试证明未命中 portable 门禁的既有 SSE 请求逐事件保持原行为。
- [ ] 流式错误与诊断日志不包含任务正文或工具参数正文。
