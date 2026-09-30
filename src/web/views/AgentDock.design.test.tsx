// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCodexRuntime: vi.fn(), checkCodexRuntime: vi.fn(), listLlmProfiles: vi.fn(), listProjects: vi.fn(), getAgentWorkspace: vi.fn(), listAgentMessages: vi.fn(), listAgentApprovals: vi.fn(), sendAgentMessage: vi.fn(), updateAgentSession: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("./workspace", () => ({ stableProjectAccent: () => "#fff", useWorkspaceContext: () => ({ workspace: "project", projects: [{ id: "project", name: "Test", code: "TEST" }] }) }));
vi.mock("./agentUiBridge", () => ({ useAgentUiBridge: () => ({ pageContext: { projectId: "project", title: "Test", selection: { entityRefs: [] } }, lastApprovalChange: null }) }));
import { AgentDock } from "./AgentDock";
import { designRequestText, openDesignAssistant } from "./designAssistant";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCodexRuntime.mockResolvedValue({ status: "unchecked", message: "尚未检查" });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.listProjects.mockResolvedValue([]); mocks.listAgentMessages.mockResolvedValue([]); mocks.listAgentApprovals.mockResolvedValue([]);
  mocks.getAgentWorkspace.mockResolvedValue({ workspace: { defaultProfileId: "profile" }, sessions: [{ id: "session", projectId: "project", profileId: "profile", model: "catalog-model", status: "idle", title: "Design", controlMode: "project-autonomous" }] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("opens a design request without sending it or exposing autonomous execution", async () => {
  mocks.listLlmProfiles.mockResolvedValue([{ id: "profile", authMode: "api-key", enabled: true, models: ["catalog-model"], defaultModel: "catalog-model" }]);
  await act(async () => root.render(<AgentDock />));
  await act(async () => openDesignAssistant({ projectId: "project", goal: "设计报名流程" }));
  expect(container.querySelector("textarea")?.value).toBe(designRequestText("设计报名流程"));
  expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
  expect(container.querySelector('select[aria-label="Agent 控制模式"]')).toBeNull();
  expect(container.textContent).toContain("API 提供方独立计费");
});
it("keeps ChatGPT design execution fail-closed after login without switching to API mode", async () => {
  mocks.listLlmProfiles.mockResolvedValue([{ id: "profile", authMode: "chatgpt", enabled: true, models: ["catalog-model"], defaultModel: "catalog-model" }]);
  await act(async () => root.render(<AgentDock />));
  await act(async () => openDesignAssistant({ projectId: "project", goal: "设计报名流程" }));
  expect(container.textContent).toContain("Codex 设计运行环境：未检查");
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.disabled).toBe(true);
  await act(async () => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
});

it("also blocks API-key profiles routed through the unverified Codex runtime", async () => {
  mocks.listLlmProfiles.mockResolvedValue([{ id: "profile", authMode: "api-key", protocol: "openai-responses", enabled: true, models: ["catalog-model"], defaultModel: "catalog-model" }]);
  await act(async () => root.render(<AgentDock />));
  await act(async () => openDesignAssistant({ projectId: "project", goal: "设计方案" }));
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.disabled).toBe(true);
  expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
});

it("rolls back a failed profile change and blocks sending while configuration is pending", async () => {
  mocks.listLlmProfiles.mockResolvedValue([
    { id: "profile", authMode: "api-key", protocol: "openai-chat", enabled: true, name: "Original", models: ["catalog-model", "other-model"], defaultModel: "catalog-model" },
    { id: "profile-2", authMode: "api-key", protocol: "openai-chat", enabled: true, name: "Other", models: ["other-model"], defaultModel: "other-model" },
  ]);
  await act(async () => root.render(<AgentDock />));
  await act(async () => openDesignAssistant({ projectId: "project", goal: "设计方案" }));
  let reject!: (reason: Error) => void; mocks.updateAgentSession.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const profile = container.querySelector<HTMLSelectElement>('select[aria-label="模型配置"]')!;
  await act(async () => { profile.value = "profile-2"; profile.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(profile.disabled).toBe(true); expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.disabled).toBe(true);
  await act(async () => reject(new Error("配置保存失败")));
  expect(profile.value).toBe("profile"); expect(container.querySelector<HTMLSelectElement>('select[aria-label="当前模型"]')!.value).toBe("catalog-model");
  expect(container.textContent).toContain("模型配置未保存，已恢复原选择"); expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
});
it("restores the actual session model after an unsuccessful model update", async () => {
  mocks.listLlmProfiles.mockResolvedValue([{ id: "profile", authMode: "api-key", protocol: "openai-chat", enabled: true, models: ["catalog-model", "new-model"], defaultModel: "catalog-model" }]);
  mocks.updateAgentSession.mockRejectedValue(new Error("模型不允许"));
  await act(async () => root.render(<AgentDock />)); await act(async () => openDesignAssistant({ projectId: "project", goal: "设计方案" }));
  const model = container.querySelector<HTMLSelectElement>('select[aria-label="当前模型"]')!;
  await act(async () => { model.value = "new-model"; model.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(model.value).toBe("catalog-model"); expect(container.textContent).toContain("模型未保存，已恢复原选择");
});

it("allows Codex design input only after authoritative runtime readiness", async () => {
  mocks.listLlmProfiles.mockResolvedValue([{ id: "profile", authMode: "chatgpt", enabled: true, models: ["catalog-model"], defaultModel: "catalog-model" }]);
  mocks.checkCodexRuntime.mockResolvedValue({ status: "ready", message: "只读隔离检查通过" });
  await act(async () => root.render(<AgentDock />));
  await act(async () => openDesignAssistant({ projectId: "project", goal: "设计流程" }));
  expect(mocks.checkCodexRuntime).not.toHaveBeenCalled();
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "检查设计运行环境")!.click());
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.disabled).toBe(false);
  expect(mocks.sendAgentMessage).not.toHaveBeenCalled();
});
