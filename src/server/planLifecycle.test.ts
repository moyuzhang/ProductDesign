import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, nowIso } from "./db.js";
import { transitionPlanLifecycle } from "./planLifecycle.js";

const resources: Array<{ store: Store; dir: string }> = [];
const roleAssignments = {
  designer: { agentId: "designer-id", displayName: "designer" },
  builder: { agentId: "builder-id", displayName: "builder" },
  auditor: { agentId: "auditor-id", displayName: "auditor" },
};

function bindApprovedDesign(store: Store, projectId: string, planId: string, suffix: string): string {
  const document = store.insertDesignDoc({
    projectId, category: "功能说明", title: `批准设计-${suffix}`, summary: "固定设计基线",
    status: "已批准", version: "1.0", author: "designer", content: `设计正文-${suffix}`,
  });
  store.insertDocumentReference({
    projectId, documentId: document.id, targetType: "plan", targetId: planId, relationType: "defines",
  });
  return document.currentRevisionId;
}

function passDesignAudit(store: Store, projectId: string, planId: string, documentRevisionId: string): void {
  store.insertEvidence({
    projectId, nodeId: store.getPlan(planId)?.diagramNodeId ?? null, planItemId: planId, sourceType: "manual", sourcePath: "design-audit.json", command: "review design",
    resultStatus: "pass", summary: "设计审计通过", details: { auditScope: "design" }, commitSha: "", digest: "design-audit",
    collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id", documentRevisionId,
  });
  transitionPlanLifecycle(store, planId, { action: "pass_design_audit", actor: "auditor", agentId: "auditor-id" });
}

