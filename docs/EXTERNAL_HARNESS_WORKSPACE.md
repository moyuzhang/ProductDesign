# 外部 Harness 工作区绑定（第一阶段）

## 边界

ProductDesign 先通过现有 `POST /api/projects` / `create_product_design_project` 显式创建项目，返回稳定 project ID。不会扫描外部目录、按路径自动建项目、克隆源码或启动执行进程。内部 Harness 继续处理设计；开发进程与子 Agent 由外部 Harness 管理。服务只持有设计、工单、租约、审批和证据。

已有本地模式保持兼容：未设置 `externalRepositoryId` 时仍校验服务端 `repositoryPath`。外部模式不需要在服务宿主机配置源码路径或 Git HEAD。

## 配置与领取

1. 对明确的项目 ID 调用 `PATCH /api/projects/:id`，或现有 `update_project` MCP 工具，设置 `externalRepositoryId`，并将 `repositoryPath` 留空。该标识是非秘密的不透明仓库身份，不会被访问或解析成 URL。两个字段不能同时非空。
2. 使用已有认证流程取得允许该项目与角色的 Agent 会话。外部模式所有领取（包括重放）必须提供 `authSessionToken`；认证的 `agentId` 和 `workerId` 必须与请求完全一致。此功能不创建凭据、不新增权限。
3. 开发领取时传入 `externalWorkspace`：`repositoryId`（必须匹配项目配置）、`workspaceId`（外部 Harness 分配、同项目所有机器/Runner 间唯一的工作区身份）、`workspacePath`（执行端绝对路径，可为 Windows 或 POSIX）、`workspaceBranch`、`baselineRevision`（完整小写 40/64 位 Git SHA）。这些是执行端声明，不会在服务端读取或执行。
4. 支持 `POST /api/projects/:id/agent-task-package`、`get_agent_task_package`、`claim_next_agent_task`，以及 Main Agent 派发后的 `claim_dispatched_child_task` / REST 子任务领取。子任务必须匹配父租约、派发任务、Agent 与 Worker。
5. 工作区、分支和基线在领取时持久化固定在租约中。`start_agent_task` 可以省略这些字段；传入不同值会拒绝。更换工作区必须释放并重新领取。活动工单或父协调租约存在时，不允许修改项目仓库绑定。

`lease.externalWorkspace` 是固定执行上下文，和 `lease.workerId` 一起绑定执行进程。任务包 `workingDirectory.location=external`、`verification=runner-attestation`；`exists=false` / `directory=false` 明确表示服务没有验证远端文件系统，`ready=true` 只表示绑定协议就绪。`launch.executionOwner=external-harness` 描述执行归属；旧 `manualStartRequired=true` 保留兼容含义：服务不会自行启动进程，外部 Harness 可在自身授权下执行。

## 安全与重试

- 外部基线仅为已认证 Runner 的声明，不是服务校验过的 Git 真相。完成实现仍须回传真实实现修订与证据，保留独立审计、批准、任务修订、资源锁、政策确认和 nonce 门禁。
- 活动外部工作区在同一项目内按 `workspaceId` 拒绝并发领取，同一原子审批组成员可共享绑定。不同机器可以有相同路径，服务不会以路径推断远端机器身份。Harness 必须对同一真实工作区持续使用同一个 workspaceId 并保证真实隔离，不能通过不同标识证明隔离。
- 直接领取与派发子任务领取均原子提交工单、工作区预留和完整任务包；序列化失败回滚。重放返回原始固定绑定，并重新验证认证；会话刷新不改变业务幂等摘要。认证 token 不写入租约、审计或幂等响应。
- 现有项目配置与 MCP 安全策略继续生效，外部仓库设置不是审批授权。

## 第一阶段限制

`submit_evidence_repair` 在外部模式明确返回 `EXTERNAL_REPAIR_VERIFIER_REQUIRED`。当前修复协议依赖受控仓库 HEAD 与固定修订比较；尚未实现可信外部验证器，不能用 Runner 自报 SHA 代替这个门禁。服务端 Git 证据采集也不适用于无服务端源码的项目；外部执行者须按既有证据协议提交结果并接受独立审计。

本阶段不新增自动派发/改派幂等协议、不远程检查路径、不提供 UI 源码绑定表单、不负责外部 Runner 安装或凭据配置。外部路径和基线输入应来自 Harness 自己核实的隔离工作区。

## 验证与维护范围

新增 `externalProjectRepository.test.ts`、`externalWorkspace.test.ts` 和 `externalWorkspaceApi.test.ts` 覆盖持久化迁移、活动租约冻结、无本地源码的领取与开工、身份/项目/角色限制、重放与认证撤销、工作区不可变、并发冲突、直接和派发领取事务回滚，以及 REST/MCP 传输和本地兼容。

本次为用户明确批准的独立仓库维护，运行时项目工作流预检不可用；未连接/修改真实项目、未借用工单、未创建虚假批准。数据库状态与测试认证均仅存在于一次性合成测试夹具中。

验证命令：`npm run verify`（完整 Vitest + Web/Server 类型检查 + Vite/Server 构建），最终结果 85 个测试文件、700 通过、1 跳过。新增三组回归共 48 项通过。新测试文件另经严格 TypeScript 检查。构建仅有既有大资源块提示；未执行部署或真实外部 Runner 端到端连接。
