import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../mcp/index.js";
import type { AgentTaskPackage, Project, AgentCoordinationLease, AgentChildTaskDispatch } from "../shared/types.js";
import { expectedChallengeResponse, type registerAgentCredential, type beginAgentAuth, type completeAgentAuth } from "./agentSecurity.js";
import type { listClaimableAgentTasks } from "./agentTaskLeases.js";
import { Store } from "./db.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText } from "./localMcpClient.js";

const resources: Array<{ app: ReturnType<typeof buildApp>; store: Store; dir: string; clients: LocalMcpClient[] }> = [];
afterEach(async () => {
  for (const { app, store, dir, clients } of resources.splice(0)) {
    for (const client of clients) await client.close();
    await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

const workspace = {
  repositoryId: "fixture:team/external-source", workspaceId: "synthetic-harness/isolated-worktree",
  workspacePath: "/external-harness-fixture/not-on-service/worktree", workspaceBranch: "test/external-lifecycle",
  baselineRevision: "a".repeat(40),
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-external-lifecycle-"));
  const dbPath = join(dir, "fixture.db");
  vi.stubEnv("PCS_AGENT_ADMIN_TOKEN", "synthetic-lifecycle-admin");
  const app = buildApp({ dbPath, dataDir: dir });
  const store = new Store(dbPath, dir);
  const clients: LocalMcpClient[] = [];
  resources.push({ app, store, dir, clients });
  // Actual loopback HTTP, and MCP JSON-RPC over the SDK's in-memory transport.
  // Neither transport targets a running service, live database or coding agent.
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const http = async <T = unknown>(method: string, path: string, payload?: object, admin = false) => {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { "content-type": "application/json", ...(admin ? { authorization: "Bearer synthetic-lifecycle-admin" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body as T;
  };
  const project = await http<Project>("POST", "/api/projects", { code: "HARNESS-FIXTURE", name: "External lifecycle fixture" });
  expect(project).toMatchObject({ repositoryPath: "", externalRepositoryId: "" });

  // Approved historical setup is a fixture, not proof of the approval workflow.
  // All direct Store writes end here, before source binding or lease activity.
  const brief = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准", version: "1", author: "fixture", content: "Synthetic lifecycle regression fixture" });
  store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
  const main = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  const nodeId = "external-lifecycle-node";
  store.updateDiagram(main.id, { nodes: [...main.nodes, { id: nodeId, kind: "feature", label: "External implementation", description: "Fixture only", owner: "team", acceptanceCriteria: "Formal blockers reach independent review", requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160 }] });
  store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
  const plan = store.insertPlan({ projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "External implementation", description: "", status: "未开始", priority: "P0", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], lifecycleStatus: "approved", proposedBy: "designer", submittedAt: "2026-01-01T00:00:00.000Z", approvedBy: "Main Agent", approvedAt: "2026-01-01T00:01:00.000Z", roleAssignments: { designer: { agentId: "designer", displayName: "Designer" }, builder: { agentId: "builder", displayName: "Builder" }, auditor: { agentId: "auditor", displayName: "Auditor" } } });

  const configured = await http("PATCH", `/api/projects/${project.id}`, { externalRepositoryId: workspace.repositoryId });
  expect(configured).toMatchObject({ id: project.id, repositoryPath: "", externalRepositoryId: workspace.repositoryId });
  const connect = async () => {
    const client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir: dir }));
    clients.push(client);
    const raw = (name: string, args: Record<string, unknown>) => client.callTool(name, args);
    return { client, raw, call: async (name: string, args: Record<string, unknown>) => {
      const result = await raw(name, args);
      expect(result.isError, mcpResultText(result, 100_000)).not.toBe(true);
      return JSON.parse(mcpResultText(result, 100_000));
    } };
  };
  const enroll = (agentId: string, workerId: string, role: string) => http<ReturnType<typeof registerAgentCredential>>("POST", "/api/agent-security/credentials", { principalId: `fixture/${workerId}`, agentId, workerId, allowedRoles: [role], allowedProjects: [project.id] }, true);
  const login = async (credential: { credentialId: string; credentialSecret: string }, connectionId: string) => {
    const challenge = await http<ReturnType<typeof beginAgentAuth>>("POST", "/api/agent-security/auth/challenge", { credentialId: credential.credentialId, connectionId });
    const timestamp = new Date().toISOString(), protocolVersion = "2025-06-18";
    return http<ReturnType<typeof completeAgentAuth>>("POST", "/api/agent-security/auth/complete", { challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion, response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId, credential.credentialId, timestamp, protocolVersion) });
  };
  return { app, store, project, plan, http, connect, enroll, login };
}

async function dispatchFixture() {
  const f = await fixture();
  const main = await f.login(await f.enroll("Main Agent", "main-fixture-worker", "approver"), "synthetic-main-connection");
  const credential = await f.enroll("builder", "external-fixture-worker", "builder");
  const child = await f.login(credential, "synthetic-child-connection");
  const parent = await f.http<AgentCoordinationLease>("POST", `/api/projects/${f.project.id}/coordination-leases`, { planId: f.plan.id, mainAgentId: main.agentId, workerId: main.workerId, authSessionToken: main.authSessionToken, idempotencyKey: "parent-claim" });
  expect(parent.stage).toBe("implementation");
  const control = { leaseToken: parent.leaseToken, mainAgentId: main.agentId };
  const parentPath = `/api/projects/${f.project.id}/coordination-leases/${parent.id}`;
  const tasks = await f.http<ReturnType<typeof listClaimableAgentTasks>>("GET", `/api/projects/${f.project.id}/agent-tasks`);
  const task = tasks.find((item) => item.planItemId === f.plan.id && item.queue === "development")!;
  expect(task.available).toBe(true);
  const dispatchInput = { ...control, taskId: task.id, taskKey: task.taskKey, role: "builder", agentId: child.agentId, workerId: child.workerId, idempotencyKey: "dispatch-once" };
  const dispatch = await f.http<AgentChildTaskDispatch>("POST", `${parentPath}/dispatch`, dispatchInput);
  expect(await f.http("POST", `${parentPath}/dispatch`, dispatchInput)).toEqual(dispatch);
  const claim = { projectRef: f.project.id, dispatchId: dispatch.dispatchId, agentId: child.agentId, workerId: child.workerId, authSessionToken: child.authSessionToken, externalWorkspace: workspace, idempotencyKey: "child-claim" };
  return { ...f, credential, parent, parentPath, control, dispatch, claim };
}

function leaseContext(packet: AgentTaskPackage) {
  const lease = packet.lease!;
  return { workOrderId: lease.workOrderId, leaseToken: lease.leaseToken, taskKey: lease.taskKey, taskRevision: lease.taskRevision, workerId: lease.workerId, agentId: lease.agentId, role: packet.task.role };
}

describe("external harness protocol lifecycle (synthetic, no coding agent)", () => {
  it("joins HTTP dispatch to external MCP execution, reconnect and formal blocker review", async () => {
    const f = await dispatchFixture();
    const first = await f.connect();
    const packet = await first.call("claim_dispatched_child_task", f.claim);
    expect(existsSync(workspace.workspacePath)).toBe(false);
    expect(packet).toMatchObject({ project: { id: f.project.id, repositoryPath: "", externalRepositoryId: workspace.repositoryId }, lease: { externalWorkspace: workspace }, launch: { executionOwner: "external-harness", sourceVerification: "runner-attestation" } });
    const context = leaseContext(packet);
    expect(await first.call("start_agent_task", { ...context, idempotencyKey: "start" })).toMatchObject({ status: "running", workspacePath: workspace.workspacePath, baselineRevision: workspace.baselineRevision });
    expect(await first.call("heartbeat_agent_task", { ...context, idempotencyKey: "heartbeat" })).toMatchObject({ status: "running", workOrderId: context.workOrderId });
    await first.client.close();
    const reconnect = await f.connect();
    const session = await f.login(f.credential, "synthetic-reconnected-child");
    const replay = await reconnect.call("claim_dispatched_child_task", { ...f.claim, authSessionToken: session.authSessionToken });
    expect(replay.lease).toMatchObject({ workOrderId: context.workOrderId, status: "running", externalWorkspace: workspace });
    const live = await f.http<AgentChildTaskDispatch[]>("GET", `${f.parentPath}/dispatches`);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ dispatchId: f.dispatch.dispatchId, status: "running" });
    const report = { ...context, idempotencyKey: "formal-gap", error: "Fixture: approved design omits the external runner evidence verification contract" };
    expect(await reconnect.call("report_design_gap", report)).toMatchObject({ status: "released", lastError: expect.stringContaining(report.error) });
    expect(await f.http("GET", `${f.parentPath}/dispatches`)).toEqual([expect.objectContaining({ dispatchId: f.dispatch.dispatchId, status: "reclaimed" })]);
    const tasks = await f.http<ReturnType<typeof listClaimableAgentTasks>>("GET", `/api/projects/${f.project.id}/agent-tasks`);
    expect(tasks).toEqual(expect.arrayContaining([expect.objectContaining({ planItemId: f.plan.id, queue: "approval", actionCode: "request_design_change", requiredRole: "approver" })]));
    expect(tasks.some((task) => task.planItemId === f.plan.id && task.queue === "development" && task.available)).toBe(false);
    const stale = await reconnect.raw("heartbeat_agent_task", { ...context, idempotencyKey: "after-gap" });
    expect(stale.isError).toBe(true);
    expect(mcpResultText(stale)).toContain("WORK_ORDER_CONTEXT_INVALID");
    expect(f.store.listEvidence(f.project.id)).toHaveLength(0);
  });

  it.each(["cancel", "reassign"])("%s rejects the old external child reconnect and late writes", async (operation) => {
    const f = await dispatchFixture();
    const mcp = await f.connect();
    // Exercise the HTTP child-claim boundary as well as MCP in the other test.
    const { projectRef: _, dispatchId: __, ...payload } = f.claim;
    const packet = await f.http<AgentTaskPackage>("POST", `/api/projects/${f.project.id}/child-task-dispatches/${f.dispatch.dispatchId}/claim`, payload);
    const context = leaseContext(packet);
    await mcp.call("start_agent_task", { ...context, idempotencyKey: "start" });
    if (operation === "cancel") {
      expect(await f.http("POST", `${f.parentPath}/release`, { ...f.control, reason: "Fixture user cancellation" })).toMatchObject({ status: "released" });
    } else {
      expect(await f.http("POST", `${f.parentPath}/reassign`, { ...f.control, dispatchId: f.dispatch.dispatchId,
        role: "builder", agentId: "builder", workerId: "replacement-fixture-worker", idempotencyKey: "reassign-once" }))
        .toMatchObject({ status: "dispatched", workerId: "replacement-fixture-worker" });
    }
    const terminal = await f.http<AgentChildTaskDispatch[]>("GET", `${f.parentPath}/dispatches`);
    expect(terminal).toHaveLength(operation === "cancel" ? 1 : 2);
    expect(terminal).toEqual(expect.arrayContaining([expect.objectContaining({ dispatchId: f.dispatch.dispatchId, status: "reclaimed" })]));
    const reconnect = await mcp.raw("claim_dispatched_child_task", f.claim);
    expect(reconnect.isError).toBe(true);
    expect(mcpResultText(reconnect)).toContain("DISPATCH_LOST");
    const late = await mcp.raw("heartbeat_agent_task", { ...context, idempotencyKey: "late-heartbeat" });
    expect(late.isError).toBe(true);
    expect(mcpResultText(late)).toContain(operation === "cancel" ? "LEASE_LOST" : "WORK_ORDER_CONTEXT_INVALID");
    expect(await f.http("GET", `${f.parentPath}/dispatches`)).toEqual(terminal);
    expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM agent_task_resource_locks").get()).toEqual({ count: 0 });
    expect(f.store.listEvidence(f.project.id)).toHaveLength(0);
  });
});
