import { describe, expect, it } from "vitest";
import type { Diagram } from "../shared/types.js";
import { applyDiagramOperations, diagramEdgeSchema, validateDiagram } from "./diagram.js";

const diagram: Diagram = {
  id: "diagram",
  projectId: "project",
  title: "组合约束",
  type: "functional",
  nodes: [
    { id: "a1", kind: "feature", label: "A1", x: 0, y: 0, w: 40, h: 40 },
    { id: "a2", kind: "feature", label: "A2", x: 40, y: 0, w: 40, h: 40 },
    { id: "b1", kind: "feature", label: "B1", x: 112, y: 0, w: 40, h: 40 },
    { id: "b2", kind: "feature", label: "B2", x: 152, y: 0, w: 40, h: 40 },
  ],
  edges: [],
  groups: [
    { id: "group-a", name: "区域 A", nodeIds: ["a1", "a2"] },
    { id: "group-b", name: "区域 B", nodeIds: ["b1", "b2"] },
  ],
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
};

describe("diagram edge visual contract", () => {
  it("accepts bounded professional edge styling", () => {
    expect(diagramEdgeSchema.parse({
      id: "styled",
      from: "a",
      to: "b",
      color: "#31c4db",
      width: 3.5,
      dash: "dashed",
      arrow: "both",
      labelPosition: 0.7,
      routingMode: "auto",
      jumpStyle: "arc",
      routeVersion: 1,
    })).toMatchObject({ color: "#31c4db", width: 3.5, arrow: "both", routingMode: "auto", jumpStyle: "arc", routeVersion: 1 });
  });

  it("preserves a legacy manual route when an endpoint node moves", () => {
    const routed: Diagram = {
      ...diagram,
      groups: [],
      nodes: diagram.nodes.slice(0, 2),
      edges: [{
        id: "manual",
        from: "a1",
        to: "a2",
        style: "ortho",
        points: [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 20, y: 20 }],
      }],
    };
    const updated = applyDiagramOperations(routed, [{ op: "update_node", nodeId: "a1", patch: { y: 10 } }]);

    expect(updated.edges[0].routingMode).toBe("manual");
    expect(updated.edges[0].points?.[0]).toEqual({ x: 20, y: 10 });
    expect(updated.edges[0].points?.at(-1)).toEqual({ x: 20, y: 20 });
  });
});

describe("diagram group overlap guard", () => {
  it("rejects an Agent mutation that introduces an overlap", () => {
    expect(() => applyDiagramOperations(diagram, [
      { op: "update_node", nodeId: "b1", patch: { x: 111 } },
    ])).toThrow("组合区域“区域 A”与“区域 B”不允许重叠");
  });

  it("reports every existing overlap as a validation error", () => {
    const overlapping = {
      ...diagram,
      nodes: diagram.nodes.map((node) => node.id.startsWith("b") ? { ...node, x: node.x - 20 } : node),
    };
    expect(validateDiagram(overlapping)).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "overlapping_groups",
      entityId: "group-a",
    }));
  });
});
