import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrototypeDraftConflictError, Store } from "./db.js";
import type { PrototypeDraft } from "../shared/types.js";

const dir = mkdtempSync(join(tmpdir(), "pcs-prototype-"));
const store = new Store(join(dir, "prototype.db"));
let sequence = 0;

function fixture(): { diagramId: string; draft: PrototypeDraft } {
  sequence += 1;
  const project = store.insertProject({ code: `PROTO${sequence}`, name: `Prototype ${sequence}`, summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  const diagram = store.listDiagrams(project.id).find((item) => item.type === "main")!;
  return {
    diagramId: diagram.id,
    draft: {
      version: 1,
      updatedAt: "2026-09-17T00:00:00.000Z",
      screens: [{ id: "home", name: " 首页 ", components: [
        { id: "title", kind: "text", x: 28, y: 28, w: 240, h: 34, text: "首页" },
        { id: "next", kind: "button", x: 28, y: 92, w: 180, h: 48, text: "查看详情" },
      ] }],
    },
  };
}

afterEach(() => vi.useRealTimers());
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("PrototypeDesigner draft contract", () => {
  it("normalizes legacy version 1 fields and preserves server-owned history", () => {
    const { diagramId, draft } = fixture();
    const first = store.upsertPrototypeDraft(diagramId, { current: draft, versions: [draft] }, null)!;
    expect(first.current.screens[0]).toMatchObject({ name: "首页", width: 640, height: 480, background: "#0f202b" });
    expect(first.current.screens[0].components[0]).toMatchObject({ fontSize: 18, fill: "transparent", hidden: false, locked: false });
    expect(first.versions).toHaveLength(1);

    const changed = { ...first.current, screens: [{ ...first.current.screens[0], name: "新版首页" }] };
    const second = store.upsertPrototypeDraft(diagramId, { current: changed, versions: [] }, first.updatedAt)!;
    expect(second.current.screens[0].name).toBe("新版首页");
    expect(second.versions).toHaveLength(2);
    expect(second.versions[1].screens[0].name).toBe("首页");
  });

  it("enforces exact CAS for first and existing saves", () => {
    const { diagramId, draft } = fixture();
    expect(() => store.upsertPrototypeDraft(diagramId, { current: draft, versions: [] }, "missing-token"))
      .toThrow(PrototypeDraftConflictError);
    const saved = store.upsertPrototypeDraft(diagramId, { current: draft, versions: [] }, null)!;
    expect(() => store.upsertPrototypeDraft(diagramId, { current: draft, versions: [] }, null))
      .toThrow(PrototypeDraftConflictError);
    expect(() => store.upsertPrototypeDraft(diagramId, { current: draft, versions: [] }, "stale-token"))
      .toThrow(PrototypeDraftConflictError);
    expect(store.getPrototypeDraft(diagramId)?.updatedAt).toBe(saved.updatedAt);
  });

  it("produces a strictly newer token for saves in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T08:00:00.000Z"));
    const { diagramId, draft } = fixture();
    const first = store.upsertPrototypeDraft(diagramId, { current: draft, versions: [] }, null)!;
    const second = store.upsertPrototypeDraft(diagramId, { current: first.current, versions: first.versions }, first.updatedAt)!;
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.updatedAt > first.updatedAt).toBe(true);
  });

  it("rejects unknown fields, duplicate ids and unsafe image URLs without writing", () => {
    const { diagramId, draft } = fixture();
    const bad = structuredClone(draft) as PrototypeDraft & { surprise?: boolean };
    bad.surprise = true;
    expect(() => store.upsertPrototypeDraft(diagramId, { current: bad, versions: [] }, null)).toThrow();
    expect(store.getPrototypeDraft(diagramId)).toBeUndefined();

    const duplicate = structuredClone(draft);
    duplicate.screens[0].components.push({ ...duplicate.screens[0].components[0] });
    expect(() => store.upsertPrototypeDraft(diagramId, { current: duplicate, versions: [] }, null)).toThrow(/组件 id 重复/);

    const unsafe = structuredClone(draft);
    unsafe.screens[0].components.push({ id: "unsafe", kind: "image", x: 0, y: 0, w: 100, h: 100, text: "bad", imageUrl: "javascript:alert(1)" });
    expect(() => store.upsertPrototypeDraft(diagramId, { current: unsafe, versions: [] }, null)).toThrow(/图片地址/);
    expect(store.getPrototypeDraft(diagramId)).toBeUndefined();
  });
});
