import type { PlanItem, PlanLifecycleStatus } from "./types.js";

export const PLAN_DELIVERY_ACTIONS = [
  "submit_plan",
  "pass_design_audit",
  "fail_design_audit",
  "approve_plan",
  "reject_plan",
  "start_development",
  "complete_development",
  "pass_audit",
  "fail_audit",
  "approve_acceptance",
  "reject_acceptance",
  "reopen_rework",
] as const;

export type PlanDeliveryAction = (typeof PLAN_DELIVERY_ACTIONS)[number];

export interface PlanDeliveryActionDescriptor {
  action: PlanDeliveryAction;
  label: string;
  actorRole: "designer" | "builder" | "auditor" | "approver";
  tone: "primary" | "neutral" | "danger";
  requiresReason?: boolean;
  requiresImplementationRevision?: boolean;
}

export const PLAN_LIFECYCLE_LABELS: Record<PlanLifecycleStatus, string> = {
  legacy: "待纳入正式流程",
  draft: "计划草拟",
  pending_approval: "待主 Agent 批准",
  approved: "已批准待施工",
  in_progress: "施工中",
  pending_audit: "待独立审计",
  audit_failed: "审计失败待返工",
  pending_manager: "待主 Agent 验收",
  accepted: "交付已验收",
  rework: "计划待修订",
  superseded: "已由后续计划取代",
};

export const PLAN_DELIVERY_STEPS = [
  "计划基线",
  "设计审计",
  "主 Agent 批准",
  "开始施工",
  "独立审计",
  "主 Agent 验收",
  "交付关闭",
] as const;

const LIFECYCLE_STEP: Record<PlanLifecycleStatus, number> = {
  legacy: 1,
  draft: 1,
  rework: 1,
  pending_approval: 2,
  approved: 4,
  in_progress: 4,
  pending_audit: 5,
  audit_failed: 5,
  pending_manager: 6,
  accepted: 7,
  superseded: 7,
};

export function planLifecycleStep(status: PlanLifecycleStatus): number {
  return LIFECYCLE_STEP[status];
}

export function planDeliveryActions(plan: Pick<PlanItem, "lifecycleStatus" | "submittedAt" | "approvedAt" | "auditStatus">): PlanDeliveryActionDescriptor[] {
  switch (plan.lifecycleStatus) {
    case "legacy":
    case "draft":
    case "rework":
      return [{ action: "submit_plan", label: "提交施工计划", actorRole: "designer", tone: "primary" }];
    case "pending_approval":
      if (plan.auditStatus !== "passed") {
        return [
          { action: "pass_design_audit", label: "设计审计通过", actorRole: "auditor", tone: "primary" },
          { action: "fail_design_audit", label: "设计审计失败", actorRole: "auditor", tone: "danger", requiresReason: true },
        ];
      }
      return [
        { action: "approve_plan", label: "批准施工计划", actorRole: "approver", tone: "primary" },
        { action: "reject_plan", label: "退回计划", actorRole: "approver", tone: "danger", requiresReason: true },
      ];
    case "approved":
      if (!plan.submittedAt || !plan.approvedAt) {
        return [{ action: "submit_plan", label: "补录并重新提交计划", actorRole: "designer", tone: "primary" }];
      }
      return [{ action: "start_development", label: "开始施工", actorRole: "builder", tone: "primary" }];
    case "in_progress":
      if (!plan.submittedAt || !plan.approvedAt) {
        return [{ action: "submit_plan", label: "补录并重新提交计划", actorRole: "designer", tone: "primary" }];
      }
      return [{ action: "complete_development", label: "提交施工完成", actorRole: "builder", tone: "primary", requiresImplementationRevision: true }];
    case "pending_audit":
      return [
        { action: "pass_audit", label: "审计通过", actorRole: "auditor", tone: "primary" },
        { action: "fail_audit", label: "审计失败", actorRole: "auditor", tone: "danger", requiresReason: true },
      ];
    case "audit_failed":
      return [{ action: "reopen_rework", label: "开始返工", actorRole: "builder", tone: "primary" }];
    case "pending_manager":
      return [
        { action: "approve_acceptance", label: "批准最终验收", actorRole: "approver", tone: "primary" },
        { action: "reject_acceptance", label: "拒绝验收", actorRole: "approver", tone: "danger", requiresReason: true },
      ];
    case "accepted":
    case "superseded":
      return [];
  }
}
