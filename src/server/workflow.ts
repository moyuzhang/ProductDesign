import type {
  DesignDoc,
  DesignStatus,
  Diagram,
  DiagramNode,
  DocumentReference,
  Evidence,
  NodeDatabaseBinding,
  PlanItem,
  Project,
  ProjectWorkflow,
  ProjectWorkflowAction,
  ProjectWorkflowNodeState,
  ProjectWorkflowPhase,
  ProjectWorkspaceNode,
  RequirementStatus,
} from "../shared/types.js";
import { PROJECT_WORKFLOW_POLICY } from "../shared/workflowPolicy.js";
import { isActiveDeliveryPlan } from "./planPolicy.js";
import { analyzePlanLayers, isDesignPhaseAction } from "./planLayers.js";
import type { ProjectWorkspaceReadData, Store } from "./db.js";
import { matchesImplementationEvidencePolicy } from "./evidencePolicy.js";
import { deriveEvidenceRepairState, getEvidenceRepairState } from "./evidenceRepair.js";
import { getDesignGap } from "./designGap.js";
import { hasRequirementChangeMarker, pendingRequirementRevision, requirementChangeSource } from "./nodeRequirementRevision.js";

/**
 * Batch-loaded per-project data keyed so per-node inspection can avoid N+1 queries.
 * Loaded once per project, then reused for every delivery node.
 */
export interface WorkflowProjectBundle {
  plansByNode: Map<string, PlanItem[]>;                 // key: `${diagramId}|${nodeId}`
  docRefsByNode: Map<string, DocumentReference[]>;      // key: nodeId (targetType=diagramNode)
  documentsById: Map<string, DesignDoc>;                // key: id
  bindingsByNode: Map<string, NodeDatabaseBinding[]>;   // key: `${diagramId}|${nodeId}`
  evidenceByNode: Map<string, Evidence[]>;              // key: nodeId
}

export interface WorkflowProjectReadData extends ProjectWorkspaceReadData {
  documentReferences?: DocumentReference[];
  bindings?: NodeDatabaseBinding[];
}

export interface ResolvedWorkflowProjectReadData {
  project: Project;
  diagrams: Diagram[];
  workspaceNodes: ProjectWorkspaceNode[];
  plans: PlanItem[];
  documents: DesignDoc[];
  documentReferences: DocumentReference[];
  bindings: NodeDatabaseBinding[];
  evidence: Evidence[];
}

function nodeKey(diagramId: string, nodeId: string): string {
  return `${diagramId}|${nodeId}`;
}

function acceptedEvidenceLeafPlans(plans: PlanItem[]): PlanItem[] {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  const accepted = plans.filter((plan) => plan.lifecycleStatus === "accepted");
  return accepted.filter((candidate) => !accepted.some((successor) => {
    if (successor.id === candidate.id || !successor.reworkOfPlanId) return false;
    const visited = new Set<string>();
    let current: PlanItem | undefined = successor;
    let tracesToCandidate = false;
    while (current) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      if (current.id === candidate.id) tracesToCandidate = true;
      if (!current.reworkOfPlanId) return tracesToCandidate;
      current = byId.get(current.reworkOfPlanId);
      if (!current
        || current.projectId !== candidate.projectId
        || current.diagramId !== candidate.diagramId
        || current.diagramNodeId !== candidate.diagramNodeId) return false;
    }
    return false;
  }));
}

export function loadWorkflowProjectData(store: Store, projectId: string, input: WorkflowProjectReadData = {}): ResolvedWorkflowProjectReadData | undefined {
  const read = (): ResolvedWorkflowProjectReadData | undefined => {
    const project = input.project ?? store.getProject(projectId);
    if (!project) return undefined;
    const diagrams = input.diagrams ?? store.listDiagrams(projectId);
    const plans = input.plans ?? store.listPlans(projectId);
    return {
      project,
      diagrams,
      plans,
      workspaceNodes: input.workspaceNodes ?? store.listProjectWorkspaceNodes(projectId, { diagrams, plans }),
      documents: input.documents ?? store.listDesignDocs(projectId),
      documentReferences: input.documentReferences ?? store.listDocumentReferences({ projectId }),
      bindings: input.bindings ?? store.listNodeDatabaseBindings({ projectId }),
      evidence: input.evidence ?? store.listEvidence(projectId),
    };
  };
  if (input.project && input.diagrams && input.workspaceNodes && input.plans && input.documents
    && input.documentReferences && input.bindings && input.evidence) return read();
  return store.db.transaction(read)();
}

