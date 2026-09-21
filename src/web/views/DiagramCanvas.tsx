import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Crosshair, Download, ExternalLink, FolderPlus, Grid3X3, GripHorizontal, LocateFixed, Map as MapIcon, Maximize, Minimize, Plus, RotateCcw, RotateCw, Route, Search, Sparkles, Trash2, X } from "lucide-react";
import {
  DIAGRAM_FLOW_NODE_TYPES,
  DIAGRAM_NODE_KINDS,
  DIAGRAM_PORTS,
  DIAGRAM_USE_CASE_NODE_TYPES,
  DIAGRAM_USE_CASE_RELATION_TYPES,
  DESIGN_STATUSES,
  NODE_SHAPES,
  REQUIREMENT_STATUSES,
  type Diagram,
  type DiagramAcceptanceStatus,
  type DiagramDevelopmentStatus,
  type DiagramEdge,
  type DiagramFlowNodeType,
  type DiagramGroup,
  type DiagramLayerState,
  type DiagramNode,
  type DiagramNodeKind,
  type DiagramPoint,
  type DiagramPort,
  type DiagramType,
  type DiagramUseCaseNodeType,
  type DiagramUseCaseRelationType,
  type DesignStatus,
  type NodeShape,
  type RequirementStatus,
} from "../../shared/types";
import { buildLayerIndex, diagramPaintOrder, effectiveHidden, effectiveLocked, itemKeyOf } from "../../shared/layers";
import {
  diagramGroupBounds,
  diagramGroupOverlapMessage,
  findIntroducedDiagramGroupOverlap,
  listDiagramGroupOverlaps,
  type DiagramGroupOverlap,
} from "../../shared/diagramGroups";
import {
  diagramEdgeRoutingMode,
  diagramPathPointAt,
  diagramPolylinePath,
  routeDiagramEdges,
} from "../../shared/diagramRouting";
import { PROJECT_WORKFLOW_POLICY } from "../../shared/workflowPolicy";
import { Badge, formatDateTime } from "../ui";
import { layoutDiagram } from "./elkLayout";
import { clampFloatingPanelPosition, createMiniMapProjection, getDiagramBounds, rankDiagramNodes, relatedDiagramNodeIds, resolveDiagramSnap, snapFloatingPanelToCorner, type AlignmentGuides, type FloatingPanelPosition, type FloatingPanelRect } from "./diagramWorkbench";

const DEFAULT_W = 176;
const DEFAULT_H = 46;
const MIN_W = 90;
const MIN_H = 40;
const MARGIN = 40;
const INSPECTOR_MIN_WIDTH = 240;
const INSPECTOR_MAX_WIDTH = 420;

const clampInspectorWidth = (width: number): number => Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, width));

const NODE_STYLE: Record<DiagramNodeKind, { fill: string; stroke: string; text: string; dashed?: boolean }> = {
  system: { fill: "rgba(49,196,219,0.16)", stroke: "#31c4db", text: "#d4f8ff" },
  module: { fill: "rgba(77,163,255,0.16)", stroke: "#4da3ff", text: "#cfe4ff" },
  feature: { fill: "rgba(63,185,111,0.16)", stroke: "#3fb96f", text: "#bfe9cf" },
  requirement: { fill: "rgba(226,163,60,0.16)", stroke: "#e2a33c", text: "#f6e2bf" },
  interface: { fill: "rgba(168,120,235,0.16)", stroke: "#a878eb", text: "#e3d4fb" },
  data: { fill: "rgba(86,204,242,0.16)", stroke: "#56ccf2", text: "#cfeffb" },
  note: { fill: "rgba(159,176,191,0.08)", stroke: "#9fb0bf", text: "#cdd8e1", dashed: true },
};

const DEVELOPMENT_STATUS_META: Record<DiagramDevelopmentStatus, { color: string; short: string }> = {
  未开发: { color: "#718596", short: "未开发" },
  开发中: { color: "#4da3ff", short: "开发中" },
  待验收: { color: "#e2a33c", short: "待验收" },
  已完成: { color: "#3fb96f", short: "已完成" },
  已阻塞: { color: "#e05d5d", short: "已阻塞" },
};

const ACCEPTANCE_STATUS_META: Record<DiagramAcceptanceStatus, { color: string; short: string }> = {
  未验收: { color: "#718596", short: "未验收" },
  验收中: { color: "#a878eb", short: "验收中" },
  已通过: { color: "#3fb96f", short: "已通过" },
  未通过: { color: "#e05d5d", short: "未通过" },
};
const DELIVERY_DIAGRAM_TYPES = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryDiagramTypes);
const DELIVERY_NODE_KINDS = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryNodeKinds);

const KIND_LABELS: Record<DiagramNodeKind, string> = {
  system: "系统",
  module: "模块",
  feature: "功能",
  requirement: "需求",
  interface: "接口",
  data: "数据",
  note: "备注",
};

const FLOW_NODE_META: Record<DiagramFlowNodeType, { label: string; shape: NodeShape; kind: DiagramNodeKind }> = {
  start: { label: "开始", shape: "ellipse", kind: "system" },
  end: { label: "结束", shape: "ellipse", kind: "system" },
  process: { label: "处理 / 流程", shape: "rect", kind: "feature" },
  decision: { label: "判断", shape: "diamond", kind: "requirement" },
  input_output: { label: "输入 / 输出", shape: "parallelogram", kind: "data" },
  subprocess: { label: "预定义流程", shape: "predefined", kind: "interface" },
  document: { label: "文档", shape: "document", kind: "note" },
};

function flowTypeOf(node: DiagramNode): DiagramFlowNodeType {
  if (node.flowType) return node.flowType;
  if (node.shape === "diamond") return "decision";
  if (node.shape === "parallelogram") return "input_output";
  if (node.shape === "predefined" || node.shape === "hexagon") return "subprocess";
  if (node.shape === "document" || node.kind === "note") return "document";
  if (node.shape === "ellipse") return /结束|终止|完成/.test(node.label) ? "end" : "start";
  return "process";
}

const isDecisionNode = (node: DiagramNode): boolean => flowTypeOf(node) === "decision";

const USE_CASE_NODE_META: Record<DiagramUseCaseNodeType, { label: string; shape: NodeShape; kind: DiagramNodeKind }> = {
  actor: { label: "参与者", shape: "actor", kind: "interface" },
  usecase: { label: "用例", shape: "ellipse", kind: "requirement" },
  boundary: { label: "系统边界", shape: "boundary", kind: "system" },
};

function useCaseTypeOf(node: DiagramNode): DiagramUseCaseNodeType {
  if (node.useCaseType) return node.useCaseType;
  if (node.shape === "actor") return "actor";
  if (node.shape === "boundary") return "boundary";
  return "usecase";
}

const USE_CASE_RELATION_META: Record<DiagramUseCaseRelationType, { label: string; dash?: string; arrow: boolean }> = {
  association: { label: "", arrow: false },
  include: { label: "<<include>>", dash: "7 5", arrow: true },
  extend: { label: "<<extend>>", dash: "7 5", arrow: true },
  generalization: { label: "泛化", arrow: true },
};

function useCaseRelationKey(edge: DiagramEdge): string {
  const relationType = edge.relationType ?? "association";
  const endpoints = relationType === "association" ? [edge.from, edge.to].sort() : [edge.from, edge.to];
  return `${relationType}:${endpoints[0]}:${endpoints[1]}`;
}

const SHAPE_LABELS: Record<NodeShape, string> = {
  rect: "矩形",
  rounded: "圆角矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  hexagon: "六边形",
  parallelogram: "平行四边形",
  cylinder: "圆柱",
  predefined: "预定义流程",
  document: "文档",
  actor: "参与者",
  boundary: "系统边界",
};

const EDGE_LABEL_SUGGESTIONS: Record<DiagramType, string[]> = {
  main: ["包含", "入口", "依赖", "调用", "数据流"],
  free: [],
  functional: ["包含", "依赖", "调用", "实现"],
  flow: ["下一步", "是", "否", "异常", "返回"],
  deployment: ["部署于", "通信", "依赖", "读写"],
  usecase: ["关联", "<<include>>", "<<extend>>", "泛化"],
};

const DIAGRAM_TYPE_SHORT_LABELS: Record<DiagramType, string> = {
  main: "系统主画布",
  free: "自由",
  functional: "功能架构",
  flow: "业务流程",
  deployment: "部署架构",
  usecase: "用例图",
};

const uid = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const nodeW = (n: DiagramNode): number => n.w ?? DEFAULT_W;
const nodeH = (n: DiagramNode): number => n.h ?? DEFAULT_H;

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}

function cylinderPath(w: number, h: number): string {
  const ry = Math.min(14, h * 0.22);
  const top = -h / 2, bot = h / 2;
  return `M ${-w / 2} ${top + ry} A ${w / 2} ${ry} 0 0 1 ${w / 2} ${top + ry} V ${bot - ry} A ${w / 2} ${ry} 0 0 0 ${-w / 2} ${bot - ry} Z`;
}

function documentPath(w: number, h: number): string {
  const left = -w / 2, right = w / 2, top = -h / 2, bottom = h / 2;
  return `M ${left} ${top} H ${right} V ${bottom - 8} C ${w * 0.25} ${bottom + 2}, ${-w * 0.25} ${bottom - 18}, ${left} ${bottom - 8} Z`;
}

