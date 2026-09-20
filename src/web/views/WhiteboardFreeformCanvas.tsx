import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Circle,
  Download,
  Eye,
  EyeOff,
  Hand,
  Image as ImageIcon,
  Layers,
  Lock,
  MousePointer2,
  Move,
  PenTool,
  Redo2,
  RotateCw,
  Save,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api, FreeformConflictError } from "../api";
import {
  buildFreeformCommand,
  buildFreeformExportJson,
  buildFreeformSvg,
  copyFreeformElements,
  createFreeformHistory,
  createFreeformMachine,
  deleteFreeformElements,
  duplicateFreeformElements,
  editableFreeformElement,
  expandFreeformSelection,
  freeformDocumentFingerprint,
  freeformElementHitTest,
  freeformKeyboardNudge,
  freeformMachine,
  freeformMarqueeHits,
  freeformSelectAllIds,
  freeformSelectionBounds,
  freeformStyleDefaults,
  freeformToolCreatesKind,
  freeformToolForShortcut,
  groupFreeformElements,
  mapLegacyPrototypeDraft,
  moveFreeformElements,
  newFreeformElementId,
  normalizeFreeformDocument,
  normalizeFreeformRect,
  pasteFreeformClipboard,
  pushFreeformCommand,
  redoFreeformCommand,
  reorderFreeformElements,
  resizeFreeformElements,
  rotateFreeformElements,
  round2,
  setFreeformRotation,
  undoFreeformCommand,
  ungroupFreeformElements,
  updateFreeformElement,
  withElements,
  FREEFORM_ASSET_PLACEHOLDER_ID,
  FREEFORM_MAX_SIZE,
  FREEFORM_MIN_SIZE,
  FREEFORM_PNG_SCALE,
  FREEFORM_SCHEMA_VERSION,
  FREEFORM_TEXT_MAX,
  FREEFORM_TOOLS,
  FREEFORM_ZOOM_MAX,
  FREEFORM_ZOOM_MIN,
  type FreeformClipboard,
  type FreeformCommandType,
  type FreeformHistory,
  type FreeformLayerAction,
  type FreeformPoint,
  type FreeformRect,
  type FreeformResizeHandle,
  type FreeformTool,
} from "../../shared/freeform";
import type { FreeformDocument, FreeformElement, FreeformElementKind } from "../../shared/types";

export const FREEFORM_KIND_LABELS: Record<FreeformElementKind, string> = {
  text: "文本", sticky: "便签", rect: "矩形", ellipse: "椭圆", arrow: "箭头", ink: "笔迹", image: "图片引用",
};

const TOOL_LABELS: Record<FreeformTool, string> = {
  select: "选择", text: "文本", sticky: "便签", rect: "矩形", ellipse: "椭圆",
  arrow: "箭头", ink: "笔迹", imageRef: "图片引用", pan: "平移",
};

const TOOL_SHORTCUTS: Record<FreeformTool, string> = {
  select: "V", text: "T", sticky: "S", rect: "R", ellipse: "O", arrow: "A", ink: "P", imageRef: "I", pan: "Space",
};

const TOOL_ICONS: Record<FreeformTool, typeof MousePointer2> = {
  select: MousePointer2, text: Type, sticky: StickyNote, rect: Square, ellipse: Circle,
  arrow: ArrowUpRight, ink: PenTool, imageRef: ImageIcon, pan: Hand,
};

const COMMAND_LABELS: Record<FreeformCommandType, string> = {
  create: "创建", move: "移动", resize: "缩放", rotate: "旋转", style: "样式编辑",
  text: "文本编辑", group: "组合", ungroup: "取消组合", layer: "层级调整", delete: "删除",
  paste: "粘贴", duplicate: "复制",
};

const RESIZE_HANDLES: FreeformResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const RESIZE_LABELS: Record<FreeformResizeHandle, string> = {
  nw: "左上角缩放", n: "上边缩放", ne: "右上角缩放", e: "右边缩放",
  se: "右下角缩放", s: "下边缩放", sw: "左下角缩放", w: "左边缩放",
};

const DEFAULT_CREATE_SIZE: Record<FreeformElementKind, { w: number; h: number }> = {
  text: { w: 180, h: 36 }, sticky: { w: 180, h: 120 }, rect: { w: 160, h: 100 },
  ellipse: { w: 140, h: 140 }, arrow: { w: 140, h: 1 }, ink: { w: 120, h: 120 }, image: { w: 220, h: 160 },
};

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const STICKY_TONES = ["neutral", "info", "warn", "success"] as const;

export interface FreeformViewport { zoom: number; offsetX: number; offsetY: number }
export interface FreeformDeliveryNodeRef { id: string; label: string }

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
}

function reducedMotionActive(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function downloadBlob(filename: string, blob: Blob): void {
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch {
    /* 浏览器不支持对象 URL 时静默降级，导出内容本身仍已生成 */
  }
}

function describeElement(element: FreeformElement): string {
  const kind = FREEFORM_KIND_LABELS[element.kind];
  const text = element.kind === "text" || element.kind === "sticky" ? element.text?.trim() ?? "" : element.kind === "image" ? element.alt?.trim() ?? "" : "";
  const summary = text ? `：${text.slice(0, 24)}` : "";
  const flags = [element.locked ? "已锁定" : "", element.hidden ? "已隐藏" : "", element.groupId ? "属于组合" : ""].filter(Boolean);
  return `${kind}${summary}${flags.length ? `（${flags.join("、")}）` : ""}`;
}

function CommitField(props: {
  label: string;
  value: string | number;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: string) => string | void;
}): ReactElement {
  const [value, setValue] = useState(String(props.value));
  const [error, setError] = useState("");
  const skipBlur = useRef(false);
  useEffect(() => { setValue(String(props.value)); setError(""); }, [props.value]);
  const commit = () => {
    if (props.disabled) return;
    const result = props.type === "number" && value.trim() === "" ? "请输入数值" : props.onCommit(value) ?? "";
    const nextError = typeof result === "string" ? result : "";
    setError(nextError);
    if (nextError) setValue(String(props.value));
  };
  return <label className={error ? "has-error" : ""}>
    {props.label}
    <input
      type={props.type ?? "text"}
      min={props.min}
      max={props.max}
      step={props.step}
      value={value}
      disabled={props.disabled}
      aria-invalid={Boolean(error)}
      title={error}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } commit(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); skipBlur.current = true; setValue(String(props.value)); setError(""); event.currentTarget.blur(); }
      }}
    />
    {error ? <small className="freeform-field-error">{error}</small> : null}
  </label>;
}

// ---------- 文档状态归属方：加载 / 命令 / 撤销重做 / dirty / 保存调度 ----------

export interface FreeformConflictInfo { message: string; serverUpdatedAt: string }

export interface FreeformDocumentController {
  document: FreeformDocument;
  loadStatus: "loading" | "ready" | "error";
  history: FreeformHistory;
  dirty: boolean;
  saving: boolean;
  saveUnknown: boolean;
  conflict: FreeformConflictInfo | null;
  saveError: string;
  loadError: string;
  notice: string;
  localBackup: FreeformDocument | null;
  canUndo: boolean;
  canRedo: boolean;
  commit: (type: FreeformCommandType, update: (document: FreeformDocument) => FreeformDocument) => boolean;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  saveAsCopy: () => void;
  forceOverwrite: () => Promise<void>;
  replayLocalBackup: () => void;
  dismissBackup: () => void;
  announce: (message: string) => void;
}

