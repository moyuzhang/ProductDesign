import type { PlanItem } from "../shared/types.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { nowIso, type Store } from "./db.js";

export type EvidenceRepairStatus = "open" | "blocked" | "submitted" | "exhausted" | "assessed" | "closed" | "superseded";
export type EvidenceRepairDisposition = "reset" | "design_change";

export interface EvidenceRepairState {
  planId: string;
  projectId: string;
  diagramId: string;
  nodeId: string;
  generation: number;
  status: EvidenceRepairStatus;
  attemptCount: number;
  maxAttempts: number;
  disposition: string;
  failureCode: string;
  failedWorkOrderId: string;
  failure: Record<string, unknown> | null;
  updatedAt: string;
}

interface EvidenceRepairRow {
  plan_id: string;
  project_id: string;
  diagram_id: string;
  node_id: string;
  generation: number;
  status: EvidenceRepairStatus;
  attempt_count: number;
  max_attempts: number;
  disposition: string;
  failure_code: string;
  failed_work_order_id: string;
  failure_json: string;
  updated_at: string;
}

function mapState(row: EvidenceRepairRow): EvidenceRepairState {
  return {
    planId: row.plan_id,
    projectId: row.project_id,
    diagramId: row.diagram_id,
    nodeId: row.node_id,
    generation: row.generation,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    disposition: row.disposition,
    failureCode: row.failure_code || "",
    failedWorkOrderId: row.failed_work_order_id || "",
    failure: row.failure_json ? JSON.parse(row.failure_json) as Record<string, unknown> : null,
    updatedAt: row.updated_at,
  };
}

