import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AgentAuditScope,
  AgentBlueprint,
  AgentBlueprintKey,
  AgentDeliveryTrack,
  AgentExecutableQueueKey,
  AgentHandoff,
  AgentOrchestration,
  AgentOrchestrationQueueKey,
  AgentOrchestrationTask,
  AgentTaskPackage,
  AgentTaskPackageDocument,
  AgentTaskPackageNode,
  AgentWorkingDirectory,
  PlanItem,
  ProjectWorkflowNodeState,
} from "../shared/types.js";
import { AGENT_POLICY_VERSION } from "./agentSecurity.js";
import { PROJECT_WORKFLOW_POLICY } from "../shared/workflowPolicy.js";
import type { Store } from "./db.js";
import { buildProjectWorkflow } from "./workflow.js";
import { designChangeImpactedPlanIds, getDesignGap, type DesignGap } from "./designGap.js";
import { isActiveDeliveryPlan } from "./planPolicy.js";
import { getProjectedProjectWorkspace } from "./projectProjection.js";
import { managedProjectPath } from "./projectFiles.js";
import { isProjectBriefTask, projectBriefProgress, projectBriefTaskSuffix } from "./projectBrief.js";
import { inspectProjectFoundation } from "./workflow.js";
import { normalizeAgentId, roleAssignmentErrors } from "../shared/planRoles.js";
import { effectiveAgentTaskAssignment } from "../shared/agentTaskAssignment.js";
import { assertPlanImplementationUnlocked, assertPlanLayerUnlocked, isPlanImplementationUnlocked, isDesignPhaseAction } from "./planLayers.js";
import { deriveEvidenceRepairState, getEvidenceRepairState } from "./evidenceRepair.js";
import { listPendingDesignChangeIntents } from "./designChangeIntent.js";
import {
  AGENT_REASSIGNMENT_APPROVAL_ACTION,
  agentReassignmentApprovalTaskId,
  listPendingAgentTaskReassignments,
} from "./agentTaskReassignment.js";

const DESIGN_ACTIONS = new Set([
  "complete_node_definition", "revise_node_requirement", "approve_node_document",
  "approve_node_design", "bind_node_database", "create_node_plan", "submit_plan",
]);

// An accepted node only surfaces these actions again; everything else stays suppressed
// so an already-delivered node cannot silently reopen its delivery workflow.
const ACCEPTED_NODE_ACTIONS = new Set([
  "submit_plan", "revise_node_requirement", "submit_evidence_repair", "assess_evidence_repair_failure",
  "reset_evidence_repair_attempt", "request_design_change",
]);

const EXECUTABLE_QUEUES: AgentExecutableQueueKey[] = ["design", "development", "audit", "approval"];
const TASK_PACKAGE_DOCUMENT_BUDGET = 16_000;
const TASK_PACKAGE_DOCUMENT_SLICE = 6_000;
const ROLE_BY_QUEUE: Record<AgentExecutableQueueKey, AgentBlueprintKey> = {
  design: "designer",
  development: "builder",
  audit: "auditor",
  approval: "approver",
};

const MAIN_AGENT_APPROVER = {
  agentId: "Main Agent",
  displayName: "Main Agent",
} as const;

const CANONICAL_AGENT_TOOL_NAMES: Record<string, string> = {
  get_project_context: "get_project_workspace",
  create_document: "create_design_doc",
  patch_document: "patch_design_doc",
  get_document: "get_design_doc",
  list_plan_items: "get_plan_item",
};

function canonicalAgentTools(tools: string[]): string[] {
  return [...new Set(tools.map((tool) => CANONICAL_AGENT_TOOL_NAMES[tool] ?? tool))];
}

export interface AgentTaskPackageSelector {
  queue?: AgentExecutableQueueKey;
  taskId?: string;
  lease?: NonNullable<AgentTaskPackage["lease"]>;
  /** Main Agent reassignments may intentionally override the plan's historical role assignment. */
  allowCoordinationAssignmentOverride?: boolean;
}

/** Validate selector-only gates without rebuilding the task package. */
export function validateAgentTaskPackageSelector(
  store: Store,
  orchestration: AgentOrchestration,
  selector: AgentTaskPackageSelector,
): void {
  if (!selector.taskId) return;
  const selectedPlanId = selector.taskId.slice(selector.taskId.indexOf(":") + 1);
  const selectedPlan = store.getPlan(selectedPlanId);
  if (selectedPlan?.projectId !== orchestration.project.id) return;
  try {
    if (selector.taskId.startsWith("development:")) assertPlanImplementationUnlocked(store, selectedPlan);
    else {
      const selectedTask = Object.values(orchestration.queues).flat().find((item) => item.id === selector.taskId);
      assertPlanLayerUnlocked(store, selectedPlan, selectedTask?.actionCode);
    }
  } catch (cause) {
    const error = cause as Error & { statusCode?: number; code?: string };
    throw new AgentTaskPackageError(error.statusCode ?? 409, error.code ?? "PLAN_LAYER_LOCKED", error.message);
  }
}

export class AgentTaskPackageError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentTaskPackageError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function inspectAgentWorkingDirectory(repositoryPath: string): AgentWorkingDirectory {
  const path = repositoryPath.trim();
  const configured = Boolean(path);
  const absolute = configured && isAbsolute(path);
  let exists = false;
  let directory = false;
  if (absolute) {
    try {
      const stat = statSync(path);
      exists = true;
      directory = stat.isDirectory();
    } catch {
      exists = false;
    }
  }
  const issue = !configured
    ? "项目未配置 repositoryPath"
    : !absolute
      ? "repositoryPath 必须是绝对路径"
      : !exists
        ? "repositoryPath 不存在或当前服务无权访问"
        : !directory
          ? "repositoryPath 不是目录"
          : "";
  return { repositoryPath: path, configured, absolute, exists, directory, ready: !issue, issue };
}

function approvedRevisionIds(store: Store, projectId: string, node: ProjectWorkflowNodeState, plan: PlanItem | null): string[] {
  if (plan?.designRevisionIds.length) return [...plan.designRevisionIds];
  const references = [
    ...store.listDocumentReferences({ projectId, targetType: "diagramNode", targetId: node.nodeId }),
    ...(plan ? store.listDocumentReferences({ projectId, targetType: "plan", targetId: plan.id }) : []),
  ];
  return [...new Set(references.flatMap((reference) => {
    const revision = store.getDocumentRevision(reference.documentRevisionId);
    return revision?.projectId === projectId && revision.status === "已批准" ? [revision.id] : [];
  }))].sort();
}

function hasPendingNodeDocumentRevision(store: Store, projectId: string, nodeId: string): boolean {
  return store.listDocumentReferences({ projectId, targetType: "diagramNode", targetId: nodeId })
    .some((reference) => {
      const document = store.getDesignDoc(reference.documentId);
      if (!document) return false;
      const revision = store.getDocumentRevision(document.currentRevisionId);
      return document.currentRevisionId !== reference.documentRevisionId || revision?.status !== "已批准";
    });
}