export function loadWorkflowProjectBundle(store: Store, projectId: string, input: WorkflowProjectReadData = {}): WorkflowProjectBundle {
  const plansByNode = new Map<string, PlanItem[]>();
  for (const plan of input.plans ?? store.listPlans(projectId)) {
    if (!plan.diagramId || !plan.diagramNodeId) continue;
    const key = nodeKey(plan.diagramId, plan.diagramNodeId);
    const list = plansByNode.get(key) ?? [];
    list.push(plan);
    plansByNode.set(key, list);
  }
  const docRefsByNode = new Map<string, DocumentReference[]>();
  for (const ref of input.documentReferences ?? store.listDocumentReferences({ projectId, targetType: "diagramNode" })) {
    if (ref.targetType !== "diagramNode") continue;
    const list = docRefsByNode.get(ref.targetId) ?? [];
    list.push(ref);
    docRefsByNode.set(ref.targetId, list);
  }
  const documentsById = new Map((input.documents ?? store.listDesignDocs(projectId)).map((doc) => [doc.id, doc]));
  const bindingsByNode = new Map<string, NodeDatabaseBinding[]>();
  for (const binding of input.bindings ?? store.listNodeDatabaseBindings({ projectId })) {
    const key = nodeKey(binding.diagramId, binding.diagramNodeId);
    const list = bindingsByNode.get(key) ?? [];
    list.push(binding);
    bindingsByNode.set(key, list);
  }
  const evidenceByNode = new Map<string, Evidence[]>();
  for (const item of input.evidence ?? store.listEvidence(projectId)) {
    if (!item.nodeId) continue;
    const list = evidenceByNode.get(item.nodeId) ?? [];
    list.push(item);
    evidenceByNode.set(item.nodeId, list);
  }
  return { plansByNode, docRefsByNode, documentsById, bindingsByNode, evidenceByNode };
}

const deliveryDiagramTypes = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryDiagramTypes);
const deliveryNodeKinds = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryNodeKinds);

function action(
  code: string,
  title: string,
  description: string,
  entityType: ProjectWorkflowAction["entityType"],
  href: string,
  ids: { entityId?: string; diagramId?: string; nodeId?: string } = {},
): ProjectWorkflowAction {
  return {
    code,
    title,
    description,
    entityType,
    entityId: ids.entityId ?? null,
    diagramId: ids.diagramId ?? null,
    nodeId: ids.nodeId ?? null,
    href,
  };
}

function nodeHref(diagramId: string, nodeId: string, tab: string): string {
  return `#/canvas/${diagramId}/node/${nodeId}?tab=${tab}`;
}

function nodePlanHref(diagramId: string, nodeId: string, tab: string, planId: string): string {
  return `${nodeHref(diagramId, nodeId, tab)}&plan=${encodeURIComponent(planId)}`;
}

export function isWorkflowDeliveryNode(diagram: Diagram, node: DiagramNode): boolean {
  return deliveryDiagramTypes.has(diagram.type) && deliveryNodeKinds.has(node.kind);
}

export interface ProjectFoundationInspection {
  ready: boolean;
  missing: string[];
  approvedBriefCount: number;
}

