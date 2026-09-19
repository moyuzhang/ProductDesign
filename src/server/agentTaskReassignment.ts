import { createHash, randomUUID } from "node:crypto";
import type { AgentBlueprintKey, PlanRoleAssignment } from "../shared/types.js";
import { implicitAgentTaskPoolId } from "../shared/agentTaskAssignment.js";
import { normalizeAgentId, normalizeRoleAssignment } from "../shared/planRoles.js";
import type { Store } from "./db.js";
import {
  assertAgentWorkOrderContext,
  isAgentSecurityEnforced,
  type WorkOrderContextInput,
} from "./agentSecurity.js";

export const AGENT_REASSIGNMENT_REASON = "credential_unavailable" as const;
export const AGENT_REASSIGNMENT_APPROVAL_ACTION = "approve_agent_reassignment" as const;

export type AgentTaskReassignmentStatus = "pending" | "approved";

export interface AgentTaskReassignmentRequest {
  id: string;
  projectId: string;
  targetTaskId: string;
  targetTaskKey: string;
  targetTaskRevision: string;
  targetPlanItemId: string;
  targetActionCode: "audit_completed_plan";
  targetWorkScopes: string[];
  originalAssignment: PlanRoleAssignment;
  replacementAssignment: PlanRoleAssignment;
  reason: typeof AGENT_REASSIGNMENT_REASON;
  status: AgentTaskReassignmentStatus;
  assignmentGeneration: number;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string;
  approvedAt: string;
  approvalWorkOrderId: string;
  approvalNote: string;
  createdAt: string;
  updatedAt: string;
}

interface ReassignmentRow {
  id: string;
  project_id: string;
  target_task_id: string;
  target_task_key: string;
  target_task_revision: string;
  target_plan_item_id: string;
  target_action_code: "audit_completed_plan";
  target_work_scopes_json: string;
  original_agent_id: string;
  original_display_name: string;
  original_pool_id: string;
  replacement_agent_id: string;
  replacement_display_name: string;
  replacement_pool_id: string;
  reason: typeof AGENT_REASSIGNMENT_REASON;
  status: AgentTaskReassignmentStatus;
  assignment_generation: number;
  requested_by: string;
  requested_at: string;
  approved_by: string;
  approved_at: string;
  approval_work_order_id: string;
  approval_note: string;
  request_idempotency_key: string;
  request_hash: string;
  approval_idempotency_key: string;
  approval_hash: string;
  approval_response_json: string;
  created_at: string;
  updated_at: string;
}

interface LeaseRow {
  id: string;
  task_key: string;
  task_id: string;
  task_revision: string;
  project_id: string;
  queue: string;
  role: AgentBlueprintKey;
  action_code: string;
  status: string;
  lease_token: string;
  agent_id: string;
  worker_id: string;
  lease_expires_at: string;
  work_scopes_json: string;
}

interface WorkerPoolRow {
  id: string;
  project_id: string;
  role: AgentBlueprintKey;
  name: string;
  status: "active" | "paused";
}

export class AgentTaskReassignmentError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AgentTaskReassignmentError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizedScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function parseScopes(value: string): string[] {
  try { return normalizedScopes(JSON.parse(value || "[]") as string[]); }
  catch { return []; }
}

