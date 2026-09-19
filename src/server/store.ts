import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AuditEvent,
  Backup,
  DashboardData,
  Evidence,
  GovernanceInput,
  GovernanceRecord,
  Paginated,
  PlanItem,
  PlanItemInput,
  Project,
  ProjectInput,
  WorkNode,
  WorkNodeInput
} from "../shared/types.js";
import { normalizeRoleAssignments } from "../shared/planRoles.js";

type Row = Record<string, unknown>;
type AuditSource = AuditEvent["source"];

const nowIso = (): string => new Date().toISOString();
const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");
const numberValue = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const nullableString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToProject(row: Row): Project {
  return {
    id: stringValue(row.id),
    code: stringValue(row.code),
    name: stringValue(row.name),
    summary: stringValue(row.summary),
    stage: stringValue(row.stage) as Project["stage"],
    health: stringValue(row.health) as Project["health"],
    progress: numberValue(row.progress),
    riskLevel: stringValue(row.risk_level) as Project["riskLevel"],
    riskSummary: stringValue(row.risk_summary),
    blockerSummary: stringValue(row.blocker_summary),
    nextStep: stringValue(row.next_step),
    repositoryPath: stringValue(row.repository_path),
    startAt: stringValue(row.start_at),
    dueAt: stringValue(row.due_at),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function rowToNode(row: Row): WorkNode {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    parentId: nullableString(row.parent_id),
    kind: stringValue(row.kind) as WorkNode["kind"],
    title: stringValue(row.title),
    description: stringValue(row.description),
    priority: stringValue(row.priority) as WorkNode["priority"],
    owner: stringValue(row.owner),
    requirementStatus: stringValue(row.requirement_status) as WorkNode["requirementStatus"],
    designStatus: stringValue(row.design_status) as WorkNode["designStatus"],
    developmentStatus: stringValue(row.development_status) as WorkNode["developmentStatus"],
    testStatus: stringValue(row.test_status) as WorkNode["testStatus"],
    progress: numberValue(row.progress),
    startAt: stringValue(row.start_at),
    dueAt: stringValue(row.due_at),
    position: numberValue(row.position),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function rowToPlanItem(row: Row): PlanItem {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    diagramId: nullableString(row.diagram_id),
    diagramNodeId: nullableString(row.diagram_node_id),
    parentId: nullableString(row.parent_id),
    kind: stringValue(row.kind) as PlanItem["kind"],
    title: stringValue(row.title),
    description: stringValue(row.description),
    status: stringValue(row.status) as PlanItem["status"],
    priority: stringValue(row.priority) as PlanItem["priority"],
    progress: numberValue(row.progress),
    owner: stringValue(row.owner),
    roleAssignments: normalizeRoleAssignments(parseJson(row.role_assignments, {})),
    versionTag: stringValue(row.version_tag),
    startAt: stringValue(row.start_at),
    dueAt: stringValue(row.due_at),
    dependencyIds: parseJson<string[]>(row.dependency_ids, []),
    blockedReason: stringValue(row.blocked_reason),
    completedAt: stringValue(row.completed_at),
    lifecycleStatus: (stringValue(row.lifecycle_status) || "legacy") as PlanItem["lifecycleStatus"],
    proposalRevision: numberValue(row.proposal_revision),
    designRevisionIds: parseJson<string[]>(row.design_revision_ids, []),
    proposedBy: stringValue(row.proposed_by), submittedAt: stringValue(row.submitted_at),
    approvedBy: stringValue(row.approved_by), approvedAt: stringValue(row.approved_at),
    rejectedBy: stringValue(row.rejected_by), rejectedAt: stringValue(row.rejected_at), rejectionReason: stringValue(row.rejection_reason),
    implementationRevision: stringValue(row.implementation_revision), completedBy: stringValue(row.completed_by),
    auditStatus: (stringValue(row.audit_status) || "not_requested") as PlanItem["auditStatus"],
    auditedBy: stringValue(row.audited_by), auditedAt: stringValue(row.audited_at),
    managerDecision: (stringValue(row.manager_decision) || "pending") as PlanItem["managerDecision"],
    managerDecisionBy: stringValue(row.manager_decision_by), managerDecisionAt: stringValue(row.manager_decision_at),
    reworkOfPlanId: nullableString(row.rework_of_plan_id), correlationId: stringValue(row.correlation_id) || stringValue(row.id),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at)
  };
}

function rowToEvidence(row: Row): Evidence {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    nodeId: nullableString(row.node_id),
    sourceType: stringValue(row.source_type) as Evidence["sourceType"],
    sourcePath: stringValue(row.source_path),
    command: stringValue(row.command),
    resultStatus: stringValue(row.result_status) as Evidence["resultStatus"],
    summary: stringValue(row.summary),
    details: parseJson<Record<string, unknown>>(row.details_json, {}),
    commitSha: stringValue(row.commit_sha),
    digest: stringValue(row.digest),
    planItemId: nullableString(row.plan_item_id),
    acceptanceCriterionKey: stringValue(row.acceptance_criterion_key),
    documentRevisionId: nullableString(row.document_revision_id),
    actorRole: (stringValue(row.actor_role) || null) as Evidence["actorRole"],
    agentId: stringValue(row.agent_id),
    sessionId: nullableString(row.session_id),
    runId: stringValue(row.run_id),
    supersedesEvidenceId: nullableString(row.supersedes_evidence_id),
    status: (stringValue(row.status) || "active") as Evidence["status"],
    revokedReason: stringValue(row.revoked_reason),
    revokedAt: stringValue(row.revoked_at),
    collectedAt: stringValue(row.collected_at)
  };
}

