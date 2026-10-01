// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ErrorBanner, Modal, Spinner } from "./ui";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function Flow() {
  const [open, setOpen] = useState(false); const [child, setChild] = useState(false);
  return <><button id="trigger" onClick={() => setOpen(true)}>打开表单</button>{open ? <Modal title="编辑项目" onClose={() => setOpen(false)} footer={<button id="last">保存</button>}><input aria-label="目标" /><button id="nested" onClick={() => setChild(true)}>更多</button>{child ? <Modal title="子窗口" onClose={() => setChild(false)}><input aria-label="子输入" /></Modal> : null}</Modal> : null}</>;
}
async function open() { await act(async () => root.render(<Flow />)); const trigger = container.querySelector<HTMLButtonElement>("#trigger")!; trigger.focus(); await act(async () => trigger.click()); }
async function key(key: string, shiftKey = false) { await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }))); }
it("gives the dialog a title and moves focus into its form without resetting on input rerenders", async () => {
  await open(); const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true"); expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("编辑项目");
  expect(document.activeElement).toBe(container.querySelector("input"));
});
it("wraps Tab in both directions and restores focus to the opening control after Escape", async () => {
  await open(); const dialog = container.querySelector('[role="dialog"]')!; const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
  container.querySelector<HTMLButtonElement>("#last")!.focus(); await key("Tab"); expect(document.activeElement).toBe(close);
  await key("Tab", true); expect(document.activeElement).toBe(container.querySelector("#last"));
  await key("Escape"); expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(container.querySelector("#trigger"));
});
it("closes only the top nested modal and returns focus to its opener", async () => {
  await open(); const nested = container.querySelector<HTMLButtonElement>("#nested")!; nested.focus(); await act(async () => nested.click());
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2); await key("Escape");
  expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1); expect(document.activeElement).toBe(nested);
  await key("Escape"); expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
});
it("does not dismiss when another control consumed Escape or a busy close handler refuses dismissal", async () => {
  const close = vi.fn(); await act(async () => root.render(<Modal title="等待保存" onClose={close}><input /></Modal>));
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true }); event.preventDefault(); await act(async () => window.dispatchEvent(event)); expect(close).not.toHaveBeenCalled();
  await key("Escape"); expect(close).toHaveBeenCalledOnce(); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
it("announces errors and loading to assistive technology", async () => {
  await act(async () => root.render(<><ErrorBanner message="无法保存" /><Spinner /></>));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("无法保存"); expect(container.querySelector('[role="status"]')?.textContent).toBe("加载中…");
});

it("keeps focus during form rerenders and uses the latest close handler", async () => {
  const first = vi.fn(); const latest = vi.fn();
  await act(async () => root.render(<Modal title="编辑" onClose={first}><input /><button id="stay">继续填写</button></Modal>));
  container.querySelector<HTMLButtonElement>("#stay")!.focus();
  await act(async () => root.render(<Modal title="编辑中" onClose={latest}><input /><button id="stay">继续填写</button></Modal>));
  expect(document.activeElement).toBe(container.querySelector("#stay"));
  await key("Escape"); expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledOnce();
});
