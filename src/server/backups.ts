import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Backup, StorageRetentionSummary } from "../shared/types.js";
import { newId, nowIso, type Store } from "./db.js";

export function buildBusinessSnapshot(store: Store) {
  const projects = store.listProjects();
  return {
    exportedAt: nowIso(),
    projects,
    workNodes: Object.fromEntries(projects.map((project) => [project.id, store.listNodes(project.id)])),
    plans: Object.fromEntries(projects.map((project) => [project.id, store.listPlans(project.id)])),
    evidence: Object.fromEntries(projects.map((project) => [project.id, store.listEvidence(project.id)])),
    governance: store.listGovernance(),
    designDocs: Object.fromEntries(projects.map((project) => [project.id, store.listDesignDocs(project.id)])),
    documentRevisions: Object.fromEntries(projects.map((project) => [project.id, store.listDesignDocs(project.id).flatMap((doc) => store.listDocumentRevisions(doc.id))])),
    documentReferences: Object.fromEntries(projects.map((project) => [project.id, store.listDocumentReferences({ projectId: project.id })])),
    diagrams: Object.fromEntries(projects.map((project) => [project.id, store.listDiagrams(project.id)])),
    diagramRevisions: Object.fromEntries(projects.map((project) => [project.id, store.listDiagrams(project.id).flatMap((diagram) => store.listDiagramRevisions(diagram.id))])),
    databaseModels: Object.fromEntries(projects.map((project) => [project.id, store.listDatabaseModels(project.id)])),
    nodeDatabaseBindings: Object.fromEntries(projects.map((project) => [project.id, store.listNodeDatabaseBindings({ projectId: project.id })])),
  };
}

export function createBackupFile(store: Store, dataDir: string, label: string, reason: string): Backup & { path: string } {
  const snapshot = buildBusinessSnapshot(store);
  const itemCount = snapshot.projects.length
    + Object.values(snapshot.workNodes).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.plans).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.evidence).reduce((count, list) => count + list.length, 0)
    + snapshot.governance.length
    + Object.values(snapshot.designDocs).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.documentRevisions).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.documentReferences).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.diagrams).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.diagramRevisions).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.databaseModels).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.nodeDatabaseBindings).reduce((count, list) => count + list.length, 0);
  const backup: Backup = { id: newId(), label, reason, itemCount, createdAt: nowIso() };
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const path = join(backupDir, `backup-${backup.id}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf-8");
  store.insertBackup(backup);
  return { ...backup, path };
}

export function loadBackupFile(dataDir: string, backupId: string, createdAt?: string): unknown {
  const candidates = [
    join(dataDir, "backups", `backup-${backupId}.json`),
    ...(createdAt ? [join(dataDir, "backups", `backup-${createdAt.replace(/[:.]/g, "-")}.json`)] : []),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("备份文件不存在，无法恢复");
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function directoryStats(path: string): { count: number; bytes: number; oldestAt: string; newestAt: string } {
  if (!existsSync(path)) return { count: 0, bytes: 0, oldestAt: "", newestAt: "" };
  const files: Array<{ bytes: number; at: string }> = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const stat = statSync(child);
        files.push({ bytes: stat.size, at: stat.mtime.toISOString() });
      }
    }
  };
  visit(path);
  const times = files.map((file) => file.at).sort();
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    oldestAt: times[0] ?? "",
    newestAt: times.at(-1) ?? "",
  };
}

export function storageRetentionSummary(dataDir: string): StorageRetentionSummary {
  const policy = {
    maxBackupCount: 50,
    maxBackupBytes: 2 * 1024 * 1024 * 1024,
    maxBackupAgeDays: 90,
    maxExportBytes: 1024 * 1024 * 1024,
  };
  const backups = directoryStats(join(dataDir, "backups"));
  const exports = directoryStats(join(dataDir, "exports"));
  const oldestExpired = backups.oldestAt
    ? Date.now() - new Date(backups.oldestAt).getTime() > policy.maxBackupAgeDays * 86_400_000
    : false;
  return {
    backups: { ...backups, overLimit: backups.count > policy.maxBackupCount || backups.bytes > policy.maxBackupBytes || oldestExpired },
    exports: { ...exports, overLimit: exports.bytes > policy.maxExportBytes },
    policy,
  };
}