afterEach(() => {
  for (const { store, dir } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plan lifecycle", () => {
  it("freezes an explicitly referenced review revision for independent design audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-review-baseline-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "REVIEW-BASELINE", name: "待审设计基线", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "待审计划",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", roleAssignments,
    });
    const document = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "待审详细设计", summary: "", status: "评审中",
      version: "1.0", author: "designer", content: "供独立审计的固定设计",
    });
    store.insertDocumentReference({
      projectId: project.id, documentId: document.id, documentRevisionId: document.currentRevisionId,
      targetType: "plan", targetId: plan.id, relationType: "defines",
    });

    const submitted = transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    expect(submitted.designRevisionIds).toEqual([document.currentRevisionId]);
  });

  it("separates proposal, construction, audit and manager decisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-lifecycle-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "FLOW", name: "交付链", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "实现功能",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "",
      roleAssignments,
    });
    const designRevisionId = bindApprovedDesign(store, project.id, plan.id, "flow");

    expect(transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" }).lifecycleStatus).toBe("pending_approval");
    passDesignAudit(store, project.id, plan.id, designRevisionId);
    expect(transitionPlanLifecycle(store, plan.id, { action: "approve_plan", actor: "manager" }).approvedBy).toBe("manager");
    expect(transitionPlanLifecycle(store, plan.id, { action: "start_development", actor: "builder", agentId: "builder-id" }).status).toBe("进行中");
    expect(transitionPlanLifecycle(store, plan.id, { action: "complete_development", actor: "builder", agentId: "builder-id", implementationRevision: "abc123" }).lifecycleStatus).toBe("pending_audit");
    expect(() => transitionPlanLifecycle(store, plan.id, { action: "pass_audit", actor: "auditor", agentId: "auditor-id" })).toThrow("受派审计者");
    store.insertEvidence({
      projectId: project.id, nodeId: null, planItemId: plan.id, sourceType: "manual", sourcePath: "report.json", command: "npm test",
      resultStatus: "pass", summary: "独立测试通过", details: { auditScope: "implementation", implementationRevision: "abc123" }, commitSha: "abc123", digest: "digest", collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id",
    });
    expect(transitionPlanLifecycle(store, plan.id, { action: "pass_audit", actor: "auditor", agentId: "auditor-id" }).lifecycleStatus).toBe("pending_manager");
    const accepted = transitionPlanLifecycle(store, plan.id, { action: "approve_acceptance", actor: "manager" });
    expect(accepted.lifecycleStatus).toBe("accepted");
    expect(accepted.managerDecisionBy).toBe("manager");
  });

  it("requires a reason when audit or manager rejects work", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-reject-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "REJECT", name: "拒绝链", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "计划",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "",
      roleAssignments,
    });
    bindApprovedDesign(store, project.id, plan.id, "reject");
    transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    expect(() => transitionPlanLifecycle(store, plan.id, { action: "reject_plan", actor: "manager" })).toThrow("reason");
    expect(transitionPlanLifecycle(store, plan.id, { action: "reject_plan", actor: "manager", reason: "验收标准不完整" }).lifecycleStatus).toBe("rework");
  });

  it("returns design audit failures to Designer and invalidates evidence after a new document revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-design-audit-rework-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "DESIGN-REWORK", name: "设计审计返工", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "设计闭环",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", roleAssignments,
    });
    const document = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "闭环设计", summary: "", status: "已批准",
      version: "1.0", author: "designer", content: "第一版设计",
    });
    const reference = store.insertDocumentReference({
      projectId: project.id, documentId: document.id, targetType: "plan", targetId: plan.id, relationType: "defines",
    });

    const first = transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    expect(first.designRevisionIds).toEqual([document.currentRevisionId]);
    passDesignAudit(store, project.id, plan.id, document.currentRevisionId);
    transitionPlanLifecycle(store, plan.id, { action: "reject_plan", actor: "manager", reason: "异常路径不足" });

    const revised = store.updateDesignDoc(document.id, { status: "已批准", version: "2.0", content: "第二版设计，补齐异常路径" })!;
    store.updateDocumentReferenceRevision(reference.id, revised.currentRevisionId);
    const second = transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    expect(second.designRevisionIds).toEqual([revised.currentRevisionId]);
    expect(second.designRevisionIds).not.toEqual(first.designRevisionIds);
    expect(() => transitionPlanLifecycle(store, plan.id, {
      action: "pass_design_audit", actor: "auditor", agentId: "auditor-id",
    })).toThrow("当前固定文档修订");

    store.insertEvidence({
      projectId: project.id, nodeId: null, planItemId: plan.id, sourceType: "manual", sourcePath: "design-audit-fail.json", command: "review design",
      resultStatus: "fail", summary: "第二版仍缺少并发说明", details: { auditScope: "design" }, commitSha: "", digest: "design-fail",
      collectedAt: nowIso(), actorRole: "auditor", agentId: "auditor-id", documentRevisionId: revised.currentRevisionId,
    });
    const failed = transitionPlanLifecycle(store, plan.id, {
      action: "fail_design_audit", actor: "auditor", agentId: "auditor-id", reason: "并发一致性边界不完整",
    });
    expect(failed).toMatchObject({ lifecycleStatus: "rework", auditStatus: "failed" });
    expect(failed.rejectionReason).toContain("设计审计失败");
  });

  it("does not allow a controlled plan to skip approval or start construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-no-skip-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "NO-SKIP", name: "不可跳步", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "正式施工计划",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "",
      roleAssignments,
    });
    const designRevisionId = bindApprovedDesign(store, project.id, plan.id, "no-skip");

    expect(() => transitionPlanLifecycle(store, plan.id, { action: "complete_development", actor: "builder" })).toThrow("不能执行");
    transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    passDesignAudit(store, project.id, plan.id, designRevisionId);
    transitionPlanLifecycle(store, plan.id, { action: "approve_plan", actor: "manager" });
    expect(() => transitionPlanLifecycle(store, plan.id, { action: "complete_development", actor: "builder" })).toThrow("不能执行");
  });

  it("repairs an in-progress legacy trace by re-submitting the plan baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-trace-recovery-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "TRACE", name: "痕迹修复", summary: "", stage: "开发", health: "关注", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: "trace-node", kind: "feature", label: "正式交付", x: 600, y: 160,
      developmentStatus: "开发中", acceptanceStatus: "未验收",
    }] });
    const plan = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "trace-node", parentId: null, kind: "task", title: "历史施工单",
      description: "", status: "进行中", priority: "P1", progress: 80, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "in_progress",
      roleAssignments,
    });
    bindApprovedDesign(store, project.id, plan.id, "trace");

    expect(() => transitionPlanLifecycle(store, plan.id, {
      action: "complete_development", actor: "builder", agentId: "builder-id", implementationRevision: "abc123",
    })).toThrow("缺少提交或批准痕迹");
    const submitted = transitionPlanLifecycle(store, plan.id, {
      action: "submit_plan", actor: "designer", agentId: "designer-id", correlationId: "trace-recovery-1",
    });
    expect(submitted).toMatchObject({
      lifecycleStatus: "pending_approval", status: "未开始", progress: 0,
      correlationId: "trace-recovery-1", proposedBy: "designer", approvedBy: "",
    });
    expect(store.getDiagram(main.id)?.nodes.find((node) => node.id === "trace-node")).toMatchObject({
      developmentStatus: "未开发", acceptanceStatus: "未验收",
    });
  });

  it("rejects duplicate assignments, wrong identities and builder evidence for audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-role-separation-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "ROLES", name: "职责隔离", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const duplicate = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "重复角色",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "same", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], roleAssignments: {
        designer: { agentId: "same", displayName: "same" }, builder: { agentId: "same", displayName: "same" }, auditor: { agentId: "auditor", displayName: "auditor" },
      },
    });
    expect(() => transitionPlanLifecycle(store, duplicate.id, { action: "submit_plan", actor: "same", agentId: "same" })).toThrow("不能使用同一 Agent 身份");

    const plan = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "独立角色",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], roleAssignments,
    });
    const designRevisionId = bindApprovedDesign(store, project.id, plan.id, "roles");
    expect(() => transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "伪装设计者", agentId: "builder-id" })).toThrow("身份不匹配");
    transitionPlanLifecycle(store, plan.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" });
    passDesignAudit(store, project.id, plan.id, designRevisionId);
    transitionPlanLifecycle(store, plan.id, { action: "approve_plan", actor: "manager" });
    transitionPlanLifecycle(store, plan.id, { action: "start_development", actor: "builder", agentId: "builder-id" });
    transitionPlanLifecycle(store, plan.id, { action: "complete_development", actor: "builder", agentId: "builder-id", implementationRevision: "build-1" });
    store.insertEvidence({
      projectId: project.id, nodeId: null, planItemId: plan.id, sourceType: "manual", sourcePath: "builder.txt", command: "npm test",
      resultStatus: "pass", summary: "施工测试", details: {}, commitSha: "", digest: "builder", collectedAt: nowIso(), actorRole: "builder", agentId: "builder-id",
    });
    expect(() => transitionPlanLifecycle(store, plan.id, { action: "pass_audit", actor: "auditor", agentId: "auditor-id" })).toThrow("受派审计者");
  });

  it("keeps milestones out of the executable delivery lifecycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-milestone-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "MILESTONE", name: "里程碑层级", summary: "", stage: "规划", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const milestone = store.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "milestone", title: "M1",
      description: "只表达层级", status: "未开始", priority: "P1", progress: 0, owner: "manager", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    });

    expect(() => transitionPlanLifecycle(store, milestone.id, { action: "submit_plan", actor: "designer" }))
      .toThrow("只有 task 可进入施工交付生命周期");
  });

  it("allows dependent design approval but blocks implementation until its dependency is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-plan-layer-gate-"));
    const store = new Store(join(dir, "test.db"));
    resources.push({ store, dir });
    const project = store.insertProject({
      code: "LAYERS", name: "逐层交付", summary: "", stage: "开发", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes,
      { id: "layer-one", kind: "feature", label: "第一层", x: 600, y: 120 },
      { id: "layer-two", kind: "feature", label: "第二层", x: 900, y: 120 },
    ] });
    const first = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "layer-one", parentId: null, kind: "task", title: "第一层任务",
      description: "", status: "未开始", priority: "P3", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", roleAssignments,
    });
    const second = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: "layer-two", parentId: null, kind: "task", title: "第二层高优任务",
      description: "", status: "未开始", priority: "P0", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [first.id], blockedReason: "", completedAt: "", roleAssignments,
    });
    const revision = bindApprovedDesign(store, project.id, second.id, "layer-two");
    expect(transitionPlanLifecycle(store, second.id, { action: "submit_plan", actor: "designer", agentId: "designer-id" }).lifecycleStatus)
      .toBe("pending_approval");
    passDesignAudit(store, project.id, second.id, revision);
    expect(transitionPlanLifecycle(store, second.id, { action: "approve_plan", actor: "manager" }).lifecycleStatus).toBe("approved");
    expect(() => transitionPlanLifecycle(store, second.id, { action: "start_development", actor: "builder", agentId: "builder-id" }))
      .toThrow("依赖任务：第一层任务");
    store.updatePlan(first.id, { lifecycleStatus: "accepted", status: "已完成", progress: 100 });
    expect(transitionPlanLifecycle(store, second.id, { action: "start_development", actor: "builder", agentId: "builder-id" }).lifecycleStatus)
      .toBe("in_progress");
  });
});
