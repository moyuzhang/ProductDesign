import { claimTaskPackage } from "./claimTaskPackage.js";
import { buildAgentOrchestration } from "./orchestration.js";
import { getDesignGap } from "./designGap.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForPlanAction,
  claimAgentTask,
  approvalGroupLeases,
  decorateAgentOrchestrationWithLeases,
  expireStaleAgentTasks,
  heartbeatAgentTask,
  listAgentTaskLeases,
  releaseAgentTask,
  reportDesignGap,
  dismissDesignGap,
  startAgentTask,
  updateAgentTaskCapacity,
} from "./agentTaskLeases.js";
import { designChangeBodyDigest, requestDesignChange } from "./designChange.js";
import { submitDesignChangeIntent } from "./designChangeIntent.js";
import { getEvidenceRepairState, openEvidenceRepairState, updateEvidenceRepairState } from "./evidenceRepair.js";
import { Store, nowIso } from "./db.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { createMcpServer } from "../mcp/index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";
import { buildApp } from "./index.js";
import {
  acknowledgeAgentPolicy,
  beginAgentAuth,
  completeAgentAuth,
  expectedChallengeResponse,
  issueOneTimeNonce,
  registerAgentCredential,
} from "./agentSecurity.js";

const resources: Array<{ store: Store; dir: string }> = [];
const assignments = {
  designer: { agentId: "designer-id", displayName: "Designer" },
  builder: { agentId: "builder-id", displayName: "Builder" },
  auditor: { agentId: "auditor-id", displayName: "Auditor" },
};

function designChangeRequestCount(store: Store): number {
  try {
    return (store.db.prepare("SELECT COUNT(*) AS count FROM design_change_requests").get() as { count: number }).count;
  } catch {
    return 0;
  }
}

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-design-change-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "CHANGE", name: "设计变更", summary: "测试设计变更", stage: "开发", health: "正常",
    progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodeId = "change-node";
  const diagram = store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: nodeId, kind: "feature", label: "可返工功能", description: "设计错误测试", owner: "Team",
    acceptanceCriteria: "新设计可验证", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "开发中", acceptanceStatus: "未验收", x: 620, y: 180,
  }] })!;
  const document = store.insertDesignDoc({
    projectId: project.id, category: "功能说明", title: "详细设计", summary: "旧设计", status: "已批准",
    version: "1.0", author: "Designer", sourceUrl: "", content: "旧版本设计",
  });
  const reference = store.insertDocumentReference({
    projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines",
  });
  const base = {
    projectId: project.id, diagramId: diagram.id, diagramNodeId: nodeId, parentId: null,
    kind: "task" as const, description: "实现旧设计", priority: "P1" as const, owner: "Builder",
    versionTag: "v1", dueAt: "", dependencyIds: [] as string[], blockedReason: "", roleAssignments: assignments,
    proposedBy: "Designer", submittedAt: "2026-09-01T01:00:00.000Z", approvedBy: "Manager",
    approvedAt: "2026-09-01T01:05:00.000Z",
  };
  const activePlan = store.insertPlan({
    ...base, title: "进行中计划", status: "进行中", progress: 70, startAt: "2026-09-01",
    completedAt: "", lifecycleStatus: "in_progress", proposalRevision: 2,
  });
  const acceptedPlan = store.insertPlan({
    ...base, title: "已验收计划", status: "已完成", progress: 100, startAt: "2026-08-01",
    completedAt: "2026-08-02T01:00:00.000Z", lifecycleStatus: "accepted", proposalRevision: 3,
    implementationRevision: "old-accepted", auditStatus: "passed", managerDecision: "approved",
  });
  const acceptedPlanReference = store.insertDocumentReference({
    projectId: project.id, documentId: document.id, documentRevisionId: document.currentRevisionId,
    targetType: "plan", targetId: acceptedPlan.id, relationType: "defines",
  });
  const evidence = store.insertEvidence({
    projectId: project.id, nodeId, planItemId: activePlan.id, documentRevisionId: document.currentRevisionId,
    sourceType: "manual", sourcePath: "old-report.json", command: "npm test", resultStatus: "pass",
    summary: "旧设计通过", details: {}, commitSha: "old", digest: "old", collectedAt: nowIso(),
    actorRole: "auditor", agentId: "auditor-id",
  });
  const lease = claimAgentTask(store, {
    projectId: project.id, taskId: `development:${activePlan.id}`, role: "builder", agentId: "builder-id",
    workerId: "design-change-builder", sessionId: "design-change-session", runId: "design-change-run",
    leaseSeconds: 60, idempotencyKey: "claim-design-change",
  });
  return { store, dir, project, diagram, nodeId, document, reference, activePlan, acceptedPlan, acceptedPlanReference, evidence, lease };
}

function prepareAssessedRepair(fx: ReturnType<typeof fixture>) {
  releaseAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "release-builder" });
  fx.store.updatePlan(fx.activePlan.id, {
    status: "已完成", progress: 100, lifecycleStatus: "accepted", auditStatus: "passed", managerDecision: "approved",
    implementationRevision: "main-change-base", completedAt: nowIso(), auditedAt: nowIso(), managerDecisionAt: nowIso(),
  });
  fx.store.insertEvidence({
    projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.acceptedPlan.id,
    sourceType: "manual", sourcePath: "accepted-audit.json", command: "npm test -- accepted", resultStatus: "pass",
    summary: "既有计划独立审计有效", details: { auditScope: "implementation", implementationRevision: fx.acceptedPlan.implementationRevision },
    commitSha: fx.acceptedPlan.implementationRevision, digest: "accepted-audit", collectedAt: nowIso(),
    actorRole: "auditor", agentId: "auditor-id",
  });
  const diagram = fx.store.getDiagram(fx.diagram.id)!;
  fx.store.updateDiagram(diagram.id, { nodes: diagram.nodes.map((node) => node.id === fx.nodeId
    ? { ...node, developmentStatus: "已完成", acceptanceStatus: "已通过", deliveryUpdatedAt: nowIso() }
    : node) });
  openEvidenceRepairState(fx.store, fx.store.getPlan(fx.activePlan.id)!, 3);
  updateEvidenceRepairState(fx.store, fx.activePlan.id, {
    status: "exhausted", attemptCount: 3, disposition: "attempts_exhausted:test",
  });
  return fx;
}

function mainAgentFixture(agentId = "Main Agent") {
  const fx = prepareAssessedRepair(fixture());
  transitionPlanLifecycle(fx.store, fx.activePlan.id, {
    action: "assess_evidence_repair_failure", actor: agentId, agentId,
    reason: "实现边界已变化，必须重新设计", repairDisposition: "design_change",
  });
  const lease = claimAgentTask(fx.store, {
    projectId: fx.project.id, role: "approver", agentId, workerId: "main-change-worker",
    idempotencyKey: "claim-main", sessionId: "main-session", runId: "main-run",
  });
  const agent = {
    workOrderId: lease.workOrderId, leaseToken: lease.leaseToken, taskKey: lease.taskKey, taskRevision: lease.taskRevision,
    workerId: lease.workerId, agentId: lease.agentId, role: lease.role,
  };
  const input = {
    projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "spoofed-display-name",
    reason: "接口边界错误", changeSummary: "提交新的设计基线", requirementImpact: false,
    impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id],
    reusableWorkSummary: "", reworkScope: "重新设计与实现", apiImpact: "", databaseImpact: "", deploymentImpact: "",
    expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt, idempotencyKey: "main-design-change",
  };
  return { ...fx, mainLease: lease, agent, input };
}

