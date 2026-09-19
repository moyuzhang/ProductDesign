import type { PlanItem } from "../shared/types.js";
import { nowIso, type Store } from "./db.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";
import { assertPlanActionIdentity } from "./planRolePolicy.js";
import { assertPlanImplementationUnlocked, assertPlanLayerUnlocked } from "./planLayers.js";
import { hasImplementationEvidence, matchesImplementationEvidencePolicy } from "./evidencePolicy.js";
import { assessEvidenceRepairFailure, getEvidenceRepairState, inspectEvidenceRepairPreflight, openEvidenceRepairState, resetEvidenceRepairAttempt, updateEvidenceRepairState } from "./evidenceRepair.js";
import { inspectNodeWorkflow } from "./workflow.js";

export const PLAN_TRANSITION_ACTIONS = [
  "submit_plan", "pass_design_audit", "fail_design_audit", "approve_plan", "reject_plan", "start_development", "complete_development",
  "pass_audit", "fail_audit", "approve_acceptance", "reject_acceptance", "reopen_rework",
  "submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "accept_node",
] as const;
export type PlanTransitionAction = (typeof PLAN_TRANSITION_ACTIONS)[number];

const ALLOWED: Record<PlanTransitionAction, PlanItem["lifecycleStatus"][]> = {
  submit_plan: ["draft", "rework", "legacy", "approved", "in_progress"],
  pass_design_audit: ["pending_approval"],
  fail_design_audit: ["pending_approval"],
  approve_plan: ["pending_approval"],
  reject_plan: ["pending_approval"],
  start_development: ["approved"],
  complete_development: ["in_progress"],
  pass_audit: ["pending_audit"],
  fail_audit: ["pending_audit"],
  approve_acceptance: ["pending_manager"],
  reject_acceptance: ["pending_manager"],
  reopen_rework: ["audit_failed", "rework"],
  submit_evidence_repair: ["accepted"],
  assess_evidence_repair_failure: ["accepted"],
  reset_evidence_repair_attempt: ["accepted"],
  accept_node: ["accepted"],
};

const LAYER_GATED_ACTIONS = new Set<PlanTransitionAction>([
  "submit_plan", "pass_design_audit", "approve_plan", "start_development", "complete_development",
  "pass_audit", "approve_acceptance", "reopen_rework", "accept_node",
]);
const IMPLEMENTATION_GATED_ACTIONS = new Set<PlanTransitionAction>([
  "start_development", "complete_development", "reopen_rework",
]);

export interface PlanTransitionInput {
  action: PlanTransitionAction;
  actor: string;
  agentId?: string;
  reason?: string;
  implementationRevision?: string;
  correlationId?: string;
  evidenceId?: string;
  testCommand?: string;
  baselineRevision?: string;
  repairDisposition?: "reset" | "design_change";
}

function planDeliveryProjection(siblingPlans: PlanItem[]): Pick<PlanItem, never> & {
  developmentStatus: "未开发" | "开发中" | "已完成";
  acceptanceStatus: "未验收" | "已通过";
} {
  const allDevelopmentCompleted = siblingPlans.length > 0 && siblingPlans.every((item) => item.status === "已完成");
  const allManagerAccepted = siblingPlans.every((item) => item.lifecycleStatus === "accepted" || (item.lifecycleStatus === "legacy" && item.status === "已完成"));
  const anyDevelopmentStarted = siblingPlans.some((item) =>
    item.status !== "未开始"
      || item.progress > 0
      || ["in_progress", "pending_audit", "audit_failed", "pending_manager", "accepted"].includes(item.lifecycleStatus)
  );
  return {
    developmentStatus: allDevelopmentCompleted ? "已完成" : anyDevelopmentStarted ? "开发中" : "未开发",
    acceptanceStatus: allManagerAccepted ? "已通过" : "未验收",
  };
}

