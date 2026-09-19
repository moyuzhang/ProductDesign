import { describe, expect, it } from "vitest";
import type { PlanItem } from "../shared/types.js";
import { analyzePlanLayers } from "./planLayers.js";

function plan(id: string, dependencyIds: string[] = [], patch: Partial<PlanItem> = {}): PlanItem {
  return {
    id, projectId: "project", diagramId: "diagram", diagramNodeId: `node-${id}`, parentId: null,
    kind: "task", title: id, description: "", status: "未开始", priority: "P1", progress: 0,
    owner: "builder", roleAssignments: {
      designer: { agentId: "designer", displayName: "designer" },
      builder: { agentId: "builder", displayName: "builder" },
      auditor: { agentId: "auditor", displayName: "auditor" },
    },
    versionTag: "", startAt: "", dueAt: "", dependencyIds, blockedReason: "", completedAt: "",
    lifecycleStatus: "draft", proposalRevision: 0, proposedBy: "", submittedAt: "", approvedBy: "",
    approvedAt: "", rejectedBy: "", rejectedAt: "", rejectionReason: "", implementationRevision: "",
    completedBy: "", auditStatus: "not_requested", auditedBy: "", auditedAt: "", managerDecision: "pending",
    managerDecisionBy: "", managerDecisionAt: "", reworkOfPlanId: null, correlationId: id,
    createdAt: `2026-08-30T00:00:0${id.length}.000Z`, updatedAt: "2026-08-30T00:00:00.000Z",
    ...patch,
  };
}

describe("plan delivery layers", () => {
  it("unlocks a task when its own dependencies are accepted without waiting for unrelated work", () => {
    const first = plan("first", [], { lifecycleStatus: "accepted", status: "已完成" });
    const sibling = plan("sibling");
    const dependent = plan("dependent", [first.id], { priority: "P0" });

    const gate = analyzePlanLayers([first, sibling, dependent]);
    expect(gate).toMatchObject({ activeLayer: 1, totalLayers: 2, activePlanCount: 2, lockedPlanCount: 0 });
    expect(gate.plans.find((item) => item.planId === sibling.id)).toMatchObject({ layer: 1, locked: false });
    expect(gate.plans.find((item) => item.planId === dependent.id)).toMatchObject({ layer: 2, locked: false });

    const unlocked = analyzePlanLayers([first, { ...sibling, lifecycleStatus: "accepted", status: "已完成" }, dependent]);
    expect(unlocked.activeLayer).toBe(2);
    expect(unlocked.plans.find((item) => item.planId === dependent.id)).toMatchObject({ locked: false });
  });

  it("does not treat development complete or audit passed as layer completion", () => {
    for (const lifecycleStatus of ["pending_audit", "pending_manager", "audit_failed", "rework"] as const) {
      const gate = analyzePlanLayers([
        plan("first", [], { lifecycleStatus, status: "已完成" }),
        plan("second", ["first"]),
      ]);
      expect(gate.activeLayer).toBe(1);
      expect(gate.plans.find((item) => item.planId === "second")?.locked).toBe(true);
    }
  });

  it("accepts completed legacy work as a closed layer", () => {
    const gate = analyzePlanLayers([
      plan("legacy", [], { lifecycleStatus: "legacy", status: "已完成" }),
      plan("next", ["legacy"]),
    ]);
    expect(gate.activeLayer).toBe(2);
    expect(gate.plans.find((item) => item.planId === "next")?.locked).toBe(false);
  });

  it("treats a parent task as an aggregate that runs after its sequential child tasks", () => {
    const parent = plan("parent", [], { lifecycleStatus: "approved" });
    const first = plan("first", [], { parentId: parent.id, lifecycleStatus: "accepted", status: "已完成" });
    const second = plan("second", [first.id], { parentId: parent.id });

    const gate = analyzePlanLayers([parent, first, second]);
    expect(gate).toMatchObject({ activeLayer: 2, totalLayers: 3, activePlanCount: 2, lockedPlanCount: 0 });
    expect(gate.plans.find((item) => item.planId === first.id)).toMatchObject({ layer: 1, complete: true, locked: false });
    expect(gate.plans.find((item) => item.planId === second.id)).toMatchObject({ layer: 2, complete: false, locked: false });
    expect(gate.plans.find((item) => item.planId === parent.id)).toMatchObject({ layer: 3, complete: false, locked: false });

    const completed = analyzePlanLayers([parent, first, { ...second, lifecycleStatus: "accepted", status: "已完成" }]);
    expect(completed.activeLayer).toBe(3);
    expect(completed.plans.find((item) => item.planId === parent.id)).toMatchObject({ locked: false });
  });

  it("blocks an invalid cyclic dependency graph", () => {
    const gate = analyzePlanLayers([plan("a", ["b"]), plan("b", ["a"])]);
    expect(gate.activeLayer).toBeNull();
    expect(gate.issues[0]).toContain("循环");
    expect(gate.plans.every((item) => item.locked)).toBe(true);
  });
});
