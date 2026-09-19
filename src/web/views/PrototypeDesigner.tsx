import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Link2,
  Lock,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Square,
  Type,
  Undo2,
  Unlock,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { formatDateTime } from "../ui";
import { api } from "../api";
import {
  alignPrototypeComponents,
  clonePrototypeDraft,
  isEditablePrototypeComponent,
  movePrototypeComponents,
  normalizePrototypeDraft,
  normalizePrototypePayload,
  normalizePrototypeStored,
  prototypeFingerprint,
  prototypeStyleDefaults,
  PROTOTYPE_HISTORY_LIMIT,
  PROTOTYPE_ZOOM_MAX,
  PROTOTYPE_ZOOM_MIN,
  type PrototypeAlignment,
} from "../../shared/prototype";
import type { PrototypeComponent, PrototypeDraft, PrototypeKind, PrototypeScreen, PrototypeStored } from "../../shared/types";

declare global {
  interface Window {
    __productDesignPrototypeGuard?: () => boolean;
  }
}

type StoredPrototype = Omit<PrototypeStored, "updatedAt">;
type LoadStatus = "loading" | "ready" | "error";
type Gesture = {
  type: "move" | "resize";
  pointerId: number;
  screenId: string;
  componentId: string;
  ids: string[];
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  before: PrototypeDraft;
};

const uid = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LABELS: Record<PrototypeKind, string> = { text: "文本", button: "按钮", input: "输入框", card: "卡片", image: "图片" };
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

const defaults = (kind: PrototypeKind, index: number): Omit<PrototypeComponent, "id"> => ({
  kind,
  x: 28,
  y: 28 + index * 64,
  w: kind === "text" ? 260 : kind === "image" ? 240 : 180,
  h: kind === "text" ? 36 : kind === "image" ? 150 : 48,
  text: kind === "button" ? "继续" : kind === "input" ? "请输入内容" : kind === "card" ? "内容卡片" : kind === "image" ? "图片说明" : "页面标题",
  ...prototypeStyleDefaults(kind),
});

const initialDraft = (title: string): PrototypeDraft => normalizePrototypeDraft({
  version: 1,
  updatedAt: new Date().toISOString(),
  screens: [
    { id: uid(), name: "首页", width: 640, height: 480, background: "#0f202b", components: [
      { id: uid(), ...defaults("text", 0), text: title },
      { id: uid(), ...defaults("button", 1), text: "查看详情" },
    ] },
    { id: uid(), name: "详情页", width: 640, height: 480, background: "#0f202b", components: [
      { id: uid(), ...defaults("text", 0), text: "详情页" },
      { id: uid(), ...defaults("card", 1) },
    ] },
  ],
});

export function nextPrototypeScreenId(screens: PrototypeScreen[], currentId: string): string {
  if (!screens.length) return "";
  const index = Math.max(0, screens.findIndex((screen) => screen.id === currentId));
  return screens[(index + 1) % screens.length]?.id ?? "";
}

export function prototypePreviewTarget(screens: PrototypeScreen[], currentId: string, kind: PrototypeKind): string {
  return kind === "button" ? nextPrototypeScreenId(screens, currentId) : currentId;
}

function readStored(key: string): { value: StoredPrototype | null; error: string } {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { value: null, error: "" };
    return { value: normalizePrototypePayload(JSON.parse(raw)), error: "" };
  }
  catch { return { value: null, error: "本地恢复草稿已损坏，已忽略" }; }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
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
    const nextError = props.type === "number" && value.trim() === ""
      ? "请输入数值"
      : props.onCommit(value) ?? "";
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
    {error ? <small className="prototype-field-error">{error}</small> : null}
  </label>;
}

function PrototypeImage({ component }: { component: PrototypeComponent }): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [component.imageUrl]);
  if (!component.imageUrl || failed) return <><ImageIcon size={18} /><span>{component.text}</span></>;
  return <img src={component.imageUrl} alt={component.text} draggable={false} onError={() => setFailed(true)} />;
}

