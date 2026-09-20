/**
 * 组件库（节点 whiteboard-layers-templates，设计 9.2）。
 *
 * 语义边界（设计 4.1/4.4）：定义是快照、实例是副本，二者之间只有 sourceComponentId 溯源，
 * 不存在运行时联动。因此面板必须显式提示"更新组件不会改变已插入的实例"。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Boxes, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import type { DiagramComponentDefinition } from "../../shared/types";
import { COMPONENT_OFFSET_DEFAULT, COMPONENT_NAME_MAX } from "../../shared/components";
import { api, WhiteboardConflictError } from "../api";

export interface DiagramComponentSelection {
  nodeIds: string[];
  edgeIds: string[];
  freeformIds: string[];
}

export interface DiagramComponentLibraryProps {
  diagramId: string;
  /** 画布当前 revision（CAS 基准；写成功后由 onRevisionChanged 推进）。 */
  diagramUpdatedAt: string;
  /** 宿主当前选区（自由层/交付节点/连线可混合）。 */
  selection: DiagramComponentSelection;
  onRevisionChanged?: (diagramUpdatedAt: string) => void;
  /** 实例化成功：宿主据此刷新画布并选中新实例。 */
  onInstanceCreated?: (created: { nodeIds: string[]; edgeIds: string[]; freeformIds: string[] }) => void;
  onClose?: () => void;
}

function memberCount(component: DiagramComponentDefinition): number {
  return component.payload.nodes.length + component.payload.edges.length + (component.payload.freeform?.elements.length ?? 0);
}

