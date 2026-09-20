/**
 * 模板库（节点 whiteboard-layers-templates，设计 9.3）。
 *
 * 数据归属：模板落绑定表 diagram_templates（read/create/update/delete-即软撤销），
 * 与其他画布能力无关；本组件不读写 layers/components 之外的项目数据。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Diagram, DiagramTemplateSummary } from "../../shared/types";
import { SUPPORTED_TEMPLATE_SCHEMA_VERSION, resolveTemplateCompatibility, TEMPLATE_NAME_MAX } from "../../shared/templates";
import { formatDateTime } from "../ui";
import { api, WhiteboardConflictError } from "../api";
import type { DiagramTemplateApplyResponse } from "../api";

export interface DiagramTemplateLibraryProps {
  projectId: string;
  /** 当前画布：作为"从当前画布创建模板"的快照来源。 */
  currentDiagram: Diagram;
  /** 同项目全部画布：作为应用目标（含主画布，用于给出 replace 禁用原因）。 */
  diagrams: Diagram[];
  onClose?: () => void;
  /** 应用成功后回调宿主刷新目标画布。 */
  onApplied?: (result: DiagramTemplateApplyResponse) => void;
}

function deliveryNodeCount(diagram: Diagram): number {
  return diagram.nodes.filter((node) => Boolean(node.requirementStatus || node.designStatus || node.developmentStatus || node.acceptanceStatus)).length;
}

function replaceBlockReason(diagram: Diagram | undefined): string {
  if (!diagram) return "请选择目标画布";
  if (diagram.type === "main") return "主画布不允许 replace";
  if (deliveryNodeCount(diagram) > 0) return "目标画布存在交付状态节点";
  return "";
}

