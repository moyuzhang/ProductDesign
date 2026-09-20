import { z } from "zod";
import {
  DIAGRAM_LAYER_MEMBER_KINDS,
  DIAGRAM_LAYER_SCHEMA_VERSION,
  type Diagram,
  type DiagramItemOverride,
  type DiagramLayer,
  type DiagramLayerItemKind,
  type DiagramLayerMemberKind,
  type DiagramLayerState,
  type FreeformDocument,
} from "./types.js";
import { freeformBoundingBox, normalizeFreeformRect, round2, type FreeformRect } from "./freeform.js";

export const LAYER_SCHEMA_VERSION = DIAGRAM_LAYER_SCHEMA_VERSION;
export const LAYER_NAME_MAX = 80;
export const LAYER_MAX = 200;
export const LAYER_CUSTOM_ID_PREFIX = "ly_";
export const LAYER_SYSTEM_NODE_ID = "layer_nodes";
export const LAYER_SYSTEM_EDGE_ID = "layer_edges";
export const LAYER_SYSTEM_FREEFORM_ID = "layer_freeform";
export const LAYER_ITEM_KEY_MAX = 240;
/** 交付节点/连线的默认几何，与画布渲染口径一致（见 mcp/diagram.ts DEFAULT_W/H）。 */
export const LAYER_NODE_DEFAULT_W = 176;
export const LAYER_NODE_DEFAULT_H = 46;

export const LAYER_SYSTEM_LAYER_DEFS: ReadonlyArray<{
  id: string;
  name: string;
  memberKind: Exclude<DiagramLayerMemberKind, "mixed">;
}> = [
  { id: LAYER_SYSTEM_NODE_ID, name: "交付节点", memberKind: "node" },
  { id: LAYER_SYSTEM_EDGE_ID, name: "连线", memberKind: "edge" },
  { id: LAYER_SYSTEM_FREEFORM_ID, name: "自由元素", memberKind: "freeform" },
];

export interface LayerContractErrorShape { code: string; message: string; statusCode: number }

