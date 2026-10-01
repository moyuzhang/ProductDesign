import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp/index.js";
import type { AgentTaskPackage, ExternalWorkspaceBinding } from "../shared/types.js";
import { Store } from "./db.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText, type AgentMcpResult } from "./localMcpClient.js";

const resources: Array<{ app: ReturnType<typeof buildApp>; store: Store; dir: string; clients: LocalMcpClient[] }> = [];
afterEach(async () => {
  for (const { app, store, dir, clients } of resources.splice(0)) {
    for (const client of clients) await client.close();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-external-transport-"));
  const dbPath = join(dir, "test.db");
  const app = buildApp({ dbPath, dataDir: dir });
  await app.ready();
  const store = new Store(dbPath, dir);
  const clients: LocalMcpClient[] = [];
  resources.push({ app, store, dir, clients });
  const mcp = async (trustedInternal = false) => {
    const client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir: dir, trustedInternal }));
    clients.push(client);
    return (name: string, args: Record<string, unknown>) =>
      (client as unknown as { request(method: string, params: unknown): Promise<AgentMcpResult> })
        .request("tools/call", { name, arguments: args });
  };
  return { app, store, dir, mcp };
}

async function createProject(f: Awaited<ReturnType<typeof fixture>>, external = true, code = "EXTERNAL") {
  const created = await f.app.inject({ method: "POST", url: "/api/projects", payload: { code, name: "Remote source project" } });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id as string;
  expect(created.json()).toMatchObject({ repositoryPath: "", externalRepositoryId: "" });
  if (external) {
    const configured = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { externalRepositoryId: "provider:team/repository" } });
    expect(configured.statusCode, configured.body).toBe(200);
    expect(configured.json()).toMatchObject({ repositoryPath: "", externalRepositoryId: "provider:team/repository" });
  }
  return id;
}

