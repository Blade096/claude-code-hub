# 03 — 覆盖完整 collaboration 动作与输入形态

**What to build:** 让 portable 子 Agent 在创建后仍能接收运行中消息和后续任务，并让 Codex 当前使用的两种工具放置方式得到一致处理。该票将非流式 codec 从单一 `spawn_agent` tracer bullet 扩展为完整的 collaboration 动作矩阵。

**Blocked by:** 02 — 打通 portable Provider 的非流式 spawn_agent

**Status:** ready-for-agent

- [ ] `spawn_agent`、`send_message`、`followup_task` 三个工具的 `message` 参数使用相同的受控去加密标记规则。
- [ ] 顶层 `tools` 和输入项中的 `additional_tools` 使用同一遍历与转换逻辑，产生一致的 transformation metadata。
- [ ] 不在允许列表中的 collaboration 工具字段、普通业务工具及其参数不会被 codec 修改。
- [ ] portable 输入转换覆盖合法的单项内容、混合内容项和已转换输入，并保持非目标内容的顺序与值。
- [ ] 工具名恢复支持 Provider 保留 namespace、点号扁平名称、双下划线扁平名称三种回显形式。
- [ ] Provider 省略 namespace 时，只有反向映射能够唯一确定原工具时才允许恢复；存在歧义必须明确失败。
- [ ] 转换前检查保留 portable 名称与客户端工具、Provider 工具的碰撞，碰撞请求不得发送到上游。
- [ ] 未知工具名、缺失映射、重复映射和畸形响应均产生可区分的兼容错误，不返回伪造的成功响应。
- [ ] 非流式 mock-upstream 测试分别证明三个 collaboration 动作能够完成请求转换和响应恢复。
- [ ] fixture tests 覆盖三种模式、三个动作、两种工具位置、各类 namespace 回显、重复转换以及错误矩阵。
- [ ] 普通业务中恰好使用 `spawn_agent` 等名称、但不满足完整 Codex V2 门禁的请求保持原样。
- [ ] 所有失败路径均不自动更换 Provider、不降级到 MultiAgentV1，也不在错误正文中泄漏委派内容。
