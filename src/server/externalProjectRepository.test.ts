import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgentTaskLeaseSchema } from "./agentTaskLeases.js";
import { ensureCoordinationLeaseSchema } from "./coordinationLeases.js";
import { ProjectRepositoryError, Store } from "./db.js";

const resources: Array<{ store: Store; dir: string }> = [];

afterEach(() => {
  const current = resources.splice(0);
  for (const { store } of current) {
    if (store.db.open) store.close();
  }
  for (const dir of new Set(current.map((resource) => resource.dir))) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pcs-external-project-"));
  const path = join(dir, "test.db");
  const store = new Store(path);
  resources.push({ store, dir });
  return { store, dir, path };
}

function projectInput(overrides: Partial<Parameters<Store["insertProject"]>[0]> = {}): Parameters<Store["insertProject"]>[0] {
  return {
    code: "EXTERNAL", name: "External repository", summary: "", stage: "探索", health: "正常",
    progress: 0, riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "",
    repositoryPath: "", startAt: "", dueAt: "", ...overrides,
  };
}

function taskLease(store: Store, projectId: string, status = "claimed", expiresAt = "2999-01-01T00:00:00.000Z") {
  ensureAgentTaskLeaseSchema(store);
  const id = `lease-${projectId}`;
  store.db.prepare(`INSERT INTO agent_task_leases (
    id, task_key, task_id, task_revision, project_id, queue, role, action_code, status,
    lease_token, agent_id, lease_expires_at, claimed_at, heartbeat_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'implementation', 'builder', 'implement_plan', ?, ?, 'builder', ?, ?, ?, ?)`)
    .run(id, `key-${projectId}`, `task-${projectId}`, "revision-1", projectId, status, `token-${projectId}`,
      expiresAt, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function coordinationLease(store: Store, projectId: string, status: string, expiresAt = "2999-01-01T00:00:00.000Z") {
  ensureCoordinationLeaseSchema(store);
  store.db.prepare(`INSERT INTO agent_coordination_leases (
    id, project_id, main_agent_id, worker_id, status, stage, lease_token, lease_expires_at,
    heartbeat_at, created_at, updated_at
  ) VALUES (?, ?, 'main', 'worker', ?, 'implementation', ?, ?, ?, ?, ?)`)
    .run(`coordination-${projectId}`, projectId, status, `coordination-token-${projectId}`, expiresAt,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

describe("project external repository identity", () => {
  it("defaults new projects to local-compatible empty identity", () => {
    const { store } = fixture();
    const project = store.insertProject(projectInput({ repositoryPath: "/local/repository" }));
    expect(project.externalRepositoryId).toBe("");
    expect(store.getProject(project.id)?.externalRepositoryId).toBe("");
    expect(store.db.prepare("SELECT external_repository_id FROM projects WHERE id=?").get(project.id))
      .toEqual({ external_repository_id: "" });
    expect(store.updateProject(project.id, { summary: "local compatible" })?.repositoryPath).toBe("/local/repository");
  });

  it("persists inserted and updated opaque identities across restart without resolving them", () => {
    const { store, dir, path } = fixture();
    const project = store.insertProject(projectInput({ externalRepositoryId: "github:team/repository" }));
    // This deliberately unreachable URL-shaped label must remain plain data.
    const identity = "https://unreachable.invalid/team/repository";
    expect(store.updateProject(project.id, { externalRepositoryId: identity })?.externalRepositoryId).toBe(identity);
    store.close();
    const restarted = new Store(path);
    resources.push({ store: restarted, dir });
    expect(restarted.getProject(project.id)).toMatchObject({ repositoryPath: "", externalRepositoryId: identity });
    expect(restarted.listProjects()[0].externalRepositoryId).toBe(identity);
    expect(restarted.getProjectWorkspace(project.id)?.project.externalRepositoryId).toBe(identity);
  });

  it("migrates legacy project rows once while retaining their local repository", () => {
    const { store, dir, path } = fixture();
    const project = store.insertProject(projectInput({ repositoryPath: "/legacy/repository" }));
    store.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE projects DROP COLUMN external_repository_id");
    legacy.close();
    const migrated = new Store(path);
    resources.push({ store: migrated, dir });
    expect(migrated.getProject(project.id)).toMatchObject({ repositoryPath: "/legacy/repository", externalRepositoryId: "" });
    migrated.updateProject(project.id, { repositoryPath: "", externalRepositoryId: "provider:repo-1" });
    migrated.close();
    const restarted = new Store(path);
    resources.push({ store: restarted, dir });
    expect(restarted.getProject(project.id)?.externalRepositoryId).toBe("provider:repo-1");
  });

  it("rejects conflicting local and external modes without partially inserting or updating", () => {
    const { store } = fixture();
    expect(() => store.insertProject(projectInput({ repositoryPath: "/local/repository", externalRepositoryId: "repo:one" })))
      .toThrowError(ProjectRepositoryError);
    expect(store.listProjects()).toHaveLength(0);
    const project = store.insertProject(projectInput({ repositoryPath: "/local/repository" }));
    expect(() => store.updateProject(project.id, { externalRepositoryId: "repo:one", name: "should not change" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_MODE_CONFLICT", statusCode: 400 }));
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.updateProject(project.id, { repositoryPath: "", externalRepositoryId: "repo:one" }))
      .toMatchObject({ repositoryPath: "", externalRepositoryId: "repo:one" });
    const external = store.getProject(project.id);
    expect(() => store.updateProject(project.id, { repositoryPath: "/other/repository" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_MODE_CONFLICT" }));
    expect(store.getProject(project.id)).toEqual(external);
    expect(store.updateProject(project.id, { repositoryPath: "/other/repository", externalRepositoryId: "" }))
      .toMatchObject({ repositoryPath: "/other/repository", externalRepositoryId: "" });
  });

  it.each(["claimed", "running"])("rejects identity changes atomically during %s task leases, but permits exact no-ops", (status) => {
    const { store } = fixture();
    const project = store.insertProject(projectInput({ externalRepositoryId: "repo:one" }));
    taskLease(store, project.id, status);
    for (const patch of [
      { externalRepositoryId: "repo:two", name: "should not change" },
      { externalRepositoryId: "" },
      { externalRepositoryId: "", repositoryPath: "/local/repository" },
    ]) {
      expect(() => store.updateProject(project.id, patch))
        .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_ACTIVE_LEASE", statusCode: 409 }));
      expect(store.getProject(project.id)).toEqual(project);
    }
    expect(store.updateProject(project.id, { externalRepositoryId: "repo:one", repositoryPath: "", summary: "allowed" }))
      .toMatchObject({ externalRepositoryId: "repo:one", summary: "allowed" });
  });

  it("protects local repository path changes too, while allowing updates to other projects", () => {
    const { store } = fixture();
    const project = store.insertProject(projectInput({ repositoryPath: "/local/one" }));
    taskLease(store, project.id);
    expect(() => store.updateProject(project.id, { repositoryPath: "/local/two" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_ACTIVE_LEASE" }));
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.updateProject(project.id, { repositoryPath: "/local/one", name: "allowed" })?.name).toBe("allowed");
    const other = store.insertProject(projectInput({ code: "OTHER" }));
    expect(store.updateProject(other.id, { externalRepositoryId: "repo:other" })?.externalRepositoryId).toBe("repo:other");
  });

  it.each(["active", "paused"])("protects repository identity during %s coordination leases", (status) => {
    const { store } = fixture();
    const project = store.insertProject(projectInput());
    coordinationLease(store, project.id, status);
    expect(() => store.updateProject(project.id, { externalRepositoryId: "repo:one" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_ACTIVE_LEASE" }));
    expect(store.getProject(project.id)).toEqual(project);
    expect(store.updateProject(project.id, { externalRepositoryId: "", summary: "allowed" })?.summary).toBe("allowed");
  });

  it.each(["completed", "released", "failed", "expired"])("does not treat %s task leases as active", (status) => {
    const { store } = fixture();
    const project = store.insertProject(projectInput());
    taskLease(store, project.id, status === "expired" ? "running" : status,
      status === "expired" ? "2000-01-01T00:00:00.000Z" : undefined);
    expect(store.updateProject(project.id, { externalRepositoryId: "repo:one" })?.externalRepositoryId).toBe("repo:one");
  });

  it.each(["released", "expired"])("does not treat %s coordination leases as active", (status) => {
    const { store } = fixture();
    const project = store.insertProject(projectInput());
    coordinationLease(store, project.id, status === "expired" ? "active" : status,
      status === "expired" ? "2000-01-01T00:00:00.000Z" : undefined);
    expect(store.updateProject(project.id, { externalRepositoryId: "repo:one" })?.externalRepositoryId).toBe("repo:one");
  });

  it("bounds and validates opaque identifiers at the storage boundary", () => {
    const { store } = fixture();
    const project = store.insertProject(projectInput());
    for (const identity of ["a".repeat(501), "repo id", "repo\nidentity", "repo\u0000identity", "repo?secret=value", "../repo", null]) {
      expect(() => store.updateProject(project.id, { externalRepositoryId: identity as string }))
        .toThrowError(expect.objectContaining({ code: "EXTERNAL_REPOSITORY_ID_INVALID", statusCode: 400 }));
      expect(store.getProject(project.id)).toEqual(project);
    }
    expect(store.updateProject(project.id, { externalRepositoryId: "a".repeat(500) })?.externalRepositoryId).toHaveLength(500);
    expect(store.updateProject(project.id, { externalRepositoryId: "  provider:team/repo_1@revision  " })?.externalRepositoryId)
      .toBe("provider:team/repo_1@revision");
  });

  it("reads current leases from another connection before accepting an identity update", () => {
    const { store, dir, path } = fixture();
    const project = store.insertProject(projectInput());
    const other = new Store(path);
    resources.push({ store: other, dir });
    taskLease(other, project.id);
    expect(() => store.updateProject(project.id, { externalRepositoryId: "repo:one" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_REPOSITORY_ACTIVE_LEASE" }));
    expect(other.getProject(project.id)).toEqual(project);
  });
});
