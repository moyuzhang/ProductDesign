import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { assertAgentTaskLeaseForPlanAction, claimAgentTask, completeAgentTask } from "./agentTaskLeases.js";
import {
  AGENT_POLICY_VERSION,
  acknowledgeAgentPolicy,
  assertHumanForHighRisk,
  assertAgentWorkOrderContext,
  beginAgentAuth,
  completeAgentAuth,
  expectedChallengeResponse,
  issueOneTimeNonce,
  registerAgentCredential,
  revokeAgentCredential,
} from "./agentSecurity.js";

const resources: Array<{ store: Store; dir: string }> = [];
afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-agent-security-"));
  const dbPath = join(dir, "test.db");
  const store = new Store(dbPath);
  resources.push({ store, dir });
  const project = store.insertProject({
    code: "SECURITY", name: "Agent security", summary: "security", stage: "开发", health: "正常",
    progress: 0, riskLevel: "P0", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir,
    startAt: "", dueAt: "",
  });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: "secure-node", kind: "feature", label: "Secure work", description: "", owner: "team",
    acceptanceCriteria: "secured", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "未开发", acceptanceStatus: "未验收", x: 100, y: 100,
  }] });
  const plan = store.insertPlan({
    projectId: project.id, diagramId: main.id, diagramNodeId: "secure-node", parentId: null,
    kind: "task", title: "Secure plan", description: "", status: "未开始", priority: "P0", progress: 0,
    owner: "Builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    lifecycleStatus: "approved", proposedBy: "Designer", submittedAt: "2026-09-01T00:00:00.000Z",
    approvedBy: "Main Agent", approvedAt: "2026-09-01T00:01:00.000Z",
    roleAssignments: {
      designer: { agentId: "Designer", displayName: "Designer" },
      builder: { agentId: "Builder", displayName: "Builder" },
      auditor: { agentId: "Main Agent", displayName: "Main Agent" },
    },
  });
  return { store, dir, dbPath, project, plan };
}

function authenticate(store: Store, projectId: string) {
  const credential = registerAgentCredential(store, {
    principalId: "principal-builder", agentId: "Builder", workerId: "worker-builder",
    allowedRoles: ["builder"], allowedProjects: [projectId],
  });
  const connectionId = "connection-secure-builder-0001";
  const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
  const timestamp = new Date().toISOString();
  const response = expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId,
    credential.credentialId, timestamp, "2025-03-26");
  const principal = completeAgentAuth(store, { ...challenge, timestamp, protocolVersion: "2025-03-26", response });
  return { credential, principal, challenge, timestamp, response, connectionId };
}

describe("persistent Agent authentication and work-order gate", () => {
  it("keeps high-risk and unknown writes human-only", () => {
    expect(() => assertHumanForHighRisk("production_deploy", "agent"))
      .toThrowError(expect.objectContaining({ code: "HIGH_RISK_HUMAN_REQUIRED" }));
    expect(() => assertHumanForHighRisk("future_unknown_write", "system"))
      .toThrowError(expect.objectContaining({ code: "HIGH_RISK_HUMAN_REQUIRED" }));
    expect(() => assertHumanForHighRisk("routine_approval", "agent", true)).not.toThrow();
  });
  it("atomically consumes challenges and rejects forged credentials", () => {
    const { store, project } = fixture();
    const auth = authenticate(store, project.id);
    expect(auth.principal).toMatchObject({ principalId: "principal-builder", agentId: "Builder", workerId: "worker-builder" });
    expect(() => completeAgentAuth(store, {
      ...auth.challenge, timestamp: auth.timestamp, protocolVersion: "2025-03-26", response: auth.response,
    })).toThrowError(expect.objectContaining({ code: "TOKEN_REPLAYED" }));
    expect(() => beginAgentAuth(store, "00000000-0000-4000-8000-000000000000", auth.connectionId))
      .toThrowError(expect.objectContaining({ code: "CREDENTIAL_REJECTED" }));
  });

  it("binds policy, identity, work order and one-time nonce and survives restart", () => {
    const { store, dbPath, project } = fixture();
    const auth = authenticate(store, project.id);
    const ack = acknowledgeAgentPolicy(store, auth.principal, { role: "builder", projectId: project.id, policyVersion: AGENT_POLICY_VERSION });
    expect(() => acknowledgeAgentPolicy(store, auth.principal, { role: "builder", projectId: project.id, policyVersion: "old" }))
      .toThrowError(expect.objectContaining({ code: "POLICY_VERSION_STALE" }));
    const lease = claimAgentTask(store, {
      projectId: project.id, role: "builder", agentId: "Builder", workerId: "worker-builder",
      sessionId: "secure-session", runId: "secure-run", idempotencyKey: "secure-claim",
    });
    expect(() => completeAgentTask(store, {
      leaseToken: lease.leaseToken, agentId: "Builder", idempotencyKey: "incomplete-completion",
    })).toThrowError(expect.objectContaining({ code: "WORK_ORDER_SUBMISSION_INCOMPLETE" }));
    const planId = lease.taskId.slice(lease.taskId.indexOf(":") + 1);
    const target = `plan:${planId}`;
    const digest = "a".repeat(64);
    const nonce = issueOneTimeNonce(store, { policyAckToken: ack.policyAckToken, workOrderId: lease.workOrderId, action: "plan.start_development", target, bodyDigest: digest });
    const context = {
      policyAckToken: ack.policyAckToken, workOrderId: lease.workOrderId, leaseToken: lease.leaseToken,
      taskKey: lease.taskKey, taskRevision: lease.taskRevision, nonceId: nonce.nonceId,
      idempotencyKey: "secure-write", agentId: "Builder", workerId: "worker-builder", role: "builder" as const,
      projectId: project.id, action: "plan.start_development", target, bodyDigest: digest, connectionId: auth.connectionId,
    };
    expect(() => assertAgentTaskLeaseForPlanAction(store, { leaseToken: lease.leaseToken, agentId: "Builder", planId, action: "start_development" }))
      .toThrowError(expect.objectContaining({ code: "WORK_ORDER_CONTEXT_INVALID" }));
    expect(assertAgentTaskLeaseForPlanAction(store, {
      leaseToken: lease.leaseToken, agentId: "Builder", planId, action: "start_development", securityContext: context,
    })?.workOrderId).toBe(lease.workOrderId);
    expect(() => assertAgentWorkOrderContext(store, context)).toThrowError(expect.objectContaining({ code: "TOKEN_REPLAYED" }));

    store.close();
    resources.splice(resources.findIndex((item) => item.store === store), 1);
    const restarted = new Store(dbPath);
    resources.push({ store: restarted, dir: join(dbPath, "..") });
    expect(() => assertAgentWorkOrderContext(restarted, context)).toThrowError(expect.objectContaining({ code: "TOKEN_REPLAYED" }));
  });

  it("invalidates existing sessions and policy tokens on credential revocation", () => {
    const { store, project } = fixture();
    const auth = authenticate(store, project.id);
    acknowledgeAgentPolicy(store, auth.principal, { role: "builder", projectId: project.id, policyVersion: AGENT_POLICY_VERSION });
    revokeAgentCredential(store, auth.credential.credentialId);
    expect(() => acknowledgeAgentPolicy(store, auth.principal, { role: "builder", projectId: project.id, policyVersion: AGENT_POLICY_VERSION }))
      .toThrowError(expect.objectContaining({ code: "TOKEN_REVOKED" }));
  });
});