function rowToGovernance(row: Row): GovernanceRecord {
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    type: stringValue(row.type) as GovernanceRecord["type"],
    title: stringValue(row.title),
    content: stringValue(row.content),
    rationale: stringValue(row.rationale),
    status: stringValue(row.status) as GovernanceRecord["status"],
    author: stringValue(row.author),
    createdAt: stringValue(row.created_at)
  };
}

function rowToAudit(row: Row): AuditEvent {
  return {
    id: stringValue(row.id),
    projectId: nullableString(row.project_id),
    entityType: stringValue(row.entity_type),
    entityId: stringValue(row.entity_id),
    action: stringValue(row.action),
    before: parseJson<Record<string, unknown> | null>(row.before_json, null),
    after: parseJson<Record<string, unknown> | null>(row.after_json, null),
    actor: stringValue(row.actor),
    source: stringValue(row.source) as AuditEvent["source"],
    createdAt: stringValue(row.created_at)
  };
}

function rowToBackup(row: Row): Backup {
  return {
    id: stringValue(row.id),
    label: stringValue(row.label),
    reason: stringValue(row.reason),
    itemCount: numberValue(row.item_count),
    createdAt: stringValue(row.created_at)
  };
}

const requirementWeights: Record<string, number> = {
  "待整理": 0,
  "草拟中": 30,
  "待评审": 70,
  "已批准": 100,
  "已拒绝": 0
};
const designWeights: Record<string, number> = { "未开始": 0, "进行中": 50, "待评审": 80, "已批准": 100, "不适用": 100 };
const developmentWeights: Record<string, number> = { "未开始": 0, "进行中": 50, "待评审": 80, "已完成": 100, "已阻塞": 30, "不适用": 100 };
const testWeights: Record<string, number> = { "未开始": 0, "进行中": 50, "已通过": 100, "未通过": 60, "已阻塞": 30, "不适用": 100 };

function nodeProgress(node: Pick<WorkNode, "requirementStatus" | "designStatus" | "developmentStatus" | "testStatus">): number {
  return Math.round(
    ((requirementWeights[node.requirementStatus] ?? 0) +
      (designWeights[node.designStatus] ?? 0) +
      (developmentWeights[node.developmentStatus] ?? 0) +
      (testWeights[node.testStatus] ?? 0)) /
      4
  );
}

export interface EvidenceInsert {
  projectId: string;
  nodeId?: string | null;
  sourceType: Evidence["sourceType"];
  sourcePath: string;
  command: string;
  resultStatus: Evidence["resultStatus"];
  summary: string;
  details: Record<string, unknown>;
  commitSha?: string;
}