export function ensureEvidenceRepairSchema(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_repair_state (
      plan_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      diagram_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 0,
      disposition TEXT NOT NULL DEFAULT '',
      failure_code TEXT NOT NULL DEFAULT '',
      failed_work_order_id TEXT NOT NULL DEFAULT '',
      failure_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_repair_project_status
      ON evidence_repair_state(project_id, status, updated_at);
  `);
  const columns = store.db.prepare("PRAGMA table_info(evidence_repair_state)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "failure_code")) store.db.exec("ALTER TABLE evidence_repair_state ADD COLUMN failure_code TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "failed_work_order_id")) store.db.exec("ALTER TABLE evidence_repair_state ADD COLUMN failed_work_order_id TEXT NOT NULL DEFAULT ''");
  if (!columns.some((column) => column.name === "failure_json")) store.db.exec("ALTER TABLE evidence_repair_state ADD COLUMN failure_json TEXT NOT NULL DEFAULT ''");
  store.db.exec(`CREATE TABLE IF NOT EXISTS evidence_repair_assessment_requests (
    project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, idempotency_key)
  )`);
}

export function getEvidenceRepairState(store: Store, planId: string): EvidenceRepairState | null {
  const row = store.db.prepare("SELECT * FROM evidence_repair_state WHERE plan_id=?")
    .get(planId) as EvidenceRepairRow | undefined;
  return row ? mapState(row) : null;
}

/** Read-only fallback for legacy accepted plans whose durable state has not been materialized. */
export function deriveEvidenceRepairState(plan: PlanItem, maxAttempts: number): EvidenceRepairState {
  if (!plan.diagramId || !plan.diagramNodeId) throw new Error("证据修复计划必须绑定画布节点");
  return {
    planId: plan.id,
    projectId: plan.projectId,
    diagramId: plan.diagramId,
    nodeId: plan.diagramNodeId,
    generation: 0,
    status: "open",
    attemptCount: 0,
    maxAttempts,
    disposition: "",
    failureCode: "",
    failedWorkOrderId: "",
    failure: null,
    updatedAt: "",
  };
}

export function openEvidenceRepairState(store: Store, plan: PlanItem, maxAttempts: number): EvidenceRepairState {
  if (!plan.diagramId || !plan.diagramNodeId) throw new Error("证据修复计划必须绑定画布节点");
  ensureEvidenceRepairSchema(store);
  const now = nowIso();
  const row = store.db.prepare(`
    INSERT INTO evidence_repair_state (
      plan_id, project_id, diagram_id, node_id, generation, status,
      attempt_count, max_attempts, disposition, updated_at
    ) VALUES (?, ?, ?, ?, 0, 'open', 0, ?, '', ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      project_id=excluded.project_id, diagram_id=excluded.diagram_id,
      node_id=excluded.node_id, max_attempts=excluded.max_attempts,
      updated_at=CASE WHEN evidence_repair_state.status='open' THEN excluded.updated_at ELSE evidence_repair_state.updated_at END
    RETURNING *
  `).get(plan.id, plan.projectId, plan.diagramId, plan.diagramNodeId, maxAttempts, now) as EvidenceRepairRow;
  return mapState(row);
}

export function updateEvidenceRepairState(
  store: Store,
  planId: string,
  patch: { status: EvidenceRepairStatus; attemptCount?: number; maxAttempts?: number; disposition?: string },
): EvidenceRepairState | null {
  ensureEvidenceRepairSchema(store);
  let row = store.db.prepare(`
    UPDATE evidence_repair_state SET status=@status,
      attempt_count=COALESCE(@attemptCount, attempt_count),
      max_attempts=COALESCE(@maxAttempts, max_attempts),
      disposition=COALESCE(@disposition, disposition), updated_at=@updatedAt
    WHERE plan_id=@planId RETURNING *
  `).get({ planId, status: patch.status, attemptCount: patch.attemptCount ?? null,
    maxAttempts: patch.maxAttempts ?? null, disposition: patch.disposition ?? null, updatedAt: nowIso() }) as EvidenceRepairRow | undefined;
  if (!row) {
    const plan = store.getPlan(planId);
    if (!plan?.diagramId || !plan.diagramNodeId) return null;
    openEvidenceRepairState(store, plan, patch.maxAttempts ?? 3);
    row = store.db.prepare(`
      UPDATE evidence_repair_state SET status=@status,
        attempt_count=COALESCE(@attemptCount, attempt_count),
        max_attempts=COALESCE(@maxAttempts, max_attempts),
        disposition=COALESCE(@disposition, disposition), updated_at=@updatedAt
      WHERE plan_id=@planId RETURNING *
    `).get({ planId, status: patch.status, attemptCount: patch.attemptCount ?? null,
      maxAttempts: patch.maxAttempts ?? null, disposition: patch.disposition ?? null, updatedAt: nowIso() }) as EvidenceRepairRow | undefined;
  }
  return row ? mapState(row) : null;
}

export function failEvidenceRepairAttempt(
  store: Store,
  planId: string,
  attempt: number,
  maxAttempts: number,
  error: string,
): EvidenceRepairState | null {
  const current = getEvidenceRepairState(store, planId)
    ?? (() => {
      const plan = store.getPlan(planId);
      return plan?.diagramId && plan.diagramNodeId ? openEvidenceRepairState(store, plan, maxAttempts) : null;
    })();
  if (!current) return null;
  const exhausted = attempt >= maxAttempts;
  return updateEvidenceRepairState(store, planId, {
    status: exhausted ? "exhausted" : "open",
    attemptCount: Math.max(current.attemptCount, attempt),
    maxAttempts,
    disposition: exhausted ? `attempts_exhausted:${error}` : `retry:${error}`,
  });
}

export interface EvidenceRepairPreflightFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export function inspectEvidenceRepairPreflight(
  store: Store,
  plan: PlanItem,
  frozenBaseline = "",
): { head: string; repositoryPath: string } | EvidenceRepairPreflightFailure {
  const repositoryPath = store.getProject(plan.projectId)?.repositoryPath?.trim() || "";
  const base = { source: "server_preflight", repositoryPath, implementationRevision: plan.implementationRevision, frozenBaseline };
  if (!repositoryPath) return { code: "REPAIR_REPOSITORY_REQUIRED", message: "证据修复开工前项目必须配置受控 Git repositoryPath", details: base };
  let head = "";
  try {
    head = execFileSync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    }).trim();
  } catch { /* handled below */ }
  if (!head) return { code: "REPAIR_REPOSITORY_HEAD_UNAVAILABLE", message: "无法读取受控仓库 HEAD，证据修复不得开工", details: { ...base, head } };
  if (/^nogit(?:$|[-:_/])/i.test(plan.implementationRevision.trim())) {
    return { code: "REPAIR_BASELINE_NOGIT", message: "历史 nogit 标签不是可验证仓库基线，必须独立评估", details: { ...base, head } };
  }
  if (plan.implementationRevision.trim() && plan.implementationRevision.trim() !== head) {
    return { code: "REPAIR_BASELINE_MISMATCH", message: "计划 implementationRevision 与受控仓库 HEAD 不一致", details: { ...base, head } };
  }
  if (frozenBaseline && frozenBaseline !== head) {
    return { code: "REPAIR_BASELINE_FROZEN", message: "证据修复冻结基线与受控仓库 HEAD 不一致", details: { ...base, head } };
  }
  return { head, repositoryPath };
}

export function blockEvidenceRepairState(
  store: Store,
  plan: PlanItem,
  failedWorkOrderId: string,
  failure: EvidenceRepairPreflightFailure,
  attemptCount?: number,
): EvidenceRepairState {
  const current = getEvidenceRepairState(store, plan.id) ?? openEvidenceRepairState(store, plan, 3);
  const updatedAt = nowIso();
  const payload = { ...failure.details, source: "server_preflight", generation: current.generation,
    repairUpdatedAt: current.updatedAt, failedWorkOrderId };
  const row = store.db.prepare(`UPDATE evidence_repair_state SET status='blocked',
    attempt_count=?, disposition=?, failure_code=?, failed_work_order_id=?, failure_json=?, updated_at=?
    WHERE plan_id=? RETURNING *`).get(
      attemptCount ?? current.attemptCount,
      `blocked:${failure.code}`,
      failure.code,
      failedWorkOrderId,
      JSON.stringify(payload),
      updatedAt,
      plan.id,
    ) as EvidenceRepairRow;
  return mapState(row);
}

export interface EvidenceRepairAssessmentRequest {
  projectId: string;
  planId: string;
  failedWorkOrderId: string;
  expectedGeneration: number;
  expectedRepairUpdatedAt: string;
  idempotencyKey: string;
  requestedBy?: string;
}

export class EvidenceRepairAssessmentError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EvidenceRepairAssessmentError";
  }
}

export function requestEvidenceRepairAssessment(store: Store, raw: EvidenceRepairAssessmentRequest): EvidenceRepairState {
  ensureEvidenceRepairSchema(store);
  const input = {
    ...raw,
    projectId: raw.projectId.trim(), planId: raw.planId.trim(), failedWorkOrderId: raw.failedWorkOrderId.trim(),
    expectedRepairUpdatedAt: raw.expectedRepairUpdatedAt.trim(), idempotencyKey: raw.idempotencyKey.trim(),
    requestedBy: raw.requestedBy?.trim() || "",
  };
  if (!input.projectId || !input.planId || !input.failedWorkOrderId || !input.expectedRepairUpdatedAt || !input.idempotencyKey) {
    throw new EvidenceRepairAssessmentError(400, "EVIDENCE_REPAIR_ASSESSMENT_FIELD_REQUIRED", "历史失败评估请求字段不完整");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return store.db.transaction(() => {
    const cached = store.db.prepare("SELECT request_hash, response_json FROM evidence_repair_assessment_requests WHERE project_id=? AND idempotency_key=?")
      .get(input.projectId, input.idempotencyKey) as { request_hash: string; response_json: string } | undefined;
    if (cached) {
      if (cached.request_hash !== requestHash) throw new EvidenceRepairAssessmentError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同评估请求");
      return JSON.parse(cached.response_json) as EvidenceRepairState;
    }
    const plan = store.getPlan(input.planId);
    const repair = getEvidenceRepairState(store, input.planId);
    if (!plan || plan.projectId !== input.projectId || !repair || repair.status !== "open") {
      throw new EvidenceRepairAssessmentError(409, "EVIDENCE_REPAIR_STATE_MISMATCH", "只接受当前项目内 open 证据修复的历史 failed 工单");
    }
    if (repair.generation !== input.expectedGeneration || repair.updatedAt !== input.expectedRepairUpdatedAt) {
      throw new EvidenceRepairAssessmentError(409, "EVIDENCE_REPAIR_REVISION_DRIFT", "修复 generation 或 updatedAt 已变化");
    }
    const active = store.db.prepare(`SELECT id FROM agent_task_leases WHERE project_id=? AND task_id=?
      AND status IN ('claimed','running') AND lease_expires_at>? LIMIT 1`).get(input.projectId, `development:${plan.id}`, nowIso());
    if (active) throw new EvidenceRepairAssessmentError(409, "EVIDENCE_REPAIR_ACTIVE_LEASE", "当前计划已有新活动租约，不能升级旧失败记录");
    const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=?")
      .get(input.failedWorkOrderId) as Record<string, string | number> | undefined;
    const revisionMatch = typeof lease?.task_revision === "string"
      ? /^(\d+):submit_evidence_repair:repair:(\d+)$/.exec(lease.task_revision) : null;
    const proposalRevision = Number(revisionMatch?.[1] ?? Number.NaN);
    const generation = Number(revisionMatch?.[2] ?? Number.NaN);
    if (!lease || lease.project_id !== input.projectId || lease.task_id !== `development:${plan.id}`
      || lease.action_code !== "submit_evidence_repair" || lease.status !== "failed"
      || generation !== repair.generation || proposalRevision !== plan.proposalRevision) {
      throw new EvidenceRepairAssessmentError(409, "FAILED_WORK_ORDER_MISMATCH", "failed 工单、动作、计划或完整受信 taskRevision 不匹配");
    }
    let snapshot: { generation?: number; repairUpdatedAt?: string; proposalRevision?: number;
      implementationRevision?: string; repositoryPath?: string } | undefined;
    const rawSnapshot = String(lease.repair_snapshot_json || "").trim();
    try { snapshot = rawSnapshot ? JSON.parse(rawSnapshot) : undefined; } catch { snapshot = undefined; }
    if (!snapshot || !Number.isInteger(snapshot.generation) || typeof snapshot.repairUpdatedAt !== "string"
      || !Number.isInteger(snapshot.proposalRevision) || typeof snapshot.implementationRevision !== "string"
      || typeof snapshot.repositoryPath !== "string") {
      throw new EvidenceRepairAssessmentError(409, "EVIDENCE_REPAIR_SNAPSHOT_REQUIRED",
        "历史 failed 工单缺少可验证的服务器冻结快照，不能升级；请按当前状态重新申请变更意图");
    }
    const repositoryPath = store.getProject(input.projectId)?.repositoryPath?.trim() || "";
    if (snapshot.generation !== repair.generation || snapshot.repairUpdatedAt !== repair.updatedAt
      || snapshot.proposalRevision !== plan.proposalRevision
      || snapshot.implementationRevision !== plan.implementationRevision || snapshot.repositoryPath !== repositoryPath) {
      throw new EvidenceRepairAssessmentError(409, "EVIDENCE_REPAIR_SNAPSHOT_DRIFT",
        "failed 工单冻结的计划实现、仓库或修复状态已变化；请按当前状态重新处理");
    }
    const preflight = inspectEvidenceRepairPreflight(store, plan, String(lease.baseline_revision ?? ""));
    if (!("code" in preflight)) {
      throw new EvidenceRepairAssessmentError(409, "REPAIR_PREFLIGHT_NOW_PASSES", "服务器重新预检已通过，不能把历史错误升级为 blocked");
    }
    const blocked = blockEvidenceRepairState(store, plan, input.failedWorkOrderId, {
      ...preflight,
      details: { ...preflight.details, assessmentSnapshotSource: "failed_work_order" },
    });
    store.db.prepare(`INSERT INTO evidence_repair_assessment_requests
      (project_id, idempotency_key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.projectId, input.idempotencyKey, requestHash, JSON.stringify(blocked), nowIso());
    store.recordAudit({
      projectId: input.projectId, entityType: "evidenceRepair", entityId: plan.id,
      action: "request_evidence_repair_assessment", before: repair as unknown as Record<string, unknown>,
      after: { ...blocked, requestedBy: input.requestedBy, failureSource: "server_preflight", auditTrust: "unverified_submission" },
      actor: "unverified_submission", source: "system", correlationId: `evidence-repair-assessment:${input.failedWorkOrderId}`,
    });
    return blocked;
  }).immediate();
}

