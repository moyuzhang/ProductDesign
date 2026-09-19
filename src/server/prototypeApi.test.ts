import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-prototype-api-"));
const app = buildApp({ dbPath: join(dataDir, "prototype-api.db"), dataDir });
let diagramId = "";

const current = {
  version: 1 as const,
  updatedAt: "2026-09-17T00:00:00.000Z",
  screens: [{
    id: "home",
    name: "首页",
    components: [{ id: "title", kind: "text" as const, x: 20, y: 24, w: 260, h: 40, text: "页面标题" }],
  }],
};

beforeAll(async () => {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { code: "PROTOTYPE_API", name: "页面原型 API", summary: "", stage: "开发", health: "正常" },
  });
  expect(project.statusCode, project.body).toBe(200);
  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${project.json().id}` });
  diagramId = (diagrams.json() as Array<{ id: string; type: string }>).find((diagram) => diagram.type === "main")!.id;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("prototype REST CAS and validation", () => {
  it("requires explicit first-save CAS and allows only one null-token creator", async () => {
    const missing = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagramId}/prototype`,
      payload: { current, versions: [] },
    });
    expect(missing.statusCode).toBe(400);

    const stringOnMissing = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagramId}/prototype`,
      payload: { expectedUpdatedAt: "not-created", current, versions: [] },
    });
    expect(stringOnMissing.statusCode).toBe(409);

    const payload = { expectedUpdatedAt: null, current, versions: [] };
    const responses = await Promise.all([
      app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/prototype`, payload }),
      app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/prototype`, payload }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const saved = responses.find((response) => response.statusCode === 200)!.json();
    expect(saved.current.screens[0]).toMatchObject({ width: 640, height: 480, background: "#0f202b" });
  });

  it("rejects unknown and unsafe fields without changing the stored revision", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/prototype` });
    const stored = before.json();
    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagramId}/prototype`,
      payload: { expectedUpdatedAt: stored.updatedAt, current: { ...stored.current, unknown: true }, versions: stored.versions },
    });
    expect(unknown.statusCode).toBe(400);

    const unsafe = structuredClone(stored.current);
    unsafe.screens[0].components.push({
      id: "bad-image", kind: "image", x: 0, y: 0, w: 100, h: 100, text: "bad", imageUrl: "data:text/html,bad",
    });
    const invalidUrl = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagramId}/prototype`,
      payload: { expectedUpdatedAt: stored.updatedAt, current: unsafe, versions: stored.versions },
    });
    expect(invalidUrl.statusCode).toBe(400);

    const duplicate = structuredClone(stored.current);
    duplicate.screens[0].components.push({ ...duplicate.screens[0].components[0] });
    const duplicateId = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${diagramId}/prototype`,
      payload: { expectedUpdatedAt: stored.updatedAt, current: duplicate, versions: stored.versions },
    });
    expect(duplicateId.statusCode).toBe(400);
    const after = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/prototype` });
    expect(after.json().updatedAt).toBe(stored.updatedAt);
  });

  it("allows only one writer for the same existing token", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/prototype` });
    const stored = before.json();
    const payload = (name: string) => ({
      expectedUpdatedAt: stored.updatedAt,
      current: { ...stored.current, screens: [{ ...stored.current.screens[0], name }] },
      versions: [],
    });
    const responses = await Promise.all([
      app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/prototype`, payload: payload("客户端 A") }),
      app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/prototype`, payload: payload("客户端 B") }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const after = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/prototype` });
    expect(["客户端 A", "客户端 B"]).toContain(after.json().current.screens[0].name);
    expect(after.json().versions).toHaveLength(2);
  });
});
