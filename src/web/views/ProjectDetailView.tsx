import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronLeft, Eye, Link as LinkIcon, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  DESIGN_DOC_STATUSES,
  DESIGN_STATUSES,
  DEVELOPMENT_STATUSES,
  DIAGRAM_DEVELOPMENT_STATUSES,
  NODE_KINDS,
  PLAN_KINDS,
  PLAN_STATUSES,
  PRIORITIES,
  REQUIREMENT_STATUSES,
  TEST_STATUSES,
  type Evidence,
  type DesignDoc,
  type DocumentReference,
  type GovernanceRecord,
  type PlanItem,
  type Project,
  type ProjectWorkflow,
  type ProjectWorkspace,
  type ProjectWorkspaceNode,
  type WorkNode,
} from "../../shared/types";
import { PROJECT_WORKFLOW_POLICY } from "../../shared/workflowPolicy";
import { displayAssignment, normalizeRoleAssignments, roleAssignmentErrors } from "../../shared/planRoles";
import { PLAN_DELIVERY_STEPS, PLAN_LIFECYCLE_LABELS, planLifecycleStep } from "../../shared/planDelivery";
import { api } from "../api";
import { navigate } from "../App";
import { DatabaseWorkbenchView } from "./DatabaseWorkbenchView";
import { setWorkspaceSelection } from "./workspace";
import { agentVisibleContent, useAgentUiBridge } from "./agentUiBridge";
import { DocumentReferencePanel } from "./DocumentReferencePanel";
import { designChangeIdFromBlockedReason, planDeliveryHref } from "./planNavigation";
import { administratorNextStep, groupDesignDocuments, projectPurpose } from "./projectInformation";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Field,
  HealthBadge,
  Modal,
  Pagination,
  ProgressBar,
  Select,
  Spinner,
  StatCard,
  StageBadge,
  formatDate,
  formatDateTime,
} from "../ui";

const TAB_LABELS = [
  ["nodes", "画布节点"],
  ["workflow", "推进流程"],
  ["plans", "计划"],
  ["documents", "文档"],
  ["database", "数据库设计"],
  ["evidence", "证据"],
  ["governance", "治理记录"],
] as const;

type TabKey = (typeof TAB_LABELS)[number][0];

const NODE_KIND_LABELS: Record<WorkNode["kind"], string> = {
  module: "模块",
  feature: "功能",
  requirement: "需求",
  development: "开发",
  test: "测试",
};

const PLAN_KIND_ORDER: Record<PlanItem["kind"], number> = {
  goal: 0, milestone: 1, version: 2, task: 3,
};
const PLAN_KIND_LABELS: Record<PlanItem["kind"], string> = {
  goal: "目标", milestone: "里程碑", version: "版本", task: "任务",
};

const PLAN_STATUS_TONE: Record<PlanItem["status"], "good" | "warn" | "bad" | "info" | "neutral" | "muted"> = {
  未开始: "muted", 进行中: "info", 已完成: "good", 已阻塞: "bad",
};
const PLAN_PRIORITY_TONE: Record<PlanItem["priority"], "good" | "warn" | "bad" | "info" | "neutral" | "muted"> = {
  P0: "bad", P1: "warn", P2: "neutral", P3: "muted",
};
const PLAN_KIND_TONE: Record<PlanItem["kind"], "good" | "warn" | "bad" | "info" | "neutral" | "muted" | "accent"> = {
  goal: "accent", milestone: "info", version: "warn", task: "neutral",
};
const PLAN_AUDIT_LABELS: Record<PlanItem["auditStatus"], string> = {
  not_requested: "未请求审计", pending: "等待独立审计", passed: "审计通过", failed: "审计未通过",
};
const MANAGER_DECISION_LABELS: Record<PlanItem["managerDecision"], string> = {
  pending: "等待管理员决定", approved: "管理员已批准", rejected: "管理员已拒绝",
};
const EXECUTABLE_PLAN_KINDS = new Set<string>(PROJECT_WORKFLOW_POLICY.executablePlanKinds);

function tabFrom(value?: string): TabKey {
  return TAB_LABELS.some(([key]) => key === value) ? value as TabKey : "nodes";
}

