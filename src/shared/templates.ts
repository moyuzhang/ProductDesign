import { z } from "zod";
import {
  DIAGRAM_TEMPLATE_SCHEMA_VERSION,
  DIAGRAM_TEMPLATE_SCOPES,
  type DiagramComponentDefinition,
  type DiagramComponentLibrary,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramItemOverride,
  type DiagramLayer,
  type DiagramLayerState,
  type DiagramNode,
  type DiagramTemplateContent,
  type DiagramTemplateScope,
  type DiagramTemplateSummary,
  type DiagramTemplateThumbnailMeta,
  type DiagramType,
  type FreeformDocument,
  type FreeformElement,
  type FreeformUnknownElement,
} from "./types.js";
import {
  COMPONENT_ID_PREFIX,
  componentEdgeSchema,
  componentGroupSchema,
  componentItemOverrideSchema,
  componentLayerSchema,
  componentLibrarySchema,
  componentNodeSchema,
  instantiateComponent,
  newComponentId,
} from "./components.js";
import {
  FREEFORM_ASSET_PLACEHOLDER_ID,
  FREEFORM_ELEMENTS_MAX,
  FREEFORM_UNSUPPORTED_MAX,
  freeformBoundingBox,
  freeformElementSchema,
  freeformUnknownElementSchema,
  normalizeFreeformDocument,
  normalizeFreeformRect,
  round2,
  type FreeformRect,
} from "./freeform.js";
import {
  defaultLayerState,
  normalizeLayerState,
} from "./layers.js";

export const TEMPLATE_SCHEMA_PREFIX = "whiteboard.template/";
export const SUPPORTED_TEMPLATE_SCHEMA_VERSION = DIAGRAM_TEMPLATE_SCHEMA_VERSION;
export const TEMPLATE_SCHEMA_MAJOR = 1;
export const TEMPLATE_SCHEMA_MINOR = 0;
export const TEMPLATE_NAME_MAX = 160;
export const TEMPLATE_SCOPE_MAX = 24;
export const TEMPLATE_CREATED_BY_MAX = 120;
export const TEMPLATE_SYSTEM_CREATED_BY = "system";
export const TEMPLATE_STORE_CHUNK_LIMIT = 2000;

export const TEMPLATE_THUMBNAIL_MAX_BYTES = 32 * 1024;
export const TEMPLATE_THUMBNAIL_W = 160;
export const TEMPLATE_THUMBNAIL_H = 120;
export const TEMPLATE_THUMBNAIL_PAD = 6;
export const TEMPLATE_THUMBNAIL_TAGS = [
  "svg", "g", "rect", "circle", "ellipse", "line", "polyline", "text", "path",
] as const;

/** 追加模式：与目标画布现有内容包围盒右下角的确定性间距（设计 5.6）。 */
export const TEMPLATE_APPEND_GAP = 32;
/** 模板节点/连线/组合的新 id 前缀：不含交付节点 slug 形态（避免被识别为交付节点）。 */
export const TEMPLATE_NODE_ID_PREFIX = "tpl_node_";
export const TEMPLATE_EDGE_ID_PREFIX = "tpl_edge_";
export const TEMPLATE_GROUP_ID_PREFIX = "tpl_group_";

/** 与自由层一致的交付专有字段集合，并额外覆盖 deliveryUpdatedAt（设计 5.4）。 */
export const TEMPLATE_DELIVERY_FIELDS = [
  "requirementStatus", "designStatus", "developmentStatus", "acceptanceStatus",
  "owner", "acceptanceCriteria", "requiresDatabase", "blockedReason", "deliveryUpdatedAt",
] as const;

export const TEMPLATE_DIAGRAM_NODE_DEFAULT_W = 176;
export const TEMPLATE_DIAGRAM_NODE_DEFAULT_H = 46;

export interface TemplateContractErrorShape { code: string; message: string; statusCode: number; details?: Record<string, unknown> }

