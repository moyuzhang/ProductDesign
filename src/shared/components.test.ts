import { describe, expect, it } from "vitest";
import type { DiagramComponentDefinition, DiagramEdge, DiagramGroup, DiagramLayerState, DiagramNode } from "./types.js";
import {
  COMPONENT_ID_PREFIX,
  COMPONENT_MAX,
  componentCreateSchema,
  componentLibrarySchema,
  componentPayloadSchema,
  instantiateComponent,
  normalizeComponentLibrary,
  snapshotComponent,
  stripComponentNodeDeliveryFields,
} from "./components.js";
import { LAYER_SYSTEM_NODE_ID, defaultLayerState } from "./layers.js";

function node(id: string, x = 0, y = 0, extra: Partial<DiagramNode> = {}): DiagramNode {
  return { id, kind: "feature", label: id, x, y, ...extra };
}

function edge(id: string, from: string, to: string): DiagramEdge {
  return { id, from, to };
}

describe("组件：从选区创建快照", () => {
  const diagram = {
    nodes: [
      node("n1", 0, 0, { requirementStatus: "已批准", owner: "designer", acceptanceCriteria: "AC1", requiresDatabase: true }),
      node("n2", 200, 0, { designStatus: "已批准", deliveryUpdatedAt: "T1" }),
      node("n3", 400, 0),
    ],
    edges: [edge("e1", "n1", "n2"), edge("e2", "n2", "n3")],
    groups: [
      { id: "g1", name: "内部组", nodeIds: ["n1", "n2"] } as DiagramGroup,
      { id: "g2", name: "跨界组", nodeIds: ["n2", "n3"] } as DiagramGroup,
    ],
  };

  it("剥离全部交付字段，连线越出选区即丢弃，仅保留完全内部组", () => {
    const result = snapshotComponent({
      diagram,
      selection: { nodeIds: ["n1", "n2"], edgeIds: ["e1", "e2"], freeformIds: [] },
      name: "组件 A",
      actor: "builder",
      now: "T0",
    });
    expect(result.definition.id.startsWith(COMPONENT_ID_PREFIX)).toBe(true);
    expect(result.definition.payload.nodes).toHaveLength(2);
    for (const snapshot of result.definition.payload.nodes) {
      expect(Object.keys(snapshot)).not.toContain("requirementStatus");
      expect(Object.keys(snapshot)).not.toContain("designStatus");
      expect(Object.keys(snapshot)).not.toContain("owner");
      expect(Object.keys(snapshot)).not.toContain("acceptanceCriteria");
      expect(Object.keys(snapshot)).not.toContain("requiresDatabase");
      expect(Object.keys(snapshot)).not.toContain("deliveryUpdatedAt");
    }
    expect(result.definition.payload.edges.map((item) => item.id)).toEqual(["e1"]);
    expect(result.droppedEdgeIds).toEqual(["e2"]);
    expect(result.definition.payload.groups.map((group) => group.id)).toEqual(["g1"]);
    expect(result.definition.createdBy).toBe("builder");
    expect(result.definition.createdAt).toBe("T0");
  });

  it("空选区与不存在元素一律拒绝", () => {
    expect(() => snapshotComponent({ diagram, selection: { nodeIds: [], edgeIds: [], freeformIds: [] }, name: "x", actor: "a" }))
      .toThrowError(/至少需要选中/);
    expect(() => snapshotComponent({ diagram, selection: { nodeIds: ["gone"], edgeIds: [], freeformIds: [] }, name: "x", actor: "a" }))
      .toThrowError(/选区节点不存在/);
  });

  it("越权 assetRef 以占位资源落库", () => {
    const result = snapshotComponent({
      diagram: { nodes: [node("n1")], edges: [], groups: [] },
      freeform: { elements: [{ id: "fr_1", kind: "image", x: 0, y: 0, w: 20, h: 20, rotation: 0, groupId: null, style: {}, locked: false, hidden: false, createdAt: "", updatedAt: "", assetRef: "fa_other_project" } as never] },
      selection: { nodeIds: ["n1"], edgeIds: [], freeformIds: ["fr_1"] },
      name: "带图组件",
      actor: "builder",
      availableAssetIds: ["fa_ok"],
    });
    expect((result.definition.payload.freeform?.elements[0] as { assetRef?: string }).assetRef).toBe("fa_placeholder_missing");
  });

  it("只纳入选区涉及的自定义层", () => {
    const layerState: DiagramLayerState = {
      ...defaultLayerState({}, "T0"),
      layers: [...defaultLayerState({}, "T0").layers, { id: "ly_custom", name: "自定义", kind: "custom", memberKind: "mixed", locked: false, hidden: false, createdAt: "T0", updatedAt: "T0" }],
      itemOverrides: { "node:n1": { layerId: "ly_custom", hidden: true } },
    };
    const result = snapshotComponent({
      diagram, layerState,
      selection: { nodeIds: ["n1"], edgeIds: [], freeformIds: [] },
      name: "层组件", actor: "builder", now: "T0",
    });
    expect(result.definition.payload.layers?.layers.map((layer) => layer.id)).toEqual(["ly_custom"]);
    expect(result.definition.payload.layers?.itemOverrides["node:n1"]).toEqual({ layerId: "ly_custom", hidden: true });
  });
});

