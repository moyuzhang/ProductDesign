import { z } from "zod";
import {
  DIAGRAM_NODE_KINDS,
  FREEFORM_ELEMENT_KINDS,
  FREEFORM_TONES,
  type FreeformDocument,
  type FreeformElement,
  type FreeformElementKind,
  type FreeformStyle,
  type FreeformUnknownElement,
  type PrototypeDraft,
} from "./types.js";

export const FREEFORM_SCHEMA_VERSION = 1 as const;
export const FREEFORM_HISTORY_LIMIT = 50;
export const FREEFORM_MIN_SIZE = 8;
export const FREEFORM_MAX_SIZE = 8192;
export const FREEFORM_COORD_LIMIT = 100000;
export const FREEFORM_PASTE_OFFSET = 16;
export const FREEFORM_ROTATION_SNAP = 15;
export const FREEFORM_ZOOM_MIN = 0.25;
export const FREEFORM_ZOOM_MAX = 4;
export const FREEFORM_TEXT_MAX = 5000;
export const FREEFORM_ALT_MAX = 500;
export const FREEFORM_INK_MAX_POINTS = 4000;
export const FREEFORM_ELEMENTS_MAX = 5000;
export const FREEFORM_UNSUPPORTED_MAX = 1000;
export const FREEFORM_ELEMENT_ID_PREFIX = "fr_";
export const FREEFORM_GROUP_ID_PREFIX = "fg_";
export const FREEFORM_ASSET_ID_PREFIX = "fa_";
/** 越权 / 缺失 assetRef 时使用的占位资源 id：渲染占位图，绝不回退到远程请求。 */
export const FREEFORM_ASSET_PLACEHOLDER_ID = "fa_placeholder_missing";
export const FREEFORM_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const FREEFORM_PNG_SCALE = 2;

/** 交付节点专有字段：自由元素出现任何一个都必须被拒绝，绝不静默忽略。 */
export const FREEFORM_DELIVERY_ONLY_FIELDS = [
  "requirementStatus",
  "designStatus",
  "developmentStatus",
  "acceptanceStatus",
  "owner",
  "acceptanceCriteria",
  "requiresDatabase",
  "blockedReason",
] as const;

export const FREEFORM_ASSET_MIME_WHITELIST = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** 可携带脚本或可执行内容的类型，必须显式拒绝。 */
export const FREEFORM_ASSET_MIME_DENYLIST = [
  "image/svg+xml",
  "image/svg",
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
  "image/bmp",
] as const;

const color = z.string().refine(
  (value) => value === "transparent" || /^#[0-9a-fA-F]{6}$/.test(value),
  "颜色必须为 #RRGGBB 或 transparent",
);

export const freeformElementIdSchema = z.string().trim()
  .regex(/^fr_[A-Za-z0-9_-]{1,200}$/, "自由元素 id 必须以 fr_ 开头");
export const freeformGroupIdSchema = z.string().trim()
  .regex(/^fg_[A-Za-z0-9_-]{1,200}$/, "组合 id 必须以 fg_ 开头");
export const freeformAssetIdSchema = z.string().trim()
  .regex(/^fa_[A-Za-z0-9_-]{1,160}$/, "图片必须引用受控资源 assetRef（fa_ 前缀），禁止 URL/data:/blob:");

export const freeformStyleSchema = z.object({
  fill: color.optional(),
  strokeColor: color.optional(),
  strokeWidth: z.number().finite().min(0).max(40).optional(),
  borderRadius: z.number().finite().min(0).max(2048).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  textColor: color.optional(),
  fontSize: z.number().finite().min(8).max(200).optional(),
  fontWeight: z.enum(["normal", "bold"]).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
}).strict();

const baseElementFields = {
  id: freeformElementIdSchema,
  x: z.number().finite().min(-FREEFORM_COORD_LIMIT).max(FREEFORM_COORD_LIMIT),
  y: z.number().finite().min(-FREEFORM_COORD_LIMIT).max(FREEFORM_COORD_LIMIT),
  w: z.number().finite().min(1).max(FREEFORM_MAX_SIZE),
  h: z.number().finite().min(1).max(FREEFORM_MAX_SIZE),
  rotation: z.number().finite().min(-360).max(360),
  groupId: freeformGroupIdSchema.nullable(),
  style: freeformStyleSchema,
  locked: z.boolean(),
  hidden: z.boolean(),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
};

const pointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

export const freeformTextElementSchema = z.object({
  ...baseElementFields, kind: z.literal("text"),
  text: z.string().max(FREEFORM_TEXT_MAX),
  autoHeight: z.boolean(),
}).strict();

export const freeformStickyElementSchema = z.object({
  ...baseElementFields, kind: z.literal("sticky"),
  text: z.string().max(FREEFORM_TEXT_MAX),
  tone: z.enum(FREEFORM_TONES),
}).strict();

export const freeformRectElementSchema = z.object({
  ...baseElementFields, kind: z.literal("rect"),
  cornerStyle: z.enum(["sharp", "rounded"]),
}).strict();

export const freeformEllipseElementSchema = z.object({
  ...baseElementFields, kind: z.literal("ellipse"),
}).strict();

export const freeformArrowElementSchema = z.object({
  ...baseElementFields, kind: z.literal("arrow"),
  dx: z.number().finite().min(-FREEFORM_MAX_SIZE).max(FREEFORM_MAX_SIZE),
  dy: z.number().finite().min(-FREEFORM_MAX_SIZE).max(FREEFORM_MAX_SIZE),
  arrowStart: z.enum(["none", "triangle"]),
  arrowEnd: z.enum(["none", "triangle"]),
  lineStyle: z.enum(["solid", "dashed", "dotted"]),
}).strict();

export const freeformInkElementSchema = z.object({
  ...baseElementFields, kind: z.literal("ink"),
  points: z.array(pointSchema).min(1).max(FREEFORM_INK_MAX_POINTS),
  pressure: z.array(z.number().finite().min(0).max(1)).max(FREEFORM_INK_MAX_POINTS).optional(),
  strokeWidth: z.number().finite().min(1).max(40),
}).strict();

export const freeformImageElementSchema = z.object({
  ...baseElementFields, kind: z.literal("image"),
  assetRef: freeformAssetIdSchema,
  imageFit: z.enum(["contain", "cover"]),
  alt: z.string().max(FREEFORM_ALT_MAX),
  sourceWidth: z.number().int().min(0).max(FREEFORM_MAX_SIZE),
  sourceHeight: z.number().int().min(0).max(FREEFORM_MAX_SIZE),
}).strict();

export const freeformElementSchema = z.discriminatedUnion("kind", [
  freeformTextElementSchema,
  freeformStickyElementSchema,
  freeformRectElementSchema,
  freeformEllipseElementSchema,
  freeformArrowElementSchema,
  freeformInkElementSchema,
  freeformImageElementSchema,
]);