describe("Main Agent design-change authorization", () => {
  it("rejects an assessment lease without mutation, then succeeds only after a fresh request_design_change lease", () => {
    const fx = prepareAssessedRepair(fixture());
    const assessmentLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, role: "approver", agentId: "Main Agent", workerId: "assessment-worker",
      idempotencyKey: "claim-assessment-action", sessionId: "assessment-session", runId: "assessment-run",
    });
    expect(assessmentLease.actionCode).toBe("assess_evidence_repair_failure");
    const assessmentAgent = {
      workOrderId: assessmentLease.workOrderId, leaseToken: assessmentLease.leaseToken,
      taskKey: assessmentLease.taskKey, taskRevision: assessmentLease.taskRevision,
      workerId: assessmentLease.workerId, agentId: assessmentLease.agentId, role: assessmentLease.role,
    };
    const input = {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Main Agent",
      reason: "需要设计变更", changeSummary: "修订设计边界", requirementImpact: false,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "设计、实现和验证", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt, idempotencyKey: "assessment-action-mismatch",
    };
    const before = {
      plan: fx.store.getPlan(fx.activePlan.id),
      document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.listEvidence(fx.project.id),
      repair: getEvidenceRepairState(fx.store, fx.activePlan.id),
      lease: listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.workOrderId === assessmentLease.workOrderId),
      auditCount: (fx.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
      idempotencyCount: designChangeRequestCount(fx.store),
    };
    expect(() => requestDesignChange(fx.store, input, { source: "mcp", agent: assessmentAgent }))
      .toThrow(expect.objectContaining({ code: "ACTION_MISMATCH" }));
    expect({
      plan: fx.store.getPlan(fx.activePlan.id),
      document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.listEvidence(fx.project.id),
      repair: getEvidenceRepairState(fx.store, fx.activePlan.id),
      lease: listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.workOrderId === assessmentLease.workOrderId),
      auditCount: (fx.store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
      idempotencyCount: designChangeRequestCount(fx.store),
    }).toEqual(before);

    startAgentTask(fx.store, {
      leaseToken: assessmentLease.leaseToken, agentId: "Main Agent", idempotencyKey: "start-assessment-action",
    });
    fx.store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(fx.store, {
        leaseToken: assessmentLease.leaseToken, agentId: "Main Agent",
        planId: fx.activePlan.id, action: "assess_evidence_repair_failure",
      });
      transitionPlanLifecycle(fx.store, fx.activePlan.id, {
        action: "assess_evidence_repair_failure", actor: "Main Agent", agentId: "Main Agent",
        reason: "实现边界已变化，必须重新设计", repairDisposition: "design_change",
      });
      advanceAgentTaskLeaseForPlanAction(fx.store, asserted, {
        action: "assess_evidence_repair_failure", agentId: "Main Agent",
        idempotencyKey: "complete-assessment-action", resultDigest: "design_change",
      });
    }).immediate();
    const changeLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, role: "approver", agentId: "Main Agent", workerId: "design-change-worker",
      idempotencyKey: "claim-request-design-change", sessionId: "design-change-session", runId: "design-change-run",
    });
    expect(changeLease.actionCode).toBe("request_design_change");
    const result = requestDesignChange(fx.store, { ...input, idempotencyKey: "request-after-assessment" }, {
      source: "mcp",
      agent: {
        workOrderId: changeLease.workOrderId, leaseToken: changeLease.leaseToken,
        taskKey: changeLease.taskKey, taskRevision: changeLease.taskRevision,
        workerId: changeLease.workerId, agentId: changeLease.agentId, role: changeLease.role,
      },
    });
    expect(result.changeId).toBeTruthy();
  });

  it("requires the server-computed transitive dependent closure and supersedes old repair state", () => {
    const fx = mainAgentFixture();
    fx.store.updatePlan(fx.acceptedPlan.id, { dependencyIds: [fx.activePlan.id] });
    openEvidenceRepairState(fx.store, fx.store.getPlan(fx.acceptedPlan.id)!, 3);
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "IMPACTED_PLAN_CLOSURE_MISMATCH" }));
    const result = requestDesignChange(fx.store, {
      ...fx.input,
      impactedPlanIds: [fx.activePlan.id, fx.acceptedPlan.id],
      idempotencyKey: "main-design-change-with-closure",
    }, { source: "mcp", agent: fx.agent });
    expect(result.impactedPlanIds.sort()).toEqual([fx.activePlan.id, fx.acceptedPlan.id].sort());
    expect(getEvidenceRepairState(fx.store, fx.acceptedPlan.id)).toMatchObject({ status: "superseded" });
  });

  it("fails closed when one Agent approval lease tries to mutate a cross-node dependency closure", () => {
    const fx = mainAgentFixture();
    const latest = fx.store.getDiagram(fx.diagram.id)!;
    const dependentNodeId = "dependent-node";
    fx.store.updateDiagram(latest.id, { nodes: [...latest.nodes, {
      id: dependentNodeId, kind: "feature", label: "依赖节点", description: "跨节点依赖", owner: "Team",
      acceptanceCriteria: "独立审批", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "已完成", acceptanceStatus: "已通过", x: 920, y: 180,
    }] });
    const dependent = fx.store.insertPlan({
      ...fx.acceptedPlan, id: undefined, title: "跨节点依赖计划", diagramNodeId: dependentNodeId,
      dependencyIds: [fx.activePlan.id], correlationId: "cross-node-dependent",
    });
    const input = {
      ...fx.input,
      impactedPlanIds: [fx.activePlan.id, dependent.id],
      expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt,
      idempotencyKey: "cross-node-change",
    };
    expect(() => requestDesignChange(fx.store, input, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "CROSS_NODE_APPROVAL_REQUIRED" }));
    expect(fx.store.getPlan(fx.activePlan.id)?.lifecycleStatus).toBe("accepted");
    expect(fx.store.getPlan(dependent.id)?.lifecycleStatus).toBe("accepted");
    expect(fx.store.getDesignDoc(fx.document.id)?.currentRevisionId).toBe(fx.document.currentRevisionId);
  });

  it("accepts the same normalized identity contract as the claim entry point", () => {
    const fx = mainAgentFixture("main agent");
    const result = requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent });
    expect(result.changeId).toBeTruthy();
    expect(fx.store.getDesignDoc(fx.document.id)?.status).toBe("评审中");
  });
  it("allows a scoped approver, invalidates its lease and recovers only the same committed change", () => {
    const fx = mainAgentFixture();
    const result = requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent });
    expect(fx.store.getDesignDoc(fx.document.id)?.status).toBe("评审中");
    expect(listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.workOrderId === fx.mainLease.workOrderId)?.status).toBe("released");
    expect(result.releasedLeaseTaskKeys).toContain(fx.mainLease.taskKey);
    expect(requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent })).toEqual(result);
    expect(fx.store.db.prepare("SELECT actor FROM audit_events WHERE entity_id=?").get(result.changeId)).toEqual({ actor: "Main Agent" });
    expect(() => requestDesignChange(fx.store, { ...fx.input, idempotencyKey: "new-change" }, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "LEASE_LOST" }));
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: { ...fx.agent, workerId: "other-worker" } }))
      .toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
  });

  it.each(["designer", "builder", "auditor"])("rejects a %s even when the actor is named Main Agent", (role) => {
    const fx = mainAgentFixture();
    expect(() => requestDesignChange(fx.store, { ...fx.input, actor: "Main Agent" }, {
      source: "mcp", agent: { ...fx.agent, role },
    })).toThrow(expect.objectContaining({ code: "MAIN_AGENT_REQUIRED" }));
    expect(fx.store.getDesignDoc(fx.document.id)?.currentRevisionId).toBe(fx.document.currentRevisionId);
  });

  it("rejects missing context, forged identities, cross-node scope and expired leases without mutation", () => {
    const fx = mainAgentFixture();
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: {} }))
      .toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: { ...fx.agent, taskRevision: "stale" } }))
      .toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    expect(() => requestDesignChange(fx.store, { ...fx.input, nodeId: "other-node" }, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "DESIGN_CHANGE_SCOPE_MISMATCH" }));
    fx.store.db.prepare("UPDATE agent_task_leases SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", fx.mainLease.workOrderId);
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "LEASE_LOST" }));
    expect(fx.store.getDesignDoc(fx.document.id)?.currentRevisionId).toBe(fx.document.currentRevisionId);
  });

  it("rejects production identity reuse and stale canvas versions, preserving the active approver lease", () => {
    const fx = mainAgentFixture();
    expect(() => requestDesignChange(fx.store, { ...fx.input, expectedUpdatedAt: "stale" }, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "DIAGRAM_REVISION_CONFLICT" }));
    fx.store.updatePlan(fx.activePlan.id, { roleAssignments: { ...assignments, builder: { agentId: "Main Agent", displayName: "Builder" } } });
    expect(() => requestDesignChange(fx.store, fx.input, { source: "mcp", agent: fx.agent }))
      .toThrow(expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }));
    expect(listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.workOrderId === fx.mainLease.workOrderId)?.status).toBe("claimed");
  });

  it("accepts the actual external MCP tool with an approver lease, denies missing/spoofed roles, and safely replays", async () => {
    const fx = mainAgentFixture();
    const client = await LocalMcpClient.connect(() => createMcpServer({ store: fx.store, dataDir: fx.dir }));
    const payload = { ...fx.input, projectRef: fx.project.id };
    try {
      expect(mcpResultText(await client.callTool("request_design_change", payload), 100_000)).toContain("WORK_ORDER_CONTEXT_INVALID");
      expect(mcpResultText(await client.callTool("request_design_change", { ...payload, ...fx.agent, role: "builder" }), 100_000)).toContain("MAIN_AGENT_REQUIRED");
      const changed = await client.callTool("request_design_change", { ...payload, ...fx.agent });
      const result = JSON.parse(mcpResultText(changed, 100_000));
      expect(result.changeId).toBeTruthy();
      expect(result.releasedLeaseTaskKeys).toContain(fx.mainLease.taskKey);
      const replay = await client.callTool("request_design_change", { ...payload, ...fx.agent });
      expect(JSON.parse(mcpResultText(replay, 100_000))).toEqual(result);
      await expect(client.callTool("delete_design_doc", { documentId: fx.document.id, confirm: true }))
        .rejects.toThrow("Agent 不允许调用 MCP 工具");
    } finally { await client.close(); }
  });

  it("uses the same lease gate through REST without trusting an actor header", async () => {
    const fx = mainAgentFixture();
    const app = buildApp({ dbPath: join(fx.dir, "test.db"), dataDir: fx.dir });
    try {
      await app.ready();
      const payload = { ...fx.input, ...fx.agent, expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt };
      const url = `/api/projects/${fx.project.id}/design-changes`;
      const spoofed = await app.inject({ method: "POST", url, payload, headers: { "x-productdesign-actor-type": "human" } });
      expect(spoofed.statusCode).toBe(401);
      const rejected = await app.inject({ method: "POST", url, payload: { ...payload, workerId: "wrong-worker" } });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json().code).toBe("WORK_ORDER_CONTEXT_INVALID");
      const changed = await app.inject({ method: "POST", url, payload });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().releasedLeaseTaskKeys).toContain(fx.mainLease.taskKey);
      const replay = await app.inject({ method: "POST", url, payload });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(changed.json());
    } finally { await app.close(); }
  });
});