// render the node body by shape (defaults to rounded rectangle)
function nodeBody(node: DiagramNode, style: { fill: string; stroke: string; text: string; dashed?: boolean }, isSel: boolean, isTarget: boolean) {
  const w = nodeW(node), h = nodeH(node);
  const stroke = isSel ? "#ffffff" : style.stroke;
  const sw = isSel || isTarget ? 2.5 : 1.5;
  const dash = style.dashed ? "5 4" : undefined;
  const fill = style.fill;
  switch (node.shape) {
    case "actor": {
      const bodyStroke = isSel ? "#ffffff" : style.stroke;
      const headY = -h / 2 + 20;
      const bodyTop = headY + 10;
      const bodyBottom = h / 2 - 28;
      return <g fill="none" stroke={bodyStroke} strokeWidth={sw} strokeLinecap="round"><circle cx={0} cy={headY} r={9} /><line x1={0} y1={bodyTop} x2={0} y2={bodyBottom} /><line x1={-16} y1={bodyTop + 12} x2={16} y2={bodyTop + 12} /><line x1={0} y1={bodyBottom} x2={-15} y2={bodyBottom + 18} /><line x1={0} y1={bodyBottom} x2={15} y2={bodyBottom + 18} /></g>;
    }
    case "boundary": return <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={4} fill="rgba(49,196,219,0.025)" stroke={stroke} strokeWidth={sw} strokeDasharray="8 5" />;
    case "rect": return <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={3} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "ellipse": return <ellipse cx={0} cy={0} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "diamond": return <polygon points={`0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "hexagon": return <polygon points={`${-w / 2 + w * 0.25},${-h / 2} ${w / 2 - w * 0.25},${-h / 2} ${w / 2},0 ${w / 2 - w * 0.25},${h / 2} ${-w / 2 + w * 0.25},${h / 2} ${-w / 2},0`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "parallelogram": return <polygon points={`${-w / 2 + w * 0.18},${-h / 2} ${w / 2},${-h / 2} ${w / 2 - w * 0.18},${h / 2} ${-w / 2},${h / 2}`} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "cylinder": return <path d={cylinderPath(w, h)} fill={fill} stroke={stroke} strokeWidth={sw} />;
    case "predefined": return <g><rect x={-w / 2} y={-h / 2} width={w} height={h} rx={3} fill={fill} stroke={stroke} strokeWidth={sw} /><line x1={-w / 2 + 13} y1={-h / 2} x2={-w / 2 + 13} y2={h / 2} stroke={stroke} strokeWidth={sw} /><line x1={w / 2 - 13} y1={-h / 2} x2={w / 2 - 13} y2={h / 2} stroke={stroke} strokeWidth={sw} /></g>;
    case "document": return <path d={documentPath(w, h)} fill={fill} stroke={stroke} strokeWidth={sw} />;
    default: return <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={9} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />;
  }
}

// string version for SVG export
function nodeBodySvg(node: DiagramNode, st: { fill: string; stroke: string; text: string; dashed?: boolean }): string {
  const w = nodeW(node), h = nodeH(node);
  const fill = st.fill, stroke = st.stroke;
  switch (node.shape) {
    case "actor": {
      const headY = -h / 2 + 20, bodyTop = headY + 10, bodyBottom = h / 2 - 28;
      return `<g fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round"><circle cx="0" cy="${headY}" r="9"/><line x1="0" y1="${bodyTop}" x2="0" y2="${bodyBottom}"/><line x1="-16" y1="${bodyTop + 12}" x2="16" y2="${bodyTop + 12}"/><line x1="0" y1="${bodyBottom}" x2="-15" y2="${bodyBottom + 18}"/><line x1="0" y1="${bodyBottom}" x2="15" y2="${bodyBottom + 18}"/></g>`;
    }
    case "boundary": return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="4" fill="rgba(49,196,219,0.025)" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="8 5"/>`;
    case "rect": return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "ellipse": return `<ellipse cx="0" cy="0" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "diamond": return `<polygon points="0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "hexagon": return `<polygon points="${-w / 2 + w * 0.25},${-h / 2} ${w / 2 - w * 0.25},${-h / 2} ${w / 2},0 ${w / 2 - w * 0.25},${h / 2} ${-w / 2 + w * 0.25},${h / 2} ${-w / 2},0" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "parallelogram": return `<polygon points="${-w / 2 + w * 0.18},${-h / 2} ${w / 2},${-h / 2} ${w / 2 - w * 0.18},${h / 2} ${-w / 2},${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "cylinder": return `<path d="${cylinderPath(w, h)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    case "predefined": return `<g><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><line x1="${-w / 2 + 13}" y1="${-h / 2}" x2="${-w / 2 + 13}" y2="${h / 2}" stroke="${stroke}" stroke-width="1.5"/><line x1="${w / 2 - 13}" y1="${-h / 2}" x2="${w / 2 - 13}" y2="${h / 2}" stroke="${stroke}" stroke-width="1.5"/></g>`;
    case "document": return `<path d="${documentPath(w, h)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    default: return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${st.dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
  }
}

// pick the attachment point on a node's nearest-facing edge toward another point
function attachPoint(node: DiagramNode, toward: { x: number; y: number }): { x: number; y: number } {
  const w = nodeW(node), h = nodeH(node);
  const dx = toward.x - node.x, dy = toward.y - node.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { x: node.x + w / 2, y: node.y } : { x: node.x - w / 2, y: node.y };
  }
  return dy >= 0 ? { x: node.x, y: node.y + h / 2 } : { x: node.x, y: node.y - h / 2 };
}

type AttachmentSide = "top" | "right" | "bottom" | "left";

function attachmentSide(node: DiagramNode, toward: DiagramNode): AttachmentSide {
  const dx = toward.x - node.x, dy = toward.y - node.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function offsetAttachmentPoint(node: DiagramNode, side: AttachmentSide, offset: number): DiagramPoint {
  const rx = nodeW(node) / 2, ry = nodeH(node) / 2;
  if (node.shape === "ellipse") {
    if (side === "left" || side === "right") {
      const normalized = Math.max(-0.82, Math.min(0.82, offset / ry));
      return { x: node.x + (side === "right" ? 1 : -1) * rx * Math.sqrt(1 - normalized * normalized), y: node.y + normalized * ry };
    }
    const normalized = Math.max(-0.82, Math.min(0.82, offset / rx));
    return { x: node.x + normalized * rx, y: node.y + (side === "bottom" ? 1 : -1) * ry * Math.sqrt(1 - normalized * normalized) };
  }
  if (side === "left" || side === "right") {
    return { x: node.x + (side === "right" ? rx : -rx), y: node.y + Math.max(-ry + 12, Math.min(ry - 12, offset)) };
  }
  return { x: node.x + Math.max(-rx + 12, Math.min(rx - 12, offset)), y: node.y + (side === "bottom" ? ry : -ry) };
}

function useCaseAttachmentPoint(edge: DiagramEdge, node: DiagramNode, toward: DiagramNode, nodes: DiagramNode[], edges: DiagramEdge[]): DiagramPoint {
  const explicitPort = edge.from === node.id ? edge.sourcePort : edge.targetPort;
  const side: AttachmentSide = explicitPort ?? attachmentSide(node, toward);
  const incident = edges.flatMap((candidate) => {
    const otherId = candidate.from === node.id ? candidate.to : candidate.to === node.id ? candidate.from : null;
    const other = otherId ? nodes.find((item) => item.id === otherId) : undefined;
    const candidatePort = candidate.from === node.id ? candidate.sourcePort : candidate.to === node.id ? candidate.targetPort : undefined;
    const candidateSide = other ? candidatePort ?? attachmentSide(node, other) : undefined;
    return other && other.id !== node.id && candidateSide === side ? [{ edge: candidate, other }] : [];
  }).sort((left, right) => {
    const coordinate = side === "left" || side === "right" ? left.other.y - right.other.y : left.other.x - right.other.x;
    return coordinate || left.edge.id.localeCompare(right.edge.id);
  });
  if (incident.length <= 1) return offsetAttachmentPoint(node, side, 0);
  const index = incident.findIndex((item) => item.edge.id === edge.id);
  const available = Math.max(16, (side === "left" || side === "right" ? nodeH(node) : nodeW(node)) - 24);
  const step = Math.min(16, available / Math.max(1, incident.length - 1));
  return offsetAttachmentPoint(node, side, (index - (incident.length - 1) / 2) * step);
}

function outputPoint(node: DiagramNode, direction: "vertical" | "horizontal"): { x: number; y: number } {
  return direction === "vertical"
    ? { x: node.x, y: node.y + nodeH(node) / 2 }
    : { x: node.x + nodeW(node) / 2, y: node.y };
}

const PORT_VECTORS: Record<DiagramPort, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const PORT_LABELS: Record<DiagramPort, string> = { top: "上", right: "右", bottom: "下", left: "左" };

function portPoint(node: DiagramNode, port: DiagramPort): DiagramPoint {
  const halfW = nodeW(node) / 2, halfH = nodeH(node) / 2;
  if (port === "top") return { x: node.x, y: node.y - halfH };
  if (port === "right") return { x: node.x + halfW, y: node.y };
  if (port === "bottom") return { x: node.x, y: node.y + halfH };
  return { x: node.x - halfW, y: node.y };
}

function nearestPort(node: DiagramNode, point: DiagramPoint): DiagramPort {
  return DIAGRAM_PORTS.reduce((nearest, port) => {
    const candidate = portPoint(node, port);
    const current = portPoint(node, nearest);
    return Math.hypot(point.x - candidate.x, point.y - candidate.y) < Math.hypot(point.x - current.x, point.y - current.y)
      ? port
      : nearest;
  }, "top" as DiagramPort);
}

function offsetPortPoint(point: DiagramPoint, port: DiagramPort, distance: number): DiagramPoint {
  const vector = PORT_VECTORS[port];
  return { x: point.x + vector.x * distance, y: point.y + vector.y * distance };
}

function routeBetweenPorts(from: DiagramNode, to: DiagramNode, sourcePort: DiagramPort, targetPort: DiagramPort): DiagramPoint[] {
  const source = portPoint(from, sourcePort);
  const target = portPoint(to, targetPort);
  const sourceOut = offsetPortPoint(source, sourcePort, 22);
  const targetOut = offsetPortPoint(target, targetPort, 22);
  const sourceVertical = sourcePort === "top" || sourcePort === "bottom";
  const targetVertical = targetPort === "top" || targetPort === "bottom";
  if (sourceVertical && targetVertical) {
    const middleY = (sourceOut.y + targetOut.y) / 2;
    return compactRoutePoints([source, sourceOut, { x: sourceOut.x, y: middleY }, { x: targetOut.x, y: middleY }, targetOut, target]);
  }
  if (!sourceVertical && !targetVertical) {
    const middleX = (sourceOut.x + targetOut.x) / 2;
    return compactRoutePoints([source, sourceOut, { x: middleX, y: sourceOut.y }, { x: middleX, y: targetOut.y }, targetOut, target]);
  }
  return compactRoutePoints([source, sourceOut, { x: targetOut.x, y: sourceOut.y }, targetOut, target]);
}

function selfLoopRoute(node: DiagramNode, sourcePort: DiagramPort, targetPort: DiagramPort): DiagramPoint[] {
  const source = portPoint(node, sourcePort);
  const target = portPoint(node, targetPort);
  const gap = 54;
  const left = node.x - nodeW(node) / 2;
  const right = node.x + nodeW(node) / 2;
  const top = node.y - nodeH(node) / 2;
  const bottom = node.y + nodeH(node) / 2;
  const outer: Record<DiagramPort, DiagramPoint> = {
    top: { x: node.x, y: top - gap },
    right: { x: right + gap, y: node.y },
    bottom: { x: node.x, y: bottom + gap },
    left: { x: left - gap, y: node.y },
  };
  if (sourcePort === targetPort) {
    const sameSideRoutes: Record<DiagramPort, DiagramPoint[]> = {
      top: [source, outer.top, { x: right + gap, y: outer.top.y }, { x: right + gap, y: top }, target],
      right: [source, outer.right, { x: outer.right.x, y: bottom + gap }, { x: right, y: bottom + gap }, target],
      bottom: [source, outer.bottom, { x: left - gap, y: outer.bottom.y }, { x: left - gap, y: bottom }, target],
      left: [source, outer.left, { x: outer.left.x, y: top - gap }, { x: left, y: top - gap }, target],
    };
    return compactRoutePoints(sameSideRoutes[sourcePort]);
  }
  const clockwiseCorner: Record<DiagramPort, DiagramPoint> = {
    top: { x: right + gap, y: top - gap },
    right: { x: right + gap, y: bottom + gap },
    bottom: { x: left - gap, y: bottom + gap },
    left: { x: left - gap, y: top - gap },
  };
  const counterCorner: Record<DiagramPort, DiagramPoint> = {
    top: { x: left - gap, y: top - gap },
    right: { x: right + gap, y: top - gap },
    bottom: { x: right + gap, y: bottom + gap },
    left: { x: left - gap, y: bottom + gap },
  };
  const sourceIndex = DIAGRAM_PORTS.indexOf(sourcePort);
  const targetIndex = DIAGRAM_PORTS.indexOf(targetPort);
  const clockwiseSteps = (targetIndex - sourceIndex + DIAGRAM_PORTS.length) % DIAGRAM_PORTS.length;
  const counterSteps = (sourceIndex - targetIndex + DIAGRAM_PORTS.length) % DIAGRAM_PORTS.length;
  const clockwise = clockwiseSteps <= counterSteps;
  const points: DiagramPoint[] = [source, outer[sourcePort]];
  let current = sourcePort;
  while (current !== targetPort) {
    points.push(clockwise ? clockwiseCorner[current] : counterCorner[current]);
    const index = DIAGRAM_PORTS.indexOf(current);
    current = DIAGRAM_PORTS[(index + (clockwise ? 1 : -1) + DIAGRAM_PORTS.length) % DIAGRAM_PORTS.length];
  }
  points.push(outer[targetPort], target);
  return compactRoutePoints(points);
}

function fallbackEdgeRoute(edge: DiagramEdge, from: DiagramNode, to: DiagramNode): DiagramPoint[] | null {
  if (from.id === to.id) return selfLoopRoute(from, edge.sourcePort ?? "right", edge.targetPort ?? "top");
  if (edge.style === "straight" || edge.style === "curve") return null;
  if (!edge.sourcePort && !edge.targetPort) return null;
  const sourcePort = edge.sourcePort ?? nearestPort(from, to);
  const targetPort = edge.targetPort ?? nearestPort(to, from);
  return routeBetweenPorts(from, to, sourcePort, targetPort);
}

function clearEdgePoints(edges: DiagramEdge[]): DiagramEdge[] {
  return edges.map((edge) => (edge.points || edge.routingMode !== "auto"
    ? { ...edge, points: undefined, routingMode: "auto", routeVersion: 1 }
    : edge));
}

function clearEdgePointsForNodes(edges: DiagramEdge[], nodeIds: readonly string[]): DiagramEdge[] {
  const moved = new Set(nodeIds);
  return edges.map((edge) => (
    diagramEdgeRoutingMode(edge) === "auto" && (moved.has(edge.from) || moved.has(edge.to))
      ? { ...edge, points: undefined, routingMode: "auto", routeVersion: 1 }
      : edge
  ));
}

type NodeDelta = { x: number; y: number };

function nodeMoveDeltas(
  startNodes: ReadonlyArray<{ id: string; x: number; y: number }>,
  nodes: DiagramNode[],
): Map<string, NodeDelta> {
  const current = new Map(nodes.map((node) => [node.id, node]));
  const deltas = new Map<string, NodeDelta>();
  for (const start of startNodes) {
    const node = current.get(start.id);
    if (!node) continue;
    const delta = { x: node.x - start.x, y: node.y - start.y };
    if (Math.abs(delta.x) > 0.001 || Math.abs(delta.y) > 0.001) deltas.set(start.id, delta);
  }
  return deltas;
}

function compactRoutePoints(points: DiagramPoint[]): DiagramPoint[] {
  const unique = points.filter((point, index) => (
    index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
  ));
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

function moveRouteEndpoint(points: DiagramPoint[], atStart: boolean, delta: NodeDelta): DiagramPoint[] {
  const endpointIndex = atStart ? 0 : points.length - 1;
  const adjacentIndex = atStart ? 1 : points.length - 2;
  const endpoint = points[endpointIndex];
  const adjacent = points[adjacentIndex];
  const movedEndpoint = { x: endpoint.x + delta.x, y: endpoint.y + delta.y };
  const horizontal = Math.abs(endpoint.x - adjacent.x) >= Math.abs(endpoint.y - adjacent.y);

  if (points.length === 2) {
    const bend = horizontal
      ? { x: adjacent.x, y: movedEndpoint.y }
      : { x: movedEndpoint.x, y: adjacent.y };
    return compactRoutePoints(atStart
      ? [movedEndpoint, bend, adjacent]
      : [adjacent, bend, movedEndpoint]);
  }

  const moved = points.map((point) => ({ ...point }));
  moved[endpointIndex] = movedEndpoint;
  moved[adjacentIndex] = horizontal
    ? { ...moved[adjacentIndex], y: movedEndpoint.y }
    : { ...moved[adjacentIndex], x: movedEndpoint.x };
  return compactRoutePoints(moved);
}

function moveEdgePoints(edge: DiagramEdge, deltas: Map<string, NodeDelta>): DiagramPoint[] | undefined {
  const points = edge.points;
  if (!points || points.length < 2) return points;
  const sourceDelta = deltas.get(edge.from);
  const targetDelta = deltas.get(edge.to);
  if (!sourceDelta && !targetDelta) return points;
  if (sourceDelta && targetDelta && sourceDelta.x === targetDelta.x && sourceDelta.y === targetDelta.y) {
    return points.map((point) => ({ x: point.x + sourceDelta.x, y: point.y + sourceDelta.y }));
  }
  let moved = points;
  if (sourceDelta) moved = moveRouteEndpoint(moved, true, sourceDelta);
  if (targetDelta) moved = moveRouteEndpoint(moved, false, targetDelta);
  return moved;
}

function moveEdgeRoutes(edges: DiagramEdge[], deltas: Map<string, NodeDelta>): DiagramEdge[] {
  if (deltas.size === 0) return edges;
  return edges.map((edge) => {
    const points = moveEdgePoints(edge, deltas);
    return points === edge.points ? edge : { ...edge, points };
  });
}

// orthogonal (right-angle) route between two points, with rounded corners
function orthoPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx <= 0.5 && dy <= 0.5) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const R = Math.min(14, Math.min(dx, dy) / 2);
  const sxb = Math.sign(b.x - a.x) || 1;
  const syb = Math.sign(b.y - a.y) || 1;
  if (dx > dy) {
    const cx = (a.x + b.x) / 2;
    const r1 = Math.min(R, Math.abs(cx - a.x));
    const r2 = Math.min(R, Math.abs(cx - b.x));
    const rv = Math.min(R, Math.abs(b.y - a.y) / 2);
    return `M ${a.x} ${a.y} H ${cx - sxb * r1} Q ${cx} ${a.y} ${cx} ${a.y + syb * rv} V ${b.y - syb * rv} Q ${cx} ${b.y} ${cx + sxb * r2} ${b.y} H ${b.x}`;
  }
  const cy = (a.y + b.y) / 2;
  const r1 = Math.min(R, Math.abs(cy - a.y));
  const r2 = Math.min(R, Math.abs(cy - b.y));
  const rh = Math.min(R, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} V ${cy - syb * r1} Q ${a.x} ${cy} ${a.x + sxb * rh} ${cy} H ${b.x - sxb * rh} Q ${b.x} ${cy} ${b.x} ${cy + syb * r2} V ${b.y}`;
}

// smooth cubic bezier S-curve between two points
function curvePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  if (dx <= 0.5 && dy <= 0.5) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  if (dx >= dy) {
    return `M ${a.x} ${a.y} C ${cx} ${a.y}, ${cx} ${b.y}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} C ${a.x} ${cy}, ${b.x} ${cy}, ${b.x} ${b.y}`;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Turn an orthogonal polyline into an SVG path with rounded corners.
function polylineToPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return "";
  const pts = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = pts[pts.length - 1], b = points[i], c = points[i + 1];
    if ((b.x === a.x && b.x === c.x) || (b.y === a.y && b.y === c.y)) continue;
    pts.push(b);
  }
  pts.push(points[points.length - 1]);
  if (pts.length < 2) return `M ${points[0].x} ${points[0].y} L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
  const R = 10;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const iv = { x: Math.sign(p1.x - p0.x), y: Math.sign(p1.y - p0.y) };
    const ov = { x: Math.sign(p2.x - p1.x), y: Math.sign(p2.y - p1.y) };
    const r = Math.min(R, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2);
    d += ` L ${p1.x - iv.x * r} ${p1.y - iv.y * r} Q ${p1.x} ${p1.y} ${p1.x + ov.x * r} ${p1.y + ov.y * r}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function pathPointAt(points: Array<{ x: number; y: number }>, position = 0.5): { x: number; y: number } {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
  const target = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, position));
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (travelled + length >= target) {
      const ratio = length === 0 ? 0 : (target - travelled) / length;
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    travelled += length;
  }
  return points[points.length - 1];
}

function pathMidpoint(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  return pathPointAt(points, 0.5);
}

// Build a clean, content-fit, grid-free SVG string for export.
export function buildDiagramSvg(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  groups: DiagramGroup[],
  diagramType: DiagramType,
  layerState?: Pick<DiagramLayerState, "layers"> | null,
): string {
  if (nodes.length === 0) return "";
  const routeResults = routeDiagramEdges(nodes, edges);
  const pad = 44;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const n of nodes) {
    const w = nodeW(n), h = nodeH(n);
    expand(n.x - w / 2, n.y - h / 2); expand(n.x + w / 2, n.y + h / 2);
  }
  for (const g of groups) {
    for (const id of g.nodeIds) {
      const n = nodes.find((x) => x.id === id);
      if (!n) continue;
      const w = nodeW(n), h = nodeH(n);
      expand(n.x - w / 2 - 16, n.y - h / 2 - 16); expand(n.x + w / 2 + 16, n.y + h / 2 + 16);
    }
  }
  for (const edge of edges) {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const intelligentRoute = routeResults.get(edge.id);
    const route = diagramType !== "usecase" && (edge.style === "ortho" || diagramEdgeRoutingMode(edge) === "manual")
      ? intelligentRoute?.points
      : edge.points && edge.points.length >= 2 ? edge.points : fallbackEdgeRoute(edge, from, to);
    for (const point of route ?? []) expand(point.x, point.y);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return "";
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const W = maxX - minX, H = maxY - minY;

  const P: string[] = [];
  P.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${minX} ${minY} ${W} ${H}" font-family="IBM Plex Sans, Microsoft YaHei, system-ui, sans-serif">`);
  P.push('<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M0,0 L8,3 L0,6 Z" fill="context-stroke"/></marker><marker id="open-arrow" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto" markerUnits="strokeWidth"><path d="M1,1 L10,5 L1,9" fill="none" stroke="#8497aa" stroke-width="1.5"/></marker><marker id="uml-triangle" markerWidth="13" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M1,1 L11,6 L1,11 Z" fill="#111820" stroke="#8497aa" stroke-width="1.3"/></marker></defs>');
  P.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="#111820"/>`);
  for (const g of groups) {
    const members = g.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter((n): n is DiagramNode => !!n);
    if (members.length < 2) continue;
    const a = Math.min(...members.map((n) => n.x - nodeW(n) / 2));
    const b = Math.min(...members.map((n) => n.y - nodeH(n) / 2));
    const c = Math.max(...members.map((n) => n.x + nodeW(n) / 2));
    const d = Math.max(...members.map((n) => n.y + nodeH(n) / 2));
    P.push(`<rect x="${a - 16}" y="${b - 16}" width="${(c - a) + 32}" height="${(d - b) + 32}" rx="12" fill="rgba(83,126,148,0.05)" stroke="#52758a" stroke-width="1.2" stroke-dasharray="7 4"/>`);
    P.push(`<text x="${a - 8}" y="${b - 22}" font-size="11" fill="#7897a8">${escXml(g.name)} (${g.nodeIds.length})</text>`);
  }
  for (const paintLayer of diagramPaintOrder(layerState)) {
    if (paintLayer === "edge") for (const e of edges) {
    const f = nodes.find((n) => n.id === e.from);
    const t = nodes.find((n) => n.id === e.to);
    if (!f || !t) continue;
    const src = diagramType === "usecase" ? useCaseAttachmentPoint(e, f, t, nodes, edges)
      : e.sourcePort ? portPoint(f, e.sourcePort) : f.id === t.id ? portPoint(f, "right") : attachPoint(f, t);
    const dst = diagramType === "usecase" ? useCaseAttachmentPoint(e, t, f, nodes, edges)
      : e.targetPort ? portPoint(t, e.targetPort) : f.id === t.id ? portPoint(t, "top") : attachPoint(t, f);
    const routeResult = routeResults.get(e.id);
    const routedPoints = diagramType !== "usecase" && (e.style === "ortho" || diagramEdgeRoutingMode(e) === "manual")
      ? routeResult?.points
      : e.points && e.points.length >= 2 ? e.points : fallbackEdgeRoute(e, f, t);
    const relation = diagramType === "usecase" ? USE_CASE_RELATION_META[e.relationType ?? "association"] : null;
    const relationMarker = diagramType === "usecase"
      ? e.relationType === "generalization" ? ' marker-end="url(#uml-triangle)"'
        : e.relationType === "include" || e.relationType === "extend" ? ' marker-end="url(#open-arrow)"'
          : ""
      : e.arrow === "none" ? "" : ` marker-end="url(#arrow)"${e.arrow === "both" ? ' marker-start="url(#arrow)"' : ""}`;
    const dash = relation?.dash ?? (e.dash === "dashed" ? "8 5" : e.dash === "dotted" ? "2 5" : "");
    const relationAttrs = `${dash ? ` stroke-dasharray="${dash}"` : ""}${relationMarker}`;
    const color = e.color ?? "#8497aa";
    const width = Math.max(1, Math.min(8, e.width ?? 2));
    if (routedPoints) {
      P.push(`<path d="${diagramPolylinePath(routedPoints, routeResult?.crossings, e.jumpStyle ?? "arc")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${relationAttrs}/>`);
    } else if (e.style === "straight") {
      P.push(`<line x1="${src.x}" y1="${src.y}" x2="${dst.x}" y2="${dst.y}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${relationAttrs}/>`);
    } else {
      const d = e.style === "curve" ? curvePath(src, dst) : orthoPath(src, dst);
      P.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${relationAttrs}/>`);
    }
    const edgeLabel = e.label || relation?.label;
    if (edgeLabel) {
      const midpoint = routeResult?.labelPoint ?? diagramPathPointAt(routedPoints ?? [src, dst], e.labelPosition ?? 0.5);
      const labelWidth = Math.max(42, edgeLabel.length * 7 + 18);
      P.push(`<rect x="${midpoint.x - labelWidth / 2}" y="${midpoint.y - 17}" width="${labelWidth}" height="20" rx="7" fill="#0b161e" stroke="#2c4353" stroke-width="0.9"/>`);
      P.push(`<text x="${midpoint.x}" y="${midpoint.y - 3.5}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#a9bac7">${escXml(edgeLabel)}</text>`);
    }
    }
    if (paintLayer === "node") for (const n of nodes) {
    const st = NODE_STYLE[n.kind];
    const w = nodeW(n), h = nodeH(n);
    P.push(`<g transform="translate(${n.x},${n.y})">`);
    P.push(nodeBodySvg(n, st));
    if (diagramType !== "flow" && diagramType !== "usecase") {
      P.push(`<text x="${-w / 2 + 10}" y="${-h / 2 + 10}" font-size="9" fill="${st.text}" opacity="0.7">${escXml(KIND_LABELS[n.kind])}</text>`);
    }
    const labelY = diagramType === "usecase" && useCaseTypeOf(n) === "actor" ? h / 2 - 5 : diagramType === "usecase" && useCaseTypeOf(n) === "boundary" ? -h / 2 + 20 : 1;
    P.push(`<text x="0" y="${labelY}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="600" fill="${st.text}">${escXml(n.label)}</text>`);
    if (DELIVERY_DIAGRAM_TYPES.has(diagramType) && DELIVERY_NODE_KINDS.has(n.kind)) {
      const developmentStatus = n.developmentStatus ?? "未开发";
      const acceptanceStatus = n.acceptanceStatus ?? "未验收";
      const developmentMeta = DEVELOPMENT_STATUS_META[developmentStatus];
      const acceptanceMeta = ACCEPTANCE_STATUS_META[acceptanceStatus];
      P.push(`<circle cx="${-w / 2 + 11}" cy="${h / 2 - 7}" r="3.2" fill="${developmentMeta.color}"/>`);
      P.push(`<text x="${-w / 2 + 18}" y="${h / 2 - 4}" font-size="8.5" fill="#9fb0bf">${escXml(`开发 · ${developmentMeta.short}`)}</text>`);
      P.push(`<circle cx="${w < 150 ? 8 : w / 2 - 65}" cy="${h / 2 - 7}" r="3.2" fill="${acceptanceMeta.color}"/>`);
      P.push(`<text x="${w < 150 ? 15 : w / 2 - 58}" y="${h / 2 - 4}" font-size="8.5" fill="#9fb0bf">${escXml(`验收 · ${acceptanceMeta.short}`)}</text>`);
      const subLinkCount = (n.linkDiagramIds ?? []).length;
      if (subLinkCount > 0) P.push(`<text x="0" y="${h / 2 + 14}" text-anchor="middle" font-size="11" fill="#8ec4ff">⤷ 子画布${subLinkCount > 1 ? ` ×${subLinkCount}` : ""}</text>`);
    }
    P.push(`</g>`);
    }
  }
  P.push("</svg>");
  return P.join("");
}

