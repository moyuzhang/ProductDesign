import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, lstatSync, readFileSync, renameSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import type { DesignDoc, Project } from "../shared/types.js";
import type { Store } from "./db.js";

const PROJECT_DIRECTORIES = ["docs", "diagrams", "db-models", "plans", "evidence", "files"] as const;

export function managedProjectPath(dataDir: string, projectId: string): string {
  return join(resolve(dataDir), "projects", projectId);
}

function legacyProjectPath(dataDir: string, projectCode: string): string | null {
  const projectsRoot = resolve(dataDir, "projects");
  const candidate = resolve(projectsRoot, projectCode);
  return candidate.startsWith(`${projectsRoot}${sep}`) ? candidate : null;
}

function copyMissingFiles(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) copyMissingFiles(sourcePath, targetPath);
    else if (entry.isFile() && !existsSync(targetPath)) copyFileSync(sourcePath, targetPath);
  }
}

export function ensureManagedProjectDirectory(dataDir: string, project: Project): string {
  const root = managedProjectPath(dataDir, project.id);
  const legacy = legacyProjectPath(dataDir, project.code);
  if (legacy && legacy !== root && existsSync(legacy)) copyMissingFiles(legacy, root);
  mkdirSync(root, { recursive: true });
  for (const directory of PROJECT_DIRECTORIES) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "project.json"), projectJson(project), "utf8");
  return root;
}

function projectJson(project: Project): string {
  return JSON.stringify({
    storageVersion: 1,
    id: project.id,
    code: project.code,
    name: project.name,
    summary: project.summary,
    stage: project.stage,
    health: project.health,
    progress: project.progress,
    riskLevel: project.riskLevel,
    riskSummary: project.riskSummary,
    blockerSummary: project.blockerSummary,
    nextStep: project.nextStep,
    startAt: project.startAt,
    dueAt: project.dueAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }, null, 2);
}

export function materializeProjectJson(
  dataDir: string,
  projectId: string,
  type: "diagrams" | "db-models" | "plans" | "evidence",
  id: string,
  value: unknown,
): void {
  const directory = join(managedProjectPath(dataDir, projectId), type);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(value, null, 2), "utf8");
}

export function materializeProjectDocument(dataDir: string, projectId: string, doc: DesignDoc): void {
  const directory = join(managedProjectPath(dataDir, projectId), "docs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${doc.id}.md`), documentText(doc), "utf8");
}

function documentText(doc: DesignDoc): string {
  const frontMatter = [
    `id: ${doc.id}`,
    `projectId: ${doc.projectId}`,
    `currentRevisionId: ${doc.currentRevisionId}`,
    `category: ${doc.category}`,
    `status: ${doc.status}`,
    `version: ${doc.version}`,
    `author: ${doc.author}`,
    `sourceUrl: ${doc.sourceUrl}`,
    `summary: ${doc.summary}`,
    `updatedAt: ${doc.updatedAt}`,
  ].join("\n");
  return `---\n${frontMatter}\n---\n\n${doc.content ?? ""}\n`;
}

export function syncManagedProject(store: Store, dataDir: string, project: Project): void {
  ensureManagedProjectDirectory(dataDir, project);
  for (const plan of store.listPlans(project.id)) materializeProjectJson(dataDir, project.id, "plans", plan.id, plan);
  for (const evidence of store.listEvidence(project.id)) materializeProjectJson(dataDir, project.id, "evidence", evidence.id, evidence);
  for (const doc of store.listDesignDocs(project.id)) materializeProjectDocument(dataDir, project.id, doc);
  for (const model of store.listDatabaseModels(project.id)) materializeProjectJson(dataDir, project.id, "db-models", model.id, model);
  for (const diagram of store.listDiagrams(project.id)) materializeProjectJson(dataDir, project.id, "diagrams", diagram.id, diagram);
}

export function syncManagedProjectStorage(store: Store, dataDir: string): void {
  for (const project of store.listProjects()) syncManagedProject(store, dataDir, project);
}

/** A restore owns only exports named by the old or restored database, never files/ or unknown files. */
export interface RestoreProjectFiles {
  readonly archivePath: string;
  readonly stagingPath: string;
  apply(): void;
  rollback(): void;
  finish(): void;
}

function exportSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("Invalid managed export identifier");
  return value;
}

function projectExports(store: Store): Map<string, string> {
  const result = new Map<string, string>();
  for (const project of store.listProjects()) {
    const prefix = exportSegment(project.id);
    result.set(join(prefix, "project.json"), projectJson(project));
    for (const doc of store.listDesignDocs(project.id)) result.set(join(prefix, "docs", `${exportSegment(doc.id)}.md`), documentText(doc));
    for (const [type, values] of [
      ["plans", store.listPlans(project.id)], ["evidence", store.listEvidence(project.id)],
      ["db-models", store.listDatabaseModels(project.id)], ["diagrams", store.listDiagrams(project.id)],
    ] as const) for (const value of values) result.set(join(prefix, type, `${exportSegment(value.id)}.json`), JSON.stringify(value, null, 2));
  }
  return result;
}