export function useFreeformDocument(diagramId: string): FreeformDocumentController {
  const emptyDocument = useMemo<FreeformDocument>(() => ({
    schemaVersion: FREEFORM_SCHEMA_VERSION, diagramId, elements: [], unsupported: [], updatedAt: "",
  }), [diagramId]);

  const generationRef = useRef(0);
  const documentRef = useRef<FreeformDocument>(emptyDocument);
  const historyRef = useRef<FreeformHistory>(createFreeformHistory());
  const savedFingerprintRef = useRef("");
  const serverUpdatedAtRef = useRef<string | null>(null);
  const conflictRef = useRef<FreeformConflictInfo | null>(null);
  const savingRef = useRef(false);
  const loadStatusRef = useRef<"loading" | "ready" | "error">("loading");

  const [document, setDocumentState] = useState<FreeformDocument>(emptyDocument);
  const [history, setHistory] = useState<FreeformHistory>(() => createFreeformHistory());
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [saving, setSavingState] = useState(false);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [conflict, setConflict] = useState<FreeformConflictInfo | null>(null);
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [localBackup, setLocalBackup] = useState<FreeformDocument | null>(null);

  const setDocument = useCallback((next: FreeformDocument) => {
    documentRef.current = next;
    setDocumentState(next);
  }, []);
  const setHistoryState = useCallback((next: FreeformHistory) => {
    historyRef.current = next;
    setHistory(next);
  }, []);
  const setSaving = useCallback((next: boolean) => {
    savingRef.current = next;
    setSavingState(next);
  }, []);
  const setLoadStatusBoth = useCallback((next: "loading" | "ready" | "error") => {
    loadStatusRef.current = next;
    setLoadStatus(next);
  }, []);

  const announce = useCallback((message: string) => setNotice(message), []);

  const applyRemote = useCallback((remote: FreeformDocument | null) => {
    const next = remote ? normalizeFreeformDocument(remote, diagramId) : emptyDocument;
    setDocument(next);
    const fingerprint = remote ? freeformDocumentFingerprint(next) : "";
    savedFingerprintRef.current = fingerprint;
    setSavedFingerprint(fingerprint);
    serverUpdatedAtRef.current = remote?.updatedAt ?? null;
    setHistoryState(createFreeformHistory());
  }, [diagramId, emptyDocument, setDocument, setHistoryState]);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoadStatusBoth("loading");
    setSaving(false);
    setSaveError("");
    setLoadError("");
    setSaveUnknown(false);
    setConflict(null);
    conflictRef.current = null;
    setLocalBackup(null);
    try {
      const remote = await api.getFreeformDocument(diagramId);
      if (generation !== generationRef.current) return;
      applyRemote(remote);
      setLoadStatusBoth("ready");
    } catch (error) {
      if (generation !== generationRef.current) return;
      applyRemote(null);
      setLoadError(error instanceof Error ? `自由层加载失败：${error.message}` : "自由层加载失败");
      setLoadStatusBoth("error");
    }
  }, [applyRemote, diagramId, setLoadStatusBoth, setSaving]);

  useEffect(() => {
    void load();
    return () => { generationRef.current += 1; };
  }, [load]);

  const commit = useCallback((type: FreeformCommandType, update: (document: FreeformDocument) => FreeformDocument): boolean => {
    if (loadStatusRef.current !== "ready") return false;
    const before = documentRef.current;
    const updated = update(before);
    const after: FreeformDocument = {
      ...updated,
      schemaVersion: FREEFORM_SCHEMA_VERSION,
      diagramId,
      unsupported: updated.unsupported ?? before.unsupported,
    };
    const command = buildFreeformCommand(type, before, after);
    if (!command) return false;
    setDocument(after);
    setHistoryState(pushFreeformCommand(historyRef.current, command));
    setNotice(`已${COMMAND_LABELS[type]}（可撤销）`);
    return true;
  }, [diagramId, setDocument, setHistoryState]);

  const undo = useCallback(() => {
    if (loadStatusRef.current !== "ready") return;
    const result = undoFreeformCommand(historyRef.current, documentRef.current);
    if (!result) { setNotice("没有可撤销的操作"); return; }
    setHistoryState(result.history);
    setDocument(result.document);
    setNotice(`已撤销${COMMAND_LABELS[result.command.type]}`);
  }, [setDocument, setHistoryState]);

  const redo = useCallback(() => {
    if (loadStatusRef.current !== "ready") return;
    const result = redoFreeformCommand(historyRef.current, documentRef.current);
    if (!result) { setNotice("没有可重做的操作"); return; }
    setHistoryState(result.history);
    setDocument(result.document);
    setNotice(`已重做${COMMAND_LABELS[result.command.type]}`);
  }, [setDocument, setHistoryState]);

  const save = useCallback(async (expectedOverride?: string | null) => {
    if (loadStatusRef.current !== "ready" || savingRef.current) return;
    const generation = generationRef.current;
    const snapshot = documentRef.current;
    const fingerprint = freeformDocumentFingerprint(snapshot);
    setSaving(true);
    setSaveError("");
    setConflict(null);
    conflictRef.current = null;
    try {
      const persisted = await api.saveFreeformDocument(diagramId, {
        schemaVersion: FREEFORM_SCHEMA_VERSION,
        elements: snapshot.elements,
        unsupported: snapshot.unsupported,
        expectedUpdatedAt: expectedOverride !== undefined ? expectedOverride : serverUpdatedAtRef.current,
      });
      if (generation !== generationRef.current) return;
      serverUpdatedAtRef.current = persisted.updatedAt;
      savedFingerprintRef.current = fingerprint;
      setSavedFingerprint(fingerprint);
      setSaveUnknown(false);
      setDocument({ ...documentRef.current, updatedAt: persisted.updatedAt });
      setNotice(freeformDocumentFingerprint(documentRef.current) === fingerprint
        ? "自由层已保存"
        : "较早编辑已保存；仍有新修改待保存");
    } catch (error) {
      if (generation !== generationRef.current) return;
      if (error instanceof FreeformConflictError) {
        const info = { message: error.message, serverUpdatedAt: error.serverUpdatedAt };
        conflictRef.current = info;
        setConflict(info);
        setSaveError(`服务器自由层文档已变化（服务端 updatedAt：${error.serverUpdatedAt || "未知"}）；本地修改已完整保留`);
      } else {
        const message = error instanceof Error ? error.message : "自由层保存失败";
        setSaveUnknown(true);
        setSaveError(`保存结果未知：${message}。重新加载服务器核对后再保存。`);
      }
    } finally {
      if (generation === generationRef.current) setSaving(false);
    }
  }, [diagramId, setDocument, setSaving]);

  const reload = useCallback(async () => {
    if (savingRef.current) return;
    const backup = documentRef.current;
    const dirtyBefore = freeformDocumentFingerprint(backup) !== savedFingerprintRef.current;
    const generation = ++generationRef.current;
    try {
      const remote = await api.getFreeformDocument(diagramId);
      if (generation !== generationRef.current) return;
      applyRemote(remote);
      setLocalBackup(dirtyBefore ? backup : null);
      setConflict(null);
      conflictRef.current = null;
      setSaveUnknown(false);
      setSaveError("");
      setLoadError("");
      setLoadStatusBoth("ready");
      setNotice("已以服务端为准重载；本地未保存变更保留为可重放副本");
    } catch (error) {
      if (generation !== generationRef.current) return;
      setSaveError(error instanceof Error ? `重新加载失败：${error.message}` : "重新加载失败");
    }
  }, [applyRemote, diagramId, setLoadStatusBoth]);

  const saveAsCopy = useCallback(() => {
    downloadBlob(`freeform-${diagramId}-copy-${Date.now()}.json`, new Blob(
      [buildFreeformExportJson({ ...documentRef.current, diagramId: `${diagramId}-copy` })],
      { type: "application/json" },
    ));
    setNotice("已另存为自由层副本（新文档，不覆盖服务端）");
  }, [diagramId]);

  const forceOverwrite = useCallback(async () => {
    const info = conflictRef.current;
    if (!info) return;
    if (!window.confirm("强制覆盖会丢弃服务端上的更新版本，并会记录审计事件。确认继续？")) return;
    if (!window.confirm("二次确认：确定用本地版本覆盖服务端自由层文档？")) return;
    await save(info.serverUpdatedAt);
  }, [save]);

  const replayLocalBackup = useCallback(() => {
    const backup = localBackup;
    if (!backup) return;
    setLocalBackup(null);
    commit("paste", () => backup);
    setNotice("已重放本地副本到当前文档");
  }, [commit, localBackup]);

  const dismissBackup = useCallback(() => setLocalBackup(null), []);

  return {
    document,
    loadStatus,
    history,
    dirty: freeformDocumentFingerprint(document) !== savedFingerprint,
    saving,
    saveUnknown,
    conflict,
    saveError,
    loadError,
    notice,
    localBackup,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    commit,
    undo,
    redo,
    save: () => save(),
    reload,
    saveAsCopy,
    forceOverwrite,
    replayLocalBackup,
    dismissBackup,
    announce,
  };
}

// ---------- 工具栏（role=toolbar，方向键切换焦点，单键快捷键） ----------

export function FreeformToolbar(props: {
  tool: FreeformTool;
  disabled: boolean;
  onTool: (tool: FreeformTool) => void;
  onPickImage: () => void;
}): ReactElement {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const focusByOffset = (index: number, offset: number) => {
    const total = FREEFORM_TOOLS.length;
    buttonsRef.current[(index + offset + total) % total]?.focus();
  };
  return <div
    className="freeform-toolbar"
    role="toolbar"
    aria-label="自由层工具"
    aria-orientation="vertical"
    onKeyDown={(event) => {
      const current = buttonsRef.current.findIndex((button) => button === document.activeElement);
      if (current < 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); focusByOffset(current, 1); }
      else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); focusByOffset(current, -1); }
    }}
  >
    {FREEFORM_TOOLS.map((tool, index) => {
      const Icon = TOOL_ICONS[tool];
      return <button
        key={tool}
        ref={(node) => { buttonsRef.current[index] = node; }}
        type="button"
        className={`freeform-tool ${props.tool === tool ? "active" : ""}`}
        aria-pressed={props.tool === tool}
        aria-label={`${TOOL_LABELS[tool]}工具（快捷键 ${TOOL_SHORTCUTS[tool]}）`}
        aria-keyshortcuts={tool === "pan" ? "Space" : TOOL_SHORTCUTS[tool]}
        title={`${TOOL_LABELS[tool]}（${TOOL_SHORTCUTS[tool]}）`}
        disabled={props.disabled}
        onClick={() => props.onTool(tool)}
      >
        <Icon size={15} /><span>{TOOL_LABELS[tool]}</span>
      </button>;
    })}
    <button type="button" className="freeform-tool" aria-label="上传受控图片资源" disabled={props.disabled} onClick={props.onPickImage}>
      <Download size={15} /><span>上传图片</span>
    </button>
  </div>;
}

// ---------- 纯渲染层（输入 elements + selection + viewport，输出 SVG，无副作用） ----------

const ARROW_MARKER_ID = "freeform-arrow-marker";

