import { recordDesignChangeLineage } from "./designChangeLineage.js";
import { createHash } from "node:crypto";
import type {
  DesignChangeRequest,
  DesignChangeResult,
  DiagramNode,
  Evidence,
  PlanItem,
} from "../shared/types.js";
import { assertApprovalGroupCurrent, approvalGroupLeases, ensureAgentTaskLeaseSchema, listClaimableAgentTasks, releaseAgentTaskLeasesForDesignChange } from "./agentTaskLeases.js";
import { normalizeAgentId } from "../shared/planRoles.js";
import { newId, nowIso, type Store } from "./db.js";
import { isActiveDeliveryPlan } from "./planPolicy.js";
import { reconcilePlanDeliveryProjections } from "./planLifecycle.js";
import { buildProjectWorkflow, isWorkflowDeliveryNode } from "./workflow.js";
import { getEvidenceRepairState, supersedeEvidenceRepairStates } from "./evidenceRepair.js";
import { designChangeImpactedPlanIds, getDesignGap } from "./designGap.js";
import {
  assertDesignChangeIntentCurrent,
  finishDesignChangeIntent,
  getDesignChangeIntent,
} from "./designChangeIntent.js";
import {
  assertAgentWorkOrderContext,
  isAgentSecurityEnforced,
  resolveAuthPrincipal,
} from "./agentSecurity.js";

export interface DesignChangeContext {
  source: "web" | "mcp" | "system";
  /** Present for Agent calls, even when their supplied fields are missing. */
  agent?: DesignChangeAgentContext;
  scopeApprovals?: DesignChangeAgentContext[];
  securityAction?: string;
  securityTarget?: string;
}

export type DesignChangeAgentContext = Partial<Record<
  "workOrderId" | "leaseToken" | "taskKey" | "taskRevision" | "workerId" | "agentId" | "role"
  | "authSessionToken" | "policyAckToken" | "nonceId", string
>>;

export class DesignChangeError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "DesignChangeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

function normalizedDesignChangePayload(input: DesignChangeRequest, context: DesignChangeContext): DesignChangeRequest {
  return {
    intentId: input.intentId?.trim() || undefined,
    projectId: input.projectId.trim(),
    diagramId: input.diagramId.trim(),
    nodeId: input.nodeId.trim(),
    actor: context.agent?.agentId?.trim() || input.actor.trim(),
    reason: input.reason.trim(),
    changeSummary: input.changeSummary.trim(),
    requirementImpact: input.requirementImpact,
    impactedDocumentIds: [...new Set(input.impactedDocumentIds.map((id) => id.trim()))].sort(),
    impactedPlanIds: [...new Set(input.impactedPlanIds.map((id) => id.trim()))].sort(),
    reusableWorkSummary: input.reusableWorkSummary.trim(),
    reworkScope: input.reworkScope.trim(),
    apiImpact: input.apiImpact.trim(),
    databaseImpact: input.databaseImpact.trim(),
    deploymentImpact: input.deploymentImpact.trim(),
    reusableEvidenceIds: [...new Set((input.reusableEvidenceIds ?? []).map((id) => id.trim()))].sort(),
    expectedUpdatedAt: input.expectedUpdatedAt.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    clientId: input.clientId?.trim() || undefined,
    sessionId: input.sessionId?.trim() || undefined,
    model: input.model?.trim() || undefined,
  };
}

function requestHash(input: DesignChangeRequest, context: DesignChangeContext): string {
  const approvals = context.agent ? [context.agent, ...(context.scopeApprovals ?? [])] : [];
  const identities = approvals.map((agent) =>
    [agent.workOrderId, agent.taskKey, agent.taskRevision, agent.workerId, agent.agentId, agent.role]).sort();
  const payload = normalizedDesignChangePayload(input, context);
  return createHash("sha256").update(JSON.stringify(approvals.length ? { input: payload, identities } : payload)).digest("hex");
}

export function designChangeBodyDigest(input: DesignChangeRequest, context: DesignChangeContext): string {
  const approvals = [context.agent!, ...(context.scopeApprovals ?? [])].map((approval) => ({
    workOrderId: approval.workOrderId,
    taskKey: approval.taskKey,
    taskRevision: approval.taskRevision,
    workerId: approval.workerId,
    agentId: approval.agentId,
    role: approval.role,
  })).sort((a, b) => String(a.workOrderId).localeCompare(String(b.workOrderId)));
  const payload = normalizedDesignChangePayload(input, context);
  return createHash("sha256").update(JSON.stringify({ intentId: payload.intentId ?? "", payload, scopeIdentities: approvals })).digest("hex");
}

function approvalBodyDigest(action: string, payload: unknown, context: DesignChangeContext): string {
  const approvals = [context.agent!, ...(context.scopeApprovals ?? [])].map((approval) => ({
    workOrderId: approval.workOrderId, taskKey: approval.taskKey, taskRevision: approval.taskRevision,
    workerId: approval.workerId, agentId: approval.agentId, role: approval.role,
  })).sort((a, b) => String(a.workOrderId).localeCompare(String(b.workOrderId)));
  return createHash("sha256").update(JSON.stringify({ action, payload, scopeIdentities: approvals })).digest("hex");
}

