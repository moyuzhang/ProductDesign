import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexCommand, chatgptCodexEnv } from "./codexRuntime.js";

const runFile = promisify(execFile);
export const DESIGN_DISABLED_FEATURES = ["shell_tool", "unified_exec", "multi_agent", "multi_agent_v2", "apps", "hooks", "code_mode", "code_mode_host", "deferred_executor", "remote_plugin", "skill_mcp_dependency_install", "tool_suggest"] as const;
export const DESIGN_CODEX_CONFIG = {
  approval_policy: "never", sandbox_mode: "read-only", web_search: "disabled", project_doc_max_bytes: 0,
  features: Object.fromEntries(DESIGN_DISABLED_FEATURES.map((name) => [name, false])),
};
export function designCodexArgs(): string[] {
  return [...DESIGN_DISABLED_FEATURES.flatMap((name) => ["--disable", name]),
    "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0"];
}
export interface CodexDesignRuntimeStatus {
  status: "unchecked" | "ready" | "unavailable";
  message: string;
  version?: string;
  checkedAt?: string;
  code?: string;
}

export function assertDesignEffectiveConfig(value: unknown): void {
  const config = (value as { config?: Record<string, any> } | null)?.config;
  if (!config || config.sandbox_mode !== "read-only" || config.approval_policy !== "never"
    || config.web_search !== "disabled" || config.project_doc_max_bytes !== 0
    || DESIGN_DISABLED_FEATURES.some((name) => name !== "unified_exec" && config.features?.[name] !== false)
    || Object.values(config.mcp_servers ?? {}).some((server: any) => server?.enabled !== false)
    || Object.values(config.plugins ?? {}).some((plugin: any) => plugin?.enabled !== false)
    || [config.browser_use, config.computer_use, config.desktop].some((surface: any) => surface?.enabled === true)) {
    throw new Error("Codex 生效配置不满足设计隔离要求，已停止；不会降级为可写或命令执行模式");
  }
}
export function assertDesignThreadPolicy(value: Record<string, unknown>): void {
  const sandbox = value.sandbox as { type?: string; networkAccess?: boolean } | undefined;
  if (value.approvalPolicy !== "never" || sandbox?.type !== "readOnly" || sandbox.networkAccess !== false) {
    throw new Error("Codex 未确认只读、无网络的设计沙箱，已停止本轮");
  }
}

/** Probe only disposable files; never starts login, a model request or a target-project command. */
export class CodexDesignRuntime {
  private result: CodexDesignRuntimeStatus = { status: "unchecked", message: "尚未检查本机 Codex 设计运行环境" };
  private checking?: Promise<CodexDesignRuntimeStatus>;
  status(): CodexDesignRuntimeStatus { return { ...this.result }; }
  check(): Promise<CodexDesignRuntimeStatus> {
    if (this.checking) return this.checking;
    this.checking = this.probe().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  async ensure(): Promise<void> {
    const recentlyChecked = this.result.checkedAt && Date.now() - Date.parse(this.result.checkedAt) < 60_000;
    const result = recentlyChecked ? this.result : await this.check();
    if (result.status !== "ready") throw Object.assign(new Error(result.message), { statusCode: 409, code: "CODEX_DESIGN_RUNTIME_UNAVAILABLE" });
  }
  private async probe(): Promise<CodexDesignRuntimeStatus> {
    const root = mkdtempSync(join(tmpdir(), "productdesign-runtime-check-"));
    const home = join(root, "home"); const workspace = join(root, "design"); const schemaDir = join(root, "schema");
    mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
    const env = chatgptCodexEnv(home);
    const command = codexCommand();
    const run = (args: string[]) => runFile(command.executable, [...command.prefix, ...args], { cwd: workspace, env, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true });
    let version: string | undefined;
    let stage = "CLI";
    let probeMarker: string | undefined;
    try {
      version = (await run(["--version"])).stdout.trim().slice(0, 120);
      stage = "schema";
      await run(["app-server", "generate-json-schema", "--out", schemaDir]);
      const start = JSON.parse(readFileSync(join(schemaDir, "v2", "ThreadStartParams.json"), "utf8"));
      const turn = JSON.parse(readFileSync(join(schemaDir, "v2", "TurnStartParams.json"), "utf8"));
      if (!start.definitions?.SandboxMode?.enum?.includes("read-only") || !start.properties?.config
        || !turn.definitions?.SandboxPolicy?.oneOf?.some((item: any) => item.properties?.type?.enum?.includes("readOnly") && item.properties?.networkAccess)) {
        throw new Error("unsupported protocol schema");
      }
      stage = "features";
      const features = (await run([...designCodexArgs(), "features", "list"])).stdout;
      for (const feature of DESIGN_DISABLED_FEATURES) {
        stage = `features/${feature}`;
        // Some CLI builds report UnifiedExec's stable executor capability as true here.
        // Effective app-server config is verified before every turn; ShellTool is its command registry gate.
        if (!features.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[0] === feature
          && (feature === "unified_exec" || /\sfalse\s*$/.test(line)))) throw new Error("unverified feature flag");
      }
      stage = "sandbox";
      const marker = probeMarker = join(workspace, "must-not-write.txt");
      writeFileSync(marker, "host write control"); rmSync(marker);
      const script = 'const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"UNSAFE");process.exit(41)}catch(e){if(!["EACCES","EPERM","EROFS"].includes(e.code))process.exit(42);console.log("PRODUCTDESIGN_WRITE_DENIED")}';
      const probe = await run(["sandbox", "-P", ":read-only", ...designCodexArgs(), "-C", workspace, "--", process.execPath, "-e", script, marker]);
      if (probe.stdout.trim() !== "PRODUCTDESIGN_WRITE_DENIED" || existsSync(marker)) throw new Error("write denial not established");
      this.result = { status: "ready", message: "本机 CLI 协议和只读写入拒绝自检通过；每轮启动仍会核对生效配置，尚未验证登录或模型调用", version, checkedAt: new Date().toISOString() };
    } catch (cause) {
      const failure = cause as { code?: unknown; stderr?: unknown };
      const socketOwnership = typeof failure.stderr === "string" && failure.stderr.includes("app-server socket directory must be a user-owned directory with mode 0700");
      const wrote = Boolean(probeMarker && existsSync(probeMarker));
      const code = stage === "sandbox" ? (wrote ? "SANDBOX_WRITE_ALLOWED" : socketOwnership ? "SANDBOX_STARTUP_FAILED" : "SANDBOX_DENIAL_UNVERIFIED")
        : stage === "CLI" ? "CLI_UNAVAILABLE" : stage === "schema" ? "SCHEMA_UNSUPPORTED" : "FEATURE_UNSUPPORTED";
      const message = socketOwnership
        ? "Codex 沙箱未能启动：运行环境的 socket 目录所有权或 0700 条件不满足，未验证写入拒绝。请由环境管理员检查；不会修改安全设置或降级执行。"
        : wrote ? "Codex 沙箱允许了测试文件写入，不符合设计隔离要求，已停止。"
        : `Codex 设计运行环境未通过 ${stage} 自检；请检查官方 CLI 版本及本机沙箱支持。未发起登录或模型请求，也不会降级执行。`;
      this.result = { status: "unavailable", code, message, ...(version ? { version } : {}), checkedAt: new Date().toISOString() };
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { this.result = { ...this.result, status: "unavailable", message: "设计环境自检临时目录未能清理，请检查本机文件锁后重试" }; }
    }
    return this.status();
  }
}
