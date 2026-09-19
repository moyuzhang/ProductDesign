import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import {
  AgentTaskLeaseError,
  assertAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForWrite,
  claimAgentTask,
  completeAgentTask,
  failAgentTask,
  heartbeatAgentTask,
  listAgentTaskLeases,
  listAgentRunners,
  listClaimableAgentTasks,
  releaseAgentTask,
  releaseAgentTaskByWorkOrder,
  startAgentTask,
  taskPackageLease,
  updateAgentTaskCapacity,
} from "./agentTaskLeases.js";
import { buildAgentTaskPackage } from "./orchestration.js";

const resources: Array<{ store: Store; dir: string }> = [];
const assignments = {
  designer: { agentId: "designer-id", displayName: "Designer" },
  builder: { agentId: "builder-id", displayName: "Builder" },
  auditor: { agentId: "auditor-id", displayName: "Auditor" },
};

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { store: Store; projectId: string; planIds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "pcs-agent-lease-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "LEASE", name: "租约测试", summary: "防止重复施工", stage: "开发", health: "正常",
    progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodes = ["lease-a", "lease-b"].map((id, index) => ({
    id, kind: "feature" as const, label: `施工任务 ${index + 1}`, description: "租约测试", owner: "team",
    acceptanceCriteria: "同一任务只有一个活跃租约", requirementStatus: "已批准" as const,
    designStatus: "已批准" as const, developmentStatus: "未开发" as const,
    acceptanceStatus: "未验收" as const, x: 600 + index * 260, y: 160,
  }));
  store.updateDiagram(main.id, { nodes: [...main.nodes, ...nodes] });
  const planIds = nodes.map((node, index) => store.insertPlan({
    projectId: project.id, diagramId: main.id, diagramNodeId: node.id, parentId: null,
    kind: "task", title: `实现租约 ${index + 1}`, description: "", status: "未开始",
    priority: index === 0 ? "P0" : "P1", progress: 0, owner: "Builder", versionTag: "v1",
    startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    lifecycleStatus: "approved", proposedBy: "Designer", submittedAt: "2026-08-30T01:00:00.000Z",
    approvedBy: "Manager", approvedAt: "2026-08-30T01:05:00.000Z", roleAssignments: {
      ...assignments,
      builder: { agentId: "builder-id", displayName: "Builder Pool", poolId: "pool-builders" },
    },
  }).id);
  return { store, projectId: project.id, planIds };
}

