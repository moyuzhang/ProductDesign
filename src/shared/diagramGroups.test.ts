import { describe, expect, it } from "vitest";
import type { DiagramGroup, DiagramNode } from "./types.js";
import {
  assertNoIntroducedDiagramGroupOverlap,
  diagramGroupBounds,
  findIntroducedDiagramGroupOverlap,
  listDiagramGroupOverlaps,
} from "./diagramGroups.js";

const nodes: DiagramNode[] = [
  { id: "a1", kind: "feature", label: "A1", x: 0, y: 0, w: 40, h: 40 },
  { id: "a2", kind: "feature", label: "A2", x: 40, y: 0, w: 40, h: 40 },
  { id: "b1", kind: "feature", label: "B1", x: 112, y: 0, w: 40, h: 40 },
  { id: "b2", kind: "feature", label: "B2", x: 152, y: 0, w: 40, h: 40 },
];
const groups: DiagramGroup[] = [
  { id: "group-a", name: "区域 A", nodeIds: ["a1", "a2"] },
  { id: "group-b", name: "区域 B", nodeIds: ["b1", "b2"] },
];

describe("diagram group geometry", () => {
  it("includes the rendered padding when calculating bounds", () => {
    expect(diagramGroupBounds(groups[0], nodes)).toEqual({ left: -36, top: -36, right: 76, bottom: 36 });
  });

  it("allows group borders to touch", () => {
    expect(listDiagramGroupOverlaps({ nodes, groups })).toEqual([]);
  });

  it("detects a newly introduced overlap", () => {
    const moved = nodes.map((node) => node.id.startsWith("b") ? { ...node, x: node.x - 1 } : node);
    const overlap = findIntroducedDiagramGroupOverlap({ nodes, groups }, { nodes: moved, groups });
    expect(overlap).toMatchObject({ first: { id: "group-a" }, second: { id: "group-b" } });
    expect(() => assertNoIntroducedDiagramGroupOverlap({ nodes, groups }, { nodes: moved, groups }))
      .toThrow("组合区域“区域 A”与“区域 B”不允许重叠");
  });

  it("allows legacy overlaps to remain or be removed without creating another pair", () => {
    const legacy = nodes.map((node) => node.id.startsWith("b") ? { ...node, x: node.x - 20 } : node);
    expect(() => assertNoIntroducedDiagramGroupOverlap(
      { nodes: legacy, groups },
      { nodes: legacy, groups },
    )).not.toThrow();
    expect(() => assertNoIntroducedDiagramGroupOverlap(
      { nodes: legacy, groups },
      { nodes, groups },
    )).not.toThrow();
  });
});
