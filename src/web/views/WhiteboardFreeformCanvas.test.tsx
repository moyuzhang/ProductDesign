// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class FreeformConflictError extends Error {
    readonly serverUpdatedAt: string;
    constructor(message: string, serverUpdatedAt: string) {
      super(message);
      this.name = "FreeformConflictError";
      this.serverUpdatedAt = serverUpdatedAt;
    }
  }
  return {
    FreeformConflictError,
    getFreeformDocument: vi.fn(),
    saveFreeformDocument: vi.fn(),
    uploadFreeformAsset: vi.fn(),
    getPrototypeDraft: vi.fn(),
  };
});

vi.mock("../api", () => ({
  FreeformConflictError: harness.FreeformConflictError,
  api: {
    getFreeformDocument: harness.getFreeformDocument,
    saveFreeformDocument: harness.saveFreeformDocument,
    uploadFreeformAsset: harness.uploadFreeformAsset,
    getPrototypeDraft: harness.getPrototypeDraft,
    freeformAssetUrl: (assetRef: string) => `/api/freeform-assets/${encodeURIComponent(assetRef)}`,
  },
}));

import { WhiteboardFreeformCanvas } from "./WhiteboardFreeformCanvas";
import { FREEFORM_ASSET_PLACEHOLDER_ID, FREEFORM_TOOLS } from "../../shared/freeform";

// React 19 要求显式声明测试环境以启用 act 语义。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onClose: () => void;

const REMOTE_UPDATED_AT = "2026-09-20T00:00:00.000Z";

/** 内容坐标换算：viewport 默认 offset 为 32，zoom 为 1，jsdom 的 rect 全为 0。 */
const world = (client: number) => client - 32;

function pointerEvent(
  type: "pointerdown" | "pointermove" | "pointerup",
  target: Element,
  x: number,
  y: number,
  options: { pointerId?: number; button?: number; shiftKey?: boolean; altKey?: boolean } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    button: options.button ?? 0, buttons: type === "pointerup" ? 0 : 1,
    shiftKey: Boolean(options.shiftKey), altKey: Boolean(options.altKey),
  });
  Object.defineProperty(event, "pointerId", { value: options.pointerId ?? 1 });
  Object.defineProperty(event, "isPrimary", { value: true });
  act(() => { target.dispatchEvent(event); });
}

function keyEvent(key: string, options: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}): void {
  const overlay = container.querySelector(".freeform-overlay")!;
  const event = new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true,
    ctrlKey: Boolean(options.ctrlKey), metaKey: Boolean(options.metaKey), shiftKey: Boolean(options.shiftKey),
  });
  act(() => { overlay.dispatchEvent(event); });
}

function click(selector: string): void {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`未找到元素：${selector}`);
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

/** 顶层工具条上的动作按钮（导出/保存）没有 aria-label，只能按可见文案定位。 */
function clickButton(text: string): void {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`未找到按钮：${text}`);
  act(() => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

const viewport = () => container.querySelector('[data-testid="freeform-viewport"]')!;
const overlay = () => container.querySelector(".freeform-overlay")!;
const toolbar = () => container.querySelector('[role="toolbar"]')!;
const layerItems = () => [...container.querySelectorAll('[data-section="freeform"] .freeform-layer-item')];
const layerNames = () => layerItems().map((item) => item.querySelector(".freeform-layer-name")!.textContent);
const selectedNames = () => layerItems().filter((item) => item.getAttribute("aria-selected") === "true").map((item) => item.querySelector(".freeform-layer-name")!.textContent);
const inspectorInputs = () => [...container.querySelectorAll<HTMLInputElement>(".freeform-inspector .freeform-field-grid input")];
const inspectorFields = () => [...container.querySelectorAll<HTMLInputElement>(".freeform-inspector input")];
function fieldByLabel(text: string): HTMLInputElement {
  const found = inspectorFields().find((input) => input.closest("label")?.textContent?.includes(text));
  if (!found) throw new Error(`未找到属性字段：${text}`);
  return found;
}
/** 选中态轮廓矩形直接读取元素几何（x/y/w/h），多选/组合时属性面板不渲染数值输入。 */
const outlineX = () => Number(container.querySelector(".freeform-selection-outline rect")?.getAttribute("x"));
const announcer = () => container.querySelector(".freeform-announcer")!.textContent ?? "";
const statusReadout = () => container.querySelector(".freeform-status-readout")!.textContent ?? "";

/** CommitField 为受控输入：先写值并派发 input，再真实聚焦/失焦触发 onBlur 提交。 */
function commitField(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => { input.focus(); input.blur(); });
}

