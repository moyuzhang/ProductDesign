import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { GovernanceRecord, Project } from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import { Badge, EmptyState, ErrorBanner, Pagination, Spinner, formatDateTime } from "../ui";

export function GovernanceView(): ReactElement {
  const limit = 20;
  const [records, setRecords] = useState<GovernanceRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const reload = useCallback(() => {
    api.pageGovernance({ type: typeFilter || undefined, status: statusFilter || undefined, offset, limit })
      .then((page) => { setRecords(page.items); setTotal(page.total); setError(""); })
      .catch((e) => setError(e.message));
  }, [typeFilter, statusFilter, offset]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => undefined);
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!records) return <Spinner />;

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  return (
    <div>
      <div className="page-header">
        <h1>治理决策</h1>
        <div className="sub">跨项目的技术选型、方案裁决与意见档案</div>
      </div>

      <div className="toolbar">
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setOffset(0); }}>
          <option value="">全部类型</option>
          <option value="decision">决策</option>
          <option value="opinion">意见</option>
        </select>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}>
          <option value="">全部状态</option>
          <option value="有效">有效</option>
          <option value="待确认">待确认</option>
          <option value="已替代">已替代</option>
        </select>
      </div>

      {records.length === 0 ? (
        <EmptyState text="没有匹配的治理记录。可在各项目详情页的「治理记录」标签中添加。" />
      ) : (
        <table className="table">
          <thead>
            <tr><th>标题</th><th>所属项目</th><th>类型</th><th>状态</th><th>作者</th><th>时间</th></tr>
          </thead>
          <tbody>
            {records.map((r) => {
              const project = projectMap.get(r.projectId);
              return (
                <tr
                  key={r.id}
                  className="row-link"
                  role={project ? "link" : undefined}
                  tabIndex={project ? 0 : undefined}
                  onClick={() => project && navigate(`#/projects/${project.id}`)}
                  onKeyDown={(event) => { if (project && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); navigate(`#/projects/${project.id}`); } }}
                >
                  <td>
                    <div className="cell-main">{r.title}</div>
                    <div className="cell-sub">{r.content.slice(0, 90)}{r.content.length > 90 ? "…" : ""}</div>
                  </td>
                  <td>{project ? project.name : <span className="cell-sub mono">{r.projectId.slice(0, 8)}</span>}</td>
                  <td><Badge tone={r.type === "decision" ? "accent" : "info"}>{r.type === "decision" ? "决策" : "意见"}</Badge></td>
                  <td>
                    <Badge tone={r.status === "有效" ? "good" : r.status === "待确认" ? "warn" : "muted"}>{r.status}</Badge>
                  </td>
                  <td>{r.author || "—"}</td>
                  <td className="cell-sub mono">{formatDateTime(r.createdAt)}</td>
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
