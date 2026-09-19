import {
  DIAGRAM_PORTS,
  type DiagramEdge,
  type DiagramNode,
  type DiagramPoint,
  type DiagramPort,
} from "./types.js";

const DEFAULT_NODE_WIDTH = 176;
const DEFAULT_NODE_HEIGHT = 46;
const DEFAULT_CLEARANCE = 16;
const DEFAULT_STUB = 32;
const LANE_GAP = 8;
const PORT_LANE_GAP = 12;
const PORT_SHARED_STUB = 12;
const EPSILON = 0.001;

export interface DiagramRouteCrossing extends DiagramPoint {
  segmentIndex: number;
  direction: "horizontal" | "vertical";
}

export interface DiagramRouteResult {
  points: DiagramPoint[];
  crossings: DiagramRouteCrossing[];
  labelPoint?: DiagramPoint;
  degraded: boolean;
  reason?: "invalid-manual-route" | "no-obstacle-free-route" | "large-graph";
  cacheKey: string;
  laneOffset: number;
  dense: boolean;
}

export interface DiagramRoutingOptions {
  clearance?: number;
  largeGraph?: boolean;
  zoom?: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface OccupiedSegment {
  a: DiagramPoint;
  b: DiagramPoint;
}

const nodeWidth = (node: DiagramNode): number => node.w ?? DEFAULT_NODE_WIDTH;
const nodeHeight = (node: DiagramNode): number => node.h ?? DEFAULT_NODE_HEIGHT;

export function diagramPortPoint(node: DiagramNode, port: DiagramPort): DiagramPoint {
  if (port === "top") return { x: node.x, y: node.y - nodeHeight(node) / 2 };
  if (port === "right") return { x: node.x + nodeWidth(node) / 2, y: node.y };
  if (port === "bottom") return { x: node.x, y: node.y + nodeHeight(node) / 2 };
  return { x: node.x - nodeWidth(node) / 2, y: node.y };
}

export function nearestDiagramPort(node: DiagramNode, point: DiagramPoint): DiagramPort {
  return DIAGRAM_PORTS.reduce((nearest, port) => {
    const candidate = diagramPortPoint(node, port);
    const current = diagramPortPoint(node, nearest);
    return Math.hypot(point.x - candidate.x, point.y - candidate.y)
      < Math.hypot(point.x - current.x, point.y - current.y) ? port : nearest;
  }, "top" as DiagramPort);
}

export function diagramAttachPoint(node: DiagramNode, toward: DiagramPoint): DiagramPoint {
  return diagramPortPoint(node, nearestDiagramPort(node, toward));
}

export function diagramEdgeRoutingMode(edge: DiagramEdge): "auto" | "manual" {
  if (edge.routingMode) return edge.routingMode;
  return edge.points && edge.points.length >= 2 ? "manual" : "auto";
}

export function sanitizeDiagramRoutePoints(points: readonly DiagramPoint[] | undefined): DiagramPoint[] {
  if (!points) return [];
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  return compactPoints(finite);
}

export interface DiagramNodeDelta {
  x: number;
  y: number;
}

function moveRouteEndpoint(points: DiagramPoint[], atStart: boolean, delta: DiagramNodeDelta): DiagramPoint[] {
  const endpointIndex = atStart ? 0 : points.length - 1;
  const adjacentIndex = atStart ? 1 : points.length - 2;
  const endpoint = points[endpointIndex];
  const adjacent = points[adjacentIndex];
  const movedEndpoint = { x: endpoint.x + delta.x, y: endpoint.y + delta.y };
  const horizontal = Math.abs(endpoint.x - adjacent.x) >= Math.abs(endpoint.y - adjacent.y);
  if (points.length === 2) {
    const bend = horizontal ? { x: adjacent.x, y: movedEndpoint.y } : { x: movedEndpoint.x, y: adjacent.y };
    return compactPoints(atStart ? [movedEndpoint, bend, adjacent] : [adjacent, bend, movedEndpoint]);
  }
  const moved = points.map((point) => ({ ...point }));
  moved[endpointIndex] = movedEndpoint;
  moved[adjacentIndex] = horizontal
    ? { ...moved[adjacentIndex], y: movedEndpoint.y }
    : { ...moved[adjacentIndex], x: movedEndpoint.x };
  return compactPoints(moved);
}

export function moveDiagramManualRoute(
  edge: DiagramEdge,
  sourceDelta?: DiagramNodeDelta,
  targetDelta?: DiagramNodeDelta,
): DiagramPoint[] | undefined {
  const points = sanitizeDiagramRoutePoints(edge.points);
  if (points.length < 2 || (!sourceDelta && !targetDelta)) return edge.points;
  if (sourceDelta && targetDelta && sourceDelta.x === targetDelta.x && sourceDelta.y === targetDelta.y) {
    return points.map((point) => ({ x: point.x + sourceDelta.x, y: point.y + sourceDelta.y }));
  }
  let moved = points;
  if (sourceDelta) moved = moveRouteEndpoint(moved, true, sourceDelta);
  if (targetDelta) moved = moveRouteEndpoint(moved, false, targetDelta);
  return moved;
}

function compactPoints(points: readonly DiagramPoint[]): DiagramPoint[] {
  const unique = points.filter((point, index) => index === 0
    || Math.abs(point.x - points[index - 1].x) > EPSILON
    || Math.abs(point.y - points[index - 1].y) > EPSILON);
  if (unique.length <= 2) return unique.map((point) => ({ ...point }));
  const result: DiagramPoint[] = [{ ...unique[0] }];
  for (let index = 1; index < unique.length - 1; index += 1) {
    const previous = result[result.length - 1];
    const current = unique[index];
    const next = unique[index + 1];
    const vertical = Math.abs(previous.x - current.x) <= EPSILON && Math.abs(current.x - next.x) <= EPSILON;
    const horizontal = Math.abs(previous.y - current.y) <= EPSILON && Math.abs(current.y - next.y) <= EPSILON;
    if (!vertical && !horizontal) result.push({ ...current });
  }
  result.push({ ...unique[unique.length - 1] });
  return result;
}

function offsetPoint(point: DiagramPoint, port: DiagramPort, amount: number): DiagramPoint {
  if (port === "top") return { x: point.x, y: point.y - amount };
  if (port === "right") return { x: point.x + amount, y: point.y };
  if (port === "bottom") return { x: point.x, y: point.y + amount };
  return { x: point.x - amount, y: point.y };
}

function perpendicularOffset(point: DiagramPoint, port: DiagramPort, amount: number): DiagramPoint {
  return port === "top" || port === "bottom"
    ? { x: point.x + amount, y: point.y }
    : { x: point.x, y: point.y + amount };
}

function portStub(point: DiagramPoint, port: DiagramPort, laneOffset: number): DiagramPoint[] {
  const shared = offsetPoint(point, port, PORT_SHARED_STUB);
  const sharedLane = perpendicularOffset(shared, port, laneOffset);
  const outer = perpendicularOffset(offsetPoint(point, port, DEFAULT_STUB), port, laneOffset);
  return compactPoints([point, shared, sharedLane, outer]);
}

function nodeRect(node: DiagramNode, clearance: number): Rect {
  return {
    left: node.x - nodeWidth(node) / 2 - clearance,
    right: node.x + nodeWidth(node) / 2 + clearance,
    top: node.y - nodeHeight(node) / 2 - clearance,
    bottom: node.y + nodeHeight(node) / 2 + clearance,
  };
}

function pointInsideRect(point: DiagramPoint, rect: Rect): boolean {
  return point.x > rect.left + EPSILON && point.x < rect.right - EPSILON
    && point.y > rect.top + EPSILON && point.y < rect.bottom - EPSILON;
}

function segmentHitsRect(a: DiagramPoint, b: DiagramPoint, rect: Rect): boolean {
  if (Math.abs(a.x - b.x) <= EPSILON) {
    if (a.x <= rect.left + EPSILON || a.x >= rect.right - EPSILON) return false;
    const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
    return bottom > rect.top + EPSILON && top < rect.bottom - EPSILON;
  }
  if (Math.abs(a.y - b.y) <= EPSILON) {
    if (a.y <= rect.top + EPSILON || a.y >= rect.bottom - EPSILON) return false;
    const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
    return right > rect.left + EPSILON && left < rect.right - EPSILON;
  }
  return true;
}

export function diagramRouteIntersectsNodes(
  points: readonly DiagramPoint[],
  nodes: readonly DiagramNode[],
  excludedNodeIds: readonly string[] = [],
  clearance = DEFAULT_CLEARANCE,
): boolean {
  const excluded = new Set(excludedNodeIds);
  const obstacles = nodes.filter((node) => !excluded.has(node.id)).map((node) => nodeRect(node, clearance));
  for (let index = 1; index < points.length; index += 1) {
    if (obstacles.some((rect) => segmentHitsRect(points[index - 1], points[index], rect))) return true;
  }
  return false;
}

function simpleOrthogonalCore(
  source: DiagramPoint,
  target: DiagramPoint,
  sourcePort: DiagramPort,
  targetPort: DiagramPort,
): DiagramPoint[] {
  const sourceVertical = sourcePort === "top" || sourcePort === "bottom";
  const targetVertical = targetPort === "top" || targetPort === "bottom";
  if (sourceVertical === targetVertical) {
    if (sourceVertical) {
      const middleY = (source.y + target.y) / 2;
      return compactPoints([source, { x: source.x, y: middleY }, { x: target.x, y: middleY }, target]);
    }
    const middleX = (source.x + target.x) / 2;
    return compactPoints([source, { x: middleX, y: source.y }, { x: middleX, y: target.y }, target]);
  }
  return compactPoints([source, { x: target.x, y: source.y }, target]);
}

function joinPortRoute(
  sourceStub: DiagramPoint[],
  core: DiagramPoint[],
  targetStub: DiagramPoint[],
): DiagramPoint[] {
  const targetReturn = [...targetStub].reverse();
  return compactPoints([
    ...sourceStub,
    ...core.slice(1),
    ...targetReturn.slice(1),
  ]);
}

function selfLoopRoute(node: DiagramNode, sourcePort: DiagramPort, targetPort: DiagramPort): DiagramPoint[] {
  const source = diagramPortPoint(node, sourcePort);
  const target = diagramPortPoint(node, targetPort);
  const rect = nodeRect(node, 38);
  const outer: Record<DiagramPort, DiagramPoint> = {
    top: { x: node.x, y: rect.top },
    right: { x: rect.right, y: node.y },
    bottom: { x: node.x, y: rect.bottom },
    left: { x: rect.left, y: node.y },
  };
  if (sourcePort === targetPort) {
    const clockwise = DIAGRAM_PORTS[(DIAGRAM_PORTS.indexOf(sourcePort) + 1) % DIAGRAM_PORTS.length];
    const corner = sourcePort === "top" || sourcePort === "bottom"
      ? { x: outer[clockwise].x, y: outer[sourcePort].y }
      : { x: outer[sourcePort].x, y: outer[clockwise].y };
    return compactPoints([source, outer[sourcePort], corner, outer[clockwise], target]);
  }
  const sourceOuter = outer[sourcePort], targetOuter = outer[targetPort];
  const corner = sourcePort === "top" || sourcePort === "bottom"
    ? { x: targetOuter.x, y: sourceOuter.y }
    : { x: sourceOuter.x, y: targetOuter.y };
  return compactPoints([source, sourceOuter, corner, targetOuter, target]);
}

function routeKey(point: DiagramPoint): string {
  return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function obstacleRoute(
  source: DiagramPoint,
  target: DiagramPoint,
  sourcePort: DiagramPort,
  targetPort: DiagramPort,
  obstacles: readonly Rect[],
  occupiedSegments: readonly OccupiedSegment[],
): DiagramPoint[] | null {
  const corridor = {
    left: Math.min(source.x, target.x) - 220,
    right: Math.max(source.x, target.x) + 220,
    top: Math.min(source.y, target.y) - 220,
    bottom: Math.max(source.y, target.y) + 220,
  };
  const relevant = obstacles.filter((rect) => rect.right >= corridor.left && rect.left <= corridor.right
    && rect.bottom >= corridor.top && rect.top <= corridor.bottom).slice(0, 72);
  const relevantOccupied = occupiedSegments.filter(({ a, b }) => Math.max(a.x, b.x) >= corridor.left
    && Math.min(a.x, b.x) <= corridor.right && Math.max(a.y, b.y) >= corridor.top
    && Math.min(a.y, b.y) <= corridor.bottom).slice(0, 48);
  const xValues = [...new Set([
    source.x, target.x,
    ...relevant.flatMap((rect) => [rect.left, rect.right]),
    ...relevantOccupied.flatMap(({ a, b }) => Math.abs(a.x - b.x) <= EPSILON ? [a.x - PORT_LANE_GAP, a.x, a.x + PORT_LANE_GAP] : [a.x, b.x]),
  ])].sort((a, b) => a - b);
  const yValues = [...new Set([
    source.y, target.y,
    ...relevant.flatMap((rect) => [rect.top, rect.bottom]),
    ...relevantOccupied.flatMap(({ a, b }) => Math.abs(a.y - b.y) <= EPSILON ? [a.y - PORT_LANE_GAP, a.y, a.y + PORT_LANE_GAP] : [a.y, b.y]),
  ])].sort((a, b) => a - b);
  if (xValues.length * yValues.length > 24_000) return null;

  type QueueItem = { xIndex: number; yIndex: number; direction: "h" | "v" | "s"; cost: number };
  const queue: QueueItem[] = [];
  const distance = new Map<string, number>();
  const previous = new Map<string, string>();
  const statePoint = (xIndex: number, yIndex: number): DiagramPoint => ({ x: xValues[xIndex], y: yValues[yIndex] });
  const stateKey = (xIndex: number, yIndex: number, direction: QueueItem["direction"]): string => `${xIndex}:${yIndex}:${direction}`;
  const sourceX = xValues.indexOf(source.x), sourceY = yValues.indexOf(source.y);
  const targetX = xValues.indexOf(target.x), targetY = yValues.indexOf(target.y);
  const initialKey = stateKey(sourceX, sourceY, "s");
  distance.set(initialKey, 0);
  queue.push({ xIndex: sourceX, yIndex: sourceY, direction: "s", cost: 0 });
  let finalKey = "";

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost || a.xIndex - b.xIndex || a.yIndex - b.yIndex || a.direction.localeCompare(b.direction));
    const current = queue.shift()!;
    const currentKey = stateKey(current.xIndex, current.yIndex, current.direction);
    if (current.cost !== distance.get(currentKey)) continue;
    if (current.xIndex === targetX && current.yIndex === targetY) { finalKey = currentKey; break; }
    const neighbors: Array<[number, number, "h" | "v"]> = [];
    if (current.xIndex > 0) neighbors.push([current.xIndex - 1, current.yIndex, "h"]);
    if (current.xIndex + 1 < xValues.length) neighbors.push([current.xIndex + 1, current.yIndex, "h"]);
    if (current.yIndex > 0) neighbors.push([current.xIndex, current.yIndex - 1, "v"]);
    if (current.yIndex + 1 < yValues.length) neighbors.push([current.xIndex, current.yIndex + 1, "v"]);
    const from = statePoint(current.xIndex, current.yIndex);
    for (const [xIndex, yIndex, direction] of neighbors) {
      const to = statePoint(xIndex, yIndex);
      if (relevant.some((rect) => pointInsideRect(to, rect) || segmentHitsRect(from, to, rect))) continue;
      const turnCost = current.direction !== "s" && current.direction !== direction ? 28 : 0;
      const movementPort: DiagramPort = Math.abs(to.x - from.x) > EPSILON
        ? to.x > from.x ? "right" : "left"
        : to.y > from.y ? "bottom" : "top";
      const oppositePort: Record<DiagramPort, DiagramPort> = { top: "bottom", right: "left", bottom: "top", left: "right" };
      const reverseCost = current.direction === "s" && movementPort === oppositePort[sourcePort] ? 480
        : xIndex === targetX && yIndex === targetY && movementPort !== oppositePort[targetPort] ? 480 : 0;
      const overlapLength = relevantOccupied.reduce((sum, segment) => sum + segmentOverlapLength(from, to, segment.a, segment.b), 0);
      const crossingCount = relevantOccupied.reduce((sum, segment) => sum + (segmentCrossing(from, to, segment.a, segment.b) ? 1 : 0), 0);
      const cost = current.cost + Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
        + turnCost + reverseCost + overlapLength * 12 + crossingCount * 180;
      const nextKey = stateKey(xIndex, yIndex, direction);
      if (cost + EPSILON >= (distance.get(nextKey) ?? Infinity)) continue;
      distance.set(nextKey, cost);
      previous.set(nextKey, currentKey);
      queue.push({ xIndex, yIndex, direction, cost });
    }
  }
  if (!finalKey) return null;
  const route: DiagramPoint[] = [];
  let cursor = finalKey;
  while (cursor) {
    const [xIndex, yIndex] = cursor.split(":").map(Number);
    route.push(statePoint(xIndex, yIndex));
    cursor = previous.get(cursor) ?? "";
  }
  route.reverse();
  return compactPoints(route);
}