export function templateContractError(
  message: string,
  code = "TEMPLATE_CONTRACT_INVALID",
  statusCode = 400,
  details?: Record<string, unknown>,
): Error {
  return Object.assign(new Error(message), { statusCode, code, ...(details ? { details } : {}) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 5.4 schema_version 兼容矩阵 ----------

export interface ParsedTemplateSchemaVersion { raw: string; major: number; minor: number }

export function parseTemplateSchemaVersion(value: unknown): ParsedTemplateSchemaVersion | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 32) return null;
  if (!raw.startsWith(TEMPLATE_SCHEMA_PREFIX)) return null;
  const tail = raw.slice(TEMPLATE_SCHEMA_PREFIX.length);
  const match = /^(\d{1,4})\.(\d{1,4})$/.exec(tail);
  if (!match) return null;
  return { raw, major: Number(match[1]), minor: Number(match[2]) };
}

export type TemplateCompatibilityStatus = "exact" | "downgrade" | "unsupported" | "invalid";

export interface TemplateCompatibility {
  status: TemplateCompatibilityStatus;
  templateSchemaVersion: string;
  supportedSchemaVersions: string[];
  major: number | null;
  minor: number | null;
  migrated: boolean;
  reason: string;
}

/** 应用与读取共用同一判定函数（设计 5.4）。只允许「旧 → 新」，禁止「新 → 旧」。 */
export function resolveTemplateCompatibility(value: unknown): TemplateCompatibility {
  const supported = [...SUPPORTED_TEMPLATE_SCHEMA_VERSIONS];
  const parsed = parseTemplateSchemaVersion(value);
  if (!parsed) {
    return {
      status: "invalid", templateSchemaVersion: typeof value === "string" ? value : "",
      supportedSchemaVersions: supported, major: null, minor: null, migrated: false,
      reason: `无法解析模板 schemaVersion：${String(value)}`,
    };
  }
  if (parsed.major > TEMPLATE_SCHEMA_MAJOR) {
    return {
      status: "unsupported", templateSchemaVersion: parsed.raw,
      supportedSchemaVersions: supported, major: parsed.major, minor: parsed.minor, migrated: false,
      reason: `模板主版本 ${parsed.major} 高于本实现支持的 ${TEMPLATE_SCHEMA_MAJOR}`,
    };
  }
  if (parsed.major === TEMPLATE_SCHEMA_MAJOR && parsed.minor > TEMPLATE_SCHEMA_MINOR) {
    // 设计 5.4 未单列该格；按「禁止新→旧」方向性原则判定为 unsupported，避免丢字段。
    return {
      status: "unsupported", templateSchemaVersion: parsed.raw,
      supportedSchemaVersions: supported, major: parsed.major, minor: parsed.minor, migrated: false,
      reason: `模板次版本 ${parsed.minor} 高于本实现支持的 ${TEMPLATE_SCHEMA_MINOR}`,
    };
  }
  if (parsed.major === TEMPLATE_SCHEMA_MAJOR && parsed.minor === TEMPLATE_SCHEMA_MINOR) {
    return {
      status: "exact", templateSchemaVersion: parsed.raw,
      supportedSchemaVersions: supported, major: parsed.major, minor: parsed.minor, migrated: false,
      reason: "版本完全一致",
    };
  }
  return {
    status: "downgrade", templateSchemaVersion: parsed.raw,
    supportedSchemaVersions: supported, major: parsed.major, minor: parsed.minor, migrated: true,
    reason: `旧版本模板按降级路径归一化到 ${SUPPORTED_TEMPLATE_SCHEMA_VERSION}`,
  };
}

export const SUPPORTED_TEMPLATE_SCHEMA_VERSIONS = [SUPPORTED_TEMPLATE_SCHEMA_VERSION];

/** 不兼容（主版本更高 / 次版本更高）→ 409，服务端不写任何数据。 */
export function assertTemplateCompatible(value: unknown): TemplateCompatibility {
  const compatibility = resolveTemplateCompatibility(value);
  if (compatibility.status === "invalid") {
    throw templateContractError(compatibility.reason, "TEMPLATE_CONTRACT_INVALID", 400);
  }
  if (compatibility.status === "unsupported") {
    throw templateContractError(compatibility.reason, "TEMPLATE_SCHEMA_UNSUPPORTED", 409, {
      templateSchemaVersion: compatibility.templateSchemaVersion,
      supportedSchemaVersions: compatibility.supportedSchemaVersions,
    });
  }
  return compatibility;
}

// ---------- schema ----------

export const templateScopeSchema = z.enum(DIAGRAM_TEMPLATE_SCOPES);

export const templateThumbnailMetaSchema = z.object({
  kind: z.enum(["none", "svg"]),
  width: z.number().finite().min(0).max(4096),
  height: z.number().finite().min(0).max(4096),
  viewBox: z.string().max(64),
  content: z.string().optional(),
  generatedAt: z.string().max(64),
  source: z.enum(["auto", "custom"]),
}).strict().superRefine((meta, context) => {
  if (meta.kind === "svg") {
    if (!meta.content) context.addIssue({ code: "custom", path: ["content"], message: "kind=svg 时 content 必填" });
    if (meta.width <= 0 || meta.height <= 0) context.addIssue({ code: "custom", path: ["width"], message: "kind=svg 时尺寸必须为正" });
  }
});

const templateLayerStateSchema = z.object({
  schemaVersion: z.literal(1),
  layers: z.array(componentLayerSchema).max(200),
  itemOverrides: z.record(z.string().max(240), componentItemOverrideSchema),
}).strict();

export const templateContentSchema = z.object({
  schemaVersion: z.string().trim().min(1).max(32),
  diagram: z.object({
    nodes: z.array(componentNodeSchema).max(FREEFORM_ELEMENTS_MAX),
    edges: z.array(componentEdgeSchema).max(FREEFORM_ELEMENTS_MAX),
    groups: z.array(componentGroupSchema).max(500),
    layers: templateLayerStateSchema.optional(),
  }).strict(),
  freeform: z.object({
    elements: z.array(freeformElementSchema).max(FREEFORM_ELEMENTS_MAX),
    unsupported: z.array(freeformUnknownElementSchema).max(FREEFORM_UNSUPPORTED_MAX),
  }).strict().optional(),
  components: componentLibrarySchema.optional(),
}).strict();

export const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
  scope: z.literal("project").default("project"),
  schemaVersion: z.string().trim().min(1).max(32).default(SUPPORTED_TEMPLATE_SCHEMA_VERSION),
  content: z.unknown(),
  thumbnailMeta: templateThumbnailMetaSchema.optional(),
  actor: z.string().trim().max(120).optional(),
}).strict();

