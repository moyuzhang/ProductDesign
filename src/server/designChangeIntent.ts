import { createHash } from "node:crypto";
import type {
  DesignChangeIntentInput,
  DesignChangeIntentResult,
  DesignChangeIntentStatus,
  DesignChangeIntentTaskContext,
  PlanItem,
} from "../shared/types.js";
import { newId, nowIso, type Store } from "./db.js";
import { getDesignGap, transitiveDependentPlanIds } from "./designGap.js";
import { getEvidenceRepairState } from "./evidenceRepair.js";
import { isExecutableDeliveryPlan } from "./planPolicy.js";
import { isWorkflowDeliveryNode } from "./workflow.js";

interface IntentSnapshot {
  projectId: string;
  diagramId: string;
  nodeId: string;
  rootPlanId: string;
  plans: Array<{
    id: string;
    diagramId: string | null;
    nodeId: string | null;
    proposalRevision: number;
    updatedAt: string;
    implementationRevision: string;
    designRevisionIds: string[];
    dependencyIds: string[];
    lifecycleStatus: string;
  }>;
  documents: Array<{ id: string; currentRevisionId: string; updatedAt: string }>;
  nodes: Array<{
    diagramId: string;
    diagramUpdatedAt: string;
    nodeId: string;
    deliveryUpdatedAt: string;
    requirementStatus: string;
    designStatus: string;
    developmentStatus: string;
    acceptanceStatus: string;
  }>;
}

interface IntentRow {
  id: string;
  project_id: string;
  diagram_id: string;
  node_id: string;
  root_plan_id: string;
  payload_json: string;
  snapshot_json: string;
  snapshot_hash: string;
  status: DesignChangeIntentStatus;
  change_id: string;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
  updated_at: string;
}

export class DesignChangeIntentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DesignChangeIntentError";
  }
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new DesignChangeIntentError(400, "DESIGN_CHANGE_INTENT_FIELD_REQUIRED", `${field}不能为空`);
  return result;
}

