import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import {
  advanceAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForPlanAction,
  claimAgentTask,
  listClaimableAgentTasks,
  releaseAgentTask,
  startAgentTask,
} from "./agentTaskLeases.js";
import {
  AGENT_REASSIGNMENT_REASON,
  AgentTaskReassignmentError,
  approveAgentTaskReassignment,
  requestAgentTaskReassignment,
  type RequestAgentTaskReassignmentInput,
} from "./agentTaskReassignment.js";
import { isAgentSecurityEnforced, registerAgentCredential } from "./agentSecurity.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";

const resources: Array<{ store: Store; dir: string }> = [];

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function insertPool(store: Store, input: {
  id: string; projectId: string; role: "designer" | "builder" | "auditor" | "approver";
  name: string; status?: "active" | "paused";
}): void {
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO agent_worker_pools
      (id, project_id, role, name, max_active, capabilities_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 2, '[]', ?, ?, ?)
  `).run(input.id, input.projectId, input.role, input.name, input.status ?? "active", now, now);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-audit-reassign-"));
  const store = new Store(join(dir, "test.db"));
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "REASSIGN", name: "审计改派", summary: "credential unavailable", stage: "测试", health: "关注",
    progress: 60, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "实现审计", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const nodeId = "site-adapter";
  store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: nodeId, kind: "feature", label: "站点适配器", description: "审计恢复", owner: "team",
    acceptanceCriteria: "独立审计", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "已完成", acceptanceStatus: "未验收", x: 600, y: 160,
  }] });
  const oldPoolId = `pool:${project.id}:auditor:old-auditor`;
  const replacementPoolId = `pool:${project.id}:auditor:replacement-auditor`;
  const plan = store.insertPlan({
    projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null,
    kind: "task", title: "实现站点适配器", description: "", status: "已完成", priority: "P0", progress: 100,
    owner: "Builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "",
    completedAt: "2026-09-07T08:00:00.000Z", lifecycleStatus: "pending_audit", proposalRevision: 2,
    proposedBy: "Designer", submittedAt: "2026-09-07T01:00:00.000Z", approvedBy: "Main Agent",
    approvedAt: "2026-09-07T02:00:00.000Z", implementationRevision: "revision-123", completedBy: "Builder Agent",
    auditStatus: "pending", managerDecision: "pending", roleAssignments: {
      designer: { agentId: "Designer Agent", displayName: "Designer" },
      builder: { agentId: "Builder Agent", displayName: "Builder" },
      auditor: { agentId: "Old Auditor", displayName: "Old Auditor", poolId: oldPoolId },
    },
  });
  const target = listClaimableAgentTasks(store, project.id)
    .find((task) => task.id === `audit:${plan.id}`)!;
  insertPool(store, { id: oldPoolId, projectId: project.id, role: "auditor", name: "Old Auditor" });
  insertPool(store, { id: replacementPoolId, projectId: project.id, role: "auditor", name: "Replacement Auditor" });
  registerAgentCredential(store, {
    principalId: "legacy/old-auditor", agentId: "Old Auditor", workerId: "old-auditor-worker",
    allowedRoles: ["auditor"], allowedProjects: [project.id],
  });
  const requestInput: RequestAgentTaskReassignmentInput = {
    projectId: project.id,
    targetTaskId: target.id,
    targetTaskKey: target.taskKey,
    targetTaskRevision: target.taskRevision,
    targetPlanItemId: plan.id,
    targetActionCode: "audit_completed_plan",
    targetWorkScopes: target.workScopes,
    originalAssignment: { agentId: "Old Auditor", displayName: "Old Auditor", poolId: oldPoolId },
    replacementAssignment: { agentId: "Replacement Auditor", displayName: "Replacement Auditor", poolId: replacementPoolId },
    reason: AGENT_REASSIGNMENT_REASON,
    requestedBy: "Main Agent",
    idempotencyKey: "request-reassignment",
  };
  return { store, project, plan, target, requestInput, replacementPoolId, oldPoolId };
}

function errorCode(operation: () => unknown): string {
  try { operation(); }
  catch (cause) { return (cause as AgentTaskReassignmentError).code; }
  throw new Error("expected operation to fail");
}

describe("credential-unavailable audit reassignment", () => {
  it("rejects recovery while the target audit lease is active", () => {
    const fx = fixture();
    const lease = claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: fx.target.id, role: "auditor", agentId: "Old Auditor",
      workerId: "old-auditor-worker", poolId: fx.oldPoolId, sessionId: "old-session", runId: "old-run",
      leaseSeconds: 60, idempotencyKey: "claim-old-auditor",
    });
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, fx.requestInput))).toBe("TARGET_LEASE_ACTIVE");
    releaseAgentTask(fx.store, {
      leaseToken: lease.leaseToken, agentId: "Old Auditor", idempotencyKey: "release-old-auditor",
    });
    const request = requestAgentTaskReassignment(fx.store, fx.requestInput);
    expect(request.status).toBe("pending");
    const approvalTask = listClaimableAgentTasks(fx.store, fx.project.id)
      .find((task) => task.actionCode === "approve_agent_reassignment")!;
    const approvalLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: approvalTask.id, role: "approver", agentId: "Main Agent",
      workerId: "main-race-check", poolId: approvalTask.poolId, leaseSeconds: 60,
      idempotencyKey: "claim-race-approval",
    });
    fx.store.db.prepare("UPDATE agent_task_leases SET status='claimed', lease_expires_at=? WHERE id=?")
      .run(new Date(Date.now() + 60_000).toISOString(), lease.workOrderId);
    expect(errorCode(() => approveAgentTaskReassignment(fx.store, {
      requestId: request.id,
      approvalNote: "race check",
      workOrderId: approvalLease.workOrderId,
      leaseToken: approvalLease.leaseToken,
      taskKey: approvalLease.taskKey,
      taskRevision: approvalLease.taskRevision,
      workerId: approvalLease.workerId,
      agentId: "Main Agent",
      role: "approver",
      idempotencyKey: "approve-race-check",
    }))).toBe("TARGET_LEASE_ACTIVE");
  });

  it("validates replacement pool project, role, state, scope, and identity separation", () => {
    const fx = fixture();
    const other = fx.store.insertProject({
      code: "OTHER", name: "Other", summary: "", stage: "测试", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    insertPool(fx.store, { id: "pool-other", projectId: other.id, role: "auditor", name: "Other Auditor" });
    insertPool(fx.store, { id: "pool-builder-role", projectId: fx.project.id, role: "builder", name: "Role Auditor" });
    insertPool(fx.store, { id: "pool-paused", projectId: fx.project.id, role: "auditor", name: "Paused Auditor", status: "paused" });
    insertPool(fx.store, { id: "pool-builder-identity", projectId: fx.project.id, role: "auditor", name: "Builder Agent" });

    const replacement = (agentId: string, poolId: string) => ({ agentId, displayName: agentId, poolId });
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput, replacementAssignment: replacement("Other Auditor", "pool-other"), idempotencyKey: "wrong-project",
    }))).toBe("REPLACEMENT_POOL_PROJECT_MISMATCH");
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput, replacementAssignment: replacement("Role Auditor", "pool-builder-role"), idempotencyKey: "wrong-role",
    }))).toBe("REPLACEMENT_POOL_ROLE_MISMATCH");
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput, replacementAssignment: replacement("Paused Auditor", "pool-paused"), idempotencyKey: "paused",
    }))).toBe("REPLACEMENT_POOL_PAUSED");
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput, replacementAssignment: replacement("Builder Agent", "pool-builder-identity"), idempotencyKey: "builder-identity",
    }))).toBe("REPLACEMENT_IDENTITY_NOT_INDEPENDENT");
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput, targetWorkScopes: [`plan:${fx.plan.id}`], idempotencyKey: "wrong-scope",
    }))).toBe("TARGET_SCOPE_MISMATCH");
  });

  it("uses an exact Main Agent approval lease, replays idempotently, and rotates the audit assignment generation", () => {
    const fx = fixture();
    const request = requestAgentTaskReassignment(fx.store, fx.requestInput);
    expect(requestAgentTaskReassignment(fx.store, fx.requestInput).id).toBe(request.id);
    expect(errorCode(() => requestAgentTaskReassignment(fx.store, {
      ...fx.requestInput,
      replacementAssignment: { ...fx.requestInput.replacementAssignment, displayName: "Changed display" },
    }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(isAgentSecurityEnforced(fx.store, "Old Auditor")).toBe(true);

    const duringRecovery = listClaimableAgentTasks(fx.store, fx.project.id);
    expect(duringRecovery.some((task) => task.id === fx.target.id)).toBe(false);
    const approvalTask = duringRecovery.find((task) => task.actionCode === "approve_agent_reassignment")!;
    expect(approvalTask).toMatchObject({
      id: `approval:agent-reassignment:${request.id}`,
      requiredRole: "approver",
      assignee: { agentId: "Main Agent" },
      workScopes: fx.target.workScopes,
    });
    const approvalLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: approvalTask.id, role: "approver", agentId: "Main Agent",
      workerId: "main-agent-approver", poolId: approvalTask.poolId, sessionId: "approval-session", runId: "approval-run",
      leaseSeconds: 60, idempotencyKey: "claim-approval",
    });
    startAgentTask(fx.store, {
      leaseToken: approvalLease.leaseToken, agentId: "Main Agent", idempotencyKey: "start-approval",
    });
    const approveInput = {
      requestId: request.id,
      approvalNote: "原凭据密钥不可获得，批准使用已登记的独立 auditor 池",
      workOrderId: approvalLease.workOrderId,
      leaseToken: approvalLease.leaseToken,
      taskKey: approvalLease.taskKey,
      taskRevision: approvalLease.taskRevision,
      workerId: approvalLease.workerId,
      agentId: "Main Agent",
      role: "approver" as const,
      idempotencyKey: "approve-reassignment",
    };
    expect(errorCode(() => approveAgentTaskReassignment(fx.store, {
      ...approveInput, agentId: "Replacement Auditor", idempotencyKey: "wrong-approver",
    }))).toBe("MAIN_AGENT_REQUIRED");
    fx.store.db.prepare("UPDATE agent_task_leases SET work_scopes_json='[\"node:wrong:scope\"]' WHERE id=?")
      .run(approvalLease.workOrderId);
    expect(errorCode(() => approveAgentTaskReassignment(fx.store, {
      ...approveInput, idempotencyKey: "wrong-approval-scope",
    }))).toBe("WORK_ORDER_CONTEXT_INVALID");
    fx.store.db.prepare("UPDATE agent_task_leases SET work_scopes_json=? WHERE id=?")
      .run(JSON.stringify(fx.target.workScopes), approvalLease.workOrderId);

    const approved = approveAgentTaskReassignment(fx.store, approveInput);
    expect(approved).toMatchObject({ status: "approved", assignmentGeneration: 1, approvalWorkOrderId: approvalLease.workOrderId });
    expect(approveAgentTaskReassignment(fx.store, approveInput)).toEqual(approved);
    expect(requestAgentTaskReassignment(fx.store, fx.requestInput)).toEqual(approved);
    expect(fx.store.getPlan(fx.plan.id)!.roleAssignments.auditor).toEqual({
      agentId: "Replacement Auditor", displayName: "Replacement Auditor", poolId: fx.replacementPoolId,
    });
    expect(isAgentSecurityEnforced(fx.store, "Old Auditor")).toBe(true);
    expect(fx.store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(approvalLease.workOrderId))
      .toEqual({ status: "completed" });
    const auditRows = fx.store.db.prepare(`
      SELECT action, before, after FROM audit_events
      WHERE entity_type='agentTaskReassignment' AND entity_id=? ORDER BY created_at
    `).all(request.id) as Array<{ action: string; before: string | null; after: string }>;
    expect(auditRows.map((row) => row.action).sort()).toEqual(["approve", "request"]);
    expect(JSON.parse(auditRows.find((row) => row.action === "approve")!.after)).toMatchObject({
      status: "approved", reason: "credential_unavailable", assignmentGeneration: 1,
    });

    const nextAudit = listClaimableAgentTasks(fx.store, fx.project.id).find((task) => task.id === fx.target.id)!;
    expect(nextAudit.taskRevision).toContain(":assignment:1");
    expect(nextAudit.taskKey).not.toBe(fx.target.taskKey);
    expect(nextAudit.assignee).toMatchObject({ agentId: "Replacement Auditor", poolId: fx.replacementPoolId });
    expect(() => claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: nextAudit.id, role: "auditor", agentId: "Old Auditor",
      workerId: "old-auditor-new-worker", poolId: fx.oldPoolId, idempotencyKey: "old-claim-after-reassign",
    })).toThrowError(/任务已分配给/);

    const auditorLease = claimAgentTask(fx.store, {
      projectId: fx.project.id, taskId: nextAudit.id, role: "auditor", agentId: "Replacement Auditor",
      workerId: "replacement-auditor-worker", poolId: fx.replacementPoolId,
      sessionId: "replacement-session", runId: "replacement-run", leaseSeconds: 60,
      idempotencyKey: "replacement-claim",
    });
    startAgentTask(fx.store, {
      leaseToken: auditorLease.leaseToken, agentId: "Replacement Auditor", idempotencyKey: "replacement-start",
    });
    const evidence = fx.store.insertEvidence({
      projectId: fx.project.id,
      nodeId: fx.plan.diagramNodeId,
      sourceType: "manual",
      sourcePath: "independent-audit",
      command: "npm test -- audit-reassignment",
      resultStatus: "fail",
      summary: "独立审计发现实现缺口",
      details: { auditScope: "implementation", implementationRevision: fx.plan.implementationRevision },
      commitSha: fx.plan.implementationRevision,
      digest: "audit-fail-digest",
      planItemId: fx.plan.id,
      acceptanceCriterionKey: "site-adapter-production-path",
      documentRevisionId: null,
      actorRole: "auditor",
      agentId: "Replacement Auditor",
      sessionId: "replacement-session",
      runId: "replacement-run",
      supersedesEvidenceId: null,
      status: "active",
      revokedReason: "",
      revokedAt: "",
      collectedAt: new Date().toISOString(),
    });
    const asserted = assertAgentTaskLeaseForPlanAction(fx.store, {
      leaseToken: auditorLease.leaseToken,
      agentId: "Replacement Auditor",
      planId: fx.plan.id,
      action: "fail_audit",
    });
    const failed = transitionPlanLifecycle(fx.store, fx.plan.id, {
      action: "fail_audit",
      actor: "Replacement Auditor",
      agentId: "Replacement Auditor",
      reason: "生产调用链未覆盖",
      evidenceId: evidence.id,
    });
    advanceAgentTaskLeaseForPlanAction(fx.store, asserted, {
      action: "fail_audit",
      agentId: "Replacement Auditor",
      idempotencyKey: "replacement-fail-audit",
      resultDigest: evidence.digest,
      evidenceId: evidence.id,
    });
    expect(failed).toMatchObject({ lifecycleStatus: "audit_failed", auditStatus: "failed", auditedBy: "Replacement Auditor" });
    expect(fx.store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(auditorLease.workOrderId))
      .toEqual({ status: "completed" });
  });
});
