import { describe, expect, it } from "vitest";
import type { DiagramEdge, DiagramLayerState, DiagramNode, FreeformElement } from "./types.js";
import {
  LAYER_CUSTOM_ID_PREFIX,
  LAYER_SYSTEM_EDGE_ID,
  LAYER_SYSTEM_FREEFORM_ID,
  LAYER_SYSTEM_NODE_ID,
  addLayer,
  buildLayerIndex,
  defaultLayerState,
  diagramLayerStateSchema,
  effectiveHidden,
  effectiveLocked,
  itemKeyOf,
  layerSaveSchema,
  layerStateFingerprint,
  marqueeHits,
  normalizeLayerState,
  removeLayer,
  renameLayer,
  reorderLayers,
  resolveItemLayer,
  selectAll,
  selectLayerVisible,
  setLayerFlag,
  validateLayerState,
} from "./layers.js";

function node(id: string, x = 0, y = 0, extra: Partial<DiagramNode> = {}): DiagramNode {
  return { id, kind: "feature", label: id, x, y, ...extra };
}

function edge(id: string, from: string, to: string): DiagramEdge {
  return { id, from, to };
}

function freeformRect(id: string, x: number, y: number, extra: Partial<FreeformElement> = {}): FreeformElement {
  return {
    id, kind: "rect", x, y, w: 20, h: 20, rotation: 0, groupId: null, style: {},
    locked: false, hidden: false, createdAt: "", updatedAt: "", cornerStyle: "sharp", ...extra,
  } as FreeformElement;
}

describe("图层：默认派生与归一化", () => {
  it("无 layers 字段时派生三个系统层，不写库", () => {
    const state = defaultLayerState({ nodes: [{ id: "n1" }] }, "T0");
    expect(state.schemaVersion).toBe(1);
    expect(state.layers.map((layer) => layer.id)).toEqual([LAYER_SYSTEM_NODE_ID, LAYER_SYSTEM_EDGE_ID, LAYER_SYSTEM_FREEFORM_ID]);
    expect(state.layers.every((layer) => layer.kind === "system" && !layer.locked && !layer.hidden)).toBe(true);
    expect(state.itemOverrides).toEqual({});
  });

  it("旧式 zIndex 转为数组序，缺系统层补齐，孤儿 override 被过滤，且迁移幂等", () => {
    const legacy = {
      schemaVersion: 1,
      layers: [
        { id: "ly_a", name: "上层", zIndex: 30 },
        { id: "ly_b", name: "下层", zIndex: 10 },
        { id: LAYER_SYSTEM_NODE_ID, name: "交付节点", memberKind: "node" },
      ],
      itemOverrides: {
        [itemKeyOf("node", "n1")]: { layerId: "ly_a", locked: true },
        [itemKeyOf("node", "gone")]: { locked: true },
        [itemKeyOf("freeform", "fr_1")]: { locked: true, hidden: true, layerId: LAYER_SYSTEM_FREEFORM_ID },
      },
    };
    const first = normalizeLayerState(legacy, { nodeIds: ["n1"], freeformIds: ["fr_1"], now: "T0" });
    expect(first.unsupported).toBe(false);
    // 缺 zIndex 的旧系统层按数组序(2)参与排序，落在 ly_b(10)/ly_a(30) 之前；系统层按顺序补齐在尾部
    expect(first.state.layers.map((layer) => layer.id)).toEqual([LAYER_SYSTEM_NODE_ID, "ly_b", "ly_a", LAYER_SYSTEM_EDGE_ID, LAYER_SYSTEM_FREEFORM_ID]);
    expect(first.state.layers.filter((layer) => layer.kind === "custom").map((layer) => layer.name)).toEqual(["下层", "上层"]);
    // 孤儿 override 被过滤进 legacyUnknown，不进入状态
    expect(first.state.itemOverrides[itemKeyOf("node", "gone")]).toBeUndefined();
    expect(first.legacyUnknown[`orphan.${itemKeyOf("node", "gone")}`]).toEqual({ locked: true });
    // 自由元素级 locked/hidden 被剥离（权威在自由层文档）
    expect(first.state.itemOverrides[itemKeyOf("freeform", "fr_1")]).toEqual({ layerId: LAYER_SYSTEM_FREEFORM_ID });
    expect(first.legacyUnknown[`itemOverrides.${itemKeyOf("freeform", "fr_1")}.elementFlags`]).toEqual({ locked: true, hidden: true });

    const second = normalizeLayerState(first.state, { nodeIds: ["n1"], freeformIds: ["fr_1"], now: "T0" });
    expect(second.state).toEqual(first.state);
    expect(second.legacyUnknown).toEqual({});
  });

  it("载荷 schemaVersion 高于本实现时标记 unsupported（只读不写）", () => {
    const result = normalizeLayerState({ schemaVersion: 9, layers: [], itemOverrides: {} });
    expect(result.unsupported).toBe(true);
  });
});

