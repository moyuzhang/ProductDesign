import { BookOpen, Link2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
  DesignDoc,
  DocumentReference,
  DocumentReferenceRelationType,
  DocumentReferenceTargetType,
} from "../../shared/types.js";
import { api } from "../api.js";
import { Badge, EmptyState, ErrorBanner, Modal, formatDateTime } from "../ui.js";

const RELATION_LABEL: Record<DocumentReferenceRelationType, string> = {
  defines: "定义依据",
  implements: "施工依据",
  verifies: "验收依据",
  references: "参考资料",
};

export function DocumentReferencePanel(props: {
  projectId: string;
  targetType: DocumentReferenceTargetType;
  targetId: string;
  title?: string;
  description?: string;
  relationType?: DocumentReferenceRelationType;
  createActions?: ReactNode;
  onEdit?: (doc: DesignDoc) => void;
  onLoaded?: (documents: DesignDoc[], references: DocumentReference[]) => void;
}): ReactElement {
  const [allDocuments, setAllDocuments] = useState<DesignDoc[]>([]);
  const [references, setReferences] = useState<DocumentReference[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onLoadedRef = useRef(props.onLoaded);
  const relationType = props.relationType ?? "references";

  useEffect(() => { onLoadedRef.current = props.onLoaded; }, [props.onLoaded]);

  const reload = useCallback(async () => {
    const [documents, nextReferences] = await Promise.all([
      api.listDesignDocs(props.projectId),
      api.listDocumentReferences({ projectId: props.projectId, targetType: props.targetType, targetId: props.targetId }),
    ]);
    setAllDocuments(documents);
    setReferences(nextReferences);
    onLoadedRef.current?.(documents.filter((doc) => nextReferences.some((reference) => reference.documentId === doc.id)), nextReferences);
  }, [props.projectId, props.targetId, props.targetType]);

  useEffect(() => { void reload().catch((reason) => setError(reason instanceof Error ? reason.message : "文档引用加载失败")); }, [reload]);

  const linked = references.flatMap((reference) => {
    const document = allDocuments.find((item) => item.id === reference.documentId);
    return document ? [{ document, reference }] : [];
  });
  const available = allDocuments.filter((document) => !references.some((reference) => reference.documentId === document.id && reference.relationType === relationType));

  const linkDocument = async () => {
    if (!selectedDocumentId || busy) return;
    setBusy(true); setError("");
    try {
      await api.createDocumentReference({
        projectId: props.projectId,
        documentId: selectedDocumentId,
        targetType: props.targetType,
        targetId: props.targetId,
        relationType,
      });
      setPickerOpen(false); setSelectedDocumentId(""); await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "引用文档失败"); }
    finally { setBusy(false); }
  };

  return <section className="node-detail-card document-reference-panel">
    <div className="node-detail-doc-header">
      <div>
        <div className="node-detail-card-heading"><BookOpen size={16} /><h2>{props.title ?? "引用文档"}</h2></div>
        <p>{props.description ?? "文档统一属于当前项目；这里仅维护当前对象对文档固定版本的引用。"}</p>
      </div>
      <div className="node-detail-doc-actions">
        {props.createActions}
        <button className="btn btn-primary" onClick={() => { setSelectedDocumentId(available[0]?.id ?? ""); setPickerOpen(true); }}><Link2 size={14} /> 引用系统文档</button>
      </div>
    </div>
    {error ? <ErrorBanner message={error} /> : null}
    {linked.length === 0 ? <EmptyState text="当前对象还没有引用系统文档。" /> : <div className="document-reference-list">
      {linked.map(({ document, reference }) => {
        const stale = reference.documentRevisionId !== document.currentRevisionId;
        return <article className={`document-reference-card ${stale ? "stale" : ""}`} key={reference.id}>
          <div className="document-reference-main">
            <div><Badge tone="info">{document.category}</Badge><Badge tone={document.status === "已批准" ? "good" : document.status === "评审中" ? "warn" : "muted"}>{document.status}</Badge>{stale ? <Badge tone="bad">版本已过期</Badge> : <Badge tone="good">已锁定当前版本</Badge>}</div>
            <h3>{document.title}</h3>
            <p>{document.summary || document.content.slice(0, 140) || "暂无摘要"}</p>
            <small>{RELATION_LABEL[reference.relationType]} · {document.version || "未标版本"} · 更新于 {formatDateTime(document.updatedAt)}</small>
          </div>
          <div className="document-reference-actions">
            {stale ? <button className="btn btn-ghost btn-sm" onClick={() => { setBusy(true); api.updateDocumentReference(reference.id, { useCurrentRevision: true }).then(reload).catch((reason) => setError(reason.message)).finally(() => setBusy(false)); }}><RefreshCw size={13} /> 确认引用最新版</button> : null}
            {props.onEdit ? <button className="btn btn-ghost btn-sm" onClick={() => props.onEdit?.(document)}><Pencil size={13} /> 查看与编辑</button> : null}
            <button className="btn btn-ghost btn-sm btn-danger" onClick={() => { if (!window.confirm(`确认解除对“${document.title}”的引用？文档本身不会删除。`)) return; setBusy(true); api.deleteDocumentReference(reference.id).then(reload).catch((reason) => setError(reason.message)).finally(() => setBusy(false)); }}><Trash2 size={13} /> 解除引用</button>
          </div>
        </article>;
      })}
    </div>}
    {pickerOpen ? <Modal title="引用系统文档" onClose={() => setPickerOpen(false)} width={620} footer={<><button className="btn" onClick={() => setPickerOpen(false)}>取消</button><button className="btn btn-primary" disabled={!selectedDocumentId || busy} onClick={() => void linkDocument()}>{busy ? "引用中…" : "确认引用"}</button></>}>
      {available.length === 0 ? <EmptyState text="当前项目没有其它可引用文档，请先在系统文档库创建。" /> : <div className="form-grid"><label className="field field-wide"><span>系统文档</span><select value={selectedDocumentId} onChange={(event) => setSelectedDocumentId(event.target.value)}>{available.map((document) => <option key={document.id} value={document.id}>{document.category} · {document.title} · {document.version}</option>)}</select></label><div className="document-reference-picker-note"><Plus size={14} /> 引用会锁定当前文档版本；文档更新后需在这里明确确认新版。</div></div>}
    </Modal> : null}
  </section>;
}
