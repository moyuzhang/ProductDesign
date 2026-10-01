# 可审计的需求覆盖与设计一致性

内部设计助手可通过 validate_design_contract 读取服务端检查结果、权威计划 ID/范围指纹和 artifactSchemas。REST 使用 GET /api/projects/:id/design-contract-validation，可带 planId。读取不会修改设计或批准状态。

结构化产物继续存入已有 DesignDoc/content 与不可变修订：

- productdesign.requirements-baseline：独立需求清单，逐项稳定 ID、验收标准键与明确的接口方法/路径；需要用户或合法独立审批确认。不得从已存在计划反推“完整需求”。
- productdesign.design-contract：引用基线固定修订，映射需求到精确计划/节点/设计修订，声明 build/verification/acceptance 等阶段等待关系。
- 使用已有 defines 文档引用绑定项目或计划。没有明确结构化基线时返回 unassessed，不冒充检查通过，也不改变原有项目流程。

服务端直接从 Store 加载计划、节点、文档、修订和审计证据。检查范围包括：漏需求和漏验收项、错误但存在的 ID、标签/归属不符、范围和版本漂移、GET/POST 或路径不一致、阶段等待环。配置验收等 TXT、TXT 开发又等配置验收的回路会报告 PHASE_DEPENDENCY_CYCLE，需要通过合法设计变更修改验证阶段或依赖；检查器不删除依赖、不伪造 TXT 证据。

进入正式流程的已选择合同必须批准且有效。提交时固定合同修订到设计基线；后续变更需重新提交和独立审计。已冻结合同即使删除引用，也不能退回 unassessed 绕过门禁。实现审计和验收对当前计划要求逐标准、当前实现、对应需求基线和独立 Auditor 的真实记录，其他标准或其他计划的单条 pass 不能代替。

valid 仅表示“明确声明的结构一致”，不表示自然语言语义已穷尽、需求绝对完整、实际测试执行过或业务验收通过。缺少结构化事实时保留 unassessed/partial。用户仍需确认范围与设计；外部开发 harness 仍须走工单、租约、审计和验收流程。
