import type { DesignChangeResult } from "../shared/types.js";
import type { Store } from "./db.js";

const MIGRATION = "2026-09-design-change-active-lineage";

/** Server-owned scope link. Display labels and request correlation IDs are not authorization. */
export function activeDesignChangeId(store: Store, projectId: string, diagramId: string, nodeId: string): string | null {
  const row = store.db.prepare(`SELECT change_id FROM design_change_active_nodes
    WHERE project_id=? AND diagram_id=? AND node_id=?`).get(projectId, diagramId, nodeId) as { change_id: string } | undefined;
  return row?.change_id ?? null;
}

/** Called inside the formal change transaction; supersedes every affected node, including dependencies. */
export function recordDesignChangeLineage(store: Store, result: DesignChangeResult): void {
  const scopes = new Map([[JSON.stringify([result.diagramId, result.nodeId]), [result.diagramId, result.nodeId]]]);
  for (const id of result.reworkPlanIds) {
    const plan = store.getPlan(id);
    if (plan?.projectId === result.projectId && plan.diagramId && plan.diagramNodeId) {
      scopes.set(JSON.stringify([plan.diagramId, plan.diagramNodeId]), [plan.diagramId, plan.diagramNodeId]);
    }
  }
  const write = store.db.prepare(`INSERT INTO design_change_active_nodes (project_id, diagram_id, node_id, change_id)
    VALUES (?, ?, ?, ?) ON CONFLICT(project_id, diagram_id, node_id) DO UPDATE SET change_id=excluded.change_id`);
  for (const [diagramId, nodeId] of scopes.values()) write.run(result.projectId, diagramId, nodeId, result.changeId);
}

/** One-time conservative upgrade: only an unambiguous formal history can establish an active link.
 * Never pick a "latest" record by timestamp or resurrect a superseded link from display text.
 * Missing/malformed or multiple histories stay unavailable for correction until a new formal change.
 */
export function migrateDesignChangeLineage(store: Store): void {
  if (store.db.prepare("SELECT 1 FROM schema_migrations WHERE id=?").get(MIGRATION)) return;
  store.db.transaction(() => {
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='design_change_requests'").get()) {
      const rows = store.db.prepare("SELECT change_id, response_json FROM design_change_requests").all() as Array<{ change_id: string; response_json: string }>;
      const candidates = new Map<string, DesignChangeResult[]>();
      let malformed = false;
      for (const row of rows) {
        let result: DesignChangeResult;
        try { result = JSON.parse(row.response_json); } catch { malformed = true; break; }
        if (!result || result.changeId !== row.change_id
          || ![result.projectId, result.diagramId, result.nodeId].every((id) => typeof id === "string" && id.trim())
          || !Array.isArray(result.reworkPlanIds) || !result.reworkPlanIds.every((id) => typeof id === "string" && id.trim())) {
          malformed = true; break;
        }
        const scopes = new Set([JSON.stringify([result.projectId, result.diagramId, result.nodeId])]);
        for (const id of result.reworkPlanIds) {
          const plan = store.getPlan(id);
          if (plan?.projectId === result.projectId && plan.diagramId && plan.diagramNodeId) {
            scopes.add(JSON.stringify([result.projectId, plan.diagramId, plan.diagramNodeId]));
          }
        }
        for (const scope of scopes) candidates.set(scope, [...(candidates.get(scope) ?? []), result]);
      }
      if (!malformed) for (const [scope, history] of candidates) {
        if (history.length !== 1) continue;
        const result = history[0];
        const [projectId, diagramId, nodeId] = JSON.parse(scope) as string[];
        const governance = store.getGovernance(result.changeId);
        const diagram = store.getDiagram(diagramId);
        const node = diagram?.nodes.find((item) => item.id === nodeId);
        if (!governance || governance.projectId !== projectId || governance.type !== "decision" || governance.status !== "有效"
          || diagram?.projectId !== projectId || !node) continue;
        try {
          const decision = JSON.parse(governance.content);
          if (!decision || decision.diagramId !== result.diagramId || decision.nodeId !== result.nodeId
            || typeof decision.requirementImpact !== "boolean") continue;
        } catch { continue; }
        // A surviving contradictory legacy marker is evidence of an unknown newer change.
        if (node.blockedReason?.startsWith("设计变更处理中") && node.blockedReason !== `设计变更处理中 · ${result.changeId}`) continue;
        store.db.prepare(`INSERT OR IGNORE INTO design_change_active_nodes (project_id, diagram_id, node_id, change_id)
          VALUES (?, ?, ?, ?)`).run(projectId, diagramId, nodeId, result.changeId);
      }
    }
    store.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(MIGRATION, new Date().toISOString());
  }).immediate();
}
