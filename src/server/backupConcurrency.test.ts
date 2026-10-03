import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildApp } from "./index.js";
import { syncManagedProjectStorage } from "./projectFiles.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CodexHarness } from "./agentHarness.js";
import { Store } from "./db.js";
import { buildBusinessSnapshot, createBackupFile, loadBackupFile } from "./backups.js";
import { registerFullTools } from "../mcp/fullTools.js";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-backup-concurrency-"));
  const path = join(dir, "test.db");
  const store = new Store(path, dir), writer = new Store(path, dir);
  writer.db.pragma("busy_timeout = 0");
  cleanups.push(() => { writer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.insertProject({ code: "CONCURRENT", name: "Before", summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  const diagram = store.listDiagrams(project.id)[0]; store.updateDiagram(diagram.id, { title: "Before" });
  return { dir, store, writer, project, diagram };
}
function handlers(store: Store, dataDir: string) {
  // Service handler unit test, not an authenticated transport acceptance test.
  const callbacks = new Map<string, (args: any) => any>();
  const server = { registerTool: (name: string, _schema: unknown, callback: (args: any) => any) => callbacks.set(name, callback) } as unknown as McpServer;
  registerFullTools(server, { store, dataDir, harness: {} as CodexHarness });
  return callbacks;
}
it.each(["snapshot", "backup"])("%s cannot mix project and diagram versions across SQLite connections", (mode) => {
  const f = fixture(); const original = f.store.listProjects.bind(f.store);
  vi.spyOn(f.store, "listProjects").mockImplementationOnce(() => {
    const rows = original();
    try { f.writer.db.transaction(() => { f.writer.updateProject(f.project.id, { name: "After" }); f.writer.updateDiagram(f.diagram.id, { title: "After" }); }).immediate(); }
    catch (error) { expect((error as { code: string }).code).toBe("SQLITE_BUSY"); }
    return rows;
  });
  const snapshot = mode === "snapshot" ? buildBusinessSnapshot(f.store) : loadBackupFile(f.dir, createBackupFile(f.store, f.dir, "Concurrent", "test").id) as ReturnType<typeof buildBusinessSnapshot>;
  expect(snapshot.projects[0].name).toBe(snapshot.diagrams[f.project.id][0].title);
  f.writer.updateProject(f.project.id, { summary: "writer released" });
  expect(f.store.getProject(f.project.id)?.summary).toBe("writer released");
});
it("MCP restore excludes a second writer between protection capture and replacement", () => {
  const f = fixture(); const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" });
  const original = f.store.restoreBusinessSnapshot.bind(f.store); let writerBlocked = false;
  vi.spyOn(f.store, "restoreBusinessSnapshot").mockImplementation((snapshot) => {
    try { f.writer.updateProject(f.project.id, { name: "Lost intervening write" }); }
    catch (error) { expect((error as { code: string }).code).toBe("SQLITE_BUSY"); writerBlocked = true; }
    return original(snapshot);
  });
  const result = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
  expect(result.isError).not.toBe(true); expect(writerBlocked).toBe(true);
  expect(f.store.getProject(f.project.id)?.name).toBe("Before");
  const protection = f.store.listBackups().find((backup) => backup.id !== target.id)!;
  expect((loadBackupFile(f.dir, protection.id) as ReturnType<typeof buildBusinessSnapshot>).projects[0].name).toBe("Current");
  f.writer.updateProject(f.project.id, { summary: "writer released" });
});
it("failed MCP restore rolls back its protection catalog and removes its new protection file", () => {
  const f = fixture(); const target = createBackupFile(f.store, f.dir, "Target", "test");
  const before = readdirSync(join(f.dir, "backups"));
  vi.spyOn(f.store, "restoreBusinessSnapshot").mockImplementation(() => { throw new Error("synthetic restore failure"); });
  const result = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
  expect(result.isError).toBe(true); expect(f.store.listBackups()).toHaveLength(1);
  expect(readdirSync(join(f.dir, "backups"))).toEqual(before);
});

it("failed backup catalog write removes its file, leaves business data and releases the writer", () => {
  const f = fixture();
  vi.spyOn(f.store, "insertBackup").mockImplementation(() => { throw new Error("synthetic catalog failure"); });
  expect(() => createBackupFile(f.store, f.dir, "Failure", "test")).toThrow("synthetic catalog failure");
  expect(readdirSync(join(f.dir, "backups"))).toEqual([]);
  expect(f.store.listBackups()).toEqual([]);
  expect(f.store.getProject(f.project.id)?.name).toBe("Before");
  f.writer.updateProject(f.project.id, { summary: "writer released" });
});
it("MCP protection write failure preserves current business and releases the writer", () => {
  const f = fixture(); const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" });
  const before = readdirSync(join(f.dir, "backups"));
  vi.spyOn(f.store, "insertBackup").mockImplementation(() => { throw new Error("synthetic protection catalog failure"); });
  const result = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
  expect(result.isError).toBe(true);
  expect(f.store.getProject(f.project.id)?.name).toBe("Current");
  expect(f.store.listBackups()).toHaveLength(1);
  expect(readdirSync(join(f.dir, "backups"))).toEqual(before);
  f.writer.updateProject(f.project.id, { summary: "writer released" });
});

it.each(["REST", "MCP"])("%s audit failure rolls back restored data and removes only newly staged files", async (transport) => {
  const f = fixture();
  const assetRoot = join(f.dir, "freeform-assets"); mkdirSync(assetRoot);
  const storagePath = join(assetRoot, "original.bin"); const bytes = Buffer.from("synthetic preserved asset"); writeFileSync(storagePath, bytes);
  f.store.insertFreeformAsset({ id: "asset", projectId: f.project.id, mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, storagePath, width: 1, height: 1, createdAt: "2026-10-02T00:00:00Z" });
  const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" });
  syncManagedProjectStorage(f.store, f.dir);
  const projectPath = join(f.dir, "projects", f.project.id, "project.json");
  const mirrorBefore = readFileSync(projectPath);
  const backupsBefore = readdirSync(join(f.dir, "backups"));
  const originalAudit = Store.prototype.recordAudit;
  vi.spyOn(Store.prototype, "recordAudit").mockImplementation(function (this: Store, event) {
    if (event.entityType === "backup" && event.action === "restore") throw new Error("synthetic final audit failure");
    return originalAudit.call(this, event);
  });
  if (transport === "MCP") {
    const result = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
    expect(result.isError).toBe(true);
  } else {
    const app = buildApp({ dbPath: join(f.dir, "test.db"), dataDir: f.dir });
    cleanups.push(() => app.close()); await app.ready();
    const response = await app.inject({ method: "POST", url: `/api/backups/${target.id}/restore`, payload: { confirmation: `RESTORE ${target.id}` } });
    expect(response.statusCode).toBe(500);
  }
  expect(f.store.getProject(f.project.id)?.name).toBe("Current");
  expect(f.store.getFreeformAsset("asset")?.storagePath).toBe(storagePath);
  expect(readFileSync(storagePath)).toEqual(bytes);
  expect(readdirSync(assetRoot)).toEqual(["original.bin"]);
  expect(readdirSync(join(f.dir, "backups"))).toEqual(backupsBefore);
  expect(f.store.listBackups()).toHaveLength(1);
  expect(readFileSync(projectPath)).toEqual(mirrorBefore);
  f.writer.updateProject(f.project.id, { summary: "writer released" });
});
it("MCP response serialization failure cannot remove files referenced by an already committed restore", () => {
  const f = fixture();
  const root = join(f.dir, "freeform-assets"); mkdirSync(root);
  const storagePath = join(root, "original.bin"); const bytes = Buffer.from("synthetic asset"); writeFileSync(storagePath, bytes);
  f.store.insertFreeformAsset({ id: "asset", projectId: f.project.id, mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, storagePath, width: 1, height: 1, createdAt: "2026-10-02T00:00:00Z" });
  const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" });
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    if (value?.ok === true && value.backup && value.restored) throw new Error("synthetic response failure after commit");
    return stringify(value, replacer as any, space);
  });
  const response = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
  expect(response.isError).toBe(true);
  expect(f.store.getProject(f.project.id)?.name).toBe("Before");
  const restoredPath = f.store.getFreeformAsset("asset")!.storagePath;
  expect(restoredPath).not.toBe(storagePath);
  expect(readFileSync(restoredPath)).toEqual(bytes);
  expect(readFileSync(storagePath)).toEqual(bytes);
  expect(f.store.listBackups()).toHaveLength(2);
  expect(readdirSync(join(f.dir, "backups"))).toHaveLength(2);
});

it.each(["REST", "MCP"])("%s successful restore refreshes managed files read by external harnesses", async (transport) => {
  const f = fixture(); syncManagedProjectStorage(f.store, f.dir);
  const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" });
  f.store.updateDiagram(f.diagram.id, { title: "Current" });
  syncManagedProjectStorage(f.store, f.dir);
  const projectPath = join(f.dir, "projects", f.project.id, "project.json");
  const diagramPath = join(f.dir, "projects", f.project.id, "diagrams", `${f.diagram.id}.json`);
  expect(JSON.parse(readFileSync(projectPath, "utf8")).name).toBe("Current");
  if (transport === "MCP") {
    const response = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
    expect(response.isError).not.toBe(true);
  } else {
    const app = buildApp({ dbPath: join(f.dir, "test.db"), dataDir: f.dir });
    cleanups.push(() => app.close()); await app.ready();
    const response = await app.inject({ method: "POST", url: `/api/backups/${target.id}/restore`, payload: { confirmation: `RESTORE ${target.id}` } });
    expect(response.statusCode).toBe(200);
  }
  expect(f.store.getProject(f.project.id)?.name).toBe("Before");
  expect(JSON.parse(readFileSync(projectPath, "utf8")).name).toBe("Before");
  expect(JSON.parse(readFileSync(diagramPath, "utf8")).title).toBe("Before");
});
it.each(["REST", "MCP"])("%s archive failure after commit returns success with recoverable staging warning", async (transport) => {
  const f = fixture(); syncManagedProjectStorage(f.store, f.dir);
  const target = createBackupFile(f.store, f.dir, "Target", "test");
  f.store.updateProject(f.project.id, { name: "Current" }); syncManagedProjectStorage(f.store, f.dir);
  const audit = Store.prototype.recordAudit;
  vi.spyOn(Store.prototype, "recordAudit").mockImplementation(function (this: Store, event) {
    const result = audit.call(this, event);
    if (event.entityType === "backup" && event.action === "restore") {
      // Real filesystem fault, after active mirror update and before post-commit archive rename.
      const archiveParent = join(f.dir, "project-restore-archives");
      rmSync(archiveParent, { recursive: true }); writeFileSync(archiveParent, "synthetic archive blocker");
    }
    return result;
  });
  let payload: { ok: boolean; warnings: string[] };
  if (transport === "MCP") {
    const response = handlers(f.store, f.dir).get("restore_backup")!({ backupId: target.id, confirmation: `RESTORE ${target.id}` });
    expect(response.isError).not.toBe(true);
    const text = response.content[0].text as string;
    payload = JSON.parse(text.slice(text.indexOf("\n") + 1));
  } else {
    const app = buildApp({ dbPath: join(f.dir, "test.db"), dataDir: f.dir });
    cleanups.push(() => app.close()); await app.ready();
    const response = await app.inject({ method: "POST", url: `/api/backups/${target.id}/restore`, payload: { confirmation: `RESTORE ${target.id}` } });
    expect(response.statusCode).toBe(200); payload = response.json();
  }
  expect(payload.ok).toBe(true); expect(payload.warnings).toHaveLength(1);
  const stagingRoot = join(f.dir, ".project-restore-staging");
  const stagingPath = join(stagingRoot, readdirSync(stagingRoot)[0]);
  expect(payload.warnings[0]).toContain(stagingPath);
  expect(payload.warnings[0]).toContain("已恢复");
  expect(f.store.getProject(f.project.id)?.name).toBe("Before");
  expect(JSON.parse(readFileSync(join(f.dir, "projects", f.project.id, "project.json"), "utf8")).name).toBe("Before");
  expect(JSON.parse(readFileSync(join(stagingPath, "original", f.project.id, "project.json"), "utf8")).name).toBe("Current");
  expect(f.store.listBackups()).toHaveLength(2);
});