function seedDevelopmentTask(store: Store, projectId: string) {
  const brief = store.insertDesignDoc({ projectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准", version: "1", author: "manager", content: "Transport regression fixture" });
  store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
  const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
  const nodeId = "external-source-node";
  store.updateDiagram(main.id, { nodes: [...main.nodes, {
    id: nodeId, kind: "feature", label: "Remote implementation", description: "Transport fixture", owner: "team",
    acceptanceCriteria: "Remote workspace identity survives the API", requirementStatus: "已批准", designStatus: "已批准",
    developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160,
  }] });
  return store.insertPlan({
    projectId, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "Remote implementation",
    description: "", status: "未开始", priority: "P0", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [],
    blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer", submittedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: "Main Agent", approvedAt: "2026-01-01T00:01:00.000Z", roleAssignments: {
      designer: { agentId: "designer", displayName: "Designer" }, builder: { agentId: "builder", displayName: "Builder" }, auditor: { agentId: "auditor", displayName: "Auditor" },
    },
  });
}

/** Synthetic authorization rows exist only in this isolated temporary test database. */
function session(store: Store, projectId: string, overrides: { agentId?: string; workerId?: string; roles?: readonly string[]; projects?: readonly string[] } = {}) {
  const id = randomUUID();
  const token = `synthetic-transport-session-${id}`;
  const agentId = overrides.agentId ?? "builder";
  const workerId = overrides.workerId ?? "external-worker";
  const roles = JSON.stringify(overrides.roles ?? ["builder"]);
  const projects = JSON.stringify(overrides.projects ?? [projectId]);
  const now = new Date().toISOString();
  const expiry = "2999-01-01T00:00:00.000Z";
  store.db.prepare(`INSERT INTO agent_credentials (credential_id, principal_id, agent_id, worker_id, secret_hash,
    allowed_roles_json, allowed_projects_json, issued_at, expires_at) VALUES (?, ?, ?, ?, 'unused-test-fixture', ?, ?, ?, ?)`)
    .run(id, id, agentId, workerId, roles, projects, now, expiry);
  store.db.prepare(`INSERT INTO agent_auth_sessions (session_token_hash, credential_id, principal_id, agent_id, worker_id,
    allowed_roles_json, allowed_projects_json, connection_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(createHash("sha256").update(token).digest("hex"), id, id, agentId, workerId, roles, projects, `test-${id}`, now, expiry);
  return token;
}

function workspace(): ExternalWorkspaceBinding {
  return { repositoryId: "provider:team/repository", workspaceId: "remote-worker:isolated-worktree",
    workspacePath: "Z:\\remote-harness\\source-worktree", workspaceBranch: "feature/external-workspace", baselineRevision: "a".repeat(40) };
}

function claimPayload(authSessionToken?: string) {
  return { role: "builder", agentId: "builder", workerId: "external-worker", idempotencyKey: "transport-claim",
    externalWorkspace: workspace(), ...(authSessionToken ? { authSessionToken } : {}) };
}

function leaseCount(store: Store): number {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get()) return 0;
  return (store.db.prepare("SELECT COUNT(*) AS n FROM agent_task_leases").get() as { n: number }).n;
}

function expectExternalPackage(packet: AgentTaskPackage, projectId: string) {
  expect(packet).toMatchObject({
    project: { id: projectId, repositoryPath: "", externalRepositoryId: workspace().repositoryId },
    worker: { agentId: "builder", workerId: "external-worker" },
    lease: { externalWorkspace: workspace(), workspace: { workspacePath: workspace().workspacePath, recommendedBranch: workspace().workspaceBranch, baselineRevision: workspace().baselineRevision } },
    workingDirectory: { repositoryPath: workspace().workspacePath, location: "external", verification: "runner-attestation", ready: true, exists: false, directory: false },
    launch: { workingDirectory: workspace().workspacePath, executionOwner: "external-harness", sourceVerification: "runner-attestation" },
  });
  expect(packet.launch.prompt).toContain(workspace().workspacePath);
}

describe("external workspace transport integration", () => {
  it("explicitly creates and configures a project without a local source repository", async () => {
    const f = await fixture();
    const id = await createProject(f);
    expect(f.store.getProject(id)).toMatchObject({ repositoryPath: "", externalRepositoryId: workspace().repositoryId });
    expect(existsSync(workspace().workspacePath)).toBe(false);
    const fetched = await f.app.inject({ method: "GET", url: `/api/projects/${id}` });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json().externalRepositoryId).toBe(workspace().repositoryId);
    const conflict = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { repositoryPath: f.dir } });
    expect(conflict.statusCode, conflict.body).toBe(400);
    expect(conflict.json().code).toBe("PROJECT_REPOSITORY_MODE_CONFLICT");
    const invalid = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { externalRepositoryId: "invalid identity" } });
    expect(invalid.statusCode).toBe(400);
    expect(f.store.getProject(id)?.externalRepositoryId).toBe(workspace().repositoryId);
  });

  it("supports explicit MCP creation followed by external repository configuration", async () => {
    const f = await fixture();
    // Project administration uses the existing trusted host channel; Worker claims below do not.
    const call = await f.mcp(true);
    const created = await call("create_product_design_project", { code: "MCP-EXTERNAL", name: "MCP external source" });
    expect(created.isError).not.toBe(true);
    const project = f.store.listProjects().find((item) => item.code === "MCP-EXTERNAL")!;
    expect(project).toMatchObject({ repositoryPath: "", externalRepositoryId: "" });
    const configured = await call("update_project", { projectRef: project.id, externalRepositoryId: workspace().repositoryId });
    expect(configured.isError, mcpResultText(configured)).not.toBe(true);
    expect(f.store.getProject(project.id)).toMatchObject({ repositoryPath: "", externalRepositoryId: workspace().repositoryId });
    expect(mcpResultText(configured)).toContain(workspace().repositoryId);
  });

  it("preserves the full external workspace binding and response replay through REST", async () => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const payload = claimPayload(session(f.store, id));
    const first = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(first.statusCode, first.body).toBe(200);
    expectExternalPackage(first.json(), id);
    const replay = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().lease).toEqual(first.json().lease);
    const reconfigured = await f.app.inject({ method: "PATCH", url: `/api/projects/${id}`, payload: { externalRepositoryId: "provider:other/repository" } });
    expect(reconfigured.statusCode, reconfigured.body).toBe(409);
    expect(reconfigured.json().code).toBe("PROJECT_REPOSITORY_ACTIVE_LEASE");
  });

  it.each(["get_agent_task_package", "claim_next_agent_task"])("preserves the full binding through external MCP %s", async (tool) => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const call = await f.mcp();
    const result = await call(tool, { projectRef: id, ...claimPayload(session(f.store, id)) });
    expect(result.isError, mcpResultText(result)).not.toBe(true);
    expectExternalPackage(JSON.parse(mcpResultText(result, 100_000)), id);
  });

  it.each([undefined, "invalid-session-token-with-adequate-length"])("rejects missing or invalid REST authentication (%s)", async (token) => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const result = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload: claimPayload(token) });
    expect(result.statusCode, result.body).toBe(401);
    expect(result.json().code).toBe("AUTH_REQUIRED");
    expect(leaseCount(f.store)).toBe(0);
  });

  it.each([undefined, "invalid-session-token-with-adequate-length"])("rejects missing or invalid external MCP authentication (%s)", async (token) => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const call = await f.mcp();
    const result = await call("claim_next_agent_task", { projectRef: id, ...claimPayload(token) });
    expect(result.isError).toBe(true);
    expect(mcpResultText(result)).toContain("AUTH_REQUIRED");
  });

  it.each([
    [{ agentId: "other-agent" }, "PRINCIPAL_SPOOF_REJECTED"],
    [{ workerId: "other-worker" }, "PRINCIPAL_SPOOF_REJECTED"],
    [{ projects: ["foreign-project"] }, "PERMISSION_DENIED"],
    [{ roles: ["auditor"] }, "PERMISSION_DENIED"],
  ] as const)("rejects sessions with mismatched principal scope in both transports (%j)", async (scope, code) => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const token = session(f.store, id, scope);
    const result = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload: claimPayload(token) });
    expect(result.statusCode, result.body).toBe(403);
    expect(result.json().code).toBe(code);
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: id, ...claimPayload(token) });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain(code);
  });

  it("rejects missing projects through both transports without creating a project", async () => {
    const f = await fixture();
    const rest = await f.app.inject({ method: "POST", url: "/api/projects/missing-project/agent-task-package", payload: claimPayload() });
    expect(rest.statusCode).toBe(404);
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: "missing-project", ...claimPayload() });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain("PROJECT_NOT_FOUND");
    expect(f.store.listProjects()).toHaveLength(0);
  });

  it("rejects a workspace bound to a foreign repository through REST and MCP", async () => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const payload = { ...claimPayload(session(f.store, id)), externalWorkspace: { ...workspace(), repositoryId: "provider:foreign/repository" } };
    const rest = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(rest.statusCode, rest.body).toBe(409);
    expect(rest.json().code).toBe("EXTERNAL_REPOSITORY_MISMATCH");
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: id, ...payload });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain("EXTERNAL_REPOSITORY_MISMATCH");
  });

  it("requires the full workspace binding for external development through REST and MCP", async () => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const { externalWorkspace: _externalWorkspace, ...payload } = claimPayload(session(f.store, id));
    const rest = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(rest.statusCode, rest.body).toBe(409);
    expect(rest.json().code).toBe("EXTERNAL_WORKSPACE_REQUIRED");
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: id, ...payload });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain("EXTERNAL_WORKSPACE_REQUIRED");
  });

  it("rejects incomplete workspace attestations at both transport boundaries", async () => {
    const f = await fixture();
    const id = await createProject(f);
    seedDevelopmentTask(f.store, id);
    const payload = { ...claimPayload(session(f.store, id)), externalWorkspace: { ...workspace(), baselineRevision: "short-sha" } };
    const rest = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(rest.statusCode, rest.body).toBe(400);
    expect(rest.json().message).toContain("baselineRevision");
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: id, ...payload });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain("baselineRevision");
  });

  it("keeps local development claims blocked when repositoryPath is missing", async () => {
    const f = await fixture();
    const id = await createProject(f, false);
    seedDevelopmentTask(f.store, id);
    const { externalWorkspace: _externalWorkspace, ...payload } = claimPayload();
    const rest = await f.app.inject({ method: "POST", url: `/api/projects/${id}/agent-task-package`, payload });
    expect(rest.statusCode, rest.body).toBe(409);
    expect(rest.json().code).toBe("WORKING_DIRECTORY_NOT_READY");
    const call = await f.mcp();
    const mcp = await call("claim_next_agent_task", { projectRef: id, ...payload });
    expect(mcp.isError).toBe(true);
    expect(mcpResultText(mcp)).toContain("WORKING_DIRECTORY_NOT_READY");
    expect(leaseCount(f.store)).toBe(0);
  });
});