describe("图层：编辑操作", () => {
  const base = defaultLayerState({}, "T0");

  it("新增/重命名/置标志位", () => {
    const added = addLayer(base, "草图", { id: "ly_sketch", now: "T1" });
    expect(added.layers.map((layer) => layer.id)).toContain("ly_sketch");
    const renamed = renameLayer(added, "ly_sketch", "草图 v2", "T2");
    expect(renamed.layers.find((layer) => layer.id === "ly_sketch")?.name).toBe("草图 v2");
    const hidden = setLayerFlag(renamed, "ly_sketch", "hidden", true, "T3");
    expect(hidden.layers.find((layer) => layer.id === "ly_sketch")?.hidden).toBe(true);
    expect(hidden.layers.find((layer) => layer.id === "ly_sketch")?.updatedAt).toBe("T3");
  });

  it("删除自定义层清理其 layerId 覆盖并回落默认层；系统层不可删", () => {
    const withLayer = addLayer(base, "草图", { id: "ly_sketch", now: "T0" });
    const withOverride: DiagramLayerState = {
      ...withLayer,
      itemOverrides: { [itemKeyOf("freeform", "fr_1")]: { layerId: "ly_sketch", hidden: true } },
    };
    expect(resolveItemLayer(withOverride, itemKeyOf("freeform", "fr_1"))).toBe("ly_sketch");
    const removed = removeLayer(withOverride, "ly_sketch");
    expect(removed.layers.map((layer) => layer.id)).not.toContain("ly_sketch");
    expect(resolveItemLayer(removed, itemKeyOf("freeform", "fr_1"))).toBe(LAYER_SYSTEM_FREEFORM_ID);
    expect(removed.itemOverrides[itemKeyOf("freeform", "fr_1")]).toEqual({ hidden: true });
    expect(() => removeLayer(base, LAYER_SYSTEM_NODE_ID)).toThrowError(/系统图层不可删除/);
  });

  it("排序 front/back/forward/backward 只改顺序不改内容", () => {
    const state = addLayer(addLayer(base, "A", { id: "ly_a" }), "B", { id: "ly_b" });
    const toFront = reorderLayers(state, "ly_a", "front");
    expect(toFront.layers.at(-1)?.id).toBe("ly_a");
    const toBack = reorderLayers(state, "ly_b", "back");
    expect(toBack.layers[0].id).toBe("ly_b");
    const before = state.layers.findIndex((layer) => layer.id === "ly_a");
    expect(reorderLayers(state, "ly_a", "forward").layers.findIndex((layer) => layer.id === "ly_a")).toBe(before + 1);
    expect(reorderLayers(state, "ly_a", "backward").layers.findIndex((layer) => layer.id === "ly_a")).toBe(before - 1);
  });

  it("指纹排除时间戳", () => {
    const a = addLayer(base, "草图", { id: "ly_sketch", now: "T0" });
    const b = renameLayer(a, "ly_sketch", "草图", "T9");
    expect(layerStateFingerprint(a)).toBe(layerStateFingerprint(b));
  });
});

