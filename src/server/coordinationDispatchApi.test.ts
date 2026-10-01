import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../mcp/index.js";
import { Store } from "./db.js";
import { buildApp } from "./index.js";
import { LocalMcpClient, mcpResultText, type AgentMcpResult } from "./localMcpClient.js";
import { beginAgentAuth, completeAgentAuth, expectedChallengeResponse, registerAgentCredential } from "./agentSecurity.js";
import { claimCoordinationLease } from "./coordinationLeases.js";
import { listClaimableAgentTasks } from "./agentTaskLeases.js";

const resources: Array<{ app: ReturnType<typeof buildApp>; store: Store; dir: string; client?: LocalMcpClient }> = [];
afterEach(async () => {
  for (const { app, store, dir, client } of resources.splice(0)) {
    await client?.close(); await app.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-dispatch-retry-"));
  const dbPath = join(dir, "test.db");
  const app = buildApp({ dbPath, dataDir: dir });
  await app.ready();
  const store = new Store(dbPath, dir);
  const resource: (typeof resources)[number] = { app, store, dir };
  resources.push(resource);
  const project = store.insertProject({ code: "DISPATCH", name: "Retry transport", summary: "", stage: "设计", health: "正常", progress: 0,
    riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dir, startAt: "", dueAt: "" });
  const diagram = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  store.updateDiagram(diagram.id, { nodes: [...diagram.nodes, {
    id: "retry-node", kind: "feature", label: "Retry", description: "", owner: "", acceptanceCriteria: "Design complete",
    requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 400, y: 200,
  }] });
  const task = listClaimableAgentTasks(store, project.id).find((item) => item.queue === "design" && item.nodeId === "retry-node")!;
  const credential = registerAgentCredential(store, { principalId: "test-main", agentId: "Main Agent", workerId: "main-worker",
    allowedRoles: ["approver"], allowedProjects: [project.id] });
  const connectionId = "test-dispatch-transport";
  const challenge = beginAgentAuth(store, credential.credentialId, connectionId);
  const timestamp = new Date().toISOString();
  const protocolVersion = "2025-06-18";
  const session = completeAgentAuth(store, { challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion,
    response: expectedChallengeResponse(credential.credentialSecret, challenge.challenge, connectionId, credential.credentialId, timestamp, protocolVersion) });
  const parent = claimCoordinationLease(store, { projectId: project.id, taskKey: task.taskKey, taskRevision: task.taskRevision,
    mainAgentId: "Main Agent", workerId: "main-worker", authSessionToken: session.authSessionToken, idempotencyKey: "parent" });
  const base = { leaseToken: parent.leaseToken, mainAgentId: "Main Agent" };
  const dispatch = { ...base, taskId: task.id, taskKey: task.taskKey, role: "designer", workerId: "child-worker", idempotencyKey: "retry" };
  const rest = (operation: string, payload: object) => app.inject({ method: "POST", url: `/api/projects/${project.id}/coordination-leases/${parent.id}/${operation}`, payload });
  const mcp = async () => {
    const client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir: dir }));
    resource.client = client;
    return { client, call: (name: string, args: object) =>
      (client as unknown as { request(method: string, params: unknown): Promise<AgentMcpResult> }).request("tools/call", {
        name, arguments: { projectRef: project.id, coordinationLeaseId: parent.id, ...args },
      }) };
  };
  return { store, dbPath, parent, project, base, dispatch, rest, mcp };
}

