import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanItem } from "../../shared/types";
import { PlanDetailModal } from "./ProjectDetailView";

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  const base: PlanItem = {
    id: "plan-1",
    projectId: "project-1",
    diagramId: null,
    diagramNodeId: null,
    parentId: null,
    kind: "task",
    title: "计划",
    description: "",
    status: "未开始",
    priority: "P1",
    progress: 0,
    owner: "builder",
    roleAssignments: {
      designer: { agentId: "designer", displayName: "Designer" },
      builder: { agentId: "builder", displayName: "Builder" },
      auditor: { agentId: "auditor", displayName: "Auditor" },
    },
    versionTag: "",
    startAt: "",
    dueAt: "",
    dependencyIds: [],
    blockedReason: "",
    completedAt: "",
    lifecycleStatus: "approved",
    proposalRevision: 1,
    proposedBy: "Designer",
    submittedAt: "2026-08-30T00:00:00.000Z",
    approvedBy: "Manager",
    approvedAt: "2026-08-30T00:01:00.000Z",
    rejectedBy: "",
    rejectedAt: "",
    rejectionReason: "",
    implementationRevision: "",
    completedBy: "",
    auditStatus: "not_requested",
    auditedBy: "",
    auditedAt: "",
    managerDecision: "pending",
    managerDecisionBy: "",
    managerDecisionAt: "",
    reworkOfPlanId: null,
    correlationId: "plan-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
    designRevisionIds: [],
  };
  return Object.assign(base, overrides);
}

function render(target: PlanItem): string {
  return renderToStaticMarkup(createElement(PlanDetailModal, {
    projectId: "project-1",
    plan: target,
    plans: [target],
    documents: [],
    documentReferences: [],
    onClose: () => {},
    onEdit: () => {},
    onDocuments: () => {},
  }));
}

describe("PlanDetailModal 的施工交付门控", () => {
  // 里程碑即使绑定了画布节点也不进施工交付流程，因此不得渲染生命周期徽章与实施流程
  it("层级计划不渲染生命周期徽章与实施流程，改为层级说明", () => {
    const html = render(plan({
      kind: "milestone",
      lifecycleStatus: "legacy",
      diagramId: "diagram-1",
      diagramNodeId: "node-1",
    }));

    expect(html).toContain("该计划为里程碑，仅用于计划层级，不进入施工交付流程。");
    expect(html).not.toContain("待纳入正式流程");
    expect(html).not.toContain("计划基线");
    expect(html).not.toContain("进入实施流程");
  });

  it("可执行施工计划仍渲染完整生命周期与实施流程入口", () => {
    const html = render(plan({
      kind: "task",
      lifecycleStatus: "approved",
      diagramId: "diagram-1",
      diagramNodeId: "node-1",
    }));

    expect(html).toContain("已批准待施工");
    expect(html).toContain("计划基线");
    expect(html).toContain("进入实施流程");
    expect(html).not.toContain("仅用于计划层级");
  });
});