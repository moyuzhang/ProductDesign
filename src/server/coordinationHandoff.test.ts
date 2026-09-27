import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { safeCoordinationHandoff } from "./coordinationHandoff.js";
import { listClaimableAgentTasks } from "./agentTaskLeases.js";

const fixtures: Array<{ store: Store; dir: string }> = [];
afterEach(() => { for (const { store, dir } of fixtures.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });

describe("safe coordination Web handoff", () => {
  it("serializes only allowlisted plan and task fields and rejects stale task revisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-handoff-"));
    const store = new Store(join(dir, "test.db"));
    fixtures.push({ store, dir });
    const project = store.insertProject({ code: "HANDOFF", name: "交接项目", summary: "SECRET_SUMMARY", stage: "设计",
      health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
      repositoryPath: dir, startAt: "", dueAt: "" });
    const diagram = store.listDiagrams(project.id).find((item) => item.type === "main")!;
    store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, { id: "handoff-node", kind: "feature",
      label: "交接节点", description: "", owner: "", acceptanceCriteria: "形成设计", requirementStatus: "已批准",
      designStatus: "进行中", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 300, y: 200 }] });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.nodeId === "handoff-node" && !item.planItemId)!;
    expect(task.available).toBe(true);
    const serialized = safeCoordinationHandoff(store, project.id, { taskId: task.id,
      expectedTaskKey: task.taskKey, expectedTaskRevision: task.taskRevision });
    const parsed = JSON.parse(serialized);
    expect(Object.keys(parsed)).toEqual(["schemaVersion", "generatedAt", "project", "binding", "target", "task"]);
    expect(parsed.binding).toEqual({ type: "task", taskId: task.id, taskKey: task.taskKey, taskRevision: task.taskRevision });
    expect(serialized).not.toContain("SECRET_SUMMARY");
    expect(serialized).not.toMatch(/leaseToken|coordinationLeaseId|dispatchId|workOrderId|authSessionToken|policyAckToken|sessionId|runId/);
    expect(() => safeCoordinationHandoff(store, project.id, { taskId: task.id, expectedTaskRevision: "stale" }))
      .toThrow(expect.objectContaining({ code: "HANDOFF_TARGET_STALE" }));
    const plan = store.insertPlan({ projectId: project.id, diagramId: diagram.id, diagramNodeId: "handoff-node",
      parentId: null, kind: "task", title: "计划交接", description: "SECRET_DESCRIPTION", status: "未开始",
      priority: "P1", progress: 0, owner: "designer", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], lifecycleStatus: "draft" });
    const planHandoff = JSON.parse(safeCoordinationHandoff(store, project.id, { planId: plan.id,
      expectedProposalRevision: plan.proposalRevision }));
    expect(planHandoff.binding).toEqual({ type: "plan", planId: plan.id, proposalRevision: plan.proposalRevision });
    expect(JSON.stringify(planHandoff)).not.toContain("SECRET_DESCRIPTION");
    expect(() => safeCoordinationHandoff(store, project.id, { planId: plan.id, expectedProposalRevision: plan.proposalRevision + 1 }))
      .toThrow(expect.objectContaining({ code: "HANDOFF_TARGET_STALE" }));
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_coordination_leases'").get()).toBeUndefined();
  });
});