describe("design change rework", () => {
  it("atomically revises documents, reworks plans, revokes evidence and releases leases", () => {
    const fx = fixture();
    const input = {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Manager",
      reason: "接口边界设计错误", changeSummary: "修订边界并重排计划", requirementImpact: false,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id, fx.acceptedPlan.id],
      reusableWorkSummary: "保留纯展示组件", reworkScope: "接口、计划和测试全部返工",
      apiImpact: "响应契约变化", databaseImpact: "无", deploymentImpact: "需兼容旧客户端",
      expectedUpdatedAt: fx.diagram.updatedAt, idempotencyKey: "change-1",
    };
    const result = requestDesignChange(fx.store, input, { source: "web" });

    expect(result.changeId).toBeTruthy();
    expect(result.nextAction?.code).toBe("approve_node_document");
    expect(fx.store.getDesignDoc(fx.document.id)).toMatchObject({ status: "评审中" });
    expect(fx.store.getDocumentReference(fx.reference.id)?.documentRevisionId).toBe(fx.document.currentRevisionId);
    expect(fx.store.getDesignDoc(fx.document.id)?.currentRevisionId).not.toBe(fx.document.currentRevisionId);
    expect(fx.store.getPlan(fx.activePlan.id)).toMatchObject({ lifecycleStatus: "rework", status: "未开始", progress: 0, proposalRevision: 3 });
    expect(fx.store.getPlan(fx.acceptedPlan.id)?.lifecycleStatus).toBe("accepted");
    const cloned = fx.store.getPlan(result.reworkPlanIds.find((id) => id !== fx.activePlan.id)!);
    expect(cloned).toMatchObject({
      lifecycleStatus: "rework",
      reworkOfPlanId: fx.acceptedPlan.id,
      status: "未开始",
      rejectedBy: "design_change",
      rejectionReason: expect.stringContaining(result.changeId),
    });
    expect(fx.store.listDocumentReferences({ projectId: fx.project.id, targetType: "plan", targetId: cloned!.id }))
      .toEqual([expect.objectContaining({
        documentId: fx.acceptedPlanReference.documentId,
        documentRevisionId: fx.acceptedPlanReference.documentRevisionId,
        relationType: fx.acceptedPlanReference.relationType,
      })]);
    expect(fx.store.getEvidence(fx.evidence.id)).toMatchObject({ status: "revoked" });
    expect(listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.taskKey === fx.lease.taskKey)?.status).toBe("released");
    expect(() => heartbeatAgentTask(fx.store, {
      leaseToken: fx.lease.leaseToken, agentId: "builder-id", idempotencyKey: "heartbeat-after-change",
    })).toThrow(expect.objectContaining({ statusCode: 409, code: "LEASE_LOST" }));
    expect(fx.store.getDiagram(fx.diagram.id)?.nodes.find((node) => node.id === fx.nodeId)).toMatchObject({
      requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "开发中", acceptanceStatus: "未验收",
    });

    const replay = requestDesignChange(fx.store, input, { source: "web" });
    expect(replay).toEqual(result);
    expect(fx.store.listGovernance(fx.project.id).filter((item) => item.id === result.changeId)).toHaveLength(1);
  });

  it("rolls back all changes for a stale diagram revision or cross-project document", () => {
    const fx = fixture();
    expect(() => requestDesignChange(fx.store, {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Manager",
      reason: "错误", changeSummary: "修订", requirementImpact: true,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "全部", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: "stale", idempotencyKey: "stale-change",
    }, { source: "mcp" })).toThrow("刷新影响预览");
    expect(fx.store.getDesignDoc(fx.document.id)).toMatchObject({ status: "已批准", currentRevisionId: fx.document.currentRevisionId });
    expect(fx.store.getPlan(fx.activePlan.id)?.lifecycleStatus).toBe("in_progress");
    expect(fx.store.getEvidence(fx.evidence.id)?.status).toBe("active");
  });

  it("routes impacted requirements through Designer revision before approval", () => {
    const fx = fixture();
    const result = requestDesignChange(fx.store, {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Manager",
      reason: "验收口径错误", changeSummary: "调整业务验收口径", requirementImpact: true,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "需求、设计、计划和验证", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.diagram.updatedAt, idempotencyKey: "requirement-change",
    }, { source: "mcp" });
    expect(result.requirementStatus).toBe("草拟中");
    expect(result.nextAction?.code).toBe("revise_node_requirement");
  });

  it("accepts post-change audit evidence only when it binds the current approved document revision", () => {
    const fx = fixture();
    const result = requestDesignChange(fx.store, {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Manager",
      reason: "设计错误", changeSummary: "修订", requirementImpact: false,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "实现与测试", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.diagram.updatedAt, idempotencyKey: "audit-revision-change",
    }, { source: "web" });
    const approved = fx.store.updateDesignDoc(fx.document.id, { status: "已批准", version: "2.0", content: "新批准设计" })!;
    fx.store.updateDocumentReferenceRevision(fx.reference.id, approved.currentRevisionId);
    fx.store.updatePlan(fx.activePlan.id, {
      lifecycleStatus: "pending_audit", status: "已完成", progress: 100, completedAt: nowIso(),
      auditStatus: "pending", implementationRevision: "new", correlationId: result.changeId,
    });
    fx.store.insertEvidence({
      projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.activePlan.id,
      documentRevisionId: fx.document.currentRevisionId, sourceType: "manual", sourcePath: "stale.json",
      command: "npm test", resultStatus: "pass", summary: "旧版独立测试", details: { auditScope: "implementation", implementationRevision: "old" }, commitSha: "old",
      digest: "old-active", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
    });
    expect(() => transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    })).toThrow("有效通过证据");
    fx.store.insertEvidence({
      projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.activePlan.id,
      documentRevisionId: approved.currentRevisionId, sourceType: "manual", sourcePath: "current.json",
      command: "npm test", resultStatus: "pass", summary: "新版独立测试", details: { auditScope: "implementation", implementationRevision: "new" }, commitSha: "new",
      digest: "new-active", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
    });
    expect(transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    }).lifecycleStatus).toBe("pending_manager");
  });

  it("blocks audit until every impacted document is approved and every scoped reference is current", () => {
    const fx = fixture();
    const secondDocument = fx.store.insertDesignDoc({
      projectId: fx.project.id, category: "接口文档", title: "第二份设计", summary: "旧接口", status: "已批准",
      version: "1.0", author: "Designer", sourceUrl: "", content: "旧接口版本",
    });
    const secondReference = fx.store.insertDocumentReference({
      projectId: fx.project.id, documentId: secondDocument.id, targetType: "diagramNode",
      targetId: fx.nodeId, relationType: "references",
    });
    const result = requestDesignChange(fx.store, {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Manager",
      reason: "多文档设计错误", changeSummary: "同时修订两份设计", requirementImpact: false,
      impactedDocumentIds: [fx.document.id, secondDocument.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "实现与测试", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.diagram.updatedAt, idempotencyKey: "multi-document-audit",
    }, { source: "web" });
    const firstApproved = fx.store.updateDesignDoc(fx.document.id, { status: "已批准", version: "2.0", content: "新设计" })!;
    fx.store.updateDocumentReferenceRevision(fx.reference.id, firstApproved.currentRevisionId);
    fx.store.updatePlan(fx.activePlan.id, {
      lifecycleStatus: "pending_audit", status: "已完成", progress: 100, completedAt: nowIso(),
      auditStatus: "pending", implementationRevision: "multi", correlationId: result.changeId,
    });
    fx.store.insertEvidence({
      projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.activePlan.id,
      documentRevisionId: firstApproved.currentRevisionId, sourceType: "manual", sourcePath: "multi.json",
      command: "npm test", resultStatus: "pass", summary: "多文档独立测试", details: { auditScope: "implementation", implementationRevision: "multi" }, commitSha: "multi",
      digest: "multi", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
    });
    expect(() => transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    })).toThrow("批准全部受影响文档");

    const secondApproved = fx.store.updateDesignDoc(secondDocument.id, { status: "已批准", version: "2.0", content: "新接口" })!;
    expect(() => transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    })).toThrow("刷新其节点/计划引用");

    fx.store.updateDocumentReferenceRevision(secondReference.id, secondApproved.currentRevisionId);
    expect(transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    }).lifecycleStatus).toBe("pending_manager");
  });

  it("audits each plan against its own documents after a cross-node design change", () => {
    const fx = fixture();
    const otherNodeId = "other-change-node";
    fx.store.updateDiagram(fx.diagram.id, { nodes: [...fx.diagram.nodes, {
      id: otherNodeId, kind: "feature", label: "其他节点", description: "独立设计", owner: "Team",
      acceptanceCriteria: "独立验收", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "开发中", acceptanceStatus: "未验收", x: 900, y: 180,
    }] });
    const otherPlan = fx.store.insertPlan({
      ...fx.activePlan, id: undefined, title: "其他节点计划", diagramNodeId: otherNodeId,
    });
    const otherDocument = fx.store.insertDesignDoc({
      projectId: fx.project.id, category: "功能说明", title: "其他节点设计", summary: "独立设计",
      status: "已批准", version: "2.0", author: "Designer", sourceUrl: "", content: "其他节点当前设计",
    });
    fx.store.insertDocumentReference({
      projectId: fx.project.id, documentId: otherDocument.id, targetType: "diagramNode",
      targetId: otherNodeId, relationType: "defines",
    });
    const change = fx.store.insertGovernance({
      projectId: fx.project.id, type: "decision", title: "设计变更 · 跨节点", status: "有效",
      content: JSON.stringify({ impactedDocumentIds: [fx.document.id, otherDocument.id],
        impactedPlanIds: [fx.activePlan.id, otherPlan.id] }), rationale: "两个节点分别修订", author: "Main Agent",
    });
    fx.store.updatePlan(fx.activePlan.id, {
      lifecycleStatus: "pending_audit", status: "已完成", progress: 100, completedAt: nowIso(),
      auditStatus: "pending", implementationRevision: "cross-node", correlationId: change.id,
      designRevisionIds: [fx.document.currentRevisionId],
    });
    fx.store.insertEvidence({
      projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.activePlan.id,
      documentRevisionId: fx.document.currentRevisionId, sourceType: "manual", sourcePath: "cross-node.json",
      command: "npm test", resultStatus: "pass", summary: "当前节点独立审计",
      details: { auditScope: "implementation", implementationRevision: "cross-node" }, commitSha: "cross-node",
      digest: "cross-node", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
    });
    expect(transitionPlanLifecycle(fx.store, fx.activePlan.id, {
      action: "pass_audit", actor: "Auditor", agentId: "auditor-id",
    }).lifecycleStatus).toBe("pending_manager");
  });
});