export const templatePatchSchema = z.object({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX).optional(),
  schemaVersion: z.string().trim().min(1).max(32).optional(),
  content: z.unknown().optional(),
  thumbnailMeta: templateThumbnailMetaSchema.optional(),
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

export const templateRevokeSchema = z.object({
  actor: z.string().trim().max(120).optional(),
}).strict();

export const templateApplySchema = z.object({
  templateId: z.string().trim().min(1).max(120),
  mode: z.enum(["append", "replace"]).default("append"),
  expectedUpdatedAt: z.string().max(64).nullable(),
  actor: z.string().trim().max(120).optional(),
}).strict();

export const TEMPLATE_MODES = ["append", "replace"] as const;
export type TemplateApplyMode = (typeof TEMPLATE_MODES)[number];

// ---------- scope 不变式 ----------

export function assertTemplateScopeInvariant(scope: unknown, projectId: unknown): DiagramTemplateScope {
  const parsed = templateScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw templateContractError(`模板 scope 非法：${String(scope)}`, "TEMPLATE_SCOPE_INVALID", 400);
  }
  const isNullProject = projectId === null || projectId === undefined || projectId === "";
  if (parsed.data === "system" && !isNullProject) {
    throw templateContractError("scope=system 要求 project_id 为空", "TEMPLATE_SCOPE_INVALID", 400);
  }
  if (parsed.data === "project" && isNullProject) {
    throw templateContractError("scope=project 要求 project_id 非空", "TEMPLATE_SCOPE_INVALID", 400);
  }
  return parsed.data;
}

// ---------- 交付字段脱敏 ----------

function collectDeliveryLeaks(value: unknown): string[] {
  const found = new Set<string>();
  const deliveryFields = new Set<string>(TEMPLATE_DELIVERY_FIELDS);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (deliveryFields.has(key)) found.add(key);
      visit(item);
    }
  };
  visit(value);
  return [...found].sort();
}

/** 剥离交付专有字段（返回深拷贝）。 */
export function stripTemplateDeliveryFields<T>(value: T): { value: T; dropped: string[] } {
  const clone = structuredClone(value);
  const dropped = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if ((TEMPLATE_DELIVERY_FIELDS as readonly string[]).includes(key)) {
        dropped.add(key);
        delete (node as Record<string, unknown>)[key];
        continue;
      }
      visit(item);
    }
  };
  visit(clone);
  return { value: clone, dropped: [...dropped].sort() };
}

/** content 命中交付字段即 400（设计 5.4）。 */
export function assertTemplateContentNoDeliveryLeak(value: unknown): void {
  const leaks = collectDeliveryLeaks(value);
  if (leaks.length) {
    throw templateContractError(
      `模板内容禁止携带交付状态字段：${leaks.join(", ")}`,
      "TEMPLATE_DELIVERY_FIELD_FORBIDDEN",
      400,
      { fields: leaks },
    );
  }
}

/** content 中的绝对 URL / data: / blob: 引用一律拒绝（图片只允许受控 assetRef）。 */
export function assertTemplateContentNoExternalUrl(value: unknown): void {
  const hit: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^\s*(?:https?:|\/\/|data:|blob:|javascript:|file:)/i.test(node)) hit.push(node.slice(0, 120));
      return;
    }
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    Object.values(node as Record<string, unknown>).forEach(visit);
  };
  visit(value);
  if (hit.length) {
    throw templateContractError(`模板内容禁止携带外部/内联资源引用：${hit[0]}`, "TEMPLATE_CONTRACT_INVALID", 400);
  }
}

// ---------- content 归一化与迁移 ----------

export interface TemplateContentNormalizeResult {
  content: DiagramTemplateContent;
  migrated: boolean;
  droppedDeliveryFields: string[];
  warnings: string[];
}

function coerceNode(raw: unknown): DiagramNode | null {
  if (!isRecord(raw)) return null;
  const candidate: Record<string, unknown> = { ...raw };
  if (typeof candidate.label !== "string") candidate.label = "";
  if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)) candidate.x = 0;
  if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) candidate.y = 0;
  const parsed = componentNodeSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as unknown as DiagramNode) : null;
}

