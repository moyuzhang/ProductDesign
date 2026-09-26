import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { completeAgentTask, listClaimableAgentTasks, releaseAgentTask, startAgentTask } from "./agentTaskLeases.js";
import { registerAgentCredential } from "./agentSecurity.js";
import { claimTaskPackage } from "./claimTaskPackage.js";
import { AgentTaskPackageError, buildAgentOrchestration, buildAgentTaskPackage } from "./orchestration.js";

const resources: Array<{ store: Store; dir: string }> = [];
const roleAssignments = {
  designer: { agentId: "designer-id", displayName: "Designer Agent" },
  builder: { agentId: "builder-id", displayName: "Builder Agent" },
  auditor: { agentId: "auditor-id", displayName: "Auditor Agent" },
};

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent orchestration", () => {
  it("routes node requirement approval to an independent Approver and completes it atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-node-requirement-approval-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "NODE-REQUIREMENT", name: "需求审批", summary: "节点需求独立审批", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "requirement-node";
    const original = { id: nodeId, kind: "feature" as const, label: "需求", description: "目标清晰", owner: "team",
      acceptanceCriteria: "可复现", requirementStatus: "待评审" as const, designStatus: "待评审" as const,
      developmentStatus: "未开发" as const, acceptanceStatus: "未验收" as const, x: 100, y: 100 };
    store.updateDiagram(main.id, { nodes: [...main.nodes, original] });
    const orchestration = buildAgentOrchestration(store, project.id)!;
    expect(orchestration.queues.design.some((item) => item.actionCode === "approve_node_requirement")).toBe(false);
    expect(orchestration.queues.approval).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `approval:${nodeId}`, queue: "approval", actionCode: "approve_node_requirement",
      assignee: expect.objectContaining({ agentId: "Main Agent" }),
    })]));
    const firstRevision = listClaimableAgentTasks(store, project.id).find((item) => item.id === `approval:${nodeId}`)!.taskRevision;
    for (const field of ["description", "owner", "acceptanceCriteria", "requirementStatus"] as const) {
      const changed = { ...original, [field]: field === "requirementStatus" ? "未评审" : "changed" };
      store.updateDiagram(main.id, { nodes: [...main.nodes, changed] });
      expect(listClaimableAgentTasks(store, project.id).find((item) => item.id === `approval:${nodeId}`)?.taskRevision).not.toBe(firstRevision);
    }
    store.updateDiagram(main.id, { nodes: [...main.nodes, original] });
    // A historical node-level Designer lease has no planItemId; it must still block self-approval.
    store.db.prepare(`INSERT INTO agent_task_leases
      (id, task_key, task_id, task_revision, project_id, queue, role, action_code, status,
       lease_token, agent_id, worker_id, lease_expires_at, claimed_at, heartbeat_at, updated_at)
      VALUES (?, ?, ?, 'old', ?, 'design', 'designer', 'complete_node_definition', 'released',
        ?, 'Main Agent', 'former-designer', ?, ?, ?, ?)`).run(
      "former-designer-order", "former-designer-task", `design:${nodeId}`, project.id,
      "former-designer-token", new Date(Date.now() + 60_000).toISOString(),
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
    );
    expect(() => claimTaskPackage(store, {
      projectId: project.id, taskId: `approval:${nodeId}`, role: "approver", agentId: "Main Agent",
      workerId: "independent-approver", idempotencyKey: "self-approve-requirement",
    })).toThrow(expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }));
    store.db.prepare("UPDATE agent_task_leases SET agent_id=? WHERE id=?")
      .run("historical-designer", "former-designer-order");
    for (const [agentId, workerId, role] of [
      ["historical-designer", "former-designer", "designer"],
      ["Main Agent", "independent-approver", "approver"],
    ] as const) registerAgentCredential(store, {
      principalId: "shared-principal", agentId, workerId, allowedRoles: [role], allowedProjects: [project.id],
    });
    expect(() => claimTaskPackage(store, {
      projectId: project.id, taskId: `approval:${nodeId}`, role: "approver", agentId: "Main Agent",
      workerId: "independent-approver", idempotencyKey: "same-principal-requirement",
    })).toThrow(expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }));
    store.db.prepare("DELETE FROM agent_task_leases WHERE id=?").run("former-designer-order");
    store.db.prepare("DELETE FROM agent_credentials WHERE principal_id=?").run("shared-principal");
    const claimed = JSON.parse(claimTaskPackage(store, {
      projectId: project.id, taskId: `approval:${nodeId}`, role: "approver", agentId: "Main Agent",
      workerId: "independent-approver", idempotencyKey: "claim-requirement",
    }));
    expect(claimed.requiredSubmissionFields).toContain("非空审核结论");
    expect(claimed.launch.prompt).toContain("complete_agent_task(resultDigest=审核结论)");
    const exact = { leaseToken: claimed.lease.leaseToken, workOrderId: claimed.lease.workOrderId,
      taskKey: claimed.lease.taskKey, taskRevision: claimed.lease.taskRevision,
      agentId: "Main Agent", workerId: "independent-approver", role: "approver" } as const;
    expect(() => completeAgentTask(store, { ...exact, idempotencyKey: "unstarted", resultDigest: "批准" }))
      .toThrow(expect.objectContaining({ code: "NODE_REQUIREMENT_APPROVAL_INVALID" }));
    startAgentTask(store, { ...exact, idempotencyKey: "start-requirement" });
    expect(() => completeAgentTask(store, { ...exact, idempotencyKey: "empty", resultDigest: " " }))
      .toThrow(expect.objectContaining({ code: "NODE_REQUIREMENT_APPROVAL_INVALID" }));
    expect(() => completeAgentTask(store, { ...exact, taskRevision: "stale", idempotencyKey: "wrong-revision", resultDigest: "批准" }))
      .toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    store.updateDiagram(main.id, { nodes: [...main.nodes, { ...original, description: "并发修改" }] });
    expect(() => completeAgentTask(store, { ...exact, idempotencyKey: "drift", resultDigest: "批准" }))
      .toThrow(expect.objectContaining({ code: "TASK_REVISION_DRIFT" }));
    expect(store.getDiagram(main.id)?.nodes.find((item) => item.id === nodeId)?.requirementStatus).toBe("待评审");
    store.updateDiagram(main.id, { nodes: [...main.nodes, original] });
    store.db.prepare("UPDATE agent_task_leases SET work_scopes_json='[]' WHERE id=?").run(exact.workOrderId);
    expect(() => completeAgentTask(store, { ...exact, idempotencyKey: "wrong-scope", resultDigest: "批准" }))
      .toThrow(expect.objectContaining({ code: "LEASE_TASK_MISMATCH" }));
    store.db.prepare("UPDATE agent_task_leases SET work_scopes_json=? WHERE id=?")
      .run(JSON.stringify([`node:${main.id}:${nodeId}`]), exact.workOrderId);
    expect(store.listAudit(100, project.id).filter((item) => item.action === "approve_node_requirement")).toHaveLength(0);
    const completed = completeAgentTask(store, { ...exact, idempotencyKey: "approve-requirement", resultDigest: "需求范围已核对" });
    expect(completed.status).toBe("completed");
    expect(completeAgentTask(store, { ...exact, idempotencyKey: "approve-requirement", resultDigest: "需求范围已核对" })).toEqual(completed);
    expect(store.getDiagram(main.id)?.nodes.find((item) => item.id === nodeId)?.requirementStatus).toBe("已批准");
    expect(store.listAudit(100, project.id).filter((item) => item.action === "approve_node_requirement")).toHaveLength(1);
    expect(listClaimableAgentTasks(store, project.id).some((item) => item.id === `approval:${nodeId}`)).toBe(false);
  });

  it("routes document approval to Main Agent even when implementation depends on an unaccepted task", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-main-agent-node-approval-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "NODE-APPROVAL", name: "节点审批", summary: "Main Agent 审核节点基线", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: "node-approval", kind: "feature", label: "节点审批", description: "完整定义", owner: "team",
      acceptanceCriteria: "有可复现验收标准", requirementStatus: "已批准", designStatus: "待评审",
      developmentStatus: "未开发", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const pending = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "节点设计", summary: "", status: "已批准",
      version: "1.0", author: "designer-id", content: "原固定设计修订",
    });
    store.insertDocumentReference({
      projectId: project.id, documentId: pending.id, targetType: "diagramNode", targetId: "node-approval", relationType: "defines",
    });
    store.updateDesignDoc(pending.id, { version: "1.1", content: "新的固定设计修订" });

    const upstream = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "upstream", parentId: null,
      kind: "task", title: "上游待验收", description: "", status: "已完成", priority: "P1", progress: 100,
      owner: "builder", versionTag: "", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "",
      completedAt: "", lifecycleStatus: "pending_audit", auditStatus: "pending", roleAssignments,
    });
    const downstream = store.insertPlan({
      ...upstream, id: undefined, diagramNodeId: "node-approval", title: "依赖上游的设计", lifecycleStatus: "rework", status: "未开始",
      dependencyIds: [upstream.id], managerDecision: "pending", auditStatus: "not_requested", progress: 0,
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "1", author: "manager", content: "设计先行，实现按依赖验收推进",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });

    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.workflow.nodes.find((item) => item.nodeId === "node-approval")?.layerLocked).toBe(true);
    expect(result.workflow.nextAction?.code).toBe("approve_node_document");
    expect(result.queues.design.some((item) => item.nodeId === "node-approval" && item.actionCode === "approve_node_document")).toBe(false);
    expect(result.queues.approval).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "approval:node-approval",
      actionCode: "approve_node_document",
      assignee: expect.objectContaining({ agentId: "Main Agent" }),
      managerApprovalRequired: false,
    })]));
    expect(buildAgentTaskPackage(store, project.id, {
      queue: "approval",
      taskId: "approval:node-approval",
    })).toMatchObject({
      managerApprovalRequired: false,
      assignment: { agentId: "Main Agent", displayName: "Main Agent" },
      task: { role: "approver", actionCode: "approve_node_document" },
    });
    expect(listClaimableAgentTasks(store, project.id).find((item) => item.id === "approval:node-approval")).toMatchObject({
      taskRevision: `approve_node_document:${store.getDesignDoc(pending.id)!.currentRevisionId}`,
      available: true,
    });
    const claimed = JSON.parse(claimTaskPackage(store, {
      projectId: project.id, role: "approver", agentId: "Main Agent", workerId: "dependent-document-approver", idempotencyKey: "claim-dependent-document",
    }));
    expect(claimed.task.actionCode).toBe("approve_node_document");
    releaseAgentTask(store, { leaseToken: claimed.lease.leaseToken, agentId: "Main Agent", idempotencyKey: "release-dependent-document" });
    for (const [lifecycleStatus, auditStatus, queue, actionCode] of [
      ["draft", "not_requested", "design", "submit_plan"],
      ["pending_approval", "pending", "audit", "audit_design"],
      ["pending_approval", "passed", "approval", "approve_plan"],
    ] as const) {
      store.updatePlan(downstream.id, { lifecycleStatus, auditStatus });
      expect(buildAgentTaskPackage(store, project.id, { queue, taskId: `${queue}:${downstream.id}` }).task.actionCode).toBe(actionCode);
    }
    store.updatePlan(upstream.id, { dependencyIds: [downstream.id] });
    expect(() => buildAgentTaskPackage(store, project.id, { queue: "approval", taskId: `approval:${downstream.id}` }))
      .toThrow(expect.objectContaining({ code: "PLAN_LAYER_INVALID" }));
  });

  it("keeps the document re-approval task for an accepted node whose pinned revision was superseded", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-accepted-node-doc-revision-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "ACCEPTED-DOC-REV", name: "已验收节点文档修订", summary: "共享文档新修订必须继续派发", stage: "设计", health: "正常",
      progress: 100, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "accepted-node-doc-revision";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "已验收节点", description: "完整定义", owner: "team",
      acceptanceCriteria: "有可复现验收标准", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "已完成", acceptanceStatus: "已通过", x: 620, y: 160,
    }] });
    const shared = store.insertDesignDoc({
      projectId: project.id, category: "设计文档", title: "共享设计", summary: "", status: "已批准",
      version: "1.0", author: "designer-id", content: "原共享设计修订",
    });
    store.insertDocumentReference({
      projectId: project.id, documentId: shared.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines",
    });
    const inApprovalQueue = () => buildAgentOrchestration(store, project.id)!.queues.approval
      .some((item) => item.nodeId === nodeId && item.actionCode === "approve_node_document");
    expect(inApprovalQueue()).toBe(false);

    // Another node's design change publishes a new revision of the shared document, so this
    // accepted node's pinned revision is superseded and must not silently lose its task.
    store.updateDesignDoc(shared.id, { version: "1.1", content: "共享设计新修订" });
    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.workflow.nodes.find((item) => item.nodeId === nodeId)?.nextAction?.code).toBe("approve_node_document");
    expect(inApprovalQueue()).toBe(true);
    expect(result.queues.approval).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `approval:${nodeId}`,
      actionCode: "approve_node_document",
      assignee: expect.objectContaining({ agentId: "Main Agent" }),
    })]));
  });

  it("derives an independent Designer task for every draft parent and child plan on the same node", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-orchestration-plan-identity-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "ORCH-PLAN-ID", name: "同节点父子工单", summary: "每张工单独立治理", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "1.0", author: "manager", content: "同节点父子工单必须各自走完整治理链",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "same-node-plan-lifecycle";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "同节点分步交付", description: "父计划包含顺序子工单", owner: "team",
      acceptanceCriteria: "每张 task 独立完成治理", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "未开发", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "同节点工单设计", summary: "", status: "已批准",
      version: "1.0", author: "designer", content: "以 planId 作为工单生命周期身份",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const insertDraft = (title: string, parentId: string | null) => store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId, kind: "task", title,
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "draft", roleAssignments,
    });
    const parent = insertDraft("父工单", null);
    const first = insertDraft("步骤 01", parent.id);
    const second = insertDraft("步骤 02", parent.id);

    const result = buildAgentOrchestration(store, project.id)!;
    const tasks = result.queues.design.filter((item) => [parent.id, first.id, second.id].includes(item.planItemId ?? ""));
    expect(tasks.map((item) => item.id).sort()).toEqual([
      `design:${parent.id}`, `design:${first.id}`, `design:${second.id}`,
    ].sort());
    expect(new Set(tasks.map((item) => item.planItemId)).size).toBe(3);
    expect(tasks.every((item) => item.actionCode === "submit_plan" && item.workScopes[0] === `node:${main.id}:${nodeId}`)).toBe(true);
    for (const plan of [parent, first, second]) {
      const taskPackage = buildAgentTaskPackage(store, project.id, { queue: "design", taskId: `design:${plan.id}` });
      expect(taskPackage.planSnapshot).toMatchObject({ id: plan.id, parentId: plan.parentId });
      expect(taskPackage.task).toMatchObject({ id: `design:${plan.id}`, planItemId: plan.id });
    }
  });

  it("routes an audited construction plan to an independent Main Agent approval work order", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-main-agent-approval-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "AUTO-APPROVE", name: "自动审批", summary: "主 Agent 批准施工计划", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "auto-approved-plan";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "自动批准施工计划", description: "设计审计后由主 Agent 批准", owner: "team",
      acceptanceCriteria: "批准后生成 Builder 工单", requirementStatus: "已批准", designStatus: "待评审",
      developmentStatus: "未开始", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "自动审批设计", summary: "", status: "已批准",
      version: "1.0", author: "designer-id", content: "独立设计审计通过后由 Main Agent Approver 批准",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "自动审批施工计划",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder-id", versionTag: "v1",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "pending_approval",
      proposedBy: "designer-id", submittedAt: "2026-09-05T00:00:00.000Z", auditStatus: "passed",
      auditedBy: "auditor-id", auditedAt: "2026-09-05T00:05:00.000Z", designRevisionIds: [design.currentRevisionId],
      roleAssignments,
    });

    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.queues.managerApproval.some((item) => item.planItemId === plan.id)).toBe(false);
    expect(result.queues.approval).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `approval:${plan.id}`,
      planItemId: plan.id,
      actionCode: "approve_plan",
      assignee: expect.objectContaining({ agentId: "Main Agent" }),
      managerApprovalRequired: false,
    })]));
    const taskPackage = buildAgentTaskPackage(store, project.id, { queue: "approval", taskId: `approval:${plan.id}` });
    expect(taskPackage).toMatchObject({
      managerApprovalRequired: false,
      assignment: { agentId: "Main Agent", displayName: "Main Agent" },
      task: { role: "approver", actionCode: "approve_plan" },
    });

    store.updatePlan(plan.id, {
      lifecycleStatus: "pending_manager",
      status: "已完成",
      progress: 100,
      completedAt: "2026-09-05T01:00:00.000Z",
      implementationRevision: "abc123",
      auditStatus: "passed",
      managerDecision: "pending",
    });
    const acceptance = buildAgentOrchestration(store, project.id)!;
    expect(acceptance.queues.managerApproval.some((item) => item.planItemId === plan.id)).toBe(false);
    expect(acceptance.queues.approval).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `approval:${plan.id}`,
      actionCode: "approve_acceptance",
      assignee: expect.objectContaining({ agentId: "Main Agent" }),
      managerApprovalRequired: false,
    })]));
    expect(buildAgentTaskPackage(store, project.id, { queue: "approval", taskId: `approval:${plan.id}` })).toMatchObject({
      deliveryTrack: "implementation",
      managerApprovalRequired: false,
      task: { role: "approver", actionCode: "approve_acceptance" },
    });
  });

  it("queues formal submission for a completed legacy plan instead of node evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-legacy-trace-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "LEGACY-TRACE", name: "历史计划基线", summary: "补齐 legacy 计划的正式交付链", stage: "测试", health: "关注",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "1.0", author: "manager", content: "范围",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "legacy-trace-node";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "历史交付", description: "补齐正式基线", owner: "team",
      acceptanceCriteria: "正式计划重新提交", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "已完成", acceptanceStatus: "已通过", x: 620, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "历史交付设计", summary: "", status: "已批准",
      version: "1.0", author: "designer", content: "设计",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "历史计划",
      description: "", status: "已完成", priority: "P1", progress: 100, owner: "builder-id", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "2026-08-27T00:00:00.000Z",
      lifecycleStatus: "legacy", roleAssignments,
    });

    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.workflow.nextAction).toMatchObject({ code: "submit_plan", entityId: plan.id });
    expect(result.queues.audit.some((item) => item.nodeId === nodeId && item.actionCode === "add_node_evidence")).toBe(false);
    expect(result.queues.design).toEqual(expect.arrayContaining([expect.objectContaining({
      id: `design:${plan.id}`,
      planItemId: plan.id,
      actionCode: "submit_plan",
      href: expect.stringContaining(`tab=development&plan=${plan.id}`),
    })]));
    expect(listClaimableAgentTasks(store, project.id).find((item) => item.id === `design:${plan.id}`)).toMatchObject({
      available: true,
      availabilityReason: "可领取",
    });
  });

  it("exposes approved development work to a builder", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-orchestration-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "ORCH", name: "编排项目", summary: "验证外部 Agent 编排", stage: "开发", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "manager", content: "范围",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: "feature-orchestration", kind: "feature", label: "Agent 编排", description: "按职责推进项目", owner: "team",
      acceptanceCriteria: "外部 Agent 可读取队列", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "开发中", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "详细设计", summary: "", status: "已批准",
      version: "v1.0", author: "designer", content: "职责边界",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: "feature-orchestration", relationType: "defines" });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "feature-orchestration", parentId: null,
      kind: "task", title: "实现编排接口", description: "", status: "进行中", priority: "P0", progress: 30,
      owner: "builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
      lifecycleStatus: "approved", proposedBy: "designer", submittedAt: "2026-08-30T01:00:00.000Z",
      approvedBy: "manager", approvedAt: "2026-08-30T01:05:00.000Z",
      roleAssignments,
    });
    const milestone = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "feature-orchestration", parentId: null,
      kind: "milestone", title: "编排交付里程碑", description: "只负责层级", status: "未开始", priority: "P1", progress: 0,
      owner: "manager", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    });

    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.queues.development).toEqual(expect.arrayContaining([expect.objectContaining({
      planItemId: plan.id,
      nodeId: "feature-orchestration",
      actionCode: "start_development",
    })]));
    expect(Object.values(result.queues).flat().some((item) => item.planItemId === milestone.id)).toBe(false);
    expect(result.recommendedAgents.map((agent) => agent.key)).toEqual(["designer", "builder", "auditor", "approver"]);
    expect(result.bootstrapPrompt).toContain("禁止自动创建管理员 Agent");
    expect(result.bootstrapPrompt).toContain("必须由用户在该目录手动启动");
    expect(result.bootstrapPrompt).toContain("每个 Designer、Builder 和 Auditor 都必须提交与本人任务绑定的工单");
    expect(result.workingDirectory).toEqual(expect.objectContaining({ repositoryPath: dir, ready: true }));
    expect(result.handoffs.some((handoff) => handoff.from === "auditor" && handoff.to === "manager")).toBe(true);

    const plansBefore = store.listPlans(project.id).length;
    const evidenceBefore = store.listEvidence(project.id).length;
    const taskPackage = buildAgentTaskPackage(store, project.id, { queue: "development", taskId: `development:${plan.id}` });
    expect(taskPackage.schemaVersion).toBe("1.3");
    expect(taskPackage).toMatchObject({ deliveryTrack: "implementation", auditScope: null, managerApprovalRequired: false });
    expect(taskPackage.task).toEqual(expect.objectContaining({ planItemId: plan.id, role: "builder", queue: "development", assignee: roleAssignments.builder }));
    expect(taskPackage.assignment).toEqual(roleAssignments.builder);
    expect(taskPackage.launch).toEqual(expect.objectContaining({ manualStartRequired: true, workingDirectory: dir }));
    expect(taskPackage.launch.prompt).toContain("不要在 ProductDesign 控制台进程的默认目录代写其他项目代码");
    expect(taskPackage.planSnapshot).toEqual(expect.objectContaining({ id: plan.id, title: "实现编排接口", lifecycleStatus: "approved" }));
    expect(taskPackage.node).toEqual(expect.objectContaining({
      nodeId: "feature-orchestration",
      label: "Agent 编排",
      acceptanceCriteria: "外部 Agent 可读取队列",
      developmentStatus: "开发中",
    }));
    expect(taskPackage.documents).toEqual(expect.arrayContaining([expect.objectContaining({
      title: "详细设计",
      relationType: "defines",
      targetType: "diagramNode",
      documentRevisionId: design.currentRevisionId,
      content: "职责边界",
      hasMore: false,
    })]));
    expect(taskPackage.dependencies).toEqual([]);
    expect(taskPackage.databaseBindings).toEqual([]);
    expect(taskPackage.evidenceRequirements).toContain("implementationRevision");
    expect(taskPackage.launch.prompt).toContain("领取后不得再调用 list_plan_items");
    expect(taskPackage.launch.prompt).not.toContain("确认返回的唯一 nextAction 仍与本任务一致");
    expect(taskPackage.launch.prompt).toContain("关键路径仅用于项目级提示");
    expect(taskPackage.worker).toEqual(expect.objectContaining({ agentId: "builder-id", workerId: "builder-id" }));
    expect(taskPackage.launch.prompt).toContain("验收标准");
    expect(taskPackage.boundaries).toContain("不得绕过独立审计或自动批准 human-only 高风险事项。");
    expect(taskPackage.evidenceReturn.requiredFields).toContain("implementationRevision");
    expect(taskPackage.evidenceReturn.requiredFields).toContain("agentId");
    expect(store.listPlans(project.id)).toHaveLength(plansBefore);
    expect(store.listEvidence(project.id)).toHaveLength(evidenceBefore);
  });

  it("merges globally-shared blueprint overrides onto the editable agent fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-orchestration-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "OVERRIDE", name: "编排覆盖", summary: "验证蓝图覆盖", stage: "探索", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "",
      startAt: "", dueAt: "",
    });
    store.upsertAgentBlueprintOverride("designer", {
      name: "需求分析师",
      purpose: "专注需求澄清与验收标准。",
      responsibilities: ["澄清范围"],
      boundaries: ["不写代码"],
      allowedMcpTools: ["get_project_workflow", "get_project_context", "list_plan_items"],
    });

    const result = buildAgentOrchestration(store, project.id)!;
    const designer = result.recommendedAgents.find((agent) => agent.key === "designer")!;
    expect(designer.name).toBe("需求分析师");
    expect(designer.purpose).toBe("专注需求澄清与验收标准。");
    expect(designer.responsibilities).toEqual(["澄清范围"]);
    expect(designer.boundaries).toEqual(["不写代码"]);
    expect(designer.allowedMcpTools).toEqual(["get_project_workflow", "get_project_workspace", "get_plan_item"]);
    // Prompt stays auto-generated from the default rules; untouched by the override.
    expect(designer.prompt).toContain("Designer");

    // Un-overridden agents keep defaults.
    const builder = result.recommendedAgents.find((agent) => agent.key === "builder")!;
    expect(builder.name).toBe("施工 Agent");
    expect(builder.allowedMcpTools).toContain("get_plan_item");
    expect(builder.allowedMcpTools).toContain("get_design_doc");
    expect(builder.allowedMcpTools).not.toContain("list_plan_items");

    try {
      buildAgentTaskPackage(store, project.id);
      throw new Error("expected task package generation to fail");
    } catch (cause) {
      expect(cause).toBeInstanceOf(AgentTaskPackageError);
      expect((cause as AgentTaskPackageError).code).toBe("WORKING_DIRECTORY_NOT_READY");
    }
  });

  it("queues only the active layer, orders peers by priority, and rejects a locked task package", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-orchestration-layers-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "ORCH-LAYERS", name: "逐层编排", summary: "逐层推进", stage: "开发", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
      startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const node = (id: string, label: string) => ({
      id, kind: "feature" as const, label, description: label, owner: "team", acceptanceCriteria: "通过",
      requirementStatus: "已批准" as const, designStatus: "已批准" as const,
      developmentStatus: "未开发" as const, acceptanceStatus: "未验收" as const, x: 600, y: 160,
    });
    store.updateDiagram(main.id, { nodes: [...main.nodes, node("low", "同层普通任务"), node("urgent", "同层紧急任务"), node("high", "下一层任务")] });
    const insert = (nodeId: string, title: string, priority: "P0" | "P2", dependencyIds: string[] = []) => store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title,
      description: "", status: "未开始", priority, progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds, blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer",
      submittedAt: "2026-08-30T01:00:00.000Z", approvedBy: "manager", approvedAt: "2026-08-30T01:05:00.000Z", roleAssignments,
    });
    const low = insert("low", "普通任务", "P2");
    const urgent = insert("urgent", "紧急任务", "P0");
    const high = insert("low", "同节点下一层施工任务", "P0", [low.id]);
    const highAudit = insert("low", "同节点下一层审计任务", "P0", [low.id]);
    store.updatePlan(highAudit.id, { lifecycleStatus: "pending_audit", status: "已完成", progress: 100, auditStatus: "pending" });
    const highManager = insert("low", "同节点下一层经理任务", "P0", [low.id]);
    store.updatePlan(highManager.id, { lifecycleStatus: "pending_manager", status: "已完成", progress: 100, auditStatus: "passed", managerDecision: "pending" });
    const highDesign = insert("low", "同节点下一层返工任务", "P0", [low.id]);
    store.updatePlan(highDesign.id, { lifecycleStatus: "rework", managerDecision: "rejected", rejectionReason: "返工" });

    const result = buildAgentOrchestration(store, project.id)!;
    expect(result.workflow.layerGate).toMatchObject({ activeLayer: 1, totalLayers: 2, lockedPlanCount: 4 });
    expect(result.queues.development.map((item) => item.planItemId)).toEqual([urgent.id, low.id]);
    expect(result.queues.development.every((item) => item.deliveryLayer === 1)).toBe(true);
    const lockedIds = new Set([high.id, highAudit.id, highManager.id, highDesign.id]);
    expect(Object.values(result.queues).flat().some((item) => item.planItemId && lockedIds.has(item.planItemId))).toBe(false);
    try {
      buildAgentTaskPackage(store, project.id, { queue: "development", taskId: `development:${high.id}` });
      throw new Error("expected the higher layer package to be rejected");
    } catch (cause) {
      expect(cause).toMatchObject({ statusCode: 409, code: "PLAN_LAYER_LOCKED" });
    }
  });
});