export function DiagramComponentLibrary(props: DiagramComponentLibraryProps): ReactElement {
  const { diagramId, selection } = props;
  const [components, setComponents] = useState<DiagramComponentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const revisionRef = useRef(props.diagramUpdatedAt);

  useEffect(() => { revisionRef.current = props.diagramUpdatedAt; }, [props.diagramUpdatedAt]);

  const load = useCallback(() => {
    setLoading(true);
    api.listDiagramComponents(diagramId)
      .then((response) => {
        setComponents(response.components);
        revisionRef.current = response.diagramUpdatedAt;
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "组件读取失败"))
      .finally(() => setLoading(false));
  }, [diagramId]);

  useEffect(() => { load(); }, [load]);

  const selectionSize = selection.nodeIds.length + selection.edgeIds.length + selection.freeformIds.length;

  const fail = (reason: unknown, fallback: string) => {
    if (reason instanceof WhiteboardConflictError) {
      setError(`画布已被其他操作修改（服务端版本 ${reason.serverUpdatedAt || "未知"}），请刷新后重试。`);
    } else {
      setError(reason instanceof Error ? reason.message : fallback);
    }
  };

  const createComponent = () => {
    const name = createName.trim();
    if (!name || busy) return;
    setBusy(true);
    api.createDiagramComponent(diagramId, { name, selection, expectedUpdatedAt: revisionRef.current || null })
      .then((result) => {
        revisionRef.current = result.diagramUpdatedAt;
        props.onRevisionChanged?.(result.diagramUpdatedAt);
        setComponents((current) => [...current, result.component]);
        setNotice(result.droppedEdgeIds.length
          ? `已创建组件：${result.component.name}；丢弃悬空连线 ${result.droppedEdgeIds.length} 条`
          : `已创建组件：${result.component.name}（原画布内容不变）`);
        setCreateOpen(false);
        setCreateName("");
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "组件创建失败"))
      .finally(() => setBusy(false));
  };

  const renameComponent = (component: DiagramComponentDefinition, raw: string) => {
    setRenamingId("");
    const name = raw.trim();
    if (!name || name === component.name || busy) return;
    setBusy(true);
    api.updateDiagramComponent(diagramId, component.id, { name, expectedUpdatedAt: revisionRef.current || null })
      .then((result) => {
        revisionRef.current = result.diagramUpdatedAt;
        props.onRevisionChanged?.(result.diagramUpdatedAt);
        setComponents((current) => current.map((item) => (item.id === component.id ? result.component : item)));
        setNotice(`已重命名组件：${result.component.name}；已插入的实例不受影响`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "组件重命名失败"))
      .finally(() => setBusy(false));
  };

  const rebuildSelection = (component: DiagramComponentDefinition) => {
    if (busy || selectionSize === 0) return;
    setBusy(true);
    api.updateDiagramComponent(diagramId, component.id, { selection, expectedUpdatedAt: revisionRef.current || null })
      .then((result) => {
        revisionRef.current = result.diagramUpdatedAt;
        props.onRevisionChanged?.(result.diagramUpdatedAt);
        setComponents((current) => current.map((item) => (item.id === component.id ? result.component : item)));
        setNotice(`已用当前选区更新组件：${result.component.name}；更新组件不会改变已插入的实例`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "组件更新失败"))
      .finally(() => setBusy(false));
  };

  const insertInstance = (component: DiagramComponentDefinition) => {
    if (busy) return;
    setBusy(true);
    api.instantiateDiagramComponent(diagramId, component.id, {
      offsetX: COMPONENT_OFFSET_DEFAULT, offsetY: COMPONENT_OFFSET_DEFAULT, expectedUpdatedAt: revisionRef.current || null,
    })
      .then((result) => {
        revisionRef.current = result.diagramUpdatedAt;
        props.onRevisionChanged?.(result.diagramUpdatedAt);
        props.onInstanceCreated?.({
          nodeIds: result.createdNodeIds, edgeIds: result.createdEdgeIds, freeformIds: result.createdFreeformIds,
        });
        const total = result.createdNodeIds.length + result.createdEdgeIds.length + result.createdFreeformIds.length;
        setNotice(result.droppedEdgeIds.length
          ? `已插入实例：新增 ${total} 个元素；丢弃悬空连线 ${result.droppedEdgeIds.length} 条`
          : `已插入实例：新增 ${total} 个元素`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "实例插入失败"))
      .finally(() => setBusy(false));
  };

  const removeComponent = (component: DiagramComponentDefinition) => {
    if (busy) return;
    if (!window.confirm(`确认删除组件「${component.name}」？已插入的实例不受影响。`)) return;
    setBusy(true);
    api.deleteDiagramComponent(diagramId, component.id)
      .then((result) => {
        revisionRef.current = result.diagramUpdatedAt;
        props.onRevisionChanged?.(result.diagramUpdatedAt);
        setComponents((current) => current.filter((item) => item.id !== component.id));
        setNotice(`已删除组件：${component.name}；已插入的实例不受影响`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "组件删除失败"))
      .finally(() => setBusy(false));
  };

  return (
    <section className="component-library" aria-label="组件库">
      <header className="layer-panel-head">
        <span className="layer-panel-title"><Boxes size={14} /> 组件</span>
        <div className="layer-panel-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={selectionSize === 0}
            title={selectionSize === 0 ? "请先在画布上选择内容（交付节点/连线/自由元素可混合）" : "用当前选区创建组件快照"}
            onClick={() => { setCreateOpen(true); setCreateName(""); }}
          ><Plus size={13} /> 创建组件</button>
          {props.onClose ? <button type="button" className="btn btn-ghost btn-sm" onClick={props.onClose}>关闭</button> : null}
        </div>
      </header>

      {createOpen ? (
        <div className="component-create" role="dialog" aria-label="创建组件">
          <input
            autoFocus
            className="layer-rename-input"
            placeholder="组件名称"
            maxLength={COMPONENT_NAME_MAX}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") createComponent();
              else if (event.key === "Escape") setCreateOpen(false);
            }}
          />
          <span className="layer-panel-hint">当前选区 {selectionSize} 项</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={!createName.trim() || busy} onClick={createComponent}>确定</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreateOpen(false)}>取消</button>
        </div>
      ) : null}

      {error ? <p className="component-library-error" role="alert">{error}</p> : null}
      <p className="component-library-status" role="status" aria-live="polite">{notice}</p>

      {loading && components.length === 0 ? (
        <p className="layer-panel-hint">组件加载中…</p>
      ) : components.length === 0 ? (
        <p className="layer-panel-hint">本画布暂无组件。选中内容后点击「创建组件」生成可复用快照。</p>
      ) : (
        <ul className="component-list">
          {components.map((component) => (
            <li className="component-row" key={component.id}>
              <span className="component-preview" aria-hidden="true">
                节点 {component.payload.nodes.length} / 连线 {component.payload.edges.length} / 自由 {component.payload.freeform?.elements.length ?? 0}
              </span>
              {renamingId === component.id ? (
                <input
                  autoFocus
                  className="layer-rename-input"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") renameComponent(component, renameValue);
                    else if (event.key === "Escape") setRenamingId("");
                  }}
                  onBlur={() => renameComponent(component, renameValue)}
                />
              ) : (
                <span
                  className="component-name"
                  title="双击重命名"
                  onDoubleClick={() => { setRenamingId(component.id); setRenameValue(component.name); }}
                >{component.name}</span>
              )}
              <span className="layer-count" title="成员总数">{memberCount(component)}</span>
              <div className="component-actions">
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title="插入副本实例（默认偏移 +16,+16）" onClick={() => insertInstance(component)}>
                  <Copy size={13} /> 插入实例
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || selectionSize === 0} title="用当前选区重建组件内容（不改变已插入实例）" onClick={() => rebuildSelection(component)}>
                  <Pencil size={13} /> 重建选区
                </button>
                <button type="button" className="btn btn-ghost btn-icon btn-danger" disabled={busy} title="删除组件（已插入实例不受影响）" onClick={() => removeComponent(component)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="layer-panel-hint">组件是快照，实例是副本：更新组件不会改变已插入的实例，跨画布复用必须显式走模板通道。</p>
    </section>
  );
}