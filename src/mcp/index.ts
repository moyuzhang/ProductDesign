import { claimTaskPackage } from "../server/claimTaskPackage.js";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DESIGN_STATUSES,
  DEVELOPMENT_STATUSES,
  HEALTH_LEVELS,
  NODE_KINDS,
  PLAN_KINDS,
  PLAN_STATUSES,
  PRIORITIES,
  PROJECT_STAGES,
  REQUIREMENT_STATUSES,
  TEST_STATUSES,
} from "../shared/types.js";
import { collectGitEvidence } from "../server/collectors.js";
import { Store, nowIso } from "../server/db.js";
import { validateDocumentReferenceTarget } from "../server/domain.js";
import { ensureManagedProjectDirectory, syncManagedProject, syncManagedProjectStorage } from "../server/projectFiles.js";
import { buildProjectWorkflow } from "../server/workflow.js";
import { AgentTaskPackageError, buildAgentOrchestration } from "../server/orchestration.js";
import {
  AgentTaskLeaseError,
  completeAgentTask,
  decorateAgentOrchestrationWithLeases,
  failAgentTask,
  reportDesignGap,
  dismissDesignGap,
  getAgentTaskCapacity,
  heartbeatAgentTask,
  listAgentRunners,
  listAgentWorkerPools,
  pageAgentTaskLeases,
  listClaimableAgentTasks,
  isExactCommittedEvidenceRepairStartReplay,
  projectAgentOrchestrationResponse,
  releaseAgentTask,
  startAgentTask,
  updateAgentTaskCapacity,
} from "../server/agentTaskLeases.js";
import { getProjectedProjectWorkspace, listProjectedProjects } from "../server/projectProjection.js";
import { registerFullTools } from "./fullTools.js";
import { registerDatabaseTools } from "./database.js";
import { CodexHarness } from "../server/agentHarness.js";
import {
  AGENT_POLICY_INSTRUCTIONS,
  AGENT_POLICY_VERSION,
  AgentSecurityError,
  assertCoordinationMainAgent,
  recordScopedAgentWrite,
  acknowledgeAgentPolicy,
  beginAgentAuth,
  completeAgentAuth,
  issueOneTimeNonce,
  assertAgentWorkOrderContext,
  isAgentSecurityEnforced,
  resolveAuthPrincipal,
} from "../server/agentSecurity.js";
import { classifyMcpTool, DELEGABLE_HIGH_RISK_MCP, SCOPE_GUARDED_CONTROLLED_MCP } from "../server/controlledWriteRegistry.js";
import { agentWriteContextSchema, leaseWriteContextSchema, optionalLeaseWriteContextSchema, AGENT_WRITE_CONTEXT_DESCRIPTION } from "./agentWriteSchema.js";
import {
  AGENT_REASSIGNMENT_REASON,
  AgentTaskReassignmentError,
  approveAgentTaskReassignment,
  requestAgentTaskReassignment,
} from "../server/agentTaskReassignment.js";
import {
  AGENT_COORDINATION_STAGES,
  claimCoordinationLease,
  heartbeatCoordinationLease,
  listCoordinationLeases,
  dispatchChildTask,
  reclaimChildTask,
  reassignChildTask,
  pauseCoordinationLease,
  resumeCoordinationLease,
  releaseCoordinationLease,
  advanceCoordinationStage,
  listChildTaskDispatches,
  claimDispatchedChildTask,
  CoordinationLeaseError,
} from "../server/coordinationLeases.js";

function createStore(dbPath = process.env.PCS_DB ?? resolve("data/control-surface.db")): Store {
  return new Store(dbPath);
}

