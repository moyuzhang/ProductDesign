import { describe, expect, it } from "vitest";
import { LLM_PROVIDER_PRESETS, parseModels, profilePayloadFromForm, type ProfileFormState } from "./LlmSettingsView";

describe("LLM provider presets", () => {
  it("maps DSH-style providers to the supported runtime protocols", () => {
    const deepseek = LLM_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek");
    const anthropic = LLM_PROVIDER_PRESETS.find((preset) => preset.id === "anthropic");

    expect(deepseek).toMatchObject({
      protocol: "openai-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      defaultModel: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
      reasoningEffort: "high",
    });
    expect(anthropic).toMatchObject({ protocol: "anthropic-messages", apiKeyEnv: "ANTHROPIC_API_KEY" });
  });
});

describe("LLM profile form", () => {
  it("normalizes comma and newline separated model lists", () => {
    expect(parseModels("model-a, model-b\nmodel-a\n\nmodel-c")).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("keeps the default model in the submitted model list", () => {
    const form: ProfileFormState = {
      name: "  Gateway  ",
      provider: "custom_gateway",
      protocol: "openai-chat",
      baseUrl: " https://gateway.example.com/v1 ",
      apiKeyEnv: "GATEWAY_KEY",
      modelsText: "model-b",
      defaultModel: "model-a",
      enabled: true,
      reasoningEffort: "none",
      timeoutMs: 60_000,
      apiKey: "",
    };

    expect(profilePayloadFromForm(form)).toMatchObject({
      name: "Gateway",
      baseUrl: "https://gateway.example.com/v1",
      defaultModel: "model-a",
      models: ["model-a", "model-b"],
      reasoningEffort: "none",
    });
  });
});

it("never submits an API secret or custom gateway in ChatGPT auth mode", () => {
  const form: ProfileFormState = { authMode: "chatgpt", name: "Account", provider: "custom_gateway", protocol: "openai-chat", baseUrl: "https://gateway.invalid", apiKeyEnv: "CUSTOM_KEY", apiKey: "must-not-be-sent", modelsText: "account-model", defaultModel: "account-model", enabled: true, reasoningEffort: "none", timeoutMs: 60000 };
  const payload = profilePayloadFromForm(form);
  expect(payload).toMatchObject({ authMode: "chatgpt", provider: "openai", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" });
  expect(payload).not.toHaveProperty("apiKey");
  expect(profilePayloadFromForm({ ...form, authMode: "api-key" })).toHaveProperty("apiKey", "must-not-be-sent");
});
