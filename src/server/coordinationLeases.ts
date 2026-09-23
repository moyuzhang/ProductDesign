import { createHash, randomUUID } from "node:crypto";
import type {
  AgentBlueprintKey,
  AgentChildTaskDispatch,
  AgentChildDispatchStatus,
  AgentCoordinationLease,
  AgentCoordinationLeaseStatus,
  AgentCoordinationStage,
} from "../shared/types.js";
import { AGENT_COORDINATION_STAGES } from "../shared/types.js";
import { normalizeAgentId } from "../shared/planRoles.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";
import type { Store } from "./db.js";
import {
  AgentTaskLeaseError,
  claimAgentTask,
  AGENT_TASK_HEARTBEAT_SECONDS,
  ensureAgentTaskLeaseSchema,
  listClaimableAgentTasks,
  taskPackageLease,
  getAgentTaskLeaseByWorkOrder,
  type AgentTaskLease,
  type ClaimAgentTaskInput,
} from "./agentTaskLeases.js";
import { buildAgentOrchestration, buildAgentTaskPackage } from "./orchestration.js";

const ACTIVE_CHILD_STATUSES: AgentChildDispatchStatus[] = ["dispatched", "claimed", "running"];
const CHILD_ROLE_BY_STAGE: Partial<Record<AgentCoordinationStage, Exclude<AgentBlueprintKey, "approver">>> = {
  design: "designer",
  design_audit: "auditor",
  implementation: "builder",
  implementation_audit: "auditor",
};
const QUEUE_BY_STAGE: Partial<Record<AgentCoordinationStage, "design" | "development" | "audit">> = {
  design: "design",
  design_audit: "audit",
  implementation: "development",
  implementation_audit: "audit",
};
const NEXT_STAGE: Record<AgentCoordinationStage, AgentCoordinationStage | null> = {
  design: "design_audit",
  design_audit: "approval",
  approval: "implementation",
  implementation: "implementation_audit",
  implementation_audit: "acceptance",
  acceptance: "completed",
  completed: null,
};

function coordinationStageForPlan(plan: { lifecycleStatus: string; auditStatus: string; status: string; managerDecision: string; submittedAt?: string; approvedAt?: string }): AgentCoordinationStage {
  if (plan.lifecycleStatus === "accepted") return "completed";
  if (plan.lifecycleStatus === "pending_manager") return "acceptance";
  if (plan.lifecycleStatus === "pending_audit") return "implementation_audit";
  if (plan.lifecycleStatus === "audit_failed") return "implementation";
  if (plan.lifecycleStatus === "rework" && plan.managerDecision === "rejected") return "implementation";
  if (plan.lifecycleStatus === "approved" || plan.lifecycleStatus === "in_progress") return "implementation";
  if (plan.lifecycleStatus === "pending_approval") return plan.auditStatus === "passed" ? "approval" : "design_audit";
  // Draft, design rework, and legacy plans without a complete submission start in design.
  return "design";
}

interface CoordinationLeaseRow {
  id: string;
  project_id: string;
  target_plan_id: string;
  main_agent_id: string;
  worker_id: string;
  status: AgentCoordinationLeaseStatus;
  stage: AgentCoordinationStage;
  lease_token: string;
  lease_expires_at: string;
  heartbeat_at: string;
  dispatch_revision: number;
  created_at: string;
  updated_at: string;
}

interface DispatchRow {
  dispatch_id: string;
  coordination_lease_id: string;
  project_id: string;
  task_id: string;
  task_key: string;
  task_revision: string;
  stage: AgentCoordinationStage;
  role: Exclude<AgentBlueprintKey, "approver">;
  agent_id: string;
  worker_id: string;
  pool_id: string;
  status: AgentChildDispatchStatus;
  dispatch_version: number;
  child_work_order_id: string;
  created_at: string;
  updated_at: string;
}

