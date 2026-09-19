import { describe, expect, it } from "vitest";
import { AGENT_ENTITY_REF_LABEL_MAX_LENGTH } from "../../shared/types";
import { agentNavigationRoute, agentVisibleContent, basePageContext, boundAgentEntityRefs } from "./agentUiBridge";

describe("basePageContext", () => {
  it("derives canvas node references without reading DOM content", () => {
    const context = basePageContext("#/canvas/diagram-1/node/node-2?tab=delivery", "project-1");
    expect(context).toMatchObject({ projectId: "project-1", pageType: "node" });
    expect(context.entityRefs).toEqual([
      { type: "project", id: "project-1" },
      { type: "diagram", id: "diagram-1" },
      { type: "diagramNode", id: "node-2", parentId: "diagram-1" },
    ]);
  });

  it("derives database model context from a project route", () => {
    const context = basePageContext("#/projects/project-2/database/model-3", "project-1");
    expect(context).toMatchObject({ projectId: "project-2", pageType: "database" });
    expect(context.entityRefs).toContainEqual({ type: "databaseModel", id: "model-3" });
  });

  it("derives semantic project tab page types", () => {
    expect(basePageContext("#/projects/project-2?tab=documents", "project-1").pageType).toBe("document");
    expect(basePageContext("#/projects/project-2?tab=plans", "project-1").pageType).toBe("plan");
    expect(basePageContext("#/projects/project-2?tab=evidence", "project-1").pageType).toBe("evidence");
  });

  it("bounds visible business content without inspecting the DOM", () => {
    const content = agentVisibleContent("document", "长文档", "x".repeat(30_001));
    expect(content.text).toHaveLength(30_000);
    expect(content.truncated).toBe(true);
  });

  it("bounds entity reference labels to the backend context contract", () => {
    const originalLabel = "证".repeat(AGENT_ENTITY_REF_LABEL_MAX_LENGTH + 1);
    const refs = boundAgentEntityRefs([{ type: "evidence", id: "evidence-1", label: originalLabel }]);

    expect(refs[0]?.label).toHaveLength(AGENT_ENTITY_REF_LABEL_MAX_LENGTH);
    expect(refs[0]?.label?.endsWith("…")).toBe(true);
    expect(originalLabel).toHaveLength(AGENT_ENTITY_REF_LABEL_MAX_LENGTH + 1);
  });

  it("routes only matching clean page contexts to an internal canvas hash", () => {
    const context = {
      ...basePageContext("#/projects/project-1", "project-1"),
      contextId: "context-1",
      capturedAt: "2026-08-28T00:00:00.000Z",
    };
    const event = {
      type: "CUSTOM" as const,
      name: "productdesign.navigation.requested" as const,
      value: {
        projectId: "project-1",
        sessionId: "session-1",
        contextId: "context-1",
        diagramId: "diagram/1",
        nodeId: "node 2",
        silent: true as const,
        source: "agent" as const,
      },
      timestamp: 1,
    };

    expect(agentNavigationRoute(event, context)).toBe("#/canvas/diagram%2F1?node=node%202");
    expect(agentNavigationRoute(event, { ...context, contextId: "another-context" })).toBeNull();
    expect(agentNavigationRoute(event, { ...context, draft: { dirty: true } })).toBeNull();
  });
});
