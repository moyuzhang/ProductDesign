import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { buildBusinessSnapshot } from "./backups.js";
import { beginRestoreProjectFiles, syncManagedProjectStorage } from "./projectFiles.js";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const resources: Array<{ dir: string; store: Store }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-project-mirror-"));
  const store = new Store(join(dir, "test.db"), dir); resources.push({ dir, store });
  const project = store.insertProject({ code: "MIRROR", name: "Original", summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  return { dir, store, project, root: join(dir, "projects", project.id) };
}
afterEach(() => { for (const { store, dir } of resources.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); } });
it("restores target exports and removes only known obsolete generated documents from the active mirror", () => {
  const { store, dir, project, root } = fixture();
  const snapshot = buildBusinessSnapshot(store);
  const obsolete = store.insertDesignDoc({ projectId: project.id, category: "功能说明", title: "Obsolete", summary: "", status: "草拟", version: "1", author: "fixture", content: "not in target snapshot" });
  syncManagedProjectStorage(store, dir);
  const generated = join(root, "docs", `${obsolete.id}.md`);
  const unknown = join(root, "docs", "handwritten.md"); writeFileSync(unknown, "user authored");
  writeFileSync(join(root, "files", "user.txt"), "user bytes");
  const mirror = beginRestoreProjectFiles(store, dir);
  store.db.transaction(() => { store.restoreBusinessSnapshot(snapshot); mirror.apply(); }).immediate();
  mirror.finish();
  expect(readFileSync(join(mirror.archivePath, "original", project.id, "docs", `${obsolete.id}.md`), "utf8")).toContain("not in target snapshot");
  expect(existsSync(generated)).toBe(false);
  expect(readFileSync(unknown, "utf8")).toBe("user authored");
  expect(readFileSync(join(root, "files", "user.txt"), "utf8")).toBe("user bytes");
});

it("rewrites restored metadata/diagrams and creates target projects while preserving untracked files", () => {
  const target = fixture(), current = fixture();
  const snapshot = buildBusinessSnapshot(target.store);
  syncManagedProjectStorage(current.store, current.dir);
  const keep = join(current.root, "files", "private.txt"); writeFileSync(keep, "retain");
  const mirror = beginRestoreProjectFiles(current.store, current.dir);
  current.store.db.transaction(() => { current.store.restoreBusinessSnapshot(snapshot); mirror.apply(); }).immediate(); mirror.finish();
  const restoredRoot = join(current.dir, "projects", target.project.id);
  expect(JSON.parse(readFileSync(join(restoredRoot, "project.json"), "utf8")).name).toBe("Original");
  expect(JSON.parse(readFileSync(join(restoredRoot, "diagrams", `${target.store.listDiagrams(target.project.id)[0].id}.json`), "utf8")).projectId).toBe(target.project.id);
  expect(existsSync(join(restoredRoot, "files"))).toBe(true);
  expect(existsSync(join(current.root, "project.json"))).toBe(false);
  expect(readFileSync(keep, "utf8")).toBe("retain");
  expect(existsSync(join(mirror.archivePath, "original", current.project.id, "project.json"))).toBe(true);
});

it("rolls the database and exact original mirror back after a late failure and removes only created directories", () => {
  const current = fixture(), target = fixture(); syncManagedProjectStorage(current.store, current.dir);
  const original = readFileSync(join(current.root, "project.json"));
  const untouched = join(current.root, "docs", "notes.md"); writeFileSync(untouched, "outside generated set");
  const mirror = beginRestoreProjectFiles(current.store, current.dir);
  expect(() => current.store.db.transaction(() => {
    current.store.restoreBusinessSnapshot(buildBusinessSnapshot(target.store)); mirror.apply(); throw new Error("audit failure");
  }).immediate()).toThrow("audit failure");
  mirror.rollback();
  expect(current.store.getProject(current.project.id)).toBeTruthy();
  expect(readFileSync(join(current.root, "project.json"))).toEqual(original);
  expect(readFileSync(untouched, "utf8")).toBe("outside generated set");
  expect(existsSync(join(current.dir, "projects", target.project.id))).toBe(false);
  expect(existsSync(mirror.archivePath)).toBe(false);
});

it("rolls back after a partial export write fails without removing unrelated files", () => {
  const current = fixture(); syncManagedProjectStorage(current.store, current.dir);
  const snapshot = buildBusinessSnapshot(current.store);
  const original = readFileSync(join(current.root, "project.json"));
  const mirror = beginRestoreProjectFiles(current.store, current.dir);
  const originalRename = vi.mocked(fs.renameSync).getMockImplementation()!; let calls = 0;
  const failure = vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (++calls === 2) throw new Error("synthetic export disk failure");
    return originalRename(from, to);
  });
  try {
    expect(() => current.store.db.transaction(() => { current.store.restoreBusinessSnapshot(snapshot); mirror.apply(); }).immediate()).toThrow("synthetic export disk failure");
  } finally { failure.mockImplementation(originalRename); }
  mirror.rollback();
  expect(readFileSync(join(current.root, "project.json"))).toEqual(original);
  expect(current.store.getProject(current.project.id)).toBeTruthy();
});

it("archives an existing target generated path even if it was absent from the old database", () => {
  const current = fixture(), target = fixture();
  const path = join(current.dir, "projects", target.project.id, "project.json"); mkdirSync(join(current.dir, "projects", target.project.id), { recursive: true }); writeFileSync(path, "previous manual copy");
  const mirror = beginRestoreProjectFiles(current.store, current.dir);
  current.store.db.transaction(() => { current.store.restoreBusinessSnapshot(buildBusinessSnapshot(target.store)); mirror.apply(); }).immediate(); mirror.finish();
  expect(readFileSync(join(mirror.archivePath, "original", target.project.id, "project.json"), "utf8")).toBe("previous manual copy");
  expect(JSON.parse(readFileSync(path, "utf8")).id).toBe(target.project.id);
});

it("continues restoring other files when one rollback path fails and retains originals for retry", () => {
  const current = fixture(); syncManagedProjectStorage(current.store, current.dir);
  const metadata = join(current.root, "project.json"); writeFileSync(metadata, "original stale mirror metadata");
  const diagram = current.store.listDiagrams(current.project.id)[0];
  const blocked = join(current.root, "diagrams", `${diagram.id}.json`);
  const beforeDiagram = readFileSync(blocked);
  const mirror = beginRestoreProjectFiles(current.store, current.dir); mirror.apply();
  // An ordinary filesystem obstruction makes this path unwritable as a regular file.
  fs.unlinkSync(blocked); mkdirSync(blocked);
  expect(() => mirror.rollback()).toThrow(AggregateError);
  expect(readFileSync(metadata, "utf8")).toBe("original stale mirror metadata");
  expect(readFileSync(join(mirror.stagingPath, "original", current.project.id, "diagrams", `${diagram.id}.json`))).toEqual(beforeDiagram);
  fs.rmdirSync(blocked); mirror.rollback();
  expect(readFileSync(blocked)).toEqual(beforeDiagram);
  expect(existsSync(mirror.stagingPath)).toBe(false);
});

it("rejects non-regular managed export paths before replacing active mirror bytes", () => {
  const current = fixture(); syncManagedProjectStorage(current.store, current.dir);
  const path = join(current.root, "project.json"); fs.unlinkSync(path); mkdirSync(path);
  expect(() => beginRestoreProjectFiles(current.store, current.dir)).toThrow("regular files and directories");
  expect(current.store.getProject(current.project.id)).toBeTruthy();
});