export class ProjectStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seed();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL,
        health TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL,
        risk_summary TEXT NOT NULL DEFAULT '',
        blocker_summary TEXT NOT NULL DEFAULT '',
        next_step TEXT NOT NULL DEFAULT '',
        repository_path TEXT NOT NULL DEFAULT '',
        start_at TEXT NOT NULL DEFAULT '',
        due_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        requirement_status TEXT NOT NULL,
        design_status TEXT NOT NULL,
        development_status TEXT NOT NULL,
        test_status TEXT NOT NULL,
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
        parent_id TEXT REFERENCES plan_items(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL DEFAULT '',
        version_tag TEXT NOT NULL DEFAULT '',
        start_at TEXT NOT NULL DEFAULT '',
        due_at TEXT NOT NULL DEFAULT '',
        dependency_ids TEXT NOT NULL DEFAULT '[]',
        blocked_reason TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
        source_type TEXT NOT NULL,
        source_path TEXT NOT NULL DEFAULT '',
        command TEXT NOT NULL DEFAULT '',
        result_status TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        commit_sha TEXT NOT NULL DEFAULT '',
        digest TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS governance_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        rationale TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        before_json TEXT,
        after_json TEXT,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id, position);
      CREATE INDEX IF NOT EXISTS idx_plan_project ON plan_items(project_id, start_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id, collected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_events(project_id, created_at DESC);
    `);
    const planColumns = new Set((this.db.prepare("PRAGMA table_info(plan_items)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!planColumns.has("diagram_id")) this.db.exec("ALTER TABLE plan_items ADD COLUMN diagram_id TEXT");
    if (!planColumns.has("diagram_node_id")) this.db.exec("ALTER TABLE plan_items ADD COLUMN diagram_node_id TEXT");
    if (!planColumns.has("blocked_reason")) this.db.exec("ALTER TABLE plan_items ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT ''");
    if (!planColumns.has("completed_at")) this.db.exec("ALTER TABLE plan_items ADD COLUMN completed_at TEXT NOT NULL DEFAULT ''");
  }

  private seed(): void {
    const count = numberValue((this.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as Row).count);
    if (count > 0) return;

    const project = this.createProject(
      {
        id: "project-atlas",
        code: "ATLAS",
        name: "研发治理控制台",
        summary: "以功能树为主轴，连接规划、四套状态、测试证据与决策历史。",
        stage: "开发",
        health: "关注",
        riskLevel: "P1",
        riskSummary: "证据采集必须持续保持仓库零写入。",
        blockerSummary: "尚未配置真实受管仓库路径。",
        nextStep: "配置首个仓库并完成只读证据采集。",
        repositoryPath: "",
        startAt: "2026-08-25",
        dueAt: "2026-10-15"
      },
      "system",
      "system"
    );

    const nodes: WorkNodeInput[] = [
      {
        id: "node-control",
        projectId: project.id,
        parentId: null,
        kind: "module",
        title: "项目控制面",
        description: "总览、风险、阻塞与下一步。",
        priority: "P0",
        owner: "产品负责人",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "进行中",
        testStatus: "未开始",
        startAt: "2026-08-25",
        dueAt: "2026-09-10",
        position: 10
      },
      {
        id: "node-overview",
        projectId: project.id,
        parentId: "node-control",
        kind: "feature",
        title: "全项目健康总览",
        description: "统一展示阶段、进度、风险、阻塞和下一步。",
        priority: "P0",
        owner: "前端",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "已完成",
        testStatus: "进行中",
        startAt: "2026-08-25",
        dueAt: "2026-09-01",
        position: 11
      },
      {
        id: "node-status",
        projectId: project.id,
        parentId: "node-control",
        kind: "requirement",
        title: "四轨独立状态",
        description: "需求、设计、开发、测试状态分别维护，进度只做派生计算。",
        priority: "P0",
        owner: "领域设计",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "进行中",
        testStatus: "未开始",
        startAt: "2026-08-26",
        dueAt: "2026-09-03",
        position: 12
      },
      {
        id: "node-planning",
        projectId: project.id,
        parentId: null,
        kind: "module",
        title: "规划与执行",
        description: "目标、里程碑、版本、任务、依赖、优先级。",
        priority: "P0",
        owner: "项目经理",
        requirementStatus: "已批准",
        designStatus: "进行中",
        developmentStatus: "进行中",
        testStatus: "未开始",
        startAt: "2026-08-26",
        dueAt: "2026-09-20",
        position: 20
      },
      {
        id: "node-tree",
        projectId: project.id,
        parentId: "node-planning",
        kind: "feature",
        title: "端到端功能树",
        description: "项目到证据的可追踪结构。",
        priority: "P0",
        owner: "全栈",
        requirementStatus: "已批准",
        designStatus: "待评审",
        developmentStatus: "进行中",
        testStatus: "未开始",
        startAt: "2026-08-27",
        dueAt: "2026-09-08",
        position: 21
      },
      {
        id: "node-board",
        projectId: project.id,
        parentId: "node-planning",
        kind: "development",
        title: "看板与时间线",
        description: "以同一计划数据投影不同执行视图。",
        priority: "P1",
        owner: "前端",
        requirementStatus: "已批准",
        designStatus: "进行中",
        developmentStatus: "未开始",
        testStatus: "未开始",
        startAt: "2026-09-02",
        dueAt: "2026-09-15",
        position: 22
      },
      {
        id: "node-evidence",
        projectId: project.id,
        parentId: null,
        kind: "module",
        title: "证据与治理",
        description: "只读采集、决策记录、变更历史与恢复。",
        priority: "P0",
        owner: "平台工程",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "进行中",
        testStatus: "进行中",
        startAt: "2026-08-26",
        dueAt: "2026-09-25",
        position: 30
      },
      {
        id: "node-collector",
        projectId: project.id,
        parentId: "node-evidence",
        kind: "test",
        title: "只读证据采集",
        description: "读取 Git 和既有测试报告，禁止执行会写仓库的任务。",
        priority: "P0",
        owner: "测试平台",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "进行中",
        testStatus: "进行中",
        startAt: "2026-08-26",
        dueAt: "2026-09-05",
        position: 31
      },
      {
        id: "node-mcp",
        projectId: project.id,
        parentId: "node-evidence",
        kind: "development",
        title: "项目管理 MCP",
        description: "仅写管理库；受管代码仓库始终只读。",
        priority: "P1",
        owner: "平台工程",
        requirementStatus: "已批准",
        designStatus: "已批准",
        developmentStatus: "进行中",
        testStatus: "未开始",
        startAt: "2026-08-28",
        dueAt: "2026-09-12",
        position: 32
      }
    ];
    for (const node of nodes) this.createNode(node, "system", "system");

    const plans: PlanItemInput[] = [
      {
        id: "plan-goal",
        projectId: project.id,
        parentId: null,
        kind: "goal",
        title: "建立可验证的研发单一事实源",
        description: "任何进度结论都能回到状态、证据或人工决策。",
        status: "进行中",
        priority: "P0",
        progress: 44,
        owner: "产品负责人",
        versionTag: "V1",
        startAt: "2026-08-25",
        dueAt: "2026-10-15",
        dependencyIds: []
      },
      {
        id: "plan-m1",
        projectId: project.id,
        parentId: "plan-goal",
        kind: "milestone",
        title: "控制面闭环",
        description: "总览、规划、功能树、看板和时间线可用。",
        status: "进行中",
        priority: "P0",
        progress: 58,
        owner: "交付小组",
        versionTag: "0.1.0",
        startAt: "2026-08-25",
        dueAt: "2026-09-15",
        dependencyIds: []
      },
      {
        id: "plan-m2",
        projectId: project.id,
        parentId: "plan-goal",
        kind: "milestone",
        title: "可信证据与治理闭环",
        description: "采集、审计、备份恢复和 MCP 接入完成。",
        status: "未开始",
        priority: "P0",
        progress: 20,
        owner: "平台工程",
        versionTag: "0.1.0",
        startAt: "2026-09-05",
        dueAt: "2026-09-25",
        dependencyIds: ["plan-m1"]
      },
      {
        id: "plan-v1",
        projectId: project.id,
        parentId: "plan-goal",
        kind: "version",
        title: "第一版可验收发布",
        description: "所有范围均有真实交互和可追踪数据。",
        status: "未开始",
        priority: "P0",
        progress: 16,
        owner: "发布负责人",
        versionTag: "0.1.0",
        startAt: "2026-09-20",
        dueAt: "2026-10-15",
        dependencyIds: ["plan-m1", "plan-m2"]
      },
      {
        id: "plan-task-repo",
        projectId: project.id,
        parentId: "plan-m2",
        kind: "task",
        title: "配置真实受管仓库",
        description: "设置仓库路径并验证零写入采集。",
        status: "已阻塞",
        priority: "P1",
        progress: 10,
        owner: "管理员",
        versionTag: "0.1.0",
        startAt: "2026-08-29",
        dueAt: "2026-09-04",
        dependencyIds: []
      }
    ];
    for (const item of plans) this.createPlanItem(item, "system", "system");

    this.addGovernance(
      {
        id: "decision-architecture",
        projectId: project.id,
        type: "decision",
        title: "采用本地 Web 模块化单体",
        content: "React 工作台、Node API、SQLite 管理库与本地 stdio MCP 共享领域模型。",
        rationale: "优先保证功能闭环、证据可信度和可恢复性，暂不承担桌面打包与复杂认证成本。",
        status: "有效",
        author: "产品负责人"
      },
      "system",
      "system"
    );

    this.addEvidence(
      {
        projectId: project.id,
        nodeId: "node-evidence",
        sourceType: "manual",
        sourcePath: "设计审批",
        command: "none",
        resultStatus: "pass",
        summary: "仓库只读、管理库可写的安全边界已批准。",
        details: { decision: "本地 Web 模块化单体", repositoryPolicy: "read-only", managementDatabase: "read-write" }
      },
      "system",
      "system"
    );
    this.createBackup("初始基线", "第一版示例数据与架构决策", "system", "system");
  }

  private audit(
    projectId: string | null,
    entityType: string,
    entityId: string,
    action: string,
    before: unknown,
    after: unknown,
    actor: string,
    source: AuditSource
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (id, project_id, entity_type, entity_id, action, before_json, after_json, actor, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        projectId,
        entityType,
        entityId,
        action,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        actor,
        source,
        nowIso()
      );
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY health DESC, updated_at DESC").all() as Row[]).map(rowToProject);
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  createProject(input: ProjectInput, actor = "local-user", source: AuditSource = "web"): Project {
    const timestamp = nowIso();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO projects
          (id, code, name, summary, stage, health, progress, risk_level, risk_summary, blocker_summary, next_step,
           repository_path, start_at, due_at, created_at, updated_at)
         VALUES (@id, @code, @name, @summary, @stage, @health, 0, @riskLevel, @riskSummary, @blockerSummary,
           @nextStep, @repositoryPath, @startAt, @dueAt, @createdAt, @updatedAt)`
      )
      .run({ ...input, id, createdAt: timestamp, updatedAt: timestamp });
    const project = this.getProject(id);
    if (!project) throw new Error("项目创建后无法读取。");
    this.audit(id, "project", id, "created", null, project, actor, source);
    return project;
  }

  updateProject(id: string, patch: Partial<ProjectInput>, actor = "local-user", source: AuditSource = "web"): Project {
    const before = this.getProject(id);
    if (!before) throw new Error(`项目 ${id} 不存在。`);
    const next = { ...before, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE projects SET code=@code, name=@name, summary=@summary, stage=@stage, health=@health,
          risk_level=@riskLevel, risk_summary=@riskSummary, blocker_summary=@blockerSummary, next_step=@nextStep,
          repository_path=@repositoryPath, start_at=@startAt, due_at=@dueAt, updated_at=@updatedAt WHERE id=@id`
      )
      .run(next);
    const after = this.getProject(id);
    if (!after) throw new Error("项目更新后无法读取。");
    this.audit(id, "project", id, "updated", before, after, actor, source);
    return after;
  }

  listNodes(projectId?: string): WorkNode[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM nodes WHERE project_id = ? ORDER BY position, created_at").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM nodes ORDER BY project_id, position, created_at").all() as Row[]);
    return rows.map(rowToNode);
  }

  getNode(id: string): WorkNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToNode(row) : null;
  }

  createNode(input: WorkNodeInput, actor = "local-user", source: AuditSource = "web"): WorkNode {
    if (!this.getProject(input.projectId)) throw new Error(`项目 ${input.projectId} 不存在。`);
    if (input.parentId && !this.getNode(input.parentId)) throw new Error(`父节点 ${input.parentId} 不存在。`);
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    const progress = nodeProgress(input);
    this.db
      .prepare(
        `INSERT INTO nodes
          (id, project_id, parent_id, kind, title, description, priority, owner, requirement_status, design_status,
           development_status, test_status, progress, start_at, due_at, position, created_at, updated_at)
         VALUES (@id, @projectId, @parentId, @kind, @title, @description, @priority, @owner, @requirementStatus,
           @designStatus, @developmentStatus, @testStatus, @progress, @startAt, @dueAt, @position, @createdAt, @updatedAt)`
      )
      .run({ ...input, id, progress, createdAt: timestamp, updatedAt: timestamp });
    const node = this.getNode(id);
    if (!node) throw new Error("节点创建后无法读取。");
    this.recalculateProjectProgress(node.projectId);
    this.audit(node.projectId, "node", id, "created", null, node, actor, source);
    return node;
  }

  updateNode(id: string, patch: Partial<WorkNodeInput>, actor = "local-user", source: AuditSource = "web"): WorkNode {
    const before = this.getNode(id);
    if (!before) throw new Error(`节点 ${id} 不存在。`);
    const next = { ...before, ...patch, id, updatedAt: nowIso() };
    if (next.parentId && !this.getNode(next.parentId)) throw new Error(`父节点 ${next.parentId} 不存在。`);
    const progress = nodeProgress(next);
    this.db
      .prepare(
        `UPDATE nodes SET project_id=@projectId, parent_id=@parentId, kind=@kind, title=@title, description=@description,
          priority=@priority, owner=@owner, requirement_status=@requirementStatus, design_status=@designStatus,
          development_status=@developmentStatus, test_status=@testStatus, progress=@progress, start_at=@startAt,
          due_at=@dueAt, position=@position, updated_at=@updatedAt WHERE id=@id`
      )
      .run({ ...next, progress });
    const after = this.getNode(id);
    if (!after) throw new Error("节点更新后无法读取。");
    this.recalculateProjectProgress(after.projectId);
    this.audit(after.projectId, "node", id, "updated", before, after, actor, source);
    return after;
  }

  private recalculateProjectProgress(projectId: string): void {
    const rows = this.db
      .prepare("SELECT progress FROM nodes WHERE project_id = ? AND kind NOT IN ('module')")
      .all(projectId) as Row[];
    const progress = rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + numberValue(row.progress), 0) / rows.length);
    this.db.prepare("UPDATE projects SET progress = ?, updated_at = ? WHERE id = ?").run(progress, nowIso(), projectId);
  }

  listPlanItems(projectId?: string): PlanItem[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM plan_items WHERE project_id = ? ORDER BY start_at, created_at").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM plan_items ORDER BY project_id, start_at, created_at").all() as Row[]);
    return rows.map(rowToPlanItem);
  }

  getPlanItem(id: string): PlanItem | null {
    const row = this.db.prepare("SELECT * FROM plan_items WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToPlanItem(row) : null;
  }

  createPlanItem(input: PlanItemInput, actor = "local-user", source: AuditSource = "web"): PlanItem {
    if (!this.getProject(input.projectId)) throw new Error(`项目 ${input.projectId} 不存在。`);
    const id = input.id ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO plan_items
          (id, project_id, diagram_id, diagram_node_id, parent_id, kind, title, description, status, priority, progress, owner, version_tag,
           start_at, due_at, dependency_ids, blocked_reason, completed_at, created_at, updated_at)
         VALUES (@id, @projectId, @diagramId, @diagramNodeId, @parentId, @kind, @title, @description, @status, @priority, @progress, @owner,
           @versionTag, @startAt, @dueAt, @dependencyIdsJson, @blockedReason, @completedAt, @createdAt, @updatedAt)`
      )
      .run({
        ...input,
        id,
        diagramId: input.diagramId ?? null,
        diagramNodeId: input.diagramNodeId ?? null,
        blockedReason: input.blockedReason ?? "",
        completedAt: input.completedAt ?? "",
        dependencyIdsJson: JSON.stringify(input.dependencyIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    const item = this.getPlanItem(id);
    if (!item) throw new Error("计划项创建后无法读取。");
    this.audit(item.projectId, "plan_item", id, "created", null, item, actor, source);
    return item;
  }

  updatePlanItem(id: string, patch: Partial<PlanItemInput>, actor = "local-user", source: AuditSource = "web"): PlanItem {
    const before = this.getPlanItem(id);
    if (!before) throw new Error(`计划项 ${id} 不存在。`);
    const next = { ...before, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE plan_items SET project_id=@projectId, parent_id=@parentId, kind=@kind, title=@title,
          description=@description, status=@status, priority=@priority, progress=@progress, owner=@owner,
          version_tag=@versionTag, start_at=@startAt, due_at=@dueAt, dependency_ids=@dependencyIdsJson,
          diagram_id=@diagramId, diagram_node_id=@diagramNodeId, blocked_reason=@blockedReason,
          completed_at=@completedAt, updated_at=@updatedAt WHERE id=@id`
      )
      .run({ ...next, dependencyIdsJson: JSON.stringify(next.dependencyIds) });
    const after = this.getPlanItem(id);
    if (!after) throw new Error("计划项更新后无法读取。");
    this.audit(after.projectId, "plan_item", id, "updated", before, after, actor, source);
    return after;
  }

  listEvidence(projectId?: string, nodeId?: string, limit = 100, offset = 0): Paginated<Evidence> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      where.push("project_id = ?");
      params.push(projectId);
    }
    if (nodeId) {
      where.push("node_id = ?");
      params.push(nodeId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = numberValue((this.db.prepare(`SELECT COUNT(*) AS count FROM evidence ${clause}`).get(...params) as Row).count);
    const rows = this.db
      .prepare(`SELECT * FROM evidence ${clause} ORDER BY collected_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    const items = rows.map(rowToEvidence);
    return {
      total,
      count: items.length,
      offset,
      items,
      hasMore: offset + items.length < total,
      nextOffset: offset + items.length < total ? offset + items.length : null
    };
  }

  addEvidence(input: EvidenceInsert, actor = "collector", source: AuditSource = "system"): Evidence {
    const id = randomUUID();
    const collectedAt = nowIso();
    const detailsJson = JSON.stringify(input.details);
    const digest = createHash("sha256")
      .update([input.projectId, input.nodeId ?? "", input.sourceType, input.sourcePath, input.summary, detailsJson, collectedAt].join("\n"))
      .digest("hex");
    this.db
      .prepare(
        `INSERT INTO evidence
          (id, project_id, node_id, source_type, source_path, command, result_status, summary, details_json,
           commit_sha, digest, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.projectId,
        input.nodeId ?? null,
        input.sourceType,
        input.sourcePath,
        input.command,
        input.resultStatus,
        input.summary,
        detailsJson,
        input.commitSha ?? "",
        digest,
        collectedAt
      );
    const evidence = rowToEvidence(this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as Row);
    this.audit(input.projectId, "evidence", id, "collected", null, evidence, actor, source);
    return evidence;
  }

  listGovernance(projectId?: string): GovernanceRecord[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM governance_records WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM governance_records ORDER BY created_at DESC").all() as Row[]);
    return rows.map(rowToGovernance);
  }

  addGovernance(input: GovernanceInput, actor = "local-user", source: AuditSource = "web"): GovernanceRecord {
    const id = input.id ?? randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO governance_records
          (id, project_id, type, title, content, rationale, status, author, created_at)
         VALUES (@id, @projectId, @type, @title, @content, @rationale, @status, @author, @createdAt)`
      )
      .run({ ...input, id, createdAt });
    const record = rowToGovernance(this.db.prepare("SELECT * FROM governance_records WHERE id = ?").get(id) as Row);
    this.audit(input.projectId, "governance", id, "created", null, record, actor, source);
    return record;
  }

  listAudit(projectId?: string, limit = 100): AuditEvent[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as Row[])
      : (this.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
    return rows.map(rowToAudit);
  }

  listBackups(): Backup[] {
    return (this.db.prepare("SELECT id, label, reason, item_count, created_at FROM backups ORDER BY created_at DESC").all() as Row[]).map(rowToBackup);
  }

  createBackup(label: string, reason: string, actor = "local-user", source: AuditSource = "web"): Backup {
    const tables = ["projects", "nodes", "plan_items", "evidence", "governance_records"] as const;
    const snapshot: Record<string, Row[]> = {};
    let itemCount = 0;
    for (const table of tables) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
      snapshot[table] = rows;
      itemCount += rows.length;
    }
    const backup: Backup = { id: randomUUID(), label, reason, itemCount, createdAt: nowIso() };
    this.db
      .prepare("INSERT INTO backups (id, label, reason, payload_json, item_count, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(backup.id, label, reason, JSON.stringify(snapshot), itemCount, backup.createdAt);
    this.audit(null, "backup", backup.id, "created", null, backup, actor, source);
    return backup;
  }

  restoreBackup(id: string, confirmation: string, actor = "local-user", source: AuditSource = "web"): Backup {
    if (confirmation !== `RESTORE ${id}`) throw new Error(`恢复确认无效，请使用 RESTORE ${id}。`);
    const row = this.db.prepare("SELECT * FROM backups WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`备份 ${id} 不存在。`);
    const selected = rowToBackup(row);
    const payload = parseJson<Record<string, Row[]>>(row.payload_json, {});
    for (const table of ["projects", "nodes", "plan_items", "evidence", "governance_records"]) {
      if (!Array.isArray(payload[table])) throw new Error(`备份缺少 ${table} 数据。`);
    }
    this.createBackup(`恢复点 ${new Date().toLocaleString("zh-CN")}`, `恢复 ${selected.label} 前自动创建`, actor, source);

    const restore = this.db.transaction(() => {
      this.db.exec("DELETE FROM evidence; DELETE FROM governance_records; DELETE FROM plan_items; DELETE FROM nodes; DELETE FROM projects;");
      const statements: Record<string, Database.Statement> = {
        projects: this.db.prepare(`INSERT INTO projects
          (id, code, name, summary, stage, health, progress, risk_level, risk_summary, blocker_summary, next_step, repository_path,
           start_at, due_at, created_at, updated_at)
          VALUES (@id, @code, @name, @summary, @stage, @health, @progress, @risk_level, @risk_summary, @blocker_summary,
           @next_step, @repository_path, @start_at, @due_at, @created_at, @updated_at)`),
        nodes: this.db.prepare(`INSERT INTO nodes
          (id, project_id, parent_id, kind, title, description, priority, owner, requirement_status, design_status,
           development_status, test_status, progress, start_at, due_at, position, created_at, updated_at)
          VALUES (@id, @project_id, @parent_id, @kind, @title, @description, @priority, @owner, @requirement_status,
           @design_status, @development_status, @test_status, @progress, @start_at, @due_at, @position, @created_at, @updated_at)`),
        plan_items: this.db.prepare(`INSERT INTO plan_items
          (id, project_id, diagram_id, diagram_node_id, parent_id, kind, title, description, status, priority, progress, owner, version_tag, start_at,
           due_at, dependency_ids, blocked_reason, completed_at, created_at, updated_at)
          VALUES (@id, @project_id, @diagram_id, @diagram_node_id, @parent_id, @kind, @title, @description, @status, @priority, @progress, @owner,
           @version_tag, @start_at, @due_at, @dependency_ids, @blocked_reason, @completed_at, @created_at, @updated_at)`),
        evidence: this.db.prepare(`INSERT INTO evidence
          (id, project_id, node_id, source_type, source_path, command, result_status, summary, details_json, commit_sha,
           digest, collected_at)
          VALUES (@id, @project_id, @node_id, @source_type, @source_path, @command, @result_status, @summary,
           @details_json, @commit_sha, @digest, @collected_at)`),
        governance_records: this.db.prepare(`INSERT INTO governance_records
          (id, project_id, type, title, content, rationale, status, author, created_at)
          VALUES (@id, @project_id, @type, @title, @content, @rationale, @status, @author, @created_at)`)
      };
      for (const table of ["projects", "nodes", "plan_items", "evidence", "governance_records"]) {
        for (const item of payload[table]) {
          statements[table].run(table === "plan_items" ? {
            ...item,
            diagram_id: item.diagram_id ?? null,
            diagram_node_id: item.diagram_node_id ?? null,
            blocked_reason: item.blocked_reason ?? "",
            completed_at: item.completed_at ?? "",
          } : item);
        }
      }
    });
    restore();
    this.audit(null, "backup", id, "restored", null, selected, actor, source);
    return selected;
  }

  dashboard(): DashboardData {
    return {
      projects: this.listProjects(),
      nodes: this.listNodes(),
      planItems: this.listPlanItems(),
      evidence: this.listEvidence(undefined, undefined, 100, 0).items,
      governance: this.listGovernance(),
      audit: this.listAudit(undefined, 100),
      backups: this.listBackups(),
      generatedAt: nowIso()
    };
  }
}

export function resolveDatabasePath(): string {
  const configured = process.env.PRODUCTDESIGN_DB_PATH;
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "data", "product-design.db");
}
