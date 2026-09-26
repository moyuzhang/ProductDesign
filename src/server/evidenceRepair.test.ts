import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanItem } from "../shared/types.js";
import { Store, nowIso } from "./db.js";
import { buildApp } from "./index.js";
import { buildProjectWorkflow } from "./workflow.js";
import { buildAgentOrchestration } from "./orchestration.js";
import {
  advanceAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForPlanAction,
  claimAgentTask,
  evidenceRepairStartBodyDigest,
  failAgentTask,
  listClaimableAgentTasks,
  startAgentTask,
} from "./agentTaskLeases.js";
import {
  failEvidenceRepairAttempt,
  getEvidenceRepairState,
  openEvidenceRepairState,
  requestEvidenceRepairAssessment,
  resetImplementationBaseline,
  updateEvidenceRepairState,
} from "./evidenceRepair.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { createMcpServer } from "../mcp/index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";
import {
  acknowledgeAgentPolicy,
  beginAgentAuth,
  completeAgentAuth,
  expectedChallengeResponse,
  issueOneTimeNonce,
  registerAgentCredential,
} from "./agentSecurity.js";

const resources: Array<{ store: Store; dir: string }> = [];
const roleAssignments = {
  designer: { agentId: "designer-id", displayName: "Designer" },
  builder: { agentId: "builder-id", displayName: "Builder" },
  auditor: { agentId: "auditor-id", displayName: "Auditor" },
};

function insertAuditorEvidence(store: Store, projectId: string, nodeId: string, plan: PlanItem) {
  return store.insertEvidence({
    projectId, nodeId, planItemId: plan.id, sourceType: "manual", sourcePath: "audit.txt",
    command: `npm test -- audit-${plan.id}`, resultStatus: "pass", summary: "独立审计通过",
    details: { auditScope: "implementation", implementationRevision: plan.implementationRevision },
    commitSha: plan.implementationRevision, digest: `audit-${plan.id}`, collectedAt: nowIso(),
    actorRole: "auditor", agentId: "auditor-id",
  });
}

