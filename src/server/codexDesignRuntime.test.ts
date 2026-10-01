import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesignRuntime, DESIGN_CODEX_CONFIG, DESIGN_DISABLED_FEATURES, assertDesignEffectiveConfig, assertDesignThreadPolicy } from "./codexDesignRuntime.js";
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  Object.assign(execFile, { [Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => new Promise((resolve, reject) => execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))) });
  return { ...await original<typeof import("node:child_process")>(), execFile };
});
afterEach(() => vi.restoreAllMocks());
function mockCli(failProbe = false, unsafeWrite = false) {
  execFile.mockImplementation((_executable, args: string[], _options, callback) => {
    if (args.includes("--version")) callback(null, "codex-cli verified-fixture", "");
    else if (args.includes("generate-json-schema")) {
      const dir = join(args[args.indexOf("--out") + 1], "v2"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ThreadStartParams.json"), JSON.stringify({ properties: { config: {} }, definitions: { SandboxMode: { enum: ["read-only"] } } }));
      writeFileSync(join(dir, "TurnStartParams.json"), JSON.stringify({ definitions: { SandboxPolicy: { oneOf: [{ properties: { type: { enum: ["readOnly"] }, networkAccess: {} } }] } } }));
      callback(null, "", "");
    } else if (args.includes("features")) callback(null, DESIGN_DISABLED_FEATURES.map((feature) => `${feature} stable false`).join("\n"), "");
    else if (args.includes("sandbox")) {
      if (unsafeWrite) writeFileSync(args.at(-1)!, "UNSAFE");
      callback(failProbe ? new Error("OS sandbox unavailable") : null, "PRODUCTDESIGN_WRITE_DENIED", "");
    } else callback(new Error("unexpected invocation"), "", "");
    return {};
  });
}

describe("Codex design runtime boundary", () => {
  it("checks schema, disabled surfaces and real write denial before reporting ready", async () => {
    mockCli(); const runtime = new CodexDesignRuntime();
    expect(runtime.status().status).toBe("unchecked");
    const result = await runtime.check(); expect(result.status).toBe("ready");
    expect(execFile.mock.calls.some((call) => JSON.stringify(call[1]).includes("account/login"))).toBe(false);
    expect(execFile.mock.calls.some((call) => call[1].includes("sandbox"))).toBe(true);
  });
  it("fails closed on unsupported sandbox instead of bypassing or inferring readiness", async () => {
    mockCli(true); const runtime = new CodexDesignRuntime();
    await expect(runtime.ensure()).rejects.toThrow("sandbox 自检"); expect(runtime.status().status).toBe("unavailable");
    expect(JSON.stringify(runtime.status())).not.toContain("OS sandbox unavailable");
  });
  it("rejects a sentinel write even if a faulty runtime prints the expected denial message", async () => {
    mockCli(false, true); expect((await new CodexDesignRuntime().check()).status).toBe("unavailable");
  });
  it("checks effective configuration and rejects inherited tools or execution flags", () => {
    expect(() => assertDesignEffectiveConfig({ config: DESIGN_CODEX_CONFIG })).not.toThrow();
    for (const patch of [{ sandbox_mode: "workspace-write" }, { approval_policy: "on-request" }, { features: { ...DESIGN_CODEX_CONFIG.features, shell_tool: true } }, { mcp_servers: { external: { command: "executor" } } }, { plugins: { extra: { enabled: true } } }]) {
      expect(() => assertDesignEffectiveConfig({ config: { ...DESIGN_CODEX_CONFIG, ...patch } })).toThrow("配置不满足");
    }
  });
  it("requires returned thread policy to match no-write/no-network and rejects escalation", () => {
    expect(() => assertDesignThreadPolicy({ approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } })).not.toThrow();
    for (const sandbox of [{ type: "workspaceWrite" }, { type: "dangerFullAccess" }, { type: "readOnly", networkAccess: true }]) expect(() => assertDesignThreadPolicy({ approvalPolicy: "never", sandbox })).toThrow("只读");
  });
});
