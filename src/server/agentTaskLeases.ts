import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type {
  AgentAuditScope,
  AgentBlueprintKey,
  AgentExecutableQueueKey,
  AgentOrchestration,
  AgentOrchestrationTask,
  AgentRunnerRegistration,
  AgentWorkerPool,
  AgentTaskCapacity,
  AgentTaskLeaseStatus,
  AgentTaskLeaseSummary,
  AgentTaskPackage,
  AgentOrchestrationQueueKey,
  Paginated,
} from "../shared/types.js";
import { normalizeAgentId } from "../shared/planRoles.js";
import {
  effectiveAgentTaskAssignment,
  implicitAgentTaskPoolId,
} from "../shared/agentTaskAssignment.js";
import type { Store } from "./db.js";
import { buildAgentOrchestration } from "./orchestration.js";
import {
  AgentSecurityError,
  assertAgentWorkOrderContext,
  isAgentSecurityEnforced,
  resolveAuthPrincipal,
  type WorkOrderContextInput,
} from "./agentSecurity.js";
import {
  blockEvidenceRepairState,
  failEvidenceRepairAttempt,
  getEvidenceRepairState,
  inspectEvidenceRepairPreflight,
  openEvidenceRepairState,
} from "./evidenceRepair.js";
import { matchesImplementationEvidencePolicy } from "./evidencePolicy.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";
import { getAgentTaskAssignmentGeneration } from "./agentTaskReassignment.js";
import { assertNoDesignGap, developmentTaskRevision, getDesignGap } from "./designGap.js";

const DEFAULT_LEASE_SECONDS = 1_800;
const MIN_LEASE_SECONDS = 15;
const MAX_LEASE_SECONDS = 1_800;
export const AGENT_TASK_HEARTBEAT_SECONDS = 300;
const DEFAULT_CAPACITY: Omit<AgentTaskCapacity, "projectId" | "updatedAt"> = {
  maxActive: 4,
  designerMaxActive: 1,
  builderMaxActive: 4,
  auditorMaxActive: 2,
  maxAttempts: 3,
  retryBackoffSeconds: 30,
};
const RUNNER_STALE_SECONDS = AGENT_TASK_HEARTBEAT_SECONDS * 2;

export interface ClaimableAgentTask extends AgentOrchestrationTask {
  taskKey: string;
  taskRevision: string;
  requiredRole: AgentBlueprintKey;
  available: boolean;
  availabilityReason: string;
  attempt: number;
  retryAvailableAt: string;
  activeLease: NonNullable<AgentOrchestrationTask["activeLease"]> | null;
}

export interface AgentTaskLease {
  coordinationDispatchId?: string;
  approvalGroupId?: string;
  workOrderId: string;
  taskKey: string;
  taskId: string;
  taskRevision: string;
  projectId: string;
  queue: AgentExecutableQueueKey;
  role: AgentBlueprintKey;
  actionCode: string;
  status: AgentTaskLeaseStatus;
  leaseToken: string;
  agentId: string;
  workerId: string;
  poolId: string;
  sessionId: string;
  runId: string;
  leaseExpiresAt: string;
  attempt: number;
  resultDigest: string;
  lastError: string;
  claimedAt: string;
  startedAt: string;
  heartbeatAt: string;
  completedAt: string;
  retryAvailableAt: string;
  workScopes: string[];
  workspaceKey: string;
  workspaceRecommendedPath: string;
  workspacePath: string;
  workspaceBranch: string;
  baselineRevision: string;
  updatedAt: string;
}

interface LeaseRow {
  coordination_dispatch_id: string;
  approval_group_id: string;
  id: string;
  task_key: string;
  task_id: string;
  task_revision: string;
  project_id: string;
  queue: AgentExecutableQueueKey;
  role: AgentBlueprintKey;
  action_code: string;
  status: AgentTaskLeaseStatus;
  lease_token: string;
  agent_id: string;
  worker_id: string;
  pool_id: string;
  session_id: string;
  run_id: string;
  lease_expires_at: string;
  attempt: number;
  result_digest: string;
  last_error: string;
  claimed_at: string;
  started_at: string;
  heartbeat_at: string;
  completed_at: string;
  retry_available_at: string;
  work_scopes_json: string;
  workspace_key: string;
  workspace_recommended_path: string;
  workspace_path: string;
  workspace_branch: string;
  baseline_revision: string;
  repair_snapshot_json: string;
  updated_at: string;
}

interface CapacityRow {
  project_id: string;
  max_active: number;
  designer_max_active: number;
  builder_max_active: number;
  auditor_max_active: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  updated_at: string;
}

interface RunnerRow {
  id: string;
  project_id: string;
  agent_id: string;
  worker_id: string;
  pool_id: string;
  session_id: string;
  role: AgentBlueprintKey;
  capabilities_json: string;
  repository_path: string;
  workspace_path: string;
  status: "online" | "stale" | "offline";
  last_seen_at: string;
  updated_at: string;
}

