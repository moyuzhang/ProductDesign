import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import type { AgentOrchestrationTask, AgentTaskRetryCandidate, AgentTaskRetryRequestResult } from "../shared/types.js";
import { normalizeAgentId } from "../shared/planRoles.js";
import { AgentTaskLeaseError, agentTaskKey, getAgentTaskCapacity, listClaimableAgentTasks, revisionForTask, type AgentTaskLease, type CompleteInput } from "./agentTaskLeases.js";

export const RETRY_APPROVAL_ACTION = "approve_agent_task_retry";
const excludedActions = new Set([RETRY_APPROVAL_ACTION, "submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt"]);
interface RetryRow {
  id: string; project_id: string; task_key: string; task_revision: string;
  failed_work_order_id: string; failed_attempt: number; target_json: string; failed_lease_json: string;
  reason: string; remediation: string; status: "pending" | "approved";
  idempotency_key: string; request_hash: string; approved_work_order_id: string;
  approved_by: string; approval_note: string; consumed_work_order_id: string; created_at: string; approved_at: string; consumed_at: string;
}
interface FailedLease { id: string; project_id: string; task_key: string; task_revision: string; status: string; attempt: number; agent_id: string; worker_id: string; last_error: string; }
export interface RequestAgentTaskRetryInput {
  projectId: string; taskKey: string; taskRevision: string; failedWorkOrderId: string;
  expectedAttempt: number; reason: string; remediation: string; idempotencyKey: string;
}
function ensureSchema(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS agent_task_retry_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_key TEXT NOT NULL, task_revision TEXT NOT NULL,
    failed_work_order_id TEXT NOT NULL, failed_attempt INTEGER NOT NULL, target_json TEXT NOT NULL,
    failed_lease_json TEXT NOT NULL, reason TEXT NOT NULL, remediation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    approved_work_order_id TEXT NOT NULL DEFAULT '', approved_by TEXT NOT NULL DEFAULT '', approval_note TEXT NOT NULL DEFAULT '',
    consumed_work_order_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, approved_at TEXT NOT NULL DEFAULT '', consumed_at TEXT NOT NULL DEFAULT '',
    UNIQUE(project_id, idempotency_key), UNIQUE(project_id, task_key, task_revision, failed_work_order_id, failed_attempt)
  )`);
}
function result(store: Store, row: RetryRow): AgentTaskRetryRequestResult {
  return { requestId: row.id, status: row.status, approvalTaskId: `approval:retry:${row.id}`,
    additionalAttempts: 1, authorizesRetry: row.status === "approved" && !row.consumed_work_order_id && matches(row, failure(store, row.project_id, row.task_key))
      && listClaimableAgentTasks(store, row.project_id).some((task) => task.taskKey === row.task_key && task.taskRevision === row.task_revision) };
}
function failure(store: Store, projectId: string, taskKey: string): FailedLease | undefined {
  return store.db.prepare("SELECT * FROM agent_task_leases WHERE project_id=? AND task_key=?").get(projectId, taskKey) as FailedLease | undefined;
}
function matches(row: RetryRow, lease: FailedLease | undefined): boolean {
  return Boolean(lease && lease.id === row.failed_work_order_id && lease.task_revision === row.task_revision
    && lease.project_id === row.project_id && lease.attempt === row.failed_attempt && ["failed", "expired"].includes(lease.status));
}
export function hasAgentTaskRetryAllowance(store: Store, lease: { project_id: string; task_key: string; task_revision: string; id: string; attempt: number }): boolean {
  ensureSchema(store);
  return Boolean(store.db.prepare(`SELECT 1 FROM agent_task_retry_requests WHERE project_id=? AND task_key=? AND task_revision=?
    AND failed_work_order_id=? AND failed_attempt=? AND status='approved' AND consumed_work_order_id=''`)
    .get(lease.project_id, lease.task_key, lease.task_revision, lease.id, lease.attempt));
}
export function listAgentTaskRetryCandidates(store: Store, projectId: string): AgentTaskRetryCandidate[] {
  const tasks = listClaimableAgentTasks(store, projectId);
  ensureSchema(store);
  const maxAttempts = getAgentTaskCapacity(store, projectId).maxAttempts;
  return tasks.flatMap((task) => {
    const lease = failure(store, projectId, task.taskKey);
    if (excludedActions.has(task.actionCode) || !lease || !["failed", "expired"].includes(lease.status)
      || lease.attempt < maxAttempts || hasAgentTaskRetryAllowance(store, lease)) return [];
    const pending = store.db.prepare(`SELECT id FROM agent_task_retry_requests WHERE project_id=? AND task_key=? AND task_revision=?
      AND failed_work_order_id=? AND failed_attempt=? AND status='pending'`).get(projectId, task.taskKey, task.taskRevision, lease.id, lease.attempt) as { id: string } | undefined;
    return [{ taskId: task.id, taskKey: task.taskKey, taskRevision: task.taskRevision, failedWorkOrderId: lease.id,
      attempt: lease.attempt, maxAttempts, title: task.title, actionCode: task.actionCode, role: task.requiredRole,
      diagramId: task.diagramId, nodeId: task.nodeId, lastError: lease.last_error, ...(pending ? { pendingRequestId: pending.id } : {}) }];
  });
}
export function requestAgentTaskRetry(store: Store, raw: RequestAgentTaskRetryInput): AgentTaskRetryRequestResult {
  ensureSchema(store);
  const input = { ...raw, reason: raw.reason.trim(), remediation: raw.remediation.trim(), idempotencyKey: raw.idempotencyKey.trim() };
  if (!input.reason || !input.remediation || !input.idempotencyKey || !Number.isInteger(input.expectedAttempt))
    throw new AgentTaskLeaseError(400, "RETRY_REQUEST_INVALID", "重试恢复必须填写原因、修复措施、精确尝试次数和幂等键");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return store.db.transaction(() => {
    const replay = store.db.prepare("SELECT * FROM agent_task_retry_requests WHERE project_id=? AND idempotency_key=?").get(input.projectId, input.idempotencyKey) as RetryRow | undefined;
    if (replay) {
      if (replay.request_hash !== hash) throw new AgentTaskLeaseError(409, "IDEMPOTENCY_CONFLICT", "幂等键已绑定另一恢复请求");
      return result(store, replay);
    }
    const candidate = listAgentTaskRetryCandidates(store, input.projectId).find((task) => task.taskKey === input.taskKey
      && task.taskRevision === input.taskRevision && task.failedWorkOrderId === input.failedWorkOrderId && task.attempt === input.expectedAttempt);
    if (!candidate) throw new AgentTaskLeaseError(409, "RETRY_TARGET_STALE", "目标必须是当前项目、当前修订且已耗尽尝试次数的失败工单");
    if (candidate.pendingRequestId) throw new AgentTaskLeaseError(409, "RETRY_ALREADY_PENDING", "该失败尝试已有待批准恢复请求");
    const task = listClaimableAgentTasks(store, input.projectId).find((task) => task.taskKey === input.taskKey)!;
    // Preserve a token-free failure snapshot even when the canonical lease row is reclaimed.
    const lease = failure(store, input.projectId, input.taskKey)!;
    const { lease_token: _token, ...snapshot } = lease as FailedLease & { lease_token?: string };
    const row = store.db.prepare(`INSERT INTO agent_task_retry_requests
      (id,project_id,task_key,task_revision,failed_work_order_id,failed_attempt,target_json,failed_lease_json,reason,remediation,idempotency_key,request_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(randomUUID(), input.projectId, input.taskKey, input.taskRevision,
        input.failedWorkOrderId, input.expectedAttempt, JSON.stringify(task), JSON.stringify(snapshot), input.reason, input.remediation,
        input.idempotencyKey, hash, new Date().toISOString()) as RetryRow;
    store.recordAudit({ projectId: input.projectId, entityType: "agentTaskRetry", entityId: row.id, action: "request", before: null,
      after: { taskKey: input.taskKey, taskRevision: input.taskRevision, failedWorkOrderId: input.failedWorkOrderId,
        attempt: input.expectedAttempt, reason: input.reason, remediation: input.remediation, authorizesRetry: false }, actor: "human", source: "web" });
    return result(store, row);
  }).immediate();
}
/** Called after ordinary queues are canonicalized; never invents a task that left its governed queue. */
export function agentTaskRetryApprovalTasks(store: Store, projectId: string, tasks: AgentOrchestrationTask[]): AgentOrchestrationTask[] {
  ensureSchema(store);
  const pending = store.db.prepare("SELECT * FROM agent_task_retry_requests WHERE project_id=? AND status='pending'").all(projectId) as RetryRow[];
  return pending.flatMap((request) => {
    if (!matches(request, failure(store, projectId, request.task_key)) || request.failed_attempt < getAgentTaskCapacity(store, projectId).maxAttempts) return [];
    const current = tasks.find((task) => agentTaskKey(projectId, task, revisionForTask(store, task)) === request.task_key);
    if (!current) return [];
    return [{ ...current, id: `approval:retry:${request.id}`, queue: "approval" as const,
      actionCode: RETRY_APPROVAL_ACTION, correlationId: request.id, title: `批准单工单重试：${current.title}`,
      reason: `失败工单 ${request.failed_work_order_id}；任务修订 ${request.task_revision}；失败尝试 ${request.failed_attempt}；执行错误：${(JSON.parse(request.failed_lease_json) as FailedLease).last_error}；原因：${request.reason}；修复措施：${request.remediation}。仅批准额外一次尝试，不修改门禁或项目上限。`,
      assignee: { agentId: "Main Agent", displayName: "Main Agent" }, poolId: undefined,
      producerTaskKey: request.task_key, producerWorkerId: (JSON.parse(request.failed_lease_json) as FailedLease).worker_id }];
  });
}
/** Runs inside the existing lease completion transaction, after the normal authenticated completion entry point. */
export function approveAgentTaskRetry(store: Store, lease: AgentTaskLease, input: CompleteInput): void {
  ensureSchema(store);
  const requestId = lease.taskId.slice("approval:retry:".length);
  const row = store.db.prepare("SELECT * FROM agent_task_retry_requests WHERE id=? AND project_id=?").get(requestId, lease.projectId) as RetryRow | undefined;
  if (!row || row.status !== "pending" || lease.actionCode !== RETRY_APPROVAL_ACTION || lease.role !== "approver"
    || normalizeAgentId(lease.agentId) !== normalizeAgentId("Main Agent") || !input.resultDigest?.trim()
    || input.workOrderId !== lease.workOrderId || input.taskKey !== lease.taskKey || input.taskRevision !== lease.taskRevision
    || input.workerId !== lease.workerId || input.role !== "approver")
    throw new AgentTaskLeaseError(409, "RETRY_APPROVAL_CONTEXT_INVALID", "必须由精确匹配的独立 Main Agent 审批工单提交审核结论");
  const failed = failure(store, row.project_id, row.task_key);
  const persisted = store.db.prepare("SELECT id FROM agent_task_leases WHERE id=? AND lease_token=? AND project_id=? AND task_key=? AND task_revision=? AND agent_id=? AND worker_id=? AND role='approver' AND action_code=? AND task_id=? AND status IN ('claimed','running') AND lease_expires_at>?")
    .get(lease.workOrderId, lease.leaseToken, lease.projectId, lease.taskKey, lease.taskRevision, lease.agentId, lease.workerId,
      RETRY_APPROVAL_ACTION, `approval:retry:${row.id}`, new Date().toISOString());
  if (!persisted) throw new AgentTaskLeaseError(409, "RETRY_APPROVAL_CONTEXT_INVALID", "审批租约不存在、已结束或已过期");
  const original = JSON.parse(row.failed_lease_json) as FailedLease;
  const identities = [lease.agentId, lease.workerId].map(normalizeAgentId);
  if ([original.agent_id, original.worker_id].map(normalizeAgentId).some((id) => identities.includes(id)))
    throw new AgentTaskLeaseError(409, "RETRY_SELF_APPROVAL_FORBIDDEN", "失败任务执行者不得批准自己的重试恢复");
  if (!matches(row, failed) || row.failed_attempt < getAgentTaskCapacity(store, row.project_id).maxAttempts || !listClaimableAgentTasks(store, row.project_id).some((task) => task.taskKey === row.task_key && task.taskRevision === row.task_revision))
    throw new AgentTaskLeaseError(409, "RETRY_TARGET_STALE", "失败工单或任务修订已变化");
  const target = JSON.parse(row.target_json) as AgentOrchestrationTask;
  if (JSON.stringify([...lease.workScopes].sort()) !== JSON.stringify([...(target.workScopes ?? [])].sort()))
    throw new AgentTaskLeaseError(409, "RETRY_APPROVAL_SCOPE_INVALID", "恢复审批必须绑定原任务资源范围");
  store.db.prepare("UPDATE agent_task_retry_requests SET status='approved',approved_work_order_id=?,approved_by=?,approval_note=?,approved_at=? WHERE id=? AND status='pending'")
    .run(lease.workOrderId, lease.agentId, input.resultDigest.trim(), new Date().toISOString(), row.id);
  store.recordAudit({ projectId: row.project_id, entityType: "agentTaskRetry", entityId: row.id, action: "approve", before: { status: "pending" },
    after: { status: "approved", additionalAttempts: 1, taskKey: row.task_key, failedWorkOrderId: row.failed_work_order_id, attempt: row.failed_attempt,
      approvalWorkOrderId: lease.workOrderId, note: input.resultDigest.trim() }, actor: lease.agentId, source: "system" });
}
/** The caller's immediate claim transaction rolls back this consumption if any later gate fails. */
export function consumeAgentTaskRetry(store: Store, previous: FailedLease | undefined, workOrderId: string): void {
  if (!previous) return;
  ensureSchema(store);
  const row = store.db.prepare(`UPDATE agent_task_retry_requests SET consumed_work_order_id=?,consumed_at=?
    WHERE project_id=? AND task_key=? AND task_revision=? AND failed_work_order_id=? AND failed_attempt=?
    AND status='approved' AND consumed_work_order_id='' RETURNING id`).get(workOrderId, new Date().toISOString(), previous.project_id,
      previous.task_key, previous.task_revision, previous.id, previous.attempt) as { id: string } | undefined;
  if (row) store.recordAudit({ projectId: previous.project_id, entityType: "agentTaskRetry", entityId: row.id, action: "consume", before: null,
    after: { failedWorkOrderId: previous.id, workOrderId, attempt: previous.attempt + 1 }, actor: "system", source: "system" });
}

/** Canonical nonce payload for both REST and MCP retry approval, excluding transport secrets. */
export function agentTaskRetryApprovalDigest(input: Pick<CompleteInput, "workOrderId" | "resultDigest" | "idempotencyKey">): string {
  return createHash("sha256").update(JSON.stringify({ workOrderId: input.workOrderId,
    resultDigest: input.resultDigest?.trim() ?? "", idempotencyKey: input.idempotencyKey })).digest("hex");
}
