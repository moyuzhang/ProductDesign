import type { PlanItem } from "../shared/types.js";
import type { Store } from "./db.js";

export interface DesignGap {
  id: string;
  reason: string;
  impactedPlanIds: string[];
}

// 缺口报告与驳回复用不可变工单历史，不建立第二套计划状态机。
function hasLeases(store: Store): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get());
}

export function developmentTaskRevision(store: Store, plan: PlanItem): string {
  const base = `${plan.proposalRevision}:${plan.auditedAt || "initial"}`;
  if (!hasLeases(store)) return base;
  const dismissed = store.db.prepare(`SELECT id FROM agent_task_leases
    WHERE project_id=? AND task_id=? AND status='released'
      AND action_code='request_design_change' AND last_error LIKE 'design_gap_dismissed:%'
      AND task_revision LIKE ? ORDER BY rowid DESC LIMIT 1`)
    .get(plan.projectId, `approval:${plan.id}`, `${plan.proposalRevision}:request_design_change:gap:%`) as { id: string } | undefined;
  return dismissed ? `${base}:gap-dismissed:${dismissed.id}` : base;
}

export function transitiveDependentPlanIds(plans: PlanItem[], rootPlanIds: Iterable<string>): string[] {
  const allPlanIds = new Set(plans.map((plan) => plan.id));
  const closure = new Set([...rootPlanIds].filter((id) => allPlanIds.has(id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const plan of plans) {
      if (closure.has(plan.id) || !plan.dependencyIds.some((dependencyId) => closure.has(dependencyId))) continue;
      closure.add(plan.id);
      changed = true;
    }
  }
  return [...closure].sort();
}

export function getDesignGap(store: Store, plan: PlanItem): DesignGap | undefined {
  if (!["approved", "in_progress"].includes(plan.lifecycleStatus)) return undefined;
  for (const id of plan.designRevisionIds) {
    const revision = store.getDocumentRevision(id);
    const document = revision && store.getDesignDoc(revision.documentId);
    if (!revision || !document || document.currentRevisionId !== id || document.status !== "已批准") {
      return { id: `revision:${id}:${document?.currentRevisionId ?? "missing"}:${document?.status ?? "missing"}`,
        reason: "开工前设计缺口：冻结设计已失效或存在未绑定的新修订，必须重新提交、审计和批准",
        impactedPlanIds: [plan.id] };
    }
  }
  if (!hasLeases(store)) return undefined;
  const row = store.db.prepare(`SELECT id, last_error FROM agent_task_leases
    WHERE project_id=? AND task_id=? AND task_revision=? AND role='builder'
      AND action_code IN ('start_development', 'complete_development')
      AND status='released' AND last_error LIKE 'design_gap:%'
    ORDER BY rowid DESC LIMIT 1`)
    .get(plan.projectId, `development:${plan.id}`, developmentTaskRevision(store, plan)) as { id: string; last_error: string } | undefined;
  if (!row) return undefined;
  const payload = row.last_error.slice("design_gap:".length);
  try {
    const parsed = JSON.parse(payload) as { reason?: string; impactedPlanIds?: string[] };
    if (parsed.reason?.trim() && Array.isArray(parsed.impactedPlanIds)) {
      return { id: row.id, reason: parsed.reason.trim(), impactedPlanIds: [...new Set([plan.id, ...parsed.impactedPlanIds])] };
    }
  } catch { /* old plain-text reports remain valid */ }
  return { id: row.id, reason: payload, impactedPlanIds: [plan.id] };
}

export function assertNoDesignGap(store: Store, plan: PlanItem): void {
  const gap = getDesignGap(store, plan);
  if (gap) throw Object.assign(new Error(gap.reason), { statusCode: 409, code: "PREFLIGHT_DESIGN_GAP" });
}
