import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  HEALTH_LEVELS,
  PRIORITIES,
  PROJECT_STAGES,
  type Project,
} from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import {
  EmptyState,
  ErrorBanner,
  Field,
  HealthBadge,
  Modal,
  Pagination,
  ProgressBar,
  Spinner,
  StageBadge,
  formatDateTime,
} from "../ui";

export function ProjectsView(): ReactElement {
  const limit = 20;
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [health, setHealth] = useState("");
  const [configOnly, setConfigOnly] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("configured") === "no");
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    api.pageProjects({ q: q || undefined, stage: stage || undefined, health: health || undefined, configured: configOnly ? "no" : "all", offset, limit })
      .then((page) => { setProjects(page.items); setTotal(page.total); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [q, stage, health, configOnly, offset]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="page-header">
        <h1>项目管理</h1>
        <div className="sub">从目标出发，生成、审阅并确认产品设计</div>
      </div>

      <div className="toolbar">
        <div style={{ position: "relative" }}>
          <Search
            size={14}
            style={{ position: "absolute", left: 9, top: 10, color: "var(--text-faint)" }}
          />
          <input
            type="text"
            placeholder="搜索名称 / 编号 / 摘要"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            style={{ paddingLeft: 28, width: 240 }}
          />
        </div>
        <select value={stage} onChange={(e) => { setStage(e.target.value); setOffset(0); }}>
          <option value="">全部阶段</option>
          {PROJECT_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={health} onChange={(e) => { setHealth(e.target.value); setOffset(0); }}>
          <option value="">全部健康度</option>
          {HEALTH_LEVELS.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-dim)", cursor: "pointer", marginRight: 4, whiteSpace: "nowrap" }} title="未配置 = 无工作节点且无计划项，导入后尚未展开，勿当作健康正常">
          <input type="checkbox" checked={configOnly} onChange={(e) => { setConfigOnly(e.target.checked); setOffset(0); }} />
          仅看待配置
        </label>
        <button className="btn btn-ghost btn-icon" onClick={reload} title="刷新"><RefreshCw size={14} /></button>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={15} /> 新建项目
        </button>
      </div>

      {error ? <ErrorBanner message={error} /> : null}

      {loading ? (
        <Spinner />
      ) : projects.length === 0 && !q && !stage && !health && !configOnly ? (
        <EmptyState text="还没有项目。点击「新建项目」，项目文件将由服务统一托管。" />
      ) : projects.length === 0 ? (
        <EmptyState text="没有符合筛选的项目。" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>项目</th><th>阶段</th><th>健康</th><th>进度</th>
              <th>风险</th><th>截止</th><th>更新时间</th><th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr
                key={p.id}
                className="row-link"
                role="link"
                tabIndex={0}
                onClick={() => navigate(`#/projects/${p.id}`)}
                onKeyDown={(event) => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); navigate(`#/projects/${p.id}`); } }}
              >
                <td>
                  <div className="cell-main">
                    {p.name}
                    {p.unconfigured ? (
                      <span className="badge badge-warn" style={{ marginLeft: 8, fontSize: 11 }}>待配置</span>
                    ) : null}
                  </div>
                  <div className="cell-sub mono">{p.code}</div>
                </td>
                <td><StageBadge stage={p.stage} /></td>
                <td>{p.unconfigured ? <span className="badge badge-warn">待配置</span> : <HealthBadge health={p.health} />}</td>
                <td style={{ minWidth: 110 }}><ProgressBar value={p.progress} /></td>
                <td>{p.riskLevel}</td>
                <td className="mono">{p.dueAt || "—"}</td>
                <td className="cell-sub">{formatDateTime(p.updatedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-ghost btn-icon btn-danger"
                    title="删除项目"
                    onClick={() => {
                      if (window.confirm(`确认删除项目「${p.name}」？其工作节点、计划、证据将一并删除。`)) {
                        api.deleteProject(p.id).then(reload).catch((err) => setError(err.message));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!loading ? <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} /> : null}

      {createOpen ? <CreateProjectModal onClose={() => setCreateOpen(false)} onCreated={(project) => navigate(`#/projects/${project.id}?tab=workflow`)} /> : null}
    </div>
  );
}

function CreateProjectModal(props: { onClose: () => void; onCreated: (project: Project) => void }): ReactElement {
  const [form, setForm] = useState({
    code: "",
    name: "",
    summary: "",
    riskLevel: "P2",
    startAt: "",
    dueAt: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submitting = useRef(false);
  const submit = () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    api.createProject(form)
      .then((project) => { props.onClose(); props.onCreated(project); })
      .catch((e) => setError(e.message))
      .finally(() => { submitting.current = false; setBusy(false); });
  };

  return (
    <Modal
      title="新建项目"
      onClose={() => { if (!submitting.current) props.onClose(); }}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={props.onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !form.name.trim() || !form.code.trim()} onClick={submit}>
            {busy ? "创建中…" : "创建并进入设计"}
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <p className="cell-sub">先写清要解决的问题。创建后进入设计工作台；创建项目不会启动开发或自动确认设计。</p>
      <div className="form-grid">
        <Field label="项目编号（唯一）"><input type="text" value={form.code} onChange={set("code")} placeholder="如 ARRANGE_FIVE" /></Field>
        <Field label="项目名称"><input type="text" value={form.name} onChange={set("name")} placeholder="如 排列五助手" /></Field>
        <Field label="风险等级">
          <select value={form.riskLevel} onChange={set("riskLevel")}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="文件存储"><input type="text" value="由服务托管于 data/projects/<项目ID>" readOnly /></Field>
        <Field label="开始日期"><input type="date" value={form.startAt} onChange={set("startAt")} /></Field>
        <Field label="截止日期"><input type="date" value={form.dueAt} onChange={set("dueAt")} /></Field>
        <Field label="项目目标" wide><textarea rows={3} value={form.summary} onChange={set("summary")} placeholder="为谁解决什么问题？希望交付什么？如何判断成功？" /></Field>
      </div>
    </Modal>
  );
}