function assertEnrolledApprovalProofs(
  store: Store,
  input: DesignChangeRequest,
  context: DesignChangeContext,
  replay: boolean,
  digestOverride?: string,
): void {
  const approvals = [context.agent!, ...(context.scopeApprovals ?? [])];
  const digest = digestOverride ?? designChangeBodyDigest(input, context);
  const action = context.securityAction ?? "mcp.request_design_change";
  const target = context.securityTarget ?? "mcp:request_design_change";
  for (const approval of approvals) {
    if (!isAgentSecurityEnforced(store, approval.agentId)) continue;
    if (!approval.authSessionToken?.trim()) {
      throw new DesignChangeError(401, "AUTH_REQUIRED", "已登记审批身份必须提供有效 authSessionToken");
    }
    const principal = resolveAuthPrincipal(store, approval.authSessionToken);
    if (principal.agentId !== approval.agentId || principal.workerId !== approval.workerId
      || !principal.allowedRoles.includes("approver") || !principal.allowedProjects.includes(input.projectId)) {
      throw new DesignChangeError(403, "PRINCIPAL_SPOOF_REJECTED", "认证主体与审批工单身份或项目范围不一致");
    }
    if (replay) continue;
    if (!approval.policyAckToken?.trim() || !approval.nonceId?.trim()) {
      throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "已登记审批身份首写必须为每张范围工单提供 policyAckToken 和 nonceId");
    }
    assertAgentWorkOrderContext(store, {
      policyAckToken: approval.policyAckToken,
      workOrderId: approval.workOrderId,
      leaseToken: approval.leaseToken,
      taskKey: approval.taskKey,
      taskRevision: approval.taskRevision,
      nonceId: approval.nonceId,
      idempotencyKey: input.idempotencyKey,
      agentId: approval.agentId,
      workerId: approval.workerId,
      role: "approver",
      connectionId: principal.connectionId,
      projectId: input.projectId,
      action,
      target,
      bodyDigest: digest,
    });
  }
}

