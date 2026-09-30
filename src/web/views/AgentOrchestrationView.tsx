import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowRight, Bot, Check, Clipboard, ExternalLink, FolderOpen, Pencil, RefreshCw, ShieldCheck, UserCheck, Wrench, XCircle } from "lucide-react";
import type { AgentBlueprintKey, AgentBlueprintOverride, AgentExecutableQueueKey, AgentOrchestration, AgentOrchestrationQueueKey, AgentTaskLeaseRecord } from "../../shared/types";
import { api } from "../api";
import { navigate } from "../App";
import { EmptyState, ErrorBanner, Field, Modal, Spinner, formatTime } from "../ui";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge";
import {
  createOrchestrationQueueOffsets,
  ORCHESTRATION_QUEUE_PAGE_SIZE,
  paginateOrchestrationQueue,
  setOrchestrationQueueOffset,
} from "./agentOrchestrationPagination";
import { useWorkspaceContext } from "./workspace";

const QUEUES: Array<{ key: AgentOrchestrationQueueKey; label: string; owner: string }> = [
  { key: "design", label: "待设计", owner: "Designer" },
  { key: "development", label: "待施工", owner: "Builder" },
  { key: "audit", label: "待审计", owner: "Auditor" },
  { key: "approval", label: "待常规批准", owner: "Approver" },
  { key: "managerApproval", label: "高风险执行授权", owner: "Manager" },
];

const ROLE_ICONS = { designer: Bot, builder: Wrench, auditor: ShieldCheck, approver: UserCheck } as const;
function QueueCardHeader({ label, count }: { label: string; count: number }): ReactElement {
  return <div className="orchestration-queue-head"><span>{label}</span><strong>{count}</strong></div>;
}

function splitList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

type LeaseRecord = AgentTaskLeaseRecord;

const ACTIVE_LEASE_STATUSES = new Set<LeaseRecord["status"]>(["claimed", "running"]);
const LEASE_HISTORY_PAGE_SIZE = 10;
const RUNTIME_PAGE_SIZE = 12;

function leaseStatusLabel(status: LeaseRecord["status"]): string {
  return ({ claimed: "已领取", running: "运行中", completed: "已完成", failed: "失败", released: "已释放", expired: "已过期" } satisfies Record<LeaseRecord["status"], string>)[status];
}