function elementShape(element: FreeformElement, assetUrl: (assetRef: string) => string): ReactElement {
  const style = element.style ?? {};
  const stroke = style.strokeColor ?? "#507287";
  const fill = style.fill ?? "transparent";
  const center = `translate(${round2(element.w / 2)} ${round2(element.h / 2)}) rotate(${round2(element.rotation)}) translate(${round2(-element.w / 2)} ${round2(-element.h / 2)})`;
  const common = { transform: center, opacity: style.opacity ?? 1 };
  if (element.kind === "ellipse") {
    return <ellipse {...common} cx={round2(element.w / 2)} cy={round2(element.h / 2)} rx={round2(element.w / 2)} ry={round2(element.h / 2)}
      fill={fill} stroke={stroke} strokeWidth={style.strokeWidth ?? 1} />;
  }
  if (element.kind === "ink") {
    const points = (element.points ?? []).map((point) => `${round2(point.x * element.w)},${round2(point.y * element.h)}`).join(" ");
    return <polyline {...common} points={points} fill="none" stroke={stroke}
      strokeWidth={element.strokeWidth ?? style.strokeWidth ?? 2} strokeLinecap="round" />;
  }
  if (element.kind === "arrow") {
    const dash = element.lineStyle === "dashed" ? "8 6" : element.lineStyle === "dotted" ? "2 5" : undefined;
    return <line {...common}
      x1={round2(element.w / 2)} y1={round2(element.h / 2)}
      x2={round2(element.w / 2 + (element.dx ?? 0))} y2={round2(element.h / 2 + (element.dy ?? 0))}
      stroke={stroke} strokeWidth={style.strokeWidth ?? 2} strokeDasharray={dash}
      markerEnd={element.arrowEnd === "triangle" ? `url(#${ARROW_MARKER_ID})` : undefined}
      markerStart={element.arrowStart === "triangle" ? `url(#${ARROW_MARKER_ID})` : undefined} />;
  }
  // 占位资源 id 不是真实受控资源：只画占位图并提示，绝不生成任何资源请求。
  const url = element.kind === "image" && element.assetRef && element.assetRef !== FREEFORM_ASSET_PLACEHOLDER_ID
    ? assetUrl(element.assetRef) : "";
  const box = <rect {...common} width={round2(element.w)} height={round2(element.h)}
    rx={round2(element.kind === "rect" && element.cornerStyle === "sharp" ? 0 : style.borderRadius ?? 0)}
    fill={element.kind === "sticky"
      ? ({ neutral: "#4a4326", info: "#1d3a4d", warn: "#4d3a1d", success: "#1d4a2c" } as const)[element.tone ?? "neutral"]
      : fill}
    stroke={stroke} strokeWidth={style.strokeWidth ?? (element.kind === "text" ? 0 : 1)} />;
  if (element.kind === "image") {
    if (!url) {
      return <>
        {box}
        <g {...common}>
          <rect x={4} y={4} width={Math.max(1, round2(element.w - 8))} height={Math.max(1, round2(element.h - 8))}
            fill="none" stroke="#7d97a8" strokeWidth={1} strokeDasharray="4 4" />
          <text x={round2(element.w / 2)} y={round2(element.h / 2)} fill="#9fb6c4" fontSize={12} textAnchor="middle" dominantBaseline="middle">
            缺少受控图片资源
          </text>
        </g>
      </>;
    }
    return <>
      {box}
      <image {...common} width={round2(element.w)} height={round2(element.h)} href={url}
        preserveAspectRatio={element.imageFit === "cover" ? "xMidYMid slice" : "xMidYMid meet"} />
    </>;
  }
  const text = element.kind === "text" || element.kind === "sticky" ? element.text : "";
  if (!text) return box;
  const textX = style.align === "left" ? 6 : style.align === "right" ? round2(element.w - 6) : round2(element.w / 2);
  const anchor = style.align === "left" ? "start" : style.align === "right" ? "end" : "middle";
  const fontSize = style.fontSize ?? 14;
  return <>
    {box}
    <g {...common}>
      <text x={textX} y={round2(element.h / 2)} fill={style.textColor ?? "#d8edf8"} fontSize={fontSize}
        fontWeight={style.fontWeight ?? "normal"} textAnchor={anchor} dominantBaseline="middle">
        {text.split("\n").slice(0, 24).map((line, index) => (
          <tspan key={index} x={textX} dy={index === 0 ? 0 : fontSize * 1.25}>{line}</tspan>
        ))}
      </text>
    </g>
  </>;
}

export function FreeformElementLayer(props: {
  elements: FreeformElement[];
  legacyElements?: FreeformElement[];
  selection: string[];
  viewport: FreeformViewport;
  width: number;
  height: number;
  assetUrl: (assetRef: string) => string;
  editingId: string | null;
  interactive: boolean;
  onFocusElement: (id: string) => void;
}): ReactElement {
  const selected = new Set(props.selection);
  const { zoom, offsetX, offsetY } = props.viewport;
  return <svg className="freeform-canvas" width={props.width} height={props.height} aria-label="自由创作画布">
    <defs>
      <marker id={ARROW_MARKER_ID} markerWidth={8} markerHeight={8} refX={6} refY={3} orient="auto">
        <path d="M0,0 L6,3 L0,6 z" fill="#507287" />
      </marker>
    </defs>
    <g transform={`translate(${offsetX} ${offsetY}) scale(${zoom})`}>
      {props.elements.filter((element) => !element.hidden).map((element) => <g
        key={element.id}
        className={`freeform-element freeform-element-${element.kind} ${selected.has(element.id) ? "selected" : ""} ${element.locked ? "locked" : ""}`}
        data-element-id={element.id}
        data-element-kind={element.kind}
        data-editing={props.editingId === element.id ? "true" : "false"}
        role="button"
        tabIndex={props.interactive ? 0 : -1}
        aria-label={describeElement(element)}
        aria-pressed={selected.has(element.id)}
        style={{ pointerEvents: "none" }}
        onFocus={() => props.onFocusElement(element.id)}
      >
        {elementShape(element, props.assetUrl)}
      </g>)}
      {(props.legacyElements ?? []).map((element) => <g
        key={element.id}
        className="freeform-element freeform-element-legacy"
        data-legacy="true"
        aria-hidden="true"
        opacity={0.55}
        style={{ pointerEvents: "none" }}
      >
        {elementShape(element, props.assetUrl)}
      </g>)}
      {props.selection.length ? props.elements.filter((element) => selected.has(element.id)).map((element) => <g
        key={`outline-${element.id}`}
        className="freeform-selection-outline"
        aria-hidden="true"
        style={{ pointerEvents: "none" }}
      >
        <rect x={round2(element.x)} y={round2(element.y)} width={round2(element.w)} height={round2(element.h)}
          transform={`rotate(${round2(element.rotation)} ${round2(element.x + element.w / 2)} ${round2(element.y + element.h / 2)})`}
          fill="none" stroke="#67d0ff" strokeWidth={1.5} strokeDasharray="6 4" />
      </g>) : null}
    </g>
  </svg>;
}

// ---------- 图层面板（role=listbox，交付节点与自由元素分区，禁止混排） ----------

