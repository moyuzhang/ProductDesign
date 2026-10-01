// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createProject: vi.fn(), pageProjects: vi.fn(), navigate: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
vi.mock("../App", () => ({ navigate: mocks.navigate }));
import { ProjectsView } from "./ProjectsView";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.pageProjects.mockResolvedValue({ items: [], total: 0 });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<ProjectsView />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function openForm() {
  await click("新建项目");
  await fill('input[placeholder="如 ARRANGE_FIVE"]', "TEST");
  await fill('input[placeholder="如 排列五助手"]', "Test goal");
}
describe("project creation handoff", () => {
  it("opens the new project's workflow once, blocks repeat creation and dismissal while pending", async () => {
    let resolve!: (value: { id: string }) => void;
    mocks.createProject.mockReturnValue(new Promise((done) => { resolve = done; }));
    await openForm(); await click("创建并进入设计"); await click("创建中");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(container.querySelector(".modal")).not.toBeNull();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => resolve({ id: "new-project" }));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("#/projects/new-project?tab=workflow");
    expect(container.querySelector(".modal")).toBeNull();
  });
  it("keeps failed input available and permits retry without navigating", async () => {
    mocks.createProject.mockRejectedValueOnce(new Error("编号已存在")).mockResolvedValueOnce({ id: "retry-project" });
    await openForm(); await click("创建并进入设计");
    expect(container.textContent).toContain("编号已存在");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="如 排列五助手"]')!.value).toBe("Test goal");
    await click("创建并进入设计");
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("#/projects/retry-project?tab=workflow");
  });
  it("cancels without creating or navigating", async () => {
    await openForm(); await click("取消");
    expect(container.querySelector(".modal")).toBeNull();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

it("does not let a slow older search overwrite the latest result or error state", async () => {
  let oldResolve!: (value: unknown) => void;
  mocks.pageProjects.mockReturnValueOnce(new Promise((done) => { oldResolve = done; })).mockResolvedValueOnce({ items: [], total: 0 });
  await fill('input[placeholder="搜索名称 / 编号 / 摘要"]', "old");
  await fill('input[placeholder="搜索名称 / 编号 / 摘要"]', "new");
  expect(container.textContent).toContain("没有符合筛选的项目");
  await act(async () => oldResolve({ items: [{ id: "old", name: "过期查询结果", code: "OLD", stage: "设计", health: "正常", progress: 0, riskLevel: "P2", dueAt: "", updatedAt: "2026-09-30T00:00:00Z" }], total: 1 }));
  expect(container.textContent).not.toContain("过期查询结果"); expect(container.textContent).toContain("没有符合筛选的项目");
});
