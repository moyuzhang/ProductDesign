/**
 * 图层面板（节点 whiteboard-layers-templates，设计 9.1）。
 *
 * 边界（设计 9.1 必须写清的会话态/落库态边界）：
 *   - 落库：layers.locked/hidden 与 itemOverrides（交付节点/连线的 locked/hidden/layerId）；
 *   - 只存会话：面板宽度、折叠、悬停高亮、当前聚焦行——一律不进 API body。
 *
 * 真源唯一（设计 3.6）：面板不持久化图层副本，挂载即 GET /layers；任何写操作成功后
 * 以响应体（服务端返回的完整 state）整体覆盖本地状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { Eye, EyeOff, GripVertical, Layers, Lock, Plus, Trash2, Unlock } from "lucide-react";
import type { Diagram, DiagramLayer, DiagramLayerState, FreeformDocument } from "../../shared/types";
import {
  addLayer,
  buildLayerIndex,
  layerMemberKeys,
  removeLayer,
  renameLayer,
  reorderLayers,
  selectLayerMembers,
  setLayerFlag,
  type LayerReorderAction,
} from "../../shared/layers";
import { api, WhiteboardConflictError } from "../api";

export interface DiagramLayerPanelProps {
  diagramId: string;
  /** 画布内容（只读）：用于派生图层成员集合与有效锁定/隐藏判定。 */
  diagram: Pick<Diagram, "nodes" | "edges">;
  /** 自由层文档（只读）：自由元素的 locked/hidden 权威在自由层文档（设计 2.2）。 */
  freeform?: Pick<FreeformDocument, "elements"> | null;
  /** 面板当前宽度（仅会话态，由宿主记忆；不落库）。 */
  width?: number;
  onClose?: () => void;
  /** 图层状态写入成功后回调宿主（宿主据此刷新画布渲染与本地 layers）。 */
  onLayersChanged?: (state: DiagramLayerState, diagramUpdatedAt: string) => void;
  /** 批量选择结果（itemKey 集合，§3.5）。 */
  onSelectionChange?: (itemKeys: string[]) => void;
}

type SectionId = "node" | "edge" | "freeform" | "custom";

const SECTIONS: ReadonlyArray<{ id: SectionId; title: string }> = [
  { id: "node", title: "交付节点" },
  { id: "edge", title: "连线" },
  { id: "freeform", title: "自由元素" },
  { id: "custom", title: "自定义层" },
];

/** 分区判据：系统层按 memberKind，其余（含 ly_ 前缀）一律自定义层；禁止把交付节点与自由元素混排。 */
function sectionOf(layer: DiagramLayer): SectionId {
  if (layer.kind === "custom") return "custom";
  if (layer.memberKind === "node") return "node";
  if (layer.memberKind === "edge") return "edge";
  return "freeform";
}

/** 拖拽落位：用既有 reorderLayers 的四个操作逐步逼近目标索引，不新增第二套排序算法。 */
function moveLayerTo(state: DiagramLayerState, layerId: string, targetIndex: number): DiagramLayerState {
  let next = state;
  for (let step = 0; step <= state.layers.length; step += 1) {
    const from = next.layers.findIndex((layer) => layer.id === layerId);
    if (from < 0 || from === targetIndex) break;
    next = reorderLayers(next, layerId, from < targetIndex ? "forward" : "backward");
  }
  return next;
}

const nowIso = (): string => new Date().toISOString();

