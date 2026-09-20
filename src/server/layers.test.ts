import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

// 图层服务契约（设计第 6.2 节 / 第 12 节 LAY-10..16、LAY-40..43）。
const dataDir = mkdtempSync(join(tmpdir(), "pcs-layers-api-"));
const app = buildApp({ dbPath: join(dataDir, "layers-api.db"), dataDir });

let projectId = "";
let diagramId = "";
const NODE_ID = "layers-node-1";
const EDGE_ID = "edge-layers-1";
const FREEFORM_ID = "fr_layers_1";
const SYSTEM_IDS = ["layer_nodes", "layer_edges", "layer_freeform"];

const rect = (id = FREEFORM_ID) => ({
  id, kind: "rect" as const, x: 0, y: 0, w: 100, h: 80, rotation: 0, groupId: null, style: {},
  locked: false, hidden: false,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", cornerStyle: "rounded" as const,
});

const customLayer = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, kind: "custom" as const, memberKind: "mixed" as const, locked: false, hidden: false,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...extra,
});

async function getLayers(id = diagramId) {
  const response = await app.inject({ method: "GET", url: `/api/diagrams/${id}/layers` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

const saveLayers = (payload: unknown) =>
  app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/layers`, payload });

async function getDiagram(id = diagramId) {
  const response = await app.inject({ method: "GET", url: `/api/diagrams/${id}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/** 只抽取交付门禁相关数值，用于断言图层/组件写入前后零变化（LAY-43 / 设计 10.4）。 */
async function deliveryGateSnapshot() {
  const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/workflow` });
  expect(response.statusCode, response.body).toBe(200);
  const workflow = response.json();
  return {
    missing: workflow.missing,
    nextAction: workflow.nextAction,
    layerGate: workflow.layerGate,
    nodes: (workflow.nodes as Array<Record<string, unknown>>).map((node) => ({
      nodeId: node.nodeId,
      missing: node.missing,
      approvedDocumentCount: node.approvedDocumentCount,
      planCount: node.planCount,
      completedPlanCount: node.completedPlanCount,
      evidenceCount: node.evidenceCount,
      developmentStatus: node.developmentStatus,
      acceptanceStatus: node.acceptanceStatus,
    })),
  };
}

beforeAll(async () => {
  const project = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { code: "LAYERS_API", name: "图层 API", summary: "", stage: "开发", health: "正常" },
  });
  expect(project.statusCode, project.body).toBe(200);
  projectId = project.json().id;

  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
  diagramId = (diagrams.json() as Array<{ id: string; type: string }>).find((item) => item.type === "main")!.id;

  const patched = await app.inject({
    method: "PATCH", url: `/api/diagrams/${diagramId}`,
    payload: {
      nodes: [{ id: NODE_ID, kind: "feature", label: "图层交付节点", x: 0, y: 0 }],
      edges: [{ id: EDGE_ID, from: NODE_ID, to: NODE_ID }],
    },
  });
  expect(patched.statusCode, patched.body).toBe(200);

  const freeform = await app.inject({
    method: "PATCH", url: `/api/diagrams/${diagramId}/freeform`,
    payload: { schemaVersion: 1, elements: [rect()], expectedUpdatedAt: null },
  });
  expect(freeform.statusCode, freeform.body).toBe(200);
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("图层服务契约（LAY-10 / LAY-11 / LAY-13）", () => {
  it("旧画布读取派生三个系统层且不写库；未知画布 404", async () => {
    const state = await getLayers();
    expect(state.layers.map((layer: { id: string }) => layer.id)).toEqual(SYSTEM_IDS);
    expect(state.layers.every((layer: { kind: string }) => layer.kind === "system")).toBe(true);
    expect(state.itemOverrides).toEqual({});
    expect(typeof state.diagramUpdatedAt).toBe("string");

    // 指纹相同 → 不写库、不变更 updatedAt、不产生 revision 噪音（设计 8.1）。
    const replay = await saveLayers({
      schemaVersion: 1, layers: state.layers, itemOverrides: {}, expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().diagramUpdatedAt).toBe(state.diagramUpdatedAt);

    const missing = await app.inject({ method: "GET", url: "/api/diagrams/not-a-diagram/layers" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("图层持久化与边界（LAY-11 / LAY-16 / LAY-40）", () => {
  it("PATCH 持久化图层定义与元素级覆盖，且不改动 nodes/edges/groups/type", async () => {
    const before = await getLayers();
    const beforeDiagram = await getDiagram();
    const layers = before.layers.map((layer: Record<string, unknown>) =>
      layer.id === "layer_freeform" ? { ...layer, hidden: true } : layer);
    layers.push(customLayer("ly_custom", "草图层"));
    const body = {
      schemaVersion: 1,
      layers,
      itemOverrides: { [`node:${NODE_ID}`]: { locked: true }, [`freeform:${FREEFORM_ID}`]: { layerId: "ly_custom" } },
      expectedUpdatedAt: before.diagramUpdatedAt,
      actor: "builder",
    };
    const saved = await saveLayers(body);
    expect(saved.statusCode, saved.body).toBe(200);

    const after = await getLayers();
    expect(after.layers.map((layer: { id: string }) => layer.id)).toContain("ly_custom");
    expect(after.layers.find((layer: { id: string }) => layer.id === "layer_freeform").hidden).toBe(true);
    expect(after.itemOverrides[`node:${NODE_ID}`]).toEqual({ locked: true });
    expect(after.itemOverrides[`freeform:${FREEFORM_ID}`]).toEqual({ layerId: "ly_custom" });

    // 图层写绝不触碰交付结构（LAY-16）；主画布类型与唯一性不变（LAY-40）。
    const afterDiagram = await getDiagram();
    expect(afterDiagram.type).toBe("main");
    expect(afterDiagram.nodes).toEqual(beforeDiagram.nodes);
    expect(afterDiagram.edges).toEqual(beforeDiagram.edges);
    expect(afterDiagram.groups).toEqual(beforeDiagram.groups);
    expect(afterDiagram.title).toBe(beforeDiagram.title);
    const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
    expect((diagrams.json() as Array<{ type: string }>).filter((item) => item.type === "main")).toHaveLength(1);
  });

  it("CAS 失败返回 409 LAYER_STATE_CONFLICT + serverUpdatedAt 且零写入（LAY-12）", async () => {
    const before = await getLayers();
    const layers = before.layers.map((layer: Record<string, unknown>) =>
      layer.id === "layer_nodes" ? { ...layer, name: "被错误写入的名字" } : layer);
    const conflict = await saveLayers({
      schemaVersion: 1, layers, itemOverrides: before.itemOverrides, expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("LAYER_STATE_CONFLICT");
    expect(conflict.json().serverUpdatedAt).toBe(before.diagramUpdatedAt);

    const after = await getLayers();
    expect(after.layers.find((layer: { id: string }) => layer.id === "layer_nodes").name).not.toBe("被错误写入的名字");
    expect(after.diagramUpdatedAt).toBe(before.diagramUpdatedAt);
  });
});

describe("图层契约拒绝路径（设计 3.1 / 3.3 / 3.8）", () => {
  it("交付节点与连线不可搬运到非系统层：400 LAYER_MEMBERSHIP_FORBIDDEN", async () => {
    const state = await getLayers();
    const layers = [...state.layers, customLayer("ly_target", "目标层")];
    for (const key of [`node:${NODE_ID}`, `edge:${EDGE_ID}`]) {
      const response = await saveLayers({
        schemaVersion: 1, layers,
        itemOverrides: { ...state.itemOverrides, [key]: { layerId: "ly_target" } },
        expectedUpdatedAt: state.diagramUpdatedAt,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().code).toBe("LAYER_MEMBERSHIP_FORBIDDEN");
    }
  });

  it("自由元素禁止在 itemOverrides 写 locked/hidden；引用不存在元素一律 400", async () => {
    const state = await getLayers();
    const flagged = await saveLayers({
      schemaVersion: 1, layers: state.layers,
      itemOverrides: { ...state.itemOverrides, [`freeform:${FREEFORM_ID}`]: { locked: true } },
      expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(flagged.statusCode, flagged.body).toBe(400);
    expect(flagged.json().message).toMatch(/自由元素权威在自由层文档/);

    const orphan = await saveLayers({
      schemaVersion: 1, layers: state.layers,
      itemOverrides: { ...state.itemOverrides, [`node:gone-node`]: { locked: true } },
      expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().message).toMatch(/不存在的交付节点/);

    const dangling = await saveLayers({
      schemaVersion: 1, layers: state.layers,
      itemOverrides: { ...state.itemOverrides, [`freeform:${FREEFORM_ID}`]: { layerId: "ly_absent" } },
      expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().message).toMatch(/不存在的图层/);
  });

  it("图层命名重复 409 LAYER_NAME_CONFLICT；缺系统层/重复 id 400；未知字段 400", async () => {
    const state = await getLayers();
    const duplicated = await saveLayers({
      schemaVersion: 1,
      layers: [...state.layers, customLayer("ly_a", "同名层"), customLayer("ly_b", "同名层")],
      itemOverrides: state.itemOverrides, expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json().code).toBe("LAYER_NAME_CONFLICT");

    const missingSystem = await saveLayers({
      schemaVersion: 1, layers: state.layers.filter((layer: { id: string }) => layer.id !== "layer_edges"),
      itemOverrides: state.itemOverrides, expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(missingSystem.statusCode).toBe(400);
    expect(missingSystem.json().message).toMatch(/缺少系统图层/);

    const duplicateId = await saveLayers({
      schemaVersion: 1, layers: [...state.layers, customLayer("layer_nodes", "伪系统层")],
      itemOverrides: state.itemOverrides, expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(duplicateId.statusCode).toBe(400);
    expect(duplicateId.json().message).toMatch(/图层 id 重复/);

    const unknownField = await saveLayers({
      schemaVersion: 1, layers: state.layers, itemOverrides: state.itemOverrides,
      expectedUpdatedAt: state.diagramUpdatedAt, zIndex: 3,
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it("载荷版本高于实现 → 409 LAYER_SCHEMA_UNSUPPORTED 且零写入", async () => {
    const before = await getLayers();
    const unsupported = await saveLayers({
      schemaVersion: 9, layers: before.layers, itemOverrides: before.itemOverrides,
      expectedUpdatedAt: before.diagramUpdatedAt,
    });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().code).toBe("LAYER_SCHEMA_UNSUPPORTED");
    expect(unsupported.json().supportedSchemaVersions).toEqual([1]);

    const after = await getLayers();
    expect(after.diagramUpdatedAt).toBe(before.diagramUpdatedAt);
  });
});

describe("交付门禁隔离与既有规则（LAY-43 / 设计 10.4）", () => {
  it("图层与组件写入前后，工作流七项统计与 layerGate 零变化", async () => {
    const before = await deliveryGateSnapshot();

    const state = await getLayers();
    const layers = [...state.layers, customLayer("ly_gate", "门禁隔离层", { locked: true, hidden: true })];
    const saved = await saveLayers({
      schemaVersion: 1, layers,
      itemOverrides: { ...state.itemOverrides, [`freeform:${FREEFORM_ID}`]: { layerId: "ly_gate" } },
      expectedUpdatedAt: state.diagramUpdatedAt,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const component = await app.inject({
      method: "POST", url: `/api/diagrams/${diagramId}/components`,
      payload: {
        name: "门禁隔离组件", expectedUpdatedAt: saved.json().diagramUpdatedAt,
        selection: { nodeIds: [NODE_ID], edgeIds: [EDGE_ID], freeformIds: [FREEFORM_ID] },
      },
    });
    expect(component.statusCode, component.body).toBe(201);

    const after = await deliveryGateSnapshot();
    expect(after).toEqual(before);
  });
});