export function DiagramTemplateLibrary(props: DiagramTemplateLibraryProps): ReactElement {
  const { projectId } = props;
  const [templates, setTemplates] = useState<DiagramTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [applyId, setApplyId] = useState("");
  const [applyTarget, setApplyTarget] = useState("");
  const [applyMode, setApplyMode] = useState<"append" | "replace">("append");
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.listDiagramTemplates(projectId)
      .then((response) => {
        const items = Array.isArray(response) ? response : response.items;
        setTemplates(items);
        setError("");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "模板读取失败"))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // 焦点陷阱 + Esc 关闭（设计 9.3 可访问性）。
  useEffect(() => {
    const node = dialogRef.current;
    node?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")?.focus();
  }, []);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); props.onClose?.(); return; }
    if (event.key !== "Tab") return;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = Array.from(node.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const fail = (reason: unknown, fallback: string) => {
    if (reason instanceof WhiteboardConflictError) {
      setError(`${reason.message}（服务端版本 ${reason.serverUpdatedAt || "未知"}），请刷新后重试。`);
    } else {
      setError(reason instanceof Error ? reason.message : fallback);
    }
  };

  const createFromCurrent = () => {
    const name = createName.trim();
    if (!name || busy) return;
    setBusy(true);
    Promise.all([
      api.getDiagram(props.currentDiagram.id),
      api.getDiagramLayers(props.currentDiagram.id),
      api.getFreeformDocument(props.currentDiagram.id),
    ])
      .then(([diagram, layers, freeform]) => {
        const content = {
          schemaVersion: SUPPORTED_TEMPLATE_SCHEMA_VERSION,
          diagram: {
            nodes: diagram.nodes, edges: diagram.edges, groups: diagram.groups,
            layers: { schemaVersion: layers.schemaVersion, layers: layers.layers, itemOverrides: layers.itemOverrides },
          },
          ...(freeform ? { freeform: { elements: freeform.elements, unsupported: freeform.unsupported } } : {}),
          ...(diagram.components ? { components: diagram.components } : {}),
        };
        return api.createDiagramTemplate(projectId, { name, content });
      })
      .then((template) => {
        setNotice(`已创建项目级模板：${template.name}${template.thumbnailWarning ? "（缩略图已降级为占位）" : ""}`);
        setCreateOpen(false);
        setCreateName("");
        setError("");
        load();
      })
      .catch((reason: unknown) => fail(reason, "模板创建失败"))
      .finally(() => setBusy(false));
  };

  const renameTemplate = (template: DiagramTemplateSummary, raw: string) => {
    setRenamingId("");
    const name = raw.trim();
    if (!name || name === template.name || busy) return;
    setBusy(true);
    api.updateDiagramTemplate(template.id, { name, expectedUpdatedAt: template.updatedAt })
      .then((updated) => {
        setTemplates((current) => current.map((item) => (item.id === template.id ? { ...item, name: updated.name, updatedAt: updated.updatedAt } : item)));
        setNotice(`已重命名模板：${updated.name}`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "模板重命名失败"))
      .finally(() => setBusy(false));
  };

  const revokeTemplate = (template: DiagramTemplateSummary) => {
    if (busy) return;
    if (!window.confirm(`确认撤销模板「${template.name}」？已应用的画布内容不受影响。`)) return;
    setBusy(true);
    api.revokeDiagramTemplate(template.id)
      .then(() => {
        setTemplates((current) => current.filter((item) => item.id !== template.id));
        setNotice(`已撤销模板：${template.name}；已应用的画布内容不受影响`);
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "模板撤销失败"))
      .finally(() => setBusy(false));
  };

  const confirmApply = (template: DiagramTemplateSummary) => {
    const target = props.diagrams.find((diagram) => diagram.id === applyTarget);
    if (!target || busy) return;
    if (applyMode === "replace" && !window.confirm(`确认用模板「${template.name}」替换画布「${target.title}」的全部内容？此操作不可撤销。`)) return;
    setBusy(true);
    api.applyDiagramTemplate(target.id, { templateId: template.id, mode: applyMode, expectedUpdatedAt: target.updatedAt })
      .then((result) => {
        props.onApplied?.(result);
        setNotice(
          `已应用模板「${template.name}」到「${target.title}」：新增 ${result.createdNodeIds.length} 节点、${result.createdEdgeIds.length} 连线、${result.createdFreeformIds.length} 自由元素`
          + `${result.migrated ? "；已发生版本迁移（将升级应用）" : ""}`
          + `${result.thumbnailApplied ? "；缩略图已应用" : ""}`
          + `${result.droppedLinkDiagramIds.length ? `；已置空 ${result.droppedLinkDiagramIds.length} 个跨画布关联` : ""}`,
        );
        setApplyId("");
        setError("");
      })
      .catch((reason: unknown) => fail(reason, "模板应用失败"))
      .finally(() => setBusy(false));
  };

  const sections = useMemo(() => ([
    { id: "system" as const, title: "系统内置", rows: templates.filter((template) => template.scope === "system") },
    { id: "project" as const, title: "项目级", rows: templates.filter((template) => template.scope === "project") },
  ]), [templates]);

  return (
    <div className="modal-overlay" onMouseDown={props.onClose}>
      <div
        ref={dialogRef}
        className="modal template-library"
        style={{ width: 880 }}
        role="dialog"
        aria-modal="true"
        aria-label="模板库"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="modal-header">
          <h3>模板库 · {props.currentDiagram.title}</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={props.onClose} aria-label="关闭">✕</button>
        </div>
        <div className="modal-body">
          <div className="template-toolbar">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => { setCreateOpen(true); setCreateName(`${props.currentDiagram.title} 模板`); }}
            ><Plus size={13} /> 从当前画布创建模板</button>
            <span className="layer-panel-hint">系统内置模板只读；项目级模板可重命名与撤销（软撤销，不物理删除）。</span>
          </div>

          {createOpen ? (
            <div className="template-create" role="group" aria-label="创建模板">
              <input
                autoFocus
                className="layer-rename-input"
                placeholder="模板名称"
                maxLength={TEMPLATE_NAME_MAX}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") createFromCurrent();
                  else if (event.key === "Escape") setCreateOpen(false);
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" disabled={!createName.trim() || busy} onClick={createFromCurrent}>确定</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreateOpen(false)}>取消</button>
            </div>
          ) : null}

          {error ? <p className="layer-panel-error" role="alert" aria-live="assertive">{error}</p> : null}
          <p className="layer-panel-status" role="status" aria-live="polite">{notice}</p>

          {loading && templates.length === 0 ? (
            <p className="layer-panel-hint">模板加载中…</p>
          ) : (
            sections.map((section) => (
              <section className="template-section" key={section.id}>
                <div className="layer-section-title">{section.title}（{section.rows.length}）</div>
                {section.rows.length === 0 ? (
                  <p className="layer-panel-hint">{section.id === "system" ? "本部署未内置系统模板。" : "本项目还没有项目级模板。"}</p>
                ) : (
                  <div role="listbox" aria-label={`${section.title}模板`} className="template-list">
                    {section.rows.map((template) => {
                      const compatibility = resolveTemplateCompatibility(template.schemaVersion);
                      const unsupported = compatibility.status === "unsupported" || compatibility.status === "invalid";
                      const readOnly = template.scope === "system";
                      const target = props.diagrams.find((diagram) => diagram.id === applyTarget);
                      const blockReason = replaceBlockReason(target);
                      const expanded = applyId === template.id;
                      return (
                        <div className="template-row-wrap" key={template.id}>
                          <div className="template-row" role="option" aria-selected={expanded} aria-label={`${template.name}，版本 ${template.schemaVersion}，${unsupported ? "不兼容" : "可应用"}`}>
                            {template.thumbnailMeta.kind === "svg" && template.thumbnailMeta.content ? (
                              <img
                                className="template-thumb"
                                alt=""
                                src={`data:image/svg+xml;utf8,${encodeURIComponent(template.thumbnailMeta.content)}`}
                              />
                            ) : (
                              <span className="template-thumb template-thumb-empty" aria-hidden="true">无缩略图</span>
                            )}
                            <div className="template-main">
                              {renamingId === template.id ? (
                                <input
                                  autoFocus
                                  className="layer-rename-input"
                                  value={renameValue}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.nativeEvent.isComposing) return;
                                    if (event.key === "Enter") renameTemplate(template, renameValue);
                                    else if (event.key === "Escape") setRenamingId("");
                                  }}
                                  onBlur={() => renameTemplate(template, renameValue)}
                                />
                              ) : (
                                <span
                                  className="template-name"
                                  title={readOnly ? "系统内置模板只读" : "双击重命名"}
                                  onDoubleClick={() => { if (!readOnly) { setRenamingId(template.id); setRenameValue(template.name); } }}
                                >{template.name}</span>
                              )}
                              <span className="template-meta mono">{template.schemaVersion} · {formatDateTime(template.updatedAt)}</span>
                            </div>
                            <span className={`template-compat compat-${compatibility.status}`} title={compatibility.reason}>
                              {compatibility.status === "exact" ? "版本一致"
                                : compatibility.status === "downgrade" ? "将升级应用"
                                : "不兼容：需要更新的客户端/服务端版本"}
                            </span>
                            <div className="template-actions">
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={unsupported || busy}
                                title={unsupported ? "版本不兼容，已禁用" : "选择目标画布与模式后应用"}
                                onClick={() => {
                                  setApplyId(expanded ? "" : template.id);
                                  setApplyMode("append");
                                  setApplyTarget(props.diagrams.find((diagram) => diagram.id !== props.currentDiagram.id)?.id ?? props.currentDiagram.id);
                                }}
                              >应用…</button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={readOnly || busy}
                                title={readOnly ? "系统内置模板只读，项目接口不可改写" : "重命名模板"}
                                onClick={() => { setRenamingId(template.id); setRenameValue(template.name); }}
                              >重命名</button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon btn-danger"
                                disabled={readOnly || busy}
                                title={readOnly ? "系统内置模板只读，项目接口不可撤销" : "撤销模板（软撤销）"}
                                onClick={() => revokeTemplate(template)}
                              ><Trash2 size={13} /></button>
                            </div>
                          </div>

                          {expanded ? (
                            <div className="template-apply" role="group" aria-label={`应用模板 ${template.name}`}>
                              <label>
                                <span>目标画布</span>
                                <select aria-label="目标画布" value={applyTarget} onChange={(event) => setApplyTarget(event.target.value)}>
                                  {props.diagrams.map((diagram) => (
                                    <option key={diagram.id} value={diagram.id}>{diagram.title}{diagram.type === "main" ? "（主画布）" : ""}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                <span>模式</span>
                                <select aria-label="应用模式" value={applyMode} onChange={(event) => setApplyMode(event.target.value as "append" | "replace")}>
                                  <option value="append">append（追加，默认）</option>
                                  <option value="replace">replace（替换，需二次确认）</option>
                                </select>
                              </label>
                              {applyMode === "replace" && blockReason ? (
                                <span className="template-block" role="note">{`replace 被禁用：${blockReason}`}</span>
                              ) : null}
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={busy || !applyTarget || (applyMode === "replace" && Boolean(blockReason))}
                                onClick={() => confirmApply(template)}
                              >确认应用</button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setApplyId("")}>取消</button>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}