function assertMainAgentDesignChange(
  store: Store, input: DesignChangeRequest, context: DesignChangeContext, replayLastError?: string,
): void {
  const approvals = [context.agent!, ...(context.scopeApprovals ?? [])];
  const fields = ["workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "role"] as const;
  if (approvals.some((approval) => fields.some((field) => !approval[field]?.trim()))) {
    throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "主 Agent 设计变更必须携带完整工单与租约上下文");
  }
  if (approvals.some((approval) => approval.role !== "approver")) {
    throw new DesignChangeError(403, "MAIN_AGENT_REQUIRED", "只有持有独立 approver 工单的主 Agent 可以发起设计变更");
  }
  if (new Set(approvals.map((approval) => approval.workOrderId)).size !== approvals.length) {
    throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "同一设计变更不能重复使用同一审批工单");
  }
  const leases = approvals.map((approval) => {
    const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
      .get(approval.workOrderId, approval.leaseToken) as Record<string, string> | undefined;
    if (!lease || lease.project_id !== input.projectId || lease.task_key !== approval.taskKey
      || lease.task_revision !== approval.taskRevision || lease.worker_id !== approval.workerId
      || lease.agent_id !== approval.agentId || lease.role !== "approver" || lease.queue !== "approval") {
      throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "工单、主体、角色、项目或修订不匹配");
    }
    if (lease.action_code !== "request_design_change") {
      throw new DesignChangeError(409, "ACTION_MISMATCH", "request_design_change 必须使用同名独立 approval 工单，其他审批租约不得复用");
    }
    return { approval, lease };
  });
  // A successful change invalidates its own approval lease. Only that exact
  // committed response may be recovered; it does not authorize another write.
  if (replayLastError && leases.every(({ lease }) => lease.status === "released" && lease.last_error === replayLastError)) return;
  if (leases.some(({ lease }) => !["claimed", "running"].includes(lease.status) || lease.lease_expires_at <= nowIso())) {
    throw new DesignChangeError(409, "LEASE_LOST", "设计变更工单已结束或租约已过期");
  }
  const impactedPlans = input.impactedPlanIds.flatMap((planId) => {
    const plan = store.getPlan(planId);
    return plan ? [plan] : [];
  });
  const gapEntry = impactedPlans.map((plan) => ({ plan, gap: getDesignGap(store, plan) })).find((item) => item.gap);
  if (input.intentId) {
    const intent = assertDesignChangeIntentCurrent(store, input.intentId, input.projectId);
    if (intent.impactedPlanIds.slice().sort().join("\u001f") !== input.impactedPlanIds.slice().sort().join("\u001f")) {
      throw new DesignChangeError(409, "DESIGN_CHANGE_INTENT_SCOPE_MISMATCH", "正式变更范围与冻结意图闭包不一致");
    }
  } else if (!gapEntry) {
    const repairPlanId = leases[0].lease.task_id.slice(leases[0].lease.task_id.indexOf(":") + 1);
    const repair = getEvidenceRepairState(store, repairPlanId);
    if (!repair || repair.status !== "assessed" || !repair.disposition.startsWith("design_change:")) {
      throw new DesignChangeError(409, "EVIDENCE_REPAIR_ASSESSMENT_REQUIRED", "证据修复必须先由独立 assessment 工单记录设计变更影响和处置");
    }
  }
  const expectedScopes = new Set(impactedPlans.map((plan) => `node:${plan.diagramId}:${plan.diagramNodeId}`));
  if (!expectedScopes.has(`node:${input.diagramId}:${input.nodeId}`)) {
    throw new DesignChangeError(403, "DESIGN_CHANGE_SCOPE_MISMATCH", "设计变更根节点不属于受影响计划范围");
  }
  const approvedScopes = new Set<string>();
  for (const { lease } of leases) {
    const scopes = JSON.parse(lease.work_scopes_json) as string[];
    const planId = lease.task_id.slice(lease.task_id.indexOf(":") + 1);
    const plan = impactedPlans.find((item) => item.id === planId);
    if (!plan || !scopes.includes(`node:${plan.diagramId}:${plan.diagramNodeId}`)
      || scopes.some((scope) => !expectedScopes.has(scope))) {
      throw new DesignChangeError(403, "DESIGN_CHANGE_SCOPE_MISMATCH", "设计变更审批工单必须精确属于一个受影响节点");
    }
    scopes.forEach((scope) => approvedScopes.add(scope));
  }
  const missingScopes = [...expectedScopes].filter((scope) => !approvedScopes.has(scope));
  if (missingScopes.length) {
    throw new DesignChangeError(409, "CROSS_NODE_APPROVAL_REQUIRED", `以下受影响节点仍缺独立审批工单：${missingScopes.join(",")}`);
  }
  const grouped = leases.find(({ lease }) => lease.approval_group_id);
  if (grouped) {
    const groupLease = { approvalGroupId: grouped.lease.approval_group_id, projectId: input.projectId,
      agentId: grouped.lease.agent_id, workerId: grouped.lease.worker_id } as Parameters<typeof approvalGroupLeases>[1];
    const members = approvalGroupLeases(store, groupLease);
    if (members.length !== leases.length || leases.some(({ lease }) => lease.approval_group_id !== grouped.lease.approval_group_id)
      || members.some((member) => !approvals.some((approval) => approval.workOrderId === member.workOrderId))) {
      throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "必须提交同一审批组的完整范围租约");
    }
    assertApprovalGroupCurrent(store, groupLease);
  }
  const claimable = listClaimableAgentTasks(store, input.projectId);
  for (const { approval, lease } of leases) {
    const task = claimable.find((item) => item.taskKey === lease.task_key);
    if (!task || task.taskRevision !== lease.task_revision || task.requiredRole !== "approver"
      || normalizeAgentId(task.assignee?.agentId ?? "") !== normalizeAgentId(approval.agentId!)) {
      throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "主 Agent 工单已离开当前队列或修订已变化");
    }
  }
  const identities = approvals.flatMap((approval) => [approval.agentId!, approval.workerId!]).map(normalizeAgentId);
  for (const planId of input.impactedPlanIds) {
    const plan = store.getPlan(planId);
    const producers = store.db.prepare(`SELECT agent_id, worker_id FROM agent_task_leases
      WHERE project_id=? AND task_id IN (?, ?, ?)`).all(input.projectId,
        `design:${planId}`, `development:${planId}`, `audit:${planId}`) as Array<{ agent_id: string; worker_id: string }>;
    const producerIds = [
      ...Object.values(plan?.roleAssignments ?? {}).map((assignment) => assignment.agentId),
      ...producers.flatMap((producer) => [producer.agent_id, producer.worker_id]),
    ].filter(Boolean).map(normalizeAgentId);
    if (producerIds.some((id) => identities.includes(id))) {
      throw new DesignChangeError(403, "SELF_APPROVAL_FORBIDDEN", "主 Agent 不能使用设计、施工或审计生产身份发起此变更");
    }
  }
}