export function FreeformLayerPanel(props: {
  document: FreeformDocument;
  selection: string[];
  deliveryNodes: FreeformDeliveryNodeRef[];
  disabled: boolean;
  onSelect: (ids: string[], additive: boolean) => void;
  onToggleHidden: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onReorder: (action: FreeformLayerAction) => void;
  onDeleteUnsupported: (id: string) => void;
}): ReactElement {
  const elements = props.document.elements;
  const unsupported = props.document.unsupported;
  const selected = new Set(props.selection);
  return <div className="freeform-layer-panel" role="listbox" aria-multiselectable="true" aria-label="图层">
    <div className="freeform-layer-group" role="group" aria-label="交付节点" data-section="delivery">
      <div className="freeform-panel-heading"><span>交付节点</span><small>只读，不进入自由层</small></div>
      {props.deliveryNodes.length === 0 ? <div className="freeform-layer-empty">本画布暂无交付节点</div> : null}
      {props.deliveryNodes.map((node) => <div
        key={node.id}
        className="freeform-layer-item is-delivery"
        role="option"
        aria-selected={false}
        aria-disabled="true"
        data-delivery-node-id={node.id}
        title="交付节点由画布结构管理，自由层不可修改"
      >
        <span className="freeform-layer-badge">交付</span>
        <span className="freeform-layer-name">{node.label || node.id}</span>
        <code>{node.id}</code>
      </div>)}
    </div>
    <div className="freeform-layer-group" role="group" aria-label="自由元素" data-section="freeform">
      <div className="freeform-panel-heading"><span>自由元素</span><small>顶层在前 · {elements.length} 项</small></div>
      {elements.length === 0 ? <div className="freeform-layer-empty">从左侧工具开始创作</div> : null}
      {[...elements].reverse().map((element) => <div
        key={element.id}
        className={`freeform-layer-item ${selected.has(element.id) ? "active" : ""} ${element.hidden ? "is-hidden" : ""} ${element.locked ? "is-locked" : ""}`}
        role="option"
        aria-selected={selected.has(element.id)}
        aria-label={describeElement(element)}
        data-element-id={element.id}
        onClick={(event) => props.onSelect([element.id], event.shiftKey)}
      >
        <span className={`freeform-layer-badge kind-${element.kind}`}>{FREEFORM_KIND_LABELS[element.kind]}</span>
        <span className="freeform-layer-name">
          {element.kind === "text" || element.kind === "sticky" ? (element.text || "未命名")
            : element.kind === "image" ? (element.alt || "图片引用") : element.id}
        </span>
        <span className="freeform-layer-actions">
          <button type="button" aria-label={`${element.hidden ? "显示" : "隐藏"}图层 ${element.id}`} disabled={props.disabled}
            onClick={(event) => { event.stopPropagation(); props.onToggleHidden(element.id); }}>
            {element.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button type="button" aria-label={`${element.locked ? "解锁" : "锁定"}图层 ${element.id}`} disabled={props.disabled}
            onClick={(event) => { event.stopPropagation(); props.onToggleLocked(element.id); }}>
            {element.locked ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button type="button" aria-label={`上移一层 ${element.id}`} disabled={props.disabled}
            onClick={(event) => { event.stopPropagation(); props.onReorder("forward"); }}><ChevronUp size={13} /></button>
          <button type="button" aria-label={`下移一层 ${element.id}`} disabled={props.disabled}
            onClick={(event) => { event.stopPropagation(); props.onReorder("backward"); }}><ChevronDown size={13} /></button>
        </span>
      </div>)}
    </div>
    {unsupported.length ? <div className="freeform-layer-group" role="group" aria-label="不支持的元素" data-section="unsupported">
      <div className="freeform-panel-heading"><span>不支持的元素</span><small>保留原始 JSON，不会被静默删除</small></div>
      {unsupported.map((item) => <div key={item.id} className="freeform-layer-item is-unsupported" role="option" aria-selected={false} data-unsupported-id={item.id}>
        <span className="freeform-layer-badge">未知</span>
        <span className="freeform-layer-name">{item.id}</span>
        <span className="freeform-layer-actions">
          <button type="button" aria-label={`删除不支持的元素 ${item.id}`} disabled={props.disabled}
            onClick={(event) => { event.stopPropagation(); props.onDeleteUnsupported(item.id); }}><Trash2 size={13} /></button>
        </span>
      </div>)}
    </div> : null}
  </div>;
}

// ---------- 属性面板（几何、变换、样式、受控图片引用、alt 文本） ----------

export function FreeformInspector(props: {
  selection: string[];
  document: FreeformDocument;
  disabled: boolean;
  assetUrl: (assetRef: string) => string;
  onChange: (id: string, patch: Partial<FreeformElement>) => void;
  onNumeric: (key: "x" | "y" | "w" | "h", value: number) => string | void;
  onRotation: (value: number) => string | void;
  onToggleLocked: () => void;
  onToggleHidden: () => void;
  onGroup: () => void;
  onUngroup: () => void;
}): ReactElement {
  const selected = props.selection
    .map((id) => props.document.elements.find((element) => element.id === id))
    .filter((element): element is FreeformElement => Boolean(element));
  const single = selected.length === 1 ? selected[0] : null;
  const groupIds = new Set(selected.map((element) => element.groupId).filter(Boolean));
  if (!selected.length) {
    return <aside className="freeform-inspector" aria-label="属性">
      <div className="freeform-panel-heading"><span>属性</span><small>未选择</small></div>
      <div className="freeform-inspector-empty">
        选中元素后可精确编辑几何、旋转与样式；缩放与旋转都能只通过数值与键盘完成。
      </div>
    </aside>;
  }
  return <aside className="freeform-inspector" aria-label="属性">
    <div className="freeform-panel-heading">
      <span>属性</span>
      <small>{single ? FREEFORM_KIND_LABELS[single.kind] : `${selected.length} 项`}</small>
    </div>
    {single ? <>
      <div className="freeform-field-grid">
        {(["x", "y", "w", "h"] as const).map((key) => <CommitField
          key={key}
          label={key.toUpperCase()}
          type="number"
          value={single[key]}
          min={key === "w" || key === "h" ? FREEFORM_MIN_SIZE : -100000}
          max={key === "w" || key === "h" ? FREEFORM_MAX_SIZE : 100000}
          disabled={props.disabled}
          onCommit={(value) => props.onNumeric(key, Number(value))}
        />)}
        <CommitField label="旋转°" type="number" value={single.rotation} min={-360} max={360} disabled={props.disabled}
          onCommit={(value) => props.onRotation(Number(value))} />
      </div>
      {single.kind === "text" || single.kind === "sticky" ? <label>文本
        <textarea
          className="freeform-inspector-text"
          value={single.text}
          disabled={props.disabled}
          maxLength={FREEFORM_TEXT_MAX}
          onChange={(event) => props.onChange(single.id, { text: event.target.value })}
        />
      </label> : null}
      {single.kind === "sticky" ? <label>便签语义
        <select value={single.tone ?? "neutral"} disabled={props.disabled}
          onChange={(event) => props.onChange(single.id, { tone: event.target.value as (typeof STICKY_TONES)[number] })}>
          <option value="neutral">中性</option><option value="info">信息</option>
          <option value="warn">警示</option><option value="success">完成</option>
        </select>
      </label> : null}
      {single.kind === "rect" ? <label>直角样式
        <select value={single.cornerStyle ?? "rounded"} disabled={props.disabled}
          onChange={(event) => props.onChange(single.id, { cornerStyle: event.target.value as "sharp" | "rounded" })}>
          <option value="rounded">圆角</option><option value="sharp">直角</option>
        </select>
      </label> : null}
      {single.kind === "arrow" ? <div className="freeform-field-grid">
        <CommitField label="DX" type="number" value={single.dx ?? 0} min={-FREEFORM_MAX_SIZE} max={FREEFORM_MAX_SIZE} disabled={props.disabled}
          onCommit={(value) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return "请输入数值";
            props.onChange(single.id, { dx: number });
          }} />
        <CommitField label="DY" type="number" value={single.dy ?? 0} min={-FREEFORM_MAX_SIZE} max={FREEFORM_MAX_SIZE} disabled={props.disabled}
          onCommit={(value) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return "请输入数值";
            props.onChange(single.id, { dy: number });
          }} />
        <label>线型<select value={single.lineStyle ?? "solid"} disabled={props.disabled}
          onChange={(event) => props.onChange(single.id, { lineStyle: event.target.value as "solid" | "dashed" | "dotted" })}>
          <option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option>
        </select></label>
      </div> : null}
      {single.kind === "image" ? <>
        <CommitField label="受控资源 assetRef" value={single.assetRef ?? ""} disabled={props.disabled} onCommit={(value) => {
          const next = value.trim();
          if (!next) { props.onChange(single.id, { assetRef: FREEFORM_ASSET_PLACEHOLDER_ID }); return; }
          if (!/^fa_[A-Za-z0-9_-]{1,160}$/.test(next)) return "只接受受控资源 id（fa_ 前缀），禁止 URL / data: / blob:";
          props.onChange(single.id, { assetRef: next });
        }} />
        <CommitField label="替代文本 alt" value={single.alt ?? ""} disabled={props.disabled} onCommit={(value) => {
          if (value.length > 500) return "最多 500 字";
          props.onChange(single.id, { alt: value });
        }} />
        <label>图片适应<select value={single.imageFit ?? "contain"} disabled={props.disabled}
          onChange={(event) => props.onChange(single.id, { imageFit: event.target.value as "contain" | "cover" })}>
          <option value="contain">完整显示</option><option value="cover">裁切铺满</option>
        </select></label>
        {single.assetRef && single.assetRef !== FREEFORM_ASSET_PLACEHOLDER_ID
          ? <img className="freeform-asset-preview" src={props.assetUrl(single.assetRef)} alt={single.alt || "受控图片资源预览"} />
          : <div className="freeform-inspector-empty">当前为占位资源：渲染占位图，不会发起任何外部请求。</div>}
      </> : null}
      <div className="freeform-field-grid">
        <CommitField label="描边色" value={single.style.strokeColor ?? "#507287"} disabled={props.disabled} onCommit={(value) => {
          if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
          props.onChange(single.id, { style: { ...single.style, strokeColor: value } });
        }} />
        <CommitField label="填充" value={single.style.fill ?? "transparent"} disabled={props.disabled} onCommit={(value) => {
          if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
          props.onChange(single.id, { style: { ...single.style, fill: value } });
        }} />
        <CommitField label="描边宽" type="number" value={single.style.strokeWidth ?? 1} min={0} max={40} disabled={props.disabled} onCommit={(value) => {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || number > 40) return "0—40";
          props.onChange(single.id, { style: { ...single.style, strokeWidth: number } });
        }} />
        <CommitField label="透明度" type="number" step={0.05} value={single.style.opacity ?? 1} min={0} max={1} disabled={props.disabled} onCommit={(value) => {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0 || number > 1) return "0—1";
          props.onChange(single.id, { style: { ...single.style, opacity: number } });
        }} />
        <CommitField label="字号" type="number" value={single.style.fontSize ?? 14} min={8} max={200} disabled={props.disabled} onCommit={(value) => {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 8 || number > 200) return "8—200";
          props.onChange(single.id, { style: { ...single.style, fontSize: number } });
        }} />
        <CommitField label="文字色" value={single.style.textColor ?? "#d8edf8"} disabled={props.disabled} onCommit={(value) => {
          if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
          props.onChange(single.id, { style: { ...single.style, textColor: value } });
        }} />
      </div>
    </> : null}
    <div className="freeform-inspector-actions">
      <button type="button" className="btn btn-ghost btn-sm" disabled={props.disabled} onClick={props.onToggleLocked}>
        {selected.every((element) => element.locked) ? <><Unlock size={13} /> 解锁</> : <><Lock size={13} /> 锁定</>}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={props.disabled} onClick={props.onToggleHidden}>
        {selected.every((element) => element.hidden) ? <><Eye size={13} /> 显示</> : <><EyeOff size={13} /> 隐藏</>}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={props.disabled || selected.length < 2} onClick={props.onGroup}>
        <Layers size={13} /> 组合 {selected.length} 项
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={props.disabled || groupIds.size === 0} onClick={props.onUngroup}>
        <Layers size={13} /> 取消组合
      </button>
    </div>
  </aside>;
}

// ---------- 手势 ----------

