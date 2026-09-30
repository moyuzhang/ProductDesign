import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";
import { claimAgentTask, completeAgentTask, heartbeatAgentTask, listClaimableAgentTasks, startAgentTask } from "./agentTaskLeases.js";
import { buildAgentOrchestration } from "./orchestration.js";
import { beginAgentAuth, completeAgentAuth, expectedChallengeResponse, registerAgentCredential, revokeAgentCredential } from "./agentSecurity.js";
import {
  advanceCoordinationStage,
  assertCoordinationLeaseForPlan,
  claimCoordinationLease as claimCoordinationLeaseWithAuth,
  claimDispatchedChildTask,
  dispatchChildTask,
  listCoordinationLeases,
  listChildTaskDispatches,
  pauseCoordinationLease,
  reassignChildTask,
  releaseCoordinationLease,
  resumeCoordinationLease,
  ensureCoordinationLeaseSchema,
  recoverCoordinationLeaseAfterRejectedTransaction,
} from "./coordinationLeases.js";
import type { ClaimCoordinationLeaseInput, DispatchChildTaskInput } from "./coordinationLeases.js";

const sessions = new WeakMap<Store, Map<string, string>>();
function claimCoordinationLease(store: Store, input: Omit<ClaimCoordinationLeaseInput, "authSessionToken">) {
  let byIdentity = sessions.get(store);
  if (!byIdentity) { byIdentity = new Map(); sessions.set(store, byIdentity); }
  const identity = `${input.projectId}:${input.mainAgentId}:${input.workerId}`;
  let token = byIdentity.get(identity);
  if (!token) {
    const credential = registerAgentCredential(store, {
      principalId: `test/${identity}`, agentId: input.mainAgentId, workerId: input.workerId,
      allowedRoles: ["approver"], allowedProjects: [input.projectId],
    });
    const connectionId = `test/${identity}`;
    const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
    const timestamp = new Date().toISOString();
    const protocolVersion = "2025-06-18";
    token = completeAgentAuth(store, {
      challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion,
      response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
        credential.credentialId, timestamp, protocolVersion),
    }).authSessionToken;
    byIdentity.set(identity, token);
  }
  return claimCoordinationLeaseWithAuth(store, { ...input, authSessionToken: token });
}

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
  it("requires an authenticated claim and atomically revokes active children with the credential", () => {
    const { store, projectId, task } = noPlanFixture();
    expect(() => claimCoordinationLeaseWithAuth(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "revoked-parent",
      idempotencyKey: "no-auth", authSessionToken: "" })).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "revoked-parent",
      idempotencyKey: "revoked-parent-claim" });
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer", workerId: "revoked-child" });
    const child = JSON.parse(claimDispatchedChildTask(store, { projectId, dispatchId: dispatch.dispatchId,
      agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: "revoked-child-claim" }));
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_credentials WHERE agent_id=?")
      .get(dispatch.agentId)).toEqual({ count: 0 });
    const credential = store.db.prepare("SELECT claim_credential_id AS id FROM agent_coordination_leases WHERE id=?")
      .get(parent.id) as { id: string };
    revokeAgentCredential(store, credential.id);
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatch.dispatchId))
      .toEqual({ status: "reclaimed" });
    expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(child.lease.workOrderId))
      .toEqual({ status: "released" });
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_task_resource_locks WHERE lease_token=?")
      .get(child.lease.leaseToken)).toEqual({ count: 0 });
    expect(() => dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" })).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
  });

  it("fail-closes an unbound historical parent exactly once", () => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "legacy-parent",
      idempotencyKey: "legacy-parent-claim" });
    store.db.prepare("UPDATE agent_coordination_leases SET claim_credential_id='', claim_auth_session_hash='', claim_revocation_version=-1 WHERE id=?")
      .run(parent.id);
    ensureCoordinationLeaseSchema(store);
    ensureCoordinationLeaseSchema(store);
    expect(listCoordinationLeases(store, projectId).find((item) => item.id === parent.id)?.status).toBe("released");
    const events = store.db.prepare("SELECT count(*) AS count FROM security_audit_events WHERE action='legacy_unbound_security_migration'")
      .get() as { count: number };
    expect(events.count).toBe(1);
    expect(() => claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "legacy-parent",
      idempotencyKey: "legacy-parent-claim" })).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
  });

  it("rolls back the legacy cleanup if its audit write fails", () => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "migration-rollback-parent",
      idempotencyKey: "migration-rollback-claim" });
    const dispatch = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" });
    store.db.prepare("UPDATE agent_coordination_leases SET claim_credential_id='' WHERE id=?").run(parent.id);
    store.db.exec(`CREATE TRIGGER fail_coordination_migration BEFORE INSERT ON security_audit_events
      WHEN NEW.action='legacy_unbound_security_migration' BEGIN SELECT RAISE(ABORT,'migration audit failure'); END`);
    expect(() => ensureCoordinationLeaseSchema(store)).toThrow(/migration audit failure/);
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "active" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatch.dispatchId))
      .toEqual({ status: "dispatched" });
    store.db.exec("DROP TRIGGER fail_coordination_migration");
    ensureCoordinationLeaseSchema(store);
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatch.dispatchId))
      .toEqual({ status: "reclaimed" });
  });

  it("bounds the parent TTL by its auth session and refuses a later dispatch after session expiry", () => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "expiring-parent",
      idempotencyKey: "expiring-parent-claim", leaseSeconds: 1800 });
    const row = store.db.prepare("SELECT claim_auth_session_hash AS hash FROM agent_coordination_leases WHERE id=?")
      .get(parent.id) as { hash: string };
    const session = store.db.prepare("SELECT expires_at AS expiresAt FROM agent_auth_sessions WHERE session_token_hash=?")
      .get(row.hash) as { expiresAt: string };
    expect(Date.parse(parent.leaseExpiresAt)).toBeLessThanOrEqual(Date.parse(session.expiresAt));
    const existing = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" });
    store.db.prepare("UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE session_token_hash=?")
      .run(row.hash);
    expect(() => dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" })).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
    // Inspect raw storage before any list/GET that could itself sweep stale parents.
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(existing.dispatchId))
      .toEqual({ status: "reclaimed" });
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_child_task_dispatches WHERE coordination_lease_id=?")
      .get(parent.id)).toEqual({ count: 1 });
  });

  it("persists plan-bound expiry cleanup in the rejected dispatch request", () => {
    const { store, projectId, planId } = fixture();
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.planItemId === planId && item.queue === "design")!;
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent",
      workerId: "plan-expiring-parent", idempotencyKey: "plan-expiring-parent-claim" });
    const existing = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, role: "designer" });
    store.db.prepare(`UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z'
      WHERE session_token_hash=(SELECT claim_auth_session_hash FROM agent_coordination_leases WHERE id=?)`).run(parent.id);
    expect(() => dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      role: "designer" })).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(existing.dispatchId))
      .toEqual({ status: "reclaimed" });
  });

  it("rolls back an inserted dispatch if the parent revision update fails", () => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: "dispatch-rollback-parent",
      idempotencyKey: "dispatch-rollback-claim" });
    store.db.exec(`CREATE TRIGGER fail_dispatch_revision BEFORE UPDATE OF dispatch_revision ON agent_coordination_leases
      BEGIN SELECT RAISE(ABORT,'dispatch revision failure'); END`);
    expect(() => dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" })).toThrow(/dispatch revision failure/);
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_child_task_dispatches WHERE coordination_lease_id=?")
      .get(parent.id)).toEqual({ count: 0 });
    expect(store.db.prepare("SELECT status, dispatch_revision AS revision FROM agent_coordination_leases WHERE id=?")
      .get(parent.id)).toEqual({ status: "active", revision: 0 });
  });

  it("commits expired-plan cleanup after a rejected outer plan transaction", () => {
    const { store, projectId, planId } = fixture();
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent",
      workerId: "plan-transition-parent", idempotencyKey: "plan-transition-parent-claim" });
    store.db.prepare(`UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z'
      WHERE session_token_hash=(SELECT claim_auth_session_hash FROM agent_coordination_leases WHERE id=?)`).run(parent.id);
    let rejected: unknown;
    try {
      store.db.transaction(() => assertCoordinationLeaseForPlan(store, { projectId, planId,
        coordinationLeaseId: parent.id, coordinationLeaseToken: parent.leaseToken,
        mainAgentId: "Main Agent" })).immediate();
    } catch (cause) {
      rejected = cause;
      recoverCoordinationLeaseAfterRejectedTransaction(store, projectId, cause);
    }
    expect(rejected).toMatchObject({ code: "COORDINATION_LEASE_LOST" });
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
  });

  it.each(["pause", "release", "reassign"] as const)("commits expired-parent cleanup after rejected %s", (operation) => {
    const { store, projectId, task } = noPlanFixture();
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey,
      taskRevision: task.taskRevision, mainAgentId: "Main Agent", workerId: `${operation}-expired-parent`,
      idempotencyKey: `${operation}-expired-parent-claim` });
    const dispatched = dispatchChildTask(store, { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id,
      taskKey: task.taskKey, role: "designer" });
    store.db.prepare(`UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z'
      WHERE session_token_hash=(SELECT claim_auth_session_hash FROM agent_coordination_leases WHERE id=?)`).run(parent.id);
    const base = { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken,
      mainAgentId: "Main Agent" };
    const action = () => operation === "pause" ? pauseCoordinationLease(store, base)
      : operation === "release" ? releaseCoordinationLease(store, base)
        : reassignChildTask(store, { ...base, dispatchId: dispatched.dispatchId,
          taskId: task.id, taskKey: task.taskKey, role: "designer", workerId: "replacement-child" });
    expect(action).toThrow(expect.objectContaining({ code: "COORDINATION_LEASE_LOST" }));
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "released" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatched.dispatchId))
      .toEqual({ status: "reclaimed" });
  });
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
    expect(prompt).toContain("子 Agent 不共享 Main Agent 的 authSessionToken");
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


