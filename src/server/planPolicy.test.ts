import { describe, expect, it } from "vitest";
import type { PlanItem } from "../shared/types.js";
import { decideDependencyEdit } from "./planPolicy.js";

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    projectId: "project-1",
    diagramId: "diagram-1",
    diagramNodeId: "node-1",
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
    dependencyIds: ["old-dependency"],
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
    ...overrides,
  };
}

describe("decideDependencyEdit", () => {
  it("moves an approved but unstarted task back to rework and invalidates the old approval", () => {
    const decision = decideDependencyEdit(plan(), ["new-dependency"]);

    expect(decision.allowed).toBe(true);
    expect(decision.lifecyclePatch).toMatchObject({
      lifecycleStatus: "rework",
      submittedAt: "",
      approvedBy: "",
      approvedAt: "",
      auditStatus: "not_requested",
      managerDecision: "pending",
    });
  });

  it("does not invalidate approval when the dependency set is unchanged", () => {
    const decision = decideDependencyEdit(plan(), ["old-dependency"]);

    expect(decision).toEqual({ allowed: true, lifecyclePatch: {} });
  });

  it("rejects dependency changes after development has started", () => {
    const decision = decideDependencyEdit(plan({ lifecycleStatus: "in_progress", status: "进行中", progress: 10 }), []);

    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain("已开工计划");
  });

  it("allows hierarchy-only plans to change dependencies without a delivery transition", () => {
    const decision = decideDependencyEdit(plan({ kind: "milestone", lifecycleStatus: "legacy" }), []);

    expect(decision).toEqual({ allowed: true, lifecyclePatch: {} });
  });
});