function acceptedFixture(extraPlans = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pcs-evidence-repair-"));
  execFileSync("git", ["init", dir], { windowsHide: true });
  execFileSync("git", ["-C", dir, "config", "user.email", "repair@example.test"], { windowsHide: true });
  execFileSync("git", ["-C", dir, "config", "user.name", "Repair Test"], { windowsHide: true });
  writeFileSync(join(dir, "implementation.txt"), "accepted implementation\n");
  execFileSync("git", ["-C", dir, "add", "implementation.txt"], { windowsHide: true });
  execFileSync("git", ["-C", dir, "commit", "-m", "fixture"], { windowsHide: true });
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "REPAIR", name: "证据修复", summary: "验证已验收节点证据修复", stage: "测试", health: "正常",
    progress: 100, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const brief = store.insertDesignDoc({
    projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
    version: "1.0", author: "owner", content: "证据必须精确归属",
  });
  store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodeId = "accepted-gap";
  store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: nodeId, kind: "feature", label: "已验收证据缺口", description: "修复旧节点证据", owner: "team",
    acceptanceCriteria: "证据绑定当前实现", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "已完成", acceptanceStatus: "已通过", x: 620, y: 160,
  }] });
  const design = store.insertDesignDoc({
    projectId: project.id, category: "功能说明", title: "设计", summary: "", status: "已批准",
    version: "1.0", author: "designer-id", content: "证据修复设计",
  });
  store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
  const insertAccepted = (suffix: string) => store.insertPlan({
    projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: `已验收计划${suffix}`,
    description: "", status: "已完成", priority: "P0", progress: 100, owner: "builder-id", roleAssignments,
    versionTag: "v1", startAt: "2026-09-01", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: nowIso(),
    lifecycleStatus: "accepted", proposalRevision: 1, designRevisionIds: [design.currentRevisionId],
    proposedBy: "designer-id", submittedAt: nowIso(), approvedBy: "Main Agent", approvedAt: nowIso(),
    implementationRevision: head, completedBy: "builder-id", auditStatus: "passed",
    auditedBy: "auditor-id", auditedAt: nowIso(), managerDecision: "approved", managerDecisionBy: "Main Agent", managerDecisionAt: nowIso(),
  });
  const plan = insertAccepted("");
  const plans = [plan];
  for (let index = 0; index < extraPlans; index += 1) plans.push(insertAccepted(`-${index}`));
  return { store, project, main, nodeId, plan, plans, head };
}

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("accepted evidence repair", () => {
  it("keeps a normally closed accepted node closed when strict current evidence exists", () => {
    const { store, project, plan, nodeId } = acceptedFixture();
    insertAuditorEvidence(store, project.id, nodeId, plan);
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ status: "completed", nextAction: null });
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
  });

  it("creates exactly one Builder repair order from workflow.entityId", () => {
    const { store, project, plan } = acceptedFixture();
    const workflow = buildProjectWorkflow(store, project.id)!;
    expect(workflow).toMatchObject({ status: "ready", nextAction: { code: "submit_evidence_repair", entityId: plan.id } });
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
    openEvidenceRepairState(store, plan, 3);
    const orchestration = buildAgentOrchestration(store, project.id)!;
    expect(orchestration.queues.development.filter((task) => task.actionCode === "submit_evidence_repair"))
      .toEqual([expect.objectContaining({ id: `development:${plan.id}`, planItemId: plan.id })]);
    expect(listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "submit_evidence_repair"))
      .toMatchObject({ taskRevision: `1:submit_evidence_repair:repair:0`, requiredRole: "builder", available: true });
  });

  it("dispatches a repair task while deriving the missing durable state row", () => {
    const { store, project, plan } = acceptedFixture();
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
    expect(buildAgentOrchestration(store, project.id)!.queues.development
      .some((task) => task.planItemId === plan.id && task.actionCode === "submit_evidence_repair")).toBe(true);
    expect(listClaimableAgentTasks(store, project.id)
      .find((task) => task.planItemId === plan.id && task.actionCode === "submit_evidence_repair"))
      .toMatchObject({ taskRevision: `1:submit_evidence_repair:repair:0`, requiredRole: "builder", available: true });
  });

  it("tolerates a missing state row while recording a stale repair attempt", () => {
    const { store, plan } = acceptedFixture();
    expect(() => failEvidenceRepairAttempt(store, plan.id, 1, 3, "lease_expired")).not.toThrow();
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ status: "open", attemptCount: 1, maxAttempts: 3 });
    expect(updateEvidenceRepairState(store, plan.id, { status: "exhausted", attemptCount: 3, disposition: "attempts_exhausted:test" }))
      .toMatchObject({ status: "exhausted", attemptCount: 3 });
  });

  it("keeps workflow inspection read-only before repair state is materialized", () => {
    const { store, project, plan } = acceptedFixture();
    const beforeChanges = (store.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    const beforeRows = (store.db.prepare("SELECT COUNT(*) AS count FROM evidence_repair_state").get() as { count: number }).count;
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "submit_evidence_repair", entityId: plan.id } });
    const afterChanges = (store.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
    const afterRows = (store.db.prepare("SELECT COUNT(*) AS count FROM evidence_repair_state").get() as { count: number }).count;
    expect({ afterChanges, afterRows }).toEqual({ afterChanges: beforeChanges, afterRows: beforeRows });
  });

  it("computes strict Auditor gaps independently for every accepted plan", () => {
    const oneGap = acceptedFixture(1);
    insertAuditorEvidence(oneGap.store, oneGap.project.id, oneGap.nodeId, oneGap.plans[0]);
    expect(buildProjectWorkflow(oneGap.store, oneGap.project.id)).toMatchObject({
      nextAction: { code: "submit_evidence_repair", entityId: oneGap.plans[1].id },
    });

    const noGap = acceptedFixture(1);
    for (const plan of noGap.plans) insertAuditorEvidence(noGap.store, noGap.project.id, noGap.nodeId, plan);
    expect(buildProjectWorkflow(noGap.store, noGap.project.id)).toMatchObject({ status: "completed", nextAction: null });

    const builderOnly = acceptedFixture();
    builderOnly.store.insertEvidence({
      projectId: builderOnly.project.id, nodeId: builderOnly.nodeId, planItemId: builderOnly.plan.id,
      sourceType: "manual", sourcePath: "builder.txt", command: "npm test -- builder", resultStatus: "pass",
      summary: "Builder 测试通过", details: { auditScope: "implementation", implementationRevision: builderOnly.head },
      commitSha: builderOnly.head, digest: "builder", collectedAt: nowIso(), actorRole: "builder", agentId: "builder-id",
    });
    expect(buildProjectWorkflow(builderOnly.store, builderOnly.project.id)).toMatchObject({
      nextAction: { code: "submit_evidence_repair", entityId: builderOnly.plan.id },
    });
  });

  it("严格证据只检查已验收返工链的叶子计划", () => {
    const acceptedSuccessor = acceptedFixture(1);
    acceptedSuccessor.store.updatePlan(acceptedSuccessor.plans[1].id, { reworkOfPlanId: acceptedSuccessor.plans[0].id });
    insertAuditorEvidence(acceptedSuccessor.store, acceptedSuccessor.project.id, acceptedSuccessor.nodeId, acceptedSuccessor.plans[1]);
    expect(buildProjectWorkflow(acceptedSuccessor.store, acceptedSuccessor.project.id))
      .toMatchObject({ status: "completed", nextAction: null });

    const unfinishedSuccessor = acceptedFixture(1);
    unfinishedSuccessor.store.updatePlan(unfinishedSuccessor.plans[1].id, {
      lifecycleStatus: "rework", reworkOfPlanId: unfinishedSuccessor.plans[0].id,
    });
    expect(buildProjectWorkflow(unfinishedSuccessor.store, unfinishedSuccessor.project.id)?.nodes[0]?.missing)
      .toContain("通过的验收证据");
  });

  it("repairs multiple accepted-plan evidence gaps one plan at a time in stable order", () => {
    const { store, project, nodeId, plans } = acceptedFixture(1);
    const [first, second] = [...plans].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const workflow = buildProjectWorkflow(store, project.id)!;
    expect(workflow).toMatchObject({ status: "ready", nextAction: { code: "submit_evidence_repair", entityId: first.id } });
    expect(buildAgentOrchestration(store, project.id)!.queues.development.filter((task) => task.actionCode === "submit_evidence_repair"))
      .toEqual([expect.objectContaining({ planItemId: first.id })]);
    expect(listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "submit_evidence_repair"))
      .toMatchObject({ planItemId: first.id, available: true });
    expect(store.getPlan(first.id)?.implementationRevision).toBe(first.implementationRevision);
    expect(store.getPlan(second.id)?.implementationRevision).toBe(second.implementationRevision);

    updateEvidenceRepairState(store, first.id, { status: "blocked", disposition: "blocked:REPAIR_BASELINE_MISMATCH" });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({
      nextAction: { code: "assess_evidence_repair_failure", entityId: first.id },
    });

    insertAuditorEvidence(store, project.id, nodeId, first);
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({
      nextAction: { code: "submit_evidence_repair", entityId: second.id },
    });
  });

  it("requires a frozen start and atomically submits exact Builder evidence for re-audit", () => {
    const { store, project, plan, nodeId } = acceptedFixture();
    openEvidenceRepairState(store, plan, 3);
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const lease = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "repair-builder", sessionId: "repair-session", idempotencyKey: "claim-repair",
    });
    const running = startAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "start-from-controlled-head",
    });
    expect(running.baselineRevision).toBe(plan.implementationRevision);
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ generation: 0, status: "open", attemptCount: 0 });
    const evidence = store.insertEvidence({
      projectId: project.id, nodeId, planItemId: plan.id, sourceType: "manual", sourcePath: "repair.txt",
      command: "npm test -- repair", resultStatus: "pass", summary: "Builder 重跑测试通过",
      details: { auditScope: "implementation", implementationRevision: plan.implementationRevision },
      commitSha: plan.implementationRevision, digest: "repair-digest", collectedAt: nowIso(),
      actorRole: "builder", agentId: "builder-id",
    });
    store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(store, {
        leaseToken: running.leaseToken, agentId: "builder-id", planId: plan.id, action: "submit_evidence_repair",
      });
      transitionPlanLifecycle(store, plan.id, {
        action: "submit_evidence_repair", actor: "Builder", agentId: "builder-id",
        evidenceId: evidence.id, testCommand: evidence.command, implementationRevision: plan.implementationRevision,
        baselineRevision: asserted!.baselineRevision,
      });
      advanceAgentTaskLeaseForPlanAction(store, asserted, {
        action: "submit_evidence_repair", agentId: "builder-id", idempotencyKey: "submit-repair",
        resultDigest: evidence.digest, evidenceId: evidence.id, testCommand: evidence.command,
        implementationRevision: plan.implementationRevision,
      });
    }).immediate();
    expect(store.getPlan(plan.id)).toMatchObject({
      lifecycleStatus: "pending_audit", status: "已完成", auditStatus: "pending",
      auditedBy: "", auditedAt: "", managerDecision: "pending", managerDecisionBy: "", managerDecisionAt: "",
    });
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ status: "submitted", disposition: `evidence:${evidence.id}` });
    expect(buildAgentOrchestration(store, project.id)!.queues.audit)
      .toEqual(expect.arrayContaining([expect.objectContaining({ planItemId: plan.id, actionCode: "audit_completed_plan" })]));
  });

  it("refreshes completedAt so an already audited plan can be dispatched to audit again", () => {
    const { store, project, plan, nodeId } = acceptedFixture();
    const staleCompletedAt = "2026-09-08T08:02:42.210Z";
    store.updatePlan(plan.id, { completedAt: staleCompletedAt });
    openEvidenceRepairState(store, plan, 3);
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const lease = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "refresh-builder", sessionId: "refresh-session", idempotencyKey: "claim-refresh",
    });
    const running = startAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: "start-refresh",
    });
    const evidence = store.insertEvidence({
      projectId: project.id, nodeId, planItemId: plan.id, sourceType: "manual", sourcePath: "refresh.txt",
      command: "npm test -- refresh", resultStatus: "pass", summary: "刷新 completedAt 验证",
      details: { auditScope: "implementation", implementationRevision: plan.implementationRevision },
      commitSha: plan.implementationRevision, digest: "refresh-digest", collectedAt: nowIso(),
      actorRole: "builder", agentId: "builder-id",
    });
    store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(store, {
        leaseToken: running.leaseToken, agentId: "builder-id", planId: plan.id, action: "submit_evidence_repair",
      });
      transitionPlanLifecycle(store, plan.id, {
        action: "submit_evidence_repair", actor: "Builder", agentId: "builder-id",
        evidenceId: evidence.id, testCommand: evidence.command, implementationRevision: plan.implementationRevision,
        baselineRevision: asserted!.baselineRevision,
      });
      advanceAgentTaskLeaseForPlanAction(store, asserted, {
        action: "submit_evidence_repair", agentId: "builder-id", idempotencyKey: "submit-refresh",
        resultDigest: evidence.digest, evidenceId: evidence.id, testCommand: evidence.command,
        implementationRevision: plan.implementationRevision,
      });
    }).immediate();
    const repaired = store.getPlan(plan.id)!;
    expect(repaired.completedAt).toBeTruthy();
    expect(repaired.completedAt).not.toBe(staleCompletedAt);
    expect(listClaimableAgentTasks(store, project.id)
      .find((item) => item.planItemId === plan.id && item.actionCode === "audit_completed_plan"))
      .toMatchObject({ taskRevision: `1:implementation:${repaired.completedAt}`, requiredRole: "auditor", available: true });
  });

  it("freezes repository HEAD and writes the first implementationRevision when the accepted plan is blank", () => {
    const { store, project, plan, nodeId, head } = acceptedFixture();
    openEvidenceRepairState(store, plan, 3);
    store.updatePlan(plan.id, { implementationRevision: "" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const claimed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "blank-revision-builder", sessionId: "blank-revision-session", idempotencyKey: "claim-blank-revision",
    });
    const running = startAgentTask(store, {
      leaseToken: claimed.leaseToken, agentId: "builder-id", idempotencyKey: "start-blank-revision",
    });
    expect(running.baselineRevision).toBe(head);
    const evidence = store.insertEvidence({
      projectId: project.id, nodeId, planItemId: plan.id, sourceType: "git", sourcePath: project.repositoryPath,
      command: "npm test -- repair-empty", resultStatus: "pass", summary: "空修订首次冻结后测试通过",
      details: { auditScope: "implementation", implementationRevision: head }, commitSha: head,
      digest: "repair-empty", collectedAt: nowIso(), actorRole: "builder", agentId: "builder-id",
    });
    store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(store, {
        leaseToken: running.leaseToken, agentId: "builder-id", planId: plan.id, action: "submit_evidence_repair",
      });
      transitionPlanLifecycle(store, plan.id, {
        action: "submit_evidence_repair", actor: "Builder", agentId: "builder-id",
        evidenceId: evidence.id, testCommand: evidence.command, implementationRevision: head,
        baselineRevision: asserted!.baselineRevision,
      });
      advanceAgentTaskLeaseForPlanAction(store, asserted, {
        action: "submit_evidence_repair", agentId: "builder-id", idempotencyKey: "submit-empty-revision",
        resultDigest: evidence.digest, evidenceId: evidence.id, testCommand: evidence.command, implementationRevision: head,
      });
    }).immediate();
    expect(store.getPlan(plan.id)).toMatchObject({ implementationRevision: head, lifecycleStatus: "pending_audit" });
  });

  it("commits server preflight blockage and replays the original failure through the external MCP entry", async () => {
    const { store, project, plan } = acceptedFixture();
    store.updateProject(project.id, { repositoryPath: "" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const claimed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "blocked-builder", sessionId: "blocked-session", idempotencyKey: "claim-blocked",
    });
    const payload = {
      workOrderId: claimed.workOrderId, leaseToken: claimed.leaseToken, taskKey: claimed.taskKey,
      taskRevision: claimed.taskRevision, workerId: claimed.workerId, agentId: claimed.agentId,
      role: claimed.role, idempotencyKey: "start-blocked",
    };
    const client = await LocalMcpClient.connect(() => createMcpServer({ store, dataDir: project.repositoryPath }));
    try {
      expect(mcpResultText(await client.callTool("start_agent_task", payload), 100_000)).toContain("REPAIR_REPOSITORY_REQUIRED");
      expect(mcpResultText(await client.callTool("start_agent_task", payload), 100_000)).toContain("REPAIR_REPOSITORY_REQUIRED");
    } finally { await client.close(); }
    const blocked = getEvidenceRepairState(store, plan.id)!;
    expect(blocked).toMatchObject({ status: "blocked", attemptCount: 1, failedWorkOrderId: claimed.workOrderId,
      failureCode: "REPAIR_REPOSITORY_REQUIRED", failure: { source: "server_preflight", generation: 0 } });
    expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(claimed.workOrderId)).toEqual({ status: "failed" });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks WHERE lease_token=?").get(claimed.leaseToken)).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT status FROM agent_task_workspace_reservations WHERE lease_token=?").get(claimed.leaseToken)).toEqual({ status: "fail" });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "assess_evidence_repair_failure", entityId: plan.id } });
    expect(getEvidenceRepairState(store, plan.id)).toEqual(blocked);
  });

  it("preserves exact bearer-only replay for an unenrolled repair worker", () => {
    const { store, project, plan } = acceptedFixture();
    store.updateProject(project.id, { repositoryPath: "" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const claimed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "lease-only-repair", sessionId: "lease-only-session", idempotencyKey: "claim-lease-only",
    });
    const input = {
      leaseToken: claimed.leaseToken, agentId: claimed.agentId, idempotencyKey: "start-lease-only-blocked",
    };
    expect(() => startAgentTask(store, input)).toThrow(expect.objectContaining({ code: "REPAIR_REPOSITORY_REQUIRED" }));
    expect(() => startAgentTask(store, input)).toThrow(expect.objectContaining({ code: "REPAIR_REPOSITORY_REQUIRED" }));
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ status: "blocked", attemptCount: 1 });
  });

  it("authenticates enrolled repair preflight before mutation and replays the committed MCP failure through REST", async () => {
    const { store, project, plan } = acceptedFixture();
    const dataDir = project.repositoryPath;
    store.updateProject(project.id, { repositoryPath: "" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const claimed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "enrolled-repair-worker", sessionId: "enrolled-repair-session", idempotencyKey: "claim-enrolled-repair",
    });
    const payload = {
      workOrderId: claimed.workOrderId, leaseToken: claimed.leaseToken, taskKey: claimed.taskKey,
      taskRevision: claimed.taskRevision, workerId: claimed.workerId, agentId: claimed.agentId,
      role: claimed.role, idempotencyKey: "start-enrolled-blocked",
    };
    const credential = registerAgentCredential(store, {
      principalId: "enrolled-repair-principal", agentId: claimed.agentId, workerId: claimed.workerId,
      allowedRoles: ["builder"], allowedProjects: [project.id],
    });
    const connectionId = "enrolled-repair-transport";
    const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
    const timestamp = new Date().toISOString();
    const principal = completeAgentAuth(store, {
      challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion: "1",
      response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
        credential.credentialId, timestamp, "1"),
    });
    const policy = acknowledgeAgentPolicy(store, principal, {
      role: "builder", projectId: project.id, policyVersion: "2.3.0",
    });
    const client = await LocalMcpClient.connect(() => createMcpServer({ store, dataDir }));
    try {
      expect(mcpResultText(await client.callTool("start_agent_task", payload), 100_000)).toContain("AUTH_REQUIRED");
      expect(getEvidenceRepairState(store, plan.id)).toBeNull();
      expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(claimed.workOrderId))
        .toEqual({ status: "claimed" });
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks WHERE lease_token=?")
        .get(claimed.leaseToken)).toEqual({ count: 1 });
      const nonce = issueOneTimeNonce(store, {
        policyAckToken: policy.policyAckToken, workOrderId: claimed.workOrderId,
        action: "mcp.start_agent_task", target: "mcp:start_agent_task",
        bodyDigest: evidenceRepairStartBodyDigest(payload),
      });
      expect(mcpResultText(await client.callTool("start_agent_task", {
        ...payload, authSessionToken: principal.authSessionToken,
        policyAckToken: policy.policyAckToken, nonceId: nonce.nonceId,
      }), 100_000)).toContain("REPAIR_REPOSITORY_REQUIRED");
      const consumedAt = store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?")
        .get(nonce.nonceId) as { consumed_at: string };
      expect(consumedAt.consumed_at).toMatch(/\S/);

      const app = buildApp({ dbPath: join(dataDir, "test.db"), dataDir });
      try {
        await app.ready();
        const unauthenticated = await app.inject({
          method: "POST", url: "/api/agent-task-leases/start", payload,
        });
        expect(unauthenticated.statusCode).toBe(401);
        expect(unauthenticated.json()).toMatchObject({ code: "AUTH_REQUIRED" });
        const changedIdentity = await app.inject({
          method: "POST", url: "/api/agent-task-leases/start",
          payload: { ...payload, workerId: "other-worker", authSessionToken: principal.authSessionToken },
        });
        expect(changedIdentity.statusCode).toBe(409);
        expect(changedIdentity.json()).toMatchObject({ code: "WORK_ORDER_CONTEXT_INVALID" });
        const replay = await app.inject({
          method: "POST", url: "/api/agent-task-leases/start",
          payload: { ...payload, authSessionToken: principal.authSessionToken },
        });
        expect(replay.statusCode).toBe(409);
        expect(replay.json()).toMatchObject({ code: "REPAIR_REPOSITORY_REQUIRED" });
      } finally { await app.close(); }
      expect(store.db.prepare("SELECT consumed_at FROM one_time_nonces WHERE nonce_id=?").get(nonce.nonceId))
        .toEqual(consumedAt);
    } finally { await client.close(); }
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({
      status: "blocked", attemptCount: 1, failedWorkOrderId: claimed.workOrderId,
    });
  });

  it("keeps a client baseline typo as a retryable mismatch and never upgrades it to blocked", () => {
    const { store, project, plan } = acceptedFixture();
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const claimed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "typo-builder", sessionId: "typo-session", idempotencyKey: "claim-typo",
    });
    expect(() => startAgentTask(store, {
      leaseToken: claimed.leaseToken, agentId: "builder-id", baselineRevision: "client-typo", idempotencyKey: "start-typo",
    })).toThrow(expect.objectContaining({ code: "REPAIR_BASELINE_MISMATCH" }));
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
    expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(claimed.workOrderId)).toEqual({ status: "claimed" });
  });

  it("upgrades only an exact old failed work order after a fresh server preflight still blocks it", () => {
    const { store, project, plan } = acceptedFixture();
    store.updatePlan(plan.id, { implementationRevision: "nogit-legacy" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const failed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "legacy-builder", sessionId: "legacy-session", idempotencyKey: "claim-legacy",
    });
    failAgentTask(store, { leaseToken: failed.leaseToken, agentId: "builder-id", error: "old client failure", idempotencyKey: "fail-legacy" });
    const before = getEvidenceRepairState(store, plan.id)!;
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: "foreign-project", planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-cross-project",
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_STATE_MISMATCH" }));
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation + 1, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-wrong-generation",
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_REVISION_DRIFT" }));
    store.updatePlan(plan.id, { implementationRevision: "nogit-changed" });
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-implementation-drift",
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_SNAPSHOT_DRIFT" }));
    store.updatePlan(plan.id, { implementationRevision: "nogit-legacy", proposalRevision: 2 });
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-proposal-drift",
    })).toThrow(expect.objectContaining({ code: "FAILED_WORK_ORDER_MISMATCH" }));
    store.updatePlan(plan.id, { proposalRevision: 1 });
    store.updateProject(project.id, { repositoryPath: `${project.repositoryPath}-moved` });
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-snapshot-drift",
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_SNAPSHOT_DRIFT" }));
    store.updateProject(project.id, { repositoryPath: project.repositoryPath });
    const blocked = requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-captured", requestedBy: "untrusted",
    });
    expect(blocked).toMatchObject({ status: "blocked", attemptCount: before.attemptCount,
      failureCode: "REPAIR_BASELINE_NOGIT", failedWorkOrderId: failed.workOrderId,
      failure: { source: "server_preflight", assessmentSnapshotSource: "failed_work_order" } });
  });

  it.each([
    { name: "unchanged", mutate: (_fixture: ReturnType<typeof acceptedFixture>) => undefined },
    { name: "implementation changed", mutate: ({ store, plan }: ReturnType<typeof acceptedFixture>) => {
      store.updatePlan(plan.id, { implementationRevision: "nogit-changed-after-failure" });
    } },
    { name: "repository changed", mutate: ({ store, project }: ReturnType<typeof acceptedFixture>) => {
      const alternate = join(project.repositoryPath, "alternate-repository");
      execFileSync("git", ["init", alternate], { windowsHide: true });
      execFileSync("git", ["-C", alternate, "config", "user.email", "repair@example.test"], { windowsHide: true });
      execFileSync("git", ["-C", alternate, "config", "user.name", "Repair Test"], { windowsHide: true });
      writeFileSync(join(alternate, "implementation.txt"), "alternate implementation\n");
      execFileSync("git", ["-C", alternate, "add", "implementation.txt"], { windowsHide: true });
      execFileSync("git", ["-C", alternate, "commit", "-m", "alternate fixture"], { windowsHide: true });
      store.updateProject(project.id, { repositoryPath: alternate });
    } },
  ])("rejects a failed assessment without a server snapshot when $name", ({ name, mutate }) => {
    const fixture = acceptedFixture();
    const { store, project, plan } = fixture;
    store.updatePlan(plan.id, { implementationRevision: "nogit-legacy" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const failed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "snapshotless-builder", sessionId: "snapshotless-session", idempotencyKey: "claim-snapshotless",
    });
    failAgentTask(store, {
      leaseToken: failed.leaseToken, agentId: "builder-id", error: "historical failure", idempotencyKey: "fail-snapshotless",
    });
    const repair = getEvidenceRepairState(store, plan.id)!;
    store.db.prepare("UPDATE agent_task_leases SET repair_snapshot_json='' WHERE id=?").run(failed.workOrderId);
    mutate(fixture);
    const leaseBefore = store.db.prepare(`SELECT status, attempt, last_error, completed_at, updated_at, repair_snapshot_json
      FROM agent_task_leases WHERE id=?`).get(failed.workOrderId);
    const repairBefore = getEvidenceRepairState(store, plan.id);
    const countsBefore = {
      requests: (store.db.prepare("SELECT COUNT(*) AS count FROM evidence_repair_assessment_requests").get() as { count: number }).count,
      audits: (store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
    };
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: repair.generation, expectedRepairUpdatedAt: repair.updatedAt,
      idempotencyKey: `assess-snapshotless-${name}`,
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_SNAPSHOT_REQUIRED" }));
    expect(store.db.prepare(`SELECT status, attempt, last_error, completed_at, updated_at, repair_snapshot_json
      FROM agent_task_leases WHERE id=?`).get(failed.workOrderId)).toEqual(leaseBefore);
    expect(getEvidenceRepairState(store, plan.id)).toEqual(repairBefore);
    expect({
      requests: (store.db.prepare("SELECT COUNT(*) AS count FROM evidence_repair_assessment_requests").get() as { count: number }).count,
      audits: (store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
    }).toEqual(countsBefore);
  });

  it("rejects a historical failed assessment after a newer lease becomes active", () => {
    const { store, project, plan } = acceptedFixture();
    store.updatePlan(plan.id, { implementationRevision: "nogit-legacy" });
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    const failed = claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "old-builder", sessionId: "old-session", idempotencyKey: "claim-old",
    });
    failAgentTask(store, { leaseToken: failed.leaseToken, agentId: "builder-id", error: "old failure", idempotencyKey: "fail-old" });
    const before = getEvidenceRepairState(store, plan.id)!;
    store.db.prepare("UPDATE agent_task_leases SET retry_available_at='2000-01-01T00:00:00.000Z' WHERE task_key=?").run(task.taskKey);
    claimAgentTask(store, {
      projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "new-builder", sessionId: "new-session", idempotencyKey: "claim-new",
    });
    expect(() => requestEvidenceRepairAssessment(store, {
      projectId: project.id, planId: plan.id, failedWorkOrderId: failed.workOrderId,
      expectedGeneration: before.generation, expectedRepairUpdatedAt: before.updatedAt,
      idempotencyKey: "assess-while-active",
    })).toThrow(expect.objectContaining({ code: "EVIDENCE_REPAIR_ACTIVE_LEASE" }));
  });

  it("separates failure assessment from a new approval reset generation", () => {
    const { store, project, plan } = acceptedFixture();
    openEvidenceRepairState(store, plan, 3);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
      const lease = claimAgentTask(store, {
        projectId: project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
        workerId: `repair-builder-${attempt}`, sessionId: `repair-session-${attempt}`, idempotencyKey: `claim-repair-${attempt}`,
      });
      startAgentTask(store, { leaseToken: lease.leaseToken, agentId: "builder-id", idempotencyKey: `start-repair-${attempt}` });
      failAgentTask(store, { leaseToken: lease.leaseToken, agentId: "builder-id", error: `failed-${attempt}`, idempotencyKey: `fail-repair-${attempt}` });
      store.db.prepare("UPDATE agent_task_leases SET retry_available_at='2000-01-01T00:00:00.000Z' WHERE task_key=?").run(task.taskKey);
    }
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ generation: 0, status: "exhausted", attemptCount: 3 });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ status: "blocked", nextAction: { code: "assess_evidence_repair_failure", entityId: plan.id } });
    expect(buildAgentOrchestration(store, project.id)!.queues.development.some((task) => task.actionCode === "submit_evidence_repair")).toBe(false);
    const assessment = listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "assess_evidence_repair_failure")!;
    expect(assessment).toMatchObject({ requiredRole: "approver", taskRevision: `1:assess_evidence_repair_failure:repair:0` });
    const lease = claimAgentTask(store, {
      projectId: project.id, taskKey: assessment.taskKey, role: "approver", agentId: "Main Agent",
      workerId: "main-repair-approver", sessionId: "main-repair-assessment", idempotencyKey: "claim-repair-assessment",
    });
    startAgentTask(store, { leaseToken: lease.leaseToken, agentId: "Main Agent", idempotencyKey: "start-repair-assessment" });
    store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(store, {
        leaseToken: lease.leaseToken, agentId: "Main Agent", planId: plan.id, action: "assess_evidence_repair_failure",
      });
      transitionPlanLifecycle(store, plan.id, {
        action: "assess_evidence_repair_failure", actor: "Main Agent", agentId: "Main Agent",
        reason: "影响仅限测试证据，可安全重跑", repairDisposition: "reset",
      });
      advanceAgentTaskLeaseForPlanAction(store, asserted, {
        action: "assess_evidence_repair_failure", agentId: "Main Agent", idempotencyKey: "assess-repair", resultDigest: "允许重试",
      });
    }).immediate();
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ generation: 0, status: "assessed", attemptCount: 3 });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "reset_evidence_repair_attempt", entityId: plan.id } });
    const resetTask = listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "reset_evidence_repair_attempt")!;
    expect(resetTask).toMatchObject({ requiredRole: "approver", taskRevision: `1:reset_evidence_repair_attempt:repair:0` });
    const resetLease = claimAgentTask(store, {
      projectId: project.id, taskKey: resetTask.taskKey, role: "approver", agentId: "Main Agent",
      workerId: "main-repair-reset", sessionId: "main-repair-reset", idempotencyKey: "claim-repair-reset",
    });
    startAgentTask(store, { leaseToken: resetLease.leaseToken, agentId: "Main Agent", idempotencyKey: "start-repair-reset" });
    store.db.transaction(() => {
      const asserted = assertAgentTaskLeaseForPlanAction(store, {
        leaseToken: resetLease.leaseToken, agentId: "Main Agent", planId: plan.id, action: "reset_evidence_repair_attempt",
      });
      transitionPlanLifecycle(store, plan.id, {
        action: "reset_evidence_repair_attempt", actor: "Main Agent", agentId: "Main Agent", reason: "批准新一代修复",
      });
      advanceAgentTaskLeaseForPlanAction(store, asserted, {
        action: "reset_evidence_repair_attempt", agentId: "Main Agent", idempotencyKey: "reset-repair", resultDigest: "approved",
      });
    }).immediate();
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ generation: 1, status: "open", attemptCount: 0 });
    expect(listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "submit_evidence_repair"))
      .toMatchObject({ taskRevision: `1:submit_evidence_repair:repair:1`, available: true });
  });

  it("routes an assessed design impact to request_design_change without resetting generation", () => {
    const { store, project, plan } = acceptedFixture();
    openEvidenceRepairState(store, plan, 3);
    updateEvidenceRepairState(store, plan.id, { status: "exhausted", attemptCount: 3, disposition: "attempts_exhausted:test" });
    transitionPlanLifecycle(store, plan.id, {
      action: "assess_evidence_repair_failure", actor: "Main Agent", agentId: "Main Agent",
      reason: "验收口径已变化，必须重新设计", repairDisposition: "design_change",
    });
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ generation: 0, status: "assessed" });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "request_design_change", entityId: plan.id } });
    expect(listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "request_design_change"))
      .toMatchObject({ requiredRole: "approver", taskRevision: `1:request_design_change:repair:0`, available: true });
  });

  it("routes a revoked Auditor evidence gap after closed repair to assessment, never directly to Builder", () => {
    const { store, project, plan, nodeId } = acceptedFixture();
    const evidence = insertAuditorEvidence(store, project.id, nodeId, plan);
    openEvidenceRepairState(store, plan, 3);
    updateEvidenceRepairState(store, plan.id, { status: "closed", disposition: "accepted" });
    store.db.prepare("UPDATE evidence SET status='revoked', revoked_reason=?, revoked_at=? WHERE id=?")
      .run("审计证据被撤销", nowIso(), evidence.id);
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({
      status: "blocked", nextAction: { code: "assess_evidence_repair_failure", entityId: plan.id },
    });
    const tasks = listClaimableAgentTasks(store, project.id);
    expect(tasks.some((task) => task.actionCode === "submit_evidence_repair")).toBe(false);
    expect(tasks.find((task) => task.actionCode === "assess_evidence_repair_failure"))
      .toMatchObject({ requiredRole: "approver", available: true });
  });

  it("clears an invalid implementation baseline and reopens repair at the next generation", () => {
    const { store, project, plan } = acceptedFixture();
    store.updatePlan(plan.id, { implementationRevision: "git:bc32aef13736ebae0634" });
    openEvidenceRepairState(store, plan, 3);
    updateEvidenceRepairState(store, plan.id, { status: "exhausted", attemptCount: 3, disposition: "attempts_exhausted:test" });
    transitionPlanLifecycle(store, plan.id, {
      action: "assess_evidence_repair_failure", actor: "Main Agent", agentId: "Main Agent",
      reason: "闭包规模超出单组审批上限，设计变更路径不可行", repairDisposition: "design_change",
    });
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({ status: "assessed", generation: 0 });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "request_design_change", entityId: plan.id } });

    const updated = resetImplementationBaseline(store, {
      planId: plan.id, actor: "Main Agent", reason: "实现修订为非法 SHA，证据修复与设计变更两条路径均阻断",
    });
    expect(updated.implementationRevision).toBe("");
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({
      status: "open", generation: 1, attemptCount: 0, disposition: expect.stringContaining("baseline_reset:"),
    });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "submit_evidence_repair", entityId: plan.id } });
    expect(buildAgentOrchestration(store, project.id)!.queues.development
      .some((task) => task.planItemId === plan.id && task.actionCode === "submit_evidence_repair")).toBe(true);
    expect(listClaimableAgentTasks(store, project.id).find((task) => task.actionCode === "submit_evidence_repair"))
      .toMatchObject({ taskRevision: `1:submit_evidence_repair:repair:1`, available: true });

    const auditRow = store.db.prepare(`SELECT "before" AS beforeJson, "after" AS afterJson, actor FROM audit_events
      WHERE entity_id=? AND action='reset_implementation_baseline'`)
      .get(plan.id) as { beforeJson: string; afterJson: string; actor: string };
    expect(JSON.parse(auditRow.beforeJson)).toMatchObject({
      implementationRevision: "git:bc32aef13736ebae0634", repairStatus: "assessed", repairGeneration: 0,
    });
    expect(JSON.parse(auditRow.afterJson)).toMatchObject({
      implementationRevision: "", repairStatus: "open", repairGeneration: 1, actor: "Main Agent",
    });
  });

  it("clears the baseline without materializing a repair row when none exists", () => {
    const { store, project, plan } = acceptedFixture();
    store.updatePlan(plan.id, { implementationRevision: "git:2ba9f75d0b0a3ea96df8" });
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
    resetImplementationBaseline(store, {
      planId: plan.id, actor: "Main Agent", reason: "实现修订为非法 SHA，直接回到证据修复路径",
    });
    expect(store.getPlan(plan.id)!.implementationRevision).toBe("");
    expect(getEvidenceRepairState(store, plan.id)).toBeNull();
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "submit_evidence_repair", entityId: plan.id } });
  });

  it("rolls a stale pending_audit submission back to accepted so its audit revision can change", () => {
    const { store, project, plan } = acceptedFixture();
    openEvidenceRepairState(store, plan, 3);
    updateEvidenceRepairState(store, plan.id, { status: "submitted", disposition: "evidence:stale" });
    store.updatePlan(plan.id, {
      lifecycleStatus: "pending_audit", auditStatus: "pending", completedAt: "2026-09-08T08:02:42.210Z",
    });
    const updated = resetImplementationBaseline(store, {
      planId: plan.id, actor: "Main Agent", reason: "旧引擎未刷新 completedAt，审计修订与已完成租约撞车",
    });
    expect(updated).toMatchObject({ lifecycleStatus: "accepted", implementationRevision: "" });
    expect(getEvidenceRepairState(store, plan.id)).toMatchObject({
      status: "open", generation: 1, attemptCount: 0, disposition: expect.stringContaining("baseline_reset:"),
    });
    expect(buildProjectWorkflow(store, project.id)).toMatchObject({ nextAction: { code: "submit_evidence_repair", entityId: plan.id } });
    const auditRow = store.db.prepare(`SELECT "before" AS beforeJson, "after" AS afterJson FROM audit_events
      WHERE entity_id=? AND action='reset_implementation_baseline'`)
      .get(plan.id) as { beforeJson: string; afterJson: string };
    expect(JSON.parse(auditRow.beforeJson)).toMatchObject({ lifecycleStatus: "pending_audit", repairStatus: "submitted" });
    expect(JSON.parse(auditRow.afterJson)).toMatchObject({ lifecycleStatus: "accepted", repairStatus: "open", repairGeneration: 1 });
  });

  it("keys the acceptance task by the refreshed completion so a re-audited plan can be accepted again", () => {
    const { store, project, plan, main, nodeId } = acceptedFixture();
    store.updatePlan(plan.id, {
      lifecycleStatus: "pending_manager", auditStatus: "passed", completedAt: "2026-09-19T03:50:30.938Z",
      managerDecision: "pending", managerDecisionBy: "", managerDecisionAt: "",
    });
    const diagram = store.getDiagram(main.id)!;
    store.updateDiagram(main.id, {
      nodes: diagram.nodes.map((node) => (node.id === nodeId ? { ...node, acceptanceStatus: "未验收" } : node)),
    });
    expect(listClaimableAgentTasks(store, project.id)
      .find((item) => item.planItemId === plan.id && item.actionCode === "approve_acceptance"))
      .toMatchObject({ taskRevision: "1:approve_acceptance:2026-09-19T03:50:30.938Z", requiredRole: "approver", available: true });
  });

  it("refuses to reset a baseline outside accepted plans, empty revisions, active leases or missing plans", () => {
    const notAccepted = acceptedFixture();
    notAccepted.store.updatePlan(notAccepted.plan.id, { lifecycleStatus: "approved", implementationRevision: "git:bc32aef13736ebae0634" });
    expect(() => resetImplementationBaseline(notAccepted.store, {
      planId: notAccepted.plan.id, actor: "Main Agent", reason: "非已验收计划不得重置实现基线",
    })).toThrow(expect.objectContaining({ statusCode: 409, code: "PLAN_NOT_ACCEPTED" }));

    const empty = acceptedFixture();
    empty.store.updatePlan(empty.plan.id, { implementationRevision: "" });
    expect(() => resetImplementationBaseline(empty.store, {
      planId: empty.plan.id, actor: "Main Agent", reason: "实现修订已为空时不得重复重置",
    })).toThrow(expect.objectContaining({ statusCode: 409, code: "BASELINE_ALREADY_EMPTY" }));

    const leased = acceptedFixture();
    leased.store.updatePlan(leased.plan.id, { implementationRevision: "git:bc32aef13736ebae0634" });
    const task = listClaimableAgentTasks(leased.store, leased.project.id).find((item) => item.actionCode === "submit_evidence_repair")!;
    claimAgentTask(leased.store, {
      projectId: leased.project.id, taskKey: task.taskKey, role: "builder", agentId: "builder-id",
      workerId: "baseline-builder", sessionId: "baseline-session", idempotencyKey: "claim-baseline",
    });
    expect(() => resetImplementationBaseline(leased.store, {
      planId: leased.plan.id, actor: "Main Agent", reason: "存在活动租约时不得重置实现基线",
    })).toThrow(expect.objectContaining({ statusCode: 409, code: "BASELINE_RESET_ACTIVE_LEASE" }));

    expect(() => resetImplementationBaseline(leased.store, {
      planId: "missing-plan", actor: "Main Agent", reason: "目标计划不存在时应拒绝",
    })).toThrow(expect.objectContaining({ statusCode: 404, code: "PLAN_NOT_FOUND" }));

    const unsubmitted = acceptedFixture();
    openEvidenceRepairState(unsubmitted.store, unsubmitted.plan, 3);
    unsubmitted.store.updatePlan(unsubmitted.plan.id, { lifecycleStatus: "pending_audit" });
    expect(() => resetImplementationBaseline(unsubmitted.store, {
      planId: unsubmitted.plan.id, actor: "Main Agent", reason: "修复态尚未提交时不得回滚待重审计划",
    })).toThrow(expect.objectContaining({ statusCode: 409, code: "PLAN_NOT_ACCEPTED" }));
  });

  it("exposes the baseline reset through a controlled REST route with an explicit confirmation token", async () => {
    const { store, project, plan } = acceptedFixture();
    store.updatePlan(plan.id, { implementationRevision: "git:bc32aef13736ebae0634" });
    const app = buildApp({ dbPath: join(project.repositoryPath, "test.db"), dataDir: project.repositoryPath });
    try {
      await app.ready();
      const wrongConfirm = await app.inject({
        method: "POST", url: `/api/plans/${plan.id}/implementation-baseline/reset`,
        payload: { actor: "Main Agent", reason: "实现修订为非法 SHA，需回到证据修复路径", confirm: "RESET" },
      });
      expect(wrongConfirm.statusCode).toBe(400);

      const tooShort = await app.inject({
        method: "POST", url: `/api/plans/${plan.id}/implementation-baseline/reset`,
        payload: { actor: "Main Agent", reason: "太短", confirm: "RESET-IMPLEMENTATION-BASELINE" },
      });
      expect(tooShort.statusCode).toBe(400);

      const reset = await app.inject({
        method: "POST", url: `/api/plans/${plan.id}/implementation-baseline/reset`,
        payload: { actor: "Main Agent", reason: "实现修订为非法 SHA，需回到证据修复路径", confirm: "RESET-IMPLEMENTATION-BASELINE" },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({ id: plan.id, implementationRevision: "" });

      const replay = await app.inject({
        method: "POST", url: `/api/plans/${plan.id}/implementation-baseline/reset`,
        payload: { actor: "Main Agent", reason: "实现修订为非法 SHA，需回到证据修复路径", confirm: "RESET-IMPLEMENTATION-BASELINE" },
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ code: "BASELINE_ALREADY_EMPTY" });
    } finally { await app.close(); }
  });
});