describe("Child dispatch idempotency", () => {
  function retryFixture() {
    const context = noPlanFixture();
    const { store, projectId, task } = context;
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "retry-parent", idempotencyKey: "retry-parent-claim" });
    const input: DispatchChildTaskInput = { projectId, coordinationLeaseId: parent.id,
      leaseToken: parent.leaseToken, mainAgentId: "Main Agent", taskId: task.id, taskKey: task.taskKey,
      role: "designer", workerId: "retry-child", idempotencyKey: "dispatch-retry" };
    return { ...context, parent, input };
  }

  function claimChild(store: Store, dispatch: ReturnType<typeof dispatchChildTask>) {
    return JSON.parse(claimDispatchedChildTask(store, { projectId: dispatch.projectId, dispatchId: dispatch.dispatchId,
      agentId: dispatch.agentId, workerId: dispatch.workerId, idempotencyKey: `claim:${dispatch.dispatchId}` })) as {
        lease: { workOrderId: string; leaseToken: string }; worker: { agentId: string };
      };
  }

  function snapshot(store: Store) {
    return Object.fromEntries([
      "agent_coordination_leases", "agent_child_task_dispatches", "agent_child_dispatch_receipts",
      "agent_task_leases", "agent_task_resource_locks", "agent_task_workspace_reservations",
      "agent_runner_registrations", "audit_events", "security_audit_events",
    ].map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  }

  function counts(store: Store, parentId: string) {
    return {
      dispatches: store.db.prepare("SELECT count(*) AS count FROM agent_child_task_dispatches WHERE coordination_lease_id=?").get(parentId),
      receipts: store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts WHERE coordination_lease_id=?").get(parentId),
      revision: store.db.prepare("SELECT dispatch_revision AS revision FROM agent_coordination_leases WHERE id=?").get(parentId),
    };
  }

  it("replays a live dispatch without changing rows, timestamps, revisions, locks, runners, or audits", () => {
    const { store, parent, input } = retryFixture();
    const dispatch = dispatchChildTask(store, input);
    const before = snapshot(store);
    expect(dispatchChildTask(store, input)).toEqual(dispatch);
    expect(snapshot(store)).toEqual(before);
    expect(counts(store, parent.id)).toEqual({ dispatches: { count: 1 }, receipts: { count: 1 }, revision: { revision: 1 } });
    expect(store.db.prepare("SELECT dispatch_id, request_hash FROM agent_child_dispatch_receipts").get())
      .toEqual({ dispatch_id: dispatch.dispatchId, request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("normalizes a key and optional intent fields and ignores property order on replay", () => {
    const { store, input } = retryFixture();
    const dispatch = dispatchChildTask(store, { ...input, idempotencyKey: ` ${input.idempotencyKey} ` });
    const before = snapshot(store);
    const reordered = { poolId: "  ", agentId: "", workerId: ` ${input.workerId} `, role: input.role,
      taskKey: input.taskKey, taskId: input.taskId, mainAgentId: input.mainAgentId, leaseToken: input.leaseToken,
      coordinationLeaseId: input.coordinationLeaseId, projectId: input.projectId, idempotencyKey: input.idempotencyKey };
    expect(dispatchChildTask(store, reordered)).toEqual(dispatch);
    expect(snapshot(store)).toEqual(before);
    expect(store.db.prepare("SELECT idempotency_key FROM agent_child_dispatch_receipts").get()).toEqual({ idempotency_key: input.idempotencyKey });
  });

  it.each(["", "   ", "a".repeat(301)])("rejects an invalid supplied key before any mutation: %j", (idempotencyKey) => {
    const { store, input } = retryFixture();
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, { ...input, idempotencyKey }))
      .toThrow(expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }));
    expect(snapshot(store)).toEqual(before);
  });

  it.each(["claimed", "running"] as const)("returns the current %s dispatch when its own child lease makes the task unavailable", (status) => {
    const { store, projectId, input } = retryFixture();
    const dispatch = dispatchChildTask(store, input);
    const child = claimChild(store, dispatch);
    if (status === "running") {
      expect(startAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId,
        idempotencyKey: `start:${dispatch.dispatchId}` }).status).toBe("running");
    }
    expect(listClaimableAgentTasks(store, projectId).find((task) => task.id === input.taskId)?.available).toBe(false);
    const before = snapshot(store);
    const replay = dispatchChildTask(store, input);
    expect(replay).toMatchObject({ dispatchId: dispatch.dispatchId, status, childWorkOrderId: child.lease.workOrderId });
    expect(replay).not.toHaveProperty("leaseToken");
    expect(snapshot(store)).toEqual(before);
  });

  it("replays a running Builder dispatch after the real start_development lifecycle transition", () => {
    const { store, projectId, planId, diagramId } = fixture();
    const diagram = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, { nodes: diagram.nodes.map((node) => node.id === "coord-node"
      ? { ...node, description: "Implement the approved design", owner: "builder", designStatus: "已批准" as const } : node) });
    store.updatePlan(planId, { lifecycleStatus: "approved", submittedAt: "2026-08-30T01:00:00.000Z",
      approvedAt: "2026-08-30T01:05:00.000Z", approvedBy: "Manager" });
    const task = listClaimableAgentTasks(store, projectId).find((item) => item.planItemId === planId && item.queue === "development")!;
    expect(task.available).toBe(true);
    const parent = claimCoordinationLease(store, { projectId, planId, mainAgentId: "Main Agent",
      workerId: "builder-retry-parent", idempotencyKey: "builder-retry-parent-claim" });
    const input: DispatchChildTaskInput = { projectId, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken,
      mainAgentId: "Main Agent", taskId: task.id, taskKey: task.taskKey, role: "builder",
      workerId: "builder-retry-child", idempotencyKey: "builder-dispatch-retry" };
    const dispatch = dispatchChildTask(store, input);
    const child = claimChild(store, dispatch);
    expect(startAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId,
      idempotencyKey: "builder-start" }).status).toBe("running");
    transitionPlanLifecycle(store, planId, { action: "start_development", actor: "Builder", agentId: child.worker.agentId });
    expect(store.getPlan(planId)?.lifecycleStatus).toBe("in_progress");
    const before = snapshot(store);
    expect(dispatchChildTask(store, input)).toMatchObject({ dispatchId: dispatch.dispatchId,
      status: "running", childWorkOrderId: child.lease.workOrderId });
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    { taskId: "another-task" }, { taskKey: "another-task-key" }, { role: "builder" as const },
    { agentId: "another-agent" }, { workerId: "another-worker" }, { poolId: "another-pool" },
  ])("rejects a key reused for different dispatch intent: %j", (change) => {
    const { store, input } = retryFixture();
    dispatchChildTask(store, input);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, { ...input, ...change }))
      .toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    [{ leaseToken: "wrong-token" }, "COORDINATION_LEASE_LOST"],
    [{ mainAgentId: "another-main" }, "MAIN_AGENT_MISMATCH"],
    [{ coordinationLeaseId: "another-parent" }, "COORDINATION_LEASE_LOST"],
    [{ projectId: "another-project" }, "COORDINATION_LEASE_LOST"],
  ] as const)("authenticates the current parent before reading a receipt: %j", (change, code) => {
    const { store, input } = retryFixture();
    dispatchChildTask(store, input);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, { ...input, ...change, workerId: "different-intent-too" }))
      .toThrow(expect.objectContaining({ code }));
    expect(snapshot(store)).toEqual(before);
  });

  it.each(["paused", "released", "expired", "revoked", "session-expired", "runner-stale"] as const)
    ("does not replay through a %s parent", (state) => {
      const { store, parent, input } = retryFixture();
      dispatchChildTask(store, input);
      if (state === "paused") pauseCoordinationLease(store, input);
      else if (state === "released") releaseCoordinationLease(store, input);
      else if (state === "expired") store.db.prepare("UPDATE agent_coordination_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(parent.id);
      else if (state === "revoked") {
        const row = store.db.prepare("SELECT claim_credential_id AS id FROM agent_coordination_leases WHERE id=?").get(parent.id) as { id: string };
        revokeAgentCredential(store, row.id);
      } else if (state === "session-expired") {
        store.db.prepare(`UPDATE agent_auth_sessions SET expires_at='2000-01-01T00:00:00.000Z'
          WHERE session_token_hash=(SELECT claim_auth_session_hash FROM agent_coordination_leases WHERE id=?)`).run(parent.id);
      } else {
        store.db.prepare("UPDATE agent_runner_registrations SET status='stale', last_seen_at='2000-01-01T00:00:00.000Z' WHERE project_id=? AND worker_id=?")
          .run(input.projectId, parent.workerId);
      }
      expect(() => dispatchChildTask(store, input)).toThrow(expect.objectContaining({
        code: state === "paused" ? "COORDINATION_PAUSED" : "COORDINATION_LEASE_LOST",
      }));
      expect(counts(store, parent.id)).toEqual({ dispatches: { count: 1 }, receipts: { count: 1 }, revision: { revision: 1 } });
    });

  it("does not resurrect a dispatch receipt after pausing and resuming the parent", () => {
    const { store, parent, input } = retryFixture();
    const original = dispatchChildTask(store, input);
    const child = claimChild(store, original);
    pauseCoordinationLease(store, input);
    resumeCoordinationLease(store, input);
    expect(store.db.prepare("SELECT status FROM agent_coordination_leases WHERE id=?").get(parent.id)).toEqual({ status: "active" });
    expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(child.lease.workOrderId)).toEqual({ status: "released" });
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow(expect.objectContaining({ code: "DISPATCH_LOST" }));
    expect(snapshot(store)).toEqual(before);
    expect(counts(store, parent.id)).toEqual({ dispatches: { count: 1 }, receipts: { count: 1 }, revision: { revision: 1 } });
    const replacement = dispatchChildTask(store, { ...input, idempotencyKey: "after-resume" });
    expect(replacement.dispatchId).not.toBe(original.dispatchId);
  });

  it.each(["completed", "reclaimed"] as const)("does not return a receipt whose dispatch is now %s", (status) => {
    const { store, input } = retryFixture();
    const dispatch = dispatchChildTask(store, input);
    store.db.prepare("UPDATE agent_child_task_dispatches SET status=? WHERE dispatch_id=?").run(status, dispatch.dispatchId);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  it("rejects a replay after the parent advances to another stage", () => {
    const { store, parent, input } = retryFixture();
    dispatchChildTask(store, input);
    store.db.prepare("UPDATE agent_coordination_leases SET stage='design_audit' WHERE id=?").run(parent.id);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  it("rejects a replay after the exact task revision changes", () => {
    const { store, diagramId, input } = retryFixture();
    dispatchChildTask(store, input);
    const diagram = store.getDiagram(diagramId)!;
    store.updateDiagram(diagramId, { nodes: diagram.nodes.map((node) => node.id === "coord-node"
      ? { ...node, description: "the task changed after dispatch" } : node) });
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  it.each(["released", "completed", "failed", "expired"] as const)
    ("rejects a stale claimed dispatch when its actual child lease is %s", (status) => {
      const { store, parent, input } = retryFixture();
      const dispatch = dispatchChildTask(store, input);
      const child = claimChild(store, dispatch);
      // Simulate a delayed dispatch projection: the child lease is authoritative.
      store.db.prepare("UPDATE agent_task_leases SET status=? WHERE id=?").run(status, child.lease.workOrderId);
      expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(dispatch.dispatchId)).toEqual({ status: "claimed" });
      const before = counts(store, parent.id);
      expect(() => dispatchChildTask(store, input)).toThrow();
      expect(counts(store, parent.id)).toEqual(before);
    });

  it.each(["expired-time", "missing", "wrong-revision", "wrong-dispatch"] as const)
    ("checks child lease integrity before replaying a claimed dispatch: %s", (state) => {
      const { store, parent, input } = retryFixture();
      const dispatch = dispatchChildTask(store, input);
      const child = claimChild(store, dispatch);
      if (state === "expired-time") store.db.prepare("UPDATE agent_task_leases SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(child.lease.workOrderId);
      else if (state === "missing") store.db.prepare("DELETE FROM agent_task_leases WHERE id=?").run(child.lease.workOrderId);
      else if (state === "wrong-revision") store.db.prepare("UPDATE agent_task_leases SET task_revision='different-revision' WHERE id=?").run(child.lease.workOrderId);
      else store.db.prepare("UPDATE agent_task_leases SET coordination_dispatch_id='different-dispatch' WHERE id=?").run(child.lease.workOrderId);
      const before = counts(store, parent.id);
      expect(() => dispatchChildTask(store, input)).toThrow();
      expect(counts(store, parent.id)).toEqual(before);
    });

  it("keeps legacy unkeyed dispatch and reassign behavior without creating receipts", () => {
    const { store, input } = retryFixture();
    const unkeyed = { ...input, idempotencyKey: undefined };
    const original = dispatchChildTask(store, unkeyed);
    expect(() => dispatchChildTask(store, unkeyed)).toThrow(expect.objectContaining({ code: "CHILD_TASK_ALREADY_DISPATCHED" }));
    const reassign = { ...unkeyed, dispatchId: original.dispatchId, workerId: "legacy-replacement" };
    const replacement = reassignChildTask(store, reassign);
    expect(replacement.dispatchId).not.toBe(original.dispatchId);
    expect(replacement.dispatchVersion).toBe(2);
    expect(() => reassignChildTask(store, reassign)).toThrow(expect.objectContaining({ code: "DISPATCH_NOT_ACTIVE" }));
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts").get()).toEqual({ count: 0 });
  });

  it("replays the replacement before checking the now-reclaimed original and writes one reassign receipt", () => {
    const { store, parent, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    claimChild(store, original);
    const reassign = { ...input, taskId: "", dispatchId: original.dispatchId,
      workerId: "replacement-child", reason: "runner disconnected", idempotencyKey: "reassign-retry" };
    const replacement = reassignChildTask(store, reassign);
    const before = snapshot(store);
    expect(reassignChildTask(store, reassign)).toEqual(replacement);
    expect(snapshot(store)).toEqual(before);
    expect(replacement).toMatchObject({ dispatchVersion: 2, workerId: "replacement-child", status: "dispatched" });
    expect(store.db.prepare("SELECT status FROM agent_child_task_dispatches WHERE dispatch_id=?").get(original.dispatchId)).toEqual({ status: "reclaimed" });
    expect(counts(store, parent.id)).toEqual({ dispatches: { count: 2 }, receipts: { count: 1 }, revision: { revision: 2 } });
    expect(store.db.prepare("SELECT operation, dispatch_id FROM agent_child_dispatch_receipts").all())
      .toEqual([{ operation: "reassign", dispatch_id: replacement.dispatchId }]);
  });

  it.each(["claimed", "running"] as const)("replays the current %s replacement without reclaiming it", (status) => {
    const { store, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", idempotencyKey: "replacement-retry" };
    const replacement = reassignChildTask(store, reassign);
    const child = claimChild(store, replacement);
    if (status === "running") {
      expect(startAgentTask(store, { leaseToken: child.lease.leaseToken, agentId: child.worker.agentId,
        idempotencyKey: `start:${replacement.dispatchId}` }).status).toBe("running");
    }
    const before = snapshot(store);
    expect(reassignChildTask(store, reassign)).toMatchObject({ dispatchId: replacement.dispatchId, status,
      childWorkOrderId: child.lease.workOrderId, dispatchVersion: 2 });
    expect(snapshot(store)).toEqual(before);
  });

  it.each([{ dispatchId: "another-original" }, { workerId: "another-replacement" }, { reason: "different-reason" }])
    ("rejects conflicting reassign intent before changing either dispatch: %j", (change) => {
      const { store, input } = retryFixture();
      const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
      const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", reason: "retry", idempotencyKey: "reassign-conflict" };
      reassignChildTask(store, reassign);
      const before = snapshot(store);
      expect(() => reassignChildTask(store, { ...reassign, ...change })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
      expect(snapshot(store)).toEqual(before);
    });

  it("normalizes omitted reassign reason and ignores task selectors that reassign derives from the source", () => {
    const { store, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", idempotencyKey: "reassign-normalized" };
    const replacement = reassignChildTask(store, reassign);
    const before = snapshot(store);
    expect(reassignChildTask(store, { ...reassign, reason: " reassigned_by_main_agent ",
      taskId: "", taskKey: undefined })).toEqual(replacement);
    expect(snapshot(store)).toEqual(before);
  });

  it.each(["wrong-token", "wrong-main", "paused"] as const)("checks current parent authorization before reassign replay: %s", (state) => {
    const { store, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", idempotencyKey: "reassign-auth" };
    reassignChildTask(store, reassign);
    if (state === "paused") pauseCoordinationLease(store, input);
    const replay = state === "wrong-token" ? { ...reassign, leaseToken: "wrong-token" }
      : state === "wrong-main" ? { ...reassign, mainAgentId: "another-main" } : reassign;
    const before = snapshot(store);
    expect(() => reassignChildTask(store, replay)).toThrow(expect.objectContaining({ code:
      state === "wrong-token" ? "COORDINATION_LEASE_LOST" : state === "wrong-main" ? "MAIN_AGENT_MISMATCH" : "COORDINATION_PAUSED" }));
    expect(snapshot(store)).toEqual(before);
  });

  it("refuses to replay a reassign receipt after the replacement was reclaimed", () => {
    const { store, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", idempotencyKey: "reassign-terminal" };
    const replacement = reassignChildTask(store, reassign);
    store.db.prepare("UPDATE agent_child_task_dispatches SET status='reclaimed' WHERE dispatch_id=?").run(replacement.dispatchId);
    const before = snapshot(store);
    expect(() => reassignChildTask(store, reassign)).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  it("scopes the same key independently to dispatch and reassign operations", () => {
    const { store, input } = retryFixture();
    const original = dispatchChildTask(store, input);
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child" };
    const replacement = reassignChildTask(store, reassign);
    expect(reassignChildTask(store, reassign)).toEqual(replacement);
    expect(store.db.prepare("SELECT operation, dispatch_id FROM agent_child_dispatch_receipts ORDER BY operation").all())
      .toEqual([{ operation: "dispatch", dispatch_id: original.dispatchId }, { operation: "reassign", dispatch_id: replacement.dispatchId }]);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow();
    expect(snapshot(store)).toEqual(before);
  });

  it("allows the same dispatch key under a newly authorized parent in the same project", () => {
    const { store, projectId, task, input } = retryFixture();
    const original = dispatchChildTask(store, input);
    releaseCoordinationLease(store, input);
    const parent = claimCoordinationLease(store, { projectId, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "next-parent", idempotencyKey: "next-parent-claim" });
    const nextInput = { ...input, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken };
    const next = dispatchChildTask(store, nextInput);
    expect(next.dispatchId).not.toBe(original.dispatchId);
    expect(dispatchChildTask(store, nextInput)).toEqual(next);
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts WHERE idempotency_key=?").get(input.idempotencyKey)).toEqual({ count: 2 });
  });

  it("allows the same key in another project in the same database", () => {
    const { store, projectId, diagramId, input } = retryFixture();
    const original = dispatchChildTask(store, input);
    const sourceProject = store.getProject(projectId)!;
    const otherProject = store.insertProject({ ...sourceProject, id: undefined, code: "COORD-RETRY-OTHER", name: "Other retry project" });
    const otherDiagram = store.listDiagrams(otherProject.id).find((item) => item.type === "main")!;
    const node = store.getDiagram(diagramId)!.nodes.find((item) => item.id === "coord-node")!;
    store.updateDiagram(otherDiagram.id, { nodes: [...otherDiagram.nodes, node] });
    const task = listClaimableAgentTasks(store, otherProject.id).find((item) => item.queue === "design" && item.nodeId === node.id && !item.planItemId)!;
    const parent = claimCoordinationLease(store, { projectId: otherProject.id, taskKey: task.taskKey, taskRevision: task.taskRevision,
      mainAgentId: "Main Agent", workerId: "other-project-parent", idempotencyKey: "other-project-parent-claim" });
    const otherInput = { ...input, projectId: otherProject.id, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken,
      taskId: task.id, taskKey: task.taskKey };
    const other = dispatchChildTask(store, otherInput);
    expect(other.dispatchId).not.toBe(original.dispatchId);
    expect(dispatchChildTask(store, otherInput)).toEqual(other);
    expect(dispatchChildTask(store, input)).toEqual(original);
    expect(store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts WHERE idempotency_key=?").get(input.idempotencyKey)).toEqual({ count: 2 });
  });

  it("rolls back dispatch and revision if writing the receipt fails, then permits a clean retry", () => {
    const { store, parent, input } = retryFixture();
    store.db.exec(`CREATE TRIGGER fail_dispatch_receipt BEFORE INSERT ON agent_child_dispatch_receipts
      BEGIN SELECT RAISE(ABORT,'receipt insertion failure'); END`);
    const before = snapshot(store);
    expect(() => dispatchChildTask(store, input)).toThrow(/receipt insertion failure/);
    expect(snapshot(store)).toEqual(before);
    store.db.exec("DROP TRIGGER fail_dispatch_receipt");
    const dispatch = dispatchChildTask(store, input);
    expect(dispatchChildTask(store, input)).toEqual(dispatch);
    expect(counts(store, parent.id)).toEqual({ dispatches: { count: 1 }, receipts: { count: 1 }, revision: { revision: 1 } });
  });

  it("rolls back reclaim, child lease, resource locks, runner, revision, and replacement when its receipt fails", () => {
    const { store, parent, input } = retryFixture();
    const original = dispatchChildTask(store, { ...input, idempotencyKey: undefined });
    const child = claimChild(store, original);
    const reassign = { ...input, dispatchId: original.dispatchId, workerId: "replacement-child", idempotencyKey: "reassign-rollback" };
    store.db.exec(`CREATE TRIGGER fail_reassign_receipt BEFORE INSERT ON agent_child_dispatch_receipts
      BEGIN SELECT RAISE(ABORT,'reassign receipt failure'); END`);
    const before = snapshot(store);
    expect(() => reassignChildTask(store, reassign)).toThrow(/reassign receipt failure/);
    expect(snapshot(store)).toEqual(before);
    expect(store.db.prepare("SELECT status FROM agent_task_leases WHERE id=?").get(child.lease.workOrderId)).toEqual({ status: "claimed" });
    store.db.exec("DROP TRIGGER fail_reassign_receipt");
    const replacement = reassignChildTask(store, reassign);
    expect(reassignChildTask(store, reassign)).toEqual(replacement);
    expect(counts(store, parent.id)).toEqual({ dispatches: { count: 2 }, receipts: { count: 1 }, revision: { revision: 2 } });
  });
});
