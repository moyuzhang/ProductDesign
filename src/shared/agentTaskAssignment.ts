import type {
  AgentBlueprintKey,
  AgentOrchestrationTask,
  PlanRoleAssignment,
} from "./types.js";
import { normalizeAgentId, normalizeRoleAssignment } from "./planRoles.js";

export interface EffectiveAgentTaskAssignment {
  assignee: PlanRoleAssignment | null;
  poolId: string;
}

export function implicitAgentTaskPoolId(
  projectId: string,
  role: AgentBlueprintKey,
  agentId: string,
): string {
  return `pool:${projectId}:${role}:${normalizeAgentId(agentId)}`;
}

function normalizeDesignNodeId(nodeId: string): string {
  return encodeURIComponent(nodeId.trim().toLocaleLowerCase())
    .replace(/%/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
}

function stableAssignmentFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Resolves the single assignment contract used by orchestration, task lists,
 * REST/MCP task packages, and atomic claims.
 *
 * Plans remain authoritative for every planned task. The only synthetic
 * assignment is a deterministic Designer identity for an unplanned design
 * task that is already anchored to a concrete canvas node.
 */
export function effectiveAgentTaskAssignment(
  task: Pick<AgentOrchestrationTask,
    "queue" | "projectId" | "diagramId" | "nodeId" | "planItemId" | "title" | "assignee">,
  role: AgentBlueprintKey,
): EffectiveAgentTaskAssignment {
  const assigned = normalizeRoleAssignment(task.assignee);
  if (assigned.agentId) {
    return {
      assignee: assigned,
      poolId: assigned.poolId || implicitAgentTaskPoolId(task.projectId, role, assigned.agentId),
    };
  }

  if (
    role !== "designer"
    || task.queue !== "design"
    || task.planItemId !== null
    || !task.projectId.trim()
    || !task.diagramId?.trim()
    || !task.nodeId?.trim()
  ) {
    return { assignee: null, poolId: "" };
  }

  const nodeSegment = normalizeDesignNodeId(task.nodeId);
  if (!nodeSegment) return { assignee: null, poolId: "" };
  const identitySource = [task.projectId, task.diagramId, task.nodeId, role].join("\u001f");
  const agentId = `design-node-${nodeSegment}-${stableAssignmentFingerprint(identitySource)}`;
  const assignee: PlanRoleAssignment = {
    agentId,
    displayName: `${task.title.trim() || task.nodeId} Designer`,
    poolId: implicitAgentTaskPoolId(task.projectId, role, agentId),
  };
  return { assignee, poolId: assignee.poolId! };
}