export function assessEvidenceRepairFailure(
  store: Store,
  planId: string,
  disposition: EvidenceRepairDisposition,
  analysis: string,
): EvidenceRepairState {
  const current = getEvidenceRepairState(store, planId);
  if (!current || !["blocked", "exhausted", "closed"].includes(current.status)) {
    throw new Error("只有尝试耗尽或关闭后重新出现缺口的证据修复任务可以评估");
  }
  const detail = analysis.trim();
  if (!detail) throw new Error("证据修复失败评估必须记录影响分析");
  return updateEvidenceRepairState(store, planId, {
    status: "assessed",
    disposition: `${disposition}:${detail}`,
  })!;
}

/** A separate controlled approval work order is required after assessment. */
export function resetEvidenceRepairAttempt(store: Store, planId: string, disposition: string): EvidenceRepairState {
  const row = store.db.prepare(`
    UPDATE evidence_repair_state SET generation=generation+1, status='open',
      attempt_count=0, disposition=?, failure_code='', failed_work_order_id='', failure_json='', updated_at=?
    WHERE plan_id=? AND status='assessed' AND disposition LIKE 'reset:%' RETURNING *
  `).get(disposition.trim(), nowIso(), planId) as EvidenceRepairRow | undefined;
  if (!row) throw new Error("只有已评估为可重试的证据修复任务可以由新的独立审批工单重置");
  return mapState(row);
}