function ensureSchema(store: Store): void {
  ensureAgentTaskLeaseSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS design_change_requests (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      change_id TEXT NOT NULL UNIQUE,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DesignChangeError(400, "DESIGN_CHANGE_FIELD_REQUIRED", `${label}不能为空`);
  return normalized;
}

function reworkPatch(plan: PlanItem, changeId: string, reason: string): Partial<PlanItem> {
  return {
    lifecycleStatus: "rework",
    status: "未开始",
    progress: 0,
    proposalRevision: Math.max(1, plan.proposalRevision + 1),
    proposedBy: "",
    submittedAt: "",
    approvedBy: "",
    approvedAt: "",
    rejectedBy: "design_change",
    rejectedAt: nowIso(),
    rejectionReason: `设计变更 ${changeId}：${reason}`,
    blockedReason: `设计变更处理中 · ${changeId}`,
    completedAt: "",
    implementationRevision: "",
    completedBy: "",
    auditStatus: "not_requested",
    auditedBy: "",
    auditedAt: "",
    managerDecision: "pending",
    managerDecisionBy: "",
    managerDecisionAt: "",
    correlationId: changeId,
  };
}

function cloneAcceptedPlan(store: Store, plan: PlanItem, changeId: string, reason: string): PlanItem {
  const historicalNogit = /^nogit(?:$|[-:_/])/i.test(plan.implementationRevision.trim());
  const clone = store.insertPlan({
    projectId: plan.projectId,
    diagramId: plan.diagramId,
    diagramNodeId: plan.diagramNodeId,
    parentId: plan.parentId,
    kind: plan.kind,
    title: `${plan.title} · 设计变更返工`,
    description: `${plan.description}\n\n设计变更 ${changeId}：${reason}${historicalNogit
      ? "\n历史实现标签 nogit 仅保留在旧 accepted 计划；本 clone 无实现基线，Builder 完工必须提交等于受控仓库 HEAD 的真实修订。"
      : ""}`.trim(),
    status: "未开始",
    priority: plan.priority,
    progress: 0,
    owner: plan.owner,
    roleAssignments: plan.roleAssignments,
    versionTag: plan.versionTag,
    startAt: "",
    dueAt: plan.dueAt,
    dependencyIds: plan.dependencyIds,
    blockedReason: `设计变更处理中 · ${changeId}`,
    completedAt: "",
    lifecycleStatus: "rework",
    proposalRevision: Math.max(1, plan.proposalRevision + 1),
    proposedBy: "",
    submittedAt: "",
    approvedBy: "",
    approvedAt: "",
    rejectedBy: "design_change",
    rejectedAt: nowIso(),
    rejectionReason: `设计变更 ${changeId}：${reason}`,
    implementationRevision: "",
    completedBy: "",
    auditStatus: "not_requested",
    auditedBy: "",
    auditedAt: "",
    managerDecision: "pending",
    managerDecisionBy: "",
    managerDecisionAt: "",
    reworkOfPlanId: plan.id,
    correlationId: changeId,
  });
  for (const reference of store.listDocumentReferences({ projectId: plan.projectId, targetType: "plan", targetId: plan.id })) {
    store.insertDocumentReference({
      projectId: reference.projectId,
      documentId: reference.documentId,
      documentRevisionId: reference.documentRevisionId,
      targetType: "plan",
      targetId: clone.id,
      relationType: reference.relationType,
    });
  }
  return clone;
}

function currentNode(store: Store, diagramId: string, nodeId: string): { diagramUpdatedAt: string; node: DiagramNode } {
  const diagram = store.getDiagram(diagramId);
  if (!diagram) throw new DesignChangeError(404, "DIAGRAM_NOT_FOUND", "画布不存在");
  const node = diagram.nodes.find((item) => item.id === nodeId);
  if (!node) throw new DesignChangeError(404, "NODE_NOT_FOUND", "节点不存在");
  return { diagramUpdatedAt: diagram.updatedAt, node };
}

export function requestDesignChange(
  store: Store,
  rawInput: DesignChangeRequest,
  context: DesignChangeContext,
): DesignChangeResult {
  ensureSchema(store);
  return store.db.transaction(() => requestDesignChangeInTransaction(store, rawInput, context)).immediate();
}

export interface DismissDesignChangeIntentInput {
  projectId: string;
  intentId: string;
  reason: string;
  idempotencyKey: string;
}

export function dismissDesignChangeIntentBodyDigest(
  input: DismissDesignChangeIntentInput,
  context: DesignChangeContext,
): string {
  return approvalBodyDigest("dismiss_design_change_intent", input, context);
}

function intentRequestForApproval(
  store: Store,
  input: DismissDesignChangeIntentInput,
): DesignChangeRequest {
  const intent = assertDesignChangeIntentCurrent(store, input.intentId, input.projectId);
  const root = store.getPlan(intent.rootPlanId);
  const diagram = root?.diagramId ? store.getDiagram(root.diagramId) : undefined;
  if (!root?.diagramId || !root.diagramNodeId || !diagram) {
    throw new DesignChangeError(409, "DESIGN_CHANGE_INTENT_STALE", "变更意图根计划或画布已失效");
  }
  return {
    intentId: intent.intentId,
    projectId: input.projectId,
    diagramId: root.diagramId,
    nodeId: root.diagramNodeId,
    actor: contextActorPlaceholder,
    reason: intent.reason,
    changeSummary: intent.changeSummary,
    requirementImpact: false,
    impactedDocumentIds: intent.impactedDocumentIds,
    impactedPlanIds: intent.impactedPlanIds,
    reusableWorkSummary: "",
    reworkScope: input.reason,
    apiImpact: "",
    databaseImpact: "",
    deploymentImpact: "",
    reusableEvidenceIds: [],
    expectedUpdatedAt: diagram.updatedAt,
    idempotencyKey: input.idempotencyKey,
  };
}

const contextActorPlaceholder = "validated-approver";

function releaseIntentApprovalLeases(store: Store, projectId: string, context: DesignChangeContext, marker: string): void {
  const now = nowIso();
  for (const approval of [context.agent!, ...(context.scopeApprovals ?? [])]) {
    store.db.prepare(`UPDATE agent_task_leases SET status='released', last_error=?, completed_at=?, updated_at=?
      WHERE id=? AND lease_token=? AND status IN ('claimed','running')`)
      .run(marker, now, now, approval.workOrderId, approval.leaseToken);
    store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(approval.leaseToken);
    store.db.prepare("UPDATE agent_task_workspace_reservations SET status='released', updated_at=? WHERE lease_token=?")
      .run(now, approval.leaseToken);
    store.db.prepare(`UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=?
      WHERE project_id=? AND lower(worker_id)=lower(?)`).run(now, now, projectId, approval.workerId);
  }
}

export function dismissDesignChangeIntent(
  store: Store,
  raw: DismissDesignChangeIntentInput,
  context: DesignChangeContext,
): { intentId: string; status: "dismissed"; authorizesImplementation: false; dismissedAt: string } {
  ensureSchema(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS design_change_intent_dismissals (
    project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id, idempotency_key)
  )`);
  const input: DismissDesignChangeIntentInput = {
    projectId: required(raw.projectId, "projectId"), intentId: required(raw.intentId, "intentId"),
    reason: required(raw.reason, "reason"), idempotencyKey: required(raw.idempotencyKey, "idempotencyKey"),
  };
  if (!context.agent) throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "驳回变更意图必须使用对应独立审批工单");
  const identities = [context.agent, ...(context.scopeApprovals ?? [])].map((approval) =>
    [approval.workOrderId, approval.taskKey, approval.taskRevision, approval.workerId, approval.agentId, approval.role]).sort();
  const requestHashValue = createHash("sha256").update(JSON.stringify({ input, identities })).digest("hex");
  return store.db.transaction(() => {
    const cached = store.db.prepare("SELECT request_hash, response_json FROM design_change_intent_dismissals WHERE project_id=? AND idempotency_key=?")
      .get(input.projectId, input.idempotencyKey) as IdempotencyRow | undefined;
    if (cached) {
      if (cached.request_hash !== requestHashValue) throw new DesignChangeError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同驳回请求");
      const request = intentRequestForApprovalReplay(store, input);
      assertMainAgentDesignChange(store, request, context, `design_change_intent_dismissed:${input.intentId}`);
      assertEnrolledApprovalProofs(store, request, context, true,
        dismissDesignChangeIntentBodyDigest(input, context));
      return JSON.parse(cached.response_json) as { intentId: string; status: "dismissed"; authorizesImplementation: false; dismissedAt: string };
    }
    const request = intentRequestForApproval(store, input);
    assertMainAgentDesignChange(store, request, context);
    assertEnrolledApprovalProofs(store, request, context, false,
      dismissDesignChangeIntentBodyDigest(input, context));
    finishDesignChangeIntent(store, input.intentId, "dismissed");
    releaseIntentApprovalLeases(store, input.projectId, context, `design_change_intent_dismissed:${input.intentId}`);
    const response = { intentId: input.intentId, status: "dismissed" as const, authorizesImplementation: false as const, dismissedAt: nowIso() };
    store.db.prepare(`INSERT INTO design_change_intent_dismissals
      (project_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.projectId, input.idempotencyKey, requestHashValue, JSON.stringify(response), response.dismissedAt);
    store.recordAudit({
      projectId: input.projectId, entityType: "designChangeIntent", entityId: input.intentId,
      action: "dismiss_design_change_intent", before: { status: "pending" }, after: response,
      actor: context.agent!.agentId || "approver", source: context.source,
      correlationId: `design-change-intent:${input.intentId}`,
    });
    return response;
  }).immediate();
}

