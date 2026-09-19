import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, FileCheck2, History, Plus, RefreshCw } from "lucide-react";
import {
  PLAN_DELIVERY_STEPS,
  PLAN_LIFECYCLE_LABELS,
  planDeliveryActions,
  planLifecycleStep,
} from "../../shared/planDelivery";
import type { AuditEvent, Evidence, PlanItem } from "../../shared/types";
import { displayAssignment } from "../../shared/planRoles";
import { api } from "../api";
import { Badge, EmptyState, ErrorBanner, Spinner, formatDateTime } from "../ui";

const ACTION_LABELS: Record<string, string> = {
  create: "创建施工单",
  update: "更新施工单",
  submit_plan: "提交施工计划",
  approve_plan: "批准施工计划",
  reject_plan: "退回施工计划",
  start_development: "开始施工",
  complete_development: "提交施工完成",
  pass_audit: "独立审计通过",
  fail_audit: "独立审计失败",
  approve_acceptance: "主 Agent 批准验收",
  reject_acceptance: "主 Agent 拒绝验收",
  reopen_rework: "开始返工",
};

function lifecycleTone(plan: PlanItem): "muted" | "warn" | "good" | "bad" | "info" | "accent" {
  if (plan.lifecycleStatus === "accepted") return "good";
  if (plan.lifecycleStatus === "audit_failed" || plan.managerDecision === "rejected") return "bad";
  if (plan.lifecycleStatus === "pending_manager") return "accent";
  if (plan.lifecycleStatus === "pending_audit" || plan.lifecycleStatus === "pending_approval") return "warn";
  if (plan.lifecycleStatus === "in_progress" || plan.lifecycleStatus === "approved") return "info";
  return "muted";
}

interface TimelineItem {
  id: string;
  createdAt: string;
  title: string;
  actor: string;
  detail: string;
  result?: Evidence["resultStatus"];
  kind: "event" | "evidence";
}