function laneSignature(edge: DiagramEdge, from: DiagramNode, to: DiagramNode): string {
  const sourcePort = edge.sourcePort ?? nearestDiagramPort(from, to);
  const targetPort = edge.targetPort ?? nearestDiagramPort(to, from);
  return `${edge.from}:${sourcePort}>${edge.to}:${targetPort}`;
}

interface LaneMetadata {
  offset: number;
  sourceOffset: number;
  targetOffset: number;
  dense: boolean;
}

function centeredLaneOffset(index: number, count: number, gap: number, dense: boolean): number {
  const visibleIndex = dense ? index % 7 : index;
  const visibleCount = dense ? Math.min(7, count) : count;
  return (visibleIndex - (visibleCount - 1) / 2) * gap;
}

function laneMetadata(edges: readonly DiagramEdge[], nodes: readonly DiagramNode[]): Map<string, LaneMetadata> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parallelGroups = new Map<string, DiagramEdge[]>();
  const sourceGroups = new Map<string, DiagramEdge[]>();
  const targetGroups = new Map<string, DiagramEdge[]>();
  for (const edge of edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to || from.id === to.id) continue;
    const sourcePort = edge.sourcePort ?? nearestDiagramPort(from, to);
    const targetPort = edge.targetPort ?? nearestDiagramPort(to, from);
    const parallelSignature = laneSignature(edge, from, to);
    const sourceSignature = `${edge.from}:${sourcePort}`;
    const targetSignature = `${edge.to}:${targetPort}`;
    parallelGroups.set(parallelSignature, [...(parallelGroups.get(parallelSignature) ?? []), edge]);
    sourceGroups.set(sourceSignature, [...(sourceGroups.get(sourceSignature) ?? []), edge]);
    targetGroups.set(targetSignature, [...(targetGroups.get(targetSignature) ?? []), edge]);
  }
  const result = new Map<string, LaneMetadata>();
  for (const edge of edges) result.set(edge.id, { offset: 0, sourceOffset: 0, targetOffset: 0, dense: false });
  const assign = (groups: Map<string, DiagramEdge[]>, key: "offset" | "sourceOffset" | "targetOffset", gap: number) => {
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
      const dense = sorted.length > 7;
      sorted.forEach((edge, index) => {
        const current = result.get(edge.id)!;
        result.set(edge.id, { ...current, [key]: centeredLaneOffset(index, sorted.length, gap, dense), dense: current.dense || dense });
      });
    }
  };
  assign(parallelGroups, "offset", LANE_GAP);
  assign(sourceGroups, "sourceOffset", PORT_LANE_GAP);
  assign(targetGroups, "targetOffset", PORT_LANE_GAP);
  return result;
}

