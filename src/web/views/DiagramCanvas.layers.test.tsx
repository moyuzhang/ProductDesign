// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiagramSvg as buildMcpDiagramSvg } from "../../mcp/diagram";
import type { Diagram, DiagramLayerState } from "../../shared/types";
import type { DiagramCanvasApi } from "./DiagramCanvas";
import { buildDiagramSvg, DiagramCanvas } from "./DiagramCanvas";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nodes = [
  { id: "n1", kind: "feature" as const, label: "隐藏节点", x: 0, y: 0 },
  { id: "n2", kind: "feature" as const, label: "可见节点", x: 220, y: 0 },
  { id: "n3", kind: "feature" as const, label: "重叠节点", x: 110, y: 0 },
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

async function renderCanvas(layerState: DiagramLayerState | null, overrides: {
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
  it("主画布、小地图、重叠命中与导出统一按图层数组序绘制", async () => {
    const layerOrder = (selector: string) => [...container.querySelectorAll<SVGGElement>(selector)]
      .map((element) => element.dataset.paintLayer);
    const expectExportOrder = (layerState: DiagramLayerState, first: string, second: string) => {
      const labeledEdges = [{ ...edges[0], label: "图层连线", style: "straight" as const }];
      const diagram: Diagram = {
        id: "diagram", projectId: "project", title: "图层顺序", type: "free",
        nodes, edges: labeledEdges, groups: [], layers: layerState, createdAt: "", updatedAt: "",
      };
      for (const svg of [buildDiagramSvg(nodes, labeledEdges, [], "free", layerState), buildMcpDiagramSvg(diagram)]) {
        expect(svg.indexOf(first)).toBeLessThan(svg.indexOf(second));
      }
    };

    const nodesBelowEdges: DiagramLayerState = { schemaVersion: 1, layers: baseLayers(), itemOverrides: {} };
    await renderCanvas(nodesBelowEdges);
    expect(layerOrder(".canvas-svg g[data-paint-layer]")).toEqual(["node", "edge"]);
    expect(layerOrder(".canvas-minimap > svg > g[data-paint-layer]")).toEqual(["node", "edge"]);
    const nodeHit = container.querySelector('[data-node-id="n3"]')!;
    const edgeHit = container.querySelector('[data-edge-id="e1"]')!;
    expect(Boolean(nodeHit.compareDocumentPosition(edgeHit) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expectExportOrder(nodesBelowEdges, "重叠节点", "图层连线");

    const edgesBelowNodes: DiagramLayerState = {
      ...nodesBelowEdges,
      layers: [baseLayers()[1], baseLayers()[0], baseLayers()[2]],
    };
    await renderCanvas(edgesBelowNodes);
    expect(layerOrder(".canvas-svg g[data-paint-layer]")).toEqual(["edge", "node"]);
    expect(layerOrder(".canvas-minimap > svg > g[data-paint-layer]")).toEqual(["edge", "node"]);
    const flippedNodeHit = container.querySelector('[data-node-id="n3"]')!;
    const flippedEdgeHit = container.querySelector('[data-edge-id="e1"]')!;
    expect(Boolean(flippedEdgeHit.compareDocumentPosition(flippedNodeHit) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expectExportOrder(edgesBelowNodes, "图层连线", "重叠节点");

    await renderCanvas(null);
    expect(layerOrder(".canvas-svg g[data-paint-layer]")).toEqual(["edge", "node"]);
  });

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
