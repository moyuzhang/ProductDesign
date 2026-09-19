import type { Evidence, PlanAgentRole, PlanItem } from "../shared/types.js";
import { normalizeAgentId } from "../shared/planRoles.js";
import type { Store } from "./db.js";

export interface ImplementationEvidencePolicy {
  actorRole: Extract<PlanAgentRole, "builder" | "auditor">;
  resultStatus?: Evidence["resultStatus"];
  implementationRevision?: string;
}

/**
 * The single strict policy used whenever implementation evidence is allowed to
 * advance or close delivery.  In particular, a node-level match is not enough:
 * evidence must belong to the exact plan and current implementation revision.
 */
export function matchesImplementationEvidencePolicy(
  evidence: Evidence,
  plan: PlanItem,
  policy: ImplementationEvidencePolicy,
): boolean {
  const implementationRevision = policy.implementationRevision?.trim() || plan.implementationRevision.trim();
  if (!implementationRevision) return false;
  const assignment = plan.roleAssignments[policy.actorRole];
  if (!assignment?.agentId.trim()) return false;
  const detailRevision = typeof evidence.details.implementationRevision === "string"
    ? evidence.details.implementationRevision.trim()
    : "";
  const commitRevision = evidence.commitSha.trim();
  return evidence.status === "active"
    && evidence.resultStatus === (policy.resultStatus ?? "pass")
    && Boolean(evidence.summary.trim())
    && evidence.projectId === plan.projectId
    && evidence.nodeId === plan.diagramNodeId
    && evidence.planItemId === plan.id
    && evidence.actorRole === policy.actorRole
    && normalizeAgentId(evidence.agentId) === normalizeAgentId(assignment.agentId)
    && evidence.details.auditScope === "implementation"
    && detailRevision === implementationRevision
    && commitRevision === implementationRevision;
}

export function implementationEvidenceForPlan(
  store: Store,
  plan: PlanItem,
  policy: ImplementationEvidencePolicy,
): Evidence[] {
  return store.listEvidence(plan.projectId, plan.diagramNodeId ?? undefined)
    .filter((evidence) => matchesImplementationEvidencePolicy(evidence, plan, policy));
}

export function hasImplementationEvidence(
  store: Store,
  plan: PlanItem,
  policy: ImplementationEvidencePolicy,
): boolean {
  return implementationEvidenceForPlan(store, plan, policy).length > 0;
}