function syncBoundNode(store: Store, plan: PlanItem, action: PlanTransitionAction, reason?: string): void {
  if (!plan.diagramId || !plan.diagramNodeId) return;
  const diagram = store.getDiagram(plan.diagramId);
  if (!diagram) return;
  const siblingPlans = store.listPlans(plan.projectId, plan.diagramId, plan.diagramNodeId).filter(isExecutableDeliveryPlan);
  const { developmentStatus, acceptanceStatus } = planDeliveryProjection(siblingPlans);
  let changed = false;
  const nodes = diagram.nodes.map((node) => {
    if (node.id !== plan.diagramNodeId) return node;
    const designStatus = action === "approve_plan"
      ? "已批准"
      : ["submit_plan", "pass_design_audit", "fail_design_audit", "reject_plan"].includes(action)
        ? "待评审"
        : node.designStatus;
    const blockedReason = ["fail_design_audit", "fail_audit", "reject_acceptance", "reopen_rework"].includes(action)
      ? (reason || node.blockedReason || "")
      : ["submit_plan", "approve_plan"].includes(action) && (node.blockedReason?.startsWith("设计审计失败") || node.blockedReason?.startsWith("设计变更处理中"))
        ? ""
        : node.blockedReason;
    changed = node.developmentStatus !== developmentStatus
      || node.acceptanceStatus !== acceptanceStatus
      || node.designStatus !== designStatus
      || node.blockedReason !== blockedReason;
    return changed
      ? { ...node, designStatus, developmentStatus, acceptanceStatus, blockedReason, deliveryUpdatedAt: nowIso() }
      : node;
  });
  if (changed) store.updateDiagram(diagram.id, { nodes });
}

function currentApprovedDesignRevisionIds(store: Store, plan: PlanItem): string[] {
  const nodeReferences = plan.diagramNodeId
    ? store.listDocumentReferences({ projectId: plan.projectId, targetType: "diagramNode", targetId: plan.diagramNodeId })
    : [];
  const planReferences = store.listDocumentReferences({ projectId: plan.projectId, targetType: "plan", targetId: plan.id });
  const references = [...nodeReferences, ...planReferences];
  const planReferenceIds = new Set(planReferences.map((reference) => reference.id));
  return [...new Set(references.flatMap((reference) => {
    const document = store.getDesignDoc(reference.documentId);
    const revision = store.getDocumentRevision(reference.documentRevisionId);
    return document
      && revision
      && revision.projectId === plan.projectId
      && revision.documentId === document.id
      // A plan-level reference is the Designer's explicit submission baseline.
      // It must be auditable before manager approval, so a current review/draft
      // revision is valid here. Inherited node references remain approved-only.
      && (planReferenceIds.has(reference.id) ? revision.status !== "已废弃" : revision.status === "已批准")
      && document.currentRevisionId === revision.id
      ? [revision.id]
      : [];
  }))].sort();
}

function validDesignAuditEvidence(store: Store, plan: PlanItem, resultStatus: "pass" | "fail"): boolean {
  const evidence = store.listEvidence(plan.projectId, plan.diagramNodeId ?? undefined)
    .filter((item) => item.status === "active"
      && item.resultStatus === resultStatus
      && item.planItemId === plan.id
      && item.actorRole === "auditor"
      && item.agentId.trim().toLocaleLowerCase() === plan.roleAssignments.auditor.agentId.trim().toLocaleLowerCase()
      && item.details.auditScope === "design");
  if (plan.designRevisionIds.length === 0) return false;
  return resultStatus === "pass"
    ? plan.designRevisionIds.every((revisionId) => evidence.some((item) => item.documentRevisionId === revisionId))
    : evidence.some((item) => Boolean(item.documentRevisionId && plan.designRevisionIds.includes(item.documentRevisionId)));
}

function validImplementationAuditEvidence(store: Store, plan: PlanItem, resultStatus: "pass" | "fail"): boolean {
  return hasImplementationEvidence(store, plan, { actorRole: "auditor", resultStatus });
}

