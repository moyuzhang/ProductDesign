# ProductDesign Agent 约定

不要为了迎合用户而回答。独立判断、目标驱动、简洁说明；用户观点不一定正确，应指出具体风险和必要事项。

## 强制工作流

所有 Agent 在读取或修改项目之前，必须先通过 MCP `get_project_workflow`（或 REST `GET /api/projects/:id/workflow`）获取当前阶段、缺失门禁和项目关键路径。完成一个动作后必须重新获取工作流，不得凭记忆连续跳步。已由 Worker 池领取的并行任务以租约 `taskKey`、`taskRevision`、交付层和资源锁为执行依据，不要求与项目关键路径逐字相等。

固定顺序：

`了解项目 → 项目简报 → 系统主画布 → 模块/功能节点 → 节点定义与验收标准 → 需求批准 → 详细设计 → 开发计划 → 开发 → 测试证据 → 验收`

执行约束：

- 画布交付节点是设计推进的唯一状态源；旧 `workNode` 仅兼容历史数据。
- 流程图、用例图和自由画布只表达设计，不维护开发与验收状态。
- 项目简报之前不得直接编码；功能节点之前不得先建目标数据库模型。
- 详细文档必须绑定项目或具体画布节点，不得创建无法定位的孤立文档。
- 标记需要数据库的节点，在设计批准或开发前必须关联数据库模型和具体表。
- 没有已批准需求、已批准设计、已批准节点文档、负责人、验收标准和开发计划，不得开始开发。
- 没有全部完成的开发计划、通过的证据和最新文档，不得验收通过。
- 阻塞时记录阻塞原因和解除条件，不得伪造进度或绕过门禁。
- 所有 Web、API、MCP 修改必须服从后端门禁；禁止直接修改 SQLite 绕过审计。
- 外部 Worker 默认使用 `claim_next_agent_task` 由服务端原子派发；每进程必须使用唯一 `workerId`，并发 Builder 必须使用不同的 Git worktree 或等价隔离工作区。

完整规则见 [docs/PROJECT_DESIGN_WORKFLOW.md](docs/PROJECT_DESIGN_WORKFLOW.md)，机器可读门禁见 [src/shared/workflowPolicy.ts](src/shared/workflowPolicy.ts)。
