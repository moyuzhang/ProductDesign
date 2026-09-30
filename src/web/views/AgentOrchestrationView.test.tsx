// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: "a", getAgentOrchestration: vi.fn(), listAgentTaskLeases: vi.fn(), releaseAgentTaskManually: vi.fn(), setPageContextDetail: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("../App", () => ({ navigate: vi.fn() }));
vi.mock("./workspace", () => ({ useWorkspaceContext: () => ({ workspace: mocks.workspace }) }));
vi.mock("./agentUiBridge", () => ({ useAgentUiBridge: () => ({ setPageContextDetail: mocks.setPageContextDetail }), agentVisibleContent: () => ({}) }));
vi.mock("./AgentTaskRetryPanel", () => ({ AgentTaskRetryPanel: () => null }));
import { AgentOrchestrationView } from "./AgentOrchestrationView";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
function data(id: string) { return { project: { id, name: `项目${id}` }, workflow: { summary: "真实当前队列", phaseLabel: "设计", layerGate: {} }, workingDirectory: { ready: false, issue: "未配置" }, recommendedAgents: [], handoffs: [], queues: { design: [], development: [], audit: [], approval: [], managerApproval: [] }, bootstrapPrompt: "测试" }; }
async function render() { await act(async () => root.render(<AgentOrchestrationView />)); }
beforeEach(() => { vi.resetAllMocks(); mocks.workspace = "a"; mocks.listAgentTaskLeases.mockResolvedValue([]); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("isolates slow responses from a previously selected project", async () => {
  let oldResolve!: (value: unknown) => void;
  mocks.getAgentOrchestration.mockReturnValueOnce(new Promise((done) => { oldResolve = done; })).mockResolvedValueOnce(data("b"));
  await render(); mocks.workspace = "b"; await render(); expect(container.querySelector("h1")?.textContent).toBe("项目b");
  await act(async () => oldResolve(data("a"))); expect(container.querySelector("h1")?.textContent).toBe("项目b");
});
it("clears a lease-release dialog on project switch and does not release anything", async () => {
  mocks.getAgentOrchestration.mockImplementation((id) => Promise.resolve(data(id)));
  mocks.listAgentTaskLeases.mockResolvedValueOnce([{ workOrderId: "lease-a", actionCode: "build", status: "running", queue: "development", role: "builder", workScopes: [], leaseExpiresAt: "2026-09-30T00:00:00Z" }]).mockResolvedValue([]);
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="release-lease-lease-a"]')!.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull(); mocks.workspace = "b"; await render();
  expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(mocks.releaseAgentTaskManually).not.toHaveBeenCalled();
});
it("provides a retry after initial load failure instead of a dead-end error", async () => {
  mocks.getAgentOrchestration.mockRejectedValueOnce(new Error("队列读取失败")).mockResolvedValueOnce(data("a")); await render();
  expect(container.textContent).toContain("队列读取失败");
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "重试加载编排")!.click());
  expect(container.querySelector("h1")?.textContent).toBe("项目a");
});