export function ProjectDetailView(props: { projectId: string; initialTab?: string }): ReactElement {
  const id = props.projectId;
  const [project, setProject] = useState<Project | null>(null);
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null);
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [planTotal, setPlanTotal] = useState(0);
  const [planOffset, setPlanOffset] = useState(0);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const [tab, setTab] = useState<TabKey>(() => tabFrom(props.initialTab));
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const reloadAll = useCallback(() => {
    api.getProjectWorkspace(id).then((value) => { setWorkspace(value); setProject(value.project); }).catch((e) => setError(e.message));
    api.pagePlans(id, { offset: planOffset, limit: 20 }).then((page) => { setPlans(page.items); setPlanTotal(page.total); }).catch(() => undefined);
    api.pageEvidence(id, { offset: evidenceOffset, limit: 20 }).then((page) => { setEvidence(page.items); setEvidenceTotal(page.total); }).catch(() => undefined);
  }, [id, planOffset, evidenceOffset]);

  useEffect(() => { reloadAll(); }, [reloadAll]);
  useEffect(() => { setTab(tabFrom(props.initialTab)); }, [props.initialTab]);

  if (error && !project) return <ErrorBanner message={error} />;
  if (!project) return <Spinner />;

  const databaseFocus = tab === "database";
  const purpose = projectPurpose(project);
  const nextAdministratorAction = administratorNextStep(project);

  return (
    <div className={databaseFocus ? "project-detail-database" : undefined}>
      <a className="back-link" href="#/projects" onClick={(e) => { e.preventDefault(); navigate("#/projects"); }}>
        <ChevronLeft size={15} /> 返回项目列表
      </a>

      {databaseFocus ? (
        <section className="project-db-context">
          <div>
            <span className="project-db-eyebrow">DATABASE WORKSPACE</span>
            <div className="detail-title">
              <h1>{project.name}</h1>
              <span className="detail-code">{project.code}</span>
              <StageBadge stage={project.stage} />
              {project.unconfigured ? <Badge tone="warn">待配置</Badge> : <HealthBadge health={project.health} />}
            </div>
            <p>数据库模型属于当前项目，ER 关系、校验与实体代码在同一工作区维护。</p>
          </div>
          {workspace?.mainDiagram ? (
            <button className="btn" onClick={() => { setWorkspaceSelection(id); navigate(`#/canvas/${workspace.mainDiagram!.id}`); }}>打开系统主画布</button>
          ) : null}
        </section>
      ) : <>
      <div className="detail-head">
        <div className="detail-title">
          <h1>{project.name}</h1>
          <span className="detail-code">{project.code}</span>
          <StageBadge stage={project.stage} />
          {project.unconfigured ? <Badge tone="warn">待配置</Badge> : <HealthBadge health={project.health} />}
          <Badge tone={project.riskLevel === "P0" || project.riskLevel === "P1" ? "bad" : "neutral"}>
            风险 {project.riskLevel}
          </Badge>
        </div>
        <div className="inline-actions">
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            <Pencil size={14} /> {editing ? "取消编辑" : "编辑"}
          </button>
        </div>
      </div>
      <div className="detail-meta">
        <ProgressBar value={project.progress} />
        <span className="cell-sub">
          {project.startAt ? `起 ${formatDate(project.startAt)}` : ""}{" "}
          {project.dueAt ? `· 止 ${formatDate(project.dueAt)}` : ""}
        </span>
      </div>

      <section className="project-orientation" aria-label="项目管理摘要">
        <article className={purpose.needsBrief ? "needs-brief" : undefined}>
          <span>项目用途</span>
          <h2>{purpose.text}</h2>
          <p>{purpose.needsBrief ? "自动导入只登记项目，不会生成正式简报。请先补充并批准项目级需求文档。" : "该说明来自当前项目资料，用于确认项目范围与交付方向。"}</p>
        </article>
        <article>
          <span>管理员下一步</span>
          <h2>{nextAdministratorAction}</h2>
          <p>在“推进流程”中查看当前门禁与责任人，完成后再推进下一阶段。</p>
          <button className="btn btn-primary btn-sm" onClick={() => { setTab("workflow"); navigate(`#/projects/${id}?tab=workflow`); }}>查看推进流程 <ArrowRight size={13} /></button>
        </article>
      </section>

      {workspace ? (
        <div className="stat-grid">
          <StatCard label="画布工作节点" value={workspace.metrics.functionalNodes} hint={`已完成 ${workspace.metrics.completedNodes}`} tone="accent" />
          <StatCard label="已验收" value={workspace.metrics.acceptedNodes} hint={`待验收 ${workspace.metrics.pendingAcceptanceNodes}`} tone="good" />
          <StatCard label="开发计划" value={`${workspace.metrics.completedPlans}/${workspace.metrics.plans}`} hint={workspace.currentPlan?.title ?? workspace.nextPlan?.title ?? "暂无计划"} tone="info" />
          <StatCard label="文档" value={workspace.metrics.documents} hint="需求、设计、测试与验收资料" tone="neutral" />
          <StatCard label="证据" value={workspace.metrics.evidence} hint={workspace.metrics.missingEvidenceNodes ? `${workspace.metrics.missingEvidenceNodes} 个节点缺证据` : "证据状态正常"} tone={workspace.metrics.missingEvidenceNodes ? "warn" : "good"} />
        </div>
      ) : null}

      {workspace?.mainDiagram ? (
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => { setWorkspaceSelection(id); navigate(`#/canvas/${workspace.mainDiagram!.id}`); }}>打开系统主画布</button>
          <span className="cell-sub">项目状态由画布节点、开发计划、文档与验收证据自动汇总</span>
        </div>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {editing ? (
        <EditPanel
          project={project}
          onSaved={() => { setEditing(false); reloadAll(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="panel">
          <dl className="meta-list">
            <dt>项目用途</dt><dd>{purpose.text}</dd>
            <dt>风险</dt><dd>{project.riskSummary || "—"}</dd>
            <dt>阻塞</dt><dd>{project.blockerSummary || "无"}</dd>
            <dt>人工维护提示</dt><dd>{project.nextStep || "未填写"}</dd>
            <dt>托管目录</dt>
            <dd className="mono">data/projects/{project.id}</dd>
          </dl>
        </div>
      )}
      </>}

      <div className={`tabs ${databaseFocus ? "project-focus-tabs" : ""}`}>
        {TAB_LABELS.map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => {
            setTab(key);
            navigate(`#/projects/${id}?tab=${key}`);
          }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "nodes" ? (
        <WorkspaceNodesTab projectId={id} mainDiagramId={workspace?.mainDiagram?.id} onError={setError} />
      ) : tab === "workflow" ? (
        <WorkflowTab projectId={id} onError={setError} />
      ) : tab === "plans" ? (
        <PlansTab projectId={id} plans={plans} total={planTotal} offset={planOffset} onPage={setPlanOffset} onChanged={reloadAll} onError={setError} />
      ) : tab === "documents" ? (
        <DocumentsTab projectId={id} onError={setError} />
      ) : tab === "database" ? (
        <DatabaseWorkbenchView projectId={id} embedded />
      ) : tab === "evidence" ? (
        <EvidenceTab
          projectId={id}
          evidence={evidence}
          total={evidenceTotal}
          offset={evidenceOffset}
          onPage={setEvidenceOffset}
          busyAction={busyAction}
          setBusyAction={setBusyAction}
          onChanged={reloadAll}
          onError={setError}
        />
      ) : (
        <GovernanceTab projectId={id} onError={setError} />
      )}
    </div>
  );
}

function WorkflowTab(props: { projectId: string; onError: (message: string) => void }): ReactElement {
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setBusy(true);
    api.getProjectWorkflow(props.projectId)
      .then(setWorkflow)
      .catch((error) => props.onError(error.message))
      .finally(() => setBusy(false));
  }, [props.projectId, props.onError]);

  useEffect(() => { load(); }, [load]);
  if (!workflow) return <Spinner />;

  const phases = Object.entries(PROJECT_WORKFLOW_POLICY.phaseLabels);
  const currentIndex = phases.findIndex(([phase]) => phase === workflow.phase);
  const totalNodes = workflow.nodes.length;
  const completedNodes = workflow.nodes.filter((node) => !node.nextAction).length;
  const approvedRequirements = workflow.nodes.filter((node) => node.requirementStatus === "已批准").length;
  const approvedDesigns = workflow.nodes.filter((node) => node.designStatus === "已批准" || node.designStatus === "不适用").length;
  const acceptedNodes = workflow.nodes.filter((node) => node.acceptanceStatus === "已通过").length;
  const issueNodes = workflow.nodes
    .filter((node) => node.developmentStatus === "已阻塞" || node.missing.length > 0 || node.nextAction)
    .sort((left, right) => Number(right.developmentStatus === "已阻塞") - Number(left.developmentStatus === "已阻塞"))
    .slice(0, 5);
  const metricProgress = (value: number) => totalNodes === 0 ? 0 : Math.round((value / totalNodes) * 100);
  return (
    <div className="workflow-panel">
      <section className={`workflow-hero status-${workflow.status}`}>
        <div>
          <span className="workflow-eyebrow">PROJECT DELIVERY PROTOCOL · v{workflow.policyVersion}</span>
          <h2>{workflow.phaseLabel}</h2>
          <p>{workflow.summary}</p>
        </div>
        <div className="workflow-hero-actions">
          <Badge tone={workflow.status === "completed" ? "good" : workflow.status === "blocked" ? "bad" : "warn"}>
            {workflow.status === "completed" ? "全部完成" : workflow.status === "blocked" ? "存在阻塞" : "可以推进"}
          </Badge>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={load}><RefreshCw size={13} /> 刷新</button>
        </div>
      </section>

      {workflow.layerGate.totalLayers > 0 && (
        <section className="workflow-layer-summary" data-testid="workflow-layer-summary">
          <strong>当前第 {workflow.layerGate.activeLayer ?? "-"} / {workflow.layerGate.totalLayers} 层</strong>
          <span>依赖已就绪 {workflow.layerGate.activePlanCount} 项 · {workflow.layerGate.lockedPlanCount} 项等待依赖</span>
        </section>
      )}

      <div className="workflow-steps" aria-label="项目设计推进阶段">
        {phases.map(([phase, label], index) => (
          <div className={`workflow-step ${index < currentIndex || workflow.status === "completed" ? "done" : index === currentIndex ? "current" : "pending"}`} key={phase}>
            <span>{index < currentIndex || workflow.status === "completed" ? <CheckCircle2 size={14} /> : index + 1}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>

      {workflow.nextAction ? (
        <section className="workflow-next-action">
          <div><span>项目关键路径</span><h3>{workflow.nextAction.title}</h3><p>{workflow.nextAction.description}</p></div>
          <button className="btn btn-primary" onClick={() => navigate(workflow.nextAction!.href)}>立即处理 <ArrowRight size={14} /></button>
        </section>
      ) : (
        <section className="workflow-next-action complete"><div><span>项目闭环</span><h3>所有交付节点均已验收</h3><p>开发计划、文档和证据已经满足协议门禁。</p></div></section>
      )}

      <section className="workflow-gate-section">
        <div className="workflow-section-heading">
          <div><h3>交付门禁</h3><p>这里只显示项目整体完成度；节点明细统一在画布节点中维护。</p></div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`#/projects/${props.projectId}?tab=nodes`)}>查看全部节点 <ArrowRight size={13} /></button>
        </div>
        <div className="workflow-gate-grid">
          {[
            ["需求已批准", approvedRequirements, "需求说明、负责人和验收条件已确认"],
            ["设计已就绪", approvedDesigns, "设计文档和数据库关联满足门禁"],
            ["验收已通过", acceptedNodes, "开发完成且证据已经通过验收"],
            ["节点已闭环", completedNodes, "当前没有待执行的下一步动作"],
          ].map(([label, value, description]) => (
            <article className="workflow-gate-card" key={String(label)}>
              <div className="workflow-gate-value"><strong>{value}</strong><span>/ {totalNodes}</span></div>
              <div><h4>{label}</h4><p>{description}</p></div>
              <div className="workflow-gate-track" aria-label={`${label} ${metricProgress(Number(value))}%`}><span style={{ width: `${metricProgress(Number(value))}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-issue-section">
        <div className="workflow-section-heading">
          <div><h3>优先处理</h3><p>最多显示 5 个阻塞或缺失项，避免与节点清单重复。</p></div>
          <span>{issueNodes.length === 0 ? "无待处理项" : `显示 ${issueNodes.length} 项`}</span>
        </div>
        {totalNodes === 0 ? <EmptyState text="还没有可交付节点，请先从系统主画布拆分模块和功能。" /> : issueNodes.length === 0 ? (
          <div className="workflow-all-clear"><CheckCircle2 size={16} /> 当前没有阻塞项，按上方项目关键路径继续推进；并行 Worker 任务由编排页单独派发。</div>
        ) : (
          <div className="workflow-issue-list">
            {issueNodes.map((node) => (
              <button className="workflow-issue-row" key={`${node.diagramId}:${node.nodeId}`} onClick={() => navigate(node.nextAction?.href ?? `#/canvas/${node.diagramId}/node/${node.nodeId}`)}>
                <span className={`workflow-issue-mark ${node.developmentStatus === "已阻塞" ? "blocked" : ""}`} />
                <span className="workflow-issue-copy">
                  <strong>{node.nodeLabel}</strong>
                  <small>{node.developmentStatus === "已阻塞" ? "开发阻塞" : node.nextAction?.title ?? node.missing[0]} · {node.diagramTitle}</small>
                </span>
                <span className="workflow-issue-meta">{node.missing.length > 0 ? `缺 ${node.missing.length} 项` : "待处理"}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EditPanel(props: { project: Project; onSaved: () => void; onCancel: () => void }): ReactElement {
  const [form, setForm] = useState({ ...props.project });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof Project, value: unknown) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="panel">
      {error ? <ErrorBanner message={error} /> : null}
      <div className="kv-edit">
        <Field label="名称"><input value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="风险等级">
          <select value={form.riskLevel} onChange={(e) => set("riskLevel", e.target.value)}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="文件存储">
          <input value={`data/projects/${props.project.id}`} readOnly />
        </Field>
        <Field label="外部 Agent 目标目录" wide>
          <input
            value={form.repositoryPath}
            onChange={(e) => set("repositoryPath", e.target.value)}
            placeholder="例如 D:\\project\\FiveBear；留空则不允许领取开发任务"
          />
        </Field>
        <Field label="开始日期"><input type="date" value={form.startAt.slice(0, 10)} onChange={(e) => set("startAt", e.target.value)} /></Field>
        <Field label="截止日期"><input type="date" value={form.dueAt.slice(0, 10)} onChange={(e) => set("dueAt", e.target.value)} /></Field>
        <Field label="摘要" wide><textarea rows={2} value={form.summary} onChange={(e) => set("summary", e.target.value)} /></Field>
        <Field label="风险说明" wide><textarea rows={2} value={form.riskSummary} onChange={(e) => set("riskSummary", e.target.value)} /></Field>
        <Field label="阻塞说明" wide><textarea rows={2} value={form.blockerSummary} onChange={(e) => set("blockerSummary", e.target.value)} /></Field>
      </div>
      <div className="inline-actions">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            setBusy(true); setError("");
            api.updateProject(props.project.id, {
              name: form.name,
              riskLevel: form.riskLevel,
              repositoryPath: form.repositoryPath,
              startAt: form.startAt.slice(0, 10), dueAt: form.dueAt.slice(0, 10),
              summary: form.summary, riskSummary: form.riskSummary,
              blockerSummary: form.blockerSummary,
            })
              .then(() => props.onSaved())
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          保存
        </button>
        <button className="btn" onClick={props.onCancel}>取消</button>
      </div>
    </div>
  );
}

function WorkspaceNodesTab(props: { projectId: string; mainDiagramId?: string; onError: (message: string) => void }): ReactElement {
  const limit = 20;
  const [items, setItems] = useState<ProjectWorkspaceNode[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [devStatus, setDevStatus] = useState("");

  useEffect(() => {
    api.pageProjectWorkspaceNodes(props.projectId, { q: q.trim() || undefined, developmentStatus: devStatus || undefined, offset, limit })
      .then((page) => { setItems(page.items); setTotal(page.total); })
      .catch((e) => props.onError(e.message));
  }, [props.projectId, q, devStatus, offset]);

  return (
    <div>
      <div className="toolbar">
        <input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0); }} placeholder="搜索节点 / 所属画布" style={{ width: 260 }} />
        <Select
          value={devStatus}
          onChange={(value) => { setDevStatus(value); setOffset(0); }}
          width={150}
          ariaLabel="按开发状态筛选"
          options={[{ value: "", label: "全部开发状态" }, ...DIAGRAM_DEVELOPMENT_STATUSES.map((status) => ({ value: status, label: status }))]}
        />
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => { setWorkspaceSelection(props.projectId); navigate(props.mainDiagramId ? `#/canvas/${props.mainDiagramId}` : "#/canvas"); }}>在画布中管理节点</button>
      </div>
      {!items ? <Spinner /> : items.length === 0 ? (
        <EmptyState text={q ? "没有匹配的画布节点。" : "系统主画布还没有模块、功能或需求节点。请在画布中建立项目结构。"} />
      ) : (
        <table className="table">
          <thead><tr><th>节点</th><th>所属画布</th><th>开发</th><th>验收</th><th>业务负责人</th><th>交付角色</th><th>最后更新</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={`${item.diagramId}:${item.node.id}`}
                className="row-link"
                role="link"
                tabIndex={0}
                onClick={() => navigate(`#/canvas/${item.diagramId}/node/${item.node.id}`)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`#/canvas/${item.diagramId}/node/${item.node.id}`); } }}
              >
                <td><div className="cell-main">{item.node.label}</div><div className="cell-sub">{item.node.kind}</div></td>
                <td>{item.diagramTitle}</td>
                <td><Badge tone={item.node.developmentStatus === "已完成" ? "good" : item.node.developmentStatus === "已阻塞" ? "bad" : item.node.developmentStatus === "开发中" ? "warn" : "muted"}>{item.node.developmentStatus ?? "未开发"}</Badge></td>
                <td><Badge tone={item.node.acceptanceStatus === "已通过" ? "good" : item.node.acceptanceStatus === "未通过" ? "bad" : "muted"}>{item.node.acceptanceStatus ?? "未验收"}</Badge></td>
                <td>{item.node.owner || "—"}</td>
                <td className="cell-sub">
                  {item.deliveryRoleAssignments ? (
                    <div>设计：{displayAssignment(item.deliveryRoleAssignments.designer)}<br />施工：{displayAssignment(item.deliveryRoleAssignments.builder)}<br />审计：{displayAssignment(item.deliveryRoleAssignments.auditor)}</div>
                  ) : "—"}
                </td>
                <td className="cell-sub mono">{formatDateTime(item.node.deliveryUpdatedAt ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />
    </div>
  );
}

function DocumentsTab(props: { projectId: string; onError: (message: string) => void }): ReactElement {
  const limit = 20;
  const [items, setItems] = useState<DesignDoc[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<{ doc: DesignDoc } | null>(null);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  const reload = useCallback(() => {
    api.pageDesignDocs({ projectId: props.projectId, q: q.trim() || undefined, status: statusFilter || undefined, offset, limit })
      .then((page) => {
        setItems(page.items); setTotal(page.total);
        setDetail((current) => current ? { doc: page.items.find((doc) => doc.id === current.doc.id) ?? current.doc } : null);
      })
      .catch((e) => props.onError(e.message));
  }, [offset, props.onError, props.projectId, q, statusFilter]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!items || detail) return;
    setPageContextDetail({
      projectId: props.projectId,
      pageType: "document",
      title: "项目文档",
      entityRefs: [{ type: "project", id: props.projectId }, ...items.map((doc) => ({ type: "designDocument" as const, id: doc.id, label: doc.title }))],
      selection: { entityRefs: [] },
      draft: null,
      visibleContent: agentVisibleContent("documentList", "当前可见项目文档", items.map((doc) => ({
        id: doc.id, title: doc.title, category: doc.category, status: doc.status, summary: doc.summary,
        version: doc.version, author: doc.author, currentRevisionId: doc.currentRevisionId, updatedAt: doc.updatedAt,
      }))),
    });
  }, [detail, items, props.projectId, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (lastEntityChange?.value.entityType === "designDocument" && lastEntityChange.value.projectId === props.projectId) reload();
  }, [lastEntityChange, props.projectId, reload]);

  const documentGroups = groupDesignDocuments(items ?? []);

  return (
    <div>
      <DocumentReferencePanel
        projectId={props.projectId}
        targetType="project"
        targetId={props.projectId}
        relationType="defines"
        title="项目简报与系统级依据"
        description="下方是项目完整文档库；这里只引用定义项目目标、范围和约束的固定文档版本。"
      />
      <div className="toolbar">
        <input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0); }} placeholder="搜索标题 / 摘要 / 作者" style={{ width: 240 }} />
        <Select
          value={statusFilter}
          onChange={(value) => { setStatusFilter(value); setOffset(0); }}
          width={160}
          ariaLabel="按文档状态筛选"
          options={[{ value: "", label: "全部状态" }, ...DESIGN_DOC_STATUSES.map((status) => ({ value: status, label: status }))]}
        />
        <div className="spacer" />
        <button className="btn" onClick={() => { setWorkspaceSelection(props.projectId); navigate("#/design"); }}>打开设计中枢</button>
      </div>
      {!items ? <Spinner /> : items.length === 0 ? (
        <EmptyState text={statusFilter ? "没有符合该状态的设计文档。" : "当前项目还没有设计文档，可在设计中枢中创建。"} />
      ) : (
        <div className="project-doc-groups">
          {documentGroups.filter((group) => group.items.length > 0).map((group) => <section className="project-doc-group" key={group.key}>
            <header>
              <div><span>{group.key.toUpperCase()}</span><h3>{group.label}</h3></div>
              <p>{group.description}</p>
              <strong>{group.items.length}</strong>
            </header>
            <div className="doc-list">
          {group.items.map((doc) => (
            <article
              className="doc-row doc-row-card"
              key={doc.id}
              role="button"
              tabIndex={0}
              onClick={() => setDetail({ doc })}
              onKeyDown={(event) => {
                if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault(); setDetail({ doc });
                }
              }}
            >
              <div className="doc-main">
                <div className="doc-title">
                  <span className="doc-title-text">{doc.title}</span>
                  <Badge tone="info">{doc.category}</Badge>
                  <Badge tone={doc.status === "已批准" ? "good" : doc.status === "评审中" ? "warn" : "muted"}>{doc.status}</Badge>
                  {doc.version ? <span className="doc-version mono">{doc.version}</span> : null}
                </div>
                {doc.summary ? <div className="doc-summary">{doc.summary}</div> : null}
                <div className="doc-meta">
                  <span>{doc.author || "未署名"}</span>
                  <span className="doc-meta-dot">·</span>
                  <span>更新于 {formatDateTime(doc.updatedAt)}</span>
                </div>
              </div>
              <div className="inline-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(event) => { event.stopPropagation(); setDetail({ doc }); }}
                >
                  查看
                </button>
              </div>
            </article>
          ))}
            </div>
          </section>)}
        </div>
      )}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />
      {detail ? (
        <ProjectDocDetailModal
          doc={detail.doc}
          onClose={() => setDetail(null)}
          onEdit={() => { setDetail(null); setWorkspaceSelection(props.projectId); navigate("#/design"); }}
        />
      ) : null}
    </div>
  );
}

