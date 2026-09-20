# 06 — 补齐审计、错误和明文保护

**What to build:** 让运营人员能够确认哪些请求使用了 portable compatibility、为何失败以及实际路由到了哪里，同时确保因兼容模式产生的明文委派内容不会被普通日志、审计摘要或错误响应额外复制。

**Blocked by:** 04 — 实现 SSE 流式兼容；05 — 实现 WebSocket 兼容与 turn 隔离

**Status:** ready-for-agent

- [ ] usage log 的 special settings 记录 compatibility 模式、Provider、请求模型、实际模型、执行过的转换和响应恢复结果。
- [ ] 审计结果能够区分非流式、SSE 和 WebSocket，并能关联既有请求/会话标识。
- [ ] 错误至少区分：总开关未启用、Provider 禁用、客户端或协议不匹配、opaque content、名称碰撞、响应恢复失败和 Provider 传输能力不足。
- [ ] 所有兼容错误包含足够的请求或会话关联信息，但不包含委派正文、工具参数正文或 `encrypted_content` 内容。
- [ ] 普通运行日志、错误日志、UI 审计摘要和默认调试信息只记录结构、字段路径、长度、类型或不可逆摘要，不记录任务文本。
- [ ] 现有的完整 payload 调试或请求转储能力若被显式开启，继续遵守其原有权限和开关，并在 portable 配置说明中提示明文风险。
- [ ] metadata 生命周期结束后不保留任务正文副本；WebSocket 的 response/turn 清理行为也满足这一约束。
- [ ] requested Provider/model 与 actual Provider/model 不一致时，审计信息可以明确展示实际路由结果。
- [ ] 用户可见错误使用仓库的国际化机制，并覆盖五种语言。
- [ ] 自动化测试使用独特的敏感标记作为任务正文，确认该标记不出现在普通日志、错误、special settings 或默认持久化调试对象中。
- [ ] HTTP 非流式、SSE 和 WebSocket 各包含至少一个成功审计测试和一个失败审计测试。
- [ ] 安全测试证明兼容失败不会触发未授权的 Provider 切换、协议降级或携带明文的自动重试。