export class CoordinationLeaseError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CoordinationLeaseError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function now(): string { return new Date().toISOString(); }
function requestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function expires(seconds = 1_800): string {
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1_800) {
    throw new CoordinationLeaseError(400, "INVALID_LEASE_DURATION", "leaseSeconds 必须是 15-1800 的整数");
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}
function mapLease(row: CoordinationLeaseRow, includeToken = true): AgentCoordinationLease {
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.target_plan_id || "",
    mainAgentId: row.main_agent_id,
    workerId: row.worker_id,
    status: row.status,
    stage: row.stage,
    ...(includeToken ? { leaseToken: row.lease_token } : { leaseToken: "" }),
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    dispatchRevision: row.dispatch_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapDispatch(row: DispatchRow): AgentChildTaskDispatch {
  return {
    dispatchId: row.dispatch_id,
    coordinationLeaseId: row.coordination_lease_id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskKey: row.task_key,
    taskRevision: row.task_revision,
    stage: row.stage,
    role: row.role,
    agentId: row.agent_id,
    workerId: row.worker_id,
    poolId: row.pool_id,
    status: row.status,
    dispatchVersion: row.dispatch_version,
    childWorkOrderId: row.child_work_order_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function coordinationRunnerPool(projectId: string): string {
  return `coordination:${projectId}`;
}

function upsertCoordinationRunner(store: Store, projectId: string, mainAgentId: string, workerId: string, sessionId: string, status: "online" | "offline"): void {
  const project = store.getProject(projectId);
  const timestamp = now();
  store.db.prepare(`
    INSERT INTO agent_runner_registrations (
      id, project_id, agent_id, worker_id, pool_id, session_id, role, capabilities_json,
      repository_path, workspace_path, status, last_seen_at, updated_at
    ) VALUES (@id, @projectId, @agentId, @workerId, @poolId, @sessionId, 'approver', '["coordination"]',
      @repositoryPath, '', @status, @timestamp, @timestamp)
    ON CONFLICT(project_id, worker_id) DO UPDATE SET
      agent_id=excluded.agent_id, pool_id=excluded.pool_id, session_id=excluded.session_id,
      role=excluded.role, capabilities_json=excluded.capabilities_json,
      repository_path=excluded.repository_path, status=excluded.status,
      last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
  `).run({
    id: randomUUID(), projectId, agentId: mainAgentId, workerId, poolId: coordinationRunnerPool(projectId),
    sessionId, repositoryPath: project?.repositoryPath ?? "", status, timestamp,
  });
}

function setCoordinationRunnerStatus(store: Store, projectId: string, mainAgentId: string, workerId: string, status: "online" | "offline"): void {
  const timestamp = now();
  store.db.prepare(`
    UPDATE agent_runner_registrations SET status=?, last_seen_at=?, updated_at=?
    WHERE project_id=? AND lower(agent_id)=lower(?) AND lower(worker_id)=lower(?)
  `).run(status, timestamp, timestamp, projectId, mainAgentId, workerId);
}

export function ensureCoordinationLeaseSchema(store: Store): void {
  ensureAgentTaskLeaseSchema(store);
  const columns = store.db.prepare("PRAGMA table_info(agent_task_leases)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "coordination_dispatch_id")) {
    store.db.exec("ALTER TABLE agent_task_leases ADD COLUMN coordination_dispatch_id TEXT NOT NULL DEFAULT ''");
  }
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_coordination_leases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      target_plan_id TEXT NOT NULL DEFAULT '',
      main_agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      dispatch_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_active_project
      ON agent_coordination_leases(project_id) WHERE status IN ('active', 'paused');
    CREATE TABLE IF NOT EXISTS agent_coordination_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_child_task_dispatches (
      dispatch_id TEXT PRIMARY KEY,
      coordination_lease_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      task_revision TEXT NOT NULL,
      stage TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      pool_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      dispatch_version INTEGER NOT NULL DEFAULT 1,
      child_work_order_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_child_dispatch_project_status
      ON agent_child_task_dispatches(project_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_child_dispatch_active_task
      ON agent_child_task_dispatches(project_id, task_key)
      WHERE status IN ('dispatched', 'claimed', 'running');
  `);
  const parentColumns = store.db.prepare("PRAGMA table_info(agent_coordination_leases)").all() as Array<{ name: string }>;
  if (!parentColumns.some((column) => column.name === "target_plan_id")) {
    store.db.exec("ALTER TABLE agent_coordination_leases ADD COLUMN target_plan_id TEXT NOT NULL DEFAULT ''");
  }
}

function expireCoordinationLeases(store: Store, projectId?: string): number {
  ensureCoordinationLeaseSchema(store);
  const timestamp = now();
  const staleAt = new Date(Date.now() - AGENT_TASK_HEARTBEAT_SECONDS * 2_000).toISOString();
  const rows = store.db.prepare(`SELECT * FROM agent_coordination_leases
    WHERE status IN ('active', 'paused') AND (
      lease_expires_at <= ? OR EXISTS (
        SELECT 1 FROM agent_runner_registrations r
        WHERE r.project_id=agent_coordination_leases.project_id
          AND lower(r.agent_id)=lower(agent_coordination_leases.main_agent_id)
          AND lower(r.worker_id)=lower(agent_coordination_leases.worker_id)
          AND r.status IN ('online', 'stale') AND r.last_seen_at <= ?
      )
    ) ${projectId ? "AND project_id=?" : ""}`)
    .all(...(projectId ? [timestamp, staleAt, projectId] : [timestamp, staleAt])) as CoordinationLeaseRow[];
  for (const row of rows) {
    store.db.prepare("UPDATE agent_coordination_leases SET status='expired', updated_at=? WHERE id=? AND status IN ('active','paused')")
      .run(timestamp, row.id);
    setCoordinationRunnerStatus(store, row.project_id, row.main_agent_id, row.worker_id, "offline");
    reclaimChildren(store, row.id, "coordination_lease_expired");
  }
  return rows.length;
}

function activeParent(store: Store, projectId: string, id: string, token: string, mainAgentId: string): CoordinationLeaseRow {
  expireCoordinationLeases(store, projectId);
  const row = store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=? AND project_id=? AND lease_token=?")
    .get(id, projectId, token) as CoordinationLeaseRow | undefined;
  if (!row || !["active", "paused"].includes(row.status) || row.lease_expires_at <= now()) {
    throw new CoordinationLeaseError(409, "COORDINATION_LEASE_LOST", "父协调租约已失效，请重新领取");
  }
  if (row.main_agent_id !== mainAgentId) {
    throw new CoordinationLeaseError(409, "MAIN_AGENT_MISMATCH", "父协调租约不属于当前 Main Agent");
  }
  return row;
}

/** Validate the plan-scoped parent lease used by Main Agent plan transitions. */
export function assertCoordinationLeaseForPlan(store: Store, input: {
  projectId: string;
  planId: string;
  coordinationLeaseId: string;
  coordinationLeaseToken: string;
  mainAgentId: string;
}): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.coordinationLeaseToken, input.mainAgentId);
  if (!parent.target_plan_id || parent.target_plan_id !== input.planId) {
    throw new CoordinationLeaseError(409, "COORDINATION_PLAN_MISMATCH", "父协调租约未绑定当前目标计划");
  }
  return mapLease(parent);
}

export interface ClaimCoordinationLeaseInput {
  projectId: string;
  /** The single delivery plan coordinated by this parent lease. */
  planId: string;
  mainAgentId: string;
  workerId: string;
  leaseSeconds?: number;
  idempotencyKey: string;
}

export function claimCoordinationLease(store: Store, input: ClaimCoordinationLeaseInput): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const project = store.getProject(input.projectId);
  if (!project) throw new CoordinationLeaseError(404, "PROJECT_NOT_FOUND", "项目不存在");
  if (!input.mainAgentId.trim() || !input.workerId.trim() || !input.idempotencyKey.trim()) {
    throw new CoordinationLeaseError(400, "COORDINATION_IDENTITY_REQUIRED", "Main Agent、workerId 和幂等键不能为空");
  }
  if (typeof input.planId !== "string" || !input.planId.trim()) {
    throw new CoordinationLeaseError(400, "COORDINATION_PLAN_REQUIRED", "必须指定目标计划才能领取父协调租约");
  }
  const targetPlanId = input.planId.trim();
  const targetPlan = store.getPlan(targetPlanId);
  if (!targetPlan || targetPlan.projectId !== input.projectId || !isExecutableDeliveryPlan(targetPlan)) {
    throw new CoordinationLeaseError(404, "COORDINATION_PLAN_NOT_FOUND", "目标计划不存在、不属于项目或不是可交付 task");
  }
  const initialStage = coordinationStageForPlan(targetPlan);
  if (initialStage === "completed") {
    throw new CoordinationLeaseError(409, "COORDINATION_PLAN_COMPLETED", "目标计划已经完成，无需领取父协调租约");
  }
  expireCoordinationLeases(store, input.projectId);
  return store.db.transaction(() => {
    const hash = requestHash(input);
    const cached = store.db.prepare("SELECT request_hash, response_json FROM agent_coordination_idempotency WHERE operation='claim' AND idempotency_key=?")
      .get(input.idempotencyKey) as { request_hash: string; response_json: string } | undefined;
    if (cached) {
      if (cached.request_hash !== hash) throw new CoordinationLeaseError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 不能用于不同父租约请求");
      const replay = JSON.parse(cached.response_json) as AgentCoordinationLease;
      const current = store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=? AND lease_token=?")
        .get(replay.id, replay.leaseToken) as CoordinationLeaseRow | undefined;
      if (!current || !["active", "paused"].includes(current.status) || current.lease_expires_at <= now()) {
        throw new CoordinationLeaseError(409, "COORDINATION_LEASE_LOST", "原父协调租约已结束或失效；不能重放为可执行授权");
      }
      upsertCoordinationRunner(store, current.project_id, current.main_agent_id, current.worker_id, current.id, "online");
      return mapLease(current);
    }
    const existing = store.db.prepare("SELECT * FROM agent_coordination_leases WHERE project_id=? AND status IN ('active','paused')")
      .get(input.projectId) as CoordinationLeaseRow | undefined;
    if (existing) {
      if (existing.main_agent_id === input.mainAgentId && existing.worker_id === input.workerId) {
        if (existing.target_plan_id && existing.target_plan_id !== targetPlanId) {
          throw new CoordinationLeaseError(409, "COORDINATION_PLAN_MISMATCH", "当前父协调租约已绑定其他目标计划");
        }
        if (!existing.target_plan_id) {
          const activeChild = store.db.prepare("SELECT 1 FROM agent_child_task_dispatches WHERE coordination_lease_id=? AND status IN ('dispatched','claimed','running') LIMIT 1").get(existing.id);
          if (activeChild) throw new CoordinationLeaseError(409, "COORDINATION_PLAN_MISMATCH", "已有未完成子任务，不能切换父协调租约目标计划");
          store.db.prepare("UPDATE agent_coordination_leases SET target_plan_id=?, stage=?, updated_at=? WHERE id=?").run(targetPlanId, initialStage, now(), existing.id);
        }
        upsertCoordinationRunner(store, existing.project_id, existing.main_agent_id, existing.worker_id, existing.id, "online");
        return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(existing.id) as CoordinationLeaseRow);
      }
      throw new CoordinationLeaseError(409, "COORDINATION_LEASE_BUSY", "项目已有有效父协调租约");
    }
    const activeTask = store.db.prepare(`SELECT 1 FROM agent_task_leases
      WHERE project_id=? AND lower(worker_id)=lower(?) AND status IN ('claimed','running') AND lease_expires_at > ? LIMIT 1`)
      .get(input.projectId, input.workerId, now());
    if (activeTask) throw new CoordinationLeaseError(409, "COORDINATION_RUNNER_BUSY", "该 workerId 正在执行子任务，不能同时作为 Main Agent 协调 Runner");
    const activeRunner = store.db.prepare(`SELECT agent_id FROM agent_runner_registrations
      WHERE project_id=? AND lower(worker_id)=lower(?) AND status='online' LIMIT 1`)
      .get(input.projectId, input.workerId) as { agent_id: string } | undefined;
    if (activeRunner && normalizeAgentId(activeRunner.agent_id) !== normalizeAgentId(input.mainAgentId)) {
      throw new CoordinationLeaseError(409, "COORDINATION_RUNNER_BUSY", "该 workerId 已被其他 Runner 占用");
    }
    const timestamp = now();
    const row = {
      id: randomUUID(), projectId: input.projectId, targetPlanId, mainAgentId: input.mainAgentId.trim(), workerId: input.workerId.trim(),
      leaseToken: randomUUID(), leaseExpiresAt: expires(input.leaseSeconds), stage: initialStage, timestamp,
    };
    store.db.prepare(`INSERT INTO agent_coordination_leases
      (id, project_id, target_plan_id, main_agent_id, worker_id, status, stage, lease_token, lease_expires_at, heartbeat_at, dispatch_revision, created_at, updated_at)
      VALUES (@id,@projectId,@targetPlanId,@mainAgentId,@workerId,'active',@stage,@leaseToken,@leaseExpiresAt,@timestamp,0,@timestamp,@timestamp)`).run(row);
    const created = store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(row.id) as CoordinationLeaseRow;
    upsertCoordinationRunner(store, input.projectId, row.mainAgentId, row.workerId, row.id, "online");
    store.recordAudit({ projectId: input.projectId, entityType: "agentCoordinationLease", entityId: row.id, action: "claim", before: null,
      after: { mainAgentId: row.mainAgentId, workerId: row.workerId, planId: row.targetPlanId, stage: row.stage }, actor: row.mainAgentId, source: "system" });
    const result = mapLease(created);
    store.db.prepare("INSERT INTO agent_coordination_idempotency (operation,idempotency_key,request_hash,response_json,created_at) VALUES ('claim',?,?,?,?)")
      .run(input.idempotencyKey, hash, JSON.stringify(result), timestamp);
    return result;
  }).immediate();
}

export function heartbeatCoordinationLease(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string; leaseSeconds?: number }): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const row = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  const timestamp = now();
  store.db.prepare("UPDATE agent_coordination_leases SET lease_expires_at=?, heartbeat_at=?, updated_at=? WHERE id=?")
    .run(expires(input.leaseSeconds), timestamp, timestamp, row.id);
  upsertCoordinationRunner(store, row.project_id, row.main_agent_id, row.worker_id, row.id, "online");
  return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(row.id) as CoordinationLeaseRow);
}

export function listCoordinationLeases(store: Store, projectId: string): Array<Omit<AgentCoordinationLease, "leaseToken">> {
  ensureCoordinationLeaseSchema(store);
  expireCoordinationLeases(store, projectId);
  return (store.db.prepare("SELECT * FROM agent_coordination_leases WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as CoordinationLeaseRow[])
    .map((row) => ({ ...mapLease(row, false), leaseToken: undefined } as Omit<AgentCoordinationLease, "leaseToken">));
}

function expectedChild(store: Store, parent: CoordinationLeaseRow, taskId: string, taskKey: string | undefined, role: Exclude<AgentBlueprintKey, "approver">): { taskKey: string; taskRevision: string; taskId: string; planId: string; poolId: string; agentId: string; workScopes: string[] } {
  const queue = QUEUE_BY_STAGE[parent.stage];
  if (!queue || CHILD_ROLE_BY_STAGE[parent.stage] !== role) {
    throw new CoordinationLeaseError(409, "STAGE_ACTION_FORBIDDEN", `阶段 ${parent.stage} 不能派发 ${role}`);
  }
  const task = listClaimableAgentTasks(store, parent.project_id).find((candidate) => candidate.queue === queue
    // When Main Agent names an exact task, resolve it before applying the
    // parent plan filter so a cross-plan dispatch gets the explicit mismatch
    // error instead of looking like a missing task.
    && (taskId ? candidate.id === taskId : taskKey ? candidate.taskKey === taskKey : (!parent.target_plan_id || candidate.planItemId === parent.target_plan_id)));
  if (!task) throw new CoordinationLeaseError(404, "CHILD_TASK_NOT_FOUND", "指定任务不在当前阶段队列中");
  if (parent.target_plan_id && task.planItemId !== parent.target_plan_id) {
    throw new CoordinationLeaseError(409, "COORDINATION_PLAN_MISMATCH", "子任务不属于父协调租约的目标计划");
  }
  if (task.requiredRole !== role) throw new CoordinationLeaseError(409, "ROLE_MISMATCH", `任务必须由 ${task.requiredRole} 处理`);
  if ((parent.stage === "design_audit" && task.auditScope !== "design")
    || (parent.stage === "implementation_audit" && task.auditScope !== "implementation")
    || (parent.stage === "design" && task.deliveryTrack !== "design")
    || (parent.stage === "implementation" && task.deliveryTrack !== "implementation")) {
    throw new CoordinationLeaseError(409, "STAGE_TASK_MISMATCH", "任务线路与当前协调阶段不匹配");
  }
  if (!task.available) throw new CoordinationLeaseError(409, "CHILD_TASK_NOT_AVAILABLE", task.availabilityReason || "任务当前不可派发");
  return {
    taskKey: task.taskKey,
    taskRevision: task.taskRevision,
    taskId: task.id,
    planId: task.planItemId ?? "",
    poolId: task.poolId || "",
    agentId: task.assignee?.agentId || "",
    workScopes: task.workScopes || [],
  };
}

export interface DispatchChildTaskInput {
  projectId: string;
  coordinationLeaseId: string;
  leaseToken: string;
  mainAgentId: string;
  taskId: string;
  taskKey?: string;
  role: Exclude<AgentBlueprintKey, "approver">;
  agentId?: string;
  workerId?: string;
  poolId?: string;
}

export function dispatchChildTask(store: Store, input: DispatchChildTaskInput): AgentChildTaskDispatch {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  if (!parent.target_plan_id) throw new CoordinationLeaseError(409, "COORDINATION_PLAN_REQUIRED", "父协调租约未绑定目标计划，请重新领取");
  if (parent.status !== "active") throw new CoordinationLeaseError(409, "COORDINATION_PAUSED", "父协调租约已暂停");
  const expected = expectedChild(store, parent, input.taskId, input.taskKey, input.role);
  const agentId = input.agentId?.trim() || expected.agentId;
  const workerId = input.workerId?.trim() || agentId;
  const poolId = input.poolId?.trim() || expected.poolId;
  if (!agentId || !workerId) throw new CoordinationLeaseError(409, "CHILD_IDENTITY_REQUIRED", "派发必须指定子 Agent 和 workerId");
  if (expected.agentId && normalizeAgentId(agentId) !== normalizeAgentId(expected.agentId)) {
    throw new CoordinationLeaseError(409, "ASSIGNEE_MISMATCH", `任务已分配给 ${expected.agentId}`, {
      expectedAgentId: expected.agentId,
      taskKey: expected.taskKey,
    });
  }
  if (expected.poolId && poolId !== expected.poolId) {
    throw new CoordinationLeaseError(409, "WORKER_POOL_MISMATCH", `任务属于 Worker 池 ${expected.poolId}`, {
      expectedPoolId: expected.poolId,
      taskKey: expected.taskKey,
    });
  }
  const timestamp = now();
  const dispatchId = randomUUID();
  try {
    store.db.prepare(`INSERT INTO agent_child_task_dispatches
      (dispatch_id, coordination_lease_id, project_id, task_id, task_key, task_revision, stage, role, agent_id, worker_id, pool_id, status, dispatch_version, child_work_order_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'dispatched',1,'',?,?)`).run(
      dispatchId, parent.id, input.projectId, expected.taskId, expected.taskKey, expected.taskRevision, parent.stage, input.role,
      agentId, workerId, poolId, timestamp, timestamp,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new CoordinationLeaseError(409, "CHILD_TASK_ALREADY_DISPATCHED", "该任务已有活动派发");
    throw error;
  }
  store.db.prepare("UPDATE agent_coordination_leases SET dispatch_revision=dispatch_revision+1, updated_at=? WHERE id=?").run(timestamp, parent.id);
  return mapDispatch(store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatchId) as DispatchRow);
}

function reclaimChildren(store: Store, coordinationLeaseId: string, reason: string, onlyDispatchId?: string): number {
  const where = onlyDispatchId ? "AND dispatch_id=?" : "";
  const args = onlyDispatchId ? [coordinationLeaseId, onlyDispatchId] : [coordinationLeaseId];
  const rows = store.db.prepare(`SELECT * FROM agent_child_task_dispatches WHERE coordination_lease_id=? AND status IN ('dispatched','claimed','running') ${where}`)
    .all(...args) as DispatchRow[];
  const timestamp = now();
  for (const row of rows) {
    if (row.child_work_order_id) {
      const child = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND status IN ('claimed','running')")
        .get(row.child_work_order_id) as { lease_token: string; worker_id: string; project_id: string } | undefined;
      if (child) {
        store.db.prepare("UPDATE agent_task_leases SET status='released', last_error=?, completed_at=?, updated_at=? WHERE id=? AND status IN ('claimed','running')")
          .run(reason, timestamp, timestamp, row.child_work_order_id);
        store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(child.lease_token);
        store.db.prepare("UPDATE agent_task_workspace_reservations SET status='released', updated_at=? WHERE lease_token=?").run(timestamp, child.lease_token);
        store.db.prepare("UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=? WHERE project_id=? AND worker_id=?")
          .run(timestamp, timestamp, child.project_id, child.worker_id);
      }
    }
    store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
      .run(timestamp, row.dispatch_id);
  }
  return rows.length;
}

export function reclaimChildTask(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string; dispatchId: string; reason?: string }): AgentChildTaskDispatch {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  const row = store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE dispatch_id=? AND coordination_lease_id=?")
    .get(input.dispatchId, parent.id) as DispatchRow | undefined;
  if (!row) throw new CoordinationLeaseError(404, "DISPATCH_NOT_FOUND", "未找到子任务派发");
  if (!ACTIVE_CHILD_STATUSES.includes(row.status)) throw new CoordinationLeaseError(409, "DISPATCH_NOT_ACTIVE", "子任务派发已结束");
  reclaimChildren(store, parent.id, input.reason?.trim() || "reclaimed_by_main_agent", row.dispatch_id);
  return mapDispatch(store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE dispatch_id=?").get(row.dispatch_id) as DispatchRow);
}

export function reassignChildTask(store: Store, input: DispatchChildTaskInput & { dispatchId: string; reason?: string }): AgentChildTaskDispatch {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  const existing = store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE dispatch_id=? AND coordination_lease_id=?")
    .get(input.dispatchId, parent.id) as DispatchRow | undefined;
  if (!existing || !ACTIVE_CHILD_STATUSES.includes(existing.status)) throw new CoordinationLeaseError(409, "DISPATCH_NOT_ACTIVE", "子任务派发已结束");
  reclaimChildren(store, parent.id, input.reason?.trim() || "reassigned_by_main_agent", existing.dispatch_id);
  const next = dispatchChildTask(store, { ...input, taskId: existing.task_id, taskKey: existing.task_key, role: existing.role });
  store.db.prepare("UPDATE agent_child_task_dispatches SET dispatch_version=?, status='dispatched' WHERE dispatch_id=?")
    .run(existing.dispatch_version + 1, next.dispatchId);
  return mapDispatch(store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE dispatch_id=?").get(next.dispatchId) as DispatchRow);
}

export function pauseCoordinationLease(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string }): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  reclaimChildren(store, parent.id, "coordination_lease_paused");
  store.db.prepare("UPDATE agent_coordination_leases SET status='paused', updated_at=? WHERE id=?").run(now(), parent.id);
  return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(parent.id) as CoordinationLeaseRow);
}

export function resumeCoordinationLease(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string }): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  if (parent.status !== "paused") throw new CoordinationLeaseError(409, "COORDINATION_NOT_PAUSED", "父协调租约当前不是暂停状态");
  store.db.prepare("UPDATE agent_coordination_leases SET status='active', updated_at=? WHERE id=?").run(now(), parent.id);
  return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(parent.id) as CoordinationLeaseRow);
}

export function releaseCoordinationLease(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string; reason?: string }): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  reclaimChildren(store, parent.id, input.reason?.trim() || "released_by_main_agent");
  store.db.prepare("UPDATE agent_coordination_leases SET status='released', updated_at=? WHERE id=?").run(now(), parent.id);
  setCoordinationRunnerStatus(store, parent.project_id, parent.main_agent_id, parent.worker_id, "offline");
  return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(parent.id) as CoordinationLeaseRow);
}

export function advanceCoordinationStage(store: Store, input: { projectId: string; coordinationLeaseId: string; leaseToken: string; mainAgentId: string; stage?: AgentCoordinationStage }): AgentCoordinationLease {
  ensureCoordinationLeaseSchema(store);
  const parent = activeParent(store, input.projectId, input.coordinationLeaseId, input.leaseToken, input.mainAgentId);
  const next = NEXT_STAGE[parent.stage];
  if (!next || (input.stage && input.stage !== next)) throw new CoordinationLeaseError(409, "STAGE_ORDER_VIOLATION", `不能从 ${parent.stage} 跳转到 ${input.stage || "下一阶段"}`);
  const active = store.db.prepare("SELECT 1 FROM agent_child_task_dispatches WHERE coordination_lease_id=? AND status IN ('dispatched','claimed','running') LIMIT 1").get(parent.id);
  if (active) throw new CoordinationLeaseError(409, "CHILD_TASK_IN_PROGRESS", "当前阶段仍有未完成的子任务");
  const hasDispatch = store.db.prepare("SELECT 1 FROM agent_child_task_dispatches WHERE coordination_lease_id=? AND stage=? AND status='completed' LIMIT 1").get(parent.id, parent.stage);
  if (CHILD_ROLE_BY_STAGE[parent.stage] && !hasDispatch) throw new CoordinationLeaseError(409, "CHILD_TASK_NOT_COMPLETED", "必须先完成当前阶段的子任务");
  const timestamp = now();
  store.db.prepare("UPDATE agent_coordination_leases SET stage=?, dispatch_revision=dispatch_revision+1, updated_at=? WHERE id=?").run(next, timestamp, parent.id);
  return mapLease(store.db.prepare("SELECT * FROM agent_coordination_leases WHERE id=?").get(parent.id) as CoordinationLeaseRow);
}

export function listChildTaskDispatches(store: Store, projectId: string, coordinationLeaseId?: string): AgentChildTaskDispatch[] {
  ensureCoordinationLeaseSchema(store);
  expireCoordinationLeases(store, projectId);
  const rows = (coordinationLeaseId
    ? store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE project_id=? AND coordination_lease_id=? ORDER BY created_at").all(projectId, coordinationLeaseId)
    : store.db.prepare("SELECT * FROM agent_child_task_dispatches WHERE project_id=? ORDER BY created_at").all(projectId)) as DispatchRow[];
  return rows.map(mapDispatch);
}

export interface ClaimDispatchedChildTaskInput {
  projectId: string;
  dispatchId: string;
  agentId: string;
  workerId: string;
  poolId?: string;
  sessionId?: string;
  runId?: string;
  capabilities?: string[];
  leaseSeconds?: number;
  idempotencyKey: string;
}

export function claimDispatchedChildTask(store: Store, input: ClaimDispatchedChildTaskInput): string {
  ensureCoordinationLeaseSchema(store);
  expireCoordinationLeases(store, input.projectId);
  const dispatch = store.db.prepare("SELECT d.*, c.status AS parent_status, c.lease_expires_at AS parent_expires FROM agent_child_task_dispatches d JOIN agent_coordination_leases c ON c.id=d.coordination_lease_id WHERE d.dispatch_id=? AND d.project_id=?")
    .get(input.dispatchId, input.projectId) as (DispatchRow & { parent_status: string; parent_expires: string }) | undefined;
  if (!dispatch) throw new CoordinationLeaseError(404, "DISPATCH_NOT_FOUND", "未找到子任务派发");
  if (!ACTIVE_CHILD_STATUSES.includes(dispatch.status) || dispatch.parent_status !== "active" || dispatch.parent_expires <= now()) {
    throw new CoordinationLeaseError(409, "DISPATCH_LOST", "父协调租约或子任务派发已失效");
  }
  if (dispatch.agent_id !== input.agentId || dispatch.worker_id !== input.workerId) {
    throw new CoordinationLeaseError(409, "CHILD_IDENTITY_MISMATCH", "只能由 Main Agent 派发的精确子 Agent/workerId 领取");
  }
  if (dispatch.status !== "dispatched" && dispatch.child_work_order_id) {
    const current = getAgentTaskLeaseByWorkOrder(store, dispatch.child_work_order_id);
    if (current && ["claimed", "running"].includes(current.status)) {
      const snapshot = buildAgentOrchestration(store, input.projectId, true);
      if (!snapshot) throw new CoordinationLeaseError(404, "PROJECT_NOT_FOUND", "项目不存在");
      return JSON.stringify(buildAgentTaskPackage(store, input.projectId, {
        queue: dispatch.stage === "design" ? "design" : dispatch.stage === "implementation" ? "development" : "audit",
        taskId: dispatch.task_id,
        lease: taskPackageLease(current),
        allowCoordinationAssignmentOverride: true,
      }, snapshot), null, 2);
    }
  }
  const leaseInput: ClaimAgentTaskInput = {
    projectId: input.projectId, taskId: dispatch.task_id, taskKey: dispatch.task_key, role: dispatch.role,
    agentId: input.agentId, workerId: input.workerId, poolId: input.poolId || dispatch.pool_id,
    sessionId: input.sessionId, runId: input.runId, capabilities: input.capabilities, leaseSeconds: input.leaseSeconds,
    idempotencyKey: input.idempotencyKey, coordinationDispatchId: dispatch.dispatch_id,
  };
  const lease = claimAgentTask(store, leaseInput, { actor: input.agentId, source: "mcp", clientId: "productdesign-coordination" });
  const timestamp = now();
  store.db.prepare("UPDATE agent_child_task_dispatches SET status='claimed', child_work_order_id=?, updated_at=? WHERE dispatch_id=? AND status='dispatched'")
    .run(lease.workOrderId, timestamp, dispatch.dispatch_id);
  const snapshot = buildAgentOrchestration(store, input.projectId, true);
  if (!snapshot) throw new CoordinationLeaseError(404, "PROJECT_NOT_FOUND", "项目不存在");
  return JSON.stringify(buildAgentTaskPackage(store, input.projectId, {
    queue: dispatch.stage === "design" ? "design" : dispatch.stage === "implementation" ? "development" : "audit",
    taskId: dispatch.task_id,
    lease: taskPackageLease(lease),
    allowCoordinationAssignmentOverride: true,
  }, snapshot), null, 2);
}

export function markChildDispatchFromLease(store: Store, lease: AgentTaskLease, status: "running" | "completed"): void {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) return;
  store.db.prepare("UPDATE agent_child_task_dispatches SET status=?, updated_at=? WHERE child_work_order_id=? AND status IN ('claimed','running')")
    .run(status, now(), lease.workOrderId);
}

export function invalidateChildLeaseIfParentLost(store: Store, workOrderId: string): boolean {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) return false;
  const row = store.db.prepare(`SELECT c.status, c.lease_expires_at, d.dispatch_id FROM agent_task_leases l
    LEFT JOIN agent_child_task_dispatches d ON d.child_work_order_id=l.id
    LEFT JOIN agent_coordination_leases c ON c.id=d.coordination_lease_id WHERE l.id=?`).get(workOrderId) as { status?: string; lease_expires_at?: string; dispatch_id?: string } | undefined;
  if (!row?.dispatch_id || row.status === "active" && (row.lease_expires_at || "") > now()) return false;
  store.db.prepare("UPDATE agent_task_leases SET status='released', last_error='coordination_lease_lost', completed_at=?, updated_at=? WHERE id=? AND status IN ('claimed','running')")
    .run(now(), now(), workOrderId);
  store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
    .run(now(), row.dispatch_id);
  return true;
}

export const coordinationStages = AGENT_COORDINATION_STAGES;
export { AGENT_COORDINATION_STAGES };
