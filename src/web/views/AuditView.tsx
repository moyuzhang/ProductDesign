import { useEffect, useState, type ReactElement } from "react";
import type { AuditEvent, Project } from "../../shared/types";
import { api } from "../api";
import { EmptyState, ErrorBanner, Pagination, Spinner, formatDateTime } from "../ui";

const ACTION_LABELS: Record<string, string> = {
  create: "创建",
  update: "更新",
  delete: "删除",
  collect: "采集",
  restore: "恢复",
  revoke: "撤销",
  submit_plan: "提交计划",
  approve_plan: "批准计划",
  reject_plan: "拒绝计划",
  start_development: "开始施工",
  complete_development: "完成施工",
  pass_audit: "审计通过",
  fail_audit: "审计失败",
  approve_acceptance: "批准验收",
  reject_acceptance: "拒绝验收",
  reopen_rework: "返工重开",
};

const ENTITY_LABELS: Record<string, string> = {
  project: "项目",
  node: "工作节点",
  plan: "计划项",
  evidence: "证据",
  governance: "治理记录",
  designDoc: "设计文档",
  diagram: "画布",
  backup: "备份",
};

export function AuditView(): ReactElement {
  const limit = 30;
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [source, setSource] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => { api.listProjects().then(setProjects).catch(() => setProjects([])); }, []);

  useEffect(() => {
    api.pageAudit({ projectId: projectId || undefined, correlationId: correlationId.trim() || undefined, q: keyword.trim() || undefined, source: source || undefined, action: action || undefined, entityType: entityType || undefined, offset, limit })
      .then((page) => { setEvents(page.items); setTotal(page.total); setError(""); })
      .catch((e) => setError(e.message));
  }, [keyword, source, action, entityType, projectId, correlationId, offset]);

  if (error) return <ErrorBanner message={error} />;
  if (!events) return <Spinner />;

  return (
    <div>
      <div className="page-header">
        <h1>审计日志</h1>
        <div className="sub">所有通过 Web 与 MCP 进行的变更都会留痕（共 {total} 条）</div>
      </div>

      <div className="toolbar">
        <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setOffset(0); }}>
          <option value="">全部项目</option>
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name} · {project.code}</option>)}
        </select>
        <input
          type="text"
          placeholder="按操作人 / 动作 / 内容过滤"
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setOffset(0); }}
          style={{ width: 260 }}
        />
        <input
          type="text"
          placeholder="关联任务 / correlationId"
          value={correlationId}
          onChange={(e) => { setCorrelationId(e.target.value); setOffset(0); }}
          style={{ width: 220 }}
        />
        <select value={source} onChange={(e) => { setSource(e.target.value); setOffset(0); }}>
          <option value="">全部来源</option><option value="web">Web</option><option value="mcp">MCP</option><option value="system">系统</option>
        </select>
        <select value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }}>
          <option value="">全部动作</option><option value="create">创建</option><option value="update">更新</option><option value="delete">删除</option><option value="collect">采集</option><option value="restore">恢复</option>
        </select>
        <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setOffset(0); }}>
          <option value="">全部对象</option><option value="project">项目</option><option value="diagram">画布</option><option value="plan">计划</option><option value="designDoc">文档</option><option value="evidence">证据</option><option value="governance">治理</option><option value="backup">备份</option>
        </select>
      </div>

      {events.length === 0 ? (
        <EmptyState text="暂无审计记录。" />
      ) : (
        <table className="table">
          <thead>
            <tr><th>时间</th><th>来源</th><th>操作人</th><th>动作</th><th>对象</th><th>内容</th></tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const after = (e.after ?? {}) as Record<string, unknown>;
              const before = (e.before ?? {}) as Record<string, unknown>;
              const label =
                (after.name as string) ?? (after.title as string) ??
                (after.label as string) ?? (before.title as string) ?? "";
              return (
                <tr key={e.id}>
                  <td className="mono cell-sub">{formatDateTime(e.createdAt)}</td>
                  <td><span className={`chip ${e.source === "mcp" ? "" : ""}`}>{e.source}</span></td>
                  <td>{e.actor}</td>
                  <td>{ACTION_LABELS[e.action] ?? e.action}</td>
                  <td>{ENTITY_LABELS[e.entityType] ?? e.entityType}</td>
                  <td className="cell-sub evidence-summary">
                    <details className="audit-event-detail">
                      <summary>{label || e.entityId.slice(0, 8)}{(e.action === "update" && after.health) ? ` · ${String(before.health ?? "?")} → ${String(after.health)}` : ""}</summary>
                      <dl>
                        <dt>eventId</dt><dd>{e.id}</dd>
                        <dt>entityId</dt><dd>{e.entityId}</dd>
                        <dt>correlation</dt><dd>{e.correlationId || "—"}</dd>
                        <dt>client / session</dt><dd>{[e.clientId, e.sessionId].filter(Boolean).join(" / ") || "—"}</dd>
                      </dl>
                      <pre>{JSON.stringify({ before: e.before, after: e.after }, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />
    </div>
  );
}