function intentRequestForApprovalReplay(store: Store, input: DismissDesignChangeIntentInput): DesignChangeRequest {
  const intent = getDesignChangeIntent(store, input.intentId);
  if (!intent || intent.status !== "dismissed") throw new DesignChangeError(409, "DESIGN_CHANGE_INTENT_NOT_PENDING", "变更意图驳回结果不存在");
  const root = store.getPlan(intent.context.rootPlanId);
  const diagram = root?.diagramId ? store.getDiagram(root.diagramId) : undefined;
  if (!root?.diagramId || !root.diagramNodeId || !diagram) throw new DesignChangeError(409, "DESIGN_CHANGE_INTENT_STALE", "变更意图根计划或画布已失效");
  return {
    intentId: input.intentId, projectId: input.projectId, diagramId: root.diagramId, nodeId: root.diagramNodeId,
    actor: contextActorPlaceholder, reason: intent.context.reason, changeSummary: intent.context.changeSummary,
    requirementImpact: false, impactedDocumentIds: intent.context.impactedDocumentIds,
    impactedPlanIds: intent.context.impactedPlanIds, reusableWorkSummary: "", reworkScope: input.reason,
    apiImpact: "", databaseImpact: "", deploymentImpact: "", reusableEvidenceIds: [],
    expectedUpdatedAt: diagram.updatedAt, idempotencyKey: input.idempotencyKey,
  };
}

