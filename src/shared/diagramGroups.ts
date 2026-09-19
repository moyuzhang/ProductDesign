import type { DiagramGroup, DiagramNode } from "./types.js";

export const DIAGRAM_GROUP_PADDING = 16;
const DEFAULT_NODE_WIDTH = 176;
const DEFAULT_NODE_HEIGHT = 46;

export interface DiagramGroupBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DiagramGroupOverlap {
  first: DiagramGroup;
  second: DiagramGroup;
  firstBounds: DiagramGroupBounds;
  secondBounds: DiagramGroupBounds;
}

type DiagramGroupLayout = {
  nodes: readonly DiagramNode[];
  groups: readonly DiagramGroup[];
};

export function diagramGroupBounds(
  group: DiagramGroup,
  nodes: readonly DiagramNode[],
): DiagramGroupBounds | null {
  const members = new Set(group.nodeIds);
  const groupedNodes = nodes.filter((node) => members.has(node.id));
  if (groupedNodes.length < 2) return null;
  return {
    left: Math.min(...groupedNodes.map((node) => node.x - (node.w ?? DEFAULT_NODE_WIDTH) / 2)) - DIAGRAM_GROUP_PADDING,
    top: Math.min(...groupedNodes.map((node) => node.y - (node.h ?? DEFAULT_NODE_HEIGHT) / 2)) - DIAGRAM_GROUP_PADDING,
    right: Math.max(...groupedNodes.map((node) => node.x + (node.w ?? DEFAULT_NODE_WIDTH) / 2)) + DIAGRAM_GROUP_PADDING,
    bottom: Math.max(...groupedNodes.map((node) => node.y + (node.h ?? DEFAULT_NODE_HEIGHT) / 2)) + DIAGRAM_GROUP_PADDING,
  };
}

function boundsOverlap(first: DiagramGroupBounds, second: DiagramGroupBounds): boolean {
  return first.left < second.right
    && first.right > second.left
    && first.top < second.bottom
    && first.bottom > second.top;
}

export function diagramGroupOverlapKey(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
}

export function listDiagramGroupOverlaps(layout: DiagramGroupLayout): DiagramGroupOverlap[] {
  const entries = layout.groups
    .map((group) => ({ group, bounds: diagramGroupBounds(group, layout.nodes) }))
    .filter((entry): entry is { group: DiagramGroup; bounds: DiagramGroupBounds } => entry.bounds !== null);
  const overlaps: DiagramGroupOverlap[] = [];
  for (let firstIndex = 0; firstIndex < entries.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < entries.length; secondIndex += 1) {
      const first = entries[firstIndex];
      const second = entries[secondIndex];
      if (!boundsOverlap(first.bounds, second.bounds)) continue;
      overlaps.push({
        first: first.group,
        second: second.group,
        firstBounds: first.bounds,
        secondBounds: second.bounds,
      });
    }
  }
  return overlaps;
}

export function findIntroducedDiagramGroupOverlap(
  before: DiagramGroupLayout,
  after: DiagramGroupLayout,
): DiagramGroupOverlap | null {
  const existing = new Set(listDiagramGroupOverlaps(before).map((overlap) => (
    diagramGroupOverlapKey(overlap.first.id, overlap.second.id)
  )));
  return listDiagramGroupOverlaps(after).find((overlap) => (
    !existing.has(diagramGroupOverlapKey(overlap.first.id, overlap.second.id))
  )) ?? null;
}

export function diagramGroupOverlapMessage(overlap: DiagramGroupOverlap): string {
  return `组合区域“${overlap.first.name}”与“${overlap.second.name}”不允许重叠`;
}

export function assertNoIntroducedDiagramGroupOverlap(
  before: DiagramGroupLayout,
  after: DiagramGroupLayout,
): void {
  const overlap = findIntroducedDiagramGroupOverlap(before, after);
  if (overlap) throw new Error(diagramGroupOverlapMessage(overlap));
}
