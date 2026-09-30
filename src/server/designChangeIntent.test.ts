import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, nowIso } from "./db.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";
import { createMcpServer } from "../mcp/index.js";
import { buildAgentOrchestration } from "./orchestration.js";
import { claimTaskPackage } from "./claimTaskPackage.js";
import {
  designChangeBodyDigest,
  dismissDesignChangeIntent,
  dismissDesignChangeIntentBodyDigest,
  requestDesignChange,
} from "./designChange.js";
import { submitDesignChangeIntent } from "./designChangeIntent.js";
import { openEvidenceRepairState, updateEvidenceRepairState } from "./evidenceRepair.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { buildProjectWorkflow } from "./workflow.js";
import {
  acknowledgeAgentPolicy,
  beginAgentAuth,
  completeAgentAuth,
  expectedChallengeResponse,
  issueOneTimeNonce,
  registerAgentCredential,
} from "./agentSecurity.js";

const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-design-intent-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "INTENT", name: "变更意图", summary: "", stage: "维护", health: "正常", progress: 100,
    riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir, startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodeId = "accepted-intent-node";
  const diagram = store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: nodeId, kind: "feature", label: "已验收功能", description: "", owner: "team", acceptanceCriteria: "通过",
    requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "已完成", acceptanceStatus: "已通过",
    deliveryUpdatedAt: nowIso(), x: 600, y: 180,
  }] })!;
  const document = store.insertDesignDoc({
    projectId: project.id, category: "功能说明", title: "冻结设计", summary: "", status: "已批准",
    version: "1.0", author: "designer-id", content: "accepted design",
  });
  store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
  const plan = store.insertPlan({
    projectId: project.id, diagramId: diagram.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "历史计划",
    description: "accepted", status: "已完成", priority: "P1", progress: 100, owner: "builder-id",
    roleAssignments: {
      designer: { agentId: "designer-id", displayName: "Designer" },
      builder: { agentId: "builder-id", displayName: "Builder" },
      auditor: { agentId: "auditor-id", displayName: "Auditor" },
    },
    versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: nowIso(),
    lifecycleStatus: "accepted", proposalRevision: 1, designRevisionIds: [document.currentRevisionId],
    proposedBy: "designer-id", submittedAt: nowIso(), approvedBy: "Main Agent", approvedAt: nowIso(),
    implementationRevision: "nogit-history", completedBy: "builder-id", auditStatus: "passed", auditedBy: "auditor-id",
    auditedAt: nowIso(), managerDecision: "approved", managerDecisionBy: "Main Agent", managerDecisionAt: nowIso(),
  });
  store.insertDocumentReference({
    projectId: project.id, documentId: document.id, documentRevisionId: document.currentRevisionId,
    targetType: "plan", targetId: plan.id, relationType: "implements",
  });
  const evidence = store.insertEvidence({
    projectId: project.id, nodeId, planItemId: plan.id, documentRevisionId: document.currentRevisionId,
    sourceType: "manual", sourcePath: "audit.json", command: "npm test", resultStatus: "pass", summary: "通过",
    details: { auditScope: "implementation", implementationRevision: plan.implementationRevision },
    commitSha: plan.implementationRevision, digest: "audit", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
  });
  return { store, dir, project, diagram, nodeId, document, plan, evidence };
}

function submit(fx: ReturnType<typeof fixture>, idempotencyKey = "intent-1") {
  return submitDesignChangeIntent(fx.store, {
    projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, rootPlanId: fx.plan.id,
    reason: "新增需求", changeSummary: "调整已验收功能", expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt,
    idempotencyKey, requestedBy: "untrusted-name",
  });
}

function claim(fx: ReturnType<typeof fixture>) {
  const task = buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
    .find((item) => item.actionCode === "request_design_change")!;
  const taskPackage = JSON.parse(claimTaskPackage(fx.store, {
    projectId: fx.project.id, role: "approver", agentId: "Main Agent", workerId: "intent-main-worker",
    taskId: task.id, idempotencyKey: "claim-intent", sessionId: "intent-session", runId: "intent-run",
  })) as any;
  return { task, taskPackage, agent: {
    workOrderId: taskPackage.lease.workOrderId, leaseToken: taskPackage.lease.leaseToken,
    taskKey: taskPackage.lease.taskKey, taskRevision: taskPackage.lease.taskRevision,
    workerId: taskPackage.lease.workerId, agentId: taskPackage.lease.agentId, role: "approver",
  } };
}