type Gesture = { pointerId: number; current: FreeformPoint } & (
  | { type: "marquee"; origin: FreeformPoint; additive: boolean }
  | { type: "move"; origin: FreeformPoint; ids: string[]; before: FreeformDocument }
  | { type: "resize"; origin: FreeformPoint; handle: FreeformResizeHandle; ids: string[]; before: FreeformDocument }
  | { type: "rotate"; origin: FreeformPoint; center: FreeformPoint; startAngle: number; ids: string[]; before: FreeformDocument }
  | { type: "create"; tool: FreeformTool; origin: FreeformPoint; points: FreeformPoint[] }
  | { type: "pan"; origin: FreeformPoint; startOffset: { x: number; y: number } }
);

// ---------- 画布容器（持有 viewport 与当前工具；文档数据归属 useFreeformDocument） ----------

export function WhiteboardFreeformCanvas(props: {
  diagramId: string;
  projectId: string;
  title: string;
  deliveryNodes: FreeformDeliveryNodeRef[];
  onClose: () => void;
}): ReactElement {
  const controller = useFreeformDocument(props.diagramId);
  const { document: doc, loadStatus } = controller;
  const disabled = loadStatus !== "ready";

  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const previewRef = useRef<FreeformDocument | null>(null);
  const viewportRef = useRef<FreeformViewport>({ zoom: 1, offsetX: 32, offsetY: 32 });
  const clipboardRef = useRef<FreeformClipboard | null>(null);
  const spaceRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const [tool, setTool] = useState<FreeformTool>("select");
  const [machine, setMachine] = useState(() => createFreeformMachine("select"));
  const [selection, setSelection] = useState<string[]>([]);
  const [preview, setPreview] = useState<FreeformDocument | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<FreeformRect | null>(null);
  const [drawRect, setDrawRect] = useState<FreeformRect | null>(null);
  const [viewport, setViewport] = useState<FreeformViewport>(viewportRef.current);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [legacyElements, setLegacyElements] = useState<FreeformElement[]>([]);
  const [reducedMotion, setReducedMotion] = useState(reducedMotionActive);
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 1200, height: 720 });

  const setViewportBoth = useCallback((next: FreeformViewport) => {
    viewportRef.current = next;
    setViewport(next);
  }, []);
  const setPreviewBoth = useCallback((next: FreeformDocument | null) => {
    previewRef.current = next;
    setPreview(next);
  }, []);

  const rendered = preview ?? doc;
  const selectionIds = useMemo(
    () => selection.filter((id) => doc.elements.some((element) => element.id === id)),
    [doc, selection],
  );
  const editingTarget = editingId ? doc.elements.find((element) => element.id === editingId) ?? null : null;

  useEffect(() => {
    let cancelled = false;
    void api.getPrototypeDraft(props.diagramId).then((stored) => {
      if (cancelled || !stored) return;
      setLegacyElements(mapLegacyPrototypeDraft(stored.current));
    }).catch(() => { /* 历史草稿缺失不影响自由层 */ });
    return () => { cancelled = true; };
  }, [props.diagramId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try { query = window.matchMedia("(prefers-reduced-motion: reduce)"); } catch { return; }
    const update = () => setReducedMotion(query.matches);
    update();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    return undefined;
  }, []);

  useEffect(() => {
    const measure = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) setStageSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      openerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const release = (event: KeyboardEvent) => { if (event.key === " ") spaceRef.current = false; };
    window.addEventListener("keyup", release);
    return () => window.removeEventListener("keyup", release);
  }, []);

  const takeTool = useCallback((next: FreeformTool) => {
    setTool(next);
    setMachine((state) => freeformMachine(state, { type: "tool", tool: next }));
    setEditingId(null);
    if (next !== "select") setSelection([]);
  }, []);

  const selectFromPanel = useCallback((ids: string[], additive: boolean) => {
    setSelection((current) => {
      const expanded = expandFreeformSelection(doc, ids);
      if (!additive) return expanded;
      const already = expanded.every((id) => current.includes(id));
      return already ? current.filter((id) => !expanded.includes(id)) : [...new Set([...current, ...expanded])];
    });
  }, [doc]);

  const pointerToWorld = useCallback((event: { clientX: number; clientY: number }): FreeformPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    const screenX = event.clientX - (rect?.left ?? 0);
    const screenY = event.clientY - (rect?.top ?? 0);
    const current = viewportRef.current;
    return { x: (screenX - current.offsetX) / current.zoom, y: (screenY - current.offsetY) / current.zoom };
  }, []);

  const commitActiveField = useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialogRef.current?.contains(active) && isEditableTarget(active)) active.blur();
  }, []);

  const buildCreatedElement = useCallback((created: Extract<Gesture, { type: "create" }>): FreeformElement | null => {
    const kind = freeformToolCreatesKind(created.tool);
    if (!kind) return null;
    const now = new Date().toISOString();
    let rect = normalizeFreeformRect({
      x: created.origin.x, y: created.origin.y,
      w: created.current.x - created.origin.x, h: created.current.y - created.origin.y,
    });
    if (rect.w < FREEFORM_MIN_SIZE && rect.h < FREEFORM_MIN_SIZE) {
      const fallback = DEFAULT_CREATE_SIZE[kind];
      rect = { x: created.origin.x, y: created.origin.y, w: fallback.w, h: fallback.h };
    } else {
      rect = { ...rect, w: Math.max(FREEFORM_MIN_SIZE, rect.w), h: Math.max(FREEFORM_MIN_SIZE, rect.h) };
    }
    const base = {
      id: newFreeformElementId(), kind,
      x: round2(rect.x), y: round2(rect.y),
      w: round2(Math.min(FREEFORM_MAX_SIZE, rect.w)), h: round2(Math.min(FREEFORM_MAX_SIZE, rect.h)),
      rotation: 0, groupId: null, style: freeformStyleDefaults(kind), locked: false, hidden: false,
      createdAt: now, updatedAt: now,
    };
    if (kind === "text") return { ...base, text: "双击编辑文本", autoHeight: true } as FreeformElement;
    if (kind === "sticky") return { ...base, text: "便签内容", tone: "neutral" } as FreeformElement;
    if (kind === "rect") return { ...base, cornerStyle: "rounded" } as FreeformElement;
    if (kind === "ellipse") return base as FreeformElement;
    if (kind === "arrow") {
      const dxRaw = created.current.x - created.origin.x;
      const dyRaw = created.current.y - created.origin.y;
      return { ...base, dx: round2(dxRaw / 2), dy: round2(dyRaw / 2), arrowStart: "none", arrowEnd: "triangle", lineStyle: "solid" } as FreeformElement;
    }
    if (kind === "ink") {
      const points = created.points.length > 1 ? [...created.points, created.current] : [created.origin, created.current];
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const width = Math.max(FREEFORM_MIN_SIZE, Math.max(...xs) - left);
      const height = Math.max(FREEFORM_MIN_SIZE, Math.max(...ys) - top);
      return {
        ...base, x: round2(left), y: round2(top), w: round2(width), h: round2(height),
        points: points.slice(0, 4000).map((point) => ({ x: round2((point.x - left) / width), y: round2((point.y - top) / height) })),
        strokeWidth: 2,
      } as FreeformElement;
    }
    return {
      ...base, assetRef: FREEFORM_ASSET_PLACEHOLDER_ID, imageFit: "contain", alt: "", sourceWidth: 0, sourceHeight: 0,
    } as FreeformElement;
  }, []);

  const onStagePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || disabled) return;
    commitActiveField();
    const pointerId = event.pointerId ?? 1;
    const point = pointerToWorld(event);
    try { event.currentTarget.setPointerCapture?.(pointerId); } catch { /* 环境不支持指针捕获时忽略 */ }
    setEditingId(null);

    if (tool === "pan" || spaceRef.current) {
      gestureRef.current = { type: "pan", pointerId, current: point, origin: point, startOffset: { x: viewportRef.current.offsetX, y: viewportRef.current.offsetY } };
      setMachine((state) => freeformMachine(state, { type: "pointerdown", pointerId, point, hitIds: [] }));
      return;
    }
    if (tool !== "select") {
      gestureRef.current = { type: "create", pointerId, current: point, tool, origin: point, points: [point] };
      setDrawRect({ x: point.x, y: point.y, w: 0, h: 0 });
      setMachine((state) => freeformMachine(state, { type: "pointerdown", pointerId, point, hitIds: [] }));
      return;
    }

    const topmost = [...doc.elements].reverse()
      .find((element) => !element.hidden && freeformElementHitTest(element, point, viewportRef.current.zoom));
    if (!topmost) {
      setSelection((current) => (event.shiftKey ? current : []));
      gestureRef.current = { type: "marquee", pointerId, current: point, origin: point, additive: event.shiftKey };
      setMachine((state) => freeformMachine(state, { type: "pointerdown", pointerId, point, hitIds: [] }));
      return;
    }
    const resolved = event.altKey || !topmost.groupId ? [topmost.id] : expandFreeformSelection(doc, [topmost.id]);
    if (event.shiftKey) {
      const already = resolved.every((id) => selection.includes(id));
      setSelection(already ? selection.filter((id) => !resolved.includes(id)) : [...new Set([...selection, ...resolved])]);
      return;
    }
    const ids = selection.includes(topmost.id) ? selection : resolved;
    if (topmost.locked) {
      setSelection(resolved);
      return;
    }
    setSelection(resolved);
    setPreviewBoth(doc);
    gestureRef.current = { type: "move", pointerId, current: point, origin: point, ids, before: doc };
    setMachine((state) => freeformMachine(state, { type: "pointerdown", pointerId, point, hitIds: resolved, transform: "move" }));
  }, [commitActiveField, disabled, doc, pointerToWorld, selection, setPreviewBoth, tool]);

  const onStagePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== (event.pointerId ?? gesture.pointerId)) return;
    const point = pointerToWorld(event);
    gestureRef.current = { ...gesture, current: point };
    setMachine((state) => freeformMachine(state, { type: "pointermove", pointerId: gesture.pointerId, point }));

    if (gesture.type === "pan") {
      const current = viewportRef.current;
      setViewportBoth({
        zoom: current.zoom,
        offsetX: gesture.startOffset.x + (point.x - gesture.origin.x) * current.zoom,
        offsetY: gesture.startOffset.y + (point.y - gesture.origin.y) * current.zoom,
      });
      return;
    }
    if (gesture.type === "marquee") {
      setMarqueeRect(normalizeFreeformRect({
        x: gesture.origin.x, y: gesture.origin.y, w: point.x - gesture.origin.x, h: point.y - gesture.origin.y,
      }));
      return;
    }
    if (gesture.type === "create") {
      gesture.points.push(point);
      setDrawRect(normalizeFreeformRect({
        x: gesture.origin.x, y: gesture.origin.y, w: point.x - gesture.origin.x, h: point.y - gesture.origin.y,
      }));
      return;
    }
    if (gesture.type === "move") {
      setPreviewBoth(moveFreeformElements(gesture.before, gesture.ids, point.x - gesture.origin.x, point.y - gesture.origin.y));
      return;
    }
    if (gesture.type === "resize") {
      const horizontal = gesture.handle.includes("e") ? 1 : gesture.handle.includes("w") ? -1 : 0;
      const vertical = gesture.handle.includes("s") ? 1 : gesture.handle.includes("n") ? -1 : 0;
      setPreviewBoth(resizeFreeformElements(
        gesture.before, gesture.ids, gesture.handle,
        horizontal * (point.x - gesture.origin.x), vertical * (point.y - gesture.origin.y),
        { keepAspect: event.shiftKey, fromCenter: event.altKey },
      ));
      return;
    }
    const angle = Math.atan2(point.y - gesture.center.y, point.x - gesture.center.x) * (180 / Math.PI);
    setPreviewBoth(rotateFreeformElements(gesture.before, gesture.ids, angle - gesture.startAngle, { snap: event.shiftKey }));
  }, [pointerToWorld, setPreviewBoth, setViewportBoth]);

  const onStagePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== (event.pointerId ?? gesture.pointerId)) return;
    const point = pointerToWorld(event);
    gestureRef.current = null;
    setMachine((state) => freeformMachine(state, { type: "pointerup", pointerId: gesture.pointerId, point }));

    if (gesture.type === "pan") return;
    if (gesture.type === "marquee") {
      setMarqueeRect(null);
      const rect = normalizeFreeformRect({
        x: gesture.origin.x, y: gesture.origin.y, w: point.x - gesture.origin.x, h: point.y - gesture.origin.y,
      });
      const hits = freeformMarqueeHits(doc.elements, rect);
      setSelection((current) => gesture.additive ? [...new Set([...current, ...hits])] : expandFreeformSelection(doc, hits));
      return;
    }
    if (gesture.type === "create") {
      const element = buildCreatedElement(gesture);
      setDrawRect(null);
      setPreviewBoth(null);
      if (element && controller.commit("create", (current) => withElements(current, [...current.elements, element]))) {
        setSelection([element.id]);
        setTool("select");
        setMachine((state) => freeformMachine(state, { type: "tool", tool: "select" }));
        controller.announce(`已创建${FREEFORM_KIND_LABELS[element.kind]}并选中`);
      }
      return;
    }
    const next = previewRef.current;
    setPreviewBoth(null);
    if (next && controller.commit(gesture.type, () => next)) {
      controller.announce(gesture.type === "move" ? "已移动选中元素"
        : gesture.type === "resize" ? "已缩放选中元素" : "已旋转选中元素");
    }
  }, [buildCreatedElement, controller, doc, pointerToWorld, setPreviewBoth]);

  const onStageDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const point = pointerToWorld(event);
    const hit = [...doc.elements].reverse()
      .find((element) => !element.hidden && !element.locked && freeformElementHitTest(element, point, viewportRef.current.zoom));
    if (!hit) return;
    setSelection([hit.id]);
    if (hit.kind === "text" || hit.kind === "sticky") { setEditingId(hit.id); setEditingText(hit.text ?? ""); }
  }, [disabled, doc, pointerToWorld]);

  const beginHandleGesture = useCallback((event: ReactPointerEvent<HTMLElement>, kind: "resize" | "rotate", handle?: FreeformResizeHandle) => {
    if (disabled || !selectionIds.length || event.button !== 0) return;
    event.stopPropagation();
    const pointerId = event.pointerId ?? 1;
    const point = pointerToWorld(event);
    try { stageRef.current?.setPointerCapture?.(pointerId); } catch { /* 环境不支持指针捕获时忽略 */ }
    const ids = expandFreeformSelection(doc, selectionIds);
    const bounds = freeformSelectionBounds(doc.elements.filter((element) => ids.includes(element.id)));
    if (!bounds) return;
    if (kind === "resize" && handle) {
      gestureRef.current = { type: "resize", pointerId, current: point, origin: point, handle, ids, before: doc };
      setPreviewBoth(doc);
      return;
    }
    const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    gestureRef.current = {
      type: "rotate", pointerId, current: point, origin: point, center, ids, before: doc,
      startAngle: Math.atan2(point.y - center.y, point.x - center.x) * (180 / Math.PI),
    };
    setPreviewBoth(doc);
  }, [disabled, doc, pointerToWorld, selectionIds, setPreviewBoth]);

  const applyNumeric = useCallback((key: "x" | "y" | "w" | "h", value: number): string | void => {
    if (!selectionIds.length) return;
    const isSize = key === "w" || key === "h";
    if (!Number.isFinite(value)) return "请输入数值";
    if (isSize && (value < FREEFORM_MIN_SIZE || value > FREEFORM_MAX_SIZE)) return `${FREEFORM_MIN_SIZE}—${FREEFORM_MAX_SIZE}`;
    if (!isSize && (value < -100000 || value > 100000)) return "-100000—100000";
    const single = selectionIds.length === 1 ? doc.elements.find((element) => element.id === selectionIds[0]) : null;
    const changed = controller.commit("style", (current) => {
      if (single) return updateFreeformElement(current, single.id, { [key]: round2(value) });
      const bounds = freeformSelectionBounds(current.elements.filter((element) => selectionIds.includes(element.id)));
      if (!bounds) return current;
      if (!isSize) {
        const delta = key === "x" ? value - bounds.x : value - bounds.y;
        return moveFreeformElements(current, selectionIds, key === "x" ? delta : 0, key === "y" ? delta : 0);
      }
      const target = Math.max(FREEFORM_MIN_SIZE, value);
      if (key === "w") return resizeFreeformElements(current, selectionIds, "e", target - bounds.w, 0, {});
      return resizeFreeformElements(current, selectionIds, "s", 0, target - bounds.h, {});
    });
    return changed ? undefined : "未产生变化";
  }, [controller, doc, selectionIds]);

  const applyRotation = useCallback((value: number): string | void => {
    if (!selectionIds.length) return;
    if (!Number.isFinite(value) || value < -360 || value > 360) return "-360—360";
    const changed = controller.commit("rotate", (current) => {
      if (selectionIds.length === 1) return setFreeformRotation(current, selectionIds, value);
      const target = current.elements.find((element) => element.id === selectionIds[0]);
      return rotateFreeformElements(current, selectionIds, target ? value - target.rotation : value, {});
    });
    return changed ? undefined : "未产生变化";
  }, [controller, selectionIds]);

  const patchElement = useCallback((id: string, patch: Partial<FreeformElement>) => {
    controller.commit("style", (current) => updateFreeformElement(current, id, patch));
  }, [controller]);

  const doDelete = useCallback(() => {
    if (!selectionIds.length) return;
    const ids = selectionIds;
    if (controller.commit("delete", (current) => deleteFreeformElements(current, ids))) {
      setSelection([]);
      controller.announce(`已删除 ${ids.length} 个自由元素`);
    }
  }, [controller, selectionIds]);

  const doDuplicate = useCallback(() => {
    if (!selectionIds.length) return;
    const available = doc.elements.filter((element) => element.kind === "image")
      .map((element) => element.assetRef).filter((assetId): assetId is string => Boolean(assetId));
    let created: string[] = [];
    const changed = controller.commit("duplicate", (current) => {
      const duplicated = duplicateFreeformElements(current, selectionIds, { availableAssetIds: available });
      created = duplicated.ids;
      return duplicated.document;
    });
    if (changed) {
      setSelection(created);
      controller.announce(`已复制 ${created.length} 个自由元素（偏移 +16, +16）`);
    }
  }, [controller, doc, selectionIds]);

  const doCopy = useCallback((cut: boolean) => {
    if (!selectionIds.length) return;
    clipboardRef.current = copyFreeformElements(doc, selectionIds);
    controller.announce(cut ? `已剪切 ${selectionIds.length} 个自由元素` : `已复制 ${selectionIds.length} 个自由元素`);
    if (cut) doDelete();
  }, [controller, doDelete, doc, selectionIds]);

  const doPaste = useCallback(() => {
    const clipboard = clipboardRef.current;
    if (!clipboard) { controller.announce("剪贴板为空"); return; }
    const available = doc.elements.filter((element) => element.kind === "image")
      .map((element) => element.assetRef).filter((assetId): assetId is string => Boolean(assetId));
    let created: string[] = [];
    const changed = controller.commit("paste", (current) => {
      const pasted = pasteFreeformClipboard(current, clipboard, { availableAssetIds: available });
      created = pasted.ids;
      return pasted.document;
    });
    if (changed) {
      setSelection(created);
      controller.announce(`已粘贴 ${created.length} 个自由元素（偏移 +16, +16）`);
    }
  }, [controller, doc]);

  const doGroup = useCallback(() => {
    if (selectionIds.length < 2) { controller.announce("至少选择 2 个元素才能组合"); return; }
    if (controller.commit("group", (current) => groupFreeformElements(current, selectionIds))) {
      controller.announce(`已组合 ${selectionIds.length} 个元素`);
    }
  }, [controller, selectionIds]);

  const doUngroup = useCallback(() => {
    if (controller.commit("ungroup", (current) => ungroupFreeformElements(current, selectionIds))) {
      controller.announce("已取消组合");
    }
  }, [controller, selectionIds]);

  const doReorder = useCallback((action: FreeformLayerAction) => {
    if (!selectionIds.length) return;
    const labels: Record<FreeformLayerAction, string> = { front: "置顶", back: "置底", forward: "上移一层", backward: "下移一层" };
    if (controller.commit("layer", (current) => reorderFreeformElements(current, selectionIds, action))) {
      controller.announce(`已${labels[action]}`);
    }
  }, [controller, selectionIds]);

  const toggleField = useCallback((ids: string[], field: "locked" | "hidden") => {
    const targets = ids.length ? ids : selectionIds;
    if (!targets.length) return;
    const allOn = targets.every((id) => Boolean(doc.elements.find((element) => element.id === id)?.[field]));
    controller.commit("style", (current) => withElements(current, current.elements.map((element) =>
      targets.includes(element.id) ? { ...element, [field]: !allOn } : element)));
    controller.announce(allOn
      ? `已取消${field === "locked" ? "锁定" : "隐藏"}`
      : `已${field === "locked" ? "锁定" : "隐藏"} ${targets.length} 个元素`);
  }, [controller, doc, selectionIds]);

  const deleteUnsupported = useCallback((id: string) => {
    controller.commit("delete", (current) => ({ ...current, unsupported: current.unsupported.filter((item) => item.id !== id) }));
    controller.announce(`已删除不支持的元素 ${id}`);
  }, [controller]);

  const commitEditing = useCallback(() => {
    const id = editingId;
    const target = editingTarget;
    setEditingId(null);
    if (!id || !target || (target.kind !== "text" && target.kind !== "sticky")) return;
    if (target.text === editingText) return;
    if (controller.commit("text", (current) => updateFreeformElement(current, id, { text: editingText.slice(0, FREEFORM_TEXT_MAX) }))) {
      controller.announce("已提交文本编辑");
    }
  }, [controller, editingId, editingTarget, editingText]);

  const expandSelectionDirectional = useCallback((dx: number, dy: number) => {
    const bounds = freeformSelectionBounds(doc.elements.filter((element) => selectionIds.includes(element.id)));
    const candidates = doc.elements.filter((element) => editableFreeformElement(element) && !selectionIds.includes(element.id));
    if (!candidates.length) return;
    const origin = bounds ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 } : { x: 0, y: 0 };
    const next = candidates.map((element) => {
      const cx = element.x + element.w / 2 - origin.x;
      const cy = element.y + element.h / 2 - origin.y;
      return { id: element.id, along: cx * dx + cy * dy, across: Math.abs(cx * dy - cy * dx) };
    }).filter((entry) => entry.along > 0)
      .sort((a, b) => (a.across - b.across) || (a.along - b.along))[0];
    if (!next) return;
    setSelection([...selectionIds, next.id]);
    controller.announce("已按方向扩展选中集");
  }, [controller, doc, selectionIds]);

  const exportJson = useCallback(() => {
    downloadBlob(`freeform-${props.diagramId}.json`, new Blob([buildFreeformExportJson(doc)], { type: "application/json" }));
    controller.announce("已导出自由层 JSON（不写入证据、不触发交付事件）");
  }, [controller, doc, props.diagramId]);

  const exportSvg = useCallback(() => {
    downloadBlob(`freeform-${props.diagramId}.svg`, new Blob([buildFreeformSvg(doc, { assetUrl: api.freeformAssetUrl })], { type: "image/svg+xml" }));
    controller.announce("已导出自由层 SVG（不写入证据、不触发交付事件）");
  }, [controller, doc, props.diagramId]);

  const exportPng = useCallback(() => {
    const svg = buildFreeformSvg(doc, { assetUrl: api.freeformAssetUrl });
    const bounds = freeformSelectionBounds(doc.elements.filter((element) => !element.hidden)) ?? { x: 0, y: 0, w: 1, h: 1 };
    const width = Math.max(1, Math.ceil(bounds.w + 16)) * FREEFORM_PNG_SCALE;
    const height = Math.max(1, Math.ceil(bounds.h + 16)) * FREEFORM_PNG_SCALE;
    try {
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const rasterize = (source: CanvasImageSource) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (!context) { exportSvg(); return false; }
        context.drawImage(source, 0, 0, width, height);
        if (typeof canvas.toBlob !== "function") { exportSvg(); return false; }
        canvas.toBlob((output) => {
          if (output) {
            downloadBlob(`freeform-${props.diagramId}@2x.png`, output);
            controller.announce("已导出自由层 PNG（2x，忽略选中态与辅助线）");
          } else exportSvg();
        }, "image/png");
        return true;
      };
      const image = new Image();
      image.onload = () => { rasterize(image); URL.revokeObjectURL(url); };
      image.onerror = () => { URL.revokeObjectURL(url); exportSvg(); };
      image.src = url;
    } catch {
      controller.announce("当前环境不支持 PNG 光栅化，已改用 SVG 导出");
      exportSvg();
    }
  }, [controller, doc, exportSvg, props.diagramId]);

  const uploadAsset = useCallback(async (file: File) => {
    setUploadError("");
    if (file.size > 10 * 1024 * 1024) { setUploadError("单文件不得超过 10MB"); return; }
    setUploading(true);
    try {
      const summary = await api.uploadFreeformAsset(props.projectId, file, file.type || "image/png");
      controller.announce(`受控图片已入库（${summary.mime} ${summary.width}×${summary.height}）`);
      const target = selectionIds.length === 1 ? doc.elements.find((element) => element.id === selectionIds[0]) : null;
      if (target && target.kind === "image" && target.assetRef === FREEFORM_ASSET_PLACEHOLDER_ID) {
        patchElement(target.id, { assetRef: summary.id, sourceWidth: summary.width, sourceHeight: summary.height });
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "受控图片上传失败");
    } finally {
      setUploading(false);
    }
  }, [controller, doc, patchElement, props.projectId, selectionIds]);

  const moveSelection = useCallback((key: string, fast: boolean) => {
    const delta = freeformKeyboardNudge(key);
    if (!delta || !selectionIds.length) return;
    const distance = fast ? 10 : 1;
    controller.commit("move", (current) => moveFreeformElements(current, selectionIds, delta.dx * distance, delta.dy * distance));
  }, [controller, selectionIds]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      commitActiveField();
      window.setTimeout(() => void controller.save(), 0);
      return;
    }
    if (event.key === "Escape") {
      if (editingId) { event.preventDefault(); setEditingId(null); return; }
      if (gestureRef.current) {
        event.preventDefault();
        gestureRef.current = null;
        setPreviewBoth(null);
        setMarqueeRect(null);
        setDrawRect(null);
        return;
      }
      if (selectionIds.length) { event.preventDefault(); setSelection([]); return; }
      event.preventDefault();
      props.onClose();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (event.key === " ") {
      spaceRef.current = true;
      if (selectionIds.length) event.preventDefault();
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(freeformSelectAllIds(doc));
      controller.announce("已全选（不含隐藏与锁定元素）");
      return;
    }
    if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); controller.undo(); return; }
    if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) { event.preventDefault(); controller.redo(); return; }
    if (mod && event.key.toLowerCase() === "c") { event.preventDefault(); doCopy(false); return; }
    if (mod && event.key.toLowerCase() === "x") { event.preventDefault(); doCopy(true); return; }
    if (mod && event.key.toLowerCase() === "v") { event.preventDefault(); doPaste(); return; }
    if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); doDuplicate(); return; }
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) doUngroup(); else doGroup();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); doDelete(); return; }
    if (event.key === "[") { event.preventDefault(); doReorder("backward"); return; }
    if (event.key === "]") { event.preventDefault(); doReorder("forward"); return; }
    if (event.key === "Enter") {
      const single = selectionIds.length === 1 ? doc.elements.find((element) => element.id === selectionIds[0]) : null;
      if (single && (single.kind === "text" || single.kind === "sticky") && !single.locked) {
        event.preventDefault();
        setEditingId(single.id);
        setEditingText(single.text ?? "");
      }
      return;
    }
    const nudge = freeformKeyboardNudge(event.key);
    if (nudge) {
      event.preventDefault();
      if (spaceRef.current) { expandSelectionDirectional(nudge.dx, nudge.dy); return; }
      moveSelection(event.key, event.shiftKey);
      return;
    }
    if (mod || event.altKey) return;
    const shortcut = freeformToolForShortcut(event.key);
    if (shortcut) { event.preventDefault(); takeTool(shortcut); }
  }, [
    commitActiveField, controller, doCopy, doDelete, doDuplicate, doGroup, doPaste, doReorder, doUngroup,
    doc, editingId, expandSelectionDirectional, moveSelection, props, selectionIds, setPreviewBoth, takeTool,
  ]);

  const adjustZoom = (direction: 1 | -1) => {
    const current = viewportRef.current.zoom;
    const next = direction === 1
      ? ZOOM_STEPS.find((step) => step > current + 1e-6) ?? FREEFORM_ZOOM_MAX
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? FREEFORM_ZOOM_MIN;
    setViewportBoth({ ...viewportRef.current, zoom: Math.max(FREEFORM_ZOOM_MIN, Math.min(FREEFORM_ZOOM_MAX, next)) });
  };

  const selectionBounds = useMemo(
    () => freeformSelectionBounds(rendered.elements.filter((element) => selectionIds.includes(element.id))),
    [rendered, selectionIds],
  );
  const handleBox: CSSProperties | null = selectionBounds && selectionIds.length && !disabled ? {
    left: viewport.offsetX + selectionBounds.x * viewport.zoom,
    top: viewport.offsetY + selectionBounds.y * viewport.zoom,
    width: Math.max(1, selectionBounds.w * viewport.zoom),
    height: Math.max(1, selectionBounds.h * viewport.zoom),
  } : null;

  const statusText = loadStatus === "loading" ? "加载中"
    : controller.conflict ? "保存冲突"
      : controller.saving ? "保存中"
        : controller.dirty ? "有未保存修改" : "已保存";
  const singleRotation = selectionIds.length === 1
    ? `${doc.elements.find((element) => element.id === selectionIds[0])?.rotation ?? 0}°`
    : "—";
  const bannerText = controller.saveError || controller.loadError || uploadError || controller.notice;

  return <div
    ref={dialogRef}
    className="freeform-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="自由创作与富媒体工具"
    data-reduced-motion={reducedMotion ? "true" : "false"}
    data-tool={tool}
    data-phase={machine.phase}
    onKeyDown={onKeyDown}
  >
    <header className="freeform-topbar">
      <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClose}><ChevronLeft size={15} />返回画布</button>
      <div className="freeform-title"><span>FREEFORM LAYER</span><strong>{props.title}</strong></div>
      <div className="freeform-save-state" data-state={controller.conflict ? "conflict" : controller.saving ? "saving" : controller.dirty ? "dirty" : "clean"}>
        {statusText}
      </div>
      <div className="freeform-actions">
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} aria-label="撤销" title="撤销（Ctrl+Z）" onClick={controller.undo}>
          <Undo2 size={14} />{controller.history.past.length}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} aria-label="重做" title="重做（Ctrl+Shift+Z）" onClick={controller.redo}>
          <Redo2 size={14} />{controller.history.future.length}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={exportPng}><Download size={14} />PNG 2x</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={exportSvg}><Download size={14} />SVG</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={disabled} onClick={exportJson}><Download size={14} />JSON</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={disabled || controller.saving || controller.saveUnknown || !controller.dirty}
          onClick={() => void controller.save()}>
          <Save size={14} />{controller.saving ? "保存中…" : "保存自由层"}
        </button>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="关闭自由层" onClick={props.onClose}><X size={16} /></button>
      </div>
    </header>

    <div className="freeform-body">
      <FreeformToolbar tool={tool} disabled={disabled} onTool={takeTool} onPickImage={() => fileInputRef.current?.click()} />
      <input
        ref={fileInputRef}
        className="freeform-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="选择受控图片资源"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadAsset(file);
        }}
      />

      <main className="freeform-stage">
        {bannerText ? <div
          className={`freeform-banner ${controller.saveError || controller.loadError || uploadError ? "is-error" : ""}`}
          role={controller.saveError || controller.loadError || uploadError ? "alert" : "status"}
        >
          <span>{bannerText}</span>
          {controller.conflict ? <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void controller.reload()}>① 以服务端为准重载</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={controller.saveAsCopy}>② 另存为副本</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => void controller.forceOverwrite()}>③ 强制覆盖（二次确认）</button>
          </> : null}
          {controller.localBackup && !controller.conflict
            ? <button type="button" className="btn btn-ghost btn-sm" onClick={controller.replayLocalBackup}>重放本地副本</button>
            : null}
          {controller.loadStatus === "error"
            ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void controller.reload()}>重试加载</button>
            : null}
        </div> : null}

        <div className="freeform-stage-toolbar">
          <strong>{TOOL_LABELS[tool]}模式</strong>
          <span className="freeform-status-readout" role="status">
            缩放 {Math.round(viewport.zoom * 100)}% · 旋转 {singleRotation} · 已选 {selectionIds.length}
          </span>
          <div className="freeform-zoom">
            <button type="button" aria-label="缩小画布" onClick={() => adjustZoom(-1)}><ZoomOut size={14} /></button>
            <button type="button" aria-label="重置缩放" onClick={() => setViewportBoth({ ...viewportRef.current, zoom: 1 })}>
              {Math.round(viewport.zoom * 100)}%
            </button>
            <button type="button" aria-label="放大画布" onClick={() => adjustZoom(1)}><ZoomIn size={14} /></button>
          </div>
          {legacyElements.length ? <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            title="只读映射历史原型草稿，不自动改写历史记录"
            onClick={() => {
              if (controller.commit("create", (current) => withElements(current, [...current.elements, ...legacyElements]))) {
                controller.announce(`已把历史原型草稿复制为 ${legacyElements.length} 个自由元素（历史草稿本身未被改写）`);
              }
            }}
          ><Move size={13} />沿用历史草稿 {legacyElements.length}</button> : null}
        </div>

        <div ref={stageRef} className="freeform-stage-scroll" data-testid="freeform-stage">
          <div
            className="freeform-viewport"
            data-testid="freeform-viewport"
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={(event) => {
              gestureRef.current = null;
              setPreviewBoth(null);
              setMarqueeRect(null);
              setDrawRect(null);
            }}
            onDoubleClick={onStageDoubleClick}
            style={{ touchAction: "none", cursor: tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair" }}
          >
            <FreeformElementLayer
              elements={rendered.elements}
              legacyElements={legacyElements}
              selection={selectionIds}
              viewport={viewport}
              width={stageSize.width}
              height={stageSize.height}
              assetUrl={api.freeformAssetUrl}
              editingId={editingId}
              interactive={!disabled}
              onFocusElement={(id) => setSelection((current) => current.includes(id) ? current : [id])}
            />
            {marqueeRect ? <div className="freeform-marquee" data-testid="freeform-marquee" style={{
              left: viewport.offsetX + marqueeRect.x * viewport.zoom,
              top: viewport.offsetY + marqueeRect.y * viewport.zoom,
              width: Math.max(0, marqueeRect.w * viewport.zoom),
              height: Math.max(0, marqueeRect.h * viewport.zoom),
            }} /> : null}
            {drawRect ? <div className="freeform-draw-preview" data-testid="freeform-draw-preview" style={{
              left: viewport.offsetX + drawRect.x * viewport.zoom,
              top: viewport.offsetY + drawRect.y * viewport.zoom,
              width: Math.max(0, drawRect.w * viewport.zoom),
              height: Math.max(0, drawRect.h * viewport.zoom),
            }} /> : null}
            {handleBox ? <div className="freeform-handles" style={handleBox} data-testid="freeform-handles">
              {RESIZE_HANDLES.map((handle) => <span
                key={handle}
                role="button"
                tabIndex={-1}
                aria-label={RESIZE_LABELS[handle]}
                data-handle={handle}
                className={`freeform-handle handle-${handle}`}
                onPointerDown={(event) => beginHandleGesture(event, "resize", handle)}
              />)}
              <span
                role="button"
                tabIndex={-1}
                aria-label="旋转选中元素"
                data-handle="rotate"
                className="freeform-handle handle-rotate"
                onPointerDown={(event) => beginHandleGesture(event, "rotate")}
              ><RotateCw size={12} /></span>
            </div> : null}
            {editingTarget ? <textarea
              className="freeform-text-editor"
              data-testid="freeform-text-editor"
              aria-label="内联编辑文本"
              value={editingText}
              maxLength={FREEFORM_TEXT_MAX}
              onChange={(event) => setEditingText(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") { event.preventDefault(); commitEditing(); }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitEditing(); }
              }}
              onBlur={commitEditing}
              style={{
                left: viewport.offsetX + editingTarget.x * viewport.zoom,
                top: viewport.offsetY + editingTarget.y * viewport.zoom,
                width: Math.max(60, editingTarget.w * viewport.zoom),
                height: Math.max(24, editingTarget.h * viewport.zoom),
              }}
            /> : null}
          </div>
        </div>
      </main>

      <FreeformLayerPanel
        document={doc}
        selection={selectionIds}
        deliveryNodes={props.deliveryNodes}
        disabled={disabled}
        onSelect={selectFromPanel}
        onToggleHidden={(id) => toggleField([id], "hidden")}
        onToggleLocked={(id) => toggleField([id], "locked")}
        onReorder={doReorder}
        onDeleteUnsupported={deleteUnsupported}
      />

      <FreeformInspector
        selection={selectionIds}
        document={doc}
        disabled={disabled}
        assetUrl={api.freeformAssetUrl}
        onChange={patchElement}
        onNumeric={applyNumeric}
        onRotation={applyRotation}
        onToggleLocked={() => toggleField(selectionIds, "locked")}
        onToggleHidden={() => toggleField(selectionIds, "hidden")}
        onGroup={doGroup}
        onUngroup={doUngroup}
      />
    </div>

    <div className="freeform-announcer" role="status" aria-live="polite">
      {controller.saveError || controller.notice || (uploading ? "受控图片上传中" : "")}
    </div>
    {loadStatus === "loading" ? <div className="freeform-loading" role="status">正在加载自由层…</div> : null}
  </div>;
}