describe("图层：可见性与选择", () => {
  const state: DiagramLayerState = {
    schemaVersion: 1,
    layers: [
      { id: LAYER_SYSTEM_NODE_ID, name: "交付节点", kind: "system", memberKind: "node", locked: false, hidden: false, createdAt: "", updatedAt: "" },
      { id: LAYER_SYSTEM_EDGE_ID, name: "连线", kind: "system", memberKind: "edge", locked: false, hidden: false, createdAt: "", updatedAt: "" },
      { id: LAYER_SYSTEM_FREEFORM_ID, name: "自由元素", kind: "system", memberKind: "freeform", locked: true, hidden: false, createdAt: "", updatedAt: "" },
      { id: "ly_a", name: "A", kind: "custom", memberKind: "mixed", locked: false, hidden: true, createdAt: "", updatedAt: "" },
    ],
    itemOverrides: {
      [itemKeyOf("node", "n2")]: { locked: true },
      [itemKeyOf("freeform", "fr_2")]: { layerId: "ly_a" },
    },
  };
  const index = buildLayerIndex({
    diagram: { nodes: [node("n1", 0, 0), node("n2", 100, 0)], edges: [edge("e1", "n1", "n2")] },
    freeform: { elements: [
      freeformRect("fr_1", 300, 0, { groupId: "fg_1" }),
      freeformRect("fr_2", 200, 0),
    ] },
  });

  it("隐藏为 AND 语义、锁定为 OR 语义", () => {
    expect(effectiveHidden(state, index, itemKeyOf("freeform", "fr_2"))).toBe(true); // 父层隐藏
    expect(effectiveHidden(state, index, itemKeyOf("node", "n1"))).toBe(false);
    expect(effectiveLocked(state, index, itemKeyOf("freeform", "fr_1"))).toBe(true); // 系统自由层锁定
    expect(effectiveLocked(state, index, itemKeyOf("node", "n2"))).toBe(true); // 元素级锁定
    expect(effectiveLocked(state, index, itemKeyOf("node", "n1"))).toBe(false);
  });

  it("全选排除隐藏与锁定，仅取可见层成员", () => {
    expect(selectAll(state, index).sort()).toEqual([itemKeyOf("node", "n1"), itemKeyOf("edge", "e1")].sort());
    expect(selectLayerVisible(state, index, LAYER_SYSTEM_NODE_ID)).toEqual([itemKeyOf("node", "n1"), itemKeyOf("node", "n2")]);
  });

  it("框选排除隐藏、保留锁定，命中自由元素整组入选", () => {
    const hits = marqueeHits(state, index, { x: -10, y: -10, w: 400, h: 60 }).sort();
    expect(hits).toContain(itemKeyOf("node", "n1"));
    expect(hits).toContain(itemKeyOf("node", "n2"));
    expect(hits).toContain(itemKeyOf("freeform", "fr_1"));
    expect(hits).not.toContain(itemKeyOf("freeform", "fr_2")); // 父层隐藏
  });
});

describe("图层：契约校验与 schema", () => {
  it("重名冲突与系统层完整性", () => {
    const base = defaultLayerState({}, "T0");
    const duplicated = addLayer(base, "交付节点", { id: "ly_dup" });
    expect(() => validateLayerState(duplicated)).toThrowError(/唯一/);
    const missing = { ...base, layers: base.layers.filter((layer) => layer.id !== LAYER_SYSTEM_EDGE_ID) };
    expect(() => validateLayerState(missing)).toThrowError(/缺少系统图层/);
  });

  it("交付节点/连线不可搬运到非系统层，自由元素禁止写 locked/hidden", () => {
    const state: DiagramLayerState = {
      ...defaultLayerState({}, "T0"),
      itemOverrides: { [itemKeyOf("node", "n1")]: { layerId: "ly_a" } },
    };
    const withLayer = addLayer(state, "A", { id: "ly_a" });
    expect(() => validateLayerState(withLayer, { nodeIds: ["n1"] })).toThrowError(/LAYER_MEMBERSHIP_FORBIDDEN|不可搬运/);
    const badFreeform: DiagramLayerState = {
      ...defaultLayerState({}, "T0"),
      itemOverrides: { [itemKeyOf("freeform", "fr_1")]: { locked: true } },
    };
    expect(() => validateLayerState(badFreeform, { freeformIds: ["fr_1"] })).toThrowError(/自由元素/);
  });

  it("schema 为 strict：未知字段一律拒绝", () => {
    const state = defaultLayerState({}, "T0");
    expect(diagramLayerStateSchema.safeParse(state).success).toBe(true);
    expect(diagramLayerStateSchema.safeParse({ ...state, extra: 1 }).success).toBe(false);
    expect(layerSaveSchema.safeParse({ ...state, expectedUpdatedAt: null }).success).toBe(true);
    expect(layerSaveSchema.safeParse({ ...state, expectedUpdatedAt: null, type: "main" }).success).toBe(false);
    expect(layerSaveSchema.safeParse({ ...state }).success).toBe(false);
    expect(addLayer(defaultLayerState(), "x", { id: `${LAYER_CUSTOM_ID_PREFIX}1` }).layers.at(-1)?.id).toBe(`${LAYER_CUSTOM_ID_PREFIX}1`);
  });
});