export function AgentOrchestrationView(): ReactElement {
  const { workspace } = useWorkspaceContext();
  const [data, setData] = useState<AgentOrchestration | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [handoff, setHandoff] = useState<{ serialized: string; target: { planId?: string; taskId?: string;
    expectedProposalRevision?: number; expectedTaskKey?: string; expectedTaskRevision?: string } } | null>(null);
  const [leases, setLeases] = useState<LeaseRecord[]>([]);
  const [releaseTarget, setReleaseTarget] = useState<LeaseRecord | null>(null);
  const [releaseReason, setReleaseReason] = useState("");
  const [releasingLeaseId, setReleasingLeaseId] = useState("");
  const [showLeaseHistory, setShowLeaseHistory] = useState(false);
  const [leaseHistoryOffset, setLeaseHistoryOffset] = useState(0);
  const [runtimeOffset, setRuntimeOffset] = useState(0);
  // Per-queue pagination so any single queue cannot stretch the whole grid.
  const [offsets, setOffsets] = useState<Record<AgentOrchestrationQueueKey, number>>(createOrchestrationQueueOffsets);
  // Editable recommended-agent blueprints (globally shared).
  const [editing, setEditing] = useState<AgentBlueprintKey | null>(null);
  const [draft, setDraft] = useState<AgentBlueprintOverride | null>(null);
  const [saving, setSaving] = useState(false);
  const { setPageContextDetail } = useAgentUiBridge();

  const reload = () => {
    if (!workspace) return;
    setLoading(true);
    setError("");
    Promise.all([api.getAgentOrchestration(workspace), api.listAgentTaskLeases(workspace)])
      .then(([nextData, nextLeases]) => { setData(nextData); setLeases(nextLeases); })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setData(null);
    setHandoff(null);
    setOffsets(createOrchestrationQueueOffsets());
    setLeaseHistoryOffset(0);
    setRuntimeOffset(0);
    reload();
    // workspace is the reload boundary; keeping reload local avoids stale project reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const queueCount = useMemo(() => data
    ? Object.values(data.queues).reduce((sum, items) => sum + items.length, 0)
    : 0, [data]);

  useEffect(() => {
    if (!data) {
      setPageContextDetail(null);
      return;
    }
    setPageContextDetail({
      projectId: data.project.id,
      pageType: "orchestration",
      title: `${data.project.name} · Agent 编排建议`,
      entityRefs: [{ type: "project", id: data.project.id, label: data.project.name }],
      selection: { entityRefs: [] },
      draft: null,
      visibleContent: agentVisibleContent("agentOrchestration", "当前项目的 Agent 编排蓝图", {
        schemaVersion: data.schemaVersion,
        workflow: { phase: data.workflow.phase, status: data.workflow.status, nextAction: data.workflow.nextAction },
        queues: data.queues,
        recommendedAgents: data.recommendedAgents.map(({ key, name, purpose, responsibilities, boundaries }) => ({ key, name, purpose, responsibilities, boundaries })),
      }),
    });
    return () => setPageContextDetail(null);
  }, [data, setPageContextDetail]);

  if (!workspace) return <EmptyState text="先选择一个项目。Agent 编排是项目级蓝图，选定项目后会自动生成设计、施工、审计队列和人工批准节点。" />;
  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Spinner />;

  const activeLeases = leases.filter((lease) => ACTIVE_LEASE_STATUSES.has(lease.status));
  const historyLeases = leases.filter((lease) => !ACTIVE_LEASE_STATUSES.has(lease.status));
  const historyPagination = paginateOrchestrationQueue(historyLeases, leaseHistoryOffset, LEASE_HISTORY_PAGE_SIZE);
  const runtimeItems = [
    ...(data.workerPools ?? []).map((pool) => ({ kind: "pool" as const, pool })),
    ...(data.runners ?? []).map((runner) => ({ kind: "runner" as const, runner })),
  ];
  const runtimePagination = paginateOrchestrationQueue(runtimeItems, runtimeOffset, RUNTIME_PAGE_SIZE);

  const copyBootstrap = async () => {
    await navigator.clipboard.writeText(data.bootstrapPrompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const previewHandoff = async (item: { id: string; planItemId: string | null }) => {
    if (!data) return;
    setError("");
    try {
      const target = item.planItemId ? { planId: item.planItemId } : { taskId: item.id };
      const { serialized } = await api.getCoordinationHandoff(data.project.id, target);
      const parsed = JSON.parse(serialized) as { binding: { type: "plan" | "task"; proposalRevision?: number;
        taskKey?: string; taskRevision?: string } };
      setHandoff({ serialized, target: parsed.binding.type === "plan"
        ? { ...target, expectedProposalRevision: parsed.binding.proposalRevision }
        : { ...target, expectedTaskKey: parsed.binding.taskKey, expectedTaskRevision: parsed.binding.taskRevision } });
    } catch (cause) { setHandoff(null); setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const exportHandoff = async (mode: "copy" | "download") => {
    if (!handoff || !data) return;
    try {
      const fresh = await api.getCoordinationHandoff(data.project.id, handoff.target);
      if (fresh.serialized !== handoff.serialized) throw new Error("交接目标已变化，请重新预览");
      if (mode === "copy") await navigator.clipboard.writeText(handoff.serialized);
      else {
        const href = URL.createObjectURL(new Blob([handoff.serialized], { type: "application/json;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = href; link.download = "coordination-handoff.json"; link.click();
        URL.revokeObjectURL(href);
      }
    } catch (cause) { setHandoff(null); setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const confirmManualRelease = async () => {
    if (!releaseTarget || !data || !releaseReason.trim()) return;
    setReleasingLeaseId(releaseTarget.workOrderId);
    setError("");
    try {
      await api.releaseAgentTaskManually(data.project.id, releaseTarget.workOrderId, releaseReason.trim());
      const [nextData, nextLeases] = await Promise.all([
        api.getAgentOrchestration(data.project.id),
        api.listAgentTaskLeases(data.project.id),
      ]);
      setData(nextData);
      setLeases(nextLeases);
      setReleaseTarget(null);
      setReleaseReason("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReleasingLeaseId("");
    }
  };

  const openEdit = async (key: AgentBlueprintKey, name: string) => {
    try {
      const overrides = await api.listAgentBlueprints();
      const found = overrides.find((item) => item.key === key);
      setDraft(found ?? {
        key,
        name,
        purpose: data.recommendedAgents.find((agent) => agent.key === key)?.purpose ?? "",
        responsibilities: data.recommendedAgents.find((agent) => agent.key === key)?.responsibilities ?? [],
        boundaries: data.recommendedAgents.find((agent) => agent.key === key)?.boundaries ?? [],
        allowedMcpTools: data.recommendedAgents.find((agent) => agent.key === key)?.allowedMcpTools ?? [],
        updatedAt: new Date().toISOString(),
      });
      setEditing(key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveBlueprint = async () => {
    if (!draft || !data) return;
    setSaving(true);
    setError("");
    try {
      await api.updateAgentBlueprint(draft.key, {
        name: draft.name,
        purpose: draft.purpose,
        responsibilities: draft.responsibilities,
        boundaries: draft.boundaries,
        allowedMcpTools: draft.allowedMcpTools,
      });
      const fresh = await api.getAgentOrchestration(data.project.id);
      setData(fresh);
      setEditing(null);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="orchestration-page">
      <header className="orchestration-hero">
        <div>
          <div className="orchestration-kicker">PROJECT ORCHESTRATION · {data.schemaVersion}</div>
          <h1>{data.project.name}</h1>
          <p>{data.workflow.summary}</p>
        </div>
        <div className="orchestration-hero-actions">
          <button className="btn" onClick={reload}><RefreshCw />刷新队列</button>
          <button className="btn btn-primary" onClick={copyBootstrap}>{copied ? <Check /> : <Clipboard />}{copied ? "已复制" : "复制启动提示词"}</button>
        </div>
        <div className="orchestration-pulse">
          <span>{data.workflow.phaseLabel} · 当前层</span>
          <strong>{data.workflow.layerGate.activeLayer ?? "-"}/{data.workflow.layerGate.totalLayers}</strong>
          <small>依赖已就绪 {data.workflow.layerGate.activePlanCount} 项 · 等待依赖 {data.workflow.layerGate.lockedPlanCount} 项</small>
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      {handoff && <section className="orchestration-section" aria-label="只读协调交接预览">
        <div className="orchestration-section-title"><div><span>HANDOFF</span><h2>只读协调交接</h2></div>
          <p>此内容不含租约或凭据；实际领取和派发仅由已认证 Main Agent 完成。</p></div>
        <pre data-testid="coordination-handoff-preview">{handoff.serialized}</pre>
        <button className="btn" onClick={() => void exportHandoff("copy")}>复制交接</button>
        <button className="btn" onClick={() => void exportHandoff("download")}>下载交接</button>
      </section>}

      <section className={`orchestration-workdir ${data.workingDirectory.ready ? "is-ready" : "is-blocked"}`} data-testid="agent-working-directory">
        <FolderOpen />
        <div>
          <span>开发任务目标代码目录（设计任务使用托管项目目录）</span>
          <code>{data.workingDirectory.repositoryPath || "未配置 repositoryPath"}</code>
        </div>
        <strong>{data.workingDirectory.ready ? "开发目录就绪" : data.workingDirectory.issue}</strong>
      </section>

      {data.coordinationReadiness && !data.coordinationReadiness.ready ? (
        <div className="orchestration-workdir is-blocked" role="status" data-testid="coordination-credential-blocker">
          <div><span>Main Agent 父协调租约认证未就绪</span><p>{data.coordinationReadiness.issue}</p></div>
        </div>
      ) : null}

      {data.capacity && data.leaseSummary ? (
        <section className="orchestration-runtime" aria-label="Agent 运行容量">
          <article><span>项目并发</span><strong>{data.leaseSummary.active}/{data.capacity.maxActive}</strong><small>剩余 {data.leaseSummary.activeSlots} 个槽位</small></article>
          <article><span>施工并发</span><strong>{data.leaseSummary.roleActive.builder}/{data.capacity.builderMaxActive}</strong><small>设计 {data.leaseSummary.roleActive.designer}/{data.capacity.designerMaxActive} · 审计 {data.leaseSummary.roleActive.auditor}/{data.capacity.auditorMaxActive}</small></article>
          <article><span>任务租约</span><strong>{data.leaseSummary.claimed + data.leaseSummary.running}</strong><small>资源锁 {data.leaseSummary.lockedScopes} · 工作区 {data.leaseSummary.workspaceReservations}</small></article>
          <article><span>Worker 池</span><strong>{data.workerPools?.filter((pool) => pool.status === "active").length ?? 0}</strong><small>服务端原子派发 · 禁止抢指定任务</small></article>
          <article><span>外部 Runner</span><strong>{data.runners?.filter((runner) => runner.status === "online").length ?? 0}</strong><small>登记 {data.runners?.length ?? 0} · 最大尝试 {data.capacity.maxAttempts}</small></article>
        </section>
      ) : null}

      <section className="orchestration-section orchestration-leases" aria-label="租约管理" data-testid="lease-management">
        <div className="orchestration-section-title">
          <div><span>LEASES</span><h2>租约管理</h2></div>
          <p>仅管理员可从这里释放卡住的活动租约；释放不会自动重试或重新领取。</p>
        </div>
        <div className="orchestration-lease-summary">
          <strong>{activeLeases.length}</strong><span>个活动租约</span>
          <small>{historyLeases.length} 条历史记录 · leaseToken 不在页面传输</small>
        </div>
        <div className="orchestration-lease-list">
          {activeLeases.length === 0 ? <div className="orchestration-quiet">当前没有可释放的活动租约。</div> : activeLeases.map((lease) => (
            <article className="orchestration-lease-row" key={lease.workOrderId} data-testid={`lease-row-${lease.workOrderId}`}>
              <div><strong>{lease.actionCode}</strong><small>{lease.queue} · {lease.role} · {leaseStatusLabel(lease.status)}</small></div>
              <div><span>Agent / Worker</span><code>{lease.agentId} / {lease.workerId}</code></div>
              <div><span>租约至</span><time>{formatTime(lease.leaseExpiresAt)}</time></div>
              <div><span>资源范围</span><small>{lease.workScopes.join("、") || "无"}</small></div>
              <button className="btn btn-danger btn-sm" data-testid={`release-lease-${lease.workOrderId}`} onClick={() => { setReleaseTarget(lease); setReleaseReason(""); }} disabled={releasingLeaseId !== ""}>
                <XCircle size={14} />手动释放
              </button>
            </article>
          ))}
        </div>
        {historyLeases.length > 0 ? (
          <details className="orchestration-lease-history" open={showLeaseHistory} onToggle={(event) => setShowLeaseHistory(event.currentTarget.open)}>
             <summary>查看历史租约（{historyLeases.length}）</summary>
             <div className="orchestration-lease-list">
               {historyPagination.visible.map((lease) => (
                 <div className="orchestration-lease-row is-history" key={lease.workOrderId} data-testid={`lease-history-${lease.workOrderId}`}>
                  <div><strong>{lease.actionCode}</strong><small>{lease.queue} · {lease.role} · {leaseStatusLabel(lease.status)}</small></div>
                  <div><span>Agent / Worker</span><code>{lease.agentId} / {lease.workerId}</code></div>
                  <div><span>更新时间</span><time>{formatTime(lease.updatedAt)}</time></div>
                  <div><span>释放原因</span><small>{lease.lastError || "—"}</small></div>
                 </div>
               ))}
             </div>
             {historyPagination.pages > 1 ? (
               <div className="orchestration-queue-footer orchestration-lease-pager">
                 <span>{historyPagination.start}–{historyPagination.end} / 共 {historyPagination.total} 条</span>
                 <div className="orchestration-queue-pager">
                   <button className="btn btn-ghost btn-sm" disabled={!historyPagination.hasPrevious} onClick={() => setLeaseHistoryOffset(historyPagination.offset - LEASE_HISTORY_PAGE_SIZE)}>上一页</button>
                   <span className="orchestration-queue-page">第 {historyPagination.page} / {historyPagination.pages} 页</span>
                   <button className="btn btn-ghost btn-sm" disabled={!historyPagination.hasNext} onClick={() => setLeaseHistoryOffset(historyPagination.offset + LEASE_HISTORY_PAGE_SIZE)}>下一页</button>
                 </div>
               </div>
             ) : null}
           </details>
        ) : null}
      </section>

      <section className="orchestration-queues" aria-label="工作队列">
        {QUEUES.map((queue) => {
          const items = data.queues[queue.key];
          const executableQueue: AgentExecutableQueueKey | null = queue.key === "managerApproval" ? null : queue.key;
          const claimCandidate = executableQueue
            ? items.find((item) => item.available !== false)
            : undefined;
          // Refreshes preserve the current page when possible and clamp to a real page boundary when the queue shrinks.
          const pagination = paginateOrchestrationQueue(items, offsets[queue.key]);
          return (
            <article className={`orchestration-queue queue-${queue.key}`} key={queue.key}>
              <QueueCardHeader label={queue.label} count={items.length} />
              <div className="orchestration-owner">责任主体 · {queue.owner}</div>
              {executableQueue ? (
                <p className="orchestration-quiet">{claimCandidate
                  ? executableQueue === "approval"
                    ? "请由已认证的 Main Agent 在 MCP 中领取独立 Approver 工单并审核；本页面不保存凭据。"
                    : "请由已认证的 Main Agent 在 MCP 中领取父协调租约并派发；本页面不保存凭据。"
                  : items.length > 0 ? "当前任务暂不可领取，请查看任务的阻塞原因。" : "当前无任务。"}</p>
              ) : null}
              <div className="orchestration-task-list">
                {items.length === 0 && <div className="orchestration-quiet">当前无任务</div>}
                {pagination.visible.map((item) => (
                  <div className="orchestration-task-row" key={item.id}>
                    <button className="orchestration-task" onClick={() => item.href && navigate(item.href)}>
                      <span><b>{item.priority}</b>{item.deliveryLayer ? `第 ${item.deliveryLayer} 层 · ` : ""}{item.title}</span>
                      <small>{item.reason}</small>
                      {executableQueue ? <small>受派身份：{item.assignee?.displayName || item.assignee?.agentId || "未分配"}</small> : null}
                      {executableQueue ? <small>Worker 池：{item.poolId || item.assignee?.poolId || "兼容池"} · 资源范围：{item.workScopes?.join("、") || "自动"}</small> : null}
                      {executableQueue && item.activeLease ? <small>已由 {item.activeLease.agentId} 领取 · 租约至 {formatTime(item.activeLease.leaseExpiresAt)}</small> : null}
                      {executableQueue && !item.activeLease && item.available === false ? <small>{item.availabilityReason}</small> : null}
                      {executableQueue && item.attempt ? <small>已尝试 {item.attempt} 次</small> : null}
                      <ExternalLink />
                    </button>
                    {executableQueue === "design" && item.available !== false || item.planItemId && executableQueue
                      ? <button className="btn btn-ghost btn-sm" onClick={() => void previewHandoff(item)}>预览只读交接</button> : null}
                  </div>
                ))}
              </div>
              {items.length > ORCHESTRATION_QUEUE_PAGE_SIZE && (
                <div className="orchestration-queue-footer">
                  <span>{pagination.start}–{pagination.end} / 共 {pagination.total} 条</span>
                  <div className="orchestration-queue-pager">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!pagination.hasPrevious}
                      onClick={() => setOffsets((prev) => setOrchestrationQueueOffset(prev, queue.key, pagination.offset - ORCHESTRATION_QUEUE_PAGE_SIZE))}
                    >上一页</button>
                    <span className="orchestration-queue-page">第 {pagination.page} / {pagination.pages} 页</span>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={!pagination.hasNext}
                      onClick={() => setOffsets((prev) => setOrchestrationQueueOffset(prev, queue.key, pagination.offset + ORCHESTRATION_QUEUE_PAGE_SIZE))}
                    >下一页</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="orchestration-section" aria-label="Worker 池与运行实例">
        <div className="orchestration-section-title">
          <div><span>RUNTIME</span><h2>Worker 池与独立工作区</h2></div>
          <p>计划绑定池，具体进程使用唯一 workerId；施工并发必须使用不同工作区。</p>
        </div>
        <div className="orchestration-worker-grid">
          {runtimePagination.visible.map((item) => item.kind === "pool" ? (
            <article key={item.pool.id}>
              <span>POOL · {item.pool.role.toUpperCase()}</span>
              <strong>{item.pool.name}</strong>
              <code>{item.pool.id}</code>
              <small>{item.pool.status === "active" ? "可派发" : "已暂停"} · 上限 {item.pool.maxActive}</small>
            </article>
          ) : (
            <article key={item.runner.id} className={`worker-${item.runner.status}`}>
              <span>WORKER · {item.runner.status.toUpperCase()}</span>
              <strong>{item.runner.workerId}</strong>
              <code>{item.runner.poolId || "兼容池"}</code>
              <small>{item.runner.workspacePath || "尚未启动独立工作区"}</small>
            </article>
          ))}
          {runtimeItems.length === 0
            ? <div className="orchestration-quiet">尚未形成 Worker 池；保存计划角色或领取任务后自动出现。</div>
            : null}
        </div>
        {runtimeItems.length > RUNTIME_PAGE_SIZE ? (
          <div className="orchestration-queue-footer" data-testid="runtime-pagination">
            <span>{runtimePagination.start}–{runtimePagination.end} / 共 {runtimePagination.total} 条</span>
            <div className="orchestration-queue-pager">
              <button className="btn btn-ghost btn-sm" disabled={!runtimePagination.hasPrevious} onClick={() => setRuntimeOffset(runtimePagination.offset - RUNTIME_PAGE_SIZE)}>上一页</button>
              <span className="orchestration-queue-page">第 {runtimePagination.page} / {runtimePagination.pages} 页</span>
              <button className="btn btn-ghost btn-sm" disabled={!runtimePagination.hasNext} onClick={() => setRuntimeOffset(runtimePagination.offset + RUNTIME_PAGE_SIZE)}>下一页</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="orchestration-section">
        <div className="orchestration-section-title"><div><span>01</span><h2>建议创建的 Agent</h2></div><p>管理员是人，不由外部编排器自动创建。</p></div>
        <div className="orchestration-roles">
          {data.recommendedAgents.map((role) => {
            const Icon = ROLE_ICONS[role.key];
            return (
              <article className="orchestration-role" key={role.key}>
                <div className="orchestration-role-title"><Icon /><div><strong>{role.name}</strong><small>{role.key.toUpperCase()}</small></div><button className="btn btn-ghost btn-icon orchestration-role-edit" onClick={() => void openEdit(role.key, role.name)} aria-label={`编辑 ${role.name}`}><Pencil size={14} /></button></div>
                <p>{role.purpose}</p>
                <div className="orchestration-role-columns">
                  <div><h3>负责</h3>{role.responsibilities.map((item) => <span key={item}>+ {item}</span>)}</div>
                  <div><h3>禁止</h3>{role.boundaries.map((item) => <span key={item}>− {item}</span>)}</div>
                </div>
                <div className="orchestration-role-tools"><h3>允许的工具</h3>{role.allowedMcpTools.map((item) => <code key={item}>{item}</code>)}</div>
              </article>
            );
          })}
          <article className="orchestration-role manager-card">
            <div className="orchestration-role-title"><UserCheck /><div><strong>管理员</strong><small>HUMAN GATE</small></div></div>
            <p>仅处理 human-only 高风险操作的执行授权；审核、计划批准和最终验收由 Main Agent 完成，证据不足时退回补齐。</p>
            <div className="manager-lock">不会出现在 recommendedAgents 中，也不能被启动提示词自动创建。</div>
          </article>
        </div>
      </section>

      <section className="orchestration-section">
        <div className="orchestration-section-title"><div><span>02</span><h2>交接链</h2></div><p>每次交接保留关联 ID 和证据，不覆盖历史。</p></div>
        <div className="orchestration-handoffs">
          {data.handoffs.map((handoff, index) => (
            <div className="orchestration-handoff" key={`${handoff.from}-${handoff.to}-${index}`}>
              <b>{handoff.from}</b><ArrowRight /><b>{handoff.to}</b><span>{handoff.when}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="orchestration-section bootstrap-section">
        <div className="orchestration-section-title"><div><span>03</span><h2>外部编排启动提示词</h2></div><p>Codex、Trae 等外部通用 Agent 通过 MCP 读取同一份机器数据。</p></div>
        <pre>{data.bootstrapPrompt}</pre>
      </section>

      {releaseTarget ? (
        <Modal
          title="手动释放租约"
          onClose={() => { if (!releasingLeaseId) { setReleaseTarget(null); setReleaseReason(""); } }}
          width={560}
          footer={(
            <>
              <button className="btn" disabled={Boolean(releasingLeaseId)} onClick={() => { setReleaseTarget(null); setReleaseReason(""); }}>取消</button>
              <button className="btn btn-danger" disabled={!releaseReason.trim() || Boolean(releasingLeaseId)} onClick={() => void confirmManualRelease()}>
                {releasingLeaseId ? "释放中…" : "确认释放"}
              </button>
            </>
          )}
        >
          <p>这会释放 <code>{releaseTarget.workOrderId}</code> 当前租约，清理资源锁并让任务可以稍后重新领取。正在运行的 Worker 不会被终止，后续心跳会收到 <code>LEASE_LOST</code>。</p>
          <div className="form-grid">
            <Field label="释放原因" wide>
              <textarea autoFocus value={releaseReason} maxLength={4000} rows={4} placeholder="例如：Runner 已停止，需要回收卡住的租约" onChange={(event) => setReleaseReason(event.target.value)} />
            </Field>
          </div>
        </Modal>
      ) : null}

      {editing && draft ? (
        <Modal
          title={`编辑 ${draft.name}`}
          onClose={() => { setEditing(null); setDraft(null); }}
          width={640}
          footer={(
            <>
              <button className="btn" onClick={() => { setEditing(null); setDraft(null); }}>取消</button>
              <button className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={() => void saveBlueprint()}>{saving ? "保存中…" : "保存"}</button>
            </>
          )}
        >
          <div className="form-grid">
            <Field label="名称">
              <input value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </Field>
            <Field label="职责说明">
              <textarea value={draft.purpose} rows={3} onChange={(event) => setDraft({ ...draft, purpose: event.target.value })} />
            </Field>
            <Field label="负责（每行或逗号分隔一条）" wide>
              <textarea value={draft.responsibilities.join("\n")} rows={5} onChange={(event) => setDraft({ ...draft, responsibilities: splitList(event.target.value) })} />
            </Field>
            <Field label="禁止（每行或逗号分隔一条）" wide>
              <textarea value={draft.boundaries.join("\n")} rows={5} onChange={(event) => setDraft({ ...draft, boundaries: splitList(event.target.value) })} />
            </Field>
            <Field label="允许的工具（逗号分隔）" wide>
              <textarea value={draft.allowedMcpTools.join(", ")} rows={3} onChange={(event) => setDraft({ ...draft, allowedMcpTools: splitList(event.target.value) })} placeholder="get_project_workflow, create_document, ..." />
            </Field>
          </div>
          <p className="orchestration-edit-hint">保存后对所有项目生效。启动提示词会按默认规则重新生成，无需手改。</p>
        </Modal>
      ) : null}
    </div>
  );
}