export function DiagramLayerPanel(props: DiagramLayerPanelProps): ReactElement {
  const { diagramId, diagram } = props;
  const [state, setState] = useState<DiagramLayerState | null>(null);
  // 自由元素权威在自由层文档（设计 3.6）：宿主未注入时由面板自行读取，只读不写。
  const [freeformDoc, setFreeformDoc] = useState<Pick<FreeformDocument, "elements"> | null>(props.freeform ?? null);
  const updatedAtRef = useRef<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [focusedLayerId, setFocusedLayerId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [draggingId, setDraggingId] = useState("");
  const [dropTargetId, setDropTargetId] = useState("");
  const writingRef = useRef(false);

  useEffect(() => {
    if (props.freeform !== undefined) { setFreeformDoc(props.freeform); return; }
    let active = true;
    api.getFreeformDocument(diagramId)
      .then((document) => { if (active) setFreeformDoc(document ? { elements: document.elements } : null); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [diagramId, props.freeform]);

  const index = useMemo(
    () => buildLayerIndex({ diagram: { nodes: diagram.nodes, edges: diagram.edges }, freeform: freeformDoc }),
    [diagram.nodes, diagram.edges, freeformDoc],
  );

  const load = useCallback(() => {
    setLoading(true);
    api.getDiagramLayers(diagramId)
      .then((response) => {
        setState({ schemaVersion: response.schemaVersion, layers: response.layers, itemOverrides: response.itemOverrides });
        updatedAtRef.current = response.diagramUpdatedAt;
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "图层读取失败"))
      .finally(() => setLoading(false));
  }, [diagramId]);

  useEffect(() => { load(); }, [load]);

  /** 乐观更新 + 失败回滚 + 冲突提示（设计 8.2）。任何写成功后以响应体整体覆盖本地状态。 */
  const persist = useCallback((mutate: (current: DiagramLayerState) => DiagramLayerState, announcement: (next: DiagramLayerState) => string) => {
    if (writingRef.current) return;
    setState((previous) => {
      if (!previous) return previous;
      const next = mutate(previous);
      if (next === previous) return previous;
      writingRef.current = true;
      api.updateDiagramLayers(diagramId, {
        schemaVersion: 1,
        layers: next.layers,
        itemOverrides: next.itemOverrides,
        expectedUpdatedAt: updatedAtRef.current || null,
      })
        .then((response) => {
          const confirmed: DiagramLayerState = { schemaVersion: response.schemaVersion, layers: response.layers, itemOverrides: response.itemOverrides };
          setState(confirmed);
          updatedAtRef.current = response.diagramUpdatedAt;
          setError("");
          setNotice(announcement(confirmed));
          props.onLayersChanged?.(confirmed, response.diagramUpdatedAt);
        })
        .catch((reason: unknown) => {
          setState(previous);
          if (reason instanceof WhiteboardConflictError) {
            setError(`图层状态冲突：服务端已有更新版本（${reason.serverUpdatedAt || "未知"}），已回滚本次操作，请刷新后重试。`);
          } else {
            setError(reason instanceof Error ? reason.message : "图层保存失败");
          }
        })
        .finally(() => { writingRef.current = false; });
      return next;
    });
  }, [diagramId, props]);

  const membersOf = useCallback((layerId: string) => (state ? layerMemberKeys(state, index, layerId) : []), [index, state]);

  const reorder = (layer: DiagramLayer, action: LayerReorderAction) => {
    const label = action === "front" ? "置顶" : action === "back" ? "置底" : action === "forward" ? "前移" : "后移";
    persist((current) => reorderLayers(current, layer.id, action), () => `图层已${label}：${layer.name}`);
  };

  const toggleFlag = (layer: DiagramLayer, flag: "locked" | "hidden") => {
    const value = !layer[flag];
    const count = membersOf(layer.id).length;
    persist(
      (current) => setLayerFlag(current, layer.id, flag, value, nowIso()),
      () => flag === "locked"
        ? `${value ? "已锁定" : "已解锁"}图层：${layer.name}`
        : `${value ? `已隐藏图层：${layer.name}（含 ${count} 项）` : `已显示图层：${layer.name}`}`,
    );
  };

  const commitRename = (layer: DiagramLayer, raw: string) => {
    setRenamingId("");
    const name = raw.trim();
    if (!name || name === layer.name) return;
    const duplicated = (state?.layers ?? []).some((item) => item.id !== layer.id && item.name === name);
    if (duplicated) { setError(`图层名称已存在：${name}`); return; }
    persist((current) => renameLayer(current, layer.id, name, nowIso()), () => `已重命名图层为：${name}`);
  };

  const createLayer = () => {
    const base = state?.layers ?? [];
    let seq = base.filter((layer) => layer.kind === "custom").length + 1;
    let name = `自定义层 ${seq}`;
    while (base.some((layer) => layer.name === name)) { seq += 1; name = `自定义层 ${seq}`; }
    persist((current) => addLayer(current, name, { now: nowIso() }), () => `已新建图层：${name}`);
  };

  const dropLayer = (layer: DiagramLayer) => {
    if (!window.confirm(`确认删除图层「${layer.name}」？该层成员将回落到默认系统层。`)) return;
    persist((current) => removeLayer(current, layer.id), () => `已删除图层：${layer.name}`);
  };

  const selectLayer = (layer: DiagramLayer) => {
    if (!state) return;
    setFocusedLayerId(layer.id);
    const keys = selectLayerMembers(state, index, layer.id);
    props.onSelectionChange?.(keys);
    setNotice(keys.length ? `已选择图层「${layer.name}」的 ${keys.length} 项` : `图层「${layer.name}」没有可选项（已隐藏或已锁定）`);
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, layer: DiagramLayer) => {
    if (event.key === "F2") { event.preventDefault(); setRenamingId(layer.id); setRenameValue(layer.name); return; }
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); selectLayer(layer); return; }
    if (!event.altKey) return;
    if (event.key === "ArrowUp") { event.preventDefault(); reorder(layer, event.shiftKey ? "front" : "forward"); }
    else if (event.key === "ArrowDown") { event.preventDefault(); reorder(layer, event.shiftKey ? "back" : "backward"); }
  };

  const onDrop = (target: DiagramLayer) => {
    setDropTargetId("");
    const sourceId = draggingId;
    setDraggingId("");
    if (!sourceId || sourceId === target.id || !state) return;
    const targetIndex = state.layers.findIndex((layer) => layer.id === target.id);
    if (targetIndex < 0) return;
    const source = state.layers.find((layer) => layer.id === sourceId);
    persist((current) => moveLayerTo(current, sourceId, targetIndex), () => `图层已移动：${source?.name ?? sourceId}`);
  };

  const layers = state?.layers ?? [];
  const rowsBySection = new Map<SectionId, DiagramLayer[]>(SECTIONS.map((section) => [section.id, []]));
  for (const layer of layers) rowsBySection.get(sectionOf(layer))?.push(layer);

  return (
    <section className="layer-panel" style={{ width: props.width ?? 300 }} aria-label="图层面板">
      <header className="layer-panel-head">
        <span className="layer-panel-title"><Layers size={14} /> 图层</span>
        <div className="layer-panel-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={createLayer} title="新建自定义图层（仅承载自由元素）">
            <Plus size={13} /> 新建图层
          </button>
          {props.onClose ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClose} title="关闭图层面板">关闭</button>
          ) : null}
        </div>
      </header>

      {error ? <p className="layer-panel-error" role="alert">{error}</p> : null}
      <p className="layer-panel-status" role="status" aria-live="polite">{notice}</p>

      {loading && !state ? (
        <p className="layer-panel-hint">图层加载中…</p>
      ) : (
        <div className="layer-panel-list" role="listbox" aria-label="图层列表">
          {SECTIONS.map((section) => {
            const rows = rowsBySection.get(section.id) ?? [];
            if (rows.length === 0) return null;
            // 数组序索引 0 为最底层（设计 3.3），列表自上而下按栈顶→栈底展示，
            // 使 Alt+↑「前移」与视觉上移一致。
            const displayRows = [...rows].reverse();
            return (
              <div className="layer-section" key={section.id} role="group" aria-label={section.title}>
                <div className="layer-section-title">{section.title}</div>
                {displayRows.map((layer) => {
                  const members = membersOf(layer.id);
                  const stateText = `${layer.locked ? "已锁定" : "未锁定"}，${layer.hidden ? "已隐藏" : "可见"}`;
                  const dragging = draggingId === layer.id;
                  return (
                    <div
                      key={layer.id}
                      role="option"
                      aria-selected={focusedLayerId === layer.id}
                      aria-label={`${layer.name}，成员 ${members.length} 项，${stateText}`}
                      tabIndex={0}
                      className={`layer-row ${dragging ? "dragging" : ""} ${dropTargetId === layer.id ? "drop-target" : ""}`}
                      draggable
                      onDragStart={() => setDraggingId(layer.id)}
                      onDragEnd={() => { setDraggingId(""); setDropTargetId(""); }}
                      onDragOver={(event) => { event.preventDefault(); setDropTargetId(layer.id); }}
                      onDrop={() => onDrop(layer)}
                      onFocus={() => setFocusedLayerId(layer.id)}
                      onClick={() => setFocusedLayerId(layer.id)}
                      onKeyDown={(event) => onRowKeyDown(event, layer)}
                    >
                      <span className="layer-drag-handle" aria-hidden="true" title="拖拽排序"><GripVertical size={13} /></span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon layer-flag"
                        aria-pressed={layer.hidden}
                        title={layer.hidden ? `显示图层${layer.name}` : `隐藏图层${layer.name}`}
                        onClick={(event) => { event.stopPropagation(); toggleFlag(layer, "hidden"); }}
                      >
                        {layer.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon layer-flag"
                        aria-pressed={layer.locked}
                        title={layer.locked ? `解锁图层${layer.name}` : `锁定图层${layer.name}`}
                        onClick={(event) => { event.stopPropagation(); toggleFlag(layer, "locked"); }}
                      >
                        {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
                      </button>
                      {renamingId === layer.id ? (
                        <input
                          className="layer-rename-input"
                          autoFocus
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === "Enter") commitRename(layer, renameValue);
                            else if (event.key === "Escape") setRenamingId("");
                          }}
                          onBlur={() => commitRename(layer, renameValue)}
                        />
                      ) : (
                        <span
                          className="layer-name"
                          title="双击或按 F2 重命名"
                          onDoubleClick={(event) => { event.stopPropagation(); setRenamingId(layer.id); setRenameValue(layer.name); }}
                        >{layer.name}</span>
                      )}
                      <span className="layer-state">{layer.locked ? "已锁定" : ""}{layer.locked && layer.hidden ? "、" : ""}{layer.hidden ? "已隐藏" : ""}</span>
                      <span className="layer-count" title="该层成员数">{members.length}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm layer-select"
                        title={`全选图层${layer.name}（排除隐藏与锁定项）`}
                        onClick={(event) => { event.stopPropagation(); selectLayer(layer); }}
                      >全选该层</button>
                      {layer.kind === "custom" ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-danger"
                          title={`删除图层${layer.name}`}
                          onClick={(event) => { event.stopPropagation(); dropLayer(layer); }}
                        ><Trash2 size={13} /></button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      <p className="layer-panel-hint">排序：拖拽或 Alt+↑/↓ 前移后移，Alt+Shift+↑/↓ 置顶置底；F2 重命名；空格全选该层。图层状态服务端持久化，面板宽度仅本会话。</p>
    </section>
  );
}