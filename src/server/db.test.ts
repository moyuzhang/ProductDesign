import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store, normalizeDiagramNodeLinks } from "./db.js";

const dir = mkdtempSync(join(tmpdir(), "pcs-db-"));
const store = new Store(join(dir, "test.db"));

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function projectInput(overrides: Partial<Parameters<Store["insertProject"]>[0]> = {}) {
  return {
    code: "ALPHA",
    name: "Alpha 项目",
    summary: "",
    stage: "规划",
    health: "正常",
    progress: 0,
    riskLevel: "P2",
    riskSummary: "",
    blockerSummary: "",
    nextStep: "",
    repositoryPath: "",
    startAt: "",
    dueAt: "",
    ...overrides,
  };
}

describe("Store", () => {
  it("inserts and updates projects", () => {
    const created = store.insertProject(projectInput());
    expect(created.id).toBeTruthy();
    expect(created.code).toBe("ALPHA");

    const updated = store.updateProject(created.id, { stage: "开发", progress: 40 });
    expect(updated?.stage).toBe("开发");
    expect(updated?.progress).toBe(40);
    expect(store.getProject(created.id)?.updatedAt >= created.updatedAt).toBe(true);

    expect(store.listProjects({ stage: "开发" }).length).toBeGreaterThanOrEqual(1);
    expect(store.listProjects({ q: "alpha" }).length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates project codes", () => {
    expect(store.uniqueProjectCode("ALPHA")).not.toBe("ALPHA");
    expect(store.uniqueProjectCode("BETA")).toBe("BETA");
  });

  it("manages work nodes with defaults", () => {
    const project = store.insertProject(projectInput({ code: "NODES" }));
    const node = store.insertNode({
      projectId: project.id,
      parentId: null,
      kind: "feature",
      title: "登录功能",
      description: "",
      priority: "P1",
      owner: "",
      requirementStatus: "待整理",
      designStatus: "未开始",
      developmentStatus: "未开始",
      testStatus: "未开始",
      progress: 0,
      startAt: "",
      dueAt: "",
      position: undefined,
    });
    const edited = store.updateNode(node.id, { developmentStatus: "进行中", progress: 30 });
    expect(edited?.developmentStatus).toBe("进行中");
    expect(store.listNodes(project.id)).toHaveLength(1);
    expect(store.deleteNode(node.id)).toBe(true);
  });

  it("stores plan dependency ids as json round-trip", () => {
    const project = store.insertProject(projectInput({ code: "PLANS" }));
    const plan = store.insertPlan({
      projectId: project.id,
      parentId: null,
      kind: "milestone",
      title: "M1 内测",
      description: "",
      status: "未开始",
      priority: "P1",
      progress: 0,
      owner: "",
      versionTag: "v0.9",
      startAt: "",
      dueAt: "2026-09-01",
      dependencyIds: ["a", "b"],
    });
    expect(store.getPlan(plan.id)?.dependencyIds).toEqual(["a", "b"]);
    store.updatePlan(plan.id, { status: "已完成" });
    expect(store.getPlan(plan.id)?.status).toBe("已完成");
    expect(store.listAllPlans().some((p) => p.id === plan.id)).toBe(true);
  });

  it("deleting a project cascades children", () => {
    const project = store.insertProject(projectInput({ code: "CASCADE" }));
    store.insertEvidence({
      projectId: project.id,
      nodeId: null,
      sourceType: "manual",
      sourcePath: "",
      command: "",
      resultStatus: "info",
      summary: "手工记录",
      details: {},
      commitSha: "",
      digest: "",
      collectedAt: new Date().toISOString(),
    });
    store.deleteProject(project.id);
    expect(store.listEvidence(project.id)).toHaveLength(0);
  });

  it("filters evidence by node id", () => {
    const project = store.insertProject(projectInput({ code: "EVIDENCE-FILTER" }));
    const base = {
      projectId: project.id,
      sourceType: "manual" as const,
      sourcePath: "",
      command: "",
      resultStatus: "pass" as const,
      details: {},
      commitSha: "",
      digest: "",
      collectedAt: new Date().toISOString(),
    };
    store.insertEvidence({ ...base, nodeId: "node-a", summary: "A evidence" });
    store.insertEvidence({ ...base, nodeId: "node-b", summary: "B evidence" });
    expect(store.listEvidence(project.id, "node-a").map((item) => item.summary)).toEqual(["A evidence"]);
    expect(store.listEvidence(project.id)).toHaveLength(2);
  });

  it("pages evidence in the database without hiding revoked records", () => {
    const project = store.insertProject(projectInput({ code: "EVIDENCE-PAGE" }));
    const base = {
      projectId: project.id, nodeId: "node-page", sourceType: "manual" as const,
      command: "", resultStatus: "pass" as const, details: { auditScope: "implementation" },
      commitSha: "", digest: "",
    };
    const older = store.insertEvidence({ ...base, sourcePath: "reports/old.json", summary: "旧证据", collectedAt: "2026-09-01T00:00:00.000Z" });
    store.insertEvidence({ ...base, sourcePath: "reports/new_100%.json", summary: "中文证据", collectedAt: "2026-09-02T00:00:00.000Z" });
    expect(store.deleteEvidence(older.id, "过期")).toBe(true);

    const page = store.listEvidencePage({ projectId: project.id, nodeId: "node-page", resultStatus: "pass", q: "_100%", limit: 1, offset: 0 });
    expect(page).toMatchObject({ total: 1, count: 1, offset: 0, hasMore: false });
    expect(page.items[0]).toMatchObject({ summary: "中文证据", details: { auditScope: "implementation" } });
    expect(store.listEvidencePage({ projectId: project.id, limit: 10, offset: 0 }).items.find((item) => item.id === older.id)?.status).toBe("revoked");
  });

  it("migrates inline diagram evidence into the Evidence entity once", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "pcs-evidence-migration-"));
    const dbPath = join(migrationDir, "test.db");
    const before = new Store(dbPath);
    const project = before.insertProject(projectInput({ code: "EVIDENCE-MIGRATION" }));
    const main = before.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const legacyNode = {
      id: "legacy-node",
      kind: "feature",
      label: "旧证据节点",
      x: 200,
      y: 200,
      acceptanceStatus: "已通过",
      acceptanceEvidence: [{ id: "legacy-evidence", kind: "截图", title: "回归截图", url: "files/regression.png", note: "旧画布字段" }],
    };
    before.db.prepare("UPDATE diagrams SET nodes = ? WHERE id = ?").run(JSON.stringify([...main.nodes, legacyNode]), main.id);
    before.close();

    const after = new Store(dbPath);
    const migratedNode = after.getDiagram(main.id)?.nodes.find((node) => node.id === legacyNode.id);
    expect(migratedNode).not.toHaveProperty("acceptanceEvidence");
    const migrated = after.listEvidence(project.id, legacyNode.id);
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ summary: "回归截图", sourcePath: "files/regression.png", resultStatus: "pass" });
    expect(migrated[0]?.details).toMatchObject({ kind: "截图", note: "旧画布字段", migratedFrom: "diagramNode.acceptanceEvidence" });
    after.close();

    const reopened = new Store(dbPath);
    expect(reopened.listEvidence(project.id, legacyNode.id)).toHaveLength(1);
    reopened.close();
    rmSync(migrationDir, { recursive: true, force: true });
  });

  it("backfills distinct historical plan actors into persisted role assignments", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "pcs-role-migration-"));
    const dbPath = join(migrationDir, "test.db");
    const before = new Store(dbPath);
    const project = before.insertProject(projectInput({ code: "ROLE-MIGRATION" }));
    const plan = before.insertPlan({
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task", title: "历史计划",
      description: "", status: "已完成", priority: "P1", progress: 100, owner: "builder-id", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], proposedBy: "designer-id", auditedBy: "auditor-id",
    });
    expect(before.getPlan(plan.id)?.roleAssignments.builder.agentId).toBe("");
    before.close();

    const after = new Store(dbPath);
    expect(after.getPlan(plan.id)?.roleAssignments).toEqual({
      designer: { agentId: "designer-id", displayName: "designer-id" },
      builder: { agentId: "builder-id", displayName: "builder-id" },
      auditor: { agentId: "auditor-id", displayName: "auditor-id" },
    });
    after.close();
    rmSync(migrationDir, { recursive: true, force: true });
  });

  it("repairs only unsubmitted design-change rework plans left as drafts", () => {
    const migrationDir = mkdtempSync(join(tmpdir(), "pcs-design-change-rework-migration-"));
    const dbPath = join(migrationDir, "test.db");
    const before = new Store(dbPath);
    const project = before.insertProject(projectInput({ code: "REWORK-MIGRATION" }));
    const base = {
      projectId: project.id, diagramId: null, diagramNodeId: null, parentId: null, kind: "task" as const,
      description: "", status: "未开始" as const, priority: "P1" as const, progress: 0, owner: "builder-id",
      versionTag: "", startAt: "", dueAt: "", dependencyIds: [],
    };
    const original = before.insertPlan({ ...base, title: "原计划", lifecycleStatus: "accepted" });
    const malformed = before.insertPlan({
      ...base, title: "异常返工计划", lifecycleStatus: "draft", reworkOfPlanId: original.id,
      submittedAt: "", rejectedBy: "", rejectedAt: "", rejectionReason: "",
    });
    const ordinaryDraft = before.insertPlan({ ...base, title: "普通草稿", lifecycleStatus: "draft" });
    const submittedDraft = before.insertPlan({
      ...base, title: "已提交历史草稿", lifecycleStatus: "draft", reworkOfPlanId: original.id,
      submittedAt: new Date().toISOString(),
    });
    before.db.prepare("DELETE FROM schema_migrations WHERE id = ?")
      .run("2026-09-design-change-rework-plan-lifecycle");
    before.close();

    const after = new Store(dbPath);
    expect(after.getPlan(malformed.id)).toMatchObject({
      lifecycleStatus: "rework",
      rejectedBy: "design_change",
      rejectionReason: "历史设计变更返工计划状态修复",
    });
    expect(after.getPlan(ordinaryDraft.id)?.lifecycleStatus).toBe("draft");
    expect(after.getPlan(submittedDraft.id)?.lifecycleStatus).toBe("draft");
    after.close();

    const reopened = new Store(dbPath);
    expect(reopened.getPlan(malformed.id)?.lifecycleStatus).toBe("rework");
    reopened.close();
    rmSync(migrationDir, { recursive: true, force: true });
  });

  it("records audit events with actor/source", () => {
    store.recordAudit({
      projectId: null,
      entityType: "project",
      entityId: "x",
      action: "update",
      before: null,
      after: { health: "关注" },
      actor: "tester",
      source: "mcp",
    });
    const events = store.listAudit(10);
    expect(events[0]?.actor).toBe("tester");
    expect(events[0]?.after).toEqual({ health: "关注" });
  });

  it("manages design docs", () => {
    const project = store.insertProject(projectInput({ code: "DESIGN" }));
    const doc = store.insertDesignDoc({
      projectId: project.id,
      title: "架构方案",
      summary: "单体 + SQLite",
      status: "评审中",
      version: "v0.2",
      author: "architect",
      content: "选型说明",
    });
    expect(store.getDesignDoc(doc.id)?.status).toBe("评审中");
    const reference = store.insertDocumentReference({ projectId: project.id, documentId: doc.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const updated = store.updateDesignDoc(doc.id, { status: "已批准" })!;
    expect(updated.status).toBe("已批准");
    expect(updated.currentRevisionId).not.toBe(doc.currentRevisionId);
    expect(store.getDocumentReference(reference.id)?.documentRevisionId).toBe(doc.currentRevisionId);
    store.updateDocumentReferenceRevision(reference.id, updated.currentRevisionId);
    expect(store.getDocumentReference(reference.id)?.documentRevisionId).toBe(updated.currentRevisionId);
    expect(store.listDesignDocs().length).toBeGreaterThanOrEqual(1);
  });

  it("pages referenced design docs with literal unicode wildcard search", () => {
    const project = store.insertProject(projectInput({ code: "DESIGN-PAGE" }));
    const matching = store.insertDesignDoc({
      projectId: project.id, title: "API_%_中文", summary: "精确搜索", status: "已批准",
      version: "v1", author: "designer", content: "正文",
    });
    store.insertDesignDoc({
      projectId: project.id, title: "其他文档", summary: "", status: "草稿",
      version: "v1", author: "designer", content: "正文",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: matching.id, targetType: "project", targetId: project.id, relationType: "defines" });

    const page = store.listDesignDocsPage({
      projectId: project.id, q: "_%_中文", status: "已批准", targetType: "project", targetId: project.id, limit: 10, offset: 0,
    });
    expect(page).toMatchObject({ total: 1, count: 1, hasMore: false });
    expect(page.items.map((item) => item.id)).toEqual([matching.id]);
  });

  it("keeps document reference migration idempotent across restarts", () => {
    const restartDir = mkdtempSync(join(tmpdir(), "pcs-doc-ref-restart-"));
    const restartDb = join(restartDir, "restart.db");
    const first = new Store(restartDb);
    const project = first.insertProject(projectInput({ code: "DOC-RESTART" }));
    const document = first.insertDesignDoc({
      projectId: project.id, title: "重启测试", summary: "", status: "已批准",
      version: "v1.0", author: "test", content: "正文",
    });
    first.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: "node-restart", relationType: "defines" });
    expect(first.listDocumentReferences({ projectId: project.id })).toHaveLength(1);
    first.close();

    const second = new Store(restartDb);
    expect(second.listDocumentReferences({ projectId: project.id })).toHaveLength(1);
    second.close();
    rmSync(restartDir, { recursive: true, force: true });
  });

  it("manages system-level LLM profiles", () => {
    const profile = store.insertLlmProfile({
      name: "Local Gateway",
      provider: "Self-hosted",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:9000/v1",
      apiKeyEnv: "LOCAL_GATEWAY_KEY",
      models: ["local-model"],
      defaultModel: "local-model",
      enabled: true,
      reasoningEffort: "low",
      timeoutMs: 30000,
    });
    expect(profile.credentialConfigured).toBe(false);
    expect(profile.reasoningEffort).toBe("low");
    expect(store.listLlmProfiles().some((item) => item.id === profile.id)).toBe(true);
    expect(store.updateLlmProfile(profile.id, { enabled: false, reasoningEffort: "max" })).toMatchObject({ enabled: false, reasoningEffort: "max" });
    expect(store.deleteLlmProfile(profile.id)).toBe(true);
  });

  it("isolates Agent workspaces, sessions and messages by project", () => {
    const project = store.insertProject(projectInput({ code: "AGENT" }));
    const profile = store.insertLlmProfile({
      name: "Agent Gateway",
      provider: "OpenAI compatible",
      protocol: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      apiKeyEnv: "AGENT_GATEWAY_KEY_NOT_SET",
      models: ["agent-model"],
      defaultModel: "agent-model",
      enabled: true,
      timeoutMs: 30000,
    });
    const workspace = store.ensureAgentWorkspace(project.id);
    expect(workspace.projectId).toBe(project.id);
    expect(store.updateAgentWorkspace(project.id, profile.id)?.defaultProfileId).toBe(profile.id);

    const session = store.insertAgentSession({ projectId: project.id, profileId: profile.id, model: "agent-model", title: "架构讨论" });
    expect(session.controlMode).toBe("restricted");
    const user = store.insertAgentMessage({
      sessionId: session.id, projectId: project.id, role: "user", content: "说明当前架构",
      status: "completed", pageContext: { route: "#/canvas/1", title: "系统主画布" },
    });
    const assistant = store.insertAgentMessage({
      sessionId: session.id, projectId: project.id, role: "assistant", content: "处理中",
      status: "running", pageContext: null,
    });
    expect(store.getAgentWorkspaceSnapshot(project.id).sessions).toHaveLength(1);
    expect(store.listAgentMessages(session.id).map((item) => item.id)).toEqual([user.id, assistant.id]);
    expect(store.listAgentMessages(session.id)[0].pageContext?.route).toBe("#/canvas/1");
    expect(store.updateAgentMessage(assistant.id, { content: "已完成", status: "completed" })?.content).toBe("已完成");
    expect(store.updateAgentSession(session.id, { status: "failed", lastError: "demo", controlMode: "ask" })?.controlMode).toBe("ask");
    const approval = store.insertAgentApproval({
      projectId: project.id,
      sessionId: session.id,
      kind: "command",
      title: "执行命令",
      summary: "npm test",
      details: { command: "npm test" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(store.listAgentApprovals(session.id, "pending")).toEqual([approval]);
    expect(store.resolveAgentApproval(approval.id, "approved", "approve_once")).toMatchObject({ status: "approved", decision: "approve_once" });
    expect(store.deleteAgentSession(session.id)).toBe(true);
    expect(store.listAgentMessages(session.id)).toHaveLength(0);
    expect(store.listAgentApprovals(session.id)).toHaveLength(0);
    expect(store.deleteLlmProfile(profile.id)).toBe(true);
  });

  it("expires pending Agent approvals when the store restarts", () => {
    const restartDir = mkdtempSync(join(tmpdir(), "pcs-approval-restart-"));
    const dbPath = join(restartDir, "restart.db");
    const first = new Store(dbPath, restartDir);
    const project = first.insertProject(projectInput({ code: "APRST" }));
    const profile = first.insertLlmProfile({
      name: "Restart Gateway", provider: "OpenAI", protocol: "openai-responses",
      baseUrl: "https://example.invalid/v1", apiKeyEnv: "RESTART_KEY",
      models: ["model"], defaultModel: "model", enabled: true, timeoutMs: 30_000,
    });
    const session = first.insertAgentSession({ projectId: project.id, profileId: profile.id, model: "model", title: "重启测试", controlMode: "ask" });
    const approval = first.insertAgentApproval({
      projectId: project.id, sessionId: session.id, kind: "file-change",
      title: "修改文件", summary: "src/app.ts", details: { files: ["src/app.ts"] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    first.close();

    const reopened = new Store(dbPath, restartDir);
    expect(reopened.getAgentApproval(approval.id)).toMatchObject({ status: "expired", decision: "deny" });
    reopened.close();
    rmSync(restartDir, { recursive: true, force: true });
  });

  it("manages diagrams with node/edge json round-trip", () => {
    const project = store.insertProject(projectInput({ code: "DIAG" }));
    const diagram = store.insertDiagram({
      projectId: project.id,
      title: "架构图",
      nodes: [{ id: "a", kind: "module", label: "前端", x: 10, y: 20 }],
      edges: [],
    });
    expect(store.getDiagram(diagram.id)?.nodes[0].label).toBe("前端");
    store.updateDiagram(diagram.id, {
      nodes: [{ id: "a", kind: "module", label: "前端", x: 10, y: 20 }, { id: "b", kind: "feature", label: "登录", x: 200, y: 20 }],
      edges: [{ id: "e1", from: "a", to: "b", style: "ortho", points: [{ x: 98, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 80 }] }],
    });
    const d = store.getDiagram(diagram.id);
    expect(d?.nodes).toHaveLength(2);
    expect(d?.edges).toHaveLength(1);
    expect(d?.edges[0].points).toHaveLength(3);
  });

  it("prevents new group overlaps while allowing legacy layouts to be repaired", () => {
    const project = store.insertProject(projectInput({ code: "GROUP-GUARD" }));
    const nodes = [
      { id: "a1", kind: "feature" as const, label: "A1", x: 0, y: 0, w: 40, h: 40 },
      { id: "a2", kind: "feature" as const, label: "A2", x: 40, y: 0, w: 40, h: 40 },
      { id: "b1", kind: "feature" as const, label: "B1", x: 112, y: 0, w: 40, h: 40 },
      { id: "b2", kind: "feature" as const, label: "B2", x: 152, y: 0, w: 40, h: 40 },
    ];
    const groups = [
      { id: "group-a", name: "区域 A", nodeIds: ["a1", "a2"] },
      { id: "group-b", name: "区域 B", nodeIds: ["b1", "b2"] },
    ];
    const valid = store.insertDiagram({ projectId: project.id, title: "合法组合", nodes, edges: [], groups });
    expect(() => store.updateDiagram(valid.id, {
      nodes: nodes.map((node) => node.id === "b1" ? { ...node, x: 111 } : node),
    })).toThrow("组合区域“区域 A”与“区域 B”不允许重叠");
    expect(store.getDiagram(valid.id)?.nodes.find((node) => node.id === "b1")?.x).toBe(112);

    const legacyNodes = nodes.map((node) => node.id.startsWith("b") ? { ...node, x: node.x - 20 } : node);
    const legacy = store.insertDiagram({ projectId: project.id, title: "历史重叠", nodes: legacyNodes, edges: [], groups });
    expect(store.updateDiagram(legacy.id, { title: "历史重叠待修复" })?.title).toBe("历史重叠待修复");
    expect(store.updateDiagram(legacy.id, { nodes })?.nodes.find((node) => node.id === "b1")?.x).toBe(112);
  });

  it("normalizes legacy linkDiagramId into a linkDiagramIds array", () => {
    const node = normalizeDiagramNodeLinks({ id: "x", kind: "feature", label: "登录", x: 0, y: 0, linkDiagramId: "sub-a" } as never);
    expect(node.linkDiagramIds).toEqual(["sub-a"]);
    expect((node as unknown as { linkDiagramId?: string }).linkDiagramId).toBeUndefined();
    // empty legacy value -> empty array, no dangling field
    const empty = normalizeDiagramNodeLinks({ id: "y", kind: "feature", label: "空", x: 0, y: 0, linkDiagramId: undefined } as never);
    expect(empty.linkDiagramIds).toEqual([]);
  });

  it("round-trips a node linked to multiple sub-diagrams and dedupes on write", () => {
    const project = store.insertProject(projectInput({ code: "LINK" }));
    const a = store.insertDiagram({ projectId: project.id, title: "子画布 A", nodes: [], edges: [] });
    const b = store.insertDiagram({ projectId: project.id, title: "子画布 B", nodes: [], edges: [] });
    const parent = store.insertDiagram({
      projectId: project.id,
      title: "主图",
      nodes: [{ id: "m", kind: "feature", label: "登录", x: 0, y: 0, linkDiagramIds: [a.id, b.id] }],
      edges: [],
    });
    expect(store.getDiagram(parent.id)?.nodes[0].linkDiagramIds).toEqual([a.id, b.id]);
    // legacy single link is normalized on write and read
    const legacy = store.insertDiagram({
      projectId: project.id,
      title: "旧画布",
      nodes: [{ id: "l", kind: "feature", label: "旧", x: 0, y: 0, linkDiagramId: a.id } as never],
      edges: [],
    });
    expect(store.getDiagram(legacy.id)?.nodes[0].linkDiagramIds).toEqual([a.id]);
  });

  it("removes dangling sub-canvas links when a linked diagram is deleted", () => {
    const project = store.insertProject(projectInput({ code: "LINKDEL" }));
    const child = store.insertDiagram({ projectId: project.id, title: "子图", nodes: [], edges: [] });
    const parent = store.insertDiagram({
      projectId: project.id,
      title: "主图",
      nodes: [{ id: "m", kind: "feature", label: "登录", x: 0, y: 0, linkDiagramIds: [child.id] }],
      edges: [],
    });
    expect(store.getDiagram(parent.id)?.nodes[0].linkDiagramIds).toEqual([child.id]);
    expect(store.deleteDiagram(child.id)).toBe(true);
    expect(store.getDiagram(parent.id)?.nodes[0].linkDiagramIds).toEqual([]);
  });

  it("dashboard aggregates totals", () => {
    const dash = store.dashboard();
    expect(dash.totals.projects).toBeGreaterThan(0);
    expect(typeof dash.generatedAt).toBe("string");
  });
});
