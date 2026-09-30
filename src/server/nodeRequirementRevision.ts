import type { Diagram, DiagramNode } from "../shared/types.js";
import { PROJECT_WORKFLOW_POLICY } from "../shared/workflowPolicy.js";
import type { Store } from "./db.js";

const CHANGE_MARKER = /^设计变更处理中 · ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const requirementFields = ["description", "owner", "acceptanceCriteria", "preconditions", "mainFlow", "alternateFlow", "postconditions"] as const;
export const protectedRequirementFields = [...requirementFields, "requirementStatus", "blockedReason", "kind"] as const;

export function hasRequirementChangeMarker(node: DiagramNode): boolean {
  return (node.blockedReason ?? "").startsWith("设计变更处理中");
}

export function isRequirementDeliveryNode(diagram: Diagram, node: DiagramNode): boolean {
  return PROJECT_WORKFLOW_POLICY.deliveryDiagramTypes.some((type) => type === diagram.type)
    && PROJECT_WORKFLOW_POLICY.deliveryNodeKinds.some((kind) => kind === node.kind);
}

/** 整图写入也不能绕过受控节点；标记仅用于定位，正式记录才是授权来源。 */
export function changesProtectedRequirement(before: Diagram, nextNodes: DiagramNode[], nextType: string = before.type): boolean {
  if (nextType !== before.type && before.nodes.some(hasRequirementChangeMarker)) return true;
  return before.nodes.some((node) => {
    const next = nextNodes.find((item) => item.id === node.id);
    if (!hasRequirementChangeMarker(node) && !(next && hasRequirementChangeMarker(next))) return false;
    return !next || protectedRequirementFields.some((field) => next[field] !== node[field]);
  }) || nextNodes.some((node) => hasRequirementChangeMarker(node) && !before.nodes.some((item) => item.id === node.id));
}

export function requirementChangeSource(store: Store, diagram: Diagram, node: DiagramNode): string | null {
  const changeId = CHANGE_MARKER.exec(node.blockedReason ?? "")?.[1];
  if (!changeId || !isRequirementDeliveryNode(diagram, node) || !["草拟中", "待评审"].includes(node.requirementStatus ?? "")
    || store.getDiagram(diagram.id)?.projectId !== diagram.projectId
    || !diagram.nodes.some((item) => item.id === node.id)
    || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='design_change_requests'").get()) return null;
  const request = store.db.prepare("SELECT response_json FROM design_change_requests WHERE change_id=?")
    .get(changeId) as { response_json: string } | undefined;
  const governance = store.getGovernance(changeId);
  if (!request || !governance || governance.projectId !== diagram.projectId
    || governance.type !== "decision" || governance.status !== "有效") return null;
  try {
    const result = JSON.parse(request.response_json) as Record<string, unknown>;
    const decision = JSON.parse(governance.content) as Record<string, unknown>;
    return result.changeId === changeId && result.projectId === diagram.projectId
      && result.diagramId === diagram.id && result.nodeId === node.id
      && decision.diagramId === diagram.id && decision.nodeId === node.id
      && decision.requirementImpact === true ? changeId : null;
  } catch { return null; }
}

export function pendingRequirementRevision(store: Store, diagram: Diagram, node: DiagramNode): string | null {
  const changeId = requirementChangeSource(store, diagram, node);
  if (!changeId) return null;
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get()) return changeId;
  const completed = store.db.prepare(`SELECT 1 FROM agent_task_leases AS lease
    WHERE project_id=? AND action_code='revise_node_requirement'
      AND task_revision=? AND status='completed'
      AND EXISTS (SELECT 1 FROM json_each(lease.work_scopes_json) WHERE value=?) LIMIT 1`)
    .get(diagram.projectId, `revise_node_requirement:${changeId}`, `node:${diagram.id}:${node.id}`);
  return completed ? null : changeId;
}
