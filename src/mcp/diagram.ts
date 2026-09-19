import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DIAGRAM_ACCEPTANCE_STATUSES,
  DIAGRAM_DEVELOPMENT_STATUSES,
  DIAGRAM_FLOW_NODE_TYPES,
  DIAGRAM_NODE_KINDS,
  DIAGRAM_PORTS,
  DIAGRAM_USE_CASE_NODE_TYPES,
  DIAGRAM_USE_CASE_RELATION_TYPES,
  DESIGN_STATUSES,
  NODE_SHAPES,
  REQUIREMENT_STATUSES,
  type Diagram,
  type DiagramEdge,
  type DiagramFlowNodeType,
  type DiagramGroup,
  type DiagramNode,
  type DiagramNodeKind,
  type DiagramType,
  type DiagramUseCaseNodeType,
  type DiagramUseCaseRelationType,
  type NodeShape,
  type PlanItem,
} from "../shared/types.js";
import {
  assertNoIntroducedDiagramGroupOverlap,
  listDiagramGroupOverlaps,
} from "../shared/diagramGroups.js";
import {
  diagramEdgeRoutingMode,
  diagramPathPointAt,
  diagramPolylinePath,
  moveDiagramManualRoute,
  routeDiagramEdges,
} from "../shared/diagramRouting.js";
import { newId, nowIso } from "../server/db.js";

export const diagramNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(DIAGRAM_NODE_KINDS),
  label: z.string().trim().min(1).max(200),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().min(40).max(2000).optional(),
  h: z.number().finite().min(30).max(2000).optional(),
  shape: z.enum(NODE_SHAPES).optional(),
  flowType: z.enum(DIAGRAM_FLOW_NODE_TYPES).optional(),
  useCaseType: z.enum(DIAGRAM_USE_CASE_NODE_TYPES).optional(),
  linkDiagramIds: z.array(z.string().min(1)).max(16).optional(),
  linkDiagramId: z.string().min(1).optional(),
  description: z.string().max(5000).optional(),
  requirementStatus: z.enum(REQUIREMENT_STATUSES).optional(),
  designStatus: z.enum(DESIGN_STATUSES).optional(),
  requiresDatabase: z.boolean().optional(),
  developmentStatus: z.enum(DIAGRAM_DEVELOPMENT_STATUSES).optional(),
  acceptanceStatus: z.enum(DIAGRAM_ACCEPTANCE_STATUSES).optional(),
  owner: z.string().max(200).optional(),
  acceptanceCriteria: z.string().max(10_000).optional(),
  notes: z.string().max(10_000).optional(),
  blockedReason: z.string().max(5000).optional(),
  deliveryUpdatedAt: z.string().max(64).optional(),
  preconditions: z.string().max(10_000).optional(),
  mainFlow: z.string().max(20_000).optional(),
  alternateFlow: z.string().max(20_000).optional(),
  postconditions: z.string().max(10_000).optional(),
});

export const diagramEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  sourcePort: z.enum(DIAGRAM_PORTS).optional(),
  targetPort: z.enum(DIAGRAM_PORTS).optional(),
  label: z.string().max(200).optional(),
  style: z.enum(["ortho", "straight", "curve"]).optional(),
  points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).min(2).max(500).optional(),
  relationType: z.enum(DIAGRAM_USE_CASE_RELATION_TYPES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  width: z.number().finite().min(1).max(8).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  arrow: z.enum(["end", "both", "none"]).optional(),
  labelPosition: z.number().finite().min(0).max(1).optional(),
  routingMode: z.enum(["auto", "manual"]).optional(),
  jumpStyle: z.enum(["arc", "gap", "none"]).optional(),
  routeVersion: z.literal(1).optional(),
});

export const diagramGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  nodeIds: z.array(z.string().min(1)).min(2).max(500),
});

const diagramNodeCreateSchema = diagramNodeSchema.omit({ id: true }).extend({
  id: z.string().min(1).optional(),
  kind: z.enum(DIAGRAM_NODE_KINDS).default("feature"),
  x: z.number().finite().default(120),
  y: z.number().finite().default(120),
});

const diagramEdgeCreateSchema = diagramEdgeSchema.omit({ id: true }).extend({ id: z.string().min(1).optional() });
const diagramGroupCreateSchema = diagramGroupSchema.omit({ id: true }).extend({ id: z.string().min(1).optional() });
const diagramNodePatchSchema = diagramNodeSchema.partial().omit({ id: true });
const diagramEdgePatchSchema = diagramEdgeSchema.partial().omit({ id: true });
const diagramGroupPatchSchema = diagramGroupSchema.partial().omit({ id: true });