function applyLaneOffset(points: DiagramPoint[], amount: number): DiagramPoint[] {
  if (Math.abs(amount) <= EPSILON || points.length < 2) return points;
  const source = points[0], target = points[points.length - 1];
  const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y);
  const shifted = points.slice(1, -1).map((point) => horizontal
    ? { x: point.x, y: point.y + amount }
    : { x: point.x + amount, y: point.y });
  const sourceBridge = horizontal ? { x: source.x, y: source.y + amount } : { x: source.x + amount, y: source.y };
  const targetBridge = horizontal ? { x: target.x, y: target.y + amount } : { x: target.x + amount, y: target.y };
  return compactPoints([source, sourceBridge, ...shifted, targetBridge, target]);
}

function routeCacheKey(edge: DiagramEdge, from: DiagramNode, to: DiagramNode, lane: LaneMetadata): string {
  const values = [edge.id, edge.routingMode ?? "legacy", edge.style ?? "curve", edge.sourcePort ?? "", edge.targetPort ?? "",
    from.id, from.x, from.y, nodeWidth(from), nodeHeight(from), to.id, to.x, to.y, nodeWidth(to), nodeHeight(to),
    lane.offset, lane.sourceOffset, lane.targetOffset,
    ...(edge.points ?? []).flatMap((point) => [point.x, point.y])];
  return values.join("|");
}

