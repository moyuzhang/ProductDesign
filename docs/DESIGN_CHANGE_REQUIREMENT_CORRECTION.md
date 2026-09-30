# 未完成设计变更的需求影响复核

内部设计助手负责产品设计；外部开发 harness 继续通过 MCP、工单、租约、进度、问题、变更和证据流程完成开发。这里修复的是两者之间的正式变更恢复通道，不取消审批或开发工单。

## 原阻塞

最初判断没有需求影响后，正式变更把活动计划置为返工；普通新意图要求 accepted 根计划。此时不能合法生成有需求影响的新审批，而需求修订任务只认可有效正式变更中的 requirementImpact=true。

## 恢复操作

1. 项目设计页或节点页读取服务器提供的复核候选。只有当前节点仍指向正式变更、原分类为无需求影响、原记录中的返工计划尚处于 draft/pending_approval/rework 时才出现。
2. 如果发现分类有误，用户填写原因和更正说明，提交带 correctsChangeId 的变更意图。
3. 此步骤只生成待审批意图，不改需求、不授权实现。服务端冻结当前依赖闭包、节点、计划、文档版本及原决定指纹。
4. 新独立 approver 工单按原有身份、租约、跨节点范围及独立性门禁审核；确认更正时必须明确 requirementImpact=true。
5. 服务端追加关联原决定的新变更记录，保留历史，随后派生一次需求修订任务。旧审批不能用于新更正；相同幂等请求返回同一结果。

## 接口

- GET /api/projects/:id/design-change-recoveries：权威候选、精确变更/节点/当前返工计划、expectedUpdatedAt、阻塞原因和需要独立审批的标记
- POST /api/projects/:id/design-change-intents：现有字段加可选 correctsChangeId；普通意图仍要求 accepted 根计划
- 外部 MCP submit_design_change_intent：同样支持 correctsChangeId，仍然不具有授权效果
- request_design_change：使用新 intentId 和独立审批上下文应用更正；不允许把更正再次提交为无需求影响

源决定或冻结范围改变、错误项目/节点/计划、已完成目标、过期审批、重叠待审意图均拒绝。失效时刷新后重新提出复核，不修改旧批准记录绕过门禁。

只修改了 ProductDesign 源码和隔离测试数据，未修改任何真实 NumberSet 项目。
