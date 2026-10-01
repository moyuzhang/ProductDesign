import { designContractSchema, requirementsBaselineSchema } from "../shared/designContract.js";
import { DesignContractError, validateProjectDesignContract } from "../server/designContractValidation.js";
import { DesignChangeCorrectionError } from "../server/designChangeCorrection.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DESIGN_DOC_CATEGORIES,
  DESIGN_DOC_STATUSES,
  DOCUMENT_REFERENCE_RELATION_TYPES,
  DOCUMENT_REFERENCE_TARGET_TYPES,
  DESIGN_STATUSES,
  DEVELOPMENT_STATUSES,
  DIAGRAM_TYPES,
  HEALTH_LEVELS,
  LLM_REASONING_EFFORTS,
  LLM_PROTOCOLS,
  NODE_KINDS,
  PLAN_AGENT_ROLES,
  PLAN_KINDS,
  PLAN_STATUSES,
  PRIORITIES,
  PROJECT_STAGES,
  REQUIREMENT_STATUSES,
  TEST_STATUSES,
  type Diagram,
  type DiagramNode,
  type PlanItem,
  type Project,
  type WorkNode,
} from "../shared/types.js";
import { roleAssignmentErrors } from "../shared/planRoles.js";
import { layoutDiagram } from "../shared/diagramLayout.js";
import { assertNoIntroducedDiagramGroupOverlap } from "../shared/diagramGroups.js";
import { createBackupFile, loadBackupFile } from "../server/backups.js";
import { collectGitEvidence } from "../server/collectors.js";
import { newId, nowIso, ProjectRepositoryError, type Store } from "../server/db.js";
import { validateDiagramDeliveryTransition, validateDocumentNodeBinding, validateDocumentReferenceTarget } from "../server/domain.js";
import { ensureManagedProjectDirectory } from "../server/projectFiles.js";
import { isInitialProjectBriefApproval } from "../server/projectBrief.js";
import { hasRequirementChangeMarker } from "../server/nodeRequirementRevision.js";
import { checkLlmProfile, llmProfileSummary } from "../server/llmProfiles.js";
import { agentProfileProblem, CodexHarness } from "../server/agentHarness.js";
import { PLAN_TRANSITION_ACTIONS, transitionPlanLifecycle } from "../server/planLifecycle.js";
import { assertEvidenceIdentity } from "../server/planRolePolicy.js";
import { DISPLAY_TIME_ZONE, formatInstantAsShanghaiIso } from "../shared/time.js";
import {
  AgentTaskLeaseError,
  advanceAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForWrite,
} from "../server/agentTaskLeases.js";
import { validatePlanLayerGraph } from "../server/planLayers.js";
import { decideDependencyEdit } from "../server/planPolicy.js";
import { getProjectedProjectWorkspace } from "../server/projectProjection.js";
import { DesignChangeError, dismissDesignChangeIntent, requestDesignChange } from "../server/designChange.js";
import { DesignChangeIntentError, submitDesignChangeIntent } from "../server/designChangeIntent.js";
import { EvidenceRepairAssessmentError, requestEvidenceRepairAssessment } from "../server/evidenceRepair.js";
import { AgentSecurityError } from "../server/agentSecurity.js";
import { assertCoordinationLeaseForPlan, CoordinationLeaseError, recoverCoordinationLeaseAfterRejectedTransaction } from "../server/coordinationLeases.js";
import { leaseWriteContextSchema } from "./agentWriteSchema.js";
import {
  alignDiagramNodes,
  applyDiagramOperations,
  assertDiagramStructure,
  buildDiagramTemplate,
  diagramEdgeSchema,
  diagramGroupSchema,
  diagramNodeSchema,
  diagramOperationSchema,
  duplicateDiagramNodes,
  exportDiagram,
  validateDiagram,
} from "./diagram.js";
import { registerWhiteboardTools } from "./whiteboard.js";

export interface FullToolOptions {
  store: Store;
  dataDir: string;
  harness: CodexHarness;
  trustedInternal?: boolean;
}

export function createServiceHealthPayload(databaseOpen: boolean, time = nowIso()): {
  ok: true;
  service: string;
  time: string;
  localTime: string;
  timeZone: string;
  databaseOpen: boolean;
} {
  return {
    ok: true,
    service: "product-design-control-surface",
    time,
    localTime: formatInstantAsShanghaiIso(time),
    timeZone: DISPLAY_TIME_ZONE,
    databaseOpen,
  };
}

function result(data: unknown, message?: string) {
  const payload = JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: message ? `${message}\n${payload}` : payload }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
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

function projectByRef(store: Store, projectRef: string): Project | undefined {
  return store.getProject(projectRef) ?? store.listProjects().find((project) => project.code.toLowerCase() === projectRef.toLowerCase());
}

function recordAudit(
  store: Store,
  actor: string | undefined,
  event: { projectId: string | null; entityType: string; entityId: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; correlationId?: string; clientId?: string; sessionId?: string; model?: string },
): void {
  const normalizedActor = actor?.trim() || "mcp-client";
  const inferredSessionId = normalizedActor.startsWith("agent:") ? normalizedActor.slice("agent:".length) : "";
  store.recordAudit({
    ...event,
    actor: normalizedActor,
    source: "mcp",
    sessionId: event.sessionId || inferredSessionId || undefined,
    clientId: event.clientId || (inferredSessionId ? "productdesign-agent-harness" : "external-mcp"),
  });
}

function projectSummary(project: Project): Record<string, unknown> {
  return { id: project.id, code: project.code, name: project.name, stage: project.stage, health: project.health, progress: project.progress, repositoryPath: project.repositoryPath, externalRepositoryId: project.externalRepositoryId ?? "" };
}

function diagramSummary(diagram: Diagram): Record<string, unknown> {
  return { title: diagram.title, type: diagram.type, nodes: diagram.nodes.length, edges: diagram.edges.length, groups: diagram.groups.length, updatedAt: diagram.updatedAt };
}

function validateDiagramLinks(store: Store, diagram: Diagram): string | undefined {
  for (const node of diagram.nodes) {
    const links = nodeLinkIds(node);
    for (const childId of links) {
      const target = store.getDiagram(childId);
      if (!target) return `节点“${node.label}”关联的子画布不存在: ${childId}`;
      if (target.projectId !== diagram.projectId) return `节点“${node.label}”不能关联其他项目的画布`;
      if (target.id === diagram.id) return `节点“${node.label}”不能关联当前画布自身`;
    }
  }
  return undefined;
}

/** Collect the sub-canvas links of a node, accepting both the new `linkDiagramIds` array and the legacy single `linkDiagramId`. */
function nodeLinkIds(node: DiagramNode): string[] {
  const legacy = (node as DiagramNode & { linkDiagramId?: string }).linkDiagramId;
  return Array.isArray(node.linkDiagramIds) ? node.linkDiagramIds : legacy ? [legacy] : [];
}

function validatePlanBinding(store: Store, projectId: string, diagramId: string | null, diagramNodeId: string | null): string | undefined {
  if (!diagramId && !diagramNodeId) return undefined;
  if (!diagramId || !diagramNodeId) return "画布计划必须同时提供 diagramId 和 diagramNodeId";
  const diagram = store.getDiagram(diagramId);
  if (!diagram || diagram.projectId !== projectId) return "绑定的画布不存在或不属于当前项目";
  if (!diagram.nodes.some((node) => node.id === diagramNodeId)) return "绑定的画布节点不存在";
  return undefined;
}

function validatePlanReferences(store: Store, projectId: string, planId: string | undefined, parentId: string | null, dependencyIds: string[]): string | undefined {
  if (parentId) {
    const parent = store.getPlan(parentId);
    if (!parent || parent.projectId !== projectId) return "父计划项不存在或不属于当前项目";
    if (parent.id === planId) return "计划项不能把自己设为父级";
  }
  for (const dependencyId of dependencyIds) {
    const dependency = store.getPlan(dependencyId);
    if (!dependency || dependency.projectId !== projectId) return `依赖计划项不存在或不属于当前项目: ${dependencyId}`;
    if (dependency.id === planId) return "计划项不能依赖自己";
  }
  if (planId) {
    const before = store.getPlan(planId);
    if (before) {
      const candidate = { ...before, parentId, dependencyIds };
      const graphIssue = validatePlanLayerGraph(store.listPlans(projectId).map((plan) => plan.id === planId ? candidate : plan));
      if (graphIssue) return graphIssue;
    }
  }
  return undefined;
}

function saveDiagramChange(store: Store, before: Diagram, after: Diagram, actor: string | undefined, action: string): Diagram {
  assertNoIntroducedDiagramGroupOverlap(before, after);
  const transitionError = validateDiagramDeliveryTransition(store, before, after);
  if (transitionError) throw new Error(transitionError);
  const updated = store.updateDiagram(before.id, {
    title: after.title,
    type: after.type,
    nodes: after.nodes,
    edges: after.edges,
    groups: after.groups,
  });
  if (!updated) throw new Error(`画布不存在: ${before.id}`);
  store.recordDiagramRevision(before.id, before, updated, actor?.trim() || "mcp-client");
  recordAudit(store, actor, {
    projectId: before.projectId,
    entityType: "diagram",
    entityId: before.id,
    action,
    before: diagramSummary(before),
    after: diagramSummary(updated),
  });
  return updated;
}

function ensureExpectedRevision(diagram: Diagram, expectedUpdatedAt: string | undefined): string | undefined {
  if (expectedUpdatedAt && expectedUpdatedAt !== diagram.updatedAt) return `画布已被其他操作修改；当前 updatedAt=${diagram.updatedAt}`;
  return undefined;
}

function createBackup(store: Store, dataDir: string, label: string, reason: string, actor?: string) {
  const backup = createBackupFile(store, dataDir, label, reason);
  recordAudit(store, actor, { projectId: null, entityType: "backup", entityId: backup.id, action: "create", before: null, after: { label, itemCount: backup.itemCount } });
  return backup;
}