interface WorkerPoolRow {
  id: string;
  project_id: string;
  role: AgentBlueprintKey;
  name: string;
  max_active: number;
  capabilities_json: string;
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

export interface AgentTaskLeaseContext {
  actor?: string;
  source?: "web" | "mcp" | "system";
  clientId?: string;
  sessionId?: string;
  model?: string;
  /** Human-only lease management reason recorded in the audit trail. */
  reason?: string;
  securityAction?: string;
  securityTarget?: string;
}

export class AgentTaskLeaseError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentTaskLeaseError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const ROLE_BY_QUEUE: Record<AgentExecutableQueueKey, AgentBlueprintKey> = {
  design: "designer",
  development: "builder",
  audit: "auditor",
  approval: "approver",
};

const QUEUE_BY_ROLE: Record<AgentBlueprintKey, AgentExecutableQueueKey> = {
  designer: "design",
  builder: "development",
  auditor: "audit",
  approver: "approval",
};

function mapLease(row: LeaseRow): AgentTaskLease {
  let workScopes: string[] = [];
  try { workScopes = JSON.parse(row.work_scopes_json || "[]") as string[]; } catch { workScopes = []; }
  return {
    coordinationDispatchId: row.coordination_dispatch_id || undefined,
    approvalGroupId: row.approval_group_id || undefined,
    workOrderId: row.id || row.lease_token,
    taskKey: row.task_key,
    taskId: row.task_id,
    taskRevision: row.task_revision,
    projectId: row.project_id,
    queue: row.queue,
    role: row.role,
    actionCode: row.action_code,
    status: row.status,
    leaseToken: row.lease_token,
    agentId: row.agent_id,
    workerId: row.worker_id || row.agent_id,
    poolId: row.pool_id || "",
    sessionId: row.session_id,
    runId: row.run_id,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    resultDigest: row.result_digest,
    lastError: row.last_error,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    completedAt: row.completed_at,
    retryAvailableAt: row.retry_available_at || "",
    workScopes,
    workspaceKey: row.workspace_key || "",
    workspaceRecommendedPath: row.workspace_recommended_path || "",
    workspacePath: row.workspace_path || "",
    workspaceBranch: row.workspace_branch || "",
    baselineRevision: row.baseline_revision || "",
    updatedAt: row.updated_at,
  };
}

function mapCapacity(row: CapacityRow): AgentTaskCapacity {
  return {
    projectId: row.project_id,
    maxActive: row.max_active,
    designerMaxActive: row.designer_max_active,
    builderMaxActive: row.builder_max_active,
    auditorMaxActive: row.auditor_max_active,
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    updatedAt: row.updated_at,
  };
}

function mapRunner(row: RunnerRow): AgentRunnerRegistration {
  let capabilities: string[] = [];
  try { capabilities = JSON.parse(row.capabilities_json) as string[]; } catch { capabilities = []; }
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    workerId: row.worker_id || row.agent_id,
    poolId: row.pool_id || "",
    sessionId: row.session_id,
    role: row.role,
    capabilities,
    repositoryPath: row.repository_path,
    workspacePath: row.workspace_path || "",
    status: row.status,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkerPool(row: WorkerPoolRow): AgentWorkerPool {
  let capabilities: string[] = [];
  try { capabilities = JSON.parse(row.capabilities_json || "[]") as string[]; } catch { capabilities = []; }
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    name: row.name,
    maxActive: row.max_active,
    capabilities,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withoutToken(lease: AgentTaskLease): Omit<AgentTaskLease, "leaseToken"> {
  const { leaseToken: _leaseToken, ...safe } = lease;
  return safe;
}

function revisionForTask(store: Store, task: AgentOrchestrationTask): string {
  if (task.planItemId) {
    const plan = store.getPlan(task.planItemId);
    if (!plan) return "0";
    const gap = task.actionCode === "request_design_change" ? getDesignGap(store, plan) : undefined;
    const gapRevision = createHash("sha256").update(JSON.stringify([plan.designRevisionIds, plan.dependencyIds,
      plan.designRevisionIds.map((id) => {
        const revision = store.getDocumentRevision(id);
        const doc = revision && store.getDesignDoc(revision.documentId);
        return [id, doc?.currentRevisionId, doc?.status];
      })])).digest("hex");
    if (gap) return `${plan.proposalRevision}:request_design_change:gap:${gap.id}:${gapRevision}`;
    if (task.actionCode === "request_design_change" && task.designChangeIntent) {
      return `${plan.proposalRevision}:request_design_change:intent:${task.designChangeIntent.intentId}:${task.designChangeIntent.snapshotHash}`;
    }
    if (task.actionCode === "request_design_change" && task.correlationId.startsWith("design-gap:")) {
      return `${plan.proposalRevision}:request_design_change:${task.correlationId}:${gapRevision}`;
    }
    if (["submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "request_design_change"].includes(task.actionCode)) {
      const generation = getEvidenceRepairState(store, plan.id)?.generation ?? 0;
      return `${plan.proposalRevision}:${task.actionCode}:repair:${generation}`;
    }
    if (task.queue === "development") return developmentTaskRevision(store, plan);
    if (task.queue === "audit" && task.auditScope === "design") {
      return `${plan.proposalRevision}:design:${plan.designRevisionIds.join(",") || plan.submittedAt || "initial"}`;
    }
    if (task.queue === "audit") {
      const assignmentGeneration = getAgentTaskAssignmentGeneration(store, plan.id, task.actionCode);
      const baseRevision = `${plan.proposalRevision}:implementation:${plan.completedAt || plan.implementationRevision || "initial"}`;
      return assignmentGeneration > 0 ? `${baseRevision}:assignment:${assignmentGeneration}` : baseRevision;
    }
    if (task.actionCode === "approve_acceptance") {
      // 验收任务必须随本次实现完成而更换修订：证据修复路径不递增 proposalRevision，
      // 若沿用固定的 proposalRevision:actionCode，重审后的验收会与上一次已完成租约撞车。
      return `${plan.proposalRevision}:approve_acceptance:${plan.completedAt || plan.implementationRevision || "initial"}`;
    }
    if (task.queue === "approval") return `${plan.proposalRevision}:${task.actionCode}`;
    return String(plan.proposalRevision);
  }
  if (task.queue === "approval" && task.actionCode.startsWith("approve_node_") && task.nodeId) {
    if (task.actionCode === "approve_node_requirement") {
      const node = store.getDiagram(task.diagramId || "")?.nodes.find((item) => item.id === task.nodeId);
      return `${task.actionCode}:${createHash("sha256").update(JSON.stringify([
        node?.description?.trim() || "", node?.owner?.trim() || "",
        node?.acceptanceCriteria?.trim() || "", node?.requirementStatus || "",
      ])).digest("hex")}`;
    }
    const currentRevisionIds = store.listDocumentReferences({
      projectId: task.projectId,
      targetType: "diagramNode",
      targetId: task.nodeId,
    }).flatMap((reference) => {
      const document = store.getDesignDoc(reference.documentId);
      return document ? [document.currentRevisionId] : [];
    });
    return `${task.actionCode}:${[...new Set(currentRevisionIds)].sort().join(",") || "initial"}`;
  }
  return "0";
}

function repositoryHead(repositoryPath: string): string {
  if (!repositoryPath.trim()) {
    throw new AgentTaskLeaseError(409, "REPAIR_REPOSITORY_REQUIRED", "证据修复开工前项目必须配置受控 Git repositoryPath");
  }
  try {
    const head = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    }).trim();
    if (!head) throw new Error("empty HEAD");
    return head;
  } catch {
    throw new AgentTaskLeaseError(409, "REPAIR_REPOSITORY_HEAD_UNAVAILABLE", "无法读取受控仓库 HEAD，证据修复不得开工");
  }
}

export function agentTaskKey(projectId: string, task: AgentOrchestrationTask, revision: string): string {
  return `v1:${projectId}:${task.queue}:${encodeURIComponent(task.id)}:${revision}`;
}

function isoAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function normalizeLeaseSeconds(seconds: number | undefined): number {
  const value = seconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(value) || value < MIN_LEASE_SECONDS || value > MAX_LEASE_SECONDS) {
    throw new AgentTaskLeaseError(400, "INVALID_LEASE_DURATION", `leaseSeconds 必须是 ${MIN_LEASE_SECONDS}-${MAX_LEASE_SECONDS} 的整数`);
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function evidenceRepairStartPayload(input: Partial<StartInput>): Record<string, unknown> {
  return {
    workOrderId: input.workOrderId?.trim() || "",
    leaseToken: input.leaseToken?.trim() || "",
    taskKey: input.taskKey?.trim() || "",
    taskRevision: input.taskRevision?.trim() || "",
    workerId: input.workerId?.trim() || "",
    agentId: input.agentId?.trim() || "",
    role: input.role?.trim() || "",
    idempotencyKey: input.idempotencyKey?.trim() || "",
    coordinationDispatchId: input.coordinationDispatchId?.trim() || "",
    workspacePath: input.workspacePath?.trim() || "",
    workspaceBranch: input.workspaceBranch?.trim() || "",
    baselineRevision: input.baselineRevision?.trim() || "",
  };
}

export function evidenceRepairStartBodyDigest(input: Partial<StartInput>): string {
  return requestHash(evidenceRepairStartPayload(input));
}

function leaseControlRequestHash(operation: string, input: unknown): string {
  return operation === "start" ? requestHash(evidenceRepairStartPayload(input as Partial<StartInput>)) : requestHash(input);
}

function ensureLeaseColumn(store: Store, name: string, definition: string): void {
  const columns = store.db.prepare("PRAGMA table_info(agent_task_leases)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    store.db.exec(`ALTER TABLE agent_task_leases ADD COLUMN ${name} ${definition}`);
  }
}

function ensureTableColumn(store: Store, table: string, name: string, definition: string): void {
  const columns = store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function ensureAgentTaskLeaseSchema(store: Store): void {
  store.db.pragma("busy_timeout = 5000");
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS agent_task_leases (
      id TEXT NOT NULL UNIQUE,
      task_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_revision TEXT NOT NULL,
      project_id TEXT NOT NULL,
      queue TEXT NOT NULL,
      role TEXT NOT NULL,
      action_code TEXT NOT NULL,
      status TEXT NOT NULL,
      coordination_dispatch_id TEXT NOT NULL DEFAULT '',
      lease_token TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      pool_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      result_digest TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      claimed_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      heartbeat_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT '',
      retry_available_at TEXT NOT NULL DEFAULT '',
      work_scopes_json TEXT NOT NULL DEFAULT '[]',
      workspace_key TEXT NOT NULL DEFAULT '',
      workspace_recommended_path TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      workspace_branch TEXT NOT NULL DEFAULT '',
      baseline_revision TEXT NOT NULL DEFAULT '',
      repair_snapshot_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_task_leases_project_status
      ON agent_task_leases(project_id, status, lease_expires_at);
    CREATE TABLE IF NOT EXISTS agent_task_lease_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_task_capacity (
      project_id TEXT PRIMARY KEY,
      max_active INTEGER NOT NULL DEFAULT 4,
      designer_max_active INTEGER NOT NULL DEFAULT 1,
      builder_max_active INTEGER NOT NULL DEFAULT 4,
      auditor_max_active INTEGER NOT NULL DEFAULT 2,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      retry_backoff_seconds INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_runner_registrations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL DEFAULT '',
      pool_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      repository_path TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'online',
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, agent_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runner_project_role
      ON agent_runner_registrations(project_id, role, status);
    CREATE TABLE IF NOT EXISTS agent_worker_pools (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      max_active INTEGER NOT NULL DEFAULT 1,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_worker_pools_project_role
      ON agent_worker_pools(project_id, role, status);
    CREATE TABLE IF NOT EXISTS agent_task_resource_locks (
      project_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      task_key TEXT NOT NULL,
      lease_token TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (project_id, scope)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_task_resource_locks_lease
      ON agent_task_resource_locks(lease_token);
    CREATE TABLE IF NOT EXISTS agent_task_workspace_reservations (
      workspace_key TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      worker_id TEXT NOT NULL,
      recommended_path TEXT NOT NULL,
      workspace_path TEXT NOT NULL DEFAULT '',
      branch_name TEXT NOT NULL,
      baseline_revision TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureLeaseColumn(store, "approval_group_id", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "id", "TEXT NOT NULL DEFAULT ''");
  store.db.prepare("UPDATE agent_task_leases SET id=lease_token WHERE id='' OR id IS NULL").run();
  store.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_leases_work_order_id ON agent_task_leases(id)");
  ensureLeaseColumn(store, "retry_available_at", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "worker_id", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "pool_id", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "work_scopes_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureLeaseColumn(store, "workspace_key", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "workspace_recommended_path", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "workspace_path", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "workspace_branch", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "baseline_revision", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "repair_snapshot_json", "TEXT NOT NULL DEFAULT ''");
  ensureLeaseColumn(store, "coordination_dispatch_id", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(store, "agent_runner_registrations", "worker_id", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(store, "agent_runner_registrations", "pool_id", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(store, "agent_runner_registrations", "workspace_path", "TEXT NOT NULL DEFAULT ''");
  store.db.exec(`
    UPDATE agent_task_leases
      SET worker_id=CASE WHEN session_id='' THEN agent_id ELSE agent_id || ':' || session_id END
      WHERE worker_id='';
    UPDATE agent_runner_registrations
      SET worker_id=CASE WHEN session_id='' THEN agent_id ELSE agent_id || ':' || session_id END
      WHERE worker_id='';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runner_project_worker
      ON agent_runner_registrations(project_id, worker_id);
  `);
}

export function getAgentTaskCapacity(store: Store, projectId: string): AgentTaskCapacity {
  ensureAgentTaskLeaseSchema(store);
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT OR IGNORE INTO agent_task_capacity (
      project_id, max_active, designer_max_active, builder_max_active, auditor_max_active,
      max_attempts, retry_backoff_seconds, updated_at
    ) VALUES (@projectId, @maxActive, @designerMaxActive, @builderMaxActive, @auditorMaxActive,
      @maxAttempts, @retryBackoffSeconds, @updatedAt)
  `).run({ projectId, ...DEFAULT_CAPACITY, updatedAt: now });
  return mapCapacity(store.db.prepare("SELECT * FROM agent_task_capacity WHERE project_id = ?").get(projectId) as CapacityRow);
}

export function updateAgentTaskCapacity(
  store: Store,
  projectId: string,
  patch: Partial<Omit<AgentTaskCapacity, "projectId" | "updatedAt">>,
): AgentTaskCapacity {
  const current = getAgentTaskCapacity(store, projectId);
  const next = { ...current, ...patch, projectId, updatedAt: new Date().toISOString() };
  const values = [
    next.maxActive, next.designerMaxActive, next.builderMaxActive, next.auditorMaxActive,
    next.maxAttempts, next.retryBackoffSeconds,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 1000)) {
    throw new AgentTaskLeaseError(400, "INVALID_AGENT_CAPACITY", "并发、尝试次数和退避必须是 1-1000 的整数");
  }
  store.db.prepare(`
    UPDATE agent_task_capacity SET
      max_active=@maxActive, designer_max_active=@designerMaxActive,
      builder_max_active=@builderMaxActive, auditor_max_active=@auditorMaxActive,
      max_attempts=@maxAttempts, retry_backoff_seconds=@retryBackoffSeconds,
      updated_at=@updatedAt
    WHERE project_id=@projectId
  `).run(next);
  return next;
}

function roleCapacity(capacity: AgentTaskCapacity, role: AgentBlueprintKey): number {
  if (role === "designer") return capacity.designerMaxActive;
  if (role === "builder") return capacity.builderMaxActive;
  return capacity.auditorMaxActive;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "worker";
}

function taskPoolId(task: AgentOrchestrationTask, role: AgentBlueprintKey): string {
  return effectiveAgentTaskAssignment(task, role).poolId;
}

function taskWorkScopes(task: AgentOrchestrationTask): string[] {
  if (task.workScopes?.length) return [...new Set(task.workScopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  if (task.nodeId) return [`node:${task.diagramId || "main"}:${task.nodeId}`];
  if (task.planItemId) return [`plan:${task.planItemId}`];
  return [`task:${task.id}`];
}

function recommendedWorkspace(repositoryPath: string, projectId: string, workerId: string, taskKey: string) {
  const digest = createHash("sha256").update(taskKey).digest("hex").slice(0, 10);
  const worker = safeSegment(workerId);
  return {
    key: `workspace:${projectId}:${worker}:${digest}`,
    path: repositoryPath ? join(dirname(repositoryPath), ".productdesign-worktrees", safeSegment(projectId), `${worker}-${digest}`) : "",
    branch: `productdesign/${worker}/${digest}`,
  };
}

function ensureWorkerPool(store: Store, input: {
  id: string;
  projectId: string;
  role: AgentBlueprintKey;
  name: string;
  maxActive: number;
  capabilities: string[];
}): AgentWorkerPool {
  const now = new Date().toISOString();
  const row = store.db.prepare(`
    INSERT INTO agent_worker_pools (
      id, project_id, role, name, max_active, capabilities_json, status, created_at, updated_at
    ) VALUES (@id, @projectId, @role, @name, @maxActive, @capabilitiesJson, 'active', @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, max_active=excluded.max_active,
      capabilities_json=excluded.capabilities_json, updated_at=excluded.updated_at
    RETURNING *
  `).get({ ...input, capabilitiesJson: JSON.stringify([...new Set(input.capabilities)]), now }) as WorkerPoolRow;
  return mapWorkerPool(row);
}

export function listAgentWorkerPools(store: Store, projectId: string): AgentWorkerPool[] {
  ensureAgentTaskLeaseSchema(store);
  const persisted = (store.db.prepare(
    "SELECT * FROM agent_worker_pools WHERE project_id = ? ORDER BY role, name, id",
  ).all(projectId) as WorkerPoolRow[]).map(mapWorkerPool);
  const byId = new Map(persisted.map((pool) => [pool.id, pool]));
  const capacity = getAgentTaskCapacity(store, projectId);
  for (const plan of store.listPlans(projectId)) {
    if (plan.kind !== "task") continue;
    for (const role of ["designer", "builder", "auditor"] as const) {
      const assignment = plan.roleAssignments[role];
      if (!assignment.agentId) continue;
      const id = assignment.poolId?.trim() || implicitAgentTaskPoolId(projectId, role, assignment.agentId);
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        projectId,
        role,
        name: assignment.displayName || `${role} Worker 池`,
        maxActive: roleCapacity(capacity, role),
        capabilities: [],
        status: "active",
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.role.localeCompare(right.role) || left.name.localeCompare(right.name));
}

function isoAfterFrom(seconds: number, from = Date.now()): string {
  return new Date(from + seconds * 1000).toISOString();
}

export function expireStaleAgentTasks(store: Store, projectId?: string): number {
  ensureAgentTaskLeaseSchema(store);
  return store.db.transaction(() => {
  const now = new Date().toISOString();
  const staleAt = isoAfterFrom(-RUNNER_STALE_SECONDS);
  // ponytail: one server-side sweep is enough; move to per-runner scheduling only if scale requires it.
  store.db.prepare(`
    UPDATE agent_runner_registrations SET status='stale', updated_at=@now
    WHERE status='online' AND last_seen_at <= @staleAt
      ${projectId ? "AND project_id = @projectId" : ""}
  `).run({ now, staleAt, ...(projectId ? { projectId } : {}) });
  const rows = store.db.prepare(`
    SELECT l.* FROM agent_task_leases l
    WHERE l.status IN ('claimed', 'running') AND (l.lease_expires_at <= @now OR
      EXISTS (SELECT 1 FROM agent_runner_registrations r WHERE r.project_id=l.project_id AND lower(r.worker_id)=lower(l.worker_id) AND r.status='stale' AND r.last_seen_at <= @staleAt) OR
      (approval_group_id <> '' AND approval_group_id IN (SELECT approval_group_id FROM agent_task_leases
        WHERE status IN ('claimed', 'running') AND lease_expires_at <= @now)))
      ${projectId ? "AND l.project_id = @projectId" : ""}
  `).all({ now, staleAt, ...(projectId ? { projectId } : {}) }) as LeaseRow[];
  for (const row of rows) {
    const capacity = getAgentTaskCapacity(store, row.project_id);
    const retryAvailableAt = isoAfterFrom(capacity.retryBackoffSeconds);
    store.db.prepare(`
      UPDATE agent_task_leases SET status='expired', last_error=@lastError,
        completed_at=@now, retry_available_at=@retryAvailableAt, updated_at=@now
      WHERE task_key=@taskKey AND status IN ('claimed', 'running')
    `).run({ taskKey: row.task_key, now, retryAvailableAt, lastError: "任务租约已过期，等待退避后重新领取" });
    store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token = ?").run(row.lease_token);
    store.db.prepare(`
      UPDATE agent_task_workspace_reservations SET status='expired', updated_at=? WHERE lease_token=?
    `).run(now, row.lease_token);
    if (row.coordination_dispatch_id && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) {
      store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
        .run(now, row.coordination_dispatch_id);
    }
    const expired = store.db.prepare("SELECT * FROM agent_task_leases WHERE task_key = ?").get(row.task_key) as LeaseRow;
    if (row.action_code === "submit_evidence_repair") {
      const planId = row.task_id.slice(row.task_id.indexOf(":") + 1);
      failEvidenceRepairAttempt(store, planId, row.attempt, capacity.maxAttempts, "lease_expired");
    }
    audit(store, mapLease(expired), "expire", { source: "system", actor: "agent-lease-sweeper" }, {
      status: row.status, leaseExpiresAt: row.lease_expires_at,
    });
  }
  return rows.length;
  }).immediate();
}

function upsertRunnerRegistration(store: Store, input: {
  projectId: string;
  agentId: string;
  workerId: string;
  poolId: string;
  sessionId: string;
  role: AgentBlueprintKey;
  capabilities: string[];
  repositoryPath: string;
  workspacePath?: string;
}): AgentRunnerRegistration {
  const now = new Date().toISOString();
  // A worker is the stable process identity. When a client omits sessionId,
  // use that identity for the registration key so reassigning the same Agent
  // to a new worker does not collide on the legacy empty-session UNIQUE key.
  const sessionId = input.sessionId.trim() || input.workerId.trim();
  const row = store.db.prepare(`
    INSERT INTO agent_runner_registrations (
      id, project_id, agent_id, worker_id, pool_id, session_id, role, capabilities_json,
      repository_path, workspace_path, status, last_seen_at, updated_at
    ) VALUES (@id, @projectId, @agentId, @workerId, @poolId, @sessionId, @role, @capabilitiesJson,
      @repositoryPath, @workspacePath, 'online', @now, @now)
    ON CONFLICT(project_id, worker_id) DO UPDATE SET
      agent_id=excluded.agent_id, pool_id=excluded.pool_id, session_id=excluded.session_id,
      role=excluded.role, capabilities_json=excluded.capabilities_json,
      repository_path=excluded.repository_path, workspace_path=excluded.workspace_path, status='online',
      last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at
    RETURNING *
  `).get({
    id: randomUUID(), ...input, sessionId, workspacePath: input.workspacePath ?? "",
    capabilitiesJson: JSON.stringify([...new Set(input.capabilities)]), now,
  }) as RunnerRow;
  return mapRunner(row);
}

export function listAgentRunners(store: Store, projectId: string): AgentRunnerRegistration[] {
  expireStaleAgentTasks(store, projectId);
  return (store.db.prepare(
    "SELECT * FROM agent_runner_registrations WHERE project_id = ? ORDER BY last_seen_at DESC",
  ).all(projectId) as RunnerRow[]).map(mapRunner);
}

function cachedResponse<T>(store: Store, operation: string, idempotencyKey: string, hash: string): T | undefined {
  const row = store.db.prepare(
    "SELECT request_hash, response_json FROM agent_task_lease_idempotency WHERE operation = ? AND idempotency_key = ?",
  ).get(operation, idempotencyKey) as IdempotencyRow | undefined;
  if (!row) return undefined;
  if (row.request_hash !== hash) {
    throw new AgentTaskLeaseError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 不能用于不同请求");
  }
  return JSON.parse(row.response_json) as T;
}

function cacheResponse(store: Store, operation: string, idempotencyKey: string, hash: string, response: unknown, now: string): void {
  store.db.prepare(
    `INSERT INTO agent_task_lease_idempotency (operation, idempotency_key, request_hash, response_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(operation, idempotencyKey, hash, JSON.stringify(response), now);
}

function audit(store: Store, lease: AgentTaskLease, action: string, context: AgentTaskLeaseContext, before: Record<string, unknown> | null): void {
  store.recordAudit({
    projectId: lease.projectId,
    entityType: "agentTaskLease",
    entityId: lease.taskKey,
    action,
    before,
    after: {
      status: lease.status,
      actionCode: lease.actionCode,
      taskRevision: lease.taskRevision,
      agentId: lease.agentId,
      workerId: lease.workerId,
      poolId: lease.poolId,
      attempt: lease.attempt,
      leaseExpiresAt: lease.leaseExpiresAt,
      workScopes: lease.workScopes,
      workspacePath: lease.workspacePath,
      baselineRevision: lease.baselineRevision,
      ...(["submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "request_design_change"].includes(lease.actionCode)
        ? { evidenceRepairState: getEvidenceRepairState(store, lease.taskId.slice(lease.taskId.indexOf(":") + 1)) }
        : {}),
      ...(context.reason ? { reason: context.reason } : {}),
    },
    actor: context.actor?.trim() || `agent:${lease.agentId}`,
    source: context.source ?? "system",
    correlationId: lease.taskId,
      clientId: context.clientId,
      sessionId: context.sessionId || lease.sessionId || undefined,
      model: context.model,
  });
}

function claimableTasksForOrchestration(
  store: Store,
  orchestration: AgentOrchestration,
  reservedGroupId = "",
  requiredRole?: AgentBlueprintKey,
  requiredQueue?: AgentExecutableQueueKey,
): ClaimableAgentTask[] {
  const now = new Date().toISOString();
  const capacity = getAgentTaskCapacity(store, orchestration.project.id);
  const activeRows = store.db.prepare(
    "SELECT role, COUNT(DISTINCT COALESCE(NULLIF(approval_group_id, ''), id)) AS count FROM agent_task_leases WHERE project_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ? AND (? = '' OR approval_group_id <> ?) GROUP BY role",
  ).all(orchestration.project.id, now, reservedGroupId, reservedGroupId) as Array<{ role: AgentBlueprintKey; count: number }>;
  const roleActive = new Map(activeRows.map((row) => [row.role, row.count]));
  const totalActive = activeRows.reduce((sum, row) => sum + row.count, 0);
  const tasks = (["design", "development", "audit", "approval"] as const)
    .filter((queue) => (!requiredRole || ROLE_BY_QUEUE[queue] === requiredRole) && (!requiredQueue || queue === requiredQueue))
    .flatMap((queue) => orchestration.queues[queue]);
  const leaseRows = store.db.prepare(
    "SELECT * FROM agent_task_leases WHERE project_id = ?",
  ).all(orchestration.project.id) as LeaseRow[];
  const leaseByTaskKey = new Map(leaseRows.map((row) => [row.task_key, row]));
  const lockRows = store.db.prepare(`
    SELECT scope, task_key, worker_id, expires_at
    FROM agent_task_resource_locks
    WHERE project_id=? AND expires_at > ?
  `).all(orchestration.project.id, now) as Array<{ scope: string; task_key: string; worker_id: string; expires_at: string }>;
  const locksByScope = new Map<string, Array<{ task_key: string; worker_id: string; expires_at: string }>>();
  for (const lock of lockRows) {
    const locks = locksByScope.get(lock.scope) ?? [];
    locks.push(lock);
    locksByScope.set(lock.scope, locks);
  }
  const next = orchestration.workflow.nextAction;
  const matchingNextIndex = next ? tasks.findIndex((task) => task.actionCode === next.code
    && (!next.entityId || task.planItemId === next.entityId || task.nodeId === next.entityId)) : -1;
  if (matchingNextIndex > 0) tasks.unshift(...tasks.splice(matchingNextIndex, 1));
  return tasks.map((task): ClaimableAgentTask => {
    const taskRevision = revisionForTask(store, task);
    const taskKey = agentTaskKey(orchestration.project.id, task, taskRevision);
    const row = leaseByTaskKey.get(taskKey);
    const active = row && (["claimed", "running"] as AgentTaskLeaseStatus[]).includes(row.status) && row.lease_expires_at > now;
    const terminal = row?.status === "completed";
    const role = ROLE_BY_QUEUE[task.queue as AgentExecutableQueueKey];
    const effectiveAssignment = effectiveAgentTaskAssignment(task, role);
    const poolId = effectiveAssignment.poolId;
    const workScopes = taskWorkScopes(task);
    const conflictingLock = workScopes
      .flatMap((scope) => locksByScope.get(scope) ?? [])
      .find((lock) => lock.task_key !== taskKey);
    const attemptsExhausted = Boolean(row && row.attempt >= capacity.maxAttempts && ["failed", "expired"].includes(row.status));
    const backingOff = Boolean(row?.retry_available_at && row.retry_available_at > now && ["failed", "expired"].includes(row.status));
    const projectFull = totalActive >= capacity.maxActive;
    const roleFull = (roleActive.get(role) ?? 0) >= roleCapacity(capacity, role);
    const matchesCriticalPath = !next || (task.actionCode === next.code
      && (!next.entityId || task.planItemId === next.entityId || task.nodeId === next.entityId));
    const blockedByProject = orchestration.workflow.status === "blocked" && !matchesCriticalPath;
    const assigneeMissing = !effectiveAssignment.assignee?.agentId || !poolId;
    const availabilityReason = active
      ? `已由 ${row.agent_id} 领取`
      : terminal
        ? "任务修订已完成"
        : attemptsExhausted
          ? `已达到最大尝试次数 ${capacity.maxAttempts}`
          : backingOff
            ? `重试退避至 ${row!.retry_available_at}`
            : projectFull
              ? `项目并发已满 ${totalActive}/${capacity.maxActive}`
              : roleFull
                ? `${role} 并发已满 ${roleActive.get(role) ?? 0}/${roleCapacity(capacity, role)}`
                : blockedByProject
                  ? "项目处于阻塞状态，仅项目关键路径任务可领取"
                  : conflictingLock
                    ? `资源范围被 Worker ${conflictingLock.worker_id} 锁定至 ${conflictingLock.expires_at}`
                    : assigneeMissing
                      ? `${role} 任务缺少可用受派身份`
                      : "可领取";
    return {
      ...task,
      assignee: effectiveAssignment.assignee,
      taskKey,
      taskRevision,
      requiredRole: role,
      poolId,
      workScopes,
      available: !active && !terminal && !attemptsExhausted && !backingOff && !projectFull && !roleFull
        && !blockedByProject && !conflictingLock && !assigneeMissing,
      availabilityReason,
      attempt: row?.attempt ?? 0,
      retryAvailableAt: row?.retry_available_at ?? "",
      activeLease: active ? {
        status: row.status as "claimed" | "running",
        agentId: row.agent_id,
        workerId: row.worker_id || row.agent_id,
        poolId: row.pool_id || poolId,
        sessionId: row.session_id,
        runId: row.run_id,
        leaseExpiresAt: row.lease_expires_at,
        workScopes,
        workspacePath: row.workspace_path || "",
      } : null,
    };
  });
}

export function listClaimableAgentTasks(
  store: Store,
  projectId: string,
  reservedGroupId = "",
  orchestration?: AgentOrchestration,
  requiredRole?: AgentBlueprintKey,
  requiredQueue?: AgentExecutableQueueKey,
): ClaimableAgentTask[] {
  ensureAgentTaskLeaseSchema(store);
  if (!orchestration) {
    expireStaleAgentTasks(store, projectId);
    orchestration = buildAgentOrchestration(store, projectId, false);
  }
  if (!orchestration) throw new AgentTaskLeaseError(404, "PROJECT_NOT_FOUND", "项目不存在");
  return claimableTasksForOrchestration(store, orchestration, reservedGroupId, requiredRole, requiredQueue);
}

function optionalRepositoryHead(repositoryPath: string): string {
  try { return repositoryHead(repositoryPath); } catch { return ""; }
}

export function decorateAgentOrchestrationWithLeases(store: Store, orchestration: AgentOrchestration): AgentOrchestration {
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, orchestration.project.id);
  const claimableTasks = claimableTasksForOrchestration(store, orchestration);
  const byTaskId = new Map(claimableTasks.map((task) => [task.id, task]));
  const capacity = getAgentTaskCapacity(store, orchestration.project.id);
  const leases = listAgentTaskLeases(store, orchestration.project.id);
  const now = new Date().toISOString();
  const count = (status: AgentTaskLeaseStatus) => leases.filter((lease) => lease.status === status).length;
  const roleActive: Record<AgentBlueprintKey, number> = { designer: 0, builder: 0, auditor: 0, approver: 0 };
  const activeUnits = new Set<string>();
  for (const lease of leases) {
    if (!(["claimed", "running"] as AgentTaskLeaseStatus[]).includes(lease.status) || lease.leaseExpiresAt <= now) continue;
    const unit = lease.approvalGroupId || lease.workOrderId;
    if (activeUnits.has(unit)) continue;
    activeUnits.add(unit);
    roleActive[lease.role] += 1;
  }
  const active = roleActive.designer + roleActive.builder + roleActive.auditor + roleActive.approver;
  const leaseSummary: AgentTaskLeaseSummary = {
    available: claimableTasks.filter((task) => task.available).length,
    claimed: count("claimed"), running: count("running"), completed: count("completed"),
    failed: count("failed"), released: count("released"), expired: count("expired"),
    retrying: leases.filter((lease) => ["failed", "expired"].includes(lease.status) && lease.retryAvailableAt > now).length,
    active, activeSlots: Math.max(0, capacity.maxActive - active),
    roleActive,
    roleSlots: {
      designer: Math.max(0, capacity.designerMaxActive - roleActive.designer),
      builder: Math.max(0, capacity.builderMaxActive - roleActive.builder),
      auditor: Math.max(0, capacity.auditorMaxActive - roleActive.auditor),
      approver: Math.max(0, capacity.auditorMaxActive - roleActive.approver),
    },
    lockedScopes: Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_resource_locks WHERE project_id=? AND expires_at > ?",
    ).get(orchestration.project.id, now) as { count: number }).count),
    workspaceReservations: Number((store.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_task_workspace_reservations
      WHERE project_id=? AND status IN ('reserved', 'active')
    `).get(orchestration.project.id) as { count: number }).count),
  };
  const decorateTask = (task: AgentOrchestrationTask): AgentOrchestrationTask => {
    const state = byTaskId.get(task.id);
    return {
      ...task,
      available: state?.available ?? true,
      availabilityReason: state?.availabilityReason ?? "可领取",
      attempt: state?.attempt ?? 0,
      retryAvailableAt: state?.retryAvailableAt ?? "",
      activeLease: state?.activeLease ?? null,
    };
  };
  return {
    ...orchestration,
    schemaVersion: "1.3",
    queueCounts: {
      design: orchestration.queues.design.length,
      development: orchestration.queues.development.length,
      audit: orchestration.queues.audit.length,
      approval: orchestration.queues.approval.length,
      managerApproval: orchestration.queues.managerApproval.length,
    },
    capacity,
    leaseSummary,
    runners: listAgentRunners(store, orchestration.project.id),
    workerPools: listAgentWorkerPools(store, orchestration.project.id),
    queues: {
      ...orchestration.queues,
      design: orchestration.queues.design.map(decorateTask),
      development: orchestration.queues.development.map(decorateTask),
      approval: orchestration.queues.approval.map(decorateTask),
      audit: orchestration.queues.audit.map(decorateTask),
    },
  };
}

export interface AgentOrchestrationResponseOptions {
  includeQueues?: boolean;
  queue?: AgentOrchestrationQueueKey;
  offset?: number;
  limit?: number;
  includeRunners?: boolean;
  includeWorkerPools?: boolean;
  includePrompts?: boolean;
}

function pageArray<T>(items: T[], offset = 0, limit = 20): Paginated<T> {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const pageItems = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + pageItems.length;
  return {
    total: items.length,
    count: pageItems.length,
    offset: safeOffset,
    items: pageItems,
    hasMore: nextOffset < items.length,
    nextOffset: nextOffset < items.length ? nextOffset : null,
  };
}

/** Public MCP/API projection. Keep the complete object for internal claiming, but never serialize it by default. */
export function projectAgentOrchestrationResponse(
  orchestration: AgentOrchestration,
  options: AgentOrchestrationResponseOptions = {},
  store?: Store,
): Record<string, unknown> {
  const { nodes: _nodes, layerGate, ...workflowBase } = orchestration.workflow;
  const workflow = {
    ...workflowBase,
    layerGate: {
      activeLayer: layerGate.activeLayer,
      totalLayers: layerGate.totalLayers,
      activePlanCount: layerGate.activePlanCount,
      lockedPlanCount: layerGate.lockedPlanCount,
      issues: layerGate.issues,
    },
  };
  const includePrompts = options.includePrompts === true;
  const output: Record<string, unknown> = {
    schemaVersion: orchestration.schemaVersion,
    generatedAt: orchestration.generatedAt,
    workflowPolicyVersion: orchestration.workflowPolicyVersion,
    agentSecurityPolicyVersion: orchestration.agentSecurityPolicyVersion,
    project: orchestration.project,
    workingDirectory: orchestration.workingDirectory,
    workflow,
    recommendedAgents: includePrompts
      ? orchestration.recommendedAgents
      : orchestration.recommendedAgents.map((agent) => {
        const { prompt: _agentPrompt, ...summary } = agent;
        return summary;
      }),
    queueCounts: orchestration.queueCounts,
    capacity: orchestration.capacity,
    leaseSummary: orchestration.leaseSummary,
    handoffs: orchestration.handoffs,
    ...(includePrompts ? { bootstrapPrompt: orchestration.bootstrapPrompt } : {}),
  };
  if (store?.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_coordination_leases'").get()) {
    const coordinationLeases = (store.db.prepare("SELECT id, project_id, target_plan_id, main_agent_id, worker_id, status, stage, lease_expires_at, heartbeat_at, dispatch_revision, created_at, updated_at FROM agent_coordination_leases WHERE project_id=? ORDER BY updated_at DESC")
      .all(orchestration.project.id) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), projectId: String(row.project_id), planId: String(row.target_plan_id || ""), mainAgentId: String(row.main_agent_id), workerId: String(row.worker_id),
      status: row.status, stage: row.stage, leaseExpiresAt: String(row.lease_expires_at), heartbeatAt: String(row.heartbeat_at),
      dispatchRevision: Number(row.dispatch_revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
    const childDispatches = store.db.prepare("SELECT dispatch_id, coordination_lease_id, project_id, task_id, task_key, task_revision, stage, role, agent_id, worker_id, pool_id, status, dispatch_version, child_work_order_id, created_at, updated_at FROM agent_child_task_dispatches WHERE project_id=? ORDER BY created_at")
      .all(orchestration.project.id) as Array<Record<string, unknown>>;
    output.coordination = { leases: coordinationLeases, childDispatches: childDispatches.map((row) => ({
      dispatchId: String(row.dispatch_id), coordinationLeaseId: String(row.coordination_lease_id), projectId: String(row.project_id), taskId: String(row.task_id),
      taskKey: String(row.task_key), taskRevision: String(row.task_revision), stage: row.stage, role: row.role, agentId: String(row.agent_id), workerId: String(row.worker_id),
      poolId: String(row.pool_id), status: row.status, dispatchVersion: Number(row.dispatch_version), childWorkOrderId: String(row.child_work_order_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    })) };
  }
  if (options.includeQueues) {
    const keys = options.queue ? [options.queue] : (Object.keys(orchestration.queues) as AgentOrchestrationQueueKey[]);
    const pages = Object.fromEntries(keys.map((key) => [key, pageArray(orchestration.queues[key] ?? [], options.offset, options.limit)])) as Record<string, Paginated<unknown>>;
    const queuePages = Object.fromEntries(keys.map((key) => {
      const page = pages[key];
      return [key, { total: page.total, count: page.count, offset: page.offset, hasMore: page.hasMore, nextOffset: page.nextOffset }];
    }));
    output.queues = Object.fromEntries(keys.map((key) => [key, pages[key].items]));
    output.queuePages = queuePages;
  }
  if (options.includeRunners) output.runners = orchestration.runners ?? [];
  if (options.includeWorkerPools) output.workerPools = orchestration.workerPools ?? [];
  return output;
}

export function listAgentTaskLeases(store: Store, projectId: string): Array<Omit<AgentTaskLease, "leaseToken">> {
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, projectId);
  const rows = store.db.prepare(
    "SELECT * FROM agent_task_leases WHERE project_id = ? ORDER BY updated_at DESC, task_key",
  ).all(projectId) as LeaseRow[];
  return rows.map((row) => withoutToken(mapLease(row)));
}

export function pageAgentTaskLeases(
  store: Store,
  projectId: string,
  offset = 0,
  limit = 20,
): Paginated<Omit<AgentTaskLease, "leaseToken">> {
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, projectId);
  const total = Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_task_leases WHERE project_id = ?",
  ).get(projectId) as { count: number }).count);
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const rows = store.db.prepare(
    "SELECT * FROM agent_task_leases WHERE project_id = ? ORDER BY updated_at DESC, task_key LIMIT ? OFFSET ?",
  ).all(projectId, safeLimit, safeOffset) as LeaseRow[];
  const items = rows.map((row) => withoutToken(mapLease(row)));
  const nextOffset = safeOffset + items.length;
  return { total, count: items.length, offset: safeOffset, items, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
}

/** Atomically invalidates active task leases after their approved design baseline changes. */
export function releaseAgentTaskLeasesForDesignChange(
  store: Store,
  projectId: string,
  planIds: string[],
  changeId: string,
  nodeId?: string,
): string[] {
  ensureAgentTaskLeaseSchema(store);
  if (planIds.length === 0) return [];
  const taskIds = planIds.flatMap((planId) => [`design:${planId}`, `development:${planId}`, `audit:${planId}`, `approval:${planId}`]);
  if (nodeId) taskIds.push(`design:${nodeId}`, `approval:${nodeId}`);
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = store.db.prepare(`
    SELECT * FROM agent_task_leases
    WHERE project_id=? AND task_id IN (${placeholders}) AND status IN ('claimed', 'running')
  `).all(projectId, ...taskIds) as LeaseRow[];
  const now = new Date().toISOString();
  for (const row of rows) {
    store.db.prepare(`
      UPDATE agent_task_leases SET status='released', last_error=?, completed_at=?, updated_at=?
      WHERE task_key=? AND status IN ('claimed', 'running')
    `).run(`design_change:${changeId}`, now, now, row.task_key);
    store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(row.lease_token);
    store.db.prepare(`
      UPDATE agent_task_workspace_reservations SET status='released', updated_at=? WHERE lease_token=?
    `).run(now, row.lease_token);
    store.db.prepare(`
      UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=?
      WHERE project_id=? AND lower(worker_id)=lower(?)
    `).run(now, now, projectId, row.worker_id);
  }
  return rows.map((row) => row.task_key);
}

export interface ClaimAgentTaskInput {
  projectId: string;
  taskId?: string;
  taskKey?: string;
  role: AgentBlueprintKey;
  agentId: string;
  /** 计划角色身份；workerId 才是具体外部进程的稳定身份。 */
  workerId?: string;
  poolId?: string;
  sessionId?: string;
  runId?: string;
  capabilities?: string[];
  leaseSeconds?: number;
  idempotencyKey: string;
  /** Only the Main Agent dispatch flow may set this value. */
  coordinationDispatchId?: string;
}

/** Group membership is derived from the server queue, never from a client list. */
export function approvalGroupLeases(store: Store, lease: AgentTaskLease): AgentTaskLease[] {
  if (!lease.approvalGroupId) return [lease];
  return (store.db.prepare("SELECT * FROM agent_task_leases WHERE project_id=? AND approval_group_id=? ORDER BY task_key")
    .all(lease.projectId, lease.approvalGroupId) as LeaseRow[]).map(mapLease);
}

export function assertApprovalGroupCurrent(store: Store, lease: AgentTaskLease): void {
  if (!lease.approvalGroupId) return;
  const [correlation, fingerprint] = lease.approvalGroupId.split("|");
  const tasks = listClaimableAgentTasks(store, lease.projectId).filter((task) =>
    task.actionCode === "request_design_change" && task.correlationId === correlation);
  const members = approvalGroupLeases(store, lease);
  const expected = approvalGroupFingerprint(tasks);
  const now = new Date().toISOString();
  if (!tasks.length || fingerprint !== expected || members.length !== tasks.length
    || members.some((member) => !["claimed", "running"].includes(member.status) || member.leaseExpiresAt <= now
      || member.agentId !== lease.agentId || member.workerId !== lease.workerId
      || !tasks.some((task) => task.taskKey === member.taskKey))) {
    throw new AgentTaskLeaseError(409, "TASK_REVISION_DRIFT", "审批组范围或修订已变化；释放整组并重新领取");
  }
}

function approvalGroupFingerprint(tasks: ClaimableAgentTask[]): string {
  return createHash("sha256").update(JSON.stringify(tasks.map((task) =>
    [task.taskKey, task.workScopes, task.assignee, task.poolId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
}

export function claimAgentTask(
  store: Store,
  input: ClaimAgentTaskInput,
  context: AgentTaskLeaseContext = {},
  orchestration?: AgentOrchestration,
): AgentTaskLease {
  ensureAgentTaskLeaseSchema(store);
  return store.db.transaction(() => {
    const hash = requestHash(input);
    const cached = cachedResponse<AgentTaskLease>(store, "claim_group", input.idempotencyKey, hash);
    if (cached) {
      const current = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
        .get(cached.workOrderId, cached.leaseToken) as LeaseRow | undefined;
      if (!current || !["claimed", "running"].includes(current.status) || current.lease_expires_at <= new Date().toISOString()) {
        throw new AgentTaskLeaseError(409, "LEASE_LOST", "原审批组租约已失效");
      }
      const lease = mapLease(current);
      assertApprovalGroupCurrent(store, lease);
      return lease;
    }
    const tasks = listClaimableAgentTasks(store, input.projectId, "", orchestration);
    const selected = tasks.find((task) => task.requiredRole === input.role
      && (input.taskId ? task.id === input.taskId : input.taskKey ? task.taskKey === input.taskKey
        : task.available && normalizeAgentId(task.assignee?.agentId ?? "") === normalizeAgentId(input.agentId)));
    if (!selected || selected.actionCode !== "request_design_change"
      || !(selected.correlationId.startsWith("design-gap:") || selected.correlationId.startsWith("design-change-intent:"))) {
      return claimSingleAgentTask(store, input, context, "", orchestration);
    }
    const group = tasks.filter((task) => task.actionCode === "request_design_change" && task.correlationId === selected.correlationId);
    if (group.some((task) => !task.available)) {
      const blocked = group.find((task) => !task.available)!;
      throw new AgentTaskLeaseError(409, blocked.availabilityReason.includes("并发已满") ? "AGENT_CAPACITY_FULL" : "APPROVAL_GROUP_UNAVAILABLE", blocked.availabilityReason);
    }
    const groupId = `${selected.correlationId}|${approvalGroupFingerprint(group)}|${randomUUID()}`;
    const ordered = [selected, ...group.filter((task) => task.taskKey !== selected.taskKey)];
    const workerId = input.workerId || `${input.agentId}:${input.sessionId || randomUUID()}`;
    const members = ordered.map((task) => claimSingleAgentTask(store, {
      ...input, workerId, taskId: task.id, taskKey: task.taskKey,
      idempotencyKey: `${input.idempotencyKey}:scope:${task.id}`,
    }, context, groupId, orchestration));
    for (const member of members) {
      const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=?").get(member.workOrderId) as LeaseRow;
      assertIndependentApprover(store, row);
    }
    const expiresAt = members[0].leaseExpiresAt;
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at=? WHERE approval_group_id=?").run(expiresAt, groupId);
    for (const member of members) store.db.prepare("UPDATE agent_task_resource_locks SET expires_at=? WHERE lease_token=?").run(expiresAt, member.leaseToken);
    cacheResponse(store, "claim_group", input.idempotencyKey, hash, members[0], new Date().toISOString());
    return members[0];
  }).immediate();
}

function claimSingleAgentTask(
  store: Store,
  input: ClaimAgentTaskInput,
  context: AgentTaskLeaseContext = {},
  reservedGroupId = "",
  orchestration?: AgentOrchestration,
): AgentTaskLease {
  ensureAgentTaskLeaseSchema(store);
  if (!input.agentId.trim()) throw new AgentTaskLeaseError(400, "AGENT_ID_REQUIRED", "agentId 不能为空");
  const workerId = input.workerId?.trim() || `${input.agentId}:${input.sessionId?.trim() || input.runId?.trim() || randomUUID()}`;
  if (!workerId) throw new AgentTaskLeaseError(400, "WORKER_ID_REQUIRED", "workerId 不能为空");
  expireStaleAgentTasks(store, input.projectId);
  const leaseSeconds = normalizeLeaseSeconds(input.leaseSeconds);
  const hash = requestHash({ ...input, workerId, leaseSeconds });
  const operation = "claim";
  return store.db.transaction(() => {
    const cached = cachedResponse<AgentTaskLease>(store, operation, input.idempotencyKey, hash);
    if (cached) {
      const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE id = ? AND lease_token = ?")
        .get(cached.workOrderId, cached.leaseToken) as LeaseRow | undefined;
      if (!row || !["claimed", "running"].includes(row.status) || row.lease_expires_at <= new Date().toISOString()) {
        throw new AgentTaskLeaseError(409, "LEASE_LOST", "原领取租约已结束或失效；不能重放为可执行授权");
      }
      return mapLease(row);
    }
    const tasks = listClaimableAgentTasks(store, input.projectId, reservedGroupId, orchestration);
    const selected = tasks.find((item) => (input.taskKey ? item.taskKey === input.taskKey : true)
      && (input.taskId ? item.id === input.taskId : true));
    if ((input.taskId || input.taskKey) && selected && selected.requiredRole !== input.role) {
      throw new AgentTaskLeaseError(409, "ROLE_MISMATCH", `该任务必须由 ${selected.requiredRole} 领取`, {
        expectedRole: selected.requiredRole,
        taskKey: selected.taskKey,
      });
    }
    if ((input.taskId || input.taskKey) && selected && !selected.available) {
      const code = selected.activeLease ? "TASK_ALREADY_CLAIMED"
        : selected.availabilityReason.includes("并发已满") ? "AGENT_CAPACITY_FULL"
          : selected.availabilityReason.includes("最大尝试次数") ? "TASK_ATTEMPTS_EXHAUSTED"
            : selected.availabilityReason.includes("退避") ? "TASK_RETRY_BACKOFF"
              : !selected.assignee?.agentId || !selected.poolId ? "ASSIGNEE_REQUIRED"
              : "TASK_NOT_AVAILABLE";
      throw new AgentTaskLeaseError(409, code, selected.availabilityReason, {
        expectedRole: selected.requiredRole,
        expectedAgentId: selected.assignee?.agentId ?? null,
        expectedDisplayName: selected.assignee?.displayName ?? null,
        taskKey: selected.taskKey,
        taskRevision: selected.taskRevision,
      });
    }
    const roleCandidates = tasks.filter((item) => item.requiredRole === input.role && item.available);
    const task = (input.taskId || input.taskKey) ? selected : roleCandidates.find((item) => {
      const assignment = effectiveAgentTaskAssignment(item, input.role);
      return Boolean(
        assignment.assignee?.agentId
        && normalizeAgentId(assignment.assignee.agentId) === normalizeAgentId(input.agentId)
        && (!input.poolId?.trim() || assignment.poolId === input.poolId.trim()),
      );
    });
    if (!task && !input.taskId && !input.taskKey && roleCandidates.length > 0) {
      const matchingAgent = roleCandidates.find((item) => {
        const assignment = effectiveAgentTaskAssignment(item, input.role);
        return assignment.assignee?.agentId
          && normalizeAgentId(assignment.assignee.agentId) === normalizeAgentId(input.agentId);
      });
      if (matchingAgent && input.poolId?.trim()) {
        throw new AgentTaskLeaseError(
          409,
          "WORKER_POOL_MISMATCH",
          `任务属于 Worker 池 ${effectiveAgentTaskAssignment(matchingAgent, input.role).poolId}`,
          { expectedPoolId: effectiveAgentTaskAssignment(matchingAgent, input.role).poolId, expectedAgentId: input.agentId },
        );
      }
      const expected = roleCandidates[0]?.assignee;
      throw new AgentTaskLeaseError(409, "ASSIGNEE_MISMATCH", "没有可分配给当前 Agent 身份的可用任务", {
        expectedRole: input.role,
        expectedAgentId: expected?.agentId ?? null,
        expectedDisplayName: expected?.displayName ?? null,
        candidateCount: roleCandidates.length,
      });
    }
    if (!task) throw new AgentTaskLeaseError(404, "TASK_NOT_FOUND", "任务不存在、已离开执行队列、无空闲并发槽位或选择器不一致");
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) {
      const parent = store.db.prepare("SELECT 1 FROM agent_coordination_leases WHERE project_id=? AND status IN ('active','paused') AND lease_expires_at > ? LIMIT 1")
        .get(input.projectId, new Date().toISOString());
      if (parent && ["designer", "builder", "auditor"].includes(input.role) && !input.coordinationDispatchId) {
        throw new AgentTaskLeaseError(409, "COORDINATION_DISPATCH_REQUIRED", "当前项目由 Main Agent 中央调度；子 Agent 禁止自行领取任务");
      }
      const dispatch = store.db.prepare("SELECT dispatch_id, agent_id, worker_id FROM agent_child_task_dispatches WHERE project_id=? AND task_key=? AND status IN ('dispatched','claimed','running')")
        .get(input.projectId, task.taskKey) as { dispatch_id: string; agent_id: string; worker_id: string } | undefined;
      if (dispatch && dispatch.dispatch_id !== input.coordinationDispatchId) {
        throw new AgentTaskLeaseError(409, "COORDINATION_DISPATCH_REQUIRED", "该任务必须由 Main Agent 派发后才能领取");
      }
      if (dispatch && (dispatch.agent_id !== input.agentId || dispatch.worker_id !== workerId)) {
        throw new AgentTaskLeaseError(409, "CHILD_IDENTITY_MISMATCH", "只能由 Main Agent 派发的精确子 Agent/workerId 领取");
      }
    }
    if (task.requiredRole !== input.role) {
      throw new AgentTaskLeaseError(409, "ROLE_MISMATCH", `该任务必须由 ${task.requiredRole} 领取`, {
        expectedRole: task.requiredRole,
        taskKey: task.taskKey,
      });
    }
    if (task.requiredRole === "auditor" && task.producerWorkerId
      && normalizeAgentId(task.producerWorkerId) === normalizeAgentId(workerId)) {
      throw new AgentTaskLeaseError(409, "SELF_AUDIT_FORBIDDEN", "Auditor 的 workerId 必须不同于被审计生产任务的 producerWorkerId");
    }
    if (task.requiredRole === "approver") {
      const planId = task.planItemId ?? task.id.slice(task.id.indexOf(":") + 1);
      const producers = store.db.prepare(`SELECT worker_id, agent_id FROM agent_task_leases
        WHERE project_id=? AND task_id IN (?, ?, ?) AND status='completed'`)
        .all(input.projectId, `design:${planId}`, `development:${planId}`, `audit:${planId}`) as Array<{ worker_id: string; agent_id: string }>;
      const claimantIds = [workerId, input.agentId].map(normalizeAgentId).filter(Boolean);
      if (producers.some((producer) => [producer.worker_id, producer.agent_id].map(normalizeAgentId).some((id) => claimantIds.includes(id)))) {
        throw new AgentTaskLeaseError(409, "SELF_APPROVAL_FORBIDDEN", "Approver 身份必须不同于 Designer、Builder 和 Auditor 的生产身份");
      }
    }
    const effectiveAssignment = effectiveAgentTaskAssignment(task, input.role);
    if (!effectiveAssignment.assignee?.agentId || normalizeAgentId(effectiveAssignment.assignee.agentId) !== normalizeAgentId(input.agentId)) {
      throw new AgentTaskLeaseError(409, "ASSIGNEE_MISMATCH", `任务已分配给 ${effectiveAssignment.assignee?.displayName || effectiveAssignment.assignee?.agentId || "未分配身份"}`, {
        expectedRole: input.role,
        expectedAgentId: effectiveAssignment.assignee?.agentId ?? null,
        expectedDisplayName: effectiveAssignment.assignee?.displayName ?? null,
        taskKey: task.taskKey,
      });
    }
    const poolId = effectiveAssignment.poolId;
    if (input.poolId?.trim() && input.poolId.trim() !== poolId) {
      throw new AgentTaskLeaseError(409, "WORKER_POOL_MISMATCH", `任务属于 Worker 池 ${poolId}`, { expectedPoolId: poolId });
    }
    const now = new Date().toISOString();
    const capacity = getAgentTaskCapacity(store, input.projectId);
    const pool = ensureWorkerPool(store, {
      id: poolId,
      projectId: input.projectId,
      role: input.role,
      name: effectiveAssignment.assignee.displayName || `${input.role} Worker 池`,
      maxActive: roleCapacity(capacity, input.role),
      capabilities: input.capabilities ?? [],
    });
    if (pool.status !== "active") throw new AgentTaskLeaseError(409, "WORKER_POOL_PAUSED", `Worker 池 ${pool.name} 已暂停`);
    const poolActive = Number((store.db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(NULLIF(approval_group_id, ''), id)) AS count FROM agent_task_leases
      WHERE project_id=? AND pool_id=? AND status IN ('claimed', 'running') AND lease_expires_at > ?
        AND (? = '' OR approval_group_id <> ?)
    `).get(input.projectId, poolId, now, reservedGroupId, reservedGroupId) as { count: number }).count);
    if (poolActive >= pool.maxActive) {
      throw new AgentTaskLeaseError(409, "WORKER_POOL_CAPACITY_FULL", `Worker 池并发已满 ${poolActive}/${pool.maxActive}`);
    }
    const duplicateRunner = store.db.prepare(`
      SELECT * FROM agent_task_leases
      WHERE project_id=@projectId AND status IN ('claimed', 'running') AND lease_expires_at > @now
        AND (@reservedGroupId = '' OR approval_group_id <> @reservedGroupId)
        AND (lower(worker_id)=lower(@workerId) OR (@sessionId <> '' AND session_id=@sessionId))
      LIMIT 1
    `).get({ projectId: input.projectId, now, workerId, sessionId: input.sessionId ?? "", reservedGroupId }) as LeaseRow | undefined;
    if (duplicateRunner) {
      throw new AgentTaskLeaseError(
        409,
        "AGENT_ALREADY_BUSY",
        `同一 Worker 或会话一次只能执行一个任务；当前任务 ${duplicateRunner.task_id}，租约至 ${duplicateRunner.lease_expires_at}`,
      );
    }
    const workScopes = task.workScopes?.length ? task.workScopes : taskWorkScopes(task);
    const locked = workScopes.map((scope) => store.db.prepare(`
      SELECT worker_id, task_key, expires_at FROM agent_task_resource_locks
      WHERE project_id=? AND scope=? AND expires_at > ?
    `).get(input.projectId, scope, now) as { worker_id: string; task_key: string; expires_at: string } | undefined)
      .find(Boolean);
    if (locked) {
      throw new AgentTaskLeaseError(409, "RESOURCE_SCOPE_LOCKED", `资源范围已由 Worker ${locked.worker_id} 锁定至 ${locked.expires_at}`);
    }
    const project = store.getProject(input.projectId);
    const workOrderId = randomUUID();
    const recommended = recommendedWorkspace(project?.repositoryPath ?? "", input.projectId, workerId, task.taskKey);
    // A terminal reservation is immutable history. A legal reclaim gets a distinct reservation identity,
    // while keeping the stable recommended path and branch for the same worker/task pairing.
    const workspace = { ...recommended, key: `${recommended.key}:${workOrderId}` };
    const leaseToken = randomUUID();
    const leaseExpiresAt = isoAfter(leaseSeconds);
    const row = store.db.prepare(`
      INSERT INTO agent_task_leases (
        approval_group_id, id, task_key, task_id, task_revision, project_id, queue, role, action_code, status, coordination_dispatch_id,
        lease_token, agent_id, worker_id, pool_id, session_id, run_id, lease_expires_at, attempt,
        result_digest, last_error, claimed_at, started_at, heartbeat_at, completed_at, retry_available_at,
        work_scopes_json, workspace_key, workspace_recommended_path, workspace_path,
        workspace_branch, baseline_revision, repair_snapshot_json, updated_at
      ) VALUES (
        @reservedGroupId, @workOrderId, @taskKey, @taskId, @taskRevision, @projectId, @queue, @role, @actionCode, 'claimed', @coordinationDispatchId,
        @leaseToken, @agentId, @workerId, @poolId, @sessionId, @runId, @leaseExpiresAt, 1,
        '', '', @now, '', @now, '', '', @workScopesJson, @workspaceKey, @workspaceRecommendedPath,
        '', @workspaceBranch, '', '', @now
      )
      ON CONFLICT(task_key) DO UPDATE SET
        approval_group_id=excluded.approval_group_id, id=excluded.id, task_id=excluded.task_id, task_revision=excluded.task_revision, project_id=excluded.project_id,
        queue=excluded.queue, role=excluded.role, action_code=excluded.action_code, status='claimed', coordination_dispatch_id=excluded.coordination_dispatch_id,
        lease_token=excluded.lease_token, agent_id=excluded.agent_id, worker_id=excluded.worker_id,
        pool_id=excluded.pool_id, session_id=excluded.session_id,
        run_id=excluded.run_id, lease_expires_at=excluded.lease_expires_at,
        attempt=agent_task_leases.attempt + 1, result_digest='', last_error='',
        claimed_at=excluded.claimed_at, started_at='', heartbeat_at=excluded.heartbeat_at,
        completed_at='', retry_available_at='', work_scopes_json=excluded.work_scopes_json,
        workspace_key=excluded.workspace_key, workspace_recommended_path=excluded.workspace_recommended_path,
        workspace_path='', workspace_branch=excluded.workspace_branch,
        baseline_revision='', repair_snapshot_json='', updated_at=excluded.updated_at
      WHERE agent_task_leases.status IN ('failed', 'released', 'expired')
         OR (agent_task_leases.status IN ('claimed', 'running') AND agent_task_leases.lease_expires_at <= @now)
      RETURNING *
    `).get({
      reservedGroupId,
      workOrderId,
      taskKey: task.taskKey,
      taskId: task.id,
      taskRevision: task.taskRevision,
      projectId: input.projectId,
      queue: task.queue,
      role: input.role,
      actionCode: task.actionCode,
      coordinationDispatchId: input.coordinationDispatchId ?? "",
      leaseToken,
      agentId: input.agentId,
      workerId,
      poolId,
      sessionId: input.sessionId ?? "",
      runId: input.runId ?? "",
      leaseExpiresAt,
      workScopesJson: JSON.stringify(workScopes),
      workspaceKey: workspace.key,
      workspaceRecommendedPath: workspace.path,
      workspaceBranch: workspace.branch,
      now,
    }) as LeaseRow | undefined;
    if (!row) {
      const existing = store.db.prepare("SELECT * FROM agent_task_leases WHERE task_key = ?").get(task.taskKey) as LeaseRow;
      if (existing.status === "completed") {
        throw new AgentTaskLeaseError(409, "TASK_ALREADY_COMPLETED", "该任务修订已经完成，不能重复领取");
      }
      throw new AgentTaskLeaseError(409, "TASK_ALREADY_CLAIMED", `任务已由 ${existing.agent_id} 领取，租约到期时间 ${existing.lease_expires_at}`);
    }
    if (row.action_code === "approve_node_requirement") assertIndependentApprover(store, row);
    const lease = mapLease(row);
    for (const scope of workScopes) {
      store.db.prepare(`
        INSERT INTO agent_task_resource_locks (
          project_id, scope, task_key, lease_token, worker_id, acquired_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.projectId, scope, task.taskKey, leaseToken, workerId, now, leaseExpiresAt);
    }
    store.db.prepare(`
      INSERT INTO agent_task_workspace_reservations (
        workspace_key, project_id, task_key, lease_token, worker_id, recommended_path,
        workspace_path, branch_name, baseline_revision, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, '', 'reserved', ?, ?)
    `).run(workspace.key, input.projectId, task.taskKey, leaseToken, workerId, workspace.path, workspace.branch, now, now);
    upsertRunnerRegistration(store, {
      projectId: input.projectId,
      agentId: input.agentId,
      workerId,
      poolId,
      sessionId: input.sessionId ?? "",
      role: input.role,
      capabilities: input.capabilities ?? [],
      repositoryPath: project?.repositoryPath ?? "",
    });
    cacheResponse(store, operation, input.idempotencyKey, hash, lease, now);
    audit(store, lease, "claim", context, null);
    return lease;
  }).immediate();
}

export interface LeaseControlInput {
  leaseToken: string;
  agentId: string;
  idempotencyKey: string;
  /** Only the Main Agent dispatch flow may set this value. */
  coordinationDispatchId?: string;
  workOrderId?: string;
  taskKey?: string;
  taskRevision?: string;
  workerId?: string;
  role?: string;
  authSessionToken?: string;
  policyAckToken?: string;
  nonceId?: string;
  /** Accepted for protocol compatibility only; the server recomputes the digest and authenticated connection. */
  bodyDigest?: string;
  connectionId?: string;
}

export interface HeartbeatInput extends LeaseControlInput { leaseSeconds?: number }
export interface StartInput extends LeaseControlInput {
  workspacePath?: string;
  workspaceBranch?: string;
  baselineRevision?: string;
}
export interface CompleteInput extends LeaseControlInput {
  resultDigest?: string;
  documentRevisionId?: string;
  implementationRevision?: string;
  evidenceId?: string;
  testCommand?: string;
  verdict?: "pass" | "fail";
  reworkConditions?: string;
}
export interface FailInput extends LeaseControlInput { error?: string }
export interface DesignGapControlInput extends LeaseControlInput {
  workOrderId: string;
  taskKey: string;
  taskRevision: string;
  workerId: string;
  role: string;
  error: string;
  impactedPlanIds?: string[];
}

export function requiredLeaseRoleForPlanAction(action: string): AgentBlueprintKey | null {
  if (action === "submit_plan") return "designer";
  if (["start_development", "complete_development", "reopen_rework", "submit_evidence_repair"].includes(action)) return "builder";
  if (["pass_design_audit", "fail_design_audit", "pass_audit", "fail_audit"].includes(action)) return "auditor";
  if (["approve_plan", "reject_plan", "approve_acceptance", "reject_acceptance", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "accept_node"].includes(action)) return "approver";
  return null;
}

function expectedAuditScope(row: LeaseRow): AgentAuditScope | null {
  if (row.role !== "auditor") return null;
  if (row.action_code === "audit_design") return "design";
  if (row.action_code === "audit_completed_plan") return "implementation";
  return null;
}

function assertIndependentAuditWorker(store: Store, row: LeaseRow): void {
  const scope = expectedAuditScope(row);
  if (!scope) return;
  const planId = row.task_id.slice(row.task_id.indexOf(":") + 1);
  const producerTaskId = `${scope === "design" ? "design" : "development"}:${planId}`;
  const producer = store.db.prepare(`
    SELECT worker_id FROM agent_task_leases
    WHERE project_id=? AND task_id=? AND status='completed'
    ORDER BY completed_at DESC, updated_at DESC LIMIT 1
  `).get(row.project_id, producerTaskId) as { worker_id: string } | undefined;
  if (producer?.worker_id && normalizeAgentId(producer.worker_id) === normalizeAgentId(row.worker_id || row.agent_id)) {
    throw new AgentTaskLeaseError(409, "SELF_AUDIT_FORBIDDEN", "Auditor 的 workerId 必须不同于被审计生产任务的 producerWorkerId");
  }
}

function assertIndependentApprover(store: Store, row: LeaseRow): void {
  if (row.role !== "approver") return;
  const planId = row.task_id.slice(row.task_id.indexOf(":") + 1);
  const plan = store.getPlan(planId);
  const nodeApproval = row.action_code === "approve_node_requirement";
  const nodeScope = nodeApproval ? mapLease(row).workScopes.find((scope) => scope.endsWith(`:${planId}`)) : undefined;
  const scopeDiagramId = nodeScope?.split(":")[1];
  const plans = nodeApproval && scopeDiagramId
    ? store.listPlans(row.project_id, scopeDiagramId, planId).filter(isExecutableDeliveryPlan)
    : row.action_code === "accept_node" && plan?.diagramId && plan.diagramNodeId
    ? store.listPlans(plan.projectId, plan.diagramId, plan.diagramNodeId).filter(isExecutableDeliveryPlan)
    : plan ? [plan] : [];
  const approverIds = [row.worker_id, row.agent_id].map(normalizeAgentId).filter(Boolean);
  if (plans.some((item) => Object.values(item.roleAssignments).some((assignment) => approverIds.includes(normalizeAgentId(assignment.agentId))))) {
    throw new AgentTaskLeaseError(409, "SELF_APPROVAL_FORBIDDEN", "Approver 身份必须不同于 Designer、Builder 和 Auditor 的生产身份");
  }
  const taskIds = (plans.length ? plans.map((item) => item.id) : [planId])
    .flatMap((id) => [`design:${id}`, `development:${id}`, `audit:${id}`]);
  if (nodeApproval) taskIds.push(`design:${planId}`);
  const producers = store.db.prepare(`
    SELECT worker_id, agent_id FROM agent_task_leases
    WHERE project_id=? AND task_id IN (${taskIds.map(() => "?").join(",")}) AND ${nodeApproval ? "role='designer'" : "status='completed'"}
  `).all(row.project_id, ...taskIds) as Array<{ worker_id: string; agent_id: string }>;
  if (producers.some((producer) => [producer.worker_id, producer.agent_id].map(normalizeAgentId).some((id) => approverIds.includes(id)))) {
    throw new AgentTaskLeaseError(409, "SELF_APPROVAL_FORBIDDEN", "Approver 身份必须不同于 Designer、Builder 和 Auditor 的生产身份");
  }
  if (nodeApproval) {
    const principalFor = (agentId: string, workerId: string) => store.db.prepare(`
      SELECT DISTINCT principal_id FROM agent_credentials
      WHERE lower(agent_id)=lower(?) AND lower(worker_id)=lower(?)
    `).all(agentId, workerId) as Array<{ principal_id: string }>;
    const approverPrincipals = new Set(principalFor(row.agent_id, row.worker_id).map((item) => item.principal_id));
    if (approverPrincipals.size && producers.some((producer) => principalFor(producer.agent_id, producer.worker_id)
      .some((item) => approverPrincipals.has(item.principal_id)))) {
      throw new AgentTaskLeaseError(409, "SELF_APPROVAL_FORBIDDEN", "Approver 可信主体必须不同于 Designer 生产者");
    }
  }
}

function approveNodeRequirementForLease(store: Store, row: LeaseRow, input: CompleteInput, context: AgentTaskLeaseContext): void {
  if (row.queue !== "approval" || row.role !== "approver" || row.action_code !== "approve_node_requirement"
    || row.status !== "running" || !row.started_at || !input.resultDigest?.trim()) {
    throw new AgentTaskLeaseError(409, "NODE_REQUIREMENT_APPROVAL_INVALID", "节点需求批准必须由已开工的独立 Approver 工单提交审核结论");
  }
  if (input.workOrderId !== row.id || input.taskKey !== row.task_key || input.taskRevision !== row.task_revision
    || input.workerId !== row.worker_id || input.role !== row.role) {
    throw new AgentTaskLeaseError(409, "WORK_ORDER_CONTEXT_INVALID", "节点需求批准必须精确绑定当前工单与修订");
  }
  const queued = listClaimableAgentTasks(store, row.project_id).find((task) => task.taskKey === row.task_key);
  const nodeId = row.task_id.slice(row.task_id.indexOf(":") + 1);
  if (!queued || queued.projectId !== row.project_id || queued.id !== row.task_id
    || queued.taskRevision !== row.task_revision || queued.actionCode !== "approve_node_requirement"
    || queued.queue !== "approval" || queued.nodeId !== nodeId || !queued.diagramId) {
    throw new AgentTaskLeaseError(409, "TASK_REVISION_DRIFT", "节点需求审批工单已离开队列或修订已变化");
  }
  const diagram = store.getDiagram(queued.diagramId);
  const node = diagram?.nodes.find((item) => item.id === nodeId);
  const scopes = mapLease(row).workScopes;
  if (!diagram || diagram.projectId !== row.project_id || diagram.type !== "main" || !node
    || !scopes.includes(`node:${diagram.id}:${nodeId}`)) {
    throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "节点需求批准必须属于当前项目主画布及工单作用域");
  }
  assertIndependentApprover(store, row);
  if (!node.description?.trim() || !node.owner?.trim() || !node.acceptanceCriteria?.trim()
    || node.requirementStatus === "已批准"
    || buildAgentOrchestration(store, row.project_id)?.workflow.nodes.find((item) => item.nodeId === nodeId && item.diagramId === diagram.id)?.nextAction?.code !== "approve_node_requirement") {
    throw new AgentTaskLeaseError(409, "NODE_REQUIREMENT_APPROVAL_INVALID", "节点资料不足、已批准或当前流程动作已变化");
  }
  store.updateDiagram(diagram.id, { nodes: diagram.nodes.map((item) => item.id === nodeId
    ? { ...item, requirementStatus: "已批准" } : item) });
  store.recordAudit({
    projectId: row.project_id, entityType: "diagramNode", entityId: nodeId, action: "approve_node_requirement",
    before: { requirementStatus: node.requirementStatus },
    after: { requirementStatus: "已批准", workOrderId: row.id, resultDigest: input.resultDigest.trim() },
    actor: context.actor?.trim() || `agent:${row.agent_id}`, source: context.source ?? "system",
    correlationId: row.task_id, clientId: context.clientId, sessionId: context.sessionId || row.session_id || undefined,
    model: context.model,
  });
}


export function assertAgentTaskLeaseForPlanAction(store: Store, input: {
  leaseToken?: string;
  agentId?: string;
  planId: string;
  action: string;
  securityContext?: Omit<WorkOrderContextInput, "projectId" | "action" | "target">;
}): AgentTaskLease | null {
  const role = requiredLeaseRoleForPlanAction(input.action);
  if (!role) return null;
  const plan = store.getPlan(input.planId);
  if (!plan?.diagramId || !plan.diagramNodeId) return null;
  // Human UI calls omit agentId and retain their trusted direct path. Agent
  // approvals, including final acceptance, must use an independent Approver lease.
  if (["approve_plan", "reject_plan", "approve_acceptance", "reject_acceptance"].includes(input.action) && !input.agentId?.trim()) return null;
  if (isAgentSecurityEnforced(store, input.agentId)) {
    assertAgentWorkOrderContext(store, {
      ...input.securityContext,
      leaseToken: input.leaseToken,
      agentId: input.agentId,
      projectId: plan.projectId,
      action: `plan.${input.action}`,
      target: `plan:${input.planId}`,
    });
  }
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, plan.projectId);
  if (!input.leaseToken?.trim()) throw new AgentTaskLeaseError(409, "TASK_LEASE_REQUIRED", "Agent 动作必须携带有效 leaseToken；请先领取任务包");
  if (!input.agentId?.trim()) throw new AgentTaskLeaseError(400, "AGENT_ID_REQUIRED", "Agent 动作必须提供 agentId");
  const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE lease_token = ?").get(input.leaseToken) as LeaseRow | undefined;
  const now = new Date().toISOString();
  if (!row || !(["claimed", "running"] as AgentTaskLeaseStatus[]).includes(row.status) || row.lease_expires_at <= now) {
    throw new AgentTaskLeaseError(409, "LEASE_LOST", "任务租约不存在、已过期或已结束；停止工作并重新领取任务");
  }
  if (normalizeAgentId(row.agent_id) !== normalizeAgentId(input.agentId)) {
    throw new AgentTaskLeaseError(409, "LEASE_AGENT_MISMATCH", "任务租约不属于当前 Agent", {
      expectedAgentId: row.agent_id,
      expectedRole: row.role,
    });
  }
  if (row.role !== role || row.queue !== QUEUE_BY_ROLE[role] || row.task_id !== `${row.queue}:${input.planId}`) {
    throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "任务租约与当前计划或角色不匹配");
  }
  if ((input.action === "accept_node" || row.action_code === "accept_node" || ["submit_evidence_repair", "assess_evidence_repair_failure", "reset_evidence_repair_attempt"].includes(input.action)) && row.action_code !== input.action) {
    throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "证据修复租约动作与当前受控动作不匹配");
  }
  if (row.approval_group_id) throw new AgentTaskLeaseError(409, "ACTION_MISMATCH", "范围审批组只能用于对应设计变更");
  assertIndependentAuditWorker(store, row);
  assertIndependentApprover(store, row);
  return mapLease(row);
}

export function assertAgentTaskLeaseForWrite(store: Store, input: {
  leaseToken?: string;
  agentId?: string;
  planId: string;
  role: AgentBlueprintKey;
  auditScope?: AgentAuditScope | null;
}): AgentTaskLease {
  const plan = store.getPlan(input.planId);
  if (!plan) throw new AgentTaskLeaseError(404, "PLAN_NOT_FOUND", "计划不存在");
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, plan.projectId);
  if (!input.leaseToken?.trim()) throw new AgentTaskLeaseError(409, "TASK_LEASE_REQUIRED", "Agent 写操作必须携带有效 leaseToken");
  if (!input.agentId?.trim()) throw new AgentTaskLeaseError(400, "AGENT_ID_REQUIRED", "Agent 写操作必须提供 agentId");
  const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE lease_token = ?").get(input.leaseToken) as LeaseRow | undefined;
  const now = new Date().toISOString();
  if (!row || !(["claimed", "running"] as AgentTaskLeaseStatus[]).includes(row.status) || row.lease_expires_at <= now) {
    throw new AgentTaskLeaseError(409, "LEASE_LOST", "任务租约不存在、已过期或已结束；停止写入并重新领取任务");
  }
  if (normalizeAgentId(row.agent_id) !== normalizeAgentId(input.agentId)) {
    throw new AgentTaskLeaseError(409, "LEASE_AGENT_MISMATCH", "任务租约不属于当前 Agent");
  }
  if (row.project_id !== plan.projectId || row.role !== input.role || row.task_id !== `${row.queue}:${input.planId}`) {
    throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "任务租约与当前计划、项目或角色不匹配");
  }
  if (row.approval_group_id) throw new AgentTaskLeaseError(409, "ACTION_MISMATCH", "范围审批组只能用于对应设计变更");
  if (row.role === "auditor" && input.auditScope !== expectedAuditScope(row)) {
    throw new AgentTaskLeaseError(409, "AUDIT_SCOPE_MISMATCH", `审计证据必须声明 details.auditScope=${expectedAuditScope(row)}`, {
      expectedAuditScope: expectedAuditScope(row),
      planId: input.planId,
      expectedAgentId: row.agent_id,
    });
  }
  assertIndependentAuditWorker(store, row);
  assertIndependentApprover(store, row);
  return mapLease(row);
}

export function advanceAgentTaskLeaseForPlanAction(
  store: Store,
  lease: AgentTaskLease | null,
  input: { action: string; agentId?: string; idempotencyKey?: string; resultDigest?: string;
    evidenceId?: string; testCommand?: string; implementationRevision?: string },
  context: AgentTaskLeaseContext = {},
): AgentTaskLease | null {
  if (!lease) return null;
  if (!input.idempotencyKey?.trim()) {
    throw new AgentTaskLeaseError(400, "IDEMPOTENCY_KEY_REQUIRED", "Agent 动作必须提供 idempotencyKey");
  }
  const control = {
    leaseToken: lease.leaseToken,
    agentId: input.agentId ?? lease.agentId,
    idempotencyKey: `${input.idempotencyKey}:${input.action}`,
  };
  if (["start_development", "reopen_rework"].includes(input.action)) {
    return startAgentTask(store, control, context);
  }
  if (["submit_plan", "complete_development", "submit_evidence_repair", "pass_design_audit", "fail_design_audit", "pass_audit", "fail_audit", "approve_plan", "reject_plan", "approve_acceptance", "reject_acceptance", "assess_evidence_repair_failure", "reset_evidence_repair_attempt", "accept_node"].includes(input.action)) {
    return completeAgentTask(store, { ...control, resultDigest: input.resultDigest,
      evidenceId: input.evidenceId, testCommand: input.testCommand, implementationRevision: input.implementationRevision }, context);
  }
  return lease;
}

export function taskPackageLease(lease: AgentTaskLease): NonNullable<AgentTaskPackage["lease"]> {
  return {
    workOrderId: lease.workOrderId,
    taskKey: lease.taskKey,
    taskRevision: lease.taskRevision,
    status: lease.status as "claimed" | "running",
    leaseToken: lease.leaseToken,
    agentId: lease.agentId,
    workerId: lease.workerId,
    poolId: lease.poolId,
    sessionId: lease.sessionId,
    runId: lease.runId,
    leaseExpiresAt: lease.leaseExpiresAt,
    heartbeatSeconds: AGENT_TASK_HEARTBEAT_SECONDS,
    requiredForAgentWrites: true,
    workScopes: lease.workScopes,
    workspace: {
      key: lease.workspaceKey,
      recommendedPath: lease.workspaceRecommendedPath,
      recommendedBranch: lease.workspaceBranch,
      workspacePath: lease.workspacePath,
      baselineRevision: lease.baselineRevision,
      manualPreparationRequired: true,
    },
  };
}

function repairStartIdentityMatches(row: LeaseRow, input: StartInput): boolean {
  return row.id === input.workOrderId && row.lease_token === input.leaseToken
    && row.task_key === input.taskKey && row.task_revision === input.taskRevision
    && row.worker_id === input.workerId && row.agent_id === input.agentId
    && row.role === input.role && row.project_id.length > 0;
}

function assertEvidenceRepairStartProof(
  store: Store,
  row: LeaseRow,
  input: StartInput,
  context: AgentTaskLeaseContext,
  replay: boolean,
): void {
  if (!isAgentSecurityEnforced(store, row.agent_id)) return;
  if (!repairStartIdentityMatches(row, input)) {
    throw new AgentTaskLeaseError(409, "WORK_ORDER_CONTEXT_INVALID", "已登记证据修复身份必须提供完整且匹配的原始工单上下文");
  }
  if (!input.authSessionToken?.trim()) {
    throw new AgentTaskLeaseError(401, "AUTH_REQUIRED", "已登记证据修复身份必须提供有效 authSessionToken");
  }
  try {
    const principal = resolveAuthPrincipal(store, input.authSessionToken);
    if (principal.agentId !== row.agent_id || principal.workerId !== row.worker_id
      || !principal.allowedRoles.includes("builder") || !principal.allowedProjects.includes(row.project_id)) {
      throw new AgentTaskLeaseError(403, "PRINCIPAL_SPOOF_REJECTED", "认证主体与证据修复工单身份或项目范围不一致");
    }
    if (replay) return;
    if (!input.policyAckToken?.trim() || !input.nonceId?.trim()) {
      throw new AgentTaskLeaseError(409, "WORK_ORDER_CONTEXT_INVALID", "已登记证据修复首写必须提供 policyAckToken 和 nonceId");
    }
    assertAgentWorkOrderContext(store, {
      policyAckToken: input.policyAckToken,
      workOrderId: input.workOrderId,
      leaseToken: input.leaseToken,
      taskKey: input.taskKey,
      taskRevision: input.taskRevision,
      nonceId: input.nonceId,
      idempotencyKey: input.idempotencyKey,
      agentId: input.agentId,
      workerId: input.workerId,
      role: "builder",
      connectionId: principal.connectionId,
      projectId: row.project_id,
      action: context.securityAction ?? "mcp.start_agent_task",
      target: context.securityTarget ?? "mcp:start_agent_task",
      bodyDigest: evidenceRepairStartBodyDigest(input),
    });
  } catch (cause) {
    if (cause instanceof AgentTaskLeaseError) throw cause;
    if (cause instanceof AgentSecurityError) {
      throw new AgentTaskLeaseError(cause.statusCode, cause.code, cause.message);
    }
    throw cause;
  }
}

export function isExactCommittedEvidenceRepairStartReplay(store: Store, input: Partial<StartInput>): boolean {
  if (!input.workOrderId || !input.leaseToken || !input.idempotencyKey) return false;
  const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
    .get(input.workOrderId, input.leaseToken) as LeaseRow | undefined;
  if (!row || row.status !== "failed" || row.action_code !== "submit_evidence_repair"
    || !repairStartIdentityMatches(row, input as StartInput)) return false;
  const cached = store.db.prepare(`SELECT request_hash, response_json FROM agent_task_lease_idempotency
    WHERE operation='start' AND idempotency_key=?`).get(input.idempotencyKey) as IdempotencyRow | undefined;
  if (!cached || cached.request_hash !== leaseControlRequestHash("start", input)) return false;
  try {
    const response = JSON.parse(cached.response_json) as AgentTaskLease;
    const planId = row.task_id.slice(row.task_id.indexOf(":") + 1);
    const repair = getEvidenceRepairState(store, planId);
    return response.workOrderId === row.id && response.status === "failed"
      && response.actionCode === "submit_evidence_repair"
      && repair?.status === "blocked" && repair.failedWorkOrderId === row.id;
  } catch {
    return false;
  }
}

function invalidateCoordinationChildIfLost(store: Store, row: LeaseRow, timestamp: string): boolean {
  if (!row.coordination_dispatch_id
    || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) return false;
  const parent = store.db.prepare(`SELECT c.status, c.lease_expires_at
    FROM agent_child_task_dispatches d
    LEFT JOIN agent_coordination_leases c ON c.id=d.coordination_lease_id
    WHERE d.dispatch_id=?`).get(row.coordination_dispatch_id) as { status?: string; lease_expires_at?: string } | undefined;
  if (parent?.status === "active" && (parent.lease_expires_at || "") > timestamp) return false;
  store.db.prepare("UPDATE agent_task_leases SET status='released', last_error='coordination_lease_lost', completed_at=?, updated_at=? WHERE id=? AND status IN ('claimed','running')")
    .run(timestamp, timestamp, row.id);
  store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(row.lease_token);
  store.db.prepare("UPDATE agent_task_workspace_reservations SET status='released', updated_at=? WHERE lease_token=?").run(timestamp, row.lease_token);
  store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
    .run(timestamp, row.coordination_dispatch_id);
  return true;
}

function controlLease(
  store: Store, operation: Parameters<typeof controlSingleLease>[1],
  input: Parameters<typeof controlSingleLease>[2], context: AgentTaskLeaseContext,
): AgentTaskLease {
  ensureAgentTaskLeaseSchema(store);
  const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE lease_token=? AND agent_id=?")
    .get(input.leaseToken, input.agentId) as LeaseRow | undefined;
  if (row && operation === "heartbeat") {
    // A heartbeat is itself proof of liveness; revive a runner before the sweeper evaluates stale state.
    store.db.prepare("UPDATE agent_runner_registrations SET status='online', last_seen_at=?, updated_at=? WHERE project_id=? AND lower(worker_id)=lower(?)")
      .run(new Date().toISOString(), new Date().toISOString(), row.project_id, row.worker_id);
  }
  if (row && invalidateCoordinationChildIfLost(store, row, new Date().toISOString())) {
    throw new AgentTaskLeaseError(409, "LEASE_LOST", "父协调租约已失效；停止写入并等待 Main Agent 重派");
  }
  if (!row?.approval_group_id) return controlSingleLease(store, operation, input, context);
  return store.db.transaction(() => {
    const hash = leaseControlRequestHash(operation, input);
    const cached = cachedResponse<AgentTaskLease>(store, `group:${operation}`, input.idempotencyKey, hash);
    if (cached) return cached;
    const root = mapLease(row);
    if (!["release", "fail"].includes(operation)) assertApprovalGroupCurrent(store, root);
    if (operation === "complete") throw new AgentTaskLeaseError(409, "TASK_WORKFLOW_NOT_COMPLETED", "审批组必须通过设计变更提交，不能单独完成");
    const members = approvalGroupLeases(store, root);
    const primary = controlSingleLease(store, operation, input, context);
    for (const member of members.filter((member) => member.workOrderId !== root.workOrderId)) {
      controlSingleLease(store, operation === "dismiss_design_gap" ? "release" : operation, {
        ...input, leaseToken: member.leaseToken, idempotencyKey: `${input.idempotencyKey}:${member.workOrderId}`,
      }, context);
    }
    if (operation === "heartbeat") {
      store.db.prepare("UPDATE agent_task_leases SET lease_expires_at=? WHERE approval_group_id=?").run(primary.leaseExpiresAt, root.approvalGroupId!);
      for (const member of members) store.db.prepare("UPDATE agent_task_resource_locks SET expires_at=? WHERE lease_token=?").run(primary.leaseExpiresAt, member.leaseToken);
    }
    cacheResponse(store, `group:${operation}`, input.idempotencyKey, hash, primary, new Date().toISOString());
    return primary;
  }).immediate();
}

function controlSingleLease(
  store: Store,
  operation: "start" | "heartbeat" | "complete" | "fail" | "release" | "report_design_gap" | "dismiss_design_gap",
  input: LeaseControlInput & {
    leaseSeconds?: number;
    resultDigest?: string;
    error?: string;
    workspacePath?: string;
    workspaceBranch?: string;
    baselineRevision?: string;
  },
  context: AgentTaskLeaseContext,
): AgentTaskLease {
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store);
  const leaseSeconds = operation === "heartbeat" ? normalizeLeaseSeconds(input.leaseSeconds) : undefined;
  const hash = leaseControlRequestHash(operation, { ...input, leaseSeconds });
  return store.db.transaction(() => {
    const cached = cachedResponse<AgentTaskLease>(store, operation, input.idempotencyKey, hash);
    if (cached) {
      if (operation === "start" && cached.status === "failed" && cached.actionCode === "submit_evidence_repair") {
        const failedRow = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
          .get(cached.workOrderId, input.leaseToken) as LeaseRow | undefined;
        const planId = failedRow?.task_id.slice(failedRow.task_id.indexOf(":") + 1) ?? "";
        const repair = planId ? getEvidenceRepairState(store, planId) : null;
        const exactBearerReplay = Boolean(failedRow && failedRow.status === "failed"
          && failedRow.action_code === "submit_evidence_repair" && failedRow.agent_id === input.agentId
          && repair?.status === "blocked" && repair.failedWorkOrderId === failedRow.id);
        if (!exactBearerReplay || (isAgentSecurityEnforced(store, failedRow!.agent_id)
          && !isExactCommittedEvidenceRepairStartReplay(store, input))) {
          throw new AgentTaskLeaseError(409, "WORK_ORDER_CONTEXT_INVALID", "证据修复失败重放与原始工单身份或请求摘要不一致");
        }
        assertEvidenceRepairStartProof(store, failedRow!, input as StartInput, context, true);
      }
      return cached;
    }
    const now = new Date().toISOString();
    const currentRow = store.db.prepare("SELECT * FROM agent_task_leases WHERE lease_token = ?").get(input.leaseToken) as LeaseRow | undefined;
    if (!currentRow || currentRow.agent_id !== input.agentId) {
      throw new AgentTaskLeaseError(409, "LEASE_LOST", "租约不存在、已被接管或不属于当前 Agent");
    }
    if (!["claimed", "running"].includes(currentRow.status) || currentRow.lease_expires_at <= now) {
      throw new AgentTaskLeaseError(409, "LEASE_LOST", "租约已结束或过期；停止写入并重新领取任务");
    }
    let gapError = "";
    if (operation === "report_design_gap" || operation === "dismiss_design_gap") {
      const gapInput = input as DesignGapControlInput;
      if (!gapInput.error?.trim() || !gapInput.idempotencyKey?.trim()) {
        throw new AgentTaskLeaseError(400, "DESIGN_GAP_REASON_REQUIRED", "设计缺口报告或驳回必须填写具体原因和幂等键");
      }
      if (gapInput.workOrderId !== currentRow.id || gapInput.taskKey !== currentRow.task_key
        || gapInput.taskRevision !== currentRow.task_revision || gapInput.workerId !== currentRow.worker_id
        || gapInput.role !== currentRow.role) {
        throw new AgentTaskLeaseError(409, "WORK_ORDER_CONTEXT_INVALID", "缺口操作必须精确绑定当前工单、身份和修订");
      }
      const queued = listClaimableAgentTasks(store, currentRow.project_id).find((task) => task.taskKey === currentRow.task_key);
      if (!queued || queued.taskRevision !== currentRow.task_revision) {
        throw new AgentTaskLeaseError(409, "TASK_REVISION_DRIFT", "任务已离开当前队列，请刷新工单");
      }
      const plan = queued.planItemId ? store.getPlan(queued.planItemId) : undefined;
      if (!plan || !currentRow.work_scopes_json || !JSON.parse(currentRow.work_scopes_json).includes(`node:${plan.diagramId}:${plan.diagramNodeId}`)) {
        throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "缺口操作必须属于当前计划的节点范围");
      }
      if (operation === "report_design_gap") {
        if (currentRow.role !== "builder" || currentRow.queue !== "development"
          || !["start_development", "complete_development"].includes(currentRow.action_code)
          || !["approved", "in_progress"].includes(plan.lifecycleStatus)) {
          throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "只有当前施工 Builder 可以报告开工前或施工中的设计缺口");
        }
        const impactedPlanIds = [...new Set([plan.id, ...(gapInput.impactedPlanIds ?? [])])];
        if (impactedPlanIds.some((planId) => {
          const impacted = store.getPlan(planId);
          return !impacted || impacted.projectId !== plan.projectId || !isExecutableDeliveryPlan(impacted);
        })) throw new AgentTaskLeaseError(409, "DESIGN_GAP_SCOPE_INVALID", "设计缺口只能声明当前项目内的可施工计划");
        gapError = `design_gap:${JSON.stringify({ reason: gapInput.error.trim(), impactedPlanIds })}`;
      } else {
        const gap = getDesignGap(store, plan);
        if (currentRow.role !== "approver" || currentRow.queue !== "approval"
          || currentRow.action_code !== "request_design_change" || !gap) {
          throw new AgentTaskLeaseError(409, "LEASE_TASK_MISMATCH", "驳回缺口必须领取对应独立设计变更审批工单");
        }
        if (gap.id.startsWith("revision:")) {
          throw new AgentTaskLeaseError(409, "DESIGN_REVISION_DRIFT", "冻结修订已失效，必须重新设计审批，不能按误报恢复旧施工");
        }
        if (gap.impactedPlanIds.length > 1) {
          throw new AgentTaskLeaseError(409, "CROSS_NODE_APPROVAL_REQUIRED", "跨计划设计缺口不能由单张审批工单驳回");
        }
        assertIndependentApprover(store, currentRow);
        gapError = `design_gap_dismissed:${gap.id}:${gapInput.error.trim()}`;
      }
    }
    const workspacePath = input.workspacePath?.trim() || currentRow.workspace_path || "";
    const workspaceBranch = input.workspaceBranch?.trim() || currentRow.workspace_branch || "";
    let baselineRevision = input.baselineRevision?.trim() || currentRow.baseline_revision || "";
    if (operation === "start" && currentRow.action_code === "submit_evidence_repair") {
      const planId = currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1);
      const plan = store.getPlan(planId);
      if (!plan) throw new AgentTaskLeaseError(404, "PLAN_NOT_FOUND", "证据修复计划不存在");
      const queued = listClaimableAgentTasks(store, currentRow.project_id).find((task) => task.taskKey === currentRow.task_key);
      const expectedScope = `node:${plan.diagramId}:${plan.diagramNodeId}`;
      let workScopes: string[] = [];
      try { workScopes = JSON.parse(currentRow.work_scopes_json || "[]") as string[]; } catch { workScopes = []; }
      if (!queued || queued.taskRevision !== currentRow.task_revision || queued.actionCode !== "submit_evidence_repair"
        || !workScopes.includes(expectedScope)) {
        throw new AgentTaskLeaseError(409, "TASK_REVISION_DRIFT", "证据修复工单修订、动作或资源范围已变化");
      }
      assertEvidenceRepairStartProof(store, currentRow, input as StartInput, context, false);
      const repair = getEvidenceRepairState(store, plan.id)
        ?? openEvidenceRepairState(store, plan, getAgentTaskCapacity(store, currentRow.project_id).maxAttempts);
      const preflight = inspectEvidenceRepairPreflight(store, plan, currentRow.baseline_revision);
      const controlledHead = "head" in preflight ? preflight.head : String(preflight.details.head ?? "");
      if (controlledHead && input.baselineRevision?.trim() && input.baselineRevision.trim() !== controlledHead) {
        throw new AgentTaskLeaseError(409, "REPAIR_BASELINE_MISMATCH", "客户端声明的基线与受控仓库 HEAD 不一致", {
          expectedRevision: controlledHead,
          receivedRevision: input.baselineRevision.trim(),
          planId,
          taskKey: currentRow.task_key,
        });
      }
      if (!("head" in preflight)) {
        const blocked = blockEvidenceRepairState(store, plan, currentRow.id, {
          ...preflight,
          details: { ...preflight.details, repairUpdatedAt: repair.updatedAt },
        }, currentRow.attempt);
        const lastError = JSON.stringify({ code: preflight.code, message: preflight.message,
          details: { ...preflight.details, planId, taskKey: currentRow.task_key, generation: blocked.generation } });
        const repairSnapshot = JSON.stringify({
          generation: blocked.generation,
          repairUpdatedAt: blocked.updatedAt,
          proposalRevision: plan.proposalRevision,
          implementationRevision: plan.implementationRevision,
          repositoryPath: String(preflight.details.repositoryPath ?? ""),
        });
        const failedRow = store.db.prepare(`UPDATE agent_task_leases SET status='failed', last_error=?, repair_snapshot_json=?, completed_at=?, updated_at=?
          WHERE id=? AND status IN ('claimed','running') RETURNING *`).get(lastError, repairSnapshot, now, now, currentRow.id) as LeaseRow;
        store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(currentRow.lease_token);
        store.db.prepare("UPDATE agent_task_workspace_reservations SET status='fail', updated_at=? WHERE lease_token=?")
          .run(now, currentRow.lease_token);
        store.db.prepare(`UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=?
          WHERE project_id=? AND lower(worker_id)=lower(?)`).run(now, now, currentRow.project_id, currentRow.worker_id);
        if (currentRow.coordination_dispatch_id && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) {
          store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
            .run(now, currentRow.coordination_dispatch_id);
        }
        const failed = mapLease(failedRow);
        cacheResponse(store, operation, input.idempotencyKey, hash, failed, now);
        audit(store, failed, operation, context, { status: currentRow.status, evidenceRepairState: repair as unknown as Record<string, unknown> });
        return failed;
      }
      baselineRevision = controlledHead;
    }
    if (operation === "start" && currentRow.role === "builder" && currentRow.action_code !== "submit_evidence_repair") {
      const planId = currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1);
      const plan = store.getPlan(planId);
      const declaredBaseline = input.baselineRevision?.trim() || currentRow.baseline_revision || plan?.implementationRevision?.trim() || "";
      if (declaredBaseline) {
        const controlledHead = optionalRepositoryHead(store.getProject(currentRow.project_id)?.repositoryPath ?? "");
        if (controlledHead && declaredBaseline !== controlledHead) {
          throw new AgentTaskLeaseError(409, "REPAIR_BASELINE_MISMATCH", "Builder 开工基线与受控仓库 HEAD 不一致；请释放旧租约并重新领取", {
            expectedRevision: controlledHead,
            receivedRevision: declaredBaseline,
            planId,
            taskKey: currentRow.task_key,
          });
        }
        if (controlledHead) baselineRevision = controlledHead;
      }
    }
    if (["start", "complete"].includes(operation) && currentRow.role === "builder") {
      const plan = store.getPlan(currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1));
      if (plan) assertNoDesignGap(store, plan);
    }
    if (operation === "start" && currentRow.role === "builder") {
      const otherBuilders = store.db.prepare(`
        SELECT workspace_path FROM agent_task_leases
        WHERE project_id=@projectId AND role='builder' AND lease_token<>@leaseToken
          AND status IN ('claimed', 'running') AND lease_expires_at > @now
      `).all({ projectId: currentRow.project_id, leaseToken: input.leaseToken, now }) as Array<{ workspace_path: string }>;
      const repositoryPath = store.getProject(currentRow.project_id)?.repositoryPath?.trim() || "";
      if (otherBuilders.length > 0 && !workspacePath) {
        throw new AgentTaskLeaseError(409, "WORKSPACE_REQUIRED_FOR_CONCURRENCY", "并发施工必须先准备独立工作区并在 start_agent_task 提交 workspacePath");
      }
      const normalizedWorkspace = workspacePath.toLocaleLowerCase();
      if (otherBuilders.length > 0 && repositoryPath && normalizedWorkspace === repositoryPath.toLocaleLowerCase()) {
        throw new AgentTaskLeaseError(409, "SHARED_WORKSPACE_FORBIDDEN", "并发施工不能使用项目共享 repositoryPath；请使用独立 Git worktree 或等价隔离目录");
      }
      if (workspacePath && otherBuilders.some((item) => item.workspace_path
        && item.workspace_path.toLocaleLowerCase() === normalizedWorkspace)) {
        throw new AgentTaskLeaseError(409, "WORKSPACE_ALREADY_RESERVED", "该工作区已由另一个 Builder 使用");
      }
    }
    if (operation === "complete") {
      if (currentRow.action_code === "approve_node_requirement") {
        approveNodeRequirementForLease(store, currentRow, input as CompleteInput, context);
      }
      if (currentRow.action_code === "submit_evidence_repair") {
        const completion = input as CompleteInput;
        const planId = currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1);
        const plan = store.getPlan(planId);
        const evidence = completion.evidenceId ? store.getEvidence(completion.evidenceId) : undefined;
        if (!plan || !completion.evidenceId?.trim() || !completion.testCommand?.trim()
          || !completion.implementationRevision?.trim()
          || currentRow.status !== "running" || !currentRow.started_at
          || currentRow.baseline_revision !== completion.implementationRevision
          || (plan.implementationRevision.trim() && completion.implementationRevision !== plan.implementationRevision)
          || !evidence || completion.testCommand !== evidence.command
          || !matchesImplementationEvidencePolicy(evidence, plan, {
            actorRole: "builder", implementationRevision: completion.implementationRevision,
          })) {
          throw new AgentTaskLeaseError(409, "EVIDENCE_REPAIR_SUBMISSION_INVALID", "证据修复必须先开工并提交与冻结基线、计划和真实命令一致的 Builder 证据");
        }
      }
      if (isAgentSecurityEnforced(store, currentRow.agent_id)) {
        const completion = input as CompleteInput;
        const evidence = completion.evidenceId
          ? store.db.prepare("SELECT id, plan_item_id, agent_id, command, document_revision_id FROM evidence WHERE id=? AND status='active'").get(completion.evidenceId) as Record<string, string> | undefined
          : undefined;
        const planId = currentRow.task_id.includes(":") ? currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1) : "";
        const incomplete = currentRow.role === "designer"
          ? !completion.documentRevisionId?.trim()
          : currentRow.role === "builder"
            ? !completion.implementationRevision?.trim() || !completion.testCommand?.trim() || !evidence || evidence.plan_item_id !== planId || evidence.agent_id !== currentRow.agent_id
            : currentRow.role === "auditor"
              ? !completion.evidenceId?.trim() || !completion.verdict || !completion.reworkConditions?.trim() || !evidence
              : !completion.resultDigest?.trim();
        if (incomplete) throw new AgentTaskLeaseError(409, "WORK_ORDER_SUBMISSION_INCOMPLETE", "当前角色的固定修订、真实测试、证据、结论或返工条件不完整");
      }
      const stillQueued = listClaimableAgentTasks(store, currentRow.project_id)
        .some((task) => task.taskKey === currentRow.task_key);
      if (stillQueued) {
        throw new AgentTaskLeaseError(409, "TASK_WORKFLOW_NOT_COMPLETED", "任务仍在当前执行队列中；请先使用 transition_plan_delivery 完成对应流程动作");
      }
    }
    const nextStatus: AgentTaskLeaseStatus = operation === "start" ? "running"
      : operation === "complete" ? "completed"
        : operation === "fail" ? "failed"
          : ["release", "report_design_gap", "dismiss_design_gap"].includes(operation) ? "released"
            : currentRow.status;
    const leaseExpiresAt = operation === "heartbeat" ? isoAfter(leaseSeconds!) : currentRow.lease_expires_at;
    const resultDigest = operation === "complete" ? input.resultDigest ?? "" : currentRow.result_digest;
    const lastError = gapError || (operation === "fail" ? input.error?.trim() || "任务执行失败" : currentRow.last_error);
    const capacity = getAgentTaskCapacity(store, currentRow.project_id);
    const retryAvailableAt = operation === "fail" ? isoAfterFrom(capacity.retryBackoffSeconds) : currentRow.retry_available_at;
    const startedAt = operation === "start" && !currentRow.started_at ? now : currentRow.started_at;
    const completedAt = operation === "complete" ? now : currentRow.completed_at;
    const row = store.db.prepare(`
      UPDATE agent_task_leases SET
        status=@status, lease_expires_at=@leaseExpiresAt, result_digest=@resultDigest,
        last_error=@lastError, started_at=@startedAt, retry_available_at=@retryAvailableAt,
        heartbeat_at=CASE WHEN @operation='heartbeat' THEN @now ELSE heartbeat_at END,
        completed_at=@completedAt, workspace_path=@workspacePath, workspace_branch=@workspaceBranch,
        baseline_revision=@baselineRevision, updated_at=@now
      WHERE lease_token=@leaseToken AND agent_id=@agentId
        AND status IN ('claimed', 'running') AND lease_expires_at > @now
      RETURNING *
    `).get({
      status: nextStatus,
      leaseExpiresAt,
      resultDigest,
      lastError,
      retryAvailableAt,
      startedAt,
      completedAt,
      workspacePath,
      workspaceBranch,
      baselineRevision,
      operation,
      now,
      leaseToken: input.leaseToken,
      agentId: input.agentId,
    }) as LeaseRow | undefined;
    if (!row) throw new AgentTaskLeaseError(409, "LEASE_LOST", "租约已过期、已完成或已被其他 Agent 接管");
    const lease = mapLease(row);
    if (operation === "fail" && currentRow.action_code === "submit_evidence_repair") {
      const planId = currentRow.task_id.slice(currentRow.task_id.indexOf(":") + 1);
      const repair = failEvidenceRepairAttempt(store, planId, currentRow.attempt, capacity.maxAttempts, lastError);
      const plan = store.getPlan(planId);
      const repositoryPath = store.getProject(currentRow.project_id)?.repositoryPath?.trim() || "";
      if (repair && plan) {
         store.db.prepare("UPDATE agent_task_leases SET repair_snapshot_json=? WHERE id=?").run(JSON.stringify({
           generation: repair.generation,
           repairUpdatedAt: repair.updatedAt,
           proposalRevision: plan.proposalRevision,
           implementationRevision: plan.implementationRevision,
           repositoryPath,
        }), currentRow.id);
      }
    }
    if (operation === "heartbeat") {
      store.db.prepare("UPDATE agent_task_resource_locks SET expires_at=? WHERE lease_token=?")
        .run(leaseExpiresAt, lease.leaseToken);
      store.db.prepare(`
        UPDATE agent_runner_registrations SET status='online', last_seen_at=@now, updated_at=@now
        WHERE project_id=@projectId AND worker_id=@workerId
      `).run({ now, projectId: lease.projectId, workerId: lease.workerId });
    }
    if (operation === "start") {
      store.db.prepare(`
        UPDATE agent_task_workspace_reservations SET
          workspace_path=@workspacePath, branch_name=@workspaceBranch,
          baseline_revision=@baselineRevision, status='active', updated_at=@now
        WHERE lease_token=@leaseToken
      `).run({ workspacePath, workspaceBranch, baselineRevision, now, leaseToken: lease.leaseToken });
    }
    if (operation === "heartbeat" || operation === "start") {
      store.db.prepare(`
        UPDATE agent_runner_registrations SET status='online', workspace_path=@workspacePath,
          last_seen_at=@now, updated_at=@now
        WHERE project_id=@projectId AND lower(worker_id)=lower(@workerId)
      `).run({ now, projectId: lease.projectId, workerId: lease.workerId, workspacePath });
    } else if (["complete", "fail", "release", "report_design_gap", "dismiss_design_gap"].includes(operation)) {
      store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(lease.leaseToken);
      store.db.prepare(`
        UPDATE agent_task_workspace_reservations SET status=@status, updated_at=@now WHERE lease_token=@leaseToken
      `).run({ status: operation === "complete" ? "completed" : operation === "fail" ? "fail" : "release", now, leaseToken: lease.leaseToken });
      store.db.prepare(`
        UPDATE agent_runner_registrations SET status='offline', last_seen_at=@now, updated_at=@now
        WHERE project_id=@projectId AND lower(worker_id)=lower(@workerId)
      `).run({ now, projectId: lease.projectId, workerId: lease.workerId });
    }
    if (row.coordination_dispatch_id && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) {
      const dispatchStatus = operation === "start" ? "running" : operation === "complete" ? "completed" : operation === "release" || operation === "fail" ? "reclaimed" : "claimed";
      store.db.prepare("UPDATE agent_child_task_dispatches SET status=?, updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
        .run(dispatchStatus, now, row.coordination_dispatch_id);
    }
    cacheResponse(store, operation, input.idempotencyKey, hash, lease, now);
    audit(store, lease, operation, context, { status: currentRow.status, leaseExpiresAt: currentRow.lease_expires_at });
    return lease;
  }).immediate();
}

export function startAgentTask(store: Store, input: StartInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  const lease = controlLease(store, "start", input, context);
  if (lease.status === "failed" && lease.actionCode === "submit_evidence_repair") {
    try {
      const failure = JSON.parse(lease.lastError) as { code?: string; message?: string; details?: Record<string, unknown> };
      throw new AgentTaskLeaseError(409, failure.code || "REPAIR_PREFLIGHT_BLOCKED",
        failure.message || "证据修复服务器预检阻断", failure.details);
    } catch (cause) {
      if (cause instanceof AgentTaskLeaseError) throw cause;
      throw new AgentTaskLeaseError(409, "REPAIR_PREFLIGHT_BLOCKED", lease.lastError || "证据修复服务器预检阻断");
    }
  }
  return lease;
}

export function heartbeatAgentTask(store: Store, input: HeartbeatInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "heartbeat", input, context);
}

export function completeAgentTask(store: Store, input: CompleteInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "complete", input, context);
}

export function failAgentTask(store: Store, input: FailInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "fail", input, context);
}

export function releaseAgentTask(store: Store, input: LeaseControlInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "release", input, context);
}

/** Internal coordinator lookup; callers must still enforce their own parent authorization. */
export function getAgentTaskLeaseByWorkOrder(store: Store, workOrderId: string): AgentTaskLease | null {
  ensureAgentTaskLeaseSchema(store);
  const row = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=?").get(workOrderId) as LeaseRow | undefined;
  return row ? mapLease(row) : null;
}

/** Release one human-selected active lease without exposing its bearer token. */
export function releaseAgentTaskByWorkOrder(store: Store, input: {
  projectId: string;
  workOrderId: string;
  reason: string;
}): Omit<AgentTaskLease, "leaseToken"> {
  const reason = input.reason.trim();
  if (!reason) throw new AgentTaskLeaseError(400, "RELEASE_REASON_REQUIRED", "手动释放租约必须填写原因");
  ensureAgentTaskLeaseSchema(store);
  expireStaleAgentTasks(store, input.projectId);
  const row = store.db.prepare(
    "SELECT * FROM agent_task_leases WHERE project_id=? AND id=?",
  ).get(input.projectId, input.workOrderId) as LeaseRow | undefined;
  if (!row) throw new AgentTaskLeaseError(404, "LEASE_NOT_FOUND", "未找到指定工单租约");
  if (!["claimed", "running"].includes(row.status) || row.lease_expires_at <= new Date().toISOString()) {
    throw new AgentTaskLeaseError(409, "LEASE_NOT_ACTIVE", "指定租约已结束或已过期");
  }
  const lease = releaseAgentTask(store, {
    leaseToken: row.lease_token,
    agentId: row.agent_id,
    idempotencyKey: `manual-release:${row.id}:${requestHash(reason)}`,
  }, { actor: "human", source: "web", clientId: "productdesign-web", reason });
  return withoutToken(lease);
}

export function reportDesignGap(store: Store, input: DesignGapControlInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "report_design_gap", input, context);
}

export function dismissDesignGap(store: Store, input: DesignGapControlInput, context: AgentTaskLeaseContext = {}): AgentTaskLease {
  return controlLease(store, "dismiss_design_gap", input, context);
}
