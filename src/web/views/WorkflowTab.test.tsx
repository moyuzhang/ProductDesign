// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getProjectWorkflow: vi.fn(), navigate: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("../App", () => ({ navigate: mocks.navigate }));
import { WorkflowTab } from "./ProjectDetailView";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const workflow = { phase: "discovery", phaseLabel: "了解项目", status: "blocked", nodes: [], layerGate: { totalLayers: 0 }, nextAction: null };
beforeEach(() => {
  vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("retries an initial error instead of spinning indefinitely, without claiming acceptance", async () => {
  mocks.getProjectWorkflow.mockRejectedValueOnce(new Error("服务暂不可用")).mockResolvedValueOnce(workflow);
  await act(async () => root.render(<WorkflowTab projectId="test" onError={() => {}} />));
  expect(container.textContent).toContain("服务暂不可用");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(mocks.getProjectWorkflow).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("这不代表已完成");
  expect(container.textContent).not.toContain("所有交付节点均已验收");
});
it("uses the backend next-action target rather than inventing an execution action", async () => {
  mocks.getProjectWorkflow.mockResolvedValue({ ...workflow, nextAction: { title: "确认简报", description: "补齐目标", href: "#/projects/test?tab=documents" } });
  await act(async () => root.render(<WorkflowTab projectId="test" onError={() => {}} />));
  const next = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("立即处理"))!;
  await act(async () => next.click());
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("#/projects/test?tab=documents");
});

it("does not offer development actions inside the design workspace's legacy view", async () => {
  mocks.getProjectWorkflow.mockResolvedValue({ ...workflow, nextAction: { title: "开始开发", description: "旧版门禁", href: "#/orchestration" } });
  await act(async () => root.render(<WorkflowTab projectId="test" onError={() => {}} readOnly />));
  expect(container.textContent).toContain("已有开发交付数据");
  expect(container.textContent).not.toContain("立即处理");
  expect(container.querySelector('[aria-label="交付工作入口"]')).toBeNull();
});