function unplannedDesignFixture(count = 1): {
  store: Store;
  projectId: string;
  diagramId: string;
  nodeIds: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "pcs-preplan-design-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: `PREPLAN-${count}`, name: "无计划设计任务", summary: "确定性派发", stage: "设计", health: "正常",
    progress: 0, riskLevel: "P0", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const brief = store.insertDesignDoc({
    projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
    version: "1.0", author: "manager", content: "恢复无计划设计任务治理路径",
  });
  store.insertDocumentReference({
    projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodeIds = Array.from({ length: count }, (_, index) => `whiteboard-design-${index + 1}`);
  store.updateDiagram(main.id, {
    nodes: [...main.nodes, ...nodeIds.map((id, index) => ({
      id, kind: "feature" as const, label: `白板设计 ${index + 1}`, description: "补充详细设计",
      owner: "designer", acceptanceCriteria: "形成已批准文档与开发计划",
      requirementStatus: "已批准" as const, designStatus: "进行中" as const,
      developmentStatus: "未开发" as const, acceptanceStatus: "未验收" as const,
      x: 600 + index * 220, y: 160,
    }))],
  });
  return { store, projectId: project.id, diagramId: main.id, nodeIds };
}

function claim(store: Store, projectId: string, idempotencyKey: string, taskId?: string, agentId = "builder-id", sessionId = idempotencyKey, workerId = idempotencyKey) {
  return claimAgentTask(store, {
    projectId, taskId, role: "builder", agentId, workerId, poolId: "pool-builders",
    sessionId, runId: idempotencyKey, leaseSeconds: 60, idempotencyKey,
  });
}

describe("agent task leases", () => {
  it("derives one effective Designer assignment for list, claim, package, and lease controls", () => {
    const { store, projectId, diagramId, nodeIds } = unplannedDesignFixture();
    const [nodeId] = nodeIds;
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.nodeId === nodeId)!;
    const expectedAgentId = task.assignee!.agentId;
    const expectedPoolId = `pool:${projectId}:designer:${expectedAgentId}`;
    expect(expectedAgentId).toMatch(new RegExp(`^design-node-${nodeId}-[0-9a-f]{16}$`));

    expect(task).toMatchObject({
      id: `design:${nodeId}`,
      queue: "design",
      diagramId,
      nodeId,
      planItemId: null,
      requiredRole: "designer",
      taskRevision: "0",
      available: true,
      availabilityReason: "可领取",
      assignee: { agentId: expectedAgentId, displayName: "白板设计 1 Designer", poolId: expectedPoolId },
      poolId: expectedPoolId,
    });
    expect(task.taskKey).toContain(`:${encodeURIComponent(`design:${nodeId}`)}:0`);

    const packageBeforeClaim = buildAgentTaskPackage(store, projectId, { queue: "design", taskId: task.id });
    expect(packageBeforeClaim).toMatchObject({
      assignment: task.assignee,
      planSnapshot: null,
      node: { diagramId, nodeId, label: "白板设计 1" },
      dependencies: [],
    });

    for (const [role, code] of [["builder", "ROLE_MISMATCH"], ["auditor", "ROLE_MISMATCH"]] as const) {
      try {
        claimAgentTask(store, {
          projectId, taskId: task.id, role, agentId: expectedAgentId, workerId: `wrong-${role}`,
          poolId: expectedPoolId, idempotencyKey: `wrong-role-${role}`,
        });
        throw new Error("expected role mismatch");
      } catch (cause) {
        expect(cause).toMatchObject({ code });
      }
    }
    expect(() => claimAgentTask(store, {
      projectId, taskId: task.id, role: "designer", agentId: "wrong-designer", workerId: "wrong-agent",
      poolId: expectedPoolId, idempotencyKey: "wrong-agent",
    })).toThrowError(/任务已分配给/);
    expect(() => claimAgentTask(store, {
      projectId, taskId: task.id, role: "designer", agentId: expectedAgentId, workerId: "wrong-pool",
      poolId: "wrong-pool", idempotencyKey: "wrong-pool",
    })).toThrowError(/Worker 池/);

    const claimInput = {
      projectId, taskId: task.id, role: "designer" as const, agentId: expectedAgentId,
      workerId: "preplan-worker", poolId: expectedPoolId, sessionId: "preplan-session",
      runId: "preplan-run", leaseSeconds: 60, idempotencyKey: "preplan-claim",
    };
    const lease = claimAgentTask(store, claimInput);
    expect(claimAgentTask(store, claimInput).leaseToken).toBe(lease.leaseToken);
    expect(lease).toMatchObject({
      taskId: task.id, taskKey: task.taskKey, taskRevision: "0", agentId: expectedAgentId,
      poolId: expectedPoolId, attempt: 1, status: "claimed",
    });
    expect(() => claimAgentTask(store, { ...claimInput, workerId: "changed-worker" }))
      .toThrowError(/idempotencyKey/);

    expect(startAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: expectedAgentId, idempotencyKey: "preplan-start",
    }).status).toBe("running");
    expect(heartbeatAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: expectedAgentId, leaseSeconds: 60, idempotencyKey: "preplan-heartbeat",
    }).status).toBe("running");
    expect(releaseAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: expectedAgentId, idempotencyKey: "preplan-release",
    }).status).toBe("released");

    const reopened = listClaimableAgentTasks(store, projectId).find((item) => item.id === task.id)!;
    expect(reopened).toMatchObject({ available: true, assignee: task.assignee, poolId: expectedPoolId, attempt: 1 });
    const reclaimed = claimAgentTask(store, {
      ...claimInput, workerId: "preplan-worker-2", sessionId: "preplan-session-2",
      runId: "preplan-run-2", idempotencyKey: "preplan-reclaim",
    });
    expect(reclaimed).toMatchObject({ agentId: expectedAgentId, poolId: expectedPoolId, attempt: 2 });
  });

  it("lets the human lease manager release by work order without returning a lease token", () => {
    const { store, projectId, planIds } = fixture();
    const lease = claim(store, projectId, "manual-release-claim", `development:${planIds[0]}`);
    const released = releaseAgentTaskByWorkOrder(store, {
      projectId, workOrderId: lease.workOrderId, reason: "Runner 已停止，回收卡住的租约",
    });
    expect(released).toMatchObject({ workOrderId: lease.workOrderId, status: "released", agentId: "builder-id" });
    expect(released).not.toHaveProperty("leaseToken");
    expect(store.listAuditPage({ projectId, action: "release", entityType: "agentTaskLease", limit: 10 }).items[0].after)
      .toMatchObject({ reason: "Runner 已停止，回收卡住的租约" });
    expect(() => releaseAgentTaskByWorkOrder(store, { projectId, workOrderId: lease.workOrderId, reason: "重复释放" }))
      .toThrowError(expect.objectContaining({ code: "LEASE_NOT_ACTIVE" }));
    expect(() => releaseAgentTaskByWorkOrder(store, { projectId: "other-project", workOrderId: lease.workOrderId, reason: "越界" }))
      .toThrowError(expect.objectContaining({ code: "LEASE_NOT_FOUND" }));
  });

  it("claim_next selects the available no-plan design task matching the caller identity and pool", () => {
    const { store, projectId, nodeIds } = unplannedDesignFixture(2);
    const tasks = listClaimableAgentTasks(store, projectId).filter((item) => nodeIds.includes(item.nodeId ?? ""));
    expect(tasks).toHaveLength(2);
    const second = tasks.find((item) => item.nodeId === nodeIds[1])!;
    const lease = claimAgentTask(store, {
      projectId, role: "designer", agentId: second.assignee!.agentId,
      workerId: "second-candidate-worker", poolId: second.poolId,
      sessionId: "second-candidate-session", runId: "second-candidate-run",
      idempotencyKey: "second-candidate-claim", leaseSeconds: 60,
    });
    expect(lease).toMatchObject({
      taskId: second.id,
      taskKey: second.taskKey,
      agentId: second.assignee!.agentId,
      poolId: second.poolId,
    });
  });

  it("keeps identities and task keys stable while disambiguating the same node id across canvases", () => {
    const { store, projectId, diagramId, nodeIds } = unplannedDesignFixture();
    const nodeId = nodeIds[0];
    const duplicateNode = {
      id: nodeId, kind: "feature" as const, label: "跨画布同名节点", description: "验证四元组身份",
      owner: "designer", acceptanceCriteria: "跨画布不碰撞",
      requirementStatus: "已批准" as const, designStatus: "进行中" as const,
      developmentStatus: "未开发" as const, acceptanceStatus: "未验收" as const,
      x: 600, y: 160,
    };
    const child = store.insertDiagram({ projectId, title: "第二设计画布", type: "functional", nodes: [duplicateNode], edges: [] });
    const main = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, {
      nodes: main.nodes.map((node) => node.id === nodeId ? { ...node, linkDiagramIds: [child.id] } : node),
    });

    const firstRead = listClaimableAgentTasks(store, projectId).filter((item) => item.nodeId === nodeId);
    expect(firstRead).toHaveLength(2);
    expect(new Set(firstRead.map((task) => task.diagramId)).size).toBe(2);
    expect(new Set(firstRead.map((task) => task.id)).size).toBe(2);
    expect(new Set(firstRead.map((task) => task.taskKey)).size).toBe(2);
    expect(new Set(firstRead.map((task) => task.assignee!.agentId)).size).toBe(2);
    expect(new Set(firstRead.map((task) => task.poolId)).size).toBe(2);
    expect(firstRead.every((task) => task.id === `design:${task.diagramId}:${nodeId}`)).toBe(true);
    expect(firstRead.every((task) => task.assignee!.agentId.startsWith(`design-node-${nodeId}-`))).toBe(true);

    const secondRead = listClaimableAgentTasks(store, projectId).filter((item) => item.nodeId === nodeId);
    expect(secondRead.map((task) => ({ id: task.id, key: task.taskKey, agentId: task.assignee!.agentId, poolId: task.poolId })))
      .toEqual(firstRead.map((task) => ({ id: task.id, key: task.taskKey, agentId: task.assignee!.agentId, poolId: task.poolId })));
  });

  it("preserves a failed duplicate-node task key and backoff after its sibling leaves the design queue", () => {
    const { store, projectId, diagramId, nodeIds } = unplannedDesignFixture();
    const nodeId = nodeIds[0];
    const child = store.insertDiagram({
      projectId, title: "重复节点子画布", type: "functional", edges: [], nodes: [{
        id: nodeId, kind: "feature", label: "重复节点子任务", description: "子任务保持退避历史",
        owner: "designer", acceptanceCriteria: "失败后不可绕过退避",
        requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发",
        acceptanceStatus: "未验收", x: 600, y: 160,
      }],
    });
    const main = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, {
      nodes: main.nodes.map((node) => node.id === nodeId
        ? { ...node, designStatus: "已批准" as const, linkDiagramIds: [child.id] }
        : node),
    });
    const design = store.insertDesignDoc({
      projectId, category: "功能说明", title: "重复节点主任务设计", summary: "", status: "已批准",
      version: "1.0", author: "designer", content: "主任务设计已批准，可创建并提交开发计划。",
    });
    store.insertDocumentReference({
      projectId, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines",
    });

    const before = listClaimableAgentTasks(store, projectId).find((task) => task.diagramId === child.id && task.nodeId === nodeId)!;
    expect(before.id).toBe(`design:${child.id}:${nodeId}`);
    const lease = claimAgentTask(store, {
      projectId, taskId: before.id, role: "designer", agentId: before.assignee!.agentId,
      workerId: "stable-backoff-worker", poolId: before.poolId,
      sessionId: "stable-backoff-session", runId: "stable-backoff-run",
      idempotencyKey: "stable-backoff-claim", leaseSeconds: 60,
    });
    const failed = failAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: before.assignee!.agentId,
      error: "intentional retry", idempotencyKey: "stable-backoff-fail",
    });
    expect(failed).toMatchObject({ taskKey: before.taskKey, status: "failed", attempt: 1 });
    expect(failed.retryAvailableAt).not.toBe("");

    const plan = store.insertPlan({
      projectId, diagramId, diagramNodeId: nodeId, parentId: null, kind: "task",
      title: "重复节点主任务计划", description: "提交后主任务离开 design 队列", status: "未开始",
      priority: "P1", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "draft",
      proposedBy: "designer", roleAssignments: assignments,
    });
    transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "Designer", agentId: "designer-id" });
    expect(store.getPlan(plan.id)).toMatchObject({ lifecycleStatus: "pending_approval" });

    const afterTasks = listClaimableAgentTasks(store, projectId);
    expect(afterTasks.some((task) => task.diagramId === diagramId && task.nodeId === nodeId && task.queue === "design")).toBe(false);
    const after = afterTasks.find((task) => task.diagramId === child.id && task.nodeId === nodeId)!;
    expect(after).toMatchObject({
      id: before.id,
      taskKey: before.taskKey,
      taskRevision: before.taskRevision,
      attempt: 1,
      retryAvailableAt: failed.retryAvailableAt,
      available: false,
    });
    expect(after.availabilityReason).toContain("退避");
  });

  it("allows exactly one winner when two promises compete for the same task", async () => {
    const { store, projectId, nodeIds } = unplannedDesignFixture();
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.nodeId === nodeIds[0])!;
    const compete = (suffix: string) => new Promise<ReturnType<typeof claimAgentTask>>((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(claimAgentTask(store, {
            projectId, taskId: task.id, role: "designer", agentId: task.assignee!.agentId,
            workerId: `concurrent-worker-${suffix}`, poolId: task.poolId,
            sessionId: `concurrent-session-${suffix}`, runId: `concurrent-run-${suffix}`,
            idempotencyKey: `concurrent-claim-${suffix}`, leaseSeconds: 60,
          }));
        } catch (cause) {
          reject(cause);
        }
      });
    });
    const results = await Promise.allSettled([compete("a"), compete("b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
    expect(rejected.reason).toMatchObject({ code: "TASK_ALREADY_CLAIMED" });
    const leases = listAgentTaskLeases(store, projectId)
      .filter((lease) => lease.taskKey === task.taskKey && ["claimed", "running"].includes(lease.status));
    expect(leases).toHaveLength(1);
  });

  it("keeps the deterministic Designer assignment after failure and expiry", () => {
    for (const terminal of ["failed", "expired"] as const) {
      const { store, projectId, nodeIds } = unplannedDesignFixture();
      updateAgentTaskCapacity(store, projectId, { maxAttempts: 10, retryBackoffSeconds: 1 });
      const task = listClaimableAgentTasks(store, projectId).find((item) => item.nodeId === nodeIds[0])!;
      const agentId = task.assignee!.agentId;
      const first = claimAgentTask(store, {
        projectId, taskId: task.id, role: "designer", agentId, workerId: `${terminal}-worker-1`,
        poolId: task.poolId, sessionId: `${terminal}-session-1`,
        idempotencyKey: `${terminal}-claim-1`, leaseSeconds: 60,
      });
      if (terminal === "failed") {
        failAgentTask(store, {
          leaseToken: first.leaseToken, agentId, error: "retry", idempotencyKey: "preplan-fail",
        });
      } else {
        store.db.prepare("UPDATE agent_task_leases SET lease_expires_at=? WHERE lease_token=?")
          .run("2000-01-01T00:00:00.000Z", first.leaseToken);
        listAgentTaskLeases(store, projectId);
      }
      store.db.prepare("UPDATE agent_task_leases SET retry_available_at=? WHERE task_key=?")
        .run("2000-01-01T00:00:00.000Z", first.taskKey);
      const reopened = listClaimableAgentTasks(store, projectId).find((item) => item.id === task.id)!;
      expect(reopened).toMatchObject({ available: true, assignee: task.assignee, poolId: task.poolId });
      const second = claimAgentTask(store, {
        projectId, taskId: task.id, role: "designer", agentId, workerId: `${terminal}-worker-2`,
        poolId: task.poolId, sessionId: `${terminal}-session-2`,
        idempotencyKey: `${terminal}-claim-2`, leaseSeconds: 60,
      });
      expect(second).toMatchObject({ agentId, poolId: task.poolId, attempt: 2 });
    }
  });

  it("lets one worker serially claim five deterministic whiteboard design tasks", () => {
    const { store, projectId, nodeIds } = unplannedDesignFixture(5);
    const initial = listClaimableAgentTasks(store, projectId).filter((item) => nodeIds.includes(item.nodeId ?? ""));
    expect(initial).toHaveLength(5);
    expect(initial.every((task) => task.available && task.assignee?.agentId && task.poolId)).toBe(true);

    for (const [index, nodeId] of nodeIds.entries()) {
      const task = listClaimableAgentTasks(store, projectId).find((item) => item.nodeId === nodeId)!;
      const lease = claimAgentTask(store, {
        projectId, taskId: task.id, role: "designer", agentId: task.assignee!.agentId,
        workerId: "whiteboard-serial-worker", poolId: task.poolId,
        sessionId: "whiteboard-serial-session", runId: `whiteboard-${index}`,
        idempotencyKey: `whiteboard-claim-${index}`, leaseSeconds: 60,
      });
      startAgentTask(store, {
        leaseToken: lease.leaseToken, agentId: task.assignee!.agentId, idempotencyKey: `whiteboard-start-${index}`,
      });
      heartbeatAgentTask(store, {
        leaseToken: lease.leaseToken, agentId: task.assignee!.agentId, leaseSeconds: 60,
        idempotencyKey: `whiteboard-heartbeat-${index}`,
      });
      releaseAgentTask(store, {
        leaseToken: lease.leaseToken, agentId: task.assignee!.agentId, idempotencyKey: `whiteboard-release-${index}`,
      });
    }
    expect(listAgentTaskLeases(store, projectId).filter((lease) => lease.workerId === "whiteboard-serial-worker"))
      .toHaveLength(5);
  });

  it("defaults to a 30 minute lease and a five minute heartbeat", () => {
    const { store, projectId } = fixture();
    const claimedAt = Date.now();
    const lease = claimAgentTask(store, {
      projectId, role: "builder", agentId: "builder-id", workerId: "default-window",
      poolId: "pool-builders", sessionId: "default-window", runId: "default-window",
      capabilities: [], idempotencyKey: "default-window",
    });
    const claimedDuration = new Date(lease.leaseExpiresAt).getTime() - claimedAt;
    expect(claimedDuration).toBeGreaterThanOrEqual(1_799_000);
    expect(claimedDuration).toBeLessThanOrEqual(1_801_000);
    expect(taskPackageLease(lease).heartbeatSeconds).toBe(300);

    store.db.prepare("UPDATE agent_runner_registrations SET status='stale', last_seen_at='2000-01-01T00:00:00.000Z'").run();
    const heartbeatAt = Date.now();
    const renewed = heartbeatAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "default-heartbeat",
    });
    const renewedDuration = new Date(renewed.leaseExpiresAt).getTime() - heartbeatAt;
    expect(renewedDuration).toBeGreaterThanOrEqual(1_799_000);
    expect(renewedDuration).toBeLessThanOrEqual(1_801_000);
    expect(listAgentRunners(store, projectId)[0]?.status).toBe("online");
    expect(() => heartbeatAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", leaseSeconds: 1_801,
      idempotencyKey: "too-long-heartbeat",
    })).toThrowError(/15-1800/);
  });

  it("gives simultaneous workers different available tasks", () => {
    const { store, projectId } = fixture();
    const first = claim(store, projectId, "worker-1");
    const second = claim(store, projectId, "worker-2");

    expect(first.taskId).not.toBe(second.taskId);
    expect(first.status).toBe("claimed");
    expect(second.status).toBe("claimed");
    const tasks = listClaimableAgentTasks(store, projectId);
    expect(tasks.filter((task) => task.activeLease).map((task) => task.activeLease?.workerId)).toEqual(["worker-1", "worker-2"]);
    expect(first.poolId).toBe("pool-builders");
    expect(second.agentId).toBe("builder-id");
  });

  it("prevents one Agent or session from holding two active tasks", () => {
    const { store, projectId, planIds } = fixture();
    claim(store, projectId, "busy-first", `development:${planIds[0]}`, "builder-id", "shared-session");
    expect(() => claim(store, projectId, "busy-second", `development:${planIds[1]}`, "builder-id", "shared-session", "different-worker"))
      .toThrowError(/一次只能执行一个任务/);
  });

  it("enforces project capacity inside the atomic claim", () => {
    const { store, projectId, planIds } = fixture();
    updateAgentTaskCapacity(store, projectId, { maxActive: 1 });
    claim(store, projectId, "capacity-first", `development:${planIds[0]}`);
    try {
      claim(store, projectId, "capacity-second", `development:${planIds[1]}`);
      throw new Error("expected capacity guard");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentTaskLeaseError);
      expect((cause as AgentTaskLeaseError).code).toBe("AGENT_CAPACITY_FULL");
    }
  });

  it("stops retrying after the configured maximum attempts", () => {
    const { store, projectId, planIds } = fixture();
    updateAgentTaskCapacity(store, projectId, { maxAttempts: 2, retryBackoffSeconds: 1 });
    const taskId = `development:${planIds[0]}`;
    const first = claim(store, projectId, "attempt-1", taskId);
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", first.leaseToken);
    listAgentTaskLeases(store, projectId);
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at = ? WHERE task_key = ?")
      .run("2000-01-01T00:00:00.000Z", first.taskKey);
    const second = claim(store, projectId, "attempt-2", taskId);
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", second.leaseToken);
    listAgentTaskLeases(store, projectId);
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at = ? WHERE task_key = ?")
      .run("2000-01-01T00:00:00.000Z", second.taskKey);
    try {
      claim(store, projectId, "attempt-3", taskId);
      throw new Error("expected attempt guard");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentTaskLeaseError);
      expect((cause as AgentTaskLeaseError).code).toBe("TASK_ATTEMPTS_EXHAUSTED");
    }
  });

  it("prevents a second claim for the same task and makes retries idempotent", () => {
    const { store, projectId, planIds } = fixture();
    const taskId = `development:${planIds[0]}`;
    const first = claim(store, projectId, "same-request", taskId);
    const retry = claim(store, projectId, "same-request", taskId);
    expect(retry.leaseToken).toBe(first.leaseToken);

    try {
      claim(store, projectId, "different-worker", taskId);
      throw new Error("expected duplicate claim to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentTaskLeaseError);
      expect((cause as AgentTaskLeaseError).code).toBe("TASK_ALREADY_CLAIMED");
    }
    expect(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_workspace_reservations",
    ).get() as { count: number }).count)).toBe(1);
  });

  it("blocks overlapping resource scopes while allowing independent nodes", () => {
    const { store, projectId, planIds } = fixture();
    const firstPlan = store.getPlan(planIds[0])!;
    store.updatePlan(planIds[1], { diagramNodeId: firstPlan.diagramNodeId });
    const first = claim(store, projectId, "scope-worker-1", `development:${planIds[0]}`);
    expect(first.workScopes).toEqual([`node:${firstPlan.diagramId}:${firstPlan.diagramNodeId}`]);
    expect(() => claim(store, projectId, "scope-worker-2", `development:${planIds[1]}`))
      .toThrowError(/资源范围/);
  });

  it("keeps an approved aggregate parent out of the Builder queue while its draft child remains design-claimable", () => {
    const { store, projectId, planIds } = fixture();
    const parent = store.getPlan(planIds[0])!;
    const child = store.insertPlan({
      projectId, diagramId: parent.diagramId, diagramNodeId: parent.diagramNodeId, parentId: parent.id,
      kind: "task", title: "同节点子工单", description: "", status: "未开始", priority: "P1", progress: 0,
      owner: "Builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
      lifecycleStatus: "draft", roleAssignments: assignments,
    });
    const childTaskId = `design:${child.id}`;
    const tasks = listClaimableAgentTasks(store, projectId);
    expect(tasks.some((task) => task.id === `development:${parent.id}`)).toBe(false);
    expect(tasks.find((task) => task.id === childTaskId)).toMatchObject({
      available: true, availabilityReason: "可领取",
    });
  });

  it("requires isolated workspaces when multiple builders start concurrently", () => {
    const { store, projectId, planIds } = fixture();
    const first = claim(store, projectId, "workspace-worker-1", `development:${planIds[0]}`);
    const second = claim(store, projectId, "workspace-worker-2", `development:${planIds[1]}`);
    const projectRoot = store.getProject(projectId)!.repositoryPath;
    expect(startAgentTask(store, {
      leaseToken: first.leaseToken, agentId: "builder-id", idempotencyKey: "start-workspace-1",
      workspacePath: join(projectRoot, "worker-1"), workspaceBranch: "worker/1", baselineRevision: "base-1",
    }).status).toBe("running");
    expect(() => startAgentTask(store, {
      leaseToken: second.leaseToken, agentId: "builder-id", idempotencyKey: "start-workspace-shared",
      workspacePath: projectRoot,
    })).toThrowError(/共享 repositoryPath/);
    expect(startAgentTask(store, {
      leaseToken: second.leaseToken, agentId: "builder-id", idempotencyKey: "start-workspace-2",
      workspacePath: join(projectRoot, "worker-2"), workspaceBranch: "worker/2", baselineRevision: "base-2",
    }).workspacePath).toContain("worker-2");
  });

  it("releases resource locks and workspace reservations when a lease expires", () => {
    const { store, projectId, planIds } = fixture();
    const lease = claim(store, projectId, "expiry-worker", `development:${planIds[0]}`);
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks").get() as { count: number }).count).toBe(1);
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", lease.leaseToken);
    listAgentTaskLeases(store, projectId);
    expect((store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks").get() as { count: number }).count).toBe(0);
    expect((store.db.prepare("SELECT status FROM agent_task_workspace_reservations WHERE lease_token=?").get(lease.leaseToken) as { status: string }).status).toBe("expired");
  });

  it("allows takeover only after expiry and invalidates the old token", () => {
    const { store, projectId, planIds } = fixture();
    const taskId = `development:${planIds[0]}`;
    const first = claim(store, projectId, "initial", taskId);
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", first.leaseToken);
    listAgentTaskLeases(store, projectId);
    expect(listAgentTaskLeases(store, projectId)[0].status).toBe("expired");
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at = ? WHERE task_key = ?")
      .run("2000-01-01T00:00:00.000Z", first.taskKey);
    const takeover = claim(store, projectId, "takeover", taskId);
    expect(takeover.leaseToken).not.toBe(first.leaseToken);
    expect(takeover.attempt).toBe(2);
    expect(() => heartbeatAgentTask(store, {
      leaseToken: first.leaseToken, agentId: "builder-id", idempotencyKey: "old-heartbeat", leaseSeconds: 60,
    })).toThrowError(/租约不存在|租约已过期/);
  });

  it("preserves an expired workspace reservation when the same worker reclaims the same task", () => {
    const { store, projectId, planIds } = fixture();
    const taskId = `development:${planIds[0]}`;
    const first = claim(store, projectId, "same-worker-first", taskId, "builder-id", "same-worker-session", "same-worker");
    const initialReservationCount = Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_workspace_reservations",
    ).get() as { count: number }).count);

    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", first.leaseToken);
    listAgentTaskLeases(store, projectId);
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at = ? WHERE task_key = ?")
      .run("2000-01-01T00:00:00.000Z", first.taskKey);

    const reclaimed = claim(store, projectId, "same-worker-reclaim", taskId, "builder-id", "same-worker-session", "same-worker");
    const retry = claim(store, projectId, "same-worker-reclaim", taskId, "builder-id", "same-worker-session", "same-worker");
    const reservations = store.db.prepare(`
      SELECT workspace_key, lease_token, status
      FROM agent_task_workspace_reservations
      ORDER BY created_at
    `).all() as Array<{ workspace_key: string; lease_token: string; status: string }>;

    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    expect(retry.leaseToken).toBe(reclaimed.leaseToken);
    expect(reservations).toHaveLength(initialReservationCount + 1);
    expect(reservations.map((row) => row.workspace_key)).toHaveLength(new Set(reservations.map((row) => row.workspace_key)).size);
    expect(reservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ lease_token: first.leaseToken, status: "expired" }),
      expect.objectContaining({ lease_token: reclaimed.leaseToken, status: "reserved" }),
    ]));
    expect(() => heartbeatAgentTask(store, {
      leaseToken: first.leaseToken, agentId: "builder-id", idempotencyKey: "same-worker-old-heartbeat", leaseSeconds: 60,
    })).toThrowError(/租约不存在|租约已过期/);
  });

  it("rolls back a reclaim when the new workspace reservation cannot be inserted", () => {
    const { store, projectId, planIds } = fixture();
    const taskId = `development:${planIds[0]}`;
    const first = claim(store, projectId, "rollback-first", taskId, "builder-id", "rollback-session", "rollback-worker");
    store.db.prepare("UPDATE agent_task_leases SET lease_expires_at = ? WHERE lease_token = ?")
      .run("2000-01-01T00:00:00.000Z", first.leaseToken);
    listAgentTaskLeases(store, projectId);
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at = ? WHERE task_key = ?")
      .run("2000-01-01T00:00:00.000Z", first.taskKey);
    store.db.exec(`
      CREATE TRIGGER reject_workspace_reservation
      BEFORE INSERT ON agent_task_workspace_reservations
      BEGIN
        SELECT RAISE(ABORT, 'injected workspace reservation failure');
      END
    `);

    expect(() => claim(
      store, projectId, "rollback-reclaim", taskId, "builder-id", "rollback-session", "rollback-worker",
    )).toThrowError(/injected workspace reservation failure/);

    const lease = store.db.prepare("SELECT status, lease_token FROM agent_task_leases WHERE task_key = ?")
      .get(first.taskKey) as { status: string; lease_token: string };
    expect(lease).toEqual({ status: "expired", lease_token: first.leaseToken });
    expect(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_resource_locks",
    ).get() as { count: number }).count)).toBe(0);
    expect(Number((store.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_workspace_reservations",
    ).get() as { count: number }).count)).toBe(1);
  });

  it("requires the matching lease for controlled plan writes", () => {
    const { store, projectId, planIds } = fixture();
    const planId = planIds[0];
    expect(() => assertAgentTaskLeaseForPlanAction(store, {
      planId, action: "start_development", agentId: "builder-id",
    })).toThrowError(/leaseToken/);

    const lease = claim(store, projectId, "guard", `development:${planId}`);
    expect(assertAgentTaskLeaseForPlanAction(store, {
      planId, action: "start_development", agentId: "builder-id", leaseToken: lease.leaseToken,
    })?.taskId).toBe(`development:${planId}`);
    expect(startAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "start",
    }).status).toBe("running");
    expect(() => completeAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "too-early", resultDigest: "build-1",
    })).toThrowError(/transition_plan_delivery/);
    transitionPlanLifecycle(store, planId, { action: "start_development", actor: "Builder", agentId: "builder-id" });
    transitionPlanLifecycle(store, planId, {
      action: "complete_development", actor: "Builder", agentId: "builder-id", implementationRevision: "build-1",
    });
    expect(completeAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "complete", resultDigest: "build-1",
    }).status).toBe("completed");
  });

  it("rejects the producer worker when it tries to claim or use the implementation audit", () => {
    const { store, projectId, planIds } = fixture();
    const planId = planIds[0];
    const producer = claim(store, projectId, "producer-claim", `development:${planId}`, "builder-id", "producer-session", "shared-worker");
    startAgentTask(store, { leaseToken: producer.leaseToken, agentId: "builder-id", idempotencyKey: "producer-start" });
    transitionPlanLifecycle(store, planId, { action: "start_development", actor: "Builder", agentId: "builder-id" });
    transitionPlanLifecycle(store, planId, {
      action: "complete_development", actor: "Builder", agentId: "builder-id", implementationRevision: "implementation-1",
    });
    completeAgentTask(store, {
      leaseToken: producer.leaseToken, agentId: "builder-id", idempotencyKey: "producer-complete", resultDigest: "implementation-1",
    });

    const auditTask = listClaimableAgentTasks(store, projectId).find((item) => item.id === `audit:${planId}`)!;
    expect(auditTask).toMatchObject({ auditScope: "implementation", producerWorkerId: "shared-worker" });
    expect(() => claimAgentTask(store, {
      projectId, taskId: auditTask.id, role: "auditor", agentId: "auditor-id", workerId: "shared-worker",
      poolId: auditTask.poolId, sessionId: "self-audit", idempotencyKey: "self-audit-claim",
    })).toThrowError(expect.objectContaining({ code: "SELF_AUDIT_FORBIDDEN" }));

    const auditor = claimAgentTask(store, {
      projectId, taskId: auditTask.id, role: "auditor", agentId: "auditor-id", workerId: "independent-auditor",
      poolId: auditTask.poolId, sessionId: "independent-audit", idempotencyKey: "independent-audit-claim",
    });
    store.db.prepare("UPDATE agent_task_leases SET worker_id='shared-worker' WHERE lease_token=?").run(auditor.leaseToken);
    expect(() => assertAgentTaskLeaseForWrite(store, {
      planId, role: "auditor", agentId: "auditor-id", leaseToken: auditor.leaseToken, auditScope: "implementation",
    })).toThrowError(expect.objectContaining({ code: "SELF_AUDIT_FORBIDDEN" }));
    expect(() => assertAgentTaskLeaseForPlanAction(store, {
      planId, action: "pass_audit", agentId: "auditor-id", leaseToken: auditor.leaseToken,
    })).toThrowError(expect.objectContaining({ code: "SELF_AUDIT_FORBIDDEN" }));
  });
});