/**
 * 降级迁移：缺字段补默认、旧式 zIndex 转数组序、未知自由元素进 unsupported 容器。
 * 迁移幂等：同一份旧数据重复调用结果一致（时间戳不参与）。
 * 迁移后必须通过 strict schema 校验，否则 400 TEMPLATE_CONTRACT_INVALID。
 */
export function normalizeTemplateContent(
  value: unknown,
  options: { now?: string; allowMissingAssetRef?: boolean; availableAssetIds?: Iterable<string> } = {},
): TemplateContentNormalizeResult {
  const now = options.now ?? "";
  const warnings: string[] = [];
  const raw = isRecord(value) ? value : {};
  const declaredVersion = typeof raw.schemaVersion === "string" && raw.schemaVersion.trim()
    ? raw.schemaVersion.trim() : SUPPORTED_TEMPLATE_SCHEMA_VERSION;

  const stripped = stripTemplateDeliveryFields(raw);
  if (stripped.dropped.length) {
    warnings.push(`已剥离交付状态字段：${stripped.dropped.join(", ")}`);
  }
  const source = stripped.value as Record<string, unknown>;
  const diagramRaw = isRecord(source.diagram) ? source.diagram : {};

  const seenNodeIds = new Set<string>();
  const nodes = (Array.isArray(diagramRaw.nodes) ? diagramRaw.nodes : []).flatMap((item) => {
    const node = coerceNode(item);
    if (!node) { warnings.push("丢弃无法归一化的节点快照"); return []; }
    if (seenNodeIds.has(node.id)) return [];
    seenNodeIds.add(node.id);
    return [node];
  });
  const nodeIdSet = new Set(nodes.map((node) => node.id));

  const seenEdgeIds = new Set<string>();
  const edges = (Array.isArray(diagramRaw.edges) ? diagramRaw.edges : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    const parsed = componentEdgeSchema.safeParse(item);
    if (!parsed.success) { warnings.push("丢弃无法归一化的连线快照"); return []; }
    const edge = parsed.data as unknown as DiagramEdge;
    if (seenEdgeIds.has(edge.id)) return [];
    if (!nodeIdSet.has(edge.from) || !nodeIdSet.has(edge.to)) { warnings.push(`丢弃悬空连线 ${edge.id}`); return []; }
    seenEdgeIds.add(edge.id);
    return [edge];
  });

  const seenGroupIds = new Set<string>();
  const groups = (Array.isArray(diagramRaw.groups) ? diagramRaw.groups : []).flatMap((item) => {
    if (!isRecord(item)) return [];
    const parsed = componentGroupSchema.safeParse(item);
    if (!parsed.success) return [];
    const group = parsed.data as unknown as DiagramGroup;
    if (seenGroupIds.has(group.id)) return [];
    const nodeIds = group.nodeIds.filter((id) => nodeIdSet.has(id));
    if (!nodeIds.length) return [];
    seenGroupIds.add(group.id);
    return [{ ...group, nodeIds }];
  });

  const freeformRaw = isRecord(source.freeform) ? source.freeform : null;
  const freeformDocument: FreeformDocument | null = freeformRaw
    ? normalizeFreeformDocument(
      { schemaVersion: 1, diagramId: "__template__", elements: freeformRaw.elements ?? [], unsupported: freeformRaw.unsupported ?? [], updatedAt: now },
      "__template__",
    )
    : null;
  const freeformElements: FreeformElement[] = freeformDocument
    ? freeformDocument.elements.map((element) => remapTemplateImageAsset(element, options.availableAssetIds))
    : [];
  const freeformUnsupported: FreeformUnknownElement[] = freeformDocument?.unsupported ?? [];

  const layerRaw = isRecord(diagramRaw.layers) ? diagramRaw.layers : null;
  const normalizedLayers = layerRaw
    ? normalizeLayerState(layerRaw, {
      nodeIds: [...nodeIdSet],
      edgeIds: [...seenEdgeIds],
      freeformIds: freeformElements.map((element) => element.id),
      now,
    }).state
    : null;

  const librariesRaw = isRecord(source.components) ? source.components : null;
  const components = librariesRaw ? componentLibrarySchema.safeParse(librariesRaw) : null;

  const content: DiagramTemplateContent = {
    schemaVersion: declaredVersion,
    diagram: {
      nodes,
      edges,
      groups,
      ...(normalizedLayers ? { layers: normalizedLayers } : {}),
    },
    ...(freeformDocument ? { freeform: { elements: freeformElements, unsupported: freeformUnsupported } } : {}),
    ...(components && components.success ? { components: components.data as unknown as DiagramComponentLibrary } : {}),
  };

  const parsed = templateContentSchema.safeParse(content);
  if (!parsed.success) {
    throw templateContractError(
      `模板内容不符合契约：${parsed.error.issues[0]?.message ?? "未知错误"}`,
      "TEMPLATE_CONTRACT_INVALID",
      400,
    );
  }
  const migrated = declaredVersion !== SUPPORTED_TEMPLATE_SCHEMA_VERSION || warnings.length > 0;
  return {
    content: parsed.data as unknown as DiagramTemplateContent,
    migrated,
    droppedDeliveryFields: stripped.dropped,
    warnings,
  };
}

