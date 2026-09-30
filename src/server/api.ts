import { claimTaskPackage } from "./claimTaskPackage.js";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import {
  DESIGN_DOC_STATUSES,
  DESIGN_DOC_CATEGORIES,
  DOCUMENT_REFERENCE_RELATION_TYPES,
  DOCUMENT_REFERENCE_TARGET_TYPES,
  DESIGN_STATUSES,
  AGENT_ENTITY_REF_LABEL_MAX_LENGTH,
  AGENT_APPROVAL_STATUSES,
  AGENT_CONTROL_MODES,
  DEVELOPMENT_STATUSES,
  DIAGRAM_ACCEPTANCE_STATUSES,
  DIAGRAM_DEVELOPMENT_STATUSES,
  DIAGRAM_FLOW_NODE_TYPES,
  DIAGRAM_NODE_KINDS,
  DIAGRAM_PORTS,
  DIAGRAM_TYPES,
  DIAGRAM_USE_CASE_NODE_TYPES,
  DIAGRAM_USE_CASE_RELATION_TYPES,
  HEALTH_LEVELS,
  LLM_REASONING_EFFORTS,
  LLM_PROTOCOLS,
  NODE_KINDS,
  NODE_SHAPES,
  PLAN_KINDS,
  PLAN_AGENT_ROLES,
  PLAN_STATUSES,
  PRIORITIES,
  PROJECT_STAGES,
  REQUIREMENT_STATUSES,
  TEST_STATUSES,
  type AuditEvent,
  type AgentEntityRef,
  type AgentPageContext,
  type AgentBlueprintKey,
  type DatabaseModel,
  type Diagram,
  type Evidence,
  type NodeDatabaseBinding,
  type Paginated,
  type Project,
  type ProjectWorkspaceNode,
  type PlanItem,
} from "../shared/types.js";
import { componentLibrarySchema, normalizeComponentLibrary } from "../shared/components.js";
import { roleAssignmentErrors } from "../shared/planRoles.js";
import { autoLayoutDatabaseModel, generateDatabaseCode, validateDatabaseModel } from "../shared/databaseModel.js";
import { assertNoIntroducedDiagramGroupOverlap } from "../shared/diagramGroups.js";
import {
  databaseConnectionSchema,
  databaseCodeTargetSchema,
  databaseModelCreateSchema,
  databaseModelPatchSchema,
  nodeDatabaseBindingCreateSchema,
  nodeDatabaseBindingPatchSchema,
} from "../shared/databaseSchemas.js";
import { collectGitEvidence } from "./collectors.js";
import { createBackupFile, loadBackupFile, storageRetentionSummary } from "./backups.js";
import { PrototypeDraftConflictError, PrototypeDraftCorruptError, FreeformDraftConflictError, FreeformDocumentCorruptError, FreeformAssetRejectedError, Store, nowIso } from "./db.js";
import {
  type ServiceResult,
  type WhiteboardAuditContext,
  type WhiteboardServiceContext,
  applyDiagramTemplate,
  createComponentInstances,
  createDiagramComponent,
  createDiagramTemplate,
  listDiagramTemplates,
  normalizeDiagramLayerField,
  readDiagramComponents,
  readDiagramLayers,
  readDiagramTemplate,
  removeDiagramComponent,
  revokeDiagramTemplateRecord,
  saveDiagramLayers,
  updateDiagramComponent,
  updateDiagramTemplateRecord,
} from "./whiteboard.js";
import { prototypeSaveSchema } from "../shared/prototype.js";
import {
  applyFreeformAssetSecurityHeaders,
  assertNoDeliveryFieldLeak,
  freeformAssetMimeFromMagic,
  freeformSaveSchema,
  isFreeformAssetMimeAllowed,
  isFreeformAssetMimeDenied,
  normalizeFreeformAssetMime,
  FREEFORM_ASSET_ID_PREFIX,
  FREEFORM_ASSET_MAX_BYTES,
  FREEFORM_ASSET_MIME_WHITELIST,
} from "../shared/freeform.js";
import { DISPLAY_TIME_ZONE, formatInstantAsShanghaiIso } from "../shared/time.js";
import { validateDiagramDeliveryTransition, validateDocumentNodeBinding, validateDocumentReferenceTarget } from "./domain.js";
import {
  ensureManagedProjectDirectory,
  materializeProjectDocument,
  materializeProjectJson,
  syncManagedProject,
} from "./projectFiles.js";
import { buildProjectWorkflow } from "./workflow.js";
import { isInitialProjectBriefApproval } from "./projectBrief.js";
import { changesProtectedRequirement, hasRequirementChangeMarker } from "./nodeRequirementRevision.js";
import { getProjectedProjectWorkspace, listProjectedProjects } from "./projectProjection.js";
import { decideDependencyEdit, isExecutableDeliveryPlan } from "./planPolicy.js";
import { AgentTaskPackageError, buildAgentOrchestration } from "./orchestration.js";
import {
  AgentTaskLeaseError,
  advanceAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForPlanAction,
  assertAgentTaskLeaseForWrite,
  completeAgentTask,
  decorateAgentOrchestrationWithLeases,
  failAgentTask,
  reportDesignGap,
  dismissDesignGap,
  getAgentTaskCapacity,
  heartbeatAgentTask,
  listAgentRunners,
  listAgentWorkerPools,
  listAgentTaskLeases,
  listClaimableAgentTasks,
  isExactCommittedEvidenceRepairStartReplay,
  releaseAgentTask,
  releaseAgentTaskByWorkOrder,
  startAgentTask,
  type StartInput,
  updateAgentTaskCapacity,
} from "./agentTaskLeases.js";
import { PLAN_TRANSITION_ACTIONS, transitionPlanLifecycle } from "./planLifecycle.js";
import { assertEvidenceIdentity } from "./planRolePolicy.js";
import { validatePlanLayerGraph } from "./planLayers.js";
import { checkLlmProfile, llmProfileSummary } from "./llmProfiles.js";
import { DesignChangeError, dismissDesignChangeIntent, requestDesignChange } from "./designChange.js";
import { DesignChangeIntentError, submitDesignChangeIntent } from "./designChangeIntent.js";
import { EvidenceRepairAssessmentError, ImplementationBaselineError, requestEvidenceRepairAssessment, resetImplementationBaseline } from "./evidenceRepair.js";
import { agentProfileProblem, type CodexHarness } from "./agentHarness.js";
import type { AgentUiEventBus, SequencedAgentUiEvent } from "./agentUiEvents.js";
import {
  AGENT_POLICY_VERSION,
  AgentSecurityError,
  assertCoordinationMainAgent,
  acknowledgeAgentPolicy,
  beginAgentAuth,
  completeAgentAuth,
  issueOneTimeNonce,
  registerAgentCredential,
  resolveAuthPrincipal,
  revokeAgentCredential,
} from "./agentSecurity.js";
import { classifyRestRequest } from "./controlledWriteRegistry.js";
import { safeCoordinationHandoff } from "./coordinationHandoff.js";
import {
  checkDatabaseConnection,
  databaseConnectionLabel,
  deployDatabaseModel,
  inspectDatabase,
  previewDatabaseDeploy,
  previewDatabaseReverse,
  snapshotToModel,
} from "./databaseEngineering.js";
import {
  AGENT_COORDINATION_STAGES,
  CoordinationLeaseError,
  claimCoordinationLease,
  heartbeatCoordinationLease,
  listCoordinationLeases,
  dispatchChildTask,
  claimDispatchedChildTask,
  reclaimChildTask,
  reassignChildTask,
  pauseCoordinationLease,
  resumeCoordinationLease,
  releaseCoordinationLease,
  advanceCoordinationStage,
  listChildTaskDispatches,
  assertCoordinationLeaseForPlan,
  recoverCoordinationLeaseAfterRejectedTransaction,
} from "./coordinationLeases.js";

const stageSchema = z.enum(PROJECT_STAGES);
const healthSchema = z.enum(HEALTH_LEVELS);
const prioritySchema = z.enum(PRIORITIES);
const nodeKindSchema = z.enum(NODE_KINDS);
const planKindSchema = z.enum(PLAN_KINDS);
const llmProfileFields = {
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().min(1).max(120),
  protocol: z.enum(LLM_PROTOCOLS),
  baseUrl: z.string().trim().url().max(1000),
  apiKeyEnv: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/, "必须是大写环境变量名").max(120),
  apiKey: z.string().trim().max(2000).optional(),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  defaultModel: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  reasoningEffort: z.enum(LLM_REASONING_EFFORTS).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
};
const agentBlueprintKeySchema = z.enum(["designer", "builder", "auditor", "approver"]);
const agentBlueprintPatchSchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().max(2000),
  responsibilities: z.array(z.string().trim().min(1).max(500)).max(100),
  boundaries: z.array(z.string().trim().min(1).max(500)).max(100),
  allowedMcpTools: z.array(z.string().trim().min(1).max(200)).max(200),
});
const diagramNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(DIAGRAM_NODE_KINDS),
  label: z.string().max(200),
  x: z.number(),
  y: z.number(),
  w: z.number().optional(),
  h: z.number().optional(),
  shape: z.enum(NODE_SHAPES).optional(),
  flowType: z.enum(DIAGRAM_FLOW_NODE_TYPES).optional(),
  useCaseType: z.enum(DIAGRAM_USE_CASE_NODE_TYPES).optional(),
  linkDiagramIds: z.array(z.string()).optional(),
  linkDiagramId: z.string().optional(),
  description: z.string().max(5000).optional(),
  requirementStatus: z.enum(REQUIREMENT_STATUSES).optional(),
  designStatus: z.enum(DESIGN_STATUSES).optional(),
  requiresDatabase: z.boolean().optional(),
  developmentStatus: z.enum(DIAGRAM_DEVELOPMENT_STATUSES).optional(),
  acceptanceStatus: z.enum(DIAGRAM_ACCEPTANCE_STATUSES).optional(),
  owner: z.string().max(200).optional(),
  acceptanceCriteria: z.string().max(10_000).optional(),
  notes: z.string().max(10_000).optional(),
  blockedReason: z.string().max(5000).optional(),
  deliveryUpdatedAt: z.string().max(64).optional(),
  preconditions: z.string().max(10_000).optional(),
  mainFlow: z.string().max(20_000).optional(),
  alternateFlow: z.string().max(20_000).optional(),
  postconditions: z.string().max(10_000).optional(),
});
const agentEntityRefSchema = z.object({
  type: z.enum(["project", "diagram", "diagramNode", "diagramEdge", "designDocument", "databaseModel", "databaseTable", "nodeDatabaseBinding", "plan", "evidence", "governance"]),
  id: z.string().min(1).max(300),
  parentId: z.string().min(1).max(300).optional(),
  label: z.string().max(AGENT_ENTITY_REF_LABEL_MAX_LENGTH).optional(),
});
const agentPageContextSchema = z.object({
  contextId: z.string().min(1).max(300),
  projectId: z.string().min(1).nullable(),
  route: z.string().max(1000),
  title: z.string().max(300),
  pageType: z.enum(["dashboard", "projects", "project", "canvas", "node", "database", "document", "plan", "evidence", "design", "orchestration", "governance", "llm", "audit", "backups", "unknown"]),
  entityRefs: z.array(agentEntityRefSchema).max(100),
  selection: z.object({ entityRefs: z.array(agentEntityRefSchema).max(100) }),
  draft: z.object({
    dirty: z.boolean(),
    baseRevision: z.string().max(100).optional(),
    summary: z.string().max(4000).optional(),
  }).nullable(),
  visibleContent: z.object({
    kind: z.enum(["project", "node", "document", "documentList", "plan", "planList", "agentOrchestration", "databaseModel", "databaseModelList", "databaseTable", "evidenceList", "governanceList"]),
    title: z.string().max(300),
    text: z.string().max(30_000),
    truncated: z.boolean(),
  }).nullable(),
  capturedAt: z.string().max(64),
});

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function agentTaskPackageError(reply: FastifyReply, cause: unknown) {
  if (cause instanceof AgentSecurityError) return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code });
  if (cause instanceof AgentTaskPackageError || cause instanceof AgentTaskLeaseError || cause instanceof CoordinationLeaseError) {
    return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code, ...(cause.details ? { details: cause.details } : {}) });
  }
  throw cause;
}

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw httpError(400, result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  }
  return result.data;
}

/**
 * 局部更新必须保持“缺省即不改动”。字段上的 .default() 被 .partial() 包裹后仍会填入默认值，
 * 会把请求里没提交的字段一并重置（曾导致项目 summary/stage/progress 被静默清空）。
 * 这里按原始请求体出现过的键裁剪解析结果，恢复真正的局部更新语义。
 */
function parsePatch<T>(schema: z.ZodType<T>, payload: unknown): Partial<T> {
  const parsed = parse(schema, payload) as Record<string, unknown>;
  const present = new Set(Object.keys((payload ?? {}) as Record<string, unknown>));
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => present.has(key))) as Partial<T>;
}

interface PageQuery {
  limit?: string;
  offset?: string;
}

function wantsPage(query: PageQuery): boolean {
  return query.limit !== undefined || query.offset !== undefined;
}

