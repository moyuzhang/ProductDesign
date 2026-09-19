import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { managedProjectPath, syncManagedProject } from "./projectFiles.js";

describe("managed project storage", () => {
  it("copies legacy code folders without deleting them and writes to the immutable id folder", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pcs-managed-project-"));
    const store = new Store(join(dataDir, "test.db"));
    try {
      const project = store.insertProject({
        code: "LEGACY",
        name: "Legacy project",
        summary: "",
        stage: "探索",
        health: "正常",
        progress: 0,
        riskLevel: "P2",
        riskSummary: "",
        blockerSummary: "",
        nextStep: "",
        repositoryPath: "D:\\external\\legacy",
        startAt: "",
        dueAt: "",
      });
      const legacyRoot = join(dataDir, "projects", project.code);
      mkdirSync(join(legacyRoot, "docs"), { recursive: true });
      writeFileSync(join(legacyRoot, "docs", "legacy.md"), "legacy", "utf8");

      syncManagedProject(store, dataDir, project);

      const managedRoot = managedProjectPath(dataDir, project.id);
      expect(existsSync(join(managedRoot, "docs", "legacy.md"))).toBe(true);
      expect(existsSync(join(legacyRoot, "docs", "legacy.md"))).toBe(true);
      expect(JSON.parse(readFileSync(join(managedRoot, "project.json"), "utf8"))).toMatchObject({
        id: project.id,
        code: "LEGACY",
      });
      expect(existsSync(join(managedRoot, "diagrams", `${store.listDiagrams(project.id)[0].id}.json`))).toBe(true);

      const renamed = store.updateProject(project.id, { code: "RENAMED" })!;
      syncManagedProject(store, dataDir, renamed);
      expect(managedProjectPath(dataDir, renamed.id)).toBe(managedRoot);
      expect(JSON.parse(readFileSync(join(managedRoot, "project.json"), "utf8")).code).toBe("RENAMED");
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not follow an unsafe legacy project code outside the managed root", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pcs-managed-safe-"));
    const store = new Store(join(dataDir, "test.db"));
    try {
      const project = store.insertProject({
        code: "../outside",
        name: "Unsafe legacy code",
        summary: "",
        stage: "探索",
        health: "正常",
        progress: 0,
        riskLevel: "P2",
        riskSummary: "",
        blockerSummary: "",
        nextStep: "",
        repositoryPath: "",
        startAt: "",
        dueAt: "",
      });
      syncManagedProject(store, dataDir, project);
      expect(existsSync(join(managedProjectPath(dataDir, project.id), "project.json"))).toBe(true);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