// lstat every ancestor; missing components are allowed, symlinks and non-directory ancestors are not.
function inspectExportPath(path: string, file: boolean): boolean {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) inspectExportPath(parent, false);
  let info;
  try { info = lstatSync(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory())) throw new Error("Managed export path must contain only regular files and directories");
  return true;
}

/** Call begin inside the old DB transaction, apply after DB restore, rollback on transaction failure,
 * and finish only after commit. Original exported bytes remain in archivePath after success.
 * Crash/power-loss recovery is not claimed; failed rollback retains its recovery files for inspection.
 */
export function beginRestoreProjectFiles(store: Store, dataDir: string): RestoreProjectFiles {
  const root = resolve(dataDir);
  inspectExportPath(root, false);
  const projectsRoot = join(root, "projects");
  inspectExportPath(projectsRoot, false);
  const oldExports = projectExports(store);
  const originals = new Map<string, Buffer | null>();
  const capture = (relative: string) => {
    if (originals.has(relative)) return;
    const path = join(projectsRoot, relative);
    originals.set(relative, inspectExportPath(path, true) ? readFileSync(path) : null);
  };
  for (const relative of oldExports.keys()) capture(relative);
  const token = randomUUID();
  const stagingParent = join(root, ".project-restore-staging");
  const archiveParent = join(root, "project-restore-archives");
  inspectExportPath(stagingParent, false); inspectExportPath(archiveParent, false);
  mkdirSync(stagingParent, { recursive: true }); mkdirSync(archiveParent, { recursive: true });
  const staging = join(stagingParent, token), archivePath = join(archiveParent, token);
  mkdirSync(staging);
  const changed: string[] = [], createdDirectories: string[] = [];
  let state: "ready" | "applying" | "applied" | "rolledback" | "finished" = "ready";
  const saveOriginals = () => {
    for (const [relative, bytes] of originals) if (bytes !== null) {
      const path = join(staging, "original", relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    }
    writeFileSync(join(staging, "manifest.json"), JSON.stringify({ format: "productdesign.project-export-protection/1", files: [...originals].map(([path, bytes]) => ({ path, existed: bytes !== null })) }, null, 2));
  };
  try { saveOriginals(); } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  const ensureDirectory = (directory: string) => {
    if (inspectExportPath(directory, false)) return;
    const parent = dirname(directory); if (parent !== directory) ensureDirectory(parent);
    mkdirSync(directory); createdDirectories.push(directory);
  };
  return {
    archivePath,
    stagingPath: staging,
    apply() {
      if (state !== "ready") throw new Error("Project exports restore already applied");
      const target = projectExports(store);
      // Complete validation and protection capture before touching any active generated file.
      for (const relative of new Set([...oldExports.keys(), ...target.keys()])) {
        inspectExportPath(join(projectsRoot, relative), true); capture(relative);
      }
      saveOriginals();
      for (const [relative, content] of target) {
        const path = join(staging, "pending", relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8");
      }
      state = "applying";
      for (const relative of new Set([...oldExports.keys(), ...target.keys()])) {
        const path = join(projectsRoot, relative);
        inspectExportPath(path, true);
        if (target.has(relative)) {
          ensureDirectory(dirname(path));
          // Mark before the atomic rename so rollback also covers a failing mutation.
          changed.push(relative); renameSync(join(staging, "pending", relative), path);
        } else if (originals.get(relative) !== null) { changed.push(relative); unlinkSync(path); }
      }
      // Fresh target projects receive standard empty directories, but never a legacy-code copy.
      for (const project of store.listProjects()) for (const directory of PROJECT_DIRECTORIES) ensureDirectory(join(projectsRoot, exportSegment(project.id), directory));
      state = "applied";
    },
    rollback() {
      if (state === "finished") throw new Error("Committed project exports cannot be rolled back");
      if (state === "rolledback") return;
      const errors: unknown[] = [];
      for (const relative of [...changed].reverse()) {
        try {
          const path = join(projectsRoot, relative), bytes = originals.get(relative);
          inspectExportPath(path, true);
          if (bytes === null) { if (existsSync(path)) unlinkSync(path); }
          else if (bytes !== undefined) { ensureDirectory(dirname(path)); writeFileSync(path, bytes); }
        } catch (error) { errors.push(error); }
      }
      for (const directory of [...createdDirectories].reverse()) {
        try { inspectExportPath(directory, false); rmdirSync(directory); }
        catch (error) { if (!["ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) errors.push(error); }
      }
      // Keep the recovery manifest and original bytes if any rollback operation could not finish.
      if (errors.length) throw new AggregateError(errors, `Project export rollback incomplete; recovery files retained at ${staging}`);
      rmSync(staging, { recursive: true, force: true }); state = "rolledback";
    },
    finish() {
      if (state !== "applied") throw new Error("Project exports are not ready to commit");
      inspectExportPath(staging, false); inspectExportPath(archiveParent, false);
      // Keep original bytes and the manifest outside the active projects workspace.
      renameSync(staging, archivePath); state = "finished";
    },
  };
}