function byRef(store: Store, projectRef: string) {
  return store.getProject(projectRef) ?? store.listProjects().find((p) => p.code.toLowerCase() === projectRef.toLowerCase());
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function structuredError(cause: unknown, fallbackCode = "CONTROL_SURFACE_ERROR") {
  const error = cause as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof error.code === "string" && error.code ? error.code : fallbackCode;
  const message = typeof error.message === "string" ? error.message : String(cause);
  const details = error.details && typeof error.details === "object" ? error.details : undefined;
  return `${code}: ${message}\n${JSON.stringify({ code, message, ...(details ? { details } : {}) }, null, 2)}`;
}

function pageOf<T>(items: T[], offset = 0, limit = 20) {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const pageItems = items.slice(safeOffset, safeOffset + safeLimit);
  return { total: items.length, offset: safeOffset, count: pageItems.length, hasMore: safeOffset + pageItems.length < items.length, items: pageItems };
}

export interface McpServerOptions {
  store?: Store;
  dbPath?: string;
  dataDir?: string;
  harness?: CodexHarness;
  /** Only in-process application/test clients may bypass external Agent write authentication. */
  trustedInternal?: boolean;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const dbPath = options.dbPath ?? process.env.PCS_DB ?? resolve("data/control-surface.db");
  const store = options.store ?? createStore(dbPath);
  const dataDir = options.dataDir ?? process.env.PCS_DATA_DIR ?? dirname(dbPath);
  let harness = options.harness;
  if (!harness) harness = new CodexHarness(store, dataDir, () => createMcpServer({ store, dbPath, dataDir, harness, trustedInternal: true }));
  const server = new McpServer(
    { name: "product-design-control-surface", version: "0.1.0" },
    { instructions: `${AGENT_POLICY_INSTRUCTIONS}\npolicyVersion=${AGENT_POLICY_VERSION}` },
  );
  const rawRegisterTool = server.registerTool.bind(server) as (...args: any[]) => any;
  (server as any).registerTool = (name: string, config: any, handler: (input: Record<string, unknown>, ...rest: unknown[]) => unknown) => {
    const risk = classifyMcpTool(name);
    const onboarding = ["begin_agent_auth", "complete_agent_auth", "ack_agent_policy", "issue_agent_write_nonce", "claim_next_agent_task", "get_agent_task_package", "claim_coordination_lease", "claim_dispatched_child_task"].includes(name);
    // Plan transitions enforce their own action-aware security. In particular,
    // Human UI calls intentionally have no Agent work order, while external
    // Designer/Builder/Auditor/Approver actions require a matching lease inside
    // assertAgentTaskLeaseForPlanAction. Do not make the generic lease fields
    // mandatory at schema level for this mixed-purpose tool.
    const internallySecured = name === "transition_plan_delivery" || name === "request_design_change"
      || name === "submit_design_change_intent" || name === "request_evidence_repair_assessment"
      || name === "dismiss_design_change_intent"
      || name === "report_design_gap" || name === "dismiss_design_gap"
      || name === "request_agent_reassignment" || name === "approve_agent_reassignment"
      || name === "dispatch_child_task" || name === "reclaim_child_task" || name === "reassign_child_task"
      || name === "heartbeat_coordination_lease" || name === "pause_coordination_lease"
      || name === "resume_coordination_lease"
      || name === "release_coordination_lease" || name === "advance_coordination_stage";
    const delegableHighRisk = DELEGABLE_HIGH_RISK_MCP.has(name);
    const securedConfig = !options.trustedInternal && (risk === "controlled" || delegableHighRisk) && !onboarding && !internallySecured ? {
      ...config,
      description: `${config.description ?? ""}\n${AGENT_WRITE_CONTEXT_DESCRIPTION}`.trim(),
      inputSchema: {
        ...(config.inputSchema ?? {}),
        ...(risk === "controlled" ? leaseWriteContextSchema : optionalLeaseWriteContextSchema),
      },
    } : config;

    // Shared validation for every external Agent write: the caller must present a matching,
    // active task lease whose identity, task revision and project all line up.
    const assertAgentLeaseContext = (input: Record<string, unknown>) => {
      const required = ["workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "role", "idempotencyKey"] as const;
      const missing = required.filter((key) => typeof input[key] !== "string" || !(input[key] as string).trim());
      if (missing.length) throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", `Missing: ${missing.join(", ")}`);
      const now = new Date().toISOString();
      const lease = store.db.prepare("SELECT * FROM agent_task_leases WHERE id=? AND lease_token=?")
        .get(input.workOrderId, input.leaseToken) as Record<string, string> | undefined;
      if (lease?.approval_group_id && !["start_agent_task", "heartbeat_agent_task", "release_agent_task", "fail_agent_task", "complete_agent_task"].includes(name)) {
        throw new AgentSecurityError(409, "ACTION_MISMATCH", "范围审批组只能用于对应设计变更和租约管理");
      }
      const project = typeof input.projectRef === "string" ? byRef(store, input.projectRef)
        : typeof input.planId === "string" ? store.getProject(store.getPlan(input.planId)?.projectId ?? "")
          : store.getProject(lease?.project_id ?? "");
      if (!project) throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", "受控写缺少可解析的项目上下文");
      const identityMatches = Boolean(lease
        && lease.task_key === input.taskKey && lease.task_revision === input.taskRevision
        && lease.project_id === project.id && lease.agent_id === input.agentId
        && lease.worker_id === input.workerId && lease.role === input.role);
      const coordinationWrite = ["start_agent_task", "heartbeat_agent_task", "complete_agent_task", "fail_agent_task", "release_agent_task"].includes(name);
      const parent = lease?.coordination_dispatch_id ? store.db.prepare(`SELECT c.status, c.lease_expires_at
        FROM agent_child_task_dispatches d LEFT JOIN agent_coordination_leases c ON c.id=d.coordination_lease_id
        WHERE d.dispatch_id=?`).get(lease.coordination_dispatch_id) as { status?: string; lease_expires_at?: string } | undefined : undefined;
      const coordinationLeaseLost = Boolean(lease?.coordination_dispatch_id && coordinationWrite
        && (!parent || parent.status !== "active" || (parent.lease_expires_at || "") <= now));
      if (coordinationLeaseLost && identityMatches) {
        throw new AgentSecurityError(409, "LEASE_LOST", "父协调租约已失效；停止写入并等待 Main Agent 重派");
      }
      const committedRepairStartReplay = name === "start_agent_task" && lease?.status === "failed"
        && lease.action_code === "submit_evidence_repair" && identityMatches
        && isExactCommittedEvidenceRepairStartReplay(store, input);
      if (!lease || !identityMatches
        || (!committedRepairStartReplay && (!["claimed", "running"].includes(lease.status) || lease.lease_expires_at <= now))) {
        throw new AgentSecurityError(409, "WORK_ORDER_CONTEXT_INVALID", "Work order, lease, task revision or identity does not match");
      }
      return { lease, project };
    };

    // A delegable high-risk action is only allowed on the very node the lease is scoped to.
    const assertDelegatedHighRiskScope = (lease: Record<string, string>, projectId: string, input: Record<string, unknown>) => {
      let scopes: string[] = [];
      try { scopes = JSON.parse(lease.work_scopes_json || "[]") as string[]; } catch { scopes = []; }
      const referenceId = typeof input.referenceId === "string" ? input.referenceId : "";
      const before = referenceId ? store.getDocumentReference(referenceId) : undefined;
      if (!before) throw new AgentSecurityError(409, "HIGH_RISK_SCOPE_REQUIRED", "未找到要解除的文档引用");
      if (before.projectId !== projectId || before.targetType !== "diagramNode") {
        throw new AgentSecurityError(403, "HIGH_RISK_SCOPE_REQUIRED", "高风险委派只允许解除本租约作用域内节点上的文档引用");
      }
      if (!scopes.some((scope) => scope.startsWith("node:") && scope.endsWith(`:${before.targetId}`))) {
        throw new AgentSecurityError(403, "HIGH_RISK_SCOPE_REQUIRED", "高风险委派只允许作用于租约 workScopes 内的节点");
      }
      return before;
    };

    // Scope guard for project-level governed records: a design-change correction must concern the
    // node or plan the caller's lease actually covers, and must be explicitly confirmed.
    const assertGovernanceWriteScope = (lease: Record<string, string>, projectId: string, input: Record<string, unknown>) => {
      const governanceId = typeof input.governanceId === "string" ? input.governanceId : "";
      const record = governanceId ? store.getGovernance(governanceId) : undefined;
      if (!record) throw new AgentSecurityError(404, "GOVERNANCE_NOT_FOUND", "未找到治理记录");
      if (record.projectId !== projectId) throw new AgentSecurityError(403, "GOVERNANCE_SCOPE_REQUIRED", "治理记录不属于当前项目");
      let scopes: string[] = [];
      try { scopes = JSON.parse(lease.work_scopes_json || "[]") as string[]; } catch { scopes = []; }
      const scopeSet = new Set(scopes);
      let content: { diagramId?: unknown; nodeId?: unknown; impactedPlanIds?: unknown } = {};
      try { content = JSON.parse(record.content || "{}") as typeof content; } catch { content = {}; }
      const planIds = new Set<string>();
      if (Array.isArray(content.impactedPlanIds)) {
        for (const id of content.impactedPlanIds) if (typeof id === "string" && id.trim()) planIds.add(id);
      }
      for (const plan of store.listPlans(projectId)) if (plan.correlationId === governanceId) planIds.add(plan.id);
      const nodeScope = typeof content.diagramId === "string" && typeof content.nodeId === "string"
        ? `node:${content.diagramId}:${content.nodeId}` : "";
      const inScope = Boolean(nodeScope && scopeSet.has(nodeScope))
        || [...planIds].some((planId) => {
          if (scopeSet.has(`plan:${planId}`)) return true;
          const plan = store.getPlan(planId);
          return Boolean(plan?.diagramNodeId && scopeSet.has(`node:${plan.diagramId}:${plan.diagramNodeId}`));
        });
      if (!inScope) {
        throw new AgentSecurityError(403, "GOVERNANCE_SCOPE_REQUIRED", "治理记录修正只允许作用于本租约 workScopes 覆盖的节点或计划");
      }
      return record;
    };

    const scopedWriteAuditFields = (input: Record<string, unknown>) => ({
      workOrderId: typeof input.workOrderId === "string" ? input.workOrderId : "",
      agentId: typeof input.agentId === "string" ? input.agentId : "",
      workerId: typeof input.workerId === "string" ? input.workerId : "",
      role: typeof input.role === "string" ? input.role : "",
    });

    return rawRegisterTool(name, securedConfig, (input: Record<string, unknown>, ...rest: unknown[]) => {
      const risk = classifyMcpTool(name);
      const agentRequest = !options.trustedInternal;
      if (agentRequest && risk === "high") {
        // A caller that does not present a complete work-order context must observe exactly the
        // original refusal: the delegation path is never advertised by a different error.
        const leaseContextKeys = ["workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "role", "idempotencyKey"] as const;
        const presentsLeaseContext = leaseContextKeys.every((key) => typeof input[key] === "string" && (input[key] as string).trim().length > 0);
        if (!delegableHighRisk || input.confirm !== true || !presentsLeaseContext) {
          return { ...toolText("HIGH_RISK_HUMAN_REQUIRED: 高风险动作只能由人工通道执行"), isError: true };
        }
        try {
          const { lease, project } = assertAgentLeaseContext(input);
          const before = assertDelegatedHighRiskScope(lease, project.id, input);
          recordScopedAgentWrite(store, {
            action: name, result: "success", ...scopedWriteAuditFields(input),
            details: {
              referenceId: String(input.referenceId ?? ""), documentId: before.documentId,
              targetType: before.targetType, targetId: before.targetId,
              leaseId: lease.id, delegation: "lease-scoped",
            },
          });
        } catch (cause) {
          if (!(cause instanceof AgentSecurityError)) throw cause;
          recordScopedAgentWrite(store, {
            action: name, result: "denied", errorCode: cause.code,
            ...scopedWriteAuditFields(input), details: { tool: name, delegation: "lease-scoped" },
          });
          return { ...toolText(`${cause.code}: ${cause.message}`), isError: true };
        }
      }
      if (agentRequest && risk === "controlled" && !onboarding && !internallySecured) {
        const scopeGuarded = SCOPE_GUARDED_CONTROLLED_MCP.has(name);
        try {
          const { lease, project } = assertAgentLeaseContext(input);
          if (scopeGuarded) {
            assertGovernanceWriteScope(lease, project.id, input);
            if (input.confirm !== true) throw new AgentSecurityError(409, "CONFIRM_REQUIRED", "治理记录修正需要显式 confirm=true");
            recordScopedAgentWrite(store, {
              action: name, result: "success", riskClass: "controlled", ...scopedWriteAuditFields(input),
              details: { governanceId: String(input.governanceId ?? ""), leaseId: lease.id, scope: "work-scope-guarded" },
            });
          }
        } catch (cause) {
          if (!(cause instanceof AgentSecurityError)) throw cause;
          if (scopeGuarded) {
            recordScopedAgentWrite(store, {
              action: name, result: "denied", riskClass: "controlled", errorCode: cause.code,
              ...scopedWriteAuditFields(input), details: { tool: name, scope: "work-scope-guarded" },
            });
          }
          return { ...toolText(`${cause.code}: ${cause.message}`), isError: true };
        }
      }
      return handler(input, ...rest);
    });
  };

  const securityResult = (operation: () => unknown) => {
    try { return toolText(JSON.stringify(operation(), null, 2)); }
    catch (cause) {
      if (cause instanceof AgentSecurityError) return { ...toolText(`${cause.code}: ${cause.message}`), isError: true };
      throw cause;
    }
  };

  server.registerTool("begin_agent_auth", {
    title: "开始 Agent 可信认证",
    description: "使用管理员登记的 credentialId 创建绑定 connectionId 的一次性挑战。loopback 不是信任依据。",
    inputSchema: { credentialId: z.string().uuid(), connectionId: z.string().trim().min(16).max(300) },
  }, ({ credentialId, connectionId }) => securityResult(() => beginAgentAuth(store, credentialId, connectionId)));

  server.registerTool("complete_agent_auth", {
    title: "完成 Agent 可信认证",
    description: "验证 HMAC-SHA256 challenge-response，并原子消费挑战；并发或重启后重放均拒绝。",
    inputSchema: {
      challengeId: z.string().uuid(), challenge: z.string().min(32), connectionId: z.string().trim().min(16).max(300),
      timestamp: z.string().datetime(), protocolVersion: z.string().trim().min(1).max(100), response: z.string().min(32),
    },
  }, (input) => securityResult(() => completeAgentAuth(store, input)));

  server.registerTool("ack_agent_policy", {
    title: "确认 Agent 策略",
    description: "在可信认证后确认 initialize.instructions 中的当前 policyVersion，并签发仅限 MCP/当前连接的 policyAckToken。",
    inputSchema: {
      authSessionToken: z.string().min(32), role: z.enum(["designer", "builder", "auditor", "approver"]),
      projectRef: z.string().min(1), policyVersion: z.string().min(1),
    },
  }, ({ authSessionToken, role, projectRef, policyVersion }) => securityResult(() => {
    const project = byRef(store, projectRef);
    if (!project) throw new AgentSecurityError(404, "PROJECT_NOT_FOUND", "Project not found");
    return acknowledgeAgentPolicy(store, resolveAuthPrincipal(store, authSessionToken), { role, projectId: project.id, policyVersion });
  }));

  server.registerTool("issue_agent_write_nonce", {
    title: "签发 Agent 单次写 nonce",
    description: "为一个受控动作、目标、请求摘要和 workOrderId 签发短时单次 nonce。",
    inputSchema: {
      policyAckToken: z.string().min(32), workOrderId: z.string().min(1), action: z.string().min(1),
      target: z.string().min(1), bodyDigest: z.string().length(64),
    },
  }, (input) => securityResult(() => issueOneTimeNonce(store, input)));

  server.registerTool("list_projects", {
    title: "列出项目",
    description: "列出控制台中所有项目（支持按阶段/健康过滤，关键字搜索）。",
    inputSchema: {
      stage: z.enum(PROJECT_STAGES).optional().describe("按阶段过滤"),
      health: z.enum(HEALTH_LEVELS).optional().describe("按健康度过滤"),
      q: z.string().optional().describe("名称/编号/摘要关键字"),
      configured: z.enum(["all", "yes", "no"]).default("all"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ stage, health, q, configured, offset, limit }) => {
    const baseProjects = store.listProjects({ q });
    if (!stage && !health && configured === "all") {
      const basePage = pageOf(baseProjects, offset, limit);
      const items = listProjectedProjects(store, basePage.items);
      return toolText(`共 ${basePage.total} 个项目，本页 ${basePage.count} 个\n${items.map((p) => `${p.code} | ${p.name} | 阶段:${p.stage} | 健康:${p.health} | 进度:${p.progress}% | ${p.summary.slice(0, 80)}`).join("\n")}`);
    }
    let projects = listProjectedProjects(store, baseProjects);
    if (stage) projects = projects.filter((project) => project.stage === stage);
    if (health) projects = projects.filter((project) => project.health === health);
    if (configured === "yes") projects = projects.filter((project) => !project.unconfigured);
    if (configured === "no") projects = projects.filter((project) => project.unconfigured);
    const page = pageOf(projects, offset, limit);
    return toolText(`共 ${page.total} 个项目，本页 ${page.count} 个\n${page.items.map((p) => `${p.code} | ${p.name} | 阶段:${p.stage} | 健康:${p.health} | 进度:${p.progress}% | ${p.summary.slice(0, 80)}`).join("\n")}`);
  });

  server.registerTool("get_project", {
    title: "查询项目详情",
    description: "按项目编号(code)或 id 返回项目详情，包括工作节点、计划与最近证据。",
    inputSchema: { projectRef: z.string().min(1).describe("项目 code 或 id") },
  }, ({ projectRef }) => {
    const base = byRef(store, projectRef);
    if (!base) return toolText(`未找到项目: ${projectRef}`);
    const workspace = getProjectedProjectWorkspace(store, base.id)!;
    const project = workspace.project;
    const nodes = store.listProjectWorkspaceNodes(project.id);
    const plans = store.listPlans(project.id);
    const evidence = store.listEvidence(project.id);
    return toolText([
      `${project.name} (${project.code})`,
      `阶段: ${project.stage} | 健康: ${project.health} | 进度: ${project.progress}%`,
      `风险: ${project.riskLevel} ${project.riskSummary}`, `阻塞: ${project.blockerSummary || "无"}`,
      `下一步: ${project.nextStep || "未填写"}`, `托管目录: data/projects/${project.id}`,
      `画布工作节点 ${nodes.length} / 计划 ${plans.length} / 证据 ${evidence.length}`,
      "", "画布工作节点:", ...nodes.slice(0, 20).map((item) => `- id=${item.node.id} [${item.node.kind}] ${item.node.label}（开发:${item.node.developmentStatus ?? "未开发"} 验收:${item.node.acceptanceStatus ?? "未验收"}）@ ${item.diagramTitle}`),
      "", "计划项:", ...plans.map((pl) => `- [${pl.kind}] ${pl.title} 状态=${pl.status} 截止=${pl.dueAt || "-"} ${pl.progress}%`),
      "", "最近证据:", ...evidence.slice(0, 5).map((ev) => `- [${ev.sourceType}/${ev.resultStatus}] ${ev.summary}`),
    ].join("\n"));
  });

  server.registerTool("get_project_workspace", {
    title: "获取项目工作区",
    description: "返回由画布节点、计划、文档和证据派生的项目状态、指标、主画布以及当前/下一步计划。",
    inputSchema: { projectRef: z.string().min(1) },
  }, ({ projectRef }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const workspace = getProjectedProjectWorkspace(store, project.id);
    return toolText(JSON.stringify(workspace, null, 2));
  });

  server.registerTool("get_project_workflow", {
    title: "获取项目设计推进工作流",
    description: "返回项目当前阶段、缺失门禁摘要和唯一下一步动作。编排器/会话初始化或终态动作、租约错误、修订漂移时调用；已领取任务包已包含执行所需的 workflow 摘要，不要在每个动作前重复调用。需要节点明细时使用 includeNodes 并分页。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      includeNodes: z.boolean().default(false).describe("是否返回交付节点明细"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ projectRef, includeNodes, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const workflow = buildProjectWorkflow(store, project.id)!;
    const nodePage = includeNodes ? pageOf(workflow.nodes, offset, limit) : undefined;
    return toolText(JSON.stringify({
      policyVersion: workflow.policyVersion,
      projectId: workflow.projectId,
      phase: workflow.phase,
      phaseLabel: workflow.phaseLabel,
      status: workflow.status,
      summary: workflow.summary,
      nextAction: workflow.nextAction,
      missingCount: workflow.missing.length,
      nodeTotal: workflow.nodes.length,
      ...(nodePage ? { nodePage } : {}),
    }, null, 2));
  });

  server.registerTool("get_agent_orchestration", {
    title: "获取外部 Agent 编排蓝图",
    description: "默认返回编排摘要、队列计数、容量和租约计数；使用 includeQueues/queue/offset/limit、includeRunners、includeWorkerPools 或 includePrompts 显式读取明细。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      includePrompts: z.boolean().optional().describe("是否包含角色和编排启动提示词"),
      includeQueues: z.boolean().optional().describe("是否包含分页后的队列任务"),
      queue: z.enum(["design", "development", "audit", "approval", "managerApproval"]).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      includeRunners: z.boolean().default(false),
      includeWorkerPools: z.boolean().default(false),
    },
  }, ({ projectRef, includePrompts, includeQueues, queue, offset, limit, includeRunners, includeWorkerPools }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const prompts = includePrompts === true;
    const orchestration = buildAgentOrchestration(store, project.id, prompts)!;
    const decorated = decorateAgentOrchestrationWithLeases(store, orchestration);
    // Explicit includePrompts=false is retained as a compatibility signal for old clients
    // that expected queues in the same response; a call with no flags stays summary-only.
    const queues = includeQueues === true || (includeQueues === undefined && includePrompts === false);
    return toolText(JSON.stringify(projectAgentOrchestrationResponse(decorated, {
      includeQueues: queues,
      queue,
      offset,
      limit,
      includeRunners,
      includeWorkerPools,
      includePrompts: prompts,
    }, store), null, 2));
  });

  server.registerTool("get_agent_task_package", {
    title: "领取外部 Agent 任务包",
    description: "原子领取当前或指定的设计、编码、设计审计或实现审计任务，返回带项目、节点、计划、文档、workflow 摘要、deliveryTrack、auditScope、生产者身份和租约的机器可读交付包。领取后以任务包为上下文真源，不要重复读取全局项目或编排；仅在终态动作或租约/修订错误后刷新 workflow。同一任务修订只能被一个 Agent 持有；生产 Worker 不得自审。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      role: z.enum(["designer", "builder", "auditor", "approver"]).describe("领取角色"),
      agentId: z.string().trim().min(1).max(200).describe("计划角色身份；必须与受派身份一致"),
      workerId: z.string().trim().min(1).max(300).optional().describe("具体外部进程的唯一稳定身份；旧客户端可省略"),
      poolId: z.string().trim().min(1).max(500).optional().describe("Worker 池；省略时使用计划角色的兼容池"),
      taskId: z.string().min(1).max(1000).optional().describe("可选：指定编排任务 id"),
      taskKey: z.string().min(1).max(2000).optional().describe("可选：指定任务修订键"),
      sessionId: z.string().trim().max(300).optional(),
      runId: z.string().trim().max(300).optional(),
      capabilities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
      leaseSeconds: z.number().int().min(15).max(1800).default(1800),
      idempotencyKey: z.string().trim().min(1).max(300).describe("客户端生成的幂等键；重试必须复用同一个值"),
    },
  }, ({ projectRef, role, agentId, workerId, poolId, taskId, taskKey, sessionId, runId, capabilities, leaseSeconds, idempotencyKey }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try {
      return toolText(claimTaskPackage(store, {
        projectId: project.id, taskId, taskKey, role, agentId, workerId,
        poolId, sessionId, runId, capabilities, leaseSeconds, idempotencyKey,
      }, { actor: agentId, source: "mcp", clientId: "productdesign-mcp" }));
    } catch (cause) {
      if (cause instanceof AgentTaskPackageError || cause instanceof AgentTaskLeaseError) {
        return { ...toolText(structuredError(cause)), isError: true };
      }
      throw cause;
    }
  });

  server.registerTool("claim_next_agent_task", {
    title: "由 Worker 池领取下一任务",
    description: "推荐入口。外部 Worker 不选择 taskId，由服务端按层级、优先级、容量、项目阻塞状态和资源范围锁原子派发一个可执行任务，并返回完整任务包作为上下文真源；领取后无需重复读取项目、节点或租约。同一设计缺口的范围审批会原子领取完整审批组，占一个槽位；返回 approvalGroupId 和 scopeApprovals，设计变更提交时携带全部范围租约，续租和释放任一成员会作用于整组。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      role: z.enum(["designer", "builder", "auditor", "approver"]).describe("Worker 角色"),
      agentId: z.string().trim().min(1).max(200).describe("计划角色身份"),
      workerId: z.string().trim().min(1).max(300).describe("每个外部进程唯一且稳定的 Worker 身份"),
      poolId: z.string().trim().min(1).max(500).optional(),
      sessionId: z.string().trim().max(300).optional(),
      runId: z.string().trim().max(300).optional(),
      capabilities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
      leaseSeconds: z.number().int().min(15).max(1800).default(1800),
      idempotencyKey: z.string().trim().min(1).max(300),
    },
  }, ({ projectRef, role, agentId, workerId, poolId, sessionId, runId, capabilities, leaseSeconds, idempotencyKey }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try {
      return toolText(claimTaskPackage(store, {
        projectId: project.id, role, agentId, workerId, poolId,
        sessionId, runId, capabilities, leaseSeconds, idempotencyKey,
      }, { actor: `worker:${workerId}`, source: "mcp", clientId: "productdesign-mcp" }));
    } catch (cause) {
      if (cause instanceof AgentTaskPackageError || cause instanceof AgentTaskLeaseError) {
        return { ...toolText(structuredError(cause)), isError: true };
      }
      throw cause;
    }
  });

  const coordinationParentSchema = {
    projectRef: z.string().min(1),
    coordinationLeaseId: z.string().trim().min(1).max(300),
    leaseToken: z.string().trim().min(1).max(300),
    mainAgentId: z.string().trim().min(1).max(200),
  };
  server.registerTool("claim_coordination_lease", {
    title: "Main Agent 领取父协调租约",
    description: "需先以 Main Agent 的 approver 凭据完成认证并传入 authSessionToken；领取绑定到单一目标计划，或精确无计划设计任务 taskKey+taskRevision 的父协调租约，两种目标恰选其一。",
    inputSchema: {
      projectRef: z.string().min(1), planId: z.string().trim().min(1).max(300).optional(),
      taskKey: z.string().trim().min(1).max(2000).optional(), taskRevision: z.string().trim().min(1).max(500).optional(),
      authSessionToken: z.string().min(32).max(300).optional(), mainAgentId: z.string().trim().min(1).max(200),
      workerId: z.string().trim().min(1).max(300), leaseSeconds: z.number().int().min(15).max(1800).default(1800),
      idempotencyKey: z.string().trim().min(1).max(300),
    },
  }, ({ projectRef, ...input }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try {
      assertCoordinationMainAgent(store, { ...input, projectId: project.id });
      const { authSessionToken: _authSessionToken, ...claim } = input;
      return toolText(JSON.stringify(claimCoordinationLease(store, { ...claim, projectId: project.id }), null, 2));
    } catch (cause) {
      if (cause instanceof CoordinationLeaseError || cause instanceof AgentSecurityError) return { ...toolText(structuredError(cause)), isError: true };
      throw cause;
    }
  });
  server.registerTool("heartbeat_coordination_lease", {
    title: "Main Agent 续租父协调租约",
    description: "Main Agent 续租父协调租约；父租约失效后所有子租约停止写入。",
    inputSchema: { ...coordinationParentSchema, leaseSeconds: z.number().int().min(15).max(1800).default(1800) },
  }, ({ projectRef, ...input }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try { return toolText(JSON.stringify(heartbeatCoordinationLease(store, { ...input, projectId: project.id }), null, 2)); }
    catch (cause) { if (cause instanceof CoordinationLeaseError) return { ...toolText(structuredError(cause)), isError: true }; throw cause; }
  });
  server.registerTool("dispatch_child_task", {
    title: "Main Agent 派发子任务",
    description: "Main Agent 按当前阶段派发精确 Designer、Builder 或 Auditor 任务；响应不包含子 Agent leaseToken。",
    inputSchema: {
      ...coordinationParentSchema, taskId: z.string().trim().min(1).max(1000), taskKey: z.string().trim().min(1).max(2000).optional(),
      role: z.enum(["designer", "builder", "auditor"]), agentId: z.string().trim().max(200).optional(),
      workerId: z.string().trim().max(300).optional(), poolId: z.string().trim().max(500).optional(),
    },
  }, ({ projectRef, ...input }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try { return toolText(JSON.stringify(dispatchChildTask(store, { ...input, projectId: project.id }), null, 2)); }
    catch (cause) { if (cause instanceof CoordinationLeaseError) return { ...toolText(structuredError(cause)), isError: true }; throw cause; }
  });
  server.registerTool("claim_dispatched_child_task", {
    title: "子 Agent 领取已派发任务包",
    description: "子 Agent 只能凭 Main Agent 生成的一次性 dispatchId 领取精确任务包和自己的子 leaseToken；不得自选任务。",
    inputSchema: {
      projectRef: z.string().min(1), dispatchId: z.string().trim().min(1).max(300), agentId: z.string().trim().min(1).max(200),
      workerId: z.string().trim().min(1).max(300), poolId: z.string().trim().max(500).optional(), sessionId: z.string().trim().max(300).optional(),
      runId: z.string().trim().max(300).optional(), capabilities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
      leaseSeconds: z.number().int().min(15).max(1800).default(1800), idempotencyKey: z.string().trim().min(1).max(300),
    },
  }, ({ projectRef, ...input }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try { return toolText(claimDispatchedChildTask(store, { ...input, projectId: project.id })); }
    catch (cause) { if (cause instanceof CoordinationLeaseError || cause instanceof AgentTaskLeaseError) return { ...toolText(structuredError(cause)), isError: true }; throw cause; }
  });
  const parentAction = (name: string, title: string, description: string, schema: Record<string, z.ZodTypeAny>, run: (input: any) => unknown) => server.registerTool(name, { title, description, inputSchema: { ...coordinationParentSchema, ...schema } }, (input: any) => {
    const project = byRef(store, input.projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${input.projectRef}`), isError: true };
    try { return toolText(JSON.stringify(run({ ...input, projectId: project.id }), null, 2)); }
    catch (cause) { if (cause instanceof CoordinationLeaseError) return { ...toolText(structuredError(cause)), isError: true }; throw cause; }
  });
  parentAction("reclaim_child_task", "Main Agent 回收子任务", "Main Agent 回收子任务并使旧子租约失效。", { dispatchId: z.string().trim().min(1).max(300), reason: z.string().trim().max(4000).optional() }, (input) => reclaimChildTask(store, input));
  parentAction("reassign_child_task", "Main Agent 重派子任务", "Main Agent 回收旧子租约后，按新的精确身份重派任务。", {
    dispatchId: z.string().trim().min(1).max(300), role: z.enum(["designer", "builder", "auditor"]), taskId: z.string().trim().max(1000).optional(),
    agentId: z.string().trim().min(1).max(200), workerId: z.string().trim().min(1).max(300), poolId: z.string().trim().max(500).optional(), reason: z.string().trim().max(4000).optional(),
  }, (input) => reassignChildTask(store, input));
  parentAction("pause_coordination_lease", "暂停父协调租约", "暂停父租约并级联回收所有活动子租约。", {}, (input) => pauseCoordinationLease(store, input));
  parentAction("resume_coordination_lease", "恢复父协调租约", "恢复暂停的父协调租约；恢复后 Main Agent 可重新派发当前阶段任务。", {}, (input) => resumeCoordinationLease(store, input));
  parentAction("release_coordination_lease", "释放父协调租约", "释放父协调租约并级联释放子租约、资源锁和工作区预留。", { reason: z.string().trim().max(4000).optional() }, (input) => releaseCoordinationLease(store, input));
  parentAction("advance_coordination_stage", "推进协调阶段", "Main Agent 严格按设计→审核→批准→编码→审计→验收推进，不允许跳阶段或并行验收。", { stage: z.enum(AGENT_COORDINATION_STAGES) }, (input) => advanceCoordinationStage(store, input));
  server.registerTool("list_coordination_leases", {
    title: "列出父协调租约", description: "列出项目父协调租约，不返回父 leaseToken。", inputSchema: { projectRef: z.string().min(1) },
  }, ({ projectRef }) => { const project = byRef(store, projectRef); return project ? toolText(JSON.stringify(listCoordinationLeases(store, project.id), null, 2)) : { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true }; });
  server.registerTool("list_child_task_dispatches", {
    title: "列出子任务派发", description: "列出 Main Agent 派发记录，不返回子 leaseToken。", inputSchema: { projectRef: z.string().min(1), coordinationLeaseId: z.string().trim().max(300).optional() },
  }, ({ projectRef, coordinationLeaseId }) => { const project = byRef(store, projectRef); return project ? toolText(JSON.stringify(listChildTaskDispatches(store, project.id, coordinationLeaseId), null, 2)) : { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true }; });

  server.registerTool("list_claimable_agent_tasks", {
    title: "列出可领取 Agent 任务",
    description: "列出当前层设计、施工和审计任务的可领取状态及占用者，不返回 leaseToken。",
    inputSchema: {
      projectRef: z.string().min(1),
      role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
      queue: z.enum(["design", "development", "audit", "approval"]).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ projectRef, role, queue, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    const tasks = listClaimableAgentTasks(store, project.id, "", undefined, role, queue);
    return toolText(JSON.stringify(pageOf(tasks, offset, limit), null, 2));
  });

  server.registerTool("list_agent_task_leases", {
    title: "列出 Agent 任务租约",
    description: "列出项目任务租约历史和当前状态，不返回 leaseToken。",
    inputSchema: { projectRef: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    return toolText(JSON.stringify(pageAgentTaskLeases(store, project.id, offset, limit), null, 2));
  });

  server.registerTool("get_agent_task_capacity", {
    title: "读取 Agent 并发与重试策略",
    description: "返回项目总并发、角色并发、最大尝试次数和失败退避配置。",
    inputSchema: { projectRef: z.string().min(1) },
  }, ({ projectRef }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    return toolText(JSON.stringify(getAgentTaskCapacity(store, project.id), null, 2));
  });

  server.registerTool("update_agent_task_capacity", {
    title: "更新 Agent 并发与重试策略",
    description: "更新项目总并发、角色并发、最大尝试次数和失败退避；不会启动任何外部 Agent。",
    inputSchema: {
      projectRef: z.string().min(1),
      maxActive: z.number().int().min(1).max(1000).optional(),
      designerMaxActive: z.number().int().min(1).max(1000).optional(),
      builderMaxActive: z.number().int().min(1).max(1000).optional(),
      auditorMaxActive: z.number().int().min(1).max(1000).optional(),
      maxAttempts: z.number().int().min(1).max(1000).optional(),
      retryBackoffSeconds: z.number().int().min(1).max(1000).optional(),
    },
  }, ({ projectRef, ...patch }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    return toolText(JSON.stringify(updateAgentTaskCapacity(store, project.id, patch), null, 2));
  });

  server.registerTool("list_agent_runners", {
    title: "列出外部 Agent Runner",
    description: "列出项目已注册 Runner 的角色、能力、会话、状态和最近心跳，不返回租约令牌。",
    inputSchema: { projectRef: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    return toolText(JSON.stringify(pageOf(listAgentRunners(store, project.id), offset, limit), null, 2));
  });

  server.registerTool("list_agent_worker_pools", {
    title: "列出 Agent Worker 池",
    description: "列出项目按角色形成的 Worker 池、并发上限、能力和状态。",
    inputSchema: { projectRef: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    return toolText(JSON.stringify(pageOf(listAgentWorkerPools(store, project.id), offset, limit), null, 2));
  });

  server.registerTool("request_agent_reassignment", {
    title: "请求恢复不可认证的审计任务",
    description: "仅在实现审计任务没有有效 lease 且原 Auditor 已启用凭据强制认证时，建立 credential_unavailable 持久化恢复请求；本工具不改派、不重签凭据，也不降低认证。",
    inputSchema: {
      projectRef: z.string().min(1),
      targetTaskId: z.string().trim().min(1).max(1000),
      targetTaskKey: z.string().trim().min(1).max(2000),
      targetTaskRevision: z.string().trim().min(1).max(500),
      targetPlanItemId: z.string().trim().min(1).max(300),
      targetActionCode: z.literal("audit_completed_plan"),
      targetWorkScopes: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
      originalAgentId: z.string().trim().min(1).max(200),
      originalDisplayName: z.string().trim().max(300).default(""),
      originalPoolId: z.string().trim().min(1).max(500),
      replacementAgentId: z.string().trim().min(1).max(200),
      replacementDisplayName: z.string().trim().max(300).default(""),
      replacementPoolId: z.string().trim().min(1).max(500),
      reason: z.literal(AGENT_REASSIGNMENT_REASON),
      requestedBy: z.literal("Main Agent"),
      idempotencyKey: z.string().trim().min(1).max(300),
    },
  }, ({ projectRef, originalAgentId, originalDisplayName, originalPoolId,
    replacementAgentId, replacementDisplayName, replacementPoolId, ...input }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    try {
      return toolText(JSON.stringify(requestAgentTaskReassignment(store, {
        ...input,
        projectId: project.id,
        originalAssignment: { agentId: originalAgentId, displayName: originalDisplayName, poolId: originalPoolId },
        replacementAssignment: { agentId: replacementAgentId, displayName: replacementDisplayName, poolId: replacementPoolId },
      }), null, 2));
    } catch (cause) {
      if (cause instanceof AgentTaskReassignmentError) return { ...toolText(`${cause.code}: ${cause.message}`), isError: true };
      throw cause;
    }
  });

  server.registerTool("approve_agent_reassignment", {
    title: "批准审计任务身份恢复",
    description: "Main Agent 使用同请求、同节点 scope 的独立 approval lease 原子批准改派；若身份、池、任务修订或目标 lease 变化则失败。已登记凭据的 Main Agent 仍需 policy token 与一次性 nonce，action=mcp.approve_agent_reassignment，target=mcp:approve_agent_reassignment。",
    inputSchema: {
      ...leaseWriteContextSchema,
      requestId: z.string().trim().min(1).max(300),
      approvalNote: z.string().trim().min(1).max(4000),
      policyAckToken: z.string().min(32).max(300).optional(),
      nonceId: z.string().min(1).max(300).optional(),
      authSessionToken: z.string().min(32).max(300).optional(),
      connectionId: z.string().min(16).max(300).optional(),
      bodyDigest: z.string().length(64).optional(),
    },
  }, (input) => {
    try {
      return toolText(JSON.stringify(approveAgentTaskReassignment(store, input), null, 2));
    } catch (cause) {
      if (cause instanceof AgentTaskReassignmentError || cause instanceof AgentSecurityError) {
        return { ...toolText(`${cause.code}: ${cause.message}`), isError: true };
      }
      throw cause;
    }
  });

  const leaseControlSchema = {
    ...(options.trustedInternal ? {
      leaseToken: z.string().trim().min(1).max(300),
      agentId: z.string().trim().min(1).max(200),
      idempotencyKey: z.string().trim().min(1).max(300),
    } : {
      ...leaseWriteContextSchema,
      // Security proof is required dynamically only for identities registered
      // in agent_credentials. Local lease-only workers must not fabricate it.
      policyAckToken: z.string().min(32).max(300).optional(),
      nonceId: z.string().min(1).max(300).optional(),
      authSessionToken: z.string().min(32).max(300).optional(),
      connectionId: z.string().min(16).max(300).optional(),
      bodyDigest: z.string().length(64).optional(),
    }),
    sessionId: z.string().trim().max(300).optional(),
  };
  const leaseTool = (
    name: "start_agent_task" | "heartbeat_agent_task" | "complete_agent_task" | "fail_agent_task" | "release_agent_task" | "report_design_gap" | "dismiss_design_gap",
    title: string,
    description: string,
    extraSchema: Record<string, z.ZodTypeAny>,
    execute: (input: Record<string, unknown>, context: {
      actor: string; source: "mcp"; clientId: string; sessionId?: string;
      securityAction: string; securityTarget: string;
    }) => unknown,
  ) => server.registerTool(name, {
    title,
    description,
    inputSchema: { ...leaseControlSchema, ...extraSchema },
  }, (input: Record<string, unknown>) => {
    try {
      const values = input as Record<string, unknown>;
      return toolText(JSON.stringify(execute(values, {
        actor: String(values.agentId), source: "mcp", clientId: "productdesign-mcp",
        sessionId: typeof values.sessionId === "string" ? values.sessionId : undefined,
        securityAction: `mcp.${name}`,
        securityTarget: `mcp:${name}`,
      }), null, 2));
    } catch (cause) {
      if (cause instanceof AgentTaskLeaseError) return { ...toolText(structuredError(cause)), isError: true };
      throw cause;
    }
  });
  leaseTool("start_agent_task", "开始 Agent 任务", "将已领取任务标记为运行中；并发 Builder 必须提交独立工作区。已登记的证据修复 Builder 使用服务端固定字段 workOrderId/leaseToken/taskKey/taskRevision/workerId/agentId/role/idempotencyKey/coordinationDispatchId/workspacePath/workspaceBranch/baselineRevision 的 JSON SHA-256 作为 nonce bodyDigest；服务端会重算。", {
    workspacePath: z.string().trim().max(2000).optional(),
    workspaceBranch: z.string().trim().max(500).optional(),
    baselineRevision: z.string().trim().max(500).optional(),
  }, (input, context) => startAgentTask(store, input as never, context));
  leaseTool("heartbeat_agent_task", "续租 Agent 任务", "Agent 执行期间定期续租；租约丢失后必须停止写入。", {
    leaseSeconds: z.number().int().min(15).max(1800).default(1800),
  }, (input, context) => heartbeatAgentTask(store, input as never, context));
  leaseTool("complete_agent_task", "完成 Agent 任务", "仅在对应工作流动作已经完成后关闭租约；计划流转通常会自动完成租约。", {
    resultDigest: z.string().max(4000).optional(),
    documentRevisionId: z.string().max(300).optional(), implementationRevision: z.string().max(300).optional(),
    evidenceId: z.string().max(300).optional(), testCommand: z.string().max(2000).optional(),
    verdict: z.enum(["pass", "fail"]).optional(), reworkConditions: z.string().max(4000).optional(),
  }, (input, context) => completeAgentTask(store, input as never, context));
  leaseTool("fail_agent_task", "失败 Agent 任务", "记录失败原因并释放任务供后续重新领取。", {
    error: z.string().max(4000).optional(),
  }, (input, context) => failAgentTask(store, input as never, context));
  leaseTool("release_agent_task", "释放 Agent 任务", "主动放弃尚未完成的任务。", {}, (input, context) => releaseAgentTask(store, input as never, context));
  const designGapSchema = {
    workOrderId: z.string().trim().min(1), taskKey: z.string().trim().min(1),
    taskRevision: z.string().trim().min(1), workerId: z.string().trim().min(1),
    role: z.enum(["builder", "approver"]), error: z.string().trim().min(1).max(4000),
    impactedPlanIds: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
  };
  leaseTool("report_design_gap", "报告设计缺口", "Builder 在开工前或施工中报告具体设计缺口，释放施工租约并生成独立设计变更审批工单；不增加证据修复失败次数，不批准新设计。", designGapSchema,
    (input, context) => reportDesignGap(store, input as never, context));
  leaseTool("dismiss_design_gap", "驳回设计缺口", "Main Agent 使用对应独立设计变更审批工单说明误报原因，关闭该审批租约并恢复原施工基线；不能复用报告者身份。", designGapSchema,
    (input, context) => dismissDesignGap(store, input as never, context));

  server.registerTool("get_next_project_action", {
    title: "获取项目唯一下一步动作",
    description: "只返回当前允许优先推进的一个动作及其目标页面，用于避免 Agent 跳过需求、设计、计划、证据或验收门禁。",
    inputSchema: { projectRef: z.string().min(1).describe("项目 code 或 id") },
  }, ({ projectRef }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const workflow = buildProjectWorkflow(store, project.id)!;
    return toolText(JSON.stringify({
      project: { id: project.id, code: project.code, name: project.name },
      phase: workflow.phase,
      phaseLabel: workflow.phaseLabel,
      status: workflow.status,
      nextAction: workflow.nextAction,
    }, null, 2));
  });

  server.registerTool("validate_project_workflow", {
    title: "检查项目工作流门禁",
    description: "只读检查项目当前是否具备继续推进条件，并列出缺少的项目简报、节点定义、文档、数据库关联、计划和证据。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const workflow = buildProjectWorkflow(store, project.id)!;
    return toolText(JSON.stringify({ ok: workflow.status === "completed", phase: workflow.phase, status: workflow.status, missing: pageOf(workflow.missing, offset, limit) }, null, 2));
  });

  server.registerTool("list_project_workspace_nodes", {
    title: "分页列出项目画布节点",
    description: "分页列出项目中作为交付工作项的模块、功能和需求节点。",
    inputSchema: {
      projectRef: z.string().min(1),
      q: z.string().optional(),
      kind: z.enum(["module", "feature", "requirement", "interface", "data"]).optional(),
      diagramId: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ projectRef, q, kind, diagramId, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    let nodes = store.listProjectWorkspaceNodes(project.id);
    if (diagramId) nodes = nodes.filter((item) => item.diagramId === diagramId);
    if (kind) nodes = nodes.filter((item) => item.node.kind === kind);
    if (q) {
      const keyword = q.trim().toLowerCase();
      nodes = nodes.filter((item) => `${item.node.label} ${item.node.description ?? ""} ${item.diagramTitle}`.toLowerCase().includes(keyword));
    }
    return toolText(JSON.stringify(pageOf(nodes, offset, limit), null, 2));
  });

  server.registerTool("update_project_status", {
    title: "更新项目状态",
    description: "更新项目的阶段、健康度、进度、风险/阻塞摘要或下一步行动。",
    inputSchema: {
      projectRef: z.string().min(1),
      stage: z.enum(PROJECT_STAGES).optional(),
      health: z.enum(HEALTH_LEVELS).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      riskSummary: z.string().max(2000).optional(),
      blockerSummary: z.string().max(2000).optional(),
      nextStep: z.string().max(2000).optional(),
    },
  }, (args) => {
    const project = byRef(store, args.projectRef);
    if (!project) return toolText(`未找到项目: ${args.projectRef}`);
    const patch: Record<string, unknown> = {};
    if (args.stage !== undefined) patch.stage = args.stage;
    if (args.health !== undefined) patch.health = args.health;
    if (args.progress !== undefined) patch.progress = args.progress;
    if (args.riskSummary !== undefined) patch.riskSummary = args.riskSummary;
    if (args.blockerSummary !== undefined) patch.blockerSummary = args.blockerSummary;
    if (args.nextStep !== undefined) patch.nextStep = args.nextStep;
    const updated = store.updateProject(project.id, patch);
    if (updated) ensureManagedProjectDirectory(dataDir, updated);
    store.recordAudit({ projectId: project.id, entityType: "project", entityId: project.id, action: "update", before: { health: project.health, stage: project.stage }, after: updated ? { health: updated.health, stage: updated.stage } : null, actor: "mcp-client", source: "mcp" });
    return toolText(`已更新 ${project.name}: ${JSON.stringify(patch)}\n当前派生状态: ${JSON.stringify(getProjectedProjectWorkspace(store, project.id)?.project ?? updated)}`);
  });

  server.registerTool("create_product_design_project", {
    title: "新建项目",
    description: "创建由服务托管的项目（默认阶段=探索、健康=正常），文件统一存放于 data/projects/<projectId>。",
    inputSchema: {
      code: z.string().min(1).describe("唯一编号"),
      name: z.string().min(1).describe("项目名称"),
      summary: z.string().max(2000).optional(),
      stage: z.enum(PROJECT_STAGES).optional(),
      health: z.enum(HEALTH_LEVELS).optional(),
    },
  }, (args) => {
    const project = store.insertProject({
      code: store.uniqueProjectCode(args.code), name: args.name, summary: args.summary ?? "",
      stage: args.stage ?? "探索", health: args.health ?? "正常", progress: 0, riskLevel: "P2",
      riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "",
      startAt: "", dueAt: "",
    });
    try {
      syncManagedProject(store, dataDir, project);
    } catch (cause) {
      store.deleteProject(project.id);
      return toolText(`项目托管目录创建失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    store.recordAudit({ projectId: project.id, entityType: "project", entityId: project.id, action: "create", before: null, after: { name: project.name, stage: project.stage }, actor: "mcp-client", source: "mcp" });
    return toolText(`已创建项目 ${project.name} (${project.code}) id=${project.id}`);
  });

  server.registerTool("list_work_nodes", {
    title: "列出工作节点",
    description: "列出旧版工作节点，仅用于兼容历史数据。设计推进应使用画布交付节点和 get_project_workflow。",
    inputSchema: { projectRef: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const page = pageOf(store.listNodes(project.id), offset, limit);
    return toolText(`${project.name} 共 ${page.total} 个旧工作节点，本页 ${page.count} 个\n${page.items.map((n) => `- id=${n.id} [${n.kind}] ${n.title} ${n.progress}%（需求:${n.requirementStatus} 设计:${n.designStatus} 开发:${n.developmentStatus} 验收:${n.testStatus}）`).join("\n")}`);
  });

  server.registerTool("update_work_node", {
    title: "更新工作节点",
    description: "更新一个工作节点的各项状态或进度。",
    inputSchema: {
      nodeId: z.string().min(1),
      requirementStatus: z.enum(REQUIREMENT_STATUSES).optional(),
      designStatus: z.enum(DESIGN_STATUSES).optional(),
      developmentStatus: z.enum(DEVELOPMENT_STATUSES).optional(),
      testStatus: z.enum(TEST_STATUSES).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      owner: z.string().max(100).optional(),
    },
  }, (args) => {
    const node = store.getNode(args.nodeId);
    if (!node) return toolText(`未找到工作节点: ${args.nodeId}`);
    const patch: Record<string, unknown> = {};
    if (args.requirementStatus !== undefined) patch.requirementStatus = args.requirementStatus;
    if (args.designStatus !== undefined) patch.designStatus = args.designStatus;
    if (args.developmentStatus !== undefined) patch.developmentStatus = args.developmentStatus;
    if (args.testStatus !== undefined) patch.testStatus = args.testStatus;
    if (args.progress !== undefined) patch.progress = args.progress;
    if (args.owner !== undefined) patch.owner = args.owner;
    store.updateNode(args.nodeId, patch);
    store.recordAudit({ projectId: node.projectId, entityType: "node", entityId: node.id, action: "update", before: { title: node.title }, after: patch, actor: "mcp-client", source: "mcp" });
    return toolText(`已更新节点「${node.title}」: ${JSON.stringify(patch)}`);
  });

  server.registerTool("list_plan_items", {
    title: "列出计划项",
    description: "列出某项目的计划项（目标/里程碑/版本/任务）。",
    inputSchema: { projectRef: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    const page = pageOf(store.listPlans(project.id), offset, limit);
    return toolText(`${project.name} 共 ${page.total} 个计划项，本页 ${page.count} 个\n${page.items.map((pl) => `- id=${pl.id} [${pl.kind}] ${pl.title} 状态=${pl.status} 截止=${pl.dueAt || "-"} ${pl.progress}%`).join("\n")}`);
  });

  server.registerTool("get_plan_item", {
    title: "按 ID 查询计划项",
    description: "按项目和计划 ID 返回完整快照（状态、生命周期、审计与验收决定、角色分配等）。用于任务执行期间的状态刷新，不需要先调用 list_plan_items。",
    inputSchema: { projectRef: z.string().min(1).describe("项目 code 或 id"), planId: z.string().min(1).describe("计划项 ID") },
  }, ({ projectRef, planId }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    const plan = store.getPlan(planId);
    if (!plan || plan.projectId !== project.id) return { ...toolText(`PLAN_NOT_FOUND: 计划不存在或不属于项目 ${project.code}`), isError: true };
    return toolText(JSON.stringify(plan, null, 2));
  });

  server.registerTool("create_plan_item", {
    title: "新建计划项",
    description: "在某项目新增一个计划项。",
    inputSchema: {
      projectRef: z.string().min(1),
      kind: z.enum(PLAN_KINDS).default("task"),
      title: z.string().min(1).max(300),
      status: z.enum(PLAN_STATUSES).default("未开始"),
      priority: z.enum(PRIORITIES).default("P2"),
      progress: z.number().int().min(0).max(100).default(0),
      dueAt: z.string().max(32).optional(),
    },
  }, (args) => {
    const project = byRef(store, args.projectRef);
    if (!project) return toolText(`未找到项目: ${args.projectRef}`);
    const plan = store.insertPlan({ projectId: project.id, parentId: null, kind: args.kind, title: args.title, description: "", status: args.status, priority: args.priority, progress: args.progress, owner: "", versionTag: "", startAt: "", dueAt: args.dueAt ?? "", dependencyIds: [] });
    store.recordAudit({ projectId: project.id, entityType: "plan", entityId: plan.id, action: "create", before: null, after: { title: plan.title, kind: plan.kind }, actor: "mcp-client", source: "mcp" });
    return toolText(`已新建计划项「${plan.title}」(${plan.kind}) id=${plan.id}`);
  });

  server.registerTool("list_design_docs", {
    title: "列出设计文档",
    description: "列出某项目（或全部）的设计文档。默认仅返回目录元数据；includeContent=true 时按字符预算返回正文。若 hasMore=true，继续使用返回的 nextOffset 和 nextContentOffset 调用，直到完整拉取全部文档。",
    inputSchema: {
      projectRef: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      includeContent: z.boolean().default(false),
      contentOffset: z.number().int().min(0).default(0),
      maxContentChars: z.number().int().min(1000).max(12000).default(8000),
    },
  }, ({ projectRef, offset, limit, includeContent, contentOffset, maxContentChars }) => {
    const project = projectRef ? byRef(store, projectRef) : undefined;
    if (projectRef && !project) return toolText(`未找到项目: ${projectRef}`);
    const docs = store.listDesignDocs(project?.id);
    if (!includeContent) {
      const page = pageOf(docs, offset, limit);
      return toolText(`共 ${page.total} 篇设计文档，本页 ${page.count} 篇\n${page.items.map((d) => `- id=${d.id} [${d.status}] ${d.title} v${d.version} ${d.author || "未署名"} 更新 ${d.updatedAt.slice(0, 10)}`).join("\n")}`);
    }

    const items: Array<{
      id: string;
      projectId: string;
      currentRevisionId: string;
      category: string;
      title: string;
      status: string;
      version: string;
      author: string;
      updatedAt: string;
      contentStart: number;
      contentEnd: number;
      contentLength: number;
      contentComplete: boolean;
      content: string;
    }> = [];
    let nextOffset = Math.min(offset, docs.length);
    let nextContentOffset = contentOffset;
    let remainingChars = maxContentChars;
    const documentLimit = Math.min(limit, 20);
    const responseCharLimit = 20_000;
    const buildPayload = (pageItems: typeof items, cursorOffset: number, cursorContentOffset: number) => ({
      total: docs.length,
      offset,
      contentOffset,
      count: pageItems.length,
      maxContentChars,
      returnedContentChars: pageItems.reduce((sum, item) => sum + item.content.length, 0),
      responseCharLimit,
      nextOffset: cursorOffset,
      nextContentOffset: cursorContentOffset,
      hasMore: cursorOffset < docs.length,
      items: pageItems,
    });

    while (nextOffset < docs.length && items.length < documentLimit && remainingChars > 0) {
      const doc = docs[nextOffset];
      const start = Math.min(nextContentOffset, doc.content.length);
      const requestedLength = Math.min(remainingChars, doc.content.length - start);
      const makeItem = (length: number) => {
        const content = doc.content.slice(start, start + length);
        const end = start + content.length;
        return {
          id: doc.id,
          projectId: doc.projectId,
          currentRevisionId: doc.currentRevisionId,
          category: doc.category,
          title: doc.title,
          status: doc.status,
          version: doc.version,
          author: doc.author,
          updatedAt: doc.updatedAt,
          contentStart: start,
          contentEnd: end,
          contentLength: doc.content.length,
          contentComplete: end >= doc.content.length,
          content,
        };
      };
      const fits = (length: number) => {
        const candidate = makeItem(length);
        const candidateOffset = candidate.contentComplete ? nextOffset + 1 : nextOffset;
        const candidateContentOffset = candidate.contentComplete ? 0 : candidate.contentEnd;
        return JSON.stringify(buildPayload([...items, candidate], candidateOffset, candidateContentOffset)).length <= responseCharLimit;
      };
      let acceptedLength = requestedLength;
      if (!fits(acceptedLength)) {
        let low = 0;
        let high = acceptedLength;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle - 1;
        }
        acceptedLength = low;
      }
      if (acceptedLength === 0 && requestedLength > 0 && items.length > 0) break;

      const item = makeItem(acceptedLength);
      items.push(item);
      const { content, contentComplete, contentEnd: end } = item;
      remainingChars -= content.length;
      if (!contentComplete) {
        nextContentOffset = end;
        break;
      }
      nextOffset += 1;
      nextContentOffset = 0;
    }

    return toolText(JSON.stringify(buildPayload(items, nextOffset, nextContentOffset)));
  });

  server.registerTool("get_design_doc", {
    title: "按 ID 读取设计文档版本",
    description: "按项目、文档 ID 和可选版本 ID 精确读取设计文档正文。用于任务包已给出文档标识后的分页续读，不需要遍历文档列表。",
    inputSchema: {
      projectRef: z.string().min(1).describe("项目 code 或 id"),
      documentId: z.string().min(1).describe("设计文档 ID"),
      revisionId: z.string().min(1).optional().describe("任务包固定的文档版本 ID；省略时读取当前版本"),
      contentOffset: z.number().int().min(0).default(0),
      maxContentChars: z.number().int().min(1000).max(12000).default(8000),
    },
  }, ({ projectRef, documentId, revisionId, contentOffset, maxContentChars }) => {
    const project = byRef(store, projectRef);
    if (!project) return { ...toolText(`PROJECT_NOT_FOUND: 未找到项目: ${projectRef}`), isError: true };
    const document = store.getDesignDoc(documentId);
    if (!document || document.projectId !== project.id) {
      return { ...toolText(`DOCUMENT_NOT_FOUND: 文档不存在或不属于项目 ${project.code}`), isError: true };
    }
    const revision = store.getDocumentRevision(revisionId || document.currentRevisionId);
    if (!revision || revision.documentId !== document.id || revision.projectId !== project.id) {
      return { ...toolText("DOCUMENT_REVISION_NOT_FOUND: 文档版本不存在或不属于该文档"), isError: true };
    }
    const start = Math.min(contentOffset, revision.content.length);
    const content = revision.content.slice(start, start + maxContentChars);
    const nextContentOffset = start + content.length < revision.content.length ? start + content.length : null;
    return toolText(JSON.stringify({
      id: document.id,
      projectId: project.id,
      revisionId: revision.id,
      currentRevisionId: document.currentRevisionId,
      category: revision.category,
      title: revision.title,
      summary: revision.summary,
      status: revision.status,
      version: revision.version,
      author: revision.author,
      createdAt: revision.createdAt,
      contentOffset: start,
      contentLength: revision.content.length,
      nextContentOffset,
      hasMore: nextContentOffset !== null,
      content,
    }, null, 2));
  });

  server.registerTool("create_design_doc", {
    title: "新建设计文档",
    description: "在某项目新增一篇设计文档。",
    inputSchema: {
      projectRef: z.string().min(1),
      title: z.string().min(1).max(300),
      targetType: z.enum(["project", "diagram", "diagramNode", "plan", "databaseModel", "evidence", "governance"]).optional(),
      targetId: z.string().min(1).optional(),
      relationType: z.enum(["defines", "implements", "verifies", "references"]).default("references"),
      category: z.enum(["需求文档", "功能说明", "接口文档", "测试报告", "验收文档", "其他"]).default("其他"),
      summary: z.string().max(2000).optional(),
      status: z.enum(["草拟", "评审中", "已批准", "已废弃"]).default("草拟"),
      version: z.string().max(64).default("v0.1"),
      author: z.string().max(100).optional(),
      sourceUrl: z.string().max(2000).optional(),
      content: z.string().max(100000).optional(),
    },
  }, (args) => {
    const project = byRef(store, args.projectRef);
    if (!project) return toolText(`未找到项目: ${args.projectRef}`);
    if (Boolean(args.targetType) !== Boolean(args.targetId)) return toolText("targetType 与 targetId 必须同时提供");
    if (args.targetType && args.targetId) {
      const targetError = validateDocumentReferenceTarget(store, project.id, args.targetType, args.targetId);
      if (targetError) return toolText(targetError);
    }
    const doc = store.insertDesignDoc({ projectId: project.id, category: args.category ?? "其他", title: args.title, summary: args.summary ?? "", status: args.status as never, version: args.version, author: args.author ?? "", content: args.content ?? "", sourceUrl: args.sourceUrl ?? "" });
    if (args.targetType && args.targetId) store.insertDocumentReference({ projectId: project.id, documentId: doc.id, targetType: args.targetType, targetId: args.targetId, relationType: args.relationType });
    store.recordAudit({ projectId: project.id, entityType: "designDoc", entityId: doc.id, action: "create", before: null, after: { title: doc.title, status: doc.status }, actor: "mcp-client", source: "mcp" });
    return toolText(`已新建设计文档「${doc.title}」(${doc.status}) id=${doc.id}`);
  });

  server.registerTool("list_governance", {
    title: "列出治理记录",
    description: "列出某项目（或全部）的治理决策/意见。",
    inputSchema: { projectRef: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = projectRef ? byRef(store, projectRef) : undefined;
    if (projectRef && !project) return toolText(`未找到项目: ${projectRef}`);
    const page = pageOf(store.listGovernance(project?.id), offset, limit);
    return toolText(`共 ${page.total} 条治理记录，本页 ${page.count} 条\n${page.items.map((r) => `- id=${r.id} [${r.type === "decision" ? "决策" : "意见"}/${r.status}] ${r.title}（${project?.name ?? r.projectId.slice(0, 8)}）`).join("\n")}`);
  });

  server.registerTool("create_governance", {
    title: "新增治理记录",
    description: "在某项目新增一条决策/意见。",
    inputSchema: {
      projectRef: z.string().min(1),
      type: z.enum(["decision", "opinion"]).default("decision"),
      title: z.string().min(1).max(300),
      content: z.string().max(8000).optional(),
      rationale: z.string().max(4000).optional(),
      status: z.enum(["有效", "待确认", "已替代"]).default("有效"),
      author: z.string().max(100).optional(),
    },
  }, (args) => {
    const project = byRef(store, args.projectRef);
    if (!project) return toolText(`未找到项目: ${args.projectRef}`);
    const record = store.insertGovernance({ projectId: project.id, type: args.type as never, title: args.title, content: args.content ?? "", rationale: args.rationale ?? "", status: args.status, author: args.author ?? "" });
    store.recordAudit({ projectId: project.id, entityType: "governance", entityId: record.id, action: "create", before: null, after: { title: record.title, type: record.type }, actor: "mcp-client", source: "mcp" });
    return toolText(`已新增${record.type === "decision" ? "决策" : "意见"}「${record.title}」 id=${record.id}`);
  });

  server.registerTool("list_diagrams", {
    title: "列出画布",
    description: "列出某项目（或全部）的画布及节点/连线数。",
    inputSchema: { projectRef: z.string().optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, offset, limit }) => {
    const project = projectRef ? byRef(store, projectRef) : undefined;
    if (projectRef && !project) return toolText(`未找到项目: ${projectRef}`);
    const page = pageOf(store.listDiagrams(project?.id), offset, limit);
    return toolText(`共 ${page.total} 个画布，本页 ${page.count} 个\n${page.items.map((d) => `- id=${d.id} ${d.title}（${d.nodes.length} 节点 / ${d.edges.length} 连线）项目=${project?.name ?? d.projectId.slice(0, 8)} 更新 ${d.updatedAt.slice(0, 10)}`).join("\n")}`);
  });

  server.registerTool("get_diagram", {
    title: "查询画布详情",
    description: "返回画布的节点与连线清单（含标签/形状）。",
    inputSchema: { diagramId: z.string().min(1) },
  }, ({ diagramId }) => {
    const diagram = store.getDiagram(diagramId);
    if (!diagram) return toolText(`未找到画布: ${diagramId}`);
    return toolText([
      `${diagram.title}`,
      `节点 ${diagram.nodes.length} / 连线 ${diagram.edges.length} / 分组 ${diagram.groups.length}`,
      "", "节点:", ...diagram.nodes.map((n) => `- id=${n.id} [${n.kind}${n.shape ? "/" + n.shape : ""}] ${n.label}`),
      "", "连线:", ...diagram.edges.map((e) => `- id=${e.id} ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}`),
    ].join("\n"));
  });

  server.registerTool("collect_git_evidence", {
    title: "采集 Git 证据",
    description: "对项目 repositoryPath 执行只读 git 采集（分支、最新提交、脏文件数）。",
    inputSchema: { projectRef: z.string().min(1).describe("项目 code 或 id") },
  }, async ({ projectRef }) => {
    const project = byRef(store, projectRef);
    if (!project) return toolText(`未找到项目: ${projectRef}`);
    if (!project.repositoryPath) return toolText("该项目未设置 repositoryPath");
    const collected = await collectGitEvidence(project.repositoryPath);
    const evidence = store.insertEvidence({ ...collected, projectId: project.id, nodeId: null, collectedAt: nowIso() });
    store.recordAudit({ projectId: project.id, entityType: "evidence", entityId: evidence.id, action: "collect", before: null, after: { sourceType: evidence.sourceType, summary: evidence.summary.slice(0, 120) }, actor: "mcp-client", source: "mcp" });
    return toolText(`[${evidence.resultStatus}] ${evidence.summary}`);
  });

  server.registerTool("dashboard", {
    title: "控制台总览",
    description: "返回项目总数、阶段/健康分布、需关注项目、逾期计划项等概览。",
    inputSchema: {},
  }, () => {
    const dash = store.dashboard(listProjectedProjects(store));
    const lines = [
      `项目 ${dash.totals.projects} | 进行中 ${dash.totals.activeProjects} | 需关注 ${dash.totals.attention} | 逾期计划 ${dash.totals.overduePlans}`,
      "阶段分布:", ...Object.entries(dash.byStage).map(([k, v]) => `- ${k}: ${v}`),
      "健康分布:", ...Object.entries(dash.byHealth).map(([k, v]) => `- ${k}: ${v}`),
    ];
    if (dash.attentionProjects.length) lines.push("需关注:", ...dash.attentionProjects.map((p) => `- ${p.name} [${p.health}] ${p.blockerSummary || p.riskSummary}`));
    return toolText(lines.join("\n"));
  });

  server.registerTool("search", {
    title: "全局搜索",
    description: "在项目、工作节点、设计文档、治理记录中搜索关键字。",
    inputSchema: { q: z.string().min(1) },
  }, ({ q }) => {
    const kw = q.trim().toLowerCase();
    const lines: string[] = [];
    for (const p of store.listProjects()) {
      if (`${p.name} ${p.code} ${p.summary}`.toLowerCase().includes(kw)) lines.push(`项目: ${p.name} (${p.code})`);
      for (const n of store.listNodes(p.id)) if (n.title.toLowerCase().includes(kw)) lines.push(`  节点: ${n.title} @ ${p.name}`);
      for (const d of store.listDesignDocs(p.id)) if (d.title.toLowerCase().includes(kw)) lines.push(`  设计文档: ${d.title} @ ${p.name}`);
    }
    for (const g of store.listGovernance()) if (g.title.toLowerCase().includes(kw)) lines.push(`治理: ${g.title}`);
    return toolText(lines.length ? lines.join("\n") : "无匹配结果");
  });

  registerFullTools(server, { store, dataDir, harness, trustedInternal: options.trustedInternal });
  registerDatabaseTools(server, store);

  return server;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const dbPath = process.env.PCS_DB ?? resolve("data/control-surface.db");
    const dataDir = process.env.PCS_DATA_DIR ?? dirname(dbPath);
    const store = createStore(dbPath);
    syncManagedProjectStorage(store, dataDir);
    serveStdio(() => createMcpServer({ store, dbPath, dataDir }));
    console.error("[pcs-mcp] stdio 服务已启动（等待 MCP 客户端连接）");
  } catch (error) {
    console.error("[pcs-mcp] 启动失败:", error);
    process.exit(1);
  }
}