function pageWindow(query: PageQuery, defaultLimit = 20): { limit: number; offset: number } {
  const rawLimit = Number(query.limit ?? defaultLimit);
  const rawOffset = Number(query.offset ?? 0);
  const finiteLimit = Number.isFinite(rawLimit) && Number.isInteger(rawLimit) ? rawLimit : defaultLimit;
  const limit = Math.min(Math.max(finiteLimit || defaultLimit, 1), 100);
  const offset = Number.isSafeInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

function paginate<T>(items: T[], query: PageQuery, defaultLimit = 20): Paginated<T> {
  const { limit, offset } = pageWindow(query, defaultLimit);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return {
    total: items.length,
    count: pageItems.length,
    offset,
    items: pageItems,
    hasMore: nextOffset < items.length,
    nextOffset: nextOffset < items.length ? nextOffset : null,
  };
}

function textMatches(value: unknown, q: string | undefined): boolean {
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  return text.toLocaleLowerCase().includes((q ?? "").toLocaleLowerCase());
}

const projectCore = {
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  summary: z.string().max(2000).default(""),
  stage: stageSchema.default("探索"),
  health: healthSchema.default("正常"),
  progress: z.number().int().min(0).max(100).default(0),
  riskLevel: prioritySchema.default("P2"),
  riskSummary: z.string().max(2000).default(""),
  blockerSummary: z.string().max(2000).default(""),
  nextStep: z.string().max(2000).default(""),
  startAt: z.string().max(32).default(""),
  dueAt: z.string().max(32).default(""),
};

export interface ApiOptions {
  store: Store;
  dataDir: string;
  harness: CodexHarness;
  agentUiEvents: AgentUiEventBus;
  trustedInternal?: boolean;
}

interface ActorHint {
  actor?: string;
  source?: "web" | "mcp" | "system";
  correlationId?: string;
  clientId?: string;
  sessionId?: string;
  model?: string;
}

function audit(
  store: Store,
  hint: ActorHint | undefined,
  event: Omit<AuditEvent, "id" | "createdAt" | "actor" | "source">,
): void {
  store.recordAudit({
    ...event,
    actor: hint?.actor?.trim() || "user",
    source: hint?.source ?? "web",
    correlationId: hint?.correlationId,
    clientId: hint?.clientId,
    sessionId: hint?.sessionId,
    model: hint?.model,
  });
}

function projectCreatedPayload(p: Project): Record<string, unknown> {
  return { id: p.id, code: p.code, name: p.name, stage: p.stage, health: p.health };
}

function databaseModelSummary(model: DatabaseModel): Record<string, unknown> {
  return { name: model.name, dialect: model.dialect, tables: model.tables.length, relations: model.relations.length, updatedAt: model.updatedAt };
}

function nodeDatabaseBindingSummary(binding: NodeDatabaseBinding): Record<string, unknown> {
  return {
    diagramId: binding.diagramId,
    diagramNodeId: binding.diagramNodeId,
    databaseModelId: binding.databaseModelId,
    schemaName: binding.schemaName,
    tableName: binding.tableName,
    operations: binding.operations,
    purpose: binding.purpose,
    updatedAt: binding.updatedAt,
  };
}

function assertAgentEntityRefScope(store: Store, projectId: string, ref: AgentEntityRef): void {
  if (ref.type === "project") {
    if (ref.id !== projectId) throw httpError(409, "前端上下文引用了其他项目");
    return;
  }
  if (ref.type === "diagram" || ref.type === "diagramNode" || ref.type === "diagramEdge") {
    const diagramId = ref.type === "diagram" ? ref.id : ref.parentId;
    const diagram = diagramId ? store.getDiagram(diagramId) : undefined;
    if (!diagram || diagram.projectId !== projectId) throw httpError(409, "前端上下文中的画布不属于当前会话项目");
    if (ref.type === "diagramNode" && !diagram.nodes.some((node) => node.id === ref.id)) {
      throw httpError(409, "前端上下文中的画布节点不存在");
    }
    if (ref.type === "diagramEdge" && !diagram.edges.some((edge) => edge.id === ref.id)) {
      throw httpError(409, "前端上下文中的画布连线不存在");
    }
    return;
  }
  if (ref.type === "designDocument") {
    const document = store.getDesignDoc(ref.id);
    if (!document || document.projectId !== projectId) throw httpError(409, "前端上下文中的设计文档不属于当前会话项目");
    return;
  }
  if (ref.type === "databaseModel" || ref.type === "databaseTable") {
    const modelId = ref.type === "databaseModel" ? ref.id : ref.parentId;
    const model = modelId ? store.getDatabaseModel(modelId) : undefined;
    if (!model || model.projectId !== projectId) throw httpError(409, "前端上下文中的数据库模型不属于当前会话项目");
    if (ref.type === "databaseTable" && !model.tables.some((table) => table.id === ref.id)) {
      throw httpError(409, "前端上下文中的数据库表不存在");
    }
    return;
  }
  if (ref.type === "nodeDatabaseBinding") {
    const binding = store.getNodeDatabaseBinding(ref.id);
    if (!binding || binding.projectId !== projectId) throw httpError(409, "前端上下文中的节点数据库关联不属于当前会话项目");
    return;
  }
  if (ref.type === "plan") {
    const plan = store.getPlan(ref.id);
    if (!plan || plan.projectId !== projectId) throw httpError(409, "前端上下文中的计划不属于当前会话项目");
    return;
  }
  if (ref.type === "evidence") {
    const evidence = store.getEvidence(ref.id);
    if (!evidence || evidence.projectId !== projectId) throw httpError(409, "前端上下文中的证据不属于当前会话项目");
    return;
  }
  if (ref.type === "governance") {
    const governance = store.getGovernance(ref.id);
    if (!governance || governance.projectId !== projectId) throw httpError(409, "前端上下文中的治理记录不属于当前会话项目");
  }
}

function assertAgentPageContextScope(store: Store, projectId: string, context: AgentPageContext): void {
  if (context.projectId && context.projectId !== projectId) throw httpError(409, "当前页面与 Agent 会话不属于同一项目");
  const refs = [...context.entityRefs, ...context.selection.entityRefs];
  for (const ref of refs) assertAgentEntityRefScope(store, projectId, ref);
}

function validateNodeDatabaseBindingTarget(
  store: Store,
  binding: Pick<NodeDatabaseBinding, "projectId" | "diagramId" | "diagramNodeId" | "databaseModelId" | "schemaName" | "tableName">,
  bindingId?: string,
): void {
  if (!store.getProject(binding.projectId)) throw httpError(400, "projectId 不存在");
  const diagram = store.getDiagram(binding.diagramId);
  if (!diagram || diagram.projectId !== binding.projectId) throw httpError(400, "画布不存在或不属于当前项目");
  if (diagram.type === "flow") throw httpError(400, "流程图节点只保留基本信息，不支持数据库表关联");
  if (!diagram.nodes.some((node) => node.id === binding.diagramNodeId)) throw httpError(400, "画布节点不存在");
  const model = store.getDatabaseModel(binding.databaseModelId);
  if (!model || model.projectId !== binding.projectId) throw httpError(400, "数据库模型不存在或不属于当前项目");
  if (!model.tables.some((table) => table.name.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase())) throw httpError(400, "数据库模型中不存在该物理表");
  const duplicate = store.listNodeDatabaseBindings({ diagramId: binding.diagramId, diagramNodeId: binding.diagramNodeId })
    .some((item) => item.id !== bindingId
      && item.databaseModelId === binding.databaseModelId
      && item.schemaName.toLocaleLowerCase() === binding.schemaName.toLocaleLowerCase()
      && item.tableName.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase());
  if (duplicate) throw httpError(409, "当前节点已经关联该数据库表");
}

export function registerApi(app: FastifyInstance, options: ApiOptions): void {
  const { store, dataDir, harness, agentUiEvents } = options;

  const sendSecurityError = (reply: FastifyReply, cause: unknown) => {
    if (cause instanceof AgentSecurityError) return reply.code(cause.statusCode).send({ code: cause.code, message: cause.message });
    throw cause;
  };
  const requireAgentAdmin = (authorization: string | undefined) => {
    const configured = process.env.PCS_AGENT_ADMIN_TOKEN ?? "";
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const a = Buffer.from(configured); const b = Buffer.from(supplied);
    if (!configured || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AgentSecurityError(403, "PERMISSION_DENIED", "Protected Agent credential administration requires PCS_AGENT_ADMIN_TOKEN");
    }
  };
  app.addHook("preValidation", async (request, reply) => {
    if (options.trustedInternal) return;
    const requestPath = request.url.split("?")[0];
    if (/^\/api\/agent-security\/(?:auth\/challenge|auth\/complete|policy\/ack|nonces)$/.test(requestPath)
      || /^\/api\/projects\/[^/]+\/agent-task-package$/.test(requestPath)) return;
    // Credential payloads describe the subject being enrolled, not the caller.
    // Authenticate this admin route before applying Worker lease requirements.
    if (request.method === "POST" && /^\/api\/agent-security\/credentials(?:\/[^/]+\/revoke)?$/.test(requestPath)) {
      try { requireAgentAdmin(request.headers.authorization); }
      catch (cause) { return sendSecurityError(reply, cause); }
      return;
    }
    // Coordination operations use the parent lease; claim authenticates separately in its handler.
    if (/^\/api\/projects\/[^/]+\/(?:coordination-leases|child-task-dispatches)(?:\/|$)/.test(requestPath)) return;
    const declaredActor = request.headers["x-productdesign-actor-type"];
    const body = (request.body ?? {}) as Record<string, unknown>;
    const presentsAgentContext = declaredActor !== undefined || ["policyAckToken", "workOrderId", "leaseToken", "agentId", "workerId"].some((key) => body[key] !== undefined);
    if (!presentsAgentContext) return;
    if (declaredActor !== undefined) {
      return reply.code(401).send({ code: "UNTRUSTED_ACTOR_DECLARATION", message: "Client-controlled actor headers are not an authentication mechanism" });
    }
    const risk = classifyRestRequest(request.method, requestPath);
    if (risk === "read") return;
    if (risk === "high") return reply.code(403).send({ code: "HIGH_RISK_HUMAN_REQUIRED", message: "High-risk operations are human-only" });
    // The design-change domain validates its task-scoped lease, including
    // recovery of a committed change that invalidated that same lease.
    if (/^\/api\/projects\/[^/]+\/(?:design-changes|design-change-intents|evidence-repair-assessments)(?:\/[^/]+\/dismiss)?$/.test(requestPath)) return;
    if (request.method === "POST" && requestPath === "/api/agent-task-leases/start"
      && isExactCommittedEvidenceRepairStartReplay(store, body as Partial<StartInput>)) return;
    const required = ["policyAckToken", "workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "idempotencyKey", "nonceId"];
    const missing = required.filter((key) => typeof body[key] !== "string" || !(body[key] as string).trim());
    if (missing.length) return reply.code(409).send({ code: "WORK_ORDER_CONTEXT_INVALID", message: `Missing: ${missing.join(", ")}` });
  });

  app.post("/api/agent-security/credentials", async (request, reply) => {
    try {
      requireAgentAdmin(request.headers.authorization);
      const body = parse(z.object({
        principalId: z.string().min(1).max(200), agentId: z.string().min(1).max(200), workerId: z.string().min(1).max(300),
        allowedRoles: z.array(z.enum(["designer", "builder", "auditor", "approver"])).min(1),
        allowedProjects: z.array(z.string().min(1)).min(1), expiresAt: z.string().datetime().optional(),
      }).strict(), request.body);
      return reply.code(201).send(registerAgentCredential(store, body));
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.post("/api/agent-security/credentials/:credentialId/revoke", async (request, reply) => {
    try {
      requireAgentAdmin(request.headers.authorization);
      revokeAgentCredential(store, (request.params as { credentialId: string }).credentialId);
      return { ok: true };
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.post("/api/agent-security/auth/challenge", async (request, reply) => {
    try {
      const body = parse(z.object({ credentialId: z.string().uuid(), connectionId: z.string().min(16).max(300) }).strict(), request.body);
      return beginAgentAuth(store, body.credentialId, body.connectionId);
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.post("/api/agent-security/auth/complete", async (request, reply) => {
    try {
      const body = parse(z.object({ challengeId: z.string().uuid(), challenge: z.string().min(32), connectionId: z.string().min(16).max(300),
        timestamp: z.string().datetime(), protocolVersion: z.string().min(1).max(100), response: z.string().min(32) }).strict(), request.body);
      return completeAgentAuth(store, body);
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.post("/api/agent-security/policy/ack", async (request, reply) => {
    try {
      const body = parse(z.object({ authSessionToken: z.string().min(32), role: z.enum(["designer", "builder", "auditor", "approver"]),
        projectId: z.string().min(1), policyVersion: z.string().min(1) }).strict(), request.body);
      return acknowledgeAgentPolicy(store, resolveAuthPrincipal(store, body.authSessionToken), body);
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.post("/api/agent-security/nonces", async (request, reply) => {
    try {
      const body = parse(z.object({ policyAckToken: z.string().min(32), workOrderId: z.string().min(1), action: z.string().min(1),
        target: z.string().min(1), bodyDigest: z.string().length(64) }).strict(), request.body);
      return reply.code(201).send(issueOneTimeNonce(store, body));
    } catch (cause) { return sendSecurityError(reply, cause); }
  });
  app.get("/api/agent-security/policy", async () => ({ policyVersion: AGENT_POLICY_VERSION }));

  app.get("/api/health", async () => {
    const time = nowIso();
    return { ok: true, time, localTime: formatInstantAsShanghaiIso(time), timeZone: DISPLAY_TIME_ZONE };
  });

  app.get("/api/projects/:id/agent-events", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    const query = request.query as { after?: string };
    const headerId = request.headers["last-event-id"];
    const afterId = Math.max(0, Number(query.after ?? (Array.isArray(headerId) ? headerId[0] : headerId) ?? 0) || 0);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.setHeader("x-accel-buffering", "no");
    reply.raw.flushHeaders();
    const write = (item: SequencedAgentUiEvent) => {
      if (!reply.raw.destroyed) reply.raw.write(`id: ${item.id}\ndata: ${JSON.stringify(item.event)}\n\n`);
    };
    for (const item of agentUiEvents.since(id, afterId)) write(item);
    const unsubscribe = agentUiEvents.subscribe(id, write);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
    }, 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/dashboard", async () => store.dashboard(listProjectedProjects(store)));

  // ---------- LLM profiles ----------

  app.get("/api/llm-profiles", async () => store.listLlmProfiles());

  app.post("/api/llm-profiles", async (request, reply) => {
    const body = parse(z.object(llmProfileFields), request.body);
    if (!body.models.includes(body.defaultModel)) return reply.code(400).send({ message: "默认模型必须包含在模型列表中" });
    if (store.listLlmProfiles().some((item) => item.name.toLocaleLowerCase() === body.name.toLocaleLowerCase())) {
      return reply.code(409).send({ message: "已存在同名 LLM 配置" });
    }
    const profile = store.insertLlmProfile({ ...body, models: [...new Set(body.models)] });
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "llmProfile", entityId: profile.id,
      action: "create", before: null, after: llmProfileSummary(profile),
    });
    return profile;
  });

  app.patch("/api/llm-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getLlmProfile(id);
    if (!before) return reply.code(404).send({ message: "LLM 配置不存在" });
    const patch = parsePatch(z.object(llmProfileFields).partial(), request.body);
    const next = { ...before, ...patch, models: patch.models ? [...new Set(patch.models)] : before.models };
    if (!next.models.includes(next.defaultModel)) return reply.code(400).send({ message: "默认模型必须包含在模型列表中" });
    if (store.listLlmProfiles().some((item) => item.id !== id && item.name.toLocaleLowerCase() === next.name.toLocaleLowerCase())) {
      return reply.code(409).send({ message: "已存在同名 LLM 配置" });
    }
    const profile = store.updateLlmProfile(id, patch.models ? { ...patch, models: next.models } : patch);
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "llmProfile", entityId: id,
      action: "update", before: llmProfileSummary(before), after: profile ? llmProfileSummary(profile) : null,
    });
    return profile;
  });

  app.delete("/api/llm-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getLlmProfile(id);
    if (!before) return reply.code(404).send({ message: "LLM 配置不存在" });
    store.deleteLlmProfile(id);
    audit(store, request.query as ActorHint, {
      projectId: null, entityType: "llmProfile", entityId: id,
      action: "delete", before: llmProfileSummary(before), after: null,
    });
    return { ok: true };
  });

  app.post("/api/llm-profiles/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = store.getLlmProfile(id);
    if (!profile) return reply.code(404).send({ message: "LLM 配置不存在" });
    const checked = await checkLlmProfile(profile, store.resolveLlmKey(profile));
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "llmProfile", entityId: id,
      action: "test_connection", before: null, after: { ok: checked.ok, status: checked.status, latencyMs: checked.latencyMs },
    });
    return checked;
  });

  // ---------- Agent workbench ----------

  app.get("/api/projects/:id/agent-workspace", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    return store.getAgentWorkspaceSnapshot(id);
  });

  app.patch("/api/projects/:id/agent-workspace", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    const body = parse(z.object({ defaultProfileId: z.string().nullable() }), request.body);
    if (body.defaultProfileId && !store.getLlmProfile(body.defaultProfileId)) throw httpError(400, "默认 LLM 配置不存在");
    const before = store.getAgentWorkspace(id) ?? null;
    const workspace = store.updateAgentWorkspace(id, body.defaultProfileId);
    audit(store, request.body as ActorHint, {
      projectId: id, entityType: "agentWorkspace", entityId: workspace!.id,
      action: "update", before: before ? { defaultProfileId: before.defaultProfileId } : null,
      after: { defaultProfileId: workspace!.defaultProfileId },
    });
    return workspace;
  });

  app.post("/api/agent-sessions", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      profileId: z.string().min(1),
      model: z.string().trim().min(1).max(200),
      title: z.string().trim().min(1).max(160).default("新会话"),
      controlMode: z.enum(AGENT_CONTROL_MODES).default("restricted"),
    }), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "项目不存在");
    const profile = store.getLlmProfile(body.profileId);
    if (!profile) throw httpError(400, "LLM 配置不存在");
    if (!profile.models.includes(body.model)) throw httpError(400, "所选模型不在该 LLM 配置的模型列表中");
    const session = store.insertAgentSession(body);
    const workspace = store.getAgentWorkspace(body.projectId)!;
    if (!workspace.defaultProfileId) store.updateAgentWorkspace(body.projectId, body.profileId);
    audit(store, request.body as ActorHint, {
      projectId: body.projectId, entityType: "agentSession", entityId: session.id,
      action: "create", before: null, after: { profileId: session.profileId, model: session.model, title: session.title, controlMode: session.controlMode },
    });
    return session;
  });

  app.patch("/api/agent-sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getAgentSession(id);
    if (!before) return reply.code(404).send({ message: "Agent 会话不存在" });
    if (before.status === "running" || harness.isRunning(id)) throw httpError(409, "运行中的会话不能修改");
    const patch = parse(z.object({
      title: z.string().trim().min(1).max(160).optional(),
      profileId: z.string().min(1).optional(),
      model: z.string().trim().min(1).max(200).optional(),
      controlMode: z.enum(AGENT_CONTROL_MODES).optional(),
    }), request.body);
    let profileId = before.profileId;
    let model = before.model;
    if (patch.profileId !== undefined || patch.model !== undefined) {
      profileId = patch.profileId ?? before.profileId;
      const profile = store.getLlmProfile(profileId);
      if (!profile) throw httpError(400, "LLM 配置不存在");
      model = patch.model ?? (patch.profileId ? profile.defaultModel : before.model);
      if (!profile.models.includes(model)) throw httpError(400, "所选模型不在该 LLM 配置的模型列表中");
    }
    const changedRuntime = profileId !== before.profileId || model !== before.model;
    const session = store.updateAgentSession(id, { ...patch, profileId, model, ...(changedRuntime ? { codexThreadId: null } : {}) });
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "agentSession", entityId: id,
      action: "update", before: { title: before.title, profileId: before.profileId, model: before.model, controlMode: before.controlMode },
      after: { title: session!.title, profileId: session!.profileId, model: session!.model, controlMode: session!.controlMode },
    });
    return session;
  });

  app.get("/api/agent-sessions/:id/approvals", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getAgentSession(id)) return reply.code(404).send({ message: "Agent 会话不存在" });
    const query = parse(z.object({ status: z.enum(AGENT_APPROVAL_STATUSES).optional() }), request.query);
    return store.listAgentApprovals(id, query.status);
  });

  app.post("/api/agent-approvals/:id/decision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      sessionId: z.string().min(1),
      decision: z.enum(["approve_once", "deny"]),
    }), request.body);
    const before = store.getAgentApproval(id);
    if (!before || before.sessionId !== body.sessionId) return reply.code(404).send({ message: "授权请求不存在" });
    let approval;
    try {
      approval = harness.decideApproval(id, body.sessionId, body.decision);
    } catch (cause) {
      throw httpError(409, cause instanceof Error ? cause.message : "授权请求处理失败");
    }
    audit(store, request.body as ActorHint, {
      projectId: approval.projectId, entityType: "agentApproval", entityId: approval.id,
      action: "decision", before: { status: before.status, decision: before.decision },
      after: { status: approval.status, decision: approval.decision },
    });
    return approval;
  });

  app.delete("/api/agent-sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getAgentSession(id);
    if (!before) return reply.code(404).send({ message: "Agent 会话不存在" });
    const cancelled = await harness.cancelRun(id);
    store.deleteAgentSession(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "agentSession", entityId: id,
      action: "delete", before: { title: before.title, profileId: before.profileId, model: before.model, cancelled }, after: null,
    });
    return { ok: true, cancelled };
  });

  app.get("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getAgentSession(id)) return reply.code(404).send({ message: "Agent 会话不存在" });
    return store.listAgentMessages(id);
  });

  app.post("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getAgentSession(id);
    if (!session) return reply.code(404).send({ message: "Agent 会话不存在" });
    if (session.status === "running" || harness.isRunning(id)) throw httpError(409, "当前会话已有运行中的消息");
    const body = parse(z.object({
      content: z.string().trim().min(1).max(20_000),
      contextEvent: z.object({ type: z.literal("STATE_SNAPSHOT"), snapshot: agentPageContextSchema }).nullable().optional(),
      pageContext: z.union([
        agentPageContextSchema,
        z.object({ route: z.string().max(1000), title: z.string().max(300) }),
      ]).nullable().optional(),
    }), request.body);
    let pageContext: AgentPageContext | null = body.contextEvent?.snapshot ?? null;
    if (!pageContext && body.pageContext) {
      const fullContext = agentPageContextSchema.safeParse(body.pageContext);
      pageContext = fullContext.success ? fullContext.data : {
        contextId: `legacy:${Date.now()}`,
        projectId: session.projectId,
        route: body.pageContext.route,
        title: body.pageContext.title,
        pageType: "unknown",
        entityRefs: [],
        selection: { entityRefs: [] },
        draft: null,
        visibleContent: null,
        capturedAt: nowIso(),
      };
    }
    if (pageContext) assertAgentPageContextScope(store, session.projectId, pageContext);
    const profile = store.getLlmProfile(session.profileId);
    const profileProblem = agentProfileProblem(profile);
    if (profileProblem) throw httpError(409, profileProblem);
    const userMessage = store.insertAgentMessage({
      sessionId: id, projectId: session.projectId, role: "user", content: body.content,
      status: "completed", pageContext,
    });
    const assistantMessage = store.insertAgentMessage({
      sessionId: id, projectId: session.projectId, role: "assistant", content: "",
      status: "queued", pageContext: null,
    });
    const nextTitle = session.title === "新会话" ? body.content.slice(0, 32) : session.title;
    const runningSession = store.updateAgentSession(id, { title: nextTitle, status: "running", lastError: "" })!;
    const contextPrompt = pageContext
      ? `${body.content}\n\n[AG-UI STATE_SNAPSHOT：当前前端上下文]\n${JSON.stringify(pageContext, null, 2)}\n注意：entityRefs 仅用于定位，权威数据必须通过 MCP 读取；visibleContent 是当前前端可见内容，可能包含未保存草稿；draft 标记未保存状态，二者都不得当作已持久化事实。`
      : body.content;
    void harness.runTurn(id, assistantMessage.id, contextPrompt).catch(() => { /* 失败状态由 harness 持久化 */ });
    audit(store, request.body as ActorHint, {
      projectId: session.projectId, entityType: "agentMessage", entityId: userMessage.id,
      action: "send", before: null, after: { sessionId: id, pageContextIncluded: Boolean(pageContext), contextId: pageContext?.contextId },
    });
    return reply.code(202).send({ session: runningSession, userMessage, assistantMessage });
  });

  // ---------- projects ----------

  app.get("/api/projects", async (request) => {
    const query = request.query as PageQuery & { stage?: string; health?: string; q?: string; configured?: "all" | "yes" | "no" };
    const baseProjects = store.listProjects({ q: query.q || undefined });
    const needsDerivedFiltering = Boolean(query.stage || query.health || (query.configured && query.configured !== "all"));
    if (wantsPage(query) && !needsDerivedFiltering) {
      const page = paginate(baseProjects, query);
      return { ...page, items: listProjectedProjects(store, page.items) };
    }
    let projects = listProjectedProjects(store, baseProjects);
    if (!wantsPage(query) && !needsDerivedFiltering) return projects;
    if (query.stage) projects = projects.filter((project) => project.stage === query.stage);
    if (query.health) projects = projects.filter((project) => project.health === query.health);
    if (query.configured === "yes") projects = projects.filter((project) => !project.unconfigured);
    if (query.configured === "no") projects = projects.filter((project) => project.unconfigured);
    return wantsPage(query) ? paginate(projects, query) : projects;
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = getProjectedProjectWorkspace(store, id);
    if (!workspace) return reply.code(404).send({ message: "项目不存在" });
    return workspace.project;
  });

  app.get("/api/projects/:id/workspace", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = getProjectedProjectWorkspace(store, id);
    if (!workspace) return reply.code(404).send({ message: "项目不存在" });
    return workspace;
  });

  app.get("/api/projects/:id/workflow", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = buildProjectWorkflow(store, id);
    if (!workflow) return reply.code(404).send({ message: "项目不存在" });
    return workflow;
  });

  app.post("/api/projects/:id/design-changes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(z.object({
      intentId: z.string().trim().min(1).max(300).optional(),
      diagramId: z.string().trim().min(1).max(300),
      nodeId: z.string().trim().min(1).max(300),
      actor: z.string().trim().min(1).max(200),
      reason: z.string().trim().min(1).max(4000),
      changeSummary: z.string().trim().min(1).max(8000),
      requirementImpact: z.boolean(),
      impactedDocumentIds: z.array(z.string().trim().min(1).max(300)).min(1).max(200),
      impactedPlanIds: z.array(z.string().trim().min(1).max(300)).min(1).max(200),
      reusableWorkSummary: z.string().max(8000).default(""),
      reworkScope: z.string().trim().min(1).max(8000),
      apiImpact: z.string().max(8000).default(""),
      databaseImpact: z.string().max(8000).default(""),
      deploymentImpact: z.string().max(8000).default(""),
      reusableEvidenceIds: z.array(z.string().trim().min(1).max(300)).max(500).optional(),
      expectedUpdatedAt: z.string().trim().min(1).max(100),
      idempotencyKey: z.string().trim().min(1).max(300),
      clientId: z.string().max(300).optional(),
      sessionId: z.string().max(300).optional(),
      model: z.string().max(300).optional(),
      policyAckToken: z.string().max(300).optional(), workOrderId: z.string().max(300).optional(),
      leaseToken: z.string().max(300).optional(), agentId: z.string().max(200).optional(),
      taskKey: z.string().max(2000).optional(), taskRevision: z.string().max(500).optional(),
      workerId: z.string().max(300).optional(), role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
      scopeApprovals: z.array(z.object({
        workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1),
        taskRevision: z.string().min(1), workerId: z.string().min(1), agentId: z.string().min(1),
        role: z.literal("approver"),
        authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(),
        nonceId: z.string().min(1).optional(),
      }).strict()).max(200).optional(),
      authSessionToken: z.string().min(32).optional(),
      nonceId: z.string().max(300).optional(), bodyDigest: z.string().max(128).optional(), connectionId: z.string().max(300).optional(),
    }), request.body);
    try {
      const { workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role, scopeApprovals,
        policyAckToken, authSessionToken, nonceId, bodyDigest, connectionId, ...change } = body;
      const hasAgent = [workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role,
        policyAckToken, nonceId, bodyDigest, connectionId].some((value) => value !== undefined);
      return requestDesignChange(store, { ...change, projectId: id }, {
        source: "web", agent: hasAgent ? { workOrderId, leaseToken, taskKey, taskRevision, workerId, agentId, role,
          authSessionToken, policyAckToken, nonceId } : undefined,
        scopeApprovals,
        securityAction: "rest.request_design_change",
        securityTarget: "rest:/api/projects/:id/design-changes",
      });
    } catch (cause) {
      if (cause instanceof DesignChangeError || cause instanceof AgentSecurityError) {
        return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code });
      }
      throw cause;
    }
  });

  app.get("/api/projects/:id/agent-orchestration", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { includePrompts?: string };
    const orchestration = buildAgentOrchestration(store, id, query.includePrompts !== "false");
    if (!orchestration) return reply.code(404).send({ message: "项目不存在" });
    return decorateAgentOrchestrationWithLeases(store, orchestration);
  });

  const agentTaskPackageQuery = z.object({
    queue: z.enum(["design", "development", "audit"]).optional(),
    taskId: z.string().min(1).max(1000).optional(),
  });

  const agentTaskPackageClaim = z.object({
    role: z.enum(["designer", "builder", "auditor", "approver"]),
    agentId: z.string().trim().min(1).max(200),
    workerId: z.string().trim().min(1).max(300).optional(),
    poolId: z.string().trim().min(1).max(500).optional(),
    taskId: z.string().min(1).max(1000).optional(),
    taskKey: z.string().min(1).max(2000).optional(),
    sessionId: z.string().trim().max(300).optional(),
    runId: z.string().trim().max(300).optional(),
    capabilities: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    leaseSeconds: z.number().int().min(15).max(1800).default(1800),
    idempotencyKey: z.string().trim().min(1).max(300),
  });

  app.get("/api/projects/:id/agent-task-package", async (request, reply) => {
    const { id } = request.params as { id: string };
    parse(agentTaskPackageQuery, request.query);
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    return reply.code(409).send({
      message: "任务包必须通过 POST 原子领取，不能生成未绑定租约的可执行任务包",
      code: "TASK_CLAIM_REQUIRED",
    });
  });

  app.get("/api/projects/:id/agent-tasks", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    const query = request.query as PageQuery & { role?: string; queue?: string; availability?: string };
    let tasks = listClaimableAgentTasks(store, id);
    if (query.role) tasks = tasks.filter((task) => task.requiredRole === query.role);
    if (query.queue) tasks = tasks.filter((task) => task.queue === query.queue);
    if (query.availability === "available") tasks = tasks.filter((task) => task.available);
    if (query.availability === "occupied") tasks = tasks.filter((task) => !task.available);
    return wantsPage(query) ? paginate(tasks, query) : tasks;
  });

  app.get("/api/projects/:id/coordination-handoff", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const query = parse(z.object({
        planId: z.string().trim().min(1).optional(), taskId: z.string().trim().min(1).optional(),
        expectedProposalRevision: z.coerce.number().int().nonnegative().optional(),
        expectedTaskKey: z.string().trim().min(1).optional(), expectedTaskRevision: z.string().trim().min(1).optional(),
      }).strict(), request.query);
      if (Boolean(query.planId) === Boolean(query.taskId))
        throw new CoordinationLeaseError(400, "HANDOFF_TARGET_INVALID", "只能选择一个计划或设计任务");
      const serialized = query.planId
        ? safeCoordinationHandoff(store, id, { planId: query.planId, expectedProposalRevision: query.expectedProposalRevision })
        : safeCoordinationHandoff(store, id, { taskId: query.taskId!, expectedTaskKey: query.expectedTaskKey,
          expectedTaskRevision: query.expectedTaskRevision });
      return { serialized };
    } catch (cause) { return agentTaskPackageError(reply, cause); }
  });

  app.get("/api/projects/:id/agent-task-leases", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    return listAgentTaskLeases(store, id);
  });

  app.post("/api/projects/:id/design-change-intents", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const body = parse(z.object({
        diagramId: z.string().trim().min(1).max(300),
        nodeId: z.string().trim().min(1).max(300),
        rootPlanId: z.string().trim().min(1).max(300),
        reason: z.string().trim().min(1).max(4000),
        changeSummary: z.string().trim().min(1).max(8000),
        expectedUpdatedAt: z.string().trim().min(1).max(100),
        idempotencyKey: z.string().trim().min(1).max(300),
        requestedBy: z.string().trim().max(300).optional(),
      }).strict(), request.body);
      return reply.code(202).send(submitDesignChangeIntent(store, { ...body, projectId: id }));
    } catch (cause) {
      if (cause instanceof DesignChangeIntentError) {
        return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code, details: cause.details });
      }
      throw cause;
    }
  });

  app.post("/api/projects/:id/evidence-repair-assessments", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const body = parse(z.object({
        planId: z.string().trim().min(1).max(300),
        failedWorkOrderId: z.string().trim().min(1).max(300),
        expectedGeneration: z.number().int().min(0),
        expectedRepairUpdatedAt: z.string().trim().min(1).max(100),
        idempotencyKey: z.string().trim().min(1).max(300),
        requestedBy: z.string().trim().max(300).optional(),
      }).strict(), request.body);
      return reply.code(202).send(requestEvidenceRepairAssessment(store, { ...body, projectId: id }));
    } catch (cause) {
      if (cause instanceof EvidenceRepairAssessmentError) {
        return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code, details: cause.details });
      }
      throw cause;
    }
  });

  app.post("/api/projects/:id/design-change-intents/:intentId/dismiss", async (request, reply) => {
    const { id, intentId } = request.params as { id: string; intentId: string };
    const body = parse(z.object({
      reason: z.string().trim().min(1).max(4000), idempotencyKey: z.string().trim().min(1).max(300),
      workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1),
      taskRevision: z.string().min(1), workerId: z.string().min(1), agentId: z.string().min(1), role: z.literal("approver"),
      authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(), nonceId: z.string().min(1).optional(),
      scopeApprovals: z.array(z.object({
        workOrderId: z.string().min(1), leaseToken: z.string().min(1), taskKey: z.string().min(1),
        taskRevision: z.string().min(1), workerId: z.string().min(1), agentId: z.string().min(1), role: z.literal("approver"),
        authSessionToken: z.string().min(32).optional(), policyAckToken: z.string().min(32).optional(), nonceId: z.string().min(1).optional(),
      }).strict()).max(200).optional(),
    }).strict(), request.body);
    try {
      const { reason, idempotencyKey, scopeApprovals, ...agent } = body;
      return dismissDesignChangeIntent(store, { projectId: id, intentId, reason, idempotencyKey }, {
        source: "web", agent, scopeApprovals,
        securityAction: "rest.dismiss_design_change_intent",
        securityTarget: "rest:/api/projects/:id/design-change-intents/:intentId/dismiss",
      });
    } catch (cause) {
      if (cause instanceof DesignChangeError || cause instanceof AgentSecurityError) {
        return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code });
      }
      throw cause;
    }
  });

  // 设计决策：方案 A。人用入口按工单在服务端定位租约，复用原子释放逻辑，绝不把 leaseToken 回传给浏览器。
  app.post("/api/projects/:id/agent-task-leases/:workOrderId/release", async (request, reply) => {
    const { id, workOrderId } = request.params as { id: string; workOrderId: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    const body = parse(z.object({ reason: z.string().trim().min(1).max(4000) }).strict(), request.body);
    try {
      return releaseAgentTaskByWorkOrder(store, { projectId: id, workOrderId, reason: body.reason });
    } catch (cause) {
      return agentTaskPackageError(reply, cause);
    }
  });

  // Main Agent central orchestration: parent lease owns all child dispatches.
  const coordinationIdentity = z.object({ mainAgentId: z.string().trim().min(1).max(200), workerId: z.string().trim().min(1).max(300) });
  const coordinationParent = z.object({ leaseToken: z.string().trim().min(1).max(300), mainAgentId: z.string().trim().min(1).max(200) });
  app.get("/api/projects/:id/coordination-leases", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    return listCoordinationLeases(store, id);
  });
  app.get("/api/projects/:id/coordination-leases/:coordinationLeaseId/dispatches", async (request, reply) => {
    const { id, coordinationLeaseId } = request.params as { id: string; coordinationLeaseId: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    return listChildTaskDispatches(store, id, coordinationLeaseId);
  });
  app.post("/api/projects/:id/coordination-leases", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    try {
      const body = parse(coordinationIdentity.extend({ authSessionToken: z.string().min(32).max(300).optional(), planId: z.string().trim().min(1).max(300).optional(), taskKey: z.string().trim().min(1).max(2000).optional(), taskRevision: z.string().trim().min(1).max(500).optional(), leaseSeconds: z.number().int().min(15).max(1800).default(1800), idempotencyKey: z.string().trim().min(1).max(300) }), request.body);
      return claimCoordinationLease(store, { ...body, authSessionToken: body.authSessionToken || "", projectId: id });
    } catch (cause) { return agentTaskPackageError(reply, cause); }
  });
  app.post("/api/projects/:id/coordination-leases/:coordinationLeaseId/:operation", async (request, reply) => {
    const { id, coordinationLeaseId, operation } = request.params as { id: string; coordinationLeaseId: string; operation: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    try {
      const parent = parse(coordinationParent, request.body);
      const base = { projectId: id, coordinationLeaseId, ...parent };
      if (operation === "heartbeat") return heartbeatCoordinationLease(store, { ...base, leaseSeconds: parse(z.object({ leaseSeconds: z.number().int().min(15).max(1800).default(1800) }), request.body).leaseSeconds });
      if (operation === "pause") return pauseCoordinationLease(store, base);
      if (operation === "resume") return resumeCoordinationLease(store, base);
      if (operation === "release") return releaseCoordinationLease(store, { ...base, reason: parse(z.object({ reason: z.string().trim().max(4000).optional() }), request.body).reason });
      if (operation === "advance") return advanceCoordinationStage(store, { ...base, stage: parse(z.object({ stage: z.enum(AGENT_COORDINATION_STAGES) }), request.body).stage });
      if (operation === "dispatch") {
        const body = parse(z.object({ taskId: z.string().trim().min(1).max(1000), taskKey: z.string().trim().max(2000).optional(), role: z.enum(["designer", "builder", "auditor"]), agentId: z.string().trim().max(200).optional(), workerId: z.string().trim().max(300).optional(), poolId: z.string().trim().max(500).optional() }), request.body);
        return dispatchChildTask(store, { ...base, ...body });
      }
      if (operation === "reclaim") {
        const body = parse(z.object({ dispatchId: z.string().trim().min(1).max(300), reason: z.string().trim().max(4000).optional() }), request.body);
        return reclaimChildTask(store, { ...base, ...body });
      }
      if (operation === "reassign") {
        const body = parse(z.object({ dispatchId: z.string().trim().min(1).max(300), role: z.enum(["designer", "builder", "auditor"]), agentId: z.string().trim().min(1).max(200), workerId: z.string().trim().min(1).max(300), poolId: z.string().trim().max(500).optional(), reason: z.string().trim().max(4000).optional() }), request.body);
        return reassignChildTask(store, { ...base, ...body, taskId: "" });
      }
      return reply.code(404).send({ message: "未知的协调租约操作", code: "COORDINATION_OPERATION_NOT_FOUND" });
    } catch (cause) { return agentTaskPackageError(reply, cause); }
  });
  app.post("/api/projects/:id/child-task-dispatches/:dispatchId/claim", async (request, reply) => {
    const { id, dispatchId } = request.params as { id: string; dispatchId: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在", code: "PROJECT_NOT_FOUND" });
    try {
      const body = parse(z.object({ agentId: z.string().trim().min(1).max(200), workerId: z.string().trim().min(1).max(300), poolId: z.string().trim().max(500).optional(), sessionId: z.string().trim().max(300).optional(), runId: z.string().trim().max(300).optional(), capabilities: z.array(z.string().trim().min(1).max(100)).max(50).default([]), leaseSeconds: z.number().int().min(15).max(1800).default(1800), idempotencyKey: z.string().trim().min(1).max(300) }), request.body);
      return reply.type("application/json").send(JSON.parse(claimDispatchedChildTask(store, { ...body, dispatchId, projectId: id })));
    } catch (cause) { return agentTaskPackageError(reply, cause); }
  });

  app.get("/api/projects/:id/agent-task-capacity", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    return getAgentTaskCapacity(store, id);
  });

  app.patch("/api/projects/:id/agent-task-capacity", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    const body = parse(z.object({
      maxActive: z.number().int().min(1).max(1000).optional(),
      designerMaxActive: z.number().int().min(1).max(1000).optional(),
      builderMaxActive: z.number().int().min(1).max(1000).optional(),
      auditorMaxActive: z.number().int().min(1).max(1000).optional(),
      maxAttempts: z.number().int().min(1).max(1000).optional(),
      retryBackoffSeconds: z.number().int().min(1).max(1000).optional(),
    }).strict(), request.body);
    return updateAgentTaskCapacity(store, id, body);
  });

  app.get("/api/projects/:id/agent-runners", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    return listAgentRunners(store, id);
  });

  app.get("/api/projects/:id/agent-worker-pools", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    return listAgentWorkerPools(store, id);
  });

  app.post("/api/projects/:id/agent-task-package", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parse(agentTaskPackageClaim, request.body);
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    try {
      const payload = claimTaskPackage(store, {
        projectId: id, taskId: body.taskId, taskKey: body.taskKey,
        role: body.role, agentId: body.agentId, workerId: body.workerId,
        poolId: body.poolId, sessionId: body.sessionId, runId: body.runId,
        capabilities: body.capabilities, leaseSeconds: body.leaseSeconds,
        idempotencyKey: body.idempotencyKey,
      }, { actor: body.agentId, source: "web", clientId: "productdesign-web" });
      return reply.type("application/json").send(payload);
    } catch (cause) {
      return agentTaskPackageError(reply, cause);
    }
  });

  const leaseControlBody = z.object({
    leaseToken: z.string().trim().min(1).max(300),
    agentId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(1).max(300),
    workOrderId: z.string().trim().min(1).max(300).optional(),
    taskKey: z.string().trim().min(1).max(2000).optional(),
    taskRevision: z.string().trim().min(1).max(500).optional(),
    workerId: z.string().trim().min(1).max(300).optional(),
    role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
    authSessionToken: z.string().min(32).max(300).optional(),
    policyAckToken: z.string().min(32).max(300).optional(),
    nonceId: z.string().min(1).max(300).optional(),
    connectionId: z.string().min(16).max(300).optional(),
    bodyDigest: z.string().length(64).optional(),
    leaseSeconds: z.number().int().min(15).max(1800).optional(),
    resultDigest: z.string().max(4000).optional(),
    error: z.string().max(4000).optional(),
    sessionId: z.string().max(300).optional(),
    runId: z.string().max(300).optional(),
    workspacePath: z.string().trim().max(2000).optional(),
    workspaceBranch: z.string().trim().max(500).optional(),
    baselineRevision: z.string().trim().max(500).optional(),
    documentRevisionId: z.string().trim().max(300).optional(),
    implementationRevision: z.string().trim().max(300).optional(),
    evidenceId: z.string().trim().max(300).optional(),
    testCommand: z.string().max(2000).optional(),
    verdict: z.enum(["pass", "fail"]).optional(),
    reworkConditions: z.string().max(4000).optional(),
  });

  app.post("/api/agent-task-leases/:operation", async (request, reply) => {
    const { operation } = request.params as { operation: string };
    if (["report-design-gap", "dismiss-design-gap"].includes(operation)) {
      const body = parse(leaseControlBody.extend({
        workOrderId: z.string().trim().min(1), taskKey: z.string().trim().min(1),
        taskRevision: z.string().trim().min(1), workerId: z.string().trim().min(1),
        role: z.enum(["builder", "approver"]), error: z.string().trim().min(1).max(4000),
        impactedPlanIds: z.array(z.string().trim().min(1).max(300)).max(200).optional(),
      }), request.body);
      try {
        return (operation === "report-design-gap" ? reportDesignGap : dismissDesignGap)(store, body,
          { actor: body.agentId, source: "web", clientId: "productdesign-web", sessionId: body.sessionId });
      } catch (cause) { return agentTaskPackageError(reply, cause); }
    }
    const body = parse(leaseControlBody, request.body);
    const context = {
      actor: body.agentId, source: "web" as const, clientId: "productdesign-web", sessionId: body.sessionId,
      securityAction: `rest.${operation}_agent_task`, securityTarget: `rest:/api/agent-task-leases/${operation}`,
    };
    try {
      if (operation === "start") return startAgentTask(store, body, context);
      if (operation === "heartbeat") return heartbeatAgentTask(store, body, context);
      if (operation === "complete") return completeAgentTask(store, body, context);
      if (operation === "fail") return failAgentTask(store, body, context);
      if (operation === "release") return releaseAgentTask(store, body, context);
      return reply.code(404).send({ message: "未知的任务租约操作", code: "LEASE_OPERATION_NOT_FOUND" });
    } catch (cause) {
      return agentTaskPackageError(reply, cause);
    }
  });

  // Recommended-agent blueprints: globally shared, user-editable overrides.
  app.get("/api/agent-blueprints", async () => store.listAgentBlueprintOverrides());

  app.put("/api/agent-blueprints/:key", async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!agentBlueprintKeySchema.safeParse(key).success) return reply.code(400).send({ message: "未知的 Agent 类型" });
    const patch = parse(agentBlueprintPatchSchema, request.body);
    const before = store.getAgentBlueprintOverride(key as AgentBlueprintKey);
    const next = store.upsertAgentBlueprintOverride(key as AgentBlueprintKey, patch);
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "agentBlueprint", entityId: key,
      action: "update",
      before: before ? { key: before.key, name: before.name, purpose: before.purpose } : null,
      after: { key: next.key, name: next.name, purpose: next.purpose },
    });
    return next;
  });

  app.get("/api/projects/:id/workspace-nodes", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    const query = request.query as PageQuery & { q?: string; kind?: string; diagramId?: string; developmentStatus?: string };
    let nodes: ProjectWorkspaceNode[] = store.listProjectWorkspaceNodes(id);
    if (query.diagramId) nodes = nodes.filter((item) => item.diagramId === query.diagramId);
    if (query.kind) nodes = nodes.filter((item) => item.node.kind === query.kind);
    if (query.developmentStatus) nodes = nodes.filter((item) => item.node.developmentStatus === query.developmentStatus);
    if (query.q) nodes = nodes.filter((item) => textMatches(item.node.label, query.q) || textMatches(item.node.description, query.q) || textMatches(item.diagramTitle, query.q));
    return paginate(nodes, query);
  });

  app.post("/api/projects", async (request) => {
    const body = parse(z.object({ ...projectCore }), request.body);
    const code = store.uniqueProjectCode(body.code);
    const project = store.insertProject({ ...body, code, repositoryPath: "" });
    try {
      syncManagedProject(store, dataDir, project);
    } catch (error) {
      store.deleteProject(project.id);
      throw httpError(500, `项目托管目录创建失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    audit(store, request.body as ActorHint, {
      projectId: project.id, entityType: "project", entityId: project.id,
      action: "create", before: null, after: projectCreatedPayload(project),
    });
    return getProjectedProjectWorkspace(store, project.id)?.project ?? project;
  });

  app.patch("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getProject(id);
    if (!before) return reply.code(404).send({ message: "项目不存在" });
    const patch = parsePatch(z.object({
      ...projectCore,
      repositoryPath: z.string().trim().max(2000),
    }).partial(), request.body);
    if (patch.repositoryPath) {
      if (!isAbsolute(patch.repositoryPath)) throw httpError(400, "repositoryPath 必须是绝对目录");
      try {
        if (!statSync(patch.repositoryPath).isDirectory()) throw httpError(400, "repositoryPath 不是目录");
      } catch (cause) {
        if (cause instanceof Error && "statusCode" in cause) throw cause;
        throw httpError(400, "repositoryPath 不存在或当前服务无权访问");
      }
    }
    const project = store.updateProject(id, patch);
    if (project) ensureManagedProjectDirectory(dataDir, project);
    audit(store, request.body as ActorHint, {
      projectId: id, entityType: "project", entityId: id,
      action: "update", before: projectCreatedPayload(before), after: project ? projectCreatedPayload(project) : null,
    });
    return project ? (getProjectedProjectWorkspace(store, id)?.project ?? project) : project;
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getProject(id);
    if (!before) return reply.code(404).send({ message: "项目不存在" });
    store.deleteProject(id);
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "project", entityId: id,
      action: "delete", before: projectCreatedPayload(before), after: null,
    });
    return { ok: true };
  });

  // ---------- work nodes ----------

  app.get("/api/projects/:id/nodes", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as PageQuery & { q?: string };
    let nodes = store.listNodes(id);
    if (query.q) nodes = nodes.filter((node) => textMatches(node.title, query.q) || textMatches(node.description, query.q));
    return wantsPage(query) ? paginate(nodes, query) : nodes;
  });

  const nodeBody = {
    projectId: z.string().min(1),
    parentId: z.string().nullable().default(null),
    kind: nodeKindSchema,
    title: z.string().trim().min(1).max(300),
    description: z.string().max(4000).default(""),
    priority: prioritySchema.default("P2"),
    owner: z.string().max(100).default(""),
    requirementStatus: z.enum(REQUIREMENT_STATUSES).default("待整理"),
    designStatus: z.enum(DESIGN_STATUSES).default("未开始"),
    developmentStatus: z.enum(DEVELOPMENT_STATUSES).default("未开始"),
    testStatus: z.enum(TEST_STATUSES).default("未开始"),
    progress: z.number().int().min(0).max(100).default(0),
    startAt: z.string().max(32).default(""),
    dueAt: z.string().max(32).default(""),
    position: z.number().int().optional(),
  };

  app.post("/api/nodes", async (request) => {
    const body = parse(z.object(nodeBody), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    const node = store.insertNode(body);
    audit(store, request.body as ActorHint, {
      projectId: node.projectId, entityType: "node", entityId: node.id,
      action: "create", before: null, after: { title: node.title, kind: node.kind },
    });
    return node;
  });

  app.patch("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getNode(id);
    if (!before) return reply.code(404).send({ message: "工作节点不存在" });
    const patch = parsePatch(z.object(nodeBody).partial().omit({ projectId: true }), request.body);
    const node = store.updateNode(id, patch);
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "node", entityId: id,
      action: "update", before: { title: before.title }, after: { title: node?.title },
    });
    return node;
  });

  app.delete("/api/nodes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getNode(id);
    if (!before) return reply.code(404).send({ message: "工作节点不存在" });
    store.deleteNode(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "node", entityId: id,
      action: "delete", before: { title: before.title }, after: null,
    });
    return { ok: true };
  });

  // ---------- plan items ----------

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

  app.get("/api/projects/:id/plans", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as PageQuery & { diagramId?: string; diagramNodeId?: string; q?: string; status?: string };
    let plans = store.listPlans(id, query.diagramId || undefined, query.diagramNodeId || undefined);
    if (query.q) plans = plans.filter((plan) => textMatches(plan.title, query.q) || textMatches(plan.description, query.q));
    if (query.status) plans = plans.filter((plan) => plan.status === query.status);
    return wantsPage(query) ? paginate(plans, query) : plans;
  });

  app.get("/api/plans/:id", async (request) => {
    const { id } = request.params as { id: string };
    const plan = store.getPlan(id);
    if (!plan) throw httpError(404, "计划项不存在");
    return plan;
  });

  const planBody = {
    projectId: z.string().min(1),
    diagramId: z.string().nullable().default(null),
    diagramNodeId: z.string().nullable().default(null),
    parentId: z.string().nullable().default(null),
    kind: planKindSchema,
    title: z.string().trim().min(1).max(300),
    description: z.string().max(4000).default(""),
    status: z.enum(PLAN_STATUSES).default("未开始"),
    priority: prioritySchema.default("P2"),
    progress: z.number().int().min(0).max(100).default(0),
    owner: z.string().max(100).default(""),
    roleAssignments: planRoleAssignmentsSchema.default({
      designer: { agentId: "", displayName: "" },
      builder: { agentId: "", displayName: "" },
      auditor: { agentId: "", displayName: "" },
    }),
    versionTag: z.string().max(64).default(""),
    startAt: z.string().max(32).default(""),
    dueAt: z.string().max(32).default(""),
    dependencyIds: z.array(z.string()).default([]),
    blockedReason: z.string().max(2000).default(""),
    completedAt: z.string().max(64).default(""),
  };

  const validatePlanBinding = (projectId: string, diagramId: string | null, diagramNodeId: string | null) => {
    if (!diagramId && !diagramNodeId) return;
    if (!diagramId || !diagramNodeId) throw httpError(400, "画布计划必须同时提供 diagramId 和 diagramNodeId");
    const diagram = store.getDiagram(diagramId);
    if (!diagram || diagram.projectId !== projectId) throw httpError(400, "绑定的画布不存在或不属于当前项目");
    if (!diagram.nodes.some((node) => node.id === diagramNodeId)) throw httpError(400, "绑定的画布节点不存在");
  };

  app.post("/api/plans", async (request) => {
    const body = parse(z.object(planBody), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    validatePlanBinding(body.projectId, body.diagramId, body.diagramNodeId);
    if (body.diagramId && (body.status !== "未开始" || body.progress !== 0 || body.completedAt)) {
      throw httpError(409, "绑定画布节点的开发计划必须从未开始状态创建，并通过施工交付流程推进");
    }
    for (const depId of body.dependencyIds) {
      const dependency = store.getPlan(depId);
      if (!dependency || dependency.projectId !== body.projectId) throw httpError(400, `依赖的计划项不存在或不属于当前项目: ${depId}`);
    }
    const roleErrors = roleAssignmentErrors(body.roleAssignments, false);
    if (roleErrors.length > 0) throw httpError(409, roleErrors.join("；"));
    const plan = store.insertPlan({
      ...body,
      owner: body.roleAssignments.builder.displayName || body.roleAssignments.builder.agentId || body.owner,
      progress: body.status === "已完成" ? 100 : body.progress,
      completedAt: body.status === "已完成" ? (body.completedAt || nowIso()) : "",
      startAt: body.status === "进行中" && !body.startAt ? nowIso().slice(0, 10) : body.startAt,
    });
    if (plan) {
      const pj = store.getProject(plan.projectId);
      if (pj) materializeProjectJson(dataDir, pj.id, "plans", plan.id, plan);
    }
    audit(store, { ...(request.body as ActorHint), correlationId: plan.correlationId }, {
      projectId: plan.projectId, entityType: "plan", entityId: plan.id,
      action: "create", before: null, after: { title: plan.title, kind: plan.kind },
    });
    return plan;
  });

  app.patch("/api/plans/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getPlan(id);
    if (!before) return reply.code(404).send({ message: "计划项不存在" });
    const patch = parse(z.object({
      diagramId: z.string().nullable().optional(),
      diagramNodeId: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      kind: planKindSchema.optional(),
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(4000).optional(),
      status: z.enum(PLAN_STATUSES).optional(),
      priority: prioritySchema.optional(),
      progress: z.number().int().min(0).max(100).optional(),
      owner: z.string().max(100).optional(),
      roleAssignments: planRoleAssignmentsSchema.optional(),
      versionTag: z.string().max(64).optional(),
      startAt: z.string().max(32).optional(),
      dueAt: z.string().max(32).optional(),
      dependencyIds: z.array(z.string()).optional(),
      blockedReason: z.string().max(2000).optional(),
      completedAt: z.string().max(64).optional(),
    }), request.body);
    const diagramId = patch.diagramId === undefined ? before.diagramId : patch.diagramId;
    const diagramNodeId = patch.diagramNodeId === undefined ? before.diagramNodeId : patch.diagramNodeId;
    validatePlanBinding(before.projectId, diagramId, diagramNodeId);
    const dependencyDecision = patch.dependencyIds === undefined
      ? { allowed: true, lifecyclePatch: {} }
      : decideDependencyEdit(before, patch.dependencyIds);
    if (!dependencyDecision.allowed) throw httpError(409, dependencyDecision.message || "计划依赖当前不可修改");
    if (patch.dependencyIds !== undefined) {
      for (const dependencyId of patch.dependencyIds) {
        const dependency = store.getPlan(dependencyId);
        if (!dependency || dependency.projectId !== before.projectId) throw httpError(400, `依赖的计划项不存在或不属于当前项目: ${dependencyId}`);
        if (dependency.id === before.id) throw httpError(400, "计划项不能依赖自己");
      }
      const candidate = { ...before, dependencyIds: patch.dependencyIds } as PlanItem;
      const graphIssue = validatePlanLayerGraph(store.listPlans(before.projectId).map((plan) => plan.id === before.id ? candidate : plan));
      if (graphIssue) throw httpError(409, graphIssue);
    }
    const normalizedPatch = {
      ...patch,
      ...dependencyDecision.lifecyclePatch,
      ...(patch.roleAssignments ? { owner: patch.roleAssignments.builder.displayName || patch.roleAssignments.builder.agentId || before.owner } : {}),
      ...(patch.status === "已完成" ? { progress: 100, completedAt: patch.completedAt || nowIso() } : {}),
      ...(patch.status && patch.status !== "已完成" ? { completedAt: "" } : {}),
      ...(patch.status === "进行中" && !before.startAt && !patch.startAt ? { startAt: nowIso().slice(0, 10) } : {}),
    };
    if (patch.roleAssignments) {
      const roleErrors = roleAssignmentErrors(patch.roleAssignments, false);
      if (roleErrors.length > 0) throw httpError(409, roleErrors.join("；"));
    }
    // 该守卫只保护可执行的开发计划（task）：它们的交付状态必须由施工交付流程汇总。
    // goal/milestone/version 仅用于计划层级，无法进入施工交付流程（见 transitionPlanLifecycle），
    // 若一并拦截会使其状态再无合法更新入口。
    const controlled = Boolean(diagramId && diagramNodeId) && isExecutableDeliveryPlan(before);
    if (controlled && (patch.status !== undefined || patch.progress !== undefined || patch.completedAt !== undefined)) {
      throw httpError(409, "绑定画布节点的开发计划必须通过施工交付流程推进状态");
    }
    const plan = store.updatePlan(id, normalizedPatch);
    if (plan) {
      const pj = store.getProject(plan.projectId);
      if (pj) materializeProjectJson(dataDir, pj.id, "plans", plan.id, plan);
    }
    audit(store, { ...(request.body as ActorHint), correlationId: before.correlationId || before.id }, {
      projectId: before.projectId, entityType: "plan", entityId: id,
      action: "update", before: { title: before.title }, after: { title: plan?.title },
    });
    return plan;
  });

  app.post("/api/plans/:id/transition", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getPlan(id);
    if (!before) return reply.code(404).send({ message: "计划项不存在" });
    const body = parse(z.object({
      action: z.enum(PLAN_TRANSITION_ACTIONS),
      actor: z.string().trim().min(1).max(100),
      agentId: z.string().trim().max(200).optional(),
      leaseToken: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().trim().max(300).optional(),
      reason: z.string().max(4000).optional(),
      implementationRevision: z.string().max(200).optional(),
      evidenceId: z.string().trim().max(300).optional(),
      testCommand: z.string().max(2000).optional(),
      repairDisposition: z.enum(["reset", "design_change"]).optional(),
      correlationId: z.string().max(300).optional(),
      clientId: z.string().max(300).optional(),
      sessionId: z.string().max(300).optional(),
      model: z.string().max(300).optional(),
      policyAckToken: z.string().max(300).optional(), workOrderId: z.string().max(300).optional(),
      taskKey: z.string().max(2000).optional(), taskRevision: z.string().max(500).optional(),
      workerId: z.string().max(300).optional(), role: z.enum(["designer", "builder", "auditor", "approver"]).optional(),
      nonceId: z.string().max(300).optional(), bodyDigest: z.string().max(128).optional(), connectionId: z.string().max(300).optional(),
      coordinationLeaseId: z.string().trim().max(300).optional(), coordinationLeaseToken: z.string().trim().max(300).optional(),
    }), request.body);
    let plan;
    try {
      plan = store.db.transaction(() => {
        const parentActions = new Set(["approve_plan", "reject_plan", "approve_acceptance", "reject_acceptance"]);
        const usingParent = parentActions.has(body.action) && Boolean(body.coordinationLeaseId);
        if (body.coordinationLeaseId && !usingParent) throw Object.assign(new Error("父协调租约只能用于 Main Agent 的批准或验收动作"), { statusCode: 409, code: "COORDINATION_ACTION_FORBIDDEN" });
        const parentToken = body.coordinationLeaseToken || (!body.workOrderId ? body.leaseToken : "");
        const coordination = usingParent
          ? assertCoordinationLeaseForPlan(store, { projectId: before.projectId, planId: id, coordinationLeaseId: body.coordinationLeaseId!, coordinationLeaseToken: parentToken || "", mainAgentId: body.agentId || body.actor })
          : null;
        if (coordination) {
          const expectedStage = body.action.endsWith("acceptance") ? "acceptance" : "approval";
          if (coordination.stage !== expectedStage) throw Object.assign(new Error(`父协调租约当前阶段为 ${coordination.stage}，不能执行 ${body.action}`), { statusCode: 409, code: "COORDINATION_STAGE_MISMATCH" });
        }
        const lease = coordination ? null : assertAgentTaskLeaseForPlanAction(store, {
          leaseToken: body.leaseToken,
          agentId: body.agentId,
          planId: id,
          action: body.action,
          securityContext: {
            policyAckToken: body.policyAckToken, workOrderId: body.workOrderId, taskKey: body.taskKey,
            taskRevision: body.taskRevision, workerId: body.workerId, role: body.role, nonceId: body.nonceId,
            bodyDigest: body.bodyDigest, connectionId: body.connectionId, idempotencyKey: body.idempotencyKey,
          },
        });
        const next = transitionPlanLifecycle(store, id, { ...body, agentId: coordination?.mainAgentId || body.agentId, baselineRevision: lease?.baselineRevision });
        if (!coordination) advanceAgentTaskLeaseForPlanAction(store, lease, {
          action: body.action,
          agentId: body.agentId,
          idempotencyKey: body.idempotencyKey,
          resultDigest: body.implementationRevision || body.reason || `${body.action}:${id}`,
          evidenceId: body.evidenceId,
          testCommand: body.testCommand,
          implementationRevision: body.implementationRevision,
        }, { actor: body.actor, source: "web", clientId: body.clientId, sessionId: body.sessionId, model: body.model });
        return next;
      }).immediate();
    } catch (cause) {
      recoverCoordinationLeaseAfterRejectedTransaction(store, before.projectId, cause);
      if (cause instanceof AgentTaskLeaseError || cause instanceof CoordinationLeaseError) return agentTaskPackageError(reply, cause);
      throw cause;
    }
    const project = store.getProject(plan.projectId);
    if (project) materializeProjectJson(dataDir, project.id, "plans", plan.id, plan);
    audit(store, { ...body, correlationId: body.correlationId || plan.correlationId || plan.id }, {
      projectId: plan.projectId, entityType: "plan", entityId: plan.id, action: body.action,
      before: { lifecycleStatus: before.lifecycleStatus, status: before.status, auditStatus: before.auditStatus, managerDecision: before.managerDecision },
      after: { lifecycleStatus: plan.lifecycleStatus, status: plan.status, auditStatus: plan.auditStatus, managerDecision: plan.managerDecision, reason: body.reason ?? "" },
    });
    return plan;
  });

  // 受控管理通道：清空计划记录的脏/过期 implementationRevision，并把证据修复态重置为 open，
  // 使计划回到已验证可行的 submit_evidence_repair 路径。对 accepted 计划开放；
  // 另对「pending_audit 且修复态 submitted」的历史提交开放（审计修订撞车，需回滚重提）。
  app.post("/api/plans/:id/implementation-baseline/reset", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const body = parse(z.object({
        actor: z.string().trim().min(1).max(100),
        reason: z.string().trim().min(10).max(4000),
        confirm: z.literal("RESET-IMPLEMENTATION-BASELINE"),
      }).strict(), request.body);
      const plan = resetImplementationBaseline(store, { planId: id, actor: body.actor, reason: body.reason });
      const project = store.getProject(plan.projectId);
      if (project) materializeProjectJson(dataDir, project.id, "plans", plan.id, plan);
      return plan;
    } catch (cause) {
      if (cause instanceof ImplementationBaselineError) {
        return reply.code(cause.statusCode).send({ message: cause.message, code: cause.code, details: cause.details });
      }
      throw cause;
    }
  });

  app.delete("/api/plans/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getPlan(id);
    if (!before) return reply.code(404).send({ message: "计划项不存在" });
    store.deletePlan(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "plan", entityId: id,
      action: "delete", before: { title: before.title }, after: null,
    });
    return { ok: true };
  });

  // ---------- evidence ----------

  app.get("/api/projects/:id/evidence", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as PageQuery & { q?: string; status?: string; nodeId?: string; planItemId?: string };
    if (wantsPage(query)) {
      const { limit, offset } = pageWindow(query);
      return store.listEvidencePage({
        projectId: id,
        nodeId: query.nodeId || undefined,
        planItemId: query.planItemId || undefined,
        q: query.q || undefined,
        resultStatus: query.status as Evidence["resultStatus"] | undefined,
        limit,
        offset,
      });
    }
    let evidence = store.listEvidence(id, query.nodeId || undefined);
    if (query.planItemId) evidence = evidence.filter((item) => item.planItemId === query.planItemId);
    if (query.q) evidence = evidence.filter((item) => textMatches(item.summary, query.q) || textMatches(item.sourcePath, query.q));
    if (query.status) evidence = evidence.filter((item) => item.resultStatus === query.status);
    return evidence;
  });

  app.post("/api/evidence", async (request, reply) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      nodeId: z.string().nullable().default(null),
      sourceType: z.enum(["git", "maven", "junit", "playwright", "manual"]).default("manual"),
      sourcePath: z.string().max(1000).default(""),
      command: z.string().max(1000).default(""),
      resultStatus: z.enum(["pass", "warn", "fail", "info"]).default("info"),
      summary: z.string().trim().min(1).max(2000),
      commitSha: z.string().max(300).default(""),
      details: z.record(z.string(), z.unknown()).default({}),
      planItemId: z.string().nullable().default(null),
      actorRole: z.enum(PLAN_AGENT_ROLES).nullable().default(null),
      agentId: z.string().max(200).default(""),
      leaseToken: z.string().max(300).optional(),
      idempotencyKey: z.string().max(300).optional(),
      acceptanceCriterionKey: z.string().max(300).default(""),
      documentRevisionId: z.string().nullable().default(null),
      sessionId: z.string().nullable().default(null),
      runId: z.string().max(300).default(""),
      supersedesEvidenceId: z.string().nullable().default(null),
    }), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    const evidenceNodeBindingError = validateDocumentNodeBinding(store, body.projectId, body.nodeId);
    if (evidenceNodeBindingError) throw httpError(400, evidenceNodeBindingError);
    const evidencePlan = body.planItemId ? store.getPlan(body.planItemId) : undefined;
    if (body.planItemId && evidencePlan?.projectId !== body.projectId) throw httpError(400, "planItemId 不存在或不属于当前项目");
    if (evidencePlan) {
      try {
        assertEvidenceIdentity(evidencePlan, body.actorRole, body.agentId);
        if (body.actorRole) {
          if (!body.idempotencyKey?.trim()) throw new AgentTaskLeaseError(400, "IDEMPOTENCY_KEY_REQUIRED", "Agent 证据写入必须提供 idempotencyKey");
          assertAgentTaskLeaseForWrite(store, {
            leaseToken: body.leaseToken,
            agentId: body.agentId,
            planId: evidencePlan.id,
            role: body.actorRole,
            auditScope: body.details.auditScope === "design" || body.details.auditScope === "implementation"
              ? body.details.auditScope
              : null,
          });
        }
      } catch (cause) {
        if (cause instanceof AgentTaskLeaseError) return agentTaskPackageError(reply, cause);
        throw cause;
      }
    }
    if (body.documentRevisionId && store.getDocumentRevision(body.documentRevisionId)?.projectId !== body.projectId) throw httpError(400, "documentRevisionId 不存在或不属于当前项目");
    if (body.supersedesEvidenceId && store.getEvidence(body.supersedesEvidenceId)?.projectId !== body.projectId) throw httpError(400, "supersedesEvidenceId 不存在或不属于当前项目");
    const { leaseToken: _leaseToken, idempotencyKey: _idempotencyKey, ...evidenceBody } = body;
    const evidence = store.insertEvidence({
      ...evidenceBody,
      digest: "",
      collectedAt: nowIso(),
    });
    if (evidence) {
      const pj = store.getProject(evidence.projectId);
      if (pj) materializeProjectJson(dataDir, pj.id, "evidence", evidence.id, evidence);
    }
    const linkedPlan = evidence.planItemId ? store.getPlan(evidence.planItemId) : undefined;
    audit(store, {
      ...(request.body as ActorHint),
      correlationId: (request.body as ActorHint).correlationId || linkedPlan?.correlationId || linkedPlan?.id,
      sessionId: evidence.sessionId || (request.body as ActorHint).sessionId,
    }, {
      projectId: evidence.projectId, entityType: "evidence", entityId: evidence.id,
      action: "create", before: null, after: { summary: evidence.summary.slice(0, 120), sourceType: evidence.sourceType },
    });
    return evidence;
  });

  app.post("/api/projects/:id/evidence/collect", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = store.getProject(id);
    if (!project) return reply.code(404).send({ message: "项目不存在" });
    const body = parse(z.object({ source: z.enum(["git"]).default("git") }), request.body ?? {});
    if (!project.repositoryPath) throw httpError(400, "该项目未设置 repositoryPath，无法采集");
    if (body.source === "git") {
      const collected = await collectGitEvidence(project.repositoryPath);
      const evidence = store.insertEvidence({ ...collected, projectId: id, nodeId: null, collectedAt: nowIso() });
      audit(store, request.body as ActorHint, {
        projectId: id, entityType: "evidence", entityId: evidence.id,
        action: "collect", before: null,
        after: { sourceType: "git", digest: evidence.digest, summary: evidence.summary.slice(0, 120) },
      });
      return evidence;
    }
    throw httpError(400, `暂不支持的采集源: ${body.source}`);
  });

  app.delete("/api/evidence/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getEvidence(id);
    if (!before) return reply.code(404).send({ message: "证据记录不存在" });
    const query = request.query as ActorHint & { reason?: string };
    const reason = query.reason || "由用户撤销";
    store.deleteEvidence(id, reason);
    audit(store, query, {
      projectId: before.projectId, entityType: "evidence", entityId: id,
      action: "revoke", before: { summary: before.summary.slice(0, 120), status: before.status }, after: { status: "revoked", reason },
    });
    return { ok: true };
  });

  // ---------- governance ----------

  app.get("/api/governance", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; q?: string; status?: string; type?: string };
    let records = store.listGovernance(query.projectId || undefined);
    if (query.q) records = records.filter((record) => textMatches(record.title, query.q) || textMatches(record.content, query.q) || textMatches(record.rationale, query.q));
    if (query.status) records = records.filter((record) => record.status === query.status);
    if (query.type) records = records.filter((record) => record.type === query.type);
    return wantsPage(query) ? paginate(records, query) : records;
  });

  app.post("/api/governance", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      type: z.enum(["decision", "opinion"]).default("decision"),
      title: z.string().trim().min(1).max(300),
      content: z.string().max(8000).default(""),
      rationale: z.string().max(4000).default(""),
      status: z.enum(["有效", "待确认", "已替代"]).default("有效"),
      author: z.string().max(100).default(""),
    }), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    const record = store.insertGovernance(body);
    audit(store, request.body as ActorHint, {
      projectId: record.projectId, entityType: "governance", entityId: record.id,
      action: "create", before: null, after: { title: record.title, type: record.type },
    });
    return record;
  });

  app.patch("/api/governance/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getGovernance(id);
    if (!before) return reply.code(404).send({ message: "治理记录不存在" });
    const patch = parse(z.object({
      type: z.enum(["decision", "opinion"]).optional(),
      title: z.string().trim().min(1).max(300).optional(),
      content: z.string().max(8000).optional(),
      rationale: z.string().max(4000).optional(),
      status: z.enum(["有效", "待确认", "已替代"]).optional(),
      author: z.string().max(100).optional(),
    }), request.body);
    const record = store.updateGovernance(id, patch);
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "governance", entityId: id,
      action: "update", before: { title: before.title, status: before.status },
      after: record ? { title: record.title, status: record.status } : null,
    });
    return record;
  });

  app.delete("/api/governance/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getGovernance(id);
    if (!before) return reply.code(404).send({ message: "治理记录不存在" });
    store.deleteGovernance(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "governance", entityId: id,
      action: "delete", before: { title: before.title }, after: null,
    });
    return { ok: true };
  });

  // ---------- design docs ----------

  app.get("/api/design-docs", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; q?: string; status?: string; category?: string; targetType?: string; targetId?: string };
    if (wantsPage(query)) {
      const { limit, offset } = pageWindow(query);
      return store.listDesignDocsPage({
        projectId: query.projectId || undefined,
        q: query.q || undefined,
        status: query.status as (typeof DESIGN_DOC_STATUSES)[number] | undefined,
        category: query.category as (typeof DESIGN_DOC_CATEGORIES)[number] | undefined,
        targetType: query.targetType as (typeof DOCUMENT_REFERENCE_TARGET_TYPES)[number] | undefined,
        targetId: query.targetId || undefined,
        limit,
        offset,
      });
    }
    let docs = store.listDesignDocs(query.projectId || undefined);
    if (query.q) docs = docs.filter((doc) => textMatches(doc.title, query.q) || textMatches(doc.summary, query.q) || textMatches(doc.content, query.q));
    if (query.status) docs = docs.filter((doc) => doc.status === query.status);
    if (query.category) docs = docs.filter((doc) => doc.category === query.category);
    if (query.targetType && query.targetId) {
      const ids = new Set(store.listDocumentReferences({
        projectId: query.projectId,
        targetType: query.targetType as never,
        targetId: query.targetId,
      }).map((reference) => reference.documentId));
      docs = docs.filter((doc) => ids.has(doc.id));
    }
    return docs;
  });

  app.get("/api/design-docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = parse(z.object({
      projectId: z.string().min(1).optional(),
      revisionId: z.string().min(1).optional(),
      contentOffset: z.coerce.number().int().min(0).default(0),
      maxContentChars: z.coerce.number().int().min(1000).max(12000).default(8000),
    }), request.query);
    const document = store.getDesignDoc(id);
    if (!document || (query.projectId && document.projectId !== query.projectId)) {
      return reply.code(404).send({ message: "设计文档不存在或不属于当前项目", code: "DOCUMENT_NOT_FOUND" });
    }
    const revision = store.getDocumentRevision(query.revisionId || document.currentRevisionId);
    if (!revision || revision.documentId !== document.id || revision.projectId !== document.projectId) {
      return reply.code(404).send({ message: "文档版本不存在或不属于该文档", code: "DOCUMENT_REVISION_NOT_FOUND" });
    }
    const start = Math.min(query.contentOffset, revision.content.length);
    const content = revision.content.slice(start, start + query.maxContentChars);
    const nextContentOffset = start + content.length < revision.content.length ? start + content.length : null;
    return {
      id: document.id,
      projectId: document.projectId,
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
    };
  });

  app.post("/api/design-docs", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      category: z.enum(DESIGN_DOC_CATEGORIES).default("需求文档"),
      title: z.string().trim().min(1).max(300),
      summary: z.string().max(2000).default(""),
      status: z.enum(DESIGN_DOC_STATUSES).default("草拟"),
      version: z.string().max(64).default("v0.1"),
      author: z.string().max(100).default(""),
      sourceUrl: z.string().max(2000).default(""),
      content: z.string().max(100_000).default(""),
      references: z.array(z.object({
        targetType: z.enum(DOCUMENT_REFERENCE_TARGET_TYPES),
        targetId: z.string().min(1),
        relationType: z.enum(DOCUMENT_REFERENCE_RELATION_TYPES).default("references"),
      })).max(100).default([]),
    }), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    for (const reference of body.references) {
      const targetError = validateDocumentReferenceTarget(store, body.projectId, reference.targetType, reference.targetId);
      if (targetError) throw httpError(400, targetError);
    }
    if (body.status === "已批准" && body.references.some((reference) => reference.targetType === "project"
      && reference.targetId === body.projectId && reference.relationType === "defines")
      && isInitialProjectBriefApproval(store, body.projectId, { id: "", category: body.category })) {
      throw httpError(409, "首个项目简报必须经独立设计审计和 Main Agent 工单批准");
    }
    const { references, ...documentInput } = body;
    const doc = store.insertDesignDoc(documentInput);
    for (const reference of references) store.insertDocumentReference({ ...reference, projectId: doc.projectId, documentId: doc.id });
    const project = store.getProject(body.projectId);
    if (project) materializeProjectDocument(dataDir, project.id, doc);
    audit(store, request.body as ActorHint, {
      projectId: doc.projectId, entityType: "designDoc", entityId: doc.id,
      action: "create", before: null, after: { title: doc.title, status: doc.status },
    });
    return doc;
  });

  app.patch("/api/design-docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDesignDoc(id);
    if (!before) return reply.code(404).send({ message: "设计文档不存在" });
    const patch = parse(z.object({
      category: z.enum(DESIGN_DOC_CATEGORIES).optional(),
      title: z.string().trim().min(1).max(300).optional(),
      summary: z.string().max(2000).optional(),
      status: z.enum(DESIGN_DOC_STATUSES).optional(),
      version: z.string().max(64).optional(),
      author: z.string().max(100).optional(),
      sourceUrl: z.string().max(2000).optional(),
      content: z.string().max(100_000).optional(),
    }), request.body);
    if (patch.status === "已批准" && isInitialProjectBriefApproval(store, before.projectId,
      { id: before.id, category: patch.category ?? before.category })) {
      throw httpError(409, "首个项目简报必须经独立设计审计和 Main Agent 工单批准");
    }
    const doc = store.updateDesignDoc(id, patch);
    if (doc) {
      const project = store.getProject(doc.projectId);
      if (project) materializeProjectDocument(dataDir, project.id, doc);
    }
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "designDoc", entityId: id,
      action: "update", before: { title: before.title, status: before.status },
      after: doc ? { title: doc.title, status: doc.status, version: doc.version } : null,
    });
    return doc;
  });

  app.delete("/api/design-docs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDesignDoc(id);
    if (!before) return reply.code(404).send({ message: "设计文档不存在" });
    store.deleteDesignDoc(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "designDoc", entityId: id,
      action: "delete", before: { title: before.title }, after: null,
    });
    return { ok: true };
  });

  app.get("/api/design-docs/:id/revisions", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getDesignDoc(id)) return reply.code(404).send({ message: "设计文档不存在" });
    return store.listDocumentRevisions(id);
  });

  app.get("/api/document-references", async (request) => {
    const query = request.query as { projectId?: string; documentId?: string; targetType?: string; targetId?: string };
    return store.listDocumentReferences({
      projectId: query.projectId,
      documentId: query.documentId,
      targetType: query.targetType as never,
      targetId: query.targetId,
    });
  });

  app.post("/api/document-references", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      documentId: z.string().min(1),
      documentRevisionId: z.string().min(1).optional(),
      targetType: z.enum(DOCUMENT_REFERENCE_TARGET_TYPES),
      targetId: z.string().min(1),
      relationType: z.enum(DOCUMENT_REFERENCE_RELATION_TYPES).default("references"),
    }), request.body);
    const document = store.getDesignDoc(body.documentId);
    if (!document || document.projectId !== body.projectId) throw httpError(400, "设计文档不存在或不属于当前项目");
    const targetError = validateDocumentReferenceTarget(store, body.projectId, body.targetType, body.targetId);
    if (targetError) throw httpError(400, targetError);
    if (body.targetType === "project" && body.targetId === body.projectId && body.relationType === "defines"
      && document.status === "已批准"
      && isInitialProjectBriefApproval(store, body.projectId, { id: "", category: document.category })) {
      throw httpError(409, "首个项目简报必须经独立设计审计和 Main Agent 工单批准");
    }
    const reference = store.insertDocumentReference(body);
    audit(store, request.body as ActorHint, {
      projectId: body.projectId, entityType: "documentReference", entityId: reference.id,
      action: "create", before: null, after: { documentId: body.documentId, targetType: body.targetType, targetId: body.targetId, relationType: body.relationType },
    });
    return reference;
  });

  app.patch("/api/document-references/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDocumentReference(id);
    if (!before) return reply.code(404).send({ message: "文档引用不存在" });
    const body = parse(z.object({ documentRevisionId: z.string().min(1).optional(), useCurrentRevision: z.boolean().optional() }), request.body);
    const document = store.getDesignDoc(before.documentId);
    if (!document) return reply.code(404).send({ message: "设计文档不存在" });
    const revisionId = body.useCurrentRevision ? document.currentRevisionId : body.documentRevisionId;
    if (!revisionId) throw httpError(400, "必须提供 documentRevisionId 或 useCurrentRevision=true");
    const revision = store.getDocumentRevision(revisionId);
    if (!revision || revision.documentId !== document.id) throw httpError(400, "文档版本不存在或不属于当前文档");
    if (revision.status !== "已批准") throw httpError(409, "文档版本尚未批准，不能刷新业务引用");
    const reference = store.updateDocumentReferenceRevision(id, revisionId);
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "documentReference", entityId: id,
      action: "update", before: { documentRevisionId: before.documentRevisionId }, after: { documentRevisionId: reference?.documentRevisionId },
    });
    return reference;
  });

  app.delete("/api/document-references/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDocumentReference(id);
    if (!before) return reply.code(404).send({ message: "文档引用不存在" });
    store.deleteDocumentReference(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "documentReference", entityId: id,
      action: "delete", before: { documentId: before.documentId, targetType: before.targetType, targetId: before.targetId }, after: null,
    });
    return { ok: true };
  });

  // ---------- database models ----------

  app.post("/api/database-connections/check", async (request) => {
    const body = parse(z.object({ connection: databaseConnectionSchema }).strict(), request.body);
    return checkDatabaseConnection(body.connection);
  });

  app.post("/api/database-models/import/preview", async (request) => {
    const body = parse(z.object({ projectId: z.string().min(1), name: z.string().trim().min(1).max(200), connection: databaseConnectionSchema }).strict(), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    if (store.listDatabaseModels(body.projectId).some((model) => model.name.toLowerCase() === body.name.toLowerCase())) throw httpError(409, "当前项目已存在同名数据库模型");
    return previewDatabaseReverse({ tables: [], relations: [] }, body.connection);
  });

  app.post("/api/database-models/import", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1), name: z.string().trim().min(1).max(200), connection: databaseConnectionSchema,
      actor: z.string().max(100).optional(), source: z.enum(["web", "mcp", "system"] as const).optional(),
    }).strict(), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    if (store.listDatabaseModels(body.projectId).some((model) => model.name.toLowerCase() === body.name.toLowerCase())) throw httpError(409, "当前项目已存在同名数据库模型");
    const snapshot = await inspectDatabase(body.connection);
    const errors = validateDatabaseModel({ name: body.name, dialect: snapshot.dialect, tables: snapshot.tables, relations: snapshot.relations }).filter((issue) => issue.severity === "error");
    if (errors.length) throw httpError(400, errors.map((issue) => issue.message).join("; "));
    const model = store.insertDatabaseModel({ projectId: body.projectId, name: body.name, dialect: snapshot.dialect, tables: snapshot.tables, relations: snapshot.relations });
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "reverse_import", before: null, after: { ...databaseModelSummary(model), target: databaseConnectionLabel(body.connection) } });
    return model;
  });

  app.get("/api/database-models", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; q?: string; dialect?: string };
    let models = store.listDatabaseModels(query.projectId || undefined);
    if (query.q) models = models.filter((model) => textMatches(model.name, query.q) || textMatches(model.tables, query.q));
    if (query.dialect) models = models.filter((model) => model.dialect === query.dialect);
    return wantsPage(query) ? paginate(models, query) : models;
  });

  app.get("/api/database-models/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    return model;
  });

  app.post("/api/database-models", async (request) => {
    const body = parse(databaseModelCreateSchema, request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    if (store.listDatabaseModels(body.projectId).some((model) => model.name.toLowerCase() === body.name.toLowerCase())) throw httpError(409, "当前项目已存在同名数据库模型");
    const issues = validateDatabaseModel(body);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length) throw httpError(400, errors.map((issue) => issue.message).join("; "));
    const model = store.insertDatabaseModel({ projectId: body.projectId, name: body.name, dialect: body.dialect, tables: body.tables, relations: body.relations });
    if (model) {
      const pj = store.getProject(body.projectId);
      if (pj) materializeProjectJson(dataDir, pj.id, "db-models", model.id, model);
    }
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "create", before: null, after: databaseModelSummary(model) });
    return model;
  });

  app.patch("/api/database-models/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDatabaseModel(id);
    if (!before) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(databaseModelPatchSchema, request.body);
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== before.updatedAt) return reply.code(409).send({ message: `数据库模型已被修改；当前 updatedAt=${before.updatedAt}` });
    const next: DatabaseModel = {
      ...before,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.dialect !== undefined ? { dialect: body.dialect } : {}),
      ...(body.tables !== undefined ? { tables: body.tables } : {}),
      ...(body.relations !== undefined ? { relations: body.relations } : {}),
    };
    if (store.listDatabaseModels(before.projectId).some((model) => model.id !== before.id && model.name.toLowerCase() === next.name.toLowerCase())) return reply.code(409).send({ message: "当前项目已存在同名数据库模型" });
    const errors = validateDatabaseModel(next).filter((issue) => issue.severity === "error");
    if (errors.length) return reply.code(400).send({ message: errors.map((issue) => issue.message).join("; ") });
    const model = store.updateDatabaseModel(id, next);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const pj = store.getProject(model.projectId);
    if (pj) materializeProjectJson(dataDir, pj.id, "db-models", model.id, model);
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "update", before: databaseModelSummary(before), after: databaseModelSummary(model) });
    return model;
  });

  app.delete("/api/database-models/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDatabaseModel(id);
    if (!before) return reply.code(404).send({ message: "数据库模型不存在" });
    store.deleteDatabaseModel(id);
    audit(store, request.query as ActorHint, { projectId: before.projectId, entityType: "databaseModel", entityId: id, action: "delete", before: databaseModelSummary(before), after: null });
    return { ok: true };
  });

  app.get("/api/database-models/:id/validate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const issues = validateDatabaseModel(model);
    return { ok: !issues.some((issue) => issue.severity === "error"), issues };
  });

  app.post("/api/database-models/:id/generate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({ target: z.union([databaseCodeTargetSchema, z.literal("ddl")]) }).strict(), request.body);
    return generateDatabaseCode(model, body.target);
  });

  app.post("/api/database-models/:id/reverse/preview", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({ connection: databaseConnectionSchema }).strict(), request.body);
    return previewDatabaseReverse(model, body.connection);
  });

  app.post("/api/database-models/:id/reverse/apply", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDatabaseModel(id);
    if (!before) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({
      connection: databaseConnectionSchema, expectedUpdatedAt: z.string().max(64).optional(), confirmation: z.string().max(200),
      actor: z.string().max(100).optional(), source: z.enum(["web", "mcp", "system"] as const).optional(),
    }).strict(), request.body);
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== before.updatedAt) return reply.code(409).send({ message: `数据库模型已被修改；当前 updatedAt=${before.updatedAt}` });
    if (body.confirmation !== before.name) return reply.code(400).send({ message: "请输入当前模型名称确认覆盖" });
    const snapshot = await inspectDatabase(body.connection);
    const next = snapshotToModel(before, snapshot);
    const errors = validateDatabaseModel(next).filter((issue) => issue.severity === "error");
    if (errors.length) return reply.code(400).send({ message: errors.map((issue) => issue.message).join("; ") });
    const model = store.updateDatabaseModel(id, next);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "reverse_import", before: databaseModelSummary(before), after: { ...databaseModelSummary(model), target: databaseConnectionLabel(body.connection) } });
    return model;
  });

  app.post("/api/database-models/:id/deploy/preview", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({ connection: databaseConnectionSchema }).strict(), request.body);
    const issues = validateDatabaseModel(model).filter((issue) => issue.severity === "error");
    if (issues.length) return reply.code(400).send({ message: issues.map((issue) => issue.message).join("; ") });
    return previewDatabaseDeploy(model, body.connection);
  });

  app.post("/api/database-models/:id/deploy/apply", async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = store.getDatabaseModel(id);
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({
      connection: databaseConnectionSchema, confirmation: z.string().max(200),
      actor: z.string().max(100).optional(), source: z.enum(["web", "mcp", "system"] as const).optional(),
    }).strict(), request.body);
    if (body.confirmation !== model.name) return reply.code(400).send({ message: "请输入当前模型名称确认部署" });
    const result = await deployDatabaseModel(model, body.connection);
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "deploy", before: databaseModelSummary(model), after: { ...result, target: databaseConnectionLabel(body.connection) } });
    return result;
  });

  app.post("/api/database-models/:id/auto-layout", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDatabaseModel(id);
    if (!before) return reply.code(404).send({ message: "数据库模型不存在" });
    const body = parse(z.object({ expectedUpdatedAt: z.string().max(64).optional(), actor: z.string().max(100).optional(), source: z.enum(["web", "mcp", "system"] as const).optional() }).strict(), request.body ?? {});
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== before.updatedAt) return reply.code(409).send({ message: `数据库模型已被修改；当前 updatedAt=${before.updatedAt}` });
    const model = store.updateDatabaseModel(id, autoLayoutDatabaseModel(before));
    if (!model) return reply.code(404).send({ message: "数据库模型不存在" });
    audit(store, body, { projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action: "layout", before: databaseModelSummary(before), after: databaseModelSummary(model) });
    return model;
  });

  // ---------- diagram node database bindings ----------

  app.get("/api/node-database-bindings", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; diagramId?: string; diagramNodeId?: string; databaseModelId?: string };
    const bindings = store.listNodeDatabaseBindings({
      projectId: query.projectId || undefined,
      diagramId: query.diagramId || undefined,
      diagramNodeId: query.diagramNodeId || undefined,
      databaseModelId: query.databaseModelId || undefined,
    });
    return wantsPage(query) ? paginate(bindings, query) : bindings;
  });

  app.post("/api/node-database-bindings", async (request) => {
    const body = parse(nodeDatabaseBindingCreateSchema, request.body);
    validateNodeDatabaseBindingTarget(store, body);
    const binding = store.insertNodeDatabaseBinding({
      projectId: body.projectId,
      diagramId: body.diagramId,
      diagramNodeId: body.diagramNodeId,
      databaseModelId: body.databaseModelId,
      schemaName: body.schemaName,
      tableName: body.tableName,
      operations: [...new Set(body.operations)],
      purpose: body.purpose,
    });
    audit(store, body, { projectId: binding.projectId, entityType: "nodeDatabaseBinding", entityId: binding.id, action: "create", before: null, after: nodeDatabaseBindingSummary(binding) });
    return binding;
  });

  app.patch("/api/node-database-bindings/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getNodeDatabaseBinding(id);
    if (!before) return reply.code(404).send({ message: "数据库表关联不存在" });
    const body = parse(nodeDatabaseBindingPatchSchema, request.body);
    if (body.expectedUpdatedAt && body.expectedUpdatedAt !== before.updatedAt) return reply.code(409).send({ message: `数据库表关联已被修改；当前 updatedAt=${before.updatedAt}` });
    const next: NodeDatabaseBinding = {
      ...before,
      ...(body.databaseModelId !== undefined ? { databaseModelId: body.databaseModelId } : {}),
      ...(body.schemaName !== undefined ? { schemaName: body.schemaName } : {}),
      ...(body.tableName !== undefined ? { tableName: body.tableName } : {}),
      ...(body.operations !== undefined ? { operations: [...new Set(body.operations)] } : {}),
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
    };
    validateNodeDatabaseBindingTarget(store, next, id);
    const binding = store.updateNodeDatabaseBinding(id, next);
    if (!binding) return reply.code(404).send({ message: "数据库表关联不存在" });
    audit(store, body, { projectId: binding.projectId, entityType: "nodeDatabaseBinding", entityId: binding.id, action: "update", before: nodeDatabaseBindingSummary(before), after: nodeDatabaseBindingSummary(binding) });
    return binding;
  });

  app.delete("/api/node-database-bindings/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getNodeDatabaseBinding(id);
    if (!before) return reply.code(404).send({ message: "数据库表关联不存在" });
    store.deleteNodeDatabaseBinding(id);
    audit(store, request.query as ActorHint, { projectId: before.projectId, entityType: "nodeDatabaseBinding", entityId: id, action: "delete", before: nodeDatabaseBindingSummary(before), after: null });
    return { ok: true };
  });

  // ---------- diagrams ----------

  app.get("/api/diagrams", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; q?: string; type?: string };
    let diagrams = store.listDiagrams(query.projectId || undefined);
    if (query.q) diagrams = diagrams.filter((diagram) => textMatches(diagram.title, query.q));
    if (query.type) diagrams = diagrams.filter((diagram) => diagram.type === query.type);
    return wantsPage(query) ? paginate(diagrams, query) : diagrams;
  });

  app.get("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diagram = store.getDiagram(id);
    if (!diagram) return reply.code(404).send({ message: "画布不存在" });
    return diagram;
  });

  app.get("/api/diagrams/:id/prototype", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diagram = store.getDiagram(id);
    if (!diagram) return reply.code(404).send({ message: "画布不存在" });
    try { return store.getPrototypeDraft(id) ?? null; }
    catch (cause) {
      if (cause instanceof PrototypeDraftCorruptError) return reply.code(500).send({ message: cause.message });
      throw cause;
    }
  });

  app.patch("/api/diagrams/:id/prototype", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diagram = store.getDiagram(id);
    if (!diagram) return reply.code(404).send({ message: "画布不存在" });
    const body = parse(prototypeSaveSchema, request.body);
    try {
      const next = store.upsertPrototypeDraft(id, { current: body.current, versions: body.versions }, body.expectedUpdatedAt);
      audit(store, request.body as ActorHint, { projectId: diagram.projectId, entityType: "prototypeDraft", entityId: id, action: "update", before: null, after: { updatedAt: next?.updatedAt } });
      return next;
    } catch (cause) {
      if (cause instanceof PrototypeDraftConflictError) return reply.code(409).send({ message: cause.message });
      if (cause instanceof PrototypeDraftCorruptError) return reply.code(500).send({ message: cause.message });
      throw cause;
    }
  });

  // ---------- 自由创作层（与交付节点硬隔离，见设计 R1–R6） ----------

  app.get("/api/diagrams/:id/freeform", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diagram = store.getDiagram(id);
    if (!diagram) return reply.code(404).send({ message: "画布不存在" });
    try {
      const document = store.getFreeformDocument(id);
      return document ?? null;
    } catch (cause) {
      if (cause instanceof FreeformDocumentCorruptError) return reply.code(500).send({ message: cause.message });
      throw cause;
    }
  });

  app.patch("/api/diagrams/:id/freeform", async (request, reply) => {
    const { id } = request.params as { id: string };
    const diagram = store.getDiagram(id);
    if (!diagram) return reply.code(404).send({ message: "画布不存在" });
    // 自由元素不得携带任何交付状态字段：命中即 400，绝不静默忽略。
    assertNoDeliveryFieldLeak({ elements: (request.body as { elements?: unknown })?.elements, unsupported: (request.body as { unsupported?: unknown })?.unsupported });
    const body = parse(freeformSaveSchema, request.body);
    try {
      const next = store.upsertFreeformDocument(id, {
        schemaVersion: body.schemaVersion, elements: body.elements, unsupported: body.unsupported,
      }, body.expectedUpdatedAt);
      if (!next) return reply.code(404).send({ message: "画布不存在" });
      audit(store, request.body as ActorHint, {
        projectId: diagram.projectId, entityType: "freeformDocument", entityId: id, action: "update",
        before: null, after: { updatedAt: next.updatedAt, elementCount: next.elements.length },
      });
      return next;
    } catch (cause) {
      if (cause instanceof FreeformDraftConflictError) {
        return reply.code(409).send({ code: "FREEFORM_DRAFT_CONFLICT", message: cause.message, serverUpdatedAt: cause.serverUpdatedAt });
      }
      if (cause instanceof FreeformDocumentCorruptError) return reply.code(500).send({ message: cause.message });
      throw cause;
    }
  });

  // 上传只接受白名单图片的原始二进制；multipart 之外的一切载体都被显式拒绝。
  for (const mime of FREEFORM_ASSET_MIME_WHITELIST) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }
  app.addContentTypeParser(["image/svg+xml", "text/html", "application/javascript", "text/javascript", "application/xhtml+xml"],
    { parseAs: "buffer" }, (_request, body, done) => done(Object.assign(
      new Error("该类型可携带脚本或可执行内容，禁止作为自由层图片资源上传"), { statusCode: 400, code: "FREEFORM_ASSET_MIME_FORBIDDEN" }), undefined));

  app.post("/api/projects/:id/freeform-assets", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getProject(id)) return reply.code(404).send({ message: "项目不存在" });
    try {
      const declared = normalizeFreeformAssetMime(String(request.headers["content-type"] ?? ""));
      if (isFreeformAssetMimeDenied(declared)) {
        throw new FreeformAssetRejectedError("该类型可携带脚本或可执行内容，禁止作为自由层图片资源上传");
      }
      if (!isFreeformAssetMimeAllowed(declared) || !declared) {
        throw new FreeformAssetRejectedError(`自由层图片只接受 ${FREEFORM_ASSET_MIME_WHITELIST.join(" / ")}，当前为 ${declared || "(未声明)"}`);
      }
      const buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!buffer.length) throw new FreeformAssetRejectedError("上传内容为空");
      if (buffer.length > FREEFORM_ASSET_MAX_BYTES) throw new FreeformAssetRejectedError(`单文件不得超过 ${FREEFORM_ASSET_MAX_BYTES} 字节`, 413);
      const magic = freeformAssetMimeFromMagic(buffer);
      if (!magic) throw new FreeformAssetRejectedError("文件头无法识别为受支持的图片格式");
      if (magic !== declared) throw new FreeformAssetRejectedError(`声明 MIME（${declared}）与真实文件头（${magic}）不一致`);
      const metadata = await sharp(buffer).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const existing = store.findFreeformAssetBySha(id, sha256);
      if (existing) {
        return { id: existing.id, mime: existing.mime, width: existing.width, height: existing.height, sha256: existing.sha256 };
      }
      const assetId = `${FREEFORM_ASSET_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
      const directory = join(dataDir, "freeform-assets", id);
      mkdirSync(directory, { recursive: true });
      const storagePath = join(directory, `${assetId}.bin`);
      writeFileSync(storagePath, buffer);
      const asset = store.insertFreeformAsset({
        id: assetId, projectId: id, mime: declared, sha256, byteSize: buffer.length,
        storagePath, width, height, createdAt: nowIso(),
      });
      audit(store, request.body as ActorHint, {
        projectId: id, entityType: "freeformAsset", entityId: asset.id, action: "create",
        before: null, after: { mime: asset.mime, byteSize: asset.byteSize, sha256: asset.sha256 },
      });
      return { id: asset.id, mime: asset.mime, width: asset.width, height: asset.height, sha256: asset.sha256 };
    } catch (cause) {
      if (cause instanceof FreeformAssetRejectedError) return reply.code(cause.statusCode).send({ message: cause.message });
      throw cause;
    }
  });

  app.get("/api/freeform-assets/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const asset = store.getFreeformAsset(id);
    if (!asset) return reply.code(404).send({ message: "受控资源不存在" });
    if (!existsSync(asset.storagePath)) return reply.code(410).send({ message: "受控资源已丢失" });
    for (const [key, value] of Object.entries(applyFreeformAssetSecurityHeaders())) reply.header(key, value);
    return reply.type(asset.mime).send(readFileSync(asset.storagePath));
  });

// ---------- 图层、组件与模板（节点 whiteboard-layers-templates） ----------
  // 旁路载荷：图层/组件落 diagrams.layers / diagrams.components，模板落绑定表 diagram_templates；
  // 三者都不进入交付门禁统计（workflow.ts / planLayers.ts / planPolicy.ts 均不读取）。
  // 业务逻辑唯一实现于 src/server/whiteboard.ts：REST 端点与 MCP 工具是同一服务函数的两个薄入口（设计第 7 节）。

  const webActor = (request: { body?: unknown; query?: unknown }): WhiteboardAuditContext => {
    const hint = (request.body ?? request.query) as ActorHint | undefined;
    return {
      actor: hint?.actor?.trim() || "user",
      source: hint?.source ?? "web",
      correlationId: hint?.correlationId,
      clientId: hint?.clientId,
      sessionId: hint?.sessionId,
      model: hint?.model,
    };
  };
  const sendService = (reply: FastifyReply, result: ServiceResult): FastifyReply => reply.code(result.status).send(result.body);
  const whiteboardContext: WhiteboardServiceContext = { store, dataDir };

  app.get("/api/diagrams/:id/layers", async (request, reply) =>
    sendService(reply, readDiagramLayers(whiteboardContext, { diagramId: (request.params as { id: string }).id })));

  app.patch("/api/diagrams/:id/layers", async (request, reply) =>
    sendService(reply, saveDiagramLayers(whiteboardContext, {
      diagramId: (request.params as { id: string }).id, payload: request.body, audit: webActor(request),
    })));

  app.get("/api/diagrams/:id/components", async (request, reply) =>
    sendService(reply, readDiagramComponents(whiteboardContext, { diagramId: (request.params as { id: string }).id })));

  app.post("/api/diagrams/:id/components", async (request, reply) =>
    sendService(reply, createDiagramComponent(whiteboardContext, {
      diagramId: (request.params as { id: string }).id, payload: request.body, audit: webActor(request),
    })));

  app.patch("/api/diagrams/:id/components/:componentId", async (request, reply) =>
    sendService(reply, updateDiagramComponent(whiteboardContext, {
      diagramId: (request.params as { id: string }).id,
      componentId: (request.params as { componentId: string }).componentId,
      payload: request.body, audit: webActor(request),
    })));

  app.delete("/api/diagrams/:id/components/:componentId", async (request, reply) =>
    sendService(reply, removeDiagramComponent(whiteboardContext, {
      diagramId: (request.params as { id: string }).id,
      componentId: (request.params as { componentId: string }).componentId,
      audit: webActor(request),
    })));

  app.post("/api/diagrams/:id/components/:componentId/instances", async (request, reply) =>
    sendService(reply, createComponentInstances(whiteboardContext, {
      diagramId: (request.params as { id: string }).id,
      componentId: (request.params as { componentId: string }).componentId,
      payload: request.body, audit: webActor(request),
    })));

  app.get("/api/projects/:id/diagram-templates", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { scope?: string; schemaVersion?: string; limit?: string; offset?: string };
    const window = wantsPage(query) ? pageWindow(query) : undefined;
    return sendService(reply, listDiagramTemplates(whiteboardContext, {
      projectId: id,
      scope: query.scope === undefined ? undefined : (query.scope as "system" | "project"),
      schemaVersion: query.schemaVersion || undefined,
      ...(window ? { offset: window.offset, limit: window.limit } : {}),
    }));
  });

  app.get("/api/diagram-templates/:templateId", async (request, reply) => {
    const { templateId } = request.params as { templateId: string };
    const query = request.query as { include?: string; projectId?: string };
    return sendService(reply, readDiagramTemplate(whiteboardContext, { templateId, include: query.include, projectId: query.projectId }));
  });

  app.post("/api/projects/:id/diagram-templates", async (request, reply) =>
    sendService(reply, createDiagramTemplate(whiteboardContext, {
      projectId: (request.params as { id: string }).id, payload: request.body, audit: webActor(request),
    })));

  app.patch("/api/diagram-templates/:templateId", async (request, reply) =>
    sendService(reply, updateDiagramTemplateRecord(whiteboardContext, {
      templateId: (request.params as { templateId: string }).templateId, payload: request.body, audit: webActor(request),
    })));

  app.post("/api/diagram-templates/:templateId/revoke", async (request, reply) =>
    sendService(reply, revokeDiagramTemplateRecord(whiteboardContext, {
      templateId: (request.params as { templateId: string }).templateId, payload: request.body, audit: webActor(request),
    })));

  app.delete("/api/diagram-templates/:templateId", async (request, reply) =>
    sendService(reply, revokeDiagramTemplateRecord(whiteboardContext, {
      templateId: (request.params as { templateId: string }).templateId, audit: webActor(request),
    })));

  app.post("/api/diagrams/:id/template-applications", async (request, reply) =>
    sendService(reply, applyDiagramTemplate(whiteboardContext, {
      diagramId: (request.params as { id: string }).id, payload: request.body, audit: webActor(request),
    })));

  app.post("/api/diagrams", async (request) => {
    const body = parse(z.object({
      projectId: z.string().min(1),
      title: z.string().trim().min(1).max(200),
      type: z.enum(DIAGRAM_TYPES).default("free"),
      nodes: z.array(diagramNodeSchema).default([]),
      edges: z.array(z.object({
        id: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
        sourcePort: z.enum(DIAGRAM_PORTS).optional(), targetPort: z.enum(DIAGRAM_PORTS).optional(),
        label: z.string().max(200).optional(), style: z.enum(["ortho", "straight", "curve"]).optional(),
        relationType: z.enum(DIAGRAM_USE_CASE_RELATION_TYPES).optional(),
        points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), width: z.number().min(1).max(8).optional(),
        dash: z.enum(["solid", "dashed", "dotted"]).optional(), arrow: z.enum(["end", "both", "none"]).optional(),
        labelPosition: z.number().min(0).max(1).optional(),
      })).default([]),
      groups: z.array(z.object({
        id: z.string().min(1), name: z.string().max(200), nodeIds: z.array(z.string()),
      })).default([]),
    }), request.body);
    if (!store.getProject(body.projectId)) throw httpError(400, "projectId 不存在");
    if (body.type === "main") throw httpError(409, "系统主画布由项目自动创建，每个项目只能有一个");
    try {
      assertNoIntroducedDiagramGroupOverlap({ nodes: [], groups: [] }, body);
    } catch (cause) {
      throw httpError(409, cause instanceof Error ? cause.message : String(cause));
    }
    const diagram = store.insertDiagram(body);
    const project0 = store.getProject(body.projectId);
    if (project0) materializeProjectJson(dataDir, project0.id, "diagrams", diagram.id, { id: diagram.id, projectId: diagram.projectId, title: diagram.title, type: diagram.type, nodes: diagram.nodes, edges: diagram.edges, groups: diagram.groups, createdAt: diagram.createdAt, updatedAt: diagram.updatedAt });
    audit(store, request.body as ActorHint, {
      projectId: diagram.projectId, entityType: "diagram", entityId: diagram.id,
      action: "create", before: null, after: { title: diagram.title, nodes: diagram.nodes.length },
    });
    return diagram;
  });

  app.patch("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDiagram(id);
    if (!before) return reply.code(404).send({ message: "画布不存在" });
    const rawPatch = parse(z.object({
      title: z.string().trim().min(1).max(200).optional(),
      type: z.enum(DIAGRAM_TYPES).optional(),
      nodes: z.array(diagramNodeSchema).optional(),
      edges: z.array(z.object({
        id: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
        sourcePort: z.enum(DIAGRAM_PORTS).optional(), targetPort: z.enum(DIAGRAM_PORTS).optional(),
        label: z.string().max(200).optional(), style: z.enum(["ortho", "straight", "curve"]).optional(),
        relationType: z.enum(DIAGRAM_USE_CASE_RELATION_TYPES).optional(),
        points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), width: z.number().min(1).max(8).optional(),
        dash: z.enum(["solid", "dashed", "dotted"]).optional(), arrow: z.enum(["end", "both", "none"]).optional(),
        labelPosition: z.number().min(0).max(1).optional(),
      })).optional(),
      groups: z.array(z.object({
        id: z.string().min(1), name: z.string().max(200), nodeIds: z.array(z.string()),
      })).optional(),
      // 设计 3.6：diagrams patch schema 增加可选 layers/components 旁路载荷（缺省不写、读取时派生）。
      // 这里只收口字段存在性；真正的字段校验随后走与专用端点同源的 strict schema + validateLayerState。
      layers: z.unknown().optional(),
      components: z.unknown().optional(),
    }), request.body);
    const { layers: rawLayers, components: rawComponents, ...patchFields } = rawPatch;
    const write: Partial<Diagram> = { ...patchFields };
    if (rawLayers !== undefined) {
      const normalized = normalizeDiagramLayerField(whiteboardContext, before, rawLayers);
      if ("result" in normalized) return reply.code(normalized.result.status).send(normalized.result.body);
      write.layers = normalized.state;
    }
    // 组件同样先走与专用端点同源的 strict schema（未知字段 400），再归一化为规范载荷。
    if (rawComponents !== undefined) write.components = normalizeComponentLibrary(parse(componentLibrarySchema, rawComponents));
    const patch = write;
    if (changesProtectedRequirement(before, patch.nodes ?? before.nodes, patch.type ?? before.type))
      return reply.code(409).send({ code: "NODE_REQUIREMENT_REVISION_REQUIRED",
        message: "待修订节点的需求与流程只能通过专属 Designer 工单提交，并由独立 Approver 批准" });
    if (before.type === "main" && patch.type !== undefined && patch.type !== "main") {
      throw httpError(409, "系统主画布是项目固定入口，不能修改为其他类型");
    }
    if (before.type !== "main" && patch.type === "main") {
      throw httpError(409, "项目已经有系统主画布，其他画布不能设为主画布");
    }
    try {
      assertNoIntroducedDiagramGroupOverlap(before, { ...before, ...patch });
    } catch (cause) {
      throw httpError(409, cause instanceof Error ? cause.message : String(cause));
    }
    const transitionError = validateDiagramDeliveryTransition(store, before, { ...before, ...patch });
    if (transitionError) throw httpError(409, transitionError);
    const diagram = store.updateDiagram(id, patch);
    if (diagram) {
      store.recordDiagramRevision(id, before, diagram, (request.body as ActorHint | undefined)?.actor?.trim() || "user");
      const project = store.getProject(diagram.projectId);
      if (project) materializeProjectJson(dataDir, project.id, "diagrams", diagram.id, { id: diagram.id, projectId: diagram.projectId, title: diagram.title, type: diagram.type, nodes: diagram.nodes, edges: diagram.edges, groups: diagram.groups, createdAt: diagram.createdAt, updatedAt: diagram.updatedAt });
    }
    audit(store, request.body as ActorHint, {
      projectId: before.projectId, entityType: "diagram", entityId: id,
      action: "update", before: { title: before.title, nodes: before.nodes.length },
      after: diagram ? { title: diagram.title, nodes: diagram.nodes.length } : null,
    });
    return diagram;
  });

  app.delete("/api/diagrams/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const before = store.getDiagram(id);
    if (!before) return reply.code(404).send({ message: "画布不存在" });
    if (before.type === "main") throw httpError(409, "系统主画布是项目固定入口，不能删除");
    if (before.nodes.some(hasRequirementChangeMarker)) return reply.code(409).send({
      code: "NODE_REQUIREMENT_REVISION_REQUIRED", message: "画布含未解除设计变更标记的节点，不能删除",
    });
    store.deleteDiagram(id);
    audit(store, request.query as ActorHint, {
      projectId: before.projectId, entityType: "diagram", entityId: id,
      action: "delete", before: { title: before.title }, after: null,
    });
    return { ok: true };
  });

  // ---------- audit & backups ----------

  app.get("/api/audit", async (request) => {
    const query = request.query as PageQuery & { projectId?: string; q?: string; source?: string; action?: string; entityType?: string; entityId?: string; correlationId?: string; sessionId?: string };
    if (wantsPage(query)) {
      return store.listAuditPage({
        projectId: query.projectId || undefined,
        q: query.q || undefined,
        source: query.source || undefined,
        action: query.action || undefined,
        entityType: query.entityType || undefined,
        entityId: query.entityId || undefined,
        correlationId: query.correlationId || undefined,
        sessionId: query.sessionId || undefined,
        offset: Number(query.offset ?? 0) || 0,
        limit: Number(query.limit ?? 20) || 20,
      });
    }
    const limit = Math.min(Math.max(Number(query.limit ?? "200") || 200, 1), 1000);
    return store.listAudit(limit, query.projectId || undefined);
  });

  app.get("/api/backups", async (request) => {
    const query = request.query as PageQuery & { q?: string };
    let backups = store.listBackups();
    if (query.q) backups = backups.filter((backup) => textMatches(backup.label, query.q) || textMatches(backup.reason, query.q));
    return wantsPage(query) ? paginate(backups, query) : backups;
  });

  app.get("/api/storage-retention", async () => storageRetentionSummary(dataDir));

  app.post("/api/backups", async (request) => {
    const body = parse(z.object({
      label: z.string().trim().min(1).max(120),
      reason: z.string().max(1000).default(""),
    }), request.body ?? {});
    const { path: _path, ...backup } = createBackupFile(store, dataDir, body.label, body.reason);
    audit(store, request.body as ActorHint, {
      projectId: null, entityType: "backup", entityId: backup.id,
      action: "create", before: null, after: { label: backup.label, itemCount: backup.itemCount },
    });
    return backup;
  });

  app.post("/api/backups/:id/restore", async (request, reply) => {
    const { id } = request.params as { id: string };
    const backup = store.listBackups().find((item) => item.id === id);
    if (!backup) return reply.code(404).send({ message: "备份记录不存在" });
    const body = parse(z.object({ confirmation: z.string(), actor: z.string().max(100).optional() }), request.body ?? {});
    if (body.confirmation !== `RESTORE ${id}`) throw httpError(409, `恢复前必须输入 RESTORE ${id}`);
    let snapshot: unknown;
    try {
      snapshot = loadBackupFile(dataDir, id, backup.createdAt);
    } catch (restoreError) {
      throw httpError(400, restoreError instanceof Error ? restoreError.message : String(restoreError));
    }
    createBackupFile(store, dataDir, `恢复前自动备份 ${nowIso().slice(0, 19)}`, `恢复备份 ${backup.label} 前的安全快照`);
    const restored = store.restoreBusinessSnapshot(snapshot);
    audit(store, body, {
      projectId: null, entityType: "backup", entityId: id,
      action: "restore", before: null, after: { label: backup.label, restored },
    });
    return { ok: true, backup, restored };
  });
}
