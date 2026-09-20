import { z } from "zod";
import {
  DIAGRAM_COMPONENT_SCHEMA_VERSION,
  DIAGRAM_LAYER_MEMBER_KINDS,
  DIAGRAM_USE_CASE_NODE_TYPES,
  DIAGRAM_USE_CASE_RELATION_TYPES,
  DIAGRAM_PORTS,
  DIAGRAM_FLOW_NODE_TYPES,
  DIAGRAM_NODE_KINDS,
  NODE_SHAPES,
  type DiagramComponentDefinition,
  type DiagramComponentLibrary,
  type DiagramComponentNode,
  type DiagramComponentPayload,
  type DiagramComponentSourceSelection,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramItemOverride,
  type DiagramLayer,
  type DiagramLayerState,
  type DiagramNode,
  type FreeformDocument,
  type FreeformElement,
} from "./types.js";
import {
  FREEFORM_ASSET_PLACEHOLDER_ID,
  assertNoDeliveryFieldLeak,
  assertNoDeliveryFieldLeak as assertNoDeliveryFieldLeakShared,
  clampFreeformCoordinate,
  newFreeformElementId,
  pasteFreeformClipboard,
  round2,
} from "./freeform.js";
import { itemKeyOf, LAYER_CUSTOM_ID_PREFIX, parseItemKey } from "./layers.js";

export const COMPONENT_SCHEMA_VERSION = DIAGRAM_COMPONENT_SCHEMA_VERSION;
export const COMPONENT_ID_PREFIX = "cmp_";
export const COMPONENT_NAME_MAX = 80;
export const COMPONENT_OFFSET_DEFAULT = 16;
export const COMPONENT_MAX = 200;

export interface ComponentContractErrorShape { code: string; message: string; statusCode: number }

export function componentContractError(message: string, code = "COMPONENT_CONTRACT_INVALID", statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function newComponentId(): string {
  return `${COMPONENT_ID_PREFIX}${randomSuffix()}`;
}

function newRecordId(): string {
  return `${randomSuffix()}${randomSuffix()}`.slice(0, 24);
}

// ---------- schema ----------

export const componentNodeSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(DIAGRAM_NODE_KINDS),
  label: z.string().max(200),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  shape: z.enum(NODE_SHAPES).optional(),
  flowType: z.enum(DIAGRAM_FLOW_NODE_TYPES).optional(),
  useCaseType: z.enum(DIAGRAM_USE_CASE_NODE_TYPES).optional(),
  linkDiagramIds: z.array(z.string()).optional(),
  description: z.string().max(5000).optional(),
  notes: z.string().max(10_000).optional(),
  preconditions: z.string().max(10_000).optional(),
  mainFlow: z.string().max(20_000).optional(),
  alternateFlow: z.string().max(20_000).optional(),
  postconditions: z.string().max(10_000).optional(),
}).strict();

export const componentEdgeSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  sourcePort: z.enum(DIAGRAM_PORTS).optional(),
  targetPort: z.enum(DIAGRAM_PORTS).optional(),
  label: z.string().max(200).optional(),
  style: z.enum(["ortho", "straight", "curve"]).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() }).strict()).min(2).optional(),
  relationType: z.enum(DIAGRAM_USE_CASE_RELATION_TYPES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  width: z.number().min(1).max(8).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  arrow: z.enum(["end", "both", "none"]).optional(),
  labelPosition: z.number().min(0).max(1).optional(),
  routingMode: z.enum(["auto", "manual"]).optional(),
  jumpStyle: z.enum(["arc", "gap", "none"]).optional(),
  routeVersion: z.literal(1).optional(),
}).strict();

export const componentGroupSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().max(200), nodeIds: z.array(z.string().min(1).max(200)),
}).strict();

export const componentItemOverrideSchema = z.object({
  locked: z.boolean().optional(), hidden: z.boolean().optional(), layerId: z.string().min(1).max(120).optional(),
}).strict();

export const componentLayerSchema = z.object({
  id: z.string().min(1).max(120), name: z.string().max(80),
  kind: z.enum(["system", "custom"]), memberKind: z.enum(DIAGRAM_LAYER_MEMBER_KINDS),
  locked: z.boolean(), hidden: z.boolean(), createdAt: z.string().max(64), updatedAt: z.string().max(64),
}).strict();

