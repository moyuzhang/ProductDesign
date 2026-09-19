import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
  writeFileSync(join(root, "project.json"), JSON.stringify({
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
  }, null, 2), "utf8");
  return root;
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
  writeFileSync(join(directory, `${doc.id}.md`), `---\n${frontMatter}\n---\n\n${doc.content ?? ""}\n`, "utf8");
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