export function registerFullTools(server: McpServer, options: FullToolOptions): void {
  const { store, dataDir, harness } = options;

  // 图层、组件与模板工具（设计第 7 节）：与 REST 端点共用 src/server/whiteboard.ts 服务层。
  registerWhiteboardTools(server, { store, dataDir });

  server.registerTool("validate_design_contract", {
    title: "检查需求覆盖和设计一致性",
    description: "只读检查明确引用的结构化需求基线和设计合同。服务端核对实际计划/节点/版本、逐条验收标准覆盖、接口方法路径和分阶段依赖环。unassessed 表示没有结构化基线，绝不表示通过；valid 仅表示已声明结构一致，不代替用户批准或真实测试。可返回 artifactSchemas 供通过 create_design_doc 创建草稿；基线和合同必须独立批准后才能进入正式交付。",
    inputSchema: { projectRef: z.string().min(1), planId: z.string().min(1).optional(), includeSchemas: z.boolean().default(true) },
  }, ({ projectRef, planId, includeSchemas }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error("项目不存在");
    if (planId && store.getPlan(planId)?.projectId !== project.id) return error("计划不存在或不属于当前项目");
    const report = validateProjectDesignContract(store, project.id, planId);
    return result({ ...report, ...(includeSchemas ? { artifactSchemas: {
      baseline: z.toJSONSchema(requirementsBaselineSchema), contract: z.toJSONSchema(designContractSchema),
    } } : {}) });
  });

  server.registerTool("service_health", {
    title: "服务健康检查",
    description: "确认 ProductDesign MCP 与数据库可用。",
    inputSchema: {},
  }, () => result(createServiceHealthPayload(store.db.open)));

  server.registerTool("list_llm_profiles", {
    title: "列出 LLM 配置",
    description: "列出系统级 LLM 供应商、协议、模型和凭据就绪状态；不会返回密钥值。",
    inputSchema: {},
  }, () => result(store.listLlmProfiles()));

  server.registerTool("create_llm_profile", {
    title: "创建 LLM 配置",
    description: "创建系统级 LLM 配置，可直接传入 apiKey；密钥加密存储，接口与审计永不返回明文。",
    inputSchema: {
      name: z.string().trim().min(1).max(120), provider: z.string().trim().min(1).max(120),
      protocol: z.enum(LLM_PROTOCOLS), baseUrl: z.string().url().max(1000),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(120),
      apiKey: z.string().trim().max(2000).optional(),
      models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
      defaultModel: z.string().trim().min(1).max(200), enabled: z.boolean().default(true),
      reasoningEffort: z.enum(LLM_REASONING_EFFORTS).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    if (!args.models.includes(args.defaultModel)) return error("默认模型必须包含在模型列表中");
    if (store.listLlmProfiles().some((item) => item.name.toLocaleLowerCase() === args.name.toLocaleLowerCase())) return error("已存在同名 LLM 配置");
    const { actor, ...input } = args;
    const profile = store.insertLlmProfile({ ...input, models: [...new Set(input.models)] });
    recordAudit(store, actor, { projectId: null, entityType: "llmProfile", entityId: profile.id, action: "create", before: null, after: llmProfileSummary(profile) });
    return result(profile, "LLM 配置已创建；API Key 已加密保存且不会返回明文");
  });

  server.registerTool("update_llm_profile", {
    title: "更新 LLM 配置",
    description: "更新供应商、协议、服务地址、模型、API Key、凭据环境变量回退或启用状态；API Key 加密保存且不会返回明文。",
    inputSchema: {
      profileId: z.string().min(1), name: z.string().trim().min(1).max(120).optional(), provider: z.string().trim().min(1).max(120).optional(),
      protocol: z.enum(LLM_PROTOCOLS).optional(), baseUrl: z.string().url().max(1000).optional(),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(120).optional(),
      apiKey: z.string().trim().max(2000).optional(),
      models: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(), defaultModel: z.string().trim().min(1).max(200).optional(),
      enabled: z.boolean().optional(), reasoningEffort: z.enum(LLM_REASONING_EFFORTS).optional(),
      timeoutMs: z.number().int().min(1000).max(120000).optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const before = store.getLlmProfile(args.profileId);
    if (!before) return error(`LLM 配置不存在: ${args.profileId}`);
    const { profileId, actor, ...rawPatch } = args;
    const patch = rawPatch.models ? { ...rawPatch, models: [...new Set(rawPatch.models)] } : rawPatch;
    const next = { ...before, ...patch };
    if (!next.models.includes(next.defaultModel)) return error("默认模型必须包含在模型列表中");
    if (store.listLlmProfiles().some((item) => item.id !== profileId && item.name.toLocaleLowerCase() === next.name.toLocaleLowerCase())) return error("已存在同名 LLM 配置");
    const updated = store.updateLlmProfile(profileId, patch);
    recordAudit(store, actor, { projectId: null, entityType: "llmProfile", entityId: profileId, action: "update", before: llmProfileSummary(before), after: updated ? llmProfileSummary(updated) : null });
    return result(updated, "LLM 配置已更新");
  });

  server.registerTool("test_llm_profile", {
    title: "测试 LLM 配置",
    description: "使用已加密保存的 API Key或环境变量回退发起一次最小模型调用，校验协议、模型、凭据并返回连通性与延迟。",
    inputSchema: { profileId: z.string().min(1), actor: z.string().max(100).optional() },
  }, async ({ profileId, actor }) => {
    const profile = store.getLlmProfile(profileId);
    if (!profile) return error(`LLM 配置不存在: ${profileId}`);
    const checked = await checkLlmProfile(profile, store.resolveLlmKey(profile));
    recordAudit(store, actor, { projectId: null, entityType: "llmProfile", entityId: profileId, action: "test_connection", before: null, after: { ok: checked.ok, status: checked.status, latencyMs: checked.latencyMs } });
    return result(checked);
  });

  server.registerTool("delete_llm_profile", {
    title: "删除 LLM 配置",
    description: "删除一个系统级 LLM 配置。必须显式确认。",
    inputSchema: { profileId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ profileId, confirm, actor }) => {
    if (!confirm) return error("删除 LLM 配置需要 confirm=true");
    const before = store.getLlmProfile(profileId);
    if (!before) return error(`LLM 配置不存在: ${profileId}`);
    store.deleteLlmProfile(profileId);
    recordAudit(store, actor, { projectId: null, entityType: "llmProfile", entityId: profileId, action: "delete", before: llmProfileSummary(before), after: null });
    return result({ ok: true, deleted: before.name });
  });

  server.registerTool("get_agent_workspace", {
    title: "获取项目 Agent 工作台",
    description: "返回指定项目的 Agent 工作台、默认 LLM 配置与会话列表。",
    inputSchema: { projectRef: z.string().min(1) },
  }, ({ projectRef }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    return result(store.getAgentWorkspaceSnapshot(project.id));
  });

  server.registerTool("set_agent_workspace_profile", {
    title: "设置项目 Agent 默认 LLM",
    description: "设置项目工作台新会话默认使用的 LLM 配置。不会改变已有会话。",
    inputSchema: { projectRef: z.string().min(1), profileId: z.string().nullable(), actor: z.string().max(100).optional() },
  }, ({ projectRef, profileId, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    if (profileId && !store.getLlmProfile(profileId)) return error(`LLM 配置不存在: ${profileId}`);
    const before = store.getAgentWorkspace(project.id) ?? null;
    const workspace = store.updateAgentWorkspace(project.id, profileId)!;
    recordAudit(store, actor, {
      projectId: project.id, entityType: "agentWorkspace", entityId: workspace.id, action: "update",
      before: before ? { defaultProfileId: before.defaultProfileId } : null,
      after: { defaultProfileId: workspace.defaultProfileId },
    });
    return result(workspace);
  });

  server.registerTool("list_agent_sessions", {
    title: "列出项目 Agent 会话",
    description: "列出项目工作台中的持久化 Agent 会话。",
    inputSchema: { projectRef: z.string().min(1) },
  }, ({ projectRef }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    return result(store.listAgentSessions(project.id));
  });

  server.registerTool("create_agent_session", {
    title: "创建项目 Agent 会话",
    description: "创建固定绑定项目、LLM 配置和模型的 Agent 会话。",
    inputSchema: {
      projectRef: z.string().min(1), profileId: z.string().min(1), model: z.string().min(1).max(200),
      title: z.string().trim().min(1).max(160).default("新会话"), actor: z.string().max(100).optional(),
    },
  }, ({ projectRef, profileId, model, title, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    const profile = store.getLlmProfile(profileId);
    if (!profile) return error(`LLM 配置不存在: ${profileId}`);
    if (!profile.models.includes(model)) return error("所选模型不在该 LLM 配置的模型列表中");
    const session = store.insertAgentSession({ projectId: project.id, profileId, model, title });
    const workspace = store.getAgentWorkspace(project.id)!;
    if (!workspace.defaultProfileId) store.updateAgentWorkspace(project.id, profileId);
    recordAudit(store, actor, {
      projectId: project.id, entityType: "agentSession", entityId: session.id, action: "create",
      before: null, after: { profileId, model, title },
    });
    return result(session);
  });

  server.registerTool("list_agent_messages", {
    title: "列出 Agent 会话消息",
    description: "按时间顺序返回 Agent 会话中的用户、Agent 和系统消息。",
    inputSchema: { sessionId: z.string().min(1) },
  }, ({ sessionId }) => {
    if (!store.getAgentSession(sessionId)) return error(`Agent 会话不存在: ${sessionId}`);
    return result(store.listAgentMessages(sessionId));
  });

  server.registerTool("send_agent_message", {
    title: "发送项目 Agent 消息",
    description: "通过 Codex app-server 执行一轮项目 Agent 会话；需要审批的操作会被拒绝，不会自动批准。",
    inputSchema: {
      sessionId: z.string().min(1), content: z.string().trim().min(1).max(20000),
      pageRoute: z.string().max(1000).optional(), pageTitle: z.string().max(300).optional(), actor: z.string().max(100).optional(),
    },
  }, async ({ sessionId, content, pageRoute, pageTitle, actor }) => {
    const session = store.getAgentSession(sessionId);
    if (!session) return error(`Agent 会话不存在: ${sessionId}`);
    if (session.status === "running" || harness.isRunning(sessionId)) return error("当前会话已有运行中的消息");
    const profile = store.getLlmProfile(session.profileId);
    const problem = agentProfileProblem(profile);
    if (problem) return error(problem);
    const pageContext = pageRoute ? {
      contextId: `mcp:${newId()}`,
      projectId: session.projectId,
      route: pageRoute,
      title: pageTitle || "ProductDesign",
      pageType: "unknown" as const,
      entityRefs: [],
      selection: { entityRefs: [] },
      draft: null,
      visibleContent: null,
      capturedAt: nowIso(),
    } : null;
    const userMessage = store.insertAgentMessage({ sessionId, projectId: session.projectId, role: "user", content, status: "completed", pageContext });
    const assistantMessage = store.insertAgentMessage({ sessionId, projectId: session.projectId, role: "assistant", content: "", status: "queued", pageContext: null });
    if (session.title === "新会话") store.updateAgentSession(sessionId, { title: content.slice(0, 32) });
    const prompt = pageContext ? `${content}\n\n[AG-UI STATE_SNAPSHOT：当前前端上下文]\n${JSON.stringify(pageContext, null, 2)}` : content;
    recordAudit(store, actor, {
      projectId: session.projectId, entityType: "agentMessage", entityId: userMessage.id, action: "send",
      before: null, after: { sessionId, pageContextIncluded: Boolean(pageContext) },
    });
    try {
      const completed = await harness.runTurn(sessionId, assistantMessage.id, prompt);
      return result(completed);
    } catch (runError) {
      return error(runError instanceof Error ? runError.message : String(runError));
    }
  });

  server.registerTool("delete_agent_session", {
    title: "删除项目 Agent 会话",
    description: "删除一个 Agent 会话及其消息历史；运行中的会话会先被取消并等待清理。必须显式确认。",
    inputSchema: { sessionId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, async ({ sessionId, confirm, actor }) => {
    if (!confirm) return error("删除 Agent 会话需要 confirm=true");
    const session = store.getAgentSession(sessionId);
    if (!session) return error(`Agent 会话不存在: ${sessionId}`);
    try {
      const cancelled = await harness.cancelRun(sessionId);
      store.deleteAgentSession(sessionId);
      recordAudit(store, actor, {
        projectId: session.projectId, entityType: "agentSession", entityId: session.id, action: "delete",
        before: { title: session.title, profileId: session.profileId, model: session.model, cancelled }, after: null,
      });
      return result({ ok: true, deleted: session.title, cancelled });
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  });

  server.registerTool("get_control_capabilities", {
    title: "查询 MCP 控制能力",
    description: "返回当前 MCP 已覆盖的全部业务领域和画布动作。",
    inputSchema: {},
  }, () => result({
    coverage: "all_persisted_product_functions",
    domains: {
      projects: ["list", "get", "workspace", "workspaceNodes", "create", "update", "delete", "managedFiles"],
      workflow: ["get", "nextAction", "validate", "enforcedOnDiagramTransitions", "agentOrchestrationBlueprint"],
      workNodes: ["list", "create", "update", "delete"],
      plans: ["list", "create", "update", "delete", "bindDiagramNode", "dependencies"],
      evidence: ["list", "create", "collectGit", "revoke", "acceptedPlanRepair", "strictImplementationPolicy"],
      governance: ["list", "create", "update", "delete"],
      designChanges: ["request", "atomicCascade", "idempotency", "leaseInvalidation"],
      llmProfiles: ["list", "create", "update", "delete", "testConnection"],
      agentWorkbench: ["getWorkspace", "setDefaultProfile", "listSessions", "createSession", "listMessages", "sendMessage", "deleteSession", "openDiagramInOriginPage"],
      agentDispatch: ["workerPools", "claimNextAtomically", "uniqueWorkerIdentity", "resourceScopeLocks", "workspaceReservations", "leaseHeartbeatAndExpiry", "repairGenerationReset", "credentialUnavailableReassignment"],
      designDocs: ["list", "readContentPaginated", "create", "update", "delete", "listReferences", "createReference", "refreshReference", "deleteReference"],
      diagrams: ["list", "get", "create", "update", "delete", "batchMutate", "layout", "align", "distribute", "group", "duplicate", "extract", "validate", "undo", "redo", "exportJson", "exportSvg", "exportPng", "useCaseDiagram"],
      databaseModels: ["list", "get", "create", "update", "delete", "autoLayout", "validate", "generateDdl", "generateEntities", "checkConnection", "inspectSchema", "reversePreview", "reverseImport", "deployPreview", "deployCreateTables"],
      nodeDatabaseBindings: ["list", "create", "update", "delete"],
      operations: ["dashboard", "search", "audit", "backup", "restoreBackup", "pagination"],
    },
    note: "缩放、平移、选中态等浏览器临时视图状态由浏览器 MCP 控制，不属于持久化业务数据。",
  }));

  server.registerTool("get_project_snapshot", {
    title: "获取项目完整快照",
    description: "返回项目及其节点、计划、证据、文档、治理记录、画布和最近审计，包含所有实体 id。",
    inputSchema: { projectRef: z.string().min(1), auditLimit: z.number().int().min(0).max(1000).default(100) },
  }, ({ projectRef, auditLimit }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    const workspace = getProjectedProjectWorkspace(store, project.id);
    return result({
      project: workspace?.project ?? project,
      workspace,
      workspaceNodes: store.listProjectWorkspaceNodes(project.id),
      legacyWorkNodes: store.listNodes(project.id),
      plans: store.listPlans(project.id),
      evidence: store.listEvidence(project.id),
      governance: store.listGovernance(project.id),
      designDocs: store.listDesignDocs(project.id),
      documentReferences: store.listDocumentReferences({ projectId: project.id }),
      diagrams: store.listDiagrams(project.id),
      databaseModels: store.listDatabaseModels(project.id),
      nodeDatabaseBindings: store.listNodeDatabaseBindings({ projectId: project.id }),
      audit: store.listAudit(auditLimit, project.id),
    });
  });

  server.registerTool("update_project", {
    title: "完整更新项目",
    description: "更新项目所有可编辑字段。externalRepositoryId 是外部 Harness 的不透明仓库标识，不会作为 URL 获取或本地路径扫描；空值保持本地兼容模式。活动租约期间不能更改仓库标识。",
    inputSchema: {
      projectRef: z.string().min(1),
      code: z.string().trim().min(1).max(64).optional(),
      name: z.string().trim().min(1).max(200).optional(),
      summary: z.string().max(2000).optional(),
      stage: z.enum(PROJECT_STAGES).optional(),
      health: z.enum(HEALTH_LEVELS).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      riskLevel: z.enum(PRIORITIES).optional(),
      riskSummary: z.string().max(2000).optional(),
      blockerSummary: z.string().max(2000).optional(),
      nextStep: z.string().max(2000).optional(),
      externalRepositoryId: z.string().trim().max(500).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/@-]*)?$/).optional(),
      startAt: z.string().max(32).optional(),
      dueAt: z.string().max(32).optional(),
      actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    const { projectRef: _projectRef, actor, ...patch } = args;
    if (patch.code && patch.code !== project.code) patch.code = store.uniqueProjectCode(patch.code);
    let updated: Project | undefined;
    try {
      updated = store.updateProject(project.id, patch);
    } catch (cause) {
      if (cause instanceof ProjectRepositoryError) return error(structuredError(cause));
      throw cause;
    }
    if (!updated) return error("项目更新失败");
    ensureManagedProjectDirectory(dataDir, updated);
    recordAudit(store, actor, { projectId: project.id, entityType: "project", entityId: project.id, action: "update", before: projectSummary(project), after: projectSummary(updated) });
    return result(getProjectedProjectWorkspace(store, project.id)?.project ?? updated, "项目已更新；阶段和下一步按工作流唯一门禁派生，健康度和进度按项目工作区汇总");
  });

  server.registerTool("delete_project", {
    title: "删除项目",
    description: "删除项目及其节点、计划、证据、文档、治理记录、画布和画布历史。必须显式确认。",
    inputSchema: { projectRef: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ projectRef, confirm, actor }) => {
    if (!confirm) return error("删除项目需要 confirm=true");
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    store.deleteProject(project.id);
    recordAudit(store, actor, { projectId: null, entityType: "project", entityId: project.id, action: "delete", before: projectSummary(project), after: null });
    return result({ ok: true, deletedProject: projectSummary(project) });
  });

  server.registerTool("create_work_node", {
    title: "新建工作节点",
    description: "创建模块、功能、需求、开发或测试工作节点。",
    inputSchema: {
      projectRef: z.string().min(1), parentId: z.string().nullable().default(null), kind: z.enum(NODE_KINDS),
      title: z.string().trim().min(1).max(300), description: z.string().max(4000).default(""), priority: z.enum(PRIORITIES).default("P2"),
      owner: z.string().max(100).default(""), requirementStatus: z.enum(REQUIREMENT_STATUSES).default("待整理"),
      designStatus: z.enum(DESIGN_STATUSES).default("未开始"), developmentStatus: z.enum(DEVELOPMENT_STATUSES).default("未开始"),
      testStatus: z.enum(TEST_STATUSES).default("未开始"), progress: z.number().int().min(0).max(100).default(0),
      startAt: z.string().max(32).default(""), dueAt: z.string().max(32).default(""), position: z.number().int().optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    if (args.parentId) { const parent = store.getNode(args.parentId); if (!parent || parent.projectId !== project.id) return error("父节点不存在或不属于当前项目"); }
    const { projectRef: _projectRef, actor, ...body } = args;
    const node = store.insertNode({ ...body, projectId: project.id });
    recordAudit(store, actor, { projectId: project.id, entityType: "node", entityId: node.id, action: "create", before: null, after: { title: node.title, kind: node.kind } });
    return result(node, "工作节点已创建");
  });

  server.registerTool("patch_work_node", {
    title: "完整更新工作节点",
    description: "更新工作节点所有可编辑字段。",
    inputSchema: {
      nodeId: z.string().min(1), parentId: z.string().nullable().optional(), kind: z.enum(NODE_KINDS).optional(), title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(4000).optional(), priority: z.enum(PRIORITIES).optional(), owner: z.string().max(100).optional(),
      requirementStatus: z.enum(REQUIREMENT_STATUSES).optional(), designStatus: z.enum(DESIGN_STATUSES).optional(),
      developmentStatus: z.enum(DEVELOPMENT_STATUSES).optional(), testStatus: z.enum(TEST_STATUSES).optional(), progress: z.number().int().min(0).max(100).optional(),
      startAt: z.string().max(32).optional(), dueAt: z.string().max(32).optional(), position: z.number().int().optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const before = store.getNode(args.nodeId);
    if (!before) return error(`未找到工作节点: ${args.nodeId}`);
    if (args.parentId) { const parent = store.getNode(args.parentId); if (!parent || parent.projectId !== before.projectId || parent.id === before.id) return error("父节点无效"); }
    const { nodeId, actor, ...patch } = args;
    const updated = store.updateNode(nodeId, patch as Partial<WorkNode>);
    if (!updated) return error("工作节点更新失败");
    recordAudit(store, actor, { projectId: before.projectId, entityType: "node", entityId: nodeId, action: "update", before: { title: before.title, progress: before.progress }, after: { title: updated.title, progress: updated.progress } });
    return result(updated, "工作节点已更新");
  });

  server.registerTool("delete_work_node", {
    title: "删除工作节点",
    description: "删除工作节点，必须显式确认。",
    inputSchema: { nodeId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ nodeId, confirm, actor }) => {
    if (!confirm) return error("删除工作节点需要 confirm=true");
    const before = store.getNode(nodeId);
    if (!before) return error(`未找到工作节点: ${nodeId}`);
    store.deleteNode(nodeId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "node", entityId: nodeId, action: "delete", before: { title: before.title }, after: null });
    return result({ ok: true, deletedId: nodeId });
  });

  const planRoleAssignmentSchema = z.object({
    agentId: z.string().max(200).default(""),
    displayName: z.string().max(200).default(""),
    poolId: z.string().trim().max(500).optional(),
  });
  const planRoleAssignmentsSchema = z.object({
    designer: planRoleAssignmentSchema.default({ agentId: "", displayName: "" }),
    builder: planRoleAssignmentSchema.default({ agentId: "", displayName: "" }),
    auditor: planRoleAssignmentSchema.default({ agentId: "", displayName: "" }),
  });
  const planRoleAssignmentsDefault = {
    designer: { agentId: "", displayName: "" },
    builder: { agentId: "", displayName: "" },
    auditor: { agentId: "", displayName: "" },
  };

  const planFields = {
    diagramId: z.string().nullable().default(null), diagramNodeId: z.string().nullable().default(null), parentId: z.string().nullable().default(null),
    kind: z.enum(PLAN_KINDS), title: z.string().trim().min(1).max(300), description: z.string().max(4000).default(""),
    status: z.enum(PLAN_STATUSES).default("未开始"), priority: z.enum(PRIORITIES).default("P2"), progress: z.number().int().min(0).max(100).default(0),
    owner: z.string().max(100).default(""), roleAssignments: planRoleAssignmentsSchema.default(planRoleAssignmentsDefault), versionTag: z.string().max(64).default(""), startAt: z.string().max(32).default(""), dueAt: z.string().max(32).default(""),
    dependencyIds: z.array(z.string()).max(500).default([]), blockedReason: z.string().max(2000).default(""), completedAt: z.string().max(64).default(""),
  };

  server.registerTool("create_plan_item_full", {
    title: "完整新建计划项",
    description: "创建目标、里程碑、版本或任务，可绑定画布节点并设置依赖。",
    inputSchema: { projectRef: z.string().min(1), ...planFields, actor: z.string().max(100).optional() },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    const bindingError = validatePlanBinding(store, project.id, args.diagramId, args.diagramNodeId);
    if (bindingError) return error(bindingError);
    const referenceError = validatePlanReferences(store, project.id, undefined, args.parentId, args.dependencyIds);
    if (referenceError) return error(referenceError);
    if (args.diagramId && (args.status !== "未开始" || args.progress !== 0 || args.completedAt)) {
      return error("绑定画布节点的开发计划必须从未开始状态创建，并通过 transition_plan_delivery 推进施工");
    }
    const { projectRef: _projectRef, actor, ...input } = args;
    const roleErrors = roleAssignmentErrors(input.roleAssignments, false);
    if (roleErrors.length > 0) return error(roleErrors.join("；"));
    const plan = store.insertPlan({
      ...input, projectId: project.id, owner: input.roleAssignments.builder.displayName || input.roleAssignments.builder.agentId || input.owner,
      progress: input.status === "已完成" ? 100 : input.progress,
      completedAt: input.status === "已完成" ? (input.completedAt || nowIso()) : "",
      startAt: input.status === "进行中" && !input.startAt ? nowIso().slice(0, 10) : input.startAt,
    });
    recordAudit(store, actor, { projectId: project.id, entityType: "plan", entityId: plan.id, action: "create", before: null, after: { title: plan.title, kind: plan.kind }, correlationId: plan.correlationId });
    return result(plan, "计划项已创建");
  });

  server.registerTool("patch_plan_item", {
    title: "更新计划项",
    description: "更新计划项全部字段、画布绑定、依赖和完成状态。",
    inputSchema: {
      planId: z.string().min(1),
      diagramId: z.string().nullable().optional(), diagramNodeId: z.string().nullable().optional(), parentId: z.string().nullable().optional(),
      kind: z.enum(PLAN_KINDS).optional(), title: z.string().trim().min(1).max(300).optional(), description: z.string().max(4000).optional(),
      status: z.enum(PLAN_STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), progress: z.number().int().min(0).max(100).optional(),
      owner: z.string().max(100).optional(), roleAssignments: planRoleAssignmentsSchema.optional(), versionTag: z.string().max(64).optional(), startAt: z.string().max(32).optional(), dueAt: z.string().max(32).optional(),
      dependencyIds: z.array(z.string()).max(500).optional(), blockedReason: z.string().max(2000).optional(), completedAt: z.string().max(64).optional(),
      actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const before = store.getPlan(args.planId);
    if (!before) return error(`未找到计划项: ${args.planId}`);
    const { planId, actor, ...rawPatch } = args;
    const patch = rawPatch as Partial<PlanItem>;
    const dependencyDecision = patch.dependencyIds === undefined
      ? { allowed: true, lifecyclePatch: {} }
      : decideDependencyEdit(before, patch.dependencyIds);
    if (!dependencyDecision.allowed) return error(dependencyDecision.message || "计划依赖当前不可修改");
    Object.assign(patch, dependencyDecision.lifecyclePatch);
    if (patch.roleAssignments) {
      const roleErrors = roleAssignmentErrors(patch.roleAssignments, false);
      if (roleErrors.length > 0) return error(roleErrors.join("；"));
      patch.owner = patch.roleAssignments.builder.displayName || patch.roleAssignments.builder.agentId || before.owner;
    }
    const diagramId = patch.diagramId === undefined ? before.diagramId : patch.diagramId;
    const diagramNodeId = patch.diagramNodeId === undefined ? before.diagramNodeId : patch.diagramNodeId;
    const bindingError = validatePlanBinding(store, before.projectId, diagramId, diagramNodeId);
    if (bindingError) return error(bindingError);
    const parentId = patch.parentId === undefined ? before.parentId : patch.parentId;
    const dependencyIds = patch.dependencyIds === undefined ? before.dependencyIds : patch.dependencyIds;
    const referenceError = validatePlanReferences(store, before.projectId, before.id, parentId, dependencyIds);
    if (referenceError) return error(referenceError);
    const controlled = Boolean(diagramId && diagramNodeId);
    if (controlled && (patch.status !== undefined || patch.progress !== undefined || patch.completedAt !== undefined)) {
      return error("绑定画布节点的开发计划必须通过 transition_plan_delivery 推进施工状态");
    }
    if (patch.status === "已完成") { patch.progress = 100; patch.completedAt = patch.completedAt || nowIso(); }
    else if (patch.status) patch.completedAt = "";
    if (patch.status === "进行中" && !before.startAt && !patch.startAt) patch.startAt = nowIso().slice(0, 10);
    const updated = store.updatePlan(planId, patch);
    if (!updated) return error("计划项更新失败");
    recordAudit(store, actor, { projectId: before.projectId, entityType: "plan", entityId: planId, action: "update", before: { title: before.title, status: before.status }, after: { title: updated.title, status: updated.status }, correlationId: before.correlationId || before.id });
    return result(updated, "计划项已更新");
  });

  server.registerTool("transition_plan_delivery", {
    title: "流转计划交付状态",
    description: "受控流转双线路交付：提交计划、独立审计通过/失败、Main Agent 批准、开始/完成编码、最终验收和返工重开。每次流转都记录操作者；生产 Agent 不得自审或自批，human-only 高风险动作仍由人工处理。",
    inputSchema: {
      planId: z.string().min(1),
      action: z.enum(PLAN_TRANSITION_ACTIONS),
      actor: z.string().trim().min(1).max(100),
      agentId: z.string().trim().max(200).optional(),
      leaseToken: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().trim().max(300).optional(),
      reason: z.string().max(4000).optional(),
      documentRevisionId: z.string().trim().max(300).optional(),
      implementationRevision: z.string().max(200).optional(),
      evidenceId: z.string().trim().max(300).optional(),
      testCommand: z.string().max(2000).optional(),
      verdict: z.enum(["pass", "fail"]).optional(),
      reworkConditions: z.string().max(4000).optional(),
      authSessionToken: z.string().min(32).max(300).optional(),
      repairDisposition: z.enum(["reset", "design_change"]).optional(),
      correlationId: z.string().max(300).optional(), clientId: z.string().max(300).optional(),
      sessionId: z.string().max(300).optional(), model: z.string().max(300).optional(),
      policyAckToken: z.string().max(300).optional(), workOrderId: z.string().max(300).optional(),
      taskKey: z.string().max(2000).optional(), taskRevision: z.string().max(500).optional(),
      workerId: z.string().max(300).optional(), role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
      nonceId: z.string().max(300).optional(), bodyDigest: z.string().max(128).optional(), connectionId: z.string().max(300).optional(),
      coordinationLeaseId: z.string().trim().max(300).optional(), coordinationLeaseToken: z.string().trim().max(300).optional(),
    },
  }, ({ planId, action, actor, agentId, leaseToken, idempotencyKey, reason, documentRevisionId, implementationRevision, evidenceId, testCommand, verdict, reworkConditions, authSessionToken, repairDisposition, correlationId, clientId, sessionId, model,
    policyAckToken, workOrderId, taskKey, taskRevision, workerId, role, nonceId, bodyDigest, connectionId, coordinationLeaseId, coordinationLeaseToken }) => {
    const before = store.getPlan(planId);
    if (!before) return error(`未找到计划项: ${planId}`);
    try {
      const context = { actor, source: "mcp" as const, clientId, sessionId, model };
      const updated = store.db.transaction(() => {
        const parentActions = new Set(["approve_plan", "reject_plan", "approve_acceptance", "reject_acceptance"]);
        const usingParent = parentActions.has(action) && Boolean(coordinationLeaseId);
        if (coordinationLeaseId && !usingParent) throw new Error("父协调租约只能用于 Main Agent 的批准或验收动作");
        const parentToken = coordinationLeaseToken || (!workOrderId ? leaseToken : "");
        const coordination = usingParent
          ? assertCoordinationLeaseForPlan(store, { projectId: before.projectId, planId, coordinationLeaseId: coordinationLeaseId!, coordinationLeaseToken: parentToken || "", mainAgentId: agentId || actor })
          : null;
        if (coordination) {
          const expectedStage = action.endsWith("acceptance") ? "acceptance" : "approval";
          if (coordination.stage !== expectedStage) throw new Error(`父协调租约当前阶段为 ${coordination.stage}，不能执行 ${action}`);
        }
        const lease = coordination ? null : assertAgentTaskLeaseForPlanAction(store, { leaseToken, agentId, planId, action, securityContext: {
          policyAckToken, workOrderId, taskKey, taskRevision, workerId, role, nonceId, bodyDigest, connectionId, idempotencyKey,
        } });
        const next = transitionPlanLifecycle(store, planId, { action, actor, agentId: coordination?.mainAgentId || agentId, reason, implementationRevision, evidenceId, testCommand, repairDisposition, correlationId, baselineRevision: lease?.baselineRevision });
        if (!coordination) advanceAgentTaskLeaseForPlanAction(store, lease, {
          action, agentId, idempotencyKey,
          resultDigest: implementationRevision || reason || `${action}:${planId}`,
          evidenceId, testCommand, implementationRevision, documentRevisionId, verdict, reworkConditions,
          workOrderId, taskKey, taskRevision, workerId, role, authSessionToken,
          policyAckToken, nonceId, bodyDigest, connectionId,
        }, context);
        recordAudit(store, actor, {
          projectId: before.projectId, entityType: "plan", entityId: planId, action,
          before: { lifecycleStatus: before.lifecycleStatus, status: before.status, auditStatus: before.auditStatus, managerDecision: before.managerDecision },
          after: { lifecycleStatus: next.lifecycleStatus, status: next.status, auditStatus: next.auditStatus, managerDecision: next.managerDecision, reason: reason ?? "" },
          correlationId: correlationId || before.correlationId, clientId, sessionId, model,
        });
        return next;
      }).immediate();
      return result(updated, "计划交付状态已流转");
    } catch (cause) {
      if (cause instanceof DesignContractError) return error(JSON.stringify({ code: cause.code, message: cause.message, details: cause.details }));
      recoverCoordinationLeaseAfterRejectedTransaction(store, before.projectId, cause);
      if (cause instanceof AgentTaskLeaseError || cause instanceof AgentSecurityError || cause instanceof CoordinationLeaseError) return error(structuredError(cause));
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  });

  server.registerTool("submit_design_change_intent", {
    description: "为 accepted 根计划提交非授权设计变更意图；更正尚未完成变更的需求影响分类时必须提供 correctsChangeId 并绑定其当前返工计划，随后需要全新独立审批。requestedBy 仅作 unverified_submission 审计声明；本工具只生成 pending 独立审批工单，不修改计划、文档、节点、证据或租约。",
    inputSchema: {
      projectRef: z.string().min(1), diagramId: z.string().min(1), nodeId: z.string().min(1),
      rootPlanId: z.string().min(1), correctsChangeId: z.string().uuid().optional(), reason: z.string().min(1), changeSummary: z.string().min(1),
      expectedUpdatedAt: z.string().min(1), idempotencyKey: z.string().min(1), requestedBy: z.string().max(300).optional(),
    },
  }, (input) => {
    const project = projectByRef(store, input.projectRef);
    if (!project) return error("项目不存在");
    try {
      const { projectRef: _projectRef, ...intent } = input;
      return result(submitDesignChangeIntent(store, { ...intent, projectId: project.id }));
    } catch (cause) {
      if (cause instanceof DesignChangeIntentError || cause instanceof DesignChangeCorrectionError) return error(structuredError(cause));
      return error(cause instanceof Error ? cause.message : "提交设计变更意图失败");
    }
  });

  server.registerTool("request_evidence_repair_assessment", {
    description: "对精确的历史 failed submit_evidence_repair 工单重新执行服务器只读预检；仅当同一 generation 仍被服务器基线条件阻断时写入 blocked，随后派生独立 Main Agent assessment 工单。requestedBy 不作为身份。",
    inputSchema: {
      projectRef: z.string().min(1), planId: z.string().min(1), failedWorkOrderId: z.string().min(1),
      expectedGeneration: z.number().int().min(0), expectedRepairUpdatedAt: z.string().min(1),
      idempotencyKey: z.string().min(1), requestedBy: z.string().max(300).optional(),
    },
  }, (input) => {
    const project = projectByRef(store, input.projectRef);
    if (!project) return error("项目不存在");
    try {
      const { projectRef: _projectRef, ...assessment } = input;
      return result(requestEvidenceRepairAssessment(store, { ...assessment, projectId: project.id }));
    } catch (cause) {
      if (cause instanceof EvidenceRepairAssessmentError) return error(structuredError(cause));
      return error(cause instanceof Error ? cause.message : "请求历史证据修复评估失败");
    }
  });

  server.registerTool("dismiss_design_change_intent", {
    description: "使用变更意图完整独立 approval 组驳回 pending 意图；已登记身份须逐工单提交 authSessionToken、policyAckToken 和 nonceId。不会授权实现或修改计划、文档、节点、证据。",
    inputSchema: {
      projectRef: z.string().min(1), intentId: z.string().min(1), reason: z.string().min(1), idempotencyKey: z.string().min(1),
      workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1), taskRevision: z.string().min(1),
      workerId: z.string().min(1), agentId: z.string().min(1), role: z.literal("approver"),
      authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(), nonceId: z.string().min(1).optional(),
      scopeApprovals: z.array(z.object({
        workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1), taskRevision: z.string().min(1),
        workerId: z.string().min(1), agentId: z.string().min(1), role: z.literal("approver"),
        authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(), nonceId: z.string().min(1).optional(),
      }).strict()).max(200).optional(),
    },
  }, (input) => {
    const project = projectByRef(store, input.projectRef);
    if (!project) return error("项目不存在");
    try {
      const { projectRef: _projectRef, intentId, reason, idempotencyKey, scopeApprovals, ...agent } = input;
      return result(dismissDesignChangeIntent(store, { projectId: project.id, intentId, reason, idempotencyKey }, {
        source: "mcp", agent, scopeApprovals,
        securityAction: "mcp.dismiss_design_change_intent", securityTarget: "mcp:dismiss_design_change_intent",
      }));
    } catch (cause) {
      if (cause instanceof DesignChangeError || cause instanceof AgentSecurityError || cause instanceof DesignChangeIntentError || cause instanceof DesignChangeCorrectionError) return error(structuredError(cause));
      return error(cause instanceof Error ? cause.message : "驳回设计变更意图失败");
    }
  });

  server.registerTool("request_design_change", {
    description: "主 Agent 使用当前节点的独立 approver 工单发起原子化设计变更：冻结旧施工、建立待评审修订和返工计划、失效旧证据及租约。必须携带完整租约上下文；不能直接批准新设计或执行部署、权限等高风险动作。成功后旧工单失效，同一幂等键仅可读回原结果。",
    inputSchema: {
      workOrderId: leaseWriteContextSchema.workOrderId.optional(),
      leaseToken: leaseWriteContextSchema.leaseToken.optional(),
      taskKey: leaseWriteContextSchema.taskKey.optional(),
      taskRevision: leaseWriteContextSchema.taskRevision.optional(),
      workerId: leaseWriteContextSchema.workerId.optional(),
      agentId: leaseWriteContextSchema.agentId.optional(),
      role: leaseWriteContextSchema.role.optional(),
      scopeApprovals: z.array(z.object({
        workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1),
        taskRevision: z.string().min(1), workerId: z.string().min(1), agentId: z.string().min(1),
        role: z.literal("approver"),
        authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(),
        nonceId: z.string().min(1).optional(),
      }).strict()).max(200).optional(),
      projectRef: z.string().min(1),
      intentId: z.string().min(1).optional(),
      diagramId: z.string().min(1),
      nodeId: z.string().min(1),
      actor: z.string().min(1),
      reason: z.string().min(1),
      changeSummary: z.string().min(1),
      requirementImpact: z.boolean(),
      impactedDocumentIds: z.array(z.string().min(1)).min(1),
      impactedPlanIds: z.array(z.string().min(1)).min(1),
      reusableWorkSummary: z.string().default(""),
      reworkScope: z.string().min(1),
      apiImpact: z.string().default(""),
      databaseImpact: z.string().default(""),
      deploymentImpact: z.string().default(""),
      reusableEvidenceIds: z.array(z.string().min(1)).optional(),
      expectedUpdatedAt: z.string().min(1),
      idempotencyKey: z.string().min(1),
      clientId: z.string().optional(),
      sessionId: z.string().optional(),
      model: z.string().optional(),
      authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(),
      nonceId: z.string().min(1).optional(),
    },
  }, async (input) => {
    const project = projectByRef(store, input.projectRef);
    if (!project) return error("项目不存在");
    try {
      const { projectRef: _projectRef, workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role, scopeApprovals,
        authSessionToken, policyAckToken, nonceId, ...change } = input;
      const hasAgent = !options.trustedInternal || [workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role].some((value) => value !== undefined);
      return result(requestDesignChange(store, { ...change, projectId: project.id }, {
        source: "mcp", agent: hasAgent ? { workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role,
          authSessionToken, policyAckToken, nonceId } : undefined,
        scopeApprovals,
        securityAction: "mcp.request_design_change",
        securityTarget: "mcp:request_design_change",
      }));
    } catch (cause) {
      if (cause instanceof DesignChangeError || cause instanceof AgentSecurityError) return error(structuredError(cause));
      return error(cause instanceof Error ? cause.message : "发起设计变更失败");
    }
  });

  server.registerTool("delete_plan_item", {
    title: "删除计划项",
    description: "删除计划项，必须显式确认。",
    inputSchema: { planId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional(), policyAckToken: z.string().max(300).optional() },
  }, ({ planId, confirm, actor }) => {
    if (!confirm) return error("删除计划项需要 confirm=true");
    const before = store.getPlan(planId);
    if (!before) return error(`未找到计划项: ${planId}`);
    store.deletePlan(planId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "plan", entityId: planId, action: "delete", before: { title: before.title }, after: null });
    return result({ ok: true, deletedId: planId });
  });

  server.registerTool("list_evidence", {
    title: "列出验收证据",
    description: "分页列出项目证据；提供 nodeId 时只返回该节点的证据。",
    inputSchema: { projectRef: z.string().min(1), nodeId: z.string().min(1).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ projectRef, nodeId, offset, limit }) => {
    const project = projectByRef(store, projectRef);
    return project ? result(pageOf(store.listEvidence(project.id, nodeId), offset, limit)) : error(`未找到项目: ${projectRef}`);
  });

  server.registerTool("create_evidence", {
    title: "新增验收证据",
    description: "新增手工、测试、接口或构建证据。",
    inputSchema: {
      projectRef: z.string().min(1), nodeId: z.string().nullable().default(null), sourceType: z.enum(["git", "maven", "junit", "playwright", "manual"]).default("manual"),
      sourcePath: z.string().max(1000).default(""), command: z.string().max(1000).default(""), resultStatus: z.enum(["pass", "warn", "fail", "info"]).default("info"),
      summary: z.string().trim().min(1).max(2000), details: z.record(z.string(), z.unknown()).default({}), commitSha: z.string().max(300).default(""), digest: z.string().max(500).default(""), actor: z.string().max(100).optional(),
      planItemId: z.string().nullable().default(null), acceptanceCriterionKey: z.string().max(300).default(""),
      actorRole: z.enum(PLAN_AGENT_ROLES).nullable().default(null), agentId: z.string().max(200).default(""),
      leaseToken: z.string().max(300).optional(), idempotencyKey: z.string().max(300).optional(),
      documentRevisionId: z.string().nullable().default(null), sessionId: z.string().nullable().default(null), runId: z.string().max(300).default(""),
      supersedesEvidenceId: z.string().nullable().default(null),
      correlationId: z.string().max(300).optional(), clientId: z.string().max(300).optional(), model: z.string().max(300).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    const nodeBindingError = validateDocumentNodeBinding(store, project.id, args.nodeId);
    if (nodeBindingError) return error(nodeBindingError);
    const evidencePlan = args.planItemId ? store.getPlan(args.planItemId) : undefined;
    if (args.planItemId && evidencePlan?.projectId !== project.id) return error("planItemId 不存在或不属于当前项目");
    if (evidencePlan) {
      try {
        assertEvidenceIdentity(evidencePlan, args.actorRole, args.agentId);
        if (args.actorRole) {
          if (!args.idempotencyKey?.trim()) throw new AgentTaskLeaseError(400, "IDEMPOTENCY_KEY_REQUIRED", "Agent 证据写入必须提供 idempotencyKey");
          assertAgentTaskLeaseForWrite(store, {
            leaseToken: args.leaseToken,
            agentId: args.agentId,
            planId: evidencePlan.id,
            role: args.actorRole,
            auditScope: args.details.auditScope === "design" || args.details.auditScope === "implementation"
              ? args.details.auditScope
              : null,
          });
        }
      }
      catch (cause) { return error(structuredError(cause)); }
    }
    if (args.documentRevisionId && store.getDocumentRevision(args.documentRevisionId)?.projectId !== project.id) return error("documentRevisionId 不存在或不属于当前项目");
    if (args.supersedesEvidenceId && store.getEvidence(args.supersedesEvidenceId)?.projectId !== project.id) return error("supersedesEvidenceId 不存在或不属于当前项目");
    const { projectRef: _projectRef, actor, correlationId, clientId, model, leaseToken: _leaseToken, idempotencyKey: _idempotencyKey, ...input } = args;
    const evidence = store.insertEvidence({ ...input, projectId: project.id, collectedAt: nowIso() });
    const plan = evidence.planItemId ? store.getPlan(evidence.planItemId) : undefined;
    recordAudit(store, actor, {
      projectId: project.id, entityType: "evidence", entityId: evidence.id, action: "create",
      before: null, after: { summary: evidence.summary, sourceType: evidence.sourceType },
      correlationId: correlationId || plan?.correlationId || plan?.id,
      clientId, sessionId: evidence.sessionId || undefined, model,
    });
    return result(evidence, "证据已创建");
  });

  server.registerTool("delete_evidence", {
    title: "撤销证据",
    description: "软撤销证据记录并保留历史，必须显式确认和填写原因。兼容旧工具名 delete_evidence，但不会物理删除。",
    inputSchema: { evidenceId: z.string().min(1), reason: z.string().trim().min(1).max(2000), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ evidenceId, reason, confirm, actor }) => {
    if (!confirm) return error("撤销证据需要 confirm=true");
    const before = store.getEvidence(evidenceId);
    if (!before) return error(`未找到证据: ${evidenceId}`);
    store.deleteEvidence(evidenceId, reason);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "evidence", entityId: evidenceId, action: "revoke", before: { summary: before.summary, status: before.status }, after: { status: "revoked", reason } });
    return result({ ok: true, revokedId: evidenceId, reason });
  });

  server.registerTool("patch_governance", {
    title: "更新治理记录",
    description: "更新决策或意见的全部字段。",
    inputSchema: {
      governanceId: z.string().min(1), type: z.enum(["decision", "opinion"]).optional(), title: z.string().trim().min(1).max(300).optional(),
      content: z.string().max(8000).optional(), rationale: z.string().max(4000).optional(), status: z.enum(["有效", "待确认", "已替代"]).optional(), author: z.string().max(100).optional(), actor: z.string().max(100).optional(),
      confirm: z.boolean().default(false),
    },
  }, (args) => {
    const before = store.getGovernance(args.governanceId);
    if (!before) return error(`未找到治理记录: ${args.governanceId}`);
    const { governanceId, actor, confirm: _confirm, ...patch } = args;
    const updated = store.updateGovernance(governanceId, patch);
    if (!updated) return error("治理记录更新失败");
    recordAudit(store, actor, { projectId: before.projectId, entityType: "governance", entityId: governanceId, action: "update", before: { title: before.title, status: before.status }, after: { title: updated.title, status: updated.status } });
    return result(updated, "治理记录已更新");
  });

  server.registerTool("delete_governance", {
    title: "删除治理记录",
    description: "删除决策或意见，必须显式确认。",
    inputSchema: { governanceId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ governanceId, confirm, actor }) => {
    if (!confirm) return error("删除治理记录需要 confirm=true");
    const before = store.getGovernance(governanceId);
    if (!before) return error(`未找到治理记录: ${governanceId}`);
    store.deleteGovernance(governanceId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "governance", entityId: governanceId, action: "delete", before: { title: before.title }, after: null });
    return result({ ok: true, deletedId: governanceId });
  });

  server.registerTool("patch_design_doc", {
    title: "更新设计文档",
    description: "更新项目系统文档并创建新的不可变版本；已有业务引用不会被静默改写。",
    inputSchema: {
      documentId: z.string().min(1), category: z.enum(DESIGN_DOC_CATEGORIES).optional(), title: z.string().trim().min(1).max(300).optional(),
      summary: z.string().max(2000).optional(), status: z.enum(DESIGN_DOC_STATUSES).optional(), version: z.string().max(64).optional(), author: z.string().max(100).optional(),
      sourceUrl: z.string().max(2000).optional(), content: z.string().max(100_000).optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const before = store.getDesignDoc(args.documentId);
    if (!before) return error(`未找到设计文档: ${args.documentId}`);
    if (args.status === "已批准" && isInitialProjectBriefApproval(store, before.projectId,
      { id: before.id, category: args.category ?? before.category })) {
      return error("PROJECT_BRIEF_APPROVAL_REQUIRED: 首个项目简报必须经独立设计审计和 Main Agent 工单批准");
    }
    const { documentId, actor, ...patch } = args;
    const updated = store.updateDesignDoc(documentId, patch);
    if (!updated) return error("设计文档更新失败");
    recordAudit(store, actor, { projectId: before.projectId, entityType: "designDoc", entityId: documentId, action: "update", before: { title: before.title, status: before.status }, after: { title: updated.title, status: updated.status, version: updated.version } });
    return result(updated, "设计文档已更新");
  });

  server.registerTool("list_document_references", {
    title: "列出文档引用",
    description: "按项目、文档或目标对象查询统一文档引用。",
    inputSchema: {
      projectRef: z.string().min(1), documentId: z.string().min(1).optional(),
      targetType: z.enum(DOCUMENT_REFERENCE_TARGET_TYPES).optional(), targetId: z.string().min(1).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    return result(store.listDocumentReferences({ projectId: project.id, documentId: args.documentId, targetType: args.targetType, targetId: args.targetId }));
  });

  server.registerTool("create_document_reference", {
    title: "引用系统文档",
    description: "让画布、节点、计划、数据库模型、证据或治理记录引用文档的当前或指定版本。",
    inputSchema: {
      projectRef: z.string().min(1), documentId: z.string().min(1), documentRevisionId: z.string().min(1).optional(),
      targetType: z.enum(DOCUMENT_REFERENCE_TARGET_TYPES), targetId: z.string().min(1),
      relationType: z.enum(DOCUMENT_REFERENCE_RELATION_TYPES).default("references"), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    const document = store.getDesignDoc(args.documentId);
    if (!document || document.projectId !== project.id) return error("设计文档不存在或不属于当前项目");
    const targetError = validateDocumentReferenceTarget(store, project.id, args.targetType, args.targetId);
    if (targetError) return error(targetError);
    if (args.targetType === "project" && args.targetId === project.id && args.relationType === "defines"
      && document.status === "已批准"
      && isInitialProjectBriefApproval(store, project.id, { id: "", category: document.category })) {
      return error("PROJECT_BRIEF_APPROVAL_REQUIRED: 首个项目简报必须经独立设计审计和 Main Agent 工单批准");
    }
    const reference = store.insertDocumentReference({
      projectId: project.id, documentId: document.id, documentRevisionId: args.documentRevisionId,
      targetType: args.targetType, targetId: args.targetId, relationType: args.relationType,
    });
    recordAudit(store, args.actor, { projectId: project.id, entityType: "documentReference", entityId: reference.id, action: "create", before: null, after: { documentId: document.id, targetType: args.targetType, targetId: args.targetId, relationType: args.relationType } });
    return result(reference, "文档引用已创建");
  });

  server.registerTool("refresh_document_reference", {
    title: "确认文档引用最新版",
    description: "显式把一个已有引用更新到该文档的当前版本。",
    inputSchema: { referenceId: z.string().min(1), actor: z.string().max(100).optional() },
  }, ({ referenceId, actor }) => {
    const before = store.getDocumentReference(referenceId);
    if (!before) return error(`未找到文档引用: ${referenceId}`);
    const document = store.getDesignDoc(before.documentId);
    if (!document) return error("引用的设计文档不存在");
    const revision = store.getDocumentRevision(document.currentRevisionId);
    if (!revision || revision.status !== "已批准") return error("文档当前版本尚未批准，不能刷新业务引用");
    const updated = store.updateDocumentReferenceRevision(referenceId, document.currentRevisionId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "documentReference", entityId: referenceId, action: "update", before: { documentRevisionId: before.documentRevisionId }, after: { documentRevisionId: updated?.documentRevisionId } });
    return result(updated, "文档引用已更新到最新版");
  });

  server.registerTool("delete_document_reference", {
    title: "解除文档引用",
    description: "解除业务对象与系统文档的关系，不删除文档；必须显式确认。",
    inputSchema: { referenceId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ referenceId, confirm, actor }) => {
    if (!confirm) return error("解除文档引用需要 confirm=true");
    const before = store.getDocumentReference(referenceId);
    if (!before) return error(`未找到文档引用: ${referenceId}`);
    store.deleteDocumentReference(referenceId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "documentReference", entityId: referenceId, action: "delete", before: { documentId: before.documentId, targetType: before.targetType, targetId: before.targetId }, after: null });
    return result({ ok: true, deletedId: referenceId });
  });

  server.registerTool("delete_design_doc", {
    title: "删除设计文档",
    description: "删除设计文档，必须显式确认。",
    inputSchema: { documentId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ documentId, confirm, actor }) => {
    if (!confirm) return error("删除设计文档需要 confirm=true");
    const before = store.getDesignDoc(documentId);
    if (!before) return error(`未找到设计文档: ${documentId}`);
    store.deleteDesignDoc(documentId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "designDoc", entityId: documentId, action: "delete", before: { title: before.title }, after: null });
    return result({ ok: true, deletedId: documentId });
  });

  server.registerTool("create_diagram", {
    title: "新建画布",
    description: "从空白、部署、流程、功能或用例模板新建画布，也可直接提供完整节点与连线。主画布由项目自动创建。",
    inputSchema: {
      projectRef: z.string().min(1), title: z.string().trim().min(1).max(200), type: z.enum(DIAGRAM_TYPES).optional(), template: z.enum(["blank", "arch", "flow", "module", "usecase"]).default("blank"),
      nodes: z.array(diagramNodeSchema).max(5000).optional(), edges: z.array(diagramEdgeSchema).max(10_000).optional(), groups: z.array(diagramGroupSchema).max(1000).optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const project = projectByRef(store, args.projectRef);
    if (!project) return error(`未找到项目: ${args.projectRef}`);
    if (args.type === "main") return error("系统主画布由项目自动创建，每个项目只能有一个");
    const template = buildDiagramTemplate(args.template);
    const input = { projectId: project.id, title: args.title, type: args.type ?? template.type, nodes: args.nodes ?? template.nodes, edges: args.edges ?? template.edges, groups: args.groups ?? [] };
    try { assertDiagramStructure(input); } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
    try { assertNoIntroducedDiagramGroupOverlap({ nodes: [], groups: [] }, input); } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
    const diagram = store.insertDiagram(input);
    const linkError = validateDiagramLinks(store, diagram);
    if (linkError) { store.deleteDiagram(diagram.id); return error(linkError); }
    const structuralErrors = validateDiagram(diagram, { diagrams: store.listDiagrams(project.id) }).filter((issue) => issue.severity === "error" && ["empty_node_label", "duplicate_node_label", "broken_edge", "broken_diagram_link", "cross_project_diagram_link"].includes(issue.code));
    if (structuralErrors.length) { store.deleteDiagram(diagram.id); return error(structuralErrors.map((issue) => issue.message).join("; ")); }
    recordAudit(store, args.actor, { projectId: project.id, entityType: "diagram", entityId: diagram.id, action: "create", before: null, after: diagramSummary(diagram) });
    return result(diagram, "画布已创建");
  });

  server.registerTool("update_diagram", {
    title: "完整更新画布",
    description: "修改画布标题、类型或整体替换节点、连线、分组。可用 expectedUpdatedAt 防止覆盖并发修改。",
    inputSchema: {
      diagramId: z.string().min(1), expectedUpdatedAt: z.string().optional(), title: z.string().trim().min(1).max(200).optional(), type: z.enum(DIAGRAM_TYPES).optional(),
      nodes: z.array(diagramNodeSchema).max(5000).optional(), edges: z.array(diagramEdgeSchema).max(10_000).optional(), groups: z.array(diagramGroupSchema).max(1000).optional(), actor: z.string().max(100).optional(),
    },
  }, (args) => {
    const before = store.getDiagram(args.diagramId);
    if (!before) return error(`未找到画布: ${args.diagramId}`);
    const revisionError = ensureExpectedRevision(before, args.expectedUpdatedAt);
    if (revisionError) return error(revisionError);
    const next: Diagram = { ...before, ...(args.title !== undefined ? { title: args.title } : {}), ...(args.type !== undefined ? { type: args.type } : {}), ...(args.nodes !== undefined ? { nodes: args.nodes } : {}), ...(args.edges !== undefined ? { edges: args.edges } : {}), ...(args.groups !== undefined ? { groups: args.groups } : {}) };
    try { assertDiagramStructure(next); } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
    const linkError = validateDiagramLinks(store, next);
    if (linkError) return error(linkError);
    try { return result(saveDiagramChange(store, before, next, args.actor, "update"), "画布已更新"); } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("delete_diagram", {
    title: "删除画布",
    description: "删除非主画布，必须显式确认。",
    inputSchema: { diagramId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
  }, ({ diagramId, confirm, actor }) => {
    if (!confirm) return error("删除画布需要 confirm=true");
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    if (before.type === "main") return error("系统主画布不能删除");
    if (before.nodes.some(hasRequirementChangeMarker)) return error("NODE_REQUIREMENT_REVISION_REQUIRED: 画布含未解除设计变更标记的节点，不能删除");
    store.deleteDiagram(diagramId);
    recordAudit(store, actor, { projectId: before.projectId, entityType: "diagram", entityId: diagramId, action: "delete", before: diagramSummary(before), after: null });
    return result({ ok: true, deletedId: diagramId });
  });

  server.registerTool("mutate_diagram", {
    title: "批量操作画布",
    description: "原子执行节点、连线和分组的新增、修改、移动、缩放或删除。任一操作失败时整批不保存。",
    inputSchema: { diagramId: z.string().min(1), expectedUpdatedAt: z.string().optional(), operations: z.array(diagramOperationSchema).min(1).max(1000), actor: z.string().max(100).optional() },
  }, ({ diagramId, expectedUpdatedAt, operations, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    const revisionError = ensureExpectedRevision(before, expectedUpdatedAt);
    if (revisionError) return error(revisionError);
    try {
      const next = applyDiagramOperations(before, operations);
      const linkError = validateDiagramLinks(store, next);
      if (linkError) return error(linkError);
      return result(saveDiagramChange(store, before, next, actor, "mutate"), `已原子执行 ${operations.length} 个画布操作`);
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("auto_layout_diagram", {
    title: "自动整理画布",
    description: "使用与网页一致的 ELK 分层布局并生成正交线路。",
    inputSchema: { diagramId: z.string().min(1), direction: z.enum(["vertical", "horizontal"]).default("vertical"), expectedUpdatedAt: z.string().optional(), actor: z.string().max(100).optional() },
  }, async ({ diagramId, direction, expectedUpdatedAt, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    const revisionError = ensureExpectedRevision(before, expectedUpdatedAt);
    if (revisionError) return error(revisionError);
    try {
      const arranged = await layoutDiagram(before.nodes, before.edges, direction, before.type);
      return result(saveDiagramChange(store, before, { ...before, ...arranged }, actor, "layout"), "画布自动布局已保存");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("align_diagram_nodes", {
    title: "对齐或等距分布节点",
    description: "支持左/中/右、上/中/下对齐，以及水平/垂直等距。",
    inputSchema: { diagramId: z.string().min(1), nodeIds: z.array(z.string().min(1)).min(2).max(500), alignment: z.enum(["left", "hcenter", "right", "top", "vcenter", "bottom", "distH", "distV"]), expectedUpdatedAt: z.string().optional(), actor: z.string().max(100).optional() },
  }, ({ diagramId, nodeIds, alignment, expectedUpdatedAt, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    const revisionError = ensureExpectedRevision(before, expectedUpdatedAt);
    if (revisionError) return error(revisionError);
    try { return result(saveDiagramChange(store, before, alignDiagramNodes(before, nodeIds, alignment), actor, "align"), "节点位置已更新"); }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("duplicate_diagram_nodes", {
    title: "复制画布节点",
    description: "复制选中节点及它们之间的连线。",
    inputSchema: { diagramId: z.string().min(1), nodeIds: z.array(z.string().min(1)).min(1).max(500), offsetX: z.number().finite().default(30), offsetY: z.number().finite().default(30), expectedUpdatedAt: z.string().optional(), actor: z.string().max(100).optional() },
  }, ({ diagramId, nodeIds, offsetX, offsetY, expectedUpdatedAt, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    const revisionError = ensureExpectedRevision(before, expectedUpdatedAt);
    if (revisionError) return error(revisionError);
    try {
      const duplicated = duplicateDiagramNodes(before, nodeIds, offsetX, offsetY);
      const updated = saveDiagramChange(store, before, duplicated.diagram, actor, "duplicate");
      return result({ diagram: updated, createdNodeIds: duplicated.createdNodeIds }, "节点已复制");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("extract_diagram", {
    title: "抽取子画布",
    description: "把指定节点及内部连线复制为新画布，并把源节点关联到新画布。",
    inputSchema: { diagramId: z.string().min(1), nodeIds: z.array(z.string().min(1)).min(1).max(500), title: z.string().trim().min(1).max(200).optional(), actor: z.string().max(100).optional() },
  }, ({ diagramId, nodeIds, title, actor }) => {
    const source = store.getDiagram(diagramId);
    if (!source) return error(`未找到画布: ${diagramId}`);
    const selectedIds = new Set(nodeIds), selected = source.nodes.filter((node) => selectedIds.has(node.id));
    if (selected.length === 0) return error("没有可抽取的节点");
    const idMap = new Map(selected.map((node) => [node.id, newId()]));
    const nodes = selected.map((node) => ({ ...node, id: idMap.get(node.id)!, linkDiagramIds: [] }));
    const edges = source.edges.filter((edge) => idMap.has(edge.from) && idMap.has(edge.to)).map((edge) => ({ ...edge, id: newId(), from: idMap.get(edge.from)!, to: idMap.get(edge.to)! }));
    const child = store.insertDiagram({ projectId: source.projectId, title: title ?? (selected.length === 1 ? `${selected[0].label} · 子画布` : `${selected.length} 个节点 · 子画布`), type: source.type === "main" ? "functional" : source.type, nodes, edges, groups: [] });
    const updatedSource: Diagram = { ...source, nodes: source.nodes.map((node) => selectedIds.has(node.id) ? { ...node, linkDiagramIds: [...new Set([...(node.linkDiagramIds ?? []), child.id])], deliveryUpdatedAt: nowIso() } : node) };
    const savedSource = saveDiagramChange(store, source, updatedSource, actor, "extract");
    recordAudit(store, actor, { projectId: source.projectId, entityType: "diagram", entityId: child.id, action: "create", before: null, after: diagramSummary(child) });
    return result({ source: savedSource, child }, "子画布已创建并完成关联");
  });

  server.registerTool("validate_diagram", {
    title: "校验画布",
    description: "校验断线、孤立节点、组合区域重叠、流程开始/结束、判断分支、子画布、验收证据和计划绑定。",
    inputSchema: { diagramId: z.string().min(1) },
  }, ({ diagramId }) => {
    const diagram = store.getDiagram(diagramId);
    if (!diagram) return error(`未找到画布: ${diagramId}`);
    const issues = validateDiagram(diagram, { diagrams: store.listDiagrams(diagram.projectId), plans: store.listPlans(diagram.projectId, diagram.id) });
    return result({ ok: !issues.some((issue) => issue.severity === "error"), errors: issues.filter((issue) => issue.severity === "error").length, warnings: issues.filter((issue) => issue.severity === "warning").length, issues });
  });

  server.registerTool("export_diagram", {
    title: "导出画布",
    description: "把画布导出到 data/exports，支持 JSON、SVG 和 PNG。",
    inputSchema: { diagramId: z.string().min(1), format: z.enum(["json", "svg", "png"]).default("svg"), actor: z.string().max(100).optional() },
  }, async ({ diagramId, format, actor }) => {
    const diagram = store.getDiagram(diagramId);
    if (!diagram) return error(`未找到画布: ${diagramId}`);
    try {
      const exported = await exportDiagram(diagram, dataDir, format);
      recordAudit(store, actor, { projectId: diagram.projectId, entityType: "diagram", entityId: diagram.id, action: "export", before: null, after: exported });
      return result(exported, "画布已导出");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("undo_diagram", {
    title: "撤销画布修改",
    description: "撤销最近一次已持久化的网页或 MCP 画布修改。",
    inputSchema: { diagramId: z.string().min(1), actor: z.string().max(100).optional() },
  }, ({ diagramId, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    try {
      const updated = store.undoDiagramRevision(diagramId);
      if (!updated) return error("没有可撤销的画布修改");
      recordAudit(store, actor, { projectId: before.projectId, entityType: "diagram", entityId: diagramId, action: "undo", before: diagramSummary(before), after: diagramSummary(updated) });
      return result(updated, "已撤销画布修改");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("redo_diagram", {
    title: "重做画布修改",
    description: "重做最近一次被撤销的画布修改。",
    inputSchema: { diagramId: z.string().min(1), actor: z.string().max(100).optional() },
  }, ({ diagramId, actor }) => {
    const before = store.getDiagram(diagramId);
    if (!before) return error(`未找到画布: ${diagramId}`);
    try {
      const updated = store.redoDiagramRevision(diagramId);
      if (!updated) return error("没有可重做的画布修改");
      recordAudit(store, actor, { projectId: before.projectId, entityType: "diagram", entityId: diagramId, action: "redo", before: diagramSummary(before), after: diagramSummary(updated) });
      return result(updated, "已重做画布修改");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("list_audit", {
    title: "查询审计记录",
    description: "查询全部或指定项目的操作审计。",
    inputSchema: {
      projectRef: z.string().optional(), q: z.string().optional(), source: z.enum(["web", "mcp", "system"]).optional(),
      action: z.string().optional(), entityType: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20),
    },
  }, ({ projectRef, q, source, action, entityType, offset, limit }) => {
    const project = projectRef ? projectByRef(store, projectRef) : undefined;
    if (projectRef && !project) return error(`未找到项目: ${projectRef}`);
    return result(store.listAuditPage({ projectId: project?.id, q, source, action, entityType, offset, limit }));
  });

  server.registerTool("list_backups", {
    title: "列出备份",
    description: "分页列出 JSON 数据快照。",
    inputSchema: { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) },
  }, ({ offset, limit }) => result(pageOf(store.listBackups(), offset, limit)));

  server.registerTool("create_backup", {
    title: "创建完整备份",
    description: "把全部业务数据导出为 JSON 快照并登记备份记录。",
    inputSchema: { label: z.string().trim().min(1).max(120), reason: z.string().max(1000).default(""), actor: z.string().max(100).optional() },
  }, ({ label, reason, actor }) => result(createBackup(store, dataDir, label, reason, actor), "备份已创建"));

  server.registerTool("restore_backup", {
    title: "恢复完整备份",
    description: "恢复指定 JSON 业务快照。恢复前自动创建安全备份，必须提供精确确认文本。",
    inputSchema: { backupId: z.string().min(1), confirmation: z.string(), actor: z.string().max(100).optional() },
  }, ({ backupId, confirmation, actor }) => {
    if (confirmation !== `RESTORE ${backupId}`) return error(`恢复前必须提供 confirmation=RESTORE ${backupId}`);
    const backup = store.listBackups().find((item) => item.id === backupId);
    if (!backup) return error(`未找到备份: ${backupId}`);
    try {
      const snapshot = loadBackupFile(dataDir, backupId, backup.createdAt);
      createBackup(store, dataDir, `恢复前自动备份 ${nowIso().slice(0, 19)}`, `恢复备份 ${backup.label} 前的安全快照`, actor);
      const restored = store.restoreBusinessSnapshot(snapshot);
      recordAudit(store, actor, { projectId: null, entityType: "backup", entityId: backupId, action: "restore", before: null, after: { label: backup.label, restored } });
      return result({ ok: true, backup, restored }, "备份已恢复");
    } catch (restoreError) {
      return error(restoreError instanceof Error ? restoreError.message : String(restoreError));
    }
  });

  server.registerTool("collect_project_git_evidence", {
    title: "采集项目 Git 证据",
    description: "采集仓库分支、提交和脏文件信息并返回完整证据实体。",
    inputSchema: { projectRef: z.string().min(1), actor: z.string().max(100).optional() },
  }, async ({ projectRef, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    if (!project.repositoryPath) return error("项目未设置 repositoryPath");
    const collected = await collectGitEvidence(project.repositoryPath);
    const evidence = store.insertEvidence({ ...collected, projectId: project.id, nodeId: null, collectedAt: nowIso() });
    recordAudit(store, actor, { projectId: project.id, entityType: "evidence", entityId: evidence.id, action: "collect", before: null, after: { sourceType: evidence.sourceType, summary: evidence.summary } });
    return result(evidence, "Git 证据已采集");
  });
}