export function PrototypeDesigner(props: { diagramId: string; title: string; onClose: () => void }): ReactElement {
  const storageKey = `productdesign:prototype:${props.diagramId}`;
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageScrollRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const generationRef = useRef(0);
  const storedRef = useRef<StoredPrototype>({ current: initialDraft(props.title), versions: [] });
  const [stored, setStored] = useState<StoredPrototype>(storedRef.current);
  const [screenId, setScreenId] = useState(stored.current.screens[0]?.id ?? "");
  const [previewScreenId, setPreviewScreenId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [versionId, setVersionId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [undoStack, setUndoStack] = useState<PrototypeDraft[]>([]);
  const [redoStack, setRedoStack] = useState<PrototypeDraft[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [serverUpdatedAt, setServerUpdatedAt] = useState<string | null>(null);
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveUnknown, setSaveUnknown] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [cacheWarning, setCacheWarning] = useState("");
  storedRef.current = stored;

  const dirty = prototypeFingerprint(stored.current) !== savedFingerprint;
  const activeScreenId = preview ? previewScreenId : screenId;
  const currentScreen = stored.current.screens.find((screen) => screen.id === activeScreenId) ?? stored.current.screens[0];
  const editorScreen = stored.current.screens.find((screen) => screen.id === screenId) ?? stored.current.screens[0];
  const selected = selectedIds.length === 1 ? currentScreen?.components.find((component) => component.id === selectedIds[0]) ?? null : null;
  const editableSelectedIds = useMemo(() => {
    const ids = new Set(selectedIds);
    return currentScreen?.components.filter((component) => ids.has(component.id) && isEditablePrototypeComponent(component)).map((component) => component.id) ?? [];
  }, [currentScreen, selectedIds]);

  useEffect(() => {
    const generation = ++generationRef.current;
    setLoadStatus("loading");
    setSaving(false);
    setSaveError("");
    setSaveUnknown(false);
    setConflict(false);
    const local = readStored(storageKey);
    setCacheWarning(local.error);
    void api.getPrototypeDraft(props.diagramId).then((remote) => {
      if (generation !== generationRef.current) return;
      const normalizedRemote = remote ? normalizePrototypeStored(remote) : null;
      const value = normalizedRemote ? { current: normalizedRemote.current, versions: normalizedRemote.versions } : local.value ?? { current: initialDraft(props.title), versions: [] };
      setStored(value);
      setServerUpdatedAt(normalizedRemote?.updatedAt ?? null);
      setSavedFingerprint(remote ? prototypeFingerprint(value.current) : "");
      setScreenId(value.current.screens[0]?.id ?? "");
      setSelectedIds([]);
      setUndoStack([]);
      setRedoStack([]);
      setLoadStatus("ready");
    }).catch((error) => {
      if (generation !== generationRef.current) return;
      const value = local.value ?? { current: initialDraft(props.title), versions: [] };
      setStored(value);
      setServerUpdatedAt(null);
      setSavedFingerprint("");
      setScreenId(value.current.screens[0]?.id ?? "");
      setSelectedIds([]);
      setUndoStack([]);
      setRedoStack([]);
      setSaveError(error instanceof Error ? `服务器草稿加载失败：${error.message}` : "服务器草稿加载失败");
      setLoadStatus("error");
    });
    return () => { generationRef.current += 1; };
  }, [props.diagramId, props.title, reloadKey, storageKey]);

  useEffect(() => {
    if (loadStatus === "loading") return;
    try { localStorage.setItem(storageKey, JSON.stringify(stored)); setCacheWarning(""); }
    catch { setCacheWarning("本地容错缓存写入失败；内存编辑和服务器保存不受影响"); }
  }, [loadStatus, storageKey, stored]);

  useEffect(() => {
    if (preview) return;
    setSelectedIds((ids) => ids.filter((id) => editorScreen?.components.some((component) => component.id === id && isEditablePrototypeComponent(component))));
  }, [editorScreen, preview]);

  const commit = useCallback((update: (draft: PrototypeDraft) => PrototypeDraft) => {
    if (preview || loadStatus !== "ready") return false;
    const before = storedRef.current.current;
    const after = normalizePrototypeDraft(update(clonePrototypeDraft(before)));
    if (prototypeFingerprint(before) === prototypeFingerprint(after)) return false;
    setUndoStack((items) => [...items, clonePrototypeDraft(before)].slice(-PROTOTYPE_HISTORY_LIMIT));
    setRedoStack([]);
    const nextStored = { ...storedRef.current, current: after };
    storedRef.current = nextStored;
    setStored(nextStored);
    setNotice("");
    return true;
  }, [loadStatus, preview]);

  const updateScreen = (patch: Partial<PrototypeScreen>) => {
    if (!currentScreen) return;
    commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => screen.id === currentScreen.id ? { ...screen, ...patch } : screen) }));
  };

  const updateSelected = (patch: Partial<PrototypeComponent>) => {
    if (!selected || !currentScreen || !isEditablePrototypeComponent(selected)) return;
    commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => screen.id === currentScreen.id ? {
      ...screen,
      components: screen.components.map((component) => component.id === selected.id && isEditablePrototypeComponent(component) ? { ...component, ...patch } : component),
    } : screen) }));
  };

  const addComponent = (kind: PrototypeKind) => {
    if (!currentScreen || currentScreen.components.length >= 500) return;
    const component = { id: uid(), ...defaults(kind, currentScreen.components.length) };
    if (commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => screen.id === currentScreen.id ? { ...screen, components: [...screen.components, component] } : screen) }))) {
      setSelectedIds([component.id]);
    }
  };

  const addScreen = () => {
    if (stored.current.screens.length >= 100) return;
    const screen: PrototypeScreen = { id: uid(), name: `页面 ${stored.current.screens.length + 1}`, width: 640, height: 480, background: "#0f202b", components: [] };
    if (commit((draft) => ({ ...draft, screens: [...draft.screens, screen] }))) {
      setScreenId(screen.id);
      setSelectedIds([]);
    }
  };

  const deleteSelected = useCallback(() => {
    if (!currentScreen || editableSelectedIds.length === 0) return;
    const ids = new Set(editableSelectedIds);
    if (commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => screen.id === currentScreen.id ? {
      ...screen, components: screen.components.filter((component) => !ids.has(component.id) || !isEditablePrototypeComponent(component)),
    } : screen) }))) setSelectedIds([]);
  }, [commit, currentScreen, editableSelectedIds]);

  const undo = useCallback(() => {
    if (preview || loadStatus !== "ready" || !undoStack.length) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack((items) => [...items, clonePrototypeDraft(storedRef.current.current)].slice(-PROTOTYPE_HISTORY_LIMIT));
    setStored((value) => ({ ...value, current: clonePrototypeDraft(previous) }));
  }, [loadStatus, preview, undoStack]);

  const redo = useCallback(() => {
    if (preview || loadStatus !== "ready" || !redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack((items) => [...items, clonePrototypeDraft(storedRef.current.current)].slice(-PROTOTYPE_HISTORY_LIMIT));
    setStored((value) => ({ ...value, current: clonePrototypeDraft(next) }));
  }, [loadStatus, preview, redoStack]);

  const saveDraft = useCallback(async () => {
    if (preview || loadStatus !== "ready" || saving || saveUnknown) return;
    const generation = generationRef.current;
    const snapshot = clonePrototypeDraft(storedRef.current.current);
    const fingerprint = prototypeFingerprint(snapshot);
    setSaving(true);
    setSaveError("");
    setConflict(false);
    try {
      const persisted = await api.savePrototypeDraft(props.diagramId, {
        current: snapshot,
        versions: storedRef.current.versions,
        expectedUpdatedAt: serverUpdatedAt,
      });
      if (generation !== generationRef.current) return;
      const normalizedRemote = normalizePrototypeStored(persisted);
      const remote = { current: normalizedRemote.current, versions: normalizedRemote.versions };
      setServerUpdatedAt(persisted.updatedAt);
      setSavedFingerprint(fingerprint);
      setSaveUnknown(false);
      setStored((value) => prototypeFingerprint(value.current) === fingerprint
        ? remote
        : { current: value.current, versions: remote.versions });
      setNotice(prototypeFingerprint(storedRef.current.current) === fingerprint ? "草稿已保存" : "较早编辑已保存；仍有新修改待保存");
    } catch (error) {
      if (generation !== generationRef.current) return;
      const message = error instanceof Error ? error.message : "草稿保存失败";
      const isConflict = /HTTP 409/.test(message);
      setConflict(isConflict);
      setSaveUnknown(!isConflict);
      setSaveError(isConflict ? "服务器草稿已变化；本地修改已完整保留" : `保存结果未知：${message}。重新加载服务器核对后再保存。`);
    } finally {
      if (generation === generationRef.current) setSaving(false);
    }
  }, [loadStatus, preview, props.diagramId, saveUnknown, saving, serverUpdatedAt]);

  const reloadServer = () => {
    if (preview || saving) return;
    if ((dirty || conflict) && !window.confirm("重新加载服务器草稿会放弃当前未保存修改，是否继续？")) return;
    setReloadKey((value) => value + 1);
  };

  const restoreVersion = () => {
    const version = stored.versions.find((item) => item.updatedAt === versionId);
    if (!version || preview) return;
    if (dirty && !window.confirm("恢复版本会替换当前未保存草稿，是否继续？")) return;
    const restored = { ...clonePrototypeDraft(version), updatedAt: stored.current.updatedAt };
    if (commit(() => restored)) {
      setScreenId(restored.screens[0]?.id ?? "");
      setSelectedIds([]);
    }
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify(stored, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `prototype-${props.diagramId}-local.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const attemptClose = useCallback(() => {
    if (saving) { setNotice("保存进行中，请等待请求结束"); return false; }
    if (dirty && !window.confirm("放弃未保存修改并关闭页面原型设计器？")) return false;
    props.onClose();
    return true;
  }, [dirty, props.onClose, saving]);

  const closeGuardRef = useRef(attemptClose);
  closeGuardRef.current = attemptClose;

  useEffect(() => {
    const navigationGuard = () => closeGuardRef.current();
    document.body.dataset.prototypeOpen = "true";
    window.__productDesignPrototypeGuard = navigationGuard;
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      delete document.body.dataset.prototypeOpen;
      if (window.__productDesignPrototypeGuard === navigationGuard) delete window.__productDesignPrototypeGuard;
      openerRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !saving) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, saving]);

  useEffect(() => {
    const cancelPointerGesture = (event: KeyboardEvent) => {
      const gesture = gestureRef.current;
      if (event.key !== "Escape" || !gesture) return;
      event.preventDefault();
      event.stopPropagation();
      gestureRef.current = null;
      const nextStored = { ...storedRef.current, current: gesture.before };
      storedRef.current = nextStored;
      setStored(nextStored);
    };
    window.addEventListener("keydown", cancelPointerGesture, true);
    return () => window.removeEventListener("keydown", cancelPointerGesture, true);
  }, []);

  const changeLayer = (componentId: string, patch: Partial<PrototypeComponent>) => {
    if (!currentScreen) return;
    commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => screen.id === currentScreen.id ? {
      ...screen,
      components: screen.components.map((component) => component.id === componentId ? { ...component, ...patch } : component),
    } : screen) }));
  };

  const moveLayer = (componentId: string, direction: -1 | 1) => {
    if (!currentScreen) return;
    const index = currentScreen.components.findIndex((component) => component.id === componentId);
    const component = currentScreen.components[index];
    const target = index + direction;
    if (!component || component.locked || target < 0 || target >= currentScreen.components.length) return;
    commit((draft) => ({ ...draft, screens: draft.screens.map((screen) => {
      if (screen.id !== currentScreen.id) return screen;
      const components = [...screen.components];
      [components[index], components[target]] = [components[target], components[index]];
      return { ...screen, components };
    }) }));
  };

  const align = (alignment: PrototypeAlignment) => {
    if (!currentScreen || editableSelectedIds.length < 2) return;
    commit((draft) => alignPrototypeComponents(draft, currentScreen.id, editableSelectedIds, alignment));
  };

  const commitActiveField = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dialogRef.current?.contains(active) && isEditableTarget(active)) active.blur();
  };

  const beginGesture = (event: ReactPointerEvent<HTMLElement>, component: PrototypeComponent, type: Gesture["type"]) => {
    if (!event.isPrimary || event.button !== 0) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview || loadStatus !== "ready" || !currentScreen || !isEditablePrototypeComponent(component)) return;
    event.stopPropagation();
    event.preventDefault();
    commitActiveField();
    const focusTarget = event.currentTarget.closest<HTMLElement>(".prototype-component") ?? event.currentTarget;
    focusTarget.focus({ preventScroll: true });
    if (event.shiftKey && type === "move") {
      setSelectedIds((ids) => ids.includes(component.id) ? ids.filter((id) => id !== component.id) : [...ids, component.id]);
      return;
    }
    const ids = type === "resize"
      ? [component.id]
      : selectedIds.includes(component.id) ? editableSelectedIds : [component.id];
    if (!selectedIds.includes(component.id)) setSelectedIds([component.id]);
    event.currentTarget.setPointerCapture(event.pointerId);
    const scroll = stageScrollRef.current;
    gestureRef.current = {
      type,
      pointerId: event.pointerId,
      screenId: currentScreen.id,
      componentId: component.id,
      ids,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: scroll?.scrollLeft ?? 0,
      startScrollTop: scroll?.scrollTop ?? 0,
      before: clonePrototypeDraft(storedRef.current.current),
    };
  };

  const updateGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const scroll = stageScrollRef.current;
    const dx = (event.clientX - gesture.startX + (scroll?.scrollLeft ?? 0) - gesture.startScrollLeft) / zoom;
    const dy = (event.clientY - gesture.startY + (scroll?.scrollTop ?? 0) - gesture.startScrollTop) / zoom;
    const next = gesture.type === "move"
      ? movePrototypeComponents(gesture.before, gesture.screenId, gesture.ids, dx, dy)
      : {
        ...gesture.before,
        screens: gesture.before.screens.map((screen) => screen.id === gesture.screenId ? {
          ...screen,
          components: screen.components.map((component) => component.id === gesture.componentId && isEditablePrototypeComponent(component)
            ? {
              ...component,
              w: Math.max(1, Math.min(4096, component.w + dx)),
              h: Math.max(1, Math.min(4096, component.h + dy)),
            }
            : component),
        } : screen),
      };
    setStored((value) => ({ ...value, current: next }));
  };

  const finishGesture = (cancel = false, pointerId?: number) => {
    const gesture = gestureRef.current;
    if (!gesture || (pointerId !== undefined && gesture.pointerId !== pointerId)) return;
    gestureRef.current = null;
    if (cancel) {
      setStored((value) => ({ ...value, current: gesture.before }));
      return;
    }
    if (prototypeFingerprint(gesture.before) !== prototypeFingerprint(storedRef.current.current)) {
      setUndoStack((items) => [...items, gesture.before].slice(-PROTOTYPE_HISTORY_LIMIT));
      setRedoStack([]);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex='-1'])") ?? [])]
        .filter((element) => !element.hidden && element.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      event.stopPropagation();
      return;
    }
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (isEditableTarget(event.target)) (event.target as HTMLElement).blur();
      window.setTimeout(() => void saveDraft(), 0);
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (gestureRef.current && event.key === "Escape") { event.preventDefault(); finishGesture(true); return; }
    if (preview) return;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelectedIds(currentScreen?.components.filter(isEditablePrototypeComponent).map((component) => component.id) ?? []);
      return;
    }
    if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) { event.preventDefault(); redo(); return; }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelected(); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      if (selectedIds.length) setSelectedIds([]); else attemptClose();
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const delta = arrows[event.key];
    if (delta && currentScreen && editableSelectedIds.length) {
      event.preventDefault();
      const distance = event.shiftKey ? 10 : 1;
      commit((draft) => movePrototypeComponents(draft, currentScreen.id, editableSelectedIds, delta[0] * distance, delta[1] * distance));
    }
  };

  const togglePreview = () => {
    if (preview) setPreview(false);
    else { setPreviewScreenId(screenId); setPreview(true); }
  };

  const nextScreen = () => {
    if (preview) setPreviewScreenId(nextPrototypeScreenId(stored.current.screens, currentScreen?.id ?? ""));
    else { setScreenId(nextPrototypeScreenId(stored.current.screens, currentScreen?.id ?? "")); setSelectedIds([]); }
  };

  const canvasStyle: CSSProperties = {
    width: currentScreen?.width ?? 640,
    height: currentScreen?.height ?? 480,
    backgroundColor: currentScreen?.background ?? "#0f202b",
    transform: `scale(${zoom})`,
    transformOrigin: "0 0",
  };

  return <div
    ref={dialogRef}
    className="prototype-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="应用页面原型设计器"
    onKeyDown={onKeyDown}
  >
    <header className="prototype-topbar">
      <button className="btn btn-ghost btn-sm" onClick={attemptClose}><ChevronLeft size={15} />返回画布</button>
      <div className="prototype-title"><span>APP PROTOTYPE</span><strong>{props.title}</strong></div>
      <div className="prototype-save-state" data-state={conflict ? "conflict" : saving ? "saving" : dirty ? "dirty" : "clean"}>
        {loadStatus === "loading" ? "加载中" : conflict ? "保存冲突" : saving ? "保存中" : dirty ? "有未保存修改" : "已保存"}
      </div>
      <div className="prototype-actions">
        <button className="btn btn-ghost btn-sm" disabled={preview || loadStatus === "loading"} onClick={undo} title="撤销"><Undo2 size={14} />{undoStack.length}</button>
        <button className="btn btn-ghost btn-sm" disabled={preview || loadStatus === "loading"} onClick={redo} title="重做"><Redo2 size={14} />{redoStack.length}</button>
        <button className={`btn btn-ghost btn-sm ${preview ? "active" : ""}`} disabled={loadStatus === "loading"} onClick={togglePreview}><Eye size={14} />{preview ? "退出预览" : "只读预览"}</button>
        {!preview ? <button className="btn btn-primary btn-sm" disabled={saving || saveUnknown || loadStatus !== "ready" || !dirty} onClick={() => void saveDraft()}><Save size={14} />{saving ? "保存中…" : "保存草稿"}</button> : null}
        <button className="btn btn-ghost btn-icon" aria-label="关闭原型设计器" onClick={attemptClose}><X size={16} /></button>
      </div>
    </header>
    <div className="prototype-body">
      <aside className="prototype-sidebar" aria-label="页面、组件和图层">
        <div className="prototype-panel-heading"><span>页面</span>{!preview ? <button className="btn btn-ghost btn-icon" title="新增页面" disabled={loadStatus !== "ready"} onClick={addScreen}><Plus size={15} /></button> : null}</div>
        <div className="prototype-screens">{stored.current.screens.map((screen) => <button key={screen.id} className={screen.id === currentScreen?.id ? "active" : ""} onClick={() => {
          if (preview) setPreviewScreenId(screen.id); else { setScreenId(screen.id); setSelectedIds([]); }
        }}><span>{screen.name}</span><small>{screen.components.length} 个组件</small></button>)}</div>
        {!preview ? <>
          <div className="prototype-panel-heading"><span>组件</span><small>点击添加组件，再拖动调整位置</small></div>
          <div className="prototype-palette">{(Object.keys(LABELS) as PrototypeKind[]).map((kind) => <button key={kind} disabled={loadStatus !== "ready"} onClick={() => addComponent(kind)}><span className="prototype-palette-icon">{kind === "text" ? <Type size={14} /> : kind === "image" ? <ImageIcon size={14} /> : kind === "card" ? <Square size={14} /> : <MousePointer2 size={14} />}</span>{LABELS[kind]}</button>)}</div>
        </> : null}
        <div className="prototype-panel-heading"><span>图层</span><small>顶层在前</small></div>
        <div className="prototype-layers">{[...(currentScreen?.components ?? [])].reverse().map((component) => {
          const originalIndex = currentScreen?.components.findIndex((item) => item.id === component.id) ?? -1;
          const canSelect = !preview && isEditablePrototypeComponent(component);
          return <div key={component.id} className={`prototype-layer ${selectedIds.includes(component.id) ? "active" : ""} ${component.hidden ? "is-hidden" : ""} ${component.locked ? "is-locked" : ""}`}>
            <button className="prototype-layer-name" disabled={!canSelect} onClick={(event) => {
              if (event.shiftKey) setSelectedIds((ids) => ids.includes(component.id) ? ids.filter((id) => id !== component.id) : [...ids, component.id]);
              else setSelectedIds([component.id]);
            }}><strong>{LABELS[component.kind]}</strong><span>{component.text.slice(0, 18) || "未命名"}</span></button>
            {!preview ? <div className="prototype-layer-actions">
              <button aria-label={component.hidden ? "显示图层" : "隐藏图层"} onClick={() => changeLayer(component.id, { hidden: !component.hidden })}>{component.hidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
              <button aria-label={component.locked ? "解锁图层" : "锁定图层"} onClick={() => changeLayer(component.id, { locked: !component.locked })}>{component.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
              <button aria-label="上移图层" disabled={Boolean(component.locked) || originalIndex >= (currentScreen?.components.length ?? 0) - 1} onClick={() => moveLayer(component.id, 1)}><ChevronUp size={13} /></button>
              <button aria-label="下移图层" disabled={Boolean(component.locked) || originalIndex <= 0} onClick={() => moveLayer(component.id, -1)}><ChevronDown size={13} /></button>
            </div> : null}
          </div>;
        })}</div>
        <div className="prototype-panel-heading"><span>草稿版本</span></div>
        <select className="prototype-version-select" value={versionId} disabled={preview} onChange={(event) => setVersionId(event.target.value)}>
          <option value="">选择历史版本</option>
          {stored.versions.map((version) => <option key={version.updatedAt} value={version.updatedAt}>{formatDateTime(version.updatedAt)}</option>)}
        </select>
        {!preview ? <button className="btn btn-ghost btn-sm prototype-restore" disabled={!versionId || loadStatus !== "ready"} onClick={restoreVersion}><RotateCcw size={13} />恢复此版本到草稿</button> : null}
      </aside>
      <main className={`prototype-stage ${preview ? "is-preview" : ""}`}>
        {(saveError || cacheWarning || notice) ? <div className={`prototype-banner ${saveError ? "is-error" : ""}`} role={saveError ? "alert" : "status"}>
          <span>{saveError || cacheWarning || notice}</span>
          {!preview && conflict ? <><button className="btn btn-ghost btn-sm" onClick={exportBackup}><Download size={13} />导出本地 JSON</button><button className="btn btn-ghost btn-sm" onClick={reloadServer}>重新加载服务器</button></> : null}
          {!preview && saveUnknown && !conflict ? <button className="btn btn-ghost btn-sm" onClick={reloadServer}>重新加载服务器核对</button> : null}
          {!preview && loadStatus === "error" && !conflict ? <button className="btn btn-ghost btn-sm" onClick={reloadServer}>重试加载</button> : null}
        </div> : null}
        <div className="prototype-stage-toolbar">
          <strong>{currentScreen?.name ?? "未命名页面"}</strong>
          <span>{preview ? "只读预览 · 按钮可模拟页面跳转" : "拖动组件或右下角手柄直接调整"}</span>
          <div className="prototype-zoom">
            <button aria-label="缩小" onClick={() => setZoom((value) => Math.max(PROTOTYPE_ZOOM_MIN, ZOOM_STEPS.filter((step) => step < value).at(-1) ?? PROTOTYPE_ZOOM_MIN))}><ZoomOut size={14} /></button>
            <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button aria-label="放大" onClick={() => setZoom((value) => Math.min(PROTOTYPE_ZOOM_MAX, ZOOM_STEPS.find((step) => step > value) ?? PROTOTYPE_ZOOM_MAX))}><ZoomIn size={14} /></button>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={nextScreen}><Link2 size={13} />下一页</button>
        </div>
        <div ref={stageScrollRef} className="prototype-stage-scroll">
          <div className="prototype-canvas-scale" style={{ width: (currentScreen?.width ?? 640) * zoom, height: (currentScreen?.height ?? 480) * zoom }}>
            <div className="prototype-canvas" tabIndex={-1} style={canvasStyle} onPointerDown={(event) => {
              if (event.target !== event.currentTarget || preview || !event.isPrimary || event.button !== 0) return;
              commitActiveField();
              setSelectedIds([]);
              event.currentTarget.focus({ preventScroll: true });
            }}>
              {(currentScreen?.components ?? []).filter((component) => !component.hidden).map((component) => {
                const style: CSSProperties = {
                  left: component.x,
                  top: component.y,
                  width: component.w,
                  height: component.h,
                  color: component.textColor,
                  background: component.fill,
                  borderColor: component.borderColor,
                  borderWidth: component.borderWidth,
                  borderRadius: component.borderRadius,
                  opacity: component.opacity,
                  fontSize: component.fontSize,
                  objectFit: component.imageFit,
                };
                return <div
                  key={component.id}
                  role={preview && component.kind === "button" ? "button" : undefined}
                  tabIndex={preview && component.kind === "button" ? 0 : -1}
                  className={`prototype-component prototype-component-${component.kind} ${selectedIds.includes(component.id) ? "selected" : ""} ${component.locked ? "locked" : ""}`}
                  style={style}
                  onPointerDown={(event) => beginGesture(event, component, "move")}
                  onPointerMove={updateGesture}
                  onPointerUp={(event) => finishGesture(false, event.pointerId)}
                  onPointerCancel={(event) => finishGesture(true, event.pointerId)}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (preview && component.kind === "button") setPreviewScreenId(prototypePreviewTarget(stored.current.screens, currentScreen?.id ?? "", component.kind));
                  }}
                  onKeyDown={(event) => {
                    if (preview && component.kind === "button" && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setPreviewScreenId(prototypePreviewTarget(stored.current.screens, currentScreen?.id ?? "", component.kind));
                    }
                  }}
                >
                  {component.kind === "image" ? <PrototypeImage component={component} /> : component.text}
                  {!preview && selectedIds.length === 1 && selectedIds[0] === component.id && !component.locked
                    ? <span className="prototype-resize-handle" role="button" aria-label="调整组件尺寸" onPointerDown={(event) => beginGesture(event, component, "resize")} />
                    : null}
                </div>;
              })}
              {(currentScreen?.components ?? []).filter((component) => !component.hidden).length === 0 ? <div className="prototype-empty">从左侧点击添加组件，再拖动调整位置</div> : null}
            </div>
          </div>
        </div>
      </main>
      <aside className="prototype-inspector" aria-label="属性">
        <div className="prototype-panel-heading"><span>属性</span>{selected ? <small>{LABELS[selected.kind]}</small> : selectedIds.length > 1 ? <small>{selectedIds.length} 项</small> : <small>页面</small>}</div>
        {preview ? <div className="prototype-inspector-empty">预览模式只允许页面导航和缩放，不会修改草稿。</div> : selected ? <>
          <CommitField label="内容 / 替代文本" value={selected.text} onCommit={(value) => { if (value.length > 2000) return "最多 2000 字"; updateSelected({ text: value }); }} />
          <div className="prototype-field-grid">
            {(["x", "y", "w", "h"] as const).map((key) => <CommitField key={key} label={key.toUpperCase()} type="number" value={selected[key]} min={key === "w" || key === "h" ? 1 : -100000} max={key === "w" || key === "h" ? 4096 : 100000} onCommit={(value) => {
              const number = Number(value);
              const min = key === "w" || key === "h" ? 1 : -100000;
              const max = key === "w" || key === "h" ? 4096 : 100000;
              if (!Number.isFinite(number) || number < min || number > max) return `${min}—${max}`;
              updateSelected({ [key]: number });
            }} />)}
          </div>
          <div className="prototype-field-grid">
            <CommitField label="文字颜色" value={selected.textColor ?? "#d8edf8"} onCommit={(value) => {
              if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
              updateSelected({ textColor: value });
            }} />
            <CommitField label="字号" type="number" value={selected.fontSize ?? 14} min={8} max={120} onCommit={(value) => {
              const number = Number(value); if (!Number.isFinite(number) || number < 8 || number > 120) return "8—120"; updateSelected({ fontSize: number });
            }} />
            <CommitField label="填充" value={selected.fill ?? "transparent"} onCommit={(value) => {
              if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
              updateSelected({ fill: value });
            }} />
            <CommitField label="边框颜色" value={selected.borderColor ?? "#507287"} onCommit={(value) => {
              if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent";
              updateSelected({ borderColor: value });
            }} />
            <CommitField label="边框宽" type="number" value={selected.borderWidth ?? 1} min={0} max={20} onCommit={(value) => {
              const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 20) return "0—20"; updateSelected({ borderWidth: number });
            }} />
            <CommitField label="圆角" type="number" value={selected.borderRadius ?? 7} min={0} max={2048} onCommit={(value) => {
              const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 2048) return "0—2048"; updateSelected({ borderRadius: number });
            }} />
            <CommitField label="透明度" type="number" step={0.05} value={selected.opacity ?? 1} min={0} max={1} onCommit={(value) => {
              const number = Number(value); if (!Number.isFinite(number) || number < 0 || number > 1) return "0—1"; updateSelected({ opacity: number });
            }} />
          </div>
          {selected.kind === "image" ? <>
            <CommitField label="图片 HTTP(S) 地址" value={selected.imageUrl ?? ""} onCommit={(value) => {
              if (value.length > 2000) return "最多 2000 字";
              if (value) { try { if (!["http:", "https:"].includes(new URL(value).protocol)) return "仅允许 HTTP(S)"; } catch { return "请输入绝对地址"; } }
              updateSelected({ imageUrl: value });
            }} />
            <label>图片适应<select value={selected.imageFit ?? "contain"} onChange={(event) => updateSelected({ imageFit: event.target.value as "contain" | "cover" })}><option value="contain">完整显示</option><option value="cover">裁切铺满</option></select></label>
          </> : null}
          <button className="btn btn-danger btn-sm prototype-delete" onClick={deleteSelected}>删除组件</button>
        </> : selectedIds.length > 1 ? <>
          <div className="prototype-selection-summary">已选择 {editableSelectedIds.length} 个可编辑组件</div>
          <div className="prototype-align-grid">
            <button onClick={() => align("left")}>左对齐</button><button onClick={() => align("hcenter")}>水平居中</button><button onClick={() => align("right")}>右对齐</button>
            <button onClick={() => align("top")}>顶对齐</button><button onClick={() => align("vcenter")}>垂直居中</button><button onClick={() => align("bottom")}>底对齐</button>
          </div>
          <button className="btn btn-danger btn-sm prototype-delete" onClick={deleteSelected}>删除所选</button>
        </> : currentScreen ? <>
          <CommitField label="页面名称" value={currentScreen.name} onCommit={(value) => {
            const name = value.trim(); if (!name || name.length > 200) return "请输入 1—200 字"; updateScreen({ name });
          }} />
          <div className="prototype-field-grid">
            <CommitField label="画板宽" type="number" value={currentScreen.width ?? 640} min={100} max={4096} onCommit={(value) => {
              const number = Number(value); if (!Number.isInteger(number) || number < 100 || number > 4096) return "100—4096 整数"; updateScreen({ width: number });
            }} />
            <CommitField label="画板高" type="number" value={currentScreen.height ?? 480} min={100} max={4096} onCommit={(value) => {
              const number = Number(value); if (!Number.isInteger(number) || number < 100 || number > 4096) return "100—4096 整数"; updateScreen({ height: number });
            }} />
          </div>
          <CommitField label="画板背景" value={currentScreen.background ?? "#0f202b"} onCommit={(value) => {
            if (value !== "transparent" && !/^#[0-9a-fA-F]{6}$/.test(value)) return "#RRGGBB 或 transparent"; updateScreen({ background: value });
          }} />
          <div className="prototype-inspector-empty">未选择组件时编辑页面画板。缩放只改变视图，不写入草稿。</div>
        </> : <div className="prototype-inspector-empty">暂无页面</div>}
      </aside>
    </div>
  </div>;
}
