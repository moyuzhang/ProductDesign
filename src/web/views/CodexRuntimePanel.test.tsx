// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getCodexRuntime: vi.fn(), checkCodexRuntime: vi.fn() }));
vi.mock("../api", () => ({ api: mocks }));
import { CodexRuntimeSettings } from "./CodexRuntimePanel";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { vi.resetAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("reads status without probing and reports authoritative unavailable diagnostics", async () => {
  mocks.getCodexRuntime.mockResolvedValue({ status: "unavailable", message: "沙箱无法启动", code: "SANDBOX_STARTUP_FAILED" });
  await act(async () => root.render(<CodexRuntimeSettings />));
  expect(mocks.checkCodexRuntime).not.toHaveBeenCalled();
  expect(container.textContent).toContain("不可用");
  expect(container.textContent).toContain("SANDBOX_STARTUP_FAILED");
  expect(container.textContent).toContain("不会登录或请求模型");
});
it("locks repeated checks and only displays ready after the check completes", async () => {
  mocks.getCodexRuntime.mockResolvedValue({ status: "unchecked", message: "尚未检查" });
  let finish!: (value: unknown) => void;
  mocks.checkCodexRuntime.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<CodexRuntimeSettings />));
  await act(async () => { container.querySelector("button")!.click(); container.querySelector("button")!.click(); });
  expect(mocks.checkCodexRuntime).toHaveBeenCalledTimes(1);
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.textContent).toContain("检查中");
  await act(async () => finish({ status: "ready", message: "检查通过", version: "1" }));
  expect(container.textContent).toContain("运行环境：就绪");
});
it("retains actionable errors and supports explicit retry", async () => {
  mocks.getCodexRuntime.mockRejectedValue(new Error("读取失败"));
  mocks.checkCodexRuntime.mockRejectedValueOnce(new Error("检查失败")).mockResolvedValueOnce({ status: "ready", message: "通过" });
  await act(async () => root.render(<CodexRuntimeSettings />));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("读取失败");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("检查失败");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("运行环境：就绪");
});
