import type {
  AgentApproval,
  AgentApprovalDecision,
  AgentApprovalStatus,
  AgentBlueprintKey,
  AgentBlueprintOverride,
  AgentChildTaskDispatch,
  AgentCoordinationLease,
  AgentControlMode,
  AgentExecutableQueueKey,
  AgentMessage,
  AgentPageContext,
  AgentSendResponse,
  AgentSession,
  AgentWorkspace,
  AgentWorkspaceSnapshot,
  AgentOrchestration,
  AgentOrchestrationTask,
  AgentRunnerRegistration,
  AgentTaskLeaseRecord,
  AgentTaskCapacity,
  AgentTaskPackage,
  AuditEvent,
  Backup,
  DatabaseCodeResult,
  DatabaseCodeTarget,
  DatabaseConnectionCheck,
  DatabaseConnectionInput,
  DatabaseDeployPreview,
  DatabaseDeployResult,
  DatabaseModel,
  DatabaseModelIssue,
  DatabaseReversePreview,
  DesignDoc,
  DesignChangeRequest,
  DesignChangeResult,
  DocumentReference,
  DocumentReferenceInput,
  DocumentRevision,
  Diagram,
  DiagramComponentDefinition,
  DiagramComponentLibrary,
  DiagramLayerState,
  DiagramTemplate,
  DiagramTemplateContent,
  DiagramTemplateSummary,
  Evidence,
  FreeformAssetSummary,
  FreeformDocument,
  GovernanceRecord,
  LlmConnectionCheck,
  LlmProfile,
  NodeDatabaseBinding,
  Paginated,
  PlanItem,
  Project,
  ProjectWorkflow,
  ProjectWorkspace,
  ProjectWorkspaceNode,
  PrototypeStored,
  StorageRetentionSummary,
  WorkNode,
} from "../shared/types.js";

export interface DashboardData {
  totals: { projects: number; activeProjects: number; attention: number; unconfigured: number; overduePlans: number };
  byStage: Record<string, number>;
  byHealth: Record<string, number>;
  attentionProjects: Project[];
  unconfiguredProjects: Project[];
  overduePlans: PlanItem[];
  recentAudit: AuditEvent[];
  generatedAt: string;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = response.statusText || "请求失败";
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) message = payload.message;
    } catch {
      /* ignore */
    }
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}

/** 自由层保存冲突：服务端已有更新版本，调用方必须让用户选择处置方式。 */
export class FreeformConflictError extends Error {
  readonly serverUpdatedAt: string;
  constructor(message: string, serverUpdatedAt: string) {
    super(message);
    this.name = "FreeformConflictError";
    this.serverUpdatedAt = serverUpdatedAt;
  }
}

async function errorMessageOf(response: Response, fallback: string): Promise<string> {
  let message = response.statusText || fallback;
  try {
    const payload = (await response.json()) as { message?: string };
    if (payload?.message) message = payload.message;
  } catch {
    /* ignore */
  }
  return message;
}

