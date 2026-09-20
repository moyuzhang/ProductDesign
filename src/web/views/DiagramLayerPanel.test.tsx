// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramEdge, DiagramLayer, DiagramNode } from "../../shared/types";

const harness = vi.hoisted(() => {
  class WhiteboardConflictError extends Error {
    readonly serverUpdatedAt: string;
    readonly code: string;
    constructor(message: string, code: string, serverUpdatedAt: string) {
      super(message);
      this.name = "WhiteboardConflictError";
      this.code = code;
      this.serverUpdatedAt = serverUpdatedAt;
    }
  }
  return {
    WhiteboardConflictError,
    getDiagramLayers: vi.fn(),
    updateDiagramLayers: vi.fn(),
    getFreeformDocument: vi.fn(),
  };
});

vi.mock("../api", () => ({
  WhiteboardConflictError: harness.WhiteboardConflictError,
  api: {
    getDiagramLayers: harness.getDiagramLayers,
    updateDiagramLayers: harness.updateDiagramLayers,
    getFreeformDocument: harness.getFreeformDocument,
  },
}));

import { DiagramLayerPanel } from "./DiagramLayerPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const DIAGRAM_UPDATED_AT = "2026-09-20T00:00:00.000Z";
const NEXT_UPDATED_AT = "2026-09-20T00:01:00.000Z";

const NODES = [
  { id: "n1", kind: "feature", label: "节点一", x: 0, y: 0, w: 160, h: 48 },
  { id: "n2", kind: "feature", label: "节点二", x: 0, y: 120, w: 160, h: 48 },
] as unknown as DiagramNode[];
const EDGES = [{ id: "e1", from: "n1", to: "n2" }] as unknown as DiagramEdge[];

function makeLayer(id: string, name: string, memberKind: DiagramLayer["memberKind"], extra: Partial<DiagramLayer> = {}): DiagramLayer {
  return {
    id, name, kind: id.startsWith("ly_") ? "custom" : "system", memberKind,
    locked: false, hidden: false, createdAt: "", updatedAt: "", ...extra,
  };
}

const baseLayers = (): DiagramLayer[] => [
  makeLayer("layer_nodes", "交付节点", "node"),
  makeLayer("layer_edges", "连线", "edge"),
  makeLayer("layer_freeform", "自由元素", "freeform"),
];

function layerRead(layers = baseLayers()) {
  return { schemaVersion: 1 as const, layers, itemOverrides: {}, diagramUpdatedAt: DIAGRAM_UPDATED_AT };
}

const rows = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')];
const rowByName = (name: string): HTMLElement => {
  const found = rows().find((row) => row.getAttribute("aria-label")?.startsWith(`${name}，`));
  if (!found) throw new Error(`未找到图层行：${name}`);
  return found;
};
const buttonByTitle = (scope: HTMLElement, prefix: string): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((button) => button.getAttribute("title")?.startsWith(prefix));
  if (!found) throw new Error(`未找到按钮：${prefix}`);
  return found;
};
const statusText = () => container.querySelector(".layer-panel-status")?.textContent ?? "";
const updateBody = () => harness.updateDiagramLayers.mock.calls.at(-1)?.[1] as
  { schemaVersion: 1; layers: DiagramLayer[]; itemOverrides: Record<string, unknown>; expectedUpdatedAt: string | null } | undefined;
const layerOrder = () => (updateBody()?.layers ?? []).map((layer) => layer.id);
const findLayer = (id: string) => updateBody()?.layers.find((layer) => layer.id === id);

function click(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

function keyOn(target: Element, key: string, options: { altKey?: boolean; shiftKey?: boolean } = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true, altKey: Boolean(options.altKey), shiftKey: Boolean(options.shiftKey),
    }));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

