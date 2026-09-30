// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LlmEditModal, type ProfileFormState } from "./LlmSettingsView";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
const initial: ProfileFormState = { name: "Existing gateway", provider: "custom_gateway", protocol: "openai-chat", baseUrl: "https://example.com/v1", apiKeyEnv: "GATEWAY_KEY", apiKey: "", modelsText: "existing-model", defaultModel: "existing-model", enabled: true, reasoningEffort: "none", timeoutMs: 60000 };
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function choose(index: number) { await act(async () => container.querySelectorAll<HTMLInputElement>('input[name="auth-mode"]')[index].click()); }
it("preserves API mode drafts and only displays backend account models in ChatGPT mode", async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<LlmEditModal initial={initial} title="Test" credentialConfigured saving={false} onSave={onSave} onClose={() => {}} accountModels={[{ id: "one", model: "account-model", displayName: "Account Model", isDefault: true }]} />));
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  await choose(1);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain("Account Model");
  expect(container.textContent).not.toContain("existing-model");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ authMode: "chatgpt", defaultModel: "account-model", apiKey: "" }));
  await choose(0);
  expect([...container.querySelectorAll("input")].some((input) => input.value === "existing-model")).toBeTruthy();
  expect([...container.querySelectorAll("input")].some((input) => input.value === "https://example.com/v1")).toBeTruthy();
});
it("does not invent a default subscription model or allow saving with an unavailable account catalog", async () => {
  const onSave = vi.fn();
  await act(async () => root.render(<LlmEditModal initial={initial} title="Test" credentialConfigured={false} saving={false} onSave={onSave} onClose={() => {}} accountModels={[]} />));
  await choose(1); expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(container.textContent).toContain("请先登录并刷新模型"); expect(onSave).not.toHaveBeenCalled();
});
