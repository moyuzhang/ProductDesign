import { useEffect, useState, type ReactElement } from "react";
import { api, type DashboardData } from "../api";
import { navigate } from "../App";
import {
  EmptyState,
  ErrorBanner,
  HealthBadge,
  Spinner,
  StageBadge,
  StatCard,
  formatDateTime,
} from "../ui";

const STAGES = ["探索", "规划", "设计", "开发", "测试", "交付", "维护"];
const HEALTHS = ["正常", "关注", "高风险", "阻塞"];

const ACTION_LABELS: Record<string, string> = {
  create: "创建",
  update: "更新",
  delete: "删除",
  collect: "采集",
};

export function DashboardView(): ReactElement {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.dashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Spinner />;

  const maxStage = Math.max(1, ...STAGES.map((s) => data.byStage[s] ?? 0));

  return (
    <div>
      <div className="page-header">
        <h1>总览</h1>
        <div className="sub">全部项目的阶段、健康与风险一览 · 数据生成于 {formatDateTime(data.generatedAt)}</div>
      </div>

      <div className="stat-grid">
        <StatCard label="项目总数" value={data.totals.projects} tone="accent" />
        <StatCard label="进行中（设计/开发/测试）" value={data.totals.activeProjects} tone="good" />
        <StatCard label="需关注项目" value={data.totals.attention} tone={data.totals.attention > 0 ? "warn" : "good"} />
        <StatCard label="待配置项目" value={data.totals.unconfigured} tone={data.totals.unconfigured > 0 ? "warn" : "good"}
          hint={data.totals.unconfigured > 0 ? "无工作节点/计划/画布，非真实健康" : "均已完成配置"} />
        <StatCard label="逾期计划项" value={data.totals.overduePlans} tone={data.totals.overduePlans > 0 ? "bad" : "good"} />
      </div>

      <div className="panel">
        <h2>阶段分布</h2>
        {STAGES.map((stage) => {
          const count = data.byStage[stage] ?? 0;
          return (
            <div className="dist-row" key={stage}>
              <span className="dist-label">{stage}</span>
              <div className="dist-bar-track">
                <div className="dist-bar" style={{ width: `${(count / maxStage) * 100}%` }} />
              </div>
              <span className="dist-count">{count}</span>
            </div>
          );
        })}
      </div>

      <div className="panel">
        <h2>需关注的项目</h2>
        {data.attentionProjects.length === 0 && HEALTHS.every((h) => h === "正常") ? null : null}
        {data.attentionProjects.length === 0 ? (
          <EmptyState text="所有项目健康度正常。" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>项目</th><th>阶段</th><th>健康</th><th>阻塞 / 风险</th></tr>
            </thead>
            <tbody>
              {data.attentionProjects.map((p) => (
                <tr key={p.id} className="row-link" role="link" tabIndex={0} onClick={() => navigate(`#/projects/${p.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`#/projects/${p.id}`); } }}>
                  <td>
                    <div className="cell-main">{p.name}</div>
                    <div className="cell-sub mono">{p.code}</div>
                  </td>
                  <td><StageBadge stage={p.stage} /></td>
                  <td><HealthBadge health={p.health} /></td>
                  <td className="cell-sub">{p.blockerSummary || p.riskSummary || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>待配置的项目（导入后未展开，勿当健康正常）</h2>
        {data.unconfiguredProjects.length === 0 ? (
          <EmptyState text="全部项目均已完成配置。" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>项目</th><th>阶段</th><th>说明</th></tr>
            </thead>
            <tbody>
              {data.unconfiguredProjects.map((p) => (
                <tr key={p.id} className="row-link" role="link" tabIndex={0} onClick={() => navigate(`#/projects/${p.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`#/projects/${p.id}`); } }}>
                  <td>
                    <div className="cell-main">{p.name}</div>
                    <div className="cell-sub mono">{p.code}</div>
                  </td>
                  <td><StageBadge stage={p.stage} /></td>
                  <td className="cell-sub">无模块 / 功能 / 需求节点、计划或文档，去系统主画布补齐</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.overduePlans.length > 0 ? (
        <div className="panel">
          <h2>逾期计划项</h2>
          <table className="table">
            <thead>
              <tr><th>标题</th><th>类型</th><th>截止</th><th>进度</th></tr>
            </thead>
            <tbody>
              {data.overduePlans.map((pl) => (
                <tr key={pl.id} className="row-link" role="link" tabIndex={0} onClick={() => navigate(`#/projects/${pl.projectId}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`#/projects/${pl.projectId}`); } }}>
                  <td className="cell-main">{pl.title}</td>
                  <td>{pl.kind}</td>
                  <td className="mono">{pl.dueAt}</td>
                  <td>{pl.progress}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="panel">
        <h2>最近动态</h2>
        {data.recentAudit.length === 0 ? (
          <EmptyState text="暂无操作记录。" />
        ) : (
          data.recentAudit.map((event) => (
            <div className="audit-line" key={event.id}>
              <span className="audit-time">{formatDateTime(event.createdAt)}</span>
              <span className="audit-desc">
                <b>{event.actor}</b> {ACTION_LABELS[event.action] ?? event.action} 了{" "}
                {event.entityType === "project" ? "项目" : event.entityType} ·{" "}
                {(event.after as { name?: string; title?: string; label?: string } | null)?.name ??
                  (event.after as { title?: string; label?: string } | null)?.title ??
                  (event.before as { title?: string } | null)?.title ??
                  event.entityId.slice(0, 8)}
                <span style={{ color: "var(--text-faint)" }}>（{event.source}）</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