describe("retry-safe dispatch REST and MCP", () => {
  it("serializes concurrent identical REST dispatches and rejects concurrent intent conflicts", async () => {
    const f = await fixture();
    const results = await Promise.all([f.rest("dispatch", f.dispatch), f.rest("dispatch", f.dispatch)]);
    for (const result of results) expect(result.statusCode, result.body).toBe(200);
    expect(results[0].json()).toEqual(results[1].json());
    const conflicts = await Promise.all([f.rest("dispatch", f.dispatch), f.rest("dispatch", { ...f.dispatch, workerId: "other-child" })]);
    expect(conflicts.map((r) => r.statusCode)).toEqual([200, 409]);
    expect(conflicts[1].json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(f.store.db.prepare("SELECT dispatch_revision FROM agent_coordination_leases WHERE id=?").get(f.parent.id)).toEqual({ dispatch_revision: 1 });
    expect(f.store.db.prepare("SELECT count(*) AS count FROM agent_child_task_dispatches").get()).toEqual({ count: 1 });
  });

  it("replays REST reassignment before checking the reclaimed source and writes one receipt", async () => {
    const f = await fixture();
    const first = await f.rest("dispatch", f.dispatch);
    expect(first.statusCode, first.body).toBe(200);
    const payload = { ...f.base, dispatchId: first.json().dispatchId, role: "designer", agentId: first.json().agentId,
      workerId: "replacement", idempotencyKey: "retry" };
    const results = await Promise.all([f.rest("reassign", payload), f.rest("reassign", payload)]);
    for (const result of results) expect(result.statusCode, result.body).toBe(200);
    expect(results[0].json()).toEqual(results[1].json());
    expect(results[0].json()).toMatchObject({ dispatchVersion: 2, workerId: "replacement" });
    const conflict = await f.rest("reassign", { ...payload, reason: "different intent" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(f.store.db.prepare("SELECT operation,count(*) AS count FROM agent_child_dispatch_receipts GROUP BY operation ORDER BY operation").all())
      .toEqual([{ operation: "dispatch", count: 1 }, { operation: "reassign", count: 1 }]);
  });

  it.each(["", " ", "x".repeat(301)])("rejects invalid REST retry keys %j", async (idempotencyKey) => {
    const f = await fixture();
    const result = await f.rest("dispatch", { ...f.dispatch, idempotencyKey });
    expect(result.statusCode).toBe(400);
    expect(f.store.db.prepare("SELECT count(*) AS count FROM agent_child_task_dispatches").get()).toEqual({ count: 0 });
  });

  it("retains legacy unkeyed duplicate errors and authenticates before receipt conflicts", async () => {
    const f = await fixture();
    const { idempotencyKey: _, ...legacy } = f.dispatch;
    expect((await f.rest("dispatch", legacy)).statusCode).toBe(200);
    const duplicate = await f.rest("dispatch", legacy);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("CHILD_TASK_ALREADY_DISPATCHED");
    expect(f.store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts").get()).toEqual({ count: 0 });
    const forbidden = await f.rest("dispatch", { ...f.dispatch, leaseToken: "incorrect-parent-token" });
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json().code).toBe("COORDINATION_LEASE_LOST");
  });

  it("exposes optional bounded MCP keys and supports cross-transport current-state replay", async () => {
    const f = await fixture();
    const { call, client } = await f.mcp();
    for (const name of ["dispatch_child_task", "reassign_child_task"]) {
      const tool = (await client.listAgentTools()).find((item) => item.name === name)!;
      expect(tool.inputSchema.required).not.toContain("idempotencyKey");
      expect((tool.inputSchema.properties as Record<string, unknown>).idempotencyKey).toMatchObject({ type: "string", minLength: 1, maxLength: 300 });
    }
    const first = await call("dispatch_child_task", f.dispatch);
    expect(first.isError, mcpResultText(first)).not.toBe(true);
    const dispatch = JSON.parse(mcpResultText(first));
    const replay = await f.rest("dispatch", f.dispatch);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(dispatch);
    const payload = { ...f.base, dispatchId: dispatch.dispatchId, role: "designer", agentId: dispatch.agentId,
      workerId: "replacement", idempotencyKey: "retry" };
    const replacement = await call("reassign_child_task", payload);
    expect(replacement.isError, mcpResultText(replacement)).not.toBe(true);
    expect(mcpResultText(await call("reassign_child_task", payload))).toBe(mcpResultText(replacement));
    const conflict = await call("reassign_child_task", { ...payload, workerId: "different" });
    expect(conflict.isError).toBe(true);
    expect(mcpResultText(conflict)).toContain("IDEMPOTENCY_CONFLICT");
    const wrongToken = await call("reassign_child_task", { ...payload, leaseToken: "wrong-token", workerId: "different" });
    expect(wrongToken.isError).toBe(true);
    expect(mcpResultText(wrongToken)).toContain("COORDINATION_LEASE_LOST");
    const invalid = await call("dispatch_child_task", { ...f.dispatch, idempotencyKey: "" });
    expect(invalid.isError).toBe(true);
    const staleOriginal = await call("dispatch_child_task", f.dispatch);
    expect(staleOriginal.isError).toBe(true);
    expect(mcpResultText(staleOriginal)).toContain("DISPATCH_LOST");
  });
});

// Separate Node processes and SQLite connections contend on the same temporary
// database. The start barrier avoids merely repeating synchronous calls in one
// event loop; no service or real project database is involved.
async function concurrentProcesses(dbPath: string, operation: "dispatch" | "reassign", inputs: object[]) {
  const script = `
    import { Store } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/server/db.ts")).href)};
    import { dispatchChildTask, reassignChildTask } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "src/server/coordinationLeases.ts")).href)};
    const store = new Store(process.argv[1]);
    console.log("READY");
    process.stdin.once("data", () => {
      try { console.log(JSON.stringify({ result: (${operation === "dispatch" ? "dispatchChildTask" : "reassignChildTask"})(store, JSON.parse(process.argv[2])) })); }
      catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
      finally { store.close(); process.stdin.destroy(); }
    });
  `;
  const children = inputs.map((input) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script, dbPath, JSON.stringify(input)],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise<{ result?: { dispatchId: string }; code?: string }>((resolve, reject) => {
      child.stdout.on("data", (data) => { stdout += data.toString(); if (stdout.includes("READY\n")) readyResolve(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.on("error", (error) => { readyReject(error); reject(error); });
      child.on("close", (code) => {
        if (code !== 0) { const error = new Error(`Child exited ${code}: ${stderr}`); readyReject(error); reject(error); return; }
        try { resolve(JSON.parse(stdout.trim().split("\n").at(-1)!)); }
        catch (error) { readyReject(error as Error); reject(error); }
      });
    });
    // Attach a rejection handler while waiting for the startup barrier.
    void result.catch(() => undefined);
    return { child, ready, result };
  });
  const timer = setTimeout(() => { for (const { child } of children) child.kill(); }, 20_000);
  try {
    await Promise.all(children.map((child) => child.ready));
    for (const { child } of children) child.stdin.end("GO\n");
    return await Promise.all(children.map((child) => child.result));
  } finally { clearTimeout(timer); for (const { child } of children) child.kill(); }
}

describe("dispatch receipt SQLite concurrency", () => {
  it.each(["dispatch", "reassign"] as const)("commits one %s for identical requests from separate connections", async (operation) => {
    const f = await fixture();
    const source = operation === "reassign" ? (await f.rest("dispatch", f.dispatch)).json() : undefined;
    const input = { ...f.dispatch, projectId: f.project.id, coordinationLeaseId: f.parent.id,
      ...(source ? { dispatchId: source.dispatchId, agentId: source.agentId, workerId: "replacement" } : {}) };
    const results = await concurrentProcesses(f.dbPath, operation, [input, input]);
    expect(results[0].code).toBeUndefined();
    expect(results[1]).toEqual(results[0]);
    expect(f.store.db.prepare("SELECT dispatch_revision AS revision FROM agent_coordination_leases WHERE id=?").get(f.parent.id))
      .toEqual({ revision: source ? 2 : 1 });
  }, 30_000);

  it.each(["dispatch", "reassign"] as const)("commits exactly one %s intent when separate connections race with conflicting payloads", async (operation) => {
    const f = await fixture();
    const source = operation === "reassign" ? (await f.rest("dispatch", f.dispatch)).json() : undefined;
    const input = { ...f.dispatch, projectId: f.project.id, coordinationLeaseId: f.parent.id,
      ...(source ? { dispatchId: source.dispatchId, agentId: source.agentId, workerId: "replacement" } : {}) };
    const results = await concurrentProcesses(f.dbPath, operation, [input, { ...input, workerId: "contending-worker" }]);
    expect(results.filter((result) => result.result)).toHaveLength(1);
    expect(results.filter((result) => result.code)).toEqual([{ code: "IDEMPOTENCY_CONFLICT", message: expect.any(String) }]);
    expect(f.store.db.prepare("SELECT dispatch_revision AS revision FROM agent_coordination_leases WHERE id=?").get(f.parent.id))
      .toEqual({ revision: source ? 2 : 1 });
    expect(f.store.db.prepare("SELECT count(*) AS count FROM agent_child_dispatch_receipts WHERE operation=?").get(operation)).toEqual({ count: 1 });
  }, 30_000);
});
