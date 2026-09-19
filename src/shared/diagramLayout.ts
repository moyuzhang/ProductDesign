import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk.bundled.js";
import {
  DIAGRAM_PORTS,
  type DiagramEdge,
  type DiagramNode,
  type DiagramPoint,
  type DiagramPort,
  type DiagramType,
} from "./types.js";

export type LayoutDirection = "vertical" | "horizontal";

const DEFAULT_NODE_WIDTH = 176;
const DEFAULT_NODE_HEIGHT = 46;

function nodeWidth(node: DiagramNode): number {
  return node.w ?? DEFAULT_NODE_WIDTH;
}

function nodeHeight(node: DiagramNode): number {
  return node.h ?? DEFAULT_NODE_HEIGHT;
}

function roundedPoint(point: ElkPoint): DiagramPoint {
  return { x: Math.round(point.x * 2) / 2, y: Math.round(point.y * 2) / 2 };
}

function compactPoints(points: DiagramPoint[]): DiagramPoint[] {
  const unique = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  if (unique.length <= 2) return unique;
  const compacted = [unique[0]];
  for (let index = 1; index < unique.length - 1; index += 1) {
    const previous = compacted[compacted.length - 1];
    const current = unique[index];
    const next = unique[index + 1];
    if ((previous.x === current.x && current.x === next.x) || (previous.y === current.y && current.y === next.y)) continue;
    compacted.push(current);
  }
  compacted.push(unique[unique.length - 1]);
  return compacted;
}

function edgePoints(edge: ElkExtendedEdge): DiagramPoint[] | undefined {
  const section = edge.sections?.[0];
  if (!section) return undefined;
  return compactPoints([section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(roundedPoint));
}

function useCaseNodeType(node: DiagramNode): "actor" | "usecase" | "boundary" {
  if (node.useCaseType) return node.useCaseType;
  if (node.shape === "actor") return "actor";
  if (node.shape === "boundary") return "boundary";
  return "usecase";
}

function orderedNodes(nodes: DiagramNode[]): DiagramNode[] {
  return [...nodes].sort((left, right) => left.y - right.y || left.x - right.x || left.label.localeCompare(right.label));
}

function chunks(nodes: DiagramNode[], size: number): DiagramNode[][] {
  const result: DiagramNode[][] = [];
  for (let index = 0; index < nodes.length; index += size) result.push(nodes.slice(index, index + size));
  return result;
}

function balancedLayers(nodes: DiagramNode[], direction: LayoutDirection): DiagramNode[][] {
  if (nodes.length === 0) return [];
  const perLayer = direction === "vertical"
    ? (nodes.length <= 5 ? 1 : 2)
    : (nodes.length <= 4 ? 1 : 2);
  return chunks(orderedNodes(nodes), perLayer);
}

function useCaseLayers(nodes: DiagramNode[], edges: DiagramEdge[], direction: LayoutDirection): DiagramNode[][] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const active = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to || !edge.relationType || edge.relationType === "association") continue;
    active.add(edge.from);
    active.add(edge.to);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  if (active.size === 0) return balancedLayers(nodes, direction);

  const ordered = orderedNodes(nodes);
  const queue = ordered.filter((node) => active.has(node.id) && (indegree.get(node.id) ?? 0) === 0);
  const level = new Map<string, number>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited.add(node.id);
    const currentLevel = level.get(node.id) ?? 0;
    for (const nextId of outgoing.get(node.id) ?? []) {
      level.set(nextId, Math.max(level.get(nextId) ?? 0, currentLevel + 1));
      const nextIndegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextIndegree);
      if (nextIndegree === 0) {
        const next = ordered.find((candidate) => candidate.id === nextId);
        if (next) queue.push(next);
      }
    }
  }

  const layered = new Map<number, DiagramNode[]>();
  for (const node of ordered.filter((candidate) => visited.has(candidate.id))) {
    const nodeLevel = level.get(node.id) ?? 0;
    layered.set(nodeLevel, [...(layered.get(nodeLevel) ?? []), node]);
  }
  const result = [...layered.entries()].sort(([left], [right]) => left - right).map(([, layer]) => layer);
  const cyclic = ordered.filter((node) => active.has(node.id) && !visited.has(node.id));
  if (cyclic.length > 0) result.push(cyclic);
  const isolated = ordered.filter((node) => !active.has(node.id));
  return [...result, ...balancedLayers(isolated, direction)];
}