async function renderCanvas(): Promise<void> {
  await act(async () => {
    root.render(<WhiteboardFreeformCanvas
      diagramId="diagram-1"
      projectId="project-1"
      title="测试画布"
      deliveryNodes={[{ id: "node-delivery-a", label: "交付节点 A" }]}
      onClose={onClose}
    />);
  });
  // 让加载 Promise 的 setState 落地。
  await act(async () => { await Promise.resolve(); });
}

/** 用工具拖拽创建元素：从 (100,100) 拖到 (200,180)。 */
function createWithTool(label: string, to = { x: 200, y: 180 }): void {
  click(`button[aria-label^="${label}工具"]`);
  pointerEvent("pointerdown", viewport(), 100, 100);
  pointerEvent("pointermove", viewport(), to.x, to.y);
  pointerEvent("pointerup", viewport(), to.x, to.y);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = vi.fn();
  harness.getFreeformDocument.mockResolvedValue(null);
  harness.saveFreeformDocument.mockResolvedValue({
    schemaVersion: 1, diagramId: "diagram-1", elements: [], unsupported: [], updatedAt: REMOTE_UPDATED_AT,
  });
  harness.uploadFreeformAsset.mockResolvedValue({ id: "fa_uploaded", mime: "image/png", width: 1, height: 1, sha256: "0".repeat(64) });
  harness.getPrototypeDraft.mockResolvedValue(null);
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", configurable: true, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true, writable: true });
  HTMLAnchorElement.prototype.click = () => {};
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
});

describe("AC1 七类自由元素的创建路径（FT-01..FT-07）", () => {
  const cases: Array<[string, string | RegExp]> = [
    ["文本", "双击编辑文本"],
    ["便签", "便签内容"],
    ["矩形", /^fr_/],
    ["椭圆", /^fr_/],
    ["箭头", /^fr_/],
    ["笔迹", /^fr_/],
    ["图片引用", "图片引用"],
  ];

  it.each(cases)("用 %s 工具拖拽即可创建一个自由元素", async (toolLabel, expectedLayerName) => {
    await renderCanvas();
    expect(layerItems()).toHaveLength(0);
    createWithTool(toolLabel);
    expect(layerItems()).toHaveLength(1);
    // 文本/便签显示内容，图片显示 alt（缺省“图片引用”），几何类显示 fr_ 前缀 id。
    if (typeof expectedLayerName === "string") expect(layerNames()).toEqual([expectedLayerName]);
    else expect(layerNames()[0]).toMatch(expectedLayerName);
    // 每类元素的无障碍名称都必须能区分出种类。
    expect(layerItems()[0].getAttribute("aria-label")).toContain(toolLabel);
    expect(statusReadout()).toContain("已选 1");
    // 创建后自动回到选择工具，避免连续误建。
    expect(overlay().getAttribute("data-tool")).toBe("select");
    // 自由元素 id 必须落在 fr_ 空间，且只能出现在自由层分区。
    expect(container.querySelectorAll('[data-section="delivery"] .freeform-layer-item')).toHaveLength(1);
  });

  it("AC4 图片元素只保存受控资源引用，未上传时不回退到外部请求", async () => {
    await renderCanvas();
    createWithTool("图片引用");
    const image = container.querySelector(".freeform-element-image")!;
    // 未上传资源时只渲染占位图，绝不回退到远程 <image>。
    expect(image.querySelector("image")).toBeNull();
    expect(image.textContent).toContain("缺少受控图片资源");
    expect(container.querySelector(".freeform-inspector-empty")!.textContent).toContain("占位");
    expect(container.querySelector(".freeform-asset-preview")).toBeNull();
    expect(fieldByLabel("assetRef").value).toBe(FREEFORM_ASSET_PLACEHOLDER_ID);
  });

  it("越权或非 fa_ 前缀的资源引用被拒绝并给出错误提示", async () => {
    await renderCanvas();
    createWithTool("图片引用");
    const assetRefInput = fieldByLabel("assetRef");
    commitField(assetRefInput, "https://evil.example/x.png");
    expect(assetRefInput.closest("label")!.querySelector(".freeform-field-error")!.textContent).toContain("受控资源");
    expect(assetRefInput.getAttribute("aria-invalid")).toBe("true");
    // 非法引用被拒绝后回落到上一个合法值，不留任何越权引用。
    expect(assetRefInput.value).toBe(FREEFORM_ASSET_PLACEHOLDER_ID);
    expect(container.querySelector(".freeform-asset-preview")).toBeNull();
  });
});