export function inspectProjectFoundation(store: Store, projectId: string, input: WorkflowProjectReadData = {}): ProjectFoundationInspection {
  const project = input.project ?? store.getProject(projectId);
  if (!project) return { ready: false, missing: ["项目不存在"], approvedBriefCount: 0 };
  const briefReferences = (input.documentReferences ?? store.listDocumentReferences({ projectId, targetType: "project", targetId: projectId }))
    .filter((reference) => reference.targetType === "project" && reference.targetId === projectId)
    .filter((reference) => reference.relationType === "defines");
  const approvedBriefCount = (input.documents ?? store.listDesignDocs(projectId)).filter((doc) =>
    briefReferences.some((reference) => reference.documentId === doc.id && reference.documentRevisionId === doc.currentRevisionId)
      && doc.status === "已批准" && (doc.category === "需求文档" || doc.category === "功能说明")
  ).length;
  const missing: string[] = [];
  if (!project.summary.trim()) missing.push("项目摘要与范围");
  if (approvedBriefCount === 0) missing.push("已批准的项目简报或项目级需求文档");
  return { ready: missing.length === 0, missing, approvedBriefCount };
}

export interface NodeWorkflowInspection {
  state: ProjectWorkflowNodeState;
  descriptionReady: boolean;
  ownerReady: boolean;
  criteriaReady: boolean;
  requirementReady: boolean;
  documentReady: boolean;
  designReady: boolean;
  databaseReady: boolean;
  planReady: boolean;
  plansCompleted: boolean;
  evidenceReady: boolean;
}

