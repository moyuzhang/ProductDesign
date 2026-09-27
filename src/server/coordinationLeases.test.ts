import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { claimAgentTask, completeAgentTask, heartbeatAgentTask, listClaimableAgentTasks } from "./agentTaskLeases.js";
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
  return { store, projectId: project.id, planId: plan.id, diagramId: diagram.id };
}

function noPlanFixture() {
  const context = fixture();
  context.store.deletePlan(context.planId);
  const task = listClaimableAgentTasks(context.store, context.projectId)
    .find((item) => item.queue === "design" && item.nodeId === "coord-node" && !item.planItemId)!;
  expect(task).toBeDefined();
  expect(task.available).toBe(true);
  return { ...context, task };
}

describe("Main Agent coordination lease", () => {
  it("binds only one exact claimable no-plan Designer task and exposes its target", () => {
    const { store, projectId, task } = noPlanFixture();
    const input = { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "task-parent", idempotencyKey: "task-parent-claim" };
    expect(() => claimCoordinationLease(store, { ...input, planId: "also-a-plan" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TARGET_INVALID" }));
    expect(() => claimCoordinationLease(store, { ...input, taskRevision: undefined }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TARGET_INVALID" }));
    expect(() => claimCoordinationLease(store, { ...input, taskKey: `${task.taskKey}-wrong` }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_REVISION_MISMATCH" }));
    expect(() => claimCoordinationLease(store, { ...input, taskRevision: "stale" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_REVISION_MISMATCH" }));
    const otherProject = store.insertProject({ code: "COORD-OTHER", name: "另一个项目", summary: "", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
    expect(() => claimCoordinationLease(store, { ...input, projectId: otherProject.id }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_REVISION_MISMATCH" }));
    const parent = claimCoordinationLease(store, input);
    expect(parent).toMatchObject({ planId: "", taskKey: task.taskKey, taskRevision: task.taskRevision, stage: "design" });
    expect(claimCoordinationLease(store, input).id).toBe(parent.id);
    expect(() => claimCoordinationLease(store, { ...input, taskKey: "changed-target" }))
      .toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => claimCoordinationLease(store, { ...input, workerId: "competing-parent", idempotencyKey: "competing-claim" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_BUSY" }));
    expect(() => claimCoordinationLease(store, { ...input, idempotencyKey: "second-key", taskRevision: "stale" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TARGET_MISMATCH" }));
    expect(() => advanceCoordinationStage(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", stage: "design_audit" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_STAGE_FORBIDDEN" }));
    expect(() => assertCoordinationLeaseForPlan(store, { projectId, planId: "any-plan", coordinationLeaseId: parent.id,
      coordinationLeaseToken: parent.leaseToken, mainAgentId: "Main Agent" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_PLAN_MISMATCH" }));
  });

  it("cannot bind a plan-backed Designer task through the task target contract", () => {
    const { store, projectId, planId } = fixture();
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.planItemId === planId && item.queue === "design")!;
    expect(task).toBeDefined();
    expect(() => claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "spoofed-task-parent", idempotencyKey: "spoofed-task-parent" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_INVALID" }));
    expect(listCoordinationLeases(store, projectId)).toHaveLength(0);
  });

  it("dispatches the exact no-plan task once and revokes its child on parent release", () => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "task-parent", idempotencyKey: "no-plan-dispatch" });
    const input = { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken,
      mainAgentId: "Main Agent", taskId: task.id, taskKey: task.taskKey, role: "designer" as const };
    expect(() => dispatchChildTask(store, { ...input, taskKey: undefined }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_MISMATCH" }));
    expect(() => dispatchChildTask(store, { ...input, taskKey: "wrong" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_MISMATCH" }));
    expect(() => dispatchChildTask(store, { ...input, role: "builder" }))
      .toThrow(expect.objectContaining({ code: "STAGE_ACTION_FORBIDDEN" }));
    expect(() => dispatchChildTask(store, { ...input, agentId: "wrong-designer" }))
      .toThrow(expect.objectContaining({ code: "ASSIGNEE_MISMATCH" }));
    expect(() => dispatchChildTask(store, { ...input, poolId: "wrong-pool" }))
      .toThrow(expect.objectContaining({ code: "WORKER_POOL_MISMATCH" }));
    const dispatch = dispatchChildTask(store, input);
    expect(() => dispatchChildTask(store, input))
      .toThrow(expect.objectContaining({ code: "CHILD_TASK_ALREADY_DISPATCHED" }));
    const child = JSON.parse(claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId,
      agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "child-no-plan" }));
    expect(child.task).toMatchObject({ planItemId: null, deliveryTrack: "design" });
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
    expect(listChildTaskDispatches(store, projectId)[0].status).toBe("reclaimed");
    expect(() => heartbeatAgentTask(store, { leaseToken: child.lease.leaseToken,
      agentId: child.worker.agentId, idempotencyKey: "child-after-parent-release" })).toThrow();
    expect(() => claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "task-parent", idempotencyKey: "no-plan-dispatch" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
    const nextParent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "new-task-parent", idempotencyKey: "no-plan-dispatch-retry" });
    expect(nextParent.id).not.toBe(parent.id);
  });

  it("rejects dispatch after a no-plan task revision changes without leaving a child", () => {
    const { store, projectId, diagramId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "revision-parent", idempotencyKey: "revision-parent-claim" });
    const diagram = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, { nodes: diagram.nodes.map((node) => node.id === "coord-node"
      ? { ...node, description: "changed but still lacks owner" } : node) });
    const changed = listClaimableAgentTasks(store, projectId).find((item) => item.id === task.id)!;
    expect(changed.taskRevision).not.toBe(task.taskRevision);
    expect(() => dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_MISMATCH" }));
    expect(listChildTaskDispatches(store, projectId)).toHaveLength(0);
    releaseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent" });
    expect(() => claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "revision-parent-new", idempotencyKey: "revision-parent-new" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_TASK_REVISION_MISMATCH" }));
  });

  it("releases a task-bound parent atomically when its exact design child completes", () => {
    const { store, projectId, diagramId, task } = noPlanFixture();
    expect(task.actionCode).toBe("complete_node_definition");
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "completion-parent", idempotencyKey: "completion-parent-claim" });
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, taskKey: task.taskKey, role: "designer" });
    const child = JSON.parse(claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId,
      agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "completion-child-claim" }));
    const diagram = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, { nodes: diagram.nodes.map((node) => node.id === "coord-node"
      ? { ...node, description: "完成节点边界", owner: "designer" } : node) });
    expect(completeAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId,
      idempotencyKey: "completion-child-complete", resultDigest: "defined" }).status).toBe("completed");
    expect(listChildTaskDispatches(store, projectId)[0].status).toBe("completed");
    expect(listCoordinationLeases(store, projectId).find((lease) => lease.id === parent.id)?.status).toBe("released");
    expect(releaseCoordinationLease(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent" }).status).toBe("released");
    expect(() => advanceCoordinationStage(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", stage: "design_audit" }))
      .toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
  });
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
    const claimable = listClaimableAgentTasks(store, projectId).find((item) => item.id === task.id)!;
    expect(claimable.available).toBe(true);
    const parent = claimCoordinationLease(store, {
      projectId, planId, mainAgentId: "Main Agent", workerId: "main-design-rework", idempotencyKey: "coord-failed-design-audit",
    });
    expect(parent.stage).toBe("design");
    const dispatchInput = {
      projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent",
      taskId: task.id, taskKey: claimable.taskKey,
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
    expect(child.lease).toMatchObject({ taskKey: claimable.taskKey, taskRevision: claimable.taskRevision, status: "claimed" });
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