export const freeformUnknownElementSchema = z.object({
  id: z.string().trim().min(1).max(200),
  raw: z.record(z.string(), z.unknown()),
}).strict();

export const freeformDocumentSchema = z.object({
  schemaVersion: z.literal(FREEFORM_SCHEMA_VERSION),
  diagramId: z.string().trim().min(1).max(200),
  elements: z.array(freeformElementSchema).max(FREEFORM_ELEMENTS_MAX),
  unsupported: z.array(freeformUnknownElementSchema).max(FREEFORM_UNSUPPORTED_MAX),
  updatedAt: z.string().max(64),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  document.elements.forEach((element, index) => {
    if (ids.has(element.id)) context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "自由元素 id 重复" });
    ids.add(element.id);
  });
});

export const freeformSaveSchema = z.object({
  schemaVersion: z.literal(FREEFORM_SCHEMA_VERSION),
  elements: z.array(freeformElementSchema).max(FREEFORM_ELEMENTS_MAX),
  unsupported: z.array(freeformUnknownElementSchema).max(FREEFORM_UNSUPPORTED_MAX).default([]),
  expectedUpdatedAt: z.string().max(64).nullable(),
}).strict().superRefine((document, context) => {
  const ids = new Set<string>();
  document.elements.forEach((element, index) => {
    if (ids.has(element.id)) context.addIssue({ code: "custom", path: ["elements", index, "id"], message: "自由元素 id 重复" });
    ids.add(element.id);
  });
});

export interface FreeformContractErrorShape { code: string; message: string; statusCode: number }

export function freeformContractError(message: string, code = "FREEFORM_CONTRACT_INVALID", statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

// ---------- 2.5 与交付节点元素的区分判据 ----------

export function isFreeformElementId(value: unknown): boolean {
  return typeof value === "string" && /^fr_[A-Za-z0-9_-]{1,200}$/.test(value.trim());
}

export function isFreeformGroupId(value: unknown): boolean {
  return typeof value === "string" && /^fg_[A-Za-z0-9_-]{1,200}$/.test(value.trim());
}

export function isDeliveryNodeId(value: unknown): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.trim())
    && !isFreeformElementId(value) && !isFreeformGroupId(value);
}

export type FreeformIdSpace = "freeform-element" | "freeform-group" | "delivery-node" | "unknown";

export function freeformIdSpaceOf(value: unknown): FreeformIdSpace {
  if (isFreeformElementId(value)) return "freeform-element";
  if (isFreeformGroupId(value)) return "freeform-group";
  if (isDeliveryNodeId(value)) return "delivery-node";
  return "unknown";
}

export function freeformKindIntersectsDeliveryKinds(): string[] {
  const delivery = new Set<string>(DIAGRAM_NODE_KINDS);
  return FREEFORM_ELEMENT_KINDS.filter((kind) => delivery.has(kind));
}

/** 深度扫描交付专有字段；自由元素携带任一即视为契约违规。 */
export function listDeliveryFieldLeaks(value: unknown): string[] {
  const found = new Set<string>();
  const deliveryOnly = new Set<string>(FREEFORM_DELIVERY_ONLY_FIELDS);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (deliveryOnly.has(key)) found.add(key);
      visit(item);
    }
  };
  visit(value);
  return [...found].sort();
}

export function assertNoDeliveryFieldLeak(value: unknown): void {
  const leaks = listDeliveryFieldLeaks(value);
  if (leaks.length) {
    throw freeformContractError(`自由元素禁止携带交付字段：${leaks.join(", ")}`, "FREEFORM_DELIVERY_FIELD_FORBIDDEN");
  }
}

// ---------- 2.3 几何 ----------

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface FreeformPoint { x: number; y: number }
export interface FreeformRect { x: number; y: number; w: number; h: number }

export function freeformElementBox(element: Pick<FreeformElement, "x" | "y" | "w" | "h">): FreeformRect {
  return { x: element.x, y: element.y, w: element.w, h: element.h };
}

export function freeformRotatedCorners(element: FreeformElement): FreeformPoint[] {
  const cx = element.x + element.w / 2;
  const cy = element.y + element.h / 2;
  const radians = (element.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const corners: FreeformPoint[] = [
    { x: element.x, y: element.y },
    { x: element.x + element.w, y: element.y },
    { x: element.x + element.w, y: element.y + element.h },
    { x: element.x, y: element.y + element.h },
  ];
  return corners.map((corner) => ({
    x: round2(cx + (corner.x - cx) * cos - (corner.y - cy) * sin),
    y: round2(cy + (corner.x - cx) * sin + (corner.y - cy) * cos),
  }));
}

export function freeformBoundingBox(element: FreeformElement): FreeformRect {
  if (!element.rotation) return freeformElementBox(element);
  const corners = freeformRotatedCorners(element);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: round2(x), y: round2(y), w: round2(Math.max(...xs) - x), h: round2(Math.max(...ys) - y) };
}

export function freeformSelectionBounds(elements: FreeformElement[]): FreeformRect | null {
  if (!elements.length) return null;
  const boxes = elements.map(freeformBoundingBox);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: round2(left), y: round2(top), w: round2(right - left), h: round2(bottom - top) };
}

