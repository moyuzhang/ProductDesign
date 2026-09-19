import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Eye, Link as LinkIcon, Pencil, Plus, Trash2 } from "lucide-react";
import {
  DESIGN_DOC_CATEGORIES,
  DESIGN_DOC_STATUSES,
  type DesignDoc,
  type DesignDocCategory,
  type DesignDocStatus,
  type DocumentReference,
  type Project,
} from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  Pagination,
  Spinner,
  formatDateTime,
} from "../ui";
import { useWorkspace } from "./workspace";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge";

const STATUS_TONE: Record<DesignDocStatus, "good" | "warn" | "accent" | "muted" | "neutral"> = {
  草拟: "muted",
  评审中: "warn",
  已批准: "good",
  已废弃: "neutral",
};

export function DesignHubView(): ReactElement {
  const limit = 20;
  const [docs, setDocs] = useState<DesignDoc[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [editor, setEditor] = useState<{ doc?: DesignDoc } | null>(null);
  const [detail, setDetail] = useState<{ doc: DesignDoc } | null>(null);
  const [ws] = useWorkspace();
  const [refsByProject, setRefsByProject] = useState<Map<string, DocumentReference[]>>(new Map());
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  const reload = useCallback(() => {
    api.pageDesignDocs({ projectId: ws || projectFilter || undefined, q: q.trim() || undefined, status: statusFilter || undefined, offset, limit }).then((page) => {
      setDocs(page.items);
      setTotal(page.total);
      const projectIds = Array.from(new Set(page.items.map((d) => d.projectId)));
      Promise.all(projectIds.map(async (pid) => {
        const references = await api.listDocumentReferences({ projectId: pid });
        setRefsByProject((current) => new Map(current).set(pid, references));
      })).catch(() => undefined);
    }).catch((e) => setError(e.message));
  }, [ws, projectFilter, q, statusFilter, offset]);

  useEffect(() => {
    reload();
    api.listProjects().then(setProjects).catch(() => undefined);
  }, [reload]);

  useEffect(() => { setOffset(0); }, [ws]);

  useEffect(() => {
    if (!docs || editor || detail) return;
    const contextProjectId = ws || projectFilter || null;
    const visibleDocs = contextProjectId ? docs.filter((doc) => doc.projectId === contextProjectId) : [];
    setPageContextDetail({
      projectId: contextProjectId,
      pageType: "design",
      title: contextProjectId ? "项目设计文档" : "设计文档中枢",
      entityRefs: contextProjectId
        ? [{ type: "project", id: contextProjectId }, ...visibleDocs.map((doc) => ({ type: "designDocument" as const, id: doc.id, label: doc.title }))]
        : [],
      selection: { entityRefs: [] },
      draft: null,
      visibleContent: contextProjectId ? agentVisibleContent("documentList", "当前可见设计文档", visibleDocs.map((doc) => ({
        id: doc.id, title: doc.title, category: doc.category, status: doc.status, version: doc.version,
        summary: doc.summary, author: doc.author, currentRevisionId: doc.currentRevisionId, updatedAt: doc.updatedAt,
      }))) : null,
    });
  }, [detail, docs, editor, projectFilter, setPageContextDetail, ws]);

  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);

  useEffect(() => {
    if (lastEntityChange?.value.entityType !== "designDocument") return;
    if (ws && lastEntityChange.value.projectId !== ws) return;
    if (projectFilter && lastEntityChange.value.projectId !== projectFilter) return;
    reload();
  }, [lastEntityChange, projectFilter, reload, ws]);

  if (error && !docs) return <ErrorBanner message={error} />;
  if (!docs) return <Spinner />;

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const byProject = new Map<string, DesignDoc[]>();
  for (const d of docs) {
    const list = byProject.get(d.projectId) ?? [];
    list.push(d);
    byProject.set(d.projectId, list);
  }

  return (
    <div>
      <div className="page-header">
        <h1>项目设计中枢</h1>
        <div className="sub">集中浏览与管理所有项目的设计文档、需求与架构方案</div>
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder="搜索标题 / 摘要 / 作者"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOffset(0); }}
          style={{ width: 240 }}
        />
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}>
          <option value="">全部状态</option>
          {DESIGN_DOC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={projectFilter} disabled={Boolean(ws)} onChange={(e) => { setProjectFilter(e.target.value); setOffset(0); }}>
          <option value="">全部项目</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setEditor({})}>
          <Plus size={14} /> 新建设计文档
        </button>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {docs.length === 0 ? (
        <EmptyState text="还没有设计文档。可为每个重要项目撰写需求/架构/方案文档，沉淀设计决策。" />
      ) : byProject.size === 0 ? (
        <EmptyState text={ws ? "当前工作区还没有设计文档。" : "没有匹配的设计文档。"} />
      ) : (
        Array.from(byProject.entries())
          .sort((a, b) => (projectMap.get(a[0])?.name ?? "").localeCompare(projectMap.get(b[0])?.name ?? ""))
          .map(([projectId, list]) => (
            <div className="panel" key={projectId}>
              <h2>
                {projectMap.get(projectId)?.name ?? projectId.slice(0, 8)}
                <span className="count">{list.length}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 8 }}
                  onClick={() => {
                    const project = projectMap.get(projectId);
                    if (project) navigate(`#/projects/${project.id}`);
                  }}
                >
                  打开项目
                </button>
              </h2>
              {list.map((d) => {
                const references = (refsByProject.get(projectId) ?? []).filter((reference) => reference.documentId === d.id);
                return (
                  <div className="doc-row" key={d.id}>
                    <div className="doc-main">
                      <div className="doc-title">
                        <span className="doc-title-text">{d.title}</span>
                        <Badge tone="info">{d.category}</Badge>
                        <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                        {d.version ? <span className="doc-version mono">{d.version}</span> : null}
                      </div>
                      {d.summary ? <div className="doc-summary">{d.summary}</div> : null}
                      {references.length > 0 ? (
                        <div className="doc-relations">
                          <span className="doc-relation-chip"><LinkIcon size={12} /> 被 {references.length} 个对象引用</span>
                          {Array.from(new Set(references.map((reference) => reference.targetType))).map((targetType) => <span className="doc-relation-chip" key={targetType}>{targetType}</span>)}
                        </div>
                      ) : null}
                      <div className="doc-meta">
                        <span>{d.author || "未署名"}</span>
                        <span className="doc-meta-dot">·</span>
                        <span>更新于 {formatDateTime(d.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="inline-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setDetail({ doc: d })}>
                        <Eye size={13} /> 查看
                      </button>
                      <button className="btn btn-ghost btn-icon" onClick={() => setEditor({ doc: d })} title="编辑">
                        <Pencil size={13} />
                      </button>
                      <button
                        className="btn btn-ghost btn-icon btn-danger"
                        title="删除"
                        onClick={() => {
                          if (window.confirm(`确认删除设计文档「${d.title}」？`)) {
                            api.deleteDesignDoc(d.id).then(reload).catch((e) => setError(e.message));
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
      )}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />

      {editor ? (
        <DesignDocModal
          projects={projects}
          doc={editor.doc}
          defaultProjectId={ws}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); reload(); }}
        />
      ) : null}
      {detail ? (
        <DesignDocDetailModal
          doc={detail.doc}
          projects={projects}
          refsByProject={refsByProject}
          onClose={() => setDetail(null)}
          onEdit={() => { const d = detail.doc; setDetail(null); setEditor({ doc: d }); }}
        />
      ) : null}
    </div>
  );
}

function DesignDocModal(props: {
  projects: Project[];
  doc?: DesignDoc;
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.doc;
  const [form, setForm] = useState({
    projectId: existing?.projectId ?? props.defaultProjectId ?? props.projects[0]?.id ?? "",
    title: existing?.title ?? "",
    category: existing?.category ?? ("需求文档" as DesignDocCategory),
    summary: existing?.summary ?? "",
    status: existing?.status ?? ("草拟" as DesignDocStatus),
    version: existing?.version ?? "v0.1",
    author: existing?.author ?? "",
    sourceUrl: existing?.sourceUrl ?? "",
    content: existing?.content ?? "",
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();
  const initialForm = useMemo(() => ({
    projectId: existing?.projectId ?? props.defaultProjectId ?? props.projects[0]?.id ?? "",
    title: existing?.title ?? "",
    category: existing?.category ?? ("需求文档" as DesignDocCategory),
    summary: existing?.summary ?? "",
    status: existing?.status ?? ("草拟" as DesignDocStatus),
    version: existing?.version ?? "v0.1",
    author: existing?.author ?? "",
    sourceUrl: existing?.sourceUrl ?? "",
    content: existing?.content ?? "",
  }), [existing, props.defaultProjectId, props.projects]);
  const dirty = !existing || JSON.stringify(form) !== JSON.stringify(initialForm);

  useEffect(() => {
    if (!form.projectId) return;
    setPageContextDetail({
      projectId: form.projectId,
      pageType: "document",
      title: `${existing ? "编辑" : "新建"}文档 · ${form.title || "未命名"}`,
      entityRefs: [
        { type: "project", id: form.projectId },
        ...(existing ? [{ type: "designDocument" as const, id: existing.id, label: existing.title }] : []),
      ],
      selection: { entityRefs: existing ? [{ type: "designDocument", id: existing.id, label: existing.title }] : [] },
      draft: { dirty, baseRevision: existing?.updatedAt, summary: "当前 visibleContent 是编辑器中的文档草稿。" },
      visibleContent: agentVisibleContent("document", form.title || "未命名文档", form),
    });
  }, [dirty, existing, form, setPageContextDetail]);

  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);

  useEffect(() => {
    if (!existing || lastEntityChange?.value.entityType !== "designDocument" || lastEntityChange.value.entityId !== existing.id) return;
    if (lastEntityChange.value.revision <= existing.updatedAt) return;
    setError(dirty
      ? "Agent 已更新当前文档，但本地还有未保存修改；已保留本地草稿，请保存或重新打开后同步。"
      : "Agent 已更新当前文档，请重新打开以查看最新内容。");
  }, [dirty, existing, lastEntityChange]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = () => {
    setBusy(true); setError("");
    const call = existing
      ? api.updateDesignDoc(existing.id, form)
      : api.createDesignDoc(form);
    call.then(() => props.onSaved()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <Modal
      title={existing ? `编辑设计文档：${existing.title}` : "新建设计文档"}
      onClose={props.onClose}
      width={760}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn" onClick={() => setPreviewOpen((v) => !v)}>{previewOpen ? "编辑" : "预览"}</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim() || !form.projectId} onClick={submit}>
            保存
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {previewOpen ? (
        <div className="doc-preview">{form.content || "（无内容）"}</div>
      ) : (
        <div className="form-grid">
          <Field label="所属项目">
            <select value={form.projectId} onChange={set("projectId")}>
              {props.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="状态">
            <select value={form.status} onChange={set("status")}>
              {DESIGN_DOC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="文档类型">
            <select value={form.category} onChange={set("category")}>
              {DESIGN_DOC_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="标题"><input value={form.title} onChange={set("title")} /></Field>
          <Field label="作者"><input value={form.author} onChange={set("author")} /></Field>
          <Field label="版本号"><input value={form.version} onChange={set("version")} /></Field>
          <Field label="摘要"><input value={form.summary} onChange={set("summary")} /></Field>
          <Field label="附件或外部文档链接" wide><input value={form.sourceUrl} placeholder="https://…" onChange={set("sourceUrl")} /></Field>
          <Field label="文档内容（Markdown / 纯文本）" wide>
            <textarea rows={12} value={form.content} onChange={set("content")} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function DesignDocDetailModal(props: {
  doc: DesignDoc;
  projects: Project[];
  refsByProject: Map<string, DocumentReference[]>;
  onClose: () => void;
  onEdit: () => void;
}): ReactElement {
  const doc = props.doc;
  const project = props.projects.find((p) => p.id === doc.projectId);
  const references = (props.refsByProject.get(doc.projectId) ?? []).filter((reference) => reference.documentId === doc.id);
  const { setPageContextDetail } = useAgentUiBridge();

  useEffect(() => {
    setPageContextDetail({
      projectId: doc.projectId,
      pageType: "document",
      title: `文档 · ${doc.title}`,
      entityRefs: [{ type: "project", id: doc.projectId }, { type: "designDocument", id: doc.id, label: doc.title }],
      selection: { entityRefs: [{ type: "designDocument", id: doc.id, label: doc.title }] },
      draft: null,
      visibleContent: agentVisibleContent("document", doc.title, doc),
    });
  }, [doc, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);

  return (
    <Modal
      title="设计文档详情"
      onClose={props.onClose}
      width={760}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>关闭</button>
          <button className="btn btn-primary" onClick={props.onEdit}><Pencil size={14} /> 编辑</button>
        </>
      }
    >
      <div className="doc-detail-head">
        <h2>{doc.title}</h2>
        <div className="doc-detail-badges">
          <Badge tone="info">{doc.category}</Badge>
          <Badge tone={STATUS_TONE[doc.status]}>{doc.status}</Badge>
          {doc.version ? <span className="doc-version mono">{doc.version}</span> : null}
        </div>
      </div>

      <dl className="doc-detail-meta">
        <div className="doc-detail-meta-item"><dt>所属项目</dt><dd>{project?.name ?? doc.projectId.slice(0, 8)}</dd></div>
        <div className="doc-detail-meta-item"><dt>作者</dt><dd>{doc.author || "未署名"}</dd></div>
        <div className="doc-detail-meta-item"><dt>版本</dt><dd className="mono">{doc.version || "—"}</dd></div>
        <div className="doc-detail-meta-item"><dt>版本快照</dt><dd className="mono">{doc.currentRevisionId.slice(0, 8)}</dd></div>
        <div className="doc-detail-meta-item"><dt>更新于</dt><dd>{formatDateTime(doc.updatedAt)}</dd></div>
      </dl>

      {doc.summary ? (
        <>
          <h4 className="doc-detail-section">摘要</h4>
          <p className="doc-detail-summary">{doc.summary}</p>
        </>
      ) : null}

      {references.length > 0 ? (
        <>
          <h4 className="doc-detail-section">引用关系</h4>
          <div className="doc-relations">
            {references.map((reference) => <span className="doc-relation-chip" key={reference.id}><LinkIcon size={12} /> {reference.targetType} · {reference.relationType} · {reference.targetId.slice(0, 8)}{reference.documentRevisionId !== doc.currentRevisionId ? " · 旧版本" : ""}</span>)}
          </div>
        </>
      ) : null}

      {doc.sourceUrl ? (
        <>
          <h4 className="doc-detail-section">外部链接</h4>
          <a className="doc-source-link" href={doc.sourceUrl} target="_blank" rel="noreferrer">
            <LinkIcon size={13} /> {doc.sourceUrl}
          </a>
        </>
      ) : null}

      <h4 className="doc-detail-section">文档内容</h4>
      <div className="doc-preview doc-detail-content">{doc.content || "（无内容）"}</div>
    </Modal>
  );
}