export class ImplementationBaselineError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ImplementationBaselineError";
  }
}

/**
 * 受控管理通道：宣告计划记录的实现基线无效并清空，同时把证据修复态重置为新一代 open。
 *
 * 适用场景一：accepted 计划的 implementationRevision 是脏值或过期提交，既不等于受控仓库
 * HEAD 也不是合法 SHA，导致 inspectEvidenceRepairPreflight 必然判 REPAIR_BASELINE_MISMATCH，
 * 证据修复与设计变更两条路径都走不通。清空后预检判据被跳过，计划回到 submit_evidence_repair。
 *
 * 适用场景二：pending_audit 且修复态为 submitted 的计划，其审计任务修订
 * （proposalRevision:implementation:completedAt）与既有的已完成审计租约撞车，无法重新派发审计。
 * 这类计划是「旧引擎未刷新 completedAt」的历史提交，需回滚为 accepted 后按新引擎重新提交修复。
 *
 * 约束：仅上述两种状态、implementationRevision 非空、无开发/审计活动租约；
 * 无修复行时不建行（工作流会派生 open）。
 */
export function resetImplementationBaseline(
  store: Store,
  input: { planId: string; actor: string; reason: string },
): PlanItem {
  ensureEvidenceRepairSchema(store);
  const planId = input.planId.trim();
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  if (!planId || !actor || !reason) {
    throw new ImplementationBaselineError(400, "BASELINE_RESET_FIELD_REQUIRED", "清空实现基线必须提供 planId、actor 和 reason");
  }
  return store.db.transaction(() => {
    const plan = store.getPlan(planId);
    if (!plan) throw new ImplementationBaselineError(404, "PLAN_NOT_FOUND", "计划项不存在");
    const before = getEvidenceRepairState(store, plan.id);
    const rollbackFromStaleAudit = plan.lifecycleStatus === "pending_audit" && before?.status === "submitted";
    if (plan.lifecycleStatus !== "accepted" && !rollbackFromStaleAudit) {
      throw new ImplementationBaselineError(409, "PLAN_NOT_ACCEPTED", "只有已验收计划，或修复态为 submitted 的待重审计划，可以重置实现基线");
    }
    const previousRevision = plan.implementationRevision.trim();
    if (!previousRevision) {
      throw new ImplementationBaselineError(409, "BASELINE_ALREADY_EMPTY", "计划当前没有实现修订，无需清空");
    }
    let active: unknown;
    try {
      active = store.db.prepare(`SELECT id FROM agent_task_leases WHERE project_id=? AND task_id IN (?,?)
        AND status IN ('claimed','running') AND lease_expires_at>? LIMIT 1`)
        .get(plan.projectId, `development:${plan.id}`, `audit:${plan.id}`, nowIso());
    } catch { /* 租约表尚未初始化时视为无活动租约 */ }
    if (active) {
      throw new ImplementationBaselineError(409, "BASELINE_RESET_ACTIVE_LEASE", "计划存在活动租约，须停止在途工作后重试");
    }
    store.updatePlan(plan.id, rollbackFromStaleAudit
      ? { implementationRevision: "", lifecycleStatus: "accepted" }
      : { implementationRevision: "" });
    let repair = before;
    if (before && !["closed", "superseded"].includes(before.status)) {
      const row = store.db.prepare(`UPDATE evidence_repair_state SET generation=generation+1, status='open',
        attempt_count=0, disposition=?, failure_code='', failed_work_order_id='', failure_json='', updated_at=?
        WHERE plan_id=? RETURNING *`).get(`baseline_reset:${reason}`, nowIso(), plan.id) as EvidenceRepairRow;
      repair = mapState(row);
    }
    const next = store.getPlan(plan.id)!;
    store.recordAudit({
      projectId: plan.projectId, entityType: "plan", entityId: plan.id,
      action: "reset_implementation_baseline",
      before: {
        lifecycleStatus: plan.lifecycleStatus, implementationRevision: previousRevision,
        repairStatus: before?.status ?? "", repairGeneration: before?.generation ?? 0,
      },
      after: {
        lifecycleStatus: next.lifecycleStatus, implementationRevision: next.implementationRevision,
        repairStatus: repair?.status ?? "", repairGeneration: repair?.generation ?? 0,
        reason, actor,
      },
      actor, source: "system", correlationId: `baseline-reset:${plan.id}`,
    });
    return next;
  }).immediate();
}

export function supersedeEvidenceRepairStates(store: Store, planIds: string[], changeId: string): number {
  if (planIds.length === 0) return 0;
  ensureEvidenceRepairSchema(store);
  const placeholders = planIds.map(() => "?").join(",");
  return store.db.prepare(`
    UPDATE evidence_repair_state SET status='superseded', disposition=?, updated_at=?
    WHERE plan_id IN (${placeholders}) AND status NOT IN ('closed', 'superseded')
  `).run(`design_change:${changeId}`, nowIso(), ...planIds).changes;
}