async function saveFreeformDocumentRequest<T>(id: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/diagrams/${id}/freeform`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) {
    let message = "自由层保存冲突";
    let serverUpdatedAt = "";
    try {
      const payload = (await response.json()) as { message?: string; serverUpdatedAt?: string };
      if (payload?.message) message = payload.message;
      if (payload?.serverUpdatedAt) serverUpdatedAt = payload.serverUpdatedAt;
    } catch {
      /* ignore */
    }
    throw new FreeformConflictError(message, serverUpdatedAt);
  }
  if (!response.ok) throw new Error(`${await errorMessageOf(response, "请求失败")}（HTTP ${response.status}）`);
  return (await response.json()) as T;
}

async function uploadFreeformAssetRequest<T>(projectId: string, blob: Blob, mime: string): Promise<T> {
  const response = await fetch(`/api/projects/${projectId}/freeform-assets`, {
    method: "POST",
    headers: { "content-type": mime },
    body: blob,
  });
  if (!response.ok) throw new Error(`${await errorMessageOf(response, "上传失败")}（HTTP ${response.status}）`);
  return (await response.json()) as T;
}

/**
 * 图层/组件/模板写接口的统一冲突错误（设计 8.1：CAS 失败 → 409 + serverUpdatedAt）。
 * 与 FreeformConflictError 同构，额外携带契约错误码，供 UI 区分"版本冲突"与"业务拒绝"。
 */
export class WhiteboardConflictError extends Error {
  readonly serverUpdatedAt: string;
  readonly code: string;
  constructor(message: string, code: string, serverUpdatedAt: string) {
    super(message);
    this.name = "WhiteboardConflictError";
    this.code = code;
    this.serverUpdatedAt = serverUpdatedAt;
  }
}

/** 图层/组件/模板请求封装：409 且带 serverUpdatedAt 时抛 WhiteboardConflictError，其余按普通错误处理。 */
async function whiteboardRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 409) {
    let message = "内容已被其他操作修改";
    let code = "";
    let serverUpdatedAt = "";
    try {
      const payload = (await response.json()) as { message?: string; code?: string; serverUpdatedAt?: string };
      if (payload?.message) message = payload.message;
      if (payload?.code) code = payload.code;
      if (payload?.serverUpdatedAt) serverUpdatedAt = payload.serverUpdatedAt;
    } catch {
      /* ignore */
    }
    if (serverUpdatedAt) throw new WhiteboardConflictError(message, code, serverUpdatedAt);
    throw new Error(`${message}（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(`${await errorMessageOf(response, "请求失败")}（HTTP ${response.status}）`);
  return (await response.json()) as T;
}