async function renderPanel(props: {
  onSelectionChange?: (keys: string[]) => void;
  onLayersChanged?: (state: unknown, updatedAt: string) => void;
  layers?: DiagramLayer[];
} = {}): Promise<void> {
  harness.getDiagramLayers.mockResolvedValue(layerRead(props.layers ?? baseLayers()));
  await act(async () => {
    root.render(
      <DiagramLayerPanel
        diagramId="diagram-1"
        diagram={{ nodes: NODES, edges: EDGES }}
        onSelectionChange={props.onSelectionChange}
        onLayersChanged={props.onLayersChanged as never}
      />,
    );
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  harness.getFreeformDocument.mockResolvedValue(null);
  harness.updateDiagramLayers.mockImplementation(async (_id: string, body: {
    schemaVersion: 1; layers: DiagramLayer[]; itemOverrides: Record<string, unknown>;
  }) => ({
    schemaVersion: 1 as const,
    layers: body.layers,
    itemOverrides: body.itemOverrides,
    diagramUpdatedAt: NEXT_UPDATED_AT,
  }));
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.clearAllMocks();
});

describe("UI-LAY-01 图层可命名（F2 与双击）", () => {
  it("F2 进入重命名并回车落库", async () => {
    await renderPanel();
    const row = rowByName("交付节点");
    keyOn(row, "F2");
    const input = row.querySelector<HTMLInputElement>(".layer-rename-input");
    expect(input).not.toBeNull();
    setInputValue(input!, "业务节点");
    keyOn(input!, "Enter");
    await flush();
    expect(findLayer("layer_nodes")?.name).toBe("业务节点");
    expect(statusText()).toContain("已重命名图层为：业务节点");
    expect(updateBody()?.expectedUpdatedAt).toBe(DIAGRAM_UPDATED_AT);
  });

  it("双击层名进入重命名，Esc 取消则不改名", async () => {
    await renderPanel();
    const row = rowByName("连线");
    const nameSpan = row.querySelector(".layer-name")!;
    act(() => { nameSpan.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); });
    const input = row.querySelector<HTMLInputElement>(".layer-rename-input");
    expect(input).not.toBeNull();
    setInputValue(input!, "数据流");
    keyOn(input!, "Escape");
    await flush();
    expect(harness.updateDiagramLayers).not.toHaveBeenCalled();
    expect(rowByName("连线")).toBeTruthy();
  });
});

describe("UI-LAY-02 图层排序（键盘与拖拽）", () => {
  it("Alt+↑ 前移、Alt+Shift+↓ 置底", async () => {
    await renderPanel();
    keyOn(rowByName("连线"), "ArrowUp", { altKey: true });
    await flush();
    expect(layerOrder()).toEqual(["layer_nodes", "layer_freeform", "layer_edges"]);
    expect(statusText()).toContain("图层已前移：连线");

    keyOn(rowByName("连线"), "ArrowDown", { altKey: true, shiftKey: true });
    await flush();
    expect(layerOrder()).toEqual(["layer_edges", "layer_nodes", "layer_freeform"]);
    expect(statusText()).toContain("图层已置底：连线");
  });

  it("Alt+↓ 后移", async () => {
    await renderPanel();
    keyOn(rowByName("连线"), "ArrowDown", { altKey: true });
    await flush();
    expect(layerOrder()).toEqual(["layer_edges", "layer_nodes", "layer_freeform"]);
    expect(statusText()).toContain("图层已后移：连线");
  });

  it("拖拽到目标行后落库同一顺序", async () => {
    await renderPanel();
    const source = rowByName("自由元素");
    const target = rowByName("交付节点");
    act(() => { source.dispatchEvent(new Event("dragstart", { bubbles: true })); });
    act(() => { target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true })); });
    act(() => { target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })); });
    await flush();
    expect(layerOrder()).toEqual(["layer_freeform", "layer_nodes", "layer_edges"]);
  });
});

