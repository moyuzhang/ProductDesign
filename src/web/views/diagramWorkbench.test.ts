import { describe, expect, it } from "vitest";
import type { DiagramNode } from "../../shared/types";
import { clampFloatingPanelPosition, createMiniMapProjection, getDiagramBounds, rankDiagramNodes, relatedDiagramNodeIds, resolveDiagramSnap, snapFloatingPanelToCorner } from "./diagramWorkbench";

const nodes: DiagramNode[] = [
  { id: "routing", kind: "feature", label: "智能连线", description: "障碍避让", x: 100, y: 100, w: 160, h: 60 },
  { id: "comments", kind: "module", label: "评论审阅", owner: "协作组", x: 420, y: 220, w: 180, h: 70 },
];

describe("diagram workbench helpers", () => {
  it("ranks exact labels before descriptive matches", () => {
    expect(rankDiagramNodes(nodes, "智能连线").map((node) => node.id)).toEqual(["routing"]);
    expect(rankDiagramNodes(nodes, "协作").map((node) => node.id)).toEqual(["comments"]);
  });

  it("returns one-hop related nodes", () => {
    expect([...relatedDiagramNodeIds("routing", [{ id: "e", from: "routing", to: "comments" }])]).toEqual(["routing", "comments"]);
  });

  it("prefers alignment guides and otherwise snaps to the grid", () => {
    expect(resolveDiagramSnap({ x: 100, y: 100 }, 318, 117, [nodes[1]])).toEqual({ dx: 320, dy: 120, guides: { x: 420, y: 220 } });
    expect(resolveDiagramSnap({ x: 100, y: 100 }, 37, 31, [], 12)).toEqual({ dx: 32, dy: 32, guides: {} });
  });

  it("projects every diagram bound into the minimap frame", () => {
    const bounds = getDiagramBounds(nodes, 0);
    const projection = createMiniMapProjection(bounds, 200, 120, 10);
    expect(projection.projectX(bounds.minX)).toBeGreaterThanOrEqual(10);
    expect(projection.projectX(bounds.maxX)).toBeLessThanOrEqual(190);
    expect(projection.projectY(bounds.minY)).toBeGreaterThanOrEqual(10);
    expect(projection.projectY(bounds.maxY)).toBeLessThanOrEqual(110);
  });

  it("keeps a draggable navigation panel inside the canvas viewport", () => {
    expect(clampFloatingPanelPosition({ x: -40, y: 900 }, { width: 960, height: 640 }, { width: 190, height: 150 }, 12))
      .toEqual({ x: 12, y: 478 });
    expect(clampFloatingPanelPosition({ x: 300, y: 220 }, { width: 960, height: 640 }, { width: 190, height: 150 }, 12))
      .toEqual({ x: 300, y: 220 });
  });

  it("snaps a floating panel to the nearest free corner", () => {
    const viewport = { width: 960, height: 640 };
    const panel = { width: 190, height: 150 };
    expect(snapFloatingPanelToCorner({ x: 700, y: 430 }, viewport, panel, [], 12)).toEqual({ x: 758, y: 478 });
    expect(snapFloatingPanelToCorner(
      { x: 700, y: 430 },
      viewport,
      panel,
      [{ x: 740, y: 440, width: 220, height: 200 }],
      12,
    )).toEqual({ x: 758, y: 12 });
  });
});
