# 01 — 增加 Provider 兼容模式与安全门禁

**What to build:** 让管理员能够显式控制哪些 Provider 可以承载 Codex MultiAgentV2 portable 请求，同时保证升级后原生 OpenAI 路径和普通 Responses 请求保持原状。该票交付从持久化、管理接口、管理界面到代理入口门禁的完整配置链路，但不执行 portable payload 转换。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] 增加默认关闭的系统级 MultiAgentV2 compatibility 总开关，现有安装升级后不会自动启用兼容行为。
- [ ] Provider 可以配置 `native`、`portable` 或 `disabled` 三种模式，既有 Provider 的默认模式为 `native`。
- [ ] 数据库变更通过仓库规定的迁移生成流程产生，升级与回滚配置均不依赖手写迁移历史。
- [ ] Provider 模式贯通创建、编辑、读取、复制、批量操作、导入导出和运行时 Provider 对象，不会在任一管理路径丢失。
- [ ] 管理界面可以修改系统总开关和 Provider 模式，并在选择 `portable` 时明确提示委派任务将以明文经过 CCH 与第三方 Provider。
- [ ] 新增用户可见文案覆盖仓库支持的五种语言，并通过现有翻译键完整性检查。
- [ ] 兼容门禁只在最终 Provider 已选定后判断，并组合官方 Codex 客户端识别、Responses 路由和 V2 collaboration 工具结构；不能仅凭工具名称触发。
- [ ] `native` 模式不修改请求；`disabled` 模式收到已确认的 V2 collaboration 请求时在本地返回明确错误且不访问上游。
- [ ] Provider 配置为 `portable` 但系统总开关关闭时，在本地返回“功能未启用”错误，不把请求当作 native 请求透明转发。
- [ ] 非 Codex 请求、非 Responses 请求和普通业务同名工具请求不受新门禁影响。
- [ ] 配置、门禁和默认行为具有单元或集成测试，新增代码满足仓库规定的覆盖率要求。