export const componentFreeformElementSchema = z.object({
  id: z.string().regex(/^fr_[A-Za-z0-9_-]{1,200}$/),
  kind: z.enum(["text", "sticky", "rect", "ellipse", "arrow", "ink", "image"]),
}).passthrough();

export const componentPayloadSchema = z.object({
  nodes: z.array(componentNodeSchema).max(1000),
  edges: z.array(componentEdgeSchema).max(2000),
  groups: z.array(componentGroupSchema).max(200),
  freeform: z.object({ elements: z.array(componentFreeformElementSchema).max(5000) }).strict().nullable(),
  layers: z.object({
    layers: z.array(componentLayerSchema).max(200),
    itemOverrides: z.record(z.string().max(240), componentItemOverrideSchema),
  }).strict().nullable(),
}).strict();

export const componentDefinitionSchema = z.object({
  id: z.string().regex(/^cmp_[A-Za-z0-9_-]{1,160}$/),
  name: z.string().trim().min(1).max(COMPONENT_NAME_MAX),
  payload: componentPayloadSchema,
  sourceSelection: z.object({
    nodeIds: z.array(z.string().max(200)).max(1000),
    edgeIds: z.array(z.string().max(200)).max(2000),
    freeformIds: z.array(z.string().max(200)).max(5000),
  }).strict(),
  createdBy: z.string().max(120),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
}).strict();

export const componentLibrarySchema = z.object({
  schemaVersion: z.literal(COMPONENT_SCHEMA_VERSION),
  components: z.array(componentDefinitionSchema).max(COMPONENT_MAX),
}).strict();

export const componentSelectionSchema = z.object({
  nodeIds: z.array(z.string().min(1).max(200)).max(1000).default([]),
  edgeIds: z.array(z.string().min(1).max(200)).max(2000).default([]),
  freeformIds: z.array(z.string().min(1).max(200)).max(5000).default([]),
}).strict();

