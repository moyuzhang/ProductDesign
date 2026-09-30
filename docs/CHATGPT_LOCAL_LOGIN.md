# 本机 ChatGPT 登录（账户功能）

此集成仅面向用户自己运行的本机 ProductDesign，不用于托管服务或商业代登录。官方 Codex app-server 管理浏览器 / device-code OAuth、令牌存储与刷新；应用不读取或导出 auth.json / access token。

- 模型设置可显式开始登录、取消、查看状态和退出。浏览器/设备授权必须由用户在官方页面完成。当前实现没有代用户登录。
- 账户服务与未来订阅会话共用 data/codex-chatgpt 隔离目录。API Key 会话继续使用原目录。订阅进程移除 API Key 环境覆盖，不会自动改用 API 计费。
- 登录接口及订阅相关入口仅允许 loopback、匹配的浏览器 Origin 和明确本机请求头。无远程订阅入口；未通过的请求不会启动登录。
- 模型来自 account/read + model/list；目录存在不等于已验证该账户真实推理权限或剩余额度。
- 登录等待十分钟后取消；通知只保留安全状态，不回传原始错误或令牌。

## 明确限制

**ChatGPT 登录和模型目录已实现；Codex 设计执行暂时关闭。** 当前公开 app-server 契约无法充分证明所有本地代码执行与文件写入路径都可禁用。read-only sandbox、shell flags 或 hooks 单独不是完整能力白名单。因此 Responses/Codex 运行会明确报错，不会自动切换到收费 API。

用户可以显式选择已有 OpenAI Chat / Anthropic API 配置继续受控设计对话。该路径仅提供应用内设计工具，拒绝开发任务、代码生成、部署、测试证据及自行批准；草稿必须由用户确认。API 独立计费。

已用 mock 验证账户协议与安全边界，未进行真实 OAuth、订阅推理或额度验证。

官方依据：
- https://learn.chatgpt.com/docs/app-server#auth-endpoints
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/hooks#tool-coverage