function completedAuditCount(store: Store, projectId: string, planId: string, actionCode: string): number {
  try {
    return Number((store.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_task_leases
      WHERE project_id=? AND task_id=? AND action_code=? AND status='completed'
    `).get(projectId, `audit:${planId}`, actionCode) as { count: number }).count);
  } catch {
    return 0;
  }
}

function producerForAudit(store: Store, projectId: string, planId: string, auditScope: AgentAuditScope): {
  taskKey: string | null;
  workerId: string | null;
} {
  try {
    const producerTaskId = `${auditScope === "design" ? "design" : "development"}:${planId}`;
    const row = store.db.prepare(`
      SELECT task_key, worker_id FROM agent_task_leases
      WHERE project_id=? AND task_id=? AND status='completed'
      ORDER BY completed_at DESC, updated_at DESC LIMIT 1
    `).get(projectId, producerTaskId) as { task_key: string; worker_id: string } | undefined;
    return { taskKey: row?.task_key ?? null, workerId: row?.worker_id ?? null };
  } catch {
    return { taskKey: null, workerId: null };
  }
}

function supersededEvidenceIds(
  store: Store,
  projectId: string,
  plan: PlanItem | null,
  auditScope: AgentAuditScope | null,
  documentRevisionIds: string[],
): string[] {
  if (!plan || !auditScope) return [];
  const revisionSet = new Set(documentRevisionIds);
  return store.listEvidence(projectId, plan.diagramNodeId ?? undefined)
    .filter((item) => item.planItemId === plan.id && item.actorRole === "auditor")
    .filter((item) => auditScope === "design"
      ? item.details.auditScope === "design" && Boolean(item.documentRevisionId) && !revisionSet.has(item.documentRevisionId!)
      : item.details.auditScope !== "design"
        && Boolean(plan.implementationRevision)
        && item.commitSha !== plan.implementationRevision
        && item.details.implementationRevision !== plan.implementationRevision)
    .map((item) => item.id);
}

function task(
  store: Store,
  queue: AgentOrchestrationQueueKey,
  projectId: string,
  node: ProjectWorkflowNodeState,
  plan: PlanItem | null,
  actionCode: string,
  reason: string,
  deliveryLayer?: number | null,
): AgentOrchestrationTask {
  const role = queue === "managerApproval" ? null : ROLE_BY_QUEUE[queue];
  const assignee = role === "approver"
    ? MAIN_AGENT_APPROVER
    : role && plan
      ? plan.roleAssignments[role]
      : null;
  const deliveryTrack: AgentDeliveryTrack = queue === "design" || actionCode === "audit_design" || actionCode === "approve_plan" || actionCode.startsWith("approve_node_")
    ? "design"
    : "implementation";
  const auditScope: AgentAuditScope | null = queue === "audit" || queue === "approval" ? deliveryTrack : null;
  const documentRevisionIds = approvedRevisionIds(store, projectId, node, plan);
  const producer = plan && auditScope ? producerForAudit(store, projectId, plan.id, auditScope) : { taskKey: null, workerId: null };
  const deliveryAttempt = plan
    ? completedAuditCount(store, projectId, plan.id, deliveryTrack === "design" ? "audit_design" : "audit_completed_plan") + 1
    : 1;
  const base: AgentOrchestrationTask = {
    id: `${queue}:${plan?.id ?? node.nodeId}`,
    queue,
    projectId,
    diagramId: node.diagramId,
    nodeId: node.nodeId,
    planItemId: plan?.id ?? null,
    correlationId: plan?.correlationId || plan?.id || node.nodeId,
    title: plan?.title ?? node.nodeLabel,
    reason,
    priority: plan?.priority ?? "P1",
    deliveryLayer: deliveryLayer ?? node.deliveryLayer,
    dueAt: plan?.dueAt ?? "",
    createdAt: plan?.createdAt ?? "",
    actionCode,
    deliveryTrack,
    auditScope,
    deliveryAttempt,
    producerTaskKey: producer.taskKey,
    producerWorkerId: producer.workerId,
    documentRevisionIds,
    implementationRevision: plan?.implementationRevision ?? "",
    supersedesEvidenceIds: supersededEvidenceIds(store, projectId, plan, auditScope, documentRevisionIds),
    managerApprovalRequired: queue === "managerApproval",
    href: node.nextAction?.href ?? `#/canvas/${node.diagramId}/node/${node.nodeId}`,
    assignee,
    workScopes: node.nodeId ? [`node:${node.diagramId}:${node.nodeId}`] : plan ? [`plan:${plan.id}`] : [],
  };
  if (!role) return base;
  const effective = effectiveAgentTaskAssignment(base, role);
  return {
    ...base,
    assignee: effective.assignee,
    ...(effective.poolId ? { poolId: effective.poolId } : {}),
  };
}

function agentBlueprints(store: Store, includePrompts: boolean): AgentBlueprint[] {
  const agents: AgentBlueprint[] = [
    {
      key: "designer",
      name: "设计 Agent",
      purpose: "在设计线路中澄清需求，产出固定文档修订，并按设计审计意见返工。",
      responsibilities: ["理解项目和现状", "定义功能节点与验收标准", "维护需求、详细设计和数据库设计文档", "提出开发计划", "设计审计失败后产生新的不可变文档修订", "在设计收敛后同步设计变更记录（受影响文档/计划）"],
      boundaries: ["不得编写业务代码", "不得审核或批准自己的设计", "不得覆盖旧修订或删除旧证据", "不得把节点标记为开发完成或验收通过", "治理记录修正仅限本租约 workScopes 覆盖的节点，且必须显式确认并留痕"],
      allowedMcpTools: ["get_project_workflow", "claim_dispatched_child_task", "start_agent_task", "heartbeat_agent_task", "get_plan_item", "get_project_workspace", "get_design_doc", "create_design_doc", "patch_design_doc", "create_plan_item_full", "transition_plan_delivery", "complete_agent_task", "fail_agent_task", "release_agent_task", "list_governance", "patch_governance"],
      consumes: ["项目简报", "系统主画布", "已有文档与约束"],
      produces: ["节点定义", "验收标准", "固定设计文档修订", "待独立设计审计的开发计划"],
      completionConditions: ["需求、详细设计和验收标准形成不可变修订", "开发计划与节点、文档修订精确关联", "提交后进入独立设计审计而非直接批准"],
      prompt: includePrompts ? "你是 Designer。禁止自行调用 claim_next_agent_task 或选择任务；只能使用 Main Agent 提供的一次性 dispatchId 调用 claim_dispatched_child_task，且只处理任务包中精确的 design 任务。任务包是上下文真源；提交固定 documentRevisionId 后停止，由不同 workerId 的 Design Auditor 只读审核。所有计划流转携带自己的子 leaseToken；租约丢失立即停止，不得编码、自审或批准。" : "",
    },
    {
      key: "builder",
      name: "施工 Agent",
      purpose: "在编码线路中严格按 Main Agent 批准的设计基线完成编码/施工和开发者测试。",
      responsibilities: ["读取已批准计划和固定设计修订", "实现代码与数据库变更", "运行开发者测试", "提交可追溯的实现证据", "实现审计失败后产生新的 implementationRevision"],
      boundaries: ["不得改变需求、设计和验收标准", "不得批准计划", "不得自审实现", "不得把构建成功冒充测试或审计通过"],
      allowedMcpTools: ["get_project_workflow", "claim_dispatched_child_task", "start_agent_task", "heartbeat_agent_task", "get_plan_item", "get_project_workspace", "get_design_doc", "create_evidence", "patch_plan_item", "transition_plan_delivery", "complete_agent_task", "fail_agent_task", "release_agent_task", "report_design_gap"],
      consumes: ["已批准设计", "已批准开发计划", "验收标准"],
      produces: ["代码变更", "测试输出", "实现修订标识", "待审计交付包"],
      completionConditions: ["计划项全部完成", "实现证据包含命令、结果、修订与关联 ID"],
      prompt: includePrompts ? "你是 Builder。禁止自行调用 claim_next_agent_task 或选择任务；只能使用 Main Agent 提供的一次性 dispatchId 调用 claim_dispatched_child_task，且只处理任务包中精确的 implementation 任务。start_agent_task 后定期 heartbeat_agent_task；发现设计缺口时调用 report_design_gap。提交 implementationRevision、开发者测试和证据后停止，由不同 workerId 的 Implementation Auditor 审核；租约丢失立即停止写入。" : "",
    },
    {
      key: "auditor",
      name: "审计 Agent",
      purpose: "按 auditScope 独立审核固定设计修订或实现修订，并形成可复核证据。",
      responsibilities: ["design 范围只读核验固定文档修订", "implementation 范围复核设计与实现差异并独立运行测试", "逐项核验验收标准", "记录通过/失败证据和返工条件"],
      boundaries: ["不得修改被审计的设计或实现", "workerId 必须不同于 producerWorkerId", "不得篡改批准基线或删除旧证据", "不得复用审计身份作批准或最终验收"],
      allowedMcpTools: ["get_project_workflow", "claim_dispatched_child_task", "start_agent_task", "heartbeat_agent_task", "get_plan_item", "get_project_workspace", "get_design_doc", "list_evidence", "create_evidence", "patch_plan_item", "transition_plan_delivery", "complete_agent_task", "fail_agent_task", "release_agent_task"],
      consumes: ["auditScope", "固定 documentRevisionIds 或 implementationRevision", "生产者证据", "验收标准"],
      produces: ["带 auditScope 的独立审计结论", "逐项检查或测试证据", "失败原因与返工条件"],
      completionConditions: ["每条验收标准有结论", "证据绑定当前设计或实现修订", "证据关联计划、节点、会话与运行", "审计通过后进入独立的 Main Agent approval 工单"],
      prompt: includePrompts ? "你是 Auditor。禁止自行调用 claim_next_agent_task 或选择任务；只能使用 Main Agent 提供的一次性 dispatchId 调用 claim_dispatched_child_task，并严格按任务包 auditScope 工作。workerId 必须不同于 producerWorkerId；证据绑定当前修订，失败只给返工条件，不得修改产物；审计通过后交回 Main Agent 批准。" : "",
    },
    {
      key: "approver",
      name: "Main Agent 常规批准",
      purpose: "仅在独立审计通过后，以全新 approval 工单审核施工计划或执行最终验收。",
      responsibilities: ["重新领取独立 approval 工单", "核对当前审计、验收标准与证据", "批准计划、批准验收或给出可执行的返工条件", "在当前工单节点范围内发起需要重新设计的常规变更"],
      boundaries: ["不得复用审计租约", "不得与 Designer、Builder 或 Auditor 生产身份冲突", "不得批准 human-only 高风险动作"],
      allowedMcpTools: ["get_project_workflow", "claim_next_agent_task", "claim_coordination_lease", "heartbeat_coordination_lease", "dispatch_child_task", "claim_dispatched_child_task", "reclaim_child_task", "reassign_child_task", "pause_coordination_lease", "release_coordination_lease", "advance_coordination_stage", "get_agent_task_package", "start_agent_task", "heartbeat_agent_task", "get_plan_item", "list_evidence", "submit_design_change_intent", "request_design_change", "dismiss_design_change_intent", "request_evidence_repair_assessment", "dismiss_design_gap", "approve_agent_reassignment", "transition_plan_delivery", "complete_agent_task", "release_agent_task"],
      consumes: ["已通过的独立审计", "当前固定修订", "证据"],
      produces: ["可追溯的计划批准、最终验收或返工决定"],
      completionConditions: ["独立 approval workOrderId", "独立审计已通过且证据完整", "无生产者身份冲突", "高风险事项未被自动批准"],
      prompt: includePrompts ? "你是 Main Agent。先按工作流和队列确定任务：approval 队列中的独立 Approver 工单直接调用 claim_next_agent_task(role=approver, agentId=Main Agent) 领取，开工后按任务包完成审批，不领取父协调租约；需要派发 Designer、Builder 或 Auditor 时，已有计划传 planId，无计划设计或项目简报审计传精确 taskKey+taskRevision，二者恰选其一领取父协调租约。只有你可以选择、派发、暂停、回收和重派；任务型父租约只派绑定任务，完成后自动释放。计划型按 Designer → Design Auditor → 你批准 → Builder → Implementation Auditor → 你验收推进。子 Agent 禁止自行领取；只能凭一次性 dispatchId 获取精确任务包。父租约或 Runner 失联时回收并重派，旧子 leaseToken 永不复用。" : "",
    },
  ];
  // Merge any globally-shared, user-edited overrides onto the editable fields only.
  const overrides = store.listAgentBlueprintOverrides();
  if (overrides.length > 0) {
    const byKey = new Map(overrides.map((override) => [override.key, override]));
    for (const agent of agents) {
      const override = byKey.get(agent.key);
      if (!override) continue;
      agent.name = override.name || agent.name;
      agent.purpose = override.purpose || agent.purpose;
      agent.responsibilities = override.responsibilities.length ? override.responsibilities : agent.responsibilities;
      agent.boundaries = override.boundaries.length ? override.boundaries : agent.boundaries;
      agent.allowedMcpTools = override.allowedMcpTools.length
        ? canonicalAgentTools(override.allowedMcpTools)
        : agent.allowedMcpTools;
    }
  }
  return agents;
}

const HANDOFFS: AgentHandoff[] = [
  { from: "designer", to: "auditor", deliveryTrack: "design", auditScope: "design", when: "Designer 提交固定设计修订", payload: ["documentRevisionIds", "验收标准", "风险", "producerTaskKey", "producerWorkerId"] },
  { from: "auditor", to: "designer", deliveryTrack: "design", auditScope: "design", when: "Design Auditor 审计失败", payload: ["失败证据 ID", "缺陷", "返工范围", "保留的旧修订"] },
  { from: "auditor", to: "manager", deliveryTrack: "design", auditScope: "design", when: "Design Auditor 审计通过", payload: ["设计审计结论", "documentRevisionIds", "证据 ID", "Main Agent approval 工单"] },
  { from: "manager", to: "designer", deliveryTrack: "design", auditScope: null, when: "Main Agent 拒绝设计或计划", payload: ["拒绝原因", "返工范围", "新关联 ID"] },
  { from: "manager", to: "builder", deliveryTrack: "implementation", auditScope: null, when: "Main Agent 批准设计与开发计划", payload: ["批准记录", "冻结设计修订", "计划 ID", "关联节点"] },
  { from: "builder", to: "auditor", deliveryTrack: "implementation", auditScope: "implementation", when: "Builder 完成编码/施工和开发者测试", payload: ["implementationRevision", "变更摘要", "开发者测试", "证据 ID", "producerWorkerId"] },
  { from: "auditor", to: "builder", deliveryTrack: "implementation", auditScope: "implementation", when: "Implementation Auditor 审计失败", payload: ["失败证据 ID", "复现步骤", "返工范围", "保留的旧证据"] },
  { from: "auditor", to: "manager", deliveryTrack: "implementation", auditScope: "implementation", when: "Implementation Auditor 审计通过", payload: ["实现审计结论", "验收标准结果", "证据 ID", "Main Agent approval 工单"] },
  { from: "manager", to: "builder", deliveryTrack: "implementation", auditScope: null, when: "Main Agent 拒绝最终验收", payload: ["拒绝原因", "返工范围", "新关联 ID", "保留的旧证据"] },
];

export function buildAgentOrchestration(store: Store, projectId: string, includePrompts = true): AgentOrchestration | undefined {
  const workflow = buildProjectWorkflow(store, projectId);
  const project = getProjectedProjectWorkspace(store, projectId, workflow)?.project;
  if (!project || !workflow) return undefined;
  const queues: AgentOrchestration["queues"] = { design: [], development: [], audit: [], approval: [], managerApproval: [] };
  if (inspectProjectFoundation(store, projectId).approvedBriefCount === 0) {
    const brief = projectBriefProgress(store, projectId);
    const suffix = projectBriefTaskSuffix(projectId);
    const queue = brief.stage;
    const role = queue === "design" ? "designer" : queue === "audit" ? "auditor" : "approver";
    const actionCode = queue === "design" ? "prepare_project_brief"
      : queue === "audit" ? "audit_project_brief" : "approve_project_brief";
    const failedRevision = brief.evidence?.resultStatus === "fail" ? brief.evidence.id
      : brief.approval?.result_digest.startsWith("rejected:") ? brief.approval.id : "";
    const assignee = role === "approver" ? MAIN_AGENT_APPROVER : {
      agentId: `project-brief-${role}:${projectId}`,
      displayName: `项目简报 ${role === "designer" ? "Designer" : "Design Auditor"}`,
    };
    queues[queue].push({
      id: `${queue}:${suffix}`, queue, projectId, diagramId: null, nodeId: null, planItemId: null,
      correlationId: suffix, title: `项目简报：${project.name}`,
      reason: queue === "design" ? "形成项目级需求简报；提交者不得自审"
        : queue === "audit" ? "独立审计当前项目简报修订" : "Main Agent 复核独立设计审计并批准或退回",
      priority: "P1", deliveryLayer: 0, dueAt: "", createdAt: project.createdAt,
      actionCode, deliveryTrack: "design", auditScope: queue === "design" ? null : "design",
      deliveryAttempt: 1, producerTaskKey: queue === "audit" ? brief.design?.task_key ?? null
        : queue === "approval" ? brief.audit?.task_key ?? null : null,
      producerWorkerId: queue === "audit" ? brief.design?.worker_id ?? null
        : queue === "approval" ? brief.audit?.worker_id ?? null : null,
      documentRevisionIds: brief.revisionId ? [brief.revisionId] : [], implementationRevision: "",
      supersedesEvidenceIds: failedRevision ? [failedRevision] : [], managerApprovalRequired: false,
      href: `#/projects/${projectId}?tab=documents`, assignee,
      workScopes: [`project:${projectId}`],
    });
  }
  if (workflow.nextAction?.code === "add_function_node" && workflow.nextAction.diagramId) {
    const diagramId = workflow.nextAction.diagramId;
    const briefReferences = store.listDocumentReferences({ projectId, targetType: "project", targetId: projectId })
      .filter((reference) => reference.relationType === "defines");
    const approvedBrief = store.listDesignDocs(projectId).find((document) => document.status === "已批准"
      && ["需求文档", "功能说明"].includes(document.category)
      && briefReferences.some((reference) => reference.documentId === document.id
        && reference.documentRevisionId === document.currentRevisionId));
    if (!approvedBrief) throw new AgentTaskPackageError(409, "PROJECT_BRIEF_REQUIRED", "节点拆分缺少已批准的项目简报");
    queues.design.push({
      id: `design:project-nodes:${projectId}`, queue: "design", projectId, diagramId, nodeId: null, planItemId: null,
      correlationId: `project-nodes:${projectId}`, title: `拆分功能节点：${project.name}`,
      reason: "按已批准项目简报在系统主画布建立首批可交付功能节点",
      priority: "P1", deliveryLayer: 0, dueAt: "", createdAt: project.createdAt,
      actionCode: "add_function_node", deliveryTrack: "design", auditScope: null,
      deliveryAttempt: 1, producerTaskKey: null, producerWorkerId: null,
      documentRevisionIds: [approvedBrief.currentRevisionId], implementationRevision: "",
      supersedesEvidenceIds: [], managerApprovalRequired: false,
      href: workflow.nextAction.href,
      assignee: { agentId: `project-nodes-designer:${projectId}`, displayName: "功能节点 Designer" },
      workScopes: [`diagram:${diagramId}`],
    });
  }
  const layerStateByPlanId = new Map(workflow.layerGate.plans.map((state) => [state.planId, state]));
  // Load plans once per project and index by `${diagramId}|${nodeId}` to avoid re-querying per node.
  const plansByNode = new Map<string, PlanItem[]>();
  const projectPlans = store.listPlans(projectId);
  for (const plan of projectPlans) {
    if (!isActiveDeliveryPlan(plan) || !plan.diagramId || !plan.diagramNodeId) continue;
    const key = `${plan.diagramId}|${plan.diagramNodeId}`;
    const list = plansByNode.get(key) ?? [];
    list.push(plan);
    plansByNode.set(key, list);
  }
  const designGapByPlanId = new Map<string, { rootPlan: PlanItem; gap: DesignGap }>();
  for (const rootPlan of projectPlans) {
    const gap = getDesignGap(store, rootPlan);
    if (!gap) continue;
    for (const planId of designChangeImpactedPlanIds(projectPlans, gap.impactedPlanIds)) {
      if (!designGapByPlanId.has(planId)) designGapByPlanId.set(planId, { rootPlan, gap });
    }
  }

  for (const node of workflow.nodes) {
    const plans = plansByNode.get(`${node.diagramId}|${node.nodeId}`) ?? [];
    const action = node.nextAction;
    const pendingNodeDocumentApproval = hasPendingNodeDocumentRevision(store, projectId, node.nodeId);
    const nodeDocumentApprovalIsNext = action?.code === "approve_node_document";
    // A later approved revision of a shared node document supersedes the revision this node
    // pinned. The node must keep getting its approve_node_document task, otherwise it loses
    // the only chance to re-pin and silently drops out of every queue.
    if (node.acceptanceStatus === "已通过"
      && !ACCEPTED_NODE_ACTIONS.has(action?.code ?? "")
      && !pendingNodeDocumentApproval) continue;
    if (action && DESIGN_ACTIONS.has(action.code)
      && !(nodeDocumentApprovalIsNext && pendingNodeDocumentApproval)
      && workflow.layerGate.issues.length === 0) {
      const actionPlan = action.entityType === "plan" && action.entityId
        ? plans.find((plan) => plan.id === action.entityId) ?? null
        : null;
      queues.design.push(task(store, "design", projectId, node, actionPlan, action.code, action.description));
    }
    if (action?.code === "approve_node_requirement" && workflow.layerGate.issues.length === 0) {
      queues.approval.push(task(store, "approval", projectId, node, null, action.code, action.description));
    }
    if (pendingNodeDocumentApproval && action?.code !== "approve_node_requirement" && workflow.layerGate.issues.length === 0) {
      const approval = task(store, "approval", projectId, node, null, "approve_node_document",
        "节点存在未批准或未固定的当前文档修订，由 Main Agent 使用独立 approval 工单审核。");
      approval.href = `#/canvas/${node.diagramId}/node/${node.nodeId}?tab=documents`;
      queues.approval.push(approval);
    }
    if (action?.code === "submit_evidence_repair" && action.entityId && !node.layerLocked) {
      const repairPlan = plans.find((plan) => plan.id === action.entityId);
      // Legacy accepted plans may not have a durable repair row yet. The workflow
      // already derives an open state for them; enqueue the task and let start
      // materialize the row under the Builder lease.
      if (repairPlan && (getEvidenceRepairState(store, repairPlan.id)
        ?? deriveEvidenceRepairState(repairPlan, 3))) {
        queues.development.push(task(store, "development", projectId, node, repairPlan, action.code, action.description));
      }
    }
    if (["assess_evidence_repair_failure", "reset_evidence_repair_attempt", "request_design_change"].includes(action?.code ?? "") && action?.entityId && !node.layerLocked) {
      const repairPlan = plans.find((plan) => plan.id === action.entityId);
      if (repairPlan) {
        queues.approval.push(task(store, "approval", projectId, node, repairPlan, action.code, action.description));
      }
    }
    for (const plan of plans) {
      if (designGapByPlanId.has(plan.id)) continue;
      const planLayerState = layerStateByPlanId.get(plan.id);
      const implementationUnlocked = isPlanImplementationUnlocked(projectPlans, plan);
      if (plan.lifecycleStatus === "draft") {
        if (!queues.design.some((item) => item.planItemId === plan.id && item.actionCode === "submit_plan")) {
          queues.design.push(task(store, "design", projectId, node, plan, "submit_plan", "草稿施工单等待 Designer 固定设计修订并提交", planLayerState?.layer));
        }
      } else if (plan.lifecycleStatus === "pending_approval") {
        if (plan.auditStatus === "passed") {
          queues.approval.push(task(store, "approval", projectId, node, plan, "approve_plan", "设计审计已通过，等待 Main Agent 使用独立 approval 工单执行常规批准", planLayerState?.layer));
        } else {
          queues.audit.push(task(store, "audit", projectId, node, plan, "audit_design", "Designer 已提交固定文档修订，等待独立 Design Auditor 审核", planLayerState?.layer));
        }
      } else if (plan.managerDecision === "rejected" && implementationUnlocked) {
        queues.development.push(task(store, "development", projectId, node, plan, "reopen_rework", plan.rejectionReason || "Main Agent 验收被拒绝，等待 Builder 返工", planLayerState?.layer));
      } else if (plan.lifecycleStatus === "rework") {
        if (!queues.design.some((item) => item.planItemId === plan.id)) {
          queues.design.push(task(store, "design", projectId, node, plan, "submit_plan", plan.rejectionReason || "设计审计或 Main Agent 评审未通过，等待 Designer 返工并提交新修订", planLayerState?.layer));
        }
      } else if (
        (["approved", "in_progress", "legacy"].includes(plan.lifecycleStatus))
        && (!plan.submittedAt || !plan.approvedAt)
      ) {
        if (!queues.design.some((item) => item.planItemId === plan.id && item.actionCode === "submit_plan")) {
          queues.design.push(task(store, "design", projectId, node, plan, "submit_plan", "施工单缺少正式提交或批准痕迹，需要重建计划基线", planLayerState?.layer));
        }
      } else if (plan.lifecycleStatus === "approved" && implementationUnlocked) {
        queues.development.push(task(store, "development", projectId, node, plan, "start_development", "设计审计与 Main Agent 批准已完成，等待 Builder 明确开工", planLayerState?.layer));
      } else if (plan.status !== "已完成" && plan.lifecycleStatus === "in_progress" && implementationUnlocked) {
        queues.development.push(task(store, "development", projectId, node, plan, "complete_development", "施工已开始且计划尚未完成", planLayerState?.layer));
      } else if (plan.status === "已完成" && !["passed", "failed"].includes(plan.auditStatus)) {
        queues.audit.push(task(store, "audit", projectId, node, plan, "audit_completed_plan", "Builder 已提交实现修订，等待独立 Implementation Auditor 审核", planLayerState?.layer));
      } else if (plan.auditStatus === "passed" && plan.managerDecision === "pending") {
        queues.approval.push(task(store, "approval", projectId, node, plan, "approve_acceptance", "实现审计已通过，等待 Main Agent 使用独立 approval 工单核验证据并执行最终验收", planLayerState?.layer));
      } else if (plan.auditStatus === "failed" && implementationUnlocked) {
        queues.development.push(task(store, "development", projectId, node, plan, "reopen_rework", "独立实现审计失败，等待 Builder 返工", planLayerState?.layer));
      }
    }
    if (action?.code === "add_node_evidence" && plans.length === 0) {
      queues.audit.push(task(store, "audit", projectId, node, null, action.code, action.description));
    }
    if (action?.code === "accept_node" && !node.layerLocked && plans.length > 0) {
      queues.approval.push(task(store, "approval", projectId, node, plans.at(-1)!, action.code, "由 Main Agent 使用独立 approval 工单复核全部计划与证据，完成节点验收"));
    }
  }

  for (const queue of EXECUTABLE_QUEUES) {
    queues[queue] = queues[queue].filter((item) => !item.planItemId
      || !layerStateByPlanId.get(item.planItemId)?.locked
      || (workflow.layerGate.issues.length === 0 && isDesignPhaseAction(item.actionCode)));
  }

  queues.approval = queues.approval.filter((item) => item.actionCode !== "request_design_change"
    || !item.planItemId || !designGapByPlanId.has(item.planItemId));
  const queuedGapScopes = new Set<string>();
  for (const [planId, impact] of designGapByPlanId) {
    const plan = projectPlans.find((item) => item.id === planId);
    if (!plan?.diagramId || !plan.diagramNodeId) continue;
    const scope = `${plan.diagramId}:${plan.diagramNodeId}`;
    if (queuedGapScopes.has(`${impact.gap.id}:${scope}`)) continue;
    const node = workflow.nodes.find((item) => item.diagramId === plan.diagramId && item.nodeId === plan.diagramNodeId);
    if (!node) continue;
    const impactedPlanIds = designChangeImpactedPlanIds(projectPlans, impact.gap.impactedPlanIds);
    const approval = task(store, "approval", projectId, node, plan, "request_design_change",
      `${impact.gap.reason}；本次影响计划=${impactedPlanIds.join(",")}`);
    approval.correlationId = `design-gap:${impact.gap.id}:${impact.rootPlan.id}`;
    queues.approval.push(approval);
    queuedGapScopes.add(`${impact.gap.id}:${scope}`);
  }

  for (const intent of listPendingDesignChangeIntents(store, projectId)) {
    const plans = intent.impactedPlanIds.map((id) => projectPlans.find((plan) => plan.id === id))
      .filter((plan): plan is PlanItem => Boolean(plan && isActiveDeliveryPlan(plan) && plan.diagramId && plan.diagramNodeId));
    const byScope = new Map<string, PlanItem>();
    for (const plan of plans) {
      const scope = `${plan.diagramId}:${plan.diagramNodeId}`;
      const current = byScope.get(scope);
      if (!current || plan.id === intent.rootPlanId || plan.id.localeCompare(current.id) < 0) byScope.set(scope, plan);
    }
    for (const plan of byScope.values()) {
      const node = workflow.nodes.find((item) => item.diagramId === plan.diagramId && item.nodeId === plan.diagramNodeId);
      if (!node) continue;
      const approval = task(store, "approval", projectId, node, plan, "request_design_change", intent.reason);
      approval.correlationId = `design-change-intent:${intent.intentId}`;
      approval.designChangeIntent = intent;
      queues.approval.push(approval);
    }
  }

  // A credential-unavailable recovery request is non-authorizing by itself. It
  // temporarily replaces only the exact stale audit task with a same-node Main
  // Agent approval task. Any request whose plan or original assignment drifted
  // is ignored here and therefore cannot suppress the current executable task.
  for (const request of listPendingAgentTaskReassignments(store, projectId)) {
    const plan = store.getPlan(request.targetPlanItemId);
    if (!plan || plan.projectId !== projectId || !plan.diagramId || !plan.diagramNodeId
      || plan.lifecycleStatus !== "pending_audit" || plan.status !== "已完成"
      || normalizeAgentId(plan.roleAssignments.auditor.agentId) !== normalizeAgentId(request.originalAssignment.agentId)) continue;
    const node = workflow.nodes.find((item) => item.diagramId === plan.diagramId && item.nodeId === plan.diagramNodeId);
    if (!node) continue;
    queues.audit = queues.audit.filter((item) => item.id !== request.targetTaskId);
    const approval = task(
      store,
      "approval",
      projectId,
      node,
      plan,
      AGENT_REASSIGNMENT_APPROVAL_ACTION,
      `原 Auditor 凭据不可用；Main Agent 仅可在目标审计无有效 lease 时批准改派到 ${request.replacementAssignment.displayName || request.replacementAssignment.agentId}`,
    );
    approval.id = agentReassignmentApprovalTaskId(request.id);
    approval.workScopes = request.targetWorkScopes;
    approval.correlationId = plan.correlationId || plan.id;
    queues.approval.push(approval);
  }

  // Canonical delivery nodes, rather than the transient executable queues,
  // determine whether a no-plan task needs a diagram-qualified id. A sibling
  // moving to approval/completion must not make the remaining task fall back
  // to a different lease key and thereby lose attempt/backoff history.
  const canonicalNodeIdCounts = new Map<string, number>();
  for (const workflowNode of workflow.nodes) {
    canonicalNodeIdCounts.set(workflowNode.nodeId, (canonicalNodeIdCounts.get(workflowNode.nodeId) ?? 0) + 1);
  }
  const duplicateCanonicalNodeIds = new Set(
    [...canonicalNodeIdCounts].filter(([, count]) => count > 1).map(([nodeId]) => nodeId),
  );
  for (const queue of EXECUTABLE_QUEUES) {
    for (const queuedTask of queues[queue]) {
      if (!queuedTask.nodeId || !duplicateCanonicalNodeIds.has(queuedTask.nodeId)
        || queuedTask.planItemId || !queuedTask.diagramId) continue;
      queuedTask.id = `${queue}:${queuedTask.diagramId}:${queuedTask.nodeId}`;
    }
  }

  const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  // 设计缺口会阻断已有施工，自动领取时优先于仍可按 taskId 精确领取的文档审批。
  const approvalActionRank = (item: AgentOrchestrationTask) => item.actionCode === "request_design_change"
    ? 0 : item.actionCode === "approve_node_document" ? 2 : 1;
  const compareTasks = (left: AgentOrchestrationTask, right: AgentOrchestrationTask) =>
    (left.queue === "approval" && right.queue === "approval" ? approvalActionRank(left) - approvalActionRank(right) : 0)
    || (left.deliveryLayer ?? Number.MAX_SAFE_INTEGER) - (right.deliveryLayer ?? Number.MAX_SAFE_INTEGER)
    || priorityRank[left.priority] - priorityRank[right.priority]
    || (left.dueAt || "9999-12-31").localeCompare(right.dueAt || "9999-12-31")
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
  for (const queue of Object.values(queues)) queue.sort(compareTasks);

  const counts = {
    design: queues.design.length,
    development: queues.development.length,
    audit: queues.audit.length,
    approval: queues.approval.length,
    managerApproval: queues.managerApproval.length,
  };
  return {
    schemaVersion: "1.3",
    generatedAt: new Date().toISOString(),
    workflowPolicyVersion: PROJECT_WORKFLOW_POLICY.version,
    agentSecurityPolicyVersion: AGENT_POLICY_VERSION,
    project,
    workingDirectory: inspectAgentWorkingDirectory(project.repositoryPath),
    workflow,
    recommendedAgents: agentBlueprints(store, includePrompts),
    queues,
    handoffs: HANDOFFS,
    bootstrapPrompt: includePrompts
      ? [
        `你是外部通用 Agent 编排器。连接 ProductDesign 项目 ${project.code}（${project.id}）。`,
        `设计任务使用托管项目目录 ${managedProjectPath(store.dataDir, projectId)}；开发任务的目标代码目录是 ${project.repositoryPath || "（未配置）"}，必须由用户在该目录手动启动。`,
        "ProductDesign 只提供编排蓝图和任务包，不启动外部进程，也不替外部 Agent 编写目标项目代码。",
        `编排器或会话初始化时读取一次 get_agent_orchestration；队列长度仅代表待办数（designer=${counts.design}，builder=${counts.development}，auditor=${counts.audit}），绝不能按任务数创建 Agent。Worker 领取任务后以任务包为上下文真源，不再重复读取全局编排。`,
        "只按 leaseSummary.activeSlots 与 leaseSummary.roleSlots 创建有限 Worker；每个外部进程使用唯一且稳定的 workerId，同一 workerId/sessionId 一次只领取一个任务。",
        `managerApproval=${counts.managerApproval} 仅保留 human-only 高风险执行授权，禁止自动创建管理员 Agent；施工计划批准和证据充分的最终验收由 Main Agent 领取独立 approval 工单。`,
        "Main Agent 先按工作流和队列确定任务：approval 队列中的独立 Approver 工单直接调用 claim_next_agent_task(role=approver, agentId=Main Agent) 领取，开工后按任务包完成审批；无需父协调租约。派发子 Agent 时才领取父协调租约：已有计划传 planId；无计划设计任务及项目简报审计传精确 taskKey+taskRevision，二者恰选其一。任务型只派绑定任务，完成后自动释放。只有 Main Agent 可以选择、派发、暂停、回收、重派和推进计划型阶段。",
        "Main Agent 通过 dispatch_child_task 按当前阶段派发精确任务包；Designer、Builder、Auditor 禁止调用 claim_next_agent_task 自行领取任务，必须使用 claim_dispatched_child_task 并校验一次性 dispatchId。子 Agent 不共享 Main Agent 的 authSessionToken；未登记凭据的本机子身份凭派发和子租约执行，已登记凭据的身份仍按其自身认证策略执行。",
        "子 Agent 只接收自己的任务包和子租约；Main Agent 响应永不返回子 Agent 的 leaseToken。父租约暂停、回收、过期或 Runner 失联时，服务端级联释放子租约、资源锁和工作区预留，旧心跳必须返回 LEASE_LOST。",
        "阶段严格按 设计 → 审核 → 批准 → 编码 → 审计 → 验收推进；禁止跨阶段派发和并行验收。",
        "每个 Designer、Builder 和 Auditor 都必须提交与本人任务绑定的工单，写明 taskKey、taskRevision、实际产出或证据；未提交工单不得交接或宣告完成。",
        "并发 Builder 必须先准备独立 Git worktree 或等价隔离目录，并在 start_agent_task 提交 workspacePath、分支和基线修订。",
        "计划流转必须携带 leaseToken、agentId、idempotencyKey。租约冲突或丢失时立即停止当前工作，并重新读取可领取队列。",
        "Worker 领取后不要重复读取项目、节点或租约详情；仅在终态动作前后、租约/修订错误或服务端明确要求时调用 get_project_workflow。所有交接保留 projectId、diagramId、nodeId、planItemId、correlationId、sessionId、runId 和证据 ID。",
        "设计线路固定为 Main Agent → Designer → Design Auditor → 失败回 Designer → 审计通过后 Main Agent 以独立 Approver 工单批准。",
        "编码线路固定为 Main Agent → Builder → Implementation Auditor → 失败回 Builder → 审计通过后 Main Agent 以独立 Approver 工单验收并继续下一任务；Builder 完成的是编码/施工，不是设计。",
        "Auditor 的 workerId 必须不同于 producerWorkerId，且不得修改被审计产物；human-only 高风险动作始终由人类处理。",
        "Auditor 凭据不可用时，只能先建立持久化改派请求，再由 Main Agent 领取同节点独立 approval 工单批准；不得重签凭据或降低认证。",
      ].join("\n")
      : "",
  };
}

function selectTask(orchestration: AgentOrchestration, selector: AgentTaskPackageSelector): {
  queue: AgentExecutableQueueKey;
  task: AgentOrchestrationTask;
} {
  const queues = selector.queue ? [selector.queue] : EXECUTABLE_QUEUES;
  const candidates = queues.flatMap((queue) => orchestration.queues[queue].map((task) => ({ queue, task })));
  if (selector.taskId) {
    const selected = candidates.find(({ task }) => task.id === selector.taskId);
    if (!selected) {
      const planId = selector.taskId.slice(selector.taskId.indexOf(":") + 1);
      const layerState = orchestration.workflow.layerGate.plans.find((state) => state.planId === planId);
      if (layerState?.locked) throw new AgentTaskPackageError(409, "PLAN_LAYER_LOCKED", layerState.lockReason);
      throw new AgentTaskPackageError(404, "AGENT_TASK_NOT_FOUND", "指定任务不存在或不属于所选队列");
    }
    return selected;
  }
  const next = orchestration.workflow.nextAction;
  const matchingNextAction = next
    ? candidates.find(({ task }) => task.actionCode === next.code
      && (!next.entityId || task.planItemId === next.entityId || task.nodeId === next.entityId))
    : undefined;
  if (matchingNextAction) return matchingNextAction;
  if (candidates[0]) return candidates[0];
  if (orchestration.queues.managerApproval.length > 0) {
    throw new AgentTaskPackageError(409, "HUMAN_APPROVAL_REQUIRED", "当前下一步需要人工管理员批准，不能生成外部 Agent 执行任务包");
  }
  throw new AgentTaskPackageError(409, "NO_EXECUTABLE_AGENT_TASK", "当前没有可交给外部 Agent 的设计、施工或审计任务");
}

export function buildAgentTaskPackage(
  store: Store,
  projectId: string,
  selector: AgentTaskPackageSelector = {},
  orchestrationOverride?: AgentOrchestration,
): AgentTaskPackage {
  // Claim flows pass the snapshot used for atomic selection so packaging does
  // not rebuild the full project orchestration after the lease is written.
  const orchestration = orchestrationOverride ?? buildAgentOrchestration(store, projectId, true);
  if (!orchestration) throw new AgentTaskPackageError(404, "PROJECT_NOT_FOUND", "项目不存在");
  validateAgentTaskPackageSelector(store, orchestration, selector);
  const { queue, task } = selectTask(orchestration, selector);
  const managedDirectory = inspectAgentWorkingDirectory(managedProjectPath(store.dataDir, projectId));
  const workingDirectory = queue === "development" ? orchestration.workingDirectory
    : managedDirectory.ready || isProjectBriefTask(task.actionCode) || task.actionCode === "add_function_node"
      ? managedDirectory : orchestration.workingDirectory;
  if (!workingDirectory.ready) {
    throw new AgentTaskPackageError(409, "WORKING_DIRECTORY_NOT_READY", workingDirectory.issue);
  }
  const role = ROLE_BY_QUEUE[queue];
  const configuredBlueprint = orchestration.recommendedAgents.find((item) => item.key === role);
  const roleBlueprint = configuredBlueprint && task.actionCode === "add_function_node"
    ? { ...configuredBlueprint, allowedMcpTools: canonicalAgentTools([
      "get_project_workflow", "get_project_workspace", "get_diagram", "get_design_doc", "validate_diagram",
      "start_agent_task", "heartbeat_agent_task", "mutate_diagram", "complete_agent_task", "fail_agent_task", "release_agent_task",
    ]) }
    : configuredBlueprint && isProjectBriefTask(task.actionCode)
    ? { ...configuredBlueprint, allowedMcpTools: canonicalAgentTools(task.actionCode === "prepare_project_brief"
      ? ["get_project_workflow", "get_project_workspace", "get_design_doc", "create_design_doc", "patch_design_doc",
        "create_document_reference", "start_agent_task", "heartbeat_agent_task", "complete_agent_task", "fail_agent_task", "release_agent_task"]
      : task.actionCode === "audit_project_brief"
        ? ["get_project_workflow", "get_design_doc", "create_evidence", "start_agent_task", "heartbeat_agent_task",
          "complete_agent_task", "fail_agent_task", "release_agent_task"]
        : ["get_project_workflow", "get_design_doc", "list_evidence", "start_agent_task", "heartbeat_agent_task",
          "complete_agent_task", "release_agent_task"]) }
    : configuredBlueprint && task.actionCode === "revise_node_requirement"
    ? { ...configuredBlueprint, allowedMcpTools: canonicalAgentTools([
      "get_project_workflow", "get_project_workspace", "get_diagram", "get_design_doc", "validate_diagram",
      "claim_dispatched_child_task", "start_agent_task", "heartbeat_agent_task", "mutate_diagram",
      "complete_agent_task", "fail_agent_task", "release_agent_task",
    ]) }
    : configuredBlueprint;
  if (!roleBlueprint) throw new AgentTaskPackageError(500, "AGENT_BLUEPRINT_MISSING", `缺少 ${role} 角色蓝图`);
  const assignmentFromTask = effectiveAgentTaskAssignment(task, role);
  const effectiveAssignment = selector.allowCoordinationAssignmentOverride && selector.lease
    ? {
      ...assignmentFromTask,
      assignee: {
        ...(assignmentFromTask.assignee ?? { agentId: "", displayName: "" }),
        agentId: selector.lease.agentId,
        displayName: selector.lease.agentId,
      },
      poolId: selector.lease.poolId || assignmentFromTask.poolId,
    }
    : assignmentFromTask;
  if (!effectiveAssignment.assignee?.agentId || !effectiveAssignment.poolId) {
    throw new AgentTaskPackageError(409, "ROLE_ASSIGNMENT_REQUIRED", "该任务缺少可验证的受派身份，不能生成任务包");
  }
  const plan = task.planItemId ? store.getPlan(task.planItemId) ?? null : null;
  if (task.planItemId && !plan) throw new AgentTaskPackageError(404, "PLAN_NOT_FOUND", "任务关联的开发计划不存在");
  if (!plan && (role === "builder" || (role === "auditor" && task.actionCode !== "audit_project_brief"))) {
    throw new AgentTaskPackageError(409, "ROLE_ASSIGNMENT_REQUIRED", "Builder 与 Auditor 必须由已批准开发计划明确分配");
  }
  if (plan) {
    try {
      if (queue === "development") assertPlanImplementationUnlocked(store, plan);
      else assertPlanLayerUnlocked(store, plan, task.actionCode);
    } catch (cause) {
      const error = cause as Error & { statusCode?: number; code?: string };
      throw new AgentTaskPackageError(error.statusCode ?? 409, error.code ?? "PLAN_LAYER_LOCKED", error.message);
    }
    const roleErrors = roleAssignmentErrors(plan.roleAssignments, true);
    if (roleErrors.length > 0) {
      throw new AgentTaskPackageError(409, "ROLE_ASSIGNMENT_INVALID", `开发计划角色分配无效：${roleErrors.join("；")}`);
    }
  }
  const assignment = effectiveAssignment.assignee;
  if (selector.lease && selector.lease.agentId.trim().toLocaleLowerCase() !== assignment.agentId.trim().toLocaleLowerCase()) {
    throw new AgentTaskPackageError(409, "LEASE_AGENT_MISMATCH", "任务租约与受派 Agent 身份不一致");
  }

  // 领取任务即内嵌当前节点、关联文档，以及存在时的完整计划快照。
  const diagram = task.diagramId ? store.getDiagram(task.diagramId) : undefined;
  const diagramNode = diagram && task.nodeId
    ? diagram.nodes.find((item) => item.id === task.nodeId)
    : undefined;
  const nodeSnapshot: AgentTaskPackageNode | null = diagram && diagramNode
    ? {
      diagramId: diagram.id,
      diagramTitle: diagram.title,
      nodeId: diagramNode.id,
      label: diagramNode.label,
      kind: diagramNode.kind,
      description: diagramNode.description ?? "",
      requirementStatus: diagramNode.requirementStatus ?? "",
      designStatus: diagramNode.designStatus ?? "",
      developmentStatus: diagramNode.developmentStatus ?? "",
      acceptanceStatus: diagramNode.acceptanceStatus ?? "",
      acceptanceCriteria: diagramNode.acceptanceCriteria ?? "",
      notes: diagramNode.notes ?? "",
      owner: diagramNode.owner ?? "",
      preconditions: diagramNode.preconditions ?? "",
      mainFlow: diagramNode.mainFlow ?? "",
      alternateFlow: diagramNode.alternateFlow ?? "",
      postconditions: diagramNode.postconditions ?? "",
      blockedReason: diagramNode.blockedReason ?? "",
    }
    : null;
  const documentsById = new Map(store.listDesignDocs(projectId).map((doc) => [doc.id, doc]));
  const documentReferences = [
    ...((isProjectBriefTask(task.actionCode) || task.actionCode === "add_function_node")
      ? store.listDocumentReferences({ projectId, targetType: "project", targetId: projectId })
      : []),
    ...(nodeSnapshot
      ? store.listDocumentReferences({ projectId, targetType: "diagramNode", targetId: nodeSnapshot.nodeId })
      : []),
    ...(plan ? store.listDocumentReferences({ projectId, targetType: "plan", targetId: plan.id }) : []),
  ];
  const frozenRevisionIds = task.documentRevisionIds.length > 0
    ? [...new Set(task.documentRevisionIds)]
    : [...new Set(documentReferences.map((reference) => reference.documentRevisionId))];
  const documents: AgentTaskPackageDocument[] = [];
  const seenRevisionIds = new Set<string>();
  let remainingDocumentBudget = TASK_PACKAGE_DOCUMENT_BUDGET;
  for (const revisionId of frozenRevisionIds) {
    if (seenRevisionIds.has(revisionId)) continue;
    const revision = store.getDocumentRevision(revisionId);
    const doc = revision ? documentsById.get(revision.documentId) : undefined;
    if (!doc || !revision || revision.projectId !== projectId
      || (revision.status !== "已批准" && !isProjectBriefTask(task.actionCode))) continue;
    const reference = documentReferences.find((item) => item.documentRevisionId === revision.id)
      ?? documentReferences.find((item) => item.documentId === revision.documentId);
    seenRevisionIds.add(revisionId);
    const contentSize = Math.min(TASK_PACKAGE_DOCUMENT_SLICE, remainingDocumentBudget);
    const content = revision.content.slice(0, contentSize);
    remainingDocumentBudget -= content.length;
    documents.push({
      id: doc.id,
      documentRevisionId: revision.id,
      title: revision.title,
      category: revision.category,
      status: revision.status,
      version: revision.version,
      author: revision.author,
      updatedAt: doc.updatedAt,
      relationType: reference?.relationType ?? "frozen_design_baseline",
      targetType: reference?.targetType ?? "plan",
      targetId: reference?.targetId ?? plan?.id ?? task.nodeId ?? projectId,
      content,
      contentOffset: 0,
      nextContentOffset: content.length < revision.content.length ? content.length : null,
      hasMore: content.length < revision.content.length,
    });
  }
  const dependencies = (plan?.dependencyIds ?? [])
    .map((dependencyId) => store.getPlan(dependencyId))
    .filter((dependency): dependency is PlanItem => Boolean(dependency && dependency.projectId === projectId));
  const databaseBindings = nodeSnapshot
    ? store.listNodeDatabaseBindings({ projectId, diagramId: nodeSnapshot.diagramId, diagramNodeId: nodeSnapshot.nodeId })
    : [];
  const evidenceRequirements = task.actionCode === "add_function_node"
    ? ["仅在系统主画布新增模块或功能节点", "一次原子提交首批节点", "完成结论与画布写入审计记录"]
    : task.actionCode === "prepare_project_brief"
    ? ["项目级 defines 引用", "需求文档或功能说明的当前修订", "非空目标、范围、约束和成功标准"]
    : task.actionCode === "audit_project_brief"
      ? ["独立于 Designer 的身份", "当前 documentRevisionId", "details.auditScope=design", "pass/fail 审计证据"]
    : task.actionCode === "approve_project_brief"
      ? ["Main Agent 独立 Approver 工单", "当前简报修订", "独立设计审计通过证据", "批准或明确退回条件"]
    : task.actionCode === "revise_node_requirement"
    ? ["仅更新当前节点需求及流程字段", "状态提交为待评审", "完成结论与精确工单修订"]
    : task.actionCode === "approve_node_requirement"
    ? ["非空审核结论", "精确需求工单修订与节点作用域"]
    : role === "designer"
    ? ["固定的 documentRevisionIds", "计划提案修订与依赖", "验收标准、风险与阻塞解除条件"]
    : role === "builder"
      ? ["实际执行命令与结果", "implementationRevision", "变更摘要", "验收标准逐项自检", "关联 evidenceId"]
      : task.auditScope === "design"
        ? ["details.auditScope=design", "每个固定 documentRevisionId 的独立检查结论", "验收标准可实施性", "缺陷与返工条件", "关联 evidenceId"]
        : ["details.auditScope=implementation", "当前 implementationRevision", "独立执行的测试命令与结果", "验收标准逐项结论", "缺陷与复现步骤", "关联 evidenceId"];

  const packageId = randomUUID();
  const suggestedSessionId = selector.lease?.sessionId || `external-${role}-${packageId}`;
  const suggestedRunId = selector.lease?.runId || packageId;
  const workerId = selector.lease?.workerId || assignment.agentId;
  const poolId = selector.lease?.poolId || assignment.poolId || "";
  const boundaries = [
    `只允许在目标工作目录 ${workingDirectory.repositoryPath} 内处理本任务。`,
    "ProductDesign 系统内 Agent 不负责写目标项目代码，也不会启动或托管本次外部 Agent。",
    ...roleBlueprint.boundaries,
    "不得直接修改 ProductDesign 的 SQLite 数据，所有产品状态写入必须经过 MCP 或 REST 门禁。",
    "不得绕过独立审计或自动批准 human-only 高风险事项。",
    ...(role === "auditor" ? [
      `当前 auditScope=${task.auditScope}；不得跨范围复用结论。`,
      `当前 producerWorkerId=${task.producerWorkerId ?? "未知"}；审计 Worker 必须与生产 Worker 不同。`,
      "只读审核被审计产物；失败时只提交证据和返工条件。",
    ] : []),
  ];
  const prompt = [
    `你是 ${roleBlueprint.name}，负责 ProductDesign 项目 ${orchestration.project.code} 的外部任务。`,
    `目标项目：${orchestration.project.name}（${orchestration.project.id}）`,
    `目标工作目录：${workingDirectory.repositoryPath}`,
    "该目录必须由用户在启动 Codex、Trae 或其他外部 Agent 前手动设置；不要在 ProductDesign 控制台进程的默认目录代写其他项目代码。",
    `任务：${task.title}`,
    `队列/动作：${queue} / ${task.actionCode}`,
    `交付线路：deliveryTrack=${task.deliveryTrack}, auditScope=${task.auditScope ?? "-"}, deliveryAttempt=${task.deliveryAttempt}`,
    `生产任务：producerTaskKey=${task.producerTaskKey ?? "-"}, producerWorkerId=${task.producerWorkerId ?? "-"}`,
    `固定设计修订：${task.documentRevisionIds.join("；") || "-"}`,
    `当前实现修订：${task.implementationRevision || "-"}`,
    `版本边界：workflowPolicyVersion=${orchestration.workflow.policyVersion}；agentSecurityPolicyVersion=${AGENT_POLICY_VERSION}（两者不可互换）`,
    `已被本轮替代的旧证据：${task.supersedesEvidenceIds.join("；") || "-"}`,
    `交付层级：第 ${task.deliveryLayer ?? "-"} 层；当前开放第 ${orchestration.workflow.layerGate.activeLayer ?? "-"} / ${orchestration.workflow.layerGate.totalLayers} 层。`,
    `受派身份：agentId=${assignment.agentId}, displayName=${assignment.displayName}`,
    `Worker：workerId=${workerId}, poolId=${poolId || "兼容池"}`,
    `任务原因：${task.reason}`,
    `关联 ID：diagramId=${task.diagramId ?? "-"}, nodeId=${task.nodeId ?? "-"}, planItemId=${task.planItemId ?? "-"}, correlationId=${task.correlationId}`,
    nodeSnapshot ? `当前节点：${nodeSnapshot.label}（${nodeSnapshot.diagramTitle}）开发状态=${nodeSnapshot.developmentStatus || "-"}，验收状态=${nodeSnapshot.acceptanceStatus || "-"}` : "",
    nodeSnapshot?.acceptanceCriteria ? `验收标准：\n${nodeSnapshot.acceptanceCriteria}` : "",
    documents.length > 0 ? `关联文档：${documents.map((doc) => `${doc.title}(${doc.id}, ${doc.status}, ${doc.relationType})`).join("；")}` : "",
    "任务包已内嵌 planSnapshot、node、dependencies、当前相关文档正文、databaseBindings 与 evidenceRequirements；领取后不得再调用 list_plan_items 定位任务。",
    plan
      ? "执行期间以 planSnapshot 和本任务包为上下文真源；文档正文未完整内嵌时，仅用 get_design_doc(projectRef, documentId, revisionId, contentOffset) 继续读取。"
      : `${isProjectBriefTask(task.actionCode) ? "当前为项目简报任务" : task.actionCode === "add_function_node" ? "当前为主画布节点拆分任务" : "当前为节点级无计划设计任务"}；执行期间以本任务包为上下文真源，文档正文未完整内嵌时仅用 get_design_doc(projectRef, documentId, revisionId, contentOffset) 继续读取。`,
    "领取后不要重复调用 get_agent_orchestration、get_project_workspace、get_project_snapshot、list_project_workspace_nodes 或 get_project_workflow；关键路径仅用于项目级提示，不作为已领取 Worker 任务的等值校验。仅在终态流转前后、收到 LEASE_LOST/TASK_REVISION_DRIFT/POLICY_VERSION_STALE/WORK_ORDER_CONTEXT_INVALID，或任务包修订与服务端不一致时刷新 workflow。",
    ...roleBlueprint.responsibilities.map((item) => `职责：${item}`),
    ...boundaries.map((item) => `禁止/约束：${item}`),
    `运行标识建议：sessionId=${suggestedSessionId}, runId=${suggestedRunId}`,
    ...(selector.lease ? [
      `独占任务租约：leaseToken=${selector.lease.leaseToken}`,
      `资源范围锁：${selector.lease.workScopes.join("；") || "无"}`,
      `独立工作区预留：${selector.lease.workspace.recommendedPath || "由外部编排器提供"}；建议分支 ${selector.lease.workspace.recommendedBranch}`,
      `租约到期：${selector.lease.leaseExpiresAt}；工作期间每 ${selector.lease.heartbeatSeconds} 秒调用 heartbeat_agent_task 续租。`,
      "开始任何目标项目修改前调用 start_agent_task；Builder 并发时必须提交独立 workspacePath、workspaceBranch 和 baselineRevision。所有计划流转必须携带 leaseToken 和唯一 idempotencyKey。",
      "若收到 LEASE_LOST、TASK_ALREADY_CLAIMED 或租约过期，立即停止写入，不得继续抢占任务。",
      task.actionCode === "add_function_node"
        ? "在当前主画布一次原子新增首批模块或功能节点，然后以 complete_agent_task(resultDigest=拆分结论) 完工。"
      : isProjectBriefTask(task.actionCode)
        ? "项目简报任务以 complete_agent_task 提交固定文档修订、独立审计证据或 Main Agent 结论；不得调用计划流转替代。"
      : ["revise_node_requirement", "approve_node_document", "approve_node_requirement"].includes(task.actionCode)
        ? "核验当前节点资料后调用 complete_agent_task(resultDigest=审核结论)；服务端会在精确工单修订下原子完成审批。"
        : "transition_plan_delivery 成功后会自动推进或关闭租约；不要在工作流动作完成前单独调用 complete_agent_task。",
    ] : []),
    task.actionCode === "prepare_project_brief"
      ? "创建或修订项目级需求简报并以 defines 引用绑定项目，保持评审中；调用 complete_agent_task(documentRevisionId=当前修订) 后交独立审计。"
      : task.actionCode === "audit_project_brief"
        ? "只读审计当前项目简报修订，创建 actorRole=auditor、details.auditScope=design、documentRevisionId=当前修订的 pass/fail 证据，再调用 complete_agent_task(evidenceId, verdict)。"
      : task.actionCode === "approve_project_brief"
        ? "Main Agent 核对独立审计通过证据后调用 complete_agent_task(verdict=pass/fail, resultDigest=审核结论；拒绝时填写 reworkConditions)；服务端原子批准或退回简报。"
      : task.actionCode === "add_function_node"
        ? "仅在本工单主画布一次原子新增首批模块或功能节点；不要修改已有节点或其他画布。"
      : role === "auditor" && task.auditScope === "design"
      ? "完成后为每个固定 documentRevisionId 创建带 details.auditScope=design 的审计证据，再执行 pass_design_audit 或 fail_design_audit；不得直接批准计划。"
      : role === "auditor"
        ? "完成后创建绑定当前 implementationRevision 且 details.auditScope=implementation 的审计证据，再执行 pass_audit 或 fail_audit；不得直接验收。"
        : task.actionCode === "revise_node_requirement"
          ? "本工单只允许 mutate_diagram 修改当前节点需求与流程字段，提交 requirementStatus=待评审 后以 complete_agent_task(resultDigest=修订结论) 完工；不能批准自己。"
        : task.actionCode === "approve_node_requirement"
          ? "本工单只审核当前节点需求；确认后用 complete_agent_task 提交审核结论，不得自行改写节点资料。"
        : task.actionCode === "approve_node_document"
          ? "本工单只审核当前节点待批准或待固定的文档修订；确认后用 complete_agent_task 提交审核结论，不得改写文档正文。"
        : "完成后运行与风险相称的测试，通过 create_evidence 回传命令、结果、当前修订和证据 ID。",
    "普通执行期间只按租约 heartbeat；终态动作或受控写入错误后再刷新 workflow，并以新的 nextAction 作为交接依据。",
  ].filter(Boolean).join("\n");

  return {
    schemaVersion: "1.3",
    packageId,
    generatedAt: new Date().toISOString(),
    deliveryTrack: task.deliveryTrack,
    auditScope: task.auditScope,
    attempt: task.deliveryAttempt,
    producerTaskKey: task.producerTaskKey,
    producerWorkerId: task.producerWorkerId,
    documentRevisionIds: task.documentRevisionIds,
    implementationRevision: task.implementationRevision,
    supersedesEvidenceIds: task.supersedesEvidenceIds,
    managerApprovalRequired: task.managerApprovalRequired,
    workflowPolicyVersion: orchestration.workflow.policyVersion,
    agentSecurityPolicyVersion: AGENT_POLICY_VERSION,
    policyVersion: AGENT_POLICY_VERSION,
    workOrderStatus: selector.lease?.status ?? "unclaimed",
    requiredSubmissionFields: evidenceRequirements,
    project: {
      id: orchestration.project.id,
      code: orchestration.project.code,
      name: orchestration.project.name,
      repositoryPath: orchestration.project.repositoryPath,
    },
    workingDirectory,
    workflow: {
      phase: orchestration.workflow.phase,
      phaseLabel: orchestration.workflow.phaseLabel,
      status: orchestration.workflow.status,
      summary: orchestration.workflow.summary,
      nextAction: orchestration.workflow.nextAction,
    },
    task: { ...task, role },
    assignment,
    worker: { agentId: assignment.agentId, workerId, poolId },
    roleBlueprint,
    planSnapshot: plan,
    node: nodeSnapshot,
    documents,
    dependencies,
    databaseBindings,
    evidenceRequirements,
    ...(selector.lease ? { lease: selector.lease } : {}),
    launch: {
      manualStartRequired: true,
      workingDirectory: workingDirectory.repositoryPath,
      instructions: [
        `由用户手动在 ${workingDirectory.repositoryPath} 打开 Codex、Trae 或终端会话。`,
        "把本任务包中的 launch.prompt 完整交给外部 Agent。",
        "外部 Agent 直接使用任务包中的项目、节点、计划、文档和租约上下文；仅按 prompt 中的刷新条件读取最新 workflow。",
      ],
      prompt,
    },
    boundaries,
    evidenceReturn: {
      requiredFields: ["actorRole", "agentId", "sessionId", "runId", "auditScope", "documentRevisionId", "implementationRevision", "commands", "resultStatus", "evidenceId", "blockedReason"],
      instructions: [
        "生产或审计完成后使用 create_evidence 关联 projectId、nodeId、planItemId、sessionId 与 runId。",
        "设计审计证据绑定当前 documentRevisionId；实现审计证据绑定当前 implementationRevision；未执行的检查不得写成通过。",
        "写入证据或推进计划后重新调用 get_project_workflow，人工门禁出现时立即停下。",
      ],
    },
    handoff: {
      correlationId: task.correlationId,
      suggestedSessionId,
      suggestedRunId,
      nextStep: "完成当前角色职责后回传证据与运行标识，并按最新 workflow 唯一 nextAction 交接。",
    },
  };
}
