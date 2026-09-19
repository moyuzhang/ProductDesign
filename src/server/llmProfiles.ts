import type { LlmConnectionCheck, LlmProfile } from "../shared/types.js";

export function llmEndpoint(profile: LlmProfile): string {
  const base = new URL(profile.baseUrl);
  const suffix = profile.protocol === "openai-responses" ? "responses"
    : profile.protocol === "openai-chat" ? "chat/completions"
      : "messages";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${suffix}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function llmProfileSummary(profile: LlmProfile): Record<string, unknown> {
  return {
    name: profile.name,
    provider: profile.provider,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    apiKeyEnv: profile.apiKeyEnv,
    models: profile.models,
    defaultModel: profile.defaultModel,
    enabled: profile.enabled,
    reasoningEffort: profile.reasoningEffort,
    timeoutMs: profile.timeoutMs,
    credentialConfigured: profile.credentialConfigured,
    credentialMasked: profile.credentialMasked,
    credentialSource: profile.credentialSource,
  };
}

export function isDeepSeekProfile(profile: LlmProfile): boolean {
  if (profile.provider.trim().toLocaleLowerCase() === "deepseek") return true;
  try {
    return new URL(profile.baseUrl).hostname.toLocaleLowerCase().endsWith("deepseek.com");
  } catch {
    return false;
  }
}

export function openAiChatReasoningOptions(profile: LlmProfile): Record<string, unknown> {
  if (profile.protocol !== "openai-chat" || !isDeepSeekProfile(profile)) return {};
  if (profile.reasoningEffort === "none") return { thinking: { type: "disabled" } };
  return {
    thinking: { type: "enabled" },
    reasoning_effort: profile.reasoningEffort,
  };
}

function testBody(profile: LlmProfile): Record<string, unknown> {
  if (profile.protocol === "openai-responses") {
    return { model: profile.defaultModel, input: "Reply with OK only.", max_output_tokens: 8 };
  }
  if (profile.protocol === "openai-chat") {
    return {
      model: profile.defaultModel,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 8,
      stream: false,
      ...openAiChatReasoningOptions(profile),
    };
  }
  return { model: profile.defaultModel, messages: [{ role: "user", content: "Reply with OK only." }], max_tokens: 8 };
}

export async function checkLlmProfile(profile: LlmProfile, resolvedApiKey?: string): Promise<LlmConnectionCheck> {
  const checkedAt = new Date().toISOString();
  const apiKey = resolvedApiKey?.trim() || process.env[profile.apiKeyEnv]?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: "missing_credential",
      message: `尚未配置 API Key，也未检测到环境变量 ${profile.apiKeyEnv}`,
      latencyMs: 0,
      checkedAt,
    };
  }

  const startedAt = Date.now();
  try {
    const headers = profile.protocol === "anthropic-messages"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
    const response = await fetch(llmEndpoint(profile), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(testBody(profile)),
      signal: AbortSignal.timeout(profile.timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        status: "request_failed",
        message: `模型调用失败（HTTP ${response.status}）`,
        latencyMs,
        checkedAt,
      };
    }
    return {
      ok: true,
      status: "connected",
      message: "模型调用与凭据校验通过",
      latencyMs,
      checkedAt,
    };
  } catch (cause) {
    return {
      ok: false,
      status: "request_failed",
      message: cause instanceof Error ? `连接失败：${cause.message}` : "连接失败",
      latencyMs: Date.now() - startedAt,
      checkedAt,
    };
  }
}
