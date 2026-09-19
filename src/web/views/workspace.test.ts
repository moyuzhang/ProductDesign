import { describe, expect, it } from "vitest";
import { explicitProjectIdFromHash, preservesWorkspaceContext, projectSwitchTarget, stableProjectAccent } from "./workspace";

describe("workspace routing", () => {
  it("derives the project from an explicit project route", () => {
    expect(explicitProjectIdFromHash("#/projects/project%20one?tab=design")).toBe("project one");
    expect(explicitProjectIdFromHash("#/canvas/diagram-one")).toBe("");
  });

  it("preserves the current project detail tab when switching", () => {
    expect(projectSwitchTarget("#/projects/old-project?tab=development", "new-project"))
      .toBe("#/projects/new-project?tab=development");
  });

  it("opens the target project's main canvas from a deep canvas route", () => {
    expect(projectSwitchTarget("#/canvas/diagram-one/node/node-one?tab=definition", "new-project", "main-two"))
      .toBe("#/canvas/main-two");
  });

  it("returns deep routes to their global collection when selecting all projects", () => {
    expect(projectSwitchTarget("#/canvas/diagram-one", "")).toBe("#/canvas");
    expect(projectSwitchTarget("#/canvas/database/model-one", "")).toBe("#/canvas?view=database");
    expect(projectSwitchTarget("#/projects/project-one?tab=design", "")).toBe("#/projects");
  });

  it("opens project detail when selecting a project from a global page", () => {
    expect(projectSwitchTarget("#/", "new-project")).toBe("#/projects/new-project");
    expect(projectSwitchTarget("#/governance", "new-project")).toBe("#/projects/new-project");
  });

  it("keeps the selected project visible on guide and project management pages", () => {
    expect(preservesWorkspaceContext("#/guide")).toBe(true);
    expect(preservesWorkspaceContext("#/guide?section=agent-mcp")).toBe(true);
    expect(preservesWorkspaceContext("#/projects")).toBe(true);
    expect(preservesWorkspaceContext("#/projects?configured=no")).toBe(true);
    expect(preservesWorkspaceContext("#/governance")).toBe(false);
  });
});

describe("project accent", () => {
  it("is stable for the same project id", () => {
    expect(stableProjectAccent("project-one")).toBe(stableProjectAccent("project-one"));
  });
});
