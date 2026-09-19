import type { PlanAgentRole, PlanItem } from "../shared/types.js";
import {
  normalizeAgentId,
  PLAN_ROLE_LABELS,
  roleAssignmentErrors,
  roleForPlanAction,
} from "../shared/planRoles.js";

function roleError(statusCode: number, code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { statusCode, code, details });
}

export function assertPlanRoleSeparation(plan: PlanItem): void {
  const errors = roleAssignmentErrors(plan.roleAssignments, true);
  if (errors.length > 0) throw roleError(409, "ROLE_ASSIGNMENT_INVALID", `计划角色分配无效：${errors.join("；")}`, { errors });
}

export function assertPlanActionIdentity(plan: PlanItem, action: string, agentId?: string): void {
  const role = roleForPlanAction(action);
  if (!role) return;
  assertPlanRoleSeparation(plan);
  if (!agentId?.trim()) throw roleError(400, "AGENT_ID_REQUIRED", `${PLAN_ROLE_LABELS[role]}动作必须提供 agentId，actor 仅用于显示，不能作为身份依据`, {
    expectedRole: role,
    expectedAgentId: plan.roleAssignments[role].agentId,
    expectedDisplayName: plan.roleAssignments[role].displayName,
  });
  const assigned = plan.roleAssignments[role];
  if (normalizeAgentId(agentId) !== normalizeAgentId(assigned.agentId)) {
    throw roleError(409, "ASSIGNEE_MISMATCH", `身份不匹配：${PLAN_ROLE_LABELS[role]}任务已分配给 ${assigned.displayName || assigned.agentId}`, {
      expectedRole: role,
      expectedAgentId: assigned.agentId,
      expectedDisplayName: assigned.displayName,
    });
  }
}

export function assertEvidenceIdentity(plan: PlanItem, role: PlanAgentRole | null, agentId: string): void {
  if (!role && !agentId.trim()) return;
  if (!role || !agentId.trim()) throw roleError(400, "AGENT_ID_REQUIRED", "计划证据必须同时提供 actorRole 与 agentId", {
    expectedRole: role,
    expectedAgentId: role ? plan.roleAssignments[role].agentId : undefined,
    expectedDisplayName: role ? plan.roleAssignments[role].displayName : undefined,
  });
  assertPlanRoleSeparation(plan);
  const assigned = plan.roleAssignments[role];
  if (normalizeAgentId(agentId) !== normalizeAgentId(assigned.agentId)) {
    throw roleError(409, "ASSIGNEE_MISMATCH", `证据身份不匹配：${PLAN_ROLE_LABELS[role]}已分配给 ${assigned.displayName || assigned.agentId}`, {
      expectedRole: role,
      expectedAgentId: assigned.agentId,
      expectedDisplayName: assigned.displayName,
    });
  }
}