type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "distH" | "distV";
type NodeInspectorTab = "basic" | "delivery" | "acceptance";

export interface DiagramPlanSummary {
  total: number;
  completed: number;
  progress: number;
  currentTitle?: string;
  nextTitle?: string;
}
const ALIGN_LABELS: Record<AlignKind, string> = {
  left: "左对齐", hcenter: "水平居中", right: "右对齐",
  top: "顶对齐", vcenter: "垂直居中", bottom: "底对齐",
  distH: "水平等距", distV: "垂直等距",
};

type Gesture =
  | { type: "none" }
  | { type: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { type: "move"; fromWorld: { x: number; y: number }; startNodes: Array<{ id: string; x: number; y: number }> }
  | { type: "edge"; fromId: string; sourcePort: DiagramPort; curX: number; curY: number; defaultLabel?: string }
  | { type: "edge-endpoint"; edgeId: string; endpoint: "source" | "target" }
  | { type: "edge-bend"; edgeId: string; pointIndex: number; points: DiagramPoint[] }
  | { type: "resize"; id: string; startW: number; startH: number; startWorld: { x: number; y: number } }
  | { type: "box"; startWorld: { x: number; y: number }; curWorld: { x: number; y: number } };

export interface SubCanvasOpenChoice {
  id: string;
  title: string;
  available: boolean;
}

export function resolveSubCanvasOpenIntent(
  linkDiagramIds: string[],
  linkOptions: Array<{ id: string; title: string }>,
): { directId: string | null; choices: SubCanvasOpenChoice[] } {
  const uniqueIds = [...new Set(linkDiagramIds.filter(Boolean))];
  const choices = uniqueIds.map((id) => {
    const option = linkOptions.find((item) => item.id === id);
    return { id, title: option?.title ?? "已删除的画布", available: Boolean(option) };
  });
  return { directId: choices.length === 1 ? choices[0].id : null, choices };
}

export interface DiagramCanvasApi {
  insertNode: (kind: DiagramNodeKind, shape?: NodeShape, label?: string, flowType?: DiagramFlowNodeType, useCaseType?: DiagramUseCaseNodeType) => void;
  selectItems: (itemKeys: string[]) => void;
}

export function DiagramCanvas(props: {
  initial: Pick<Diagram, "nodes" | "edges" | "groups">;
  diagramType: DiagramType;
  planSummaries?: Record<string, DiagramPlanSummary>;
  initialSelectedNodeId?: string;
  viewportKey?: string;
  onCommit: (nodes: DiagramNode[], edges: DiagramEdge[], groups: DiagramGroup[]) => void;
  linkOptions: Array<{ id: string; title: string }>;
  onOpenDiagram: (id: string) => void;
  onOpenNodeDetails: (id: string, tab?: string) => void;
  titleForExport?: string;
  onExtractToNewCanvas?: (payload: { nodes: DiagramNode[]; edges: DiagramEdge[]; title: string; sourceNodeIds: string[] }) => void;
  onRegisterApi?: (api: DiagramCanvasApi) => void;
  onSelectionChange?: (selection: { nodeIds: string[]; edgeIds: string[]; groupIds: string[] }) => void;
  layerState?: DiagramLayerState | null;
  keyboardDisabled?: boolean;
}): ReactElement {
  const [nodes, setNodes] = useState<DiagramNode[]>(props.initial.nodes);
  const [edges, setEdges] = useState<DiagramEdge[]>(props.initial.edges);
  const [groups, setGroups] = useState<DiagramGroup[]>(props.initial.groups ?? []);
  const layerIndex = useMemo(() => buildLayerIndex({ diagram: { nodes, edges } }), [nodes, edges]);
  const layerAccess = useMemo(() => {
    const hiddenNodeIds = new Set<string>(), lockedNodeIds = new Set<string>();
    const hiddenEdgeIds = new Set<string>(), lockedEdgeIds = new Set<string>();
    if (!props.layerState) return { hiddenNodeIds, lockedNodeIds, hiddenEdgeIds, lockedEdgeIds };
    for (const node of nodes) {
      const key = itemKeyOf("node", node.id);
      if (effectiveHidden(props.layerState, layerIndex, key)) hiddenNodeIds.add(node.id);
      if (effectiveLocked(props.layerState, layerIndex, key)) lockedNodeIds.add(node.id);
    }
    for (const edge of edges) {
      const key = itemKeyOf("edge", edge.id);
      if (effectiveHidden(props.layerState, layerIndex, key)) hiddenEdgeIds.add(edge.id);
      if (effectiveLocked(props.layerState, layerIndex, key)) lockedEdgeIds.add(edge.id);
    }
    return { hiddenNodeIds, lockedNodeIds, hiddenEdgeIds, lockedEdgeIds };
  }, [edges, layerIndex, nodes, props.layerState]);
  const visibleNodes = useMemo(() => nodes.filter((node) => !layerAccess.hiddenNodeIds.has(node.id)), [layerAccess.hiddenNodeIds, nodes]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => edges.filter((edge) => !layerAccess.hiddenEdgeIds.has(edge.id)
    && visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to)), [edges, layerAccess.hiddenEdgeIds, visibleNodeIds]);
  const visibleGroups = useMemo(() => groups
    .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => visibleNodeIds.has(id)) }))
    .filter((group) => group.nodeIds.length > 0), [groups, visibleNodeIds]);
  const paintOrder = useMemo(() => diagramPaintOrder(props.layerState), [props.layerState]);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    props.initialSelectedNodeId && props.initial.nodes.some((node) => node.id === props.initialSelectedNodeId)
      ? [props.initialSelectedNodeId]
      : [],
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupCollision, setGroupCollision] = useState<DiagramGroupOverlap | null>(null);
  const [inspectorError, setInspectorError] = useState("");
  const [preview, setPreview] = useState<{ fromId: string; sourcePort: DiagramPort; x: number; y: number } | null>(null);
  const [edgeEndpointPreview, setEdgeEndpointPreview] = useState<{ edgeId: string; endpoint: "source" | "target"; x: number; y: number } | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [boxState, setBoxState] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const savedViewport = useRef((() => {
    if (!props.viewportKey) return null;
    try {
      const value = JSON.parse(sessionStorage.getItem(`diagram-viewport:${props.viewportKey}`) ?? "null") as { zoom?: number; pan?: { x?: number; y?: number } } | null;
      if (value && typeof value.zoom === "number" && typeof value.pan?.x === "number" && typeof value.pan?.y === "number") {
        return { zoom: value.zoom, pan: { x: value.pan.x, y: value.pan.y } };
      }
    } catch { /* ignore invalid session state */ }
    return null;
  })()).current;
  const [zoom, setZoom] = useState(savedViewport?.zoom ?? 1);
  const [pan, setPan] = useState(savedViewport?.pan ?? { x: 60, y: 60 });
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;
  const [treeDir, setTreeDir] = useState<"vertical" | "horizontal">("vertical");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState("");
  const [nodeInspectorTab, setNodeInspectorTab] = useState<NodeInspectorTab>("basic");
  const [subCanvasPicker, setSubCanvasPicker] = useState<{
    nodeLabel: string;
    choices: SubCanvasOpenChoice[];
    left: number;
    top: number;
  } | null>(null);
  const [addKindSel, setAddKindSel] = useState<DiagramNodeKind>("feature");  const addKind = useRef<DiagramNodeKind>("feature");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const gesture = useRef<Gesture>({ type: "none" });
  const [fullscreen, setFullscreen] = useState(false);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const miniMapRef = useRef<HTMLDivElement | null>(null);
  const miniMapDrag = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    start: FloatingPanelPosition;
  } | null>(null);
  const [gridVisible, setGridVisible] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [miniMapVisible, setMiniMapVisible] = useState(true);
  const [miniMapDragging, setMiniMapDragging] = useState(false);
  const [miniMapPosition, setMiniMapPosition] = useState<FloatingPanelPosition | null>(() => {
    if (!props.viewportKey) return null;
    try {
      const value = JSON.parse(sessionStorage.getItem(`diagram-minimap:${props.viewportKey}`) ?? "null") as Partial<FloatingPanelPosition> | null;
      return typeof value?.x === "number" && typeof value?.y === "number" ? { x: value.x, y: value.y } : null;
    } catch { return null; }
  });
  const miniMapViewportKey = useRef(props.viewportKey);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    if (!props.viewportKey) return 320;
    try {
      const value = Number(sessionStorage.getItem(`diagram-inspector-width:${props.viewportKey}`));
      return Number.isFinite(value) && value > 0 ? clampInspectorWidth(value) : 320;
    } catch { return 320; }
  });
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => {
    if (!props.viewportKey) return false;
    try { return sessionStorage.getItem(`diagram-inspector-collapsed:${props.viewportKey}`) === "true"; }
    catch { return false; }
  });
  const [focusMode, setFocusMode] = useState(false);
  const inspectorResize = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides>({});
  const commandInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!commandOpen) return;
    requestAnimationFrame(() => commandInputRef.current?.focus());
  }, [commandOpen]);

  useEffect(() => {
    props.onSelectionChange?.({
      nodeIds: selectedIds,
      edgeIds: selectedEdgeId ? [selectedEdgeId] : [],
      groupIds: selectedGroupId ? [selectedGroupId] : [],
    });
  }, [props.onSelectionChange, selectedEdgeId, selectedGroupId, selectedIds]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => !layerAccess.hiddenNodeIds.has(id)));
    setSelectedEdgeId((current) => current && layerAccess.hiddenEdgeIds.has(current) ? null : current);
  }, [layerAccess.hiddenEdgeIds, layerAccess.hiddenNodeIds]);

  useEffect(() => {
    setSubCanvasPicker(null);
  }, [props.viewportKey]);

  useEffect(() => {
    if (miniMapViewportKey.current === props.viewportKey) return;
    miniMapViewportKey.current = props.viewportKey;
    if (!props.viewportKey) {
      setMiniMapPosition(null);
      return;
    }
    try {
      const value = JSON.parse(sessionStorage.getItem(`diagram-minimap:${props.viewportKey}`) ?? "null") as Partial<FloatingPanelPosition> | null;
      setMiniMapPosition(typeof value?.x === "number" && typeof value?.y === "number" ? { x: value.x, y: value.y } : null);
    } catch { setMiniMapPosition(null); }
  }, [props.viewportKey]);

  useEffect(() => {
    if (!props.viewportKey) return;
    try {
      const width = Number(sessionStorage.getItem(`diagram-inspector-width:${props.viewportKey}`));
      setInspectorWidth(Number.isFinite(width) && width > 0 ? clampInspectorWidth(width) : 320);
      setInspectorCollapsed(sessionStorage.getItem(`diagram-inspector-collapsed:${props.viewportKey}`) === "true");
    } catch {
      setInspectorWidth(320);
      setInspectorCollapsed(false);
    }
  }, [props.viewportKey]);

  useEffect(() => {
    if (!props.viewportKey) return;
    try { sessionStorage.setItem(`diagram-inspector-width:${props.viewportKey}`, String(inspectorWidth)); } catch { /* storage may be unavailable */ }
  }, [inspectorWidth, props.viewportKey]);

  useEffect(() => {
    if (!props.viewportKey) return;
    try { sessionStorage.setItem(`diagram-inspector-collapsed:${props.viewportKey}`, String(inspectorCollapsed)); } catch { /* storage may be unavailable */ }
  }, [inspectorCollapsed, props.viewportKey]);

  useEffect(() => {
    document.documentElement.classList.toggle("canvas-focus-mode-active", focusMode);
    return () => document.documentElement.classList.remove("canvas-focus-mode-active");
  }, [focusMode]);

  const persistMiniMapPosition = (position: FloatingPanelPosition) => {
    setMiniMapPosition(position);
    if (props.viewportKey) sessionStorage.setItem(`diagram-minimap:${props.viewportKey}`, JSON.stringify(position));
  };

  const currentMiniMapPosition = (): FloatingPanelPosition | null => {
    const viewport = canvasViewportRef.current;
    const panel = miniMapRef.current;
    if (!viewport || !panel) return null;
    const viewportRect = viewport.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return { x: panelRect.left - viewportRect.left, y: panelRect.top - viewportRect.top };
  };

  const moveMiniMap = (position: FloatingPanelPosition) => {
    const viewport = canvasViewportRef.current;
    const panel = miniMapRef.current;
    if (!viewport || !panel) return;
    const safeWidth = svgRef.current?.clientWidth ?? viewport.clientWidth;
    persistMiniMapPosition(clampFloatingPanelPosition(
      position,
      { width: safeWidth, height: viewport.clientHeight },
      { width: panel.offsetWidth, height: panel.offsetHeight },
      12,
    ));
  };

  const miniMapObstacles = (): FloatingPanelRect[] => {
    const viewport = canvasViewportRef.current;
    if (!viewport) return [];
    const viewportRect = viewport.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(".agent-dock, .agent-launcher")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.right > viewportRect.left && rect.left < viewportRect.right && rect.bottom > viewportRect.top && rect.top < viewportRect.bottom)
      .map((rect) => ({ x: rect.left - viewportRect.left, y: rect.top - viewportRect.top, width: rect.width, height: rect.height }));
  };

  const snapMiniMap = (position?: FloatingPanelPosition | null) => {
    const viewport = canvasViewportRef.current;
    const panel = miniMapRef.current;
    if (!viewport || !panel) return;
    const safeViewport = { width: svgRef.current?.clientWidth ?? viewport.clientWidth, height: viewport.clientHeight };
    const current = position ?? currentMiniMapPosition();
    if (!current) return;
    persistMiniMapPosition(snapFloatingPanelToCorner(
      current,
      safeViewport,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      miniMapObstacles(),
      12,
    ));
  };

  useEffect(() => {
    if (!miniMapVisible || focusMode) return;
    let frame = 0;
    const reposition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => snapMiniMap());
    };
    reposition();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (canvasViewportRef.current) resizeObserver?.observe(canvasViewportRef.current);
    if (svgRef.current) resizeObserver?.observe(svgRef.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("agent-dock-geometry-change", reposition);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("agent-dock-geometry-change", reposition);
    };
  }, [focusMode, inspectorCollapsed, inspectorWidth, miniMapVisible, props.viewportKey]);

  useEffect(() => {
    if (!subCanvasPicker || props.keyboardDisabled) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSubCanvasPicker(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [props.keyboardDisabled, subCanvasPicker]);

  const openLinkedCanvases = (node: DiagramNode, clientX?: number, clientY?: number) => {
    const intent = resolveSubCanvasOpenIntent(node.linkDiagramIds ?? [], props.linkOptions ?? []);
    if (intent.directId) {
      props.onOpenDiagram(intent.directId);
      return;
    }
    if (intent.choices.length === 0) return;

    const svgRect = svgRef.current?.getBoundingClientRect();
    const anchorX = clientX ?? (svgRect ? svgRect.left + pan.x + node.x * zoom : window.innerWidth / 2);
    const anchorY = clientY ?? (svgRect ? svgRect.top + pan.y + (node.y + nodeH(node) / 2) * zoom : window.innerHeight / 2);
    const menuWidth = 286;
    const menuHeight = Math.min(360, 58 + intent.choices.length * 48);
    const left = Math.min(Math.max(12, anchorX - menuWidth / 2), Math.max(12, window.innerWidth - menuWidth - 12));
    const belowTop = anchorY + 14;
    const top = belowTop + menuHeight <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, anchorY - menuHeight - 14);
    setSubCanvasPicker({ nodeLabel: node.label, choices: intent.choices, left, top });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Ctrl/⌘+滚轮：以光标为中心缩放画布。non-passive 监听 + preventDefault 可拦截浏览器页面缩放，
        // 让滚轮只缩放画布本身；触控板两指捏合（浏览器发 ctrlKey wheel）也走这里。
        const rect = svg.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.1 : 0.9;
        const next = Math.max(0.3, Math.min(2.5, zoomRef.current * factor));
        const wx = (mx - panRef.current.x) / zoomRef.current;
        const wy = (my - panRef.current.y) / zoomRef.current;
        setZoom(next);
        setPan({ x: mx - wx * next, y: my - wy * next });
        return;
      }
      if (event.shiftKey) {
        // 左右平移（保留已解决的行为；普通鼠标只有 deltaY，用 Shift 借它平移左右）
        const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        setPan((value) => ({ x: value.x - delta, y: value.y }));
        return;
      }
      // 默认滚轮：上下平移（deltaY），并跟随横向滚轮/触控板左右（deltaX）
      setPan((value) => ({ x: value.x - event.deltaX, y: value.y - event.deltaY }));
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    setTreeDir(props.diagramType === "deployment" ? "horizontal" : "vertical");
  }, [props.diagramType]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }, [pan, zoom]);

  const hitNode = useCallback((wx: number, wy: number): string | null => {
    const candidates = [...visibleNodes].reverse();
    for (const n of candidates) {
      if (wx >= n.x - nodeW(n) / 2 && wx <= n.x + nodeW(n) / 2 && wy >= n.y - nodeH(n) / 2 && wy <= n.y + nodeH(n) / 2) {
        return n.id;
      }
    }
    return null;
  }, [visibleNodes]);

  const commit = useCallback((nextNodes: DiagramNode[], nextEdges: DiagramEdge[], nextGroups: DiagramGroup[]) => {
    props.onCommit(nextNodes, nextEdges, nextGroups);
  }, [props]);

  type Snapshot = { nodes: DiagramNode[]; edges: DiagramEdge[]; groups: DiagramGroup[] };
  const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  useEffect(() => { historyRef.current = { past: [], future: [] }; }, [props.layerState]);
  const dragBefore = useRef<Snapshot | null>(null);
  const snapshot = useCallback((): Snapshot => ({ nodes, edges, groups }), [nodes, edges, groups]);
  const recordHistory = useCallback((before: Snapshot) => {
    const h = historyRef.current;
    h.past.push(before);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
  }, []);
  const applyChange = useCallback(
    (nextNodes: DiagramNode[], nextEdges: DiagramEdge[], nextGroups: DiagramGroup[], before: Snapshot) => {
      const overlap = findIntroducedDiagramGroupOverlap({ nodes, groups }, { nodes: nextNodes, groups: nextGroups });
      if (overlap) {
        setGroupCollision(overlap);
        return false;
      }
      setGroupCollision(null);
      recordHistory(before);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setGroups(nextGroups);
      commit(nextNodes, nextEdges, nextGroups);
      return true;
    },
    [recordHistory, commit, nodes, groups],
  );
  const undo = useCallback(() => {
    const h = historyRef.current;
    const prev = h.past.pop();
    if (!prev) return;
    const current = snapshot();
    const overlap = findIntroducedDiagramGroupOverlap(current, prev);
    if (overlap) {
      h.past.push(prev);
      setGroupCollision(overlap);
      return;
    }
    setGroupCollision(null);
    h.future.push(current);
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setGroups(prev.groups);
    commit(prev.nodes, prev.edges, prev.groups);
  }, [snapshot, commit]);
  const redo = useCallback(() => {
    const h = historyRef.current;
    const nxt = h.future.pop();
    if (!nxt) return;
    const current = snapshot();
    const overlap = findIntroducedDiagramGroupOverlap(current, nxt);
    if (overlap) {
      h.future.push(nxt);
      setGroupCollision(overlap);
      return;
    }
    setGroupCollision(null);
    h.past.push(current);
    setNodes(nxt.nodes);
    setEdges(nxt.edges);
    setGroups(nxt.groups);
    commit(nxt.nodes, nxt.edges, nxt.groups);
  }, [snapshot, commit]);

  const clearSelected = useCallback(() => {
    setSelectedIds([]);
    setSelectedEdgeId(null);
    setSelectedGroupId(null);
    setGroupCollision(null);
    setInspectorError("");
  }, []);

  const isLabelTaken = useCallback((label: string, excludeId: string | null): boolean =>
    nodes.some((n) => n.label.trim() === label.trim() && n.id !== excludeId), [nodes]);

  // ---------- selection actions ----------

  const applyAlign = useCallback((kind: AlignKind) => {
    const sel = nodes.filter((n) => selectedIds.includes(n.id) && !layerAccess.lockedNodeIds.has(n.id));
    if (sel.length < 2) return;
    const xs = sel.map((n) => n.x);
    const ys = sel.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    const set = new Set(sel.map((node) => node.id));
    let next: DiagramNode[];
    if (kind === "distH" || kind === "distV") {
      const axis = kind === "distH" ? "x" : "y";
      const ordered = [...sel].sort((a, b) => a[axis] - b[axis]);
      if (ordered.length < 3) return;
      const first = ordered[0][axis], last = ordered[ordered.length - 1][axis];
      const step = (last - first) / (ordered.length - 1);
      const pos = new Map(ordered.map((n, i) => [n.id, first + step * i]));
      next = nodes.map((n) => (pos.has(n.id) ? { ...n, [axis]: pos.get(n.id)! } : n));
    } else {
      next = nodes.map((n) => {
        if (!set.has(n.id)) return n;
        let nx = n.x, ny = n.y;
        if (kind === "left") nx = minX;
        else if (kind === "right") nx = maxX;
        else if (kind === "hcenter") nx = midX;
        else if (kind === "top") ny = minY;
        else if (kind === "bottom") ny = maxY;
        else if (kind === "vcenter") ny = midY;
        return { ...n, x: nx, y: ny };
      });
    }
    applyChange(next, clearEdgePoints(edges), groups, snapshot());
  }, [nodes, edges, selectedIds, groups, applyChange, snapshot, layerAccess.lockedNodeIds]);

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const set = new Set(selectedIds.filter((id) => !layerAccess.lockedNodeIds.has(id)
      && !edges.some((edge) => layerAccess.lockedEdgeIds.has(edge.id) && (edge.from === id || edge.to === id))));
    if (set.size === 0) return;
    const nextNodes = nodes.filter((n) => !set.has(n.id));
    const nextEdges = edges.filter((e) => !set.has(e.from) && !set.has(e.to));
    const nextGroups = groups
      .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => !set.has(id)) }))
      .filter((g) => g.nodeIds.length >= 2);
    setSelectedIds([]);
    setSelectedEdgeId(null);
    setSelectedGroupId(null);
    applyChange(nextNodes, nextEdges, nextGroups, snapshot());
  }, [nodes, edges, groups, selectedIds, applyChange, snapshot, layerAccess.lockedEdgeIds, layerAccess.lockedNodeIds]);

  const deleteEdge = useCallback((id: string) => {
    if (layerAccess.lockedEdgeIds.has(id)) return;
    const nextEdges = edges.filter((e) => e.id !== id);
    setSelectedEdgeId((x) => (x === id ? null : x));
    applyChange(nodes, nextEdges, groups, snapshot());
  }, [edges, nodes, groups, applyChange, snapshot, layerAccess.lockedEdgeIds]);

  const updateEdge = useCallback((id: string, patch: Partial<DiagramEdge>) => {
    if (layerAccess.lockedEdgeIds.has(id)) return;
    const routeChanged = patch.style !== undefined || patch.sourcePort !== undefined || patch.targetPort !== undefined;
    const hasPointsPatch = Object.prototype.hasOwnProperty.call(patch, "points");
    const next = edges.map((e) => (e.id === id ? {
      ...e,
      ...patch,
      points: routeChanged ? undefined : hasPointsPatch ? patch.points : e.points,
      routingMode: routeChanged ? "auto" : patch.routingMode ?? e.routingMode,
      routeVersion: routeChanged ? 1 : patch.routeVersion ?? e.routeVersion,
    } : e));
    applyChange(nodes, next, groups, snapshot());
  }, [edges, groups, applyChange, snapshot, layerAccess.lockedEdgeIds]);

  // ---------- global pointer handlers ----------

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (g.type === "pan") {
        setPan({ x: g.panX + (e.clientX - g.startX), y: g.panY + (e.clientY - g.startY) });
      } else if (g.type === "move") {
        const w = toWorld(e.clientX, e.clientY);
        const rawDx = w.x - g.fromWorld.x;
        const rawDy = w.y - g.fromWorld.y;
        const anchor = g.startNodes[g.startNodes.length - 1];
        const movingIds = new Set(g.startNodes.map((node) => node.id));
        const snapped = snapEnabled && anchor
          ? resolveDiagramSnap(anchor, rawDx, rawDy, nodes.filter((node) => !movingIds.has(node.id)))
          : { dx: rawDx, dy: rawDy, guides: {} };
        const { dx, dy } = snapped;
        setAlignmentGuides(snapped.guides);
        setNodes((currentNodes) => {
          const nextNodes = currentNodes.map((n) => {
            const target = g.startNodes.find((s) => s.id === n.id);
            return target ? { ...n, x: target.x + dx, y: target.y + dy } : n;
          });
          const overlap = findIntroducedDiagramGroupOverlap(
            { nodes: currentNodes, groups },
            { nodes: nextNodes, groups },
          );
          if (overlap) {
            setGroupCollision(overlap);
            return currentNodes;
          }
          setGroupCollision(null);
          return nextNodes;
        });
      } else if (g.type === "edge") {
        const w = toWorld(e.clientX, e.clientY);
        g.curX = w.x; g.curY = w.y;
        setPreview({ fromId: g.fromId, sourcePort: g.sourcePort, x: w.x, y: w.y });
        setTargetId(hitNode(w.x, w.y));
      } else if (g.type === "edge-endpoint") {
        const w = toWorld(e.clientX, e.clientY);
        setEdgeEndpointPreview({ edgeId: g.edgeId, endpoint: g.endpoint, x: w.x, y: w.y });
        setTargetId(hitNode(w.x, w.y));
      } else if (g.type === "edge-bend") {
        const w = toWorld(e.clientX, e.clientY);
        setEdges((currentEdges) => currentEdges.map((edge) => {
          if (edge.id !== g.edgeId) return edge;
          const points = g.points.map((point, index) => index === g.pointIndex ? w : point);
          return { ...edge, points, routingMode: "manual", routeVersion: 1 };
        }));
      } else if (g.type === "resize") {
        const w = toWorld(e.clientX, e.clientY);
        const dW = Math.max(MIN_W, g.startW + (w.x - g.startWorld.x));
        const dH = Math.max(MIN_H, g.startH + (w.y - g.startWorld.y));
        setNodes((currentNodes) => {
          const nextNodes = currentNodes.map((n) => (n.id === g.id ? { ...n, w: dW, h: dH } : n));
          const overlap = findIntroducedDiagramGroupOverlap(
            { nodes: currentNodes, groups },
            { nodes: nextNodes, groups },
          );
          if (overlap) {
            setGroupCollision(overlap);
            return currentNodes;
          }
          setGroupCollision(null);
          return nextNodes;
        });
      } else if (g.type === "box") {
        const w = toWorld(e.clientX, e.clientY);
        g.curWorld = w;
        const x = Math.min(g.startWorld.x, w.x);
        const y = Math.min(g.startWorld.y, w.y);
        const bw = Math.abs(w.x - g.startWorld.x);
        const bh = Math.abs(w.y - g.startWorld.y);
        setBoxState({ x, y, w: bw, h: bh });
      }
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture.current;
      setAlignmentGuides({});
      if (g.type === "edge") {
        const w = toWorld(e.clientX, e.clientY);
        const target = hitNode(w.x, w.y);
        gesture.current = { type: "none" };
        setPreview(null); setTargetId(null);
        if (target) {
          const targetNode = nodes.find((node) => node.id === target);
          if (!targetNode) return;
          const targetPort = nearestPort(targetNode, w);
          if (!edges.some((edge) => edge.from === g.fromId && edge.to === target && edge.sourcePort === g.sourcePort && edge.targetPort === targetPort)) {
            recordHistory(dragBefore.current as Snapshot);
            const sourceNode = nodes.find((node) => node.id === g.fromId);
            if (!sourceNode) return;
            const next = [...edges, {
              id: uid(), from: g.fromId, to: target,
              sourcePort: g.sourcePort, targetPort,
              label: g.defaultLabel, style: props.diagramType === "usecase" ? "straight" as const : "ortho" as const,
              relationType: props.diagramType === "usecase" ? "association" as const : undefined,
              routingMode: "auto" as const,
              jumpStyle: "arc" as const,
              routeVersion: 1 as const,
            }];
            setEdges(next);
            commit(nodes, next, groups);
          }
        }
      } else if (g.type === "edge-endpoint") {
        const w = toWorld(e.clientX, e.clientY);
        const target = hitNode(w.x, w.y);
        gesture.current = { type: "none" };
        setEdgeEndpointPreview(null);
        setTargetId(null);
        if (target) {
          const targetNode = nodes.find((node) => node.id === target);
          const currentEdge = edges.find((edge) => edge.id === g.edgeId);
          if (!targetNode || !currentEdge) return;
          const targetPort = nearestPort(targetNode, w);
          const updatedEdge: DiagramEdge = g.endpoint === "source"
            ? { ...currentEdge, from: target, sourcePort: targetPort, points: undefined, routingMode: "auto", routeVersion: 1 }
            : { ...currentEdge, to: target, targetPort, points: undefined, routingMode: "auto", routeVersion: 1 };
          const unchanged = updatedEdge.from === currentEdge.from
            && updatedEdge.to === currentEdge.to
            && updatedEdge.sourcePort === currentEdge.sourcePort
            && updatedEdge.targetPort === currentEdge.targetPort;
          if (!unchanged) {
            if (dragBefore.current) recordHistory(dragBefore.current);
            const nextEdges = edges.map((edge) => edge.id === g.edgeId ? updatedEdge : edge);
            setEdges(nextEdges);
            commit(nodes, nextEdges, groups);
          }
        }
        dragBefore.current = null;
      } else if (g.type === "edge-bend") {
        gesture.current = { type: "none" };
        if (dragBefore.current) recordHistory(dragBefore.current);
        commit(nodes, edges, groups);
        dragBefore.current = null;
      } else if (g.type === "box") {
        const w = toWorld(e.clientX, e.clientY);
        gesture.current = { type: "none" };
        const { x, y } = { x: Math.min(g.startWorld.x, w.x), y: Math.min(g.startWorld.y, w.y) };
        const bw = Math.abs(w.x - g.startWorld.x), bh = Math.abs(w.y - g.startWorld.y);
        setBoxState(null);
        if (bw < 6 && bh < 6) { clearSelected(); return; }
        const ids = visibleNodes
          .filter((n) => n.x >= x && n.x <= x + bw && n.y >= y && n.y <= y + bh)
          .map((n) => n.id);
        setSelectedIds((prev) => Array.from(new Set([...prev, ...ids])));
      } else if (g.type === "pan") {
        gesture.current = { type: "none" };
        if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 4) clearSelected();
      } else if (g.type === "move") {
        const w = toWorld(e.clientX, e.clientY);
        gesture.current = { type: "none" };
        if (Math.hypot(w.x - g.fromWorld.x, w.y - g.fromWorld.y) < 4) {
          setNodes((current) => current.map((node) => {
            const original = g.startNodes.find((item) => item.id === node.id);
            return original ? { ...node, x: original.x, y: original.y } : node;
          }));
          dragBefore.current = null;
          return;
        }
        if (dragBefore.current) recordHistory(dragBefore.current);
        const nextEdges = moveEdgeRoutes(edges, nodeMoveDeltas(g.startNodes, nodes));
        setEdges(nextEdges);
        commit(nodes, nextEdges, groups);
        dragBefore.current = null;
      } else if (g.type === "resize") {
        gesture.current = { type: "none" };
        if (dragBefore.current) recordHistory(dragBefore.current);
        const nextEdges = clearEdgePointsForNodes(edges, [g.id]);
        setEdges(nextEdges);
        commit(nodes, nextEdges, groups);
        dragBefore.current = null;
      } else {
        gesture.current = { type: "none" };
        setPreview(null); setTargetId(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [toWorld, hitNode, commit, nodes, edges, groups, clearSelected, recordHistory, snapEnabled, visibleNodes]);

  // ---------- node ops ----------

  const addNode = (kind: DiagramNodeKind, world?: { x: number; y: number }, shape?: NodeShape, defaultLabel?: string, flowType?: DiagramFlowNodeType, useCaseType?: DiagramUseCaseNodeType) => {
    const center = world ?? { x: 120, y: 120 };
    const base = defaultLabel?.trim() || KIND_LABELS[kind];
    let label = base;
    let i = 2;
    while (isLabelTaken(label, null)) { label = `${base} ${i}`; i += 1; }
    const useCaseSize = useCaseType === "actor" ? { w: 90, h: 120 }
      : useCaseType === "boundary" ? { w: 520, h: 390 }
        : useCaseType === "usecase" ? { w: 180, h: 72 }
          : { w: DEFAULT_W, h: DEFAULT_H };
    const node: DiagramNode = {
      id: uid(), kind, label, x: center.x, y: center.y, ...useCaseSize, shape, flowType, useCaseType,
      ...(props.diagramType === "flow" || props.diagramType === "usecase" ? {} : {
        requirementStatus: "待整理" as const,
        designStatus: "未开始" as const,
        requiresDatabase: kind === "data",
        developmentStatus: "未开发" as const,
        acceptanceStatus: "未验收" as const,
        deliveryUpdatedAt: new Date().toISOString(),
      }),
    };
    const next = [...nodes, node];
    applyChange(next, edges, groups, snapshot());
  };

  useEffect(() => {
    props.onRegisterApi?.({
      insertNode: (kind, shape, label, flowType, useCaseType) => addNode(kind, undefined, shape, label, flowType, useCaseType),
      selectItems: (itemKeys) => {
        const nodeIds = itemKeys.filter((key) => key.startsWith("node:")).map((key) => key.slice(5)).filter((id) => nodes.some((node) => node.id === id));
        const edgeIds = itemKeys.filter((key) => key.startsWith("edge:")).map((key) => key.slice(5)).filter((id) => edges.some((edge) => edge.id === id));
        setSelectedIds(nodeIds);
        setSelectedEdgeId(edgeIds.at(-1) ?? null);
        setSelectedGroupId(null);
      },
    });
  });

  const updateNode = (id: string, patch: Partial<DiagramNode>) => {
    if (layerAccess.lockedNodeIds.has(id)) return;
    const next = nodes.map((n) => (n.id === id ? { ...n, ...patch, deliveryUpdatedAt: new Date().toISOString() } : n));
    const geometryChanged = patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined;
    applyChange(next, geometryChanged ? clearEdgePoints(edges) : edges, groups, snapshot());
  };

  const toggleSubCanvasLink = (id: string, add: boolean) => {
    const current = selectedNode?.linkDiagramIds ?? [];
    const next = add ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    updateNode(selectedNode!.id, { linkDiagramIds: next });
  };

  const groupNameUnique = () => {
    const names = new Set(groups.map((g) => g.name));
    let name = "分组";
    let i = 2;
    while (names.has(name)) { name = `分组 ${i}`; i += 1; }
    return name;
  };
  const groupSelected = () => {
    const nodeIds = selectedIds.filter((id) => !layerAccess.lockedNodeIds.has(id));
    if (nodeIds.length < 2) return;
    const g: DiagramGroup = { id: uid(), name: groupNameUnique(), nodeIds };
    if (applyChange(nodes, edges, [...groups, g], snapshot())) setSelectedGroupId(g.id);
  };
  const ungroup = (id: string) => {
    applyChange(nodes, edges, groups.filter((g) => g.id !== id), snapshot());
    setSelectedGroupId(null);
  };
  const updateGroupName = (id: string, name: string) => {
    applyChange(nodes, edges, groups.map((g) => (g.id === id ? { ...g, name } : g)), snapshot());
  };

  const clipboard = useRef<{ nodes: DiagramNode[]; edges: DiagramEdge[] }>({ nodes: [], edges: [] });
  const copySelected = useCallback(() => {
    const sel = new Set(selectedIds);
    clipboard.current = {
      nodes: nodes.filter((n) => sel.has(n.id)).map((n) => ({ ...n })),
      edges: edges.filter((e) => sel.has(e.from) && sel.has(e.to)).map((e) => ({ ...e })),
    };
  }, [selectedIds, nodes, edges]);
  const pasteClipboard = useCallback(() => {
    const cb = clipboard.current;
    if (cb.nodes.length === 0) return;
    const idMap = new Map(cb.nodes.map((n) => [n.id, uid()]));
    const newNodes = cb.nodes.map((n) => ({ ...n, id: idMap.get(n.id)!, x: n.x + 30, y: n.y + 30 }));
    const newEdges = cb.edges
      .filter((e) => idMap.has(e.from) && idMap.has(e.to))
      .map((e) => ({ ...e, id: uid(), from: idMap.get(e.from)!, to: idMap.get(e.to)!, points: undefined }));
    const nextNodes = [...nodes, ...newNodes];
    const nextEdges = [...edges, ...newEdges];
    applyChange(nextNodes, nextEdges, groups, snapshot());
    setSelectedIds(newNodes.map((n) => n.id));
  }, [nodes, edges, groups, applyChange, snapshot]);
  const duplicateSelected = useCallback(() => {
    copySelected();
    pasteClipboard();
  }, [copySelected, pasteClipboard]);

  const extractSelected = useCallback(() => {
    const selIds = new Set(selectedIds);
    const selNodes = nodes.filter((n) => selIds.has(n.id));
    if (selNodes.length === 0) return;
    const idMap = new Map(selNodes.map((n) => [n.id, uid()]));
    const clones = selNodes.map((n) => ({ ...n, id: idMap.get(n.id)! }));
    const clonesEdges = edges
      .filter((e) => selIds.has(e.from) && selIds.has(e.to))
      .map((e) => ({ ...e, id: uid(), from: idMap.get(e.from)!, to: idMap.get(e.to)! }));
    const title = clones.length === 1 ? `${clones[0].label} · 子画布` : `${clones.length} 个节点 · 子画布`;
    props.onExtractToNewCanvas?.({ nodes: clones, edges: clonesEdges, title, sourceNodeIds: [...selectedIds] });
  }, [nodes, edges, selectedIds, props]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (props.keyboardDisabled) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (e.key === "Escape" && commandOpen) {
        e.preventDefault();
        setCommandOpen(false);
        setCommandQuery("");
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.key === "Escape" && focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "c") { if (selectedIds.length > 0) { e.preventDefault(); copySelected(); } return; }
      if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
      if (mod && e.key.toLowerCase() === "d") { if (selectedIds.length > 0) { e.preventDefault(); duplicateSelected(); } return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIds.length > 0) { e.preventDefault(); deleteSelected(); }
        else if (selectedEdgeId) { e.preventDefault(); deleteEdge(selectedEdgeId); }
      } else if (e.key === "Escape") {
        setSelectedIds([]);
        setSelectedEdgeId(null);
        setSelectedGroupId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.keyboardDisabled, selectedIds, deleteSelected, selectedEdgeId, deleteEdge, undo, redo, copySelected, pasteClipboard, duplicateSelected, commandOpen, focusMode]);

  const dragNode = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const isSel = selectedIds.includes(id);
      setSelectedIds((prev) => (isSel ? prev.filter((x) => x !== id) : [...prev, id]));
      setSelectedGroupId(null);
      gesture.current = { type: "none" };
      return;
    }
    const clickedLast = selectedIds.includes(id)
      ? [...selectedIds.filter((selectedId) => selectedId !== id), id]
      : [id];
    const base = clickedLast;
    setSelectedIds(base);
    setSelectedEdgeId(null);
    setSelectedGroupId(null);
    setGroupCollision(null);
    setInspectorError("");
    if (layerAccess.lockedNodeIds.has(id)) { gesture.current = { type: "none" }; return; }
    dragBefore.current = snapshot();
    const w = toWorld(e.clientX, e.clientY);
    gesture.current = {
      type: "move",
      fromWorld: w,
      startNodes: base.filter((bid) => !layerAccess.lockedNodeIds.has(bid)).map((bid) => {
        const n = nodes.find((m) => m.id === bid);
        return { id: bid, x: n?.x ?? 0, y: n?.y ?? 0 };
      }),
    };
  };

  const dragEdge = (e: React.PointerEvent, id: string, sourcePort: DiagramPort, defaultLabel?: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (layerAccess.lockedNodeIds.has(id)) return;
    setSelectedEdgeId(null);
    dragBefore.current = snapshot();
    const w = toWorld(e.clientX, e.clientY);
    const usedLabels = new Set(edges.filter((edge) => edge.from === id).map((edge) => edge.label));
    const label = defaultLabel && !usedLabels.has(defaultLabel)
      ? defaultLabel
      : defaultLabel ? `条件 ${edges.filter((edge) => edge.from === id).length + 1}` : undefined;
    gesture.current = { type: "edge", fromId: id, sourcePort, curX: w.x, curY: w.y, defaultLabel: label };
    setPreview({ fromId: id, sourcePort, x: w.x, y: w.y });
    setTargetId(null);
  };

  const dragEdgeEndpoint = (e: React.PointerEvent, edgeId: string, endpoint: "source" | "target") => {
    e.stopPropagation();
    e.preventDefault();
    if (layerAccess.lockedEdgeIds.has(edgeId) || !edges.some((edge) => edge.id === edgeId)) return;
    setSelectedIds([]);
    setSelectedGroupId(null);
    setSelectedEdgeId(edgeId);
    dragBefore.current = snapshot();
    const w = toWorld(e.clientX, e.clientY);
    gesture.current = { type: "edge-endpoint", edgeId, endpoint };
    setEdgeEndpointPreview({ edgeId, endpoint, x: w.x, y: w.y });
    setTargetId(null);
  };

  const dragEdgeBend = (e: React.PointerEvent, edgeId: string, pointIndex: number, route: DiagramPoint[]) => {
    e.stopPropagation();
    e.preventDefault();
    if (layerAccess.lockedEdgeIds.has(edgeId) || pointIndex <= 0 || pointIndex >= route.length - 1) return;
    dragBefore.current = snapshot();
    const points = route.map((point) => ({ ...point }));
    setEdges((current) => current.map((edge) => edge.id === edgeId ? { ...edge, points, routingMode: "manual", routeVersion: 1 } : edge));
    gesture.current = { type: "edge-bend", edgeId, pointIndex, points };
  };

  const resizeNode = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (layerAccess.lockedNodeIds.has(id)) return;
    const n = nodes.find((m) => m.id === id);
    if (!n) return;
    dragBefore.current = snapshot();
    const w = toWorld(e.clientX, e.clientY);
    gesture.current = { type: "resize", id, startW: nodeW(n), startH: nodeH(n), startWorld: w };
  };

  const startPan = (e: React.PointerEvent) => {
    e.preventDefault();
    gesture.current = { type: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  };

  const startBox = (e: React.PointerEvent) => {
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    gesture.current = { type: "box", startWorld: w, curWorld: w };
  };

  const fitView = useCallback((list: DiagramNode[], routeEdges: DiagramEdge[]) => {
    const svg = svgRef.current;
    if (!svg || list.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const routePoints = routeEdges.flatMap((edge) => {
      const from = list.find((node) => node.id === edge.from);
      const to = list.find((node) => node.id === edge.to);
      if (!from || !to) return [];
      return edge.points && edge.points.length >= 2 ? edge.points : fallbackEdgeRoute(edge, from, to) ?? [];
    });
    const minX = Math.min(...list.map((n) => n.x - nodeW(n) / 2), ...routePoints.map((point) => point.x));
    const maxX = Math.max(...list.map((n) => n.x + nodeW(n) / 2), ...routePoints.map((point) => point.x));
    const minY = Math.min(...list.map((n) => n.y - nodeH(n) / 2), ...routePoints.map((point) => point.y));
    const maxY = Math.max(...list.map((n) => n.y + nodeH(n) / 2), ...routePoints.map((point) => point.y));
    const bw = maxX - minX + 2 * MARGIN;
    const bh = maxY - minY + 2 * MARGIN;
    const z = Math.max(0.3, Math.min(1.2, Math.min(rect.width / bw, rect.height / bh)));
    setZoom(z);
    setPan({
      x: (rect.width - bw * z) / 2 - (minX - MARGIN) * z,
      y: (rect.height - bh * z) / 2 - (minY - MARGIN) * z,
    });
  }, []);

  const focusNode = useCallback((node: DiagramNode) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const nextZoom = Math.max(0.85, Math.min(1.35, zoomRef.current));
    setZoom(nextZoom);
    setPan({ x: rect.width / 2 - node.x * nextZoom, y: rect.height / 2 - node.y * nextZoom });
    setSelectedIds([node.id]);
    setSelectedEdgeId(null);
    setSelectedGroupId(null);
    setCommandOpen(false);
    setCommandQuery("");
  }, []);

  const toggleFullscreen = () => {
    const el = canvasWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    // 进入全屏后布局更新，等一帧再适配内容，保证“整个页面显示画布”时内容完整可见。
    const currentNodes = visibleNodes;
    const currentEdges = visibleEdges;
    const request = el.requestFullscreen?.();
    if (request) {
      void request.then(() => requestAnimationFrame(() => fitView(currentNodes, currentEdges))).catch(() => {});
    }
  };

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const autoArrange = async () => {
    if (layoutBusy || nodes.length === 0) return;
    if (layerAccess.lockedNodeIds.size || layerAccess.hiddenNodeIds.size || layerAccess.hiddenEdgeIds.size) {
      setLayoutError("存在已锁定或已隐藏图层内容，自动整理已停止，避免改动不可编辑元素");
      return;
    }
    setLayoutBusy(true);
    setLayoutError("");
    try {
      const arranged = await layoutDiagram(nodes, edges, treeDir, props.diagramType);
      if (applyChange(arranged.nodes, arranged.edges, groups, snapshot())) fitView(arranged.nodes, arranged.edges);
    } catch (error) {
      setLayoutError(error instanceof Error ? error.message : "自动整理失败");
    } finally {
      setLayoutBusy(false);
    }
  };

  const baseName = () => props.titleForExport?.trim() || "diagram";
  const exportPng = () => {
    const svgStr = buildDiagramSvg(visibleNodes, visibleEdges, visibleGroups, props.diagramType, props.layerState);
    if (!svgStr) return;
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, img.width * scale);
      canvas.height = Math.max(1, img.height * scale);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#111820";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      URL.revokeObjectURL(url);
      const a = document.createElement("a");
      a.download = `${baseName()}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };
  const exportSvg = () => {
    const svgStr = buildDiagramSvg(visibleNodes, visibleEdges, visibleGroups, props.diagramType, props.layerState);
    if (!svgStr) return;
    const blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = `${baseName()}.svg`;
    a.href = url;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openNodeDetails = (id: string, tab?: string) => {
    if (props.viewportKey) {
      sessionStorage.setItem(`diagram-viewport:${props.viewportKey}`, JSON.stringify({ zoom, pan }));
    }
    props.onOpenNodeDetails(id, tab);
  };
  const edgeFromNode = (id: string) => nodes.find((n) => n.id === id);
  const selectedNode = nodes.find((n) => n.id === selectedIds[selectedIds.length - 1]) ?? null;
  const selectedShowsDelivery = Boolean(selectedNode && DELIVERY_DIAGRAM_TYPES.has(props.diagramType) && DELIVERY_NODE_KINDS.has(selectedNode.kind));
  const selectedPlanSummary = selectedNode ? props.planSummaries?.[selectedNode.id] : undefined;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const routeResults = useMemo(() => routeDiagramEdges(visibleNodes, visibleEdges, { zoom }), [visibleNodes, visibleEdges, zoom]);
  const selectedRoute = selectedEdge ? routeResults.get(selectedEdge.id) : undefined;
  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;
  const hasInspector = Boolean(selectedEdge || selectedGroup || selectedNode);
  const inspectorDocked = hasInspector && !inspectorCollapsed && !focusMode;
  const focusSelection = useCallback(() => {
    const focusedIds = new Set(selectedIds);
    selectedGroup?.nodeIds.forEach((id) => focusedIds.add(id));
    if (selectedEdge) {
      focusedIds.add(selectedEdge.from);
      focusedIds.add(selectedEdge.to);
    }
    const focusedNodes = nodes.filter((node) => focusedIds.has(node.id));
    if (focusedNodes.length === 0) return;
    const focusedEdges = edges.filter((edge) => focusedIds.has(edge.from) && focusedIds.has(edge.to));
    fitView(focusedNodes, focusedEdges);
  }, [edges, fitView, nodes, selectedEdge, selectedGroup, selectedIds]);

  useEffect(() => {
    const onViewShortcut = (event: KeyboardEvent) => {
      if (props.keyboardDisabled) return;
      if (isEditableTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key === "0") {
        event.preventDefault();
        fitView(visibleNodes, visibleEdges);
        return;
      }
      if (!mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        focusSelection();
      }
    };
    window.addEventListener("keydown", onViewShortcut);
    return () => window.removeEventListener("keydown", onViewShortcut);
  }, [fitView, focusSelection, props.keyboardDisabled, visibleEdges, visibleNodes]);
  const existingGroupOverlaps = listDiagramGroupOverlaps({ nodes, groups });
  const groupConflictIds = new Set([
    ...existingGroupOverlaps.flatMap((overlap) => [overlap.first.id, overlap.second.id]),
    ...(groupCollision ? [groupCollision.first.id, groupCollision.second.id] : []),
  ]);
  const groupConstraintMessage = groupCollision
    ? diagramGroupOverlapMessage(groupCollision)
    : existingGroupOverlaps.length > 0
      ? `存在 ${existingGroupOverlaps.length} 处组合区域重叠，请拖动分离`
      : "";
  const flowValidationIssues = nodes.filter(isDecisionNode).reduce((count, node) => {
        const branches = edges.filter((edge) => edge.from === node.id);
        return count + (branches.length < 2 ? 1 : 0) + branches.filter((edge) => !edge.label?.trim()).length;
      }, 0);
  const isolatedNodeCount = nodes.length <= 1 ? 0 : nodes.filter((node) => !edges.some((edge) => edge.from === node.id || edge.to === node.id)).length;
  const useCaseActors = nodes.filter((node) => useCaseTypeOf(node) === "actor");
  const useCases = nodes.filter((node) => useCaseTypeOf(node) === "usecase");
  const isolatedUseCaseNodeCount = [...useCaseActors, ...useCases].filter((node) => !edges.some((edge) => edge.from === node.id || edge.to === node.id)).length;
  const useCaseRelationCounts = edges.reduce((counts, edge) => {
    const key = useCaseRelationKey(edge);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const duplicateUseCaseRelationCount = [...useCaseRelationCounts.values()].reduce((count, occurrences) => count + Math.max(0, occurrences - 1), 0);
  const invalidUseCaseRelationCount = edges.filter((edge) => {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    if (!from || !to) return true;
    const fromType = useCaseTypeOf(from), toType = useCaseTypeOf(to);
    if (fromType === "boundary" || toType === "boundary") return true;
    const relationType = edge.relationType ?? "association";
    if (relationType === "include" || relationType === "extend") return fromType !== "usecase" || toType !== "usecase";
    if (relationType === "generalization") return fromType !== toType;
    return false;
  }).length;
  const useCaseValidationIssues = (useCaseActors.length === 0 ? 1 : 0)
    + (useCases.length === 0 ? 1 : 0)
    + isolatedUseCaseNodeCount
    + invalidUseCaseRelationCount
    + duplicateUseCaseRelationCount;
  const validation = props.diagramType === "flow"
    ? { issues: flowValidationIssues, ok: "流程规则完整", problem: `${flowValidationIssues} 项流程问题`, title: "判断节点需要至少两个有条件名称的分支" }
    : props.diagramType === "main"
      ? { issues: isolatedNodeCount, ok: "系统关系完整", problem: `${isolatedNodeCount} 个孤立节点`, title: "系统主画布中的模块、流程、服务和数据应建立总览关系" }
    : props.diagramType === "functional"
      ? { issues: isolatedNodeCount, ok: "层级关系完整", problem: `${isolatedNodeCount} 个孤立节点`, title: "功能架构中的节点应通过包含、依赖或调用关系连接" }
      : props.diagramType === "deployment"
        ? { issues: isolatedNodeCount, ok: "部署关系完整", problem: `${isolatedNodeCount} 个孤立节点`, title: "部署节点、服务、组件和存储应建立关系" }
        : props.diagramType === "usecase"
          ? { issues: useCaseValidationIssues, ok: "用例关系完整", problem: `${useCaseValidationIssues} 项用例问题`, title: `${duplicateUseCaseRelationCount > 0 ? `${duplicateUseCaseRelationCount} 条重复关系；` : ""}需要参与者和用例；参与者/用例不可孤立；include、extend 仅连接用例；泛化两端类型需一致` }
          : null;
  const isSimpleDiagram = props.diagramType === "flow" || props.diagramType === "usecase";
  const activeGesture = gesture.current;
  const liveNodeDeltas = activeGesture.type === "move"
    ? nodeMoveDeltas(activeGesture.startNodes, nodes)
    : new Map<string, NodeDelta>();
  const resizingNodeId = activeGesture.type === "resize" ? activeGesture.id : null;
  const relatedNodeIds = relatedDiagramNodeIds(hoveredNodeId, visibleEdges);
  const commandResults = rankDiagramNodes(visibleNodes, commandQuery);
  const miniMapBounds = getDiagramBounds(visibleNodes, 56);
  const miniMapWidth = 190;
  const miniMapHeight = 118;
  const miniMapProjection = createMiniMapProjection(miniMapBounds, miniMapWidth, miniMapHeight, 9);
  const viewportWidth = svgRef.current?.clientWidth ?? 900;
  const viewportHeight = svgRef.current?.clientHeight ?? 620;
  const visibleWorld = {
    x: -pan.x / zoom,
    y: -pan.y / zoom,
    width: viewportWidth / zoom,
    height: viewportHeight / zoom,
  };
  return (
    <div className="canvas-wrap" ref={canvasWrapRef}>
      <div className="canvas-toolbar">
        <div className="tb-group">
          <Badge tone={props.diagramType === "main" ? "good" : props.diagramType === "flow" ? "accent" : "info"}>
            {DIAGRAM_TYPE_SHORT_LABELS[props.diagramType]}
          </Badge>
          {props.diagramType === "free" ? (
            <>
              <select
                value={addKindSel}
                onChange={(e) => { addKind.current = e.target.value as DiagramNodeKind; setAddKindSel(e.target.value as DiagramNodeKind); }}
                title="节点类型"
              >
                {DIAGRAM_NODE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
              <button className="btn btn-primary btn-sm" onClick={() => addNode(addKind.current)}>＋ 添加节点</button>
            </>
          ) : <span className="toolbar-hint">从左侧元素库添加</span>}
        </div>

        <div className="tb-sep" />

        <div className="tb-group">
          <div className="tree-dir">
            <button className={`btn btn-sm ${treeDir === "vertical" ? "btn-primary" : ""}`} disabled={layoutBusy} onClick={() => setTreeDir("vertical")}>上下</button>
            <button className={`btn btn-sm ${treeDir === "horizontal" ? "btn-primary" : ""}`} disabled={layoutBusy} onClick={() => setTreeDir("horizontal")}>左右</button>
          </div>
          <button className="btn btn-sm btn-primary" disabled={layoutBusy || nodes.length === 0} onClick={() => void autoArrange()} title="自动分层、减少交叉并生成正交线路">
            <Sparkles size={14} /> {layoutBusy ? "整理中…" : "自动整理"}
          </button>
          {layoutError ? <span className="toolbar-error" role="alert" title={layoutError}>整理失败</span> : null}
          {groupConstraintMessage ? <span className="toolbar-error" role="alert" title={groupConstraintMessage}>{groupConstraintMessage}</span> : null}
          {validation ? (
            <span className={`flow-validation ${validation.issues === 0 ? "valid" : "invalid"}`} title={validation.issues === 0 ? validation.ok : validation.title}>
              {validation.issues === 0 ? validation.ok : validation.problem}
            </span>
          ) : null}
        </div>

        <div className="spacer" />

        <button className="canvas-command-trigger" type="button" onClick={() => setCommandOpen(true)} title="查找并定位节点（Ctrl/⌘+K）">
          <Search size={14} />
          <span>查找节点</span>
          <kbd>⌘K</kbd>
        </button>

        <div className="tb-group">
          <button className="btn btn-ghost btn-icon" onClick={undo} title="撤销 (Ctrl+Z)"><RotateCcw size={14} /></button>
          <button className="btn btn-ghost btn-icon" onClick={redo} title="重做 (Ctrl+Y)"><RotateCw size={14} /></button>
        </div>
        <div className="tb-sep" />
        <div className="tb-group">
          <button className="btn btn-ghost btn-icon" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))} title="缩小">−</button>
          <span className="mono" style={{ width: 44, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button className="btn btn-ghost btn-icon" onClick={() => setZoom((z) => Math.min(2.5, z + 0.15))} title="放大">+</button>
          <button className="btn btn-ghost btn-sm" onClick={() => fitView(visibleNodes, visibleEdges)} title="适配全部可见内容（Ctrl/⌘+0）">适配</button>
          <button className="btn btn-ghost btn-sm" onClick={focusSelection} disabled={!hasInspector} title="聚焦选中内容（F）"><LocateFixed size={14} /> F</button>
          <button className={`btn btn-ghost btn-sm ${focusMode ? "active" : ""}`} onClick={() => setFocusMode((value) => !value)} aria-pressed={focusMode} title="专注模式；Esc 退出">{focusMode ? "退出专注" : "专注"}</button>
        </div>
        <details className="canvas-toolbar-more">
          <summary className="btn btn-ghost btn-sm" aria-label="更多画布操作">更多 ···</summary>
          <div className="canvas-toolbar-more-menu">
            <button className="btn btn-ghost btn-sm" onClick={exportPng} title="导出为 PNG 图片"><Download size={14} /> 导出 PNG</button>
            <button className="btn btn-ghost btn-sm" onClick={exportSvg} title="导出为 SVG 文件"><Download size={14} /> 导出 SVG</button>
            <button className={`btn btn-ghost btn-sm ${gridVisible ? "active" : ""}`} onClick={() => setGridVisible((value) => !value)} aria-pressed={gridVisible}><Grid3X3 size={14} /> 双层网格</button>
            <button className={`btn btn-ghost btn-sm ${snapEnabled ? "active" : ""}`} onClick={() => setSnapEnabled((value) => !value)} aria-pressed={snapEnabled}><Crosshair size={14} /> 节点吸附</button>
            <button className={`btn btn-ghost btn-sm ${miniMapVisible ? "active" : ""}`} onClick={() => setMiniMapVisible((value) => !value)} aria-pressed={miniMapVisible}><MapIcon size={14} /> 画布导航</button>
            <button className="btn btn-ghost btn-sm" onClick={toggleFullscreen}>{fullscreen ? <Minimize size={14} /> : <Maximize size={14} />} {fullscreen ? "退出全屏" : "全屏显示"}</button>
          </div>
        </details>
      </div>

      <div
        className={`canvas-viewport ${inspectorDocked ? "has-docked-inspector" : ""} ${focusMode ? "is-focus-mode" : ""}`}
        style={{ "--canvas-inspector-width": `${inspectorWidth}px` } as CSSProperties}
        ref={canvasViewportRef}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDrop={(e) => {
          e.preventDefault();
          try {
            const raw = e.dataTransfer.getData("application/json");
            if (!raw) return;
            const payload = JSON.parse(raw) as { kind: DiagramNodeKind; shape?: NodeShape; label?: string; flowType?: DiagramFlowNodeType; useCaseType?: DiagramUseCaseNodeType };
            if (!payload.kind) return;
            const w = toWorld(e.clientX, e.clientY);
            addNode(payload.kind, w, payload.shape, payload.label, payload.flowType, payload.useCaseType);
          } catch { /* ignore */ }
        }}
      >
        <svg
          ref={svgRef}
          className={`canvas-svg ${visibleNodes.length >= 500 || visibleEdges.length >= 1000 ? "large-graph" : ""}`}
          onPointerDown={(e) => {
            if (e.button === 1) { startPan(e); return; }
            if (e.button !== 0) return;
            if (e.shiftKey) { startBox(e); return; }
            startPan(e);
          }}
          onDoubleClick={(e) => {
            if (props.diagramType !== "free") return;
            const w = toWorld(e.clientX, e.clientY);
            addNode(addKind.current, w);
          }}
        >
          <defs>
            <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth">
              <path d="M0,0 L8,3 L0,6 Z" fill="context-stroke" />
            </marker>
            <marker id="open-arrow" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto" markerUnits="strokeWidth">
              <path d="M1,1 L10,5 L1,9" fill="none" stroke="#5c7185" strokeWidth="1.5" />
            </marker>
            <marker id="uml-triangle" markerWidth="13" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="strokeWidth">
              <path d="M1,1 L11,6 L1,11 Z" fill="#0d141b" stroke="#5c7185" strokeWidth="1.3" />
            </marker>
            <pattern id="canvas-minor-grid" width="12" height="12" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.7" fill="#476276" />
            </pattern>
            <pattern id="canvas-major-grid" width="60" height="60" patternUnits="userSpaceOnUse">
              <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#3b5366" strokeWidth="0.8" />
            </pattern>
            <filter id="node-selected" x="-40%" y="-80%" width="180%" height="260%">
              <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#61dfff" floodOpacity="0.32" />
              <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#000000" floodOpacity="0.38" />
            </filter>
          </defs>
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {gridVisible ? (
              <g className="canvas-grid" style={{ pointerEvents: "none" }}>
                <rect x={-6000} y={-6000} width={12000} height={12000} fill="url(#canvas-minor-grid)" opacity={zoom < 0.55 ? 0.08 : 0.26} />
                <rect x={-6000} y={-6000} width={12000} height={12000} fill="url(#canvas-major-grid)" opacity={0.32} />
              </g>
            ) : null}

            {alignmentGuides.x !== undefined ? <line className="canvas-alignment-guide" x1={alignmentGuides.x} x2={alignmentGuides.x} y1={-6000} y2={6000} /> : null}
            {alignmentGuides.y !== undefined ? <line className="canvas-alignment-guide" y1={alignmentGuides.y} y2={alignmentGuides.y} x1={-6000} x2={6000} /> : null}

            {visibleGroups.map((g) => {
              const bounds = diagramGroupBounds(g, visibleNodes);
              if (!bounds) return null;
              const isSel = selectedGroupId === g.id;
              const isConflict = groupConflictIds.has(g.id);
              return (
                <g
                  key={g.id}
                  data-group-id={g.id}
                  data-overlap-conflict={isConflict ? "true" : undefined}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelectedIds([...g.nodeIds]);
                    setSelectedGroupId(g.id);
                    setSelectedEdgeId(null);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <rect x={bounds.left} y={bounds.top} width={bounds.right - bounds.left} height={bounds.bottom - bounds.top}
                    rx={12} fill={isConflict ? "rgba(224,93,93,0.09)" : "rgba(168,120,235,0.05)"}
                    stroke={isConflict ? "#e05d5d" : isSel ? "#a878eb" : "#6a5b8a"} strokeWidth={isConflict || isSel ? 2 : 1.2} strokeDasharray="7 4" />
                  <text x={bounds.left + 8} y={bounds.top - 6} fontSize={11}
                    fill={isConflict ? "#ff9f9f" : isSel ? "#c9b0f0" : "#8d80a8"} style={{ pointerEvents: "none" }}>
                    ▣ {g.name}（{g.nodeIds.length}）
                  </text>
                </g>
              );
            })}

            {paintOrder.map((paintLayer) => paintLayer === "edge" ? (
              <g key="edge" data-paint-layer="edge">
              {visibleEdges.map((edge) => {
              const from = edgeFromNode(edge.from);
              const to = edgeFromNode(edge.to);
              if (!from || !to) return null;
              const src = props.diagramType === "usecase" ? useCaseAttachmentPoint(edge, from, to, nodes, edges)
                : edge.sourcePort ? portPoint(from, edge.sourcePort) : from.id === to.id ? portPoint(from, "right") : attachPoint(from, to);
              const dst = props.diagramType === "usecase" ? useCaseAttachmentPoint(edge, to, from, nodes, edges)
                : edge.targetPort ? portPoint(to, edge.targetPort) : from.id === to.id ? portPoint(to, "top") : attachPoint(to, from);
              const pathD = edge.style === "curve" ? curvePath(src, dst) : orthoPath(src, dst);
              const followsResize = resizingNodeId === edge.from || resizingNodeId === edge.to;
              const routeResult = routeResults.get(edge.id);
              const savedRoute = diagramEdgeRoutingMode(edge) === "manual" && !followsResize && edge.points && edge.points.length >= 2
                ? moveEdgePoints(edge, liveNodeDeltas) ?? null
                : null;
              const routedPoints = savedRoute
                ?? (props.diagramType !== "usecase" && edge.style === "ortho" ? routeResult?.points : undefined)
                ?? fallbackEdgeRoute(edge, from, to);
              const routedD = routedPoints
                ? diagramPolylinePath(routedPoints, savedRoute ? [] : routeResult?.crossings, edge.jumpStyle ?? "arc")
                : null;
              const isSel = selectedEdgeId === edge.id;
              const isRelated = Boolean(hoveredNodeId && (edge.from === hoveredNodeId || edge.to === hoveredNodeId));
              const stroke = isSel ? "#7de7ff" : isRelated ? "#70d8ef" : edge.color ?? "#6f879b";
              const edgeWidth = Math.max(1, Math.min(8, edge.width ?? 2));
              const relation = props.diagramType === "usecase" ? USE_CASE_RELATION_META[edge.relationType ?? "association"] : null;
              const markerEnd = props.diagramType === "usecase"
                ? edge.relationType === "generalization" ? "url(#uml-triangle)"
                  : edge.relationType === "include" || edge.relationType === "extend" ? "url(#open-arrow)"
                    : undefined
                : edge.arrow === "none" ? undefined : "url(#arrow)";
              const markerStart = props.diagramType !== "usecase" && edge.arrow === "both" ? "url(#arrow)" : undefined;
              const strokeDasharray = relation?.dash ?? (edge.dash === "dashed" ? "8 5" : edge.dash === "dotted" ? "2 5" : undefined);
              const hitD = routedD ?? (edge.style === "straight" ? `M ${src.x} ${src.y} L ${dst.x} ${dst.y}` : pathD);
              const labelPoint = routeResult?.labelPoint ?? pathPointAt(routedPoints ?? [src, dst], edge.labelPosition ?? 0.5);
              const edgeLabel = edge.label || relation?.label;
              const labelWidth = Math.max(42, (edgeLabel?.length ?? 0) * 7 + 18);
              return (
                <g key={edge.id} className={`canvas-edge ${isSel ? "selected" : ""} ${isRelated ? "related" : ""} ${routeResult?.degraded ? "degraded" : ""}`}
                  opacity={hoveredNodeId && !isRelated ? 0.16 : 1} style={{ transition: "opacity 140ms ease" }}>
                  <path
                    data-edge-id={edge.id}
                    d={hitD}
                    fill="none" stroke="transparent"
                    strokeWidth={14} strokeLinecap="round"
                    role="button" tabIndex={0}
                    aria-label={`连线${edge.label ? `：${edge.label}` : ""}${routeResult?.degraded ? "，自动路由已降级" : ""}`}
                    style={{ cursor: "pointer", outline: "none" }}
                    onPointerDown={(e) => { e.stopPropagation(); setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(edge.id); }}
                    onClick={(e) => { e.stopPropagation(); setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(edge.id); }}
                    onFocus={() => { setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(edge.id); }}
                    onDoubleClick={(e) => { e.stopPropagation(); deleteEdge(edge.id); }}
                  />
                  {routedD ? (
                    <path d={routedD} fill="none" stroke={stroke} strokeWidth={isSel ? edgeWidth + 1.25 : edgeWidth}
                      markerStart={markerStart} markerEnd={markerEnd} strokeDasharray={strokeDasharray} strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />
                  ) : edge.style === "straight" ? (
                    <line x1={src.x} y1={src.y} x2={dst.x} y2={dst.y} stroke={stroke} strokeWidth={isSel ? edgeWidth + 1.25 : edgeWidth}
                      markerStart={markerStart} markerEnd={markerEnd} strokeDasharray={strokeDasharray} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                  ) : (
                    <path d={pathD} fill="none" stroke={stroke} strokeWidth={isSel ? edgeWidth + 1.25 : edgeWidth}
                      markerStart={markerStart} markerEnd={markerEnd} strokeDasharray={strokeDasharray} strokeLinecap="round" style={{ pointerEvents: "none" }} />
                  )}
                  {edgeLabel ? (
                    <g transform={`translate(${labelPoint.x}, ${labelPoint.y - 7})`} className="canvas-edge-label"
                      role="button" tabIndex={0} aria-label={`连线标签：${edgeLabel}`}
                      onFocus={() => { setSelectedIds([]); setSelectedGroupId(null); setSelectedEdgeId(edge.id); }}>
                      <rect x={-labelWidth / 2} y={-10} width={labelWidth} height={20} rx={7} fill="rgba(11,22,30,.94)" stroke={isSel || isRelated ? stroke : "#2c4353"} strokeWidth={0.9} />
                      <text y={3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={isSel || isRelated ? "#d8f8ff" : "#a9bac7"}>{edgeLabel}</text>
                    </g>
                  ) : null}
                </g>
              );
              })}
              </g>
            ) : (
              <g key="node" data-paint-layer="node">
              {visibleNodes.map((node) => {
              const style = NODE_STYLE[node.kind];
              const w = nodeW(node), h = nodeH(node);
              const isSel = selectedIds.includes(node.id);
              const isTarget = targetId === node.id;
              const developmentStatus = node.developmentStatus ?? "未开发";
              const acceptanceStatus = node.acceptanceStatus ?? "未验收";
              const developmentMeta = DEVELOPMENT_STATUS_META[developmentStatus];
              const acceptanceMeta = ACCEPTANCE_STATUS_META[acceptanceStatus];
              const planSummary = props.planSummaries?.[node.id];
              const showsDelivery = DELIVERY_DIAGRAM_TYPES.has(props.diagramType) && DELIVERY_NODE_KINDS.has(node.kind);
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  opacity={hoveredNodeId && !relatedNodeIds.has(node.id) ? 0.24 : 1}
                  filter={isSel ? "url(#node-selected)" : undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={props.diagramType === "flow" ? `${node.label}，${FLOW_NODE_META[flowTypeOf(node)].label}` : props.diagramType === "usecase" ? `${node.label}，${USE_CASE_NODE_META[useCaseTypeOf(node)].label}` : showsDelivery ? `${node.label}，开发 ${developmentStatus}，验收 ${acceptanceStatus}` : node.label}
                  onFocus={() => {
                    if (gesture.current.type !== "none") return;
                    setSelectedIds([node.id]);
                    setSelectedGroupId(null);
                    setSelectedEdgeId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      setSelectedIds([node.id]);
                      if (event.key === "Enter" && !isSimpleDiagram) openNodeDetails(node.id);
                    }
                  }}
                  onPointerDown={(e) => dragNode(e, node.id)}
                  onPointerEnter={() => setHoveredNodeId(node.id)}
                  onPointerLeave={() => setHoveredNodeId((current) => current === node.id ? null : current)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (isSimpleDiagram) return;
                    openNodeDetails(node.id);
                  }}
                  style={{ cursor: "move", transition: "opacity 140ms ease" }}
                >
                  <title>{props.diagramType === "flow"
                    ? `${node.label} · ${FLOW_NODE_META[flowTypeOf(node)].label}`
                    : props.diagramType === "usecase" ? `${node.label} · ${USE_CASE_NODE_META[useCaseTypeOf(node)].label}`
                    : showsDelivery ? `${node.label} · 开发：${developmentStatus}${planSummary ? `（${planSummary.completed}/${planSummary.total}，${planSummary.progress}%）` : ""} · 验收：${acceptanceStatus}` : node.label}</title>
                  {nodeBody(node, style, isSel, isTarget)}
                  <text x={0} y={props.diagramType === "usecase" && useCaseTypeOf(node) === "actor" ? h / 2 - 5 : props.diagramType === "usecase" && useCaseTypeOf(node) === "boundary" ? -h / 2 + 20 : 1} textAnchor="middle" dominantBaseline="middle"
                    fill={style.text} fontSize={13} fontWeight={600} style={{ pointerEvents: "none" }}>
                    {node.label}
                  </text>
            {selectedShowsDelivery ? (
                    <text x={-w / 2 + 10} y={-h / 2 + 10} fontSize={9} fill={style.text} opacity={0.7}
                      style={{ pointerEvents: "none" }}>{KIND_LABELS[node.kind]}</text>
                  ) : null}
                  {showsDelivery ? (
                    <>
                      <g transform={`translate(${-w / 2 + 11}, ${h / 2 - 7})`} style={{ pointerEvents: "none" }}>
                        <circle r={3.2} fill={developmentMeta.color} />
                        <text x={7} y={3} fontSize={8.5} fill="#9fb0bf">
                          {`开发 · ${developmentMeta.short}${planSummary ? ` · ${planSummary.completed}/${planSummary.total}` : ""}`}
                        </text>
                      </g>
                      <g transform={`translate(${w < 150 ? 8 : w / 2 - 65}, ${h / 2 - 7})`} style={{ pointerEvents: "none" }}>
                        <circle r={3.2} fill={acceptanceMeta.color} />
                        <text x={7} y={3} fontSize={8.5} fill="#9fb0bf">{`验收 · ${acceptanceMeta.short}`}</text>
                      </g>
                    </>
                  ) : null}
                  {/* connect handles */}
                  {props.diagramType === "flow" ? (
                    <>
                      {DIAGRAM_PORTS.map((port) => {
                        const point = port === "top" ? { x: 0, y: -h / 2 }
                          : port === "right" ? { x: w / 2, y: 0 }
                            : port === "bottom" ? { x: 0, y: h / 2 }
                              : { x: -w / 2, y: 0 };
                        const decision = isDecisionNode(node);
                        const defaultLabel = decision && port === "bottom" ? "是" : decision && port === "right" ? "否" : undefined;
                        const portColor = defaultLabel === "是" ? "#3fb96f" : defaultLabel === "否" ? "#e2a33c" : style.stroke;
                        return (
                            <g className={`flow-port-handle port-${port}`} key={port}>
                              <circle cx={point.x} cy={point.y} r={6.5} fill="#17212c" stroke={portColor} strokeWidth={1.8}
                                role="button" tabIndex={0} aria-label={`从${node.label}${PORT_LABELS[port]}侧创建连线`}
                                onPointerDown={(event) => dragEdge(event, node.id, port, defaultLabel)} style={{ cursor: "crosshair" }} />
                              {defaultLabel ? (
                                <text x={point.x + (port === "right" ? 11 : 10)} y={point.y + (port === "bottom" ? 17 : -10)}
                                  fontSize={9.5} fill={defaultLabel === "是" ? "#6fd69a" : "#eec27c"} style={{ pointerEvents: "none" }}>
                                  {defaultLabel}
                                </text>
                              ) : null}
                            </g>
                        );
                      })}
                    </>
                  ) : props.diagramType === "usecase" && useCaseTypeOf(node) === "boundary" ? null : (
                    <g className={`canvas-port-cluster ${isSel || hoveredNodeId === node.id || preview ? "visible" : ""}`}>
                      {DIAGRAM_PORTS.map((port) => {
                        const point = port === "top" ? { x: 0, y: -h / 2 }
                          : port === "right" ? { x: w / 2, y: 0 }
                            : port === "bottom" ? { x: 0, y: h / 2 }
                              : { x: -w / 2, y: 0 };
                        return (
                          <circle key={port} cx={point.x} cy={point.y} r={6.5} fill="#14232d" stroke={isTarget ? "#65dfa2" : style.stroke} strokeWidth={1.8}
                            role="button" tabIndex={0} aria-label={`从${node.label}${PORT_LABELS[port]}侧创建连线`}
                            onPointerDown={(event) => dragEdge(event, node.id, port)} style={{ cursor: "crosshair" }}>
                            <title>从{PORT_LABELS[port]}侧创建连线</title>
                          </circle>
                        );
                      })}
                    </g>
                  )}
                  {/* resize handle */}
                  {isSel ? (
                    <circle cx={w / 2} cy={h / 2} r={6} fill="#17212c" stroke="#4da3ff" strokeWidth={2}
                      onPointerDown={(e) => resizeNode(e, node.id)} style={{ cursor: "nwse-resize" }} />
                  ) : null}
                  {!isSimpleDiagram && (node.linkDiagramIds ?? []).length > 0 ? (
                    <g transform={`translate(0, ${h / 2 + 12})`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        openLinkedCanvases(node, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        openLinkedCanvases(node);
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`打开 ${node.label} 关联的子画布${node.linkDiagramIds!.length > 1 ? `，共 ${node.linkDiagramIds!.length} 个` : ""}`}
                      style={{ cursor: "pointer" }}>
                      <rect x={-52} y={-12} width={104} height={24} rx={12}
                        fill="rgba(77,163,255,0.16)" stroke="#4da3ff" strokeWidth={1} />
                      <text textAnchor="middle" y={4} fontSize={11} fill="#8ec4ff" style={{ pointerEvents: "none" }}>⤷ 打开子画布{(node.linkDiagramIds!.length > 1 ? ` ×${node.linkDiagramIds!.length}` : "")}</text>
                    </g>
                  ) : null}
                </g>
              );
              })}
              </g>
            ))}

            {preview ? (() => {
              const from = edgeFromNode(preview.fromId);
              if (!from) return null;
              const src = portPoint(from, preview.sourcePort);
              const hoveredNode = targetId ? edgeFromNode(targetId) : null;
              const targetPort = hoveredNode ? nearestPort(hoveredNode, preview) : null;
              const route = hoveredNode && targetPort
                ? (hoveredNode.id === from.id
                    ? selfLoopRoute(from, preview.sourcePort, targetPort)
                    : routeBetweenPorts(from, hoveredNode, preview.sourcePort, targetPort))
                : (() => {
                    const sourceOut = offsetPortPoint(src, preview.sourcePort, 20);
                    const vertical = preview.sourcePort === "top" || preview.sourcePort === "bottom";
                    return vertical
                      ? [src, sourceOut, { x: preview.x, y: sourceOut.y }, { x: preview.x, y: preview.y }]
                      : [src, sourceOut, { x: sourceOut.x, y: preview.y }, { x: preview.x, y: preview.y }];
                  })();
              const d = polylineToPath(route);
              return (
                <path
                  d={d}
                  fill="none"
                  stroke={targetId ? "#3fb96f" : "#4da3ff"}
                  strokeWidth={2.5}
                  strokeDasharray="6 4"
                  markerEnd="url(#arrow)"
                />
              );
            })() : null}

            {boxState ? (
              <rect
                x={boxState.x} y={boxState.y} width={boxState.w} height={boxState.h}
                fill="rgba(77,163,255,0.10)" stroke="#4da3ff" strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ) : null}

            {selectedEdge && !edgeEndpointPreview ? (() => {
              const from = edgeFromNode(selectedEdge.from);
              const to = edgeFromNode(selectedEdge.to);
              if (!from || !to) return null;
              const source = props.diagramType === "usecase"
                ? useCaseAttachmentPoint(selectedEdge, from, to, nodes, edges)
                : selectedEdge.sourcePort ? portPoint(from, selectedEdge.sourcePort) : from.id === to.id ? portPoint(from, "right") : attachPoint(from, to);
              const target = props.diagramType === "usecase"
                ? useCaseAttachmentPoint(selectedEdge, to, from, nodes, edges)
                : selectedEdge.targetPort ? portPoint(to, selectedEdge.targetPort) : from.id === to.id ? portPoint(to, "top") : attachPoint(to, from);
              const route = diagramEdgeRoutingMode(selectedEdge) === "manual" && selectedEdge.points && selectedEdge.points.length >= 2
                ? selectedEdge.points
                : props.diagramType !== "usecase" && selectedEdge.style === "ortho"
                  ? selectedRoute?.points
                  : fallbackEdgeRoute(selectedEdge, from, to);
              const sourceHandle = route?.[0] ?? source;
              const targetHandle = route?.[route.length - 1] ?? target;
              return (
                <g className="edge-endpoint-handles">
                  <circle
                    data-edge-endpoint="source"
                    data-edge-id={selectedEdge.id}
                    cx={sourceHandle.x} cy={sourceHandle.y} r={7}
                    fill="#0d141b" stroke="#4da3ff" strokeWidth={2.5}
                    role="button" tabIndex={0} aria-label="调整连线起点"
                    onPointerDown={(event) => dragEdgeEndpoint(event, selectedEdge.id, "source")}
                    style={{ cursor: "crosshair" }}
                  >
                    <title>拖动起点以更换节点或连接方向</title>
                  </circle>
                  <circle
                    data-edge-endpoint="target"
                    data-edge-id={selectedEdge.id}
                    cx={targetHandle.x} cy={targetHandle.y} r={7}
                    fill="#0d141b" stroke="#3fb96f" strokeWidth={2.5}
                    role="button" tabIndex={0} aria-label="调整连线终点"
                    onPointerDown={(event) => dragEdgeEndpoint(event, selectedEdge.id, "target")}
                    style={{ cursor: "crosshair" }}
                  >
                    <title>拖动终点以更换节点或连接方向</title>
                  </circle>
                  {(route ?? []).slice(1, -1).map((point, index) => (
                    <circle
                      key={`${selectedEdge.id}-bend-${index + 1}`}
                      data-edge-bend={index + 1}
                      cx={point.x}
                      cy={point.y}
                      r={5.5}
                      fill="#15232e"
                      stroke="#a8d8e8"
                      strokeWidth={1.8}
                      role="slider"
                      tabIndex={0}
                      aria-label={`调整连线折点 ${index + 1}`}
                      onPointerDown={(event) => dragEdgeBend(event, selectedEdge.id, index + 1, route!)}
                      onKeyDown={(event) => {
                        const step = event.shiftKey ? 20 : 5;
                        const delta = event.key === "ArrowLeft" ? { x: -step, y: 0 }
                          : event.key === "ArrowRight" ? { x: step, y: 0 }
                            : event.key === "ArrowUp" ? { x: 0, y: -step }
                              : event.key === "ArrowDown" ? { x: 0, y: step }
                                : null;
                        if (!delta) return;
                        event.preventDefault();
                        const points = route!.map((routePoint, routeIndex) => routeIndex === index + 1
                          ? { x: routePoint.x + delta.x, y: routePoint.y + delta.y }
                          : { ...routePoint });
                        updateEdge(selectedEdge.id, { points, routingMode: "manual", routeVersion: 1 });
                      }}
                      style={{ cursor: "move" }}
                    >
                      <title>拖动折点调整路径</title>
                    </circle>
                  ))}
                </g>
              );
            })() : null}

            {edgeEndpointPreview ? (() => {
              const edge = edges.find((item) => item.id === edgeEndpointPreview.edgeId);
              if (!edge) return null;
              const originalFrom = edgeFromNode(edge.from);
              const originalTo = edgeFromNode(edge.to);
              if (!originalFrom || !originalTo) return null;
              const hoveredNode = targetId ? edgeFromNode(targetId) : null;
              const hoveredPort = hoveredNode ? nearestPort(hoveredNode, edgeEndpointPreview) : null;
              const fixedNode = edgeEndpointPreview.endpoint === "source" ? originalTo : originalFrom;
              const originalMovingNode = edgeEndpointPreview.endpoint === "source" ? originalFrom : originalTo;
              const towardFixed = hoveredNode ?? originalMovingNode;
              const fixedPort = edgeEndpointPreview.endpoint === "source" ? edge.targetPort : edge.sourcePort;
              const fixedPoint = props.diagramType === "usecase"
                ? useCaseAttachmentPoint(edge, fixedNode, towardFixed, nodes, edges)
                : fixedPort ? portPoint(fixedNode, fixedPort) : attachPoint(fixedNode, towardFixed);
              const movingPoint = hoveredNode && hoveredPort
                ? (props.diagramType === "usecase" ? offsetAttachmentPoint(hoveredNode, hoveredPort, 0) : portPoint(hoveredNode, hoveredPort))
                : { x: edgeEndpointPreview.x, y: edgeEndpointPreview.y };
              const source = edgeEndpointPreview.endpoint === "source" ? movingPoint : fixedPoint;
              const target = edgeEndpointPreview.endpoint === "target" ? movingPoint : fixedPoint;
              const path = edge.style === "curve"
                ? curvePath(source, target)
                : `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
              return (
                <g style={{ pointerEvents: "none" }}>
                  <path d={path} fill="none" stroke={hoveredNode ? "#3fb96f" : "#4da3ff"}
                    strokeWidth={2.5} strokeDasharray="6 4" />
                  <circle cx={movingPoint.x} cy={movingPoint.y} r={7} fill="#0d141b"
                    stroke={hoveredNode ? "#3fb96f" : "#4da3ff"} strokeWidth={2.5} />
                </g>
              );
            })() : null}
          </g>
        </svg>

        {miniMapVisible && !focusMode && nodes.length > 0 ? (
          <div
            ref={miniMapRef}
            className={`canvas-minimap ${miniMapDragging ? "dragging" : ""}`}
            role="navigation"
            aria-label="画布小地图"
            style={miniMapPosition ? { left: miniMapPosition.x, top: miniMapPosition.y, right: "auto", bottom: "auto" } : undefined}
          >
            <div
              className="canvas-minimap-head"
              role="button"
              tabIndex={0}
              aria-label="拖动画布导航"
              title="拖动导航；方向键也可移动"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const start = currentMiniMapPosition();
                if (!start) return;
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                miniMapDrag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start };
                setMiniMapDragging(true);
              }}
              onPointerMove={(event) => {
                const drag = miniMapDrag.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                event.preventDefault();
                event.stopPropagation();
                moveMiniMap({ x: drag.start.x + event.clientX - drag.clientX, y: drag.start.y + event.clientY - drag.clientY });
              }}
              onPointerUp={(event) => {
                if (miniMapDrag.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                miniMapDrag.current = null;
                setMiniMapDragging(false);
                snapMiniMap(currentMiniMapPosition());
              }}
              onPointerCancel={() => {
                miniMapDrag.current = null;
                setMiniMapDragging(false);
              }}
              onKeyDown={(event) => {
                const delta = event.shiftKey ? 24 : 12;
                const offset = event.key === "ArrowLeft" ? { x: -delta, y: 0 }
                  : event.key === "ArrowRight" ? { x: delta, y: 0 }
                    : event.key === "ArrowUp" ? { x: 0, y: -delta }
                      : event.key === "ArrowDown" ? { x: 0, y: delta }
                        : null;
                if (!offset) return;
                event.preventDefault();
                const current = currentMiniMapPosition();
                if (current) moveMiniMap({ x: current.x + offset.x, y: current.y + offset.y });
              }}
            >
              <span><GripHorizontal size={12} /> 导航</span><small>{nodes.length} 节点</small>
            </div>
            <svg
              viewBox={`0 0 ${miniMapWidth} ${miniMapHeight}`}
              aria-label="点击小地图定位画布"
              onPointerDown={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const mapX = (event.clientX - rect.left) * miniMapWidth / rect.width;
                const mapY = (event.clientY - rect.top) * miniMapHeight / rect.height;
                const worldX = (mapX - miniMapProjection.offsetX) / miniMapProjection.scale;
                const worldY = (mapY - miniMapProjection.offsetY) / miniMapProjection.scale;
                setPan({ x: viewportWidth / 2 - worldX * zoom, y: viewportHeight / 2 - worldY * zoom });
              }}
            >
              {paintOrder.map((paintLayer) => paintLayer === "edge" ? (
                <g key="edge" data-paint-layer="edge">
                  {visibleEdges.map((edge) => {
                    const from = visibleNodes.find((node) => node.id === edge.from);
                    const to = visibleNodes.find((node) => node.id === edge.to);
                    if (!from || !to) return null;
                    return <line key={edge.id} x1={miniMapProjection.projectX(from.x)} y1={miniMapProjection.projectY(from.y)} x2={miniMapProjection.projectX(to.x)} y2={miniMapProjection.projectY(to.y)} stroke="#476276" strokeWidth={0.8} />;
                  })}
                </g>
              ) : (
                <g key="node" data-paint-layer="node">
                  {visibleNodes.map((node) => (
                    <rect
                      key={node.id}
                      x={miniMapProjection.projectX(node.x - nodeW(node) / 2)}
                      y={miniMapProjection.projectY(node.y - nodeH(node) / 2)}
                      width={Math.max(3, nodeW(node) * miniMapProjection.scale)}
                      height={Math.max(2, nodeH(node) * miniMapProjection.scale)}
                      rx={1.5}
                      fill={NODE_STYLE[node.kind].stroke}
                      opacity={selectedIds.includes(node.id) ? 1 : 0.62}
                    />
                  ))}
                </g>
              ))}
              <rect
                className="canvas-minimap-viewport"
                x={miniMapProjection.projectX(visibleWorld.x)}
                y={miniMapProjection.projectY(visibleWorld.y)}
                width={visibleWorld.width * miniMapProjection.scale}
                height={visibleWorld.height * miniMapProjection.scale}
                fill="rgba(97,223,255,.06)"
                stroke="#61dfff"
                strokeWidth={1.1}
                rx={2}
              />
            </svg>
          </div>
        ) : null}

        {commandOpen ? (
          <div className="canvas-command-layer" onPointerDown={() => { setCommandOpen(false); setCommandQuery(""); }}>
            <div className="canvas-command" role="dialog" aria-modal="true" aria-label="查找并定位节点" onPointerDown={(event) => event.stopPropagation()}>
              <div className="canvas-command-search">
                <Search size={17} />
                <input
                  ref={commandInputRef}
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && commandResults[0]) {
                      event.preventDefault();
                      focusNode(commandResults[0]);
                    }
                  }}
                  placeholder="搜索名称、说明、负责人或类型…"
                  aria-label="搜索节点"
                />
                <kbd>Esc</kbd>
              </div>
              <div className="canvas-command-meta">
                <span>节点导航</span>
                <small>{commandResults.length} / {visibleNodes.length}</small>
              </div>
              <div className="canvas-command-results">
                {commandResults.length > 0 ? commandResults.map((node) => (
                  <button key={node.id} type="button" onClick={() => focusNode(node)}>
                    <span className="canvas-command-kind" style={{ "--node-accent": NODE_STYLE[node.kind].stroke } as CSSProperties}>{KIND_LABELS[node.kind]}</span>
                    <span><strong>{node.label}</strong><small>{node.description?.trim() || node.owner?.trim() || "无补充说明"}</small></span>
                    <LocateFixed size={15} />
                  </button>
                )) : <div className="canvas-command-empty">没有匹配节点</div>}
              </div>
              <div className="canvas-command-foot"><span>↑↓ 浏览</span><span>Enter 定位</span><span>Ctrl/⌘ K 打开</span></div>
            </div>
          </div>
        ) : null}

        {subCanvasPicker ? (
          <div className="canvas-subcanvas-picker-layer" onPointerDown={() => setSubCanvasPicker(null)}>
            <div
              className="canvas-subcanvas-picker"
              style={{ left: subCanvasPicker.left, top: subCanvasPicker.top }}
              role="dialog"
              aria-modal="true"
              aria-label={`选择 ${subCanvasPicker.nodeLabel} 的子画布`}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="canvas-subcanvas-picker-head">
                <div>
                  <small>关联画布 · {subCanvasPicker.choices.length}</small>
                  <strong>{subCanvasPicker.nodeLabel}</strong>
                </div>
                <button type="button" autoFocus aria-label="关闭子画布选择" onClick={() => setSubCanvasPicker(null)}><X size={14} /></button>
              </div>
              <div className="canvas-subcanvas-picker-list">
                {subCanvasPicker.choices.map((choice, index) => (
                  <button
                    key={choice.id}
                    type="button"
                    className="canvas-subcanvas-picker-item"
                    disabled={!choice.available}
                    onClick={() => {
                      setSubCanvasPicker(null);
                      props.onOpenDiagram(choice.id);
                    }}
                  >
                    <span className="canvas-subcanvas-picker-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="canvas-subcanvas-picker-copy">
                      <strong>{choice.title}</strong>
                      <small>{choice.available ? "打开关联画布" : "关联画布已删除"}</small>
                    </span>
                    <ExternalLink size={14} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {selectedIds.length > 0 ? (
          <div className="canvas-selection-bar">
            <span className="sel-count">{selectedIds.length} 选中</span>
            <button className="btn btn-ghost btn-sm" onClick={copySelected}>复制</button>
            <button className="btn btn-ghost btn-sm" onClick={pasteClipboard}>粘贴</button>
            <button className="btn btn-ghost btn-sm" onClick={extractSelected} title="把选中节点复制到一张新画布">
              <FolderPlus size={13} /> 子画布
            </button>
            {selectedIds.length >= 2 ? (
              <>
                {(["left", "hcenter", "right", "top", "vcenter", "bottom"] as AlignKind[]).map((k) => (
                  <button key={k} className="btn btn-ghost btn-sm" onClick={() => applyAlign(k)}>{ALIGN_LABELS[k]}</button>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={() => applyAlign("distH")}>水平等距</button>
                <button className="btn btn-ghost btn-sm" onClick={() => applyAlign("distV")}>垂直等距</button>
                <button className="btn btn-ghost btn-sm" onClick={groupSelected}>成组</button>
              </>
            ) : null}
            <button className="btn btn-ghost btn-sm btn-danger" onClick={deleteSelected}>
              <Trash2 size={13} /> 删除
            </button>
          </div>
        ) : null}

        {inspectorDocked ? (
          <>
            <button
              type="button"
              className="canvas-inspector-collapse"
              onClick={() => setInspectorCollapsed(true)}
              aria-label="折叠属性面板"
              title="折叠属性面板"
            >›</button>
            <div
              className="canvas-inspector-resize-handle"
              role="separator"
              aria-label="调整属性面板宽度"
              aria-orientation="vertical"
              aria-valuemin={INSPECTOR_MIN_WIDTH}
              aria-valuemax={INSPECTOR_MAX_WIDTH}
              aria-valuenow={inspectorWidth}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                inspectorResize.current = { pointerId: event.pointerId, clientX: event.clientX, width: inspectorWidth };
              }}
              onPointerMove={(event) => {
                const drag = inspectorResize.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                setInspectorWidth(clampInspectorWidth(drag.width + drag.clientX - event.clientX));
              }}
              onPointerUp={(event) => {
                if (inspectorResize.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                inspectorResize.current = null;
              }}
              onPointerCancel={() => { inspectorResize.current = null; }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setInspectorWidth((width) => clampInspectorWidth(width + (event.key === "ArrowLeft" ? 12 : -12)));
              }}
            />
          </>
        ) : null}
        {!focusMode && inspectorCollapsed && hasInspector ? (
          <button type="button" className="canvas-inspector-restore" onClick={() => setInspectorCollapsed(false)} aria-label="展开属性面板" title="展开属性面板">属性 ‹</button>
        ) : null}

        {!focusMode && !inspectorCollapsed ? (selectedEdge ? (
          <div className="canvas-inspector">
            <div className="inspector-title">连线编辑</div>
            {props.diagramType === "usecase" ? (
              <label className="field">
                <span className="field-label">用例关系</span>
                <select value={selectedEdge.relationType ?? "association"} onChange={(e) => {
                  const relationType = e.target.value as DiagramUseCaseRelationType;
                  updateEdge(selectedEdge.id, { relationType, label: USE_CASE_RELATION_META[relationType].label, style: "straight" });
                }}>
                  {DIAGRAM_USE_CASE_RELATION_TYPES.map((type) => (
                    <option key={type} value={type}>{type === "association" ? "关联" : type === "include" ? "包含（include）" : type === "extend" ? "扩展（extend）" : "泛化"}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span className="field-label">标签</span>
              <input list={`edge-labels-${props.diagramType}`} value={selectedEdge.label ?? ""} placeholder={props.diagramType === "flow" ? "流程或判断条件" : props.diagramType === "usecase" ? "可选，自定义关系文字" : "关系名称"}
                onChange={(e) => updateEdge(selectedEdge.id, { label: e.target.value })} />
              <datalist id={`edge-labels-${props.diagramType}`}>
                {EDGE_LABEL_SUGGESTIONS[props.diagramType].map((label) => <option key={label} value={label} />)}
              </datalist>
            </label>
            <label className="field">
              <span className="field-label">样式</span>
              <select value={selectedEdge.style ?? "curve"} onChange={(e) => updateEdge(selectedEdge.id, { style: e.target.value as "ortho" | "straight" | "curve" })}>
                <option value="curve">曲线（圆滑）</option>
                <option value="ortho">折线（直角）</option>
                <option value="straight">直线</option>
              </select>
            </label>
            <div className="edge-routing-grid">
              <label className="field">
                <span className="field-label">路由</span>
                <select value={diagramEdgeRoutingMode(selectedEdge)} onChange={(event) => {
                  const routingMode = event.target.value as "auto" | "manual";
                  updateEdge(selectedEdge.id, routingMode === "manual"
                    ? { routingMode, points: selectedRoute?.points ?? selectedEdge.points, routeVersion: 1 }
                    : { routingMode, points: undefined, routeVersion: 1 });
                }}>
                  <option value="auto">自动避障</option>
                  <option value="manual">手工路径</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">交叉</span>
                <select value={selectedEdge.jumpStyle ?? "arc"} onChange={(event) => updateEdge(selectedEdge.id, { jumpStyle: event.target.value as DiagramEdge["jumpStyle"], routeVersion: 1 })}>
                  <option value="arc">圆弧跳线</option>
                  <option value="gap">断口</option>
                  <option value="none">关闭</option>
                </select>
              </label>
            </div>
            <div className={`edge-routing-status ${selectedRoute?.degraded ? "is-degraded" : ""}`} role="status">
              <span>{selectedRoute?.degraded ? "已降级" : "路径正常"}</span>
              <small>{selectedRoute?.degraded
                ? selectedRoute.reason === "large-graph" ? "大图模式使用轻量路径，停止实时跳线计算"
                  : selectedRoute.reason === "invalid-manual-route" ? "手工路径无效，已回退自动路径"
                    : "没有找到无碰撞路径，已使用安全回退"
                : `${selectedRoute?.crossings.length ?? 0} 个跳线 · ${selectedRoute?.laneOffset ? `lane ${selectedRoute.laneOffset > 0 ? "+" : ""}${selectedRoute.laneOffset}px` : "中心 lane"}`}</small>
            </div>
            <div className="edge-visual-grid">
              <label className="field">
                <span className="field-label">颜色</span>
                <span className="edge-color-control">
                  <input type="color" value={selectedEdge.color ?? "#6f879b"} onChange={(event) => updateEdge(selectedEdge.id, { color: event.target.value })} />
                  <code>{selectedEdge.color ?? "#6f879b"}</code>
                </span>
              </label>
              <label className="field">
                <span className="field-label">线宽 · {selectedEdge.width ?? 2}px</span>
                <input type="range" min={1} max={6} step={0.5} value={selectedEdge.width ?? 2} onChange={(event) => updateEdge(selectedEdge.id, { width: Number(event.target.value) })} />
              </label>
              <label className="field">
                <span className="field-label">线型</span>
                <select value={selectedEdge.dash ?? "solid"} onChange={(event) => updateEdge(selectedEdge.id, { dash: event.target.value as DiagramEdge["dash"] })}>
                  <option value="solid">实线</option>
                  <option value="dashed">虚线</option>
                  <option value="dotted">点线</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">箭头</span>
                <select value={selectedEdge.arrow ?? "end"} onChange={(event) => updateEdge(selectedEdge.id, { arrow: event.target.value as DiagramEdge["arrow"] })}>
                  <option value="end">终点</option>
                  <option value="both">双向</option>
                  <option value="none">无箭头</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span className="field-label">标签位置 · {Math.round((selectedEdge.labelPosition ?? 0.5) * 100)}%</span>
              <input type="range" min={0.1} max={0.9} step={0.05} value={selectedEdge.labelPosition ?? 0.5} onChange={(event) => updateEdge(selectedEdge.id, { labelPosition: Number(event.target.value) })} />
            </label>
            <button className="btn btn-ghost btn-sm edge-route-reset" type="button" onClick={() => updateEdge(selectedEdge.id, { points: undefined, routingMode: "auto", routeVersion: 1 })}>
              <Route size={13} /> 重新计算路径
            </button>
            {props.diagramType === "flow" ? (
              <div className="delivery-status-grid">
                <label className="field">
                  <span className="field-label">起点端口</span>
                  <select value={selectedEdge.sourcePort ?? "bottom"} onChange={(e) => updateEdge(selectedEdge.id, { sourcePort: e.target.value as DiagramPort, style: "ortho" })}>
                    {DIAGRAM_PORTS.map((port) => <option key={port} value={port}>{PORT_LABELS[port]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">终点端口</span>
                  <select value={selectedEdge.targetPort ?? "top"} onChange={(e) => updateEdge(selectedEdge.id, { targetPort: e.target.value as DiagramPort, style: "ortho" })}>
                    {DIAGRAM_PORTS.map((port) => <option key={port} value={port}>{PORT_LABELS[port]}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
            <div className="spacer" />
            <button className="btn btn-danger btn-sm" onClick={() => deleteEdge(selectedEdge.id)}>删除连线</button>
          </div>
        ) : selectedGroup ? (
          <div className="canvas-inspector">
            <div className="inspector-title">组合</div>
            <label className="field">
              <span className="field-label">名称</span>
              <input value={selectedGroup.name} onChange={(e) => updateGroupName(selectedGroup.id, e.target.value)} />
            </label>
            <div className="cell-sub">{selectedGroup.nodeIds.length} 个节点 · 拖动任意成员即可整组移动</div>
            <div className="spacer" />
            <button className="btn btn-sm" onClick={() => ungroup(selectedGroup.id)}>取消成组</button>
          </div>
        ) : selectedNode ? (
          <div className="canvas-inspector canvas-delivery-inspector">
            <div className="inspector-heading">
              <div>
                <div className="inspector-title">{props.diagramType === "flow" ? "流程节点" : props.diagramType === "usecase" ? "用例节点" : "节点与交付"}</div>
                <div className="inspector-subtitle">{props.diagramType === "flow"
                  ? FLOW_NODE_META[flowTypeOf(selectedNode)].label
                  : props.diagramType === "usecase" ? USE_CASE_NODE_META[useCaseTypeOf(selectedNode)].label
                  : `${KIND_LABELS[selectedNode.kind]} · ${selectedNode.owner?.trim() || "未指定负责人"}`}</div>
              </div>
              {selectedShowsDelivery ? (
                <div className="delivery-summary" title="开发状态 / 验收状态">
                  <span style={{ "--status-color": DEVELOPMENT_STATUS_META[selectedNode.developmentStatus ?? "未开发"].color } as CSSProperties}>
                    开发 · {selectedNode.developmentStatus ?? "未开发"}
                  </span>
                  <span style={{ "--status-color": ACCEPTANCE_STATUS_META[selectedNode.acceptanceStatus ?? "未验收"].color } as CSSProperties}>
                    验收 · {selectedNode.acceptanceStatus ?? "未验收"}
                  </span>
                </div>
              ) : null}
            </div>
            {selectedShowsDelivery ? (
              <button className="btn btn-primary btn-sm inspector-detail-link" onClick={() => openNodeDetails(selectedNode.id)}>
                <ExternalLink size={13} /> 查看节点详情
              </button>
            ) : null}
            {selectedShowsDelivery ? (
              <div className="node-inspector-tabs" role="tablist" aria-label="节点信息">
                <button type="button" role="tab" aria-selected={nodeInspectorTab === "basic"}
                  className={nodeInspectorTab === "basic" ? "active" : ""} onClick={() => setNodeInspectorTab("basic")}>基本信息</button>
                <button type="button" role="tab" aria-selected={nodeInspectorTab === "delivery"}
                  className={nodeInspectorTab === "delivery" ? "active" : ""} onClick={() => setNodeInspectorTab("delivery")}>交付状态</button>
                <button type="button" role="tab" aria-selected={nodeInspectorTab === "acceptance"}
                  className={nodeInspectorTab === "acceptance" ? "active" : ""} onClick={() => setNodeInspectorTab("acceptance")}>验收</button>
              </div>
            ) : null}

            {!selectedShowsDelivery || isSimpleDiagram || nodeInspectorTab === "basic" ? (
              <div className="node-tab-panel" role="tabpanel">
                {inspectorError ? <div style={{ color: "var(--bad)", fontSize: 11.5 }}>{inspectorError}</div> : null}
                <label className="field">
                  <span className="field-label">名称</span>
                  <input type="text" value={selectedNode.label}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (isLabelTaken(v, selectedNode.id)) { setInspectorError("名称已存在"); return; }
                      setInspectorError("");
                      updateNode(selectedNode.id, { label: v });
                    }} />
                </label>
                <label className="field">
                  <span className="field-label">功能说明</span>
                  <textarea value={selectedNode.description ?? ""} placeholder="说明这个节点负责什么、边界是什么"
                    onChange={(e) => updateNode(selectedNode.id, { description: e.target.value })} />
                </label>
                <div className="delivery-status-grid">
                  {props.diagramType === "flow" ? (
                    <>
                      <label className="field diagram-node-type-field">
                        <span className="field-label">流程节点类型</span>
                        <select value={flowTypeOf(selectedNode)} onChange={(e) => {
                          const flowType = e.target.value as DiagramFlowNodeType;
                          const meta = FLOW_NODE_META[flowType];
                          updateNode(selectedNode.id, { flowType, kind: meta.kind, shape: meta.shape });
                        }}>
                          {DIAGRAM_FLOW_NODE_TYPES.map((type) => <option key={type} value={type}>{FLOW_NODE_META[type].label}</option>)}
                        </select>
                        <span className="diagram-auto-shape">
                          <span>形状随节点类型自动匹配</span>
                          <strong>{SHAPE_LABELS[FLOW_NODE_META[flowTypeOf(selectedNode)].shape]}</strong>
                        </span>
                      </label>
                    </>
                  ) : props.diagramType === "usecase" ? (
                    <>
                      <label className="field diagram-node-type-field">
                        <span className="field-label">用例节点类型</span>
                        <select value={useCaseTypeOf(selectedNode)} onChange={(e) => {
                          const useCaseType = e.target.value as DiagramUseCaseNodeType;
                          const meta = USE_CASE_NODE_META[useCaseType];
                          const size = useCaseType === "actor" ? { w: 90, h: 120 }
                            : useCaseType === "boundary" ? { w: 520, h: 390 }
                              : { w: 180, h: 72 };
                          updateNode(selectedNode.id, { useCaseType, kind: meta.kind, shape: meta.shape, ...size });
                        }}>
                          {DIAGRAM_USE_CASE_NODE_TYPES.map((type) => <option key={type} value={type}>{USE_CASE_NODE_META[type].label}</option>)}
                        </select>
                        <span className="diagram-auto-shape">
                          <span>形状随节点类型自动匹配</span>
                          <strong>{SHAPE_LABELS[USE_CASE_NODE_META[useCaseTypeOf(selectedNode)].shape]}</strong>
                        </span>
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span className="field-label">类型</span>
                        <select value={selectedNode.kind} onChange={(e) => updateNode(selectedNode.id, { kind: e.target.value as DiagramNodeKind })}>
                          {DIAGRAM_NODE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span className="field-label">形状</span>
                        <select value={selectedNode.shape ?? "rounded"} onChange={(e) => updateNode(selectedNode.id, { shape: e.target.value as NodeShape })}>
                          {NODE_SHAPES.map((s) => <option key={s} value={s}>{SHAPE_LABELS[s]}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                {props.diagramType === "usecase" && useCaseTypeOf(selectedNode) === "usecase" ? (
                  <>
                    <label className="field"><span className="field-label">前置条件</span><textarea value={selectedNode.preconditions ?? ""} placeholder="执行此用例前必须满足的条件" onChange={(e) => updateNode(selectedNode.id, { preconditions: e.target.value })} /></label>
                    <label className="field"><span className="field-label">基本流程</span><textarea value={selectedNode.mainFlow ?? ""} placeholder="按步骤描述正常交互流程" onChange={(e) => updateNode(selectedNode.id, { mainFlow: e.target.value })} /></label>
                    <label className="field"><span className="field-label">备选 / 异常流程</span><textarea value={selectedNode.alternateFlow ?? ""} placeholder="描述分支、异常与失败处理" onChange={(e) => updateNode(selectedNode.id, { alternateFlow: e.target.value })} /></label>
                    <label className="field"><span className="field-label">后置条件</span><textarea value={selectedNode.postconditions ?? ""} placeholder="用例完成后的系统状态" onChange={(e) => updateNode(selectedNode.id, { postconditions: e.target.value })} /></label>
                  </>
                ) : null}
                <label className="field">
                  <span className="field-label">尺寸 {Math.round(nodeW(selectedNode))}×{Math.round(nodeH(selectedNode))}</span>
                  <input type="range" min={MIN_W} max={useCaseTypeOf(selectedNode) === "boundary" ? 1000 : 420} value={nodeW(selectedNode)}
                    onChange={(e) => updateNode(selectedNode.id, { w: Number(e.target.value) })} />
                  <input type="range" min={MIN_H} max={useCaseTypeOf(selectedNode) === "boundary" ? 800 : 260} value={nodeH(selectedNode)}
                    onChange={(e) => updateNode(selectedNode.id, { h: Number(e.target.value) })} />
                </label>
            {selectedShowsDelivery ? (
                  <>
                    <div className="field">
                      <span className="field-label">关联子画布（钻取，可多选）</span>
                      {(props.linkOptions ?? []).length > 0 ? (
                        <div className="node-link-options">
                          {props.linkOptions.map((d) => {
                            const checked = (selectedNode.linkDiagramIds ?? []).includes(d.id);
                            return (
                              <label key={d.id} className={`node-link-option${checked ? " checked" : ""}`}>
                                <input type="checkbox" checked={checked}
                                  onChange={(e) => toggleSubCanvasLink(d.id, e.target.checked)} />
                                <span title={d.title}>{d.title}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="field-hint">暂无可关联的子画布</span>
                      )}
                      {(selectedNode.linkDiagramIds ?? []).length > 0 ? (
                        <div className="node-link-opens">
                          {(selectedNode.linkDiagramIds ?? []).map((id) => {
                            const opt = (props.linkOptions ?? []).find((d) => d.id === id);
                            return (
                              <button key={id} className="btn btn-sm" type="button"
                                onClick={() => props.onOpenDiagram(id)}
                                title={opt ? `打开 ${opt.title}` : "关联的子画布已删除"}>
                                <span>打开 {opt ? opt.title : "已删除的画布"}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {selectedShowsDelivery && nodeInspectorTab === "delivery" ? (
              <div className="node-tab-panel" role="tabpanel">
                {selectedPlanSummary ? (
                  <div className="canvas-plan-summary">
                    <div className="canvas-plan-summary-head">
                      <div><span>开发计划</span><strong>{selectedPlanSummary.completed}/{selectedPlanSummary.total} 已完成</strong></div>
                      <b>{selectedPlanSummary.progress}%</b>
                    </div>
                    <div className="canvas-plan-progress"><span style={{ width: `${selectedPlanSummary.progress}%` }} /></div>
                    <dl>
                      <dt>当前</dt><dd>{selectedPlanSummary.currentTitle ?? (selectedPlanSummary.completed === selectedPlanSummary.total ? "全部动作已完成" : "尚未开始")}</dd>
                      <dt>下一步</dt><dd>{selectedPlanSummary.nextTitle ?? (selectedPlanSummary.completed === selectedPlanSummary.total ? "进入独立审计" : "未安排")}</dd>
                    </dl>
                    <button className="btn btn-ghost btn-sm" onClick={() => openNodeDetails(selectedNode.id, "development")}>
                      <ExternalLink size={12} /> 打开施工交付
                    </button>
                  </div>
                ) : (
                  <button className="canvas-plan-empty" onClick={() => openNodeDetails(selectedNode.id, "development")}>
                    还没有开发计划 · 点击新增
                  </button>
                )}
                <div className="delivery-status-grid">
                  <label className="field">
                    <span className="field-label">需求状态</span>
                    <select value={selectedNode.requirementStatus ?? "待整理"}
                      onChange={(e) => updateNode(selectedNode.id, { requirementStatus: e.target.value as RequirementStatus })}>
                      {REQUIREMENT_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">设计状态</span>
                    <select value={selectedNode.designStatus ?? "未开始"}
                      onChange={(e) => updateNode(selectedNode.id, { designStatus: e.target.value as DesignStatus })}>
                      {DESIGN_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>
                </div>
                <div className="delivery-status-grid">
                  <div className="delivery-derived-status"><span>开发状态</span><strong>{selectedNode.developmentStatus ?? "未开发"}</strong><small>由施工计划自动汇总</small></div>
                  <div className="delivery-derived-status"><span>验收状态</span><strong>{selectedNode.acceptanceStatus ?? "未验收"}</strong><small>由独立审计与主 Agent 决定</small></div>
                </div>
                <label className="field">
                  <span className="field-label">负责人</span>
                  <input type="text" value={selectedNode.owner ?? ""} placeholder="负责人或团队"
                    onChange={(e) => updateNode(selectedNode.id, { owner: e.target.value })} />
                </label>
                <label className="workflow-checkbox">
                  <input type="checkbox" checked={selectedNode.requiresDatabase ?? selectedNode.kind === "data"} disabled={selectedNode.kind === "data"}
                    onChange={(e) => updateNode(selectedNode.id, { requiresDatabase: e.target.checked })} />
                  <span><strong>该节点需要数据库</strong><small>开发前必须关联数据库模型和具体表。</small></span>
                </label>
                {selectedNode.developmentStatus === "已阻塞" ? (
                  <label className="field field-alert">
                    <span className="field-label">阻塞原因</span>
                    <textarea value={selectedNode.blockedReason ?? ""} placeholder="说明阻塞原因和解除条件"
                      onChange={(e) => updateNode(selectedNode.id, { blockedReason: e.target.value })} />
                  </label>
                ) : null}
                <label className="field">
                  <span className="field-label">补充说明</span>
                  <textarea value={selectedNode.notes ?? ""} placeholder="风险、限制、遗留事项或其他说明"
                    onChange={(e) => updateNode(selectedNode.id, { notes: e.target.value })} />
                </label>
              </div>
            ) : null}

            {selectedShowsDelivery && nodeInspectorTab === "acceptance" ? (
              <div className="node-tab-panel" role="tabpanel">
                <label className="field">
                  <span className="field-label">验收标准</span>
                  <textarea value={selectedNode.acceptanceCriteria ?? ""} placeholder="写清楚什么结果才算验收通过"
                    onChange={(e) => updateNode(selectedNode.id, { acceptanceCriteria: e.target.value })} />
                </label>
                <div className="evidence-empty">
                  验收证据已统一为独立 Evidence 记录，请在节点详情中查看和维护。
                  <button className="btn btn-ghost btn-sm" onClick={() => openNodeDetails(selectedNode.id)}><ExternalLink size={12} /> 打开节点证据</button>
                </div>
              </div>
            ) : null}
            <div className="canvas-inspector-footer">
              {!isSimpleDiagram && selectedNode.deliveryUpdatedAt ? (
                <div className="delivery-updated">最后更新：{formatDateTime(selectedNode.deliveryUpdatedAt)}</div>
              ) : <span />}
              <button className="btn btn-danger btn-sm" onClick={() => deleteSelected()}><Trash2 size={13} /> 删除节点</button>
            </div>
          </div>
        ) : null) : null}
      </div>
      <div className="canvas-hint"><span>精密模式</span> 空白拖动平移 · Ctrl/⌘+滚轮缩放 · Shift+拖动框选 · 四向端口连线 · 选中连线可拖折点 · Ctrl/⌘+K 搜索{!isSimpleDiagram ? " · 双击节点查看详情" : ""} · {snapEnabled ? "吸附已开启" : "自由移动"}</div>
    </div>
  );
}
