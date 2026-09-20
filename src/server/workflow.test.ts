import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { validateDiagramDeliveryTransition } from "./domain.js";
import { buildProjectWorkflow } from "./workflow.js";
import { getProjectedProjectWorkspace, listProjectedProjects } from "./projectProjection.js";

const stores: Array<{ store: Store; dir: string }> = [];

function setup(): { store: Store; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcs-workflow-"));
  const store = new Store(join(dir, "test.db"));
  stores.push({ store, dir });
  const project = store.insertProject({
    code: "WF",
    name: "工作流项目",
    summary: "用于验证统一设计推进协议",
    stage: "设计",
    health: "正常",
    progress: 0,
    riskLevel: "P2",
    riskSummary: "",
    blockerSummary: "",
    nextStep: "",
    repositoryPath: "",
    startAt: "",
    dueAt: "",
  });
  return { store, projectId: project.id };
}

afterEach(() => {
  for (const item of stores.splice(0)) {
    item.store.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

describe("project workflow", () => {
  it("does not read project collections outside the requested list page", () => {
    const { store, projectId } = setup();
    store.insertProject({
      code: "UNRELATED", name: "无关项目", summary: "无关", stage: "探索", health: "正常", progress: 0,
      riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
    });
    const diagrams = vi.spyOn(store, "listDiagrams");
    const plans = vi.spyOn(store, "listPlans");
    const documents = vi.spyOn(store, "listDesignDocs");
    const evidence = vi.spyOn(store, "listEvidence");

    expect(listProjectedProjects(store, [])).toEqual([]);
    expect([diagrams, plans, documents, evidence].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);

    const project = store.getProject(projectId)!;
    expect(listProjectedProjects(store, [project])).toHaveLength(1);
    expect(diagrams.mock.calls).toEqual([[projectId]]);
    expect(plans.mock.calls).toEqual([[projectId]]);
    expect(documents.mock.calls).toEqual([[projectId]]);
    expect(evidence.mock.calls).toEqual([[projectId]]);
  });

  it("shares project collections within a projection and rereads them on the next request", () => {
    const { store, projectId } = setup();
    const brief = store.insertDesignDoc({
      projectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "范围",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    const diagrams = vi.spyOn(store, "listDiagrams");
    const plans = vi.spyOn(store, "listPlans");
    const documents = vi.spyOn(store, "listDesignDocs");
    const evidence = vi.spyOn(store, "listEvidence");

    const first = getProjectedProjectWorkspace(store, projectId)!;
    expect(first.project.nextStep).toBe("拆分模块与功能节点");
    expect([diagrams, plans, documents, evidence].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);

    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, { id: "fresh-node", kind: "feature", label: "实时节点", x: 10, y: 10 }] });
    const second = getProjectedProjectWorkspace(store, projectId)!;
    expect(second.project.nextStep).toBe("补全节点“实时节点”");
    expect([plans, documents, evidence].map((spy) => spy.mock.calls.length)).toEqual([2, 2, 2]);
    expect(diagrams).toHaveBeenCalledTimes(3); // one explicit read between the two projections
  });

  it("returns one actionable next step in protocol order", () => {
    const { store, projectId } = setup();
    expect(buildProjectWorkflow(store, projectId)?.nextAction?.code).toBe("approve_project_brief");

    const brief = store.insertDesignDoc({
      projectId,
      category: "需求文档",
      title: "项目简报",
      summary: "目标、范围和成功标准",
      status: "已批准",
      version: "v1.0",
      author: "owner",
      content: "项目目标与非目标",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    expect(buildProjectWorkflow(store, projectId)?.nextAction?.code).toBe("add_function_node");

    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, {
      nodes: [...main.nodes, {
        id: "feature-login",
        kind: "feature",
        label: "登录",
        x: 600,
        y: 160,
        developmentStatus: "未开发",
        acceptanceStatus: "未验收",
      }],
    });
    expect(buildProjectWorkflow(store, projectId)?.nextAction?.code).toBe("complete_node_definition");
  });

  it("blocks development until gates pass and then requires the formal plan transition", () => {
    const { store, projectId } = setup();
    const brief = store.insertDesignDoc({
      projectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "范围",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    const node = {
      id: "feature-orders",
      kind: "feature" as const,
      label: "订单",
      description: "创建并查询订单",
      owner: "team-a",
      acceptanceCriteria: "创建成功后可以查询",
      requirementStatus: "已批准" as const,
      designStatus: "已批准" as const,
      developmentStatus: "未开发" as const,
      acceptanceStatus: "未验收" as const,
      x: 600,
      y: 160,
    };
    const before = store.updateDiagram(main.id, { nodes: [...main.nodes, node] })!;
    const after = { ...before, nodes: before.nodes.map((item) => item.id === node.id ? { ...item, developmentStatus: "开发中" as const } : item) };
    expect(validateDiagramDeliveryTransition(store, before, after)).toContain("已批准的节点文档");

    const design = store.insertDesignDoc({
      projectId, category: "功能说明", title: "订单功能设计", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "设计",
    });
    store.insertDocumentReference({ projectId, documentId: design.id, targetType: "diagramNode", targetId: node.id, relationType: "defines" });
    expect(validateDiagramDeliveryTransition(store, before, after)).toContain("开发计划");

    store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: node.id, parentId: null, kind: "task", title: "实现订单",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "team-a", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
      lifecycleStatus: "approved", proposedBy: "designer", submittedAt: "2026-08-30T01:00:00.000Z",
      approvedBy: "manager", approvedAt: "2026-08-30T01:05:00.000Z",
    });
    expect(validateDiagramDeliveryTransition(store, before, after)).toContain("由施工计划自动汇总");
    expect(buildProjectWorkflow(store, projectId)?.nextAction?.code).toBe("start_development");
  });

  it("syncs a child-diagram mirror root node without demanding a development plan", () => {
    const { store, projectId } = setup();
    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    const parent = {
      id: "module-orders", kind: "module" as const, label: "订单服务",
      description: "订单域", owner: "team-a", acceptanceCriteria: "订单可创建",
      requirementStatus: "已批准" as const, designStatus: "已批准" as const,
      developmentStatus: "已完成" as const, acceptanceStatus: "已通过" as const,
      x: 100, y: 100,
    };
    const child = store.insertDiagram({
      projectId, title: "订单服务子画布", type: "functional", edges: [],
      nodes: [{
        id: "mirror-orders", kind: "module" as const, label: "订单服务",
        description: "订单域", owner: "team-a", acceptanceCriteria: "订单可创建",
        requirementStatus: "已批准" as const, designStatus: "已批准" as const,
        developmentStatus: "未开发" as const, acceptanceStatus: "未验收" as const,
        x: 100, y: 100,
      }],
    });
    const withParent = store.updateDiagram(main.id, {
      nodes: [...main.nodes, { ...parent, linkDiagramIds: [child.id] }],
    })!;
    // 镜像根节点被排除在交付节点之外，因此不受"至少需要一个开发计划"门禁约束
    expect(store.listProjectWorkspaceNodes(projectId, { diagrams: store.listDiagrams(projectId) })
      .some((item) => item.node.id === "mirror-orders")).toBe(false);
    const before = store.getDiagram(child.id)!;
    const after = { ...before, nodes: before.nodes.map((item) => item.id === "mirror-orders"
      ? { ...item, developmentStatus: "已完成" as const, acceptanceStatus: "已通过" as const }
      : item) };
    expect(validateDiagramDeliveryTransition(store, before, after)).toBeUndefined();

    // 非镜像节点仍受开发门禁约束
    const stillBlocked = { ...withParent, nodes: withParent.nodes.map((item) => item.id === parent.id
      ? { ...item, developmentStatus: "开发中" as const }
      : item) };
    expect(validateDiagramDeliveryTransition(store, withParent, stillBlocked)).toBeTruthy();
  });

  it("routes a completed legacy plan without formal trace back to plan submission", () => {
    const { store, projectId } = setup();
    const brief = store.insertDesignDoc({
      projectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "范围",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    const node = {
      id: "feature-legacy-trace",
      kind: "feature" as const,
      label: "历史交付",
      description: "验证历史计划回归正式链路",
      owner: "team-a",
      acceptanceCriteria: "正式计划可重新提交",
      requirementStatus: "已批准" as const,
      designStatus: "已批准" as const,
      developmentStatus: "已完成" as const,
      acceptanceStatus: "已通过" as const,
      x: 600,
      y: 160,
    };
    store.updateDiagram(main.id, { nodes: [...main.nodes, node] });
    const design = store.insertDesignDoc({
      projectId, category: "功能说明", title: "历史交付设计", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "设计",
    });
    store.insertDocumentReference({ projectId, documentId: design.id, targetType: "diagramNode", targetId: node.id, relationType: "defines" });
    const plan = store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: node.id, parentId: null, kind: "task", title: "历史计划",
      description: "", status: "已完成", priority: "P1", progress: 100, owner: "team-a", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "2026-08-27T00:00:00.000Z",
      lifecycleStatus: "legacy",
    });

    const nextAction = buildProjectWorkflow(store, projectId)?.nextAction;
    expect(nextAction).toMatchObject({
      code: "submit_plan",
      entityType: "plan",
      entityId: plan.id,
      nodeId: node.id,
    });
    expect(nextAction?.href).toContain(`tab=development&plan=${plan.id}`);
  });

  it("uses the workflow gate as the public project stage and ignores milestones as delivery plans", () => {
    const { store, projectId } = setup();
    const brief = store.insertDesignDoc({
      projectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "范围",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: "feature-gated", kind: "feature", label: "受控交付", description: "验证统一阶段",
      owner: "team", acceptanceCriteria: "完成正式计划交付", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "待验收", acceptanceStatus: "未验收", x: 600, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId, category: "功能说明", title: "受控交付设计", summary: "", status: "已批准",
      version: "v1.0", author: "owner", content: "设计",
    });
    store.insertDocumentReference({ projectId, documentId: design.id, targetType: "diagramNode", targetId: "feature-gated", relationType: "defines" });
    store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: "feature-gated", parentId: null, kind: "milestone", title: "交付里程碑",
      description: "只表达层级", status: "未开始", priority: "P1", progress: 0, owner: "manager", versionTag: "",
      startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
    });

    const workflow = buildProjectWorkflow(store, projectId)!;
    expect(workflow.phase).toBe("planning");
    expect(workflow.nextAction?.code).toBe("create_node_plan");
    expect(workflow.nodes.find((node) => node.nodeId === "feature-gated")?.planCount).toBe(0);
    expect(getProjectedProjectWorkspace(store, projectId)?.project.stage).toBe("规划");
  });
});