describe("UI-LAY-03 可见性与锁定开关落库、冲突回滚", () => {
  it("点击眼睛按钮隐藏图层并落库", async () => {
    await renderPanel();
    click(buttonByTitle(rowByName("交付节点"), "隐藏图层"));
    await flush();
    expect(findLayer("layer_nodes")?.hidden).toBe(true);
    expect(statusText()).toContain("已隐藏图层：交付节点");
    expect(buttonByTitle(rowByName("交付节点"), "显示图层").getAttribute("aria-pressed")).toBe("true");
    expect(rowByName("交付节点").getAttribute("aria-label")).toContain("已隐藏");
  });

  it("点击锁按钮锁定图层并落库", async () => {
    await renderPanel();
    click(buttonByTitle(rowByName("自由元素"), "锁定图层"));
    await flush();
    expect(findLayer("layer_freeform")?.locked).toBe(true);
    expect(statusText()).toContain("已锁定图层：自由元素");
  });

  it("CAS 冲突时回滚乐观更新并提示刷新", async () => {
    await renderPanel();
    harness.updateDiagramLayers.mockRejectedValueOnce(
      new harness.WhiteboardConflictError("画布已被其他操作修改", "LAYER_STATE_CONFLICT", NEXT_UPDATED_AT),
    );
    click(buttonByTitle(rowByName("连线"), "隐藏图层"));
    await flush();
    expect(buttonByTitle(rowByName("连线"), "隐藏图层").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".layer-panel-error")?.textContent).toContain("图层状态冲突");
  });
});

describe("UI-LAY-04 全选该层（排除隐藏与锁定）", () => {
  it("返回该层可见且未锁定的 itemKey 集合", async () => {
    const onSelectionChange = vi.fn();
    await renderPanel({ onSelectionChange });
    click(buttonByTitle(rowByName("交付节点"), "全选图层"));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["node:n1", "node:n2"]);
    expect(statusText()).toContain("已选择图层「交付节点」的 2 项");
  });

  it("该层被锁定时无可选项", async () => {
    const onSelectionChange = vi.fn();
    await renderPanel({ onSelectionChange, layers: baseLayers().map((layer) => (layer.id === "layer_nodes" ? { ...layer, locked: true } : layer)) });
    click(buttonByTitle(rowByName("交付节点"), "全选图层"));
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(statusText()).toContain("没有可选项");
  });
});

describe("UI-LAY-05 键盘可达与 aria 属性", () => {
  it("listbox/option 语义与成员数、锁定隐藏播报完整", async () => {
    await renderPanel();
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("图层列表");
    expect(rows()).toHaveLength(3);
    expect(rowByName("交付节点").getAttribute("aria-label")).toBe("交付节点，成员 2 项，未锁定，可见");
    expect(rowByName("连线").getAttribute("aria-label")).toBe("连线，成员 1 项，未锁定，可见");
    expect(rows().every((row) => row.getAttribute("tabindex") === "0")).toBe(true);
    act(() => { rowByName("连线").focus(); });
    expect(rowByName("连线").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".layer-section-title")).not.toBeNull();
    expect([...container.querySelectorAll(".layer-section-title")].map((node) => node.textContent))
      .toEqual(["交付节点", "连线", "自由元素"]);
  });

  it("面板提示明确会话态与落库态的边界", async () => {
    await renderPanel();
    const hint = container.querySelector(".layer-panel-hint");
    expect(hint?.textContent).toContain("F2 重命名");
    expect(hint?.textContent).toContain("面板宽度仅本会话");
  });
});

describe("UI-LAY-06 reduced-motion 下功能不降级", () => {
  it("媒体查询命中 reduce 时锁定/隐藏与排序仍可用", async () => {
    window.matchMedia = ((query: string) => ({
      matches: true, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    await renderPanel();
    click(buttonByTitle(rowByName("自由元素"), "隐藏图层"));
    await flush();
    expect(findLayer("layer_freeform")?.hidden).toBe(true);
    keyOn(rowByName("自由元素"), "ArrowDown", { altKey: true, shiftKey: true });
    await flush();
    expect(layerOrder()).toEqual(["layer_freeform", "layer_nodes", "layer_edges"]);
  });
});

describe("UI-LAY-07 刷新后状态与 MCP/服务端一致", () => {
  it("服务端返回的锁定/隐藏直接映射为面板静态文本与 aria-pressed", async () => {
    await renderPanel({
      layers: baseLayers().map((layer) => (layer.id === "layer_freeform" ? { ...layer, locked: true, hidden: true } : layer)),
    });
    const row = rowByName("自由元素");
    expect(row.getAttribute("aria-label")).toBe("自由元素，成员 0 项，已锁定，已隐藏");
    expect(row.querySelector(".layer-state")?.textContent).toBe("已锁定、已隐藏");
    expect(buttonByTitle(row, "解锁图层").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByTitle(row, "显示图层").getAttribute("aria-pressed")).toBe("true");
  });
});