function segmentOverlapLength(a1: DiagramPoint, a2: DiagramPoint, b1: DiagramPoint, b2: DiagramPoint): number {
  const aHorizontal = Math.abs(a1.y - a2.y) <= EPSILON;
  const bHorizontal = Math.abs(b1.y - b2.y) <= EPSILON;
  if (aHorizontal !== bHorizontal) return 0;
  if (aHorizontal) {
    if (Math.abs(a1.y - b1.y) > EPSILON) return 0;
    return Math.max(0, Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x))
      - Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)));
  }
  if (Math.abs(a1.x - b1.x) > EPSILON) return 0;
  return Math.max(0, Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y))
    - Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y)));
}

function segmentCrossing(
  a1: DiagramPoint,
  a2: DiagramPoint,
  b1: DiagramPoint,
  b2: DiagramPoint,
): DiagramPoint | null {
  const aHorizontal = Math.abs(a1.y - a2.y) <= EPSILON;
  const bHorizontal = Math.abs(b1.y - b2.y) <= EPSILON;
  if (aHorizontal === bHorizontal) return null;
  const horizontalStart = aHorizontal ? a1 : b1;
  const horizontalEnd = aHorizontal ? a2 : b2;
  const verticalStart = aHorizontal ? b1 : a1;
  const verticalEnd = aHorizontal ? b2 : a2;
  const point = { x: verticalStart.x, y: horizontalStart.y };
  const within = point.x > Math.min(horizontalStart.x, horizontalEnd.x) + 6
    && point.x < Math.max(horizontalStart.x, horizontalEnd.x) - 6
    && point.y > Math.min(verticalStart.y, verticalEnd.y) + 6
    && point.y < Math.max(verticalStart.y, verticalEnd.y) - 6;
  return within ? point : null;
}