export const componentCreateSchema = z.object({
  name: z.string().trim().min(1).max(COMPONENT_NAME_MAX),
  selection: componentSelectionSchema,
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

export const componentPatchSchema = z.object({
  name: z.string().trim().min(1).max(COMPONENT_NAME_MAX).optional(),
  selection: componentSelectionSchema.optional(),
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

export const componentInstanceSchema = z.object({
  offsetX: z.number().finite().default(COMPONENT_OFFSET_DEFAULT),
  offsetY: z.number().finite().default(COMPONENT_OFFSET_DEFAULT),
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

// ---------- 交付字段剥离 ----------

const COMPONENT_DELIVERY_FIELDS = [
  "requirementStatus", "designStatus", "developmentStatus", "acceptanceStatus",
  "owner", "acceptanceCriteria", "requiresDatabase", "blockedReason", "deliveryUpdatedAt",
] as const;

export function stripComponentNodeDeliveryFields(node: DiagramNode): DiagramComponentNode {
  const clone = { ...(node as unknown as Record<string, unknown>) };
  for (const field of COMPONENT_DELIVERY_FIELDS) delete clone[field];
  return clone as unknown as DiagramComponentNode;
}

// ---------- 从选区创建组件 ----------

export interface ComponentSnapshotInput {
  diagram: { nodes: DiagramNode[]; edges: DiagramEdge[]; groups: DiagramGroup[] };
  freeform?: Pick<FreeformDocument, "elements"> | null;
  layerState?: DiagramLayerState | null;
  selection: DiagramComponentSourceSelection;
  name: string;
  actor: string;
  now?: string;
  availableAssetIds?: Iterable<string>;
}

export interface ComponentSnapshotResult {
  definition: DiagramComponentDefinition;
  droppedEdgeIds: string[];
}

export function snapshotComponent(input: ComponentSnapshotInput): ComponentSnapshotResult {
  const { diagram } = input;
  const nodeIds = [...new Set(input.selection.nodeIds)];
  const edgeIds = [...new Set(input.selection.edgeIds)];
  const freeformIds = [...new Set(input.selection.freeformIds)];
  if (!nodeIds.length && !edgeIds.length && !freeformIds.length) {
    throw componentContractError("创建组件至少需要选中 1 个元素", "COMPONENT_SELECTION_INVALID", 400);
  }
  const nodeById = new Map(diagram.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(diagram.edges.map((edge) => [edge.id, edge]));
  const freeformById = new Map((input.freeform?.elements ?? []).map((element) => [element.id, element]));
  for (const id of nodeIds) if (!nodeById.has(id)) throw componentContractError(`选区节点不存在：${id}`, "COMPONENT_SELECTION_INVALID");
  for (const id of edgeIds) if (!edgeById.has(id)) throw componentContractError(`选区连线不存在：${id}`, "COMPONENT_SELECTION_INVALID");
  for (const id of freeformIds) if (!freeformById.has(id)) throw componentContractError(`选区自由元素不存在：${id}`, "COMPONENT_SELECTION_INVALID");

  const selectedNodeIds = new Set(nodeIds);
  const nodes = nodeIds.map((id) => stripComponentNodeDeliveryFields(nodeById.get(id) as DiagramNode));
  const droppedEdgeIds: string[] = [];
  const edges: DiagramEdge[] = [];
  for (const id of edgeIds) {
    const edge = edgeById.get(id) as DiagramEdge;
    if (!selectedNodeIds.has(edge.from) || !selectedNodeIds.has(edge.to)) { droppedEdgeIds.push(id); continue; }
    edges.push(structuredClone(edge));
  }
  const groups = diagram.groups
    .filter((group) => group.nodeIds.length && group.nodeIds.every((id) => selectedNodeIds.has(id)))
    .map((group) => structuredClone(group));

  // 快照自由元素：完整复制，但越权 assetRef 以占位资源 id 落库（与 pasteFreeformClipboard 一致）。
  const available = input.availableAssetIds ? new Set(input.availableAssetIds) : null;
  const elements: FreeformElement[] = freeformIds.map((id) => {
    const element = structuredClone(freeformById.get(id) as FreeformElement);
    if (element.kind === "image" && element.assetRef && available && !available.has(element.assetRef)) {
      element.assetRef = FREEFORM_ASSET_PLACEHOLDER_ID;
    }
    return element;
  });

  const selectedKeys = [
    ...nodeIds.map((id) => itemKeyOf("node", id)),
    ...edges.map((edge) => itemKeyOf("edge", edge.id)),
    ...freeformIds.map((id) => itemKeyOf("freeform", id)),
  ];
  const layers = snapshotComponentLayers(input.layerState ?? null, selectedKeys);

  const payload: DiagramComponentPayload = {
    nodes, edges, groups,
    freeform: elements.length ? { elements } : null,
    layers,
  };
  try {
    assertNoDeliveryFieldLeak(payload);
  } catch {
    throw componentContractError("组件内容禁止携带交付状态字段", "COMPONENT_DELIVERY_FIELD_FORBIDDEN", 400);
  }

  const now = input.now ?? "";
  return {
    definition: {
      id: newComponentId(),
      name: input.name.trim(),
      payload,
      sourceSelection: { nodeIds, edgeIds, freeformIds },
      createdBy: input.actor,
      createdAt: now,
      updatedAt: now,
    },
    droppedEdgeIds,
  };
}

/** 只纳入选区涉及的自定义层定义与相关 itemOverrides（保证实例化后层级结构可复现）。 */
function snapshotComponentLayers(
  layerState: DiagramLayerState | null,
  selectedKeys: string[],
): DiagramComponentPayload["layers"] {
  if (!layerState) return null;
  const layerById = new Map(layerState.layers.map((layer) => [layer.id, layer]));
  const includedLayerIds = new Set<string>();
  for (const key of selectedKeys) {
    const override = layerState.itemOverrides[key];
    const layer = override?.layerId ? layerById.get(override.layerId) : undefined;
    if (layer && layer.kind === "custom") includedLayerIds.add(layer.id);
  }
  const itemOverrides: Record<string, DiagramItemOverride> = {};
  for (const key of selectedKeys) {
    const override = layerState.itemOverrides[key];
    if (!override) continue;
    const parsed = parseItemKey(key);
    const next: DiagramItemOverride = {};
    if (override.layerId && includedLayerIds.has(override.layerId)) next.layerId = override.layerId;
    if (parsed?.kind === "node" || parsed?.kind === "edge") {
      if (override.locked !== undefined) next.locked = override.locked;
      if (override.hidden !== undefined) next.hidden = override.hidden;
    }
    if (Object.keys(next).length) itemOverrides[key] = next;
  }
  const layers = layerState.layers.filter((layer) => includedLayerIds.has(layer.id)).map((layer) => structuredClone(layer));
  if (!layers.length && !Object.keys(itemOverrides).length) return null;
  return { layers, itemOverrides };
}

// ---------- 复制实例 ----------

export interface ComponentInstantiateInput {
  definition: DiagramComponentDefinition;
  offsetX?: number;
  offsetY?: number;
  availableAssetIds?: Iterable<string>;
  now?: string;
}

export interface ComponentInstantiateResult {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  freeformElements: FreeformElement[];
  layers: { layers: DiagramLayer[]; itemOverrides: Record<string, DiagramItemOverride> } | null;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  createdFreeformIds: string[];
  droppedEdgeIds: string[];
}

const INSTANCE_COORD_LIMIT = 100000;

export function instantiateComponent(input: ComponentInstantiateInput): ComponentInstantiateResult {
  const { definition } = input;
  const offsetX = input.offsetX ?? COMPONENT_OFFSET_DEFAULT;
  const offsetY = input.offsetY ?? COMPONENT_OFFSET_DEFAULT;
  const nodeIdMap = new Map<string, string>();
  for (const node of definition.payload.nodes) nodeIdMap.set(node.id, newRecordId());
  const activeNodeIds = new Set(definition.payload.nodes.map((node) => node.id));

  const nodes: DiagramNode[] = definition.payload.nodes.map((node) => {
    const next = structuredClone(node) as unknown as DiagramNode;
    next.id = nodeIdMap.get(node.id) as string;
    next.x = clampCoord(node.x + offsetX);
    next.y = clampCoord(node.y + offsetY);
    // 实例不继承交付状态：新节点以缺省态出现（不写任何交付字段）。
    for (const field of COMPONENT_DELIVERY_FIELDS) delete (next as unknown as Record<string, unknown>)[field];
    return next;
  });
  const createdNodeIds = [...nodeIdMap.values()];

  const droppedEdgeIds: string[] = [];
  const edges: DiagramEdge[] = [];
  for (const edge of definition.payload.edges) {
    if (!activeNodeIds.has(edge.from) || !activeNodeIds.has(edge.to)) { droppedEdgeIds.push(edge.id); continue; }
    edges.push({
      ...structuredClone(edge),
      id: newRecordId(),
      from: nodeIdMap.get(edge.from) as string,
      to: nodeIdMap.get(edge.to) as string,
    });
  }
  const createdEdgeIds = edges.map((edge) => edge.id);

  const nodeIdRemap = new Map(definition.payload.nodes.map((node, index) => [node.id, createdNodeIds[index]]));
  const groups: DiagramGroup[] = definition.payload.groups.map((group) => ({
    id: newRecordId(),
    name: group.name,
    nodeIds: group.nodeIds.map((id) => nodeIdRemap.get(id)).filter((id): id is string => Boolean(id)),
  }));

  // 自由元素：沿用 pasteFreeformClipboard 的 id 重生成 / 组重映射 / 越权 assetRef 占位语义。
  let freeformElements: FreeformElement[] = [];
  const freeformIdMap = new Map<string, string>();
  if (definition.payload.freeform?.elements.length) {
    const emptyDocument: FreeformDocument = { schemaVersion: 1, diagramId: "", elements: [], unsupported: [], updatedAt: "" };
    const pasted = pasteFreeformClipboard(emptyDocument, {
      kind: "freeform-clipboard",
      elements: definition.payload.freeform.elements.map((element) => structuredClone(element)),
      groups: [...new Set(definition.payload.freeform.elements.map((element) => element.groupId).filter((id): id is string => Boolean(id)))],
    }, { offset: { x: offsetX, y: offsetY }, availableAssetIds: input.availableAssetIds });
    freeformElements = pasted.document.elements;
    definition.payload.freeform.elements.forEach((element, index) => {
      const nextId = pasted.ids[index];
      if (nextId) freeformIdMap.set(element.id, nextId);
    });
  }
  const createdFreeformIds = [...freeformIdMap.values()];

  // 图层：自定义层 id 重新生成（避免与目标画布冲突），itemOverrides 键与 layerId 同步重映射。
  let layers: ComponentInstantiateResult["layers"] = null;
  const snapshotLayers = definition.payload.layers;
  if (snapshotLayers && (snapshotLayers.layers.length || Object.keys(snapshotLayers.itemOverrides).length)) {
    const layerIdMap = new Map<string, string>();
    for (const layer of snapshotLayers.layers) {
      layerIdMap.set(layer.id, layer.kind === "custom" ? `${LAYER_CUSTOM_ID_PREFIX}${newRecordId()}` : layer.id);
    }
    const nextLayers: DiagramLayer[] = snapshotLayers.layers.map((layer) => ({
      ...structuredClone(layer),
      id: layerIdMap.get(layer.id) as string,
      kind: layer.kind,
    }));
    const itemOverrides: Record<string, DiagramItemOverride> = {};
    for (const [key, override] of Object.entries(snapshotLayers.itemOverrides)) {
      const parsed = parseItemKey(key);
      if (!parsed) continue;
      const nextId = parsed.kind === "node" ? nodeIdMap.get(parsed.id)
        : parsed.kind === "edge" ? edges.find((edge, index) => createdEdgeIds[index] && definition.payload.edges[index]?.id === parsed.id)?.id
          : freeformIdMap.get(parsed.id);
      const nextKey = nextId ? itemKeyOf(parsed.kind, nextId) : null;
      if (!nextKey) continue;
      const nextOverride: DiagramItemOverride = {};
      if (override.layerId && layerIdMap.has(override.layerId)) nextOverride.layerId = layerIdMap.get(override.layerId) as string;
      if (parsed.kind !== "freeform") {
        if (override.locked !== undefined) nextOverride.locked = override.locked;
        if (override.hidden !== undefined) nextOverride.hidden = override.hidden;
      }
      if (Object.keys(nextOverride).length) itemOverrides[nextKey] = nextOverride;
    }
    layers = { layers: nextLayers, itemOverrides };
  }

  return { nodes, edges, groups, freeformElements, layers, createdNodeIds, createdEdgeIds, createdFreeformIds, droppedEdgeIds };
}

function clampCoord(value: number): number {
  return clampFreeformCoordinate(round2(value)) || Math.max(-INSTANCE_COORD_LIMIT, Math.min(INSTANCE_COORD_LIMIT, round2(value)));
}

// ---------- 归一化 ----------

export function normalizeComponentLibrary(value: unknown): DiagramComponentLibrary {
  const raw = isRecord(value) ? value : {};
  const components = (Array.isArray(raw.components) ? raw.components : [])
    .map((item) => (isRecord(item) && typeof item.id === "string" && item.id.startsWith(COMPONENT_ID_PREFIX) ? item : null))
    .filter((item): item is Record<string, unknown> => Boolean(item));
  return {
    schemaVersion: COMPONENT_SCHEMA_VERSION,
    components: components.map((item) => normalizeComponentDefinition(item)),
  };
}

function normalizeComponentDefinition(raw: Record<string, unknown>): DiagramComponentDefinition {
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const selection = isRecord(raw.sourceSelection) ? raw.sourceSelection : {};
  const stringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    id: String(raw.id),
    name: typeof raw.name === "string" ? raw.name : "",
    payload: {
      nodes: Array.isArray(payload.nodes) ? payload.nodes as DiagramComponentNode[] : [],
      edges: Array.isArray(payload.edges) ? payload.edges as DiagramEdge[] : [],
      groups: Array.isArray(payload.groups) ? payload.groups as DiagramGroup[] : [],
      freeform: isRecord(payload.freeform) && Array.isArray(payload.freeform.elements)
        ? { elements: payload.freeform.elements as FreeformElement[] } : null,
      layers: isRecord(payload.layers) && Array.isArray(payload.layers.layers)
        ? { layers: payload.layers.layers as DiagramLayer[], itemOverrides: (isRecord(payload.layers.itemOverrides) ? payload.layers.itemOverrides : {}) as Record<string, DiagramItemOverride> }
        : null,
    },
    sourceSelection: {
      nodeIds: stringArray(selection.nodeIds),
      edgeIds: stringArray(selection.edgeIds),
      freeformIds: stringArray(selection.freeformIds),
    },
    createdBy: typeof raw.createdBy === "string" ? raw.createdBy : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function componentLibraryFingerprint(library: DiagramComponentLibrary): string {
  return JSON.stringify(library.components.map((component) => ({
    id: component.id, name: component.name, payload: component.payload,
  })));
}

/** 内部使用：确保剥离断言可被测试直接引用。 */
export const assertComponentNoDeliveryFieldLeak = assertNoDeliveryFieldLeakShared;