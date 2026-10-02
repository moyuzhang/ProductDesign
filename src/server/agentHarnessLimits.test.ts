import { describe, expect, it, vi } from "vitest";
import type { LlmProfile } from "../shared/types.js";
import type { Store } from "./db.js";
import { CodexHarness, MAX_DIRECT_AGENT_TOOL_ROUNDS } from "./agentHarness.js";

// No provider/network calls: verify the existing execution bound using synthetic responses.
// This is a request-count bound, not a token or monetary budget guarantee.
describe.each(["openai-chat", "anthropic-messages"] as const)("%s request bounds", (protocol) => {
  function fixture() {
    const profile: LlmProfile = {
      id: "synthetic-limit-profile", name: "Synthetic request-bound test",
      provider: protocol === "openai-chat" ? "openai-compatible" : "anthropic",
      protocol, baseUrl: "https://example.invalid", apiKeyEnv: "UNUSED_SYNTHETIC_KEY",
      models: ["synthetic-model"], defaultModel: "synthetic-model", enabled: true,
      reasoningEffort: "none", timeoutMs: 1_000, credentialConfigured: false,
      credentialMasked: "", credentialSource: "missing", createdAt: "", updatedAt: "",
    };
    const harness = new CodexHarness({ updateAgentMessage: vi.fn() } as unknown as Store, "");
    let round = 0;
    const fetchDirectModel = vi.fn(async () => {
      round += 1;
      // Vary input so the repeated-batch guard does not mask the total request limit.
      return JSON.stringify(protocol === "openai-chat"
        ? { choices: [{ message: { content: "", tool_calls: [{ id: `synthetic-${round}`, type: "function", function: { name: "get_project", arguments: JSON.stringify({ round }) } }] } }] }
        : { content: [{ type: "tool_use", id: `synthetic-${round}`, name: "get_project", input: { round } }] });
    });
    const executeProjectMcpTool = vi.fn(async () => "synthetic read result");
    Object.assign(harness, { fetchDirectModel, executeProjectMcpTool });
    const loopName = protocol === "openai-chat" ? "runOpenAiToolLoop" : "runAnthropicToolLoop";
    const run = (harness as unknown as Record<string, (...args: unknown[]) => Promise<string>>)[loopName].bind(harness);
    return {
      fetchDirectModel, executeProjectMcpTool,
      run: (signal: AbortSignal) => run(
        { id: "synthetic-session", projectId: "synthetic-project", model: "synthetic-model" },
        profile, "unused-fixture-value", [{ role: "user", content: "synthetic bounded loop" }],
        [{ name: "get_project", inputSchema: { type: "object", properties: {} } }], {}, "synthetic-message", signal,
      ),
    };
  }

  it("rejects an endless sequence of distinct tool calls before making request 25", async () => {
    const f = fixture();
    await expect(f.run(new AbortController().signal)).rejects.toThrow("模型工具调用达到 24 轮上限");
    expect(MAX_DIRECT_AGENT_TOOL_ROUNDS).toBe(24);
    expect(f.fetchDirectModel).toHaveBeenCalledTimes(24);
    expect(f.executeProjectMcpTool).toHaveBeenCalledTimes(24);
  });

  it("does not start another provider request or tool execution after cancellation", async () => {
    const f = fixture(), controller = new AbortController();
    f.executeProjectMcpTool.mockImplementationOnce(async () => { controller.abort(new Error("synthetic budget cancelled")); return "last completed read"; });
    await expect(f.run(controller.signal)).rejects.toThrow("synthetic budget cancelled");
    expect(f.fetchDirectModel).toHaveBeenCalledTimes(1);
    expect(f.executeProjectMcpTool).toHaveBeenCalledTimes(1);
  });
});