function addCrossings(routes: Map<string, DiagramRouteResult>, edges: readonly DiagramEdge[]): void {
  const sorted = [...edges]
    .filter((edge) => routes.has(edge.id) && edge.style !== "straight" && edge.style !== "curve")
    .sort((a, b) => a.id.localeCompare(b.id));
  for (let firstIndex = 0; firstIndex < sorted.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < sorted.length; secondIndex += 1) {
      const lower = routes.get(sorted[firstIndex].id)!;
      const upper = routes.get(sorted[secondIndex].id)!;
      for (let upperSegment = 1; upperSegment < upper.points.length; upperSegment += 1) {
        for (let lowerSegment = 1; lowerSegment < lower.points.length; lowerSegment += 1) {
          const point = segmentCrossing(
            upper.points[upperSegment - 1], upper.points[upperSegment],
            lower.points[lowerSegment - 1], lower.points[lowerSegment],
          );
          if (!point) continue;
          const direction = Math.abs(upper.points[upperSegment - 1].y - upper.points[upperSegment].y) <= EPSILON ? "horizontal" : "vertical";
          if (!upper.crossings.some((crossing) => Math.hypot(crossing.x - point.x, crossing.y - point.y) < 1)) {
            upper.crossings.push({ ...point, segmentIndex: upperSegment - 1, direction });
          }
        }
      }
    }
  }
}

