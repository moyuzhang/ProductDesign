import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { McpServer } from "@modelcontextprotocol/server";
import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentApprovalKind,
  AgentApprovalStatus,
  AgentControlMode,
  AgentMessage,
  AgentPageContext,
  AgentSession,
  LlmProfile,
} from "../shared/types.js";
import { nowIso, type Store } from "./db.js";
import { LocalMcpClient, MUTATING_AGENT_MCP_TOOLS, mcpResultText, type AgentMcpResult, type AgentMcpTool } from "./localMcpClient.js";
import { isDeepSeekProfile, llmEndpoint, openAiChatReasoningOptions } from "./llmProfiles.js";
import { ensureManagedProjectDirectory } from "./projectFiles.js";
import type { AgentEntityChangedValue } from "../shared/types.js";
import type { AgentUiEventBus } from "./agentUiEvents.js";

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface RunResult {
  session: AgentSession;
  message: AgentMessage;
}

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
]);

interface ApprovalPresentation {
  kind: AgentApprovalKind;
  title: string;
  summary: string;
  details: Record<string, unknown>;
}

interface PendingApprovalHandle {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
  complete: (status: Extract<AgentApprovalStatus, "approved" | "denied" | "expired">, decision: AgentApprovalDecision) => AgentApproval | undefined;
}

interface ActiveAgentRun {
  controller: AbortController;
  child?: ChildProcessWithoutNullStreams;
  pageContext: AgentPageContext | null;
  completed: Promise<void>;
  complete: () => void;
}

const MAX_AGENT_TURN_TIMEOUT_MS = 10 * 60_000;
const AGENT_TURN_TIMEOUT_MULTIPLIER = 10;
export const MAX_DIRECT_AGENT_TOOL_ROUNDS = 24;
export const MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS = 3;

const WORKFLOW_REFRESH_ERROR_CODES = /(?:LEASE_LOST|TASK_REVISION_DRIFT|POLICY_VERSION_STALE|WORK_ORDER_CONTEXT_INVALID)/;

/** Workflow is a session/terminal-state context, not a per-tool middleware call. */
export function shouldRefreshAgentWorkflow(toolName: string, result: { isError?: boolean }, resultText: string): boolean {
  return toolName === "transition_plan_delivery"
    || (Boolean(result.isError) && WORKFLOW_REFRESH_ERROR_CODES.test(resultText));
}

function recordDirectAgentToolRound(seenRounds: Map<string, number>, signature: string): void {
  const count = (seenRounds.get(signature) ?? 0) + 1;
  seenRounds.set(signature, count);
  if (count >= MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS) {
    throw new Error(`模型重复执行相同工具调用 ${MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS} 次，已停止以避免无限循环`);
  }
}

export function agentTurnTimeoutMs(requestTimeoutMs: number): number {
  return Math.min(MAX_AGENT_TURN_TIMEOUT_MS, requestTimeoutMs * AGENT_TURN_TIMEOUT_MULTIPLIER);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function boundedText(value: unknown, maxLength: number): string {
  const text = typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.join(" ")
      : "";
  return text.trim().slice(0, maxLength);
}

export function approvalPolicyForMode(mode: AgentControlMode): "never" | "on-request" {
  return mode === "project-autonomous" ? "never" : "on-request";
}

export function approvalResponseForMethod(method: string, approved: boolean): { decision: string } {
  const modern = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
  return { decision: approved ? (modern ? "accept" : "approved") : (modern ? "decline" : "denied") };
}

export function approvalPresentation(method: string, params: Record<string, unknown> = {}): ApprovalPresentation {
  const isCommand = method === "item/commandExecution/requestApproval" || method === "execCommandApproval";
  const reason = boundedText(params.reason, 500);
  const cwd = boundedText(params.cwd, 500);
  const command = boundedText(params.command, 2_000);
  if (isCommand) {
    return {
      kind: "command",
      title: "Agent 请求执行命令",
      summary: command || reason || "Agent 请求执行一条需要授权的命令",
      details: { ...(command ? { command } : {}), ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) },
    };
  }

  const grantRoot = boundedText(params.grantRoot, 500);
  const rawChanges = params.fileChanges;
  const files = rawChanges && typeof rawChanges === "object" && !Array.isArray(rawChanges)
    ? Object.keys(rawChanges as Record<string, unknown>).slice(0, 50).map((file) => file.slice(0, 500))
    : [];
  return {
    kind: "file-change",
    title: "Agent 请求修改文件",
    summary: files.length > 0 ? files.join("、").slice(0, 2_000) : reason || grantRoot || "Agent 请求执行需要授权的文件修改",
    details: { ...(files.length > 0 ? { files } : {}), ...(grantRoot ? { grantRoot } : {}), ...(reason ? { reason } : {}) },
  };
}

