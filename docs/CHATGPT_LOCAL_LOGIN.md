# 本机 ChatGPT 登录（账户功能）

此集成仅面向用户自己运行的本机 ProductDesign，不用于托管服务或商业代登录。官方 Codex app-server 管理浏览器 / device-code OAuth、令牌存储与刷新；应用不读取或导出 auth.json / access token。

- 模型设置可显式开始登录、取消、查看状态和退出。浏览器/设备授权必须由用户在官方页面完成。当前实现没有代用户登录。
- 账户服务与未来订阅会话共用 data/codex-chatgpt 隔离目录。API Key 会话继续使用原目录。订阅进程移除 API Key 环境覆盖，不会自动改用 API 计费。
- 登录接口及订阅相关入口仅允许 loopback、匹配的浏览器 Origin 和明确本机请求头。无远程订阅入口；未通过的请求不会启动登录。
- 模型来自 account/read + model/list；目录存在不等于已验证该账户真实推理权限或剩余额度。
- 登录等待十分钟后取消；通知只保留安全状态，不回传原始错误或令牌。

## 明确限制

**ChatGPT 登录、模型目录和受限设计运行路径已实现；运行取决于本机自检。** 每轮使用独立临时设计工作区，不进入目标源码目录；配置关闭 shell_tool、apps、hooks、multi-agent、code mode 等入口，限定只读、无网络沙箱，并拒绝命令/文件提权请求。只有作用域内设计 MCP 工具能写应用设计资料，外部开发 harness 仍走工单执行开发。

运行前验证本机 CLI 生成的协议 schema 和安全功能配置，并通过 Codex 沙箱执行只针对临时文件的写入拒绝 canary。沙箱必须真正成功启动且脚本确认写入被拒绝；“文件不存在”或沙箱启动失败不能算通过。启动 app-server 后再次检查生效配置和返回的只读/无网络策略。未满足时明确阻止本轮，不修改系统安全设置、不自动切换 API。

某些版本将 unified_exec 规范化显示为 true；官方工具注册实现由 shell_tool=false 在注册 exec/write_stdin 前提前返回。仍请求 unified_exec=false，但不以该内部执行器值单独误判模型有命令工具。apply_patch 独立存在，因此不能省略只读 OS 沙箱和拒绝提权。

本云环境的实际无登录自检返回 SANDBOX_STARTUP_FAILED：Codex 的 socket 目录所有权/0700 条件不满足。未将其当成成功拒写，未进行模型调用。支持所需沙箱的用户本机可通过“检查设计运行环境”后使用；真实用户环境与订阅推理仍待验证。

用户可以显式选择已有 OpenAI Chat / Anthropic API 配置继续受控设计对话。该路径仅提供应用内设计工具，拒绝开发任务、代码生成、部署、测试证据及自行批准；草稿必须由用户确认。API 独立计费。

每轮重新读取项目目标、当前批准文档、待确认草稿、相关节点、记录的决定及结构化检查；保留来源 ID/修订，历史对话不作为当前批准依据。设计工具保存后自动追加服务端一致性检查，指导局部修订。此机制改善依据与校验，不宣称模型语义推理或实际设计质量已完成现场验证。

已用 mock 验证账户协议、安全边界和支持环境的执行路径，未进行真实 OAuth、订阅推理或额度验证。

官方依据：
- https://learn.chatgpt.com/docs/app-server#auth-endpoints
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/hooks#tool-coverage

- Shell 工具注册依据：https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/core/src/tools/spec_plan.rs