function requestDesignChangeInTransaction(
  store: Store, rawInput: DesignChangeRequest, context: DesignChangeContext,
): DesignChangeResult {
  const input: DesignChangeRequest = {
    ...rawInput,
    intentId: rawInput.intentId?.trim() || undefined,
    actor: required(rawInput.actor, "actor"),
    reason: required(rawInput.reason, "错误原因"),
    changeSummary: required(rawInput.changeSummary, "变更摘要"),
    reusableWorkSummary: rawInput.reusableWorkSummary.trim(),
    reworkScope: required(rawInput.reworkScope, "返工范围"),
    apiImpact: rawInput.apiImpact.trim(),
    databaseImpact: rawInput.databaseImpact.trim(),
    deploymentImpact: rawInput.deploymentImpact.trim(),
    impactedDocumentIds: [...new Set(rawInput.impactedDocumentIds)],
    impactedPlanIds: [...new Set(rawInput.impactedPlanIds)],
    reusableEvidenceIds: [...new Set(rawInput.reusableEvidenceIds ?? [])],
    expectedUpdatedAt: required(rawInput.expectedUpdatedAt, "expectedUpdatedAt"),
    idempotencyKey: required(rawInput.idempotencyKey, "idempotencyKey"),
  };
  if (input.impactedDocumentIds.length === 0) {
    throw new DesignChangeError(400, "IMPACTED_DOCUMENT_REQUIRED", "至少选择一份受影响文档");
  }
  if (input.impactedPlanIds.length === 0) {
    throw new DesignChangeError(400, "IMPACTED_PLAN_REQUIRED", "至少选择一个受影响计划");
  }
  if (input.intentId && !context.agent) {
    throw new DesignChangeError(409, "WORK_ORDER_CONTEXT_INVALID", "变更意图必须使用对应的完整独立审批工单");
  }
  // The recorded actor is derived from the validated lease for Agent calls.
  if (context.agent) input.actor = context.agent.agentId || "Agent";
  const hash = requestHash(input, context);
  const cached = store.db.prepare(
    "SELECT request_hash, response_json FROM design_change_requests WHERE idempotency_key = ?",
  ).get(input.idempotencyKey) as IdempotencyRow | undefined;
  if (context.agent) {
    const replay = cached?.request_hash === hash ? JSON.parse(cached.response_json) as DesignChangeResult : undefined;
    assertMainAgentDesignChange(store, input, context, replay ? `design_change:${replay.changeId}` : undefined);
    if (replay) assertEnrolledApprovalProofs(store, input, context, true);
  }
  if (cached) {
    if (cached.request_hash !== hash) {
      throw new DesignChangeError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同的设计变更请求");
    }
    return JSON.parse(cached.response_json) as DesignChangeResult;
  }

  const project = store.getProject(input.projectId);
  if (!project) throw new DesignChangeError(404, "PROJECT_NOT_FOUND", "项目不存在");
  const diagram = store.getDiagram(input.diagramId);
  if (!diagram || diagram.projectId !== project.id) {
    throw new DesignChangeError(409, "DIAGRAM_PROJECT_MISMATCH", "画布不存在或不属于当前项目");
  }
  const node = diagram.nodes.find((item) => item.id === input.nodeId);
  if (!node) throw new DesignChangeError(404, "NODE_NOT_FOUND", "节点不存在");
  if (!isWorkflowDeliveryNode(diagram, node)) {
    throw new DesignChangeError(409, "NODE_NOT_DELIVERABLE", "只有非流程图交付节点可以发起设计变更");
  }
  if (diagram.updatedAt !== input.expectedUpdatedAt) {
    throw new DesignChangeError(409, "DIAGRAM_REVISION_CONFLICT", "画布已变化，请刷新影响预览后重试");
  }

  const plans = input.impactedPlanIds.map((id) => store.getPlan(id));
  if (plans.some((plan) => !plan || plan.projectId !== project.id || !isActiveDeliveryPlan(plan))) {
    throw new DesignChangeError(409, "PLAN_SCOPE_MISMATCH", "受影响计划不存在、跨项目或不是可施工 task");
  }
  const typedPlans = plans as PlanItem[];
  const rootPlanIds = typedPlans.filter((plan) => plan.diagramId === diagram.id && plan.diagramNodeId === node.id).map((plan) => plan.id);
  if (rootPlanIds.length === 0) {
    throw new DesignChangeError(409, "PLAN_SCOPE_MISMATCH", "受影响计划必须至少包含当前节点的一张根计划");
  }
  const projectPlans = store.listPlans(project.id).filter(isActiveDeliveryPlan);
  const reportedGap = typedPlans.map((plan) => getDesignGap(store, plan)).find(Boolean);
  const requiredClosure = designChangeImpactedPlanIds(projectPlans, reportedGap?.impactedPlanIds ?? rootPlanIds);
  const requestedPlanIds = [...input.impactedPlanIds].sort();
  if (requiredClosure.join("\u001f") !== requestedPlanIds.join("\u001f")) {
    const missing = requiredClosure.filter((id) => !requestedPlanIds.includes(id));
    const extra = requestedPlanIds.filter((id) => !requiredClosure.includes(id));
    throw new DesignChangeError(409, "IMPACTED_PLAN_CLOSURE_MISMATCH",
      `受影响计划必须等于服务端计算的传递依赖闭包；缺少=${missing.join(",") || "无"}；多余=${extra.join(",") || "无"}`);
  }
  const allowedPlanStates = new Set(["draft", "pending_approval", "approved", "in_progress", "pending_audit", "audit_failed", "pending_manager", "accepted", "rework"]);
  if (typedPlans.some((plan) => !allowedPlanStates.has(plan.lifecycleStatus))) {
    throw new DesignChangeError(409, "PLAN_STATE_UNSUPPORTED", "受影响计划包含不支持设计返工的生命周期状态");
  }
  const impactedNodeIds = new Set([node.id, ...typedPlans.map((plan) => plan.diagramNodeId).filter((id): id is string => Boolean(id))]);
  const references = [
    ...[...impactedNodeIds].flatMap((nodeId) => store.listDocumentReferences({ projectId: project.id, targetType: "diagramNode", targetId: nodeId })),
    ...typedPlans.flatMap((plan) => store.listDocumentReferences({ projectId: project.id, targetType: "plan", targetId: plan.id })),
  ];
  const referencedDocumentIds = new Set(references.map((reference) => reference.documentId));
  const documents = input.impactedDocumentIds.map((id) => store.getDesignDoc(id));
  if (documents.some((document) => !document || document.projectId !== project.id || !referencedDocumentIds.has(document.id))) {
    throw new DesignChangeError(409, "DOCUMENT_SCOPE_MISMATCH", "受影响文档不存在、跨项目或未被当前节点/计划引用");
  }
  let correctsChangeId: string | undefined;
  if (input.intentId) {
    const intent = assertDesignChangeIntentCurrent(store, input.intentId, project.id);
    correctsChangeId = intent.correctsChangeId;
    if (correctsChangeId && !input.requirementImpact) throw new DesignChangeError(409, "CORRECTION_REQUIREMENT_IMPACT_REQUIRED", "需求影响更正必须经独立审批明确确认存在需求影响");
    if (!rootPlanIds.includes(intent.rootPlanId) || intent.reason !== input.reason || intent.changeSummary !== input.changeSummary
      || intent.impactedDocumentIds.slice().sort().join("\u001f") !== input.impactedDocumentIds.slice().sort().join("\u001f")) {
      throw new DesignChangeError(409, "DESIGN_CHANGE_INTENT_PAYLOAD_MISMATCH", "正式变更业务内容与冻结意图不一致");
    }
  }
  const reusableEvidence = new Set(input.reusableEvidenceIds);
  const allImpactedEvidence = store.listEvidence(project.id)
    .filter((item) => Boolean(item.planItemId && input.impactedPlanIds.includes(item.planItemId)) || item.nodeId === node.id);
  if ([...reusableEvidence].some((id) => !allImpactedEvidence.some((item) => item.id === id && item.status === "active"))) {
    throw new DesignChangeError(409, "EVIDENCE_SCOPE_MISMATCH", "指定保留的证据不存在、不属于受影响计划/节点或已失效");
  }

  return store.db.transaction(() => {
    const concurrentReplay = store.db.prepare(
      "SELECT request_hash, response_json FROM design_change_requests WHERE idempotency_key = ?",
    ).get(input.idempotencyKey) as IdempotencyRow | undefined;
    if (concurrentReplay) {
      if (concurrentReplay.request_hash !== hash) {
        throw new DesignChangeError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同的设计变更请求");
      }
      return JSON.parse(concurrentReplay.response_json) as DesignChangeResult;
    }
    const latest = currentNode(store, diagram.id, node.id);
    if (latest.diagramUpdatedAt !== input.expectedUpdatedAt) {
      throw new DesignChangeError(409, "DIAGRAM_REVISION_CONFLICT", "画布已变化，请刷新影响预览后重试");
    }
    // Revalidate frozen source/scope under the same write transaction, not only during preflight.
    if (input.intentId) assertDesignChangeIntentCurrent(store, input.intentId, project.id);
    if (context.agent) assertEnrolledApprovalProofs(store, input, context, false);
    const changeId = newId();
    const createdAt = nowIso();
    const before = {
      node: latest.node,
      plans: typedPlans,
      documents: documents.map((document) => ({ id: document!.id, currentRevisionId: document!.currentRevisionId, status: document!.status })),
      evidence: allImpactedEvidence.filter((item) => item.status === "active"),
    };
    store.insertGovernance({
      id: changeId,
      projectId: project.id,
      type: "decision",
      title: `设计变更 · ${node.label}`,
      content: JSON.stringify({
        diagramId: diagram.id,
        nodeId: node.id,
        changeSummary: input.changeSummary,
        requirementImpact: input.requirementImpact,
        ...(correctsChangeId ? { correctsChangeId } : {}),
        impactedDocumentIds: input.impactedDocumentIds,
        impactedPlanIds: input.impactedPlanIds,
        reusableWorkSummary: input.reusableWorkSummary,
        reworkScope: input.reworkScope,
        apiImpact: input.apiImpact,
        databaseImpact: input.databaseImpact,
        deploymentImpact: input.deploymentImpact,
      }),
      rationale: input.reason,
      status: "有效",
      author: input.actor,
    });

    const revisedDocuments = documents.map((document) => {
      const current = document!;
      const revised = store.updateDesignDoc(current.id, {
        status: "评审中",
        version: `${current.version || "v0"}-rework-${changeId.slice(0, 8)}`,
        summary: `${current.summary}${current.summary ? " · " : ""}设计变更 ${changeId} 待修订`,
      })!;
      return { documentId: current.id, previousRevisionId: current.currentRevisionId, revisionId: revised.currentRevisionId };
    });

    const reworkPlanIds: string[] = [];
    for (const plan of typedPlans) {
      if (plan.lifecycleStatus === "accepted") {
        const hasActiveRework = typedPlans.some((candidate) => {
          if (candidate.lifecycleStatus === "accepted" || candidate.lifecycleStatus === "legacy"
            || candidate.diagramId !== plan.diagramId || candidate.diagramNodeId !== plan.diagramNodeId) return false;
          const seen = new Set<string>();
          let ancestor = candidate.reworkOfPlanId;
          while (ancestor && !seen.has(ancestor)) {
            if (ancestor === plan.id) return true;
            seen.add(ancestor);
            ancestor = store.getPlan(ancestor)?.reworkOfPlanId ?? null;
          }
          return false;
        });
        if (hasActiveRework) continue;
        reworkPlanIds.push(cloneAcceptedPlan(store, plan, changeId, input.reason).id);
      } else {
        store.updatePlan(plan.id, reworkPatch(plan, changeId, input.reason));
        reworkPlanIds.push(plan.id);
      }
    }

    const impactedRevisionIds = new Set(revisedDocuments.map((item) => item.previousRevisionId));
    const impactedPlanIds = new Set(input.impactedPlanIds);
    const revokedEvidenceIds: string[] = [];
    const retainedEvidenceIds: string[] = [];
    for (const evidence of allImpactedEvidence) {
      const impacted = evidence.status === "active"
        && ((evidence.planItemId && impactedPlanIds.has(evidence.planItemId))
          || (evidence.documentRevisionId && impactedRevisionIds.has(evidence.documentRevisionId)));
      if (!impacted) continue;
      if (reusableEvidence.has(evidence.id)) {
        retainedEvidenceIds.push(evidence.id);
        continue;
      }
      store.db.prepare("UPDATE evidence SET status='revoked', revoked_reason=?, revoked_at=?, details=? WHERE id=?")
        .run(
          `设计变更 ${changeId} 已使旧基线证据失效`,
          createdAt,
          JSON.stringify({ ...evidence.details, changeId }),
          evidence.id,
        );
      revokedEvidenceIds.push(evidence.id);
    }

    const releasedLeaseTaskKeys = releaseAgentTaskLeasesForDesignChange(store, project.id, input.impactedPlanIds, changeId, node.id);
    supersedeEvidenceRepairStates(store, input.impactedPlanIds, changeId);
    const nextNodes = diagram.nodes.map((item) => item.id === node.id ? {
      ...item,
      requirementStatus: input.requirementImpact ? "草拟中" as const : item.requirementStatus,
      designStatus: "进行中" as const,
      blockedReason: `设计变更处理中 · ${changeId}`,
      deliveryUpdatedAt: createdAt,
    } : item);
    store.updateDiagram(diagram.id, { nodes: nextNodes });
    reconcilePlanDeliveryProjections(store);

    const result: DesignChangeResult = {
      ...(correctsChangeId ? { correctsChangeId } : {}),
      changeId,
      projectId: project.id,
      diagramId: diagram.id,
      nodeId: node.id,
      requirementStatus: input.requirementImpact ? "草拟中" : (node.requirementStatus ?? "待整理"),
      designStatus: "进行中",
      revisedDocuments,
      impactedPlanIds: input.impactedPlanIds,
      reworkPlanIds,
      releasedLeaseTaskKeys,
      revokedEvidenceIds,
      retainedEvidenceIds,
      nextAction: null,
      createdAt,
    };
    // 同一事务中先记录正式请求，再计算下一动作；失败会连裁决一起回滚。
    store.db.prepare(
      "INSERT INTO design_change_requests (idempotency_key, request_hash, change_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(input.idempotencyKey, hash, changeId, JSON.stringify(result), createdAt);
    recordDesignChangeLineage(store, result);
    const workflow = buildProjectWorkflow(store, project.id);
    result.nextAction = workflow?.nodes.find((item) => item.diagramId === diagram.id && item.nodeId === node.id)?.nextAction ?? null;
    if (input.intentId) finishDesignChangeIntent(store, input.intentId, "applied", changeId);
    store.recordAudit({
      projectId: project.id,
      entityType: "designChange",
      entityId: changeId,
      action: "request_design_change",
      before,
      after: {
        ...result,
        ...(context.agent ? { agentContext: {
          workOrderId: context.agent.workOrderId, taskKey: context.agent.taskKey, taskRevision: context.agent.taskRevision,
          workerId: context.agent.workerId, agentId: context.agent.agentId, role: context.agent.role,
        } } : {}),
      } as unknown as Record<string, unknown>,
      actor: input.actor,
      source: context.source,
      correlationId: changeId,
      clientId: input.clientId,
      sessionId: input.sessionId,
      model: input.model,
    });
    store.db.prepare("UPDATE design_change_requests SET response_json=? WHERE idempotency_key=?")
      .run(JSON.stringify(result), input.idempotencyKey);
    return result;
  }).immediate();
}