function routeSegments(points: readonly DiagramPoint[]): OccupiedSegment[] {
  return points.slice(1).map((point, index) => ({ a: points[index], b: point }));
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function labelRect(point: DiagramPoint, width: number): Rect {
  return { left: point.x - width / 2, right: point.x + width / 2, top: point.y - 18, bottom: point.y + 4 };
}

function placeRouteLabels(
  routes: Map<string, DiagramRouteResult>,
  edges: readonly DiagramEdge[],
  nodes: readonly DiagramNode[],
  largeGraph: boolean,
): void {
  const occupiedLabels: Rect[] = [];
  const nodeBounds = nodes.map((node) => nodeRect(node, 10));
  const sortedEdges = [...edges].filter((edge) => routes.has(edge.id)).sort((a, b) => a.id.localeCompare(b.id));

  for (const edge of sortedEdges) {
    const route = routes.get(edge.id)!;
    const points = route.points;
    if (points.length < 2 || !edge.label?.trim()) continue;
    const labelWidth = Math.max(42, (edge.label?.length ?? 0) * 7 + 18);
    const preferred = Math.max(0.1, Math.min(0.9, edge.labelPosition ?? 0.5));
    if (largeGraph) {
      route.labelPoint = diagramPathPointAt(points, preferred);
      continue;
    }
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0) || 1;
    const candidates: Array<{ point: DiagramPoint; position: number; vertical: boolean }> = [];
    let travelled = 0;
    lengths.forEach((length, index) => {
      if (length >= 30) {
        for (const ratio of length >= 90 ? [0.35, 0.5, 0.65] : [0.5]) {
          const start = points[index], end = points[index + 1];
          candidates.push({
            point: { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio },
            position: (travelled + length * ratio) / totalLength,
            vertical: Math.abs(start.x - end.x) <= EPSILON,
          });
        }
      }
      travelled += length;
    });
    candidates.push({ point: diagramPathPointAt(points, preferred), position: preferred, vertical: false });

    const otherSegments = [...routes.entries()]
      .filter(([edgeId]) => edgeId !== edge.id)
      .flatMap(([, result]) => routeSegments(result.points));
    const scored = candidates.map((candidate, index) => {
      const bounds = labelRect(candidate.point, labelWidth);
      const nodeCollision = nodeBounds.some((rect) => rectsOverlap(bounds, rect));
      const labelCollision = occupiedLabels.some((rect) => rectsOverlap(bounds, rect));
      const bendDistance = points.slice(1, -1).reduce((minimum, bend) => Math.min(minimum, Math.hypot(candidate.point.x - bend.x, candidate.point.y - bend.y)), Infinity);
      const endpointDistance = Math.min(
        Math.hypot(candidate.point.x - points[0].x, candidate.point.y - points[0].y),
        Math.hypot(candidate.point.x - points[points.length - 1].x, candidate.point.y - points[points.length - 1].y),
      );
      const routeDensity = otherSegments.filter((segment) => segmentHitsRect(segment.a, segment.b, bounds)).length;
      const score = Math.abs(candidate.position - preferred) * 320
        + (candidate.vertical ? 26 : 0)
        + routeDensity * 90
        + (bendDistance < 18 ? 6_000 : 0)
        + (endpointDistance < 24 ? 6_000 : 0)
        + (nodeCollision ? 100_000 : 0)
        + (labelCollision ? 80_000 : 0)
        + index * 0.001;
      return { ...candidate, bounds, score };
    }).sort((a, b) => a.score - b.score || a.position - b.position);
    const selected = scored[0];
    if (!selected) continue;
    route.labelPoint = selected.point;
    occupiedLabels.push(selected.bounds);
  }
}

