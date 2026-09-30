import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, LlmProfile } from "../shared/types.js";
import type { Store } from "./db.js";
import {
  agentTurnTimeoutMs,
  approvalPolicyForMode,
  approvalPresentation,
  approvalResponseForMethod,
  CodexHarness,
  MAX_DIRECT_AGENT_TOOL_ROUNDS,
  MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS,
  shouldRefreshAgentWorkflow,
} from "./agentHarness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Agent approval protocol", () => {
  it("refreshes workflow only for terminal transitions or lease/revision errors", () => {
    expect(shouldRefreshAgentWorkflow("get_project_workspace", {}, "ok")).toBe(false);
    expect(shouldRefreshAgentWorkflow("create_evidence", {}, "ok")).toBe(false);
    expect(shouldRefreshAgentWorkflow("transition_plan_delivery", {}, "ok")).toBe(true);
    expect(shouldRefreshAgentWorkflow("create_evidence", { isError: true }, "LEASE_LOST: expired")).toBe(true);
    expect(shouldRefreshAgentWorkflow("create_evidence", { isError: true }, "VALIDATION_ERROR: bad input")).toBe(false);
  });

  it("does not wrap every tool call with workflow reads", async () => {
    const harness = new CodexHarness({} as Store, "");
    const callTool = vi.fn(async (name: string) => ({ content: [{ type: "text", text: `${name}:ok` }] }));
    const execute = (harness as unknown as {
      executeProjectMcpTool: (session: AgentSession, tool: { name: string; inputSchema: Record<string, unknown> }, args: Record<string, unknown>, mcp: { callTool: typeof callTool }) => Promise<string>;
    }).executeProjectMcpTool.bind(harness);
    const session = { id: "session-1", projectId: "project-1", model: "test-model" } as AgentSession;
    const tool = { name: "get_project_workspace", inputSchema: { properties: { projectRef: {} } } };
    await execute(session, tool, {}, { callTool });
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["get_project_workspace"]);
    callTool.mockClear();
    await expect(execute(session, { name: "transition_plan_delivery", inputSchema: { properties: { projectRef: {} } } }, {}, { callTool })).rejects.toThrow("设计会话不允许");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("maps session control modes to the bounded Codex policy", () => {
    expect(approvalPolicyForMode("restricted")).toBe("on-request");
    expect(approvalPolicyForMode("ask")).toBe("on-request");
    expect(approvalPolicyForMode("project-autonomous")).toBe("on-request");
  });

  it("answers modern and legacy approval requests with their native decision values", () => {
    expect(approvalResponseForMethod("item/commandExecution/requestApproval", true)).toEqual({ decision: "accept" });
    expect(approvalResponseForMethod("item/fileChange/requestApproval", false)).toEqual({ decision: "decline" });
    expect(approvalResponseForMethod("execCommandApproval", true)).toEqual({ decision: "approved" });
    expect(approvalResponseForMethod("applyPatchApproval", false)).toEqual({ decision: "denied" });
  });

  it("publishes only bounded approval presentation fields", () => {
    const command = approvalPresentation("execCommandApproval", {
      command: ["npm", "test"],
      cwd: "D:/managed/project",
      reason: "验证实现",
      transportSecret: "must-not-leak",
    });
    expect(command).toMatchObject({
      kind: "command",
      summary: "npm test",
      details: { command: "npm test", cwd: "D:/managed/project", reason: "验证实现" },
    });
    expect(JSON.stringify(command)).not.toContain("transportSecret");

    const fileChange = approvalPresentation("applyPatchApproval", {
      fileChanges: { "src/a.ts": { type: "update" }, "src/b.ts": { type: "add" } },
      reason: "应用补丁",
    });
    expect(fileChange).toMatchObject({ kind: "file-change", summary: "src/a.ts、src/b.ts" });
    expect(fileChange.details.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("Agent timeout isolation", () => {
  it("gives a multi-step turn a longer bounded lifetime than one model request", () => {
    expect(agentTurnTimeoutMs(1_000)).toBe(10_000);
    expect(agentTurnTimeoutMs(60_000)).toBe(600_000);
    expect(agentTurnTimeoutMs(120_000)).toBe(600_000);
  });

  it("does not abort another request when one request times out", async () => {
    const profile = {
      id: "profile-1",
      name: "Test profile",
      provider: "openai-compatible",
      protocol: "openai-chat",
      baseUrl: "https://example.test",
      apiKeyEnv: "TEST_API_KEY",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      reasoningEffort: "none",
      timeoutMs: 25,
      credentialConfigured: true,
      credentialMasked: "••••test",
      credentialSource: "stored",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies LlmProfile;
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as { task?: string };
      if (requestBody.task === "fast") {
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }
      const requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () => reject(requestSignal.reason);
        if (requestSignal.aborted) rejectAborted();
        else requestSignal.addEventListener("abort", rejectAborted, { once: true });
      });
    }));

    const harness = new CodexHarness({} as Store, "");
    type DirectFetch = (target: LlmProfile, apiKey: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
    const fetchDirectModel = (harness as unknown as { fetchDirectModel: DirectFetch }).fetchDirectModel.bind(harness);
    const slow = fetchDirectModel(profile, "secret", { task: "slow" }, new AbortController().signal);
    const fast = fetchDirectModel(profile, "secret", { task: "fast" }, new AbortController().signal);

    await expect(fast).resolves.toBe('{"ok":true}');
    await expect(slow).rejects.toThrow("模型单次请求超过 25ms，已停止当前会话");
  });
});

describe("DeepSeek thinking tool calls", () => {
  it("passes reasoning_content back unchanged on the next tool-call request", async () => {
    const profile = {
      id: "deepseek-profile",
      name: "DeepSeek",
      provider: "deepseek",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: ["deepseek-v4-flash"],
      defaultModel: "deepseek-v4-flash",
      enabled: true,
      reasoningEffort: "high",
      timeoutMs: 60_000,
      credentialConfigured: true,
      credentialMasked: "••••test",
      credentialSource: "stored",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies LlmProfile;
    const updateAgentMessage = vi.fn();
    const store = { updateAgentMessage } as unknown as Store;
    const harness = new CodexHarness(store, "");
    const fetchDirectModel = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        choices: [{ message: {
          content: "",
          reasoning_content: "exact-provider-reasoning",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "get_project", arguments: "{}" } }],
        } }],
      }))
      .mockImplementationOnce((_profile, _key, body: Record<string, unknown>) => {
        const messages = body.messages as Array<Record<string, unknown>>;
        expect(messages).toContainEqual(expect.objectContaining({
          role: "assistant",
          reasoning_content: "exact-provider-reasoning",
        }));
        expect(body).toMatchObject({
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        });
        expect(body).not.toHaveProperty("tool_choice");
        return JSON.stringify({ choices: [{ message: { content: "done" } }] });
      });
    const executeProjectMcpTool = vi.fn().mockResolvedValue("tool-result");
    Object.assign(harness as unknown as Record<string, unknown>, { fetchDirectModel, executeProjectMcpTool });

    type ToolLoop = (...args: unknown[]) => Promise<string>;
    const runOpenAiToolLoop = (harness as unknown as { runOpenAiToolLoop: ToolLoop }).runOpenAiToolLoop.bind(harness);
    const output = await runOpenAiToolLoop(
      { id: "session-1", projectId: "project-1", model: "deepseek-v4-flash" },
      profile,
      "secret",
      [{ role: "user", content: "test" }],
      [{ name: "get_project", inputSchema: { type: "object", properties: {} } }],
      {},
      "assistant-1",
      new AbortController().signal,
    );

    expect(output).toBe("done");
    expect(executeProjectMcpTool).toHaveBeenCalledOnce();
    expect(JSON.stringify(updateAgentMessage.mock.calls)).not.toContain("exact-provider-reasoning");
  });
});

