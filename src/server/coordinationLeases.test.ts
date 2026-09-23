import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { claimAgentTask, heartbeatAgentTask } from "./agentTaskLeases.js";
import { buildAgentOrchestration } from "./orchestration.js";
import {
  advanceCoordinationStage,
  assertCoordinationLeaseForPlan,
  claimCoordinationLease,
  claimDispatchedChildTask,
  dispatchChildTask,
  listCoordinationLeases,
  listChildTaskDispatches,
  pauseCoordinationLease,
  reassignChildTask,
  releaseCoordinationLease,
  resumeCoordinationLease,
} from "./coordinationLeases.js";

const fixtures: Array<{ store: Store; dir: string }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) { fixture.store.close(); rmSync(fixture.dir, { recursive: true, force: true }); }
});

const roleAssignments = {
  designer: { agentId: "designer-id", displayName: "Designer" },
  builder: { agentId: "builder-id", displayName: "Builder" },
  auditor: { agentId: "auditor-id", displayName: "Auditor" },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-coordination-"));
  const store = new Store(join(dir, "test.db"));
  fixtures.push({ store, dir });
  const project = store.insertProject({ code: "COORD", name: "中央调度", summary: "", stage: "设计", health: "正常", progress: 0,
    riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir, startAt: "", dueAt: "" });
  const diagram = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, {
    id: "coord-node", kind: "feature", label: "协调任务", description: "", owner: "", acceptanceCriteria: "形成设计",
    requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 400, y: 200,
  }] });
  const plan = store.insertPlan({
    projectId: project.id, diagramId: diagram.id, diagramNodeId: "coord-node", parentId: null, kind: "task",
    title: "协调计划", description: "", status: "未开始", priority: "P1", progress: 0, owner: "designer",
    versionTag: "", startAt: "", dueAt: "", dependencyIds: [], lifecycleStatus: "draft", roleAssignments,
  });
  return { store, projectId: project.id, planId: plan.id };
}

