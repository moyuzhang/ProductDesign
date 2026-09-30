import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccount } from "./codexAccount.js";
import { buildApp } from "./index.js";
import { Store } from "./db.js";
import { agentProfileProblem } from "./agentHarness.js";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn }));
const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "pcs-account-")); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function transport(respond: (method: string, params: any) => any) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() });
  child.kill.mockImplementation(() => { child.exitCode = 0; child.emit("exit", 0); return true; });
  const calls: Array<{ method: string; params: any }> = [];
  child.stdin.on("data", (data: Buffer) => {
    const request = JSON.parse(data.toString()); calls.push(request);
    if (!request.id) return;
    const result = respond(request.method, request.params);
    if (result !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`));
  });
  spawn.mockReturnValue(child);
  return { child, calls, notify: (params: unknown) => child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params })}\n`) };
}
function defaultReply(method: string) {
  if (method === "account/read") return { result: { account: null, requiresOpenaiAuth: true } };
  if (method === "account/login/start") return { result: { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-ONLY" } };
  return { result: {} };
}

describe("local managed Codex account", () => {
  it("reads safe account status without starting login or forwarding inherited API credentials", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-secret-never-transmitted"); vi.stubEnv("CODEX_API_KEY", "other-test-secret");
    const { calls } = transport((method) => method === "account/read" ? { result: { account: { type: "chatgpt", email: "test@example.test", planType: "plus", accessToken: "must-not-leak" } } } : defaultReply(method));
    const account = new CodexAccount(temp());
    try {
      expect(await account.status()).toEqual({ status: "signed-in", email: "test@example.test", planType: "plus", login: null });
      expect(calls.map((call) => call.method)).toEqual(["initialize", "initialized", "account/read"]);
      expect(spawn.mock.lastCall?.[2].env.OPENAI_API_KEY).toBeUndefined();
      expect(spawn.mock.lastCall?.[2].env.CODEX_API_KEY).toBeUndefined();
      expect(spawn.mock.lastCall?.[2].env.CODEX_HOME).toContain("codex-chatgpt");
    } finally { await account.close(); }
  });
  it("starts an explicit device attempt, reports sanitized failure, and permits retry/cancel", async () => {
    const { notify, calls } = transport(defaultReply); const account = new CodexAccount(temp());
    try {
      const login = await account.start("chatgptDeviceCode");
      expect(login).toMatchObject({ type: "chatgptDeviceCode", userCode: "TEST-ONLY" });
      await expect(account.start("chatgptDeviceCode")).rejects.toThrow("已有待完成");
      notify({ loginId: "unrelated", success: true });
      expect((await account.status()).login?.status).toBe("pending");
      notify({ loginId: "login-1", success: false, error: "sensitive-token-detail" });
      const status = await account.status(); expect(status.login?.status).toBe("failed");
      expect(JSON.stringify(status)).not.toContain("sensitive-token-detail");
      await account.start("chatgptDeviceCode"); await account.cancel("login-1");
      expect((await account.status()).login?.status).toBe("cancelled");
      expect(calls.some((call) => call.method === "account/login/cancel")).toBe(true);
    } finally { await account.close(); }
  });
  it("rejects non-official login links and cancels the attempt", async () => {
    const { calls } = transport((method) => method === "account/login/start" ? { result: { type: "chatgpt", loginId: "login-1", authUrl: "https://example.test/collect" } } : defaultReply(method));
    const account = new CodexAccount(temp());
    try {
      await expect(account.start("chatgpt")).rejects.toThrow("官方地址");
      expect(calls.some((call) => call.method === "account/login/cancel")).toBe(true);
    } finally { await account.close(); }
  });
  it("uses model/list pagination and exposes only supported model fields", async () => {
    transport((method, params) => method === "account/read" ? { result: { account: { type: "chatgpt" } } }
      : method === "model/list" ? { result: { data: [{ id: params.cursor ? "second" : "first", model: params.cursor ? "available-2" : "available-1", displayName: "Available", isDefault: !params.cursor, unknownSecret: "private" }], nextCursor: params.cursor ? null : "page2" } } : defaultReply(method));
    const account = new CodexAccount(temp());
    try {
      const result = await account.models(); expect(result.models.map((item) => item.model)).toEqual(["available-1", "available-2"]);
      expect(JSON.stringify(result)).not.toContain("private"); await account.logout();
    } finally { await account.close(); }
  });
  it("fails pending RPCs on process exit without leaking raw stderr", async () => {
    const { child } = transport(() => undefined); const account = new CodexAccount(temp());
    const failed = expect(account.status()).rejects.toThrow("Codex 账户服务不可用");
    child.stderr.write("never expose test secret"); child.kill(); await failed; await account.close();
  });
});

const localHeaders = { host: "localhost", origin: "http://localhost", "x-productdesign-local-auth": "1" };
const profileBody = { name: "Local ChatGPT", provider: "openai", protocol: "openai-responses", authMode: "chatgpt", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", models: ["available-model"], defaultModel: "available-model", enabled: true, timeoutMs: 60_000 };

describe("subscription API boundaries and persistence", () => {
  it("blocks remote, cross-origin, missing-header and actor requests before Codex runs", async () => {
    const dir = temp(); const app = buildApp({ dbPath: join(dir, "test.db"), dataDir: dir });
    const status = vi.spyOn(CodexAccount.prototype, "status").mockResolvedValue({ status: "signed-out", login: null });
    try {
      for (const input of [
        { headers: { host: "localhost" } },
        { headers: { ...localHeaders, origin: "https://untrusted.example" } },
        { headers: { ...localHeaders, host: "rebind.example" } },
        { headers: localHeaders, remoteAddress: "192.0.2.1" },
        { headers: { ...localHeaders, "x-productdesign-actor-type": "agent" } },
      ]) {
        expect([401, 403]).toContain((await app.inject({ method: "GET", url: "/api/codex/account", ...input })).statusCode);
      }
      expect(status).not.toHaveBeenCalled();
      const response = await app.inject({ method: "GET", url: "/api/codex/account", headers: localHeaders });
      expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });
  it("validates subscription profiles against account models and preserves legacy API mode", async () => {
    const dir = temp(); const app = buildApp({ dbPath: join(dir, "test.db"), dataDir: dir });
    vi.spyOn(CodexAccount.prototype, "models").mockResolvedValue({ models: [{ id: "available-model", model: "available-model", displayName: "Available", isDefault: true }] });
    try {
      const created = await app.inject({ method: "POST", url: "/api/llm-profiles", headers: localHeaders, payload: profileBody });
      expect(created.statusCode).toBe(200); expect(created.json()).toMatchObject({ authMode: "chatgpt", credentialConfigured: false });
      expect(agentProfileProblem(created.json())).toContain("Codex 设计执行暂不可用");
      for (const patch of [{ apiKey: "must-not-store" }, { protocol: "openai-chat" }, { models: ["invented"], defaultModel: "invented" }]) {
        expect((await app.inject({ method: "POST", url: "/api/llm-profiles", headers: localHeaders, payload: { ...profileBody, ...patch } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "POST", url: "/api/llm-profiles", payload: profileBody })).statusCode).toBe(403);
      const { authMode: _, ...legacy } = profileBody;
      const api = await app.inject({ method: "POST", url: "/api/llm-profiles", payload: { ...legacy, name: "Legacy API" } });
      expect(api.statusCode).toBe(200); expect(api.json().authMode).toBe("api-key");
      const check = await app.inject({ method: "POST", url: `/api/llm-profiles/${created.json().id}/test`, headers: localHeaders });
      expect(check.json()).toMatchObject({ ok: true, status: "connected" });
    } finally { await app.close(); }
    const reopened = new Store(join(dir, "test.db"), dir);
    try { expect(reopened.listLlmProfiles().map((profile) => profile.authMode).sort()).toEqual(["api-key", "chatgpt"]); }
    finally { reopened.close(); }
  });
});
