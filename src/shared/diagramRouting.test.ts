import { describe, expect, it } from "vitest";
import type { DiagramEdge, DiagramNode } from "./types.js";
import {
  diagramEdgeRoutingMode,
  diagramPolylinePath,
  diagramRouteIntersectsNodes,
  routeDiagramEdges,
  sanitizeDiagramRoutePoints,
} from "./diagramRouting.js";

const horizontalNodes: DiagramNode[] = [
  { id: "source", kind: "feature", label: "Source", x: 0, y: 0, w: 100, h: 60 },
  { id: "obstacle", kind: "module", label: "Obstacle", x: 200, y: 0, w: 100, h: 80 },
  { id: "target", kind: "feature", label: "Target", x: 400, y: 0, w: 100, h: 60 },
];

describe("diagram routing engine", () => {
  it("keeps decision branches moving outward and visually separate", () => {
    const nodes: DiagramNode[] = [
      { id: "decision", kind: "requirement", label: "inputMode", x: 0, y: 0, w: 300, h: 150, shape: "diamond", flowType: "decision" },
      { id: "amount", kind: "feature", label: "Amount", x: -280, y: 280, w: 150, h: 60 },
      { id: "numbers", kind: "feature", label: "Numbers", x: 320, y: 280, w: 150, h: 60 },
    ];
    const edges: DiagramEdge[] = [
      { id: "amount-edge", from: "decision", to: "amount", sourcePort: "bottom", targetPort: "top", label: "AMOUNT", style: "ortho" },
      { id: "numbers-edge", from: "decision", to: "numbers", sourcePort: "right", targetPort: "top", label: "NUMBERS", style: "ortho" },
    ];
    const routes = routeDiagramEdges(nodes, edges);
    const amount = routes.get("amount-edge")!;
    const numbers = routes.get("numbers-edge")!;

    expect(amount.points[1].y).toBeGreaterThan(amount.points[0].y);
    expect(numbers.points[1].x).toBeGreaterThan(numbers.points[0].x);
    expect(diagramRouteIntersectsNodes(amount.points, nodes, ["decision", "amount"])).toBe(false);
    expect(diagramRouteIntersectsNodes(numbers.points, nodes, ["decision", "numbers"])).toBe(false);
    expect(amount.labelPoint).toBeDefined();
    expect(numbers.labelPoint).toBeDefined();
    expect(Math.hypot(amount.labelPoint!.x - numbers.labelPoint!.x, amount.labelPoint!.y - numbers.labelPoint!.y)).toBeGreaterThan(42);
  });

  it("fans multiple branches out from the same port with twelve-pixel lanes", () => {
    const nodes: DiagramNode[] = [
      { id: "decision", kind: "requirement", label: "判断", x: 0, y: 0, w: 220, h: 120, shape: "diamond", flowType: "decision" },
      ...[-260, 0, 260].map((x, index): DiagramNode => ({ id: `target-${index}`, kind: "feature", label: `Target ${index}`, x, y: 300, w: 120, h: 50 })),
    ];
    const edges: DiagramEdge[] = [0, 1, 2].map((index) => ({
      id: `branch-${index}`,
      from: "decision",
      to: `target-${index}`,
      sourcePort: "bottom",
      targetPort: "top",
      label: `条件 ${index + 1}`,
      style: "ortho",
    }));
    const routes = routeDiagramEdges(nodes, edges);
    const outerY = 60 + 32;
    const laneXs = edges.map((edge) => {
      const points = routes.get(edge.id)!.points;
      const segmentIndex = points.slice(1).findIndex((point, index) => points[index].x === point.x
        && outerY >= Math.min(points[index].y, point.y) && outerY <= Math.max(points[index].y, point.y));
      return points[segmentIndex].x;
    }).sort((a, b) => a - b);

    expect(laneXs).toEqual([-12, 0, 12]);
  });

  it("finds a deterministic orthogonal path around inflated node obstacles", () => {
    const edge: DiagramEdge = {
      id: "route-a",
      from: "source",
      to: "target",
      sourcePort: "right",
      targetPort: "left",
      style: "ortho",
      routingMode: "auto",
      routeVersion: 1,
    };
    const first = routeDiagramEdges(horizontalNodes, [edge]).get(edge.id)!;
    const second = routeDiagramEdges(horizontalNodes, [edge]).get(edge.id)!;

    expect(first.points).toEqual(second.points);
    expect(first.degraded).toBe(false);
    expect(first.points.length).toBeGreaterThan(4);
    expect(diagramRouteIntersectsNodes(first.points, horizontalNodes, ["source", "target"])).toBe(false);
    expect(first.points.every((point, index) => index === 0
      || point.x === first.points[index - 1].x
      || point.y === first.points[index - 1].y)).toBe(true);
  });

  it("assigns stable parallel lanes without persisting derived offsets", () => {
    const nodes = horizontalNodes.filter((node) => node.id !== "obstacle");
    const edges: DiagramEdge[] = ["route-c", "route-a", "route-b"].map((id) => ({
      id,
      from: "source",
      to: "target",
      sourcePort: "right",
      targetPort: "left",
      style: "ortho",
      routingMode: "auto",
    }));
    const routes = routeDiagramEdges(nodes, edges);

    expect(routes.get("route-a")?.laneOffset).toBe(-8);
    expect(routes.get("route-b")?.laneOffset).toBe(0);
    expect(routes.get("route-c")?.laneOffset).toBe(8);
    expect(edges.every((edge) => !("laneOffset" in edge))).toBe(true);
  });

  it("places a jump only on the stable upper edge and supports arc, gap and none paths", () => {
    const nodes: DiagramNode[] = [
      { id: "left", kind: "feature", label: "Left", x: -100, y: 0, w: 40, h: 40 },
      { id: "right", kind: "feature", label: "Right", x: 100, y: 0, w: 40, h: 40 },
      { id: "top", kind: "feature", label: "Top", x: 0, y: -100, w: 40, h: 40 },
      { id: "bottom", kind: "feature", label: "Bottom", x: 0, y: 100, w: 40, h: 40 },
    ];
    const edges: DiagramEdge[] = [
      { id: "a-horizontal", from: "left", to: "right", style: "ortho", routingMode: "manual", points: [{ x: -80, y: 0 }, { x: 80, y: 0 }] },
      { id: "z-vertical", from: "top", to: "bottom", style: "ortho", routingMode: "manual", points: [{ x: 0, y: -80 }, { x: 0, y: 80 }] },
    ];
    const routes = routeDiagramEdges(nodes, edges);
    const lower = routes.get("a-horizontal")!;
    const upper = routes.get("z-vertical")!;

    expect(lower.crossings).toEqual([]);
    expect(upper.crossings).toHaveLength(1);
    expect(diagramPolylinePath(upper.points, upper.crossings, "arc")).toContain(" Q ");
    expect(diagramPolylinePath(upper.points, upper.crossings, "gap")).toContain(" M ");
    expect(diagramPolylinePath(upper.points, upper.crossings, "none")).not.toContain(" Q ");
  });

  it("keeps legacy points manual and safely falls back from an invalid manual path", () => {
    const legacy: DiagramEdge = {
      id: "legacy",
      from: "source",
      to: "target",
      style: "ortho",
      points: [{ x: 50, y: 0 }, { x: Number.NaN, y: 10 }, { x: 350, y: 0 }],
    };
    expect(diagramEdgeRoutingMode(legacy)).toBe("manual");
    expect(sanitizeDiagramRoutePoints(legacy.points)).toEqual([{ x: 50, y: 0 }, { x: 350, y: 0 }]);

    const invalid = { ...legacy, id: "invalid", routingMode: "manual" as const, points: [{ x: Number.NaN, y: 0 }, { x: 350, y: 0 }] };
    const route = routeDiagramEdges(horizontalNodes, [invalid]).get(invalid.id)!;
    expect(route.degraded).toBe(true);
    expect(route.reason).toBe("invalid-manual-route");
    expect(route.points.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves all routes in the 500-node / 1000-edge large-graph fixture", () => {
    const nodes: DiagramNode[] = Array.from({ length: 500 }, (_, index) => ({
      id: `node-${index}`,
      kind: "feature",
      label: `Node ${index}`,
      x: (index % 25) * 220,
      y: Math.floor(index / 25) * 100,
      w: 120,
      h: 44,
    }));
    const edges: DiagramEdge[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `edge-${index.toString().padStart(4, "0")}`,
      from: `node-${index % 499}`,
      to: `node-${(index % 499) + 1}`,
      sourcePort: "right",
      targetPort: "left",
      style: "ortho",
      routingMode: "auto",
    }));

    const routes = routeDiagramEdges(nodes, edges);
    expect(routes.size).toBe(1000);
    expect([...routes.values()].every((route) => route.points.length >= 2)).toBe(true);
    expect([...routes.values()].every((route) => route.reason === "large-graph" && route.crossings.length === 0)).toBe(true);
  });
});