function providerId(profile: LlmProfile): string {
  return `pcs_${profile.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function codexCommand(): { executable: string; prefix: string[] } {
  const configured = process.env.PCS_CODEX_BIN?.trim();
  if (configured) return { executable: configured, prefix: [] };
  if (process.platform !== "win32") return { executable: "codex", prefix: [] };
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const root = join(localAppData, "OpenAI", "Codex", "bin");
    if (existsSync(root)) {
      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, "codex.exe"))
        .filter(existsSync)
        .sort()
        .reverse();
      if (candidates[0]) return { executable: candidates[0], prefix: [] };
    }
  }
  return { executable: process.env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", "codex"] };
}

export function agentProfileProblem(profile: LlmProfile | undefined): string | undefined {
  if (!profile) return "LLM 配置不存在";
  if (!profile.enabled) return `LLM 配置“${profile.name}”已停用`;
  if (!profile.credentialConfigured) return `凭据 ${profile.apiKeyEnv} 尚未配置（或未填写 API 密钥），服务端无法启动会话`;
  return undefined;
}

export class CodexHarness {
  private readonly activeRuns = new Map<string, ActiveAgentRun>();
  private readonly pendingApprovals = new Map<string, PendingApprovalHandle>();

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly mcpFactory?: () => McpServer,
    private readonly agentUiEvents?: AgentUiEventBus,
  ) {}

  isRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  async cancelRun(sessionId: string): Promise<boolean> {
    const activeRun = this.activeRuns.get(sessionId);
    if (!activeRun) return false;
    activeRun.controller.abort(new Error("Agent 运行已取消"));
    this.expireSessionApprovals(sessionId);
    if (activeRun.child?.exitCode === null) activeRun.child.kill();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      activeRun.completed.then(() => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 5_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!stopped) throw new Error("Agent 运行未能在 5 秒内停止，未删除会话");
    return true;
  }

  decideApproval(approvalId: string, sessionId: string, decision: AgentApprovalDecision): AgentApproval {
    const approval = this.store.getAgentApproval(approvalId);
    if (!approval || approval.sessionId !== sessionId) throw new Error("授权请求不存在");
    if (approval.status !== "pending") {
      if (approval.decision === decision) return approval;
      throw new Error("授权请求已经处理，不能更改决定");
    }
    const handle = this.pendingApprovals.get(approvalId);
    if (!handle || handle.sessionId !== sessionId || Date.parse(approval.expiresAt) <= Date.now()) {
      const expired = handle?.complete("expired", "deny")
        ?? this.store.resolveAgentApproval(approvalId, "expired", "deny");
      if (expired && !handle) this.agentUiEvents?.publishApprovalChanged(expired);
      throw new Error("授权请求已失效");
    }
    const resolved = handle.complete(decision === "approve_once" ? "approved" : "denied", decision);
    if (!resolved) throw new Error("授权请求处理失败");
    return resolved;
  }

  async runTurn(sessionId: string, assistantMessageId: string, prompt: string): Promise<RunResult> {
    const session = this.store.getAgentSession(sessionId);
    if (!session) throw new Error("Agent 会话不存在");
    if (this.isRunning(sessionId)) throw new Error("当前会话已有运行中的消息");
    const project = this.store.getProject(session.projectId);
    if (!project) throw new Error("会话所属项目不存在");
    const profile = this.store.getLlmProfile(session.profileId);
    const profileProblem = agentProfileProblem(profile);
    if (profileProblem || !profile) throw new Error(profileProblem ?? "LLM 配置不可用");

    const controller = new AbortController();
    const originMessage = [...this.store.listAgentMessages(sessionId)].reverse().find((message) => message.role === "user");
    let completeRun = () => {};
    const completed = new Promise<void>((resolve) => { completeRun = resolve; });
    const activeRun: ActiveAgentRun = { controller, pageContext: originMessage?.pageContext ?? null, completed, complete: completeRun };
    this.activeRuns.set(sessionId, activeRun);
    const turnLimitMs = agentTurnTimeoutMs(profile.timeoutMs);
    const turnTimeout = setTimeout(() => {
      controller.abort(new Error(`Agent 任务运行超过 ${turnLimitMs}ms，已停止当前会话`));
    }, turnLimitMs);

    try {
      if (profile.protocol !== "openai-responses") {
        return await this.runDirectTurn(session, profile, assistantMessageId, prompt, controller.signal);
      }
      if (!this.mcpFactory) throw new Error("ProductDesign MCP 工具桥接尚未初始化");

      const mcp = await LocalMcpClient.connect(this.mcpFactory);
      const agentTools = await mcp.listAgentTools();
      const workflowContext = await this.loadWorkflowContext(session.projectId, mcp);
      controller.signal.throwIfAborted();
      const toolByName = new Map(agentTools.map((tool) => [tool.name, tool]));

    const cwd = ensureManagedProjectDirectory(this.dataDir, project);
    const command = codexCommand();
    const codexHome = join(this.dataDir, "codex-harness");
    mkdirSync(codexHome, { recursive: true });
    const storedKey = this.store.resolveLlmKey(profile);
    const childEnv: Record<string, string | undefined> = { ...process.env, CODEX_HOME: codexHome };
    if (storedKey) childEnv[profile.apiKeyEnv] = storedKey;
    const args = [...command.prefix, "app-server", "--listen", "stdio://"];
    const child = spawn(command.executable, args, {
      cwd: codexHome,
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeRun.child = child;
    this.store.updateAgentSession(sessionId, { status: "running", lastError: "" });
    this.store.updateAgentMessage(assistantMessageId, { status: "running", content: "" });

    let nextRequestId = 1;
    let output = "";
    let approvalDenied = 0;
    let stderr = "";
    let completedTurn: Record<string, unknown> | undefined;
    let expectedTurnId = "";
    let lastPersistAt = 0;
    const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
    let finishTurn: ((turn: Record<string, unknown>) => void) | undefined;
    let failTurn: ((error: Error) => void) | undefined;
    const turnDone = new Promise<Record<string, unknown>>((resolve, reject) => { finishTurn = resolve; failTurn = reject; });
    const abortChild = (): void => {
      failTurn?.(abortReason(controller.signal, "Agent 任务已取消"));
      if (child.exitCode === null) child.kill();
    };
    controller.signal.addEventListener("abort", abortChild, { once: true });
    if (controller.signal.aborted) abortChild();

    const send = (message: Record<string, unknown>): void => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = nextRequestId++;
      send({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const persistOutput = (force = false): void => {
      const now = Date.now();
      if (!force && output.length < 64 && now - lastPersistAt < 300) return;
      lastPersistAt = now;
      this.store.updateAgentMessage(assistantMessageId, { content: output, status: "running" });
    };
    const answerServerRequest = async (message: JsonRpcMessage): Promise<void> => {
      if (message.id === undefined || !message.method) return;
      if (message.method === "item/tool/call") {
        const toolName = typeof message.params?.tool === "string" ? message.params.tool : "";
        const tool = toolByName.get(toolName);
        if (!tool) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { contentItems: [{ type: "inputText", text: `不允许的 ProductDesign 工具: ${toolName || "unknown"}` }], success: false },
          });
          return;
        }
        const rawArgs = message.params?.arguments;
        const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? rawArgs as Record<string, unknown>
          : {};
        try {
          const content = await this.executeProjectMcpTool(session, tool, args, mcp);
          send({ jsonrpc: "2.0", id: message.id, result: { contentItems: [{ type: "inputText", text: content }], success: true } });
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          send({ jsonrpc: "2.0", id: message.id, result: { contentItems: [{ type: "inputText", text: `工具调用失败：${detail}` }], success: false } });
        }
        return;
      }
      if (APPROVAL_METHODS.has(message.method)) {
        if (session.controlMode !== "ask") {
          approvalDenied += 1;
          send({ jsonrpc: "2.0", id: message.id, result: approvalResponseForMethod(message.method, false) });
          return;
        }
        const approved = await this.waitForApproval(
          session,
          message.method,
          message.params ?? {},
          profile.timeoutMs,
          (accepted) => send({ jsonrpc: "2.0", id: message.id, result: approvalResponseForMethod(message.method!, accepted) }),
        );
        if (!approved) approvalDenied += 1;
        return;
      }
      if (message.method === "item/tool/requestUserInput") {
        send({ jsonrpc: "2.0", id: message.id, result: { answers: {} } });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "ProductDesign 工作台尚未支持该交互请求" } });
    };

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { return; }
      if (message.id !== undefined && ("result" in message || message.error)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex app-server 请求失败"));
        else waiter.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) {
        void answerServerRequest(message).catch((error: Error) => {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
        });
        return;
      }
      if (message.method === "item/agentMessage/delta") {
        const delta = typeof message.params?.delta === "string" ? message.params.delta : "";
        output += delta;
        persistOutput();
        return;
      }
      if (message.method === "item/completed") {
        const item = message.params?.item as { type?: string; text?: string } | undefined;
        if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text) return;
        if (!output) output = item.text;
        else if (item.text.startsWith(output)) output = item.text;
        persistOutput(true);
        return;
      }
      if (message.method === "turn/completed") {
        const turn = message.params?.turn as Record<string, unknown> | undefined;
        if (!turn) return;
        const turnId = typeof turn.id === "string" ? turn.id : "";
        if (expectedTurnId && turnId !== expectedTurnId) return;
        completedTurn = turn;
        finishTurn?.(turn);
        return;
      }
      if (message.method === "error" && message.params?.willRetry === false) {
        const error = message.params.error as { message?: string } | undefined;
        failTurn?.(new Error(error?.message ?? "Codex app-server 运行失败"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000); });
    child.on("error", (error) => failTurn?.(error));
    child.on("exit", (code) => {
      if (!completedTurn) failTurn?.(new Error(stderr.trim() || `Codex app-server 已退出（code ${code ?? "unknown"}）`));
    });

    try {
      await request("initialize", {
        clientInfo: { name: "product-design-control-surface", title: "ProductDesign Agent Workbench", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      send({ jsonrpc: "2.0", method: "initialized" });

      const pid = providerId(profile);
      const config = {
        model_provider: pid,
        model: session.model,
        model_providers: {
          [pid]: {
            name: profile.name,
            base_url: profile.baseUrl,
            env_key: profile.apiKeyEnv,
            wire_api: "responses",
          },
        },
      };
      const threadParams = {
        model: session.model,
        modelProvider: pid,
        cwd,
        approvalPolicy: approvalPolicyForMode(session.controlMode),
        sandbox: "workspace-write",
        config,
        dynamicTools: agentTools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        })),
        baseInstructions: this.directAgentInstructions(session, workflowContext),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      };
      let threadResult: Record<string, unknown>;
      if (session.codexThreadId) {
        try {
          threadResult = await request("thread/resume", { threadId: session.codexThreadId, ...threadParams }) as Record<string, unknown>;
        } catch {
          threadResult = await request("thread/start", { ...threadParams, ephemeral: false }) as Record<string, unknown>;
        }
      } else {
        threadResult = await request("thread/start", { ...threadParams, ephemeral: false }) as Record<string, unknown>;
      }
      const thread = threadResult.thread as { id?: string } | undefined;
      const threadId = thread?.id;
      if (!threadId) throw new Error("Codex app-server 未返回 thread id");
      this.store.updateAgentSession(sessionId, { codexThreadId: threadId });

      const turnResult = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }) as Record<string, unknown>;
      const turn = turnResult.turn as { id?: string } | undefined;
      expectedTurnId = turn?.id ?? "";
      if (!expectedTurnId) throw new Error("Codex app-server 未返回 turn id");
      const finalTurn = completedTurn ?? await turnDone;
      const status = typeof finalTurn.status === "string" ? finalTurn.status : "failed";
      if (status !== "completed") {
        const error = finalTurn.error as { message?: string } | undefined;
        throw new Error(error?.message ?? `Codex turn 状态为 ${status}`);
      }
      if (approvalDenied > 0) output += `\n\n[系统] 已拒绝 ${approvalDenied} 个需要人工审批的操作。`;
      if (!output.trim()) output = "Codex 已完成本轮，但没有返回可展示的文本。";
      persistOutput(true);
      const message = this.store.updateAgentMessage(assistantMessageId, { content: output, status: "completed" });
      const updatedSession = this.store.updateAgentSession(sessionId, { status: "idle", lastError: "" });
      if (!message || !updatedSession) throw new Error("Agent 运行结果保存失败");
      return { session: updatedSession, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const display = `运行失败：${message}`;
      this.store.updateAgentMessage(assistantMessageId, { content: display, status: "failed" });
      this.store.updateAgentSession(sessionId, { status: "failed", lastError: message });
      throw error;
    } finally {
      controller.signal.removeEventListener("abort", abortChild);
      this.expireSessionApprovals(sessionId);
      for (const waiter of pending.values()) waiter.reject(new Error("Codex app-server 已关闭"));
      pending.clear();
      lines.close();
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
      }
      await mcp.close();
    }
    } catch (error) {
      const current = this.store.getAgentSession(sessionId);
      if (current?.status === "running") {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateAgentMessage(assistantMessageId, { content: `运行失败：${message}`, status: "failed" });
        this.store.updateAgentSession(sessionId, { status: "failed", lastError: message });
      }
      throw error;
    } finally {
      clearTimeout(turnTimeout);
      activeRun.complete();
      if (this.activeRuns.get(sessionId) === activeRun) this.activeRuns.delete(sessionId);
    }
  }

  close(): void {
    for (const sessionId of new Set([...this.pendingApprovals.values()].map((item) => item.sessionId))) {
      this.expireSessionApprovals(sessionId);
    }
    for (const activeRun of this.activeRuns.values()) {
      activeRun.controller.abort(new Error("Agent 服务已关闭"));
      if (activeRun.child?.exitCode === null) activeRun.child.kill();
    }
    this.activeRuns.clear();
  }

  private waitForApproval(
    session: AgentSession,
    method: string,
    params: Record<string, unknown>,
    turnTimeoutMs: number,
    respond: (approved: boolean) => void,
  ): Promise<boolean> {
    const presentation = approvalPresentation(method, params);
    const waitMs = Math.max(500, Math.min(120_000, turnTimeoutMs - 500));
    const approval = this.store.insertAgentApproval({
      projectId: session.projectId,
      sessionId: session.id,
      ...presentation,
      expiresAt: new Date(Date.now() + waitMs).toISOString(),
    });
    this.store.recordAudit({
      projectId: session.projectId,
      entityType: "agentApproval",
      entityId: approval.id,
      action: "request",
      before: null,
      after: { sessionId: session.id, kind: approval.kind, title: approval.title, expiresAt: approval.expiresAt },
      actor: `agent:${session.id}`,
      source: "system",
    });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const complete: PendingApprovalHandle["complete"] = (status, decision) => {
        if (settled) return this.store.getAgentApproval(approval.id);
        settled = true;
        clearTimeout(timer);
        this.pendingApprovals.delete(approval.id);
        const updated = this.store.resolveAgentApproval(approval.id, status, decision);
        if (updated) this.agentUiEvents?.publishApprovalChanged(updated);
        respond(status === "approved");
        resolve(status === "approved");
        return updated;
      };
      timer = setTimeout(() => complete("expired", "deny"), waitMs);
      this.pendingApprovals.set(approval.id, { sessionId: session.id, timer, complete });
      this.agentUiEvents?.publishApprovalChanged(approval);
    });
  }

  private expireSessionApprovals(sessionId: string): void {
    for (const handle of [...this.pendingApprovals.values()]) {
      if (handle.sessionId === sessionId) handle.complete("expired", "deny");
    }
  }

  private async runDirectTurn(session: AgentSession, profile: LlmProfile, assistantMessageId: string, prompt: string, signal: AbortSignal): Promise<RunResult> {
    const apiKey = this.store.resolveLlmKey(profile);
    if (!apiKey) throw new Error(`凭据 ${profile.apiKeyEnv} 尚未配置`);
    if (!this.mcpFactory) throw new Error("ProductDesign MCP 工具桥接尚未初始化");
    this.store.updateAgentSession(session.id, { status: "running", lastError: "" });
    this.store.updateAgentMessage(assistantMessageId, { status: "running", content: "" });

    let mcp: LocalMcpClient | undefined;
    try {
      mcp = await LocalMcpClient.connect(this.mcpFactory);
      const completed: Array<{ role: "user" | "assistant"; content: string }> = this.store.listAgentMessages(session.id)
        .filter((message) => message.status === "completed" && (message.role === "user" || message.role === "assistant"))
        .slice(-24)
        .map((message) => ({ role: message.role as "user" | "assistant", content: message.content.slice(-12_000) }));
      let latestUser = -1;
      for (let index = completed.length - 1; index >= 0; index -= 1) {
        if (completed[index].role === "user") { latestUser = index; break; }
      }
      if (latestUser >= 0) completed[latestUser] = { role: "user", content: prompt };
      const tools = await mcp.listAgentTools();
      const workflowContext = await this.loadWorkflowContext(session.projectId, mcp);
      signal.throwIfAborted();
      const output = profile.protocol === "anthropic-messages"
        ? await this.runAnthropicToolLoop(session, profile, apiKey, completed, tools, mcp, assistantMessageId, signal, workflowContext)
        : await this.runOpenAiToolLoop(session, profile, apiKey, completed, tools, mcp, assistantMessageId, signal, workflowContext);
      if (!output.trim()) throw new Error("模型返回成功，但响应中没有可展示文本");

      const message = this.store.updateAgentMessage(assistantMessageId, { content: output, status: "completed" });
      const updatedSession = this.store.updateAgentSession(session.id, { status: "idle", lastError: "", codexThreadId: null });
      if (!message || !updatedSession) throw new Error("Agent 运行结果保存失败");
      return { session: updatedSession, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateAgentMessage(assistantMessageId, { content: `运行失败：${message}`, status: "failed" });
      this.store.updateAgentSession(session.id, { status: "failed", lastError: message });
      throw error;
    } finally {
      await mcp?.close();
    }
  }

  private async runOpenAiToolLoop(
    session: AgentSession,
    profile: LlmProfile,
    apiKey: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    tools: AgentMcpTool[],
    mcp: LocalMcpClient,
    assistantMessageId: string,
    signal: AbortSignal,
    workflowContext = "",
  ): Promise<string> {
    interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
    type ChatMessage = {
      role: "system" | "user" | "assistant" | "tool";
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
    };
    const messages: ChatMessage[] = [
      { role: "system", content: this.directAgentInstructions(session, workflowContext) },
      ...history,
    ];
    const toolDefinitions = tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema },
    }));
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const seenRounds = new Map<string, number>();
    for (let round = 0; round < MAX_DIRECT_AGENT_TOOL_ROUNDS; round += 1) {
      signal.throwIfAborted();
      const response = await this.fetchDirectModel(profile, apiKey, {
        model: session.model,
        messages,
        tools: toolDefinitions,
        ...(isDeepSeekProfile(profile) && profile.reasoningEffort !== "none" ? {} : { tool_choice: "auto" }),
        ...openAiChatReasoningOptions(profile),
        stream: false,
      }, signal);
      const payload = JSON.parse(response) as {
        choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] } }>;
      };
      const choice = payload.choices?.[0]?.message;
      if (!choice) throw new Error("模型响应缺少 choices[0].message");
      const calls = (choice.tool_calls ?? []).slice(0, 8);
      if (calls.length === 0) return choice.content ?? "";
      recordDirectAgentToolRound(seenRounds, JSON.stringify(calls.map((call) => [call.function.name, call.function.arguments])));

      if (isDeepSeekProfile(profile) && profile.reasoningEffort !== "none" && typeof choice.reasoning_content !== "string") {
        throw new Error("DeepSeek 思考模式的工具调用响应缺少 reasoning_content");
      }

      messages.push({
        role: "assistant",
        content: choice.content ?? null,
        ...(choice.reasoning_content !== undefined ? { reasoning_content: choice.reasoning_content } : {}),
        tool_calls: calls,
      });
      this.store.updateAgentMessage(assistantMessageId, {
        status: "running",
        content: `正在执行设计工具（第 ${round + 1}/${MAX_DIRECT_AGENT_TOOL_ROUNDS} 轮）：${calls.map((call) => call.function.name).join("、")}`,
      });
      for (const call of calls) {
        signal.throwIfAborted();
        let toolText: string;
        try {
          const tool = toolByName.get(call.function.name);
          if (!tool) throw new Error(`不允许的工具: ${call.function.name}`);
          const parsed = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
          toolText = await this.executeProjectMcpTool(session, tool, parsed, mcp);
        } catch (cause) {
          toolText = `工具调用失败：${cause instanceof Error ? cause.message : String(cause)}`;
        }
        signal.throwIfAborted();
        messages.push({ role: "tool", tool_call_id: call.id, content: toolText });
      }
    }
    throw new Error(`模型工具调用达到 ${MAX_DIRECT_AGENT_TOOL_ROUNDS} 轮上限，已停止以避免无限循环`);
  }

  private async runAnthropicToolLoop(
    session: AgentSession,
    profile: LlmProfile,
    apiKey: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    tools: AgentMcpTool[],
    mcp: LocalMcpClient,
    assistantMessageId: string,
    signal: AbortSignal,
    workflowContext = "",
  ): Promise<string> {
    type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
    const messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = history.map((item) => ({ ...item }));
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const seenRounds = new Map<string, number>();
    for (let round = 0; round < MAX_DIRECT_AGENT_TOOL_ROUNDS; round += 1) {
      signal.throwIfAborted();
      const response = await this.fetchDirectModel(profile, apiKey, {
        model: session.model,
        system: this.directAgentInstructions(session, workflowContext),
        messages,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema })),
        max_tokens: 4096,
      }, signal);
      const payload = JSON.parse(response) as { content?: ContentBlock[] };
      const blocks = payload.content ?? [];
      const calls = blocks.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use").slice(0, 8);
      if (calls.length === 0) return blocks.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n");
      recordDirectAgentToolRound(seenRounds, JSON.stringify(calls.map((call) => [call.name, call.input])));

      messages.push({ role: "assistant", content: blocks });
      this.store.updateAgentMessage(assistantMessageId, {
        status: "running",
        content: `正在执行设计工具（第 ${round + 1}/${MAX_DIRECT_AGENT_TOOL_ROUNDS} 轮）：${calls.map((call) => call.name).join("、")}`,
      });
      const results: ContentBlock[] = [];
      for (const call of calls) {
        signal.throwIfAborted();
        try {
          const tool = toolByName.get(call.name);
          if (!tool) throw new Error(`不允许的工具: ${call.name}`);
          const content = await this.executeProjectMcpTool(session, tool, call.input ?? {}, mcp);
          results.push({ type: "tool_result", tool_use_id: call.id, content });
        } catch (cause) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: `工具调用失败：${cause instanceof Error ? cause.message : String(cause)}`, is_error: true });
        }
        signal.throwIfAborted();
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`模型工具调用达到 ${MAX_DIRECT_AGENT_TOOL_ROUNDS} 轮上限，已停止以避免无限循环`);
  }

  private async fetchDirectModel(profile: LlmProfile, apiKey: string, body: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (profile.protocol === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
    const requestTimeout = AbortSignal.timeout(profile.timeoutMs);
    let response: Response;
    let raw: string;
    try {
      response = await fetch(llmEndpoint(profile), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, requestTimeout]),
      });
      raw = await response.text();
    } catch (error) {
      if (signal.aborted) throw abortReason(signal, "Agent 任务已取消");
      if (requestTimeout.aborted) throw new Error(`模型单次请求超过 ${profile.timeoutMs}ms，已停止当前会话`);
      throw error;
    }
    if (response.ok) return raw;
    let detail = raw.slice(0, 500);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message || parsed.message || detail;
    } catch { /* use bounded upstream body */ }
    detail = detail.split(apiKey).join("[redacted]");
    throw new Error(`模型请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  }

  private async executeProjectMcpTool(session: AgentSession, tool: AgentMcpTool, rawArgs: Record<string, unknown>, mcp: LocalMcpClient): Promise<string> {
    const args = { ...rawArgs };
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    if ("projectRef" in properties) args.projectRef = session.projectId;
    if ("projectId" in properties) args.projectId = session.projectId;
    if ("actor" in properties) args.actor = `agent:${session.id}`;
    if ("sessionId" in properties) args.sessionId = session.id;
    if ("clientId" in properties) args.clientId = "productdesign-agent-harness";
    if ("model" in properties) args.model = session.model;
    this.assertProjectEntityScope(session.projectId, args);

    const result = tool.name === "get_project_workflow"
      ? await mcp.callTool("get_project_workflow", { projectRef: session.projectId, includeNodes: false, offset: 0, limit: 20 })
      : tool.name === "open_diagram"
        ? this.openDiagram(session, args)
        : await mcp.callTool(tool.name, args);
    let text = mcpResultText(result);
    if (MUTATING_AGENT_MCP_TOOLS.has(tool.name)) {
      if (!result.isError) this.publishMutationEvent(session, tool.name, args, mcpResultText(result));
    }
    if (shouldRefreshAgentWorkflow(tool.name, result, text)) {
      const workflowAfter = await mcp.callTool("get_project_workflow", { projectRef: session.projectId, includeNodes: false, offset: 0, limit: 20 });
      text = `${text}\n\n[需要刷新时的项目工作流]\n${mcpResultText(workflowAfter, 8_000)}`;
    }
    return result.isError ? `[MCP 工具返回错误]\n${text}` : text;
  }

  private async loadWorkflowContext(projectId: string, mcp: LocalMcpClient): Promise<string> {
    const result = await mcp.callTool("get_project_workflow", { projectRef: projectId, includeNodes: false, offset: 0, limit: 20 });
    return mcpResultText(result, 8_000);
  }

  private openDiagram(session: AgentSession, args: Record<string, unknown>): AgentMcpResult {
    const diagramId = typeof args.diagramId === "string" ? args.diagramId : "";
    const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
    const diagram = diagramId ? this.store.getDiagram(diagramId) : undefined;
    if (!diagram || diagram.projectId !== session.projectId) throw new Error("画布不存在或不属于当前会话项目");
    if (nodeId && !diagram.nodes.some((node) => node.id === nodeId)) throw new Error("定位节点不存在于目标画布");
    const pageContext = this.activeRuns.get(session.id)?.pageContext;
    if (!pageContext?.contextId) throw new Error("当前 Agent 消息没有可定向的前端页面上下文");
    if (pageContext.draft?.dirty) throw new Error("当前页面存在未保存草稿，不能静默打开画布");
    if (!this.agentUiEvents) throw new Error("前端导航事件通道不可用");

    this.agentUiEvents.publishNavigationRequested({
      projectId: session.projectId,
      sessionId: session.id,
      contextId: pageContext.contextId,
      diagramId,
      ...(nodeId ? { nodeId } : {}),
      silent: true,
      source: "agent",
    });
    const route = `#/canvas/${encodeURIComponent(diagramId)}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ""}`;
    return { content: [{ type: "text", text: `已请求前端静默打开画布“${diagram.title}”\n${route}` }] };
  }

  private publishMutationEvent(session: AgentSession, toolName: string, args: Record<string, unknown>, resultText: string): void {
    if (!this.agentUiEvents) return;
    let entityType: AgentEntityChangedValue["entityType"] | undefined;
    let entityId = "";
    let revision = nowIso();
    let changedEntityIds: string[] = [];
    const resultId = resultText.match(/(?:\"id\"\s*:\s*\"|\bid=)([0-9a-f-]{36})/i)?.[1] ?? "";

    if (["update_diagram", "mutate_diagram", "auto_layout_diagram", "align_diagram_nodes"].includes(toolName)) {
      entityType = "diagram";
      entityId = typeof args.diagramId === "string" ? args.diagramId : "";
      const operations = Array.isArray(args.operations) ? args.operations as Array<Record<string, unknown>> : [];
      changedEntityIds = operations.flatMap((operation) => {
        const nested = (operation.node ?? operation.edge ?? operation.group) as Record<string, unknown> | undefined;
        const id = operation.nodeId ?? operation.edgeId ?? operation.groupId ?? nested?.id;
        return typeof id === "string" ? [id] : [];
      });
      const diagram = entityId ? this.store.getDiagram(entityId) : undefined;
      if (diagram) revision = diagram.updatedAt;
    } else if (toolName === "create_diagram") {
      entityType = "diagram";
      entityId = resultId;
      const diagram = entityId ? this.store.getDiagram(entityId) : undefined;
      if (diagram) revision = diagram.updatedAt;
    } else if (["create_design_doc", "patch_design_doc"].includes(toolName)) {
      entityType = "designDocument";
      entityId = typeof args.documentId === "string" ? args.documentId : resultId;
      const document = entityId ? this.store.getDesignDoc(entityId) : undefined;
      if (document) revision = document.updatedAt;
    } else if (["create_document_reference", "refresh_document_reference"].includes(toolName)) {
      entityType = "designDocument";
      const reference = typeof args.referenceId === "string" ? this.store.getDocumentReference(args.referenceId) : undefined;
      entityId = typeof args.documentId === "string" ? args.documentId : reference?.documentId ?? "";
      const document = entityId ? this.store.getDesignDoc(entityId) : undefined;
      if (document) revision = document.updatedAt;
    } else if (["create_database_model", "update_database_model", "auto_layout_database_model"].includes(toolName)) {
      entityType = "databaseModel";
      entityId = typeof args.modelId === "string" ? args.modelId : resultId;
      const model = entityId ? this.store.getDatabaseModel(entityId) : undefined;
      if (model) revision = model.updatedAt;
    } else if (["create_node_database_binding", "update_node_database_binding"].includes(toolName)) {
      entityType = "nodeDatabaseBinding";
      entityId = typeof args.bindingId === "string" ? args.bindingId : resultId;
    } else if (["create_plan_item_full", "patch_plan_item"].includes(toolName)) {
      entityType = "plan";
      entityId = typeof args.planId === "string" ? args.planId : resultId;
      const plan = entityId ? this.store.getPlan(entityId) : undefined;
      if (plan) revision = plan.updatedAt;
    } else if (["create_governance", "patch_governance"].includes(toolName)) {
      entityType = "governance";
      entityId = typeof args.governanceId === "string" ? args.governanceId : resultId;
    } else if (toolName === "create_evidence") {
      entityType = "evidence";
      entityId = resultId;
    } else if (toolName === "update_project_status") {
      entityType = "project";
      entityId = session.projectId;
      const project = this.store.getProject(session.projectId);
      if (project) revision = project.updatedAt;
    }

    if (!entityType || !entityId) return;
    this.agentUiEvents.publishEntityChanged({
      projectId: session.projectId,
      entityType,
      entityId,
      changedEntityIds: [...new Set(changedEntityIds)],
      revision,
      source: "agent",
      sessionId: session.id,
    });
  }

  private assertProjectEntityScope(projectId: string, args: Record<string, unknown>): void {
    const checks: Array<[string, (id: string) => { projectId: string } | undefined]> = [
      ["documentId", (id) => this.store.getDesignDoc(id)],
      ["diagramId", (id) => this.store.getDiagram(id)],
      ["modelId", (id) => this.store.getDatabaseModel(id)],
      ["databaseModelId", (id) => this.store.getDatabaseModel(id)],
      ["bindingId", (id) => this.store.getNodeDatabaseBinding(id)],
      ["planId", (id) => this.store.getPlan(id)],
      ["governanceId", (id) => this.store.getGovernance(id)],
      ["referenceId", (id) => this.store.getDocumentReference(id)],
    ];
    for (const [field, lookup] of checks) {
      const id = args[field];
      if (typeof id !== "string") continue;
      const entity = lookup(id);
      if (entity && entity.projectId !== projectId) throw new Error(`拒绝访问其他项目实体: ${field}`);
    }
  }

  private directAgentInstructions(session: AgentSession, workflowContext = ""): string {
    return [
      "你是 ProductDesign 项目工作台中的设计 Agent，不是普通聊天机器人。",
      `当前会话唯一项目 ID: ${session.projectId}。不得访问或修改其他项目。`,
      "你的职责包括项目分析、系统画布、功能节点、数据库模型、系统文档、开发计划与测试证据。文档属于项目，画布、节点、计划、数据库模型和证据通过 DocumentReference 引用固定版本；需要事实时先调用工具，不能凭空声称已完成。",
      "会话初始化时已注入一次项目 workflow 快照；任务包或该快照是当前上下文真源。不要为每个工具动作重复读取项目、节点或租约。仅在终态流转、LEASE_LOST/TASK_REVISION_DRIFT/POLICY_VERSION_STALE/WORK_ORDER_CONTEXT_INVALID 或明确需要确认修订时刷新 workflow。",
      "修改画布或数据库模型前先读取当前实体和 updatedAt，写入时携带 expectedUpdatedAt。所有写入必须使用提供的 MCP 工具。",
      "如果工作流阻塞，明确说明缺失项和解除条件。不要调用删除、备份恢复、外部数据库部署、LLM 配置或 Agent 会话工具。",
      "用简洁中文报告真实完成结果，并列出创建或更新的实体名称；工具失败时不要伪造成功。",
      workflowContext ? `会话初始化 workflow 快照：\n${workflowContext}` : "",
    ].join("\n");
  }
}