function ensureSchema(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS design_change_intents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      diagram_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      root_plan_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      change_id TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_change_intents_pending_root
      ON design_change_intents(project_id, root_plan_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_design_change_intents_project_status
      ON design_change_intents(project_id, status, updated_at);
  `);
}

function planIds(snapshot: IntentSnapshot): string[] {
  return snapshot.plans.map((plan) => plan.id);
}

function nodeScopes(snapshot: IntentSnapshot): Set<string> {
  return new Set(snapshot.nodes.map((node) => `node:${node.diagramId}:${node.nodeId}`));
}

function approvalTaskIds(snapshot: IntentSnapshot): string[] {
  const byNode = new Map<string, string>();
  for (const plan of snapshot.plans) {
    if (!plan.diagramId || !plan.nodeId) continue;
    const scope = `${plan.diagramId}:${plan.nodeId}`;
    const current = byNode.get(scope);
    if (!current || plan.id === snapshot.rootPlanId || plan.id.localeCompare(current) < 0) byNode.set(scope, plan.id);
  }
  return [...byNode.values()].sort().map((id) => `approval:${id}`);
}

function resultFromRow(row: IntentRow): DesignChangeIntentResult {
  const snapshot = JSON.parse(row.snapshot_json) as IntentSnapshot;
  return {
    intentId: row.id,
    status: row.status,
    approvalTaskIds: approvalTaskIds(snapshot),
    authorizesImplementation: false,
    snapshotHash: row.snapshot_hash,
    changeId: row.change_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowById(store: Store, intentId: string): IntentRow | undefined {
  ensureSchema(store);
  return store.db.prepare("SELECT * FROM design_change_intents WHERE id=?").get(intentId) as IntentRow | undefined;
}

export function buildDesignChangeIntentSnapshot(store: Store, projectId: string, rootPlanId: string): IntentSnapshot {
  const root = store.getPlan(rootPlanId);
  if (!root || root.projectId !== projectId || !isExecutableDeliveryPlan(root) || !root.diagramId || !root.diagramNodeId) {
    throw new DesignChangeIntentError(409, "ROOT_PLAN_SCOPE_MISMATCH", "根计划不存在、跨项目或未绑定交付节点");
  }
  const projectPlans = store.listPlans(projectId).filter(isExecutableDeliveryPlan);
  const closureIds = transitiveDependentPlanIds(projectPlans, [root.id]);
  const closure = closureIds.map((id) => projectPlans.find((plan) => plan.id === id)).filter((plan): plan is PlanItem => Boolean(plan));
  const nodeScopes = [...new Set(closure.flatMap((plan) => plan.diagramId && plan.diagramNodeId
    ? [`${plan.diagramId}\u001f${plan.diagramNodeId}`] : []))].sort();
  const references = [
    ...closure.flatMap((plan) => store.listDocumentReferences({ projectId, targetType: "plan", targetId: plan.id })),
    ...nodeScopes.flatMap((scope) => {
      const [, nodeId] = scope.split("\u001f");
      return store.listDocumentReferences({ projectId, targetType: "diagramNode", targetId: nodeId });
    }),
  ];
  const documentIds = [...new Set(references.map((reference) => reference.documentId))].sort();
  const documents = documentIds.map((id) => store.getDesignDoc(id)).filter((doc) => Boolean(doc)).map((doc) => ({
    id: doc!.id,
    currentRevisionId: doc!.currentRevisionId,
    updatedAt: doc!.updatedAt,
  }));
  const nodes = nodeScopes.map((scope) => {
    const [diagramId, nodeId] = scope.split("\u001f");
    const diagram = store.getDiagram(diagramId);
    const node = diagram?.nodes.find((item) => item.id === nodeId);
    if (!diagram || !node || diagram.projectId !== projectId || !isWorkflowDeliveryNode(diagram, node)) {
      throw new DesignChangeIntentError(409, "INTENT_NODE_SCOPE_INVALID", "依赖闭包包含不存在或不可交付的节点");
    }
    return {
      diagramId,
      diagramUpdatedAt: diagram.updatedAt,
      nodeId,
      deliveryUpdatedAt: node.deliveryUpdatedAt ?? "",
      requirementStatus: node.requirementStatus ?? "",
      designStatus: node.designStatus ?? "",
      developmentStatus: node.developmentStatus ?? "",
      acceptanceStatus: node.acceptanceStatus ?? "",
    };
  });
  return {
    projectId,
    diagramId: root.diagramId,
    nodeId: root.diagramNodeId,
    rootPlanId: root.id,
    plans: closure.map((plan) => ({
      id: plan.id,
      diagramId: plan.diagramId,
      nodeId: plan.diagramNodeId,
      proposalRevision: plan.proposalRevision,
      updatedAt: plan.updatedAt,
      implementationRevision: plan.implementationRevision,
      designRevisionIds: [...plan.designRevisionIds].sort(),
      dependencyIds: [...plan.dependencyIds].sort(),
      lifecycleStatus: plan.lifecycleStatus,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    documents: documents.sort((a, b) => a.id.localeCompare(b.id)),
    nodes,
  };
}

export function designChangeIntentSnapshotHash(snapshot: IntentSnapshot): string {
  return hash(snapshot);
}

function invalidateIntentLeases(store: Store, projectId: string, intentId: string, reason: string, now: string): void {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get()) return;
  const rows = store.db.prepare(`SELECT id, lease_token, worker_id, coordination_dispatch_id FROM agent_task_leases
    WHERE action_code='request_design_change' AND task_revision LIKE ? AND status IN ('claimed','running')`)
    .all(`%:intent:${intentId}:%`) as Array<{ id: string; lease_token: string; worker_id: string; coordination_dispatch_id: string }>;
  for (const lease of rows) {
    store.db.prepare("UPDATE agent_task_leases SET status='released', last_error=?, completed_at=?, updated_at=? WHERE id=?")
      .run(reason, now, now, lease.id);
    store.db.prepare("DELETE FROM agent_task_resource_locks WHERE lease_token=?").run(lease.lease_token);
    store.db.prepare("UPDATE agent_task_workspace_reservations SET status='released', updated_at=? WHERE lease_token=?")
      .run(now, lease.lease_token);
    store.db.prepare("UPDATE agent_runner_registrations SET status='offline', last_seen_at=?, updated_at=? WHERE project_id=? AND lower(worker_id)=lower(?)")
      .run(now, now, projectId, lease.worker_id);
    if (lease.coordination_dispatch_id && store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_child_task_dispatches'").get()) {
      store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed', updated_at=? WHERE dispatch_id=? AND status IN ('dispatched','claimed','running')")
        .run(now, lease.coordination_dispatch_id);
    }
  }
}

function staleDriftedPendingIntents(store: Store, projectId: string, rootPlanId: string, now: string): void {
  const rows = store.db.prepare("SELECT * FROM design_change_intents WHERE project_id=? AND status='pending'")
    .all(projectId) as IntentRow[];
  for (const row of rows) {
    if (row.root_plan_id !== rootPlanId) continue;
    let currentHash = "invalid";
    try { currentHash = designChangeIntentSnapshotHash(buildDesignChangeIntentSnapshot(store, projectId, row.root_plan_id)); } catch { /* stale */ }
    if (currentHash === row.snapshot_hash) continue;
    store.db.prepare("UPDATE design_change_intents SET status='stale', updated_at=? WHERE id=? AND status='pending'").run(now, row.id);
    invalidateIntentLeases(store, projectId, row.id, `design_change_intent_stale:${row.id}`, now);
    store.recordAudit({
      projectId,
      entityType: "designChangeIntent",
      entityId: row.id,
      action: "mark_stale",
      before: { status: "pending", snapshotHash: row.snapshot_hash },
      after: { status: "stale", currentSnapshotHash: currentHash },
      actor: "system",
      source: "system",
      correlationId: `design-change-intent:${row.id}`,
    });
  }
}

function assertNoConflictingGovernancePath(store: Store, snapshot: IntentSnapshot): void {
  const scopes = nodeScopes(snapshot);
  const plans = store.listPlans(snapshot.projectId).filter((plan) => plan.diagramId && plan.diagramNodeId
    && scopes.has(`node:${plan.diagramId}:${plan.diagramNodeId}`) && isExecutableDeliveryPlan(plan));
  for (const plan of plans) {
    const gap = getDesignGap(store, plan);
    if (gap) {
      throw new DesignChangeIntentError(409, "DESIGN_CHANGE_PATH_CONFLICT", "受影响范围已有正式设计缺口审批路径", {
        actionCode: "request_design_change",
        correlationId: `design-gap:${gap.id}`,
        planId: plan.id,
      });
    }
    const repair = getEvidenceRepairState(store, plan.id);
    if (repair?.status === "assessed" && repair.disposition.startsWith("design_change:")) {
      throw new DesignChangeIntentError(409, "DESIGN_CHANGE_PATH_CONFLICT", "受影响范围已有证据修复设计变更审批路径", {
        actionCode: "request_design_change",
        correlationId: `evidence-repair:${plan.id}:${repair.generation}`,
         planId: plan.id,
      });
    }
  }
}

export function submitDesignChangeIntent(store: Store, raw: DesignChangeIntentInput): DesignChangeIntentResult {
  ensureSchema(store);
  const input: DesignChangeIntentInput = {
    projectId: required(raw.projectId, "projectId"),
    diagramId: required(raw.diagramId, "diagramId"),
    nodeId: required(raw.nodeId, "nodeId"),
    rootPlanId: required(raw.rootPlanId, "rootPlanId"),
    reason: required(raw.reason, "reason"),
    changeSummary: required(raw.changeSummary, "changeSummary"),
    expectedUpdatedAt: required(raw.expectedUpdatedAt, "expectedUpdatedAt"),
    idempotencyKey: required(raw.idempotencyKey, "idempotencyKey"),
    requestedBy: raw.requestedBy?.trim() || undefined,
  };
  const requestHash = hash(input);
  return store.db.transaction(() => {
    const replay = store.db.prepare("SELECT * FROM design_change_intents WHERE project_id=? AND idempotency_key=?")
      .get(input.projectId, input.idempotencyKey) as IntentRow | undefined;
    if (replay) {
      if (replay.request_hash !== requestHash) throw new DesignChangeIntentError(409, "IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 已用于不同意图");
      return resultFromRow(replay);
    }
    const project = store.getProject(input.projectId);
    const diagram = store.getDiagram(input.diagramId);
    const root = store.getPlan(input.rootPlanId);
    if (!project) throw new DesignChangeIntentError(404, "PROJECT_NOT_FOUND", "项目不存在");
    if (!diagram || diagram.projectId !== project.id) throw new DesignChangeIntentError(409, "DIAGRAM_PROJECT_MISMATCH", "画布不存在或不属于项目");
    if (!root || root.projectId !== project.id || root.diagramId !== diagram.id || root.diagramNodeId !== input.nodeId
      || root.lifecycleStatus !== "accepted" || !isExecutableDeliveryPlan(root)) {
      throw new DesignChangeIntentError(409, "ROOT_PLAN_NOT_ACCEPTED", "变更意图必须绑定当前项目、节点下的 accepted 根计划");
    }
    if (diagram.updatedAt !== input.expectedUpdatedAt) throw new DesignChangeIntentError(409, "DIAGRAM_REVISION_CONFLICT", "画布已变化，请刷新后重新申请");
    const now = nowIso();
    staleDriftedPendingIntents(store, project.id, root.id, now);
    const snapshot = buildDesignChangeIntentSnapshot(store, project.id, root.id);
    const snapshotHash = designChangeIntentSnapshotHash(snapshot);
    assertNoConflictingGovernancePath(store, snapshot);
    const pending = store.db.prepare("SELECT * FROM design_change_intents WHERE project_id=? AND status='pending'")
      .all(project.id) as IntentRow[];
    const planScope = new Set(planIds(snapshot));
    const nodeScope = nodeScopes(snapshot);
    const conflict = pending.find((row) => {
      const other = JSON.parse(row.snapshot_json) as IntentSnapshot;
      return row.root_plan_id === root.id
        || planIds(other).some((id) => planScope.has(id))
        || [...nodeScopes(other)].some((scope) => nodeScope.has(scope));
    });
    if (conflict) {
      throw new DesignChangeIntentError(409, "DESIGN_CHANGE_INTENT_PENDING", "相同或重叠范围已有 pending 变更意图", {
        intentId: conflict.id,
        correlationId: `design-change-intent:${conflict.id}`,
      });
    }
    const id = newId();
    store.db.prepare(`INSERT INTO design_change_intents
      (id, project_id, diagram_id, node_id, root_plan_id, payload_json, snapshot_json, snapshot_hash,
       status, change_id, idempotency_key, request_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?)`)
      .run(id, project.id, diagram.id, input.nodeId, root.id, JSON.stringify(input), JSON.stringify(snapshot), snapshotHash,
        input.idempotencyKey, requestHash, now, now);
    const row = rowById(store, id)!;
    store.recordAudit({
      projectId: project.id,
      entityType: "designChangeIntent",
      entityId: id,
      action: "submit_design_change_intent",
      before: null,
      after: { ...resultFromRow(row), requestedBy: input.requestedBy ?? "", auditTrust: "unverified_submission" },
      actor: "unverified_submission",
      source: "system",
      correlationId: `design-change-intent:${id}`,
    });
    return resultFromRow(row);
  }).immediate();
}

export function listPendingDesignChangeIntents(store: Store, projectId: string): DesignChangeIntentTaskContext[] {
  ensureSchema(store);
  const rows = store.db.prepare("SELECT * FROM design_change_intents WHERE project_id=? AND status='pending' ORDER BY created_at")
    .all(projectId) as IntentRow[];
  return rows.flatMap((row) => {
    const snapshot = JSON.parse(row.snapshot_json) as IntentSnapshot;
    let currentHash = "";
    try { currentHash = designChangeIntentSnapshotHash(buildDesignChangeIntentSnapshot(store, projectId, row.root_plan_id)); } catch { return []; }
    if (currentHash !== row.snapshot_hash) return [];
    const payload = JSON.parse(row.payload_json) as DesignChangeIntentInput;
    return [{
      intentId: row.id,
      rootPlanId: row.root_plan_id,
      impactedPlanIds: planIds(snapshot),
      impactedDocumentIds: snapshot.documents.map((doc) => doc.id),
      snapshotHash: row.snapshot_hash,
      reason: payload.reason,
      changeSummary: payload.changeSummary,
    }];
  });
}

export function getDesignChangeIntent(store: Store, intentId: string): {
  context: DesignChangeIntentTaskContext;
  status: DesignChangeIntentStatus;
  changeId: string;
} | null {
  const row = rowById(store, intentId);
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot_json) as IntentSnapshot;
  const payload = JSON.parse(row.payload_json) as DesignChangeIntentInput;
  return {
    status: row.status,
    changeId: row.change_id,
    context: {
      intentId: row.id,
      rootPlanId: row.root_plan_id,
      impactedPlanIds: planIds(snapshot),
      impactedDocumentIds: snapshot.documents.map((doc) => doc.id),
      snapshotHash: row.snapshot_hash,
      reason: payload.reason,
      changeSummary: payload.changeSummary,
    },
  };
}

export function assertDesignChangeIntentCurrent(store: Store, intentId: string, projectId: string): DesignChangeIntentTaskContext {
  const intent = getDesignChangeIntent(store, intentId);
  if (!intent || intent.status !== "pending") throw new DesignChangeIntentError(409, "DESIGN_CHANGE_INTENT_NOT_PENDING", "变更意图不存在或已结束");
  const current = buildDesignChangeIntentSnapshot(store, projectId, intent.context.rootPlanId);
  if (designChangeIntentSnapshotHash(current) !== intent.context.snapshotHash) {
    throw new DesignChangeIntentError(409, "DESIGN_CHANGE_INTENT_STALE", "冻结指纹已漂移；请重新提交变更意图");
  }
  return intent.context;
}

export function finishDesignChangeIntent(store: Store, intentId: string, status: "applied" | "dismissed", changeId = ""): void {
  const now = nowIso();
  const changed = store.db.prepare("UPDATE design_change_intents SET status=?, change_id=?, updated_at=? WHERE id=? AND status='pending'")
    .run(status, changeId, now, intentId);
  if (changed.changes !== 1) throw new DesignChangeIntentError(409, "DESIGN_CHANGE_INTENT_NOT_PENDING", "变更意图已由其他请求处理");
}
