export const PROJECT_WORKFLOW_POLICY = {
  version: "1.1.0",
  authoritativeEntity: "diagramNode",
  legacyEntity: "workNode",
  deliveryDiagramTypes: ["main", "functional", "deployment"],
  exemptDiagramTypes: ["flow", "usecase", "free"],
  deliveryNodeKinds: ["module", "feature", "requirement", "interface", "data"],
  /** 只有 task 是可执行的施工计划；goal/milestone/version 仅用于计划层级，不进施工交付流程。 */
  executablePlanKinds: ["task"],
  phaseLabels: {
    discovery: "了解项目",
    "functional-design": "系统与功能设计",
    "node-definition": "补全节点",
    "requirement-review": "需求评审",
    "detailed-design": "详细设计",
    planning: "开发计划",
    development: "开发实施",
    verification: "测试与证据",
    acceptance: "验收",
    completed: "已完成",
  },
  gates: {
    requirementApproved: ["description", "owner", "acceptanceCriteria"],
    designApproved: ["requirementApproved", "approvedCurrentDocumentReference", "databaseBindingWhenRequired"],
    developmentStarted: ["requirementApproved", "designApproved", "owner", "acceptanceCriteria", "approvedCurrentDocumentReference", "developmentPlan", "databaseBindingWhenRequired"],
    developmentCompleted: ["allDevelopmentPlansCompleted"],
    acceptancePassed: ["developmentCompleted", "acceptanceCriteria", "approvedCurrentDocumentReference", "passingEvidence", "allDevelopmentPlansCompleted", "databaseBindingWhenRequired"],
  },
} as const;
