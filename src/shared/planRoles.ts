import type {
  PlanAgentRole,
  PlanItem,
  PlanRoleAssignment,
  PlanRoleAssignments,
} from "./types.js";

export const EMPTY_PLAN_ROLE_ASSIGNMENTS: PlanRoleAssignments = {
  designer: { agentId: "", displayName: "" },
  builder: { agentId: "", displayName: "" },
  auditor: { agentId: "", displayName: "" },
};

export const PLAN_ROLE_LABELS: Record<PlanAgentRole, string> = {
  designer: "设计者",
  builder: "施工者",
  auditor: "审计者",
};

export function normalizeAgentId(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function normalizeRoleAssignment(value?: Partial<PlanRoleAssignment> | null): PlanRoleAssignment {
  return {
    agentId: value?.agentId?.trim() ?? "",
    displayName: value?.displayName?.trim() ?? "",
    ...(value?.poolId?.trim() ? { poolId: value.poolId.trim() } : {}),
  };
}

export function normalizeRoleAssignments(value?: Partial<PlanRoleAssignments> | null): PlanRoleAssignments {
  return {
    designer: normalizeRoleAssignment(value?.designer),
    builder: normalizeRoleAssignment(value?.builder),
    auditor: normalizeRoleAssignment(value?.auditor),
  };
}

export function roleAssignmentErrors(assignments: PlanRoleAssignments, requireAll = true): string[] {
  const normalized = normalizeRoleAssignments(assignments);
  const errors: string[] = [];
  const identities = new Map<string, PlanAgentRole>();
  for (const role of ["designer", "builder", "auditor"] as const) {
    const assignment = normalized[role];
    if (requireAll && !assignment.agentId) errors.push(`${PLAN_ROLE_LABELS[role]}未分配 agentId`);
    if (requireAll && !assignment.displayName) errors.push(`${PLAN_ROLE_LABELS[role]}未填写显示名称`);
    if (!assignment.agentId) continue;
    const key = normalizeAgentId(assignment.agentId);
    const existing = identities.get(key);
    if (existing) errors.push(`${PLAN_ROLE_LABELS[existing]}与${PLAN_ROLE_LABELS[role]}不能使用同一 Agent 身份`);
    else identities.set(key, role);
  }
  return errors;
}

export function roleForPlanAction(action: string): PlanAgentRole | null {
  if (action === "submit_plan") return "designer";
  if (["start_development", "complete_development", "reopen_rework", "submit_evidence_repair"].includes(action)) return "builder";
  if (["pass_design_audit", "fail_design_audit", "pass_audit", "fail_audit"].includes(action)) return "auditor";
  return null;
}

export function displayAssignment(assignment: PlanRoleAssignment): string {
  return assignment.displayName || assignment.agentId || "未分配";
}

export function assignmentForPlanAction(plan: PlanItem, action: string): PlanRoleAssignment | null {
  const role = roleForPlanAction(action);
  return role ? plan.roleAssignments[role] : null;
}
