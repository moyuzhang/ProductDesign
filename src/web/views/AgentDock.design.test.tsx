// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listLlmProfiles: vi.fn(), listProjects: vi.fn(), getAgentWorkspace: vi.fn(), listAgentMessages: vi.fn(), listAgentApprovals: vi.fn(), sendAgentMessage: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("./workspace", () => ({ stableProjectAccent: () => "#fff", useWorkspaceContext: () => ({ workspace: "project", projects: [{ id: "project", name: "Test", code: "TEST" }] }) }));
vi.mock("./agentUiBridge", () => ({ useAgentUiBridge: () => ({ pageContext: { projectId: "project", title: "Test", selection: { entityRefs: [] } }, lastApprovalChange: null }) }));
import { AgentDock } from "./AgentDock";
import { designRequestText, openDesignAssistant } from "./designAssistant";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
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
  expect(container.textContent).toContain("Codex 设计执行暂未开放");
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
