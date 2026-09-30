import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { LlmCredentialVault } from "./llmCredentials.js";
import type {
  AgentMessage,
  AgentMessageInput,
  AgentApproval,
  AgentApprovalDecision,
  AgentApprovalKind,
  AgentApprovalStatus,
  AgentSession,
  AgentSessionInput,
  AgentWorkspace,
  AgentWorkspaceSnapshot,
  AgentBlueprintKey,
  AgentBlueprintOverride,
  AuditEvent,
  Backup,
  DatabaseModel,
  DatabaseModelInput,
  NodeDatabaseBinding,
  NodeDatabaseBindingInput,
  DesignDoc,
  DesignDocInput,
  DocumentReference,
  DocumentReferenceInput,
  DocumentRevision,
  Diagram,
  DiagramInput,
  DiagramNode,
  DiagramTemplate,
  DiagramTemplateContent,
  DiagramTemplateScope,
  DiagramTemplateThumbnailMeta,
  Evidence,
  GovernanceRecord,
  FreeformAsset,
  FreeformDocument,
  LlmProfile,
  LlmProfileInput,
  Paginated,
  PlanItem,
  PlanItemInput,
  Project,
  ProjectWorkspace,
  ProjectWorkspaceNode,
  PrototypeStored,
  WorkNode,
} from "../shared/types.js";
import { PROJECT_WORKFLOW_POLICY } from "../shared/workflowPolicy.js";
import { isActiveDeliveryPlan, isExecutableDeliveryPlan } from "./planPolicy.js";
import { assertNoIntroducedDiagramGroupOverlap } from "../shared/diagramGroups.js";
import { normalizeAgentId, normalizeRoleAssignments } from "../shared/planRoles.js";
import { ensureAgentSecuritySchema } from "./agentSecurity.js";
import { normalizePrototypePayload, prototypeFingerprint, PROTOTYPE_VERSION_LIMIT } from "../shared/prototype.js";
import { freeformDocumentFingerprint, normalizeFreeformDocument, FREEFORM_SCHEMA_VERSION } from "../shared/freeform.js";
import { normalizeLayerState } from "../shared/layers.js";
import { normalizeComponentLibrary } from "../shared/components.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export class PrototypeDraftConflictError extends Error {}
export class PrototypeDraftCorruptError extends Error {}
export class FreeformDraftConflictError extends Error {
  constructor(message: string, readonly serverUpdatedAt: string | null) { super(message); }
}
export class FreeformDocumentCorruptError extends Error {}
export class FreeformAssetRejectedError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
export class DiagramTemplateNameConflictError extends Error {}
export class DiagramTemplateRevisionConflictError extends Error {
  constructor(message: string, readonly serverUpdatedAt: string | null) { super(message); }
}
export class DiagramTemplateRevokedError extends Error {}
export class ProjectRepositoryError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

/** Repository identities are labels only: never resolve them as URLs or filesystem paths. */
export function normalizeExternalRepositoryId(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ProjectRepositoryError(400, "EXTERNAL_REPOSITORY_ID_INVALID", "externalRepositoryId 必须是字符串");
  }
  const normalized = value.trim();
  if (normalized.length > 500 || !/^(?:[A-Za-z0-9][A-Za-z0-9._:/@-]*)?$/.test(normalized)) {
    throw new ProjectRepositoryError(400, "EXTERNAL_REPOSITORY_ID_INVALID", "externalRepositoryId 必须为空或不超过 500 字符的安全仓库标识");
  }
  return normalized;
}

function assertProjectRepositoryMode(repositoryPath: string, externalRepositoryId: string): void {
  if (repositoryPath && externalRepositoryId) {
    throw new ProjectRepositoryError(400, "PROJECT_REPOSITORY_MODE_CONFLICT", "repositoryPath 与 externalRepositoryId 不能同时设置");
  }
}

/**
 * 子画布镜像根节点索引：diagramId → 指向该画布的父节点标签集合。
 * 子画布入口节点与父侧入口节点同名，属占位节点，交付状态由父侧节点承载。
 */
export function buildChildRootLabelIndex(diagrams: Diagram[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const diagram of diagrams) {
    for (const node of diagram.nodes) {
      for (const childId of node.linkDiagramIds ?? []) {
        const labels = index.get(childId) ?? new Set<string>();
        labels.add(node.label.trim().toLowerCase());
        index.set(childId, labels);
      }
    }
  }
  return index;
}

/** 该节点是否为子画布镜像根节点（占位节点，不参与交付门禁）。 */
export function isChildDiagramRootNode(index: Map<string, Set<string>>, diagram: Diagram, node: DiagramNode): boolean {
  return Boolean(index.get(diagram.id)?.has(node.label.trim().toLowerCase()));
}

/** 单调递增的修订时间戳：保证同一毫秒内的连续写入仍严格递增，供 CAS 与列表排序使用。 */
export function nextPrototypeRevision(previous?: string): string {
  const now = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(previousTime) && previousTime >= now ? previousTime + 1 : now).toISOString();
}

export interface ProjectWorkspaceReadData {
  project?: Project;
  diagrams?: Diagram[];
  workspaceNodes?: ProjectWorkspaceNode[];
  plans?: PlanItem[];
  documents?: DesignDoc[];
  evidence?: Evidence[];
}

export interface EvidencePageQuery {
  projectId: string;
  nodeId?: string;
  planItemId?: string;
  q?: string;
  resultStatus?: Evidence["resultStatus"];
  limit: number;
  offset: number;
}

export interface DesignDocPageQuery {
  projectId?: string;
  q?: string;
  status?: DesignDoc["status"];
  category?: DesignDoc["category"];
  targetType?: DocumentReference["targetType"];
  targetId?: string;
  limit: number;
  offset: number;
}

interface ProjectRow {
  id: string; code: string; name: string; summary: string; stage: string; health: string;
  progress: number; risk_level: string; risk_summary: string; blocker_summary: string;
  next_step: string; repository_path: string; external_repository_id: string; start_at: string; due_at: string;
  created_at: string; updated_at: string;
}

interface WorkNodeRow {
  id: string; project_id: string; parent_id: string | null; kind: string; title: string;
  description: string; priority: string; owner: string; requirement_status: string;
  design_status: string; development_status: string; test_status: string; progress: number;
  start_at: string; due_at: string; position: number; created_at: string; updated_at: string;
}

interface PlanItemRow {
  id: string; project_id: string; diagram_id: string | null; diagram_node_id: string | null;
  parent_id: string | null; kind: string; title: string;
  description: string; status: string; priority: string; progress: number; owner: string; role_assignments: string;
  version_tag: string; start_at: string; due_at: string; dependency_ids: string;
  blocked_reason: string; completed_at: string;
  lifecycle_status: string; proposal_revision: number; design_revision_ids: string; proposed_by: string; submitted_at: string;
  approved_by: string; approved_at: string; rejected_by: string; rejected_at: string; rejection_reason: string;
  implementation_revision: string; completed_by: string; audit_status: string; audited_by: string; audited_at: string;
  manager_decision: string; manager_decision_by: string; manager_decision_at: string;
  rework_of_plan_id: string | null; correlation_id: string;
  created_at: string; updated_at: string;
}

interface EvidenceRow {
  id: string; project_id: string; node_id: string | null; source_type: string;
  source_path: string; command: string; result_status: string; summary: string;
  details: string; commit_sha: string; digest: string; collected_at: string;
  plan_item_id: string | null; acceptance_criterion_key: string; document_revision_id: string | null;
  actor_role: string; agent_id: string; session_id: string | null; run_id: string; supersedes_evidence_id: string | null;
  status: string; revoked_reason: string; revoked_at: string;
}

interface GovernanceRow {
  id: string; project_id: string; type: string; title: string; content: string;
  rationale: string; status: string; author: string; created_at: string;
}

interface DesignDocRow {
  id: string; project_id: string; node_id: string | null; current_revision_id: string; title: string;
  decision_ids: string;
  category: string; summary: string; status: string; version: string; author: string;
  source_url: string; content: string;
  created_at: string; updated_at: string;
}

interface DocumentRevisionRow {
  id: string; project_id: string; document_id: string; category: string; title: string;
  summary: string; status: string; version: string; author: string; source_url: string;
  content: string; created_at: string;
}

interface DocumentReferenceRow {
  id: string; project_id: string; document_id: string; document_revision_id: string;
  target_type: string; target_id: string; relation_type: string; created_at: string;
}

interface DiagramRow {
  id: string; project_id: string; title: string; type: string; nodes: string; edges: string;
  groups: string; layers: string | null; components: string | null; created_at: string; updated_at: string;
}

/** 模板绑定表行（diagram_templates，见节点 whiteboard-layers-templates 设计 5.1）。 */
interface DiagramTemplateRow {
  id: string; project_id: string | null; scope: string; name: string; schema_version: string;
  content: string; thumbnail_meta: string; created_by: string; created_at: string; updated_at: string;
  revoked_at: string | null;
}

interface PrototypeDraftRow {
  diagram_id: string;
  project_id: string;
  payload: string;
  updated_at: string;
}

interface FreeformDocumentRow {
  diagram_id: string;
  project_id: string;
  schema_version: number;
  payload: string;
  updated_at: string;
}

interface FreeformAssetRow {
  id: string;
  project_id: string;
  mime: string;
  sha256: string;
  byte_size: number;
  storage_path: string;
  width: number;
  height: number;
  created_at: string;
}

interface DatabaseModelRow {
  id: string; project_id: string; name: string; dialect: string; tables: string; relations: string;
  created_at: string; updated_at: string;
}

interface NodeDatabaseBindingRow {
  id: string; project_id: string; diagram_id: string; diagram_node_id: string;
  database_model_id: string; schema_name: string; table_name: string; operations: string;
  purpose: string; created_at: string; updated_at: string;
}

interface LlmProfileRow {
  id: string; name: string; provider: string; protocol: string; base_url: string; auth_mode: string;
  api_key_env: string; models: string; default_model: string; enabled: number;
  reasoning_effort: string; timeout_ms: number; created_at: string; updated_at: string;
}

interface AgentWorkspaceRow {
  id: string; project_id: string; default_profile_id: string | null;
  created_at: string; updated_at: string;
}

interface AgentSessionRow {
  id: string; workspace_id: string; project_id: string; profile_id: string; model: string;
  codex_thread_id: string | null; title: string; control_mode: string; status: string; last_error: string;
  created_at: string; updated_at: string;
}

interface AgentApprovalRow {
  id: string; project_id: string; session_id: string; kind: string; title: string; summary: string;
  details: string; status: string; decision: string | null; expires_at: string; created_at: string; resolved_at: string;
}

interface AgentMessageRow {
  id: string; session_id: string; project_id: string; role: string; content: string;
  status: string; page_context: string | null; created_at: string; updated_at: string;
}

interface AgentBlueprintOverrideRow {
  key: string; name: string; purpose: string; responsibilities: string; boundaries: string;
  allowed_mcp_tools: string; updated_at: string;
}

interface AuditRow {
  id: string; project_id: string | null; entity_type: string; entity_id: string;
  action: string; before: string | null; after: string | null; actor: string;
  source: string; created_at: string;
  correlation_id: string; client_id: string; session_id: string; model: string; parent_event_id: string | null;
}

