# 依赖锁按阶段执行：修复设计与交付循环等待

日期：2026-09-09。用户已在详细评估后要求“修复”。
状态：用户连续要求直接修复后，代码修复、本地验证和本机服务更新已完成；没有登记或冒充受控工单的独立审计、审批及验收记录。

## 归属及范围

- 项目：PRODUCTDESIGN / 93775248-c4e3-4697-8ef9-41d5dd1b8a21。
- 主画布：7283a719-5955-4d1d-9659-fcaaa2f10053。
- 归属节点：08406e3c-ed25-4246-ba93-5bda496ff76c（外部 Agent 编排与可信交付链）。
- 用户已批准的方向：设计可先行；实现保留上游验收依赖；队列、领取、状态转换一致；同步真实文档引用。
- 不涉及数据库模型、DDL、认证策略、权限扩展或真实站点业务动作。
- 现有 3fb2ca5f-7604-441c-afbb-33368c6811ad 为可信认证 v2.3 施工基线，不将本修复冒充其既有批准范围。

## 当前证据

FiveBear 的 A 为 child-cap-bet，计划 befbf0a5-3957-49bc-b9eb-99b15b705edc，状态 pending_audit。
B 为 child-cap-odds，计划 7957ed16-699b-4113-aac8-59a49a367b40，状态 rework，其 dependencyIds 包含 A。
B 的当前动作 approve_node_document 被 layerLocked 排除；CAP-V3-08 当前修订 4a1cba2b-36d6-4737-9bf9-67f73eab8d15 为评审中。
A 的设计变更 9f3ade31-3e07-4c95-bf27-fbd862ecef20 要求 CAP-V3-08 与 CAP-V3-09 均批准并更新引用。
因此 A 实现审计等待 B 文档批准，B 文档审批等待 A 验收。

另有独立的数据闭环缺口：A 计划的 CAP-V3-09 引用仍为 fcdbe54a-1c12-491c-99ae-92392067ece6，节点和冻结设计已为 361a3b77-fee9-4ff4-ad52-0584ab2977c6；A 对 CAP-V3-08 的引用仍为 a13c6223-b9c0-4664-b45a-edbaaa028647。
以上为读取时快照，实际写入前必须重新读取当前版本和工作流。

## 行为设计

保留 analyzePlanLayers 的依赖图及实现锁语义，不把未验收依赖伪装成已完成。按实际 actionCode 和交付阶段决定该动作是否受实现依赖锁约束；不要只按角色或队列区分，因为 approval/audit 同时承担设计与实现动作。

1. 节点定义、需求/文档设计准备、设计计划提交、独立设计审计与常规设计批准，不等待上游实现验收。
2. start_development、complete_development、实现返工开工、实现审计通过及最终验收继续保留现行依赖及证据条件。
3. 无效依赖、真实依赖环仍拒绝正向交付，不以设计放行绕过图有效性检查。
4. 工作流 nextAction、编排队列、显式任务领取、原子任务领取及生命周期转换调用一致的动作判定。
5. 不把 layerLocked 全局改成 false；界面应能表达“实现待依赖验收，设计可推进”，避免展示全节点不可推进。
6. 文档批准、不可变修订、角色独立、当前租约、任务修订和资源锁仍正常验证。
7. 未知动作不默认获得豁免；设计例外使用明确动作范围。设计返工与实现返工分开处理。

## 最小开发计划

- 在现有依赖门禁模块集中动作判定，复用当前层图，不新增调度器、任务状态或依赖字段。
- 对 workflow.ts、orchestration.ts、planLifecycle.ts 的调用链逐一应用，包括 buildAgentTaskPackage 的两次验证。
- 更新旧的“下游设计提交必须等待上游验收”测试预期，增加跨入口回归。
- 修订流程规范和必要的节点状态提示；不做无关重构。
- 本地验证后由独立 Auditor 复核；运行时发布需保留现有运行任务并核实新版本实际生效。

## FiveBear 恢复计划