function remapTemplateImageAsset(element: FreeformElement, availableAssetIds?: Iterable<string>): FreeformElement {
  if (element.kind !== "image") return element;
  const available = availableAssetIds ? new Set(availableAssetIds) : null;
  if (!element.assetRef) return element;
  if (available && !available.has(element.assetRef)) return { ...element, assetRef: FREEFORM_ASSET_PLACEHOLDER_ID };
  return element;
}

export function templateContentBytes(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content ?? null)).length;
}

/** content 指纹：不含时间戳，用于 CAS 之外的幂等比对。 */
export function templateContentFingerprint(content: unknown): string {
  return JSON.stringify(content ?? null);
}

// ---------- 5.5 thumbnail_meta ----------

export function noneTemplateThumbnail(now = ""): DiagramTemplateThumbnailMeta {
  return { kind: "none", width: 0, height: 0, viewBox: "0 0 0 0", generatedAt: now, source: "auto" };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 安全校验：白名单标签、禁脚本/事件/外部引用、≤32KB（设计 5.5）。 */
export function assertSafeThumbnailSvg(svg: unknown): string {
  if (typeof svg !== "string" || !svg.trim()) {
    throw templateContractError("缩略图 SVG 不能为空", "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > TEMPLATE_THUMBNAIL_MAX_BYTES) {
    throw templateContractError(`缩略图 SVG 超过 ${TEMPLATE_THUMBNAIL_MAX_BYTES} 字节上限`, "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  if (/<\s*(?:script|foreignObject|iframe|object|embed|animate|animateTransform|set|style|use|image|a|audio|video|link|meta)\b/i.test(svg)) {
    throw templateContractError("缩略图 SVG 含被禁止的标签", "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  if (/\son[a-z]+\s*=/i.test(svg)) {
    throw templateContractError("缩略图 SVG 含事件属性", "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  if (/(?:href|xlink:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|data:|blob:|javascript:|file:)/i.test(svg)) {
    throw templateContractError("缩略图 SVG 含外部引用", "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  if (/javascript:/i.test(svg)) {
    throw templateContractError("缩略图 SVG 含脚本协议", "TEMPLATE_THUMBNAIL_UNSAFE", 400);
  }
  const allowed = new Set<string>(TEMPLATE_THUMBNAIL_TAGS);
  for (const match of svg.matchAll(/<\s*\/?\s*([A-Za-z][A-Za-z0-9:_-]*)/g)) {
    const tag = match[1].toLowerCase();
    if (!allowed.has(tag)) {
      throw templateContractError(`缩略图 SVG 含未允许标签 <${tag}>`, "TEMPLATE_THUMBNAIL_UNSAFE", 400);
    }
  }
  return svg;
}

export function normalizeTemplateThumbnail(value: unknown, now = ""): DiagramTemplateThumbnailMeta {
  const parsed = templateThumbnailMetaSchema.safeParse(value);
  if (!parsed.success) return noneTemplateThumbnail(now);
  const meta = parsed.data as DiagramTemplateThumbnailMeta;
  if (meta.kind === "none") return noneTemplateThumbnail(meta.generatedAt || now);
  assertSafeThumbnailSvg(meta.content ?? "");
  return meta;
}

/** 列表投影：不回传 content，避免列表体积膨胀（设计 5.5）。 */
export function toTemplateSummary(
  template: { id: string; projectId: string | null; scope: DiagramTemplateScope; name: string; schemaVersion: string; thumbnailMeta: DiagramTemplateThumbnailMeta; createdBy: string; createdAt: string; updatedAt: string; revokedAt: string | null },
  content: unknown,
): DiagramTemplateSummary {
  const source = template.thumbnailMeta ?? noneTemplateThumbnail();
  const metaWithoutContent: DiagramTemplateThumbnailMeta = {
    kind: source.kind,
    width: source.width,
    height: source.height,
    viewBox: source.viewBox,
    generatedAt: source.generatedAt,
    source: source.source,
  };
  return {
    id: template.id,
    projectId: template.projectId,
    scope: template.scope,
    name: template.name,
    schemaVersion: template.schemaVersion,
    thumbnailMeta: metaWithoutContent as DiagramTemplateThumbnailMeta,
    createdBy: template.createdBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    revokedAt: template.revokedAt,
    contentBytes: templateContentBytes(content),
  };
}

/** 模板内容几何包围盒（节点矩形 + 自由元素旋转外框 + 连线点）。 */
export function templateContentBox(content: DiagramTemplateContent): FreeformRect | null {
  const boxes: FreeformRect[] = [];
  for (const node of content.diagram.nodes) {
    boxes.push({
      x: node.x, y: node.y,
      w: typeof node.w === "number" && Number.isFinite(node.w) ? node.w : TEMPLATE_DIAGRAM_NODE_DEFAULT_W,
      h: typeof node.h === "number" && Number.isFinite(node.h) ? node.h : TEMPLATE_DIAGRAM_NODE_DEFAULT_H,
    });
  }
  for (const element of content.freeform?.elements ?? []) boxes.push(freeformBoundingBox(element));
  for (const edge of content.diagram.edges) {
    const points = edge.points ?? [];
    if (!points.length) continue;
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    boxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return normalizeFreeformRect({ x: round2(x), y: round2(y), w: round2(right - x), h: round2(bottom - y) });
}

/** 确定性缩略图生成：不依赖浏览器渲染，同输入同输出（设计 5.5）。 */
export function buildTemplateThumbnail(
  content: DiagramTemplateContent,
  options: { now?: string } = {},
): { meta: DiagramTemplateThumbnailMeta; warning?: string } {
  const now = options.now ?? "";
  const box = templateContentBox(content);
  if (!box || box.w <= 0 && box.h <= 0) {
    return { meta: noneTemplateThumbnail(now), warning: "模板内容为空，缩略图降级为 none" };
  }
  const innerW = TEMPLATE_THUMBNAIL_W - TEMPLATE_THUMBNAIL_PAD * 2;
  const innerH = TEMPLATE_THUMBNAIL_H - TEMPLATE_THUMBNAIL_PAD * 2;
  const scale = Math.min(innerW / Math.max(box.w, 1), innerH / Math.max(box.h, 1));
  const offsetX = TEMPLATE_THUMBNAIL_PAD + (innerW - box.w * scale) / 2;
  const offsetY = TEMPLATE_THUMBNAIL_PAD + (innerH - box.h * scale) / 2;
  const px = (value: number): number => round2(offsetX + (value - box.x) * scale);
  const py = (value: number): number => round2(offsetY + (value - box.y) * scale);

  const shapes: string[] = [];
  for (const node of content.diagram.nodes) {
    const w = Math.max(round2((typeof node.w === "number" && Number.isFinite(node.w) ? node.w : TEMPLATE_DIAGRAM_NODE_DEFAULT_W) * scale), 1);
    const h = Math.max(round2((typeof node.h === "number" && Number.isFinite(node.h) ? node.h : TEMPLATE_DIAGRAM_NODE_DEFAULT_H) * scale), 1);
    shapes.push(`<rect x="${px(node.x)}" y="${py(node.y)}" width="${w}" height="${h}" rx="2" fill="#e2e8f0" stroke="#94a3b8"/>`);
    const label = (node.label ?? "").slice(0, 14);
    if (label) shapes.push(`<text x="${round2(px(node.x) + 2)}" y="${round2(py(node.y) + 7)}" font-size="6" fill="#475569">${escapeXml(label)}</text>`);
  }
  for (const edge of content.diagram.edges) {
    const points = edge.points ?? [];
    if (!points.length) continue;
    const poly = points.map((point) => `${px(point.x)},${py(point.y)}`).join(" ");
    shapes.push(`<polyline points="${poly}" fill="none" stroke="#94a3b8"/>`);
  }
  for (const element of content.freeform?.elements ?? []) {
    const bbox = freeformBoundingBox(element);
    if (element.kind === "ellipse") {
      shapes.push(`<ellipse cx="${px(bbox.x + bbox.w / 2)}" cy="${py(bbox.y + bbox.h / 2)}" rx="${Math.max(round2(bbox.w * scale / 2), 1)}" ry="${Math.max(round2(bbox.h * scale / 2), 1)}" fill="#fde68a" stroke="#d97706"/>`);
    } else if (element.kind === "arrow") {
      shapes.push(`<line x1="${px(bbox.x)}" y1="${py(bbox.y)}" x2="${px(bbox.x + bbox.w)}" y2="${py(bbox.y + bbox.h)}" stroke="#475569"/>`);
    } else if (element.kind === "text") {
      shapes.push(`<text x="${px(bbox.x)}" y="${round2(py(bbox.y) + 7)}" font-size="6" fill="#334155">${escapeXml((element.text ?? "").slice(0, 14))}</text>`);
    } else {
      shapes.push(`<rect x="${px(bbox.x)}" y="${py(bbox.y)}" width="${Math.max(round2(bbox.w * scale), 1)}" height="${Math.max(round2(bbox.h * scale), 1)}" rx="2" fill="#fde68a" stroke="#d97706"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TEMPLATE_THUMBNAIL_W} ${TEMPLATE_THUMBNAIL_H}" width="${TEMPLATE_THUMBNAIL_W}" height="${TEMPLATE_THUMBNAIL_H}">${shapes.join("")}</svg>`;
  assertSafeThumbnailSvg(svg);
  return {
    meta: {
      kind: "svg",
      width: TEMPLATE_THUMBNAIL_W,
      height: TEMPLATE_THUMBNAIL_H,
      viewBox: `0 0 ${TEMPLATE_THUMBNAIL_W} ${TEMPLATE_THUMBNAIL_H}`,
      content: svg,
      generatedAt: now,
      source: "auto",
    },
  };
}

// ---------- 5.6 应用（append / replace） ----------

export interface TemplateApplyInput {
  diagram: {
    type?: DiagramType;
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    groups: DiagramGroup[];
    layers?: DiagramLayerState | null;
    components?: DiagramComponentLibrary | null;
  };
  freeform?: FreeformDocument | null;
  content: DiagramTemplateContent;
  mode?: TemplateApplyMode;
  availableAssetIds?: Iterable<string>;
  now?: string;
}

export interface TemplateApplyResult {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  layers: DiagramLayerState;
  components: DiagramComponentLibrary;
  freeform: FreeformDocument;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  createdFreeformIds: string[];
  createdComponentIds: string[];
  droppedLinkDiagramIds: string[];
  droppedEdgeIds: string[];
}

/** 追加偏移：现有内容包围盒右下角 + 32（确定性，设计 5.6）。 */
export function templateAppendOffset(content: DiagramTemplateContent): { x: number; y: number } {
  const box = templateContentBox(content);
  if (!box) return { x: 0, y: 0 };
  return { x: round2(box.x + box.w + TEMPLATE_APPEND_GAP), y: round2(box.y + box.h + TEMPLATE_APPEND_GAP) };
}

export function emptyComponentLibrary(): DiagramComponentLibrary {
  return { schemaVersion: 1, components: [] };
}

/** replace 前置校验：非主画布 + 无交付数据（设计 5.6）。 */
export function assertTemplateReplaceAllowed(input: {
  diagramType?: DiagramType;
  nodes: DiagramNode[];
  planCount?: number;
  evidenceCount?: number;
}): void {
  if (input.diagramType === "main") {
    throw templateContractError("replace 模式不允许作用于主画布", "TEMPLATE_REPLACE_FORBIDDEN", 409);
  }
  const withDelivery = input.nodes.filter((node) => (TEMPLATE_DELIVERY_FIELDS as readonly string[]).some((field) => (node as unknown as Record<string, unknown>)[field] !== undefined));
  if (withDelivery.length) {
    throw templateContractError("目标画布存在交付状态节点，replace 被拒绝", "TEMPLATE_REPLACE_FORBIDDEN", 409, { nodeIds: withDelivery.map((node) => node.id) });
  }
  if ((input.planCount ?? 0) > 0 || (input.evidenceCount ?? 0) > 0) {
    throw templateContractError("目标画布存在计划/证据绑定，replace 被拒绝", "TEMPLATE_REPLACE_FORBIDDEN", 409);
  }
}

/**
 * 把模板内容物化进目标画布：新 id、几何偏移、组重映射、跨画布关联不还原。
 * 纯函数：不写库、不产生任何交付/计划/证据数据。
 */
export function applyTemplateToDiagram(input: TemplateApplyInput): TemplateApplyResult {
  const mode: TemplateApplyMode = input.mode ?? "append";
  const now = input.now ?? "";
  const target = input.diagram;
  const replace = mode === "replace";

  const baseNodes = replace ? [] : target.nodes;
  const baseEdges = replace ? [] : target.edges;
  const baseGroups = replace ? [] : target.groups;
  const baseLayers = replace ? defaultLayerState({}, now) : (target.layers ?? defaultLayerState({}, now));
  const baseComponents = replace ? emptyComponentLibrary() : (target.components ?? emptyComponentLibrary());
  const baseFreeform: FreeformDocument = replace
    ? { schemaVersion: 1, diagramId: input.freeform?.diagramId ?? "", elements: [], unsupported: [], updatedAt: now }
    : (input.freeform ?? { schemaVersion: 1, diagramId: "", elements: [], unsupported: [], updatedAt: now });

  const templateBox = templateContentBox(input.content);
  const offset = replace
    ? { x: 0, y: 0 }
    : (() => {
      const anchor = templateAppendOffset({
        schemaVersion: input.content.schemaVersion,
        diagram: { nodes: baseNodes, edges: baseEdges, groups: baseGroups, ...(target.layers ? { layers: target.layers } : {}) },
        ...(baseFreeform.elements.length ? { freeform: { elements: baseFreeform.elements, unsupported: baseFreeform.unsupported } } : {}),
      });
      // 锚点 = 现有内容右下角 + 32；再减去模板自身左上角，保证模板不与该锚点重叠。
      return { x: round2(anchor.x - (templateBox?.x ?? 0)), y: round2(anchor.y - (templateBox?.y ?? 0)) };
    })();

  const definition: DiagramComponentDefinition = {
    id: `${COMPONENT_ID_PREFIX}tpl_${randomSuffix()}`,
    name: "template-payload",
    payload: {
      nodes: input.content.diagram.nodes as unknown as DiagramComponentDefinition["payload"]["nodes"],
      edges: input.content.diagram.edges,
      groups: input.content.diagram.groups,
      freeform: input.content.freeform ? { elements: input.content.freeform.elements } : null,
      layers: input.content.diagram.layers
        ? { layers: input.content.diagram.layers.layers, itemOverrides: input.content.diagram.layers.itemOverrides }
        : null,
    },
    sourceSelection: { nodeIds: [], edgeIds: [], freeformIds: [] },
    createdBy: TEMPLATE_SYSTEM_CREATED_BY,
    createdAt: now,
    updatedAt: now,
  };

  const instantiated = instantiateComponent({
    definition,
    offsetX: offset.x,
    offsetY: offset.y,
    availableAssetIds: input.availableAssetIds,
    now,
  });

  // 模板应用不还原跨画布关联：新节点 linkDiagramIds 置空并记录（设计 10.2）。
  const droppedLinkDiagramIds: string[] = [];
  const createdNodes: DiagramNode[] = instantiated.nodes.map((node) => {
    const linkIds = (node as { linkDiagramIds?: string[] }).linkDiagramIds;
    if (!replace && Array.isArray(linkIds) && linkIds.length) droppedLinkDiagramIds.push(node.id);
    if (linkIds !== undefined) {
      const clone = { ...node } as Record<string, unknown>;
      delete clone.linkDiagramIds;
      return clone as unknown as DiagramNode;
    }
    return node;
  });

  const instantiatedLayers = instantiated.layers;
  const layers = instantiatedLayers ? mergeLayerStates(baseLayers, instantiatedLayers, now) : baseLayers;

  const components = mergeComponentLibraries(baseComponents, input.content.components, now);

  const freeformElements = [...baseFreeform.elements, ...instantiated.freeformElements];
  const unsupported = dedupeUnsupported([...baseFreeform.unsupported, ...(input.content.freeform?.unsupported ?? [])]);
  const freeform: FreeformDocument = {
    schemaVersion: 1,
    diagramId: baseFreeform.diagramId,
    elements: freeformElements,
    unsupported,
    updatedAt: now || baseFreeform.updatedAt,
  };

  return {
    nodes: [...baseNodes, ...createdNodes],
    edges: [...baseEdges, ...instantiated.edges],
    groups: [...baseGroups, ...instantiated.groups],
    layers,
    components,
    freeform,
    createdNodeIds: instantiated.createdNodeIds,
    createdEdgeIds: instantiated.createdEdgeIds,
    createdFreeformIds: instantiated.createdFreeformIds,
    createdComponentIds: components.components.slice(baseComponents.components.length).map((component) => component.id),
    droppedLinkDiagramIds,
    droppedEdgeIds: instantiated.droppedEdgeIds,
  };
}

export function mergeLayerStates(
  base: DiagramLayerState,
  addition: { layers: DiagramLayer[]; itemOverrides: Record<string, DiagramItemOverride> },
  now: string,
): DiagramLayerState {
  const seen = new Set(base.layers.map((layer) => layer.id));
  const extra = addition.layers.filter((layer) => {
    if (seen.has(layer.id)) return false;
    seen.add(layer.id);
    return true;
  }).map((layer) => ({ ...layer, updatedAt: layer.updatedAt || now }));
  return {
    schemaVersion: base.schemaVersion,
    layers: [...base.layers, ...extra],
    itemOverrides: { ...base.itemOverrides, ...addition.itemOverrides },
  };
}

function mergeComponentLibraries(
  base: DiagramComponentLibrary,
  addition: DiagramComponentLibrary | undefined,
  now: string,
): DiagramComponentLibrary {
  if (!addition?.components?.length) return base;
  const existing = new Set(base.components.map((component) => component.id));
  const imported = addition.components.map((component) => {
    let id = newComponentId();
    while (existing.has(id)) id = newComponentId();
    existing.add(id);
    return { ...structuredClone(component), id, createdBy: component.createdBy || TEMPLATE_SYSTEM_CREATED_BY, createdAt: component.createdAt || now, updatedAt: now || component.updatedAt };
  });
  return { schemaVersion: base.schemaVersion, components: [...base.components, ...imported] };
}

function dedupeUnsupported(items: FreeformUnknownElement[]): FreeformUnknownElement[] {
  const seen = new Map<string, FreeformUnknownElement>();
  items.forEach((item) => { if (!seen.has(item.id)) seen.set(item.id, item); });
  return [...seen.values()].slice(0, FREEFORM_UNSUPPORTED_MAX);
}