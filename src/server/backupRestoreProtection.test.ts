import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "./index.js";
import { buildBusinessSnapshot, createBackupFile, loadBackupFile } from "./backups.js";
import { Store } from "./db.js";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { BackupProtectionChallenge } from "../shared/types.js";

const { failProtectionWrite } = vi.hoisted(() => ({ failProtectionWrite: { enabled: false } }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (failProtectionWrite.enabled && String(args[0]).includes("backup-")) throw Object.assign(new Error("synthetic protection file write failure"), { code: "EIO" });
    return actual.writeFileSync(...args);
  } };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { failProtectionWrite.enabled = false; vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-restore-protection-"));
  const dbPath = join(dir, "business.db"); const store = new Store(dbPath, dir);
  const project = store.insertProject({ code: "RESTORE", name: "At backup", summary: "", stage: "规划", health: "正常", progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "" });
  const root = join(dir, "freeform-assets", project.id); mkdirSync(root, { recursive: true });
  const path = join(root, "asset.bin"); const bytes = Buffer.from("original synthetic asset"); writeFileSync(path, bytes);
  const asset = store.insertFreeformAsset({ id: "fixture-asset", projectId: project.id, mime: "image/png", sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, width: 1, height: 1, storagePath: path, createdAt: "2026-10-02T00:00:00.000Z" });
  const backup = createBackupFile(store, dir, "Complete target", "synthetic fixture");
  store.updateProject(project.id, { name: "Current unsaved-to-target work" });
  const app = buildApp({ dbPath, dataDir: dir }); await app.ready();
  cleanup.push(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const restore = (protection?: BackupProtectionChallenge, backupId = backup.id) => app.inject({ method: "POST", url: `/api/backups/${backupId}/restore`, payload: { confirmation: `RESTORE ${backupId}`,
    ...(protection ? { protectionConfirmation: { sourceFingerprint: protection.sourceFingerprint, targetFingerprint: protection.targetFingerprint, acknowledgement: "PARTIAL_PROTECTION_IS_NOT_RESTORABLE" } } : {}) } });
  return { dir, store, app, asset, backup, project, bytes, path, restore };
}
it("restores an intact target with a complete protection backup when current assets are healthy", async () => {
  const f = await fixture(); const response = await f.restore();
  expect(response.statusCode, response.body).toBe(200); expect(response.json().partialProtection).toBe(false);
  expect(f.store.getProject(f.project.id)?.name).toBe("At backup");
  const protectedSnapshot = loadBackupFile(f.dir, response.json().protectionBackup.id) as { projects: Array<{ name: string }>; protectionManifest?: unknown };
  expect(protectedSnapshot.projects[0].name).toBe("Current unsaved-to-target work"); expect(protectedSnapshot.protectionManifest).toBeUndefined();
  expect(readFileSync(f.store.getFreeformAsset(f.asset.id)!.storagePath)).toEqual(f.bytes);
});
it.each(["missing", "corrupt"] as const)("requires a fresh bound second confirmation for %s current assets, preserves evidence and restores original bytes", async (reason) => {
  const f = await fixture(); const damaged = Buffer.from("damaged but recoverable bytes");
  if (reason === "missing") rmSync(f.path); else writeFileSync(f.path, damaged);
  const before = f.store.listBackups().length;
  const first = await f.restore(); expect(first.statusCode, first.body).toBe(409);
  const challenge = first.json().protection as BackupProtectionChallenge;
  expect(challenge.issues[0]).toMatchObject({ assetId: f.asset.id, reason, expectedSha256: f.asset.sha256 });
  expect(f.store.getProject(f.project.id)?.name).toBe("Current unsaved-to-target work"); expect(f.store.listBackups()).toHaveLength(before);
  expect((await f.restore()).statusCode).toBe(409);
  expect(() => createBackupFile(f.store, f.dir, "manual strict", "test")).toThrow();
  const second = await f.restore(challenge); expect(second.statusCode, second.body).toBe(200);
  expect(second.json().partialProtection).toBe(true);
  const protectedSnapshot = loadBackupFile(f.dir, second.json().protectionBackup.id) as ReturnType<typeof buildBusinessSnapshot> & { protectionManifest: { restorable: boolean; issues: BackupProtectionChallenge["issues"] } };
  expect(protectedSnapshot.protectionManifest.restorable).toBe(false);
  expect(protectedSnapshot.projects[0].name).toBe("Current unsaved-to-target work");
  const protectedAsset = protectedSnapshot.freeformAssets[f.project.id][0];
  expect(protectedAsset.contentBase64).toBe(reason === "missing" ? null : damaged.toString("base64"));
  expect(protectedSnapshot.protectionManifest.issues[0].actualByteSize).toBe(reason === "missing" ? null : damaged.length);
  expect(f.store.getProject(f.project.id)?.name).toBe("At backup");
  expect(readFileSync(f.store.getFreeformAsset(f.asset.id)!.storagePath)).toEqual(f.bytes);
  if (reason === "corrupt") expect(readFileSync(f.path)).toEqual(damaged);
  const count = f.store.listBackups().length;
  const partialRestore = await f.restore(undefined, second.json().protectionBackup.id);
  expect(partialRestore.statusCode).toBe(400); expect(partialRestore.body).toContain("不可直接恢复");
  expect(f.store.listBackups()).toHaveLength(count); expect(f.store.getProject(f.project.id)?.name).toBe("At backup");
});
it.each(["source", "target"] as const)("rejects an old confirmation after %s data changes", async (side) => {
  const f = await fixture(); rmSync(f.path);
  const challenge = (await f.restore()).json().protection as BackupProtectionChallenge;
  if (side === "source") f.store.updateProject(f.project.id, { name: "Changed after review" });
  else { const target = JSON.parse(readFileSync(f.backup.path, "utf8")); target.projects[0].name = "Target changed after review"; writeFileSync(f.backup.path, JSON.stringify(target)); }
  const response = await f.restore(challenge); expect(response.statusCode).toBe(409); expect(response.body).toContain("已变化");
  expect(f.store.getProject(f.project.id)?.name).toBe(side === "source" ? "Changed after review" : "Current unsaved-to-target work");
  expect(f.store.listBackups()).toHaveLength(1);
});
it("keeps current business data unchanged if registering the protection package fails", async () => {
  const f = await fixture(); rmSync(f.path); const challenge = (await f.restore()).json().protection;
  // Ordinary catalog failure after the protection file was written.
  const original = f.store.getProject(f.project.id);
  vi.spyOn(Store.prototype, "insertBackup").mockImplementationOnce(() => { throw new Error("synthetic disk/catalog write failure"); });
  const response = await f.restore(challenge); expect(response.statusCode).toBe(500);
  expect(f.store.getProject(f.project.id)).toEqual(original); expect(f.store.listBackups()).toHaveLength(1);
});
it("prevalidates incomplete target assets before any protection backup or business write", async () => {
  const f = await fixture(); const target = JSON.parse(readFileSync(f.backup.path, "utf8"));
  target.freeformAssets[f.project.id][0].contentBase64 = Buffer.from("truncated").toString("base64"); writeFileSync(f.backup.path, JSON.stringify(target));
  const response = await f.restore(); expect(response.statusCode).toBe(400); expect(f.store.listBackups()).toHaveLength(1);
  expect(f.store.getProject(f.project.id)?.name).toBe("Current unsaved-to-target work");
});
it("holds the SQLite write transaction throughout fresh capture, protection registration and restore", async () => {
  const f = await fixture(); const original = Store.prototype.validateBusinessSnapshot;
  const observed: boolean[] = [];
  vi.spyOn(Store.prototype, "validateBusinessSnapshot").mockImplementation(function (this: Store, snapshot) { observed.push(this.db.inTransaction); return original.call(this, snapshot); });
  const insert = Store.prototype.insertBackup;
  vi.spyOn(Store.prototype, "insertBackup").mockImplementation(function (this: Store, backup) { observed.push(this.db.inTransaction); return insert.call(this, backup); });
  expect((await f.restore()).statusCode).toBe(200); expect(observed).toEqual([true, true]);
});

it("does not restore or register a protection record when writing the protection file fails", async () => {
  const f = await fixture(); rmSync(f.path); const challenge = (await f.restore()).json().protection;
  const beforeFiles = readdirSync(join(f.dir, "backups")); failProtectionWrite.enabled = true;
  const response = await f.restore(challenge); expect(response.statusCode).toBe(500);
  expect(f.store.getProject(f.project.id)?.name).toBe("Current unsaved-to-target work");
  expect(f.store.listBackups()).toHaveLength(1); expect(readdirSync(join(f.dir, "backups"))).toEqual(beforeFiles);
});
