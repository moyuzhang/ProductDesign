import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Store, nowIso } from "./db.js";
import { buildAgentOrchestration } from "./orchestration.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { claimAgentTask, assertAgentTaskLeaseForPlanAction, listAgentTaskLeases } from "./agentTaskLeases.js";
import { planDeliveryActions } from "../shared/planDelivery.js";
import { openEvidenceRepairState } from "./evidenceRepair.js";
import { LocalMcpClient } from "./localMcpClient.js";
import { createMcpServer } from "../mcp/index.js";

it("hands node acceptance to an independent Main Agent and rejects incomplete or conflicting review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-main-review-"));
  const store = new Store(join(dir, "test.db"));
  let client: LocalMcpClient | undefined;
  try {
    const project = store.insertProject({
      code: "MAIN-REVIEW", name: "主 Agent 审核", summary: "验收归属", stage: "开发", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir, startAt: "", dueAt: "",
    });
    const diagram = store.listDiagrams(project.id).find((item) => item.type === "main")!;
    const nodeId = "review-node";
    store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, {
      id: nodeId, kind: "feature", label: "验收", description: "复核全部计划", owner: "team", acceptanceCriteria: "全部当前证据通过",
      requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "已完成", acceptanceStatus: "未验收", x: 600, y: 160,
    }] });
    const doc = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "固定设计", summary: "", status: "已批准", version: "1", author: "designer", content: "验收标准",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: doc.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const assignments = {
      designer: { agentId: "designer", displayName: "Designer" },
      builder: { agentId: "builder", displayName: "Builder" },
      auditor: { agentId: "auditor", displayName: "Auditor" },
    };
    const plans = ["第一步", "第二步"].map((title) => store.insertPlan({
      projectId: project.id, diagramId: diagram.id, diagramNodeId: nodeId, parentId: null, kind: "task", title, description: "",
      status: "已完成", priority: "P1", progress: 100, owner: "builder", versionTag: "1", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: nowIso(), lifecycleStatus: "accepted", roleAssignments: assignments,
      submittedAt: nowIso(), approvedAt: nowIso(), auditStatus: "passed", managerDecision: "approved", implementationRevision: "revision-1",
      designRevisionIds: [doc.currentRevisionId],
    }));
    plans.forEach((plan) => store.insertEvidence({
      projectId: project.id, nodeId, planItemId: plan.id, sourceType: "manual", sourcePath: "review.txt", command: "verify implementation",
      resultStatus: "pass", summary: "当前实现独立审计通过", details: { auditScope: "implementation", implementationRevision: "revision-1" },
      commitSha: "revision-1", digest: "review", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor",
    }));
    plans.forEach((plan) => openEvidenceRepairState(store, plan, 3));
    const queues = buildAgentOrchestration(store, project.id)!.queues;
    expect(queues.managerApproval).toEqual([]);
    const task = queues.approval.find((item) => item.nodeId === nodeId)!;
    expect(task).toMatchObject({ actionCode: "accept_node", assignee: { agentId: "Main Agent" }, managerApprovalRequired: false });
    const planId = task.planItemId!;
    const other = plans.find((plan) => plan.id !== planId)!;
    const lease = claimAgentTask(store, {
      projectId: project.id, taskId: task.id, role: "approver", agentId: "Main Agent", workerId: "main-review-worker", idempotencyKey: "claim-review",
    });
    const context = { planId, action: "accept_node", leaseToken: lease.leaseToken, agentId: "Main Agent" };
    expect(() => assertAgentTaskLeaseForPlanAction(store, { planId, action: "accept_node", agentId: "Main Agent" })).toThrow("leaseToken");
    expect(() => assertAgentTaskLeaseForPlanAction(store, { ...context, action: "approve_acceptance" })).toThrow("不匹配");
    store.updatePlan(other.id, { roleAssignments: { ...assignments, builder: { agentId: "Main Agent", displayName: "Main Agent" } } });
    expect(() => assertAgentTaskLeaseForPlanAction(store, context)).toThrow("生产身份");
    store.updatePlan(other.id, { roleAssignments: assignments });
    assertAgentTaskLeaseForPlanAction(store, context);
    const input = { action: "accept_node" as const, actor: "Main Agent", agentId: "Main Agent" };
    store.updatePlan(other.id, { implementationRevision: "revision-2" });
    expect(() => transitionPlanLifecycle(store, planId, input)).toThrow("当前实现证据");
    expect(buildAgentOrchestration(store, project.id)!.queues.development.some((item) => item.planItemId === other.id && item.actionCode === "submit_evidence_repair")).toBe(true);
    store.updatePlan(other.id, { implementationRevision: "revision-1" });
    store.updatePlan(other.id, { lifecycleStatus: "legacy" });
    expect(buildAgentOrchestration(store, project.id)!.queues.design.some((item) => item.planItemId === other.id && item.actionCode === "submit_plan")).toBe(true);
    expect(() => transitionPlanLifecycle(store, planId, input)).toThrow("全部计划");
    store.updatePlan(other.id, { lifecycleStatus: "accepted" });
    client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath: join(dir, "test.db"), dataDir: dir }));
    const result = await client.callTool("transition_plan_delivery", { ...input, ...context, idempotencyKey: "finish-review" });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(store.getDiagram(diagram.id)!.nodes.find((item) => item.id === nodeId)!.acceptanceStatus).toBe("已通过");
    expect(listAgentTaskLeases(store, project.id).find((item) => item.workOrderId === lease.workOrderId)!.status).toBe("completed");
    expect(buildAgentOrchestration(store, project.id)!.queues.approval.some((item) => item.nodeId === nodeId)).toBe(false);
    for (const lifecycleStatus of ["pending_approval", "pending_manager"] as const) {
      expect(planDeliveryActions({ ...plans[0], lifecycleStatus }).every((action) => action.actorRole === "approver")).toBe(true);
    }
  } finally {
    await client?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
