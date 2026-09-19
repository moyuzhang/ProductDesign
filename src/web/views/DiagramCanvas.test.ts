import { describe, expect, it } from "vitest";
import { buildDiagramSvg as buildMcpDiagramSvg } from "../../mcp/diagram";
import type { Diagram } from "../../shared/types";
import { buildDiagramSvg, resolveSubCanvasOpenIntent } from "./DiagramCanvas";

describe("sub-canvas quick open", () => {
  const options = [
    { id: "canvas-a", title: "业务视角" },
    { id: "canvas-b", title: "数据视角" },
  ];

  it("opens a single linked canvas directly", () => {
    expect(resolveSubCanvasOpenIntent(["canvas-a"], options)).toEqual({
      directId: "canvas-a",
      choices: [{ id: "canvas-a", title: "业务视角", available: true }],
    });
  });

  it("requires an explicit choice when multiple canvases are linked", () => {
    expect(resolveSubCanvasOpenIntent(["canvas-a", "canvas-b"], options)).toEqual({
      directId: null,
      choices: [
        { id: "canvas-a", title: "业务视角", available: true },
        { id: "canvas-b", title: "数据视角", available: true },
      ],
    });
  });

  it("keeps a deleted linked canvas visible but unavailable", () => {
    expect(resolveSubCanvasOpenIntent(["canvas-a", "missing"], options).choices[1]).toEqual({
      id: "missing",
      title: "已删除的画布",
      available: false,
    });
  });
});

describe("system root delivery presentation", () => {
  it("does not render synthetic development or acceptance state in exported diagrams", () => {
    const svg = buildDiagramSvg([{
      id: "system-root",
      kind: "system",
      label: "ProductDesign",
      x: 200,
      y: 120,
      developmentStatus: "未开发",
      acceptanceStatus: "未验收",
    }], [], [], "main");

    expect(svg).not.toContain("开发 ·");
    expect(svg).not.toContain("验收 ·");
  });

  it("exports professional edge styling without dropping its visual contract", () => {
    const svg = buildDiagramSvg([
      { id: "a", kind: "feature", label: "A", x: 80, y: 80 },
      { id: "b", kind: "feature", label: "B", x: 360, y: 80 },
    ], [{
      id: "styled-edge",
      from: "a",
      to: "b",
      label: "双向同步",
      style: "straight",
      color: "#31c4db",
      width: 3.5,
      dash: "dashed",
      arrow: "both",
      labelPosition: 0.7,
    }], [], "functional");

    expect(svg).toContain('stroke="#31c4db"');
    expect(svg).toContain('stroke-width="3.5"');
    expect(svg).toContain('stroke-dasharray="8 5"');
    expect(svg).toContain('marker-start="url(#arrow)"');
    expect(svg).toContain("双向同步");
  });

  it("uses the same intelligent route path in browser and MCP exports", () => {
    const nodes: Diagram["nodes"] = [
      { id: "source", kind: "feature", label: "Source", x: 0, y: 0, w: 100, h: 60 },
      { id: "obstacle", kind: "module", label: "Obstacle", x: 200, y: 0, w: 100, h: 80 },
      { id: "target", kind: "feature", label: "Target", x: 400, y: 0, w: 100, h: 60 },
    ];
    const edges: Diagram["edges"] = [{
      id: "routed",
      from: "source",
      to: "target",
      sourcePort: "right",
      targetPort: "left",
      style: "ortho",
      routingMode: "auto",
      jumpStyle: "arc",
      routeVersion: 1,
    }];
    const browserSvg = buildDiagramSvg(nodes, edges, [], "functional");
    const mcpSvg = buildMcpDiagramSvg({
      id: "diagram",
      projectId: "project",
      title: "Routing consistency",
      type: "functional",
      nodes,
      edges,
      groups: [],
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    const routePath = (svg: string): string => svg.match(/<path d="([^"]+)" fill="none" stroke="#8497aa"/)?.[1] ?? "";

    expect(routePath(browserSvg)).not.toBe("");
    expect(routePath(browserSvg)).toBe(routePath(mcpSvg));
  });
});
