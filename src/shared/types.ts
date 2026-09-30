export const PROJECT_STAGES = ["探索", "规划", "设计", "开发", "测试", "交付", "维护"] as const;
export const HEALTH_LEVELS = ["正常", "关注", "高风险", "阻塞"] as const;
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const NODE_KINDS = ["module", "feature", "requirement", "development", "test"] as const;
export const PLAN_KINDS = ["goal", "milestone", "version", "task"] as const;

export const REQUIREMENT_STATUSES = ["待整理", "草拟中", "待评审", "已批准", "已拒绝"] as const;
export const DESIGN_STATUSES = ["未开始", "进行中", "待评审", "已批准", "不适用"] as const;
export const DEVELOPMENT_STATUSES = ["未开始", "进行中", "待评审", "已完成", "已阻塞", "不适用"] as const;
export const TEST_STATUSES = ["未开始", "进行中", "已通过", "未通过", "已阻塞", "不适用"] as const;
export const PLAN_STATUSES = ["未开始", "进行中", "已完成", "已阻塞"] as const;
export const PLAN_LIFECYCLE_STATUSES = [
  "legacy",
  "draft",
  "pending_approval",
  "approved",
  "in_progress",
  "pending_audit",
  "audit_failed",
  "pending_manager",
  "accepted",
  "rework",
  "superseded",
] as const;
export const PLAN_AUDIT_STATUSES = ["not_requested", "pending", "passed", "failed"] as const;
export const MANAGER_DECISIONS = ["pending", "approved", "rejected"] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];
export type HealthLevel = (typeof HEALTH_LEVELS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type NodeKind = (typeof NODE_KINDS)[number];
export type PlanKind = (typeof PLAN_KINDS)[number];
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];
export type DesignStatus = (typeof DESIGN_STATUSES)[number];
export type DevelopmentStatus = (typeof DEVELOPMENT_STATUSES)[number];
export type TestStatus = (typeof TEST_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanLifecycleStatus = (typeof PLAN_LIFECYCLE_STATUSES)[number];
export type PlanAuditStatus = (typeof PLAN_AUDIT_STATUSES)[number];
export type ManagerDecision = (typeof MANAGER_DECISIONS)[number];

export const PLAN_AGENT_ROLES = ["designer", "builder", "auditor"] as const;
export type PlanAgentRole = (typeof PLAN_AGENT_ROLES)[number];

export interface PlanRoleAssignment {
  agentId: string;
  displayName: string;
  /** 可选 Worker 池；为空时由项目、角色和 agentId 生成兼容池。 */
  poolId?: string;
}

export type PlanRoleAssignments = Record<PlanAgentRole, PlanRoleAssignment>;

export interface Project {
  id: string;
  code: string;
  name: string;
  summary: string;
  stage: ProjectStage;
  health: HealthLevel;
  progress: number;
  riskLevel: Priority;
  riskSummary: string;
  blockerSummary: string;
  nextStep: string;
  repositoryPath: string;
  startAt: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  /** 导入后未展开（无工作节点也无计划项），非真实健康状态。 */
  unconfigured?: boolean;
}

export interface WorkNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: NodeKind;
  title: string;
  description: string;
  priority: Priority;
  owner: string;
  requirementStatus: RequirementStatus;
  designStatus: DesignStatus;
  developmentStatus: DevelopmentStatus;
  testStatus: TestStatus;
  progress: number;
  startAt: string;
  dueAt: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlanItem {
  id: string;
  projectId: string;
  diagramId: string | null;
  diagramNodeId: string | null;
  parentId: string | null;
  kind: PlanKind;
  title: string;
  description: string;
  status: PlanStatus;
  priority: Priority;
  progress: number;
  owner: string;
  roleAssignments: PlanRoleAssignments;
  versionTag: string;
  startAt: string;
  dueAt: string;
  dependencyIds: string[];
  blockedReason: string;
  completedAt: string;
  lifecycleStatus: PlanLifecycleStatus;
  proposalRevision: number;
  /** Designer 提交时冻结的已批准文档修订；设计审计只能针对这组不可变修订。 */
  designRevisionIds: string[];
  proposedBy: string;
  submittedAt: string;
  approvedBy: string;
  approvedAt: string;
  rejectedBy: string;
  rejectedAt: string;
  rejectionReason: string;
  implementationRevision: string;
  completedBy: string;
  auditStatus: PlanAuditStatus;
  auditedBy: string;
  auditedAt: string;
  managerDecision: ManagerDecision;
  managerDecisionBy: string;
  managerDecisionAt: string;
  reworkOfPlanId: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export type PlanItemInput = Omit<PlanItem,
  "id" | "createdAt" | "updatedAt" | "diagramId" | "diagramNodeId" | "blockedReason" | "completedAt" |
  "lifecycleStatus" | "proposalRevision" | "designRevisionIds" | "proposedBy" | "submittedAt" | "approvedBy" | "approvedAt" |
  "rejectedBy" | "rejectedAt" | "rejectionReason" | "implementationRevision" | "completedBy" |
  "auditStatus" | "auditedBy" | "auditedAt" | "managerDecision" | "managerDecisionBy" |
  "managerDecisionAt" | "reworkOfPlanId" | "correlationId" | "roleAssignments"
> & {
  id?: string;
  diagramId?: string | null;
  diagramNodeId?: string | null;
  blockedReason?: string;
  completedAt?: string;
  lifecycleStatus?: PlanLifecycleStatus;
  proposalRevision?: number;
  designRevisionIds?: string[];
  proposedBy?: string;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  implementationRevision?: string;
  completedBy?: string;
  auditStatus?: PlanAuditStatus;
  auditedBy?: string;
  auditedAt?: string;
  managerDecision?: ManagerDecision;
  managerDecisionBy?: string;
  managerDecisionAt?: string;
  reworkOfPlanId?: string | null;
  correlationId?: string;
  roleAssignments?: PlanRoleAssignments;
};

export type EvidenceSource = "git" | "maven" | "junit" | "playwright" | "manual";

export interface Evidence {
  id: string;
  projectId: string;
  nodeId: string | null;
  sourceType: EvidenceSource;
  sourcePath: string;
  command: string;
  resultStatus: "pass" | "warn" | "fail" | "info";
  summary: string;
  details: Record<string, unknown>;
  commitSha: string;
  digest: string;
  planItemId: string | null;
  acceptanceCriterionKey: string;
  documentRevisionId: string | null;
  actorRole: PlanAgentRole | null;
  agentId: string;
  sessionId: string | null;
  runId: string;
  supersedesEvidenceId: string | null;
  status: "active" | "revoked" | "superseded";
  revokedReason: string;
  revokedAt: string;
  collectedAt: string;
}

export interface GovernanceRecord {
  id: string;
  projectId: string;
  type: "decision" | "opinion";
  title: string;
  content: string;
  rationale: string;
  status: "有效" | "待确认" | "已替代";
  author: string;
  createdAt: string;
}

export interface DesignChangeRequest {
  intentId?: string;
  projectId: string;
  diagramId: string;
  nodeId: string;
  actor: string;
  reason: string;
  changeSummary: string;
  requirementImpact: boolean;
  impactedDocumentIds: string[];
  impactedPlanIds: string[];
  reusableWorkSummary: string;
  reworkScope: string;
  apiImpact: string;
  databaseImpact: string;
  deploymentImpact: string;
  reusableEvidenceIds?: string[];
  expectedUpdatedAt: string;
  idempotencyKey: string;
  clientId?: string;
  sessionId?: string;
  model?: string;
}

export type DesignChangeIntentStatus = "pending" | "applied" | "dismissed" | "stale";

export interface DesignChangeIntentInput {
  projectId: string;
  diagramId: string;
  nodeId: string;
  rootPlanId: string;
  reason: string;
  changeSummary: string;
  expectedUpdatedAt: string;
  idempotencyKey: string;
  requestedBy?: string;
}

export interface DesignChangeIntentTaskContext {
  intentId: string;
  rootPlanId: string;
  impactedPlanIds: string[];
  impactedDocumentIds: string[];
  snapshotHash: string;
  reason: string;
  changeSummary: string;
}

export interface DesignChangeIntentResult {
  intentId: string;
  status: DesignChangeIntentStatus;
  approvalTaskIds: string[];
  authorizesImplementation: false;
  snapshotHash: string;
  changeId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignChangeResult {
  changeId: string;
  projectId: string;
  diagramId: string;
  nodeId: string;
  requirementStatus: RequirementStatus;
  designStatus: DesignStatus;
  revisedDocuments: Array<{ documentId: string; previousRevisionId: string; revisionId: string }>;
  impactedPlanIds: string[];
  reworkPlanIds: string[];
  releasedLeaseTaskKeys: string[];
  revokedEvidenceIds: string[];
  retainedEvidenceIds: string[];
  nextAction: ProjectWorkflowAction | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: string;
  source: "web" | "mcp" | "system";
  correlationId?: string;
  clientId?: string;
  sessionId?: string;
  model?: string;
  parentEventId?: string | null;
  createdAt: string;
}

export interface Backup {
  id: string;
  label: string;
  reason: string;
  itemCount: number;
  createdAt: string;
}

export interface DashboardData {
  projects: Project[];
  nodes: WorkNode[];
  planItems: PlanItem[];
  evidence: Evidence[];
  governance: GovernanceRecord[];
  audit: AuditEvent[];
  backups: Backup[];
  generatedAt: string;
}

export type ProjectInput = Omit<Project, "id" | "progress" | "createdAt" | "updatedAt"> & { id?: string };
export type WorkNodeInput = Omit<WorkNode, "id" | "progress" | "createdAt" | "updatedAt"> & { id?: string };
export type GovernanceInput = Omit<GovernanceRecord, "id" | "createdAt"> & { id?: string };

export const LLM_PROTOCOLS = ["openai-responses", "openai-chat", "anthropic-messages"] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];
export const LLM_REASONING_EFFORTS = ["none", "low", "high", "max"] as const;
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

export interface LlmProfile {
  id: string;
  name: string;
  provider: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel: string;
  enabled: boolean;
  reasoningEffort: LlmReasoningEffort;
  timeoutMs: number;
  credentialConfigured: boolean;
  credentialMasked: string;
  credentialSource: "stored" | "environment" | "missing";
  createdAt: string;
  updatedAt: string;
}

export type LlmProfileInput = Omit<LlmProfile, "id" | "reasoningEffort" | "credentialConfigured" | "credentialMasked" | "credentialSource" | "createdAt" | "updatedAt"> & {
  id?: string;
  apiKey?: string;
  reasoningEffort?: LlmReasoningEffort;
};

export interface LlmConnectionCheck {
  ok: boolean;
  status: "connected" | "missing_credential" | "request_failed";
  message: string;
  latencyMs: number;
  checkedAt: string;
}

export const AGENT_SESSION_STATUSES = ["idle", "running", "failed"] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

export const AGENT_CONTROL_MODES = ["restricted", "ask", "project-autonomous"] as const;
export type AgentControlMode = (typeof AGENT_CONTROL_MODES)[number];

export const AGENT_APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number];
export type AgentApprovalKind = "command" | "file-change";
export type AgentApprovalDecision = "approve_once" | "deny";

export const AGENT_MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

export const AGENT_MESSAGE_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AgentMessageStatus = (typeof AGENT_MESSAGE_STATUSES)[number];

export interface AgentWorkspace {
  id: string;
  projectId: string;
  defaultProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  projectId: string;
  profileId: string;
  model: string;
  codexThreadId: string | null;
  title: string;
  controlMode: AgentControlMode;
  status: AgentSessionStatus;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentApproval {
  id: string;
  projectId: string;
  sessionId: string;
  kind: AgentApprovalKind;
  title: string;
  summary: string;
  details: Record<string, unknown>;
  status: AgentApprovalStatus;
  decision: AgentApprovalDecision | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string;
}

export type AgentPageType = "dashboard" | "projects" | "project" | "canvas" | "node" | "database" | "document" | "plan" | "evidence" | "design" | "orchestration" | "governance" | "llm" | "audit" | "backups" | "unknown";

export type AgentEntityType = "project" | "diagram" | "diagramNode" | "diagramEdge" | "designDocument" | "databaseModel" | "databaseTable" | "nodeDatabaseBinding" | "plan" | "evidence" | "governance";

export const AGENT_ENTITY_REF_LABEL_MAX_LENGTH = 300;

export interface AgentEntityRef {
  type: AgentEntityType;
  id: string;
  parentId?: string;
  label?: string;
}

export interface AgentPageSelection {
  entityRefs: AgentEntityRef[];
}

export interface AgentPageDraft {
  dirty: boolean;
  baseRevision?: string;
  summary?: string;
}

export type AgentVisibleContentKind = "project" | "node" | "document" | "documentList" | "plan" | "planList" | "agentOrchestration" | "databaseModel" | "databaseModelList" | "databaseTable" | "evidenceList" | "governanceList";

export interface AgentVisibleContent {
  kind: AgentVisibleContentKind;
  title: string;
  text: string;
  truncated: boolean;
}

export interface AgentPageContext {
  contextId: string;
  projectId: string | null;
  route: string;
  title: string;
  pageType: AgentPageType;
  entityRefs: AgentEntityRef[];
  selection: AgentPageSelection;
  draft: AgentPageDraft | null;
  visibleContent: AgentVisibleContent | null;
  capturedAt: string;
}

export interface AgentStateSnapshotEvent {
  type: "STATE_SNAPSHOT";
  snapshot: AgentPageContext;
}

export interface AgentEntityChangedValue {
  projectId: string;
  entityType: "diagram" | "designDocument" | "databaseModel" | "nodeDatabaseBinding" | "plan" | "governance" | "evidence" | "project";
  entityId: string;
  changedEntityIds: string[];
  revision: string;
  source: "agent";
  sessionId: string;
}

export interface AgentEntityChangedEvent {
  type: "CUSTOM";
  name: "productdesign.entity.changed";
  value: AgentEntityChangedValue;
  timestamp: number;
}

export interface AgentApprovalChangedEvent {
  type: "CUSTOM";
  name: "productdesign.approval.changed";
  value: {
    projectId: string;
    sessionId: string;
    approval: AgentApproval;
  };
  timestamp: number;
}

export interface AgentNavigationRequestedValue {
  projectId: string;
  sessionId: string;
  contextId: string;
  diagramId: string;
  nodeId?: string;
  silent: true;
  source: "agent";
}

export interface AgentNavigationRequestedEvent {
  type: "CUSTOM";
  name: "productdesign.navigation.requested";
  value: AgentNavigationRequestedValue;
  timestamp: number;
}

export type AgentUiEvent = AgentEntityChangedEvent | AgentApprovalChangedEvent | AgentNavigationRequestedEvent;

export interface AgentMessage {
  id: string;
  sessionId: string;
  projectId: string;
  role: AgentMessageRole;
  content: string;
  status: AgentMessageStatus;
  pageContext: AgentPageContext | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkspaceSnapshot {
  workspace: AgentWorkspace;
  sessions: AgentSession[];
}

export interface AgentSendResponse {
  session: AgentSession;
  userMessage: AgentMessage;
  assistantMessage: AgentMessage;
}

export type AgentSessionInput = Pick<AgentSession, "projectId" | "profileId" | "model" | "title"> & { id?: string; controlMode?: AgentControlMode };
export type AgentMessageInput = Pick<AgentMessage, "sessionId" | "projectId" | "role" | "content" | "status" | "pageContext"> & { id?: string };

export interface Paginated<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface ProjectWorkspaceNode {
  diagramId: string;
  diagramTitle: string;
  diagramType: DiagramType;
  node: DiagramNode;
  deliveryRoleAssignments: PlanRoleAssignments | null;
}

export interface ProjectWorkspaceMetrics {
  functionalNodes: number;
  completedNodes: number;
  acceptedNodes: number;
  blockedNodes: number;
  pendingAcceptanceNodes: number;
  missingEvidenceNodes: number;
  plans: number;
  completedPlans: number;
  backlogPlans: number;
  documents: number;
  evidence: number;
}

export interface ProjectWorkspace {
  project: Project;
  mainDiagram: Diagram | null;
  diagrams: Array<Pick<Diagram, "id" | "projectId" | "title" | "type" | "createdAt" | "updatedAt"> & { nodeCount: number; edgeCount: number }>;
  metrics: ProjectWorkspaceMetrics;
  currentPlan: PlanItem | null;
  nextPlan: PlanItem | null;
}

export const DESIGN_DOC_STATUSES = ["草拟", "评审中", "已批准", "已废弃"] as const;
export type DesignDocStatus = (typeof DESIGN_DOC_STATUSES)[number];

export const DESIGN_DOC_CATEGORIES = ["需求文档", "功能说明", "接口文档", "测试报告", "验收文档", "其他"] as const;
export type DesignDocCategory = (typeof DESIGN_DOC_CATEGORIES)[number];

export const DOCUMENT_REFERENCE_TARGET_TYPES = ["project", "diagram", "diagramNode", "plan", "databaseModel", "evidence", "governance"] as const;
export type DocumentReferenceTargetType = (typeof DOCUMENT_REFERENCE_TARGET_TYPES)[number];

export const DOCUMENT_REFERENCE_RELATION_TYPES = ["defines", "implements", "verifies", "references"] as const;
export type DocumentReferenceRelationType = (typeof DOCUMENT_REFERENCE_RELATION_TYPES)[number];

export interface DesignDoc {
  id: string;
  projectId: string;
  currentRevisionId: string;
  category: DesignDocCategory;
  title: string;
  summary: string;
  status: DesignDocStatus;
  version: string;
  author: string;
  sourceUrl: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type DesignDocInput = Omit<DesignDoc, "id" | "currentRevisionId" | "createdAt" | "updatedAt" | "category" | "sourceUrl"> & {
  id?: string;
  category?: DesignDocCategory;
  sourceUrl?: string;
};

export interface DocumentRevision {
  id: string;
  projectId: string;
  documentId: string;
  category: DesignDocCategory;
  title: string;
  summary: string;
  status: DesignDocStatus;
  version: string;
  author: string;
  sourceUrl: string;
  content: string;
  createdAt: string;
}

export interface DocumentReference {
  id: string;
  projectId: string;
  documentId: string;
  documentRevisionId: string;
  targetType: DocumentReferenceTargetType;
  targetId: string;
  relationType: DocumentReferenceRelationType;
  createdAt: string;
}

export type DocumentReferenceInput = Omit<DocumentReference, "id" | "createdAt" | "documentRevisionId"> & {
  id?: string;
  documentRevisionId?: string;
};

export const DIAGRAM_NODE_KINDS = ["system", "module", "feature", "requirement", "interface", "data", "note"] as const;
export type DiagramNodeKind = (typeof DIAGRAM_NODE_KINDS)[number];

export const NODE_SHAPES = ["rect", "rounded", "ellipse", "diamond", "hexagon", "parallelogram", "cylinder", "predefined", "document", "actor", "boundary"] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

export const DIAGRAM_FLOW_NODE_TYPES = ["start", "end", "process", "decision", "input_output", "subprocess", "document"] as const;
export type DiagramFlowNodeType = (typeof DIAGRAM_FLOW_NODE_TYPES)[number];

export const DIAGRAM_USE_CASE_NODE_TYPES = ["actor", "usecase", "boundary"] as const;
export type DiagramUseCaseNodeType = (typeof DIAGRAM_USE_CASE_NODE_TYPES)[number];

export const DIAGRAM_USE_CASE_RELATION_TYPES = ["association", "include", "extend", "generalization"] as const;
export type DiagramUseCaseRelationType = (typeof DIAGRAM_USE_CASE_RELATION_TYPES)[number];

export const DIAGRAM_DEVELOPMENT_STATUSES = ["未开发", "开发中", "待验收", "已完成", "已阻塞"] as const;
export type DiagramDevelopmentStatus = (typeof DIAGRAM_DEVELOPMENT_STATUSES)[number];

export const DIAGRAM_ACCEPTANCE_STATUSES = ["未验收", "验收中", "已通过", "未通过"] as const;
export type DiagramAcceptanceStatus = (typeof DIAGRAM_ACCEPTANCE_STATUSES)[number];

export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  shape?: NodeShape;
  flowType?: DiagramFlowNodeType;
  useCaseType?: DiagramUseCaseNodeType;
  /** 关联的子画布（钻取），一个节点可关联多个不同视角的子画布。 */
  linkDiagramIds?: string[];
  description?: string;
  requirementStatus?: RequirementStatus;
  designStatus?: DesignStatus;
  requiresDatabase?: boolean;
  developmentStatus?: DiagramDevelopmentStatus;
  acceptanceStatus?: DiagramAcceptanceStatus;
  owner?: string;
  acceptanceCriteria?: string;
  notes?: string;
  blockedReason?: string;
  deliveryUpdatedAt?: string;
  preconditions?: string;
  mainFlow?: string;
  alternateFlow?: string;
  postconditions?: string;
}

export interface DiagramPoint {
  x: number;
  y: number;
}

export const DIAGRAM_PORTS = ["top", "right", "bottom", "left"] as const;
export type DiagramPort = (typeof DIAGRAM_PORTS)[number];

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  sourcePort?: DiagramPort;
  targetPort?: DiagramPort;
  label?: string;
  style?: "ortho" | "straight" | "curve";
  points?: DiagramPoint[];
  relationType?: DiagramUseCaseRelationType;
  color?: string;
  width?: number;
  dash?: "solid" | "dashed" | "dotted";
  arrow?: "end" | "both" | "none";
  labelPosition?: number;
  routingMode?: "auto" | "manual";
  jumpStyle?: "arc" | "gap" | "none";
  routeVersion?: 1;
}

export interface DiagramGroup {
  id: string;
  name: string;
  nodeIds: string[];
}

export const DIAGRAM_TYPES = ["main", "free", "functional", "flow", "deployment", "usecase"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export interface Diagram {
  id: string;
  projectId: string;
  title: string;
  type: DiagramType;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  /** 图层状态旁路载荷（见节点 whiteboard-layers-templates 设计 3.6）；缺省不写、读取时派生。 */
  layers?: DiagramLayerState;
  /** 组件库旁路载荷（见设计 4.1）；缺省不写、读取时派生。 */
  components?: DiagramComponentLibrary;
  createdAt: string;
  updatedAt: string;
}

// ---------- 图层（节点 whiteboard-layers-templates 设计 3.1） ----------

export const DIAGRAM_LAYER_SCHEMA_VERSION = 1 as const;
export const DIAGRAM_LAYER_KINDS = ["system", "custom"] as const;
export type DiagramLayerKind = (typeof DIAGRAM_LAYER_KINDS)[number];
export const DIAGRAM_LAYER_MEMBER_KINDS = ["node", "edge", "freeform", "mixed"] as const;
export type DiagramLayerMemberKind = (typeof DIAGRAM_LAYER_MEMBER_KINDS)[number];
export type DiagramLayerItemKind = "node" | "edge" | "freeform";

export interface DiagramLayer {
  id: string;
  name: string;
  kind: DiagramLayerKind;
  memberKind: DiagramLayerMemberKind;
  locked: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramItemOverride {
  locked?: boolean;
  hidden?: boolean;
  layerId?: string;
}

export interface DiagramLayerState {
  schemaVersion: typeof DIAGRAM_LAYER_SCHEMA_VERSION;
  layers: DiagramLayer[];
  itemOverrides: Record<string, DiagramItemOverride>;
}

// ---------- 组件（设计 4.1） ----------

export const DIAGRAM_COMPONENT_SCHEMA_VERSION = 1 as const;

/** 组件快照中的交付节点：已剥离全部交付状态字段。 */
export type DiagramComponentNode = Omit<DiagramNode,
  "requirementStatus" | "designStatus" | "developmentStatus" | "acceptanceStatus"
  | "owner" | "acceptanceCriteria" | "requiresDatabase" | "blockedReason" | "deliveryUpdatedAt">;

export interface DiagramComponentPayload {
  nodes: DiagramComponentNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  freeform: { elements: FreeformElement[] } | null;
  layers: { layers: DiagramLayer[]; itemOverrides: Record<string, DiagramItemOverride> } | null;
}

export interface DiagramComponentSourceSelection {
  nodeIds: string[];
  edgeIds: string[];
  freeformIds: string[];
}

export interface DiagramComponentDefinition {
  id: string;
  name: string;
  payload: DiagramComponentPayload;
  sourceSelection: DiagramComponentSourceSelection;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramComponentLibrary {
  schemaVersion: typeof DIAGRAM_COMPONENT_SCHEMA_VERSION;
  components: DiagramComponentDefinition[];
}

/** 实例自带溯源信息（写在 layers 辅助映射中，不建立运行时联动）。 */
export interface DiagramComponentInstanceLink {
  itemKey: string;
  sourceComponentId: string;
}

// ---------- 模板（设计 5.1） ----------

export const DIAGRAM_TEMPLATE_SCOPES = ["system", "project"] as const;
export type DiagramTemplateScope = (typeof DIAGRAM_TEMPLATE_SCOPES)[number];

/** 模板载荷契约版本。格式必须为设计 5.4 规定的 `whiteboard.template/<major>.<minor>`。 */
export const DIAGRAM_TEMPLATE_SCHEMA_VERSION = "whiteboard.template/1.0";

export interface DiagramTemplateThumbnailMeta {
  kind: "none" | "svg";
  width: number;
  height: number;
  viewBox: string;
  content?: string;
  generatedAt: string;
  source: "auto" | "custom";
}

export interface DiagramTemplateContent {
  schemaVersion: string;
  diagram: {
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    groups: DiagramGroup[];
    layers?: DiagramLayerState;
  };
  freeform?: { elements: FreeformElement[]; unsupported: FreeformUnknownElement[] };
  components?: DiagramComponentLibrary;
}

export interface DiagramTemplate {
  id: string;
  /** 系统内置模板为 null；项目级模板为所属项目 id。 */
  projectId: string | null;
  scope: DiagramTemplateScope;
  name: string;
  schemaVersion: string;
  content: DiagramTemplateContent;
  thumbnailMeta: DiagramTemplateThumbnailMeta;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

/** 列表投影：不回传 content，避免列表体积膨胀。 */
export type DiagramTemplateSummary = Omit<DiagramTemplate, "content"> & { contentBytes: number };

export type PrototypeKind = "text" | "button" | "input" | "card" | "image";
export interface PrototypeComponent {
  id: string;
  kind: PrototypeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  textColor?: string;
  fill?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  opacity?: number;
  fontSize?: number;
  imageUrl?: string;
  imageFit?: "contain" | "cover";
  hidden?: boolean;
  locked?: boolean;
}
export interface PrototypeScreen {
  id: string;
  name: string;
  width?: number;
  height?: number;
  background?: string;
  components: PrototypeComponent[];
}
export interface PrototypeDraft {
  version: 1;
  screens: PrototypeScreen[];
  updatedAt: string;
}
export interface PrototypeStored {
  current: PrototypeDraft;
  versions: PrototypeDraft[];
  updatedAt: string;
}

export const FREEFORM_ELEMENT_KINDS = ["text", "sticky", "rect", "ellipse", "arrow", "ink", "image"] as const;
export type FreeformElementKind = (typeof FREEFORM_ELEMENT_KINDS)[number];

export const FREEFORM_TONES = ["neutral", "info", "warn", "success"] as const;
export type FreeformTone = (typeof FREEFORM_TONES)[number];

export interface FreeformStyle {
  fill?: string;
  strokeColor?: string;
  strokeWidth?: number;
  borderRadius?: number;
  opacity?: number;
  textColor?: string;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  align?: "left" | "center" | "right";
}

/** 自由元素：只存在于自由层文档，永不写入 diagram.nodes。 */
export interface FreeformElement {
  id: string;
  kind: FreeformElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  groupId: string | null;
  style: FreeformStyle;
  locked: boolean;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  text?: string;
  autoHeight?: boolean;
  tone?: FreeformTone;
  cornerStyle?: "sharp" | "rounded";
  dx?: number;
  dy?: number;
  arrowStart?: "none" | "triangle";
  arrowEnd?: "none" | "triangle";
  lineStyle?: "solid" | "dashed" | "dotted";
  points?: Array<{ x: number; y: number }>;
  pressure?: number[];
  strokeWidth?: number;
  assetRef?: string;
  imageFit?: "contain" | "cover";
  alt?: string;
  sourceWidth?: number;
  sourceHeight?: number;
}

/** 未知 kind / 未知字段的历史元素，原样保留、不静默删除。 */
export interface FreeformUnknownElement {
  id: string;
  raw: Record<string, unknown>;
}

export interface FreeformDocument {
  schemaVersion: 1;
  diagramId: string;
  elements: FreeformElement[];
  unsupported: FreeformUnknownElement[];
  updatedAt: string;
}

export interface FreeformAsset {
  id: string;
  projectId: string;
  mime: string;
  sha256: string;
  byteSize: number;
  storagePath: string;
  width: number;
  height: number;
  createdAt: string;
}

export interface FreeformAssetSummary {
  id: string;
  mime: string;
  width: number;
  height: number;
  sha256: string;
}

export type DiagramInput = Omit<Diagram, "id" | "createdAt" | "updatedAt" | "type"> & { id?: string; type?: DiagramType };

export const PROJECT_WORKFLOW_PHASES = [
  "discovery",
  "functional-design",
  "node-definition",
  "requirement-review",
  "detailed-design",
  "planning",
  "development",
  "verification",
  "acceptance",
  "completed",
] as const;
export type ProjectWorkflowPhase = (typeof PROJECT_WORKFLOW_PHASES)[number];

export interface ProjectWorkflowAction {
  code: string;
  title: string;
  description: string;
  entityType: "project" | "document" | "diagram" | "node" | "plan" | "evidence" | "database";
  entityId: string | null;
  diagramId: string | null;
  nodeId: string | null;
  href: string;
}

export interface ProjectWorkflowNodeState {
  diagramId: string;
  diagramTitle: string;
  nodeId: string;
  nodeLabel: string;
  requirementStatus: RequirementStatus;
  designStatus: DesignStatus;
  developmentStatus: DiagramDevelopmentStatus;
  acceptanceStatus: DiagramAcceptanceStatus;
  requiresDatabase: boolean;
  approvedDocumentCount: number;
  databaseBindingCount: number;
  planCount: number;
  completedPlanCount: number;
  evidenceCount: number;
  deliveryLayer: number | null;
  layerLocked: boolean;
  layerLockReason: string;
  missing: string[];
  nextAction: ProjectWorkflowAction | null;
}

export interface PlanDeliveryLayerPlanState {
  planId: string;
  layer: number;
  complete: boolean;
  locked: boolean;
  lockReason: string;
}

export interface PlanDeliveryLayerGate {
  activeLayer: number | null;
  totalLayers: number;
  activePlanCount: number;
  lockedPlanCount: number;
  issues: string[];
  plans: PlanDeliveryLayerPlanState[];
}

export interface ProjectWorkflow {
  policyVersion: string;
  projectId: string;
  phase: ProjectWorkflowPhase;
  phaseLabel: string;
  status: "blocked" | "ready" | "completed";
  summary: string;
  missing: string[];
  nextAction: ProjectWorkflowAction | null;
  layerGate: PlanDeliveryLayerGate;
  nodes: ProjectWorkflowNodeState[];
  generatedAt: string;
}

export type AgentOrchestrationQueueKey = "design" | "development" | "audit" | "approval" | "managerApproval";
export type AgentDeliveryTrack = "design" | "implementation";
export type AgentAuditScope = AgentDeliveryTrack;

export const AGENT_TASK_LEASE_STATUSES = ["claimed", "running", "completed", "failed", "released", "expired"] as const;
export type AgentTaskLeaseStatus = (typeof AGENT_TASK_LEASE_STATUSES)[number];

export interface AgentTaskCapacity {
  projectId: string;
  maxActive: number;
  designerMaxActive: number;
  builderMaxActive: number;
  auditorMaxActive: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  updatedAt: string;
}

export interface AgentTaskLeaseSummary {
  available: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  released: number;
  expired: number;
  retrying: number;
  active: number;
  activeSlots: number;
  roleActive: Record<AgentBlueprintKey, number>;
  roleSlots: Record<AgentBlueprintKey, number>;
  lockedScopes: number;
  workspaceReservations: number;
}

export interface AgentWorkerPool {
  id: string;
  projectId: string;
  role: AgentBlueprintKey;
  name: string;
  maxActive: number;
  capabilities: string[];
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunnerRegistration {
  id: string;
  projectId: string;
  agentId: string;
  workerId: string;
  poolId: string;
  sessionId: string;
  role: AgentBlueprintKey;
  capabilities: string[];
  repositoryPath: string;
  workspacePath: string;
  status: "online" | "stale" | "offline";
  lastSeenAt: string;
  updatedAt: string;
}

export interface AgentTaskActiveLease {
  status: Extract<AgentTaskLeaseStatus, "claimed" | "running">;
  agentId: string;
  workerId: string;
  poolId: string;
  sessionId: string;
  runId: string;
  leaseExpiresAt: string;
  workScopes: string[];
  workspacePath: string;
}

/** Token-free lease record safe for human lease-management views. */
export interface AgentTaskLeaseRecord {
  approvalGroupId?: string;
  workOrderId: string;
  taskKey: string;
  taskId: string;
  taskRevision: string;
  projectId: string;
  queue: AgentExecutableQueueKey;
  role: AgentBlueprintKey;
  actionCode: string;
  status: AgentTaskLeaseStatus;
  agentId: string;
  workerId: string;
  poolId: string;
  sessionId: string;
  runId: string;
  leaseExpiresAt: string;
  attempt: number;
  resultDigest: string;
  lastError: string;
  claimedAt: string;
  startedAt: string;
  heartbeatAt: string;
  completedAt: string;
  retryAvailableAt: string;
  workScopes: string[];
  workspaceKey: string;
  workspaceRecommendedPath: string;
  workspacePath: string;
  workspaceBranch: string;
  baselineRevision: string;
  updatedAt: string;
}

export interface AgentOrchestrationTask {
  id: string;
  queue: AgentOrchestrationQueueKey;
  projectId: string;
  diagramId: string | null;
  nodeId: string | null;
  planItemId: string | null;
  correlationId: string;
  title: string;
  reason: string;
  priority: Priority;
  deliveryLayer: number | null;
  dueAt: string;
  createdAt: string;
  actionCode: string;
  deliveryTrack: AgentDeliveryTrack;
  auditScope: AgentAuditScope | null;
  /** 交付返工轮次，与租约重试次数 attempt 区分。 */
  deliveryAttempt: number;
  producerTaskKey: string | null;
  producerWorkerId: string | null;
  documentRevisionIds: string[];
  implementationRevision: string;
  supersedesEvidenceIds: string[];
  managerApprovalRequired: boolean;
  href: string;
  assignee: PlanRoleAssignment | null;
  poolId?: string;
  workScopes?: string[];
  designChangeIntent?: DesignChangeIntentTaskContext;
  available?: boolean;
  availabilityReason?: string;
  attempt?: number;
  retryAvailableAt?: string;
  activeLease?: AgentTaskActiveLease | null;
}

export interface AgentBlueprint {
  key: AgentBlueprintKey;
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries: string[];
  allowedMcpTools: string[];
  consumes: string[];
  produces: string[];
  completionConditions: string[];
  prompt: string;
}

export type AgentBlueprintKey = PlanAgentRole | "approver";

// Per-key, globally shared override of the default recommended-agent blueprint.
// Only the user-editable fields are persisted; prompt/consumes/produces/completionConditions stay on defaults.
export interface AgentBlueprintOverride {
  key: AgentBlueprintKey;
  name: string;
  purpose: string;
  responsibilities: string[];
  boundaries: string[];
  allowedMcpTools: string[];
  updatedAt: string;
}

export interface AgentHandoff {
  from: "designer" | "builder" | "auditor" | "manager";
  to: "designer" | "builder" | "auditor" | "manager";
  deliveryTrack: AgentDeliveryTrack;
  auditScope: AgentAuditScope | null;
  when: string;
  payload: string[];
}

export interface AgentOrchestration {
  schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
  generatedAt: string;
  /** 仅描述项目工作流规则；不要与 Agent 安全协议版本混用。 */
  workflowPolicyVersion: string;
  /** 仅描述 Agent 工单/写入安全协议版本。 */
  agentSecurityPolicyVersion: string;
  project: Project;
  workingDirectory: AgentWorkingDirectory;
  coordinationReadiness?: { ready: boolean; issue: string };
  workflow: ProjectWorkflow;
  recommendedAgents: AgentBlueprint[];
  queues: Record<AgentOrchestrationQueueKey, AgentOrchestrationTask[]>;
  queueCounts?: Record<AgentOrchestrationQueueKey, number>;
  capacity?: AgentTaskCapacity;
  leaseSummary?: AgentTaskLeaseSummary;
  runners?: AgentRunnerRegistration[];
  workerPools?: AgentWorkerPool[];
  coordination?: {
    leases: Array<Omit<AgentCoordinationLease, "leaseToken">>;
    childDispatches: AgentChildTaskDispatch[];
  };
  handoffs: AgentHandoff[];
  bootstrapPrompt: string;
}

export type AgentExecutableQueueKey = Exclude<AgentOrchestrationQueueKey, "managerApproval">;

/** Central Main Agent orchestration stages. A child can only be dispatched for the current stage. */
export const AGENT_COORDINATION_STAGES = [
  "design", "design_audit", "approval", "implementation", "implementation_audit", "acceptance", "completed",
] as const;
export type AgentCoordinationStage = (typeof AGENT_COORDINATION_STAGES)[number];
export type AgentCoordinationLeaseStatus = "active" | "paused" | "released" | "expired" | "completed";
export type AgentChildDispatchStatus = "dispatched" | "claimed" | "running" | "completed" | "reclaimed" | "reassigned";

export interface AgentCoordinationLease {
  id: string;
  projectId: string;
  /** Exactly one of planId or taskKey/taskRevision identifies the target. */
  planId: string;
  taskKey: string;
  taskRevision: string;
  mainAgentId: string;
  workerId: string;
  status: AgentCoordinationLeaseStatus;
  stage: AgentCoordinationStage;
  leaseToken: string;
  leaseExpiresAt: string;
  heartbeatAt: string;
  dispatchRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** Safe dispatch projection; child leaseToken is intentionally never part of this type. */
export interface AgentChildTaskDispatch {
  dispatchId: string;
  coordinationLeaseId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  taskRevision: string;
  stage: AgentCoordinationStage;
  role: Exclude<AgentBlueprintKey, "approver">;
  agentId: string;
  workerId: string;
  poolId: string;
  status: AgentChildDispatchStatus;
  dispatchVersion: number;
  childWorkOrderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkingDirectory {
  repositoryPath: string;
  configured: boolean;
  absolute: boolean;
  exists: boolean;
  directory: boolean;
  ready: boolean;
  issue: string;
}

/** 任务包内嵌的画布节点快照（含验收标准与流程字段）。 */
export interface AgentTaskPackageNode {
  diagramId: string;
  diagramTitle: string;
  nodeId: string;
  label: string;
  kind: string;
  description: string;
  requirementStatus: string;
  designStatus: string;
  developmentStatus: string;
  acceptanceStatus: string;
  acceptanceCriteria: string;
  notes: string;
  owner: string;
  preconditions: string;
  mainFlow: string;
  alternateFlow: string;
  postconditions: string;
  blockedReason: string;
}

/** 任务包内嵌的关联文档条目（按引用关系去重后的设计文档元数据）。 */
export interface AgentTaskPackageDocument {
  id: string;
  documentRevisionId: string;
  title: string;
  category: string;
  status: string;
  version: string;
  author: string;
  updatedAt: string;
  relationType: string;
  targetType: string;
  targetId: string;
  content: string;
  contentOffset: number;
  nextContentOffset: number | null;
  hasMore: boolean;
}

export interface AgentTaskPackage {
  schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
  packageId: string;
  generatedAt: string;
  deliveryTrack: AgentDeliveryTrack;
  auditScope: AgentAuditScope | null;
  attempt: number;
  producerTaskKey: string | null;
  producerWorkerId: string | null;
  documentRevisionIds: string[];
  implementationRevision: string;
  supersedesEvidenceIds: string[];
  managerApprovalRequired: boolean;
  /** @deprecated 兼容旧客户端；请使用 agentSecurityPolicyVersion。 */
  policyVersion: string;
  /** 项目工作流规则版本。 */
  workflowPolicyVersion: string;
  /** Agent 工单/写入安全协议版本。 */
  agentSecurityPolicyVersion: string;
  workOrderStatus: "unclaimed" | "claimed" | "running";
  requiredSubmissionFields: string[];
  project: Pick<Project, "id" | "code" | "name" | "repositoryPath">;
  workingDirectory: AgentWorkingDirectory;
  workflow: Pick<ProjectWorkflow, "phase" | "phaseLabel" | "status" | "summary" | "nextAction">;
  task: AgentOrchestrationTask & { role: AgentBlueprintKey };
  assignment: PlanRoleAssignment;
  worker: {
    agentId: string;
    workerId: string;
    poolId: string;
  };
  roleBlueprint: AgentBlueprint;
  /** 领取任务时的完整计划快照；无计划 design 任务为 null。 */
  planSnapshot: PlanItem | null;
  /** 当前画布节点快照（含验收标准）。 */
  node: AgentTaskPackageNode | null;
  /** 与该节点/计划关联的设计文档列表。 */
  documents: AgentTaskPackageDocument[];
  /** 当前计划直接依赖的计划快照。 */
  dependencies: PlanItem[];
  /** 当前节点已登记的数据库物理表绑定。 */
  databaseBindings: NodeDatabaseBinding[];
  /** 当前角色必须形成的证据字段和验收关联要求。 */
  evidenceRequirements: string[];
  lease?: {
    workOrderId: string;
    taskKey: string;
    taskRevision: string;
    status: Extract<AgentTaskLeaseStatus, "claimed" | "running">;
    leaseToken: string;
    agentId: string;
    workerId: string;
    poolId: string;
    sessionId: string;
    runId: string;
    leaseExpiresAt: string;
    heartbeatSeconds: number;
    requiredForAgentWrites: true;
    workScopes: string[];
    workspace: {
      key: string;
      recommendedPath: string;
      recommendedBranch: string;
      workspacePath: string;
      baselineRevision: string;
      manualPreparationRequired: true;
    };
  };
  launch: {
    manualStartRequired: true;
    workingDirectory: string;
    instructions: string[];
    prompt: string;
  };
  boundaries: string[];
  evidenceReturn: {
    requiredFields: string[];
    instructions: string[];
  };
  handoff: {
    correlationId: string;
    suggestedSessionId: string;
    suggestedRunId: string;
    nextStep: string;
  };
}

export interface StorageRetentionSummary {
  backups: { count: number; bytes: number; oldestAt: string; newestAt: string; overLimit: boolean };
  exports: { count: number; bytes: number; oldestAt: string; newestAt: string; overLimit: boolean };
  policy: { maxBackupCount: number; maxBackupBytes: number; maxBackupAgeDays: number; maxExportBytes: number };
}

export const DATABASE_DIALECTS = ["mysql", "postgresql", "sqlite"] as const;
export type DatabaseDialect = (typeof DATABASE_DIALECTS)[number];

export const DATABASE_DATA_TYPES = ["uuid", "string", "text", "integer", "bigint", "decimal", "boolean", "date", "time", "datetime", "json", "binary"] as const;
export type DatabaseDataType = (typeof DATABASE_DATA_TYPES)[number];

export const DATABASE_RELATION_TYPES = ["one-to-one", "one-to-many", "many-to-many"] as const;
export type DatabaseRelationType = (typeof DATABASE_RELATION_TYPES)[number];

export const DATABASE_CODE_TARGETS = ["java-jpa", "java-mybatis-plus", "typescript-typeorm", "csharp-ef-core", "go-gorm"] as const;
export type DatabaseCodeTarget = (typeof DATABASE_CODE_TARGETS)[number];

export interface DatabaseField {
  id: string;
  name: string;
  type: DatabaseDataType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  unique: boolean;
  defaultValue: string;
  comment: string;
}

export interface DatabaseIndex {
  id: string;
  name: string;
  fieldIds: string[];
  unique: boolean;
}

export interface DatabaseTable {
  id: string;
  name: string;
  displayName: string;
  comment: string;
  x: number;
  y: number;
  fields: DatabaseField[];
  indexes: DatabaseIndex[];
}

export interface DatabaseRelation {
  id: string;
  name: string;
  type: DatabaseRelationType;
  sourceTableId: string;
  sourceFieldId: string;
  targetTableId: string;
  targetFieldId: string;
  onDelete: "NO ACTION" | "CASCADE" | "SET NULL" | "RESTRICT";
}

export interface DatabaseModel {
  id: string;
  projectId: string;
  name: string;
  dialect: DatabaseDialect;
  tables: DatabaseTable[];
  relations: DatabaseRelation[];
  createdAt: string;
  updatedAt: string;
}

export type DatabaseModelInput = Omit<DatabaseModel, "id" | "createdAt" | "updatedAt"> & { id?: string };

export const NODE_DATABASE_OPERATIONS = ["read", "create", "update", "delete"] as const;
export type NodeDatabaseOperation = (typeof NODE_DATABASE_OPERATIONS)[number];

export interface NodeDatabaseBinding {
  id: string;
  projectId: string;
  diagramId: string;
  diagramNodeId: string;
  databaseModelId: string;
  schemaName: string;
  tableName: string;
  operations: NodeDatabaseOperation[];
  purpose: string;
  createdAt: string;
  updatedAt: string;
}

export type NodeDatabaseBindingInput = Omit<NodeDatabaseBinding, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface DatabaseModelIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  tableId?: string;
  fieldId?: string;
  relationId?: string;
}

export interface GeneratedCodeFile {
  name: string;
  language: string;
  code: string;
}

export interface DatabaseCodeResult {
  target: DatabaseCodeTarget | "ddl";
  files: GeneratedCodeFile[];
  issues: DatabaseModelIssue[];
}

/** 密码仅随当前请求传输，不持久化，也不应写入日志或审计记录。 */
export interface DatabaseConnectionInput {
  dialect: DatabaseDialect;
  filePath?: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export interface DatabaseSchemaSnapshot {
  dialect: DatabaseDialect;
  databaseName: string;
  tables: DatabaseTable[];
  relations: DatabaseRelation[];
}

export type DatabaseSchemaChangeKind = "add" | "remove" | "change";
export type DatabaseSchemaObjectKind = "table" | "field" | "index" | "relation";

export interface DatabaseSchemaChange {
  kind: DatabaseSchemaChangeKind;
  objectKind: DatabaseSchemaObjectKind;
  path: string;
  detail: string;
  destructive: boolean;
}

export interface DatabaseConnectionCheck {
  ok: boolean;
  target: string;
  dialect: DatabaseDialect;
  databaseName: string;
  tableCount: number;
}

export interface DatabaseReversePreview {
  target: string;
  snapshot: DatabaseSchemaSnapshot;
  changes: DatabaseSchemaChange[];
}

export interface DatabaseDeployPreview {
  target: string;
  ddl: string;
  statements: string[];
  changes: DatabaseSchemaChange[];
  createTableCount: number;
  canApply: boolean;
  blockingReasons: string[];
}

export interface DatabaseDeployResult {
  ok: boolean;
  target: string;
  executedStatements: number;
  executedAt: string;
}