export const diagramOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: diagramNodeCreateSchema }),
  z.object({ op: z.literal("update_node"), nodeId: z.string().min(1), patch: diagramNodePatchSchema }),
  z.object({ op: z.literal("delete_node"), nodeId: z.string().min(1) }),
  z.object({ op: z.literal("add_edge"), edge: diagramEdgeCreateSchema }),
  z.object({ op: z.literal("update_edge"), edgeId: z.string().min(1), patch: diagramEdgePatchSchema }),
  z.object({ op: z.literal("delete_edge"), edgeId: z.string().min(1) }),
  z.object({ op: z.literal("add_group"), group: diagramGroupCreateSchema }),
  z.object({ op: z.literal("update_group"), groupId: z.string().min(1), patch: diagramGroupPatchSchema }),
  z.object({ op: z.literal("delete_group"), groupId: z.string().min(1) }),
]);

export type DiagramOperation = z.infer<typeof diagramOperationSchema>;
export type DiagramAlignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom" | "distH" | "distV";
export type DiagramTemplateId = "blank" | "arch" | "flow" | "module" | "usecase";

const DEFAULT_W = 176;
const DEFAULT_H = 46;

const FLOW_NODE_META: Record<DiagramFlowNodeType, { shape: NodeShape; kind: DiagramNodeKind }> = {
  start: { shape: "ellipse", kind: "system" },
  end: { shape: "ellipse", kind: "system" },
  process: { shape: "rect", kind: "feature" },
  decision: { shape: "diamond", kind: "requirement" },
  input_output: { shape: "parallelogram", kind: "data" },
  subprocess: { shape: "predefined", kind: "interface" },
  document: { shape: "document", kind: "note" },
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

function clearRoutesForNodes(edges: DiagramEdge[], nodeIds: Iterable<string>): DiagramEdge[] {
  const changed = new Set(nodeIds);
  return edges.map((edge) => (changed.has(edge.from) || changed.has(edge.to)) && diagramEdgeRoutingMode(edge) !== "manual"
    ? { ...edge, points: undefined, routingMode: "auto", routeVersion: 1 }
    : edge);
}

function normalizeFlowNode(node: DiagramNode): DiagramNode {
  if (!node.flowType) return node;
  const meta = FLOW_NODE_META[node.flowType];
  return { ...node, kind: meta.kind, shape: meta.shape };
}

export function assertDiagramStructure(diagram: Pick<Diagram, "nodes" | "edges" | "groups">): void {
  const nodeIds = new Set<string>();
  const labels = new Set<string>();
  for (const node of diagram.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`画布节点 id 重复: ${node.id}`);
    nodeIds.add(node.id);
    const normalized = node.label.trim().toLowerCase();
    if (!normalized) throw new Error(`画布节点名称不能为空: ${node.id}`);
    if (labels.has(normalized)) throw new Error(`画布节点名称重复: ${node.label}`);
    labels.add(normalized);
  }
  const edgeIds = new Set<string>();
  for (const edge of diagram.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`画布连线 id 重复: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`连线 ${edge.id} 引用了不存在的节点`);
  }
  const groupIds = new Set<string>();
  for (const group of diagram.groups) {
    if (groupIds.has(group.id)) throw new Error(`画布分组 id 重复: ${group.id}`);
    groupIds.add(group.id);
    const members = new Set(group.nodeIds);
    if (members.size < 2) throw new Error(`分组 ${group.name} 至少需要两个节点`);
    for (const nodeId of members) if (!nodeIds.has(nodeId)) throw new Error(`分组 ${group.name} 引用了不存在的节点 ${nodeId}`);
  }
}

export function applyDiagramOperations(diagram: Diagram, operations: DiagramOperation[]): Diagram {
  let nodes: DiagramNode[] = diagram.nodes.map((node) => ({ ...node }));
  let edges: DiagramEdge[] = diagram.edges.map((edge) => ({ ...edge, points: edge.points?.map((point) => ({ ...point })) }));
  let groups: DiagramGroup[] = diagram.groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] }));
  for (const operation of operations) {
    switch (operation.op) {
      case "add_node": {
        const node = normalizeFlowNode({
          ...operation.node,
          id: operation.node.id ?? newId(),
          deliveryUpdatedAt: operation.node.deliveryUpdatedAt ?? (diagram.type === "flow" ? undefined : nowIso()),
        });
        nodes.push(node as DiagramNode);
        break;
      }
      case "update_node": {
        const index = nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new Error(`画布节点不存在: ${operation.nodeId}`);
        const previousNode = nodes[index];
        const geometryChanged = operation.patch.x !== undefined || operation.patch.y !== undefined || operation.patch.w !== undefined || operation.patch.h !== undefined;
        nodes[index] = normalizeFlowNode({ ...nodes[index], ...operation.patch, id: nodes[index].id, deliveryUpdatedAt: nowIso() }) as DiagramNode;
        if (geometryChanged) {
          const delta = { x: nodes[index].x - previousNode.x, y: nodes[index].y - previousNode.y };
          edges = edges.map((edge) => {
            if (edge.from !== operation.nodeId && edge.to !== operation.nodeId) return edge;
            if (diagramEdgeRoutingMode(edge) !== "manual") return { ...edge, points: undefined, routingMode: "auto", routeVersion: 1 };
            return {
              ...edge,
              points: moveDiagramManualRoute(
                edge,
                edge.from === operation.nodeId ? delta : undefined,
                edge.to === operation.nodeId ? delta : undefined,
              ),
              routingMode: "manual",
              routeVersion: 1,
            };
          });
        }
        break;
      }
      case "delete_node": {
        if (!nodes.some((node) => node.id === operation.nodeId)) throw new Error(`画布节点不存在: ${operation.nodeId}`);
        nodes = nodes.filter((node) => node.id !== operation.nodeId);
        edges = edges.filter((edge) => edge.from !== operation.nodeId && edge.to !== operation.nodeId);
        groups = groups
          .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== operation.nodeId) }))
          .filter((group) => group.nodeIds.length >= 2);
        break;
      }
      case "add_edge":
        edges.push({ ...operation.edge, id: operation.edge.id ?? newId() } as DiagramEdge);
        break;
      case "update_edge": {
        const index = edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new Error(`画布连线不存在: ${operation.edgeId}`);
        const routeChanged = operation.patch.from !== undefined || operation.patch.to !== undefined || operation.patch.sourcePort !== undefined || operation.patch.targetPort !== undefined || operation.patch.style !== undefined;
        edges[index] = {
          ...edges[index],
          ...operation.patch,
          id: edges[index].id,
          points: routeChanged ? undefined : (operation.patch.points ?? edges[index].points),
          routingMode: routeChanged ? "auto" : (operation.patch.routingMode ?? edges[index].routingMode),
          routeVersion: routeChanged ? 1 : (operation.patch.routeVersion ?? edges[index].routeVersion),
        } as DiagramEdge;
        break;
      }
      case "delete_edge": {
        if (!edges.some((edge) => edge.id === operation.edgeId)) throw new Error(`画布连线不存在: ${operation.edgeId}`);
        edges = edges.filter((edge) => edge.id !== operation.edgeId);
        break;
      }
      case "add_group":
        groups.push({ ...operation.group, id: operation.group.id ?? newId(), nodeIds: [...new Set(operation.group.nodeIds)] });
        break;
      case "update_group": {
        const index = groups.findIndex((group) => group.id === operation.groupId);
        if (index < 0) throw new Error(`画布分组不存在: ${operation.groupId}`);
        groups[index] = {
          ...groups[index],
          ...operation.patch,
          id: groups[index].id,
          nodeIds: operation.patch.nodeIds ? [...new Set(operation.patch.nodeIds)] : groups[index].nodeIds,
        };
        break;
      }
      case "delete_group": {
        if (!groups.some((group) => group.id === operation.groupId)) throw new Error(`画布分组不存在: ${operation.groupId}`);
        groups = groups.filter((group) => group.id !== operation.groupId);
        break;
      }
    }
  }
  const next = { ...diagram, nodes, edges, groups, updatedAt: nowIso() };
  assertDiagramStructure(next);
  assertNoIntroducedDiagramGroupOverlap(diagram, next);
  return next;
}

export function alignDiagramNodes(diagram: Diagram, nodeIds: string[], alignment: DiagramAlignment): Diagram {
  const selected = diagram.nodes.filter((node) => nodeIds.includes(node.id));
  if (selected.length < 2) throw new Error("对齐至少需要两个节点");
  if ((alignment === "distH" || alignment === "distV") && selected.length < 3) throw new Error("等距分布至少需要三个节点");
  const xs = selected.map((node) => node.x);
  const ys = selected.map((node) => node.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  const selectedIds = new Set(nodeIds);
  let nodes: DiagramNode[];
  if (alignment === "distH" || alignment === "distV") {
    const axis = alignment === "distH" ? "x" : "y";
    const ordered = [...selected].sort((a, b) => a[axis] - b[axis]);
    const first = ordered[0][axis], last = ordered[ordered.length - 1][axis];
    const step = (last - first) / (ordered.length - 1);
    const positions = new Map(ordered.map((node, index) => [node.id, first + step * index]));
    nodes = diagram.nodes.map((node) => positions.has(node.id) ? { ...node, [axis]: positions.get(node.id)! } : node);
  } else {
    nodes = diagram.nodes.map((node) => {
      if (!selectedIds.has(node.id)) return node;
      if (alignment === "left") return { ...node, x: minX };
      if (alignment === "right") return { ...node, x: maxX };
      if (alignment === "hcenter") return { ...node, x: midX };
      if (alignment === "top") return { ...node, y: minY };
      if (alignment === "bottom") return { ...node, y: maxY };
      return { ...node, y: midY };
    });
  }
  return { ...diagram, nodes, edges: clearRoutesForNodes(diagram.edges, selectedIds), updatedAt: nowIso() };
}

export function duplicateDiagramNodes(diagram: Diagram, nodeIds: string[], offsetX: number, offsetY: number): { diagram: Diagram; createdNodeIds: string[] } {
  const selectedIds = new Set(nodeIds);
  const selected = diagram.nodes.filter((node) => selectedIds.has(node.id));
  if (selected.length === 0) throw new Error("没有可复制的节点");
  const idMap = new Map(selected.map((node) => [node.id, newId()]));
  const clones = selected.map((node) => ({ ...node, id: idMap.get(node.id)!, x: node.x + offsetX, y: node.y + offsetY, deliveryUpdatedAt: nowIso() }));
  const clonedEdges = diagram.edges
    .filter((edge) => idMap.has(edge.from) && idMap.has(edge.to))
    .map((edge) => ({ ...edge, id: newId(), from: idMap.get(edge.from)!, to: idMap.get(edge.to)!, points: undefined }));
  const next = { ...diagram, nodes: [...diagram.nodes, ...clones], edges: [...diagram.edges, ...clonedEdges], updatedAt: nowIso() };
  assertDiagramStructure(next);
  return { diagram: next, createdNodeIds: clones.map((node) => node.id) };
}

export function buildDiagramTemplate(template: DiagramTemplateId): { type: DiagramType; nodes: DiagramNode[]; edges: DiagramEdge[] } {
  if (template === "blank") return { type: "free", nodes: [], edges: [] };
  if (template === "arch") {
    const nodes: DiagramNode[] = [
      { id: newId(), kind: "system", label: "客户端", x: 80, y: 80, shape: "ellipse" },
      { id: newId(), kind: "module", label: "接入网关", x: 320, y: 80, shape: "rect" },
      { id: newId(), kind: "module", label: "应用服务", x: 560, y: 80, shape: "rect" },
      { id: newId(), kind: "data", label: "数据存储", x: 800, y: 80, shape: "cylinder" },
    ];
    return { type: "deployment", nodes, edges: nodes.slice(0, -1).map((node, index) => ({ id: newId(), from: node.id, to: nodes[index + 1].id, style: "ortho" })) };
  }
  if (template === "flow") {
    const nodes: DiagramNode[] = [
      { id: newId(), kind: "system", label: "开始", x: 80, y: 80, shape: "ellipse", flowType: "start" },
      { id: newId(), kind: "feature", label: "提交需求", x: 320, y: 80, shape: "rect", flowType: "process" },
      { id: newId(), kind: "requirement", label: "审批通过?", x: 560, y: 80, shape: "diamond", flowType: "decision" },
      { id: newId(), kind: "system", label: "结束", x: 800, y: 80, shape: "ellipse", flowType: "end" },
    ];
    return {
      type: "flow",
      nodes,
      edges: [
        { id: newId(), from: nodes[0].id, to: nodes[1].id, label: "发起", style: "ortho" },
        { id: newId(), from: nodes[1].id, to: nodes[2].id, label: "送审", style: "ortho" },
        { id: newId(), from: nodes[2].id, to: nodes[3].id, label: "是", style: "ortho" },
        { id: newId(), from: nodes[2].id, to: nodes[1].id, label: "否", style: "curve" },
      ],
    };
  }
  if (template === "usecase") {
    const nodes: DiagramNode[] = [
      { id: newId(), kind: "system", label: "业务系统", x: 470, y: 270, w: 520, h: 390, shape: "boundary", useCaseType: "boundary" },
      { id: newId(), kind: "interface", label: "用户", x: 100, y: 230, w: 90, h: 120, shape: "actor", useCaseType: "actor" },
      { id: newId(), kind: "requirement", label: "登录系统", x: 380, y: 180, w: 180, h: 72, shape: "ellipse", useCaseType: "usecase" },
      { id: newId(), kind: "requirement", label: "查看业务数据", x: 560, y: 310, w: 180, h: 72, shape: "ellipse", useCaseType: "usecase" },
    ];
    return {
      type: "usecase",
      nodes,
      edges: [
        { id: newId(), from: nodes[1].id, to: nodes[2].id, style: "straight", relationType: "association" },
        { id: newId(), from: nodes[1].id, to: nodes[3].id, style: "straight", relationType: "association" },
      ],
    };
  }
  const nodes: DiagramNode[] = [
    { id: newId(), kind: "module", label: "系统", x: 360, y: 80, shape: "rect" },
    { id: newId(), kind: "feature", label: "模块 A", x: 80, y: 260, shape: "rounded" },
    { id: newId(), kind: "feature", label: "模块 B", x: 360, y: 260, shape: "rounded" },
    { id: newId(), kind: "feature", label: "模块 C", x: 640, y: 260, shape: "rounded" },
  ];
  return { type: "functional", nodes, edges: nodes.slice(1).map((node) => ({ id: newId(), from: nodes[0].id, to: node.id, style: "ortho" })) };
}

export interface DiagramValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  entityId?: string;
}

export function validateDiagram(diagram: Diagram, context: { diagrams?: Diagram[]; plans?: PlanItem[] } = {}): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  const nodeIds = new Set(diagram.nodes.map((node) => node.id));
  const linked = new Map((context.diagrams ?? []).map((item) => [item.id, item]));
  const seenLabels = new Map<string, string>();
  for (const node of diagram.nodes) {
    const key = node.label.trim().toLowerCase();
    if (!key) issues.push({ severity: "error", code: "empty_node_label", message: "节点名称不能为空", entityId: node.id });
    else if (seenLabels.has(key)) issues.push({ severity: "error", code: "duplicate_node_label", message: `节点名称重复: ${node.label}`, entityId: node.id });
    else seenLabels.set(key, node.id);
    for (const childId of node.linkDiagramIds ?? []) {
      const target = linked.get(childId);
      if (!target) issues.push({ severity: "error", code: "broken_diagram_link", message: `子画布不存在: ${childId}`, entityId: node.id });
      else if (target.projectId !== diagram.projectId) issues.push({ severity: "error", code: "cross_project_diagram_link", message: "不能关联其他项目的画布", entityId: node.id });
    }
    if (node.developmentStatus === "已阻塞" && !node.blockedReason?.trim()) {
      issues.push({ severity: "warning", code: "blocked_without_reason", message: "节点已阻塞但没有填写阻塞原因", entityId: node.id });
    }
  }
  for (const edge of diagram.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) issues.push({ severity: "error", code: "broken_edge", message: "连线引用了不存在的节点", entityId: edge.id });
  }
  for (const overlap of listDiagramGroupOverlaps(diagram)) {
    issues.push({
      severity: "error",
      code: "overlapping_groups",
      message: `组合区域“${overlap.first.name}”与“${overlap.second.name}”存在重叠`,
      entityId: overlap.first.id,
    });
  }
  if (diagram.nodes.length > 1) {
    for (const node of diagram.nodes) {
      if (diagram.type === "usecase" && useCaseTypeOf(node) === "boundary") continue;
      if (!diagram.edges.some((edge) => edge.from === node.id || edge.to === node.id)) issues.push({ severity: "warning", code: "isolated_node", message: `孤立节点: ${node.label}`, entityId: node.id });
    }
  }
  if (diagram.type === "flow") {
    const starts = diagram.nodes.filter((node) => flowTypeOf(node) === "start");
    const ends = diagram.nodes.filter((node) => flowTypeOf(node) === "end");
    if (starts.length === 0) issues.push({ severity: "error", code: "missing_start", message: "流程图缺少开始节点" });
    if (ends.length === 0) issues.push({ severity: "error", code: "missing_end", message: "流程图缺少结束节点" });
    for (const node of diagram.nodes.filter((item) => flowTypeOf(item) === "decision")) {
      const outgoing = diagram.edges.filter((edge) => edge.from === node.id);
      const labels = outgoing.map((edge) => edge.label?.trim()).filter(Boolean) as string[];
      if (outgoing.length < 2 || labels.length < 2) issues.push({ severity: "error", code: "decision_branches", message: `判断节点“${node.label}”至少需要两个带条件名称的分支`, entityId: node.id });
      if (new Set(labels).size !== labels.length) issues.push({ severity: "error", code: "duplicate_branch_label", message: `判断节点“${node.label}”存在重复条件`, entityId: node.id });
    }
  }
  if (diagram.type === "usecase") {
    const actors = diagram.nodes.filter((node) => useCaseTypeOf(node) === "actor");
    const useCases = diagram.nodes.filter((node) => useCaseTypeOf(node) === "usecase");
    if (actors.length === 0) issues.push({ severity: "error", code: "missing_actor", message: "用例图缺少参与者" });
    if (useCases.length === 0) issues.push({ severity: "error", code: "missing_usecase", message: "用例图缺少用例" });
    for (const edge of diagram.edges) {
      const from = diagram.nodes.find((node) => node.id === edge.from), to = diagram.nodes.find((node) => node.id === edge.to);
      if (!from || !to) continue;
      const fromType = useCaseTypeOf(from), toType = useCaseTypeOf(to), relationType = edge.relationType ?? "association";
      if (fromType === "boundary" || toType === "boundary") issues.push({ severity: "error", code: "boundary_relation", message: "系统边界不能作为关系线端点", entityId: edge.id });
      else if ((relationType === "include" || relationType === "extend") && (fromType !== "usecase" || toType !== "usecase")) issues.push({ severity: "error", code: "invalid_usecase_relation", message: `${relationType} 只能连接两个用例`, entityId: edge.id });
      else if (relationType === "generalization" && fromType !== toType) issues.push({ severity: "error", code: "invalid_generalization", message: "泛化关系两端必须同为参与者或同为用例", entityId: edge.id });
    }
  }
  for (const plan of context.plans ?? []) {
    if (plan.diagramId === diagram.id && plan.diagramNodeId && !nodeIds.has(plan.diagramNodeId)) issues.push({ severity: "error", code: "orphan_plan_binding", message: `计划项“${plan.title}”绑定了不存在的画布节点`, entityId: plan.id });
  }
  return issues;
}

const NODE_STYLE: Record<DiagramNodeKind, { fill: string; stroke: string; text: string; dashed?: boolean }> = {
  system: { fill: "#17343c", stroke: "#31c4db", text: "#d4f8ff" },
  module: { fill: "#1b3046", stroke: "#4da3ff", text: "#cfe4ff" },
  feature: { fill: "#193a2b", stroke: "#3fb96f", text: "#bfe9cf" },
  requirement: { fill: "#3b3020", stroke: "#e2a33c", text: "#f6e2bf" },
  interface: { fill: "#302545", stroke: "#a878eb", text: "#e3d4fb" },
  data: { fill: "#1a3540", stroke: "#56ccf2", text: "#cfeffb" },
  note: { fill: "#202b34", stroke: "#9fb0bf", text: "#cdd8e1", dashed: true },
};
const KIND_LABELS: Record<DiagramNodeKind, string> = { system: "系统", module: "模块", feature: "功能", requirement: "需求", interface: "接口", data: "数据", note: "备注" };
const DEVELOPMENT_COLORS = { 未开发: "#718596", 开发中: "#4da3ff", 待验收: "#e2a33c", 已完成: "#3fb96f", 已阻塞: "#e05d5d" } as const;
const ACCEPTANCE_COLORS = { 未验收: "#718596", 验收中: "#a878eb", 已通过: "#3fb96f", 未通过: "#e05d5d" } as const;

const nodeW = (node: DiagramNode): number => node.w ?? DEFAULT_W;
const nodeH = (node: DiagramNode): number => node.h ?? DEFAULT_H;
const xml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

function cylinderPath(w: number, h: number): string {
  const ry = Math.min(14, h * 0.22), top = -h / 2, bottom = h / 2;
  return `M ${-w / 2} ${top + ry} A ${w / 2} ${ry} 0 0 1 ${w / 2} ${top + ry} V ${bottom - ry} A ${w / 2} ${ry} 0 0 0 ${-w / 2} ${bottom - ry} Z`;
}

function documentPath(w: number, h: number): string {
  const left = -w / 2, right = w / 2, top = -h / 2, bottom = h / 2;
  return `M ${left} ${top} H ${right} V ${bottom - 8} C ${w * 0.25} ${bottom + 2}, ${-w * 0.25} ${bottom - 18}, ${left} ${bottom - 8} Z`;
}

function nodeBodySvg(node: DiagramNode): string {
  const w = nodeW(node), h = nodeH(node), style = NODE_STYLE[node.kind], base = `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"`;
  if (node.shape === "actor") {
    const headY = -h / 2 + 20, bodyTop = headY + 10, bodyBottom = h / 2 - 28;
    return `<g fill="none" stroke="${style.stroke}" stroke-width="1.8" stroke-linecap="round"><circle cx="0" cy="${headY}" r="9"/><line x1="0" y1="${bodyTop}" x2="0" y2="${bodyBottom}"/><line x1="-16" y1="${bodyTop + 12}" x2="16" y2="${bodyTop + 12}"/><line x1="0" y1="${bodyBottom}" x2="-15" y2="${bodyBottom + 18}"/><line x1="0" y1="${bodyBottom}" x2="15" y2="${bodyBottom + 18}"/></g>`;
  }
  if (node.shape === "boundary") return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="4" fill="#102027" stroke="${style.stroke}" stroke-width="1.5" stroke-dasharray="8 5"/>`;
  if (node.shape === "rect") return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" ${base}/>`;
  if (node.shape === "ellipse") return `<ellipse cx="0" cy="0" rx="${w / 2}" ry="${h / 2}" ${base}/>`;
  if (node.shape === "diamond") return `<polygon points="0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0" ${base}/>`;
  if (node.shape === "hexagon") return `<polygon points="${-w / 4},${-h / 2} ${w / 4},${-h / 2} ${w / 2},0 ${w / 4},${h / 2} ${-w / 4},${h / 2} ${-w / 2},0" ${base}/>`;
  if (node.shape === "parallelogram") return `<polygon points="${-w / 2 + w * 0.18},${-h / 2} ${w / 2},${-h / 2} ${w / 2 - w * 0.18},${h / 2} ${-w / 2},${h / 2}" ${base}/>`;
  if (node.shape === "cylinder") return `<path d="${cylinderPath(w, h)}" ${base}/>`;
  if (node.shape === "predefined") return `<g><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="3" ${base}/><line x1="${-w / 2 + 13}" y1="${-h / 2}" x2="${-w / 2 + 13}" y2="${h / 2}" stroke="${style.stroke}"/><line x1="${w / 2 - 13}" y1="${-h / 2}" x2="${w / 2 - 13}" y2="${h / 2}" stroke="${style.stroke}"/></g>`;
  if (node.shape === "document") return `<path d="${documentPath(w, h)}" ${base}/>`;
  return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9" ${base}${style.dashed ? ' stroke-dasharray="5 4"' : ""}/>`;
}

export function buildDiagramSvg(diagram: Diagram): string {
  if (diagram.nodes.length === 0) throw new Error("空画布无法导出图片");
  const routeResults = routeDiagramEdges(diagram.nodes, diagram.edges);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of diagram.nodes) {
    minX = Math.min(minX, node.x - nodeW(node) / 2); maxX = Math.max(maxX, node.x + nodeW(node) / 2);
    minY = Math.min(minY, node.y - nodeH(node) / 2); maxY = Math.max(maxY, node.y + nodeH(node) / 2);
  }
  for (const edge of diagram.edges) for (const point of routeResults.get(edge.id)?.points ?? edge.points ?? []) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const pad = 48; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = Math.max(1, maxX - minX), height = Math.max(1, maxY - minY), parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="IBM Plex Sans, Microsoft YaHei, sans-serif">`);
  parts.push('<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto-start-reverse"><path d="M0,0 L8,3 L0,6 Z" fill="context-stroke"/></marker><marker id="open-arrow" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto"><path d="M1,1 L10,5 L1,9" fill="none" stroke="#8497aa" stroke-width="1.5"/></marker><marker id="uml-triangle" markerWidth="13" markerHeight="12" refX="11" refY="6" orient="auto"><path d="M1,1 L11,6 L1,11 Z" fill="#111820" stroke="#8497aa" stroke-width="1.3"/></marker></defs>');
  parts.push(`<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#111820"/>`);
  for (const group of diagram.groups) {
    const members = group.nodeIds.map((id) => diagram.nodes.find((node) => node.id === id)).filter((node): node is DiagramNode => Boolean(node));
    if (members.length < 2) continue;
    const left = Math.min(...members.map((node) => node.x - nodeW(node) / 2)) - 16;
    const top = Math.min(...members.map((node) => node.y - nodeH(node) / 2)) - 16;
    const right = Math.max(...members.map((node) => node.x + nodeW(node) / 2)) + 16;
    const bottom = Math.max(...members.map((node) => node.y + nodeH(node) / 2)) + 16;
    parts.push(`<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" rx="12" fill="#12202a" stroke="#52758a" stroke-dasharray="7 4"/><text x="${left + 8}" y="${top - 6}" font-size="11" fill="#7897a8">${xml(group.name)}</text>`);
  }
  for (const edge of diagram.edges) {
    const from = diagram.nodes.find((node) => node.id === edge.from), to = diagram.nodes.find((node) => node.id === edge.to);
    if (!from || !to) continue;
    const route = routeResults.get(edge.id);
    const points = route?.points ?? [];
    const relation = diagram.type === "usecase" ? USE_CASE_RELATION_META[edge.relationType ?? "association"] : null;
    const marker = diagram.type === "usecase"
      ? edge.relationType === "generalization" ? ' marker-end="url(#uml-triangle)"'
        : edge.relationType === "include" || edge.relationType === "extend" ? ' marker-end="url(#open-arrow)"'
          : ""
      : edge.arrow === "none" ? "" : ` marker-end="url(#arrow)"${edge.arrow === "both" ? ' marker-start="url(#arrow)"' : ""}`;
    const dash = relation?.dash ?? (edge.dash === "dashed" ? "8 5" : edge.dash === "dotted" ? "2 5" : "");
    const attrs = `${dash ? ` stroke-dasharray="${dash}"` : ""}${marker}`;
    const color = edge.color ?? "#8497aa", lineWidth = Math.max(1, Math.min(8, edge.width ?? 2));
    parts.push(`<path d="${diagramPolylinePath(points, route?.crossings, edge.jumpStyle ?? "arc")}" fill="none" stroke="${color}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`);
    const edgeLabel = edge.label || relation?.label;
    if (edgeLabel) {
      const point = route?.labelPoint ?? diagramPathPointAt(points, edge.labelPosition ?? 0.5), labelWidth = Math.max(42, edgeLabel.length * 7 + 18);
      parts.push(`<rect x="${point.x - labelWidth / 2}" y="${point.y - 17}" width="${labelWidth}" height="20" rx="7" fill="#0b161e" stroke="#2c4353" stroke-width="0.9"/>`);
      parts.push(`<text x="${point.x}" y="${point.y - 3.5}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#a9bac7">${xml(edgeLabel)}</text>`);
    }
  }
  for (const node of [...diagram.nodes].sort((a, b) => Number(useCaseTypeOf(a) !== "boundary") - Number(useCaseTypeOf(b) !== "boundary"))) {
    const style = NODE_STYLE[node.kind], w = nodeW(node), h = nodeH(node);
    parts.push(`<g transform="translate(${node.x},${node.y})">${nodeBodySvg(node)}`);
    if (diagram.type !== "flow" && diagram.type !== "usecase") parts.push(`<text x="${-w / 2 + 10}" y="${-h / 2 + 11}" font-size="9" fill="${style.text}" opacity="0.7">${KIND_LABELS[node.kind]}</text>`);
    const labelY = diagram.type === "usecase" && useCaseTypeOf(node) === "actor" ? h / 2 - 5 : diagram.type === "usecase" && useCaseTypeOf(node) === "boundary" ? -h / 2 + 20 : 1;
    parts.push(`<text x="0" y="${labelY}" text-anchor="middle" dominant-baseline="middle" font-size="13" font-weight="600" fill="${style.text}">${xml(node.label)}</text>`);
    if (diagram.type !== "flow" && diagram.type !== "usecase") {
      const development = node.developmentStatus ?? "未开发", acceptance = node.acceptanceStatus ?? "未验收";
      parts.push(`<circle cx="${-w / 2 + 11}" cy="${h / 2 - 7}" r="3.2" fill="${DEVELOPMENT_COLORS[development]}"/><text x="${-w / 2 + 18}" y="${h / 2 - 4}" font-size="8.5" fill="#9fb0bf">开发 · ${development}</text>`);
      parts.push(`<circle cx="${w / 2 - 65}" cy="${h / 2 - 7}" r="3.2" fill="${ACCEPTANCE_COLORS[acceptance]}"/><text x="${w / 2 - 58}" y="${h / 2 - 4}" font-size="8.5" fill="#9fb0bf">验收 · ${acceptance}</text>`);
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("");
}

function safeFileName(value: string): string {
  return value.trim().replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").slice(0, 100) || "diagram";
}

export async function exportDiagram(diagram: Diagram, dataDir: string, format: "json" | "svg" | "png"): Promise<{ path: string; format: string; bytes: number }> {
  const exportDir = join(dataDir, "exports");
  mkdirSync(exportDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const path = join(exportDir, `${safeFileName(diagram.title)}-${stamp}.${format}`);
  if (format === "json") {
    const content = JSON.stringify(diagram, null, 2);
    writeFileSync(path, content, "utf-8");
    return { path, format, bytes: Buffer.byteLength(content) };
  }
  const svg = buildDiagramSvg(diagram);
  if (format === "svg") {
    writeFileSync(path, svg, "utf-8");
    return { path, format, bytes: Buffer.byteLength(svg) };
  }
  const { default: sharp } = await import("sharp");
  const info = await sharp(Buffer.from(svg)).png().toFile(path);
  return { path, format, bytes: info.size };
}
