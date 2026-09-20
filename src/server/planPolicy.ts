import type { PlanItem } from "../shared/types.js";
import { PROJECT_WORKFLOW_POLICY } from "../shared/workflowPolicy.js";

const EXECUTABLE_PLAN_KINDS = new Set<string>(PROJECT_WORKFLOW_POLICY.executablePlanKinds);

/** Only task plans are executable delivery work. Goals, milestones, and versions are hierarchy only. */
export function isExecutableDeliveryPlan(plan: Pick<PlanItem, "kind">): boolean {
  return EXECUTABLE_PLAN_KINDS.has(plan.kind);
}

export interface DependencyEditDecision {
  allowed: boolean;
  lifecyclePatch: Partial<PlanItem>;
  message?: string;
}

function sameDependencies(current: string[], next: string[]): boolean {
  if (current.length !== next.length) return false;
  const currentSet = new Set(current);
  return next.every((id) => currentSet.has(id));
}

/**
 * 依赖属于计划基线。未开工计划允许修订，但任何正式批准都必须立即失效，
 * 防止施工 Agent 沿用管理员针对旧依赖图做出的批准。
 */
export function decideDependencyEdit(plan: PlanItem, nextDependencyIds: string[]): DependencyEditDecision {
  if (sameDependencies(plan.dependencyIds, nextDependencyIds)) return { allowed: true, lifecyclePatch: {} };
  if (!isExecutableDeliveryPlan(plan) || ["legacy", "draft", "rework"].includes(plan.lifecycleStatus)) {
    return { allowed: true, lifecyclePatch: {} };
  }
  const neverStarted = plan.status === "未开始"
    && plan.progress === 0
    && !plan.startAt
    && !plan.completedAt
    && !plan.implementationRevision;
  if (plan.lifecycleStatus === "approved" && neverStarted) {
    return {
      allowed: true,
      lifecyclePatch: {
        lifecycleStatus: "rework",
        proposedBy: "",
        submittedAt: "",
        approvedBy: "",
        approvedAt: "",
        rejectedBy: "",
        rejectedAt: "",
        rejectionReason: "依赖关系已调整，原计划批准已失效；必须重新提交并由管理员批准。",
        auditStatus: "not_requested",
        auditedBy: "",
        auditedAt: "",
        managerDecision: "pending",
        managerDecisionBy: "",
        managerDecisionAt: "",
      },
    };
  }
  return {
    allowed: false,
    lifecyclePatch: {},
    message: "依赖关系只能在未正式批准、计划草稿或返工阶段修改；已开工计划必须先完成正式返工流转",
  };
}