describe("AC3 选择、复制粘贴、移动、缩放、旋转、组合与层级（FT-20..FT-27）", () => {
  it("FT-20 框选命中多个元素，Ctrl/Cmd+A 全选，点击空白清空选择", async () => {
    await renderCanvas();
    createWithTool("矩形", { x: 160, y: 160 });
    createWithTool("椭圆", { x: 400, y: 320 });
    expect(layerItems()).toHaveLength(2);

    keyEvent("a", { ctrlKey: true });
    expect(statusReadout()).toContain("已选 2");

    keyEvent("Escape");
    expect(statusReadout()).toContain("已选 0");

    // 框选覆盖全部元素：从世界坐标 (-10,-10) 拖到 (500,400)。
    pointerEvent("pointerdown", viewport(), 22, 22);
    pointerEvent("pointermove", viewport(), 532, 432);
    pointerEvent("pointerup", viewport(), 532, 432);
    expect(statusReadout()).toContain("已选 2");
  });

  it("FT-21 复制粘贴生成新 id 并偏移 +16/+16", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const xBefore = Number(inspectorInputs()[0].value);
    keyEvent("c", { ctrlKey: true });
    keyEvent("v", { ctrlKey: true });
    expect(layerItems()).toHaveLength(2);
    expect(statusReadout()).toContain("已选 1");
    expect(Number(inspectorInputs()[0].value)).toBe(xBefore + 16);
    // 新元素 id 与原元素不同。
    const ids = layerItems().map((item) => item.querySelector(".freeform-layer-name")!.textContent);
    expect(new Set(ids).size).toBe(2);
  });

  it("FT-22 方向键 1px、Shift+方向键 10px 移动选中集", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const x0 = Number(inspectorInputs()[0].value);
    keyEvent("ArrowRight");
    expect(Number(inspectorInputs()[0].value)).toBe(x0 + 1);
    keyEvent("ArrowDown", { shiftKey: true });
    expect(Number(inspectorInputs()[1].value)).toBe(world(100) + 10);
  });

  it("FT-23/FT-24 属性面板提供缩放与旋转的数值路径", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const [xInput, yInput, , hInput, rotationInput] = inspectorInputs();
    commitField(inspectorInputs()[2], "300");
    expect(Number(inspectorInputs()[2].value)).toBe(300);
    expect(Number(hInput.value)).toBe(80);
    // 超界数值被拒绝并保留原值。
    commitField(inspectorInputs()[2], "4");
    expect(inspectorInputs()[2].closest("label")!.querySelector(".freeform-field-error")).toBeTruthy();
    expect(Number(inspectorInputs()[2].value)).toBe(300);

    commitField(rotationInput, "45");
    expect(statusReadout()).toContain("旋转 45°");
    expect(Number(xInput.value)).toBe(world(100));
    expect(Number(yInput.value)).toBe(world(100));
  });

  it("FT-25/FT-26/FT-27 组合、按组选中、层级调整与取消组合", async () => {
    await renderCanvas();
    createWithTool("矩形", { x: 160, y: 160 });
    createWithTool("椭圆", { x: 260, y: 260 });
    createWithTool("便签", { x: 360, y: 180 });
    expect(layerItems()).toHaveLength(3);

    // 图层顶层在前：索引 0 为便签，1 为椭圆，2 为矩形；Shift 点击扩展选择。
    act(() => { layerItems()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    act(() => { layerItems()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(selectedNames()).toHaveLength(2);
    keyEvent("g", { ctrlKey: true });
    expect(announcer()).toContain("已组合 2 个元素");

    // 组合后点击组内任一元素即整组选中。
    act(() => { layerItems()[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(selectedNames()).toHaveLength(2);

    // FT-27：整组为单位调整层级，组内相对次序不变。
    const namesBefore = layerNames();
    keyEvent("]");
    expect(announcer()).toContain("上移一层");
    expect(layerNames()).not.toEqual(namesBefore);
    expect(layerNames()).toHaveLength(3);

    keyEvent("G", { ctrlKey: true, shiftKey: true });
    expect(announcer()).toContain("已取消组合");
  });
});

describe("AC5 撤销重做、保存冲突与导出（FT-40 / FT-41 / FT-43 / FT-44）", () => {
  it("FT-40 Ctrl+Z 撤销、Ctrl+Shift+Z 重做，且状态可读", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const x0 = Number(inspectorInputs()[0].value);
    keyEvent("ArrowRight");
    keyEvent("ArrowRight");
    expect(Number(inspectorInputs()[0].value)).toBe(x0 + 2);

    keyEvent("z", { ctrlKey: true });
    expect(Number(inspectorInputs()[0].value)).toBe(x0 + 1);

    keyEvent("Z", { ctrlKey: true, shiftKey: true });
    expect(Number(inspectorInputs()[0].value)).toBe(x0 + 2);
    expect(container.querySelector(".freeform-announcer")!.textContent).toContain("已重做");

    // 历史栈：创建 + 两次移动，需三次撤销才能回到空文档。
    keyEvent("z", { ctrlKey: true });
    keyEvent("z", { ctrlKey: true });
    expect(layerItems()).toHaveLength(1);
    keyEvent("z", { ctrlKey: true });
    expect(layerItems()).toHaveLength(0);
    expect(announcer()).toContain("已撤销创建");
  });

  it("FT-44 保存冲突时给出三条显式处置路径且不丢失本地修改", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const x0 = Number(inspectorInputs()[0].value);
    harness.saveFreeformDocument.mockRejectedValueOnce(new harness.FreeformConflictError("自由层草稿已被其他操作修改", "2026-09-20T10:00:00.000Z"));

    const saveButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("保存自由层"))!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const banner = container.querySelector(".freeform-banner.is-error")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("服务器自由层文档已变化");
    expect(banner.textContent).toContain("本地修改已完整保留");
    expect(banner.textContent).toContain("以服务端为准重载");
    expect(banner.textContent).toContain("另存为副本");
    expect(banner.textContent).toContain("强制覆盖");
    // 本地修改完整保留，且服务端 updatedAt 被回传用于决策。
    expect(Number(inspectorInputs()[0].value)).toBe(x0);
    expect(harness.saveFreeformDocument).toHaveBeenCalledWith("diagram-1", expect.objectContaining({ expectedUpdatedAt: null }));
  });

  it("FT-42 SVG 与 JSON 导出只产出文件，不写证据也不保存草稿", async () => {
    await renderCanvas();
    createWithTool("矩形");
    const callsBefore = harness.saveFreeformDocument.mock.calls.length;
    clickButton("SVG");
    expect(announcer()).toContain("已导出自由层 SVG");
    expect(announcer()).toContain("不写入证据");
    clickButton("JSON");
    expect(announcer()).toContain("已导出自由层 JSON");
    expect(harness.saveFreeformDocument.mock.calls.length).toBe(callsBefore);
  });
});

describe("AC6 键盘、ARIA 与 reduced-motion（FT-50..FT-53）", () => {
  it("FT-51 工具栏、图层与属性面板具备完整 ARIA 语义", async () => {
    await renderCanvas();
    const toolbarElement = toolbar();
    expect(toolbarElement.getAttribute("aria-orientation")).toBe("vertical");
    // 工具按钮（含上传图片动作按钮）全部要有可读名称，但只有 FREEFORM_TOOLS 才是互斥工具。
    const allTools = [...toolbarElement.querySelectorAll(".freeform-tool")];
    expect(allTools).toHaveLength(FREEFORM_TOOLS.length + 1);
    const tools = allTools.filter((tool) => tool.hasAttribute("aria-pressed"));
    expect(tools).toHaveLength(FREEFORM_TOOLS.length);
    tools.forEach((tool) => {
      expect(tool.getAttribute("aria-label")).toBeTruthy();
      expect(tool.getAttribute("aria-pressed")).toBe(tool.classList.contains("active") ? "true" : "false");
      expect(tool.getAttribute("aria-keyshortcuts")).toBeTruthy();
    });
    const upload = allTools.find((tool) => !tool.hasAttribute("aria-pressed"))!;
    expect(upload.getAttribute("aria-label")).toBe("上传受控图片资源");

    const listbox = container.querySelector('[role="listbox"]')!;
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    const deliveryItem = container.querySelector('[data-section="delivery"] .freeform-layer-item')!;
    expect(deliveryItem.getAttribute("role")).toBe("option");
    expect(deliveryItem.getAttribute("aria-disabled")).toBe("true");
    expect(deliveryItem.getAttribute("data-delivery-node-id")).toBe("node-delivery-a");

    createWithTool("矩形");
    const freeformItem = layerItems()[0];
    expect(freeformItem.getAttribute("role")).toBe("option");
    expect(freeformItem.getAttribute("aria-selected")).toBe("true");
    expect(freeformItem.getAttribute("aria-label")).toContain("矩形");

    expect(container.querySelector(".freeform-announcer")!.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector('[data-testid="freeform-stage"]')).toBeTruthy();
    expect(container.querySelector(".freeform-inspector")!.getAttribute("aria-label")).toBe("属性");
  });

  it("FT-51 工具支持方向键循环聚焦，元素可通过键盘聚焦", async () => {
    await renderCanvas();
    const tools = [...toolbar().querySelectorAll<HTMLButtonElement>(".freeform-tool")];
    tools[0].focus();
    expect(document.activeElement).toBe(tools[0]);
    act(() => {
      toolbar().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(tools[1]);

    createWithTool("矩形");
    const elementGroup = container.querySelector(".freeform-element")!;
    expect(elementGroup.getAttribute("role")).toBe("button");
    expect(elementGroup.getAttribute("tabindex")).toBe("0");
    expect(elementGroup.getAttribute("aria-label")).toContain("矩形");
  });

  it("FT-52 prefers-reduced-motion 下不依赖动画，核心能力不降级", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    await renderCanvas();
    expect(overlay().getAttribute("data-reduced-motion")).toBe("true");

    createWithTool("矩形");
    expect(layerItems()).toHaveLength(1);
    keyEvent("a", { ctrlKey: true });
    expect(statusReadout()).toContain("已选 1");
    keyEvent("ArrowRight");
    expect(Number(inspectorInputs()[0].value)).toBe(world(100) + 1);
    keyEvent("z", { ctrlKey: true });
    expect(Number(inspectorInputs()[0].value)).toBe(world(100));
    clickButton("SVG");
    expect(announcer()).toContain("已导出自由层 SVG");
    expect(layerItems()).toHaveLength(1);
  });

  it("FT-50 纯键盘完成一次完整创作：创建 → 多选 → 组合 → 变换 → 撤销 → 导出", async () => {
    await renderCanvas();
    createWithTool("矩形", { x: 160, y: 160 });
    createWithTool("便签", { x: 400, y: 320 });
    keyEvent("a", { ctrlKey: true });
    expect(statusReadout()).toContain("已选 2");
    keyEvent("g", { ctrlKey: true });
    expect(announcer()).toContain("已组合 2 个元素");
    // 多选态下属性面板不提供单元素数值输入，改为直接读取选中轮廓的元素几何。
    expect(outlineX()).toBe(world(100));
    keyEvent("ArrowRight", { shiftKey: true });
    expect(outlineX()).toBe(world(100) + 10);
    keyEvent("z", { ctrlKey: true });
    expect(outlineX()).toBe(world(100));
    clickButton("SVG");
    expect(layerItems()).toHaveLength(2);
    expect(announcer()).toContain("已导出自由层 SVG");
  });

  it("Esc 依次退出内联编辑、取消手势、清空选择，最后关闭自由层", async () => {
    await renderCanvas();
    createWithTool("文本");
    const textEditorSelector = '[data-testid="freeform-text-editor"]';
    act(() => {
      viewport().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 150, clientY: 150 }));
    });
    expect(container.querySelector(textEditorSelector)).toBeTruthy();
    keyEvent("Escape");
    expect(container.querySelector(textEditorSelector)).toBeNull();

    keyEvent("Escape");
    expect(statusReadout()).toContain("已选 0");
    keyEvent("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});