describe("组件：实例化", () => {
  const definition: DiagramComponentDefinition = {
    id: `${COMPONENT_ID_PREFIX}1`,
    name: "组件 A",
    payload: {
      nodes: [node("n1", 0, 0), node("n2", 100, 0)] as never,
      edges: [edge("e1", "n1", "n2")],
      groups: [{ id: "g1", name: "组", nodeIds: ["n1", "n2"] } as DiagramGroup],
      freeform: null,
      layers: {
        layers: [{ id: "ly_custom", name: "自定义", kind: "custom", memberKind: "mixed", locked: false, hidden: false, createdAt: "", updatedAt: "" }],
        itemOverrides: { "node:n1": { layerId: "ly_custom", locked: true }, "node:n2": { layerId: LAYER_SYSTEM_NODE_ID } },
      },
    },
    sourceSelection: { nodeIds: ["n1", "n2"], edgeIds: ["e1"], freeformIds: [] },
    createdBy: "builder",
    createdAt: "T0",
    updatedAt: "T0",
  };

  it("id 全重生成、连线端点重映射、几何偏移、层 id 重生成且引用同步", () => {
    const result = instantiateComponent({ definition, offsetX: 16, offsetY: 16, now: "T1" });
    expect(result.createdNodeIds).toHaveLength(2);
    expect(result.createdNodeIds).not.toContain("n1");
    expect(result.nodes[0].x).toBe(16);
    expect(result.nodes[0].y).toBe(16);
    const newEdge = result.edges[0];
    expect(result.createdNodeIds).toContain(newEdge.from);
    expect(result.createdNodeIds).toContain(newEdge.to);
    expect(result.groups[0].nodeIds).toEqual(result.createdNodeIds);
    const customLayer = result.layers?.layers.find((layer) => layer.name === "自定义");
    expect(customLayer?.id).not.toBe("ly_custom");
    const keys = Object.keys(result.layers?.itemOverrides ?? {});
    expect(keys).toContain(`node:${result.createdNodeIds[0]}`);
    expect(result.layers?.itemOverrides[`node:${result.createdNodeIds[0]}`].layerId).toBe(customLayer?.id);
    // 覆盖层不在快照内（系统默认层）→ 该覆盖条目被丢弃，实例回落默认层
    expect(result.layers?.itemOverrides[`node:${result.createdNodeIds[1]}`]).toBeUndefined();
  });

  it("实例节点不继承交付状态字段", () => {
    const withDelivery = { ...definition, payload: { ...definition.payload, nodes: [node("n1", 0, 0, { requirementStatus: "已批准" })] as never } };
    const result = instantiateComponent({ definition: withDelivery, offsetX: 0, offsetY: 0, now: "T1" });
    expect(Object.keys(result.nodes[0])).not.toContain("requirementStatus");
  });
});

describe("组件：归一化与 schema", () => {
  it("非法组件条目被丢弃，schemaVersion 归一为 1", () => {
    const library = normalizeComponentLibrary({ components: [{ id: "not-a-component" }, { id: `${COMPONENT_ID_PREFIX}ok`, name: "ok", payload: {}, sourceSelection: {} }] });
    expect(library.schemaVersion).toBe(1);
    expect(library.components.map((component) => component.id)).toEqual([`${COMPONENT_ID_PREFIX}ok`]);
  });

  it("strict schema 拒绝交付字段与未知字段", () => {
    const payload = {
      nodes: [{ id: "n1", kind: "feature", label: "", x: 0, y: 0, requirementStatus: "已批准" }],
      edges: [], groups: [], freeform: null, layers: null,
    };
    expect(componentPayloadSchema.safeParse(payload).success).toBe(false);
    expect(componentLibrarySchema.safeParse({ schemaVersion: 1, components: [], extra: 1 }).success).toBe(false);
    expect(stripComponentNodeDeliveryFields(node("n1", 0, 0, { developmentStatus: "开发中" }))).toEqual({ id: "n1", kind: "feature", label: "n1", x: 0, y: 0 });
  });

  it("创建 schema 为选区数组补默认空，且拒绝画布级字段", () => {
    const parsed = componentCreateSchema.parse({ name: "组件", selection: {}, expectedUpdatedAt: null });
    expect(parsed.selection).toEqual({ nodeIds: [], edgeIds: [], freeformIds: [] });
    expect(componentCreateSchema.safeParse({ name: "组件", selection: {}, expectedUpdatedAt: null, type: "main" }).success).toBe(false);
    expect(componentLibrarySchema.safeParse({ schemaVersion: 1, components: [] }).success).toBe(true);
    expect(COMPONENT_MAX).toBe(200);
  });
});