export function inspectNodeWorkflow(store: Store, diagram: Diagram, node: DiagramNode, bundle?: WorkflowProjectBundle): NodeWorkflowInspection {
  const plans = (bundle
    ? (bundle.plansByNode.get(nodeKey(diagram.id, node.id)) ?? [])
    : store.listPlans(diagram.projectId, diagram.id, node.id))
    .filter(isActiveDeliveryPlan);
  const deliveryPlans = plans.filter((plan) => ["legacy", "approved", "in_progress", "pending_audit", "audit_failed", "pending_manager", "accepted"].includes(plan.lifecycleStatus));
  const pendingApprovalPlan = plans.find((plan) => plan.lifecycleStatus === "pending_approval");
  const pendingDesignAuditPlan = plans.find((plan) => plan.lifecycleStatus === "pending_approval" && plan.auditStatus !== "passed");
  const pendingDesignManagerPlan = plans.find((plan) => plan.lifecycleStatus === "pending_approval" && plan.auditStatus === "passed");
  const designReworkPlan = plans.find((plan) => plan.lifecycleStatus === "rework" && plan.managerDecision !== "rejected");
  const draftPlan = plans.find((plan) => plan.lifecycleStatus === "draft");
  const implementationReworkPlan = plans.find((plan) => plan.lifecycleStatus === "rework" && plan.managerDecision === "rejected");
  const formalTraceGapPlan = plans.find((plan) =>
    ["approved", "in_progress", "legacy"].includes(plan.lifecycleStatus)
      && (!plan.submittedAt || !plan.approvedAt)
  );
  const approvedPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "approved");
  let designGapPlan: PlanItem | undefined;
  let designGap: ReturnType<typeof getDesignGap>;
  for (const plan of deliveryPlans) {
    const gap = getDesignGap(store, plan);
    if (!gap) continue;
    designGapPlan = plan;
    designGap = gap;
    break;
  }
  const inProgressPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "in_progress");
  const pendingAuditPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "pending_audit");
  const auditFailedPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "audit_failed");
  const pendingManagerPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "pending_manager");
  const references = bundle
    ? (bundle.docRefsByNode.get(node.id) ?? [])
    : store.listDocumentReferences({ projectId: diagram.projectId, targetType: "diagramNode", targetId: node.id });
  const documents = references.flatMap((reference) => {
    const doc = bundle ? bundle.documentsById.get(reference.documentId) : store.getDesignDoc(reference.documentId);
    return doc && reference.documentRevisionId === doc.currentRevisionId ? [doc] : [];
  });
  const approvedDocuments = documents.filter((doc) => doc.status === "已批准");
  const bindings = bundle
    ? (bundle.bindingsByNode.get(nodeKey(diagram.id, node.id)) ?? [])
    : store.listNodeDatabaseBindings({ projectId: diagram.projectId, diagramId: diagram.id, diagramNodeId: node.id });
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const acceptedPlans = acceptedEvidenceLeafPlans(plans);
  const nodeEvidence = bundle ? (bundle.evidenceByNode.get(node.id) ?? []) : store.listEvidence(diagram.projectId, node.id);
  const storedEvidence = nodeEvidence
    .filter((item) => {
      const plan = item.planItemId ? planById.get(item.planItemId) : undefined;
      return Boolean(plan
        && (item.actorRole === "builder" || item.actorRole === "auditor")
        && matchesImplementationEvidencePolicy(item, plan, { actorRole: item.actorRole }));
    });
  const requirementStatus: RequirementStatus = node.requirementStatus ?? "待整理";
  const designStatus: DesignStatus = node.designStatus ?? "未开始";
  const requiresDatabase = node.requiresDatabase ?? node.kind === "data";
  const descriptionReady = Boolean(node.description?.trim());
  const ownerReady = Boolean(node.owner?.trim());
  const criteriaReady = Boolean(node.acceptanceCriteria?.trim());
  const requirementReady = requirementStatus === "已批准";
  const documentReady = approvedDocuments.length > 0;
  const designReady = designStatus === "已批准" || (!requiresDatabase && designStatus === "不适用");
  const databaseReady = !requiresDatabase || bindings.length > 0;
  const planReady = deliveryPlans.length > 0;
  const plansCompleted = planReady && deliveryPlans.every((plan) => plan.status === "已完成");
  const gapPlans = acceptedPlans.filter((plan) => !nodeEvidence.some((item) =>
    matchesImplementationEvidencePolicy(item, plan, { actorRole: "auditor", resultStatus: "pass" })
  ));
  // Once a node is accepted, only strict per-plan Auditor evidence can keep it closed.
  // Builder evidence remains useful for handoff, but can never close an accepted plan.
  const evidenceReady = acceptedPlans.length > 0 ? gapPlans.length === 0 : storedEvidence.length > 0;
  const developmentStatus = node.developmentStatus ?? "未开发";
  const acceptanceStatus = node.acceptanceStatus ?? "未验收";
  const missing: string[] = [];
  if (!descriptionReady) missing.push("功能说明");
  if (!ownerReady) missing.push("负责人");
  if (!criteriaReady) missing.push("验收标准");
  if (!requirementReady) missing.push("已批准的需求");
  if (!documentReady) missing.push("已批准的节点文档");
  if (!designReady) missing.push("已批准的设计");
  if (!databaseReady) missing.push("数据库表关联");
  if (!planReady) missing.push(plans.length > 0 ? "已批准的开发计划" : "开发计划");
  if (developmentStatus === "已阻塞") missing.push("解除开发阻塞");
  if (developmentStatus !== "已完成") missing.push("开发完成");
  if (!plansCompleted) missing.push("全部开发计划完成");
  if (!evidenceReady) missing.push("通过的验收证据");
  if (acceptanceStatus !== "已通过") missing.push("验收通过");

  const ids = { entityId: node.id, diagramId: diagram.id, nodeId: node.id };
  let nextAction: ProjectWorkflowAction | null = null;
  if (designGapPlan && designGap) {
    missing.unshift(designGap.reason);
    nextAction = action("request_design_change", `处理节点“${node.label}”的开工前设计缺口`, designGap.reason,
      "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: designGapPlan.id });
  } else if (hasRequirementChangeMarker(node) && !requirementChangeSource(store, diagram, node)
    && requirementStatus !== "已批准") {
    nextAction = action("resolve_node_blocker", `核对节点“${node.label}”的设计变更来源`, "设计变更标记缺少同项目正式请求及有效需求影响裁决；须走正式变更流程。", "node", nodeHref(diagram.id, node.id, "delivery"), ids);
  } else if (pendingRequirementRevision(store, diagram, node)) {
    nextAction = action("revise_node_requirement", `修订节点“${node.label}”的需求`, "由 Designer 修正当前变更涉及的节点需求与验收标准，完成后再交独立批准。", "node", nodeHref(diagram.id, node.id, "overview"), ids);
  } else if (!descriptionReady || !ownerReady || !criteriaReady) {
    nextAction = action("complete_node_definition", `补全节点“${node.label}”`, "填写功能边界、负责人和可验证的验收标准。", "node", nodeHref(diagram.id, node.id, "overview"), ids);
  } else if (!requirementReady) {
    nextAction = action("approve_node_requirement", `评审节点“${node.label}”的需求`, "确认需求范围后将需求状态推进为已批准。", "node", nodeHref(diagram.id, node.id, "delivery"), ids);
  } else if (!documentReady) {
    nextAction = action("approve_node_document", `补充节点“${node.label}”的设计文档`, "从项目文档库创建或引用至少一份已批准的需求或设计文档。", "document", nodeHref(diagram.id, node.id, "documents"), ids);
  } else if (pendingDesignAuditPlan) {
    nextAction = action("audit_design", `审计节点“${node.label}”的设计基线`, "由独立 Design Auditor 只读核验固定文档修订并形成证据；Designer 不得自审。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: pendingDesignAuditPlan.id });
  } else if (pendingDesignManagerPlan) {
    nextAction = action("approve_plan", `批准节点“${node.label}”的设计与开发计划`, "独立设计审计已通过，等待 Main Agent 领取独立 Approver 工单确认设计基线和开发计划。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: pendingDesignManagerPlan.id });
  } else if (designReworkPlan) {
    nextAction = action("submit_plan", `返工节点“${node.label}”的设计基线`, designReworkPlan.rejectionReason || "设计审计或人工评审未通过，Designer 必须产生新文档修订并重新提交。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: designReworkPlan.id });
  } else if (draftPlan) {
    nextAction = action("submit_plan", `提交节点“${node.label}”的开发计划`, "由设计 Agent 固定设计修订并提交此独立计划。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: draftPlan.id });
  } else if (implementationReworkPlan) {
    nextAction = action("reopen_rework", `返工节点“${node.label}”的实现`, implementationReworkPlan.rejectionReason || "人工验收未通过，Builder 必须按拒绝原因返工并产生新实现修订。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: implementationReworkPlan.id });
  } else if (!designReady) {
    nextAction = action("approve_node_design", `完成节点“${node.label}”的详细设计`, "根据需要完成流程、接口、数据库或部署设计并通过评审。", "node", nodeHref(diagram.id, node.id, "delivery"), ids);
  } else if (!databaseReady) {
    nextAction = action("bind_node_database", `关联节点“${node.label}”的数据库表`, "标记为需要数据库的节点必须关联模型和具体表。", "database", nodeHref(diagram.id, node.id, "relations"), ids);
  } else if (plans.length === 0) {
    nextAction = action("create_node_plan", `拆分节点“${node.label}”的开发计划`, "创建带负责人、依赖和完成条件的开发动作。", "plan", nodeHref(diagram.id, node.id, "development"), ids);
  } else if (pendingApprovalPlan) {
    nextAction = action("approve_plan", `批准节点“${node.label}”的开发计划`, "由 Main Agent 领取独立 Approver 工单批准开发计划基线，禁止设计 Agent 自批。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: pendingApprovalPlan.id });
  } else if (formalTraceGapPlan) {
    nextAction = action("submit_plan", `补齐节点“${node.label}”的正式交付基线`, "当前施工单缺少正式提交或管理员批准痕迹；先在指定施工单补齐角色并重新提交，再进入独立审计和批准。", "plan", nodePlanHref(diagram.id, node.id, "development", formalTraceGapPlan.id), { ...ids, entityId: formalTraceGapPlan.id });
  } else if (!planReady) {
    const candidate = plans.find((plan) => plan.lifecycleStatus === "draft" || plan.lifecycleStatus === "rework") ?? plans[0];
    nextAction = action("submit_plan", `提交节点“${node.label}”的开发计划`, "由设计 Agent 提交计划，独立设计审计通过后进入 Main Agent Approver 队列。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: candidate.id });

  } else if (developmentStatus === "已阻塞") {
    nextAction = action("resolve_node_blocker", `解除节点“${node.label}”的阻塞`, node.blockedReason?.trim() || "处理阻塞原因后恢复开发。", "node", nodeHref(diagram.id, node.id, "development"), ids);
  } else if (approvedPlan) {
    nextAction = action("start_development", `开始节点“${node.label}”的施工`, "由施工 Agent 在计划批准后明确开工，形成可追溯的开工事件。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: approvedPlan.id });
  } else if (inProgressPlan) {
    nextAction = action("complete_development", `提交节点“${node.label}”的施工完成`, "Builder 完成编码/施工、开发者测试和实现证据后，提交当前 implementationRevision。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: inProgressPlan.id });
  } else if (developmentStatus !== "已完成" || !plansCompleted) {
    nextAction = action("complete_node_development", `推进节点“${node.label}”的开发`, "按计划执行并完成全部开发动作。", "plan", nodeHref(diagram.id, node.id, "development"), ids);
  } else if (auditFailedPlan) {
    nextAction = action("reopen_rework", `返工节点“${node.label}”`, auditFailedPlan.rejectionReason || "独立审计未通过，施工 Agent 必须按失败原因返工。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: auditFailedPlan.id });
  } else if (pendingAuditPlan) {
    nextAction = action("audit_completed_plan", `审计节点“${node.label}”`, "由独立审计 Agent 复核实现、运行测试并形成关联证据；施工 Agent 不得自审。", "plan", nodeHref(diagram.id, node.id, "delivery"), { ...ids, entityId: pendingAuditPlan.id });
  } else if (pendingManagerPlan) {
    nextAction = action("approve_acceptance", `批准节点“${node.label}”的验收`, "独立审计已通过，等待 Main Agent 领取独立 Approver 工单核验证据并批准验收或退回返工。", "plan", nodeHref(diagram.id, node.id, "delivery"), { ...ids, entityId: pendingManagerPlan.id });
  } else if (acceptanceStatus !== "已通过" && deliveryPlans.some((plan) => plan.lifecycleStatus === "legacy")) {
    const legacyPlan = deliveryPlans.find((plan) => plan.lifecycleStatus === "legacy")!;
    nextAction = action("submit_plan", `补齐节点“${node.label}”的正式交付基线`, "历史计划须补齐设计、独立审计与 Main Agent 批准记录后才能验收。", "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: legacyPlan.id });
  } else if (!evidenceReady && acceptedPlans.length > 0) {
    if (gapPlans.length > 0) {
      const plan = gapPlans.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
      let maxAttempts = 3;
      try {
        maxAttempts = Number((store.db.prepare("SELECT max_attempts FROM agent_task_capacity WHERE project_id=?").get(plan.projectId) as { max_attempts?: number } | undefined)?.max_attempts ?? 3);
      } catch { /* lease schema may not have been initialized yet */ }
      const repair = getEvidenceRepairState(store, plan.id) ?? deriveEvidenceRepairState(plan, maxAttempts);
      if (repair.status === "blocked" || repair.status === "exhausted" || repair.status === "closed" || repair.status === "submitted") {
        nextAction = action("assess_evidence_repair_failure", `评估节点“${node.label}”的证据修复失败`, repair.disposition || "证据修复尝试已耗尽或关闭后再次出现缺口，由 Main Agent 使用独立 approval 工单记录影响分析和处置。", "plan", nodeHref(diagram.id, node.id, "delivery"), { ...ids, entityId: plan.id });
      } else if (repair.status === "assessed" && repair.disposition.startsWith("reset:")) {
        nextAction = action("reset_evidence_repair_attempt", `批准节点“${node.label}”的新一代证据修复`, repair.disposition.slice("reset:".length), "plan", nodeHref(diagram.id, node.id, "delivery"), { ...ids, entityId: plan.id });
      } else if (repair.status === "assessed" && repair.disposition.startsWith("design_change:")) {
        nextAction = action("request_design_change", `发起节点“${node.label}”的设计变更`, repair.disposition.slice("design_change:".length), "plan", nodeHref(diagram.id, node.id, "development"), { ...ids, entityId: plan.id });
      } else {
        nextAction = action("submit_evidence_repair", `修复节点“${node.label}”的验收证据`, "由受派 Builder 在冻结当前实现修订后重跑真实测试并提交精确绑定本计划的证据。", "evidence", nodeHref(diagram.id, node.id, "delivery"), { ...ids, entityId: plan.id });
      }
    }
  } else if (!evidenceReady) {
    nextAction = action("add_node_evidence", `补充节点“${node.label}”的验收证据`, "添加测试报告、截图、接口响应或其他可复核证据。", "evidence", nodeHref(diagram.id, node.id, "delivery"), ids);
  } else if (acceptanceStatus !== "已通过") {
    nextAction = action("accept_node", `验收节点“${node.label}”`, "按照既定标准复核证据并推进为验收通过。", "node", nodeHref(diagram.id, node.id, "delivery"), ids);
  }

  return {
    descriptionReady,
    ownerReady,
    criteriaReady,
    requirementReady,
    documentReady,
    designReady,
    databaseReady,
    planReady,
    plansCompleted,
    evidenceReady,
    state: {
      diagramId: diagram.id,
      diagramTitle: diagram.title,
      nodeId: node.id,
      nodeLabel: node.label,
      requirementStatus,
      designStatus,
      developmentStatus,
      acceptanceStatus,
      requiresDatabase,
      approvedDocumentCount: approvedDocuments.length,
      databaseBindingCount: bindings.length,
      planCount: plans.length,
      completedPlanCount: deliveryPlans.filter((plan) => plan.status === "已完成").length,
      evidenceCount: storedEvidence.length,
      deliveryLayer: null,
      layerLocked: false,
      layerLockReason: "",
      missing,
      nextAction,
    },
  };
}

function phaseForAction(code: string): ProjectWorkflowPhase {
  if (code === "complete_project_summary" || code === "approve_project_brief") return "discovery";
  if (code === "create_main_diagram" || code === "add_function_node") return "functional-design";
  if (code === "complete_node_definition") return "node-definition";
  if (code === "approve_node_requirement") return "requirement-review";
  if (code === "approve_node_document" || code === "approve_node_design" || code === "audit_design" || code === "bind_node_database") return "detailed-design";
  if (["create_node_plan", "submit_plan", "approve_plan"].includes(code)) return "planning";
  if (code === "reopen_rework") return "development";
  if (["audit_completed_plan", "submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "evidence_repair_blocked"].includes(code)) return "verification";
  if (code === "request_design_change") return "detailed-design";
  if (code === "approve_acceptance") return "acceptance";
  if (code === "start_development" || code === "complete_development" || code === "complete_node_development" || code === "resolve_node_blocker") return "development";
  if (code === "add_node_evidence") return "verification";
  if (code === "accept_node") return "acceptance";
  return "completed";
}

export function buildProjectWorkflow(store: Store, projectId: string, input: WorkflowProjectReadData = {}): ProjectWorkflow | undefined {
  const data = loadWorkflowProjectData(store, projectId, input);
  if (!data) return undefined;
  const { project, diagrams } = data;
  const mainDiagram = diagrams.find((diagram) => diagram.type === "main") ?? null;
  const foundation = inspectProjectFoundation(store, projectId, data);
  const diagramById = new Map(diagrams.map((diagram) => [diagram.id, diagram]));
  // Load per-node related data once up front to avoid N+1 queries across every delivery node.
  const bundle = loadWorkflowProjectBundle(store, projectId, data);
  const layerGate = analyzePlanLayers(data.plans);
  const layerStateByPlanId = new Map(layerGate.plans.map((state) => [state.planId, state]));
  const nodeInspections = data.workspaceNodes.flatMap((item) => {
    const diagram = diagramById.get(item.diagramId);
    return diagram ? [inspectNodeWorkflow(store, diagram, item.node, bundle)] : [];
  });
  const nodes = nodeInspections.map((inspection) => {
    const state = inspection.state;
    const plans = (bundle.plansByNode.get(nodeKey(state.diagramId, state.nodeId)) ?? []).filter(isActiveDeliveryPlan);
    const actionPlan = state.nextAction?.entityType === "plan" && state.nextAction.entityId
      ? plans.find((plan) => plan.id === state.nextAction?.entityId)
      : undefined;
    const layerState = actionPlan
      ? layerStateByPlanId.get(actionPlan.id)
      : plans.map((plan) => layerStateByPlanId.get(plan.id)).filter((item) => item !== undefined)
        .sort((left, right) => Number(left.complete) - Number(right.complete) || left.layer - right.layer)[0];
    return {
      ...state,
      deliveryLayer: layerState?.layer ?? null,
      layerLocked: Boolean(layerState?.locked),
      layerLockReason: layerState?.lockReason ?? "",
    };
  });
  let nextAction: ProjectWorkflowAction | null = null;

  if (!project.summary.trim()) {
    nextAction = action("complete_project_summary", "补充项目目标与范围", "明确项目解决什么问题、服务谁、包含什么以及明确不做什么。", "project", `#/projects/${projectId}`, { entityId: projectId });
  } else if (foundation.approvedBriefCount === 0) {
    nextAction = action("approve_project_brief", "创建并批准项目简报", "项目级简报应覆盖目标、现状、范围、约束和成功标准。", "document", `#/projects/${projectId}?tab=documents`, { entityId: projectId });
  } else if (!mainDiagram) {
    nextAction = action("create_main_diagram", "建立系统主画布", "系统主画布是项目唯一入口，用于确定系统、模块和功能边界。", "diagram", "#/canvas", { entityId: projectId });
  } else if (nodes.length === 0) {
    nextAction = action("add_function_node", "拆分模块与功能节点", "从系统主画布开始建立可交付的模块、功能、接口或数据节点。", "diagram", `#/canvas/${mainDiagram.id}`, { entityId: mainDiagram.id, diagramId: mainDiagram.id });
  } else {
    nextAction = layerGate.issues.length > 0 ? null : nodes.find((node) => node.nextAction
      && (!node.layerLocked || isDesignPhaseAction(node.nextAction.code)))?.nextAction ?? null;
  }

  const phase = nextAction ? phaseForAction(nextAction.code) : layerGate.issues.length > 0 ? "planning" : "completed";
  const repairBlocked = ["assess_evidence_repair_failure", "evidence_repair_blocked"].includes(nextAction?.code ?? "");
  const projectBlocked = repairBlocked || Boolean(project.blockerSummary.trim()) || nodeInspections.some((inspection) => inspection.state.developmentStatus === "已阻塞");
  const missing = [
    ...foundation.missing,
    ...(!mainDiagram ? ["系统主画布"] : []),
    ...(nodes.length === 0 ? ["可交付功能节点"] : []),
    ...nodes.flatMap((node) => node.missing.map((item) => `${node.nodeLabel}：${item}`)),
  ];
  const status: ProjectWorkflow["status"] = layerGate.issues.length > 0
    ? "blocked"
    : nextAction
      ? (projectBlocked ? "blocked" : "ready")
      : missing.length > 0 ? "blocked" : "completed";
  const phaseLabel = PROJECT_WORKFLOW_POLICY.phaseLabels[phase];
  const summary = layerGate.issues.length > 0
    ? `计划层级被阻塞：${layerGate.issues[0]}`
    : nextAction
    ? `当前处于“${phaseLabel}”，下一步：${nextAction.title}`
    : missing.length > 0
      ? `工作流存在 ${missing.length} 个未闭合门禁，不能标记 completed。`
      : "项目所有交付节点均已完成开发、证据归档和验收。";

  return {
    policyVersion: PROJECT_WORKFLOW_POLICY.version,
    projectId,
    phase,
    phaseLabel,
    status,
    summary,
    missing,
    nextAction,
    layerGate,
    nodes,
    generatedAt: new Date().toISOString(),
  };
}