export function routeDiagramEdges(
  nodes: readonly DiagramNode[],
  edges: readonly DiagramEdge[],
  options: DiagramRoutingOptions = {},
): Map<string, DiagramRouteResult> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const largeGraph = options.largeGraph ?? (nodes.length >= 500 || edges.length >= 1000);
  const clearance = options.clearance ?? DEFAULT_CLEARANCE;
  const lanes = laneMetadata(edges, nodes);
  const routes = new Map<string, DiagramRouteResult>();
  const occupiedSegments: OccupiedSegment[] = [];
  const orderedEdges = [...edges].sort((a, b) => {
    const manualOrder = Number(diagramEdgeRoutingMode(b) === "manual") - Number(diagramEdgeRoutingMode(a) === "manual");
    return manualOrder || a.id.localeCompare(b.id);
  });

  for (const edge of orderedEdges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    const lane = lanes.get(edge.id) ?? { offset: 0, sourceOffset: 0, targetOffset: 0, dense: false };
    const cacheKey = routeCacheKey(edge, from, to, lane);
    const manual = diagramEdgeRoutingMode(edge) === "manual";
    const manualPoints = sanitizeDiagramRoutePoints(edge.points);
    if (manual && manualPoints.length >= 2) {
      routes.set(edge.id, { points: manualPoints, crossings: [], degraded: false, cacheKey, laneOffset: lane.offset, dense: lane.dense });
      occupiedSegments.push(...routeSegments(manualPoints));
      continue;
    }

    const sourcePort = edge.sourcePort ?? nearestDiagramPort(from, to);
    const targetPort = edge.targetPort ?? nearestDiagramPort(to, from);
    const source = diagramPortPoint(from, sourcePort);
    const target = diagramPortPoint(to, targetPort);
    let points: DiagramPoint[];
    let degraded = false;
    let reason: DiagramRouteResult["reason"];
    if (from.id === to.id) {
      points = selfLoopRoute(from, sourcePort, targetPort);
    } else if (edge.style === "straight" || edge.style === "curve") {
      points = [source, target];
    } else {
      const sourceStub = portStub(source, sourcePort, lane.sourceOffset);
      const targetStub = portStub(target, targetPort, lane.targetOffset);
      const sourceOuter = sourceStub[sourceStub.length - 1];
      const targetOuter = targetStub[targetStub.length - 1];
      const fallbackCore = simpleOrthogonalCore(sourceOuter, targetOuter, sourcePort, targetPort);
      if (largeGraph) {
        points = joinPortRoute(sourceStub, fallbackCore, targetStub);
        degraded = true;
        reason = "large-graph";
      } else {
        // Endpoint nodes remain obstacles after their short port corridor. This prevents
        // a decision branch from doubling back through or around its own diamond.
        const obstacles = nodes.map((node) => nodeRect(node, clearance));
        const core = obstacleRoute(sourceOuter, targetOuter, sourcePort, targetPort, obstacles, occupiedSegments)
          ?? fallbackCore;
        points = joinPortRoute(sourceStub, core, targetStub);
      }
      if (!largeGraph && diagramRouteIntersectsNodes(points, nodes, [from.id, to.id], clearance)) {
        degraded = true;
        reason = "no-obstacle-free-route";
      }
    }
    if (manual && manualPoints.length < 2) {
      degraded = true;
      reason = "invalid-manual-route";
    }
    const shifted = Math.abs(lane.sourceOffset) <= EPSILON && Math.abs(lane.targetOffset) <= EPSILON
      ? applyLaneOffset(points, lane.offset) : points;
    if (!diagramRouteIntersectsNodes(shifted, nodes, [from.id, to.id], clearance)) points = shifted;
    routes.set(edge.id, { points, crossings: [], degraded, reason, cacheKey, laneOffset: lane.offset, dense: lane.dense });
    occupiedSegments.push(...routeSegments(points));
  }
  if (!largeGraph && (options.zoom ?? 1) >= 0.4) addCrossings(routes, edges);
  placeRouteLabels(routes, edges, nodes, largeGraph);
  return routes;
}

