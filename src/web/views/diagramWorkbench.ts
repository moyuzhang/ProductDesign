import type { DiagramEdge, DiagramNode } from "../../shared/types";

export interface DiagramBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface AlignmentGuides {
  x?: number;
  y?: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: AlignmentGuides;
}

const nodeWidth = (node: DiagramNode): number => node.w ?? 176;
const nodeHeight = (node: DiagramNode): number => node.h ?? 46;

export function getDiagramBounds(nodes: DiagramNode[], padding = 80): DiagramBounds {
  if (nodes.length === 0) {
    return { minX: -padding, minY: -padding, maxX: padding, maxY: padding, width: padding * 2, height: padding * 2 };
  }
  const minX = Math.min(...nodes.map((node) => node.x - nodeWidth(node) / 2)) - padding;
  const minY = Math.min(...nodes.map((node) => node.y - nodeHeight(node) / 2)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.x + nodeWidth(node) / 2)) + padding;
  const maxY = Math.max(...nodes.map((node) => node.y + nodeHeight(node) / 2)) + padding;
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function relatedDiagramNodeIds(nodeId: string | null, edges: DiagramEdge[]): Set<string> {
  if (!nodeId) return new Set();
  const related = new Set([nodeId]);
  for (const edge of edges) {
    if (edge.from === nodeId) related.add(edge.to);
    if (edge.to === nodeId) related.add(edge.from);
  }
  return related;
}

function searchableNodeText(node: DiagramNode): string {
  return [node.label, node.description, node.owner, node.notes, node.kind].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

export function rankDiagramNodes(nodes: DiagramNode[], query: string, limit = 8): DiagramNode[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return nodes.slice(0, limit);
  return nodes
    .flatMap((node) => {
      const label = node.label.toLocaleLowerCase("zh-CN");
      const haystack = searchableNodeText(node);
      const index = haystack.indexOf(normalized);
      if (index < 0) return [];
      const score = label === normalized ? 0 : label.startsWith(normalized) ? 1 : label.includes(normalized) ? 2 : 3 + index / 1000;
      return [{ node, score }];
    })
    .sort((left, right) => left.score - right.score || left.node.label.localeCompare(right.node.label, "zh-CN"))
    .slice(0, limit)
    .map(({ node }) => node);
}

function nearestValue(value: number, candidates: number[], threshold: number): { value: number; guide?: number } {
  let best = value;
  let guide: number | undefined;
  let distance = threshold + 1;
  for (const candidate of candidates) {
    const nextDistance = Math.abs(candidate - value);
    if (nextDistance <= threshold && nextDistance < distance) {
      best = candidate;
      guide = candidate;
      distance = nextDistance;
    }
  }
  return { value: best, guide };
}

export function resolveDiagramSnap(
  anchor: { x: number; y: number },
  dx: number,
  dy: number,
  otherNodes: DiagramNode[],
  gridSize = 12,
  threshold = 6,
): SnapResult {
  const rawX = anchor.x + dx;
  const rawY = anchor.y + dy;
  const xCandidates = otherNodes.flatMap((node) => [node.x - nodeWidth(node) / 2, node.x, node.x + nodeWidth(node) / 2]);
  const yCandidates = otherNodes.flatMap((node) => [node.y - nodeHeight(node) / 2, node.y, node.y + nodeHeight(node) / 2]);
  const alignedX = nearestValue(rawX, xCandidates, threshold);
  const alignedY = nearestValue(rawY, yCandidates, threshold);
  const snappedX = alignedX.guide === undefined ? Math.round(rawX / gridSize) * gridSize : alignedX.value;
  const snappedY = alignedY.guide === undefined ? Math.round(rawY / gridSize) * gridSize : alignedY.value;
  return {
    dx: snappedX - anchor.x,
    dy: snappedY - anchor.y,
    guides: { x: alignedX.guide, y: alignedY.guide },
  };
}

export interface MiniMapProjection {
  scale: number;
  offsetX: number;
  offsetY: number;
  projectX: (x: number) => number;
  projectY: (y: number) => number;
}

export interface FloatingPanelPosition {
  x: number;
  y: number;
}

export interface FloatingPanelRect extends FloatingPanelPosition {
  width: number;
  height: number;
}

export function clampFloatingPanelPosition(
  position: FloatingPanelPosition,
  viewport: { width: number; height: number },
  panel: { width: number; height: number },
  margin = 12,
): FloatingPanelPosition {
  const maxX = Math.max(margin, viewport.width - panel.width - margin);
  const maxY = Math.max(margin, viewport.height - panel.height - margin);
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  };
}

function overlapArea(left: FloatingPanelRect, right: FloatingPanelRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

export function snapFloatingPanelToCorner(
  position: FloatingPanelPosition,
  viewport: { width: number; height: number },
  panel: { width: number; height: number },
  obstacles: FloatingPanelRect[] = [],
  margin = 12,
): FloatingPanelPosition {
  const candidates = [
    { x: margin, y: margin },
    { x: viewport.width - panel.width - margin, y: margin },
    { x: margin, y: viewport.height - panel.height - margin },
    { x: viewport.width - panel.width - margin, y: viewport.height - panel.height - margin },
  ].map((candidate) => clampFloatingPanelPosition(candidate, viewport, panel, margin));

  return candidates
    .map((candidate) => {
      const rect = { ...candidate, ...panel };
      const overlap = obstacles.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle), 0);
      const distance = Math.hypot(candidate.x - position.x, candidate.y - position.y);
      return { candidate, overlap, distance };
    })
    .sort((left, right) => left.overlap - right.overlap || left.distance - right.distance)[0].candidate;
}

export function createMiniMapProjection(bounds: DiagramBounds, width: number, height: number, padding = 10): MiniMapProjection {
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(innerWidth / bounds.width, innerHeight / bounds.height);
  const offsetX = padding + (innerWidth - bounds.width * scale) / 2 - bounds.minX * scale;
  const offsetY = padding + (innerHeight - bounds.height * scale) / 2 - bounds.minY * scale;
  return {
    scale,
    offsetX,
    offsetY,
    projectX: (x) => x * scale + offsetX,
    projectY: (y) => y * scale + offsetY,
  };
}