function mapProject(r: ProjectRow): Project {
  return {
    id: r.id, code: r.code, name: r.name, summary: r.summary,
    stage: r.stage as Project["stage"], health: r.health as Project["health"],
    progress: r.progress, riskLevel: r.risk_level as Project["riskLevel"],
    riskSummary: r.risk_summary, blockerSummary: r.blocker_summary, nextStep: r.next_step,
    repositoryPath: r.repository_path, externalRepositoryId: r.external_repository_id ?? "", startAt: r.start_at, dueAt: r.due_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapNode(r: WorkNodeRow): WorkNode {
  return {
    id: r.id, projectId: r.project_id, parentId: r.parent_id,
    kind: r.kind as WorkNode["kind"], title: r.title, description: r.description,
    priority: r.priority as WorkNode["priority"], owner: r.owner,
    requirementStatus: r.requirement_status as WorkNode["requirementStatus"],
    designStatus: r.design_status as WorkNode["designStatus"],
    developmentStatus: r.development_status as WorkNode["developmentStatus"],
    testStatus: r.test_status as WorkNode["testStatus"],
    progress: r.progress, startAt: r.start_at, dueAt: r.due_at, position: r.position,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapPlan(r: PlanItemRow): PlanItem {
  let dependencyIds: string[] = [];
  try { dependencyIds = JSON.parse(r.dependency_ids) as string[]; } catch { dependencyIds = []; }
  let roleAssignments = normalizeRoleAssignments();
  try { roleAssignments = normalizeRoleAssignments(JSON.parse(r.role_assignments || "{}")); } catch { roleAssignments = normalizeRoleAssignments(); }
  return {
    id: r.id, projectId: r.project_id, diagramId: r.diagram_id, diagramNodeId: r.diagram_node_id, parentId: r.parent_id,
    kind: r.kind as PlanItem["kind"], title: r.title, description: r.description,
    status: r.status as PlanItem["status"], priority: r.priority as PlanItem["priority"],
    progress: r.progress, owner: r.owner, roleAssignments, versionTag: r.version_tag,
    startAt: r.start_at, dueAt: r.due_at, dependencyIds,
    blockedReason: r.blocked_reason, completedAt: r.completed_at,
    lifecycleStatus: (r.lifecycle_status || "legacy") as PlanItem["lifecycleStatus"],
    proposalRevision: r.proposal_revision ?? 0, designRevisionIds: parseArray<string>(r.design_revision_ids || "[]"),
    proposedBy: r.proposed_by || "", submittedAt: r.submitted_at || "",
    approvedBy: r.approved_by || "", approvedAt: r.approved_at || "", rejectedBy: r.rejected_by || "",
    rejectedAt: r.rejected_at || "", rejectionReason: r.rejection_reason || "",
    implementationRevision: r.implementation_revision || "", completedBy: r.completed_by || "",
    auditStatus: (r.audit_status || "not_requested") as PlanItem["auditStatus"],
    auditedBy: r.audited_by || "", auditedAt: r.audited_at || "",
    managerDecision: (r.manager_decision || "pending") as PlanItem["managerDecision"],
    managerDecisionBy: r.manager_decision_by || "", managerDecisionAt: r.manager_decision_at || "",
    reworkOfPlanId: r.rework_of_plan_id ?? null, correlationId: r.correlation_id || r.id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapEvidence(r: EvidenceRow): Evidence {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(r.details) as Record<string, unknown>; } catch { details = {}; }
  return {
    id: r.id, projectId: r.project_id, nodeId: r.node_id,
    sourceType: r.source_type as Evidence["sourceType"], sourcePath: r.source_path,
    command: r.command, resultStatus: r.result_status as Evidence["resultStatus"],
    summary: r.summary, details, commitSha: r.commit_sha, digest: r.digest,
    planItemId: r.plan_item_id ?? null, acceptanceCriterionKey: r.acceptance_criterion_key || "",
    documentRevisionId: r.document_revision_id ?? null,
    actorRole: (r.actor_role || null) as Evidence["actorRole"], agentId: r.agent_id || "",
    sessionId: r.session_id ?? null,
    runId: r.run_id || "", supersedesEvidenceId: r.supersedes_evidence_id ?? null,
    status: (r.status || "active") as Evidence["status"], revokedReason: r.revoked_reason || "",
    revokedAt: r.revoked_at || "",
    collectedAt: r.collected_at,
  };
}

function mapGovernance(r: GovernanceRow): GovernanceRecord {
  return {
    id: r.id, projectId: r.project_id, type: r.type as GovernanceRecord["type"],
    title: r.title, content: r.content, rationale: r.rationale,
    status: r.status as GovernanceRecord["status"], author: r.author, createdAt: r.created_at,
  };
}

function mapDesignDoc(r: DesignDocRow): DesignDoc {
  return {
    id: r.id, projectId: r.project_id, currentRevisionId: r.current_revision_id, title: r.title,
    category: r.category as DesignDoc["category"],
    summary: r.summary, status: r.status as DesignDoc["status"], version: r.version,
    author: r.author, sourceUrl: r.source_url, content: r.content,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapDocumentRevision(r: DocumentRevisionRow): DocumentRevision {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id,
    category: r.category as DocumentRevision["category"], title: r.title,
    summary: r.summary, status: r.status as DocumentRevision["status"], version: r.version,
    author: r.author, sourceUrl: r.source_url, content: r.content, createdAt: r.created_at,
  };
}

function mapDocumentReference(r: DocumentReferenceRow): DocumentReference {
  return {
    id: r.id, projectId: r.project_id, documentId: r.document_id,
    documentRevisionId: r.document_revision_id,
    targetType: r.target_type as DocumentReference["targetType"], targetId: r.target_id,
    relationType: r.relation_type as DocumentReference["relationType"], createdAt: r.created_at,
  };
}

function mapLlmProfile(r: LlmProfileRow, credentials: LlmCredentialVault): LlmProfile {
  return credentials.describe({
    id: r.id,
    name: r.name,
    provider: r.provider,
    authMode: r.auth_mode === "chatgpt" ? "chatgpt" : "api-key",
    protocol: r.protocol as LlmProfile["protocol"],
    baseUrl: r.base_url,
    apiKeyEnv: r.api_key_env,
    models: parseArray<string>(r.models),
    defaultModel: r.default_model,
    enabled: r.enabled === 1,
    reasoningEffort: r.reasoning_effort as LlmProfile["reasoningEffort"],
    timeoutMs: r.timeout_ms,
    credentialConfigured: false,
    credentialMasked: "",
    credentialSource: "missing",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function mapAgentWorkspace(r: AgentWorkspaceRow): AgentWorkspace {
  return {
    id: r.id,
    projectId: r.project_id,
    defaultProfileId: r.default_profile_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAgentBlueprintOverride(r: AgentBlueprintOverrideRow): AgentBlueprintOverride {
  return {
    key: r.key as AgentBlueprintKey,
    name: r.name,
    purpose: r.purpose,
    responsibilities: parseArray<string>(r.responsibilities),
    boundaries: parseArray<string>(r.boundaries),
    allowedMcpTools: parseArray<string>(r.allowed_mcp_tools),
    updatedAt: r.updated_at,
  };
}

function mapAgentSession(r: AgentSessionRow): AgentSession {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    profileId: r.profile_id,
    model: r.model,
    codexThreadId: r.codex_thread_id,
    title: r.title,
    controlMode: r.control_mode as AgentSession["controlMode"],
    status: r.status as AgentSession["status"],
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAgentApproval(r: AgentApprovalRow): AgentApproval {
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(r.details) as Record<string, unknown>; } catch { details = {}; }
  return {
    id: r.id, projectId: r.project_id, sessionId: r.session_id,
    kind: r.kind as AgentApprovalKind, title: r.title, summary: r.summary, details,
    status: r.status as AgentApprovalStatus, decision: r.decision as AgentApprovalDecision | null,
    expiresAt: r.expires_at, createdAt: r.created_at, resolvedAt: r.resolved_at,
  };
}

function mapAgentMessage(r: AgentMessageRow): AgentMessage {
  let pageContext: AgentMessage["pageContext"] = null;
  try { pageContext = r.page_context ? JSON.parse(r.page_context) as AgentMessage["pageContext"] : null; } catch { pageContext = null; }
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    role: r.role as AgentMessage["role"],
    content: r.content,
    status: r.status as AgentMessage["status"],
    pageContext,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseArray<T>(raw: string): T[] {
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}

/**
 * Normalize a diagram node's sub-canvas links to the canonical `linkDiagramIds`
 * array. Legacy data stored `linkDiagramId` as a single string; keeping this
 * normalization at the store boundary makes reads/writes consistent everywhere.
 */
export function normalizeDiagramNodeLinks(node: DiagramNode): DiagramNode {
  const legacyNode = node as DiagramNode & { linkDiagramId?: string; acceptanceEvidence?: LegacyDiagramEvidence[] };
  const legacy = legacyNode.linkDiagramId;
  const raw = Array.isArray(node.linkDiagramIds) ? node.linkDiagramIds : legacy ? [legacy] : [];
  const links = [...new Set((raw.filter(Boolean) as string[]).map((id) => id.trim()).filter(Boolean))].slice(0, 16);
  const { linkDiagramId: _legacy, acceptanceEvidence: _legacyEvidence, ...rest } = legacyNode;
  return { ...rest, linkDiagramIds: links };
}

interface LegacyDiagramEvidence {
  id: string;
  kind: string;
  title: string;
  url: string;
  note?: string;
}

type LegacyDiagramNode = DiagramNode & { acceptanceEvidence?: LegacyDiagramEvidence[] };

function migratedEvidenceId(diagramId: string, nodeId: string, evidenceId: string): string {
  return `migrated-${createHash("sha256").update(`${diagramId}:${nodeId}:${evidenceId}`).digest("hex").slice(0, 32)}`;
}

function migratedEvidence(diagram: Pick<Diagram, "id" | "projectId" | "updatedAt">, node: LegacyDiagramNode, item: LegacyDiagramEvidence): Evidence {
  const title = item.title?.trim() || "迁移的验收证据";
  const sourcePath = item.url?.trim() || "";
  const details = {
    kind: item.kind || "链接",
    note: item.note ?? "",
    migratedFrom: "diagramNode.acceptanceEvidence",
    diagramId: diagram.id,
    legacyEvidenceId: item.id,
  };
  return {
    id: migratedEvidenceId(diagram.id, node.id, item.id),
    projectId: diagram.projectId,
    nodeId: node.id,
    sourceType: "manual",
    sourcePath,
    command: "",
    resultStatus: item.title?.trim() && sourcePath ? "pass" : "info",
    summary: title,
    details,
    commitSha: "",
    digest: createHash("sha256").update(JSON.stringify({ title, sourcePath, ...details })).digest("hex"),
    planItemId: null,
    acceptanceCriterionKey: "",
    documentRevisionId: null,
    actorRole: null,
    agentId: "",
    sessionId: null,
    runId: "legacy-migration",
    supersedesEvidenceId: null,
    status: "active",
    revokedReason: "",
    revokedAt: "",
    collectedAt: node.deliveryUpdatedAt || diagram.updatedAt || nowIso(),
  };
}

function legacyEvidenceFromDiagrams(diagrams: Diagram[]): Evidence[] {
  return diagrams.flatMap((diagram) => diagram.nodes.flatMap((rawNode) => {
    const node = rawNode as LegacyDiagramNode;
    return (node.acceptanceEvidence ?? []).map((item) => migratedEvidence(diagram, node, item));
  }));
}

function mapDiagram(r: DiagramRow): Diagram {
  const diagram: Diagram = {
    id: r.id, projectId: r.project_id, title: r.title, type: r.type as Diagram["type"],
    nodes: (parseArray<Diagram["nodes"][number]>(r.nodes) as Diagram["nodes"]).map(normalizeDiagramNodeLinks),
    edges: parseArray<Diagram["edges"][number]>(r.edges) as Diagram["edges"],
    groups: parseArray<Diagram["groups"][number]>(r.groups) as Diagram["groups"],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  // 图层/组件是旁路载荷：仅在物理列有值时挂载，且读取即归一化（不写库）。
  // 逐类传入 nodeIds/edgeIds：避免只传一类时连带丢弃其他类的元素级覆盖（自由元素 id 由自由层文档权威，
  // 在 API 层用 layerStateFor 传入完整三类 id 完成孤儿过滤）。
  const layers = parseNullableObject(r.layers ?? null);
  if (layers) diagram.layers = normalizeLayerState(layers, {
    nodeIds: diagram.nodes.map((node) => node.id),
    edgeIds: diagram.edges.map((edge) => edge.id),
  }).state;
  const components = parseNullableObject(r.components ?? null);
  if (components) diagram.components = normalizeComponentLibrary(components);
  return diagram;
}

function parseNullableObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function mapDiagramTemplate(r: DiagramTemplateRow): DiagramTemplate {
  return {
    id: r.id,
    projectId: r.project_id,
    scope: r.scope as DiagramTemplate["scope"],
    name: r.name,
    schemaVersion: r.schema_version,
    content: JSON.parse(r.content) as DiagramTemplate["content"],
    thumbnailMeta: JSON.parse(r.thumbnail_meta) as DiagramTemplate["thumbnailMeta"],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
  };
}

function mapFreeformAsset(r: FreeformAssetRow): FreeformAsset {
  return {
    id: r.id, projectId: r.project_id, mime: r.mime, sha256: r.sha256, byteSize: r.byte_size,
    storagePath: r.storage_path, width: r.width, height: r.height, createdAt: r.created_at,
  };
}

function mapDatabaseModel(r: DatabaseModelRow): DatabaseModel {
  return {
    id: r.id, projectId: r.project_id, name: r.name, dialect: r.dialect as DatabaseModel["dialect"],
    tables: parseArray<DatabaseModel["tables"][number]>(r.tables) as DatabaseModel["tables"],
    relations: parseArray<DatabaseModel["relations"][number]>(r.relations) as DatabaseModel["relations"],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function mapNodeDatabaseBinding(r: NodeDatabaseBindingRow): NodeDatabaseBinding {
  return {
    id: r.id,
    projectId: r.project_id,
    diagramId: r.diagram_id,
    diagramNodeId: r.diagram_node_id,
    databaseModelId: r.database_model_id,
    schemaName: r.schema_name,
    tableName: r.table_name,
    operations: parseArray<NodeDatabaseBinding["operations"][number]>(r.operations),
    purpose: r.purpose,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAudit(r: AuditRow): AuditEvent {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return null;
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  };
  return {
    id: r.id, projectId: r.project_id, entityType: r.entity_type, entityId: r.entity_id,
    action: r.action, before: parse(r.before), after: parse(r.after),
    actor: r.actor, source: r.source as AuditEvent["source"],
    correlationId: r.correlation_id || undefined, clientId: r.client_id || undefined,
    sessionId: r.session_id || undefined, model: r.model || undefined,
    parentEventId: r.parent_event_id ?? null, createdAt: r.created_at,
  };
}

export interface ProjectFilter {
  stage?: string;
  health?: string;
  q?: string;
}

export interface AuditFilter {
  projectId?: string;
  q?: string;
  source?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  sessionId?: string;
  offset?: number;
  limit?: number;
}

interface ResolvedProjectWorkspaceReadData {
  project: Project;
  diagrams: Diagram[];
  workspaceNodes: ProjectWorkspaceNode[];
  plans: PlanItem[];
  documents: DesignDoc[];
  evidence: Evidence[];
}

interface ProjectWorkspaceDerivation {
  project: Project;
  deliveryPlans: PlanItem[];
  backlogPlans: PlanItem[];
  activeEvidence: Evidence[];
  completedNodes: number;
  acceptedNodes: number;
  blockedNodes: number;
  pendingAcceptanceNodes: number;
  missingEvidenceNodes: number;
  currentPlan: PlanItem | null;
  nextPlan: PlanItem | null;
}

function deriveProjectWorkspace(data: ResolvedProjectWorkspaceReadData): ProjectWorkspaceDerivation {
  const { project: base, workspaceNodes: nodes, plans, documents, evidence } = data;
  const deliveryNodeIds = new Set(nodes.map(({ node }) => node.id));
  const deliveryPlans = plans.filter((plan) => isActiveDeliveryPlan(plan) && Boolean(plan.diagramNodeId && deliveryNodeIds.has(plan.diagramNodeId)));
  const backlogPlans = plans.filter((plan) => plan.lifecycleStatus !== "superseded"
    && (!isExecutableDeliveryPlan(plan) || !plan.diagramNodeId || !deliveryNodeIds.has(plan.diagramNodeId)));
  const activeEvidence = evidence.filter((item) => item.status === "active");
  const passingEvidenceNodeIds = new Set(activeEvidence.filter((item) => item.resultStatus === "pass" && item.nodeId).map((item) => item.nodeId!));
  const plansByNode = new Map<string, PlanItem[]>();
  for (const plan of deliveryPlans) {
    if (!plan.diagramNodeId) continue;
    const list = plansByNode.get(plan.diagramNodeId) ?? [];
    list.push(plan);
    plansByNode.set(plan.diagramNodeId, list);
  }
  const hasAcceptanceEvidence = (node: DiagramNode): boolean => passingEvidenceNodeIds.has(node.id);
  const nodeProgress = (node: DiagramNode): number => {
    const nodePlans = plansByNode.get(node.id) ?? [];
    if (node.developmentStatus === "已完成" && node.acceptanceStatus === "已通过" && hasAcceptanceEvidence(node) && nodePlans.length > 0 && nodePlans.every((plan) => plan.status === "已完成")) return 100;
    if (node.developmentStatus === "已完成") return 85;
    if (node.developmentStatus === "待验收") return 75;
    if (node.developmentStatus === "开发中") return 40;
    if (node.developmentStatus === "已阻塞") return 20;
    return 0;
  };
  const completedNodes = nodes.filter(({ node }) => node.developmentStatus === "已完成").length;
  const acceptedNodes = nodes.filter(({ node }) => node.acceptanceStatus === "已通过").length;
  const blockedNodes = nodes.filter(({ node }) => node.developmentStatus === "已阻塞").length;
  const pendingAcceptanceNodes = nodes.filter(({ node }) => node.developmentStatus === "待验收" || (node.developmentStatus === "已完成" && node.acceptanceStatus !== "已通过")).length;
  const missingEvidenceNodes = nodes.filter(({ node }) => node.acceptanceStatus === "已通过" && !hasAcceptanceEvidence(node)).length;
  const deliveryReady = nodes.length > 0 && acceptedNodes === nodes.length && missingEvidenceNodes === 0 && deliveryPlans.length > 0 && deliveryPlans.every((plan) => plan.status === "已完成");
  const progress = nodes.length === 0 ? 0 : Math.round(nodes.reduce((sum, item) => sum + nodeProgress(item.node), 0) / nodes.length);
  const today = new Date().toISOString().slice(0, 10);
  const overduePlans = deliveryPlans.filter((plan) => plan.dueAt && plan.dueAt < today && plan.status !== "已完成");
  const currentPlan = deliveryPlans.find((plan) => plan.status === "已阻塞") ?? deliveryPlans.find((plan) => plan.status === "进行中") ?? null;
  const nextPlan = deliveryPlans.find((plan) => plan.status === "未开始") ?? null;
  const nextNode = nodes.find(({ node }) => node.acceptanceStatus !== "已通过")?.node ?? null;
  const unconfigured = nodes.length === 0 && plans.length === 0 && documents.length === 0;
  const stage: Project["stage"] = unconfigured
    ? "探索"
    : deliveryReady
      ? "交付"
      : pendingAcceptanceNodes > 0
        ? "测试"
        : nodes.some(({ node }) => ["开发中", "已完成", "已阻塞"].includes(node.developmentStatus ?? "未开发"))
          ? "开发"
          : documents.length > 0
            ? "设计"
            : base.stage;
  const health: Project["health"] = blockedNodes > 0
    ? "阻塞"
    : overduePlans.some((plan) => plan.priority === "P0" || plan.priority === "P1")
      ? "高风险"
      : overduePlans.length > 0 || missingEvidenceNodes > 0
        ? "关注"
        : base.health;
  const nextStep = currentPlan?.status === "已阻塞"
    ? `解除阻塞：${currentPlan.title}`
    : currentPlan
      ? `继续：${currentPlan.title}`
      : nextPlan
        ? `下一步：${nextPlan.title}`
        : nextNode
          ? `推进「${nextNode.label}」`
          : nodes.length > 0
            ? "全部节点已完成并验收"
            : "在系统主画布中补充模块与功能";

  return {
    project: { ...base, stage, health, progress, nextStep, unconfigured },
    deliveryPlans,
    backlogPlans,
    activeEvidence,
    completedNodes,
    acceptedNodes,
    blockedNodes,
    pendingAcceptanceNodes,
    missingEvidenceNodes,
    currentPlan,
    nextPlan,
  };
}

function databasePage<T>(items: T[], total: number, offset: number): Paginated<T> {
  const nextOffset = offset + items.length;
  return { total, count: items.length, offset, items, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
}

function databaseTextMatches(value: unknown, query: string): boolean {
  return String(value ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export class Store {
  readonly db: Database.Database;
  readonly dataDir: string;
  private readonly credentials: LlmCredentialVault;

  constructor(filePath: string, dataDir?: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.dataDir = dataDir ?? dirname(filePath);
    this.credentials = new LlmCredentialVault(join(this.dataDir, "store"));
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    const projectColumns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "external_repository_id")) {
      this.db.exec("ALTER TABLE projects ADD COLUMN external_repository_id TEXT NOT NULL DEFAULT ''");
    }
    ensureAgentSecuritySchema(this);
    try { this.db.exec("ALTER TABLE diagrams ADD COLUMN groups TEXT NOT NULL DEFAULT '[]'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE diagrams ADD COLUMN type TEXT NOT NULL DEFAULT 'free'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN diagram_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN diagram_node_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'legacy'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN proposal_revision INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN design_revision_ids TEXT NOT NULL DEFAULT '[]'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN proposed_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN submitted_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN approved_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN rejected_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN rejected_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN rejection_reason TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN implementation_revision TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN completed_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN audit_status TEXT NOT NULL DEFAULT 'not_requested'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN audited_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN audited_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN manager_decision TEXT NOT NULL DEFAULT 'pending'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN manager_decision_by TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN manager_decision_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN rework_of_plan_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE plan_items ADD COLUMN role_assignments TEXT NOT NULL DEFAULT '{}'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN plan_item_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN acceptance_criterion_key TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN document_revision_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN actor_role TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN session_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN run_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN supersedes_evidence_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN revoked_reason TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE evidence ADD COLUMN revoked_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE audit_events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE audit_events ADD COLUMN client_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE audit_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE audit_events ADD COLUMN model TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE audit_events ADD COLUMN parent_event_id TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE design_docs ADD COLUMN category TEXT NOT NULL DEFAULT '需求文档'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE design_docs ADD COLUMN source_url TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE design_docs ADD COLUMN decision_ids TEXT NOT NULL DEFAULT '[]'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE design_docs ADD COLUMN current_revision_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE agent_sessions ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'restricted'"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE diagrams ADD COLUMN layers TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE diagrams ADD COLUMN components TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE llm_profiles ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'api-key'"); } catch { /* column exists */ }
    let addedReasoningEffort = false;
    try {
      this.db.exec("ALTER TABLE llm_profiles ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'none'");
      addedReasoningEffort = true;
    } catch { /* column exists */ }
    if (addedReasoningEffort) {
      this.db.prepare("UPDATE llm_profiles SET reasoning_effort = 'high' WHERE lower(provider) = 'deepseek' OR lower(base_url) LIKE '%api.deepseek.com%'").run();
    }
    this.db.prepare("UPDATE agent_approvals SET status = 'expired', decision = 'deny', resolved_at = ? WHERE status = 'pending'").run(nowIso());
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_diagrams_one_main_per_project ON diagrams(project_id) WHERE type = 'main'");
    this.migratePlanRoleAssignments();
    this.repairDraftDesignChangeReworkPlans();
    this.migrateInlineAcceptanceEvidence();
    this.migrateDocumentReferences();
    this.repairDuplicateProjectDocumentReferences();
    this.ensureAllProjectsHaveMainDiagrams();
  }

  private migratePlanRoleAssignments(): void {
    const rows = this.db.prepare(
      "SELECT id, owner, proposed_by, audited_by, role_assignments FROM plan_items",
    ).all() as Array<Pick<PlanItemRow, "id" | "owner" | "proposed_by" | "audited_by" | "role_assignments">>;
    const update = this.db.prepare("UPDATE plan_items SET role_assignments = ? WHERE id = ?");
    for (const row of rows) {
      let existing = normalizeRoleAssignments();
      try { existing = normalizeRoleAssignments(JSON.parse(row.role_assignments || "{}")); } catch { existing = normalizeRoleAssignments(); }
      if (existing.designer.agentId || existing.builder.agentId || existing.auditor.agentId) continue;
      const builderId = row.owner.trim();
      const designerId = normalizeAgentId(row.proposed_by) !== normalizeAgentId(builderId) ? row.proposed_by.trim() : "";
      const auditorId = row.audited_by.trim();
      const auditorConflicts = [designerId, builderId].filter(Boolean)
        .some((value) => normalizeAgentId(value) === normalizeAgentId(auditorId));
      const migrated = normalizeRoleAssignments({
        designer: { agentId: designerId, displayName: designerId },
        builder: { agentId: builderId, displayName: builderId },
        auditor: { agentId: auditorConflicts ? "" : auditorId, displayName: auditorConflicts ? "" : auditorId },
      });
      update.run(JSON.stringify(migrated), row.id);
    }
  }

  private repairDraftDesignChangeReworkPlans(): void {
    const migrationId = "2026-09-design-change-rework-plan-lifecycle";
    const applied = this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migrationId);
    if (applied) return;
    const repair = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE plan_items
         SET lifecycle_status = 'rework',
             rejected_by = CASE WHEN rejected_by = '' THEN 'design_change' ELSE rejected_by END,
             rejected_at = CASE WHEN rejected_at = '' THEN updated_at ELSE rejected_at END,
             rejection_reason = CASE
               WHEN rejection_reason = '' THEN '历史设计变更返工计划状态修复'
               ELSE rejection_reason
             END
         WHERE rework_of_plan_id IS NOT NULL
           AND lifecycle_status = 'draft'
           AND submitted_at = ''`,
      ).run();
      this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migrationId, nowIso());
    });
    repair();
  }

  private migrateDocumentReferences(): void {
    const rows = this.db.prepare("SELECT * FROM design_docs").all() as DesignDocRow[];
    const insertRevision = this.db.prepare(
      `INSERT OR IGNORE INTO document_revisions
       (id, project_id, document_id, category, title, summary, status, version, author, source_url, content, created_at)
       VALUES (@id, @projectId, @documentId, @category, @title, @summary, @status, @version, @author, @sourceUrl, @content, @createdAt)`,
    );
    const insertReference = this.db.prepare(
      `INSERT OR IGNORE INTO document_references
       (id, project_id, document_id, document_revision_id, target_type, target_id, relation_type, created_at)
       VALUES (@id, @projectId, @documentId, @documentRevisionId, @targetType, @targetId, @relationType, @createdAt)`,
    );
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        if (row.current_revision_id) continue;
        const revisionId = row.current_revision_id || newId();
        insertRevision.run({
          id: revisionId, projectId: row.project_id, documentId: row.id, category: row.category,
          title: row.title, summary: row.summary, status: row.status, version: row.version,
          author: row.author, sourceUrl: row.source_url, content: row.content, createdAt: row.updated_at || row.created_at,
        });
        if (row.node_id) {
          insertReference.run({
            id: newId(), projectId: row.project_id, documentId: row.id, documentRevisionId: revisionId,
            targetType: "diagramNode", targetId: row.node_id, relationType: "defines", createdAt: row.updated_at || row.created_at,
          });
        } else {
          insertReference.run({
            id: newId(), projectId: row.project_id, documentId: row.id, documentRevisionId: revisionId,
            targetType: "project", targetId: row.project_id, relationType: "defines", createdAt: row.updated_at || row.created_at,
          });
        }
        for (const decisionId of parseArray<string>(row.decision_ids)) {
          insertReference.run({
            id: newId(), projectId: row.project_id, documentId: row.id, documentRevisionId: revisionId,
            targetType: "governance", targetId: decisionId, relationType: "references", createdAt: row.updated_at || row.created_at,
          });
        }
        this.db.prepare("UPDATE design_docs SET current_revision_id = ?, node_id = NULL, decision_ids = '[]' WHERE id = ?").run(revisionId, row.id);
      }
    });
    migrate();
  }

  private repairDuplicateProjectDocumentReferences(): void {
    const migrationId = "2026-08-document-reference-project-duplicate";
    const applied = this.db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migrationId);
    if (applied) return;
    const repair = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM document_references AS project_ref
         WHERE project_ref.target_type = 'project'
           AND EXISTS (
             SELECT 1 FROM document_references AS node_ref
             WHERE node_ref.document_id = project_ref.document_id
               AND node_ref.target_type = 'diagramNode'
           )`,
      ).run();
      this.db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(migrationId, nowIso());
    });
    repair();
  }

  private migrateInlineAcceptanceEvidence(): void {
    const rows = this.db.prepare("SELECT * FROM diagrams").all() as DiagramRow[];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO evidence (id, project_id, node_id, source_type, source_path, command,
        result_status, summary, details, commit_sha, digest, collected_at)
       VALUES (@id, @projectId, @nodeId, @sourceType, @sourcePath, @command,
        @resultStatus, @summary, @detailsJson, @commitSha, @digest, @collectedAt)`,
    );
    const updateDiagram = this.db.prepare("UPDATE diagrams SET nodes = ? WHERE id = ?");
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const nodes = parseArray<LegacyDiagramNode>(row.nodes);
        if (!nodes.some((node) => Object.hasOwn(node, "acceptanceEvidence"))) continue;
        const diagram = { id: row.id, projectId: row.project_id, updatedAt: row.updated_at };
        let inserted = 0;
        for (const node of nodes) {
          for (const item of node.acceptanceEvidence ?? []) {
            const evidence = migratedEvidence(diagram, node, item);
            inserted += insert.run({ ...evidence, detailsJson: JSON.stringify(evidence.details) }).changes;
          }
        }
        const cleaned = nodes.map(normalizeDiagramNodeLinks);
        updateDiagram.run(JSON.stringify(cleaned), row.id);
        this.recordAudit({
          projectId: row.project_id,
          entityType: "diagram",
          entityId: row.id,
          action: "migrate_inline_evidence",
          before: { inlineEvidenceCount: nodes.reduce((count, node) => count + (node.acceptanceEvidence?.length ?? 0), 0) },
          after: { evidenceCreated: inserted, inlineFieldRemoved: true },
          actor: "system-migration",
          source: "system",
        });
      }
    });
    migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---------- projects ----------

  listProjects(filter: ProjectFilter = {}): Project[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.stage) { clauses.push("stage = @stage"); params.stage = filter.stage; }
    if (filter.health) { clauses.push("health = @health"); params.health = filter.health; }
    if (filter.q) {
      clauses.push("(name LIKE @q OR code LIKE @q OR summary LIKE @q)");
      params.q = `%${filter.q}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT p.*,
            CASE WHEN (SELECT COUNT(*) FROM work_nodes wn WHERE wn.project_id = p.id) > 0
                  OR   (SELECT COUNT(*) FROM plan_items pi WHERE pi.project_id = p.id) > 0
                 THEN 0 ELSE 1 END AS unconfigured
         FROM projects p ${where} ORDER BY p.updated_at DESC`
      )
      .all(params) as Array<ProjectRow & { unconfigured: number }>;
    return rows.map((r) => ({ ...mapProject(r), unconfigured: r.unconfigured === 1 }));
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  listProjectWorkspaceNodes(projectId: string, input: Pick<ProjectWorkspaceReadData, "diagrams" | "plans"> = {}): ProjectWorkspaceNode[] {
    const diagrams = input.diagrams ?? this.listDiagrams(projectId);
    const latestPlanByNode = new Map<string, PlanItem>();
    for (const plan of input.plans ?? this.listPlans(projectId)) {
      if (!isActiveDeliveryPlan(plan) || !plan.diagramNodeId) continue;
      const current = latestPlanByNode.get(plan.diagramNodeId);
      if (!current || current.updatedAt.localeCompare(plan.updatedAt) < 0) latestPlanByNode.set(plan.diagramNodeId, plan);
    }
    const childRootLabels = buildChildRootLabelIndex(diagrams);
    const trackedKinds = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryNodeKinds);
    const trackedDiagramTypes = new Set<string>(PROJECT_WORKFLOW_POLICY.deliveryDiagramTypes);
    const refs: ProjectWorkspaceNode[] = [];
    for (const diagram of diagrams) {
      if (!trackedDiagramTypes.has(diagram.type)) continue;
      for (const node of diagram.nodes) {
        if (!trackedKinds.has(node.kind)) continue;
        if (isChildDiagramRootNode(childRootLabels, diagram, node)) continue;
        refs.push({
          diagramId: diagram.id,
          diagramTitle: diagram.title,
          diagramType: diagram.type,
          node,
          deliveryRoleAssignments: latestPlanByNode.get(node.id)?.roleAssignments ?? null,
        });
      }
    }
    return refs;
  }

  private resolveProjectWorkspaceReadData(projectId: string, input: ProjectWorkspaceReadData = {}): ResolvedProjectWorkspaceReadData | undefined {
    const project = input.project ?? this.getProject(projectId);
    if (!project) return undefined;
    const diagrams = input.diagrams ?? this.listDiagrams(projectId);
    const plans = input.plans ?? this.listPlans(projectId);
    return {
      project,
      diagrams,
      plans,
      workspaceNodes: input.workspaceNodes ?? this.listProjectWorkspaceNodes(projectId, { diagrams, plans }),
      documents: input.documents ?? this.listDesignDocs(projectId),
      evidence: input.evidence ?? this.listEvidence(projectId),
    };
  }

  getProjectWorkspaceProject(projectId: string, input: ProjectWorkspaceReadData = {}): Project | undefined {
    const data = this.resolveProjectWorkspaceReadData(projectId, input);
    return data ? deriveProjectWorkspace(data).project : undefined;
  }

  getProjectWorkspace(projectId: string, input: ProjectWorkspaceReadData = {}): ProjectWorkspace | undefined {
    const data = this.resolveProjectWorkspaceReadData(projectId, input);
    if (!data) return undefined;
    const { diagrams, workspaceNodes: nodes } = data;
    const derived = deriveProjectWorkspace(data);

    return {
      project: derived.project,
      mainDiagram: diagrams.find((diagram) => diagram.type === "main") ?? null,
      diagrams: diagrams.map((diagram) => ({
        id: diagram.id,
        projectId: diagram.projectId,
        title: diagram.title,
        type: diagram.type,
        createdAt: diagram.createdAt,
        updatedAt: diagram.updatedAt,
        nodeCount: diagram.nodes.length,
        edgeCount: diagram.edges.length,
      })),
      metrics: {
        functionalNodes: nodes.length,
        completedNodes: derived.completedNodes,
        acceptedNodes: derived.acceptedNodes,
        blockedNodes: derived.blockedNodes,
        pendingAcceptanceNodes: derived.pendingAcceptanceNodes,
        missingEvidenceNodes: derived.missingEvidenceNodes,
        plans: derived.deliveryPlans.length,
        completedPlans: derived.deliveryPlans.filter((plan) => plan.status === "已完成").length,
        backlogPlans: derived.backlogPlans.length,
        documents: data.documents.length,
        evidence: derived.activeEvidence.length,
      },
      currentPlan: derived.currentPlan,
      nextPlan: derived.nextPlan,
    };
  }

  findProjectByRepositoryPath(repositoryPath: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE repository_path = ?")
      .get(repositoryPath) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  uniqueProjectCode(base: string): string {
    const clean = base.trim() || "PROJECT";
    let candidate = clean;
    let i = 2;
    while (this.db.prepare("SELECT 1 FROM projects WHERE code = ?").get(candidate)) {
      candidate = `${clean}-${i}`;
      i += 1;
    }
    return candidate;
  }

  insertProject(input: Omit<Project, "id" | "createdAt" | "updatedAt"> & { id?: string }): Project {
    const externalRepositoryId = normalizeExternalRepositoryId(input.externalRepositoryId);
    assertProjectRepositoryMode(input.repositoryPath, externalRepositoryId);
    const ts = nowIso();
    const row: ProjectRow = {
      id: input.id ?? newId(), code: input.code, name: input.name, summary: input.summary,
      stage: input.stage, health: input.health, progress: input.progress,
      risk_level: input.riskLevel, risk_summary: input.riskSummary,
      blocker_summary: input.blockerSummary, next_step: input.nextStep,
      repository_path: input.repositoryPath, external_repository_id: externalRepositoryId, start_at: input.startAt, due_at: input.dueAt,
      created_at: ts, updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO projects (id, code, name, summary, stage, health, progress, risk_level,
        risk_summary, blocker_summary, next_step, repository_path, external_repository_id, start_at, due_at, created_at, updated_at)
       VALUES (@id, @code, @name, @summary, @stage, @health, @progress, @risk_level,
        @risk_summary, @blocker_summary, @next_step, @repository_path, @external_repository_id, @start_at, @due_at, @created_at, @updated_at)`
    ).run(row);
    const project = mapProject(row);
    this.ensureProjectMainDiagram(project);
    return project;
  }

  updateProject(id: string, patch: Partial<Project>): Project | undefined {
    return this.db.transaction(() => {
      const current = this.getProject(id);
      if (!current) return undefined;
      const externalRepositoryId = normalizeExternalRepositoryId(patch.externalRepositoryId === undefined ? current.externalRepositoryId : patch.externalRepositoryId);
      const next: Project = { ...current, ...patch, externalRepositoryId, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
      assertProjectRepositoryMode(next.repositoryPath, externalRepositoryId);
      if (next.repositoryPath !== current.repositoryPath || externalRepositoryId !== (current.externalRepositoryId ?? "")) {
        const timestamp = nowIso();
        // The lease schemas are initialized lazily. Inspect existing tables without creating them.
        const taskLeasesExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_task_leases'").get();
        const coordinationLeasesExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_coordination_leases'").get();
        const taskLease = taskLeasesExist && this.db.prepare("SELECT 1 FROM agent_task_leases WHERE project_id=? AND status IN ('claimed','running') AND lease_expires_at>? LIMIT 1").get(id, timestamp);
        const coordinationLease = coordinationLeasesExist && this.db.prepare("SELECT 1 FROM agent_coordination_leases WHERE project_id=? AND status IN ('active','paused') AND lease_expires_at>? LIMIT 1").get(id, timestamp);
        if (taskLease || coordinationLease) {
          throw new ProjectRepositoryError(409, "PROJECT_REPOSITORY_ACTIVE_LEASE", "项目仍有活动租约，不能更改仓库路径或外部仓库标识");
        }
      }
      this.db.prepare(
        `UPDATE projects SET code=@code, name=@name, summary=@summary, stage=@stage, health=@health,
          progress=@progress, risk_level=@riskLevel, risk_summary=@riskSummary,
          blocker_summary=@blockerSummary, next_step=@nextStep, repository_path=@repositoryPath,
          external_repository_id=@externalRepositoryId, start_at=@startAt, due_at=@dueAt, updated_at=@updatedAt WHERE id=@id`
      ).run(next);
      return next;
    }).immediate();
  }

  /**
   * Sync the project's canvas (diagram) nodes into work_nodes, and derive the
   * project stage / progress / nextStep from them. Fixes the "canvas has 40
   * nodes but project shows 0% / no work items" disconnect.
   */
  syncProjectCanvasNodes(projectId: string): { created: number; updated: number; workNodeCount: number } {
    const diagrams = this.listDiagrams(projectId);
    const existingByKey = new Map(this.listNodes(projectId).map((n) => [`${n.kind}::${n.title}`, n]));
    const workKinds = new Set(["module", "feature", "requirement"]);
    const devMap: Record<string, string> = { 未开发: "未开始", 开发中: "进行中", 待验收: "待评审", 已完成: "已完成", 已阻塞: "已阻塞" };
    const accMap: Record<string, string> = { 未验收: "未开始", 验收中: "进行中", 已通过: "已通过", 未通过: "未通过" };
    let created = 0;
    let updated = 0;
    for (const diagram of diagrams) {
      for (const node of diagram.nodes) {
        if (!workKinds.has(node.kind)) continue;
        const key = `${node.kind}::${node.label}`;
        const dev = devMap[node.developmentStatus ?? "未开发"] ?? "未开始";
        const test = accMap[node.acceptanceStatus ?? "未验收"] ?? "未开始";
        const acc = node.acceptanceStatus ?? "未验收";
        const progress = node.developmentStatus === "已完成" && acc === "已通过" ? 100
          : node.developmentStatus === "已完成" ? 80
          : node.developmentStatus === "开发中" ? 40
          : node.developmentStatus === "已阻塞" ? 20
          : 0;
        const existing = existingByKey.get(key);
        if (existing) {
          const patch: Partial<WorkNode> = {};
          if (existing.description !== (node.description ?? "")) patch.description = node.description ?? "";
          if (existing.developmentStatus !== dev) patch.developmentStatus = dev as WorkNode["developmentStatus"];
          if (existing.testStatus !== test) patch.testStatus = test as WorkNode["testStatus"];
          if (existing.owner !== (node.owner ?? "")) patch.owner = node.owner ?? "";
          if (existing.progress !== progress) patch.progress = progress;
          if (Object.keys(patch).length > 0) { this.updateNode(existing.id, patch); updated += 1; }
        } else {
          this.insertNode({
            projectId, parentId: null, kind: node.kind as WorkNode["kind"], title: node.label,
            description: node.description ?? "", priority: "P2", owner: node.owner ?? "",
            requirementStatus: "待整理", designStatus: "未开始",
            developmentStatus: dev as WorkNode["developmentStatus"], testStatus: test as WorkNode["testStatus"],
            progress, startAt: "", dueAt: "", position: 0,
          });
          created += 1;
        }
      }
    }
    const finalNodes = this.listNodes(projectId);
    const finished = finalNodes.filter((n) => n.developmentStatus === "已完成" && n.testStatus === "已通过").length;
    const progress = finalNodes.length === 0 ? 0 : Math.round(finalNodes.reduce((sum, n) => sum + n.progress, 0) / finalNodes.length);
    const nextNode = finalNodes.find((n) => n.developmentStatus !== "已完成") ?? null;
    if (this.getProject(projectId)) {
      const stage = finalNodes.length === 0 ? "探索" : finished === finalNodes.length ? "交付" : finished > 0 ? "测试" : "开发";
      this.updateProject(projectId, {
        progress,
        stage,
        nextStep: nextNode ? `推进「${nextNode.title}」` : "已全部完成，进入交付/验收",
      });
    }
    return { created, updated, workNodeCount: finalNodes.length };
  }


  deleteProject(id: string): boolean {
    const info = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    if (info.changes > 0) {
      this.db.prepare("DELETE FROM work_nodes WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM plan_items WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM evidence WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM governance WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM document_references WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM document_revisions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM design_docs WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM node_database_bindings WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM database_models WHERE project_id = ?").run(id);
      const diagrams = this.db.prepare("SELECT id FROM diagrams WHERE project_id = ?").all(id) as Array<{ id: string }>;
      for (const diagram of diagrams) this.db.prepare("DELETE FROM diagram_revisions WHERE diagram_id = ?").run(diagram.id);
      this.db.prepare("DELETE FROM diagrams WHERE project_id = ?").run(id);
    }
    return info.changes > 0;
  }

  // ---------- work nodes ----------

  listNodes(projectId: string): WorkNode[] {
    const rows = this.db
      .prepare("SELECT * FROM work_nodes WHERE project_id = ? ORDER BY kind, position, created_at")
      .all(projectId) as WorkNodeRow[];
    return rows.map(mapNode);
  }

  getNode(id: string): WorkNode | undefined {
    const row = this.db.prepare("SELECT * FROM work_nodes WHERE id = ?").get(id) as WorkNodeRow | undefined;
    return row ? mapNode(row) : undefined;
  }

  insertNode(
    input: Omit<WorkNode, "id" | "createdAt" | "updatedAt" | "position"> & { id?: string; position?: number },
  ): WorkNode {
    const maxPos = this.db
      .prepare("SELECT COALESCE(MAX(position), 0) AS p FROM work_nodes WHERE project_id = ? AND kind = ?")
      .get(input.projectId, input.kind) as { p: number };
    const ts = nowIso();
    const row: WorkNodeRow = {
      id: input.id ?? newId(), project_id: input.projectId, parent_id: input.parentId,
      kind: input.kind, title: input.title, description: input.description,
      priority: input.priority, owner: input.owner, requirement_status: input.requirementStatus,
      design_status: input.designStatus, development_status: input.developmentStatus,
      test_status: input.testStatus, progress: input.progress, start_at: input.startAt,
      due_at: input.dueAt, position: input.position ?? maxPos.p + 1,
      created_at: ts, updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO work_nodes (id, project_id, parent_id, kind, title, description, priority, owner,
        requirement_status, design_status, development_status, test_status, progress, start_at, due_at,
        position, created_at, updated_at)
       VALUES (@id, @project_id, @parent_id, @kind, @title, @description, @priority, @owner,
        @requirement_status, @design_status, @development_status, @test_status, @progress, @start_at, @due_at,
        @position, @created_at, @updated_at)`
    ).run(row);
    return mapNode(row);
  }

  updateNode(id: string, patch: Partial<WorkNode>): WorkNode | undefined {
    const current = this.getNode(id);
    if (!current) return undefined;
    const next: WorkNode = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
    this.db.prepare(
      `UPDATE work_nodes SET parent_id=@parentId, kind=@kind, title=@title, description=@description,
        priority=@priority, owner=@owner, requirement_status=@requirementStatus, design_status=@designStatus,
        development_status=@developmentStatus, test_status=@testStatus, progress=@progress,
        start_at=@startAt, due_at=@dueAt, position=@position, updated_at=@updatedAt WHERE id=@id`
    ).run({
      ...next,
      parentId: next.parentId,
    });
    return next;
  }

  deleteNode(id: string): boolean {
    const current = this.getNode(id);
    if (current) this.deleteDocumentReferencesForTarget(current.projectId, "diagramNode", id);
    return this.db.prepare("DELETE FROM work_nodes WHERE id = ?").run(id).changes > 0;
  }

  // ---------- plan items ----------

  listPlans(projectId: string, diagramId?: string, diagramNodeId?: string): PlanItem[] {
    const clauses = ["project_id = @projectId"];
    const params: Record<string, unknown> = { projectId };
    if (diagramId) { clauses.push("diagram_id = @diagramId"); params.diagramId = diagramId; }
    if (diagramNodeId) { clauses.push("diagram_node_id = @diagramNodeId"); params.diagramNodeId = diagramNodeId; }
    const rows = this.db
      .prepare(`SELECT * FROM plan_items WHERE ${clauses.join(" AND ")} ORDER BY kind, created_at`)
      .all(params) as PlanItemRow[];
    return rows.map(mapPlan);
  }

  listAllPlans(): PlanItem[] {
    const rows = this.db.prepare("SELECT * FROM plan_items ORDER BY due_at").all() as PlanItemRow[];
    return rows.map(mapPlan);
  }

  getPlan(id: string): PlanItem | undefined {
    const row = this.db.prepare("SELECT * FROM plan_items WHERE id = ?").get(id) as PlanItemRow | undefined;
    return row ? mapPlan(row) : undefined;
  }

  insertPlan(input: PlanItemInput): PlanItem {
    const ts = nowIso();
    const row: PlanItemRow = {
      id: input.id ?? newId(), project_id: input.projectId,
      diagram_id: input.diagramId ?? null, diagram_node_id: input.diagramNodeId ?? null, parent_id: input.parentId,
      kind: input.kind, title: input.title, description: input.description,
      status: input.status, priority: input.priority, progress: input.progress,
      owner: input.owner, role_assignments: JSON.stringify(normalizeRoleAssignments(input.roleAssignments)), version_tag: input.versionTag, start_at: input.startAt,
      due_at: input.dueAt, dependency_ids: JSON.stringify(input.dependencyIds ?? []),
      blocked_reason: input.blockedReason ?? "", completed_at: input.completedAt ?? "",
      lifecycle_status: input.lifecycleStatus ?? "draft", proposal_revision: input.proposalRevision ?? 1,
      design_revision_ids: JSON.stringify(input.designRevisionIds ?? []),
      proposed_by: input.proposedBy ?? input.owner, submitted_at: input.submittedAt ?? "",
      approved_by: input.approvedBy ?? "", approved_at: input.approvedAt ?? "",
      rejected_by: input.rejectedBy ?? "", rejected_at: input.rejectedAt ?? "", rejection_reason: input.rejectionReason ?? "",
      implementation_revision: input.implementationRevision ?? "", completed_by: input.completedBy ?? "",
      audit_status: input.auditStatus ?? "not_requested", audited_by: input.auditedBy ?? "", audited_at: input.auditedAt ?? "",
      manager_decision: input.managerDecision ?? "pending", manager_decision_by: input.managerDecisionBy ?? "",
      manager_decision_at: input.managerDecisionAt ?? "", rework_of_plan_id: input.reworkOfPlanId ?? null,
      correlation_id: input.correlationId ?? input.id ?? "",
      created_at: ts, updated_at: ts,
    };
    if (!row.correlation_id) row.correlation_id = row.id;
    this.db.prepare(
      `INSERT INTO plan_items (id, project_id, diagram_id, diagram_node_id, parent_id, kind, title, description, status, priority,
        progress, owner, role_assignments, version_tag, start_at, due_at, dependency_ids, blocked_reason, completed_at,
        lifecycle_status, proposal_revision, design_revision_ids, proposed_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at,
        rejection_reason, implementation_revision, completed_by, audit_status, audited_by, audited_at, manager_decision,
        manager_decision_by, manager_decision_at, rework_of_plan_id, correlation_id, created_at, updated_at)
       VALUES (@id, @project_id, @diagram_id, @diagram_node_id, @parent_id, @kind, @title, @description, @status, @priority,
        @progress, @owner, @role_assignments, @version_tag, @start_at, @due_at, @dependency_ids, @blocked_reason, @completed_at,
         @lifecycle_status, @proposal_revision, @design_revision_ids, @proposed_by, @submitted_at, @approved_by, @approved_at, @rejected_by, @rejected_at,
        @rejection_reason, @implementation_revision, @completed_by, @audit_status, @audited_by, @audited_at, @manager_decision,
        @manager_decision_by, @manager_decision_at, @rework_of_plan_id, @correlation_id, @created_at, @updated_at)`
    ).run(row);
    return mapPlan(row);
  }

  updatePlan(id: string, patch: Partial<PlanItem>): PlanItem | undefined {
    const current = this.getPlan(id);
    if (!current) return undefined;
    const next: PlanItem = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
    this.db.prepare(
      `UPDATE plan_items SET diagram_id=@diagramId, diagram_node_id=@diagramNodeId, parent_id=@parentId, kind=@kind, title=@title, description=@description,
        status=@status, priority=@priority, progress=@progress, owner=@owner, role_assignments=@roleAssignmentsJson, version_tag=@versionTag,
        start_at=@startAt, due_at=@dueAt, dependency_ids=@dependencyIdsJson,
        blocked_reason=@blockedReason, completed_at=@completedAt, lifecycle_status=@lifecycleStatus,
        proposal_revision=@proposalRevision, design_revision_ids=@designRevisionIdsJson, proposed_by=@proposedBy, submitted_at=@submittedAt,
        approved_by=@approvedBy, approved_at=@approvedAt, rejected_by=@rejectedBy, rejected_at=@rejectedAt,
        rejection_reason=@rejectionReason, implementation_revision=@implementationRevision, completed_by=@completedBy,
        audit_status=@auditStatus, audited_by=@auditedBy, audited_at=@auditedAt, manager_decision=@managerDecision,
        manager_decision_by=@managerDecisionBy, manager_decision_at=@managerDecisionAt,
        rework_of_plan_id=@reworkOfPlanId, correlation_id=@correlationId, updated_at=@updatedAt
       WHERE id=@id`
    ).run({
      ...next,
      dependencyIdsJson: JSON.stringify(next.dependencyIds ?? []),
      designRevisionIdsJson: JSON.stringify(next.designRevisionIds ?? []),
      roleAssignmentsJson: JSON.stringify(normalizeRoleAssignments(next.roleAssignments)),
    });
    return next;
  }

  deletePlan(id: string): boolean {
    const current = this.getPlan(id);
    if (!current) return false;
    this.deleteDocumentReferencesForTarget(current.projectId, "plan", id);
    // 子计划上提一级继承被删计划的上级，避免留下指向已删除计划的悬空 parent_id。
    this.db.prepare("UPDATE plan_items SET parent_id = ?, updated_at = ? WHERE parent_id = ?")
      .run(current.parentId, nowIso(), id);
    return this.db.prepare("DELETE FROM plan_items WHERE id = ?").run(id).changes > 0;
  }

  // ---------- evidence ----------

  listEvidence(projectId: string, nodeId?: string): Evidence[] {
    const rows = (nodeId
      ? this.db.prepare("SELECT * FROM evidence WHERE project_id = ? AND node_id = ? ORDER BY collected_at DESC").all(projectId, nodeId)
      : this.db.prepare("SELECT * FROM evidence WHERE project_id = ? ORDER BY collected_at DESC").all(projectId)) as EvidenceRow[];
    return rows.map(mapEvidence);
  }

  listEvidencePage(query: EvidencePageQuery): Paginated<Evidence> {
    return this.db.transaction(() => {
    const clauses = ["project_id = @projectId"];
    const params: Record<string, unknown> = { projectId: query.projectId, limit: query.limit, offset: query.offset };
    if (query.nodeId) { clauses.push("node_id = @nodeId"); params.nodeId = query.nodeId; }
    if (query.planItemId) { clauses.push("plan_item_id = @planItemId"); params.planItemId = query.planItemId; }
    if (query.resultStatus) { clauses.push("result_status = @resultStatus"); params.resultStatus = query.resultStatus; }
    const where = `WHERE ${clauses.join(" AND ")}`;

    if (query.q) {
      const matches = (this.db.prepare(`SELECT id, summary, source_path FROM evidence ${where} ORDER BY collected_at DESC`).all(params) as Array<{ id: string; summary: string; source_path: string }>)
        .filter((row) => databaseTextMatches(row.summary, query.q!) || databaseTextMatches(row.source_path, query.q!));
      const ids = matches.slice(query.offset, query.offset + query.limit).map((row) => row.id);
      if (ids.length === 0) return databasePage([], matches.length, query.offset);
      const idParams = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
      const rows = this.db.prepare(`SELECT * FROM evidence WHERE id IN (${ids.map((_, index) => `@id${index}`).join(", ")})`).all(idParams) as EvidenceRow[];
      const byId = new Map(rows.map((row) => [row.id, mapEvidence(row)]));
      return databasePage(ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []), matches.length, query.offset);
    }

    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM evidence ${where}`).get(params) as { count: number }).count);
    const rows = this.db.prepare(`SELECT * FROM evidence ${where} ORDER BY collected_at DESC LIMIT @limit OFFSET @offset`).all(params) as EvidenceRow[];
    return databasePage(rows.map(mapEvidence), total, query.offset);
    })();
  }

  getEvidence(id: string): Evidence | undefined {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
    return row ? mapEvidence(row) : undefined;
  }

  insertEvidence(input: Omit<Evidence,
    "id" | "planItemId" | "acceptanceCriterionKey" | "documentRevisionId" | "actorRole" | "agentId" | "sessionId" | "runId" |
    "supersedesEvidenceId" | "status" | "revokedReason" | "revokedAt"
  > & Partial<Pick<Evidence,
    "planItemId" | "acceptanceCriterionKey" | "documentRevisionId" | "actorRole" | "agentId" | "sessionId" | "runId" |
    "supersedesEvidenceId" | "status" | "revokedReason" | "revokedAt"
  >> & { id?: string }): Evidence {
    const row: EvidenceRow = {
      id: input.id ?? newId(), project_id: input.projectId, node_id: input.nodeId,
      source_type: input.sourceType, source_path: input.sourcePath, command: input.command,
      result_status: input.resultStatus, summary: input.summary,
      details: JSON.stringify(input.details ?? {}), commit_sha: input.commitSha,
      digest: input.digest, collected_at: input.collectedAt,
      plan_item_id: input.planItemId ?? null, acceptance_criterion_key: input.acceptanceCriterionKey ?? "",
      document_revision_id: input.documentRevisionId ?? null, actor_role: input.actorRole ?? "", agent_id: input.agentId ?? "", session_id: input.sessionId ?? null,
      run_id: input.runId ?? "", supersedes_evidence_id: input.supersedesEvidenceId ?? null,
      status: input.status ?? "active", revoked_reason: input.revokedReason ?? "", revoked_at: input.revokedAt ?? "",
    };
    this.db.prepare(
      `INSERT INTO evidence (id, project_id, node_id, source_type, source_path, command,
        result_status, summary, details, commit_sha, digest, collected_at, plan_item_id, acceptance_criterion_key,
        document_revision_id, actor_role, agent_id, session_id, run_id, supersedes_evidence_id, status, revoked_reason, revoked_at)
       VALUES (@id, @project_id, @node_id, @source_type, @source_path, @command,
        @result_status, @summary, @details, @commit_sha, @digest, @collected_at, @plan_item_id, @acceptance_criterion_key,
        @document_revision_id, @actor_role, @agent_id, @session_id, @run_id, @supersedes_evidence_id, @status, @revoked_reason, @revoked_at)`
    ).run(row);
    return mapEvidence(row);
  }

  deleteEvidence(id: string, reason = "已撤销"): boolean {
    const current = this.getEvidence(id);
    if (!current || current.status === "revoked") return false;
    return this.db.prepare("UPDATE evidence SET status = 'revoked', revoked_reason = ?, revoked_at = ? WHERE id = ?")
      .run(reason, nowIso(), id).changes > 0;
  }

  // ---------- governance ----------

  listGovernance(projectId?: string): GovernanceRecord[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM governance WHERE project_id = ? ORDER BY created_at DESC").all(projectId)
        : this.db.prepare("SELECT * FROM governance ORDER BY created_at DESC").all()
    ) as GovernanceRow[];
    return rows.map(mapGovernance);
  }

  getGovernance(id: string): GovernanceRecord | undefined {
    const row = this.db.prepare("SELECT * FROM governance WHERE id = ?").get(id) as GovernanceRow | undefined;
    return row ? mapGovernance(row) : undefined;
  }

  insertGovernance(input: Omit<GovernanceRecord, "id" | "createdAt"> & { id?: string }): GovernanceRecord {
    const row: GovernanceRow = {
      id: input.id ?? newId(), project_id: input.projectId, type: input.type, title: input.title,
      content: input.content, rationale: input.rationale, status: input.status,
      author: input.author, created_at: nowIso(),
    };
    this.db.prepare(
      `INSERT INTO governance (id, project_id, type, title, content, rationale, status, author, created_at)
       VALUES (@id, @project_id, @type, @title, @content, @rationale, @status, @author, @created_at)`
    ).run(row);
    return mapGovernance(row);
  }

  updateGovernance(id: string, patch: Partial<GovernanceRecord>): GovernanceRecord | undefined {
    const current = this.getGovernance(id);
    if (!current) return undefined;
    const next: GovernanceRecord = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
    this.db.prepare(
      `UPDATE governance SET project_id=@projectId, type=@type, title=@title, content=@content,
        rationale=@rationale, status=@status, author=@author WHERE id=@id`
    ).run(next);
    return next;
  }

  deleteGovernance(id: string): boolean {
    const current = this.getGovernance(id);
    if (current) this.deleteDocumentReferencesForTarget(current.projectId, "governance", id);
    return this.db.prepare("DELETE FROM governance WHERE id = ?").run(id).changes > 0;
  }

  // ---------- diagrams ----------

  listDiagrams(projectId?: string): Diagram[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM diagrams WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
        : this.db.prepare("SELECT * FROM diagrams ORDER BY updated_at DESC").all()
    ) as DiagramRow[];
    return rows.map(mapDiagram);
  }

  getDiagram(id: string): Diagram | undefined {
    const row = this.db.prepare("SELECT * FROM diagrams WHERE id = ?").get(id) as DiagramRow | undefined;
    return row ? mapDiagram(row) : undefined;
  }

  /** Raw layer payload is needed to preserve and reject future schema versions without downgrading them. */
  getRawDiagramLayers(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT layers FROM diagrams WHERE id = ?").get(id) as Pick<DiagramRow, "layers"> | undefined;
    return row ? parseNullableObject(row.layers) : null;
  }

  getPrototypeDraft(diagramId: string): PrototypeStored | undefined {
    const row = this.db.prepare("SELECT * FROM prototype_drafts WHERE diagram_id = ?").get(diagramId) as PrototypeDraftRow | undefined;
    if (!row) return undefined;
    try { return { ...normalizePrototypePayload(JSON.parse(row.payload)), updatedAt: row.updated_at }; }
    catch { throw new PrototypeDraftCorruptError("服务器原型草稿数据损坏"); }
  }

  upsertPrototypeDraft(diagramId: string, payload: Omit<PrototypeStored, "updatedAt">, expectedUpdatedAt: string | null): PrototypeStored | undefined {
    const diagram = this.getDiagram(diagramId);
    if (!diagram) return undefined;
    const incoming = normalizePrototypePayload(payload);
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM prototype_drafts WHERE diagram_id = ?").get(diagramId) as PrototypeDraftRow | undefined;
      if (current ? expectedUpdatedAt !== current.updated_at : expectedUpdatedAt !== null) {
        throw new PrototypeDraftConflictError(current
          ? `原型草稿已被其他操作修改；当前 updatedAt=${current.updated_at}`
          : "原型草稿尚不存在，首次保存必须使用 expectedUpdatedAt=null");
      }
      let baseVersions = incoming.versions;
      if (current) {
        try { baseVersions = normalizePrototypePayload(JSON.parse(current.payload)).versions; }
        catch { throw new PrototypeDraftCorruptError("服务器原型草稿数据损坏"); }
      }
      const updatedAt = nextPrototypeRevision(current?.updated_at);
      const snapshot = { ...incoming.current, updatedAt };
      const versions = [snapshot, ...baseVersions]
        .filter((version, index, all) => all.findIndex((candidate) => candidate.updatedAt === version.updatedAt
          || prototypeFingerprint(candidate) === prototypeFingerprint(version)) === index)
        .slice(0, PROTOTYPE_VERSION_LIMIT);
      const stored = { current: snapshot, versions };
      this.db.prepare(`INSERT INTO prototype_drafts (diagram_id, project_id, payload, updated_at)
        VALUES (@diagramId, @projectId, @payload, @updatedAt)
        ON CONFLICT(diagram_id) DO UPDATE SET payload=@payload, updated_at=@updatedAt`).run({
        diagramId, projectId: diagram.projectId, payload: JSON.stringify(stored), updatedAt,
      });
      return { ...stored, updatedAt };
    })();
  }

  // ---------- 自由层（与交付节点硬隔离：只读写自由层文档与受控资源，不触碰 diagram.nodes） ----------

  getFreeformDocument(diagramId: string): FreeformDocument | undefined {
    const row = this.db.prepare("SELECT * FROM diagram_freeform_documents WHERE diagram_id = ?").get(diagramId) as FreeformDocumentRow | undefined;
    if (!row) return undefined;
    try {
      return { ...normalizeFreeformDocument(JSON.parse(row.payload), diagramId), updatedAt: row.updated_at };
    } catch { throw new FreeformDocumentCorruptError("服务器自由层文档数据损坏"); }
  }

  upsertFreeformDocument(
    diagramId: string,
    payload: Pick<FreeformDocument, "schemaVersion" | "elements" | "unsupported">,
    expectedUpdatedAt: string | null,
  ): FreeformDocument | undefined {
    const diagram = this.getDiagram(diagramId);
    if (!diagram) return undefined;
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM diagram_freeform_documents WHERE diagram_id = ?").get(diagramId) as FreeformDocumentRow | undefined;
      if (current ? expectedUpdatedAt !== current.updated_at : expectedUpdatedAt !== null) {
        throw new FreeformDraftConflictError(current
          ? `自由层草稿已被其他操作修改；当前 updatedAt=${current.updated_at}`
          : "自由层草稿尚不存在，首次保存必须使用 expectedUpdatedAt=null", current?.updated_at ?? null);
      }
      const updatedAt = nextPrototypeRevision(current?.updated_at);
      const stored: FreeformDocument = {
        schemaVersion: FREEFORM_SCHEMA_VERSION,
        diagramId,
        elements: payload.elements,
        unsupported: payload.unsupported ?? [],
        updatedAt,
      };
      this.db.prepare(`INSERT INTO diagram_freeform_documents (diagram_id, project_id, schema_version, payload, updated_at)
        VALUES (@diagramId, @projectId, @schemaVersion, @payload, @updatedAt)
        ON CONFLICT(diagram_id) DO UPDATE SET payload=@payload, updated_at=@updatedAt, schema_version=@schemaVersion`).run({
        diagramId, projectId: diagram.projectId, schemaVersion: FREEFORM_SCHEMA_VERSION,
        payload: JSON.stringify(stored), updatedAt,
      });
      return stored;
    })();
  }

  freeformDocumentFingerprint(diagramId: string): string | null {
    const document = this.getFreeformDocument(diagramId);
    return document ? freeformDocumentFingerprint(document) : null;
  }

  // ---------- 模板（绑定表 diagram_templates；与图层/组件旁路载荷硬隔离，不参与交付门禁） ----------

  listDiagramTemplates(
    projectId: string,
    options: { scope?: DiagramTemplateScope; schemaVersion?: string; offset?: number; limit?: number } = {},
  ): DiagramTemplate[] {
    const conditions = ["revoked_at IS NULL", "(project_id = @projectId OR project_id IS NULL)"];
    const params: Record<string, unknown> = { projectId };
    if (options.scope) { conditions.push("scope = @scope"); params.scope = options.scope; }
    if (options.schemaVersion) { conditions.push("schema_version = @schemaVersion"); params.schemaVersion = options.schemaVersion; }
    const rows = this.db.prepare(
      `SELECT * FROM diagram_templates WHERE ${conditions.join(" AND ")} ORDER BY scope DESC, updated_at DESC`,
    ).all(params) as DiagramTemplateRow[];
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = options.limit ?? 50;
    return rows.slice(offset, offset + limit).map(mapDiagramTemplate);
  }

  /** 直读（含已撤销）；用于 403/409 判定与撤销幂等。 */
  findDiagramTemplate(templateId: string): DiagramTemplate | undefined {
    const row = this.db.prepare("SELECT * FROM diagram_templates WHERE id = ?").get(templateId) as DiagramTemplateRow | undefined;
    return row ? mapDiagramTemplate(row) : undefined;
  }

  /** 读取路径统一带 revoked_at IS NULL：已撤销模板按 404 处理，不返回内容。 */
  getDiagramTemplate(templateId: string): DiagramTemplate | undefined {
    const template = this.findDiagramTemplate(templateId);
    return template && !template.revokedAt ? template : undefined;
  }

  findDiagramTemplateByName(projectId: string | null, name: string): DiagramTemplate | undefined {
    const rows = this.db.prepare("SELECT * FROM diagram_templates WHERE revoked_at IS NULL AND name = ?").all(name) as DiagramTemplateRow[];
    const row = rows.find((item) => (item.project_id ?? null) === projectId);
    return row ? mapDiagramTemplate(row) : undefined;
  }

  insertDiagramTemplate(input: {
    projectId: string | null;
    scope: DiagramTemplateScope;
    name: string;
    schemaVersion: string;
    content: DiagramTemplateContent;
    thumbnailMeta: DiagramTemplateThumbnailMeta;
    createdBy: string;
  }): DiagramTemplate {
    return this.db.transaction(() => {
      if (this.findDiagramTemplateByName(input.projectId, input.name)) {
        throw new DiagramTemplateNameConflictError(`模板名称已存在：${input.name}`);
      }
      const ts = nowIso();
      const row: DiagramTemplateRow = {
        id: newId(), project_id: input.projectId, scope: input.scope, name: input.name,
        schema_version: input.schemaVersion, content: JSON.stringify(input.content),
        thumbnail_meta: JSON.stringify(input.thumbnailMeta), created_by: input.createdBy,
        created_at: ts, updated_at: ts, revoked_at: null,
      };
      this.db.prepare(
        `INSERT INTO diagram_templates (id, project_id, scope, name, schema_version, content, thumbnail_meta, created_by, created_at, updated_at, revoked_at)
         VALUES (@id, @project_id, @scope, @name, @schema_version, @content, @thumbnail_meta, @created_by, @created_at, @updated_at, @revoked_at)`,
      ).run(row);
      return mapDiagramTemplate(row);
    })();
  }

  /** CAS 更新（模板 updated_at）；已撤销 → DiagramTemplateRevokedError，版本不符 → DiagramTemplateRevisionConflictError。 */
  updateDiagramTemplate(
    templateId: string,
    patch: { name?: string; schemaVersion?: string; content?: DiagramTemplateContent; thumbnailMeta?: DiagramTemplateThumbnailMeta },
    expectedUpdatedAt: string | null,
  ): DiagramTemplate | undefined {
    return this.db.transaction(() => {
      const current = this.findDiagramTemplate(templateId);
      if (!current) return undefined;
      if (current.revokedAt) throw new DiagramTemplateRevokedError("模板已撤销，不可更新");
      if (expectedUpdatedAt !== current.updatedAt) {
        throw new DiagramTemplateRevisionConflictError(`模板已被其他操作修改；当前 updatedAt=${current.updatedAt}`, current.updatedAt);
      }
      const name = patch.name ?? current.name;
      if (name !== current.name) {
        const existing = this.findDiagramTemplateByName(current.projectId, name);
        if (existing && existing.id !== templateId) throw new DiagramTemplateNameConflictError(`模板名称已存在：${name}`);
      }
      const next: DiagramTemplate = {
        ...current,
        name,
        schemaVersion: patch.schemaVersion ?? current.schemaVersion,
        content: patch.content ?? current.content,
        thumbnailMeta: patch.thumbnailMeta ?? current.thumbnailMeta,
        updatedAt: nextPrototypeRevision(current.updatedAt),
      };
      this.db.prepare(
        `UPDATE diagram_templates SET name=@name, schema_version=@schema_version, content=@content, thumbnail_meta=@thumbnail_meta, updated_at=@updated_at WHERE id=@id`,
      ).run({
        id: templateId, name: next.name, schema_version: next.schemaVersion,
        content: JSON.stringify(next.content), thumbnail_meta: JSON.stringify(next.thumbnailMeta), updated_at: next.updatedAt,
      });
      return next;
    })();
  }

  /** 软撤销（delete 操作映射）；幂等：重复撤销返回当前状态。 */
  revokeDiagramTemplate(templateId: string): DiagramTemplate | undefined {
    return this.db.transaction(() => {
      const current = this.findDiagramTemplate(templateId);
      if (!current) return undefined;
      if (current.revokedAt) return current;
      const revokedAt = nextPrototypeRevision(current.updatedAt);
      this.db.prepare("UPDATE diagram_templates SET revoked_at=@revokedAt, updated_at=@updatedAt WHERE id=@id")
        .run({ id: templateId, revokedAt, updatedAt: revokedAt });
      return { ...current, revokedAt, updatedAt: revokedAt };
    })();
  }

  insertFreeformAsset(asset: FreeformAsset): FreeformAsset {
    this.db.prepare(`INSERT INTO freeform_assets (id, project_id, mime, sha256, byte_size, storage_path, width, height, created_at)
      VALUES (@id, @projectId, @mime, @sha256, @byteSize, @storagePath, @width, @height, @createdAt)`).run({
      id: asset.id, projectId: asset.projectId, mime: asset.mime, sha256: asset.sha256,
      byteSize: asset.byteSize, storagePath: asset.storagePath, width: asset.width, height: asset.height,
      createdAt: asset.createdAt,
    });
    return asset;
  }

  getFreeformAsset(id: string): FreeformAsset | undefined {
    const row = this.db.prepare("SELECT * FROM freeform_assets WHERE id = ?").get(id) as FreeformAssetRow | undefined;
    return row ? mapFreeformAsset(row) : undefined;
  }

  findFreeformAssetBySha(projectId: string, sha256: string): FreeformAsset | undefined {
    const row = this.db.prepare("SELECT * FROM freeform_assets WHERE project_id = ? AND sha256 = ? LIMIT 1")
      .get(projectId, sha256) as FreeformAssetRow | undefined;
    return row ? mapFreeformAsset(row) : undefined;
  }

  listFreeformAssets(projectId: string): FreeformAsset[] {
    const rows = this.db.prepare("SELECT * FROM freeform_assets WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as FreeformAssetRow[];
    return rows.map(mapFreeformAsset);
  }

  private ensureAllProjectsHaveMainDiagrams(): void {
    for (const project of this.listProjects()) this.ensureProjectMainDiagram(project);
  }

  private ensureProjectMainDiagram(project: Pick<Project, "id" | "name">): Diagram {
    const existing = this.listDiagrams(project.id).find((diagram) => diagram.type === "main");
    if (existing) return existing;
    return this.insertDiagram({
      projectId: project.id,
      title: "系统主画布",
      type: "main",
      nodes: [{
        id: newId(),
        kind: "system",
        label: project.name,
        description: "整个系统的功能、流程、部署和数据关系入口",
        x: 360,
        y: 160,
        w: 240,
        h: 70,
        shape: "rounded",
        developmentStatus: "未开发",
        acceptanceStatus: "未验收",
      }],
      edges: [],
      groups: [],
    });
  }

  insertDiagram(input: DiagramInput): Diagram {
    const type = input.type ?? "free";
    if (type === "main" && this.listDiagrams(input.projectId).some((diagram) => diagram.type === "main")) {
      throw new Error("每个项目只能有一个系统主画布");
    }
    const ts = nowIso();
    const row: DiagramRow = {
      id: input.id ?? newId(), project_id: input.projectId, title: input.title, type,
      nodes: JSON.stringify((input.nodes ?? []).map(normalizeDiagramNodeLinks)),
      edges: JSON.stringify(input.edges ?? []),
      groups: JSON.stringify(input.groups ?? []),
      layers: input.layers ? JSON.stringify(input.layers) : null,
      components: input.components ? JSON.stringify(input.components) : null,
      created_at: ts, updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO diagrams (id, project_id, title, type, nodes, edges, groups, layers, components, created_at, updated_at)
       VALUES (@id, @project_id, @title, @type, @nodes, @edges, @groups, @layers, @components, @created_at, @updated_at)`
    ).run(row);
    return mapDiagram(row);
  }

  updateDiagram(id: string, patch: Partial<Diagram>): Diagram | undefined {
    const current = this.getDiagram(id);
    if (!current) return undefined;
    if (current.type === "main" && patch.type !== undefined && patch.type !== "main") {
      throw new Error("系统主画布不能修改为其他类型");
    }
    if (current.type !== "main" && patch.type === "main") {
      throw new Error("项目已存在系统主画布，不能把其他画布设为主画布");
    }
    const next: Diagram = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
    next.nodes = (next.nodes ?? []).map(normalizeDiagramNodeLinks);
    assertNoIntroducedDiagramGroupOverlap(current, next);
    const writesLayers = Object.prototype.hasOwnProperty.call(patch, "layers");
    const writesComponents = Object.prototype.hasOwnProperty.call(patch, "components");
    this.db.prepare(
      `UPDATE diagrams SET title=@title, type=@type, nodes=@nodesJson, edges=@edgesJson, groups=@groupsJson,
         layers=CASE WHEN @writesLayers = 1 THEN @layersJson ELSE layers END,
         components=CASE WHEN @writesComponents = 1 THEN @componentsJson ELSE components END,
         updated_at=@updatedAt WHERE id=@id`
    ).run({
      ...next,
      nodesJson: JSON.stringify(next.nodes ?? []),
      edgesJson: JSON.stringify(next.edges ?? []),
      groupsJson: JSON.stringify(next.groups ?? []),
      layersJson: next.layers ? JSON.stringify(next.layers) : null,
      componentsJson: next.components ? JSON.stringify(next.components) : null,
      writesLayers: writesLayers ? 1 : 0,
      writesComponents: writesComponents ? 1 : 0,
    });
    const nextNodeIds = new Set(next.nodes.map((node) => node.id));
    for (const node of current.nodes) {
      if (!nextNodeIds.has(node.id)) {
        this.db.prepare("DELETE FROM node_database_bindings WHERE diagram_id = ? AND diagram_node_id = ?").run(id, node.id);
        this.db.prepare("UPDATE evidence SET node_id = NULL WHERE project_id = ? AND node_id = ?").run(current.projectId, node.id);
        this.deleteDocumentReferencesForTarget(current.projectId, "diagramNode", node.id);
      }
    }
    return next;
  }

  deleteDiagram(id: string): boolean {
    const current = this.getDiagram(id);
    if (current?.type === "main") throw new Error("系统主画布不能删除");
    this.db.prepare("DELETE FROM node_database_bindings WHERE diagram_id = ?").run(id);
    if (current) {
      this.deleteDocumentReferencesForTarget(current.projectId, "diagram", id);
      const detachEvidence = this.db.prepare("UPDATE evidence SET node_id = NULL WHERE project_id = ? AND node_id = ?");
      for (const node of current.nodes) {
        detachEvidence.run(current.projectId, node.id);
        this.deleteDocumentReferencesForTarget(current.projectId, "diagramNode", node.id);
      }
    }
    const deleted = this.db.prepare("DELETE FROM diagrams WHERE id = ?").run(id).changes > 0;
    if (deleted) {
      this.db.prepare("DELETE FROM diagram_revisions WHERE diagram_id = ?").run(id);
      if (current) this.clearDanglingReferencesToDiagram(current.projectId, id);
    }
    return deleted;
  }

  /** Remove dangling sub-canvas links in sibling diagrams that point to a deleted diagram. */
  private clearDanglingReferencesToDiagram(projectId: string, removedDiagramId: string): void {
    const update = this.db.prepare("UPDATE diagrams SET nodes = @nodesJson, updated_at = @updatedAt WHERE id = @id");
    const transaction = this.db.transaction(() => {
      for (const diagram of this.listDiagrams(projectId)) {
        let changed = false;
        const nodes = diagram.nodes.map((node) => {
          const links = (node.linkDiagramIds ?? []).filter((childId) => childId !== removedDiagramId);
          if (links.length === (node.linkDiagramIds?.length ?? 0)) return node;
          changed = true;
          const { linkDiagramIds: _keep, ...rest } = node;
          return links.length ? { ...rest, linkDiagramIds: links } : rest;
        });
        if (changed) update.run({ id: diagram.id, nodesJson: JSON.stringify(nodes), updatedAt: nowIso() });
      }
    });
    transaction();
  }

  // ---------- database models ----------

  listDatabaseModels(projectId?: string): DatabaseModel[] {
    const rows = (projectId
      ? this.db.prepare("SELECT * FROM database_models WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
      : this.db.prepare("SELECT * FROM database_models ORDER BY updated_at DESC").all()) as DatabaseModelRow[];
    return rows.map(mapDatabaseModel);
  }

  getDatabaseModel(id: string): DatabaseModel | undefined {
    const row = this.db.prepare("SELECT * FROM database_models WHERE id = ?").get(id) as DatabaseModelRow | undefined;
    return row ? mapDatabaseModel(row) : undefined;
  }

  insertDatabaseModel(input: DatabaseModelInput): DatabaseModel {
    const ts = nowIso();
    const row: DatabaseModelRow = {
      id: input.id ?? newId(), project_id: input.projectId, name: input.name, dialect: input.dialect,
      tables: JSON.stringify(input.tables ?? []), relations: JSON.stringify(input.relations ?? []),
      created_at: ts, updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO database_models (id, project_id, name, dialect, tables, relations, created_at, updated_at)
       VALUES (@id, @project_id, @name, @dialect, @tables, @relations, @created_at, @updated_at)`
    ).run(row);
    return mapDatabaseModel(row);
  }

  updateDatabaseModel(id: string, patch: Partial<DatabaseModel>): DatabaseModel | undefined {
    const current = this.getDatabaseModel(id);
    if (!current) return undefined;
    const next: DatabaseModel = { ...current, ...patch, id: current.id, projectId: current.projectId, createdAt: current.createdAt, updatedAt: nowIso() };
    this.db.prepare(
      `UPDATE database_models SET name=@name, dialect=@dialect, tables=@tablesJson, relations=@relationsJson, updated_at=@updatedAt WHERE id=@id`
    ).run({ ...next, tablesJson: JSON.stringify(next.tables), relationsJson: JSON.stringify(next.relations) });
    return next;
  }

  deleteDatabaseModel(id: string): boolean {
    const current = this.getDatabaseModel(id);
    if (current) this.deleteDocumentReferencesForTarget(current.projectId, "databaseModel", id);
    return this.db.prepare("DELETE FROM database_models WHERE id = ?").run(id).changes > 0;
  }

  // ---------- diagram node database bindings ----------

  listNodeDatabaseBindings(filter: { projectId?: string; diagramId?: string; diagramNodeId?: string; databaseModelId?: string } = {}): NodeDatabaseBinding[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.projectId) { clauses.push("project_id = @projectId"); params.projectId = filter.projectId; }
    if (filter.diagramId) { clauses.push("diagram_id = @diagramId"); params.diagramId = filter.diagramId; }
    if (filter.diagramNodeId) { clauses.push("diagram_node_id = @diagramNodeId"); params.diagramNodeId = filter.diagramNodeId; }
    if (filter.databaseModelId) { clauses.push("database_model_id = @databaseModelId"); params.databaseModelId = filter.databaseModelId; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM node_database_bindings ${where} ORDER BY updated_at DESC`).all(params) as NodeDatabaseBindingRow[])
      .map(mapNodeDatabaseBinding);
  }

  getNodeDatabaseBinding(id: string): NodeDatabaseBinding | undefined {
    const row = this.db.prepare("SELECT * FROM node_database_bindings WHERE id = ?").get(id) as NodeDatabaseBindingRow | undefined;
    return row ? mapNodeDatabaseBinding(row) : undefined;
  }

  insertNodeDatabaseBinding(input: NodeDatabaseBindingInput): NodeDatabaseBinding {
    const ts = nowIso();
    const row: NodeDatabaseBindingRow = {
      id: input.id ?? newId(),
      project_id: input.projectId,
      diagram_id: input.diagramId,
      diagram_node_id: input.diagramNodeId,
      database_model_id: input.databaseModelId,
      schema_name: input.schemaName,
      table_name: input.tableName,
      operations: JSON.stringify(input.operations),
      purpose: input.purpose,
      created_at: ts,
      updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO node_database_bindings
       (id, project_id, diagram_id, diagram_node_id, database_model_id, schema_name, table_name, operations, purpose, created_at, updated_at)
       VALUES (@id, @project_id, @diagram_id, @diagram_node_id, @database_model_id, @schema_name, @table_name, @operations, @purpose, @created_at, @updated_at)`,
    ).run(row);
    return mapNodeDatabaseBinding(row);
  }

  updateNodeDatabaseBinding(id: string, patch: Partial<NodeDatabaseBinding>): NodeDatabaseBinding | undefined {
    const current = this.getNodeDatabaseBinding(id);
    if (!current) return undefined;
    const next: NodeDatabaseBinding = {
      ...current,
      ...patch,
      id: current.id,
      projectId: current.projectId,
      diagramId: current.diagramId,
      diagramNodeId: current.diagramNodeId,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    };
    this.db.prepare(
      `UPDATE node_database_bindings SET database_model_id=@databaseModelId, schema_name=@schemaName, table_name=@tableName,
       operations=@operationsJson, purpose=@purpose, updated_at=@updatedAt WHERE id=@id`,
    ).run({ ...next, operationsJson: JSON.stringify(next.operations) });
    return next;
  }

  deleteNodeDatabaseBinding(id: string): boolean {
    return this.db.prepare("DELETE FROM node_database_bindings WHERE id = ?").run(id).changes > 0;
  }

  // Keep insertion order: undo/redo use rowid, not timestamps (which may tie).
  listDiagramRevisions(diagramId: string): Array<{ id: string; diagramId: string; beforeJson: string; afterJson: string; actor: string; undone: number; createdAt: string }> {
    return this.db.prepare(
      `SELECT id, diagram_id AS diagramId, before_json AS beforeJson, after_json AS afterJson,
        actor, undone, created_at AS createdAt FROM diagram_revisions WHERE diagram_id = ? ORDER BY rowid ASC`,
    ).all(diagramId) as Array<{ id: string; diagramId: string; beforeJson: string; afterJson: string; actor: string; undone: number; createdAt: string }>;
  }

  recordDiagramRevision(diagramId: string, before: Diagram, after: Diagram, actor: string): string {
    const id = newId();
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM diagram_revisions WHERE diagram_id = ? AND undone = 1").run(diagramId);
      this.db.prepare(
        `INSERT INTO diagram_revisions (id, diagram_id, before_json, after_json, actor, undone, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).run(id, diagramId, JSON.stringify(before), JSON.stringify(after), actor, nowIso());
      this.db.prepare(
        `DELETE FROM diagram_revisions WHERE diagram_id = ? AND id NOT IN (
          SELECT id FROM diagram_revisions WHERE diagram_id = ? ORDER BY rowid DESC LIMIT 100
        )`,
      ).run(diagramId, diagramId);
    });
    transaction();
    return id;
  }

  undoDiagramRevision(diagramId: string): Diagram | undefined {
    const revision = this.db.prepare(
      "SELECT id, before_json AS beforeJson FROM diagram_revisions WHERE diagram_id = ? AND undone = 0 ORDER BY rowid DESC LIMIT 1",
    ).get(diagramId) as { id: string; beforeJson: string } | undefined;
    if (!revision) return undefined;
    const before = JSON.parse(revision.beforeJson) as Diagram;
    const updated = this.updateDiagram(diagramId, { title: before.title, type: before.type, nodes: before.nodes, edges: before.edges, groups: before.groups });
    this.db.prepare("UPDATE diagram_revisions SET undone = 1 WHERE id = ?").run(revision.id);
    return updated;
  }

  redoDiagramRevision(diagramId: string): Diagram | undefined {
    const revision = this.db.prepare(
      "SELECT id, after_json AS afterJson FROM diagram_revisions WHERE diagram_id = ? AND undone = 1 ORDER BY rowid ASC LIMIT 1",
    ).get(diagramId) as { id: string; afterJson: string } | undefined;
    if (!revision) return undefined;
    const after = JSON.parse(revision.afterJson) as Diagram;
    const updated = this.updateDiagram(diagramId, { title: after.title, type: after.type, nodes: after.nodes, edges: after.edges, groups: after.groups });
    this.db.prepare("UPDATE diagram_revisions SET undone = 0 WHERE id = ?").run(revision.id);
    return updated;
  }

  // ---------- design docs ----------

  listDesignDocs(projectId?: string): DesignDoc[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM design_docs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
        : this.db.prepare("SELECT * FROM design_docs ORDER BY updated_at DESC").all()
    ) as DesignDocRow[];
    return rows.map(mapDesignDoc);
  }

  listDesignDocsPage(query: DesignDocPageQuery): Paginated<DesignDoc> {
    return this.db.transaction(() => {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: query.limit, offset: query.offset };
    if (query.projectId) { clauses.push("d.project_id = @projectId"); params.projectId = query.projectId; }
    if (query.status) { clauses.push("d.status = @status"); params.status = query.status; }
    if (query.category) { clauses.push("d.category = @category"); params.category = query.category; }
    if (query.targetType && query.targetId) {
      clauses.push(`EXISTS (SELECT 1 FROM document_references dr
        WHERE dr.document_id = d.id AND dr.project_id = d.project_id
          AND dr.target_type = @targetType AND dr.target_id = @targetId)`);
      params.targetType = query.targetType;
      params.targetId = query.targetId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    if (query.q) {
      const matches = (this.db.prepare(`SELECT d.id, d.title, d.summary, d.content FROM design_docs d ${where} ORDER BY d.updated_at DESC`).all(params) as Array<{ id: string; title: string; summary: string; content: string }>)
        .filter((row) => databaseTextMatches(row.title, query.q!) || databaseTextMatches(row.summary, query.q!) || databaseTextMatches(row.content, query.q!));
      const ids = matches.slice(query.offset, query.offset + query.limit).map((row) => row.id);
      if (ids.length === 0) return databasePage([], matches.length, query.offset);
      const idParams = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
      const rows = this.db.prepare(`SELECT * FROM design_docs WHERE id IN (${ids.map((_, index) => `@id${index}`).join(", ")})`).all(idParams) as DesignDocRow[];
      const byId = new Map(rows.map((row) => [row.id, mapDesignDoc(row)]));
      return databasePage(ids.flatMap((id) => byId.get(id) ? [byId.get(id)!] : []), matches.length, query.offset);
    }

    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM design_docs d ${where}`).get(params) as { count: number }).count);
    const rows = this.db.prepare(`SELECT d.* FROM design_docs d ${where} ORDER BY d.updated_at DESC LIMIT @limit OFFSET @offset`).all(params) as DesignDocRow[];
    return databasePage(rows.map(mapDesignDoc), total, query.offset);
    })();
  }

  getDesignDoc(id: string): DesignDoc | undefined {
    const row = this.db.prepare("SELECT * FROM design_docs WHERE id = ?").get(id) as DesignDocRow | undefined;
    return row ? mapDesignDoc(row) : undefined;
  }

  insertDesignDoc(input: DesignDocInput): DesignDoc {
    const ts = nowIso();
    const legacy = input as DesignDocInput & { nodeId?: string | null; decisionIds?: string[]; currentRevisionId?: string };
    const revisionId = legacy.currentRevisionId || newId();
    const row: DesignDocRow = {
      id: input.id ?? newId(), project_id: input.projectId, node_id: null, current_revision_id: revisionId,
      decision_ids: "[]",
      category: input.category ?? "需求文档", title: input.title, summary: input.summary, status: input.status,
      version: input.version, author: input.author, source_url: input.sourceUrl ?? "", content: input.content,
      created_at: ts, updated_at: ts,
    };
    const insert = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO design_docs (id, project_id, node_id, decision_ids, current_revision_id, category, title, summary, status, version, author, source_url, content, created_at, updated_at)
         VALUES (@id, @project_id, @node_id, @decision_ids, @current_revision_id, @category, @title, @summary, @status, @version, @author, @source_url, @content, @created_at, @updated_at)`
      ).run(row);
      this.insertDocumentRevision({
        id: revisionId, projectId: row.project_id, documentId: row.id, category: row.category as DesignDoc["category"],
        title: row.title, summary: row.summary, status: row.status as DesignDoc["status"], version: row.version,
        author: row.author, sourceUrl: row.source_url, content: row.content, createdAt: row.updated_at,
      });
      if (legacy.nodeId) {
        this.insertDocumentReference({
          projectId: row.project_id, documentId: row.id, documentRevisionId: revisionId,
          targetType: "diagramNode", targetId: legacy.nodeId, relationType: "defines",
        });
      }
      for (const decisionId of legacy.decisionIds ?? []) {
        this.insertDocumentReference({
          projectId: row.project_id, documentId: row.id, documentRevisionId: revisionId,
          targetType: "governance", targetId: decisionId, relationType: "references",
        });
      }
    });
    insert();
    return mapDesignDoc(row);
  }

  updateDesignDoc(id: string, patch: Partial<DesignDoc>): DesignDoc | undefined {
    const current = this.getDesignDoc(id);
    if (!current) return undefined;
    const revisionId = newId();
    const next: DesignDoc = {
      ...current, ...patch, id: current.id, projectId: current.projectId,
      currentRevisionId: revisionId, createdAt: current.createdAt, updatedAt: nowIso(),
    };
    const update = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE design_docs SET current_revision_id=@currentRevisionId, category=@category, title=@title, summary=@summary, status=@status, version=@version,
          author=@author, source_url=@sourceUrl, content=@content, updated_at=@updatedAt WHERE id=@id`
      ).run(next);
      this.insertDocumentRevision({
        id: revisionId, projectId: next.projectId, documentId: next.id, category: next.category,
        title: next.title, summary: next.summary, status: next.status, version: next.version,
        author: next.author, sourceUrl: next.sourceUrl, content: next.content, createdAt: next.updatedAt,
      });
    });
    update();
    return next;
  }

  deleteDesignDoc(id: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM document_references WHERE document_id = ?").run(id);
      this.db.prepare("DELETE FROM document_revisions WHERE document_id = ?").run(id);
      return this.db.prepare("DELETE FROM design_docs WHERE id = ?").run(id).changes > 0;
    });
    return remove();
  }

  // ---------- document revisions and references ----------

  listDocumentRevisions(documentId: string): DocumentRevision[] {
    return (this.db.prepare("SELECT * FROM document_revisions WHERE document_id = ? ORDER BY created_at DESC").all(documentId) as DocumentRevisionRow[])
      .map(mapDocumentRevision);
  }

  getDocumentRevision(id: string): DocumentRevision | undefined {
    const row = this.db.prepare("SELECT * FROM document_revisions WHERE id = ?").get(id) as DocumentRevisionRow | undefined;
    return row ? mapDocumentRevision(row) : undefined;
  }

  insertDocumentRevision(revision: DocumentRevision): DocumentRevision {
    const row: DocumentRevisionRow = {
      id: revision.id, project_id: revision.projectId, document_id: revision.documentId,
      category: revision.category, title: revision.title, summary: revision.summary, status: revision.status,
      version: revision.version, author: revision.author, source_url: revision.sourceUrl,
      content: revision.content, created_at: revision.createdAt,
    };
    this.db.prepare(
      `INSERT OR IGNORE INTO document_revisions
       (id, project_id, document_id, category, title, summary, status, version, author, source_url, content, created_at)
       VALUES (@id, @project_id, @document_id, @category, @title, @summary, @status, @version, @author, @source_url, @content, @created_at)`,
    ).run(row);
    return mapDocumentRevision(row);
  }

  listDocumentReferences(filter: { projectId?: string; documentId?: string; targetType?: DocumentReference["targetType"]; targetId?: string } = {}): DocumentReference[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.projectId) { clauses.push("project_id = @projectId"); params.projectId = filter.projectId; }
    if (filter.documentId) { clauses.push("document_id = @documentId"); params.documentId = filter.documentId; }
    if (filter.targetType) { clauses.push("target_type = @targetType"); params.targetType = filter.targetType; }
    if (filter.targetId) { clauses.push("target_id = @targetId"); params.targetId = filter.targetId; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM document_references ${where} ORDER BY created_at DESC`).all(params) as DocumentReferenceRow[])
      .map(mapDocumentReference);
  }

  getDocumentReference(id: string): DocumentReference | undefined {
    const row = this.db.prepare("SELECT * FROM document_references WHERE id = ?").get(id) as DocumentReferenceRow | undefined;
    return row ? mapDocumentReference(row) : undefined;
  }

  insertDocumentReference(input: DocumentReferenceInput): DocumentReference {
    const document = this.getDesignDoc(input.documentId);
    if (!document) throw new Error("设计文档不存在");
    const revisionId = input.documentRevisionId ?? document.currentRevisionId;
    const revision = this.getDocumentRevision(revisionId);
    if (!revision || revision.documentId !== document.id) throw new Error("引用的文档版本不存在或不属于该文档");
    const existing = this.listDocumentReferences({ projectId: input.projectId, documentId: input.documentId, targetType: input.targetType, targetId: input.targetId })
      .find((item) => item.relationType === input.relationType);
    if (existing) return existing;
    const reference: DocumentReference = {
      id: input.id ?? newId(), projectId: input.projectId, documentId: input.documentId,
      documentRevisionId: revisionId, targetType: input.targetType, targetId: input.targetId,
      relationType: input.relationType, createdAt: (input as DocumentReferenceInput & { createdAt?: string }).createdAt ?? nowIso(),
    };
    this.db.prepare(
      `INSERT INTO document_references
       (id, project_id, document_id, document_revision_id, target_type, target_id, relation_type, created_at)
       VALUES (@id, @projectId, @documentId, @documentRevisionId, @targetType, @targetId, @relationType, @createdAt)`,
    ).run(reference);
    return reference;
  }

  deleteDocumentReference(id: string): boolean {
    return this.db.prepare("DELETE FROM document_references WHERE id = ?").run(id).changes > 0;
  }

  updateDocumentReferenceRevision(id: string, documentRevisionId: string): DocumentReference | undefined {
    const current = this.getDocumentReference(id);
    if (!current) return undefined;
    const revision = this.getDocumentRevision(documentRevisionId);
    if (!revision || revision.documentId !== current.documentId) throw new Error("引用的文档版本不存在或不属于该文档");
    this.db.prepare("UPDATE document_references SET document_revision_id = ? WHERE id = ?").run(documentRevisionId, id);
    return { ...current, documentRevisionId };
  }

  deleteDocumentReferencesForTarget(projectId: string, targetType: DocumentReference["targetType"], targetId: string): number {
    return this.db.prepare("DELETE FROM document_references WHERE project_id = ? AND target_type = ? AND target_id = ?")
      .run(projectId, targetType, targetId).changes;
  }

  // ---------- LLM profiles ----------

  listLlmProfiles(): LlmProfile[] {
    const rows = this.db.prepare("SELECT * FROM llm_profiles ORDER BY enabled DESC, name COLLATE NOCASE").all() as LlmProfileRow[];
    return rows.map((row) => mapLlmProfile(row, this.credentials));
  }

  getLlmProfile(id: string): LlmProfile | undefined {
    const row = this.db.prepare("SELECT * FROM llm_profiles WHERE id = ?").get(id) as LlmProfileRow | undefined;
    return row ? mapLlmProfile(row, this.credentials) : undefined;
  }

  insertLlmProfile(input: LlmProfileInput): LlmProfile {
    const ts = nowIso();
    const row: LlmProfileRow = {
      id: input.id ?? newId(),
      name: input.name,
      provider: input.provider,
      auth_mode: input.authMode ?? "api-key",
      protocol: input.protocol,
      base_url: input.baseUrl,
      api_key_env: input.apiKeyEnv,
      models: JSON.stringify(input.models),
      default_model: input.defaultModel,
      enabled: input.enabled ? 1 : 0,
      reasoning_effort: input.reasoningEffort
        ?? (input.provider.trim().toLocaleLowerCase() === "deepseek" || input.baseUrl.toLocaleLowerCase().includes("api.deepseek.com") ? "high" : "none"),
      timeout_ms: input.timeoutMs,
      created_at: ts,
      updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO llm_profiles (id, name, provider, auth_mode, protocol, base_url, api_key_env, models, default_model, enabled, reasoning_effort, timeout_ms, created_at, updated_at)
       VALUES (@id, @name, @provider, @auth_mode, @protocol, @base_url, @api_key_env, @models, @default_model, @enabled, @reasoning_effort, @timeout_ms, @created_at, @updated_at)`
    ).run(row);
    this.applyApiKey(row.id, input.apiKey);
    return this.getLlmProfile(row.id)!;
  }

  updateLlmProfile(id: string, patch: Partial<LlmProfileInput>): LlmProfile | undefined {
    const current = this.getLlmProfile(id);
    if (!current) return undefined;
    this.applyApiKey(id, patch.apiKey);
    const next = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
    this.db.prepare(
      `UPDATE llm_profiles SET name=@name, provider=@provider, auth_mode=@authMode, protocol=@protocol, base_url=@baseUrl,
       api_key_env=@apiKeyEnv, models=@modelsJson, default_model=@defaultModel, enabled=@enabledInt,
       reasoning_effort=@reasoningEffort, timeout_ms=@timeoutMs, updated_at=@updatedAt WHERE id=@id`
    ).run({ ...next, modelsJson: JSON.stringify(next.models), enabledInt: next.enabled ? 1 : 0 });
    return this.getLlmProfile(id);
  }

  deleteLlmProfile(id: string): boolean {
    const removed = this.db.prepare("DELETE FROM llm_profiles WHERE id = ?").run(id).changes > 0;
    if (removed) this.credentials.clear(id);
    return removed;
  }

  resolveLlmKey(profile: LlmProfile): string | undefined {
    return this.credentials.resolve(profile);
  }

  private applyApiKey(id: string, apiKey: string | undefined): void {
    if (typeof apiKey === "string" && apiKey.trim()) this.credentials.set(id, apiKey.trim());
  }

  // ---------- Agent blueprint settings (globally shared overrides) ----------

  listAgentBlueprintOverrides(): AgentBlueprintOverride[] {
    const rows = this.db.prepare("SELECT * FROM agent_blueprint_settings ORDER BY key").all() as AgentBlueprintOverrideRow[];
    return rows.map(mapAgentBlueprintOverride);
  }

  getAgentBlueprintOverride(key: AgentBlueprintKey): AgentBlueprintOverride | undefined {
    const row = this.db.prepare("SELECT * FROM agent_blueprint_settings WHERE key = ?").get(key) as AgentBlueprintOverrideRow | undefined;
    return row ? mapAgentBlueprintOverride(row) : undefined;
  }

  upsertAgentBlueprintOverride(key: AgentBlueprintKey, patch: Partial<Pick<AgentBlueprintOverride, "name" | "purpose" | "responsibilities" | "boundaries" | "allowedMcpTools">>): AgentBlueprintOverride {
    const ts = nowIso();
    const current = this.getAgentBlueprintOverride(key);
    const next = {
      key,
      name: patch.name ?? current?.name ?? "",
      purpose: patch.purpose ?? current?.purpose ?? "",
      responsibilities: patch.responsibilities ?? current?.responsibilities ?? [],
      boundaries: patch.boundaries ?? current?.boundaries ?? [],
      allowedMcpTools: patch.allowedMcpTools ?? current?.allowedMcpTools ?? [],
      updatedAt: ts,
    };
    this.db.prepare(
      `INSERT INTO agent_blueprint_settings (key, name, purpose, responsibilities, boundaries, allowed_mcp_tools, updated_at)
       VALUES (@key, @name, @purpose, @responsibilities, @boundaries, @allowedMcpTools, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET name=@name, purpose=@purpose, responsibilities=@responsibilities,
         boundaries=@boundaries, allowed_mcp_tools=@allowedMcpTools, updated_at=@updatedAt`
    ).run({
      key: next.key,
      name: next.name,
      purpose: next.purpose,
      responsibilities: JSON.stringify(next.responsibilities),
      boundaries: JSON.stringify(next.boundaries),
      allowedMcpTools: JSON.stringify(next.allowedMcpTools),
      updatedAt: next.updatedAt,
    });
    return this.getAgentBlueprintOverride(key)!;
  }

  // ---------- Agent workspaces ----------

  getAgentWorkspace(projectId: string): AgentWorkspace | undefined {
    const row = this.db.prepare("SELECT * FROM agent_workspaces WHERE project_id = ?").get(projectId) as AgentWorkspaceRow | undefined;
    return row ? mapAgentWorkspace(row) : undefined;
  }

  ensureAgentWorkspace(projectId: string): AgentWorkspace {
    const current = this.getAgentWorkspace(projectId);
    if (current) return current;
    const ts = nowIso();
    const row: AgentWorkspaceRow = { id: newId(), project_id: projectId, default_profile_id: null, created_at: ts, updated_at: ts };
    this.db.prepare(
      "INSERT INTO agent_workspaces (id, project_id, default_profile_id, created_at, updated_at) VALUES (@id, @project_id, @default_profile_id, @created_at, @updated_at)",
    ).run(row);
    return mapAgentWorkspace(row);
  }

  updateAgentWorkspace(projectId: string, defaultProfileId: string | null): AgentWorkspace | undefined {
    const workspace = this.ensureAgentWorkspace(projectId);
    const updatedAt = nowIso();
    this.db.prepare("UPDATE agent_workspaces SET default_profile_id = ?, updated_at = ? WHERE id = ?")
      .run(defaultProfileId, updatedAt, workspace.id);
    return this.getAgentWorkspace(projectId);
  }

  getAgentWorkspaceSnapshot(projectId: string): AgentWorkspaceSnapshot {
    return { workspace: this.ensureAgentWorkspace(projectId), sessions: this.listAgentSessions(projectId) };
  }

  listAgentSessions(projectId: string): AgentSession[] {
    const rows = this.db.prepare("SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as AgentSessionRow[];
    return rows.map(mapAgentSession);
  }

  getAgentSession(id: string): AgentSession | undefined {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as AgentSessionRow | undefined;
    return row ? mapAgentSession(row) : undefined;
  }

  insertAgentSession(input: AgentSessionInput): AgentSession {
    const workspace = this.ensureAgentWorkspace(input.projectId);
    const ts = nowIso();
    const row: AgentSessionRow = {
      id: input.id ?? newId(),
      workspace_id: workspace.id,
      project_id: input.projectId,
      profile_id: input.profileId,
      model: input.model,
      codex_thread_id: null,
      title: input.title,
      control_mode: input.controlMode ?? "restricted",
      status: "idle",
      last_error: "",
      created_at: ts,
      updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO agent_sessions
       (id, workspace_id, project_id, profile_id, model, codex_thread_id, title, control_mode, status, last_error, created_at, updated_at)
       VALUES (@id, @workspace_id, @project_id, @profile_id, @model, @codex_thread_id, @title, @control_mode, @status, @last_error, @created_at, @updated_at)`,
    ).run(row);
    return mapAgentSession(row);
  }

  updateAgentSession(id: string, patch: Partial<Pick<AgentSession, "profileId" | "model" | "codexThreadId" | "title" | "controlMode" | "status" | "lastError">>): AgentSession | undefined {
    const current = this.getAgentSession(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, updatedAt: nowIso() };
    this.db.prepare(
      `UPDATE agent_sessions SET profile_id=@profileId, model=@model, codex_thread_id=@codexThreadId,
       title=@title, control_mode=@controlMode, status=@status, last_error=@lastError, updated_at=@updatedAt WHERE id=@id`,
    ).run(next);
    return this.getAgentSession(id);
  }

  deleteAgentSession(id: string): boolean {
    return this.db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(id).changes > 0;
  }

  listAgentMessages(sessionId: string): AgentMessage[] {
    const rows = this.db.prepare("SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as AgentMessageRow[];
    return rows.map(mapAgentMessage);
  }

  getAgentMessage(id: string): AgentMessage | undefined {
    const row = this.db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as AgentMessageRow | undefined;
    return row ? mapAgentMessage(row) : undefined;
  }

  insertAgentMessage(input: AgentMessageInput): AgentMessage {
    const ts = nowIso();
    const row: AgentMessageRow = {
      id: input.id ?? newId(),
      session_id: input.sessionId,
      project_id: input.projectId,
      role: input.role,
      content: input.content,
      status: input.status,
      page_context: input.pageContext ? JSON.stringify(input.pageContext) : null,
      created_at: ts,
      updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO agent_messages
       (id, session_id, project_id, role, content, status, page_context, created_at, updated_at)
       VALUES (@id, @session_id, @project_id, @role, @content, @status, @page_context, @created_at, @updated_at)`,
    ).run(row);
    return mapAgentMessage(row);
  }

  updateAgentMessage(id: string, patch: Partial<Pick<AgentMessage, "content" | "status">>): AgentMessage | undefined {
    const current = this.getAgentMessage(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db.prepare("UPDATE agent_messages SET content = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next.content, next.status, next.updatedAt, id);
    return this.getAgentMessage(id);
  }

  listAgentApprovals(sessionId: string, status?: AgentApprovalStatus): AgentApproval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM agent_approvals WHERE session_id = ? AND status = ? ORDER BY created_at").all(sessionId, status)
      : this.db.prepare("SELECT * FROM agent_approvals WHERE session_id = ? ORDER BY created_at").all(sessionId);
    return (rows as AgentApprovalRow[]).map(mapAgentApproval);
  }

  getAgentApproval(id: string): AgentApproval | undefined {
    const row = this.db.prepare("SELECT * FROM agent_approvals WHERE id = ?").get(id) as AgentApprovalRow | undefined;
    return row ? mapAgentApproval(row) : undefined;
  }

  insertAgentApproval(input: Pick<AgentApproval, "projectId" | "sessionId" | "kind" | "title" | "summary" | "details" | "expiresAt"> & { id?: string }): AgentApproval {
    const row: AgentApprovalRow = {
      id: input.id ?? newId(), project_id: input.projectId, session_id: input.sessionId,
      kind: input.kind, title: input.title, summary: input.summary, details: JSON.stringify(input.details),
      status: "pending", decision: null, expires_at: input.expiresAt, created_at: nowIso(), resolved_at: "",
    };
    this.db.prepare(
      `INSERT INTO agent_approvals
       (id, project_id, session_id, kind, title, summary, details, status, decision, expires_at, created_at, resolved_at)
       VALUES (@id, @project_id, @session_id, @kind, @title, @summary, @details, @status, @decision, @expires_at, @created_at, @resolved_at)`,
    ).run(row);
    return mapAgentApproval(row);
  }

  resolveAgentApproval(id: string, status: "approved" | "denied" | "expired", decision: AgentApprovalDecision): AgentApproval | undefined {
    this.db.prepare(
      "UPDATE agent_approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).run(status, decision, nowIso(), id);
    return this.getAgentApproval(id);
  }

  // ---------- audit ----------

  listAudit(limit = 100, projectId?: string, offset = 0): AuditEvent[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(projectId, limit, offset)
        : this.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset)
    ) as AuditRow[];
    return rows.map(mapAudit);
  }

  listAuditPage(filter: AuditFilter = {}): Paginated<AuditEvent> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.projectId) { clauses.push("project_id = @projectId"); params.projectId = filter.projectId; }
    if (filter.source) { clauses.push("source = @source"); params.source = filter.source; }
    if (filter.action) { clauses.push("action = @action"); params.action = filter.action; }
    if (filter.entityType) { clauses.push("entity_type = @entityType"); params.entityType = filter.entityType; }
    if (filter.entityId) { clauses.push("entity_id = @entityId"); params.entityId = filter.entityId; }
    if (filter.correlationId) { clauses.push("correlation_id = @correlationId"); params.correlationId = filter.correlationId; }
    if (filter.sessionId) { clauses.push("session_id = @sessionId"); params.sessionId = filter.sessionId; }
    if (filter.q) {
      clauses.push("(actor LIKE @q OR action LIKE @q OR entity_type LIKE @q OR entity_id LIKE @q OR before LIKE @q OR after LIKE @q)");
      params.q = `%${filter.q}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM audit_events ${where}`).get(params) as { total: number }).total;
    const rows = this.db.prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit, offset }) as AuditRow[];
    const items = rows.map(mapAudit);
    const nextOffset = offset + items.length;
    return { total, count: items.length, offset, items, hasMore: nextOffset < total, nextOffset: nextOffset < total ? nextOffset : null };
  }

  recordAudit(event: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const row: AuditRow = {
      id: newId(), project_id: event.projectId, entity_type: event.entityType,
      entity_id: event.entityId, action: event.action,
      before: event.before === null ? null : JSON.stringify(event.before),
      after: event.after === null ? null : JSON.stringify(event.after),
      actor: event.actor, source: event.source, created_at: nowIso(),
      correlation_id: event.correlationId ?? "", client_id: event.clientId ?? "",
      session_id: event.sessionId ?? "", model: event.model ?? "", parent_event_id: event.parentEventId ?? null,
    };
    this.db.prepare(
      `INSERT INTO audit_events (id, project_id, entity_type, entity_id, action, before, after, actor, source,
        correlation_id, client_id, session_id, model, parent_event_id, created_at)
       VALUES (@id, @project_id, @entity_type, @entity_id, @action, @before, @after, @actor, @source,
        @correlation_id, @client_id, @session_id, @model, @parent_event_id, @created_at)`
    ).run(row);
    return mapAudit(row);
  }

  // ---------- backups ----------

  listBackups(): Backup[] {
    return this.db
      .prepare("SELECT id, label, reason, item_count AS itemCount, created_at AS createdAt FROM backups ORDER BY created_at DESC")
      .all() as Backup[];
  }

  insertBackup(backup: Backup): void {
    this.db.prepare(
      "INSERT INTO backups (id, label, reason, item_count, created_at) VALUES (@id, @label, @reason, @itemCount, @createdAt)"
    ).run(backup);
  }

  restoreBusinessSnapshot(snapshot: unknown): { projects: number; workNodes: number; plans: number; evidence: number; governance: number; designDocs: number; documentRevisions: number; documentReferences: number; diagrams: number; diagramRevisions: number; databaseModels: number; nodeDatabaseBindings: number } {
    if (!snapshot || typeof snapshot !== "object") throw new Error("备份内容不是有效对象");
    const data = snapshot as Record<string, unknown>;
    if (!Array.isArray(data.projects) || !Array.isArray(data.governance)) throw new Error("备份缺少 projects 或 governance 数据");
    const grouped = (key: string): unknown[] => {
      const value = data[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`备份缺少 ${key} 数据`);
      const lists = Object.values(value as Record<string, unknown>);
      if (lists.some((list) => !Array.isArray(list))) throw new Error(`备份中的 ${key} 格式无效`);
      return lists.flatMap((list) => list as unknown[]);
    };
    const projects = data.projects as Project[];
    const workNodes = grouped("workNodes") as WorkNode[];
    const plans = grouped("plans") as PlanItem[];
    const evidence = grouped("evidence") as Evidence[];
    const governance = data.governance as GovernanceRecord[];
    const designDocs = grouped("designDocs") as DesignDoc[];
    const documentRevisions = data.documentRevisions ? grouped("documentRevisions") as DocumentRevision[] : [];
    const documentReferences = data.documentReferences ? grouped("documentReferences") as DocumentReference[] : [];
    const diagrams = grouped("diagrams") as Diagram[];
    const diagramRevisions = data.diagramRevisions !== undefined
      ? grouped("diagramRevisions") as ReturnType<Store["listDiagramRevisions"]> : [];
    const diagramIds = new Set(diagrams.map((diagram) => diagram.id));
    for (const revision of diagramRevisions) {
      if (!revision || typeof revision.id !== "string" || !diagramIds.has(revision.diagramId)
        || typeof revision.actor !== "string" || typeof revision.createdAt !== "string"
        || ![0, 1].includes(revision.undone)
        || typeof revision.beforeJson !== "string" || typeof revision.afterJson !== "string") {
        throw new Error("备份中的 diagramRevisions 格式无效");
      }
      for (const json of [revision.beforeJson, revision.afterJson]) {
        const diagram = JSON.parse(json) as Diagram;
        if (!diagram || diagram.id !== revision.diagramId || !Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) {
          throw new Error("备份中的画布历史内容无效");
        }
      }
    }
    const restoredEvidence = [...evidence];
    const restoredEvidenceIds = new Set(restoredEvidence.map((item) => item.id));
    for (const item of legacyEvidenceFromDiagrams(diagrams)) {
      if (!restoredEvidenceIds.has(item.id)) restoredEvidence.push(item);
    }
    const databaseModels = data.databaseModels ? grouped("databaseModels") as DatabaseModel[] : [];
    const nodeDatabaseBindings = data.nodeDatabaseBindings ? grouped("nodeDatabaseBindings") as NodeDatabaseBinding[] : [];

    const restore = this.db.transaction(() => {
      this.db.prepare("DELETE FROM diagram_revisions").run();
      this.db.prepare("DELETE FROM document_references").run();
      this.db.prepare("DELETE FROM document_revisions").run();
      this.db.prepare("DELETE FROM design_docs").run();
      this.db.prepare("DELETE FROM node_database_bindings").run();
      this.db.prepare("DELETE FROM database_models").run();
      this.db.prepare("DELETE FROM governance").run();
      this.db.prepare("DELETE FROM evidence").run();
      this.db.prepare("DELETE FROM plan_items").run();
      this.db.prepare("DELETE FROM work_nodes").run();
      this.db.prepare("DELETE FROM diagrams").run();
      this.db.prepare("DELETE FROM projects").run();

      for (const project of projects) this.insertProject(project);
      this.db.prepare("DELETE FROM diagrams").run();
      for (const node of workNodes) this.insertNode(node);
      for (const plan of plans) this.insertPlan(plan);
      for (const item of restoredEvidence) this.insertEvidence(item);
      for (const record of governance) this.insertGovernance(record);
      for (const doc of designDocs) this.insertDesignDoc(doc);
      for (const revision of documentRevisions) this.insertDocumentRevision(revision);
      for (const reference of documentReferences) this.insertDocumentReference(reference);
      for (const diagram of diagrams) this.insertDiagram(diagram);
      const insertDiagramRevision = this.db.prepare(
        `INSERT INTO diagram_revisions (id, diagram_id, before_json, after_json, actor, undone, created_at)
         VALUES (@id, @diagramId, @beforeJson, @afterJson, @actor, @undone, @createdAt)`,
      );
      for (const revision of diagramRevisions) insertDiagramRevision.run(revision);
      for (const model of databaseModels) this.insertDatabaseModel(model);
      for (const binding of nodeDatabaseBindings) this.insertNodeDatabaseBinding(binding);
      for (const project of projects) this.ensureProjectMainDiagram(project);
    });
    restore();
    return {
      projects: projects.length,
      workNodes: workNodes.length,
      plans: plans.length,
      evidence: restoredEvidence.length,
      governance: governance.length,
      designDocs: designDocs.length,
      documentRevisions: documentRevisions.length || designDocs.length,
      documentReferences: documentReferences.length + designDocs.filter((doc) => Boolean((doc as DesignDoc & { nodeId?: string }).nodeId)).length,
      diagrams: diagrams.length,
      diagramRevisions: diagramRevisions.length,
      databaseModels: databaseModels.length,
      nodeDatabaseBindings: nodeDatabaseBindings.length,
    };
  }

  // ---------- dashboard ----------

  dashboard(projectsOverride?: Project[]) {
    const projects = projectsOverride ?? this.listProjects().map((project) => this.getProjectWorkspace(project.id)?.project ?? project);
    const plans = this.listAllPlans();
    const today = new Date().toISOString().slice(0, 10);
    const byStage: Record<string, number> = {};
    const byHealth: Record<string, number> = {};
    let unconfigured = 0;
    for (const p of projects) {
      byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;
      if (!p.unconfigured) byHealth[p.health] = (byHealth[p.health] ?? 0) + 1;
      else { unconfigured += 1; byHealth["待配置"] = (byHealth["待配置"] ?? 0) + 1; }
    }
    const overduePlans = plans.filter((p) => p.dueAt && p.dueAt < today && p.status !== "已完成");
    const attentionProjects = projects.filter((p) => !p.unconfigured && p.health !== "正常");
    return {
      totals: {
        projects: projects.length,
        activeProjects: projects.filter((p) => !p.unconfigured && ["设计", "开发", "测试"].includes(p.stage)).length,
        attention: attentionProjects.length,
        unconfigured,
        overduePlans: overduePlans.length,
      },
      byStage,
      byHealth,
      attentionProjects: attentionProjects.slice(0, 20),
      unconfiguredProjects: projects.filter((p) => p.unconfigured).slice(0, 20),
      overduePlans: overduePlans.slice(0, 20),
      recentAudit: this.listAudit(15),
      generatedAt: nowIso(),
    };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '探索',
  health TEXT NOT NULL DEFAULT '正常',
  progress INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'P2',
  risk_summary TEXT NOT NULL DEFAULT '',
  blocker_summary TEXT NOT NULL DEFAULT '',
  next_step TEXT NOT NULL DEFAULT '',
  repository_path TEXT NOT NULL DEFAULT '',
  external_repository_id TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P2',
  owner TEXT NOT NULL DEFAULT '',
  requirement_status TEXT NOT NULL DEFAULT '待整理',
  design_status TEXT NOT NULL DEFAULT '未开始',
  development_status TEXT NOT NULL DEFAULT '未开始',
  test_status TEXT NOT NULL DEFAULT '未开始',
  progress INTEGER NOT NULL DEFAULT 0,
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  diagram_id TEXT,
  diagram_node_id TEXT,
  parent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '未开始',
  priority TEXT NOT NULL DEFAULT 'P2',
  progress INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT '',
  role_assignments TEXT NOT NULL DEFAULT '{}',
  version_tag TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  dependency_ids TEXT NOT NULL DEFAULT '[]',
  blocked_reason TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  lifecycle_status TEXT NOT NULL DEFAULT 'draft',
  proposal_revision INTEGER NOT NULL DEFAULT 1,
  design_revision_ids TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL DEFAULT '',
  rejected_by TEXT NOT NULL DEFAULT '',
  rejected_at TEXT NOT NULL DEFAULT '',
  rejection_reason TEXT NOT NULL DEFAULT '',
  implementation_revision TEXT NOT NULL DEFAULT '',
  completed_by TEXT NOT NULL DEFAULT '',
  audit_status TEXT NOT NULL DEFAULT 'not_requested',
  audited_by TEXT NOT NULL DEFAULT '',
  audited_at TEXT NOT NULL DEFAULT '',
  manager_decision TEXT NOT NULL DEFAULT 'pending',
  manager_decision_by TEXT NOT NULL DEFAULT '',
  manager_decision_at TEXT NOT NULL DEFAULT '',
  rework_of_plan_id TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT,
  source_type TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  result_status TEXT NOT NULL DEFAULT 'info',
  summary TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  commit_sha TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL DEFAULT '',
  plan_item_id TEXT,
  acceptance_criterion_key TEXT NOT NULL DEFAULT '',
  document_revision_id TEXT,
  actor_role TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  run_id TEXT NOT NULL DEFAULT '',
  supersedes_evidence_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  revoked_reason TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_repair_state (
  plan_id TEXT PRIMARY KEY REFERENCES plan_items(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  diagram_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'decision',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '有效',
  author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS design_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT,
  decision_ids TEXT NOT NULL DEFAULT '[]',
  current_revision_id TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '需求文档',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '草拟',
  version TEXT NOT NULL DEFAULT 'v0.1',
  author TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES design_docs(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES design_docs(id) ON DELETE CASCADE,
  document_revision_id TEXT NOT NULL REFERENCES document_revisions(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'references',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagrams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'free',
  nodes TEXT NOT NULL DEFAULT '[]',
  edges TEXT NOT NULL DEFAULT '[]',
  groups TEXT NOT NULL DEFAULT '[]',
  layers TEXT,
  components TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagram_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  name TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  content TEXT NOT NULL,
  thumbnail_meta TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS prototype_drafts (
  diagram_id TEXT PRIMARY KEY REFERENCES diagrams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diagram_freeform_documents (
  diagram_id TEXT PRIMARY KEY REFERENCES diagrams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS freeform_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_env TEXT NOT NULL,
  models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  reasoning_effort TEXT NOT NULL DEFAULT 'none',
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  default_profile_id TEXT REFERENCES llm_profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  model TEXT NOT NULL,
  codex_thread_id TEXT,
  title TEXT NOT NULL DEFAULT '新会话',
  control_mode TEXT NOT NULL DEFAULT 'restricted',
  status TEXT NOT NULL DEFAULT 'idle',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  page_context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agent_blueprint_settings (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  responsibilities TEXT NOT NULL DEFAULT '[]',
  boundaries TEXT NOT NULL DEFAULT '[]',
  allowed_mcp_tools TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS database_models (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dialect TEXT NOT NULL DEFAULT 'mysql',
  tables TEXT NOT NULL DEFAULT '[]',
  relations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_database_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
  diagram_node_id TEXT NOT NULL,
  database_model_id TEXT NOT NULL,
  schema_name TEXT NOT NULL DEFAULT '',
  table_name TEXT NOT NULL,
  operations TEXT NOT NULL DEFAULT '[]',
  purpose TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(diagram_id, diagram_node_id, database_model_id, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS diagram_revisions (
  id TEXT PRIMARY KEY,
  diagram_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before TEXT,
  after TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'web',
  correlation_id TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  parent_event_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON work_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plan_items(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project_collected ON evidence(project_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_repair_project_status ON evidence_repair_state(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_governance_project ON governance(project_id);
CREATE INDEX IF NOT EXISTS idx_design_docs_project ON design_docs(project_id);
CREATE INDEX IF NOT EXISTS idx_design_docs_updated ON design_docs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_docs_project_updated ON design_docs(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_revisions_document ON document_revisions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_references_document ON document_references(document_id);
CREATE INDEX IF NOT EXISTS idx_document_references_target ON document_references(project_id, target_type, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_references_unique ON document_references(document_id, target_type, target_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_diagrams_project ON diagrams(project_id);
CREATE INDEX IF NOT EXISTS idx_diagram_templates_project_name ON diagram_templates(project_id, name);
CREATE INDEX IF NOT EXISTS idx_diagram_templates_scope_updated ON diagram_templates(scope, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_profiles_name ON llm_profiles(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_session ON agent_approvals(session_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_database_models_project ON database_models(project_id);
CREATE INDEX IF NOT EXISTS idx_node_database_bindings_node ON node_database_bindings(diagram_id, diagram_node_id);
CREATE INDEX IF NOT EXISTS idx_node_database_bindings_model ON node_database_bindings(database_model_id);
CREATE INDEX IF NOT EXISTS idx_diagram_revisions_diagram ON diagram_revisions(diagram_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_diagrams_one_main_per_project ON diagrams(project_id) WHERE type = 'main';
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
`;