function formalInput(fx: ReturnType<typeof fixture>, intentId: string) {
  return {
    intentId, projectId: fx.project.id, diagramId: fx.diagram.id, nodeId: fx.nodeId, actor: "spoofed",
    reason: "新增需求", changeSummary: "调整已验收功能", requirementImpact: true,
    impactedDocumentIds: [fx.document.id], impactedPlanIds: [fx.plan.id], reusableWorkSummary: "",
    reworkScope: "重新设计和实现", apiImpact: "", databaseImpact: "", deploymentImpact: "",
    expectedUpdatedAt: fx.store.getDiagram(fx.diagram.id)!.updatedAt, idempotencyKey: "apply-intent",
  };
}

function copyAcceptedPlan(fx: ReturnType<typeof fixture>, nodeId: string, title: string) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...template } = fx.plan;
  return fx.store.insertPlan({ ...template, diagramNodeId: nodeId, title, dependencyIds: [] });
}

function copyReworkPlan(fx: ReturnType<typeof fixture>, acceptedPlanId: string, nodeId: string) {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...template } = fx.plan;
  return fx.store.insertPlan({ ...template, diagramNodeId: nodeId, title: "现有返工", lifecycleStatus: "rework",
    reworkOfPlanId: acceptedPlanId, status: "未开始", progress: 0, implementationRevision: "",
    auditStatus: "failed", approvedAt: "", completedAt: "" });
}