function placeUseCases(nodes: DiagramNode[], edges: DiagramEdge[], direction: LayoutDirection): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  const layers = useCaseLayers(nodes, edges, direction);
  const positions = new Map<string, { x: number; y: number }>();
  const gapAcross = 42;
  const gapBetween = 38;
  if (layers.length === 0) return { positions, width: 0, height: 0 };

  if (direction === "vertical") {
    const widths = layers.map((layer) => layer.reduce((sum, node) => sum + nodeWidth(node), 0) + gapAcross * Math.max(0, layer.length - 1));
    const heights = layers.map((layer) => Math.max(...layer.map(nodeHeight)));
    const width = Math.max(...widths);
    let y = 0;
    layers.forEach((layer, layerIndex) => {
      let x = (width - widths[layerIndex]) / 2;
      layer.forEach((node) => {
        positions.set(node.id, { x: x + nodeWidth(node) / 2, y: y + heights[layerIndex] / 2 });
        x += nodeWidth(node) + gapAcross;
      });
      y += heights[layerIndex] + gapBetween;
    });
    return { positions, width, height: y - gapBetween };
  }

  const widths = layers.map((layer) => Math.max(...layer.map(nodeWidth)));
  const heights = layers.map((layer) => layer.reduce((sum, node) => sum + nodeHeight(node), 0) + gapAcross * Math.max(0, layer.length - 1));
  const height = Math.max(...heights);
  let x = 0;
  layers.forEach((layer, layerIndex) => {
    let y = (height - heights[layerIndex]) / 2;
    layer.forEach((node) => {
      positions.set(node.id, { x: x + widths[layerIndex] / 2, y: y + nodeHeight(node) / 2 });
      y += nodeHeight(node) + gapAcross;
    });
    x += widths[layerIndex] + gapBetween;
  });
  return { positions, width: x - gapBetween, height };
}

function layoutUseCaseDiagram(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: LayoutDirection,
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const boundaries = orderedNodes(nodes.filter((node) => useCaseNodeType(node) === "boundary"));
  const actors = nodes.filter((node) => useCaseNodeType(node) === "actor");
  const useCases = nodes.filter((node) => useCaseNodeType(node) === "usecase");
  const positions = new Map<string, DiagramNode>();
  const regionBounds: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const regions: Array<{ boundary?: DiagramNode; useCases: DiagramNode[] }> = boundaries.map((boundary) => ({ boundary, useCases: [] }));

  if (boundaries.length === 0 && useCases.length > 0) regions.push({ useCases: [] });
  for (const useCase of useCases) {
    if (boundaries.length === 0) {
      regions[0].useCases.push(useCase);
      continue;
    }
    const containing = boundaries
      .filter((boundary) => Math.abs(useCase.x - boundary.x) <= nodeWidth(boundary) / 2 && Math.abs(useCase.y - boundary.y) <= nodeHeight(boundary) / 2)
      .sort((left, right) => nodeWidth(left) * nodeHeight(left) - nodeWidth(right) * nodeHeight(right));
    const target = containing[0] ?? boundaries.reduce((nearest, boundary) => (
      Math.hypot(useCase.x - boundary.x, useCase.y - boundary.y) < Math.hypot(useCase.x - nearest.x, useCase.y - nearest.y) ? boundary : nearest
    ));
    regions.find((region) => region.boundary?.id === target.id)!.useCases.push(useCase);
  }

  let cursorX = 300;
  const top = 100;
  for (const region of regions) {
    const local = placeUseCases(region.useCases, edges, direction);
    const width = region.boundary
      ? Math.max(420, local.width + 128)
      : Math.max(180, local.width);
    const height = region.boundary
      ? Math.max(260, local.height + 120)
      : Math.max(72, local.height);
    const contentLeft = cursorX + (width - local.width) / 2;
    const contentTop = region.boundary
      ? top + 72 + Math.max(0, (height - 112 - local.height) / 2)
      : top;

    if (region.boundary) positions.set(region.boundary.id, { ...region.boundary, x: cursorX + width / 2, y: top + height / 2, w: width, h: height });
    for (const useCase of region.useCases) {
      const localPosition = local.positions.get(useCase.id);
      if (localPosition) positions.set(useCase.id, { ...useCase, x: contentLeft + localPosition.x, y: contentTop + localPosition.y });
    }
    regionBounds.push({ left: cursorX, right: cursorX + width, top, bottom: top + height });
    cursorX += width + 180;
  }

  const core = regionBounds.length > 0
    ? {
        left: Math.min(...regionBounds.map((bounds) => bounds.left)),
        right: Math.max(...regionBounds.map((bounds) => bounds.right)),
        top: Math.min(...regionBounds.map((bounds) => bounds.top)),
        bottom: Math.max(...regionBounds.map((bounds) => bounds.bottom)),
      }
    : { left: 300, right: 820, top: 100, bottom: 420 };
  const oldLeft = boundaries.length > 0 ? Math.min(...boundaries.map((boundary) => boundary.x - nodeWidth(boundary) / 2)) : core.left;
  const oldRight = boundaries.length > 0 ? Math.max(...boundaries.map((boundary) => boundary.x + nodeWidth(boundary) / 2)) : core.right;
  const coreCenter = (core.left + core.right) / 2;
  const actorPlans = actors.map((actor) => {
    const connectedIds = new Set(edges.flatMap((edge) => edge.from === actor.id ? [edge.to] : edge.to === actor.id ? [edge.from] : []));
    const connected = [...connectedIds]
      .map((id) => positions.get(id))
      .filter((node): node is DiagramNode => node !== undefined)
      .filter((node) => useCaseNodeType(node) === "usecase");
    const targetX = connected.length > 0 ? connected.reduce((sum, node) => sum + node.x, 0) / connected.length : coreCenter;
    const connectedY = connected.map((node) => node.y).sort((left, right) => left - right);
    const middle = Math.floor(connectedY.length / 2);
    const desiredY = connectedY.length === 0
      ? (core.top + core.bottom) / 2
      : connectedY.length % 2 === 1 ? connectedY[middle] : (connectedY[middle - 1] + connectedY[middle]) / 2;
    const side = actor.x < oldLeft ? "left" : actor.x > oldRight ? "right" : targetX < coreCenter ? "left" : "right";
    return { actor, desiredY, side } as const;
  });

  for (const side of ["left", "right"] as const) {
    const plans = actorPlans.filter((plan) => plan.side === side).sort((left, right) => left.desiredY - right.desiredY || left.actor.y - right.actor.y);
    let nextTop = core.top + 18;
    for (const plan of plans) {
      const height = nodeHeight(plan.actor);
      const y = Math.max(plan.desiredY, nextTop + height / 2);
      const x = side === "left"
        ? core.left - 76 - nodeWidth(plan.actor) / 2
        : core.right + 76 + nodeWidth(plan.actor) / 2;
      positions.set(plan.actor.id, { ...plan.actor, x, y });
      nextTop = y + height / 2 + 38;
    }
  }

  const arrangedEdges: DiagramEdge[] = edges.map((edge) => ({
    ...edge,
    style: "straight",
    points: undefined,
    sourcePort: undefined,
    targetPort: undefined,
  }));
  return { nodes: nodes.map((node) => positions.get(node.id) ?? node), edges: arrangedEdges };
}