function roundedCornerData(points: readonly DiagramPoint[], index: number, radius: number): { enter: DiagramPoint; exit: DiagramPoint } {
  const previous = points[index - 1], corner = points[index], next = points[index + 1];
  const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
  const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
  const amount = Math.min(radius, incomingLength / 2, outgoingLength / 2);
  const incoming = { x: Math.sign(corner.x - previous.x), y: Math.sign(corner.y - previous.y) };
  const outgoing = { x: Math.sign(next.x - corner.x), y: Math.sign(next.y - corner.y) };
  return {
    enter: { x: corner.x - incoming.x * amount, y: corner.y - incoming.y * amount },
    exit: { x: corner.x + outgoing.x * amount, y: corner.y + outgoing.y * amount },
  };
}

function appendJumpSegment(
  path: string,
  from: DiagramPoint,
  to: DiagramPoint,
  crossings: readonly DiagramRouteCrossing[],
  jumpStyle: "arc" | "gap" | "none",
): string {
  if (jumpStyle === "none" || crossings.length === 0) return `${path} L ${to.x} ${to.y}`;
  const horizontal = Math.abs(from.y - to.y) <= EPSILON;
  const direction = horizontal ? Math.sign(to.x - from.x) || 1 : Math.sign(to.y - from.y) || 1;
  const ordered = [...crossings].sort((a, b) => horizontal
    ? (a.x - b.x) * direction : (a.y - b.y) * direction);
  let nextPath = path;
  for (const crossing of ordered) {
    const before = horizontal ? { x: crossing.x - direction * 5, y: from.y } : { x: from.x, y: crossing.y - direction * 5 };
    const after = horizontal ? { x: crossing.x + direction * 5, y: from.y } : { x: from.x, y: crossing.y + direction * 5 };
    nextPath += ` L ${before.x} ${before.y}`;
    if (jumpStyle === "gap") nextPath += ` M ${after.x} ${after.y}`;
    else {
      const control = horizontal
        ? { x: crossing.x, y: crossing.y - 7 }
        : { x: crossing.x + 7, y: crossing.y };
      nextPath += ` Q ${control.x} ${control.y} ${after.x} ${after.y}`;
    }
  }
  return `${nextPath} L ${to.x} ${to.y}`;
}

export function diagramPolylinePath(
  pointsInput: readonly DiagramPoint[],
  crossings: readonly DiagramRouteCrossing[] = [],
  jumpStyle: "arc" | "gap" | "none" = "arc",
  radius = 10,
): string {
  const points = compactPoints(pointsInput);
  if (points.length < 2) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  let cursor = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const isCorner = index < points.length - 1;
    const corner = isCorner ? roundedCornerData(points, index, radius) : null;
    const segmentTarget = corner?.enter ?? points[index];
    const segmentCrossings = crossings.filter((crossing) => crossing.segmentIndex === index - 1);
    path = appendJumpSegment(path, cursor, segmentTarget, segmentCrossings, jumpStyle);
    if (corner) {
      path += ` Q ${points[index].x} ${points[index].y} ${corner.exit.x} ${corner.exit.y}`;
      cursor = corner.exit;
    } else cursor = segmentTarget;
  }
  return path;
}

export function diagramPathPointAt(points: readonly DiagramPoint[], position = 0.5): DiagramPoint {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  const target = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, position));
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (travelled + lengths[index] >= target) {
      const ratio = lengths[index] === 0 ? 0 : (target - travelled) / lengths[index];
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    travelled += lengths[index];
  }
  return points[points.length - 1];
}