export function layerContractError(message: string, code = "LAYER_CONTRACT_INVALID", statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// ---------- itemKey ----------

export function itemKeyOf(kind: DiagramLayerItemKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseItemKey(key: string): { kind: DiagramLayerItemKind; id: string } | null {
  const index = key.indexOf(":");
  if (index <= 0) return null;
  const prefix = key.slice(0, index);
  const id = key.slice(index + 1);
  if (!id.trim()) return null;
  if (prefix !== "node" && prefix !== "edge" && prefix !== "freeform") return null;
  return { kind: prefix, id };
}

export function defaultLayerIdFor(kind: DiagramLayerItemKind): string {
  if (kind === "node") return LAYER_SYSTEM_NODE_ID;
  if (kind === "edge") return LAYER_SYSTEM_EDGE_ID;
  return LAYER_SYSTEM_FREEFORM_ID;
}

export function newLayerId(): string {
  return `${LAYER_CUSTOM_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- schema（strict：未知字段一律 400） ----------

export const diagramLayerSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().max(LAYER_NAME_MAX),
  kind: z.enum(["system", "custom"]),
  memberKind: z.enum(DIAGRAM_LAYER_MEMBER_KINDS),
  locked: z.boolean(),
  hidden: z.boolean(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
}).strict();

export const diagramItemOverrideSchema = z.object({
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
  layerId: z.string().trim().min(1).max(120).optional(),
}).strict();

export const diagramLayerStateSchema = z.object({
  schemaVersion: z.literal(LAYER_SCHEMA_VERSION),
  layers: z.array(diagramLayerSchema).max(LAYER_MAX),
  itemOverrides: z.record(z.string().max(LAYER_ITEM_KEY_MAX), diagramItemOverrideSchema),
}).strict();

export const layerSaveSchema = z.object({
  schemaVersion: z.literal(LAYER_SCHEMA_VERSION),
  layers: z.array(diagramLayerSchema).max(LAYER_MAX),
  itemOverrides: z.record(z.string().max(LAYER_ITEM_KEY_MAX), diagramItemOverrideSchema),
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

// ---------- 默认派生与归一化 ----------

export interface LayerDeriveInput {
  nodes?: Array<{ id: string }>;
  edges?: Array<{ id: string }>;
  freeform?: { elements?: Array<{ id: string }> } | null;
}

function systemLayer(def: (typeof LAYER_SYSTEM_LAYER_DEFS)[number], now: string): DiagramLayer {
  return {
    id: def.id, name: def.name, kind: "system", memberKind: def.memberKind,
    locked: false, hidden: false, createdAt: now, updatedAt: now,
  };
}

/** 旧画布（无 layers 字段）读取时确定性派生默认图层，不写库（设计 3.7）。 */
export function defaultLayerState(input: LayerDeriveInput = {}, now = ""): DiagramLayerState {
  void input;
  return {
    schemaVersion: LAYER_SCHEMA_VERSION,
    layers: LAYER_SYSTEM_LAYER_DEFS.map((def) => systemLayer(def, now)),
    itemOverrides: {},
  };
}

export interface NormalizeLayerOptions {
  nodeIds?: string[];
  edgeIds?: string[];
  freeformIds?: string[];
  now?: string;
  fallbackDiagramId?: string;
}

export interface NormalizedLayerState {
  state: DiagramLayerState;
  /** 旧式未知字段（zIndex/layerId 等）原样保留，不静默删除。 */
  legacyUnknown: Record<string, unknown>;
  /** 载荷 schemaVersion 高于本实现：只读不写。 */
  unsupported: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLayerEntry(value: unknown, now: string): { layer: DiagramLayer; legacyZIndex: number | null } | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) return null;
  const systemDef = LAYER_SYSTEM_LAYER_DEFS.find((def) => def.id === id);
  const rawMemberKind = String(value.memberKind ?? "");
  const memberKind: DiagramLayerMemberKind = systemDef
    ? systemDef.memberKind
    : (DIAGRAM_LAYER_MEMBER_KINDS as readonly string[]).includes(rawMemberKind)
      ? (rawMemberKind as DiagramLayerMemberKind) : "mixed";
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, LAYER_NAME_MAX) : id;
  const legacyZIndex = typeof value.zIndex === "number" && Number.isFinite(value.zIndex) ? value.zIndex : null;
  return {
    layer: {
      id,
      name,
      kind: systemDef ? "system" : "custom",
      memberKind,
      locked: Boolean(value.locked),
      hidden: Boolean(value.hidden),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
    },
    legacyZIndex,
  };
}

/**
 * 逐字段归一化：缺省补系统层、去重、旧式 zIndex 转数组序、未知字段转 legacyUnknown。
 * 迁移幂等：同一份旧数据重复归一化结果一致。
 */
export function normalizeLayerState(value: unknown, options: NormalizeLayerOptions = {}): NormalizedLayerState {
  const now = options.now ?? "";
  const raw = isRecord(value) ? value : {};
  const legacyUnknown: Record<string, unknown> = {};
  const knownKeys = new Set(["schemaVersion", "layers", "itemOverrides"]);
  for (const [key, item] of Object.entries(raw)) if (!knownKeys.has(key)) legacyUnknown[key] = item;

  const rawVersion = raw.schemaVersion;
  const unsupported = typeof rawVersion === "number" && rawVersion > LAYER_SCHEMA_VERSION;

  const seen = new Set<string>();
  const entries: Array<{ layer: DiagramLayer; order: number; zIndex: number | null }> = [];
  const source = Array.isArray(raw.layers) ? raw.layers : [];
  source.forEach((item, index) => {
    const parsed = normalizeLayerEntry(item, now);
    if (!parsed || seen.has(parsed.layer.id)) return;
    seen.add(parsed.layer.id);
    entries.push({ layer: parsed.layer, order: index, zIndex: parsed.legacyZIndex });
  });
  if (entries.some((entry) => entry.zIndex !== null)) {
    entries.sort((a, b) => (a.zIndex ?? a.order) - (b.zIndex ?? b.order));
  }
  // 补齐缺失系统层：始终保证三个系统层存在，UI 面板结构稳定。
  for (const def of LAYER_SYSTEM_LAYER_DEFS) {
    if (seen.has(def.id)) continue;
    seen.add(def.id);
    entries.push({ layer: systemLayer(def, now), order: entries.length, zIndex: null });
  }

  const layerIds = new Set(entries.map((entry) => entry.layer.id));
  const nodeIds = new Set(options.nodeIds ?? []);
  const edgeIds = new Set(options.edgeIds ?? []);
  const freeformIds = new Set(options.freeformIds ?? []);

  const itemOverrides: Record<string, DiagramItemOverride> = {};
  const rawOverrides = isRecord(raw.itemOverrides) ? raw.itemOverrides : {};
  for (const [key, item] of Object.entries(rawOverrides)) {
    const parsedKey = parseItemKey(key);
    if (!parsedKey || !isRecord(item)) { legacyUnknown[`itemOverrides.${key}`] = item; continue; }
    const known = new Set(["locked", "hidden", "layerId"]);
    for (const [field, fieldValue] of Object.entries(item)) {
      if (!known.has(field)) legacyUnknown[`itemOverrides.${key}.${field}`] = fieldValue;
    }
    const override: DiagramItemOverride = {};
    if (typeof item.layerId === "string" && item.layerId.trim() && layerIds.has(item.layerId.trim())) {
      override.layerId = item.layerId.trim();
    }
    // 自由元素的元素级 locked/hidden 权威在自由层文档：图层载荷中的同类字段一律剥离。
    if (parsedKey.kind === "freeform") {
      if (item.locked !== undefined || item.hidden !== undefined) {
        legacyUnknown[`itemOverrides.${key}.elementFlags`] = { locked: item.locked, hidden: item.hidden };
      }
    } else {
      if (typeof item.locked === "boolean") override.locked = item.locked;
      if (typeof item.hidden === "boolean") override.hidden = item.hidden;
    }
    const exists = parsedKey.kind === "node" ? nodeIds.has(parsedKey.id)
      : parsedKey.kind === "edge" ? edgeIds.has(parsedKey.id) : freeformIds.has(parsedKey.id);
    // 孤儿判定必须逐类作用域化：只提供了某一类的 id 集合时，不得连带丢弃其他类的有效覆盖。
    const scoped = parsedKey.kind === "node" ? options.nodeIds !== undefined
      : parsedKey.kind === "edge" ? options.edgeIds !== undefined : options.freeformIds !== undefined;
    // 元素已删除时 itemOverride 成为孤儿条目：读取时过滤（设计 3.2）。
    if (!exists && scoped) {
      legacyUnknown[`orphan.${key}`] = override;
      continue;
    }
    if (Object.keys(override).length) itemOverrides[key] = override;
  }

  return {
    state: { schemaVersion: LAYER_SCHEMA_VERSION, layers: entries.map((entry) => entry.layer), itemOverrides },
    legacyUnknown,
    unsupported,
  };
}

export function layerStateFingerprint(state: DiagramLayerState): string {
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    layers: state.layers.map((layer) => ({
      id: layer.id, name: layer.name, kind: layer.kind, memberKind: layer.memberKind,
      locked: layer.locked, hidden: layer.hidden,
    })),
    itemOverrides: Object.keys(state.itemOverrides).sort().map((key) => {
      const override = state.itemOverrides[key];
      return [key, { locked: override.locked ?? null, hidden: override.hidden ?? null, layerId: override.layerId ?? null }];
    }),
  });
}

// ---------- 内容索引与归属解析 ----------

export interface LayerItemGeometry { x: number; y: number; w: number; h: number }

export interface LayerItemSeed {
  itemKey: string;
  kind: DiagramLayerItemKind;
  elementHidden: boolean;
  elementLocked: boolean;
  groupId: string | null;
  box: LayerItemGeometry | null;
}

export interface LayerIndex {
  items: LayerItemSeed[];
  byKey: Map<string, LayerItemSeed>;
}

export interface BuildLayerIndexInput {
  diagram: Pick<Diagram, "nodes" | "edges">;
  freeform?: Pick<FreeformDocument, "elements"> | null;
  edgeBoxes?: Record<string, LayerItemGeometry>;
}

function geometryBox(item: { x: number; y: number; w?: number; h?: number }): LayerItemGeometry {
  return { x: round2(item.x), y: round2(item.y), w: round2(item.w ?? LAYER_NODE_DEFAULT_W), h: round2(item.h ?? LAYER_NODE_DEFAULT_H) };
}

export function buildLayerIndex(input: BuildLayerIndexInput): LayerIndex {
  const items: LayerItemSeed[] = [];
  for (const node of input.diagram.nodes) {
    items.push({ itemKey: itemKeyOf("node", node.id), kind: "node", elementHidden: false, elementLocked: false, groupId: null, box: geometryBox(node as { x: number; y: number; w?: number; h?: number }) });
  }
  for (const edge of input.diagram.edges) {
    items.push({ itemKey: itemKeyOf("edge", edge.id), kind: "edge", elementHidden: false, elementLocked: false, groupId: null, box: input.edgeBoxes?.[edge.id] ?? null });
  }
  for (const element of input.freeform?.elements ?? []) {
    items.push({
      itemKey: itemKeyOf("freeform", element.id), kind: "freeform",
      elementHidden: element.hidden, elementLocked: element.locked,
      groupId: element.groupId ?? null, box: freeformBoundingBox(element),
    });
  }
  return { items, byKey: new Map(items.map((item) => [item.itemKey, item])) };
}

/** 归属解析：itemOverrides.layerId 优先，否则回落默认系统层；引用不存在的图层回落（不抛错）。 */
export function resolveItemLayer(state: DiagramLayerState, itemKey: string): string {
  const parsed = parseItemKey(itemKey);
  if (!parsed) return LAYER_SYSTEM_NODE_ID;
  const layerIds = new Set(state.layers.map((layer) => layer.id));
  const override = state.itemOverrides[itemKey];
  if (override?.layerId && layerIds.has(override.layerId)) return override.layerId;
  return defaultLayerIdFor(parsed.kind);
}

export interface LayerItemFlags { hidden: boolean; locked: boolean }

/** 元素级标志：自由元素取自由层文档；交付节点/连线取 itemOverrides（缺省 false）。 */
export function itemFlagsOf(state: DiagramLayerState, index: LayerIndex, itemKey: string): LayerItemFlags {
  const seed = index.byKey.get(itemKey);
  if (seed?.kind === "freeform") return { hidden: seed.elementHidden, locked: seed.elementLocked };
  const override = state.itemOverrides[itemKey];
  return { hidden: override?.hidden ?? false, locked: override?.locked ?? false };
}

function parentLayer(state: DiagramLayerState, itemKey: string): DiagramLayer | undefined {
  const layerId = resolveItemLayer(state, itemKey);
  return state.layers.find((layer) => layer.id === layerId);
}

/** 隐藏是吞吐封顶（AND 语义），锁定是下限（OR 语义），元素级只做收紧。 */
export function effectiveHidden(state: DiagramLayerState, index: LayerIndex, itemKey: string): boolean {
  return Boolean(parentLayer(state, itemKey)?.hidden) || itemFlagsOf(state, index, itemKey).hidden;
}

export function effectiveLocked(state: DiagramLayerState, index: LayerIndex, itemKey: string): boolean {
  return Boolean(parentLayer(state, itemKey)?.locked) || itemFlagsOf(state, index, itemKey).locked;
}

/** 图层成员集合是派生的，不落库冗余成员列表。 */
export function layerMemberKeys(state: DiagramLayerState, index: LayerIndex, layerId: string): string[] {
  return index.items.filter((item) => resolveItemLayer(state, item.itemKey) === layerId).map((item) => item.itemKey);
}

// ---------- 批量选择判定（对齐自由层口径） ----------

export function layerVisibleKeys(state: DiagramLayerState, index: LayerIndex): string[] {
  return index.items.filter((item) => !effectiveHidden(state, index, item.itemKey)).map((item) => item.itemKey);
}

/** 全选对齐 freeformSelectAllIds：排除隐藏与锁定。 */
export function selectAll(state: DiagramLayerState, index: LayerIndex): string[] {
  return index.items
    .filter((item) => !effectiveHidden(state, index, item.itemKey) && !effectiveLocked(state, index, item.itemKey))
    .map((item) => item.itemKey);
}

export function selectLayerVisible(state: DiagramLayerState, index: LayerIndex, layerId: string): string[] {
  const members = new Set(layerMemberKeys(state, index, layerId));
  return layerVisibleKeys(state, index).filter((key) => members.has(key));
}

export function selectLayerMembers(state: DiagramLayerState, index: LayerIndex, layerId: string): string[] {
  const members = new Set(layerMemberKeys(state, index, layerId));
  return selectAll(state, index).filter((key) => members.has(key));
}

/** 框选对齐 freeformMarqueeHits：排除 effectiveHidden，保留 locked；命中自由元素整组入选。 */
export function marqueeHits(state: DiagramLayerState, index: LayerIndex, rect: FreeformRect): string[] {
  const normalized = normalizeFreeformRect(rect);
  const hits = index.items.filter((item) => item.box && rectIntersects(normalized, item.box)).map((item) => item.itemKey);
  const expanded = new Set(hits);
  const groups = new Set(index.items
    .filter((item) => expanded.has(item.itemKey) && item.kind === "freeform" && item.groupId)
    .map((item) => item.groupId as string));
  if (groups.size) {
    for (const item of index.items) if (item.groupId && groups.has(item.groupId)) expanded.add(item.itemKey);
  }
  return [...expanded].filter((key) => !effectiveHidden(state, index, key));
}

function rectIntersects(a: FreeformRect, b: FreeformRect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

// ---------- 图层编辑操作 ----------

export type LayerReorderAction = "front" | "back" | "forward" | "backward";

export function reorderLayers(state: DiagramLayerState, layerId: string, action: LayerReorderAction): DiagramLayerState {
  const index = state.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return state;
  const layers = [...state.layers];
  const [target] = layers.splice(index, 1);
  layers.splice(action === "front" ? layers.length : action === "back" ? 0
    : action === "forward" ? Math.min(index + 1, layers.length) : Math.max(index - 1, 0), 0, target);
  return { ...state, layers };
}

export function addLayer(state: DiagramLayerState, name: string, options: { id?: string; now?: string } = {}): DiagramLayerState {
  const now = options.now ?? "";
  const layer: DiagramLayer = {
    id: options.id ?? newLayerId(), name, kind: "custom", memberKind: "mixed",
    locked: false, hidden: false, createdAt: now, updatedAt: now,
  };
  return { ...state, layers: [...state.layers, layer] };
}

export function renameLayer(state: DiagramLayerState, layerId: string, name: string, now = ""): DiagramLayerState {
  return { ...state, layers: state.layers.map((layer) => layer.id === layerId ? { ...layer, name, updatedAt: now } : layer) };
}

export function setLayerFlag(state: DiagramLayerState, layerId: string, flag: "locked" | "hidden", value: boolean, now = ""): DiagramLayerState {
  return { ...state, layers: state.layers.map((layer) => layer.id === layerId ? { ...layer, [flag]: value, updatedAt: now } : layer) };
}

/** 删除图层时其成员 layerId 覆盖被清理，回落到默认系统层（设计 3.1）。 */
export function removeLayer(state: DiagramLayerState, layerId: string): DiagramLayerState {
  const target = state.layers.find((layer) => layer.id === layerId);
  if (!target) return state;
  if (target.kind === "system") throw layerContractError("系统图层不可删除", "LAYER_SYSTEM_IMMUTABLE", 400);
  const itemOverrides: Record<string, DiagramItemOverride> = {};
  for (const [key, override] of Object.entries(state.itemOverrides)) {
    if (override.layerId === layerId) {
      const { layerId: _removed, ...rest } = override;
      if (Object.keys(rest).length) itemOverrides[key] = rest;
    } else itemOverrides[key] = override;
  }
  return { schemaVersion: state.schemaVersion, layers: state.layers.filter((layer) => layer.id !== layerId), itemOverrides };
}

// ---------- 契约校验 ----------

export interface LayerValidationContext {
  nodeIds?: string[];
  edgeIds?: string[];
  freeformIds?: string[];
}

/** 严格校验：命名/唯一性/归属/引用完整性；违规抛出带 code 的错误。 */
export function validateLayerState(state: DiagramLayerState, context: LayerValidationContext = {}): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  const layerIds = new Set(state.layers.map((layer) => layer.id));
  for (const layer of state.layers) {
    if (ids.has(layer.id)) throw layerContractError(`图层 id 重复：${layer.id}`);
    ids.add(layer.id);
    const trimmed = layer.name.trim();
    if (!trimmed || trimmed.length > LAYER_NAME_MAX) throw layerContractError(`图层名称必须为 1..${LAYER_NAME_MAX} 个非空白字符`);
    if (names.has(trimmed)) throw layerContractError(`同画布内图层名称必须唯一：${trimmed}`, "LAYER_NAME_CONFLICT", 409);
    names.add(trimmed);
    if (layer.kind === "system") {
      const def = LAYER_SYSTEM_LAYER_DEFS.find((item) => item.id === layer.id);
      if (!def) throw layerContractError(`未知系统图层 id：${layer.id}`);
      if (layer.memberKind !== def.memberKind) throw layerContractError(`系统图层 ${layer.id} 不可改变成员类型`, "LAYER_SYSTEM_IMMUTABLE");
    }
  }
  for (const def of LAYER_SYSTEM_LAYER_DEFS) {
    if (!layerIds.has(def.id)) throw layerContractError(`缺少系统图层：${def.id}`);
  }
  const nodeIds = context.nodeIds ? new Set(context.nodeIds) : null;
  const edgeIds = context.edgeIds ? new Set(context.edgeIds) : null;
  const freeformIds = context.freeformIds ? new Set(context.freeformIds) : null;
  for (const [key, override] of Object.entries(state.itemOverrides)) {
    const parsed = parseItemKey(key);
    if (!parsed) throw layerContractError(`itemOverrides 键必须为 node:/edge:/freeform: 形式的 itemKey：${key}`);
    if (nodeIds && parsed.kind === "node" && !nodeIds.has(parsed.id)) throw layerContractError(`itemOverrides 引用了不存在的交付节点：${key}`);
    if (edgeIds && parsed.kind === "edge" && !edgeIds.has(parsed.id)) throw layerContractError(`itemOverrides 引用了不存在的连线：${key}`);
    if (freeformIds && parsed.kind === "freeform" && !freeformIds.has(parsed.id)) throw layerContractError(`itemOverrides 引用了不存在的自由元素：${key}`);
    if (parsed.kind === "freeform" && (override.locked !== undefined || override.hidden !== undefined)) {
      throw layerContractError(`禁止在 itemOverrides 中为自由元素写 locked/hidden（自由元素权威在自由层文档）：${key}`);
    }
    if (override.layerId && !layerIds.has(override.layerId)) throw layerContractError(`itemOverrides 引用了不存在的图层：${override.layerId}`);
    if (parsed.kind === "node" && override.layerId && override.layerId !== LAYER_SYSTEM_NODE_ID) {
      throw layerContractError("交付节点不可搬运到非系统图层", "LAYER_MEMBERSHIP_FORBIDDEN", 400);
    }
    if (parsed.kind === "edge" && override.layerId && override.layerId !== LAYER_SYSTEM_EDGE_ID) {
      throw layerContractError("连线不可搬运到非系统图层", "LAYER_MEMBERSHIP_FORBIDDEN", 400);
    }
  }
}