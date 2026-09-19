import { z } from "zod";
import type { PrototypeComponent, PrototypeDraft, PrototypeKind, PrototypeScreen, PrototypeStored } from "./types.js";

export const PROTOTYPE_HISTORY_LIMIT = 50;
export const PROTOTYPE_VERSION_LIMIT = 10;
export const PROTOTYPE_ZOOM_MIN = 0.25;
export const PROTOTYPE_ZOOM_MAX = 2;

const color = z.string().refine((value) => value === "transparent" || /^#[0-9a-fA-F]{6}$/.test(value), "颜色必须为 #RRGGBB 或 transparent");
const id = z.string().trim().min(1).max(200);
const imageUrl = z.string().max(2000).refine((value) => {
  if (!value) return true;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "图片地址必须为空或 HTTP(S) 绝对地址");

export const prototypeComponentSchema = z.object({
  id,
  kind: z.enum(["text", "button", "input", "card", "image"]),
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
  w: z.number().finite().min(1).max(4096),
  h: z.number().finite().min(1).max(4096),
  text: z.string().max(2000),
  textColor: color.optional(),
  fill: color.optional(),
  borderColor: color.optional(),
  borderWidth: z.number().finite().min(0).max(20).optional(),
  borderRadius: z.number().finite().min(0).max(2048).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  fontSize: z.number().finite().min(8).max(120).optional(),
  imageUrl: imageUrl.optional(),
  imageFit: z.enum(["contain", "cover"]).optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
}).strict();

export const prototypeScreenSchema = z.object({
  id,
  name: z.string().trim().min(1).max(200),
  width: z.number().int().min(100).max(4096).optional(),
  height: z.number().int().min(100).max(4096).optional(),
  background: color.optional(),
  components: z.array(prototypeComponentSchema).max(500),
}).strict().superRefine((screen, context) => {
  const ids = new Set<string>();
  screen.components.forEach((component, index) => {
    if (ids.has(component.id)) context.addIssue({ code: "custom", path: ["components", index, "id"], message: "组件 id 重复" });
    ids.add(component.id);
  });
});

export const prototypeDraftSchema = z.object({
  version: z.literal(1),
  screens: z.array(prototypeScreenSchema).min(1).max(100),
  updatedAt: z.string().max(64),
}).strict().superRefine((draft, context) => {
  const ids = new Set<string>();
  draft.screens.forEach((screen, index) => {
    if (ids.has(screen.id)) context.addIssue({ code: "custom", path: ["screens", index, "id"], message: "页面 id 重复" });
    ids.add(screen.id);
  });
});

export const prototypePayloadSchema = z.object({
  current: prototypeDraftSchema,
  versions: z.array(prototypeDraftSchema).max(10),
}).strict();

export const prototypeSaveSchema = prototypePayloadSchema.extend({
  expectedUpdatedAt: z.union([z.string().min(1).max(64).refine((value) => value.trim().length > 0, "expectedUpdatedAt 不能为空"), z.null()]),
}).strict();

export const prototypeStoredSchema = prototypePayloadSchema.extend({
  updatedAt: z.string().min(1).max(64),
}).strict();

export function prototypeStyleDefaults(kind: PrototypeKind): Required<Pick<PrototypeComponent,
  "textColor" | "fill" | "borderColor" | "borderWidth" | "borderRadius" | "opacity" | "fontSize" | "imageUrl" | "imageFit" | "hidden" | "locked">> {
  return {
    textColor: kind === "button" ? "#06131c" : kind === "input" ? "#7f9eae" : "#d8edf8",
    fill: kind === "text" ? "transparent" : kind === "button" ? "#68c7f4" : kind === "input" ? "#101f2a" : kind === "card" ? "#1b2d3a" : "#152d3a",
    borderColor: kind === "text" ? "transparent" : kind === "button" ? "#55baf2" : "#507287",
    borderWidth: kind === "text" ? 0 : 1,
    borderRadius: 7,
    opacity: 1,
    fontSize: kind === "text" ? 18 : 14,
    imageUrl: "",
    imageFit: "contain",
    hidden: false,
    locked: false,
  };
}

export function normalizePrototypeComponent(component: PrototypeComponent): PrototypeComponent {
  return { ...prototypeStyleDefaults(component.kind), ...component };
}

export function normalizePrototypeScreen(screen: PrototypeScreen): PrototypeScreen {
  return {
    ...screen,
    width: screen.width ?? 640,
    height: screen.height ?? 480,
    background: screen.background ?? "#0f202b",
    components: screen.components.map(normalizePrototypeComponent),
  };
}

export function normalizePrototypeDraft(value: unknown): PrototypeDraft {
  const parsed = prototypeDraftSchema.parse(value) as PrototypeDraft;
  return { ...parsed, screens: parsed.screens.map(normalizePrototypeScreen) };
}

export function normalizePrototypePayload(value: unknown): Omit<PrototypeStored, "updatedAt"> {
  const parsed = prototypePayloadSchema.parse(value);
  return {
    current: normalizePrototypeDraft(parsed.current),
    versions: parsed.versions.map(normalizePrototypeDraft),
  };
}

export function normalizePrototypeStored(value: unknown): PrototypeStored {
  const parsed = prototypeStoredSchema.parse(value);
  return { ...normalizePrototypePayload({ current: parsed.current, versions: parsed.versions }), updatedAt: parsed.updatedAt };
}

export function prototypeFingerprint(draft: PrototypeDraft): string {
  return JSON.stringify({ version: draft.version, screens: draft.screens });
}

export function clonePrototypeDraft(draft: PrototypeDraft): PrototypeDraft {
  return structuredClone(draft);
}

export function isEditablePrototypeComponent(component: PrototypeComponent): boolean {
  return !component.hidden && !component.locked;
}

export function movePrototypeComponents(draft: PrototypeDraft, screenId: string, ids: Iterable<string>, dx: number, dy: number): PrototypeDraft {
  const selected = new Set(ids);
  return {
    ...draft,
    screens: draft.screens.map((screen) => screen.id === screenId ? {
      ...screen,
      components: screen.components.map((component) => selected.has(component.id) && isEditablePrototypeComponent(component)
        ? {
          ...component,
          x: Math.max(-100000, Math.min(100000, component.x + dx)),
          y: Math.max(-100000, Math.min(100000, component.y + dy)),
        }
        : component),
    } : screen),
  };
}

export type PrototypeAlignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

export function alignPrototypeComponents(draft: PrototypeDraft, screenId: string, ids: Iterable<string>, alignment: PrototypeAlignment): PrototypeDraft {
  const selected = new Set(ids);
  const screen = draft.screens.find((item) => item.id === screenId);
  const items = screen?.components.filter((component) => selected.has(component.id) && isEditablePrototypeComponent(component)) ?? [];
  if (items.length < 2) return draft;
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.w));
  const bottom = Math.max(...items.map((item) => item.y + item.h));
  return {
    ...draft,
    screens: draft.screens.map((item) => item.id === screenId ? {
      ...item,
      components: item.components.map((component) => {
        if (!selected.has(component.id) || !isEditablePrototypeComponent(component)) return component;
        if (alignment === "left") return { ...component, x: left };
        if (alignment === "hcenter") return { ...component, x: left + (right - left - component.w) / 2 };
        if (alignment === "right") return { ...component, x: right - component.w };
        if (alignment === "top") return { ...component, y: top };
        if (alignment === "vcenter") return { ...component, y: top + (bottom - top - component.h) / 2 };
        return { ...component, y: bottom - component.h };
      }),
    } : item),
  };
}