function mapRequest(row: ReassignmentRow): AgentTaskReassignmentRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    targetTaskId: row.target_task_id,
    targetTaskKey: row.target_task_key,
    targetTaskRevision: row.target_task_revision,
    targetPlanItemId: row.target_plan_item_id,
    targetActionCode: row.target_action_code,
    targetWorkScopes: parseScopes(row.target_work_scopes_json),
    originalAssignment: normalizeRoleAssignment({
      agentId: row.original_agent_id,
      displayName: row.original_display_name,
      poolId: row.original_pool_id,
    }),
    replacementAssignment: normalizeRoleAssignment({
      agentId: row.replacement_agent_id,
      displayName: row.replacement_display_name,
      poolId: row.replacement_pool_id,
    }),
    reason: row.reason,
    status: row.status,
    assignmentGeneration: row.assignment_generation,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvalWorkOrderId: row.approval_work_order_id,
    approvalNote: row.approval_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ensureAgentTaskReassignmentSchema(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_task_reassignment_requests (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_task_id TEXT NOT NULL,
      target_task_key TEXT NOT NULL,
      target_task_revision TEXT NOT NULL,
      target_plan_item_id TEXT NOT NULL,
      target_action_code TEXT NOT NULL,
      target_work_scopes_json TEXT NOT NULL DEFAULT '[]',
      original_agent_id TEXT NOT NULL,
      original_display_name TEXT NOT NULL DEFAULT '',
      original_pool_id TEXT NOT NULL,
      replacement_agent_id TEXT NOT NULL,
      replacement_display_name TEXT NOT NULL DEFAULT '',
      replacement_pool_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignment_generation INTEGER NOT NULL,
      requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      approved_by TEXT NOT NULL DEFAULT '',
      approved_at TEXT NOT NULL DEFAULT '',
      approval_work_order_id TEXT NOT NULL DEFAULT '',
      approval_note TEXT NOT NULL DEFAULT '',
      request_idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      approval_idempotency_key TEXT NOT NULL DEFAULT '',
      approval_hash TEXT NOT NULL DEFAULT '',
      approval_response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_reassignment_pending
      ON agent_task_reassignment_requests(project_id, target_task_id)
      WHERE status='pending';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_reassignment_approval_idempotency
      ON agent_task_reassignment_requests(approval_idempotency_key)
      WHERE approval_idempotency_key<>'';
    CREATE INDEX IF NOT EXISTS idx_agent_task_reassignment_project_status
      ON agent_task_reassignment_requests(project_id, status, requested_at);
  `);
}

export function agentReassignmentApprovalTaskId(requestId: string): string {
  return `approval:agent-reassignment:${requestId}`;
}

export function getAgentTaskAssignmentGeneration(
  store: Store,
  planId: string,
  actionCode = "audit_completed_plan",
): number {
  ensureAgentTaskReassignmentSchema(store);
  const row = store.db.prepare(`
    SELECT MAX(assignment_generation) AS generation
    FROM agent_task_reassignment_requests
    WHERE target_plan_item_id=? AND target_action_code=? AND status='approved'
  `).get(planId, actionCode) as { generation: number | null };
  return Number(row.generation ?? 0);
}

export function listPendingAgentTaskReassignments(store: Store, projectId: string): AgentTaskReassignmentRequest[] {
  ensureAgentTaskReassignmentSchema(store);
  return (store.db.prepare(`
    SELECT * FROM agent_task_reassignment_requests
    WHERE project_id=? AND status='pending'
    ORDER BY requested_at, id
  `).all(projectId) as ReassignmentRow[]).map(mapRequest);
}

function activeTargetLease(store: Store, projectId: string, targetTaskId: string): LeaseRow | undefined {
  return store.db.prepare(`
    SELECT * FROM agent_task_leases
    WHERE project_id=? AND task_id=? AND status IN ('claimed', 'running') AND lease_expires_at>?
    ORDER BY updated_at DESC LIMIT 1
  `).get(projectId, targetTaskId, new Date().toISOString()) as LeaseRow | undefined;
}

function expectedAuditRevision(store: Store, planId: string): string {
  const plan = store.getPlan(planId);
  if (!plan) return "";
  const generation = getAgentTaskAssignmentGeneration(store, planId);
  const baseRevision = `${plan.proposalRevision}:implementation:${plan.completedAt || plan.implementationRevision || "initial"}`;
  return generation > 0 ? `${baseRevision}:assignment:${generation}` : baseRevision;
}

function assertReplacementPool(
  store: Store,
  projectId: string,
  replacement: PlanRoleAssignment,
  originalAgentId: string,
  planId: string,
): WorkerPoolRow {
  const poolId = replacement.poolId?.trim() || "";
  const pool = store.db.prepare("SELECT * FROM agent_worker_pools WHERE id=?")
    .get(poolId) as WorkerPoolRow | undefined;
  if (!pool || pool.project_id !== projectId) {
    throw new AgentTaskReassignmentError(409, "REPLACEMENT_POOL_PROJECT_MISMATCH", "替代 Worker 池不存在或不属于目标项目");
  }
  if (pool.role !== "auditor") {
    throw new AgentTaskReassignmentError(409, "REPLACEMENT_POOL_ROLE_MISMATCH", "替代 Worker 池必须是 auditor 角色");
  }
  if (pool.status !== "active") {
    throw new AgentTaskReassignmentError(409, "REPLACEMENT_POOL_PAUSED", "替代 Worker 池当前未启用");
  }
  const replacementId = normalizeAgentId(replacement.agentId);
  const poolIdentityMatches = normalizeAgentId(pool.name) === replacementId
    || Boolean(store.db.prepare(`
      SELECT 1 AS present FROM agent_runner_registrations
      WHERE project_id=? AND pool_id=? AND lower(agent_id)=lower(?) LIMIT 1
    `).get(projectId, pool.id, replacement.agentId));
  if (!poolIdentityMatches) {
    throw new AgentTaskReassignmentError(409, "REPLACEMENT_POOL_IDENTITY_MISMATCH", "替代 agentId 必须与目标 auditor 池身份一致");
  }
  const plan = store.getPlan(planId);
  if (!plan) throw new AgentTaskReassignmentError(404, "PLAN_NOT_FOUND", "审计任务关联的计划不存在");
  const forbidden = new Set([
    originalAgentId,
    plan.roleAssignments.designer.agentId,
    plan.roleAssignments.builder.agentId,
    "Main Agent",
  ].map(normalizeAgentId).filter(Boolean));
  const producers = store.db.prepare(`
    SELECT agent_id, worker_id FROM agent_task_leases
    WHERE project_id=? AND task_id IN (?, ?) AND status='completed'
  `).all(projectId, `design:${planId}`, `development:${planId}`) as Array<{ agent_id: string; worker_id: string }>;
  for (const producer of producers) {
    forbidden.add(normalizeAgentId(producer.agent_id));
    forbidden.add(normalizeAgentId(producer.worker_id));
  }
  const replacementRunners = store.db.prepare(`
    SELECT agent_id, worker_id FROM agent_runner_registrations
    WHERE project_id=? AND pool_id=?
  `).all(projectId, pool.id) as Array<{ agent_id: string; worker_id: string }>;
  if (forbidden.has(replacementId)
    || replacementRunners.some((runner) => forbidden.has(normalizeAgentId(runner.agent_id))
      || forbidden.has(normalizeAgentId(runner.worker_id)))) {
    throw new AgentTaskReassignmentError(409, "REPLACEMENT_IDENTITY_NOT_INDEPENDENT", "替代 Auditor 必须与原 Auditor、Designer、Builder、生产 Worker 和 Main Agent 身份分离");
  }
  return pool;
}

export interface RequestAgentTaskReassignmentInput {
  projectId: string;
  targetTaskId: string;
  targetTaskKey: string;
  targetTaskRevision: string;
  targetPlanItemId: string;
  targetActionCode: "audit_completed_plan";
  targetWorkScopes: string[];
  originalAssignment: PlanRoleAssignment;
  replacementAssignment: PlanRoleAssignment;
  reason: typeof AGENT_REASSIGNMENT_REASON;
  requestedBy: string;
  idempotencyKey: string;
}

export function requestAgentTaskReassignment(
  store: Store,
  raw: RequestAgentTaskReassignmentInput,
): AgentTaskReassignmentRequest {
  ensureAgentTaskReassignmentSchema(store);
  const input = {
    ...raw,
    targetTaskId: raw.targetTaskId.trim(),
    targetTaskKey: raw.targetTaskKey.trim(),
    targetTaskRevision: raw.targetTaskRevision.trim(),
    targetPlanItemId: raw.targetPlanItemId.trim(),
    targetWorkScopes: normalizedScopes(raw.targetWorkScopes),
    originalAssignment: normalizeRoleAssignment(raw.originalAssignment),
    replacementAssignment: normalizeRoleAssignment(raw.replacementAssignment),
    requestedBy: raw.requestedBy.trim(),
    idempotencyKey: raw.idempotencyKey.trim(),
  };
  if (!input.idempotencyKey || !input.requestedBy) {
    throw new AgentTaskReassignmentError(400, "REASSIGNMENT_REQUEST_INVALID", "requestedBy 与 idempotencyKey 不能为空");
  }
  if (normalizeAgentId(input.requestedBy) !== normalizeAgentId("Main Agent")) {
    throw new AgentTaskReassignmentError(403, "MAIN_AGENT_REQUIRED", "仅 Main Agent 可建立审计身份恢复请求");
  }
  if (input.reason !== AGENT_REASSIGNMENT_REASON || input.targetActionCode !== "audit_completed_plan") {
    throw new AgentTaskReassignmentError(400, "REASSIGNMENT_REASON_UNSUPPORTED", "仅支持实现审计 credential_unavailable 恢复");
  }
  const hash = requestHash({
    projectId: input.projectId,
    targetTaskId: input.targetTaskId,
    targetTaskKey: input.targetTaskKey,
    targetTaskRevision: input.targetTaskRevision,
    targetPlanItemId: input.targetPlanItemId,
    targetActionCode: input.targetActionCode,
    targetWorkScopes: input.targetWorkScopes,
    originalAssignment: input.originalAssignment,
    replacementAssignment: input.replacementAssignment,
    reason: input.reason,
    requestedBy: input.requestedBy,
  });
  const earlyReplay = store.db.prepare("SELECT * FROM agent_task_reassignment_requests WHERE request_idempotency_key=?")
    .get(input.idempotencyKey) as ReassignmentRow | undefined;
  if (earlyReplay) {
    if (earlyReplay.request_hash !== hash) {
      throw new AgentTaskReassignmentError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同恢复请求");
    }
    return mapRequest(earlyReplay);
  }
  const plan = store.getPlan(input.targetPlanItemId);
  if (!plan || plan.projectId !== input.projectId || !plan.diagramId || !plan.diagramNodeId) {
    throw new AgentTaskReassignmentError(404, "PLAN_NOT_FOUND", "审计任务关联的计划、画布或节点不存在");
  }
  if (plan.lifecycleStatus !== "pending_audit" || plan.status !== "已完成" || ["passed", "failed"].includes(plan.auditStatus)) {
    throw new AgentTaskReassignmentError(409, "TARGET_TASK_NOT_EXECUTABLE", "目标计划已离开实现审计队列");
  }
  if (input.targetTaskId !== `audit:${plan.id}`) {
    throw new AgentTaskReassignmentError(409, "TARGET_TASK_MISMATCH", "仅能恢复当前计划的实现审计任务");
  }
  const expectedRevision = expectedAuditRevision(store, plan.id);
  const expectedTaskKey = `v1:${input.projectId}:audit:${encodeURIComponent(input.targetTaskId)}:${expectedRevision}`;
  if (input.targetTaskRevision !== expectedRevision || input.targetTaskKey !== expectedTaskKey) {
    throw new AgentTaskReassignmentError(409, "TARGET_TASK_REVISION_DRIFT", "目标审计任务修订已变化，请重新读取队列");
  }
  const currentAssignment = normalizeRoleAssignment(plan.roleAssignments.auditor);
  const currentPoolId = currentAssignment.poolId
    || implicitAgentTaskPoolId(input.projectId, "auditor", currentAssignment.agentId);
  const requestedOriginalPoolId = input.originalAssignment.poolId
    || implicitAgentTaskPoolId(input.projectId, "auditor", input.originalAssignment.agentId);
  if (normalizeAgentId(currentAssignment.agentId) !== normalizeAgentId(input.originalAssignment.agentId)
    || currentPoolId !== requestedOriginalPoolId) {
    throw new AgentTaskReassignmentError(409, "ORIGINAL_ASSIGNMENT_MISMATCH", "计划当前 Auditor 与声明的原受派身份不一致");
  }
  const expectedScopes = normalizedScopes([`node:${plan.diagramId}:${plan.diagramNodeId}`]);
  if (input.targetWorkScopes.join("\u001f") !== expectedScopes.join("\u001f")) {
    throw new AgentTaskReassignmentError(409, "TARGET_SCOPE_MISMATCH", "恢复请求必须精确绑定原审计任务的节点 scope");
  }
  if (activeTargetLease(store, input.projectId, input.targetTaskId)) {
    throw new AgentTaskReassignmentError(409, "TARGET_LEASE_ACTIVE", "目标审计任务仍有有效 lease，不能改派");
  }
  if (!isAgentSecurityEnforced(store, currentAssignment.agentId)) {
    throw new AgentTaskReassignmentError(409, "CREDENTIAL_RECOVERY_NOT_APPLICABLE", "原 Auditor 未启用凭据强制认证，不能使用 credential_unavailable 恢复");
  }
  assertReplacementPool(store, input.projectId, input.replacementAssignment, currentAssignment.agentId, plan.id);
  return store.db.transaction(() => {
    const replay = store.db.prepare("SELECT * FROM agent_task_reassignment_requests WHERE request_idempotency_key=?")
      .get(input.idempotencyKey) as ReassignmentRow | undefined;
    if (replay) {
      if (replay.request_hash !== hash) {
        throw new AgentTaskReassignmentError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同恢复请求");
      }
      return mapRequest(replay);
    }
    const existing = store.db.prepare(`
      SELECT * FROM agent_task_reassignment_requests
      WHERE project_id=? AND target_task_id=? AND status='pending'
    `).get(input.projectId, input.targetTaskId) as ReassignmentRow | undefined;
    if (existing) {
      const sameReplacement = normalizeAgentId(existing.replacement_agent_id) === normalizeAgentId(input.replacementAssignment.agentId)
        && existing.replacement_pool_id === input.replacementAssignment.poolId;
      if (!sameReplacement) {
        throw new AgentTaskReassignmentError(409, "REASSIGNMENT_ALREADY_PENDING", "目标审计任务已有不同的待批准改派请求");
      }
      return mapRequest(existing);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const generation = getAgentTaskAssignmentGeneration(store, plan.id) + 1;
    const row = store.db.prepare(`
      INSERT INTO agent_task_reassignment_requests (
        id, project_id, target_task_id, target_task_key, target_task_revision,
        target_plan_item_id, target_action_code, target_work_scopes_json,
        original_agent_id, original_display_name, original_pool_id,
        replacement_agent_id, replacement_display_name, replacement_pool_id,
        reason, status, assignment_generation, requested_by, requested_at,
        request_idempotency_key, request_hash, created_at, updated_at
      ) VALUES (
        @id, @projectId, @targetTaskId, @targetTaskKey, @targetTaskRevision,
        @targetPlanItemId, @targetActionCode, @targetWorkScopesJson,
        @originalAgentId, @originalDisplayName, @originalPoolId,
        @replacementAgentId, @replacementDisplayName, @replacementPoolId,
        @reason, 'pending', @assignmentGeneration, @requestedBy, @now,
        @requestIdempotencyKey, @requestHash, @now, @now
      ) RETURNING *
    `).get({
      id,
      projectId: input.projectId,
      targetTaskId: input.targetTaskId,
      targetTaskKey: input.targetTaskKey,
      targetTaskRevision: input.targetTaskRevision,
      targetPlanItemId: plan.id,
      targetActionCode: input.targetActionCode,
      targetWorkScopesJson: JSON.stringify(input.targetWorkScopes),
      originalAgentId: currentAssignment.agentId,
      originalDisplayName: currentAssignment.displayName,
      originalPoolId: currentPoolId,
      replacementAgentId: input.replacementAssignment.agentId,
      replacementDisplayName: input.replacementAssignment.displayName,
      replacementPoolId: input.replacementAssignment.poolId,
      reason: input.reason,
      assignmentGeneration: generation,
      requestedBy: input.requestedBy,
      requestIdempotencyKey: input.idempotencyKey,
      requestHash: hash,
      now,
    }) as ReassignmentRow;
    const result = mapRequest(row);
    store.recordAudit({
      projectId: input.projectId,
      entityType: "agentTaskReassignment",
      entityId: id,
      action: "request",
      before: null,
      after: { ...result },
      actor: input.requestedBy,
      source: "mcp",
      correlationId: plan.correlationId || plan.id,
      clientId: "productdesign-mcp",
    });
    return result;
  }).immediate();
}

export interface ApproveAgentTaskReassignmentInput {
  requestId: string;
  approvalNote: string;
  workOrderId: string;
  leaseToken: string;
  taskKey: string;
  taskRevision: string;
  workerId: string;
  agentId: string;
  role: AgentBlueprintKey;
  idempotencyKey: string;
  policyAckToken?: string;
  nonceId?: string;
  connectionId?: string;
  bodyDigest?: string;
}

export function approveAgentTaskReassignment(
  store: Store,
  raw: ApproveAgentTaskReassignmentInput,
): AgentTaskReassignmentRequest {
  ensureAgentTaskReassignmentSchema(store);
  const input = {
    ...raw,
    requestId: raw.requestId.trim(),
    approvalNote: raw.approvalNote.trim(),
    workOrderId: raw.workOrderId.trim(),
    leaseToken: raw.leaseToken.trim(),
    taskKey: raw.taskKey.trim(),
    taskRevision: raw.taskRevision.trim(),
    workerId: raw.workerId.trim(),
    agentId: raw.agentId.trim(),
    idempotencyKey: raw.idempotencyKey.trim(),
  };
  if (!input.requestId || !input.approvalNote || !input.idempotencyKey) {
    throw new AgentTaskReassignmentError(400, "REASSIGNMENT_APPROVAL_INVALID", "requestId、approvalNote 与 idempotencyKey 不能为空");
  }
  const hash = requestHash({
    requestId: input.requestId,
    approvalNote: input.approvalNote,
    workOrderId: input.workOrderId,
    taskKey: input.taskKey,
    taskRevision: input.taskRevision,
    workerId: input.workerId,
    agentId: input.agentId,
    role: input.role,
  });
  const replay = store.db.prepare(`
    SELECT * FROM agent_task_reassignment_requests WHERE approval_idempotency_key=?
  `).get(input.idempotencyKey) as ReassignmentRow | undefined;
  if (replay) {
    if (replay.approval_hash !== hash) {
      throw new AgentTaskReassignmentError(409, "IDEMPOTENCY_CONFLICT", "同一批准 idempotencyKey 已用于不同请求");
    }
    return replay.approval_response_json
      ? JSON.parse(replay.approval_response_json) as AgentTaskReassignmentRequest
      : mapRequest(replay);
  }
  const pending = store.db.prepare("SELECT * FROM agent_task_reassignment_requests WHERE id=?")
    .get(input.requestId) as ReassignmentRow | undefined;
  if (!pending) throw new AgentTaskReassignmentError(404, "REASSIGNMENT_NOT_FOUND", "改派恢复请求不存在");
  if (pending.status !== "pending") {
    throw new AgentTaskReassignmentError(409, "REASSIGNMENT_NOT_PENDING", "改派恢复请求已不在待批准状态");
  }
  if (input.role !== "approver" || normalizeAgentId(input.agentId) !== normalizeAgentId("Main Agent")) {
    throw new AgentTaskReassignmentError(403, "MAIN_AGENT_REQUIRED", "改派必须由 Main Agent 的独立 Approver 工单批准");
  }
  const now = new Date().toISOString();
  const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
    .get(input.workOrderId, input.leaseToken) as LeaseRow | undefined;
  const expectedApprovalTaskId = agentReassignmentApprovalTaskId(pending.id);
  const expectedScopes = parseScopes(pending.target_work_scopes_json);
  if (!lease || !["claimed", "running"].includes(lease.status) || lease.lease_expires_at <= now
    || lease.project_id !== pending.project_id || lease.queue !== "approval" || lease.role !== "approver"
    || lease.action_code !== AGENT_REASSIGNMENT_APPROVAL_ACTION || lease.task_id !== expectedApprovalTaskId
    || lease.task_key !== input.taskKey || lease.task_revision !== input.taskRevision
    || lease.agent_id !== input.agentId || lease.worker_id !== input.workerId
    || parseScopes(lease.work_scopes_json).join("\u001f") !== expectedScopes.join("\u001f")) {
    throw new AgentTaskReassignmentError(409, "WORK_ORDER_CONTEXT_INVALID", "必须使用同请求、同节点 scope 的有效 Main Agent approval lease");
  }
  if (isAgentSecurityEnforced(store, input.agentId)) {
    const securityContext: Omit<WorkOrderContextInput, "projectId" | "action" | "target"> = {
      policyAckToken: input.policyAckToken,
      workOrderId: input.workOrderId,
      leaseToken: input.leaseToken,
      taskKey: input.taskKey,
      taskRevision: input.taskRevision,
      workerId: input.workerId,
      agentId: input.agentId,
      role: input.role,
      idempotencyKey: input.idempotencyKey,
      nonceId: input.nonceId,
      connectionId: input.connectionId,
      bodyDigest: input.bodyDigest,
    };
    assertAgentWorkOrderContext(store, {
      ...securityContext,
      projectId: pending.project_id,
      action: "mcp.approve_agent_reassignment",
      target: "mcp:approve_agent_reassignment",
    });
  }
  if (activeTargetLease(store, pending.project_id, pending.target_task_id)) {
    throw new AgentTaskReassignmentError(409, "TARGET_LEASE_ACTIVE", "目标审计任务出现新的有效 lease，批准已停止");
  }
  const plan = store.getPlan(pending.target_plan_item_id);
  if (!plan || plan.projectId !== pending.project_id || !plan.diagramId || !plan.diagramNodeId
    || plan.lifecycleStatus !== "pending_audit" || plan.status !== "已完成"
    || ["passed", "failed"].includes(plan.auditStatus)) {
    throw new AgentTaskReassignmentError(409, "TARGET_TASK_NOT_EXECUTABLE", "目标计划已离开实现审计队列");
  }
  const current = normalizeRoleAssignment(plan.roleAssignments.auditor);
  const currentPoolId = current.poolId || implicitAgentTaskPoolId(plan.projectId, "auditor", current.agentId);
  if (normalizeAgentId(current.agentId) !== normalizeAgentId(pending.original_agent_id)
    || currentPoolId !== pending.original_pool_id
    || expectedAuditRevision(store, plan.id) !== pending.target_task_revision
    || getAgentTaskAssignmentGeneration(store, plan.id) + 1 !== pending.assignment_generation) {
    throw new AgentTaskReassignmentError(409, "TARGET_TASK_REVISION_DRIFT", "计划受派身份或 assignment generation 已变化");
  }
  const replacement = normalizeRoleAssignment({
    agentId: pending.replacement_agent_id,
    displayName: pending.replacement_display_name,
    poolId: pending.replacement_pool_id,
  });
  const pool = assertReplacementPool(store, plan.projectId, replacement, current.agentId, plan.id);
  const approved = store.db.transaction(() => {
    const latestLease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
      .get(input.workOrderId, input.leaseToken) as LeaseRow | undefined;
    if (!latestLease || !["claimed", "running"].includes(latestLease.status) || latestLease.lease_expires_at <= new Date().toISOString()) {
      throw new AgentTaskReassignmentError(409, "LEASE_LOST", "批准 lease 已失效，停止改派");
    }
    if (activeTargetLease(store, pending.project_id, pending.target_task_id)) {
      throw new AgentTaskReassignmentError(409, "TARGET_LEASE_ACTIVE", "目标审计任务出现新的有效 lease，批准已停止");
    }
    const beforeAssignment = plan.roleAssignments.auditor;
    store.updatePlan(plan.id, {
      roleAssignments: {
        ...plan.roleAssignments,
        auditor: {
          agentId: replacement.agentId,
          displayName: replacement.displayName || pool.name,
          poolId: pool.id,
        },
      },
    });
    const updatedAt = new Date().toISOString();
    const updatedRow = store.db.prepare(`
      UPDATE agent_task_reassignment_requests SET
        status='approved', approved_by=@approvedBy, approved_at=@approvedAt,
        approval_work_order_id=@workOrderId, approval_note=@approvalNote,
        approval_idempotency_key=@idempotencyKey, approval_hash=@approvalHash,
        updated_at=@updatedAt
      WHERE id=@requestId AND status='pending'
      RETURNING *
    `).get({
      requestId: pending.id,
      approvedBy: input.agentId,
      approvedAt: updatedAt,
      workOrderId: input.workOrderId,
      approvalNote: input.approvalNote,
      idempotencyKey: input.idempotencyKey,
      approvalHash: hash,
      updatedAt,
    }) as ReassignmentRow | undefined;
    if (!updatedRow) throw new AgentTaskReassignmentError(409, "REASSIGNMENT_NOT_PENDING", "改派请求已被并发处理");
    const completed = store.db.prepare(`
      UPDATE agent_task_leases SET status='completed', result_digest=@resultDigest,
        completed_at=@updatedAt, updated_at=@updatedAt
      WHERE id=@workOrderId AND lease_token=@leaseToken
        AND status IN ('claimed', 'running') AND lease_expires_at>@updatedAt
    `).run({
      resultDigest: `agent_reassignment:${pending.id}:generation:${pending.assignment_generation}`,
      updatedAt,
      workOrderId: input.workOrderId,
      leaseToken: input.leaseToken,
    });
    if (completed.changes !== 1) throw new AgentTaskReassignmentError(409, "LEASE_LOST", "批准 lease 已失效，改派事务已回滚");
    store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(input.leaseToken);
    store.db.prepare(`
      UPDATE agent_task_workspace_reservations SET status='completed', updated_at=? WHERE lease_token=?
    `).run(updatedAt, input.leaseToken);
    store.db.prepare(`
      UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=?
      WHERE project_id=? AND lower(worker_id)=lower(?)
    `).run(updatedAt, updatedAt, plan.projectId, input.workerId);
    const result = mapRequest(updatedRow);
    store.db.prepare(`
      UPDATE agent_task_reassignment_requests SET approval_response_json=? WHERE id=?
    `).run(JSON.stringify(result), pending.id);
    store.recordAudit({
      projectId: plan.projectId,
      entityType: "agentTaskReassignment",
      entityId: pending.id,
      action: "approve",
      before: {
        status: "pending",
        auditor: beforeAssignment,
        targetTaskKey: pending.target_task_key,
        targetTaskRevision: pending.target_task_revision,
      },
      after: {
        status: "approved",
        auditor: result.replacementAssignment,
        reason: result.reason,
        assignmentGeneration: result.assignmentGeneration,
        approvalWorkOrderId: result.approvalWorkOrderId,
      },
      actor: input.agentId,
      source: "mcp",
      correlationId: plan.correlationId || plan.id,
      clientId: "productdesign-mcp",
    });
    store.recordAudit({
      projectId: plan.projectId,
      entityType: "agentTaskLease",
      entityId: input.taskKey,
      action: "complete",
      before: { status: latestLease.status, actionCode: latestLease.action_code },
      after: { status: "completed", actionCode: latestLease.action_code, resultDigest: `agent_reassignment:${pending.id}` },
      actor: input.agentId,
      source: "mcp",
      correlationId: plan.correlationId || plan.id,
      clientId: "productdesign-mcp",
    });
    return result;
  }).immediate();
  return approved;
}
