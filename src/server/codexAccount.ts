import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CodexAccountStatus, CodexLoginStart, CodexModel } from "../shared/types.js";
import { codexCommand, chatgptCodexEnv, chatgptCodexHome } from "./codexRuntime.js";

function officialLoginUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Codex 未返回有效登录链接");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname)
    || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Codex 登录链接不是受支持的官方地址");
  return value;
}

/** Local personal Codex account. Tokens remain wholly owned by Codex. */
export class CodexAccount {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private login: CodexAccountStatus["login"] = null;
  private loginTimer?: ReturnType<typeof setTimeout>;
  private startingLogin = false;
  private lastCompletion?: { loginId: string; success: boolean };

  constructor(private readonly dataDir: string) {}

  private failPending(message: string): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    this.pending.clear();
  }

  private async ensure(): Promise<void> {
    if (this.closed) throw new Error("Codex 账户服务已关闭");
    if (this.ready) return this.ready;
    const home = chatgptCodexHome(this.dataDir);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const command = codexCommand();
    const child = this.child = spawn(command.executable, [...command.prefix, "app-server", "--listen", "stdio://",
      "-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"'], {
      cwd: home, env: chatgptCodexEnv(home), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume(); // Never expose auth process stderr or raw RPC errors to the browser/logs.
    const stopped = () => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined; this.ready = undefined;
      this.failPending("Codex 账户服务不可用，请确认已安装并可运行 Codex CLI 后重试");
      if (this.login?.status === "pending") this.finishLogin("failed", "登录进程已停止，请重新发起登录");
    };
    child.once("error", stopped); child.once("exit", stopped);
    child.stdin.on("error", stopped);
    lines.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const item = this.pending.get(message.id); if (!item) return;
        clearTimeout(item.timer); this.pending.delete(message.id);
        if (message.error) item.reject(new Error("Codex 账户请求失败，请检查 CLI 版本、网络和登录状态后重试"));
        else item.resolve(message.result);
      } else if (message.method === "account/login/completed" && typeof message.params?.loginId === "string") {
        this.lastCompletion = { loginId: message.params.loginId, success: message.params.success === true };
        if (message.params.loginId === this.login?.loginId && this.login?.status === "pending") {
          this.finishLogin(message.params.success === true ? "succeeded" : "failed",
            message.params.success === true ? undefined : "登录未完成或已失效，请重试");
        }
      }
    });
    this.ready = this.rpc("initialize", { clientInfo: { name: "productdesign-local-account", title: "ProductDesign", version: "0.1.0" }, capabilities: {} })
      .then(() => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`); })
      .catch((error: unknown) => { this.ready = undefined; child.kill(); throw error; });
    return this.ready;
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const child = this.child;
    if (!child || !child.stdin.writable) return Promise.reject(new Error("Codex 账户服务不可用"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex 账户请求超时，请重试")); child.kill(); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private finishLogin(status: NonNullable<CodexAccountStatus["login"]>["status"], message?: string): void {
    clearTimeout(this.loginTimer);
    if (this.login) this.login = { ...this.login, status, ...(message ? { message } : {}) };
  }

  async status(): Promise<CodexAccountStatus> {
    await this.ensure();
    const result = await this.rpc("account/read", { refreshToken: false });
    const account = result?.account;
    return account?.type === "chatgpt"
      ? { status: "signed-in", ...(typeof account.email === "string" ? { email: account.email } : {}),
        ...(typeof account.planType === "string" ? { planType: account.planType } : {}), login: this.login }
      : { status: "signed-out", login: this.login };
  }

  async models(): Promise<{ models: CodexModel[] }> {
    if ((await this.status()).status !== "signed-in") throw new Error("请先完成 ChatGPT 登录");
    const models: CodexModel[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.rpc("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error("Codex 未返回有效模型列表");
      for (const item of result.data) {
        if (item.hidden === true || typeof item.id !== "string" || typeof item.model !== "string") continue;
        models.push({ id: item.id, model: item.model, displayName: typeof item.displayName === "string" ? item.displayName : item.model, isDefault: item.isDefault === true });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new Error("Codex 模型分页重复，请重试");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { models };
  }

  async start(type: "chatgpt" | "chatgptDeviceCode"): Promise<CodexLoginStart> {
    if (this.startingLogin || this.login?.status === "pending") throw new Error("已有待完成的登录，请先取消或完成");
    this.startingLogin = true;
    this.lastCompletion = undefined;
    try {
      await this.ensure();
      const result = await this.rpc("account/login/start", { type });
      if (typeof result?.loginId !== "string" || !result.loginId) throw new Error("Codex 未返回登录标识");
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      this.login = { loginId: result.loginId, status: "pending", expiresAt };
      let response: CodexLoginStart;
      try {
        if (result.type === "chatgpt" && type === "chatgpt") response = { type, loginId: result.loginId, authUrl: officialLoginUrl(result.authUrl), expiresAt };
        else if (result.type === "chatgptDeviceCode" && type === "chatgptDeviceCode" && typeof result.userCode === "string") {
          response = { type, loginId: result.loginId, verificationUrl: officialLoginUrl(result.verificationUrl), userCode: result.userCode, expiresAt };
        } else throw new Error("Codex 返回了不支持的登录响应");
      } catch (error) { await this.cancel(result.loginId); throw error; }
      this.loginTimer = setTimeout(() => {
        if (this.login?.status !== "pending") return;
        const loginId = this.login.loginId;
        this.finishLogin("expired", "登录等待已超时，请重新开始");
        void this.rpc("account/login/cancel", { loginId }).catch(() => {});
      }, 10 * 60_000);
      this.loginTimer.unref();
      const completed = this.lastCompletion as { loginId: string; success: boolean } | undefined;
      if (completed && completed.loginId === result.loginId) this.finishLogin(completed.success ? "succeeded" : "failed", completed.success ? undefined : "登录未完成或已失效，请重试");
      return response;
    } finally { this.startingLogin = false; }
  }

  async cancel(loginId: string): Promise<{ ok: true }> {
    if (!this.login || this.login.loginId !== loginId || this.login.status !== "pending") throw new Error("该登录已结束或不存在");
    await this.ensure(); await this.rpc("account/login/cancel", { loginId });
    this.finishLogin("cancelled", "登录已取消"); return { ok: true };
  }

  async logout(): Promise<{ ok: true }> {
    if (this.startingLogin) throw new Error("登录正在启动，请稍后重试");
    if (this.login?.status === "pending") await this.cancel(this.login.loginId);
    await this.ensure(); await this.rpc("account/logout"); this.login = null;
    return { ok: true };
  }

  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.loginTimer);
    this.failPending("Codex 账户服务已关闭");
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
    });
  }
}