export async function layoutDiagram(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: LayoutDirection,
  diagramType: DiagramType = "free",
): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
  if (nodes.length === 0) return { nodes, edges };
  if (diagramType === "usecase") return layoutUseCaseDiagram(nodes, edges, direction);

  const defaultInputPort = (direction === "vertical" ? "top" : "left") as DiagramPort;
  const defaultOutputPort = (direction === "vertical" ? "bottom" : "right") as DiagramPort;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const layoutPorts = (edge: DiagramEdge): { sourcePort: DiagramPort; targetPort: DiagramPort } => {
    if (edge.from === edge.to) return { sourcePort: "right", targetPort: "top" };
    const sourceNode = nodeById.get(edge.from);
    const preserveDecisionBranch = diagramType === "flow" && sourceNode?.flowType === "decision" && edge.sourcePort;
    return {
      sourcePort: preserveDecisionBranch ? edge.sourcePort! : defaultOutputPort,
      targetPort: defaultInputPort,
    };
  };
  const spacing = diagramType === "flow"
    ? { nodes: "72", layers: "112", components: "90", straight: "true" }
    : diagramType === "main"
      ? { nodes: "74", layers: "132", components: "108", straight: "false" }
      : diagramType === "deployment"
        ? { nodes: "82", layers: "138", components: "110", straight: "false" }
        : diagramType === "functional"
          ? { nodes: "52", layers: "108", components: "84", straight: "false" }
          : { nodes: "56", layers: "96", components: "80", straight: "false" };
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "vertical" ? "DOWN" : "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.spacing.nodeNode": spacing.nodes,
      "elk.spacing.componentComponent": spacing.components,
      "elk.layered.spacing.nodeNodeBetweenLayers": spacing.layers,
      "elk.layered.spacing.edgeNodeBetweenLayers": "36",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.favorStraightEdges": spacing.straight,
      "elk.layered.unnecessaryBendpoints": "true",
      "elk.layered.mergeEdges": "false",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: nodeWidth(node),
      height: nodeHeight(node),
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: DIAGRAM_PORTS.map((port) => ({
        id: `${node.id}:${port}`,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": port === "top" ? "NORTH" : port === "right" ? "EAST" : port === "bottom" ? "SOUTH" : "WEST" },
      })),
    })),
    edges: edges.map((edge) => {
      const ports = layoutPorts(edge);
      return {
        id: edge.id,
        sources: [`${edge.from}:${ports.sourcePort}`],
        targets: [`${edge.to}:${ports.targetPort}`],
      };
    }),
  };

  // elkjs ships awkward CJS types under NodeNext; force the constructor shape explicitly.
  const { default: ELK } = await import("elkjs");
  const ElkConstructor = ELK as unknown as new () => { layout(graph: unknown): Promise<unknown> };
  const elk = new ElkConstructor();
  const result = (await elk.layout(graph)) as ElkNode;
  const positioned = new Map((result.children ?? []).map((node) => [node.id, node as ElkNode]));
  const routed = new Map((result.edges ?? []).map((edge) => [edge.id, edgePoints(edge as ElkExtendedEdge)]));

  return {
    nodes: nodes.map((node) => {
      const layoutNode = positioned.get(node.id);
      if (layoutNode?.x === undefined || layoutNode.y === undefined) return node;
      const width = nodeWidth(node);
      const height = nodeHeight(node);
      return { ...node, x: layoutNode.x + width / 2, y: layoutNode.y + height / 2 };
    }),
    edges: edges.map((edge) => ({ ...edge, ...layoutPorts(edge), style: "ortho", points: routed.get(edge.id) })),
  };
}