export function PlanDeliveryPanel(props: {
  projectId: string;
  plan: PlanItem;
  evidence: Evidence[];
  onChanged: () => Promise<void> | void;
  onAddEvidence: () => void;
  onError: (message: string) => void;
}): ReactElement {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const correlationId = props.plan.correlationId || props.plan.id;
  const planEvidence = useMemo(
    () => props.evidence.filter((item) => item.planItemId === props.plan.id),
    [props.evidence, props.plan.id],
  );
  const hasPassingEvidence = planEvidence.some((item) => item.status === "active"
    && item.resultStatus === "pass"
    && item.actorRole === "auditor"
    && item.agentId.trim().toLocaleLowerCase() === props.plan.roleAssignments.auditor.agentId.trim().toLocaleLowerCase());

  const loadTimeline = useCallback(async () => {
    try {
      const page = await api.pageAudit({ projectId: props.projectId, correlationId, offset: 0, limit: 100 });
      setEvents(page.items);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "施工时间线加载失败");
    }
  }, [correlationId, props.projectId]);

  useEffect(() => {
    setEvents(null);
    void loadTimeline();
  }, [loadTimeline, props.plan.updatedAt, props.evidence.length]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const auditItems = (events ?? []).map((event): TimelineItem => ({
      id: `event:${event.id}`,
      createdAt: event.createdAt,
      title: ACTION_LABELS[event.action] ?? event.action,
      actor: event.actor,
      detail: typeof event.after?.reason === "string" && event.after.reason
        ? event.after.reason
        : event.entityType === "evidence" ? String(event.after?.summary ?? "已关联证据") : `来源 ${event.source}`,
      kind: "event",
    }));
    const auditedEvidenceIds = new Set((events ?? []).filter((event) => event.entityType === "evidence").map((event) => event.entityId));
    const evidenceItems = planEvidence
      .filter((item) => !auditedEvidenceIds.has(item.id))
      .map((item): TimelineItem => ({
        id: `evidence:${item.id}`,
        createdAt: item.collectedAt,
        title: "关联施工证据",
        actor: item.sessionId || "证据采集器",
        detail: item.summary,
        result: item.resultStatus,
        kind: "evidence",
      }));
    return [...auditItems, ...evidenceItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events, planEvidence]);

  const availableActions = planDeliveryActions(props.plan);
  const agentActions = availableActions;
  const currentStep = planLifecycleStep(props.plan.lifecycleStatus);
  const visibleStepIndexes = showAllSteps
    ? PLAN_DELIVERY_STEPS.map((_, index) => index)
    : [currentStep - 2, currentStep - 1, currentStep]
      .filter((index, position, indexes) => index >= 0 && index < PLAN_DELIVERY_STEPS.length && indexes.indexOf(index) === position);

  return (
    <section className="plan-delivery-console" aria-label={`施工交付 · ${props.plan.title}`}>
      <header className="plan-delivery-head">
        <div>
          <h3>{props.plan.title}</h3>
          <p>计划即施工单。状态只能沿正式交付链推进，所有操作、证据和决定归入同一时间线。</p>
        </div>
        <div className="plan-delivery-identity">
          <Badge tone={lifecycleTone(props.plan)}>{PLAN_LIFECYCLE_LABELS[props.plan.lifecycleStatus]}</Badge>
          <code title={correlationId}>{correlationId}</code>
        </div>
      </header>

      <div className="plan-delivery-steps-wrap">
      <div className={`plan-delivery-stepper ${showAllSteps ? "is-expanded" : "is-compact"}`}>
        {visibleStepIndexes.map((index) => {
          const label = PLAN_DELIVERY_STEPS[index];
          const step = index + 1;
          const state = currentStep > step ? "done" : currentStep === step ? "current" : "pending";
          return (
            <div className={`plan-delivery-step ${state}`} key={label}>
              <span>{state === "done" ? "✓" : String(step).padStart(2, "0")}</span>
              <strong>{label}</strong>
            </div>
          );
        })}
      </div>
      <button className="plan-delivery-steps-toggle" onClick={() => setShowAllSteps((value) => !value)}>
        {showAllSteps ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {showAllSteps ? "收起流程" : "查看完整流程"}
      </button>
      </div>

      {props.plan.rejectionReason ? (
        <div className="plan-delivery-rejection"><strong>最近退回原因</strong><span>{props.plan.rejectionReason}</span></div>
      ) : null}

      <div className="plan-delivery-gate">
        <div className="plan-delivery-section-title"><FileCheck2 size={15} /><span>当前门禁</span></div>
        {availableActions.length === 0 ? (
          <div className="plan-delivery-closed"><CheckCircle2 /><div><strong>施工交付已经关闭</strong><span>该计划的实现、审计和主 Agent 验收均已留痕。</span></div></div>
        ) : (
          <>
            <p>审核与批准由主 Agent 领取独立工单后执行；证据不足时退回补齐。</p>
            <div className="plan-delivery-actions">
              <button className="btn btn-ghost" onClick={props.onAddEvidence}><Plus size={13} />添加施工记录 / 证据</button>
            </div>
            {agentActions.length > 0 ? <small className="plan-delivery-hint">待 Agent 执行：{agentActions.map((action) => action.label).join("、")}。请在“推进流程”领取带租约的任务包，防止两个 Agent 同时处理同一任务。</small> : null}
            {props.plan.lifecycleStatus === "pending_audit" && !hasPassingEvidence ? <small className="plan-delivery-hint">审计通过前，至少需要一条明确关联本计划的有效通过证据。</small> : null}
          </>
        )}
      </div>

      <button className="plan-delivery-details-toggle" onClick={() => setShowDetails((value) => !value)}>
        {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {showDetails ? "收起角色与交付信息" : "展开角色与交付信息"}
      </button>

      <div className="plan-delivery-grid">
          {showDetails ? (
          <div className="plan-delivery-gate plan-delivery-facts-gate">
            <dl className="plan-delivery-facts">
              <div><dt>设计者</dt><dd>{displayAssignment(props.plan.roleAssignments.designer)}</dd></div>
              <div><dt>施工者</dt><dd>{displayAssignment(props.plan.roleAssignments.builder)}</dd></div>
              <div><dt>审计者</dt><dd>{displayAssignment(props.plan.roleAssignments.auditor)}</dd></div>
              <div><dt>批准人</dt><dd>{props.plan.approvedBy || "—"}</dd></div>
              <div><dt>实现版本</dt><dd>{props.plan.implementationRevision || "—"}</dd></div>
              <div><dt>独立审计</dt><dd>{props.plan.auditedBy || "—"}</dd></div>
              <div><dt>主 Agent 决定</dt><dd>{props.plan.managerDecisionBy || "—"}</dd></div>
              <div><dt>计划证据</dt><dd>{planEvidence.length} 条</dd></div>
            </dl>
          </div>
          ) : null}

          <div className="plan-delivery-timeline">
            <div className="plan-delivery-section-title">
              <History size={15} /><span>工单</span>
              <button className="btn btn-ghost btn-icon" title="刷新时间线" onClick={() => void loadTimeline()}><RefreshCw size={13} /></button>
            </div>
            {error ? <ErrorBanner message={error} /> : null}
            {!events ? <Spinner /> : timeline.length === 0 ? <EmptyState text="还没有施工记录。提交计划后，正式动作会自动出现在这里。" /> : (
              <ol className="construction-timeline">
                {timeline.map((item) => (
                  <li className={item.kind} key={item.id}>
                    <span className={`construction-dot ${item.result ?? ""}`} />
                    <div className="construction-event-head"><strong>{item.title}</strong><time>{formatDateTime(item.createdAt)}</time></div>
                    <p>{item.detail}</p>
                    <small>{item.actor}</small>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

    </section>
  );
}