export function freeformPointInPolygon(point: FreeformPoint, polygon: FreeformPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function freeformRectIntersects(a: FreeformRect, b: FreeformRect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function freeformRectContains(outer: FreeformRect, inner: FreeformRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

const ARROW_HIT_TOLERANCE = 6;

/** 命中规则见设计 4.2：矩形/文本/便签/图片按旋转后多边形；笔迹按旋转后包围盒；箭头按包围盒加端点容差。 */
export function freeformElementHitTest(element: FreeformElement, point: FreeformPoint, zoom = 1): boolean {
  const box = freeformBoundingBox(element);
  if (element.kind === "ink" || element.kind === "arrow") {
    const tolerance = element.kind === "arrow" ? ARROW_HIT_TOLERANCE / Math.max(zoom, FREEFORM_ZOOM_MIN) : 0;
    return freeformRectIntersects({ x: point.x, y: point.y, w: 0, h: 0 }, {
      x: box.x - tolerance, y: box.y - tolerance, w: box.w + tolerance * 2, h: box.h + tolerance * 2,
    });
  }
  if (!element.rotation) return freeformRectIntersects({ x: point.x, y: point.y, w: 0, h: 0 }, box);
  return freeformPointInPolygon(point, freeformRotatedCorners(element));
}

export function freeformMarqueeHits(elements: FreeformElement[], rect: FreeformRect): string[] {
  const normalized = normalizeFreeformRect(rect);
  return elements
    .filter((element) => !element.hidden && freeformRectIntersects(normalized, freeformBoundingBox(element)))
    .map((element) => element.id);
}

export function normalizeFreeformRect(rect: FreeformRect): FreeformRect {
  return {
    x: Math.min(rect.x, rect.x + rect.w),
    y: Math.min(rect.y, rect.y + rect.h),
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
}

// ---------- 2.4 选择 / 分组 / 层级 ----------

export function editableFreeformElement(element: FreeformElement): boolean {
  return !element.hidden && !element.locked;
}

export function expandFreeformSelection(document: FreeformDocument, ids: Iterable<string>, options: { includeGroups?: boolean } = {}): string[] {
  const includeGroups = options.includeGroups ?? true;
  const selected = new Set(ids);
  if (!includeGroups) return [...selected];
  const groups = new Set(document.elements
    .filter((element) => selected.has(element.id) && element.groupId)
    .map((element) => element.groupId as string));
  for (const element of document.elements) {
    if (element.groupId && groups.has(element.groupId)) selected.add(element.id);
  }
  return [...selected];
}

export function freeformSelectionOrder(document: FreeformDocument, ids: Iterable<string>): FreeformElement[] {
  const selected = new Set(ids);
  return document.elements.filter((element) => selected.has(element.id));
}

export function freeformSelectAllIds(document: FreeformDocument): string[] {
  return document.elements.filter(editableFreeformElement).map((element) => element.id);
}

/** 命中测试并返回选择集（组合优先，Alt 点击可选中组内单个元素）。 */
export function resolveFreeformSelectionHit(
  document: FreeformDocument,
  point: FreeformPoint,
  options: { additive?: boolean; isolate?: boolean; current?: Iterable<string>; zoom?: number } = {},
): string[] {
  const current = [...(options.current ?? [])];
  const hit = [...document.elements].reverse().find((element) => !element.hidden && freeformElementHitTest(element, point, options.zoom ?? 1));
  if (!hit) return options.additive ? current : [];
  const resolved = options.isolate || !hit.groupId ? [hit.id] : expandFreeformSelection(document, [hit.id]);
  if (!options.additive) return resolved;
  const already = resolved.every((id) => current.includes(id));
  return already ? current.filter((id) => !resolved.includes(id)) : [...new Set([...current, ...resolved])];
}

export type FreeformLayerAction = "front" | "back" | "forward" | "backward";

/** 层级操作以整组为单位；组内相对次序保持不变。 */
export function reorderFreeformElements(document: FreeformDocument, ids: Iterable<string>, action: FreeformLayerAction): FreeformDocument {
  const selection = expandFreeformSelection(document, ids);
  if (!selection.length) return document;
  const selected = new Set(selection);
  const unitIds = selection;
  const rest = document.elements.filter((element) => !selected.has(element.id));
  if (action === "front") return withElements(document, [...rest, ...freeformSelectionOrder(document, unitIds)]);
  if (action === "back") return withElements(document, [...freeformSelectionOrder(document, unitIds), ...rest]);
  const elements = [...document.elements];
  if (action === "forward") {
    for (let index = elements.length - 2; index >= 0; index -= 1) {
      const element = elements[index];
      const next = elements[index + 1];
      if (selected.has(element.id) && next && !selected.has(next.id)) {
        elements[index] = next;
        elements[index + 1] = element;
      }
    }
    return withElements(document, elements);
  }
  for (let index = 0; index < elements.length - 1; index += 1) {
    const element = elements[index];
    const previous = elements[index + 1];
    if (!selected.has(element.id) && previous && selected.has(previous.id)) {
      elements[index] = previous;
      elements[index + 1] = element;
    }
  }
  return withElements(document, elements);
}

export function groupFreeformElements(document: FreeformDocument, ids: Iterable<string>, groupId?: string): FreeformDocument {
  const selection = [...new Set(ids)].filter((id) => document.elements.some((element) => element.id === id));
  if (selection.length < 2) return document;
  const resolvedGroupId = groupId ?? `fg_${randomSuffix()}`;
  const selected = new Set(selection);
  return withElements(document, document.elements.map((element) =>
    selected.has(element.id) ? { ...element, groupId: resolvedGroupId } : element));
}

export function ungroupFreeformElements(document: FreeformDocument, ids: Iterable<string>): FreeformDocument {
  const selection = new Set(expandFreeformSelection(document, ids));
  const touching = new Set<string>();
  document.elements.forEach((element) => {
    if (element.groupId && selection.has(element.id)) touching.add(element.groupId);
  });
  if (!touching.size) return document;
  return withElements(document, document.elements.map((element) =>
    element.groupId && touching.has(element.groupId) ? { ...element, groupId: null } : element));
}

export function freeformGroups(document: FreeformDocument): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const element of document.elements) {
    if (!element.groupId) continue;
    groups.set(element.groupId, [...(groups.get(element.groupId) ?? []), element.id]);
  }
  return groups;
}

// ---------- 2.3 变换 ----------

export type FreeformResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export function clampFreeformCoordinate(value: number): number {
  return round2(Math.max(-FREEFORM_COORD_LIMIT, Math.min(FREEFORM_COORD_LIMIT, value)));
}

export function moveFreeformElements(document: FreeformDocument, ids: Iterable<string>, dx: number, dy: number): FreeformDocument {
  const selection = new Set(expandFreeformSelection(document, ids));
  return withElements(document, document.elements.map((element) =>
    selection.has(element.id) && !element.locked
      ? { ...element, x: clampFreeformCoordinate(element.x + dx), y: clampFreeformCoordinate(element.y + dy) }
      : element));
}

/** 组合缩放按比例换算子元素几何；Shift 保持纵横比；Alt 以中心缩放；最小 8x8。 */
export function resizeFreeformElements(
  document: FreeformDocument,
  ids: Iterable<string>,
  handle: FreeformResizeHandle,
  dx: number,
  dy: number,
  options: { keepAspect?: boolean; fromCenter?: boolean } = {},
): FreeformDocument {
  const selection = expandFreeformSelection(document, ids);
  const targets = document.elements.filter((element) => selection.includes(element.id) && !element.locked);
  if (!targets.length) return document;
  const bounds = freeformSelectionBounds(targets);
  if (!bounds) return document;
  const horizontal = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const vertical = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  let width = Math.max(FREEFORM_MIN_SIZE, bounds.w + horizontal * dx);
  let height = Math.max(FREEFORM_MIN_SIZE, bounds.h + vertical * dy);
  if (options.keepAspect && bounds.w > 0 && bounds.h > 0) {
    const ratio = bounds.w / bounds.h;
    if (horizontal && !vertical) height = Math.max(FREEFORM_MIN_SIZE, width / ratio);
    else if (vertical && !horizontal) width = Math.max(FREEFORM_MIN_SIZE, height * ratio);
    else {
      const scale = Math.max(width / bounds.w, height / bounds.h);
      width = Math.max(FREEFORM_MIN_SIZE, bounds.w * scale);
      height = Math.max(FREEFORM_MIN_SIZE, bounds.h * scale);
    }
  }
  const scaleX = width / (bounds.w || 1);
  const scaleY = height / (bounds.h || 1);
  const anchorX = options.fromCenter ? bounds.x + bounds.w / 2 : horizontal >= 0 ? bounds.x : bounds.x + bounds.w;
  const anchorY = options.fromCenter ? bounds.y + bounds.h / 2 : vertical >= 0 ? bounds.y : bounds.y + bounds.h;
  const nextWidth = options.fromCenter ? width / 2 : width;
  const nextHeight = options.fromCenter ? height / 2 : height;
  const originX = options.fromCenter ? anchorX - nextWidth : horizontal < 0 ? anchorX - nextWidth : anchorX;
  const originY = options.fromCenter ? anchorY - nextHeight : vertical < 0 ? anchorY - nextHeight : anchorY;
  return withElements(document, document.elements.map((element) => {
    if (!selection.includes(element.id) || element.locked) return element;
    return {
      ...element,
      x: clampFreeformCoordinate(originX + (element.x - bounds.x) * scaleX),
      y: clampFreeformCoordinate(originY + (element.y - bounds.y) * scaleY),
      w: round2(Math.max(FREEFORM_MIN_SIZE, element.w * scaleX)),
      h: round2(Math.max(FREEFORM_MIN_SIZE, element.h * scaleY)),
    };
  }));
}

export function rotateFreeformElements(
  document: FreeformDocument,
  ids: Iterable<string>,
  deltaDegrees: number,
  options: { snap?: boolean } = {},
): FreeformDocument {
  const selection = new Set(expandFreeformSelection(document, ids));
  const targets = document.elements.filter((element) => selection.has(element.id) && !element.locked);
  if (!targets.length) return document;
  const bounds = freeformSelectionBounds(targets);
  if (!bounds) return document;
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  return withElements(document, document.elements.map((element) => {
    if (!selection.has(element.id) || element.locked) return element;
    const rawRotation = element.rotation + deltaDegrees;
    const rotation = options.snap
      ? Math.round(rawRotation / FREEFORM_ROTATION_SNAP) * FREEFORM_ROTATION_SNAP
      : rawRotation;
    const elementCenterX = element.x + element.w / 2;
    const elementCenterY = element.y + element.h / 2;
    const radians = (deltaDegrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const nextCenterX = centerX + (elementCenterX - centerX) * cos - (elementCenterY - centerY) * sin;
    const nextCenterY = centerY + (elementCenterX - centerX) * sin + (elementCenterY - centerY) * cos;
    return {
      ...element,
      rotation: round2(Math.max(-360, Math.min(360, rotation))),
      x: clampFreeformCoordinate(nextCenterX - element.w / 2),
      y: clampFreeformCoordinate(nextCenterY - element.h / 2),
    };
  }));
}

export function setFreeformRotation(document: FreeformDocument, ids: Iterable<string>, rotation: number): FreeformDocument {
  const selection = new Set(expandFreeformSelection(document, ids));
  const clamped = round2(Math.max(-360, Math.min(360, rotation)));
  return withElements(document, document.elements.map((element) =>
    selection.has(element.id) && !element.locked ? { ...element, rotation: clamped } : element));
}

export function updateFreeformElement(
  document: FreeformDocument,
  id: string,
  patch: Partial<FreeformElement>,
): FreeformDocument {
  return withElements(document, document.elements.map((element) =>
    element.id === id ? { ...element, ...patch, id: element.id, kind: element.kind } : element));
}

export function deleteFreeformElements(document: FreeformDocument, ids: Iterable<string>): FreeformDocument {
  const selection = new Set(expandFreeformSelection(document, ids));
  return withElements(document, document.elements.filter((element) => !selection.has(element.id) || element.locked));
}

// ---------- 4.3 复制粘贴 ----------

export interface FreeformClipboard {
  kind: "freeform-clipboard";
  elements: FreeformElement[];
  groups: string[];
}

export function copyFreeformElements(document: FreeformDocument, ids: Iterable<string>): FreeformClipboard | null {
  const elements = freeformSelectionOrder(document, expandFreeformSelection(document, ids))
    .map((element) => structuredClone(element));
  if (!elements.length) return null;
  return {
    kind: "freeform-clipboard",
    elements,
    groups: [...new Set(elements.map((element) => element.groupId).filter((groupId): groupId is string => Boolean(groupId)))],
  };
}

/** 粘贴偏移 (+16, +16)、重生成 id；越权 assetRef 按占位（null）处理。 */
export function pasteFreeformClipboard(
  document: FreeformDocument,
  clipboard: FreeformClipboard,
  options: { offset?: { x: number; y: number }; availableAssetIds?: Iterable<string> } = {},
): { document: FreeformDocument; ids: string[] } {
  const offset = options.offset ?? { x: FREEFORM_PASTE_OFFSET, y: FREEFORM_PASTE_OFFSET };
  const available = options.availableAssetIds ? new Set(options.availableAssetIds) : null;
  const groupMap = new Map<string, string>();
  const ids: string[] = [];
  const pasted = clipboard.elements.map((element) => {
    const id = newFreeformElementId();
    ids.push(id);
    let groupId = element.groupId;
    if (groupId) {
      if (!groupMap.has(groupId)) groupMap.set(groupId, `fg_${randomSuffix()}`);
      groupId = groupMap.get(groupId) as string;
    }
    const nextAssetRef = element.assetRef && (!available || available.has(element.assetRef)) ? element.assetRef : "";
    return normalizeFreeformElement({
      ...element,
      id,
      groupId,
      x: clampFreeformCoordinate(element.x + offset.x),
      y: clampFreeformCoordinate(element.y + offset.y),
      ...(element.kind === "image" ? { assetRef: nextAssetRef } : {}),
    }, { allowMissingAssetRef: true }) as FreeformElement;
  });
  return { document: withElements(document, [...document.elements, ...pasted]), ids };
}

export function duplicateFreeformElements(
  document: FreeformDocument,
  ids: Iterable<string>,
  options: { availableAssetIds?: Iterable<string> } = {},
): { document: FreeformDocument; ids: string[] } {
  const clipboard = copyFreeformElements(document, ids);
  if (!clipboard) return { document, ids: [] };
  return pasteFreeformClipboard(document, clipboard, options);
}

// ---------- 命令栈（撤销 / 重做） ----------

export const FREEFORM_COMMAND_TYPES = [
  "create", "move", "resize", "rotate", "style", "text", "group", "ungroup", "layer", "delete", "paste", "duplicate",
] as const;
export type FreeformCommandType = (typeof FREEFORM_COMMAND_TYPES)[number];

export interface FreeformCommand {
  type: FreeformCommandType;
  before: FreeformElement[];
  after: FreeformElement[];
  beforeOrder?: string[];
  afterOrder?: string[];
  /** unknown 容器同样必须可重放：删除/恢复「不支持的元素」时不得静默丢数据。 */
  beforeUnsupported?: FreeformUnknownElement[];
  afterUnsupported?: FreeformUnknownElement[];
}

export interface FreeformHistory {
  past: FreeformCommand[];
  future: FreeformCommand[];
}

export function createFreeformHistory(): FreeformHistory {
  return { past: [], future: [] };
}

export function buildFreeformCommand(
  type: FreeformCommandType,
  before: FreeformDocument,
  after: FreeformDocument,
  options: { trackOrder?: boolean } = {},
): FreeformCommand | null {
  if (freeformDocumentFingerprint(before) === freeformDocumentFingerprint(after)) return null;
  const indexBefore = new Map(before.elements.map((element) => [element.id, JSON.stringify(element)]));
  const indexAfter = new Map(after.elements.map((element) => [element.id, JSON.stringify(element)]));
  const changedIds = new Set<string>();
  before.elements.forEach((element) => {
    if (indexAfter.get(element.id) !== indexBefore.get(element.id)) changedIds.add(element.id);
  });
  after.elements.forEach((element) => {
    if (indexBefore.get(element.id) !== indexAfter.get(element.id)) changedIds.add(element.id);
  });
  const beforeElements = before.elements.filter((element) => changedIds.has(element.id)).map((element) => structuredClone(element));
  const afterElements = after.elements.filter((element) => changedIds.has(element.id)).map((element) => structuredClone(element));
  const orderChanged = before.elements.map((element) => element.id).join("|") !== after.elements.map((element) => element.id).join("|");
  const needsOrder = options.trackOrder || orderChanged;
  const unsupportedChanged = JSON.stringify(before.unsupported) !== JSON.stringify(after.unsupported);
  return {
    type,
    before: beforeElements,
    after: afterElements,
    ...(needsOrder ? { beforeOrder: before.elements.map((element) => element.id), afterOrder: after.elements.map((element) => element.id) } : {}),
    ...(unsupportedChanged
      ? { beforeUnsupported: structuredClone(before.unsupported), afterUnsupported: structuredClone(after.unsupported) }
      : {}),
  };
}

export function applyFreeformCommand(document: FreeformDocument, command: FreeformCommand, direction: "forward" | "backward" = "forward"): FreeformDocument {
  const target = direction === "forward" ? command.after : command.before;
  const touched = new Set([...command.before, ...command.after].map((element) => element.id));
  const kept = document.elements.filter((element) => !touched.has(element.id));
  const merged = [...kept, ...target.map((element) => structuredClone(element))];
  const unsupported = direction === "forward" ? command.afterUnsupported : command.beforeUnsupported;
  const restored = unsupported ? { ...document, unsupported: structuredClone(unsupported) } : document;
  const order = direction === "forward" ? command.afterOrder : command.beforeOrder;
  if (order) {
    const byId = new Map(merged.map((element) => [element.id, element]));
    const ordered = order
      .map((id) => byId.get(id))
      .filter((element): element is FreeformElement => Boolean(element));
    const missing = merged.filter((element) => !order.includes(element.id));
    return withElements(restored, [...ordered, ...missing]);
  }
  return withElements(restored, merged);
}

/** 连续同类手势（如连续拖拽同一选中集）合并为单条命令。 */
export function mergeFreeformCommands(previous: FreeformCommand | undefined, incoming: FreeformCommand): FreeformCommand[] {
  if (!previous || !shouldMergeFreeformCommands(previous, incoming)) return [incoming];
  const afterOrder = incoming.afterOrder ?? previous.afterOrder;
  const afterUnsupported = incoming.afterUnsupported ?? previous.afterUnsupported;
  return [{
    type: previous.type,
    before: previous.before,
    after: incoming.after,
    ...(afterOrder ? { beforeOrder: previous.beforeOrder ?? afterOrder, afterOrder } : {}),
    ...(afterUnsupported ? { beforeUnsupported: previous.beforeUnsupported, afterUnsupported } : {}),
  }];
}

export function shouldMergeFreeformCommands(previous: FreeformCommand | undefined, incoming: FreeformCommand): boolean {
  if (!previous) return false;
  if (previous.type !== incoming.type) return false;
  const ids = new Set(incoming.after.map((element) => element.id));
  return previous.after.every((element) => ids.has(element.id));
}

export function pushFreeformCommand(history: FreeformHistory, command: FreeformCommand): FreeformHistory {
  return {
    past: [...history.past, command].slice(-FREEFORM_HISTORY_LIMIT),
    future: [],
  };
}

export function undoFreeformCommand(history: FreeformHistory, document: FreeformDocument): { document: FreeformDocument; history: FreeformHistory; command: FreeformCommand } | null {
  const command = history.past.at(-1);
  if (!command) return null;
  return {
    document: applyFreeformCommand(document, command, "backward"),
    history: { past: history.past.slice(0, -1), future: [...history.future, command].slice(-FREEFORM_HISTORY_LIMIT) },
    command,
  };
}

export function redoFreeformCommand(history: FreeformHistory, document: FreeformDocument): { document: FreeformDocument; history: FreeformHistory; command: FreeformCommand } | null {
  const command = history.future.at(-1);
  if (!command) return null;
  return {
    document: applyFreeformCommand(document, command, "forward"),
    history: { past: [...history.past, command].slice(-FREEFORM_HISTORY_LIMIT), future: history.future.slice(0, -1) },
    command,
  };
}

// ---------- 导出 ----------

export type FreeformExportFormat = "png" | "svg" | "json";
export const FREEFORM_EXPORT_FORMATS: FreeformExportFormat[] = ["png", "svg", "json"];

export function buildFreeformExportJson(document: FreeformDocument): string {
  return JSON.stringify({
    schemaVersion: document.schemaVersion,
    diagramId: document.diagramId,
    elements: document.elements,
    unsupported: document.unsupported,
  }, null, 2);
}

export function buildFreeformSvg(document: FreeformDocument, options: { assetUrl?: (assetRef: string) => string } = {}): string {
  const visible = document.elements.filter((element) => !element.hidden);
  const bounds = freeformSelectionBounds(visible) ?? { x: 0, y: 0, w: 1, h: 1 };
  const padding = 8;
  const width = Math.max(1, Math.ceil(bounds.w + padding * 2));
  const height = Math.max(1, Math.ceil(bounds.h + padding * 2));
  const offsetX = -bounds.x + padding;
  const offsetY = -bounds.y + padding;
  const body = visible.map((element) => freeformSvgElement(element, options)).join("");
  const defs = `<defs><marker id="freeform-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#507287" /></marker></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`
    + `${defs}<g transform="translate(${round2(offsetX)} ${round2(offsetY)})">${body}</g></svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function freeformSvgElement(element: FreeformElement, options: { assetUrl?: (assetRef: string) => string }): string {
  const style = element.style ?? {};
  const stroke = style.strokeColor ?? "#507287";
  const fill = style.fill ?? "transparent";
  const opacity = style.opacity ?? 1;
  const center = `translate(${round2(element.x + element.w / 2)} ${round2(element.y + element.h / 2)}) rotate(${round2(element.rotation)}) translate(${round2(-element.w / 2)} ${round2(-element.h / 2)})`;
  const common = `transform="${center}" opacity="${opacity}"`;
  if (element.kind === "ellipse") {
    return `<ellipse ${common} cx="${round2(element.w / 2)}" cy="${round2(element.h / 2)}" rx="${round2(element.w / 2)}" ry="${round2(element.h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${style.strokeWidth ?? 1}" />`;
  }
  if (element.kind === "ink") {
    const points = (element.points ?? [])
      .map((point) => `${round2(point.x * element.w)},${round2(point.y * element.h)}`).join(" ");
    return `<polyline ${common} points="${points}" fill="none" stroke="${stroke}" stroke-width="${element.strokeWidth ?? style.strokeWidth ?? 2}" stroke-linecap="round" />`;
  }
  if (element.kind === "arrow") {
    const dash = element.lineStyle === "dashed" ? ' stroke-dasharray="8 6"' : element.lineStyle === "dotted" ? ' stroke-dasharray="2 5"' : "";
    const marker = element.arrowEnd === "triangle" ? ' marker-end="url(#freeform-arrow)"' : "";
    const markerStart = element.arrowStart === "triangle" ? ' marker-start="url(#freeform-arrow)"' : "";
    return `<line ${common} x1="${round2(element.w / 2)}" y1="${round2(element.h / 2)}" x2="${round2(element.w / 2 + (element.dx ?? 0))}" y2="${round2(element.h / 2 + (element.dy ?? 0))}" stroke="${stroke}" stroke-width="${style.strokeWidth ?? 2}"${dash}${marker}${markerStart} />`;
  }
  if (element.kind === "image") {
    // 占位资源 id 不是真实受控资源：只画占位图，绝不生成任何资源请求（含同源请求）。
    const url = element.assetRef && element.assetRef !== FREEFORM_ASSET_PLACEHOLDER_ID && options.assetUrl
      ? options.assetUrl(element.assetRef) : "";
    if (!url) return `<rect ${common} width="${round2(element.w)}" height="${round2(element.h)}" fill="#1b2d3a" stroke="${stroke}" stroke-dasharray="4 4" />`;
    return `<image ${common} width="${round2(element.w)}" height="${round2(element.h)}" href="${escapeXml(url)}" preserveAspectRatio="${element.imageFit === "cover" ? "xMidYMid slice" : "xMidYMid meet"}" />`;
  }
  const radius = element.kind === "rect" && element.cornerStyle === "sharp" ? 0 : style.borderRadius ?? 0;
  const tone = element.kind === "sticky" ? element.tone ?? "neutral" : null;
  const stickyFill = tone ? { neutral: "#f5e7a3", info: "#bcdcf5", warn: "#f5cfa3", success: "#bfe8c4" }[tone] : fill;
  const textContent = (element.kind === "text" || element.kind === "sticky") && element.text
    ? `<text x="${round2(element.w / 2)}" y="${round2(element.h / 2)}" fill="${style.textColor ?? "#d8edf8"}" font-size="${style.fontSize ?? 14}" font-weight="${style.fontWeight ?? "normal"}" text-anchor="middle" dominant-baseline="middle">${escapeXml(element.text)}</text>`
    : "";
  return `<rect ${common} width="${round2(element.w)}" height="${round2(element.h)}" rx="${round2(radius)}" fill="${stickyFill}" stroke="${stroke}" stroke-width="${style.strokeWidth ?? 1}" />${textContent}`;
}

// ---------- 手势 / 工具状态机（纯函数） ----------

export const FREEFORM_TOOLS = ["select", "text", "sticky", "rect", "ellipse", "arrow", "ink", "imageRef", "pan"] as const;
export type FreeformTool = (typeof FREEFORM_TOOLS)[number];
export const FREEFORM_TOOL_SHORTCUTS: Record<string, FreeformTool> = {
  v: "select", t: "text", s: "sticky", r: "rect", o: "ellipse", a: "arrow", p: "ink", i: "imageRef",
};

export function freeformToolForShortcut(key: string): FreeformTool | null {
  return FREEFORM_TOOL_SHORTCUTS[key.toLowerCase()] ?? null;
}

export function freeformToolCreatesKind(tool: FreeformTool): FreeformElementKind | null {
  if (tool === "text" || tool === "sticky" || tool === "rect" || tool === "ellipse" || tool === "arrow" || tool === "ink") return tool;
  if (tool === "imageRef") return "image";
  return null;
}

export type FreeformGesturePhase = "idle" | "hover" | "selecting" | "active" | "transforming" | "committed";

export interface FreeformMachineState {
  tool: FreeformTool;
  phase: FreeformGesturePhase;
  pointerId: number | null;
  origin: FreeformPoint | null;
  current: FreeformPoint | null;
  selection: string[];
  transform: "move" | "resize" | "rotate" | null;
}

export type FreeformMachineEvent =
  | { type: "pointerdown"; pointerId: number; point: FreeformPoint; hitIds: string[]; additive?: boolean; isolate?: boolean; transform?: "move" | "resize" | "rotate" }
  | { type: "pointermove"; pointerId: number; point: FreeformPoint }
  | { type: "pointerup"; pointerId: number; point: FreeformPoint }
  | { type: "pointercancel"; pointerId: number }
  | { type: "escape" }
  | { type: "tool"; tool: FreeformTool };

export function createFreeformMachine(tool: FreeformTool = "select"): FreeformMachineState {
  return { tool, phase: "idle", pointerId: null, origin: null, current: null, selection: [], transform: null };
}

/**
 * 状态机：idle → hover → selecting（框选）→ active（单/多选）→ transforming（move|resize|rotate）→ committed。
 * transforming 期间只更新预览几何；pointerup 触发一次 committed，产生一条命令。
 */
export function freeformMachine(state: FreeformMachineState, event: FreeformMachineEvent): FreeformMachineState {
  switch (event.type) {
    case "tool":
      // 工具切换不丢失当前选中集。
      return { ...state, tool: event.tool, phase: state.phase === "transforming" ? "active" : state.phase };
    case "pointerdown": {
      if (state.tool !== "select") {
        return { ...state, phase: "transforming", pointerId: event.pointerId, origin: event.point, current: event.point, transform: "move" };
      }
      if (event.hitIds.length) {
        const selection = event.additive ? [...new Set([...state.selection, ...event.hitIds])] : event.hitIds;
        return { ...state, phase: event.transform ? "transforming" : "active", pointerId: event.pointerId, origin: event.point, current: event.point, selection, transform: event.transform ?? null };
      }
      return { ...state, phase: "selecting", pointerId: event.pointerId, origin: event.point, current: event.point, selection: event.additive ? state.selection : [], transform: null };
    }
    case "pointermove":
      if (state.pointerId !== event.pointerId) return state;
      if (state.phase === "selecting" || state.phase === "transforming") return { ...state, current: event.point };
      return { ...state, phase: state.phase === "idle" ? "hover" : state.phase, current: event.point };
    case "pointerup": {
      if (state.pointerId !== event.pointerId) return state;
      if (state.phase === "selecting" || state.phase === "transforming") {
        return { ...state, phase: "committed", pointerId: null, current: event.point };
      }
      return { ...state, phase: "active", pointerId: null };
    }
    case "pointercancel":
      return { ...state, phase: "idle", pointerId: null, origin: null, current: null, transform: null };
    case "escape":
      return { ...state, phase: "idle", pointerId: null, origin: null, current: null, selection: [], transform: null };
    default:
      return state;
  }
}

export function freeformMarqueeRect(state: FreeformMachineState): FreeformRect | null {
  if (state.phase !== "selecting" || !state.origin || !state.current) return null;
  return normalizeFreeformRect({
    x: state.origin.x, y: state.origin.y,
    w: state.current.x - state.origin.x, h: state.current.y - state.origin.y,
  });
}

/** Shift 以 15° 吸附；方向键 1px，Shift+方向键 10px。 */
export function freeformKeyboardNudge(key: string): { dx: number; dy: number } | null {
  const table: Record<string, { dx: number; dy: number }> = {
    ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 }, ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 },
  };
  return table[key] ?? null;
}

// ---------- 归一化 / 迁移 ----------

export function freeformStyleDefaults(kind: FreeformElementKind): Required<Pick<FreeformStyle,
  "fill" | "strokeColor" | "strokeWidth" | "borderRadius" | "opacity" | "textColor" | "fontSize" | "fontWeight" | "align">> {
  const base = {
    fill: "transparent", strokeColor: "#507287", strokeWidth: 1, borderRadius: 6,
    opacity: 1, textColor: "#d8edf8", fontSize: 14, fontWeight: "normal" as const, align: "left" as const,
  };
  if (kind === "sticky") return { ...base, fill: "#f5e7a3", textColor: "#06131c", fontSize: 15 };
  if (kind === "rect") return { ...base, fill: "#1b2d3a" };
  if (kind === "text") return { ...base, strokeWidth: 0, fontSize: 18 };
  if (kind === "arrow" || kind === "ink") return { ...base, strokeWidth: 2 };
  if (kind === "image") return { ...base, strokeColor: "#3c5a6d" };
  return base;
}

export function newFreeformElementId(): string {
  return `${FREEFORM_ELEMENT_ID_PREFIX}${randomSuffix()}`;
}

export function newFreeformGroupId(): string {
  return `${FREEFORM_GROUP_ID_PREFIX}${randomSuffix()}`;
}

function randomSuffix(): string {
  const time = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 10);
  return `${time}${noise}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 逐元素归一化：缺省字段补齐、zIndex 转换为数组序、数值 round 到 2 位。
 * 返回 null 表示该条记录无法作为自由元素解析（由调用方转入 unknown 容器）。
 */
export function normalizeFreeformElement(value: unknown, options: { allowMissingAssetRef?: boolean } = {}): FreeformElement | null {
  if (!isRecord(value)) return null;
  const raw = { ...value } as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!(FREEFORM_ELEMENT_KINDS as readonly string[]).includes(kind)) return null;
  const elementKind = kind as FreeformElementKind;
  const numeric = (key: string, fallback: number): number => {
    const parsed = typeof raw[key] === "number" ? raw[key] as number : Number(raw[key]);
    return Number.isFinite(parsed) ? round2(parsed) : fallback;
  };
  const styleDefaults = freeformStyleDefaults(elementKind);
  const styleInput = isRecord(raw.style) ? raw.style : {};
  const candidate: Record<string, unknown> = {
    id: raw.id,
    kind: elementKind,
    x: numeric("x", 0),
    y: numeric("y", 0),
    w: Math.max(1, numeric("w", elementKind === "text" ? 160 : 120)),
    h: Math.max(1, numeric("h", elementKind === "text" ? 32 : 90)),
    rotation: Math.max(-360, Math.min(360, numeric("rotation", 0))),
    groupId: raw.groupId ?? null,
    style: { ...styleDefaults, ...styleInput },
    locked: Boolean(raw.locked),
    hidden: Boolean(raw.hidden),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : "",
  };
  if (elementKind === "text" || elementKind === "sticky") {
    candidate.text = typeof raw.text === "string" ? raw.text.slice(0, FREEFORM_TEXT_MAX) : "";
  }
  if (elementKind === "text") candidate.autoHeight = raw.autoHeight === undefined ? true : Boolean(raw.autoHeight);
  if (elementKind === "sticky") {
    candidate.tone = (FREEFORM_TONES as readonly string[]).includes(String(raw.tone)) ? raw.tone : "neutral";
  }
  if (elementKind === "rect") candidate.cornerStyle = raw.cornerStyle === "sharp" ? "sharp" : "rounded";
  if (elementKind === "arrow") {
    candidate.dx = numeric("dx", 80);
    candidate.dy = numeric("dy", 0);
    candidate.arrowStart = raw.arrowStart === "triangle" ? "triangle" : "none";
    candidate.arrowEnd = raw.arrowEnd === "none" ? "none" : "triangle";
    candidate.lineStyle = ["solid", "dashed", "dotted"].includes(String(raw.lineStyle)) ? raw.lineStyle : "solid";
  }
  if (elementKind === "ink") {
    const points = Array.isArray(raw.points) ? raw.points : [];
    const normalized = points
      .filter(isRecord)
      .slice(0, FREEFORM_INK_MAX_POINTS)
      .map((point) => ({
        x: Math.max(0, Math.min(1, round2(Number(point.x) || 0))),
        y: Math.max(0, Math.min(1, round2(Number(point.y) || 0))),
      }));
    if (!normalized.length) return null;
    candidate.points = normalized;
    if (Array.isArray(raw.pressure)) {
      candidate.pressure = (raw.pressure as unknown[]).slice(0, normalized.length)
        .map((value) => Math.max(0, Math.min(1, round2(Number(value) || 0))));
    }
    candidate.strokeWidth = Math.max(1, Math.min(40, numeric("strokeWidth", 2)));
  }
  if (elementKind === "image") {
    const assetRef = typeof raw.assetRef === "string" ? raw.assetRef.trim() : "";
    const valid = /^fa_[A-Za-z0-9_-]{1,160}$/.test(assetRef);
    if (!valid && !options.allowMissingAssetRef) return null;
    candidate.assetRef = valid ? assetRef : "";
    candidate.imageFit = raw.imageFit === "cover" ? "cover" : "contain";
    candidate.alt = typeof raw.alt === "string" ? raw.alt.slice(0, FREEFORM_ALT_MAX) : "";
    candidate.sourceWidth = Math.max(0, Math.round(Number(raw.sourceWidth) || 0));
    candidate.sourceHeight = Math.max(0, Math.round(Number(raw.sourceHeight) || 0));
  }
  const parsed = freeformElementSchema.safeParse(candidate);
  if (!parsed.success) {
    if (elementKind === "image" && options.allowMissingAssetRef) {
      const retry = freeformImageElementSchema.safeParse({ ...candidate, assetRef: FREEFORM_ASSET_PLACEHOLDER_ID });
      return retry.success ? retry.data as FreeformElement : null;
    }
    return null;
  }
  return parsed.data as FreeformElement;
}

/**
 * 旧数据兼容：schemaVersion 缺省为 1；缺 rotation 补 0、缺 groupId 补 null、
 * zIndex 转换为数组序、缺 style 补默认值；未知 kind/未知字段转入 unknown 容器，禁止静默删除。
 */
export function normalizeFreeformDocument(value: unknown, fallbackDiagramId = ""): FreeformDocument {
  const raw = isRecord(value) ? value : {};
  const diagramId = typeof raw.diagramId === "string" && raw.diagramId.trim() ? raw.diagramId.trim() : fallbackDiagramId;
  const legacyOrder: Array<{ id: string; zIndex: number }> = [];
  const elements: FreeformElement[] = [];
  const unsupported: FreeformUnknownElement[] = [];
  const source = Array.isArray(raw.elements) ? raw.elements : [];
  source.forEach((item, index) => {
    const element = normalizeFreeformElement(item);
    if (element) {
      elements.push(element);
      if (isRecord(item) && typeof item.zIndex === "number" && Number.isFinite(item.zIndex)) {
        legacyOrder.push({ id: element.id, zIndex: item.zIndex });
      }
      return;
    }
    if (isRecord(item)) {
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `fr_legacy_${index}`;
      unsupported.push({ id, raw: item });
    }
  });
  if (legacyOrder.length) {
    const order = new Map(legacyOrder.map((entry) => [entry.id, entry.zIndex]));
    elements.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  if (Array.isArray(raw.unsupported)) {
    raw.unsupported.forEach((item, index) => {
      if (!isRecord(item)) return;
      const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : `fr_unknown_${index}`;
      if (!isRecord(item.raw)) return;
      unsupported.push({ id, raw: item.raw });
    });
  }
  const deduped = new Map<string, FreeformUnknownElement>();
  unsupported.forEach((item) => { if (!deduped.has(item.id)) deduped.set(item.id, item); });
  return {
    schemaVersion: FREEFORM_SCHEMA_VERSION,
    diagramId,
    elements,
    unsupported: [...deduped.values()],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

export function freeformDocumentFingerprint(document: FreeformDocument): string {
  return JSON.stringify({ schemaVersion: document.schemaVersion, elements: document.elements, unsupported: document.unsupported });
}

export function withElements(document: FreeformDocument, elements: FreeformElement[]): FreeformDocument {
  return { ...document, elements: elements.map((element) => ({ ...element, x: round2(element.x), y: round2(element.y), w: round2(element.w), h: round2(element.h), rotation: round2(element.rotation) })) };
}

/** 历史原型草稿（text/button/input/card/image）只读映射为自由层 legacy 子集，不自动改写历史记录。 */
export function mapLegacyPrototypeDraft(draft: PrototypeDraft): FreeformElement[] {
  const createdAt = draft.updatedAt || "";
  const mapped: FreeformElement[] = [];
  draft.screens.forEach((screen) => {
    screen.components.forEach((component) => {
      const kind: FreeformElementKind = component.kind === "text" ? "text"
        : component.kind === "image" ? "image"
          : component.kind === "card" ? "rect" : "sticky";
      const base = normalizeFreeformElement({
        id: `fr_legacy_${component.id}`,
        kind,
        x: component.x,
        y: component.y,
        w: component.w,
        h: component.h,
        rotation: 0,
        groupId: null,
        style: {
          fill: component.fill, strokeColor: component.borderColor, strokeWidth: component.borderWidth,
          borderRadius: component.borderRadius, opacity: component.opacity, textColor: component.textColor,
          fontSize: component.fontSize,
        },
        locked: Boolean(component.locked),
        hidden: Boolean(component.hidden),
        createdAt,
        updatedAt: createdAt,
        ...(kind === "rect" ? { cornerStyle: "rounded" as const } : {}),
        ...(kind === "sticky" ? { text: component.text ?? "", tone: "neutral" as const } : {}),
        ...(kind === "text" ? { text: component.text ?? "", autoHeight: true } : {}),
      }, { allowMissingAssetRef: true });
      if (base) mapped.push(base);
    });
  });
  return mapped;
}

export function applyFreeformAssetSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; object-src 'none'; script-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}

/** 真实文件头（magic number）识别，只返回白名单内类型。 */
export function freeformAssetMimeFromMagic(bytes: Uint8Array): string | null {
  const at = (offset: number, values: number[]): boolean =>
    values.every((value, index) => bytes[offset + index] === value);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** 可携带脚本 / 可执行内容的类型必须先于一切解析被拒绝。 */
export function isFreeformAssetMimeDenied(mime: string): boolean {
  return (FREEFORM_ASSET_MIME_DENYLIST as readonly string[]).includes(mime.split(";")[0].trim().toLowerCase());
}

export function isFreeformAssetMimeAllowed(mime: string): boolean {
  return (FREEFORM_ASSET_MIME_WHITELIST as readonly string[]).includes(mime.split(";")[0].trim().toLowerCase());
}

export function normalizeFreeformAssetMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function freeformAssetUrl(assetId: string): string {
  return `/api/freeform-assets/${encodeURIComponent(assetId)}`;
}