/** Rebuilds cached node delivery labels from their plan source of truth. */
export function reconcilePlanDeliveryProjections(store: Store): number {
  let changedCount = 0;
  for (const project of store.listProjects()) {
    const groups = new Map<string, PlanItem[]>();
    for (const plan of store.listPlans(project.id)) {
      if (!isExecutableDeliveryPlan(plan) || !plan.diagramId || !plan.diagramNodeId) continue;
      const key = `${plan.diagramId}|${plan.diagramNodeId}`;
      const group = groups.get(key) ?? [];
      group.push(plan);
      groups.set(key, group);
    }
    for (const [key, plans] of groups) {
      const separator = key.indexOf("|");
      const diagramId = key.slice(0, separator);
      const nodeId = key.slice(separator + 1);
      const diagram = store.getDiagram(diagramId);
      if (!diagram) continue;
      const projection = planDeliveryProjection(plans);
      let diagramChanged = false;
      const nodes = diagram.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        if (node.developmentStatus === projection.developmentStatus && node.acceptanceStatus === projection.acceptanceStatus) return node;
        diagramChanged = true;
        return { ...node, ...projection, deliveryUpdatedAt: nowIso() };
      });
      if (diagramChanged) {
        store.updateDiagram(diagram.id, { nodes });
        changedCount += 1;
      }
    }
  }
  return changedCount;
}

