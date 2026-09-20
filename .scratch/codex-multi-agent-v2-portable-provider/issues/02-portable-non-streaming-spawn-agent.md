# 02 — 打通 portable Provider 的非流式 spawn_agent

**What to build:** 让使用官方 Codex 客户端的用户能够通过明确配置为 `portable` 的 Provider，以非流式 Responses 请求成功创建一个第三方子 Agent。任务以第三方能够理解的标准输入抵达上游，返回的工具调用在交给 Codex 前恢复为原始 collaboration 契约。

**Blocked by:** 01 — 增加 Provider 兼容模式与安全门禁

**Status:** ready-for-agent

- [ ] 建立唯一的 portable compatibility codec 接口，一次调用同时返回转换后的请求和本请求专属的 transformation metadata。
- [ ] codec 在最终 Provider 选择后、非流式上游请求序列化前运行，不影响未命中门禁的请求。
- [ ] 对 `spawn_agent` 的 `message` 参数只移除 schema 中的 `encrypted` 标记，其他参数约束、工具定义和业务工具保持原状。
- [ ] 将 collaboration namespace 编码为 portable Provider 可接受的确定性工具名，并在 transformation metadata 中保存唯一反向映射。
- [ ] 将已确认属于 portable 流程的 `agent_message` 转换为标准 `message`、`role: user` 和 `input_text`，不声称或尝试解密真正密文。
- [ ] 遇到不可读 opaque 内容、结构不完整或来源无法确认的输入时 fail closed，不访问上游、不切换 Provider、也不降级协议版本。
- [ ] 非流式响应只使用该请求的 transformation metadata 恢复原始 collaboration namespace 和工具名，不根据响应名称临时猜测。
- [ ] codec 重复执行不会产生二次前缀、重复包装或额外字段删除。
- [ ] 代理边界的 mock-upstream 测试证明 portable payload 确实到达上游，并且返回 Codex 的响应包含可识别的原始 `spawn_agent` 工具契约。
- [ ] 对照测试证明同一 fixture 在 `native` 模式下保持原始加密标记和消息包装。
- [ ] 普通日志、错误日志和基础审计中不出现委派任务正文或 `encrypted_content` 内容。
- [ ] codec 的新增模块达到仓库规定的最低单元测试覆盖率。
