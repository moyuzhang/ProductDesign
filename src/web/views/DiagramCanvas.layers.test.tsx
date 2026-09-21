// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramCanvasApi } from "./DiagramCanvas";
import type { DiagramLayerState } from "../../shared/types";
import { DiagramCanvas } from "./DiagramCanvas";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nodes = [
  { id: "n1", kind: "feature" as const, label: "隐藏节点", x: 0, y: 0 },
  { id: "n2", kind: "feature" as const, label: "可见节点", x: 220, y: 0 },
];
const edges = [{ id: "e1", from: "n1", to: "n2" }];
const baseLayers = () => [
  { id: "layer_nodes", name: "交付节点", kind: "system" as const, memberKind: "node" as const, locked: false, hidden: false, createdAt: "", updatedAt: "" },
  { id: "layer_edges", name: "连线", kind: "system" as const, memberKind: "edge" as const, locked: false, hidden: false, createdAt: "", updatedAt: "" },
  { id: "layer_freeform", name: "自由元素", kind: "system" as const, memberKind: "freeform" as const, locked: false, hidden: false, createdAt: "", updatedAt: "" },
];

let container: HTMLDivElement;
let root: Root;
type CanvasProps = ComponentProps<typeof DiagramCanvas>;

async function renderCanvas(layerState: DiagramLayerState, overrides: {
  onCommit?: CanvasProps["onCommit"];
  onSelectionChange?: CanvasProps["onSelectionChange"];
  onRegisterApi?: (api: DiagramCanvasApi) => void;
} = {}): Promise<void> {
  await act(async () => {
    root.render(<DiagramCanvas
      initial={{ nodes, edges, groups: [] }}
      diagramType="free"
      layerState={layerState}
      onCommit={overrides.onCommit ?? vi.fn<CanvasProps["onCommit"]>()}
      onSelectionChange={overrides.onSelectionChange}
      onRegisterApi={overrides.onRegisterApi}
      linkOptions={[]}
      onOpenDiagram={vi.fn()}
      onOpenNodeDetails={vi.fn()}
    />);
  });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe("画布消费图层 effectiveHidden/effectiveLocked", () => {
  it("隐藏元素不渲染，锁定节点可选但 Delete 不产生修改", async () => {
    const onCommit = vi.fn<CanvasProps["onCommit"]>();
    await renderCanvas({
      schemaVersion: 1,
      layers: baseLayers(),
      itemOverrides: { "node:n1": { hidden: true }, "node:n2": { locked: true }, "edge:e1": { hidden: true } },
    }, { onCommit });

    expect(container.querySelector('[data-node-id="n1"]')).toBeNull();
    const lockedNode = container.querySelector<SVGGElement>('[data-node-id="n2"]');
    expect(lockedNode).not.toBeNull();
    expect(container.querySelector('[data-edge-id="e1"]')).toBeNull();

    act(() => { lockedNode!.dispatchEvent(new FocusEvent("focus", { bubbles: true })); });
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })); });
    expect(onCommit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-node-id="n2"]')).not.toBeNull();
  });

  it("图层面板回传的 itemKey 可驱动画布选择", async () => {
    const onSelectionChange = vi.fn<NonNullable<CanvasProps["onSelectionChange"]>>();
    let api: DiagramCanvasApi | null = null;
    await renderCanvas({ schemaVersion: 1, layers: baseLayers(), itemOverrides: {} }, {
      onSelectionChange,
      onRegisterApi: (value) => { api = value; },
    });
    act(() => { api!.selectItems(["node:n2", "edge:e1"]); });
    await act(async () => { await Promise.resolve(); });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ nodeIds: ["n2"], edgeIds: ["e1"], groupIds: [] });
  });
});