describe("preflight design gap", () => {
  const context = (lease: ReturnType<typeof claimAgentTask>) => ({
    workOrderId: lease.workOrderId, leaseToken: lease.leaseToken, taskKey: lease.taskKey,
    taskRevision: lease.taskRevision, workerId: lease.workerId, agentId: lease.agentId, role: lease.role,
  });
  it("stales an overlapping intent when Builder reports a newer design gap", () => {
    const fx = fixture();
    const intent = submitDesignChangeIntent(fx.store, {
      projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, rootPlanId: fx.acceptedPlan.id,
      reason: "已验收范围需要调整", changeSummary: "修订接口", expectedUpdatedAt: fx.diagram.updatedAt,
      idempotencyKey: "intent-before-gap",
    });
    reportDesignGap(fx.store, { ...context(fx.lease), error: "施工发现新设计缺口",
      idempotencyKey: "report-after-intent" });
    expect(fx.store.db.prepare("SELECT status FROM design_change_intents WHERE id=?").get(intent.intentId))
      .toEqual({ status: "stale" });
    const approvals = buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
      .filter((task) => task.actionCode === "request_design_change");
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((task) => task.correlationId.startsWith("design-gap:"))).toBe(true);
  });
  it("reports an in-progress reopen_rework gap once and exposes independent approval", () => {
    const fx = fixture();
    releaseAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "release-before-rework" });
    fx.store.updatePlan(fx.activePlan.id, { lifecycleStatus: "audit_failed", status: "已完成", auditStatus: "failed" });
    const lease = claimAgentTask(fx.store, { projectId: fx.project.id, taskId: `development:${fx.activePlan.id}`,
      role: "builder", agentId: "builder-id", workerId: "rework-builder", idempotencyKey: "claim-rework" });
    expect(lease.actionCode).toBe("reopen_rework");
    startAgentTask(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId, idempotencyKey: "start-rework" });
    const approvedInput = { ...context(lease), error: "返工时发现新接口边界", idempotencyKey: "report-rework" };
    expect(() => reportDesignGap(fx.store, approvedInput)).toThrow();
    expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!)).toBeUndefined();
    expect(listAgentTaskLeases(fx.store, fx.project.id).find((item) => item.workOrderId === lease.workOrderId)?.status).toBe("running");
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval.some((task) => task.actionCode === "request_design_change")).toBe(false);
    transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "reopen_rework", actor: "Builder", agentId: lease.agentId });
    expect(reportDesignGap(fx.store, approvedInput).status).toBe("released");
    expect(reportDesignGap(fx.store, approvedInput).workOrderId).toBe(lease.workOrderId);
    expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!)).toEqual({
      id: lease.workOrderId, reason: approvedInput.error, impactedPlanIds: [fx.activePlan.id],
    });
    const approvals = buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
      .filter((task) => task.planItemId === fx.activePlan.id && task.actionCode === "request_design_change");
    expect(approvals).toHaveLength(1);
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.development.some((task) => task.planItemId === fx.activePlan.id)).toBe(false);
    expect(() => reportDesignGap(fx.store, { ...approvedInput, error: "另一缺口" })).toThrow();
    expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!)?.id).toBe(lease.workOrderId);
  });
  it("rejects invalid reopen_rework reports without releasing a gap or approval", () => {
    const cases: Array<{ name: string; change: (fx: ReturnType<typeof fixture>, lease: ReturnType<typeof claimAgentTask>, input: ReturnType<typeof context>) => void }> = [
      { name: "approved before start", change: (fx) => { fx.store.updatePlan(fx.activePlan.id, { lifecycleStatus: "approved" }); } },
      { name: "wrong worker", change: (_fx, _lease, input) => { input.workerId = "forged"; } },
      { name: "wrong role", change: (_fx, _lease, input) => { input.role = "auditor"; } },
      { name: "wrong queue", change: (fx, lease) => { fx.store.db.prepare("UPDATE agent_task_leases SET queue='audit' WHERE id=?").run(lease.workOrderId); } },
      { name: "wrong action", change: (fx, lease) => { fx.store.db.prepare("UPDATE agent_task_leases SET action_code='audit_design' WHERE id=?").run(lease.workOrderId); } },
      { name: "wrong scope", change: (fx, lease) => { fx.store.db.prepare("UPDATE agent_task_leases SET work_scopes_json='[]' WHERE id=?").run(lease.workOrderId); } },
      { name: "wrong revision", change: (_fx, _lease, input) => { input.taskRevision = "stale"; } },
      { name: "wrong project", change: (fx, lease) => { fx.store.db.prepare("UPDATE agent_task_leases SET project_id='other-project' WHERE id=?").run(lease.workOrderId); } },
      { name: "expired lease", change: (fx, lease) => { fx.store.db.prepare("UPDATE agent_task_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(lease.workOrderId); } },
      { name: "terminal lease", change: (fx, lease) => { releaseAgentTask(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId, idempotencyKey: "release-before-report" }); } },
      { name: "missing impacted plan", change: (_fx, _lease, input) => { Object.assign(input, { impactedPlanIds: ["missing-plan"] }); } },
      { name: "cross-project impacted plan", change: (fx, _lease, input) => {
        const other = fx.store.insertProject({ ...fx.project, id: undefined, code: "OTHER" });
        const plan = fx.store.insertPlan({ ...fx.activePlan, id: undefined, projectId: other.id, title: "异项目计划" });
        Object.assign(input, { impactedPlanIds: [plan.id] });
      } },
      { name: "non-executable impacted plan", change: (fx, _lease, input) => {
        const goal = fx.store.insertPlan({ ...fx.activePlan, id: undefined, kind: "goal", title: "不可施工目标" });
        Object.assign(input, { impactedPlanIds: [goal.id] });
      } },
    ];
    for (const testCase of cases) {
      const fx = fixture();
      releaseAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "release-before-rework" });
      fx.store.updatePlan(fx.activePlan.id, { lifecycleStatus: "audit_failed", status: "已完成", auditStatus: "failed" });
      const lease = claimAgentTask(fx.store, { projectId: fx.project.id, taskId: `development:${fx.activePlan.id}`,
        role: "builder", agentId: "builder-id", workerId: `rework-${testCase.name}`, idempotencyKey: "claim-rework" });
      startAgentTask(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId, idempotencyKey: "start-rework" });
      transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "reopen_rework", actor: "Builder", agentId: lease.agentId });
      const input = context(lease);
      testCase.change(fx, lease, input);
      expect(() => reportDesignGap(fx.store, { ...input, error: testCase.name, idempotencyKey: `report-${testCase.name}` }), testCase.name).toThrow();
      expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!), testCase.name).toBeUndefined();
      expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
        .some((task) => task.planItemId === fx.activePlan.id && task.actionCode === "request_design_change"), testCase.name).toBe(false);
      expect(designChangeRequestCount(fx.store), testCase.name).toBe(0);
      const row = fx.store.db.prepare("SELECT status, last_error FROM agent_task_leases WHERE id=?")
        .get(lease.workOrderId) as { status: string; last_error: string };
      expect(row.status, testCase.name).toBe(testCase.name === "terminal lease" ? "released" : testCase.name === "expired lease" ? "expired" : "running");
      expect(row.last_error, testCase.name).not.toMatch(/^design_gap:/);
    }
  });
  it("reports atomically, rejects old construction and routes independent approval back to Designer", () => {
    const fx = fixture();
    const report = { ...context(fx.lease), error: "新接口边界尚未登记到设计", idempotencyKey: "report-gap" };
    expect(reportDesignGap(fx.store, report).status).toBe("released");
    expect(reportDesignGap(fx.store, report).workOrderId).toBe(fx.lease.workOrderId);
    expect(getEvidenceRepairState(fx.store, fx.activePlan.id)).toBeNull();
    const queues = buildAgentOrchestration(fx.store, fx.project.id)!.queues;
    expect(queues.development.some((task) => task.planItemId === fx.activePlan.id)).toBe(false);
    expect(queues.approval.find((task) => task.planItemId === fx.activePlan.id)?.actionCode).toBe("request_design_change");
    expect(() => startAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "old-start" })).toThrow();
    expect(() => transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "complete_development", actor: "Builder", agentId: "builder-id" })).toThrow(/缺口|新接口/);
    const main = claimAgentTask(fx.store, { projectId: fx.project.id, role: "approver", agentId: "Main Agent",
      workerId: "gap-main", sessionId: "gap-main-session", runId: "gap-main-run", idempotencyKey: "claim-gap-main" });
    const input = { projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Main Agent",
      reason: "补齐接口设计", changeSummary: "更新设计", requirementImpact: false,
      impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.activePlan.id], reusableWorkSummary: "",
      reworkScope: "补齐设计并重新审计批准", apiImpact: "接口边界", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt, idempotencyKey: "gap-change" };
    expect(requestDesignChange(fx.store, input, { source: "mcp", agent: context(main) }).changeId).toBeTruthy();
    expect(fx.store.getPlan(fx.activePlan.id)?.lifecycleStatus).toBe("rework");
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.design.some((task) => task.planItemId === fx.activePlan.id)).toBe(true);
    const revised = fx.store.updateDesignDoc(fx.document.id, { status: "已批准", content: "补齐接口后的设计", version: "2.0" })!;
    fx.store.updateDocumentReferenceRevision(fx.reference.id, revised.currentRevisionId);
    transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "submit_plan", actor: "Designer", agentId: "designer-id" });
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.audit.some((task) => task.planItemId === fx.activePlan.id && task.actionCode === "audit_design")).toBe(true);
    expect(() => transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "approve_plan", actor: "Main Agent" })).toThrow(/独立设计审计/);
    fx.store.insertEvidence({ projectId: fx.project.id, nodeId: fx.nodeId, planItemId: fx.activePlan.id,
      documentRevisionId: revised.currentRevisionId, sourceType: "manual", sourcePath: "design-audit.json", command: "review design",
      resultStatus: "pass", summary: "新边界已覆盖", details: { auditScope: "design" }, commitSha: "", digest: "new-design",
      collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id" });
    transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "pass_design_audit", actor: "Auditor", agentId: "auditor-id" });
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval.some((task) => task.planItemId === fx.activePlan.id && task.actionCode === "approve_plan")).toBe(true);
    transitionPlanLifecycle(fx.store, fx.activePlan.id, { action: "approve_plan", actor: "Main Agent" });
    expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!)).toBeUndefined();
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.development.some((task) => task.planItemId === fx.activePlan.id && task.actionCode === "start_development")).toBe(true);

  });

  it("requires one approval lease per impacted node before applying a cross-node design change", () => {
    const fx = fixture();
    updateAgentTaskCapacity(fx.store, fx.project.id, { maxActive: 1, auditorMaxActive: 1 });
    const dependentNodeId = "gap-dependent-node";
    const latest = fx.store.getDiagram(fx.diagram.id)!;
    fx.store.updateDiagram(latest.id, { nodes: [...latest.nodes, {
      id: dependentNodeId, kind: "feature", label: "受影响节点", description: "跨节点设计缺口", owner: "Team",
      acceptanceCriteria: "独立审批", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "已完成", acceptanceStatus: "已通过", x: 920, y: 180,
    }] });
    const dependent = fx.store.insertPlan({
      ...fx.acceptedPlan, id: undefined, title: "受影响计划", diagramNodeId: dependentNodeId,
      dependencyIds: [], correlationId: "gap-dependent",
    });
    const dependentDocument = fx.store.insertDesignDoc({
      projectId: fx.project.id, category: "接口文档", title: "受影响节点设计", summary: "跨节点设计",
      status: "已批准", version: "1.0", author: "Designer", sourceUrl: "", content: "旧跨节点设计",
    });
    fx.store.insertDocumentReference({
      projectId: fx.project.id, documentId: dependentDocument.id, targetType: "diagramNode",
      targetId: dependentNodeId, relationType: "defines",
    });
    const report = { ...context(fx.lease), error: "设计要求修改两个节点但原工单只有根节点范围",
      impactedPlanIds: [fx.activePlan.id, dependent.id], idempotencyKey: "report-cross-node-gap" };
    reportDesignGap(fx.store, report);
    const approvals = buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
      .filter((task) => task.actionCode === "request_design_change");
    expect(approvals.map((task) => task.planItemId).sort()).toEqual([fx.activePlan.id, dependent.id].sort());
    const rootLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: approvals[0].id, role: "approver", agentId: "Main Agent",
      workerId: "gap-main-group", sessionId: "gap-main-session", idempotencyKey: "claim-cross-gap",
    });
    const leases = approvalGroupLeases(fx.store, rootLease);
    expect(leases).toHaveLength(2);
    const input = { projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "Main Agent",
      reason: "补齐跨节点设计", changeSummary: "同步两个节点的接口契约", requirementImpact: false,
      impactedDocumentIds: [fx.document.id, dependentDocument.id], impactedPlanIds: [fx.activePlan.id, dependent.id], reusableWorkSummary: "",
      reworkScope: "重新提交两个节点设计并分别审计批准", apiImpact: "跨节点接口", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt, idempotencyKey: "apply-cross-node-gap" };
    expect(() => requestDesignChange(fx.store, input, { source: "mcp", agent: context(rootLease) }))
      .toThrow(expect.objectContaining({ code: "CROSS_NODE_APPROVAL_REQUIRED" }));
    const credential = registerAgentCredential(fx.store, {
      principalId: "cross-scope-main", agentId: rootLease.agentId, workerId: rootLease.workerId,
      allowedRoles: ["approver"], allowedProjects: [fx.project.id],
    });
    const connectionId = "cross-scope-transport";
    const challenge = beginAgentAuth(fx.store, credential.credentialId, connectionId);
    const timestamp = new Date().toISOString();
    const principal = completeAgentAuth(fx.store, {
      challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion: "1",
      response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
        credential.credentialId, timestamp, "1"),
    });
    const policy = acknowledgeAgentPolicy(fx.store, principal, {
      role: "approver", projectId: fx.project.id, policyVersion: "2.3.0",
    });
    const proofBase = { authSessionToken: principal.authSessionToken, policyAckToken: policy.policyAckToken };
    const root = { ...context(rootLease), ...proofBase };
    const scopes = leases.filter((lease) => lease.workOrderId !== rootLease.workOrderId)
      .map((lease) => ({ ...context(lease), ...proofBase }));
    const proofContext = { source: "mcp" as const, agent: root, scopeApprovals: scopes,
      securityAction: "mcp.request_design_change", securityTarget: "mcp:request_design_change" };
    const digest = designChangeBodyDigest(input, proofContext);
    const nonceByWorkOrder = new Map(leases.map((lease) => [lease.workOrderId, issueOneTimeNonce(fx.store, {
      policyAckToken: policy.policyAckToken, workOrderId: lease.workOrderId,
      action: "mcp.request_design_change", target: "mcp:request_design_change", bodyDigest: digest,
    }).nonceId]));
    const securedRoot = { ...root, nonceId: nonceByWorkOrder.get(root.workOrderId)! };
    expect(() => requestDesignChange(fx.store, input, {
      ...proofContext, agent: securedRoot, scopeApprovals: scopes,
    })).toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    expect(fx.store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?").get(securedRoot.nonceId))
      .toEqual({ consumed_at: "" });
    expect(() => requestDesignChange(fx.store, input, {
      ...proofContext, agent: securedRoot,
      scopeApprovals: scopes.map((scope) => ({ ...scope, nonceId: securedRoot.nonceId })),
    })).toThrow(expect.objectContaining({ code: "TOKEN_REPLAYED" }));
    const securedScopes = scopes.map((scope) => ({ ...scope, nonceId: nonceByWorkOrder.get(scope.workOrderId)! }));
    const securedContext = { ...proofContext, agent: securedRoot, scopeApprovals: securedScopes };
    const result = requestDesignChange(fx.store, input, securedContext);
    expect(requestDesignChange(fx.store, input, securedContext)).toEqual(result);
    expect(fx.store.db.prepare("SELECT COUNT(*) AS count FROM one_time_nonces WHERE consumed_at<>''").get())
      .toEqual({ count: leases.length });
    expect(result.impactedPlanIds.sort()).toEqual([fx.activePlan.id, dependent.id].sort());
    expect(fx.store.getPlan(fx.activePlan.id)?.lifecycleStatus).toBe("rework");
    expect(fx.store.listPlans(fx.project.id).some((plan) => plan.reworkOfPlanId === dependent.id)).toBe(true);
  });

  it("exposes the report through external MCP with lease context and replay", async () => {
    const fx = fixture();
    const client = await LocalMcpClient.connect(() => createMcpServer({ store: fx.store, dataDir: fx.dir }));
    try {
      const payload = { ...context(fx.lease), error: "开工前发现缺失异常路径", idempotencyKey: "mcp-gap" };
      const result = JSON.parse(mcpResultText(await client.callTool("report_design_gap", payload), 100_000));
      expect(result.status).toBe("released");
      expect(JSON.parse(mcpResultText(await client.callTool("report_design_gap", payload), 100_000))).toEqual(result);
    } finally { await client.close(); }
  });

  it("dismisses a reported gap with a new construction generation and rejects forged context", () => {
    const fx = fixture();
    const report = { ...context(fx.lease), error: "疑似遗漏", idempotencyKey: "report-gap" };
    expect(() => reportDesignGap(fx.store, { ...report, workerId: "forged" })).toThrow();
    expect(getDesignGap(fx.store, fx.activePlan)).toBeUndefined();
    reportDesignGap(fx.store, report);
    const main = claimAgentTask(fx.store, { projectId: fx.project.id, role: "approver", agentId: "Main Agent",
      workerId: "gap-main", idempotencyKey: "claim-gap-main" });
    dismissDesignGap(fx.store, { ...context(main), error: "设计已覆盖该边界", idempotencyKey: "dismiss-gap" });
    expect(getDesignGap(fx.store, fx.activePlan)).toBeUndefined();
    const builder = claimAgentTask(fx.store, { projectId: fx.project.id, role: "builder", agentId: "builder-id",
      workerId: "new-builder", idempotencyKey: "claim-after-dismiss" });
    expect(builder.taskRevision).not.toBe(fx.lease.taskRevision);
  });

  it("detects registered revision drift before dispatch and refuses stale starts or dismissal", () => {
    const fx = fixture();
    fx.store.updatePlan(fx.activePlan.id, { designRevisionIds: [fx.document.currentRevisionId] });
    fx.store.updateDesignDoc(fx.document.id, { content: "已补齐的新设计", status: "评审中" });
    expect(getDesignGap(fx.store, fx.store.getPlan(fx.activePlan.id)!)?.id).toMatch(/^revision:/);
    const queues = buildAgentOrchestration(fx.store, fx.project.id)!.queues;
    expect(queues.development.some((task) => task.planItemId === fx.activePlan.id)).toBe(false);
    expect(queues.approval.some((task) => task.actionCode === "request_design_change")).toBe(true);
    expect(() => startAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "stale-start" })).toThrow(/缺口/);
    releaseAgentTask(fx.store, { leaseToken: fx.lease.leaseToken, agentId: fx.lease.agentId, idempotencyKey: "release-stale" });
    const main = claimAgentTask(fx.store, { projectId: fx.project.id, role: "approver", agentId: "Main Agent",
      workerId: "gap-main", idempotencyKey: "claim-gap-main" });
    expect(() => dismissDesignGap(fx.store, { ...context(main), error: "强行恢复", idempotencyKey: "dismiss-drift" })).toThrow(/重新设计审批/);
  });
});


