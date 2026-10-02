import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Store } from "./db.js";
import { buildBusinessSnapshot, createBackupFile, loadBackupFile } from "./backups.js";

const dirs: string[] = [];
const stores: Store[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-backup-design-")); dirs.push(dir);
  const store = new Store(join(dir, "test.db"), dir); stores.push(store); return store;
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(store: Store) {
  const project = store.insertProject({ code: "BACKUP", name: "Backup", summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  const diagram = store.listDiagrams(project.id)[0];
  const draft = { version: 1 as const, updatedAt: "2026-10-02T00:00:00.000Z", screens: [{ id: "home", name: "Original", components: [] }] };
  const first = store.upsertPrototypeDraft(diagram.id, { current: draft, versions: [] }, null)!;
  const prototype = store.upsertPrototypeDraft(diagram.id, { current: { ...first.current, screens: [{ ...first.current.screens[0], name: "Revised" }] }, versions: [] }, first.updatedAt)!;
  const freeform = store.upsertFreeformDocument(diagram.id, { schemaVersion: 1, elements: [], unsupported: [{ id: "future-item", raw: { kind: "future", text: "Retain me" } }] }, null)!;
  const template = store.insertDiagramTemplate({ projectId: project.id, scope: "project", name: "Snapshot template", schemaVersion: "whiteboard.template/1.0", content: { schemaVersion: "whiteboard.template/1.0", diagram: { nodes: [], edges: [], groups: [] } }, thumbnailMeta: { kind: "none", width: 0, height: 0, viewBox: "0 0 0 0", generatedAt: "2026-10-02T00:00:00.000Z", source: "auto" }, createdBy: "test" });
  store.revokeDiagramTemplate(template.id);
  const bytes = Buffer.from("synthetic image asset bytes");
  const directory = join(store.dataDir, "freeform-assets", project.id); mkdirSync(directory, { recursive: true });
  const storagePath = join(directory, "asset.bin"); writeFileSync(storagePath, bytes);
  const asset = store.insertFreeformAsset({ id: "asset", projectId: project.id, mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, storagePath, width: 1, height: 1, createdAt: "2026-10-02T00:00:00.000Z" });
  return { project, diagram, prototype, freeform, template: store.findDiagramTemplate(template.id), asset, bytes };
}
it("round-trips design sidecars and asset bytes into a fresh data directory, including history and revoked templates", () => {
  const source = open(); const data = fixture(source); const target = open();
  const backup = createBackupFile(source, source.dataDir, "design", "synthetic regression");
  const snapshot = loadBackupFile(source.dataDir, backup.id);
  expect(target.restoreBusinessSnapshot(snapshot)).toMatchObject({ prototypeDrafts: 1, freeformDocuments: 1, diagramTemplates: 1, freeformAssets: 1 });
  expect(target.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
  expect(target.getFreeformDocument(data.diagram.id)).toEqual(data.freeform);
  expect(target.findDiagramTemplate(data.template!.id)).toEqual(data.template);
  const restored = target.getFreeformAsset(data.asset.id)!;
  expect(restored).toMatchObject({ ...data.asset, storagePath: expect.any(String) });
  expect(restored.storagePath.startsWith(target.dataDir)).toBe(true);
  expect(readFileSync(restored.storagePath)).toEqual(data.bytes);
  target.restoreBusinessSnapshot(snapshot);
  expect(target.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
  expect(readFileSync(target.getFreeformAsset(data.asset.id)!.storagePath)).toEqual(data.bytes);
});
it("rejects incomplete asset contents before replacing existing data", () => {
  const store = open(); const data = fixture(store);
  const snapshot = buildBusinessSnapshot(store) as unknown as Record<string, Record<string, Array<Record<string, unknown>>>>;
  expect(snapshot.freeformAssets).toBeDefined();
  snapshot.freeformAssets[data.project.id][0].contentBase64 = Buffer.from("truncated").toString("base64");
  expect(() => store.restoreBusinessSnapshot(snapshot)).toThrow();
  expect(store.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
  expect(readFileSync(data.asset.storagePath)).toEqual(data.bytes);
});
it("rolls back sidecars and removes staged files when the database restore fails", () => {
  const store = open(); const data = fixture(store);
  const snapshot = buildBusinessSnapshot(store);
  const assetRoot = join(store.dataDir, "freeform-assets"); const before = readdirSync(assetRoot).sort();
  expect(() => store.restoreBusinessSnapshot({ ...snapshot, projects: [data.project, data.project] })).toThrow();
  expect(store.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
  expect(store.findDiagramTemplate(data.template!.id)).toEqual(data.template);
  expect(readdirSync(assetRoot).sort()).toEqual(before);
});
it("keeps old snapshots without design sidecar sections compatible", () => {
  const source = open(); const target = open(); const data = fixture(source);
  const snapshot = buildBusinessSnapshot(source) as unknown as Record<string, unknown>;
  for (const key of ["prototypeDrafts", "freeformDocuments", "diagramTemplates", "freeformAssets"]) delete snapshot[key];
  target.restoreBusinessSnapshot(snapshot);
  expect(target.getDiagram(data.diagram.id)?.title).toBe(data.diagram.title);
  expect(target.getPrototypeDraft(data.diagram.id)).toBeUndefined();
});

it("restores the same store without losing project sidecars or replacing global templates", () => {
  const store = open(); const data = fixture(store);
  const systemTemplate = store.insertDiagramTemplate({ ...data.template!, projectId: null, scope: "system", name: "Global retained" });
  const snapshot = buildBusinessSnapshot(store);
  store.restoreBusinessSnapshot(snapshot);
  expect(store.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
  expect(store.getFreeformDocument(data.diagram.id)).toEqual(data.freeform);
  expect(store.findDiagramTemplate(systemTemplate.id)).toEqual(systemTemplate);
  expect(store.findDiagramTemplate(data.template!.id)).toEqual(data.template);
  expect(readFileSync(store.getFreeformAsset(data.asset.id)!.storagePath)).toEqual(data.bytes);
  expect(readFileSync(data.asset.storagePath)).toEqual(data.bytes);
});
it("refuses to label a backup complete when a managed asset file is missing", () => {
  const store = open(); const data = fixture(store); rmSync(data.asset.storagePath);
  expect(() => createBackupFile(store, store.dataDir, "incomplete", "test")).toThrow();
  expect(store.listBackups()).toHaveLength(0);
  expect(store.getPrototypeDraft(data.diagram.id)).toEqual(data.prototype);
});
