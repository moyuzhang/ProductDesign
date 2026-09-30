# Agent MCP 2.3 接入

## 本机 Main Agent：免人工登记的 stdio 接入

由受保护的本机宿主配置启动以下命令（scope 是进程环境，不是工具参数）：

```powershell
$env:PCS_DB = 'D:\project\ProductDesign\data\control-surface.db'
$env:PCS_LOCAL_MCP_PROJECT = 'FIVEBEAR'
$env:PCS_LOCAL_MCP_WORKER = 'codex-main-fivebear-' + [guid]::NewGuid().ToString()
node 'D:\project\ProductDesign\dist\node\mcp\index.js'
```

MCP 客户端应把原 HTTP 连接改为上述 `node` 命令的 **stdio** 连接，并在宿主的 MCP 配置里提供这三个环境值；工作进程的 workerId 在一次连接内稳定，重启使用新值。保护配置文件/启动账户的 OS 权限，不能把用户可编辑的工具参数当授权配置。没有这两个 scope 值的 stdio 不自动授权；HTTP 服务不读取它们，也不接受本机 session、policy token 或父租约。

initialize 会返回项目、workerId 和 15 分钟有效期，但不会返回凭据/session/policy secret。本机连接仅授权 `Main Agent` 的 `approver` 角色；认证与 nonce 由宿主注入，仍须提交精确工单/租约上下文。Main Agent 不能领取 Designer、Builder 或 Auditor 工单，不能自审，也不能执行 human-only 高风险动作。子 Agent 使用既有受限 dispatchId，独立领取自己的任务；不继承主身份。

正常 EOF、SIGINT/SIGTERM 和关闭连接会撤销本机授权并释放父子租约、锁与本进程审批工单。强杀或断电不能保证即时清理：依赖短期凭据/父租约 TTL 和下次租约扫描失效回收。到期后关闭并重建 stdio 连接，不以 HTTP 降级。此接入不替代正式需求/设计/独立审计/批准，也不修改用户现有 MCP 配置。

远程或需要强认证的 Worker 由管理员预登记一次最小权限凭证。本机未登记凭据的 Worker 使用精确租约上下文；一旦某个 `agentId` 已登记凭据，该身份的所有受控写都强制走下述认证流程。`workerId` 必须稳定且唯一；角色和项目只授予该工单池实际需要的值。先用 `-DryRun` 检查服务和登记对象，此模式不会读取管理员令牌、不会写入：

```powershell
./scripts/Register-AgentCredential.ps1 -DryRun -PrincipalId 'vendor/fivebear' -AgentId 'assigned-agent-name' -WorkerId 'fivebear-step02-worker-01' -Role builder -ProjectId '<project-uuid>'
```

确认对象后由人工执行同一命令并移除 `-DryRun`。脚本使用 `Read-Host -AsSecureString` 在本机隐藏输入管理员令牌；不读取环境变量，也不把管理员令牌放入参数、日志或返回结果。也可由可信人工宿主通过 `-AdminToken <SecureString>` 提供。

服务只返回一次 `credentialId` 和 `credentialSecret`。管理员应立即将二者写入目标 Worker 的安全密钥存储，然后清理终端历史/捕获；不要写入仓库、工单、聊天或普通日志。服务端只保存密钥哈希，之后无法找回明文。

## 信任边界

- 仅管理员可见：`PCS_AGENT_ADMIN_TOKEN`、登记接口授权、初次返回的 `credentialSecret`。
- Agent 可见：自身 `credentialId` 和 `credentialSecret`、自身 claim 返回的工单与租约、认证后的 session/policy token、每次写入的 nonce。
- 所有人均可读：policyVersion、工作流、可领取任务、工具 schema。只读发现不构成授权。
- Agent 永远不可见：管理员令牌、其他 Worker 的 secret、其他租约的 leaseToken。

已登记凭据 Worker 的合法顺序：

1. `get_project_workflow` 和 `claim_next_agent_task`，保存完整租约包。claim 只锁定任务，不代表认证成功。
2. `begin_agent_auth`，使用预登记的 `credentialId` 和本次 MCP `connectionId` 获取挑战。
3. 本地以 `credentialSecret` 计算 HMAC-SHA256，调用 `complete_agent_auth`。
4. 用返回的 `authSessionToken` 调用 `ack_agent_policy`，版本必须与 `initialize.instructions` 完全一致。
5. 每次写入前，对业务请求正文计算 SHA-256；调用 `issue_agent_write_nonce`。动作固定为 `mcp.<toolName>`，目标固定为 `mcp:<toolName>`。
6. 将 `policyAckToken/workOrderId/leaseToken/taskKey/taskRevision/workerId/agentId/role/idempotencyKey/nonceId/connectionId/bodyDigest` 原样传给 `start_agent_task`、`heartbeat_agent_task`、证据和流转工具。每次写入使用新的 nonce；重试只能复用同一个业务幂等键，不能重放 nonce。

任一身份、连接、工单修订或 nonce 不匹配都会失败关闭。领取工单不会自动认证，也不会生成或绕过策略确认。