describe("design change intent bootstrap", () => {
  it("retires an earlier rework plan when its successor is accepted", () => {
    const fx = fixture();
    const previous = copyReworkPlan(fx, fx.plan.id, fx.nodeId);
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...template } = fx.plan;
    const successor = fx.store.insertPlan({ ...template, title: "后续返工", reworkOfPlanId: previous.id,
      lifecycleStatus: "pending_manager", implementationRevision: "successor-revision",
      managerDecision: "pending", auditStatus: "passed" });
    fx.store.insertEvidence({ projectId: fx.project.id, nodeId: fx.nodeId, planItemId: successor.id,
      documentRevisionId: fx.document.currentRevisionId, sourceType: "manual", sourcePath: "successor-audit.json",
      command: "npm test", resultStatus: "pass", summary: "后续返工审计通过",
      details: { auditScope: "implementation", implementationRevision: successor.implementationRevision },
      commitSha: successor.implementationRevision, digest: "successor-audit", collectedAt: nowIso(),
      actorRole: "auditor", agentId: "auditor-id" });
    transitionPlanLifecycle(fx.store, successor.id, { action: "approve_acceptance", actor: "Main Agent" });
    expect(fx.store.getPlan(previous.id)?.lifecycleStatus).toBe("superseded");
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.design.some((task) => task.planItemId === previous.id)).toBe(false);
    const workflow = buildProjectWorkflow(fx.store, fx.project.id)!;
    expect(workflow.layerGate.plans.some((plan) => plan.planId === previous.id)).toBe(false);
    expect(workflow.nodes.find((node) => node.nodeId === fx.nodeId)?.nextAction?.entityId).not.toBe(previous.id);
    expect(() => transitionPlanLifecycle(fx.store, previous.id, { action: "submit_plan", actor: "designer-id" })).toThrow("不能执行");
  });
  it("rejects intent execution without the dedicated approval context through REST and trusted MCP", async () => {
    const fx = fixture();
    const intent = submit(fx);
    const input = formalInput(fx, intent.intentId);
    const before = {
      plan: fx.store.getPlan(fx.plan.id), document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.getEvidence(fx.evidence.id), diagram: fx.store.getDiagram(fx.diagram.id),
    };
    const { projectId: _projectId, ...mcpInput } = input;
    const client = await LocalMcpClient.connect(() => createMcpServer({
      store: fx.store, dataDir: fx.dir, trustedInternal: true,
    }));
    try {
      expect(mcpResultText(await client.callTool("request_design_change", {
        ...mcpInput, projectRef: fx.project.id,
      }), 100_000)).toContain("WORK_ORDER_CONTEXT_INVALID");
    } finally { await client.close(); }
    const app = buildApp({ dbPath: join(fx.dir, "test.db"), dataDir: fx.dir, trustedInternalApi: true });
    try {
      await app.ready();
      const response = await app.inject({
        method: "POST", url: `/api/projects/${fx.project.id}/design-changes`, payload: input,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "WORK_ORDER_CONTEXT_INVALID" });
    } finally { await app.close(); }
    expect({
      plan: fx.store.getPlan(fx.plan.id), document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.getEvidence(fx.evidence.id), diagram: fx.store.getDiagram(fx.diagram.id),
    }).toEqual(before);
    expect(fx.store.db.prepare("SELECT status FROM design_change_intents WHERE id=?").get(intent.intentId))
      .toEqual({ status: "pending" });
  });

  it("creates only pending approval work, is idempotent, and preserves accepted artifacts until leased approval applies it", () => {
    const fx = fixture();
    const before = {
      plan: fx.store.getPlan(fx.plan.id), document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.getEvidence(fx.evidence.id), node: fx.store.getDiagram(fx.diagram.id)!.nodes.find((node) => node.id === fx.nodeId),
    };
    const intent = submit(fx);
    expect(submit(fx)).toEqual(intent);
    expect(intent).toMatchObject({ status: "pending", authorizesImplementation: false, approvalTaskIds: [`approval:${fx.plan.id}`] });
    expect({
      plan: fx.store.getPlan(fx.plan.id), document: fx.store.getDesignDoc(fx.document.id),
      evidence: fx.store.getEvidence(fx.evidence.id), node: fx.store.getDiagram(fx.diagram.id)!.nodes.find((node) => node.id === fx.nodeId),
    }).toEqual(before);

    const { task, taskPackage, agent } = claim(fx);
    expect(task).toMatchObject({ correlationId: `design-change-intent:${intent.intentId}`,
      designChangeIntent: { intentId: intent.intentId, rootPlanId: fx.plan.id, snapshotHash: intent.snapshotHash } });
    expect(taskPackage.task.designChangeIntent.impactedPlanIds).toEqual([fx.plan.id]);
    const result = requestDesignChange(fx.store, formalInput(fx, intent.intentId), { source: "mcp", agent });
    expect(result.reworkPlanIds).toHaveLength(1);
    expect(fx.store.getPlan(fx.plan.id)).toMatchObject({ lifecycleStatus: "accepted", implementationRevision: "nogit-history" });
    expect(fx.store.getPlan(result.reworkPlanIds[0])).toMatchObject({
      lifecycleStatus: "rework", implementationRevision: "", approvedAt: "", reworkOfPlanId: fx.plan.id,
    });
    expect(fx.store.getEvidence(fx.evidence.id)).toMatchObject({ status: "revoked" });
  });

  it("includes an existing same-node rework and does not clone its accepted baseline again", () => {
    const fx = fixture();
    const rework = copyReworkPlan(fx, fx.plan.id, fx.nodeId);
    const intent = submit(fx);
    const { taskPackage, agent } = claim(fx);
    expect(taskPackage.task.designChangeIntent.impactedPlanIds).toEqual([fx.plan.id, rework.id].sort());
    const result = requestDesignChange(fx.store, {
      ...formalInput(fx, intent.intentId), impactedPlanIds: [fx.plan.id, rework.id],
    }, { source: "mcp", agent });
    expect(result.reworkPlanIds).toEqual([rework.id]);
    expect(fx.store.getPlan(fx.plan.id)).toMatchObject({ lifecycleStatus: "accepted", implementationRevision: "nogit-history" });
    expect(fx.store.getPlan(rework.id)).toMatchObject({ lifecycleStatus: "rework", implementationRevision: "" });
    expect(fx.store.listPlans(fx.project.id).filter((plan) => plan.reworkOfPlanId === fx.plan.id)).toHaveLength(1);
  });

  it("stales an old intent and dispatches both nodes when a dependent node gains active rework", () => {
    const fx = fixture();
    const old = submit(fx, "before-dependent-rework");
    const { agent } = claim(fx);
    const dependentNodeId = "dependent-rework-node";
    const latest = fx.store.getDiagram(fx.diagram.id)!;
    fx.store.updateDiagram(latest.id, { nodes: [...latest.nodes, {
      id: dependentNodeId, kind: "feature", label: "依赖功能", description: "", owner: "team", acceptanceCriteria: "通过",
      requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "已完成", acceptanceStatus: "已通过",
      deliveryUpdatedAt: nowIso(), x: 920, y: 180,
    }] });
    const dependent = copyAcceptedPlan(fx, dependentNodeId, "依赖计划");
    fx.store.updatePlan(dependent.id, { dependencyIds: [fx.plan.id] });
    const rework = copyReworkPlan(fx, dependent.id, dependentNodeId);
    const fresh = submit(fx, "after-dependent-rework");
    expect(fresh.intentId).not.toBe(old.intentId);
    expect(fx.store.db.prepare("SELECT status FROM design_change_intents WHERE id=?").get(old.intentId))
      .toEqual({ status: "stale" });
    expect(fx.store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(agent.workOrderId))
      .toEqual({ status: "released" });
    const approvals = buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
      .filter((task) => task.correlationId === `design-change-intent:${fresh.intentId}`);
    expect(approvals).toHaveLength(2);
    expect(new Set(approvals.map((task) => task.nodeId))).toEqual(new Set([fx.nodeId, dependentNodeId]));
    expect(approvals.map((task) => task.designChangeIntent!.impactedPlanIds).every((ids) =>
      ids.join("\u001f") === [fx.plan.id, dependent.id, rework.id].sort().join("\u001f"))).toBe(true);
  });

  it("requires enrolled proof at MCP entry, rejects a mismatched digest, and permits authenticated REST replay", async () => {
    const fx = fixture();
    const intent = submit(fx);
    const { agent } = claim(fx);
    const credential = registerAgentCredential(fx.store, {
      principalId: "principal-main", agentId: agent.agentId, workerId: agent.workerId,
      allowedRoles: ["approver"], allowedProjects: [fx.project.id],
    });
    const connectionId = "intent-transport-connection";
    const challenge = beginAgentAuth(fx.store, credential.credentialId, connectionId);
    const timestamp = new Date().toISOString();
    const authenticated = completeAgentAuth(fx.store, {
      challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion: "1",
      response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
        credential.credentialId, timestamp, "1"),
    });
    const policy = acknowledgeAgentPolicy(fx.store, authenticated, { role: "approver", projectId: fx.project.id, policyVersion: "2.3.0" });
    const input = formalInput(fx, intent.intentId);
    expect(() => requestDesignChange(fx.store, input, { source: "mcp", agent }))
      .toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    const proofAgent = { ...agent, authSessionToken: authenticated.authSessionToken, policyAckToken: policy.policyAckToken };
    const context = { source: "mcp" as const, agent: proofAgent,
      securityAction: "mcp.request_design_change", securityTarget: "mcp:request_design_change" };
    const mismatched = issueOneTimeNonce(fx.store, {
      policyAckToken: policy.policyAckToken, workOrderId: agent.workOrderId,
      action: "mcp.request_design_change", target: "mcp:request_design_change", bodyDigest: "0".repeat(64),
    });
    const { projectId: _projectId, ...mcpInput } = input;
    const client = await LocalMcpClient.connect(() => createMcpServer({ store: fx.store, dataDir: fx.dir }));
    try {
      const denied = await client.callTool("request_design_change", {
        ...mcpInput, projectRef: fx.project.id, ...proofAgent, nonceId: mismatched.nonceId,
      });
      expect(mcpResultText(denied, 100_000)).toContain("TOKEN_REPLAYED");
      expect(fx.store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?").get(mismatched.nonceId))
        .toEqual({ consumed_at: "" });
    } finally { await client.close(); }
    const nonce = issueOneTimeNonce(fx.store, {
      policyAckToken: policy.policyAckToken, workOrderId: agent.workOrderId,
      action: "mcp.request_design_change", target: "mcp:request_design_change",
      bodyDigest: designChangeBodyDigest(input, context),
    });
    const external = await LocalMcpClient.connect(() => createMcpServer({ store: fx.store, dataDir: fx.dir }));
    let result: Record<string, unknown> = {};
    try {
      result = JSON.parse(mcpResultText(await external.callTool("request_design_change", {
        ...mcpInput, projectRef: fx.project.id, ...proofAgent, nonceId: nonce.nonceId,
      }), 100_000));
    } finally { await external.close(); }
    expect(fx.store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?").get(nonce.nonceId))
      .toEqual({ consumed_at: expect.stringMatching(/\S/) });
    const app = buildApp({ dbPath: join(fx.dir, "test.db"), dataDir: fx.dir });
    try {
      await app.ready();
      const replay = await app.inject({
        method: "POST", url: `/api/projects/${fx.project.id}/design-changes`,
        payload: { ...input, ...agent, authSessionToken: authenticated.authSessionToken },
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual(result);
    } finally { await app.close(); }
  });

  it("marks a drifted pending intent stale only on resubmission and releases its old approval lease", () => {
    const fx = fixture();
    const old = submit(fx);
    const { agent } = claim(fx);
    fx.store.updatePlan(fx.plan.id, { description: "server-side revision drift" });
    expect(buildAgentOrchestration(fx.store, fx.project.id)!.queues.approval
      .some((task) => task.correlationId === `design-change-intent:${old.intentId}`)).toBe(false);
    const fresh = submit(fx, "intent-after-drift");
    expect(fresh.intentId).not.toBe(old.intentId);
    const lease = fx.store.db.prepare("SELECT status, last_error FROM agent_task_leases WHERE id=?").get(agent.workOrderId) as Record<string, string>;
    expect(lease).toMatchObject({ status: "released", last_error: `design_change_intent_stale:${old.intentId}` });
    expect(fx.store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks WHERE lease_token=?").get(agent.leaseToken))
      .toEqual({ count: 0 });
    expect(fx.store.db.prepare("SELECT status FROM agent_task_workspace_reservations WHERE lease_token=?").get(agent.leaseToken))
      .toEqual({ status: "released" });
    expect(fx.store.db.prepare("SELECT status FROM design_change_intents WHERE id=?").get(old.intentId)).toEqual({ status: "stale" });
  });

  it("requires enrolled proof for dismiss and replays without consuming the nonce twice", () => {
    const fx = fixture();
    const intent = submit(fx);
    const { agent } = claim(fx);
    const credential = registerAgentCredential(fx.store, {
      principalId: "dismiss-main", agentId: agent.agentId, workerId: agent.workerId,
      allowedRoles: ["approver"], allowedProjects: [fx.project.id],
    });
    const connectionId = "dismiss-transport-connection";
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
    const input = {
      projectId: fx.project.id, intentId: intent.intentId, reason: "需求不再继续", idempotencyKey: "dismiss-intent",
    };
    const proofAgent = { ...agent, authSessionToken: principal.authSessionToken, policyAckToken: policy.policyAckToken };
    const context = { source: "mcp" as const, agent: proofAgent,
      securityAction: "mcp.dismiss_design_change_intent", securityTarget: "mcp:dismiss_design_change_intent" };
    expect(() => dismissDesignChangeIntent(fx.store, input, context))
      .toThrow(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    const nonce = issueOneTimeNonce(fx.store, {
      policyAckToken: policy.policyAckToken, workOrderId: agent.workOrderId,
      action: "mcp.dismiss_design_change_intent", target: "mcp:dismiss_design_change_intent",
      bodyDigest: dismissDesignChangeIntentBodyDigest(input, context),
    });
    const secured = { ...context, agent: { ...proofAgent, nonceId: nonce.nonceId } };
    const result = dismissDesignChangeIntent(fx.store, input, secured);
    expect(result).toMatchObject({ intentId: intent.intentId, status: "dismissed", authorizesImplementation: false });
    expect(dismissDesignChangeIntent(fx.store, input, secured)).toEqual(result);
    expect(fx.store.getPlan(fx.plan.id)).toMatchObject({ lifecycleStatus: "accepted", implementationRevision: "nogit-history" });
  });

  it("rejects cross-project, stale-version, idempotency-conflict, and overlapping pending submissions", () => {
    const cross = fixture();
    const foreign = cross.store.insertProject({
      code: "FOREIGN", name: "外部项目", summary: "", stage: "维护", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    expect(() => submitDesignChangeIntent(cross.store, {
      projectId: foreign.id, diagramId: cross.diagram.id, nodeId: cross.nodeId, rootPlanId: cross.plan.id,
      reason: "跨项目", changeSummary: "不得接受", expectedUpdatedAt: cross.diagram.updatedAt, idempotencyKey: "cross-project",
    })).toThrow(expect.objectContaining({ code: "DIAGRAM_PROJECT_MISMATCH" }));

    const stale = fixture();
    expect(() => submitDesignChangeIntent(stale.store, {
      projectId: stale.project.id, diagramId: stale.diagram.id, nodeId: stale.nodeId, rootPlanId: stale.plan.id,
      reason: "旧版本", changeSummary: "不得覆盖", expectedUpdatedAt: "stale", idempotencyKey: "stale-version",
    })).toThrow(expect.objectContaining({ code: "DIAGRAM_REVISION_CONFLICT" }));

    const duplicate = fixture();
    submit(duplicate, "same-key");
    expect(() => submitDesignChangeIntent(duplicate.store, {
      projectId: duplicate.project.id, diagramId: duplicate.diagram.id, nodeId: duplicate.nodeId, rootPlanId: duplicate.plan.id,
      reason: "不同内容", changeSummary: "冲突", expectedUpdatedAt: duplicate.store.getDiagram(duplicate.diagram.id)!.updatedAt,
      idempotencyKey: "same-key",
    })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(() => submit(duplicate, "overlapping-key"))
      .toThrow(expect.objectContaining({ code: "DESIGN_CHANGE_INTENT_PENDING" }));
  });

  it("conflicts on actual node scope while keeping disjoint nodes independent", () => {
    const sameNode = fixture();
    submit(sameNode, "node-scope-first");
    const sibling = copyAcceptedPlan(sameNode, sameNode.nodeId, "同节点独立计划");
    expect(() => submitDesignChangeIntent(sameNode.store, {
      projectId: sameNode.project.id, diagramId: sameNode.diagram.id, nodeId: sameNode.nodeId,
      rootPlanId: sibling.id, reason: "同节点第二项", changeSummary: "不得并发",
      expectedUpdatedAt: sameNode.store.getDiagram(sameNode.diagram.id)!.updatedAt, idempotencyKey: "node-scope-second",
    })).toThrow(expect.objectContaining({ code: "DESIGN_CHANGE_INTENT_PENDING" }));

    const disjoint = fixture();
    const secondNodeId = "accepted-disjoint-node";
    disjoint.store.updateDiagram(disjoint.diagram.id, { nodes: [...disjoint.store.getDiagram(disjoint.diagram.id)!.nodes, {
      id: secondNodeId, kind: "feature", label: "不相交功能", description: "", owner: "team", acceptanceCriteria: "通过",
      requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "已完成", acceptanceStatus: "已通过",
      deliveryUpdatedAt: nowIso(), x: 900, y: 180,
    }] });
    const disjointPlan = copyAcceptedPlan(disjoint, secondNodeId, "不相交计划");
    submit(disjoint, "disjoint-first");
    expect(submitDesignChangeIntent(disjoint.store, {
      projectId: disjoint.project.id, diagramId: disjoint.diagram.id, nodeId: secondNodeId,
      rootPlanId: disjointPlan.id, reason: "独立节点", changeSummary: "允许独立申请",
      expectedUpdatedAt: disjoint.store.getDiagram(disjoint.diagram.id)!.updatedAt, idempotencyKey: "disjoint-second",
    })).toMatchObject({ status: "pending" });
  });

  it("rejects same-node gap and repair design-change paths owned by other plans", () => {
    const gapFx = fixture();
    const gapPlan = copyAcceptedPlan(gapFx, gapFx.nodeId, "同节点缺口计划");
    gapFx.store.updatePlan(gapPlan.id, { lifecycleStatus: "approved", designRevisionIds: ["missing-revision"] });
    expect(() => submit(gapFx, "conflicting-gap"))
      .toThrow(expect.objectContaining({ code: "DESIGN_CHANGE_PATH_CONFLICT" }));

    const repairFx = fixture();
    const repairPlan = copyAcceptedPlan(repairFx, repairFx.nodeId, "同节点修复计划");
    openEvidenceRepairState(repairFx.store, repairPlan, 3);
    updateEvidenceRepairState(repairFx.store, repairPlan.id, {
      status: "assessed", disposition: "design_change:需要重设计",
    });
    expect(() => submit(repairFx, "conflicting-repair"))
      .toThrow(expect.objectContaining({ code: "DESIGN_CHANGE_PATH_CONFLICT" }));
  });
});
