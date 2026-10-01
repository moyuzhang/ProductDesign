import { DESIGN_CODEX_CONFIG } from "./codexDesignRuntime.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { buildBusinessSnapshot, createBackupFile, loadBackupFile } from "./backups.js";
import { CodexHarness } from "./agentHarness.js";
import { LocalMcpClient } from "./localMcpClient.js";
import { buildApp } from "./index.js";
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "../mcp/index.js";

// These tests exercise the dormant transport independently of the production design-isolation gate.
vi.mock("./designAgentPolicy.js", async (original) => ({ ...await original<typeof import("./designAgentPolicy.js")>(), codexDesignProblem: () => undefined }));
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn }));
const dirs: string[] = [];
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "pcs-reliability-")); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const projectInput = { code: "TEST", name: "Test", summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" };

describe("diagram history backup", () => {
  it("round-trips revision identities, ordering and the undo/redo cursor through disk", () => {
    const dir = tempDir(); const store = new Store(join(dir, "source.db"), dir);
    const restored = new Store(join(dir, "restored.db"), dir);
    try {
      const project = store.insertProject(projectInput);
      const initial = store.listDiagrams(project.id)[0];
      const first = store.updateDiagram(initial.id, { title: "first" })!;
      store.recordDiagramRevision(initial.id, initial, first, "tester");
      const second = store.updateDiagram(initial.id, { title: "second" })!;
      store.recordDiagramRevision(initial.id, first, second, "tester");
      store.undoDiagramRevision(initial.id);
      const backup = createBackupFile(store, dir, "history", "test");
      const snapshot = loadBackupFile(dir, backup.id);
      expect(restored.restoreBusinessSnapshot(snapshot).diagramRevisions).toBe(2);
      expect(restored.listDiagramRevisions(initial.id)).toEqual(store.listDiagramRevisions(initial.id));
      expect(restored.redoDiagramRevision(initial.id)?.title).toBe("second");
      expect(restored.undoDiagramRevision(initial.id)?.title).toBe("first");
      expect(restored.undoDiagramRevision(initial.id)?.title).toBe(initial.title);
      expect(restored.undoDiagramRevision(initial.id)).toBeUndefined();
      expect(restored.redoDiagramRevision(initial.id)?.title).toBe("first");
      expect(restored.redoDiagramRevision(initial.id)?.title).toBe("second");
      const withoutHistory = { ...(snapshot as Record<string, unknown>) }; delete withoutHistory.diagramRevisions;
      const legacyCount = Object.values(withoutHistory).filter(Array.isArray).reduce((n, items) => n + items.length, 0);
      const groupedCount = Object.values(withoutHistory).filter((value) => value && typeof value === "object" && !Array.isArray(value))
        .reduce<number>((count, value) => count + Object.values(value as Record<string, unknown[]>).reduce((n, list) => n + list.length, 0), 0);
      expect(backup.itemCount).toBe(legacyCount + groupedCount + 2);
      expect(restored.restoreBusinessSnapshot(withoutHistory).diagramRevisions).toBe(0);
      expect(restored.undoDiagramRevision(initial.id)).toBeUndefined();
    } finally { restored.close(); store.close(); }
  });
  it("rejects malformed history before touching current data and rolls back duplicate IDs", () => {
    const dir = tempDir(); const store = new Store(join(dir, "test.db"), dir);
    try {
      const project = store.insertProject(projectInput); const diagram = store.listDiagrams(project.id)[0];
      store.recordDiagramRevision(diagram.id, diagram, diagram, "tester");
      const snapshot = buildBusinessSnapshot(store);
      const revisions = snapshot.diagramRevisions[project.id];
      expect(() => store.restoreBusinessSnapshot({ ...snapshot, diagramRevisions: { [project.id]: [{ ...revisions[0], beforeJson: "bad" }] } })).toThrow();
      expect(() => store.restoreBusinessSnapshot({ ...snapshot, diagramRevisions: { [project.id]: [revisions[0], revisions[0]] } })).toThrow();
      expect(store.getProject(project.id)?.name).toBe("Test");
      expect(store.listDiagramRevisions(diagram.id)).toEqual(revisions);
    } finally { store.close(); }
  });
});

function harnessFixture(resume = true) {
  const dir = tempDir();
  const session = { id: "session", projectId: "project", profileId: "profile", model: "test", controlMode: "ask", codexThreadId: resume ? "original-thread" : null, status: "running" };
  const store = {
    getAgentSession: vi.fn(() => session), getProject: vi.fn(() => ({ ...projectInput, id: "project" })),
    getLlmProfile: vi.fn(() => ({ id: "profile", enabled: true, credentialConfigured: true, protocol: "openai-responses", timeoutMs: 1000, apiKeyEnv: "TEST_ONLY_KEY", baseUrl: "https://example.test" })),
    listDesignDocs: vi.fn(() => []), listDiagrams: vi.fn(() => []), listGovernance: vi.fn(() => []),
    listAgentMessages: vi.fn(() => []), resolveLlmKey: vi.fn(() => undefined),
    updateAgentSession: vi.fn((_id, patch) => Object.assign(session, patch)),
    updateAgentMessage: vi.fn((_id, patch) => patch), listAgentApprovals: vi.fn(() => []),
  };
  const mcp = { listAgentTools: vi.fn(async () => [] as Array<{ name: string; inputSchema: Record<string, unknown> }>), callTool: vi.fn(async () => ({ content: [{ type: "text", text: "fixture workflow" }] })), close: vi.fn(async () => {}) };
  vi.spyOn(LocalMcpClient, "connect").mockResolvedValue(mcp as unknown as LocalMcpClient);
  return { store, mcp, session, harness: new CodexHarness(store as unknown as Store, dir, () => ({} as McpServer), undefined, { ensure: async () => {} }) };
}
function fakeChild(respond: (method: string) => Record<string, unknown> | undefined) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() });
  child.kill.mockImplementation(() => { child.exitCode = 0; child.emit("exit", 0); return true; });
  const methods: string[] = [];
  const requests: Array<{ method: string; params: Record<string, any> }> = [];
  child.stdin.on("data", (data: Buffer) => {
    const request = JSON.parse(data.toString()); methods.push(request.method); requests.push(request);
    if (!request.id) return;
    const response = request.method === "config/read" ? { result: { config: DESIGN_CODEX_CONFIG } } : respond(request.method);
    if (response?.result && typeof response.result === "object" && "thread" in response.result) Object.assign(response.result, { approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } });
    if (response) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`));
  });
  spawn.mockReturnValue(child);
  return { child, methods, requests };
}

describe("agent lifecycle reliability", () => {
  it("observes stdin failures and settles the pending run with cleanup", async () => {
    const { harness, store, mcp } = harnessFixture();
    const { child, methods } = fakeChild(() => undefined);
    const run = harness.runTurn("session", "message", "test");
    // Observe both outcomes immediately; the assertion below also stays safe on old code.
    const outcome = run.catch((error: Error) => error);
    await vi.waitFor(() => expect(methods).toContain("initialize"));
    const observed = child.stdin.listenerCount("error") > 0;
    if (observed) child.stdin.emit("error", new Error("fixture pipe failure"));
    else await harness.close();
    const result = await outcome;
    expect(observed).toBe(true);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("fixture pipe failure");
    expect(store.updateAgentMessage).toHaveBeenCalledWith("message", expect.objectContaining({ status: "failed" }));
    expect(mcp.close).toHaveBeenCalledOnce();
    expect(harness.isRunning("session")).toBe(false);
    await harness.close();
  });
  it.each([false, true])("contains a streaming persistence failure within its run (persistent=%s)", async (persistent) => {
    const { harness, store, mcp } = harnessFixture();
    const { child, methods } = fakeChild((method) => method === "thread/resume"
      ? { result: { thread: { id: "original-thread" } } } : method === "turn/start"
        ? { result: { turn: { id: "turn" } } } : { result: {} });
    const outcome = harness.runTurn("session", "message", "test").catch((error: Error) => error);
    await vi.waitFor(() => expect(methods).toContain("turn/start"));
    const persistenceFailure = () => { throw new Error("fixture persistence unavailable"); };
    if (persistent) store.updateAgentMessage.mockImplementation(persistenceFailure);
    else store.updateAgentMessage.mockImplementationOnce(persistenceFailure);
    let escaped: unknown;
    try { child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "x".repeat(80) } })}\n`); }
    catch (error) { escaped = error; }
    if (escaped) await harness.close();
    else {
      child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "later output" } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } })}\n`);
    }
    const result = await outcome;
    expect(escaped).toBeUndefined();
    expect((result as Error).message).toContain("fixture persistence unavailable");
    expect(store.updateAgentMessage).toHaveBeenCalledWith("message", expect.objectContaining({ status: "failed" }));
    expect(mcp.close).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalled();
    expect(store.updateAgentMessage).not.toHaveBeenCalledWith("message", expect.objectContaining({ status: "completed" }));
    expect(harness.isRunning("session")).toBe(false);
    await harness.close();
  });
  it("throttles full-text writes after 64 characters and flushes the final ordered output", async () => {
    const { harness, store } = harnessFixture();
    const { child, methods } = fakeChild((method) => method === "thread/resume"
      ? { result: { thread: { id: "original-thread" } } } : method === "turn/start"
        ? { result: { turn: { id: "turn" } } } : { result: {} });
    const run = harness.runTurn("session", "message", "test");
    await vi.waitFor(() => expect(methods).toContain("turn/start"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1000000);
    store.updateAgentMessage.mockClear();
    const delta = (text: string) => child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: text } })}\n`);
    delta("a".repeat(80)); delta("b"); delta("c");
    const burstWrites = store.updateAgentMessage.mock.calls.length;
    now.mockReturnValue(1000300); delta("d");
    const timedWrites = store.updateAgentMessage.mock.calls.length;
    delta("e");
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } })}\n`);
    const result = await run;
    expect(burstWrites).toBe(1);
    expect(timedWrites).toBe(2);
    expect(result.message.content).toBe("a".repeat(80) + "bcde");
    expect(store.updateAgentMessage).toHaveBeenLastCalledWith("message", { content: "a".repeat(80) + "bcde", status: "completed" });
    await harness.close();
  });

  it("surfaces resume failures without starting another thread or losing the original identity", async () => {
    const { store, session, harness, mcp } = harnessFixture();
    const { methods } = fakeChild((method) => method === "thread/resume" ? { error: { message: "temporary provider outage" } } : { result: {} });
    await expect(harness.runTurn("session", "message", "latest prompt")).rejects.toThrow("无法恢复原 Codex 会话");
    expect(methods).not.toContain("thread/start"); expect(methods).not.toContain("turn/start");
    expect(session.codexThreadId).toBe("original-thread");
    expect(store.updateAgentMessage).toHaveBeenCalledWith("message", expect.objectContaining({ status: "failed" }));
    expect(mcp.close).toHaveBeenCalledOnce(); await harness.close();
  });
  it("uses signed-in ChatGPT and the built-in provider without API credentials", async () => {
    const { store, harness } = harnessFixture();
    store.getLlmProfile.mockReturnValue({ ...store.getLlmProfile(), authMode: "chatgpt", credentialConfigured: false } as any);
    const { requests } = fakeChild((method) => method === "account/read" ? { result: { account: { type: "chatgpt" } } }
      : method === "model/list" ? { result: { data: [{ model: "test" }] } }
      : method === "thread/resume" ? { error: { message: "stop fixture before inference" } } : { result: {} });
    await expect(harness.runTurn("session", "message", "design request")).rejects.toThrow("stop fixture");
    const params = requests.find((item) => item.method === "thread/resume")!.params;
    expect(params.modelProvider).toBe("openai");
    expect(params.config).toMatchObject({ model_provider: "openai", forced_login_method: "chatgpt" });
    expect(params.config).not.toHaveProperty("model_providers");
    expect(store.resolveLlmKey).not.toHaveBeenCalled();
    await harness.close();
  });
  it("fails signed-out ChatGPT runs before starting any thread", async () => {
    const { store, harness } = harnessFixture();
    store.getLlmProfile.mockReturnValue({ ...store.getLlmProfile(), authMode: "chatgpt", credentialConfigured: false } as any);
    const { methods } = fakeChild((method) => method === "account/read" ? { result: { account: null } } : { result: {} });
    await expect(harness.runTurn("session", "message", "design request")).rejects.toThrow("完成 ChatGPT 登录");
    expect(methods).not.toContain("thread/start"); expect(methods).not.toContain("thread/resume"); await harness.close();
  });
  it("aborts pending initialize RPC and waits for run cleanup, rejecting new work", async () => {
    const { harness, store, mcp } = harnessFixture();
    const { methods } = fakeChild(() => undefined);
    const run = harness.runTurn("session", "message", "test");
    const failed = expect(run).rejects.toThrow("Agent 服务已关闭");
    await vi.waitFor(() => expect(methods).toContain("initialize"));
    const closing = harness.close(); expect(harness.close()).toBe(closing);
    await closing; await failed;
    expect(harness.isRunning("session")).toBe(false); expect(mcp.close).toHaveBeenCalledOnce();
    store.getAgentSession.mockClear();
    await expect(harness.runTurn("session", "message", "test")).rejects.toThrow("无法启动新任务");
    expect(store.getAgentSession).not.toHaveBeenCalled();
  });
  it("keeps a run active until its asynchronous persistence and cleanup finish", async () => {
    const { harness, store } = harnessFixture();
    store.getLlmProfile.mockReturnValue({ ...store.getLlmProfile(), protocol: "openai-chat" });
    let finish!: () => void;
    const drained = new Promise<void>((resolve) => { finish = resolve; });
    let signal: AbortSignal | undefined;
    Object.assign(harness, { runDirectTurn: async (...args: unknown[]) => {
      signal = args[4] as AbortSignal;
      await drained;
      store.updateAgentMessage("message", { status: "failed" });
      throw new Error("stopped");
    } });
    const run = harness.runTurn("session", "message", "test");
    const failed = expect(run).rejects.toThrow("stopped");
    let closed = false; const closing = harness.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(signal?.aborted).toBe(true); expect(closed).toBe(false); expect(harness.isRunning("session")).toBe(true);
    finish(); await closing; await failed;
    expect(store.updateAgentMessage).toHaveBeenCalled(); expect(harness.isRunning("session")).toBe(false);
  });
  it("drains an in-flight Codex tool callback before MCP teardown and shutdown", async () => {
    const { harness, mcp, store } = harnessFixture();
    mcp.listAgentTools.mockResolvedValueOnce([{ name: "get_project", inputSchema: {} }]);
    let finishTool!: () => void;
    const toolResult = new Promise<void>((resolve) => { finishTool = resolve; });
    const execute = vi.fn(async () => {
      await toolResult;
      store.updateAgentMessage("tool-result", { content: "persisted after tool completion" });
      return "done";
    });
    Object.assign(harness, { executeProjectMcpTool: execute });
    const { child, methods } = fakeChild((method) => method === "initialize" ? { result: {} }
      : method === "thread/resume" ? { result: { thread: { id: "original-thread" } } } : undefined);
    const run = harness.runTurn("session", "message", "test");
    const failed = expect(run).rejects.toThrow("Agent 服务已关闭");
    await vi.waitFor(() => expect(methods).toContain("turn/start"));
    child.stdout.write(`${JSON.stringify({ id: 90, method: "item/tool/call", params: { tool: "get_project", arguments: {} } })}\n`);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    let closed = false;
    const closing = harness.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false); expect(mcp.close).not.toHaveBeenCalled();
    finishTool(); await closing; await failed;
    expect(store.updateAgentMessage).toHaveBeenCalledWith("tool-result", { content: "persisted after tool completion" });
    expect(mcp.close).toHaveBeenCalledOnce();
  });
  it("closes MCP resources when setup fails before spawning Codex", async () => {
    const { harness, mcp } = harnessFixture();
    mcp.listAgentTools.mockRejectedValueOnce(new Error("tool discovery failed"));
    await expect(harness.runTurn("session", "message", "test")).rejects.toThrow("tool discovery failed");
    expect(mcp.close).toHaveBeenCalledOnce(); await harness.close();
  });
  it("revokes a local MCP session when its SDK transport closes", async () => {
    const dir = tempDir(); const store = new Store(join(dir, "mcp.db"), dir);
    try {
      const project = store.insertProject(projectInput);
      const server = createMcpServer({ store, dataDir: dir, localAuthorization: { projectRef: project.id, workerId: "test-worker" } });
      const [, transport] = InMemoryTransport.createLinkedPair();
      await server.connect(transport);
      expect(store.db.prepare("SELECT status FROM agent_credentials").get()).toEqual({ status: "active" });
      await server.close();
      expect(store.db.prepare("SELECT status FROM agent_credentials").get()).toEqual({ status: "revoked" });
    } finally { store.close(); }
  });
  it("closes a real connected event stream before waiting for HTTP shutdown", async () => {
    const dir = tempDir();
    const app = buildApp({ dbPath: join(dir, "stream.db"), dataDir: dir });
    const projectResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Stream fixture", code: "STREAM" } });
    expect(projectResponse.statusCode).toBe(200);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    try {
      const response = await fetch(`${address}/api/projects/${projectResponse.json().id}/agent-events`, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const ended = reader.read();
      await app.close();
      expect(await ended).toEqual({ done: true, value: undefined });
      reader.releaseLock();
    } finally { controller.abort(); await app.close(); }
  }, 5000);
  it("does not close the application store until harness drain completes", async () => {
    const dir = tempDir(); let finish!: () => void;
    const drained = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(CodexHarness.prototype, "close").mockReturnValue(drained);
    const closeStore = vi.spyOn(Store.prototype, "close");
    const app = buildApp({ dbPath: join(dir, "app.db"), dataDir: dir }); await app.ready();
    const closeApp = app.close();
    await vi.waitFor(() => expect(CodexHarness.prototype.close).toHaveBeenCalled());
    expect(closeStore).not.toHaveBeenCalled(); finish(); await closeApp;
    expect(closeStore).toHaveBeenCalledOnce();
  });
});
