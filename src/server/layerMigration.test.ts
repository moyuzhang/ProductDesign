import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { layerStateFingerprint } from "../shared/layers.js";
import { Store } from "./db.js";
import { buildApp } from "./index.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-layer-migration-"));
const dbPath = join(dataDir, "migration.db");
const app = buildApp({ dbPath, dataDir });
let diagramId = "";

beforeAll(async () => {
  const project = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { code: "LAYER_MIGRATION", name: "图层迁移", summary: "", stage: "开发", health: "正常" },
  });
  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${project.json().id}` });
  diagramId = diagrams.json()[0].id;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MIG-01..MIG-06 图层迁移", () => {
  it("旧画布只读派生默认层，显式保存后重复保存保持同一指纹", async () => {
    const store = new Store(dbPath, dataDir);
    expect(store.getRawDiagramLayers(diagramId)).toBeNull();
    store.close();

    const derived = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/layers` });
    expect(derived.statusCode).toBe(200);
    expect(derived.json().layers.map((layer: { id: string }) => layer.id)).toEqual(["layer_nodes", "layer_edges", "layer_freeform"]);

    const renamed = {
      ...derived.json(),
      layers: derived.json().layers.map((layer: Record<string, unknown>) => layer.id === "layer_nodes" ? { ...layer, name: "业务节点" } : layer),
      expectedUpdatedAt: derived.json().diagramUpdatedAt,
    };
    delete renamed.diagramUpdatedAt;
    delete renamed.unsupported;
    const first = await app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/layers`, payload: renamed });
    expect(first.statusCode, first.body).toBe(200);
    const second = await app.inject({
      method: "PATCH", url: `/api/diagrams/${diagramId}/layers`,
      payload: { ...renamed, expectedUpdatedAt: first.json().diagramUpdatedAt },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().diagramUpdatedAt).toBe(first.json().diagramUpdatedAt);
    expect(layerStateFingerprint(second.json())).toBe(layerStateFingerprint(first.json()));
  });

  it("未来版本只读返回 unsupported，所有图层写入 409 且原载荷不被旁路写覆盖", async () => {
    const future = { schemaVersion: 9, layers: [{ id: "future-layer", futureField: true }], itemOverrides: {}, futureRoot: "keep" };
    const seed = new Store(dbPath, dataDir);
    seed.db.prepare("UPDATE diagrams SET layers = ? WHERE id = ?").run(JSON.stringify(future), diagramId);
    seed.close();

    const read = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/layers` });
    expect(read.statusCode).toBe(200);
    expect(read.json().unsupported).toBe(true);
    expect(read.json().schemaVersion).toBe(1);

    const dedicatedWrite = await app.inject({
      method: "PATCH", url: `/api/diagrams/${diagramId}/layers`,
      payload: { schemaVersion: 1, layers: read.json().layers, itemOverrides: {}, expectedUpdatedAt: read.json().diagramUpdatedAt },
    });
    expect(dedicatedWrite.statusCode).toBe(409);
    expect(dedicatedWrite.json().code).toBe("LAYER_SCHEMA_UNSUPPORTED");

    const diagramWrite = await app.inject({
      method: "PATCH", url: `/api/diagrams/${diagramId}`,
      payload: { layers: { schemaVersion: 1, layers: read.json().layers, itemOverrides: {} } },
    });
    expect(diagramWrite.statusCode).toBe(409);
    expect(diagramWrite.json().code).toBe("LAYER_SCHEMA_UNSUPPORTED");

    const unrelated = await app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}`, payload: { title: "未来版本仍保留" } });
    expect(unrelated.statusCode, unrelated.body).toBe(200);
    const verify = new Store(dbPath, dataDir);
    expect(verify.getRawDiagramLayers(diagramId)).toEqual(future);
    verify.close();
  });
});