describe("Direct Agent tool-loop protection", () => {
  it("allows a legitimate OpenAI-compatible task to continue beyond the former 12-round limit", async () => {
    const profile = {
      id: "openai-profile",
      name: "OpenAI compatible",
      provider: "openai-compatible",
      protocol: "openai-chat",
      baseUrl: "https://example.test",
      apiKeyEnv: "TEST_API_KEY",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      reasoningEffort: "none",
      timeoutMs: 60_000,
      credentialConfigured: true,
      credentialMasked: "••••test",
      credentialSource: "stored",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies LlmProfile;
    const store = { updateAgentMessage: vi.fn() } as unknown as Store;
    const harness = new CodexHarness(store, "");
    const fetchDirectModel = vi.fn();
    for (let round = 0; round < 13; round += 1) {
      fetchDirectModel.mockResolvedValueOnce(JSON.stringify({
        choices: [{ message: {
          content: "",
          tool_calls: [{ id: `call-${round}`, type: "function", function: { name: "get_project", arguments: JSON.stringify({ round }) } }],
        } }],
      }));
    }
    fetchDirectModel.mockResolvedValueOnce(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    const executeProjectMcpTool = vi.fn().mockResolvedValue("tool-result");
    Object.assign(harness as unknown as Record<string, unknown>, { fetchDirectModel, executeProjectMcpTool });

    type ToolLoop = (...args: unknown[]) => Promise<string>;
    const runOpenAiToolLoop = (harness as unknown as { runOpenAiToolLoop: ToolLoop }).runOpenAiToolLoop.bind(harness);
    const output = await runOpenAiToolLoop(
      { id: "session-1", projectId: "project-1", model: "test-model" },
      profile,
      "secret",
      [{ role: "user", content: "run a long task" }],
      [{ name: "get_project", inputSchema: { type: "object", properties: {} } }],
      {},
      "assistant-1",
      new AbortController().signal,
    );

    expect(MAX_DIRECT_AGENT_TOOL_ROUNDS).toBe(24);
    expect(output).toBe("done");
    expect(fetchDirectModel).toHaveBeenCalledTimes(14);
    expect(executeProjectMcpTool).toHaveBeenCalledTimes(13);
  });

  it("stops an Anthropic model before repeatedly executing the same tool batch", async () => {
    const profile = {
      id: "anthropic-profile",
      name: "Anthropic",
      provider: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://example.test",
      apiKeyEnv: "TEST_API_KEY",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      reasoningEffort: "none",
      timeoutMs: 60_000,
      credentialConfigured: true,
      credentialMasked: "••••test",
      credentialSource: "stored",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies LlmProfile;
    const store = { updateAgentMessage: vi.fn() } as unknown as Store;
    const harness = new CodexHarness(store, "");
    const fetchDirectModel = vi.fn().mockImplementation(() => JSON.stringify({
      content: [{
        type: "tool_use",
        id: `call-${fetchDirectModel.mock.calls.length}`,
        name: "get_project",
        input: { same: true },
      }],
    }));
    const executeProjectMcpTool = vi.fn().mockResolvedValue("unchanged-result");
    Object.assign(harness as unknown as Record<string, unknown>, { fetchDirectModel, executeProjectMcpTool });

    type ToolLoop = (...args: unknown[]) => Promise<string>;
    const runAnthropicToolLoop = (harness as unknown as { runAnthropicToolLoop: ToolLoop }).runAnthropicToolLoop.bind(harness);
    await expect(runAnthropicToolLoop(
      { id: "session-1", projectId: "project-1", model: "test-model" },
      profile,
      "secret",
      [{ role: "user", content: "repeat forever" }],
      [{ name: "get_project", inputSchema: { type: "object", properties: {} } }],
      {},
      "assistant-1",
      new AbortController().signal,
    )).rejects.toThrow(`模型重复执行相同工具调用 ${MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS} 次`);

    expect(fetchDirectModel).toHaveBeenCalledTimes(MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS);
    expect(executeProjectMcpTool).toHaveBeenCalledTimes(MAX_REPEATED_DIRECT_AGENT_TOOL_ROUNDS - 1);
  });
});
