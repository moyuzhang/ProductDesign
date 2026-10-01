import { activeDesignChangeId } from "./designChangeLineage.js";
import { createHash } from "node:crypto";
import type { DesignChangeRecovery, DesignChangeResult, Diagram, PlanItem } from "../shared/types.js";
import type { Store } from "./db.js";
import { isActiveDeliveryPlan } from "./planPolicy.js";

export class DesignChangeCorrectionError extends Error {
  readonly statusCode = 409;
  readonly code = "DESIGN_CHANGE_CORRECTION_NOT_CURRENT";
  readonly details = { recoveryAction: "refresh_current_design_change", owner: "independent_approver" };
}

export function assertDesignChangeCorrection(store: Store, projectId: string, root: PlanItem, changeId: string) {
  const fail = () => { throw new DesignChangeCorrectionError("只能复核当前节点尚未完成、原判定为无需求影响的正式设计变更；请刷新当前变更和根计划"); };
  if (root.projectId !== projectId || !root.diagramId || !root.diagramNodeId || !isActiveDeliveryPlan(root)
    || !["draft", "pending_approval", "rework"].includes(root.lifecycleStatus)) return fail();
  const diagram = store.getDiagram(root.diagramId);
  const node = diagram?.nodes.find((item) => item.id === root.diagramNodeId);
  if (!diagram || diagram.projectId !== projectId || !node || activeDesignChangeId(store, projectId, diagram.id, node.id) !== changeId) return fail();
  const governance = store.getGovernance(changeId);
  if (!governance || governance.projectId !== projectId || governance.type !== "decision" || governance.status !== "有效") return fail();
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='design_change_requests'").get()) return fail();
  const row = store.db.prepare("SELECT response_json FROM design_change_requests WHERE change_id=?").get(changeId) as { response_json: string } | undefined;
  if (!row) return fail();
  let decision: Record<string, unknown>; let result: DesignChangeResult;
  try { decision = JSON.parse(governance.content); result = JSON.parse(row.response_json); } catch { return fail(); }
  if (!decision || !result || decision.requirementImpact !== false || decision.diagramId !== diagram.id || decision.nodeId !== node.id
    || result.changeId !== changeId || result.projectId !== projectId || result.diagramId !== diagram.id || result.nodeId !== node.id
    || (!Array.isArray(result.reworkPlanIds) || !result.reworkPlanIds.includes(root.id))) return fail();
  return {
    changeId,
    sourceHash: createHash("sha256").update(JSON.stringify({ governance, result })).digest("hex"),
  };
}

export function listDesignChangeRecoveries(store: Store, projectId: string, plans?: PlanItem[], diagrams?: Diagram[]): DesignChangeRecovery[] {
  const result: DesignChangeRecovery[] = [];
  const seen = new Set<string>();
  for (const root of plans ?? store.listPlans(projectId)) {
    if (!root.diagramId || !root.diagramNodeId) continue;
    const diagram = diagrams ? diagrams.find((item) => item.id === root.diagramId) : store.getDiagram(root.diagramId);
    const node = diagram?.nodes.find((item) => item.id === root.diagramNodeId);
    const changeId = node && diagram ? activeDesignChangeId(store, projectId, diagram.id, node.id) : null;
    if (!changeId || seen.has(changeId)) continue;
    try { assertDesignChangeCorrection(store, projectId, root, changeId); } catch { continue; }
    seen.add(changeId);
    result.push({ correctsChangeId: changeId, diagramId: diagram!.id, nodeId: node!.id, rootPlanId: root.id,
      nodeLabel: node!.label, expectedUpdatedAt: diagram!.updatedAt, requiresIndependentApproval: true,
      reason: "当前变更记录为无需求影响，返工计划尚未完成。如分类有误，需要新独立审批更正；不能直接改写已批准需求或复用旧审批。" });
  }
  return result;
}