describe("Main Agent coordination lease", () => {
  it("resumes implementation rework at the builder stage without skipping design rework", () => {
    const { store, projectId, planId } = fixture();
    store.updatePlan(planId, { lifecycleStatus: "rework", managerDecision: "rejected", rejectionReason: "真实验收未闭环" });
    const implementation = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "implementation-rework", idempotencyKey: "coord-implementation-rework",
    });
    expect(implementation.stage).toBe("implementation");
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: implementation.id, leaseToken: implementation.leaseToken, mainAgentId: "Main Agent" });

    store.updatePlan(planId, { lifecycleStatus: "rework", managerDecision: "pending", auditStatus: "failed" });
    const auditRework = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "audit-rework", idempotencyKey: "coord-audit-rework",
    });
    expect(auditRework.stage).toBe("design");
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: auditRework.id, leaseToken: auditRework.leaseToken, mainAgentId: "Main Agent" });

    store.updatePlan(planId, { lifecycleStatus: "audit_failed", managerDecision: "pending", auditStatus: "failed" });
    const implementationAuditRework = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "implementation-audit-rework", idempotencyKey: "coord-implementation-audit-rework",
    });
    expect(implementationAuditRework.stage).toBe("implementation");
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: implementationAuditRework.id, leaseToken: implementationAuditRework.leaseToken, mainAgentId: "Main Agent" });

    store.updatePlan(planId, { lifecycleStatus: "rework", managerDecision: "pending", auditStatus: "not_requested" });
    const design = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "design-rework", idempotencyKey: "coord-design-rework",
    });
    expect(design.stage).toBe("design");
  });

  it("dispatches and claims the exact Designer task after a failed design audit", () => {
    const { store, projectId, planId } = fixture();
    store.updatePlan(planId, { lifecycleStatus: "rework", managerDecision: "pending", auditStatus: "failed" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.planItemId === planId && item.actionCode === "submit_plan")!;
    expect(task).toBeDefined();
    const parent = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "main-design-rework", idempotencyKey: "coord-failed-design-audit",
    });
    expect(parent.stage).toBe("design");
    const dispatchInput = {
      projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent",
      taskId: task.id, taskKey: task.taskKey,
    };
    expect(() => dispatchChildTask(store, { ...dispatchInput, role: "builder" }))
      .toThrow(expect.objectContaining({ code: "STAGE_ACTION_FORBIDDEN" }));
    const dispatch = dispatchChildTask(store, { ...dispatchInput, role: "designer" });
    expect(() => dispatchChildTask(store, { ...dispatchInput, role: "designer" }))
      .toThrow(expect.objectContaining({ code: "CHILD_TASK_ALREADY_DISPATCHED" }));
    const child = JSON.parse(claimDispatchedChildTask(store, {
      projectId, dispatchId: dispatch.dispatchId, agentId: dispatch.agentId, workerId: dispatch.workerId,
      idempotencyKey: "child-failed-design-audit",
    }));
    expect(child.task).toMatchObject({ id: task.id, projectId, planItemId: planId, role: "designer", actionCode: "submit_plan" });
    expect(child.lease).toMatchObject({ taskKey: task.taskKey, taskRevision: task.taskRevision, status: "claimed" });
    expect(child.lease.leaseToken).toBeTruthy();
    expect(Date.parse(child.lease.leaseExpiresAt)).toBeGreaterThan(Date.now());
    expect(listChildTaskDispatches(store, projectId, parent.id)).toMatchObject([
      { dispatchId: dispatch.dispatchId, status: "claimed", childWorkOrderId: child.lease.workOrderId },
    ]);
  });

  it("binds the parent lease to one plan and rejects an exact task from another plan", () => {
    const { store, projectId, planId } = fixture();
    const project = store.getProject(projectId)!;
    const diagram = store.listDiagrams(projectId).find((item) => item.type === "main")!;
    store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, {
      id: "coord-node-2", kind: "feature", label: "另一个协调任务", description: "", owner: "",
      acceptanceCriteria: "形成设计", requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发",
      acceptanceStatus: "未验收", x: 600, y: 200,
    }] });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: diagram.id, diagramNodeId: "coord-node", parentId: null, kind: "task",
      title: "目标计划", description: "", status: "未开始", priority: "P1", progress: 0, owner: "designer",
      versionTag: "", startAt: "", dueAt: "", dependencyIds: [], roleAssignments,
      lifecycleStatus: "draft",
    });
    const otherPlan = store.insertPlan({ ...plan, id: undefined, diagramNodeId: "coord-node-2", title: "其他计划" });
    const parent = claimCoordinationLease(store, {
      projectId, planId: plan.id, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-plan-bound",
    });
    expect(parent.planId).toBe(plan.id);
    const otherTask = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.planItemId === otherPlan.id)!;
    expect(() => dispatchChildTask(store, {
      projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent",
      taskId: otherTask.id, role: "designer",
    })).toThrow(expect.objectContaining({ code: "COORDINATION_PLAN_MISMATCH" }));
    expect(() => assertCoordinationLeaseForPlan(store, {
      projectId, planId: otherPlan.id, coordinationLeaseId: parent.id, coordinationLeaseToken: parent.leaseToken, mainAgentId: "Main Agent",
    })).toThrow(expect.objectContaining({ code: "COORDINATION_PLAN_MISMATCH" }));
    expect(() => assertCoordinationLeaseForPlan(store, {
      projectId, planId: plan.id, coordinationLeaseId: parent.id, coordinationLeaseToken: "stale-token", mainAgentId: "Main Agent",
    })).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
  });

  it("requires an exact dispatch and keeps child token out of Main Agent projections", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-claim" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.nodeId === "coord-node" && item.planItemId === planId)!;
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, role: "designer" });
    expect(dispatch).not.toHaveProperty("leaseToken");
    expect(() => claimAgentTask(store, { projectId, taskId: task.id, role: "designer", agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "bypass" })).toThrow(/Main Agent/);
    const rawPackage = claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId, agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "child-claim" });
    const childPackage = JSON.parse(rawPackage) as { lease: { leaseToken: string }; task: { id: string } };
    expect(childPackage.task.id).toBe(task.id);
    expect(childPackage.lease.leaseToken).toBeTruthy();
    expect(listChildTaskDispatches(store, projectId)[0].status).toBe("claimed");
    const prompt = buildAgentOrchestration(store, projectId, true)!.bootstrapPrompt;
    expect(prompt).toContain("dispatch_child_task");
    expect(prompt).toContain("禁止调用 claim_next_agent_task");
  });

  it("does not replay a terminal parent lease from the idempotency cache", () => {
    const { store, projectId, planId } = fixture();
    const input = { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-replay" };
    const parent = claimCoordinationLease(store, input);
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
    expect(() => claimCoordinationLease(store, input)).toThrow(/不能重放/);
  });

  it("rejects an unclaimable child identity before persisting a dispatch", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-identity" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.nodeId === "coord-node" && item.planItemId === planId)!;
    expect(() => dispatchChildTask(store, {
      projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent",
      taskId: task.id, role: "designer", agentId: "wrong-designer", workerId: "wrong-worker",
    })).toThrow(/任务已分配/);
    expect(listChildTaskDispatches(store, projectId)).toHaveLength(0);
  });

  it("expires a parent and reclaims children when its Runner heartbeat is stale", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-stale-parent" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.nodeId === "coord-node" && item.planItemId === planId)!;
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, role: "designer" });
    const rawPackage = claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId, agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "child-stale-parent" });
    const child = JSON.parse(rawPackage) as { lease: { leaseToken: string }; worker: { agentId: string } };
    store.db.prepare("UPDATE agent_runner_registrations SET status='stale', last_seen_at=?, updated_at=? WHERE project_id=? AND worker_id=?")
      .run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", projectId, parent.workerId);
    expect(listCoordinationLeases(store, projectId).find((lease) => lease.id === parent.id)?.status).toBe("expired");
    expect(listChildTaskDispatches(store, projectId).find((item) => item.dispatchId === dispatch.dispatchId)?.status).toBe("reclaimed");
    expect(() => heartbeatAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId, idempotencyKey: "stale-parent-heartbeat" })).toThrow(/父协调租约/);
  });

  it("cascades pause/reclaim and advances only after a child completion", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-claim-2" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.nodeId === "coord-node" && item.planItemId === planId)!;
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, role: "designer" });
    const rawPackage = claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId, agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "child-claim-2" });
    const child = JSON.parse(rawPackage) as { lease: { leaseToken: string }; worker: { agentId: string } };
    pauseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
    expect(() => heartbeatAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId, idempotencyKey: "stale-child" })).toThrow(/父协调租约/);
    resumeCoordinationLease(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
    expect(() => advanceCoordinationStage(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", stage: "design_audit" })).toThrow(/子任务/);
    expect(listChildTaskDispatches(store, projectId)[0].status).toBe("reclaimed");
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
  });

  it("allows a reassigned worker to claim without an explicit session id", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent", workerId: "main-runner", idempotencyKey: "coord-claim-reassign" });
    const task = buildAgentOrchestration(store, projectId, true)!.queues.design.find((item) => item.nodeId === "coord-node" && item.planItemId === planId)!;
    const first = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, role: "designer" });
    claimDispatchedChildTask(store, { projectId, dispatchId: first.dispatchId, agentId: first.agentId, workerId: first.workerId, idempotencyKey: "child-claim-reassign-1" });
    const reassigned = reassignChildTask(store, {
      projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent",
      dispatchId: first.dispatchId, taskId: "", role: "designer", agentId: first.agentId, workerId: "reassigned-worker",
    });
    const raw = claimDispatchedChildTask(store, { projectId, dispatchId: reassigned.dispatchId, agentId: reassigned.agentId, workerId: reassigned.workerId, idempotencyKey: "child-claim-reassign-2" });
    expect(JSON.parse(raw).lease.workerId).toBe("reassigned-worker");
  });
});