describe("design-gap approval group capacity", () => {
  const context = (lease: ReturnType<typeof claimAgentTask>) => ({
    workOrderId: lease.workOrderId, leaseToken: lease.leaseToken, taskKey: lease.taskKey,
    taskRevision: lease.taskRevision, workerId: lease.workerId, agentId: lease.agentId, role: lease.role,
  });
  function addGroup(fx: ReturnType<typeof fixture>, tag: string, useOriginal = false) {
    const diagram = fx.store.getDiagram(fx.diagram.id)!;
    const nodes = Array.from({ length: 7 }, (_, i) => ({ ...diagram.nodes.find((node) => node.id === fx.nodeId)!,
      id: `${tag}-${i}`, label: `${tag}-${i}` }));
    fx.store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, ...nodes] });
    const plans = nodes.map((node, i) => useOriginal && i === 0 ? fx.activePlan : fx.store.insertPlan({
      ...fx.activePlan, id: undefined, diagramNodeId: node.id, title: `${tag}-${i}`, dependencyIds: [],
    }));
    const builder = useOriginal ? fx.lease : claimAgentTask(fx.store, { projectId: fx.project.id,
      taskId: `development:${plans[0].id}`, role: "builder", agentId: "builder-id",
      workerId: `${tag}-builder`, sessionId: `${tag}-builder`, idempotencyKey: `${tag}-builder` });
    reportDesignGap(fx.store, { ...context(builder), error: tag, impactedPlanIds: plans.map((plan) => plan.id), idempotencyKey: `${tag}-report` });
    return plans;
  }
  const claim = (fx: ReturnType<typeof fixture>, planId: string, tag: string) => claimAgentTask(fx.store, {
    projectId: fx.project.id, taskId: `approval:${planId}`, role: "approver", agentId: "Main Agent",
    workerId: tag, sessionId: tag, idempotencyKey: tag,
  });
  const summary = (fx: ReturnType<typeof fixture>) => decorateAgentOrchestrationWithLeases(fx.store,
    buildAgentOrchestration(fx.store, fx.project.id)!).leaseSummary!;

  it("claims seven scopes as one slot, limits two groups, renews and releases the whole group", () => {
    const fx = fixture();
    updateAgentTaskCapacity(fx.store, fx.project.id, { maxActive: 20, auditorMaxActive: 2 });
    const a = addGroup(fx, "a", true), b = addGroup(fx, "b"), c = addGroup(fx, "c");
    const first = claim(fx, a[0].id, "main-a");
    expect(approvalGroupLeases(fx.store, first)).toHaveLength(7);
    expect(claim(fx, a[0].id, "main-a").workOrderId).toBe(first.workOrderId);
    expect(summary(fx).roleActive.approver).toBe(1);
    const second = claim(fx, b[0].id, "main-b");
    expect(summary(fx).roleActive.approver).toBe(2);
    expect(() => claim(fx, c[0].id, "main-c")).toThrow(expect.objectContaining({ code: "AGENT_CAPACITY_FULL" }));
    heartbeatAgentTask(fx.store, { leaseToken: first.leaseToken, agentId: first.agentId, idempotencyKey: "group-beat", leaseSeconds: 1800 });
    expect(new Set(approvalGroupLeases(fx.store, first).map((lease) => lease.leaseExpiresAt)).size).toBe(1);
    releaseAgentTask(fx.store, { leaseToken: first.leaseToken, agentId: first.agentId, idempotencyKey: "group-release" });
    expect(approvalGroupLeases(fx.store, first).every((lease) => lease.status === "released")).toBe(true);
    expect(summary(fx).roleActive.approver).toBe(1);
    expect(approvalGroupLeases(fx.store, claim(fx, c[0].id, "main-c")).length).toBe(7);
    fx.store.db.prepare("UPDATE agent_task_leases SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(second.workOrderId);
    expireStaleAgentTasks(fx.store, fx.project.id);
    expect(approvalGroupLeases(fx.store, second).every((lease) => lease.status === "expired")).toBe(true);
  });

  it("returns every scope credential in the atomic task package and denies producer reuse", () => {
    const fx = fixture();
    const plans = addGroup(fx, "package", true);
    const input = { projectId: fx.project.id, taskId: `approval:${plans[0].id}`, role: "approver" as const,
      agentId: "Main Agent", workerId: "package-main", idempotencyKey: "package-claim" };
    fx.store.updatePlan(plans[6].id, { roleAssignments: { ...assignments, builder: { agentId: "Main Agent", displayName: "Main Agent" } } });
    expect(() => claimTaskPackage(fx.store, input)).toThrow(expect.objectContaining({ code: "SELF_APPROVAL_FORBIDDEN" }));
    expect(listAgentTaskLeases(fx.store, fx.project.id).filter((lease) => lease.role === "approver")).toHaveLength(0);
    fx.store.updatePlan(plans[6].id, { roleAssignments: assignments });
    const pkg = JSON.parse(claimTaskPackage(fx.store, input));
    expect(pkg.approvalGroupId).toBeTruthy();
    expect(pkg.scopeApprovals).toHaveLength(6);
    expect(new Set([pkg.lease, ...pkg.scopeApprovals].map((lease) => lease.leaseToken)).size).toBe(7);
    const replay = JSON.parse(claimTaskPackage(fx.store, input));
    expect(replay.scopeApprovals).toEqual(pkg.scopeApprovals);
  });

  it("rolls back every lease and resource if a member insert fails", () => {
    const fx = fixture();
    const plans = addGroup(fx, "rollback", true);
    fx.store.db.exec(`CREATE TRIGGER reject_scope BEFORE INSERT ON agent_task_leases
      WHEN NEW.task_id='approval:${plans[6].id}' BEGIN SELECT RAISE(ABORT, 'injected scope failure'); END`);
    expect(() => claim(fx, plans[0].id, "rollback-main")).toThrow(/injected scope failure/);
    expect(listAgentTaskLeases(fx.store, fx.project.id).filter((lease) => lease.role === "approver")).toHaveLength(0);
    expect(fx.store.db.prepare("SELECT COUNT(*) AS n FROM agent_task_resource_locks").get()).toEqual({ n: 0 });
    fx.store.db.exec("DROP TRIGGER reject_scope");
    expect(approvalGroupLeases(fx.store, claim(fx, plans[0].id, "rollback-main"))).toHaveLength(7);
  });

  it("rejects old group revisions and forbids using scope leases for ordinary approval", () => {
    const fx = fixture();
    const plans = addGroup(fx, "drift", true);
    const lease = claim(fx, plans[0].id, "drift-main");
    expect(() => assertAgentTaskLeaseForPlanAction(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId,
      planId: plans[0].id, action: "approve_plan" })).toThrow(expect.objectContaining({ code: "ACTION_MISMATCH" }));
    fx.store.updatePlan(plans[1].id, { proposalRevision: plans[1].proposalRevision + 1 });
    expect(() => heartbeatAgentTask(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId, idempotencyKey: "stale-beat" }))
      .toThrow(expect.objectContaining({ code: "TASK_REVISION_DRIFT" }));
    releaseAgentTask(fx.store, { leaseToken: lease.leaseToken, agentId: lease.agentId, idempotencyKey: "release-drift" });
    expect(approvalGroupLeases(fx.store, lease).every((member) => member.status === "released")).toBe(true);
  });
});
