# 单工单重试恢复

## 范围

单个任务耗尽 `maxAttempts` 后，用户可以提交一条非授权的恢复请求。它精确绑定项目、`taskKey`、`taskRevision`、失败/过期的 `workOrderId` 与尝试次数，并要求失败原因和已经采取的修复措施。

- `GET /api/projects/:id/agent-task-retry-candidates` 只返回仍在当前治理队列中的耗尽任务
- `POST /api/projects/:id/agent-task-retry-requests` 接收 `taskKey`、`taskRevision`、`failedWorkOrderId`、`expectedAttempt`、`reason`、`remediation`、`idempotencyKey`
- 请求本身不允许重试。精确重放返回同一请求；不同内容复用幂等键、另一个请求键重复申请同一失败尝试均失败
- 待审批请求生成唯一的 `approval:retry:<requestId>` 工单，动作 `approve_agent_task_retry`
- Main Agent 必须领取该独立审批工单。失败执行者的 Agent 或 Worker 身份不能批准自己的恢复
- 审批使用已有 `complete_agent_task`，必须提交完整租约上下文与 `resultDigest` 审核结论。它只追加一次重试许可，不批准需求、设计、代码或验收

证据修复已有专门的评估/重置治理流程，本入口不覆盖 `submit_evidence_repair`、`assess_evidence_repair_failure`、`reset_evidence_repair_attempt`，也不能递归恢复恢复审批工单。

## 安全与审计

审批仍要求有效、精确匹配、同项目、同资源范围的 Main Agent 工单。已登记身份还必须提供有效认证会话、政策确认和一次性 nonce。MCP 的 action/target 为 `mcp.complete_agent_task` / `mcp:complete_agent_task`；REST 为 `rest.complete_agent_task` / `rest:/api/agent-task-leases/complete`。

重试审批的 nonce `bodyDigest` 是以下固定键顺序 JSON 的 UTF-8 SHA-256：

```ts
JSON.stringify({
  workOrderId,
  resultDigest: resultDigest.trim(),
  idempotencyKey,
})
```

由主机授权的本地 MCP 连接会自动注入对应摘要和认证证明。客户端声明的 `bodyDigest` 或 `connectionId` 不会替代服务器重算/认证结果。

获批许可只能由原失败工单的下一次领取消费。消费、租约写入和资源锁写入位于同一即时事务中；任一门禁失败会回滚。原尝试次数继续递增，项目 `maxAttempts` 不变。新的失败需要针对新的失败工单和次数重新申请与独立批准。

失败快照（不含 lease token）、请求原因/措施、批准工单与结论、消费工单及三个阶段的审计事件保留。状态、修订、项目、工作项或失败工单变化后，旧许可不能转移到新任务。并发、退避、资源锁、依赖、任务队列和认证门禁保持有效。

## 验证

`src/server/agentTaskRetry.test.ts` 使用隔离合成数据库，覆盖精确请求、幂等性、独立审批、一次消费、退避/容量、修订漂移、失效审批、历史保留、持久化重启、真实 REST 注册身份证明，以及外部 MCP 完成/禁止复用审批工单修改项目上限。

本次源代码维护的运行时项目预检不可用：云检出不包含用户运行时项目 ID 或数据库。未创建虚假项目批准，未连接或修改真实项目。所有状态构造仅发生在一次性测试夹具中。