编排修复生效后重新读取 B 文档状态及审批队列，以 B 的独立工单完成文档评审和批准。
分别使用 A、B 对应范围的受控工单同步所需节点及计划引用到当前批准修订，不用旧快照直接覆盖。
保留现有依赖边、实现修订和历史证据；独立 Auditor 检查当前证据适用性后推进 A，B 实现仍等待所有真实上游完成。
本轮不直接删除“设计变更全部受影响文档”的审计检查。若需区分跨节点参考与本节点强制基线，应另以明确的逐计划文档归属设计批准后实施，不能靠忽略未绑定文档放行。

## 验收与最小验证

- A 未验收时，B 的设计提交、设计审计、设计批准及文档审批可进入正确队列并领取执行。
- 相同状态下 B 实现开工仍拒绝；A 验收后 B 按其他剩余依赖决定能否开工。
- 覆盖自动与指定领取，不能出现队列可见但任务包被统一层锁拒绝。
- B 批准且相关引用更新后，A 的跨文档审计前置条件解除；任一旧引用或缺失有效证据仍拒绝。
- 独立身份、租约失效、资源冲突及真实循环依赖的负向行为不变。
- 沿用 Vitest，重点验证 planLayers、planLifecycle、workflow、orchestration、claimTaskPackage 及相关 API/MCP 回归，再运行类型检查和构建。
- 评估阶段已有 planLayers.test.ts 与 planLifecycle.test.ts 共 14 项通过；该结果验证的是旧行为，不是修复通过证据。

## 实施前工单状态（历史记录）

最新编排没有本修复对应的设计/开发工单。request_design_change 要求当前节点的独立 Approver 工单；不能借用系统说明或时区节点的验收工单，也不能以旧证据修复任务代替新实现授权。
解除条件：由具有对应权限的 Main Agent/管理员为上述归属节点建立本修复的受控设计变更入口，完成精确绑定的设计修订、独立审计和计划批准，再派发 Builder 工单。
聊天中的用户方向批准已取得；缺失的是系统内可执行工单，而不是再次询问用户是否同意同一方案。

## 实际交付记录

- 用户再次明确要求“修复啊”后直接完成本地维护，未借用其他节点的工单、未写 SQLite 绕过审批。
- planLayers.ts 增加明确设计动作判定；workflow.ts 允许设计动作成为下一步；orchestration.ts 按实际动作过滤计划队列并修复任务包两处校验；planLifecycle.ts 向层锁传入真实动作。
- 保留实现依赖锁及真实环检测；节点页面将“未解锁”说明为“实现依赖未解锁”。
- 回归命令：npx vitest run src/server/planLayers.test.ts src/server/planLifecycle.test.ts src/server/orchestration.test.ts src/server/workflow.test.ts src/server/claimTaskPackage.test.ts src/server/api.test.ts src/server/designChange.test.ts。结果：7 文件、78 测试通过。
- 加入工作流下一步断言后单独重跑 orchestration.test.ts，6 测试通过。npm run typecheck、npm run build 均通过；构建保留现有大资源块提示。
- 使用 better-sqlite3 readonly 连接的 backup API 创建一致性备份：data/backups/dependency-stage-20260909/pre-restart.db。
- 重启前 ProductDesign 和 FiveBear 活动租约均为 0；仅停止经进程命令行核实的本机 ProductDesign 服务，由原监督进程重新启动。服务 health 返回 ok=true、databaseOpen=true。
- 2026-09-09 02:59 本机 MCP 回读：approval:child-cap-odds / approve_node_document 和 design:7957ed16-699b-4113-aac8-59a49a367b40 / submit_plan 均 available=true；B 的 layerLocked 仍 true，实现队列数量仍为 341；审批队列从 23 增为 24。
- 真实浏览器打开 B 文档页，确认页面正常加载，显示“实现依赖未解锁”；CAP-V3-08 仍明确显示“评审中 / 版本已过期”，未冒充批准。
- 本次完成的是编排死锁修复并生效。FiveBear 文档批准、对应引用同步及 A/B 业务验收仍需各自授权工单执行；未自动批准业务设计、未更改其依赖关系或伪造实现证据。