/** 图层读取响应：图层状态 + 画布 updatedAt（作为下一次保存的 CAS 基准）。 */
export type DiagramLayerReadResponse = DiagramLayerState & { diagramUpdatedAt: string; unsupported?: boolean };
export type DiagramComponentReadResponse = DiagramComponentLibrary & { diagramUpdatedAt: string };
export interface DiagramComponentWriteResponse {
  component: DiagramComponentDefinition;
  droppedEdgeIds: string[];
  diagramUpdatedAt: string;
}
export interface DiagramComponentInstanceResponse {
  diagram: Diagram;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  createdFreeformIds: string[];
  droppedEdgeIds: string[];
  diagramUpdatedAt: string;
}
export type DiagramTemplateReadResponse = DiagramTemplateSummary & { content?: DiagramTemplateContent };
export interface DiagramTemplateApplyResponse {
  diagram: Diagram;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  createdFreeformIds: string[];
  droppedLinkDiagramIds: string[];
  migrated: boolean;
  thumbnailApplied: boolean;
  diagramUpdatedAt: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const api = {
  dashboard: () => request<DashboardData>("GET", "/api/dashboard"),
  storageRetention: () => request<StorageRetentionSummary>("GET", "/api/storage-retention"),

  listLlmProfiles: () => request<LlmProfile[]>("GET", "/api/llm-profiles"),
  createLlmProfile: (body: Record<string, unknown>) => request<LlmProfile>("POST", "/api/llm-profiles", body),
  updateLlmProfile: (id: string, patch: Record<string, unknown>) => request<LlmProfile>("PATCH", `/api/llm-profiles/${id}`, patch),
  deleteLlmProfile: (id: string) => request<{ ok: boolean }>("DELETE", `/api/llm-profiles/${id}`),
  testLlmProfile: (id: string) => request<LlmConnectionCheck>("POST", `/api/llm-profiles/${id}/test`, {}),

  getAgentWorkspace: (projectId: string) => request<AgentWorkspaceSnapshot>("GET", `/api/projects/${projectId}/agent-workspace`),
  updateAgentWorkspace: (projectId: string, defaultProfileId: string | null) =>
    request<AgentWorkspace>("PATCH", `/api/projects/${projectId}/agent-workspace`, { defaultProfileId }),
  createAgentSession: (body: { projectId: string; profileId: string; model: string; title?: string; controlMode?: AgentControlMode }) =>
    request<AgentSession>("POST", "/api/agent-sessions", body),
  updateAgentSession: (id: string, patch: { title?: string; profileId?: string; model?: string; controlMode?: AgentControlMode }) =>
    request<AgentSession>("PATCH", `/api/agent-sessions/${id}`, patch),
  deleteAgentSession: (id: string) => request<{ ok: boolean; cancelled: boolean }>("DELETE", `/api/agent-sessions/${id}`),
  listAgentMessages: (id: string) => request<AgentMessage[]>("GET", `/api/agent-sessions/${id}/messages`),
  listAgentApprovals: (id: string, status?: AgentApprovalStatus) =>
    request<AgentApproval[]>("GET", `/api/agent-sessions/${id}/approvals${qs({ status })}`),
  decideAgentApproval: (id: string, sessionId: string, decision: AgentApprovalDecision) =>
    request<AgentApproval>("POST", `/api/agent-approvals/${id}/decision`, { sessionId, decision }),
  sendAgentMessage: (id: string, content: string, pageContext: AgentPageContext | null) =>
    request<AgentSendResponse>("POST", `/api/agent-sessions/${id}/messages`, {
      content,
      contextEvent: pageContext ? { type: "STATE_SNAPSHOT", snapshot: pageContext } : null,
    }),

  listProjects: (filter: { stage?: string; health?: string; q?: string } = {}) =>
    request<Project[]>("GET", `/api/projects${qs(filter)}`),

  pageProjects: (filter: { stage?: string; health?: string; q?: string; configured?: "all" | "yes" | "no"; offset?: number; limit?: number } = {}) =>
    request<Paginated<Project>>("GET", `/api/projects${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),

  getProject: (id: string) => request<Project>("GET", `/api/projects/${id}`),
  getProjectWorkspace: (id: string) => request<ProjectWorkspace>("GET", `/api/projects/${id}/workspace`),
  getProjectWorkflow: (id: string) => request<ProjectWorkflow>("GET", `/api/projects/${id}/workflow`),
  requestDesignChange: (id: string, body: Omit<DesignChangeRequest, "projectId">) =>
    request<DesignChangeResult>("POST", `/api/projects/${id}/design-changes`, body),
  getAgentOrchestration: (id: string, includePrompts = true) =>
    request<AgentOrchestration>("GET", `/api/projects/${id}/agent-orchestration${qs({ includePrompts: String(includePrompts) })}`),
  listAgentTasks: (projectId: string) =>
    request<Array<AgentOrchestrationTask & { taskKey: string; taskRevision: string; requiredRole: AgentBlueprintKey; available: boolean; availabilityReason: string }>>("GET", `/api/projects/${projectId}/agent-tasks`),
  claimCoordinationLease: (projectId: string, target: { planId: string } | { taskKey: string; taskRevision: string }, mainAgentId: string, workerId: string) =>
    request<AgentCoordinationLease>("POST", `/api/projects/${projectId}/coordination-leases`, {
      ...target, mainAgentId, workerId, leaseSeconds: 1800, idempotencyKey: crypto.randomUUID(),
    }),
  dispatchChildTask: (projectId: string, parent: Pick<AgentCoordinationLease, "id" | "leaseToken" | "mainAgentId">, body: { taskId: string; taskKey?: string; role: "designer" | "builder" | "auditor"; agentId?: string; workerId?: string; poolId?: string }) =>
    request<AgentChildTaskDispatch>("POST", `/api/projects/${projectId}/coordination-leases/${encodeURIComponent(parent.id)}/dispatch`, {
      leaseToken: parent.leaseToken, mainAgentId: parent.mainAgentId, ...body,
    }),
  claimDispatchedChildTask: (projectId: string, dispatch: Pick<AgentChildTaskDispatch, "dispatchId" | "agentId" | "workerId" | "poolId">) =>
    request<AgentTaskPackage>("POST", `/api/projects/${projectId}/child-task-dispatches/${encodeURIComponent(dispatch.dispatchId)}/claim`, {
      agentId: dispatch.agentId, workerId: dispatch.workerId, poolId: dispatch.poolId, capabilities: ["manual-external-runner"],
      leaseSeconds: 1800, idempotencyKey: crypto.randomUUID(),
    }),
  listAgentBlueprints: () => request<AgentBlueprintOverride[]>("GET", "/api/agent-blueprints"),
  getAgentTaskCapacity: (id: string) => request<AgentTaskCapacity>("GET", `/api/projects/${id}/agent-task-capacity`),
  updateAgentTaskCapacity: (id: string, patch: Partial<Omit<AgentTaskCapacity, "projectId" | "updatedAt">>) =>
    request<AgentTaskCapacity>("PATCH", `/api/projects/${id}/agent-task-capacity`, patch),
  listAgentRunners: (id: string) => request<AgentRunnerRegistration[]>("GET", `/api/projects/${id}/agent-runners`),
  listAgentTaskLeases: (id: string) => request<AgentTaskLeaseRecord[]>("GET", `/api/projects/${id}/agent-task-leases`),
  releaseAgentTaskManually: (projectId: string, workOrderId: string, reason: string) =>
    request<AgentTaskLeaseRecord>("POST", `/api/projects/${projectId}/agent-task-leases/${encodeURIComponent(workOrderId)}/release`, { reason }),
  updateAgentBlueprint: (key: AgentBlueprintKey, patch: Record<string, unknown>) =>
    request<AgentBlueprintOverride>("PUT", `/api/agent-blueprints/${key}`, patch),
  pageProjectWorkspaceNodes: (id: string, filter: { q?: string; kind?: string; diagramId?: string; developmentStatus?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<ProjectWorkspaceNode>>("GET", `/api/projects/${id}/workspace-nodes${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),

  createProject: (body: Record<string, unknown>) => request<Project>("POST", "/api/projects", body),

  updateProject: (id: string, patch: Record<string, unknown>) =>
    request<Project>("PATCH", `/api/projects/${id}`, patch),

  deleteProject: (id: string) => request<{ ok: boolean }>("DELETE", `/api/projects/${id}`),

  listNodes: (projectId: string) => request<WorkNode[]>("GET", `/api/projects/${projectId}/nodes`),
  createNode: (body: Record<string, unknown>) => request<WorkNode>("POST", "/api/nodes", body),
  updateNode: (id: string, patch: Record<string, unknown>) => request<WorkNode>("PATCH", `/api/nodes/${id}`, patch),
  deleteNode: (id: string) => request<{ ok: boolean }>("DELETE", `/api/nodes/${id}`),

  listPlans: (projectId: string, filter: { diagramId?: string; diagramNodeId?: string } = {}) =>
    request<PlanItem[]>("GET", `/api/projects/${projectId}/plans${qs(filter)}`),
  pagePlans: (projectId: string, filter: { diagramId?: string; diagramNodeId?: string; q?: string; status?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<PlanItem>>("GET", `/api/projects/${projectId}/plans${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  getPlan: (id: string) => request<PlanItem>("GET", `/api/plans/${id}`),
  createPlan: (body: Record<string, unknown>) => request<PlanItem>("POST", "/api/plans", body),
  updatePlan: (id: string, patch: Record<string, unknown>) => request<PlanItem>("PATCH", `/api/plans/${id}`, patch),
  transitionPlan: (id: string, body: { action: string; actor: string; agentId?: string; leaseToken?: string; idempotencyKey?: string; reason?: string; implementationRevision?: string; repairDisposition?: "reset" | "design_change"; correlationId?: string; clientId?: string; sessionId?: string; model?: string; coordinationLeaseId?: string; coordinationLeaseToken?: string }) =>
    request<PlanItem>("POST", `/api/plans/${id}/transition`, body),
  deletePlan: (id: string) => request<{ ok: boolean }>("DELETE", `/api/plans/${id}`),

  listEvidence: (projectId: string, filter: { nodeId?: string; planItemId?: string } = {}) => request<Evidence[]>("GET", `/api/projects/${projectId}/evidence${qs(filter)}`),
  pageEvidence: (projectId: string, filter: { nodeId?: string; planItemId?: string; q?: string; status?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<Evidence>>("GET", `/api/projects/${projectId}/evidence${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  collectGitEvidence: (projectId: string) =>
    request<Evidence>("POST", `/api/projects/${projectId}/evidence/collect`, { source: "git" }),
  createManualEvidence: (body: Record<string, unknown>) => request<Evidence>("POST", "/api/evidence", body),
  deleteEvidence: (id: string) => request<{ ok: boolean }>("DELETE", `/api/evidence/${id}`),

  listGovernance: (projectId?: string) =>
    request<GovernanceRecord[]>("GET", `/api/governance${qs({ projectId })}`),
  pageGovernance: (filter: { projectId?: string; q?: string; status?: string; type?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<GovernanceRecord>>("GET", `/api/governance${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  createGovernance: (body: Record<string, unknown>) =>
    request<GovernanceRecord>("POST", "/api/governance", body),
  updateGovernance: (id: string, patch: Record<string, unknown>) =>
    request<GovernanceRecord>("PATCH", `/api/governance/${id}`, patch),
  deleteGovernance: (id: string) => request<{ ok: boolean }>("DELETE", `/api/governance/${id}`),

  listAudit: (limit = 200) => request<AuditEvent[]>("GET", `/api/audit?limit=${limit}`),
  pageAudit: (filter: { projectId?: string; q?: string; source?: string; action?: string; entityType?: string; entityId?: string; correlationId?: string; sessionId?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<AuditEvent>>("GET", `/api/audit${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),

  listDesignDocs: (projectId?: string) =>
    request<DesignDoc[]>("GET", `/api/design-docs${qs({ projectId })}`),
  getDesignDocContent: (id: string, filter: { projectId?: string; revisionId?: string; contentOffset?: number; maxContentChars?: number } = {}) =>
    request<{ id: string; projectId: string; revisionId: string; currentRevisionId: string; title: string; status: string; version: string; contentOffset: number; contentLength: number; nextContentOffset: number | null; hasMore: boolean; content: string }>("GET", `/api/design-docs/${id}${qs(filter)}`),
  pageDesignDocs: (filter: { projectId?: string; targetType?: string; targetId?: string; q?: string; status?: string; category?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<DesignDoc>>("GET", `/api/design-docs${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  listReferencedDesignDocs: (projectId: string, targetType: DocumentReference["targetType"], targetId: string) =>
    request<DesignDoc[]>("GET", `/api/design-docs${qs({ projectId, targetType, targetId })}`),
  createDesignDoc: (body: Record<string, unknown>) => request<DesignDoc>("POST", "/api/design-docs", body),
  updateDesignDoc: (id: string, patch: Record<string, unknown>) =>
    request<DesignDoc>("PATCH", `/api/design-docs/${id}`, patch),
  deleteDesignDoc: (id: string) => request<{ ok: boolean }>("DELETE", `/api/design-docs/${id}`),
  listDocumentRevisions: (id: string) => request<DocumentRevision[]>("GET", `/api/design-docs/${id}/revisions`),
  listDocumentReferences: (filter: { projectId?: string; documentId?: string; targetType?: DocumentReference["targetType"]; targetId?: string } = {}) =>
    request<DocumentReference[]>("GET", `/api/document-references${qs(filter)}`),
  createDocumentReference: (body: DocumentReferenceInput) => request<DocumentReference>("POST", "/api/document-references", body),
  updateDocumentReference: (id: string, patch: { documentRevisionId?: string; useCurrentRevision?: boolean }) =>
    request<DocumentReference>("PATCH", `/api/document-references/${id}`, patch),
  deleteDocumentReference: (id: string) => request<{ ok: boolean }>("DELETE", `/api/document-references/${id}`),

  listDiagrams: (projectId?: string) => request<Diagram[]>("GET", `/api/diagrams${qs({ projectId })}`),
  pageDiagrams: (filter: { projectId?: string; q?: string; type?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<Diagram>>("GET", `/api/diagrams${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  getDiagram: (id: string) => request<Diagram>("GET", `/api/diagrams/${id}`),
  createDiagram: (body: Record<string, unknown>) => request<Diagram>("POST", "/api/diagrams", body),
  updateDiagram: (id: string, patch: { title?: string; type?: string; nodes?: unknown[]; edges?: unknown[]; groups?: unknown[]; layers?: DiagramLayerState; components?: DiagramComponentLibrary }) =>
    request<Diagram>("PATCH", `/api/diagrams/${id}`, patch),
  deleteDiagram: (id: string) => request<{ ok: boolean }>("DELETE", `/api/diagrams/${id}`),
  getPrototypeDraft: (id: string) => request<PrototypeStored | null>("GET", `/api/diagrams/${id}/prototype`),
  savePrototypeDraft: (id: string, body: Omit<PrototypeStored, "updatedAt"> & { expectedUpdatedAt: string | null }) =>
    request<PrototypeStored>("PATCH", `/api/diagrams/${id}/prototype`, body),
  getFreeformDocument: (id: string) => request<FreeformDocument | null>("GET", `/api/diagrams/${id}/freeform`),
  saveFreeformDocument: (
    id: string,
    body: { schemaVersion: 1; elements: FreeformDocument["elements"]; unsupported?: FreeformDocument["unsupported"]; expectedUpdatedAt: string | null },
  ) => saveFreeformDocumentRequest<FreeformDocument>(id, body),
  uploadFreeformAsset: (projectId: string, blob: Blob, mime: string) =>
    uploadFreeformAssetRequest<FreeformAssetSummary>(projectId, blob, mime),
  freeformAssetUrl: (assetId: string) => `/api/freeform-assets/${encodeURIComponent(assetId)}`,

  // ---------- 图层、组件与模板（节点 whiteboard-layers-templates，设计 6.2/6.3/6.4） ----------
  getDiagramLayers: (id: string) => whiteboardRequest<DiagramLayerReadResponse>("GET", `/api/diagrams/${id}/layers`),
  updateDiagramLayers: (id: string, body: { schemaVersion: 1; layers: DiagramLayerState["layers"]; itemOverrides: DiagramLayerState["itemOverrides"]; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramLayerReadResponse>("PATCH", `/api/diagrams/${id}/layers`, body),

  listDiagramComponents: (id: string) => whiteboardRequest<DiagramComponentReadResponse>("GET", `/api/diagrams/${id}/components`),
  createDiagramComponent: (id: string, body: { name: string; selection: { nodeIds: string[]; edgeIds: string[]; freeformIds: string[] }; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramComponentWriteResponse>("POST", `/api/diagrams/${id}/components`, body),
  updateDiagramComponent: (id: string, componentId: string, body: { name?: string; selection?: { nodeIds: string[]; edgeIds: string[]; freeformIds: string[] }; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramComponentWriteResponse>("PATCH", `/api/diagrams/${id}/components/${encodeURIComponent(componentId)}`, body),
  deleteDiagramComponent: (id: string, componentId: string) =>
    whiteboardRequest<{ ok: boolean; diagramUpdatedAt: string }>("DELETE", `/api/diagrams/${id}/components/${encodeURIComponent(componentId)}`),
  instantiateDiagramComponent: (id: string, componentId: string, body: { offsetX?: number; offsetY?: number; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramComponentInstanceResponse>("POST", `/api/diagrams/${id}/components/${encodeURIComponent(componentId)}/instances`, body),

  listDiagramTemplates: (projectId: string, filter: { scope?: "system" | "project"; schemaVersion?: string; offset?: number; limit?: number } = {}) =>
    request<DiagramTemplateSummary[] | Paginated<DiagramTemplateSummary>>("GET", `/api/projects/${projectId}/diagram-templates${qs(filter)}`),
  getDiagramTemplate: (templateId: string, filter: { include?: string; projectId?: string } = {}) =>
    whiteboardRequest<DiagramTemplateReadResponse>("GET", `/api/diagram-templates/${encodeURIComponent(templateId)}${qs(filter)}`),
  createDiagramTemplate: (projectId: string, body: { name: string; scope?: "project"; schemaVersion?: string; content: unknown; thumbnailMeta?: unknown }) =>
    whiteboardRequest<DiagramTemplate & { thumbnailWarning?: string }>("POST", `/api/projects/${projectId}/diagram-templates`, body),
  updateDiagramTemplate: (templateId: string, patch: { name?: string; schemaVersion?: string; content?: unknown; thumbnailMeta?: unknown; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramTemplate & { thumbnailWarning?: string }>("PATCH", `/api/diagram-templates/${encodeURIComponent(templateId)}`, patch),
  revokeDiagramTemplate: (templateId: string, body: { actor?: string } = {}) =>
    whiteboardRequest<DiagramTemplateSummary>("POST", `/api/diagram-templates/${encodeURIComponent(templateId)}/revoke`, body),
  applyDiagramTemplate: (diagramId: string, body: { templateId: string; mode: "append" | "replace"; expectedUpdatedAt: string | null }) =>
    whiteboardRequest<DiagramTemplateApplyResponse>("POST", `/api/diagrams/${diagramId}/template-applications`, body),

  listDatabaseModels: (projectId?: string) => request<DatabaseModel[]>("GET", `/api/database-models${qs({ projectId })}`),
  pageDatabaseModels: (filter: { projectId?: string; q?: string; dialect?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<DatabaseModel>>("GET", `/api/database-models${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  getDatabaseModel: (id: string) => request<DatabaseModel>("GET", `/api/database-models/${id}`),
  createDatabaseModel: (body: Record<string, unknown>) => request<DatabaseModel>("POST", "/api/database-models", body),
  updateDatabaseModel: (id: string, patch: Record<string, unknown>) => request<DatabaseModel>("PATCH", `/api/database-models/${id}`, patch),
  deleteDatabaseModel: (id: string) => request<{ ok: boolean }>("DELETE", `/api/database-models/${id}`),
  validateDatabaseModel: (id: string) => request<{ ok: boolean; issues: DatabaseModelIssue[] }>("GET", `/api/database-models/${id}/validate`),
  generateDatabaseCode: (id: string, target: DatabaseCodeTarget | "ddl") => request<DatabaseCodeResult>("POST", `/api/database-models/${id}/generate`, { target }),
  autoLayoutDatabaseModel: (id: string, expectedUpdatedAt?: string) => request<DatabaseModel>("POST", `/api/database-models/${id}/auto-layout`, { expectedUpdatedAt }),
  checkDatabaseConnection: (connection: DatabaseConnectionInput) => request<DatabaseConnectionCheck>("POST", "/api/database-connections/check", { connection }),
  previewDatabaseImport: (projectId: string, name: string, connection: DatabaseConnectionInput) => request<DatabaseReversePreview>("POST", "/api/database-models/import/preview", { projectId, name, connection }),
  importDatabaseModel: (projectId: string, name: string, connection: DatabaseConnectionInput) => request<DatabaseModel>("POST", "/api/database-models/import", { projectId, name, connection }),
  previewDatabaseReverse: (id: string, connection: DatabaseConnectionInput) => request<DatabaseReversePreview>("POST", `/api/database-models/${id}/reverse/preview`, { connection }),
  applyDatabaseReverse: (id: string, connection: DatabaseConnectionInput, confirmation: string, expectedUpdatedAt?: string) => request<DatabaseModel>("POST", `/api/database-models/${id}/reverse/apply`, { connection, confirmation, expectedUpdatedAt }),
  previewDatabaseDeploy: (id: string, connection: DatabaseConnectionInput) => request<DatabaseDeployPreview>("POST", `/api/database-models/${id}/deploy/preview`, { connection }),
  applyDatabaseDeploy: (id: string, connection: DatabaseConnectionInput, confirmation: string) => request<DatabaseDeployResult>("POST", `/api/database-models/${id}/deploy/apply`, { connection, confirmation }),

  listNodeDatabaseBindings: (filter: { projectId?: string; diagramId?: string; diagramNodeId?: string; databaseModelId?: string } = {}) =>
    request<NodeDatabaseBinding[]>("GET", `/api/node-database-bindings${qs(filter)}`),
  pageNodeDatabaseBindings: (filter: { projectId?: string; diagramId?: string; diagramNodeId?: string; databaseModelId?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<NodeDatabaseBinding>>("GET", `/api/node-database-bindings${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  createNodeDatabaseBinding: (body: Record<string, unknown>) => request<NodeDatabaseBinding>("POST", "/api/node-database-bindings", body),
  updateNodeDatabaseBinding: (id: string, patch: Record<string, unknown>) => request<NodeDatabaseBinding>("PATCH", `/api/node-database-bindings/${id}`, patch),
  deleteNodeDatabaseBinding: (id: string) => request<{ ok: boolean }>("DELETE", `/api/node-database-bindings/${id}`),

  listBackups: () => request<Backup[]>("GET", "/api/backups"),
  pageBackups: (filter: { q?: string; offset?: number; limit?: number } = {}) =>
    request<Paginated<Backup>>("GET", `/api/backups${qs({ ...filter, limit: filter.limit ?? 20, offset: filter.offset ?? 0 })}`),
  createBackup: (label: string, reason: string) =>
    request<Backup>("POST", "/api/backups", { label, reason }),
  restoreBackup: (id: string, confirmation: string) =>
    request<{ ok: boolean; backup: Backup; restored: Record<string, number> }>("POST", `/api/backups/${id}/restore`, { confirmation }),
};
