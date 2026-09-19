import { describe, expect, it } from "vitest";
import type { DiagramEdge, DiagramNode } from "../../shared/types";
import { layoutDiagram } from "./elkLayout";

const nodes: DiagramNode[] = [
  { id: "root", kind: "system", label: "系统", x: 0, y: 0, w: 240, h: 70 },
  { id: "a", kind: "module", label: "模块 A", x: 0, y: 0, w: 120, h: 50 },
  { id: "b", kind: "module", label: "模块 B", x: 0, y: 0, w: 190, h: 60 },
];
const edges: DiagramEdge[] = [
  { id: "root-a", from: "root", to: "a" },
  { id: "root-b", from: "root", to: "b" },
];

describe("layoutDiagram", () => {
  it("preserves node sizes and routes a vertical hierarchy from bottom to top", async () => {
    const result = await layoutDiagram(nodes, edges, "vertical");
    const root = result.nodes.find((node) => node.id === "root")!;
    const child = result.nodes.find((node) => node.id === "a")!;
    const route = result.edges.find((edge) => edge.id === "root-a")!;

    expect(root.w).toBe(240);
    expect(child.h).toBe(50);
    expect(child.y).toBeGreaterThan(root.y);
    expect(route.style).toBe("ortho");
    expect(route.points?.length).toBeGreaterThanOrEqual(2);
    expect(route.points?.[0].y).toBeCloseTo(root.y + 70 / 2, 0);
    expect(route.points?.at(-1)?.y).toBeCloseTo(child.y - 50 / 2, 0);
  });

  it("routes a horizontal hierarchy from right to left", async () => {
    const result = await layoutDiagram(nodes, edges, "horizontal");
    const root = result.nodes.find((node) => node.id === "root")!;
    const child = result.nodes.find((node) => node.id === "a")!;
    const route = result.edges.find((edge) => edge.id === "root-a")!;

    expect(child.x).toBeGreaterThan(root.x);
    expect(route.points?.[0].x).toBeCloseTo(root.x + 240 / 2, 0);
    expect(route.points?.at(-1)?.x).toBeCloseTo(child.x - 120 / 2, 0);
  });

  it("replaces stale manual ports when arranging a vertical functional diagram", async () => {
    const staleEdges: DiagramEdge[] = [{
      id: "root-a",
      from: "root",
      to: "a",
      sourcePort: "right",
      targetPort: "left",
      points: [{ x: 999, y: 999 }, { x: 1200, y: 999 }],
    }];

    const result = await layoutDiagram(nodes, staleEdges, "vertical", "functional");
    const root = result.nodes.find((node) => node.id === "root")!;
    const child = result.nodes.find((node) => node.id === "a")!;
    const route = result.edges[0];

    expect(route.sourcePort).toBe("bottom");
    expect(route.targetPort).toBe("top");
    expect(route.points?.[0].y).toBeCloseTo(root.y + 70 / 2, 0);
    expect(route.points?.at(-1)?.y).toBeCloseTo(child.y - 50 / 2, 0);
  });
});