export function transitionPlanLifecycle(store: Store, planId: string, input: PlanTransitionInput): PlanItem {
  const plan = store.getPlan(planId);
  if (!plan) throw Object.assign(new Error("计划项不存在"), { statusCode: 404 });
  if (!isExecutableDeliveryPlan(plan)) {
    throw Object.assign(new Error("只有 task 可进入施工交付生命周期；goal、milestone 和 version 仅用于计划层级"), { statusCode: 409 });
  }
  if (!input.actor.trim()) throw Object.assign(new Error("actor 不能为空，审批与审计必须可追溯"), { statusCode: 400 });
  if (!ALLOWED[input.action].includes(plan.lifecycleStatus)) {
    throw Object.assign(new Error(`计划当前为 ${plan.lifecycleStatus}，不能执行 ${input.action}`), { statusCode: 409 });
  }
  if (LAYER_GATED_ACTIONS.has(input.action)) {
    if (IMPLEMENTATION_GATED_ACTIONS.has(input.action)) assertPlanImplementationUnlocked(store, plan);
    else assertPlanLayerUnlocked(store, plan, input.action);
  }
  if (input.action === "submit_plan" && ["approved", "in_progress"].includes(plan.lifecycleStatus) && plan.submittedAt && plan.approvedAt) {
    throw Object.assign(new Error("已完整批准并开工的计划不能重新提交；请继续施工或按正式返工流程处理"), { statusCode: 409 });
  }
  if (input.action === "complete_development" && (!plan.submittedAt || !plan.approvedAt)) {
    throw Object.assign(new Error("施工计划缺少提交或批准痕迹，必须重新提交并经管理员批准后才能完成施工"), { statusCode: 409 });
  }
  assertPlanActionIdentity(plan, input.action, input.agentId);
  if (input.action === "assess_evidence_repair_failure") {
    if (!input.repairDisposition) {
      throw Object.assign(new Error("证据修复失败评估必须明确 repairDisposition=reset 或 design_change"), { statusCode: 400 });
    }
    assessEvidenceRepairFailure(store, plan.id, input.repairDisposition, input.reason?.trim() || "");
    return store.getPlan(plan.id)!;
  }
  if (input.action === "reset_evidence_repair_attempt") {
    resetEvidenceRepairAttempt(store, plan.id, input.reason?.trim() || "Main Agent 已批准新一代证据修复尝试");
    return store.getPlan(plan.id)!;
  }
  const ts = nowIso();
  let patch: Partial<PlanItem>;
  switch (input.action) {
    case "accept_node": {
      const diagram = plan.diagramId ? store.getDiagram(plan.diagramId) : undefined;
      const node = diagram?.nodes.find((item) => item.id === plan.diagramNodeId);
      if (!diagram || !node || !input.agentId?.trim()) {
        throw Object.assign(new Error("节点验收必须由 Main Agent 使用节点绑定的独立 Approver 工单执行"), { statusCode: 409 });
      }
      const siblings = store.listPlans(plan.projectId, diagram.id, node.id).filter(isExecutableDeliveryPlan);
      const missing = inspectNodeWorkflow(store, diagram, node).state.missing.filter((item) => item !== "验收通过");
      if (missing.length || siblings.some((item) => item.lifecycleStatus !== "accepted"
        || item.auditStatus !== "passed" || item.managerDecision !== "approved"
        || !hasImplementationEvidence(store, item, { actorRole: "auditor" }))) {
        throw Object.assign(new Error(`节点验收前必须补齐全部计划的独立审计、Main Agent 批准和当前实现证据${missing.length ? `：${missing.join("、")}` : ""}`), { statusCode: 409 });
      }
      patch = {};
      break;
    }
    case "submit_plan":
      {
        const designRevisionIds = currentApprovedDesignRevisionIds(store, plan);
        if (designRevisionIds.length === 0) {
          throw Object.assign(new Error("提交设计基线前必须关联至少一个当前已批准的设计文档修订"), { statusCode: 409 });
        }
      patch = {
        lifecycleStatus: "pending_approval", proposalRevision: Math.max(1, plan.proposalRevision + 1),
        designRevisionIds,
        proposedBy: input.actor, submittedAt: ts, rejectedBy: "", rejectedAt: "", rejectionReason: "",
        approvedBy: "", approvedAt: "", status: "未开始", progress: 0, completedAt: "", completedBy: "",
        implementationRevision: "", auditStatus: "pending", auditedBy: "", auditedAt: "",
        managerDecision: "pending", managerDecisionBy: "", managerDecisionAt: "",
        correlationId: input.correlationId?.trim() || plan.correlationId || plan.id,
      };
      break;
      }
    case "pass_design_audit":
      if (!validDesignAuditEvidence(store, plan, "pass")) {
        throw Object.assign(new Error("设计审计通过前必须存在由受派审计者创建、auditScope=design 且绑定当前固定文档修订的有效通过证据"), { statusCode: 409 });
      }
      patch = { auditStatus: "passed", auditedBy: input.actor, auditedAt: ts, rejectionReason: "" };
      break;
    case "fail_design_audit":
      if (!input.reason?.trim()) throw Object.assign(new Error("设计审计失败必须填写 reason"), { statusCode: 400 });
      if (!validDesignAuditEvidence(store, plan, "fail")) {
        throw Object.assign(new Error("设计审计失败前必须存在由受派审计者创建、auditScope=design 且绑定当前固定文档修订的有效失败证据"), { statusCode: 409 });
      }
      patch = {
        lifecycleStatus: "rework", auditStatus: "failed", auditedBy: input.actor, auditedAt: ts,
        rejectionReason: `设计审计失败：${input.reason.trim()}`,
      };
      break;
    case "approve_plan":
      if (plan.auditStatus !== "passed") {
        throw Object.assign(new Error("开发计划批准前必须先通过独立设计审计"), { statusCode: 409 });
      }
      if (currentApprovedDesignRevisionIds(store, plan).join("\u001f") !== [...plan.designRevisionIds].sort().join("\u001f")) {
        throw Object.assign(new Error("设计文档已产生新修订或引用已变化，必须由 Designer 重新提交并重新审计"), { statusCode: 409 });
      }
      patch = {
        lifecycleStatus: "approved", approvedBy: input.actor, approvedAt: ts,
        auditStatus: "not_requested", auditedBy: "", auditedAt: "",
      };
      break;
    case "reject_plan":
      if (!input.reason?.trim()) throw Object.assign(new Error("拒绝开发计划必须填写 reason"), { statusCode: 400 });
      patch = {
        lifecycleStatus: "rework", rejectedBy: input.actor, rejectedAt: ts, rejectionReason: input.reason.trim(),
        auditStatus: "not_requested", auditedBy: "", auditedAt: "",
      };
      break;
    case "start_development":
      patch = { lifecycleStatus: "in_progress", status: "进行中", startAt: plan.startAt || ts.slice(0, 10) };
      break;
    case "complete_development":
      if (!input.implementationRevision?.trim() && !plan.implementationRevision.trim()) {
        throw Object.assign(new Error("完成施工必须提供 implementationRevision"), { statusCode: 400 });
      }
      if (plan.reworkOfPlanId) {
        const previous = store.getPlan(plan.reworkOfPlanId);
        if (previous && /^nogit(?:$|[-:_/])/i.test(previous.implementationRevision.trim())) {
          const candidate = input.implementationRevision?.trim() || plan.implementationRevision.trim();
          const verification = inspectEvidenceRepairPreflight(store, { ...plan, implementationRevision: candidate });
          if (!("head" in verification)) {
            throw Object.assign(new Error("历史 nogit 计划的返工 clone 必须提交等于受控仓库 HEAD 的真实实现修订"), {
              statusCode: 409, code: verification.code, details: verification.details,
            });
          }
        }
      }
      patch = {
        lifecycleStatus: "pending_audit", status: "已完成", progress: 100, completedAt: ts,
        completedBy: input.actor, implementationRevision: input.implementationRevision?.trim() || plan.implementationRevision,
        auditStatus: "pending", auditedBy: "", auditedAt: "",
      };
      break;
    case "submit_evidence_repair": {
      const repair = getEvidenceRepairState(store, plan.id);
      if (!repair || repair.status !== "open") {
        throw Object.assign(new Error("证据修复任务不存在、已提交或已耗尽"), { statusCode: 409 });
      }
      if (!input.evidenceId?.trim() || !input.testCommand?.trim() || !input.implementationRevision?.trim()) {
        throw Object.assign(new Error("证据修复必须显式提交 evidenceId、testCommand 和 implementationRevision"), { statusCode: 400 });
      }
      const candidateRevision = input.implementationRevision.trim();
      if (input.baselineRevision?.trim() !== candidateRevision
        || (plan.implementationRevision.trim() && candidateRevision !== plan.implementationRevision.trim())) {
        throw Object.assign(new Error("证据修复提交修订必须与开工冻结基线一致；计划已有实现修订时也必须保持一致"), { statusCode: 409 });
      }
      const evidence = store.getEvidence(input.evidenceId);
      if (!evidence || evidence.command !== input.testCommand
        || !matchesImplementationEvidencePolicy(evidence, plan, { actorRole: "builder", implementationRevision: candidateRevision })) {
        throw Object.assign(new Error("证据修复必须引用受派 Builder 创建的当前实现证据，且 testCommand 必须与 evidence.command 完全一致"), { statusCode: 409 });
      }
      // completedAt 同时是审计任务修订的组成部分（proposalRevision:implementation:completedAt），
      // 必须随本次修复刷新，否则曾被审计过的计划会因修订未变而无法重新派发审计。
      patch = {
        lifecycleStatus: "pending_audit", status: "已完成", progress: 100, completedAt: ts,
        implementationRevision: candidateRevision,
        auditStatus: "pending", auditedBy: "", auditedAt: "",
        managerDecision: "pending", managerDecisionBy: "", managerDecisionAt: "",
      };
      updateEvidenceRepairState(store, plan.id, { status: "submitted", disposition: `evidence:${evidence.id}` });
      break;
    }
    case "pass_audit": {
      const designChange = store.getGovernance(plan.correlationId);
      let currentApprovedRevisionIds: Set<string> | null = null;
      if (designChange?.title.startsWith("设计变更 ·")) {
        let impactedDocumentIds: string[] = [];
        try {
          const content = JSON.parse(designChange.content) as { impactedDocumentIds?: unknown };
          if (Array.isArray(content.impactedDocumentIds)) {
            impactedDocumentIds = [...new Set(content.impactedDocumentIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))];
          }
        } catch { /* invalid governance content is rejected below */ }
        if (impactedDocumentIds.length === 0) {
          throw Object.assign(new Error("设计变更记录缺少受影响文档，不能通过审计"), { statusCode: 409 });
        }
        const scopedReferences = [
          ...(plan.diagramNodeId ? store.listDocumentReferences({ projectId: plan.projectId, targetType: "diagramNode", targetId: plan.diagramNodeId }) : []),
          ...store.listDocumentReferences({ projectId: plan.projectId, targetType: "plan", targetId: plan.id }),
        ];
        currentApprovedRevisionIds = new Set<string>();
        for (const documentId of impactedDocumentIds) {
          const document = store.getDesignDoc(documentId);
          const documentReferences = scopedReferences.filter((reference) => reference.documentId === documentId);
          if (!document || document.projectId !== plan.projectId || document.status !== "已批准"
            || documentReferences.length === 0
            || documentReferences.some((reference) => reference.documentRevisionId !== document.currentRevisionId)) {
            throw Object.assign(new Error("设计变更后的审计必须批准全部受影响文档并刷新其节点/计划引用到当前版本"), { statusCode: 409 });
          }
          currentApprovedRevisionIds.add(document.currentRevisionId);
        }
      }
      const evidence = store.listEvidence(plan.projectId, plan.diagramNodeId ?? undefined)
        .filter((item) => matchesImplementationEvidencePolicy(item, plan, { actorRole: "auditor" })
          && (!currentApprovedRevisionIds || Boolean(item.documentRevisionId && currentApprovedRevisionIds.has(item.documentRevisionId))));
      if (evidence.length === 0) throw Object.assign(new Error("审计通过前必须存在由受派审计者创建并关联本计划的有效通过证据"), { statusCode: 409 });
      patch = { lifecycleStatus: "pending_manager", auditStatus: "passed", auditedBy: input.actor, auditedAt: ts };
      break;
    }
    case "fail_audit":
      if (!input.reason?.trim()) throw Object.assign(new Error("审计失败必须填写 reason"), { statusCode: 400 });
      if (!validImplementationAuditEvidence(store, plan, "fail")) {
        throw Object.assign(new Error("实现审计失败前必须存在由受派审计者创建、auditScope=implementation 且绑定当前实现修订的有效失败证据"), { statusCode: 409 });
      }
      patch = { lifecycleStatus: "audit_failed", auditStatus: "failed", auditedBy: input.actor, auditedAt: ts, rejectionReason: input.reason.trim() };
      break;
    case "approve_acceptance":
      if (!hasImplementationEvidence(store, plan, { actorRole: "auditor" })) {
        throw Object.assign(new Error("最终验收前必须在当前事务内重新确认受派审计者的当前实现通过证据仍然有效"), { statusCode: 409 });
      }
      patch = { lifecycleStatus: "accepted", managerDecision: "approved", managerDecisionBy: input.actor, managerDecisionAt: ts };
      break;
    case "reject_acceptance":
      if (!input.reason?.trim()) throw Object.assign(new Error("拒绝验收必须填写 reason"), { statusCode: 400 });
      patch = {
        lifecycleStatus: "rework", managerDecision: "rejected", managerDecisionBy: input.actor,
        managerDecisionAt: ts, rejectionReason: input.reason.trim(), auditStatus: "not_requested",
      };
      break;
    case "reopen_rework":
      patch = {
        lifecycleStatus: "in_progress", status: "进行中", progress: Math.min(plan.progress, 99), completedAt: "",
        auditStatus: "not_requested", managerDecision: "pending", managerDecisionBy: "", managerDecisionAt: "",
      };
      break;
  }
  const updated = store.updatePlan(plan.id, patch)!;
  if (input.action === "approve_acceptance") {
    const repair = getEvidenceRepairState(store, plan.id);
    if (repair?.status === "submitted") updateEvidenceRepairState(store, plan.id, { status: "closed", disposition: "accepted" });
    else if (!repair && updated.diagramId && updated.diagramNodeId) openEvidenceRepairState(store, updated, 3);
  }
  syncBoundNode(store, updated, input.action, input.reason);
  return updated;
}