function ProjectDocDetailModal(props: { doc: DesignDoc; onClose: () => void; onEdit: () => void }): ReactElement {
  const doc = props.doc;
  const [project, setProject] = useState<Project | null>(null);
  const [references, setReferences] = useState<DocumentReference[]>([]);
  const { setPageContextDetail } = useAgentUiBridge();

  useEffect(() => {
    api.getProject(doc.projectId).then(setProject).catch(() => undefined);
    api.listDocumentReferences({ projectId: doc.projectId, documentId: doc.id }).then(setReferences).catch(() => undefined);
  }, [doc.id, doc.projectId]);

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
          <Badge tone={doc.status === "已批准" ? "good" : doc.status === "评审中" ? "warn" : "muted"}>{doc.status}</Badge>
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

// ---------- 工作节点 ----------

function NodesTab(props: {
  projectId: string;
  nodes: WorkNode[];
  onChanged: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [modal, setModal] = useState<{ node?: WorkNode } | null>(null);

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setModal({})}><Plus size={14} /> 新增工作节点</button>
      </div>
      {props.nodes.length === 0 ? (
        <EmptyState text="还没有工作节点。建议按「模块 → 功能」拆分，每个节点跟踪需求→设计→开发→测试四段状态。" />
      ) : (
        NODE_KINDS.filter((kind) => props.nodes.some((n) => n.kind === kind)).map((kind) => (
          <div className="node-group" key={kind}>
            <h3>{NODE_KIND_LABELS[kind]}（{props.nodes.filter((n) => n.kind === kind).length}）</h3>
            <table className="table">
              <tbody>
                {props.nodes.filter((n) => n.kind === kind).map((n) => (
                  <tr key={n.id}>
                    <td style={{ width: "34%" }}>
                      <div className="cell-main">{n.title}</div>
                      {n.description ? <div className="cell-sub">{n.description}</div> : null}
                    </td>
                    <td style={{ minWidth: 200 }}>
                      <div className="status-chips">
                        <span className="chip">需求:{n.requirementStatus}</span>
                        <span className="chip">设计:{n.designStatus}</span>
                        <span className="chip">开发:{n.developmentStatus}</span>
                        <span className="chip">测试:{n.testStatus}</span>
                      </div>
                    </td>
                    <td style={{ minWidth: 110 }}><ProgressBar value={n.progress} /></td>
                    <td className="cell-sub mono">{n.dueAt || ""}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn btn-ghost btn-icon" onClick={() => setModal({ node: n })} title="编辑"><Pencil size={13} /></button>
                      <button
                        className="btn btn-ghost btn-icon btn-danger"
                        title="删除"
                        onClick={() => {
                          if (window.confirm(`确认删除节点「${n.title}」？`)) {
                            api.deleteNode(n.id).then(props.onChanged).catch(props.onError);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
      {modal ? (
        <NodeModal
          projectId={props.projectId}
          node={modal.node}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); props.onChanged(); }}
        />
      ) : null}
    </div>
  );
}

function NodeModal(props: {
  projectId: string;
  node?: WorkNode;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.node;
  const [form, setForm] = useState({
    kind: existing?.kind ?? "feature",
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    priority: existing?.priority ?? "P2",
    owner: existing?.owner ?? "",
    requirementStatus: existing?.requirementStatus ?? "待整理",
    designStatus: existing?.designStatus ?? "未开始",
    developmentStatus: existing?.developmentStatus ?? "未开始",
    testStatus: existing?.testStatus ?? "未开始",
    progress: existing?.progress ?? 0,
    dueAt: existing?.dueAt ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = () => {
    setBusy(true); setError("");
    const payload = { ...form, progress: Number(form.progress), projectId: props.projectId };
    const call = existing ? api.updateNode(existing.id, payload) : api.createNode(payload);
    call.then(() => props.onSaved()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  return (
    <Modal
      title={existing ? "编辑工作节点" : "新增工作节点"}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim()} onClick={submit}>
            保存
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="类型">
          <select value={form.kind} onChange={set("kind")}>
            {NODE_KINDS.map((k) => <option key={k} value={k}>{NODE_KIND_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="标题"><input value={form.title} onChange={set("title")} /></Field>
        <Field label="优先级">
          <select value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="负责人"><input value={form.owner} onChange={set("owner")} /></Field>
        <Field label="需求状态">
          <select value={form.requirementStatus} onChange={set("requirementStatus")}>
            {REQUIREMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="设计状态">
          <select value={form.designStatus} onChange={set("designStatus")}>
            {DESIGN_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="开发状态">
          <select value={form.developmentStatus} onChange={set("developmentStatus")}>
            {DEVELOPMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="测试状态">
          <select value={form.testStatus} onChange={set("testStatus")}>
            {TEST_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label={`进度 ${form.progress}%`}>
          <input type="range" min={0} max={100} value={form.progress} onChange={(e) => setForm((f) => ({ ...f, progress: Number(e.target.value) }))} />
        </Field>
        <Field label="截止日期"><input type="date" value={form.dueAt} onChange={set("dueAt")} /></Field>
        <Field label="描述" wide><textarea rows={3} value={form.description} onChange={set("description")} /></Field>
      </div>
    </Modal>
  );
}

// ---------- 计划 ----------

function PlansTab(props: {
  projectId: string;
  plans: PlanItem[];
  total: number;
  offset: number;
  onPage: (offset: number) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [modal, setModal] = useState<{ plan?: PlanItem } | null>(null);
  const [detailPlan, setDetailPlan] = useState<PlanItem | null>(null);
  const [documentPlan, setDocumentPlan] = useState<PlanItem | null>(null);
  const [planDocuments, setPlanDocuments] = useState<DesignDoc[]>([]);
  const [planDocumentReferences, setPlanDocumentReferences] = useState<DocumentReference[]>([]);
  const [workflow, setWorkflow] = useState<ProjectWorkflow | null>(null);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();
  const sorted = useMemo(() => [...props.plans].sort(
    (a, b) => PLAN_KIND_ORDER[a.kind] - PLAN_KIND_ORDER[b.kind] || a.createdAt.localeCompare(b.createdAt),
  ), [props.plans]);

  useEffect(() => {
    api.getProjectWorkflow(props.projectId).then(setWorkflow).catch(() => undefined);
  }, [props.projectId, props.plans]);

  useEffect(() => {
    const planIds = new Set(sorted.map((plan) => plan.id));
    Promise.all([api.listDesignDocs(props.projectId), api.listDocumentReferences({ projectId: props.projectId, targetType: "plan" })])
      .then(([documents, references]) => {
        const visibleReferences = references.filter((reference) => planIds.has(reference.targetId));
        const documentIds = new Set(visibleReferences.map((reference) => reference.documentId));
        setPlanDocumentReferences(visibleReferences);
        setPlanDocuments(documents.filter((document) => documentIds.has(document.id)));
      })
      .catch(() => undefined);
  }, [props.projectId, sorted]);
  const layerByPlanId = useMemo(() => new Map(workflow?.layerGate.plans.map((state) => [state.planId, state]) ?? []), [workflow]);

  useEffect(() => {
    if (modal) return;
    const selectedReferences = detailPlan
      ? planDocumentReferences.filter((reference) => reference.targetId === detailPlan.id)
      : planDocumentReferences;
    const selectedDocumentIds = new Set(selectedReferences.map((reference) => reference.documentId));
    const selectedDocuments = detailPlan
      ? planDocuments.filter((document) => selectedDocumentIds.has(document.id))
      : planDocuments;
    setPageContextDetail({
      projectId: props.projectId,
      pageType: "plan",
      title: detailPlan ? `计划详情 · ${detailPlan.title}` : "项目开发计划",
      entityRefs: [{ type: "project", id: props.projectId }, ...(detailPlan ? [{ type: "plan" as const, id: detailPlan.id, label: detailPlan.title }] : sorted.map((plan) => ({ type: "plan" as const, id: plan.id, label: plan.title }))), ...selectedDocuments.map((document) => ({ type: "designDocument" as const, id: document.id, label: document.title }))],
      selection: { entityRefs: detailPlan ? [{ type: "plan", id: detailPlan.id, label: detailPlan.title }] : [] },
      draft: null,
      visibleContent: detailPlan
        ? agentVisibleContent("plan", detailPlan.title, { plan: detailPlan, documents: selectedDocuments, documentReferences: selectedReferences })
        : agentVisibleContent("planList", "当前可见开发计划及引用文档", { plans: sorted, documents: planDocuments, documentReferences: planDocumentReferences }),
    });
  }, [detailPlan, modal, planDocumentReferences, planDocuments, props.projectId, setPageContextDetail, sorted]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (lastEntityChange?.value.entityType === "plan" && lastEntityChange.value.projectId === props.projectId) props.onChanged();
  }, [lastEntityChange, props.onChanged, props.projectId]);

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setModal({})}><Plus size={14} /> 新增计划项</button>
        {workflow?.layerGate.totalLayers ? <span className="cell-sub">拓扑层级 {workflow.layerGate.totalLayers} 层；任务在自身依赖验收后解锁</span> : null}
      </div>
      {sorted.length === 0 ? (
        <EmptyState text="还没有计划项。可按 目标 → 里程碑 → 版本 → 任务 分层规划。" />
      ) : (
        <table className="table">
          <thead>
            <tr><th>标题</th><th>层级</th><th>类型</th><th>状态</th><th>优先级</th><th>进度</th><th>截止</th><th>依赖</th><th></th></tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.id}>
                <td>
                  <button className="plan-title-link" onClick={() => setDetailPlan(p)}>{p.title}</button>
                  {p.kind === "task" ? <div className="cell-sub">设计 {displayAssignment(p.roleAssignments.designer)} · 施工 {displayAssignment(p.roleAssignments.builder)} · 审计 {displayAssignment(p.roleAssignments.auditor)}</div> : p.owner ? <div className="cell-sub">{p.owner}</div> : null}
                  {p.versionTag ? <div className="cell-sub mono">{p.versionTag}</div> : null}
                  {EXECUTABLE_PLAN_KINDS.has(p.kind) && p.diagramId && p.diagramNodeId ? (
                    <button className="plan-node-link" onClick={() => navigate(planDeliveryHref(p)!)}>
                      进入实施流程
                    </button>
                  ) : null}
                  {p.blockedReason ? <div className="plan-blocked-note">
                    <PlanBlockedReason
                      reason={p.blockedReason}
                      hasDocuments={planDocumentReferences.some((reference) => reference.targetId === p.id)}
                      onDocuments={() => setDocumentPlan(p)}
                    />
                  </div> : null}
                </td>
                <td>{layerByPlanId.get(p.id) ? <><Badge tone={layerByPlanId.get(p.id)?.locked ? "muted" : "info"}>第 {layerByPlanId.get(p.id)?.layer} 层</Badge>{layerByPlanId.get(p.id)?.locked ? <div className="cell-sub">{layerByPlanId.get(p.id)?.lockReason}</div> : null}</> : "—"}</td>
                <td><Badge tone={p.kind === "goal" ? "accent" : p.kind === "milestone" ? "info" : "neutral"}>{PLAN_KIND_LABELS[p.kind]}</Badge></td>
                <td>
                  <Badge tone={p.status === "已完成" ? "good" : p.status === "已阻塞" ? "bad" : p.status === "进行中" ? "warn" : "muted"}>
                    {p.status}
                  </Badge>
                  {EXECUTABLE_PLAN_KINDS.has(p.kind) && p.diagramId && p.diagramNodeId ? <Badge tone={p.lifecycleStatus === "accepted" ? "good" : p.lifecycleStatus === "audit_failed" ? "bad" : "neutral"}>{PLAN_LIFECYCLE_LABELS[p.lifecycleStatus]}</Badge> : null}
                </td>
                <td><span className={`plan-pill plan-pill-${PLAN_PRIORITY_TONE[p.priority]}`}>{p.priority}</span></td>
                <td style={{ minWidth: 100 }}><ProgressBar value={p.progress} /></td>
                <td className="mono">{p.dueAt || "—"}</td>
                <td className="cell-sub">{p.dependencyIds.length > 0 ? `${p.dependencyIds.length} 项` : "—"}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  <button className="btn btn-ghost btn-icon" onClick={() => setDetailPlan(p)} title="查看详情"><Eye size={13} /></button>
                  <button className="btn btn-ghost btn-icon" onClick={() => setDocumentPlan(p)} title="引用文档"><LinkIcon size={13} /></button>
                  <button className="btn btn-ghost btn-icon" onClick={() => setModal({ plan: p })} title="编辑"><Pencil size={13} /></button>
                  <button
                    className="btn btn-ghost btn-icon btn-danger"
                    title="删除"
                    onClick={() => {
                      if (window.confirm(`确认删除计划项「${p.title}」？`)) {
                        api.deletePlan(p.id).then(props.onChanged).catch(props.onError);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal ? (
        <PlanModal
          plans={props.plans}
          plan={modal.plan}
          projectId={props.projectId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); props.onChanged(); }}
        />
      ) : null}
      {detailPlan ? (
        <PlanDetailModal
          projectId={props.projectId}
          plan={detailPlan}
          plans={props.plans}
          documents={planDocuments}
          documentReferences={planDocumentReferences}
          onClose={() => setDetailPlan(null)}
          onEdit={() => { setDetailPlan(null); setModal({ plan: detailPlan }); }}
          onDocuments={() => { setDetailPlan(null); setDocumentPlan(detailPlan); }}
        />
      ) : null}
      {documentPlan ? <Modal title={`计划文档 · ${documentPlan.title}`} onClose={() => setDocumentPlan(null)} width={820} footer={<button className="btn" onClick={() => setDocumentPlan(null)}>关闭</button>}>
        <DocumentReferencePanel
          projectId={props.projectId}
          targetType="plan"
          targetId={documentPlan.id}
          relationType="implements"
          title="计划施工依据"
          description="计划引用项目文档的固定版本，用于明确施工范围、接口和验收依据。"
        />
      </Modal> : null}
      <Pagination offset={props.offset} limit={20} total={props.total} onChange={props.onPage} />
    </div>
  );
}

export function PlanDetailModal(props: {
  projectId: string;
  plan: PlanItem;
  plans: PlanItem[];
  documents: DesignDoc[];
  documentReferences: DocumentReference[];
  onClose: () => void;
  onEdit: () => void;
  onDocuments: () => void;
}): ReactElement {
  const [relatedPlans, setRelatedPlans] = useState<Record<string, PlanItem>>({});
  const [relationError, setRelationError] = useState("");
  const relationIds = useMemo(() => Array.from(new Set([
    ...(props.plan.parentId ? [props.plan.parentId] : []),
    ...props.plan.dependencyIds,
  ])), [props.plan.dependencyIds, props.plan.parentId]);

  useEffect(() => {
    let active = true;
    const known = new Map(props.plans.map((plan) => [plan.id, plan]));
    const missingIds = relationIds.filter((id) => !known.has(id));
    if (missingIds.length === 0) {
      setRelatedPlans(Object.fromEntries(known));
      setRelationError("");
      return () => { active = false; };
    }
    void Promise.all(missingIds.map(async (id) => {
      try { return await api.getPlan(id); }
      catch { return null; }
    })).then((loaded) => {
      if (!active) return;
      for (const plan of loaded) if (plan) known.set(plan.id, plan);
      setRelatedPlans(Object.fromEntries(known));
      setRelationError(loaded.some((plan) => !plan) ? "部分关联计划已不存在，当前保留原始引用 ID。" : "");
    });
    return () => { active = false; };
  }, [props.plans, relationIds]);

  // 层级计划（goal/milestone/version）不进入施工交付流程，因此不展示生命周期与实施流程入口
  const executablePlan = EXECUTABLE_PLAN_KINDS.has(props.plan.kind);
  const deliveryHref = executablePlan ? planDeliveryHref(props.plan) : null;
  const currentStep = planLifecycleStep(props.plan.lifecycleStatus);
  const parent = props.plan.parentId ? relatedPlans[props.plan.parentId] : null;
  const dependencies = props.plan.dependencyIds.map((id) => relatedPlans[id] ?? id);
  const references = props.documentReferences.filter((reference) => reference.targetId === props.plan.id);
  const documentIds = new Set(references.map((reference) => reference.documentId));
  const documents = props.documents.filter((document) => documentIds.has(document.id));

  return <Modal
    title={`计划详情 · ${props.plan.title}`}
    onClose={props.onClose}
    width={940}
    footer={<>
      <button className="btn" onClick={props.onClose}>关闭</button>
      <span className="spacer" />
      <button className="btn btn-ghost" onClick={props.onDocuments}><LinkIcon size={13} />补充施工依据</button>
      <button className="btn" onClick={props.onEdit}><Pencil size={13} />编辑补充</button>
      {deliveryHref ? <button className="btn btn-primary" onClick={() => navigate(deliveryHref)}><ArrowRight size={14} />进入实施流程</button> : null}
    </>}
  >
    <div className="plan-detail">
      <section className="plan-detail-hero">
        <div>
          <span className="plan-detail-kicker">{PLAN_KIND_LABELS[props.plan.kind]} · {props.plan.versionTag || "未标版本"}</span>
          <h2>{props.plan.title}</h2>
          <p>{props.plan.description || "当前计划尚未补充说明。"}</p>
        </div>
        <div className="plan-detail-status">
          <Badge tone={props.plan.status === "已完成" ? "good" : props.plan.status === "已阻塞" ? "bad" : props.plan.status === "进行中" ? "warn" : "muted"}>{props.plan.status}</Badge>
          {executablePlan ? <Badge tone={props.plan.lifecycleStatus === "accepted" ? "good" : props.plan.lifecycleStatus === "audit_failed" ? "bad" : "neutral"}>{PLAN_LIFECYCLE_LABELS[props.plan.lifecycleStatus]}</Badge> : null}
          <strong>{props.plan.progress}%</strong>
        </div>
      </section>

      {props.plan.blockedReason ? <div className="plan-detail-blocked"><strong>当前阻塞</strong><span>
        <PlanBlockedReason reason={props.plan.blockedReason} hasDocuments={documents.length > 0} onDocuments={props.onDocuments} />
      </span></div> : null}

      <section className="plan-detail-section plan-detail-flow">
        <div className="plan-detail-section-heading">
          <div><h3>实施流程</h3><p>详情页展示进度；正式动作、证据和决定仍在节点施工单中完成。</p></div>
          {executablePlan ? <Badge tone={deliveryHref ? "info" : "muted"}>{deliveryHref ? "已绑定画布节点" : "未绑定画布节点"}</Badge> : null}
        </div>
        {executablePlan ? (
          <>
            <div className="plan-delivery-stepper">
              {PLAN_DELIVERY_STEPS.map((label, index) => {
                const step = index + 1;
                const state = currentStep > step ? "done" : currentStep === step ? "current" : "pending";
                return <div className={`plan-delivery-step ${state}`} key={label}><span>{state === "done" ? "✓" : String(step).padStart(2, "0")}</span><strong>{label}</strong></div>;
              })}
            </div>
            {!deliveryHref ? <div className="plan-detail-note">该计划尚未绑定画布交付节点，因此只能维护计划信息，不能进入正式施工流转。</div> : null}
          </>
        ) : (
          <div className="plan-detail-note">该计划为{PLAN_KIND_LABELS[props.plan.kind]}，仅用于计划层级，不进入施工交付流程。</div>
        )}
      </section>

      <div className="plan-detail-grid">
        <section className="plan-detail-section">
          <div className="plan-detail-section-heading"><div><h3>计划信息</h3><p>范围、责任人与排期。</p></div></div>
          <dl className="plan-detail-facts">
            <div><dt>负责人</dt><dd>{props.plan.owner || "未指定"}</dd></div>
            <div><dt>优先级</dt><dd>{props.plan.priority}</dd></div>
            <div><dt>开始日期</dt><dd>{formatDate(props.plan.startAt)}</dd></div>
            <div><dt>截止日期</dt><dd>{formatDate(props.plan.dueAt)}</dd></div>
            <div><dt>创建时间</dt><dd>{formatDateTime(props.plan.createdAt)}</dd></div>
            <div><dt>最近更新</dt><dd>{formatDateTime(props.plan.updatedAt)}</dd></div>
          </dl>
        </section>

        <section className="plan-detail-section">
          <div className="plan-detail-section-heading"><div><h3>层级与依赖</h3><p>计划在项目实施树中的位置。</p></div></div>
          {relationError ? <div className="plan-detail-note warn">{relationError}</div> : null}
          <div className="plan-detail-related">
            <div><span>上级计划</span><strong>{parent?.title ?? (props.plan.parentId || "无")}</strong></div>
            <div><span>前置依赖</span>{dependencies.length === 0 ? <strong>无</strong> : <ul>{dependencies.map((dependency, index) => <li key={props.plan.dependencyIds[index]}>{typeof dependency === "string" ? dependency : dependency.title}</li>)}</ul>}</div>
          </div>
        </section>

        <section className="plan-detail-section">
          <div className="plan-detail-section-heading"><div><h3>角色分配</h3><p>受派身份与实际执行历史分开记录。</p></div></div>
          <dl className="plan-detail-facts">
            <div><dt>设计者</dt><dd>{displayAssignment(props.plan.roleAssignments.designer)}</dd></div>
            <div><dt>施工者</dt><dd>{displayAssignment(props.plan.roleAssignments.builder)}</dd></div>
            <div><dt>Worker 池</dt><dd>{props.plan.roleAssignments.builder.poolId || "自动兼容池"}</dd></div>
            <div><dt>审计者</dt><dd>{displayAssignment(props.plan.roleAssignments.auditor)}</dd></div>
          </dl>
        </section>

        <section className="plan-detail-section">
          <div className="plan-detail-section-heading"><div><h3>施工与审核记录</h3><p>正式流程的关键责任人与结果。</p></div></div>
          <dl className="plan-detail-facts">
            <div><dt>计划提交</dt><dd>{props.plan.submittedAt ? `${props.plan.proposedBy || "未记录"} · ${formatDateTime(props.plan.submittedAt)}` : "尚未提交"}</dd></div>
            <div><dt>管理员批准</dt><dd>{props.plan.approvedAt ? `${props.plan.approvedBy || "未记录"} · ${formatDateTime(props.plan.approvedAt)}` : "尚未批准"}</dd></div>
            <div><dt>实现版本</dt><dd>{props.plan.implementationRevision || "尚未提交"}</dd></div>
            <div><dt>独立审计</dt><dd>{PLAN_AUDIT_LABELS[props.plan.auditStatus]}{props.plan.auditedBy ? ` · ${props.plan.auditedBy}` : ""}</dd></div>
            <div><dt>管理员验收</dt><dd>{MANAGER_DECISION_LABELS[props.plan.managerDecision]}{props.plan.managerDecisionBy ? ` · ${props.plan.managerDecisionBy}` : ""}</dd></div>
            <div><dt>关联标识</dt><dd className="mono">{props.plan.correlationId || props.plan.id}</dd></div>
          </dl>
        </section>

        <section className="plan-detail-section">
          <div className="plan-detail-section-heading"><div><h3>施工依据</h3><p>计划引用的固定文档版本。</p></div><Badge tone={documents.length > 0 ? "info" : "muted"}>{documents.length} 篇</Badge></div>
          {documents.length === 0 ? <div className="plan-detail-note">尚未关联施工文档，可通过“补充施工依据”添加。</div> : <div className="plan-detail-documents">{documents.map((document) => <article key={document.id}><div><Badge tone={document.status === "已批准" ? "good" : "warn"}>{document.status}</Badge><span>{document.category}</span></div><strong>{document.title}</strong><small>{document.version || "未标版本"} · 更新于 {formatDateTime(document.updatedAt)}</small></article>)}</div>}
        </section>
      </div>
    </div>
  </Modal>;
}

function PlanBlockedReason(props: { reason: string; hasDocuments: boolean; onDocuments: () => void }): ReactElement {
  const changeId = designChangeIdFromBlockedReason(props.reason);
  if (!changeId) return <>{props.reason}</>;
  return <span className="design-change-blocker">
    <span>设计变更处理中</span>
    <button
      type="button"
      className="design-change-document-link"
      disabled={!props.hasDocuments}
      title={props.hasDocuments ? `设计变更 ${changeId}` : "设计变更尚未关联文档"}
      onClick={props.onDocuments}
    >
      <LinkIcon size={12} />查看设计变更文档
    </button>
  </span>;
}

function PlanModal(props: {
  plans: PlanItem[];
  plan?: PlanItem;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const existing = props.plan;
  const controlled = Boolean(existing?.diagramId && existing.diagramNodeId);
  const [form, setForm] = useState({
    kind: existing?.kind ?? "task",
    title: existing?.title ?? "",
    description: existing?.description ?? "",
    status: existing?.status ?? "未开始",
    priority: existing?.priority ?? "P2",
    progress: existing?.progress ?? 0,
    owner: existing?.owner ?? "",
    roleAssignments: normalizeRoleAssignments(existing?.roleAssignments),
    versionTag: existing?.versionTag ?? "",
    startAt: existing?.startAt ?? "",
    dueAt: existing?.dueAt ?? "",
    dependencyIds: existing?.dependencyIds ?? ([] as string[]),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dependencyOptions, setDependencyOptions] = useState<PlanItem[]>(props.plans);
  const [depOpen, setDepOpen] = useState(false);
  const depRef = useRef<HTMLDivElement | null>(null);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();
  const initialForm = {
    kind: existing?.kind ?? "task", title: existing?.title ?? "", description: existing?.description ?? "",
    status: existing?.status ?? "未开始", priority: existing?.priority ?? "P2", progress: existing?.progress ?? 0,
    owner: existing?.owner ?? "", roleAssignments: normalizeRoleAssignments(existing?.roleAssignments), versionTag: existing?.versionTag ?? "", startAt: existing?.startAt ?? "",
    dueAt: existing?.dueAt ?? "", dependencyIds: existing?.dependencyIds ?? ([] as string[]),
  };
  const dirty = !existing || JSON.stringify(form) !== JSON.stringify(initialForm);

  useEffect(() => {
    if (!depOpen) return;
    const onDown = (event: PointerEvent) => {
      if (depRef.current && !depRef.current.contains(event.target as Node)) setDepOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [depOpen]);

  useEffect(() => {
    api.pagePlans(props.projectId, { limit: 100 }).then((page) => setDependencyOptions(page.items)).catch(() => undefined);
  }, [props.projectId]);

  useEffect(() => {
    setPageContextDetail({
      projectId: props.projectId,
      pageType: "plan",
      title: `${existing ? "编辑" : "新增"}计划 · ${form.title || "未命名"}`,
      entityRefs: [{ type: "project", id: props.projectId }, ...(existing ? [{ type: "plan" as const, id: existing.id, label: existing.title }] : [])],
      selection: { entityRefs: existing ? [{ type: "plan", id: existing.id, label: existing.title }] : [] },
      draft: { dirty, baseRevision: existing?.updatedAt, summary: "当前 visibleContent 是计划编辑器草稿。" },
      visibleContent: agentVisibleContent("plan", form.title || "未命名计划", form),
    });
  }, [dirty, existing, form, props.projectId, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (!existing || lastEntityChange?.value.entityType !== "plan" || lastEntityChange.value.entityId !== existing.id) return;
    if (lastEntityChange.value.revision <= existing.updatedAt) return;
    setError(dirty
      ? "Agent 已更新当前计划，但本地还有未保存修改；已保留本地草稿。"
      : "Agent 已更新当前计划，请重新打开以查看最新内容。");
  }, [dirty, existing, lastEntityChange]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const setRole = (role: "designer" | "builder" | "auditor", key: "agentId" | "displayName" | "poolId") => (e: { target: { value: string } }) =>
    setForm((current) => ({ ...current, roleAssignments: { ...current.roleAssignments, [role]: { ...current.roleAssignments[role], [key]: e.target.value } } }));
  const roleErrors = roleAssignmentErrors(form.roleAssignments, false);

  const submit = () => {
    setBusy(true); setError("");
    const fullPayload = { ...form, progress: Number(form.progress), projectId: props.projectId };
    const { status: _status, progress: _progress, ...controlledPayload } = fullPayload;
    const payload = controlled ? controlledPayload : fullPayload;
    const call = existing ? api.updatePlan(existing.id, payload) : api.createPlan(payload);
    call.then(() => props.onSaved()).catch((e) => setError(e.message)).finally(() => setBusy(false));
  };

  const selectable = dependencyOptions.filter((p) => p.id !== existing?.id);
  const selectedDeps = selectable.filter((p) => form.dependencyIds.includes(p.id));

  const daysLeft = (() => {
    if (!form.dueAt) return null;
    const due = new Date(`${form.dueAt}T00:00:00`);
    if (Number.isNaN(due.getTime())) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
    return diff;
  })();

  return (
    <Modal
      title={existing ? "编辑计划项" : "新增计划项"}
      onClose={props.onClose}
      width={720}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim() || roleErrors.length > 0} onClick={submit}>
            保存
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}

      <div className="plan-summary">
        <span className="plan-summary-kicker">计划概览</span>
        <span className="plan-chip"><Badge tone={PLAN_KIND_TONE[form.kind]}>{PLAN_KIND_LABELS[form.kind]}</Badge></span>
        <span className={`plan-pill plan-pill-status plan-pill-${PLAN_STATUS_TONE[form.status]}`}>{form.status}</span>
        <span className={`plan-pill plan-pill-priority plan-pill-${PLAN_PRIORITY_TONE[form.priority]}`}>{form.priority}</span>
        <span className="plan-pill plan-pill-progress mono">{form.progress}%</span>
        <span className={`plan-pill plan-pill-due ${daysLeft === null ? "" : daysLeft < 0 ? "plan-pill-late" : daysLeft === 0 ? "plan-pill-today" : ""}`}>
          {daysLeft === null ? "未设截止" : daysLeft < 0 ? `已逾期 ${-daysLeft} 天` : daysLeft === 0 ? "今天截止" : `剩余 ${daysLeft} 天`}
        </span>
        {form.kind === "task" ? <span className="plan-pill plan-pill-owner">施工者 {displayAssignment(form.roleAssignments.builder)}</span> : form.owner ? <span className="plan-pill plan-pill-owner">负责人 {form.owner}</span> : null}
      </div>

      <div className="form-grid">
        <Field label="标题" wide><input value={form.title} onChange={set("title")} placeholder="计划项标题" /></Field>

        <div className="form-section">基本信息</div>
        <Field label="类型">
          <select value={form.kind} onChange={set("kind")}>
            {PLAN_KINDS.map((k) => <option key={k} value={k}>{PLAN_KIND_LABELS[k]}</option>)}
          </select>
        </Field>
        {form.kind !== "task" ? <Field label="负责人"><input value={form.owner} onChange={set("owner")} /></Field> : null}
        <Field label="状态">
          <select value={form.status} disabled={controlled} onChange={set("status")}>
            {PLAN_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="优先级">
          <select value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="版本号"><input value={form.versionTag} onChange={set("versionTag")} placeholder="如 v1.2.0" /></Field>

        {form.kind === "task" ? <>
          <div className="form-section">职责分离</div>
          {(["designer", "builder", "auditor"] as const).map((role) => <div className="field-wide form-grid" key={role}>
            <Field label={`${role === "designer" ? "设计者" : role === "builder" ? "施工者" : "审计者"} Agent ID`}><input value={form.roleAssignments[role].agentId} onChange={setRole(role, "agentId")} /></Field>
            <Field label="显示名称"><input value={form.roleAssignments[role].displayName} onChange={setRole(role, "displayName")} /></Field>
            {role === "builder" ? <Field label="Worker 池 ID" wide><input value={form.roleAssignments[role].poolId ?? ""} onChange={setRole(role, "poolId")} placeholder="可选；为空时自动生成兼容池" /></Field> : null}
          </div>)}
          <div className={`form-note field-wide ${roleErrors.length ? "warn" : ""}`}>{roleErrors.length ? roleErrors.join("；") : "提交施工计划前必须分配三个不同的 Agent 身份。"}</div>
        </> : null}

        <div className="form-section">时间与进度</div>
        <Field label="开始日期"><input type="date" value={form.startAt.slice(0, 10)} onChange={set("startAt")} /></Field>
        <Field label="截止日期"><input type="date" value={form.dueAt.slice(0, 10)} onChange={set("dueAt")} /></Field>
        <Field label={`进度 ${form.progress}%`} wide>
          <input type="range" min={0} max={100} value={form.progress} disabled={controlled}
            onChange={(e) => setForm((f) => ({ ...f, progress: Number(e.target.value) }))} />
        </Field>
        {controlled ? <div className="form-note field-wide">画布节点计划的状态和进度由施工交付流程推进，请从节点的“开发计划”页操作。</div> : null}

        <div className="form-section">依赖与说明</div>
        <Field label={`依赖（已选 ${form.dependencyIds.length} 项）`} wide>
          <div className="dep-dropdown" ref={depRef}>
            <button type="button" className="dep-trigger" onClick={() => setDepOpen((v) => !v)}>
              <span className="dep-trigger-label">
                {selectedDeps.length === 0 ? "选择依赖的计划项…" : selectedDeps.slice(0, 3).map((p) => p.title).join("、")}
                {selectedDeps.length > 3 ? ` 等 ${selectedDeps.length} 项` : ""}
              </span>
              <ChevronDown size={15} className={depOpen ? "dep-chevron-open" : ""} />
            </button>
            {depOpen ? (
              <div className="dep-menu">
                {selectable.length === 0 ? <div className="dep-empty">暂无其它计划项可作为依赖</div> : selectable.map((p) => (
                  <label className="dep-option" key={p.id}>
                    <input
                      type="checkbox"
                      checked={form.dependencyIds.includes(p.id)}
                      onChange={() => setForm((f) => ({
                        ...f,
                        dependencyIds: f.dependencyIds.includes(p.id)
                          ? f.dependencyIds.filter((x) => x !== p.id)
                          : [...f.dependencyIds, p.id],
                      }))}
                    />
                    <span className="dep-option-main">{p.title}</span>
                    <span className="dep-option-kind">{PLAN_KIND_LABELS[p.kind]}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </Field>
        <Field label="描述" wide><textarea rows={7} value={form.description} onChange={set("description")} placeholder="补充计划项说明、交付物或约束…" /></Field>
      </div>
    </Modal>
  );
}

// ---------- 证据 ----------

function EvidenceTab(props: {
  projectId: string;
  evidence: Evidence[];
  total: number;
  offset: number;
  onPage: (offset: number) => void;
  busyAction: string;
  setBusyAction: (value: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [documentEvidence, setDocumentEvidence] = useState<Evidence | null>(null);
  const [evidenceDocuments, setEvidenceDocuments] = useState<DesignDoc[]>([]);
  const [evidenceDocumentReferences, setEvidenceDocumentReferences] = useState<DocumentReference[]>([]);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  useEffect(() => {
    const evidenceIds = new Set(props.evidence.map((item) => item.id));
    Promise.all([api.listDesignDocs(props.projectId), api.listDocumentReferences({ projectId: props.projectId, targetType: "evidence" })])
      .then(([documents, references]) => {
        const visibleReferences = references.filter((reference) => evidenceIds.has(reference.targetId));
        const documentIds = new Set(visibleReferences.map((reference) => reference.documentId));
        setEvidenceDocumentReferences(visibleReferences);
        setEvidenceDocuments(documents.filter((document) => documentIds.has(document.id)));
      })
      .catch(() => undefined);
  }, [props.evidence, props.projectId]);

  useEffect(() => {
    if (addOpen) return;
    setPageContextDetail({
      projectId: props.projectId,
      pageType: "evidence",
      title: "项目证据",
      entityRefs: [{ type: "project", id: props.projectId }, ...props.evidence.map((item) => ({ type: "evidence" as const, id: item.id, label: item.summary })), ...evidenceDocuments.map((document) => ({ type: "designDocument" as const, id: document.id, label: document.title }))],
      selection: { entityRefs: [] }, draft: null,
      visibleContent: agentVisibleContent("evidenceList", "当前可见证据及引用文档", { evidence: props.evidence, documents: evidenceDocuments, documentReferences: evidenceDocumentReferences }),
    });
  }, [addOpen, evidenceDocumentReferences, evidenceDocuments, props.evidence, props.projectId, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (lastEntityChange?.value.entityType === "evidence" && lastEntityChange.value.projectId === props.projectId) props.onChanged();
  }, [lastEntityChange, props.onChanged, props.projectId]);

  return (
    <div>
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}><Plus size={14} /> 记录证据</button>
        <span className="cell-sub">证据完全手动录入，不读取任何仓库目录，与项目源码位置无关。</span>
      </div>
      {props.evidence.length === 0 ? (
        <EmptyState text="暂无证据。请手动录入佐证（提交号/测试结果/截图/文件等）。" />
      ) : (
        <table className="table">
          <thead>
            <tr><th>时间</th><th>来源</th><th>结果</th><th>摘要</th><th>关联工作节点</th><th>指纹</th><th></th></tr>
          </thead>
          <tbody>
            {props.evidence.map((ev) => (
              <tr key={ev.id}>
                <td className="mono cell-sub">{formatDateTime(ev.collectedAt)}</td>
                <td><Badge tone={ev.sourceType === "git" ? "info" : "neutral"}>{ev.sourceType}</Badge></td>
                <td>
                  <Badge tone={ev.resultStatus === "pass" ? "good" : ev.resultStatus === "fail" ? "bad" : ev.resultStatus === "warn" ? "warn" : "neutral"}>
                    {ev.resultStatus}
                  </Badge>
                </td>
                <td className="evidence-summary">{ev.summary}</td>
                <td className="cell-sub mono">{ev.nodeId ? ev.nodeId.slice(0, 8) : "—"}</td>
                <td className="digest mono">{ev.digest || "—"}</td>
                <td>
                  <button className="btn btn-ghost btn-icon" title="引用文档" onClick={() => setDocumentEvidence(ev)}><LinkIcon size={13} /></button>
                  <button
                    className="btn btn-ghost btn-icon btn-danger"
                    title="删除"
                    onClick={() => {
                      if (window.confirm("确认删除该证据记录？")) {
                        api.deleteEvidence(ev.id).then(props.onChanged).catch(props.onError);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {addOpen ? (
        <ManualEvidenceModal
          projectId={props.projectId}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); props.onChanged(); }}
        />
      ) : null}
      {documentEvidence ? <Modal title={`证据文档 · ${documentEvidence.summary}`} onClose={() => setDocumentEvidence(null)} width={820} footer={<button className="btn" onClick={() => setDocumentEvidence(null)}>关闭</button>}>
        <DocumentReferencePanel
          projectId={props.projectId}
          targetType="evidence"
          targetId={documentEvidence.id}
          relationType="verifies"
          title="证据引用的验收文档"
          description="证据引用验收时实际采用的文档版本，保证后续复核不会被新版正文覆盖。"
        />
      </Modal> : null}
      <Pagination offset={props.offset} limit={20} total={props.total} onChange={props.onPage} />
    </div>
  );
}

function ManualEvidenceModal(props: { projectId: string; onClose: () => void; onSaved: () => void }): ReactElement {
  const [summary, setSummary] = useState("");
  const [resultStatus, setResultStatus] = useState("info");
  const [sourceType, setSourceType] = useState<Evidence["sourceType"]>("manual");
  const [commitSha, setCommitSha] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [command, setCommand] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nodes, setNodes] = useState<ProjectWorkspaceNode[]>([]);

  useEffect(() => {
    api.pageProjectWorkspaceNodes(props.projectId, { limit: 100 }).then((page) => setNodes(page.items)).catch(() => undefined);
  }, [props.projectId]);

  return (
    <Modal
      title="手动补充证据"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || !summary.trim()}
            onClick={() => {
              setBusy(true); setError("");
              api.createManualEvidence({ projectId: props.projectId, sourceType, resultStatus, summary, sourcePath, command, nodeId: nodeId || null, commitSha: commitSha || "" })
                .then(() => props.onSaved())
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            保存
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="结果">
          <select value={resultStatus} onChange={(e) => setResultStatus(e.target.value)}>
            <option value="info">说明</option>
            <option value="pass">通过</option>
            <option value="warn">警告</option>
            <option value="fail">失败</option>
          </select>
        </Field>
        <Field label="来源类型">
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as Evidence["sourceType"])}>
            <option value="manual">手动</option>
            <option value="git">Git（手动填提交号）</option>
          </select>
        </Field>
        <Field label="提交号（可选，Git 类型）"><input value={commitSha} onChange={(e) => setCommitSha(e.target.value)} placeholder="如 a1b2c3d" /></Field>
        <Field label="关联画布节点（可选）">
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">不关联</option>
            {nodes.map((item) => (
              <option key={item.node.id} value={item.node.id}>{`${item.node.label} · ${item.diagramTitle}`}</option>
            ))}
          </select>
        </Field>
        <Field label="来源路径（可选）"><input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} /></Field>
        <Field label="命令 / 方式（可选）"><input value={command} onChange={(e) => setCommand(e.target.value)} /></Field>
        <Field label="内容摘要" wide><textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ---------- 治理 ----------

function GovernanceTab(props: { projectId: string; onError: (message: string) => void }): ReactElement {
  const limit = 20;
  const [items, setItems] = useState<GovernanceRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const { setPageContextDetail, lastEntityChange } = useAgentUiBridge();

  useEffect(() => {
    api.pageGovernance({
      projectId: props.projectId,
      q: q.trim() || undefined,
      type: typeFilter || undefined,
      status: statusFilter || undefined,
      offset,
      limit,
    }).then((page) => { setItems(page.items); setTotal(page.total); })
      .catch((e) => props.onError(e.message));
  }, [props.projectId, q, typeFilter, statusFilter, offset, refresh]);

  useEffect(() => {
    if (addOpen || !items) return;
    setPageContextDetail({
      projectId: props.projectId,
      pageType: "governance",
      title: "项目治理记录",
      entityRefs: [{ type: "project", id: props.projectId }, ...items.map((item) => ({ type: "governance" as const, id: item.id, label: item.title }))],
      selection: { entityRefs: [] }, draft: null,
      visibleContent: agentVisibleContent("governanceList", "当前可见治理记录", items),
    });
  }, [addOpen, items, props.projectId, setPageContextDetail]);
  useEffect(() => () => setPageContextDetail(null), [setPageContextDetail]);
  useEffect(() => {
    if (lastEntityChange?.value.entityType === "governance" && lastEntityChange.value.projectId === props.projectId) setRefresh((value) => value + 1);
  }, [lastEntityChange, props.projectId]);

  const setStatus = (record: GovernanceRecord, status: GovernanceRecord["status"]) =>
    api.updateGovernance(record.id, { status }).then(() => setRefresh((value) => value + 1)).catch(props.onError);

  const filtered = Boolean(q.trim() || typeFilter || statusFilter);

  return (
    <div>
      <div className="toolbar">
        <input value={q} onChange={(event) => { setQ(event.target.value); setOffset(0); }} placeholder="搜索标题 / 结论 / 理由" style={{ width: 260 }} />
        <Select
          value={typeFilter}
          onChange={(value) => { setTypeFilter(value); setOffset(0); }}
          width={130}
          ariaLabel="按类型筛选"
          options={[{ value: "", label: "全部类型" }, { value: "decision", label: "决策" }, { value: "opinion", label: "意见" }]}
        />
        <Select
          value={statusFilter}
          onChange={(value) => { setStatusFilter(value); setOffset(0); }}
          width={130}
          ariaLabel="按状态筛选"
          options={[{ value: "", label: "全部状态" }, { value: "有效", label: "有效" }, { value: "待确认", label: "待确认" }, { value: "已替代", label: "已替代" }]}
        />
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}><Plus size={14} /> 新增决策 / 意见</button>
      </div>
      {!items ? <Spinner /> : items.length === 0 ? (
        <EmptyState text={filtered ? "没有符合筛选条件的治理记录。" : "暂无治理记录。重要的技术选型、方案裁决都可以记录在这里，形成项目的决策档案。"} />
      ) : (
        <table className="table">
          <thead>
            <tr><th>标题</th><th>类型</th><th>状态</th><th>结论</th><th>时间</th><th></th></tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="cell-main">{r.title}</div>
                  <div className="cell-sub">{r.author || "—"} · 理由：{r.rationale || "未填写"}</div>
                </td>
                <td><Badge tone={r.type === "decision" ? "accent" : "info"}>{r.type === "decision" ? "决策" : "意见"}</Badge></td>
                <td>
                  <Badge tone={r.status === "有效" ? "good" : r.status === "待确认" ? "warn" : "muted"}>{r.status}</Badge>
                </td>
                <td className="governance-summary" title={r.content}>{r.content || "—"}</td>
                <td className="cell-sub mono">{formatDateTime(r.createdAt)}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {r.status !== "有效" ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setStatus(r, "有效")}>设为有效</button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={() => setStatus(r, "已替代")}>标记已替代</button>
                  )}
                  <button
                    className="btn btn-ghost btn-icon btn-danger"
                    title="删除"
                    onClick={() => {
                      if (window.confirm(`确认删除治理记录「${r.title}」？`)) {
                        api.deleteGovernance(r.id).then(() => setRefresh((value) => value + 1)).catch(props.onError);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {addOpen ? (
        <GovernanceModal
          projectId={props.projectId}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); setOffset(0); setRefresh((value) => value + 1); }}
        />
      ) : null}
      <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />
    </div>
  );
}

type GovernanceTemplate = {
  type: GovernanceRecord["type"];
  title: string;
  content: string;
  rationale: string;
};

const GOVERNANCE_TEMPLATES: GovernanceTemplate[] = [
  {
    type: "decision",
    title: "技术选型：确定核心依赖与运行时，不引入外部数据库服务",
    content: "确定采用本地 SQLite + Fastify 单进程方案，数据文件随项目仓库走，避免部署时额外维护数据库服务。",
    rationale: "单机自托管，数据量可控；免运维，备份即拷贝文件；已有同态方案验证过性能。",
  },
  {
    type: "decision",
    title: "数据模型：画布节点与工作节点建立稳定映射键（kind::title）",
    content: "画布上的模块 / 功能 / 需求节点按 kind::title 稳定映射为工作节点，状态双向可同步。",
    rationale: "避免依赖坐标或自增 id 造成断链；节点改名通过人工确认，保证映射可追溯。",
  },
  {
    type: "decision",
    title: "接口契约：以 HTTP JSON 作为前端与 MCP 的唯一事实源",
    content: "前端只通过 /api 读取与写回；MCP 工具复用同一契约，避免两套模型漂移。",
    rationale: "单一数据源，降低双写不一致；Web 与 MCP 行为一致，便于审计。",
  },
  {
    type: "opinion",
    title: "交付范围：本版本聚焦画布→计划的闭环，暂不做多租户",
    content: "当前版本优先把「画布 → 工作节点 / 计划 / 验收」链路做通。",
    rationale: "先验证单机高效闭环，再考虑并发与权限，避免过早抽象。",
  },
  {
    type: "opinion",
    title: "风险处置：对上线的外部依赖做只读采集 + 人工确认",
    content: "Git 与文件证据只读采集，标注来源与时间；涉及写回的状态变化需在界面上人工确认。",
    rationale: "保护用户数据；证据可复核，降低自动化误判风险。",
  },
];

function GovernanceModal(props: { projectId: string; onClose: () => void; onSaved: () => void }): ReactElement {
  const [form, setForm] = useState({ type: "decision", title: "", content: "", rationale: "", author: "", status: "有效" as const });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const applyTemplate = (e: { target: { value: string } }) => {
    const t = GOVERNANCE_TEMPLATES.find((x) => x.title === e.target.value);
    if (t) setForm((f) => ({ ...f, type: t.type, title: t.title, content: t.content, rationale: t.rationale }));
  };

  return (
    <Modal
      title="新增决策 / 意见"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>取消</button>
          <button
            className="btn btn-primary"
            disabled={busy || !form.title.trim()}
            onClick={() => {
              setBusy(true); setError("");
              api.createGovernance({ ...form, projectId: props.projectId })
                .then(() => props.onSaved())
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            保存
          </button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <div className="form-grid">
        <Field label="从模板开始（可选）">
          <select value="" onChange={applyTemplate}>
            <option value="">选择模板预填…</option>
            {GOVERNANCE_TEMPLATES.map((t) => (
              <option key={t.title} value={t.title}>{t.type === "decision" ? "决策" : "意见"} · {t.title}</option>
            ))}
          </select>
        </Field>
        <Field label="类型">
          <select value={form.type} onChange={set("type")}>
            <option value="decision">决策</option>
            <option value="opinion">意见</option>
          </select>
        </Field>
        <Field label="作者"><input value={form.author} onChange={set("author")} /></Field>
        <Field label="标题" wide><input value={form.title} onChange={set("title")} placeholder="例如：采用 SQLite 单文件存储，不引入外部数据库服务" /></Field>
        <Field label="结论内容" wide><textarea rows={4} value={form.content} onChange={set("content")} /></Field>
        <Field label="理由 / 依据" wide><textarea rows={3} value={form.rationale} onChange={set("rationale")} /></Field>
      </div>
    </Modal>
  );
}
