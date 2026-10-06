import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Backup, BackupProtectionChallenge, BackupProtectionIssue, FreeformAsset, StorageRetentionSummary } from "../shared/types.js";
import { newId, nowIso, type Store } from "./db.js";

function captureBusinessSnapshot(store: Store, issues?: BackupProtectionIssue[]) {
  // A WAL reader must retain one SQLite snapshot across all business tables.
  return store.db.transaction(() => captureBusinessSnapshotRows(store, issues))();
}

function captureBusinessSnapshotRows(store: Store, issues?: BackupProtectionIssue[]) {
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
    ...store.snapshotDesignArtifacts(),
    freeformAssets: Object.fromEntries(projects.map((project) => [project.id, store.listFreeformAssets(project.id).map((asset) => {
      const { storagePath: _storagePath, ...metadata } = asset;
      const preservedLocation = issues ? { originalStoragePath: asset.storagePath } : {};
      let bytes: Buffer;
      try {
        // Validate the declared location even if the file is missing. Confirmation never expands read scope.
        const root = resolve(store.dataDir, "freeform-assets");
        assertManagedAssetPath(root, resolve(asset.storagePath));
        const realRoot = realpathSync(root);
        const realPath = realpathSync(asset.storagePath);
        assertManagedAssetPath(realRoot, realPath);
        bytes = readFileSync(realPath);
      } catch (error) {
        if (!issues || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        issues.push(assetIssue(asset, "missing", null));
        return { ...metadata, ...preservedLocation, contentBase64: null };
      }
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== asset.byteSize || actualSha256 !== asset.sha256) {
        if (!issues) throw new Error("素材文件不完整，无法备份");
        issues.push(assetIssue(asset, "corrupt", bytes));
      }
      // Corrupt bytes are preserved verbatim; expected metadata is never replaced by observed values.
      return { ...metadata, ...preservedLocation, contentBase64: bytes.toString("base64") };
    })])),
  };
}

function assertManagedAssetPath(root: string, path: string): void {
  const within = relative(root, path);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("素材不在受控存储目录，无法备份");
}

function assetIssue(asset: FreeformAsset, reason: BackupProtectionIssue["reason"], bytes: Buffer | null): BackupProtectionIssue {
  return { assetId: asset.id, projectId: asset.projectId, reason, expectedSha256: asset.sha256, expectedByteSize: asset.byteSize,
    actualSha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null, actualByteSize: bytes?.length ?? null };
}

export function buildBusinessSnapshot(store: Store) { return captureBusinessSnapshot(store); }

type BusinessSnapshot = ReturnType<typeof captureBusinessSnapshot>;
type ProtectionSnapshot = BusinessSnapshot & { protectionManifest?: { kind: "productdesign.partial-protection/1"; restorable: false; issues: BackupProtectionIssue[] } };

function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** No filesystem or database writes: the caller must obtain a bound second confirmation when issues exist. */
export function prepareRestoreProtection(store: Store, targetId: string, target: unknown): { snapshot: ProtectionSnapshot; challenge: BackupProtectionChallenge } {
  store.validateBusinessSnapshot(target);
  const issues: BackupProtectionIssue[] = [];
  const snapshot: ProtectionSnapshot = captureBusinessSnapshot(store, issues);
  if (issues.length) snapshot.protectionManifest = { kind: "productdesign.partial-protection/1", restorable: false, issues };
  const { exportedAt: _exportedAt, ...current } = snapshot;
  return { snapshot, challenge: { sourceFingerprint: fingerprint(current), targetFingerprint: fingerprint({ targetId, target }), issues } };
}

export function createRestoreProtectionFile(store: Store, dataDir: string, snapshot: ProtectionSnapshot, targetLabel: string): Backup & { path: string } {
  const partial = Boolean(snapshot.protectionManifest);
  return writeBackupFile(store, dataDir, snapshot,
    `${partial ? "部分保护快照（不可直接恢复）" : "恢复前自动备份"} ${nowIso().slice(0, 19)}`,
    `恢复备份 ${targetLabel} 前保全当前业务资料。${partial ? "当前素材缺失或损坏；已保留可读原始字节及缺损清单，此文件不能直接恢复。" : "完整业务快照。"}`);
}

export function createBackupFile(store: Store, dataDir: string, label: string, reason: string): Backup & { path: string } {
  // Reserve the writer before capture: upgrading a stale WAL read snapshot can fail.
  let created: (Backup & { path: string }) | undefined;
  try {
    return store.db.transaction(() => {
      created = writeBackupFile(store, dataDir, buildBusinessSnapshot(store), label, reason);
      return created;
    }).immediate();
  } catch (error) {
    if (created) rmSync(created.path, { force: true });
    throw error;
  }
}

function writeBackupFile(store: Store, dataDir: string, snapshot: ProtectionSnapshot, label: string, reason: string): Backup & { path: string } {
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
    + Object.values(snapshot.nodeDatabaseBindings).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.prototypeDrafts).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.freeformDocuments).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.diagramTemplates).reduce((count, list) => count + list.length, 0)
    + Object.values(snapshot.freeformAssets).reduce((count, list) => count + list.length, 0);
  const backup: Backup = { id: newId(), label, reason, itemCount, createdAt: nowIso() };
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const path = join(backupDir, `backup-${backup.id}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), { encoding: "utf-8", flag: "wx" });
  try { store.insertBackup(backup); }
  catch (error) { rmSync(path, { force: true }); throw error; }
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
