import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./index.js";
import { Store } from "../server/db.js";
import { syncManagedProject } from "../server/projectFiles.js";
import { LocalMcpClient, mcpResultText, type AgentMcpResult } from "../server/localMcpClient.js";
import { createServiceHealthPayload } from "./fullTools.js";
import { beginAgentAuth, completeAgentAuth, expectedChallengeResponse, registerAgentCredential } from "../server/agentSecurity.js";
import { listClaimableAgentTasks } from "../server/agentTaskLeases.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-mcp-docs-"));
const dbPath = join(dataDir, "docs.db");
const store = new Store(dbPath, dataDir);
let client: LocalMcpClient;
let projectId = "";
const contents = {
  alpha: `ALPHA-${"\u0000".repeat(8_994)}`,
  beta: (`"\\\n`.repeat(1_667)).slice(0, 5_000),
  gamma: "GAMMA-complete",
};

beforeAll(async () => {
  const project = store.insertProject({
    code: "MCPCONTENT", name: "MCP 文档正文", summary: "", stage: "设计", health: "正常",
    progress: 0,
    riskLevel: "P2", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: "", startAt: "", dueAt: "",
  });
  projectId = project.id;
  for (const [title, content] of Object.entries(contents)) {
    store.insertDesignDoc({
      projectId, title, summary: `${title} summary`, status: "草拟",
      version: "v0.1", author: "test", content,
    });
  }
  client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir, trustedInternal: true }));
});

it("claims a main-canvas node split and limits its write to initial function nodes", async () => {
  const project = store.insertProject({ code: "MCP-NODE-SPLIT", name: "节点拆分", summary: "已批准的项目目标", stage: "设计",
    health: "正常", progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "",
    repositoryPath: "", startAt: "", dueAt: "" });
  syncManagedProject(store, dataDir, project);
  const brief = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报", summary: "范围",
    status: "已批准", version: "1", author: "Main Agent", content: "目标、范围和成功标准" });
  store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project",
    targetId: project.id, relationType: "defines" });
  const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
  const task = listClaimableAgentTasks(store, project.id).find((item) => item.actionCode === "add_function_node")!;
  expect(task).toMatchObject({ available: true, diagramId: main.id, workScopes: [`diagram:${main.id}`] });
  const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
  const call = (name: string, args: Record<string, unknown>) =>
    (external as unknown as { request: (method: string, params: unknown) => Promise<AgentMcpResult> })
      .request("tools/call", { name, arguments: args });
  try {
    const packet = JSON.parse(mcpResultText(await call("get_agent_task_package", {
      projectRef: project.id, taskId: task.id, role: "designer", agentId: task.assignee!.agentId,
      workerId: "node-split-worker", idempotencyKey: "claim-node-split",
    }), 100_000)) as { lease: { workOrderId: string; leaseToken: string; taskKey: string; taskRevision: string;
      workerId: string; agentId: string }; documents: Array<{ documentRevisionId: string }> };
    expect(packet.documents.some((item) => item.documentRevisionId === brief.currentRevisionId)).toBe(true);
    const context = { workOrderId: packet.lease.workOrderId, leaseToken: packet.lease.leaseToken,
      taskKey: packet.lease.taskKey, taskRevision: packet.lease.taskRevision, workerId: packet.lease.workerId,
      agentId: packet.lease.agentId, role: "designer" };
    expect(mcpResultText(await call("start_agent_task", { ...context, idempotencyKey: "start-node-split" }), 10_000)).toContain("running");
    expect(mcpResultText(await call("mutate_diagram", { ...context, diagramId: main.id,
      expectedUpdatedAt: store.getDiagram(main.id)!.updatedAt,
      operations: [{ op: "add_node", node: { kind: "note", label: "越界", x: 10, y: 10 } }],
      idempotencyKey: "invalid-node-kind" }), 10_000)).toContain("FUNCTION_NODE_SCOPE_REQUIRED");
    expect(mcpResultText(await call("mutate_diagram", { ...context, diagramId: main.id,
      expectedUpdatedAt: store.getDiagram(main.id)!.updatedAt,
      operations: [{ op: "add_node", node: { kind: "feature", label: "会员与登录", x: 80, y: 80 } }],
      idempotencyKey: "add-first-function" }), 10_000)).toContain("已原子执行");
    expect(mcpResultText(await call("complete_agent_task", { ...context,
      resultDigest: "已建立首批功能节点", idempotencyKey: "finish-node-split" }), 10_000)).toContain("completed");
    expect(store.getDiagram(main.id)!.nodes.some((node) => node.label === "会员与登录")).toBe(true);
    expect(listClaimableAgentTasks(store, project.id).some((item) => item.actionCode === "add_function_node")).toBe(false);
  } finally { await external.close(); }
});

afterAll(async () => {
  await client?.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("list_design_docs content retrieval", () => {
  it("publishes the complete external Worker authentication and write context contract", async () => {
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    try {
      const tools = await external.listAgentTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "begin_agent_auth", "complete_agent_auth", "ack_agent_policy", "issue_agent_write_nonce",
        "claim_next_agent_task", "start_agent_task", "heartbeat_agent_task", "create_evidence",
        "transition_plan_delivery", "complete_agent_task",
      ]));
      const exactClaim = tools.find((item) => item.name === "get_agent_task_package")!;
      const exactClaimRequired = (exactClaim.inputSchema.required ?? []) as string[];
      expect(exactClaimRequired).toEqual(expect.arrayContaining([
        "projectRef", "role", "agentId", "idempotencyKey",
      ]));
      expect(exactClaimRequired).not.toContain("workOrderId");
      expect(exactClaimRequired).not.toContain("leaseToken");
      expect(exactClaim.inputSchema.properties).toEqual(expect.objectContaining({
        taskId: expect.any(Object), taskKey: expect.any(Object),
      }));
      for (const name of ["start_agent_task", "heartbeat_agent_task", "create_evidence", "complete_agent_task"]) {
        const tool = tools.find((item) => item.name === name)!;
        const required = (tool.inputSchema.required ?? []) as string[];
        expect(required).toEqual(expect.arrayContaining([
          "workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId",
          "agentId", "role", "idempotencyKey",
        ]));
      }
      const evidence = tools.find((item) => item.name === "create_evidence")!;
      expect((evidence.inputSchema.properties.commitSha as { maxLength?: number }).maxLength).toBe(300);
      const transition = tools.find((item) => item.name === "transition_plan_delivery")!;
      const transitionRequired = (transition.inputSchema.required ?? []) as string[];
      expect(transitionRequired).toEqual(expect.arrayContaining(["planId", "action", "actor"]));
      expect(transitionRequired).not.toContain("leaseToken");
      expect(transition.inputSchema.properties).toEqual(expect.objectContaining({
        leaseToken: expect.any(Object), workOrderId: expect.any(Object), taskKey: expect.any(Object),
      }));
      const coordinationClaim = tools.find((item) => item.name === "claim_coordination_lease")!;
      expect((coordinationClaim.inputSchema.required ?? []) as string[]).toEqual(expect.arrayContaining([
        "projectRef", "mainAgentId", "workerId", "idempotencyKey",
      ]));
      expect(coordinationClaim.inputSchema.properties).toEqual(expect.objectContaining({
        authSessionToken: expect.any(Object), planId: expect.any(Object), taskKey: expect.any(Object), taskRevision: expect.any(Object),
      }));
    } finally { await external.close(); }
  });

  it("executes external challenge authentication and policy acknowledgment without exposing admin authority", async () => {
    const registration = registerAgentCredential(store, {
      principalId: "test/external", agentId: "external-builder", workerId: "external-worker-01",
      allowedRoles: ["builder"], allowedProjects: [projectId],
    });
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    const connectionId = "external-connection-0001";
    try {
      const challenge = JSON.parse(mcpResultText(await external.callTool("begin_agent_auth", {
        credentialId: registration.credentialId, connectionId,
      }), 100_000));
      const timestamp = new Date().toISOString();
      const protocolVersion = "2025-06-18";
      const response = expectedChallengeResponse(registration.credentialSecret, challenge.challenge, connectionId,
        registration.credentialId, timestamp, protocolVersion);
      const authenticated = JSON.parse(mcpResultText(await external.callTool("complete_agent_auth", {
        challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion, response,
      }), 100_000));
      expect(authenticated).toMatchObject({ agentId: "external-builder", workerId: "external-worker-01", connectionId });
      const acknowledged = JSON.parse(mcpResultText(await external.callTool("ack_agent_policy", {
        authSessionToken: authenticated.authSessionToken, role: "builder", projectRef: projectId, policyVersion: "2.3.0",
      }), 100_000));
      expect(acknowledged.policyAckToken.length).toBeGreaterThanOrEqual(32);
      const replay = await external.callTool("complete_agent_auth", {
        challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion, response,
      });
      expect(mcpResultText(replay, 100_000)).toContain("TOKEN_REPLAYED");
    } finally { await external.close(); }
  });

  it("reports both UTC and Asia/Shanghai health timestamps", async () => {
    const payload = createServiceHealthPayload(true, "2026-08-31T16:30:00.123Z");
    expect(payload.ok).toBe(true);
    expect(payload.databaseOpen).toBe(true);
    expect(payload.time).toBe("2026-08-31T16:30:00.123Z");
    expect(payload.localTime).toBe("2026-09-01T00:30:00.123+08:00");
    expect(payload.timeZone).toBe("Asia/Shanghai");
    expect(Date.parse(payload.localTime)).toBe(Date.parse(payload.time));
  });

  it("lets a plan-bound Main Agent lease approve and accept only its target plan", async () => {
    const project = store.insertProject({
      code: "MCP-COORDINATION", name: "父协调租约", summary: "", stage: "设计", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir, startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "mcp-coordination-node";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "父协调任务", description: "", owner: "team", acceptanceCriteria: "可验证",
      requirementStatus: "已批准", designStatus: "待评审", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const document = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "父协调设计", summary: "", status: "已批准", version: "1.0", author: "designer", content: "冻结设计",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const roleAssignments = {
      designer: { agentId: "coord-designer", displayName: "Coord Designer" },
      builder: { agentId: "coord-builder", displayName: "Coord Builder" },
      auditor: { agentId: "coord-auditor", displayName: "Coord Auditor" },
    };
    const plan = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "目标计划",
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], lifecycleStatus: "pending_approval", designRevisionIds: [document.currentRevisionId], proposedBy: "designer",
      submittedAt: "2026-09-12T00:00:00.000Z", auditStatus: "passed", managerDecision: "pending", roleAssignments,
    });
    const json = (result: Awaited<ReturnType<LocalMcpClient["callTool"]>>) => {
      const text = mcpResultText(result, 100_000);
      return JSON.parse(text.slice(text.indexOf("{")));
    };
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    const authenticate = (workerId: string) => {
      const registration = registerAgentCredential(store, {
        principalId: `mcp/${workerId}`, agentId: "Main Agent", workerId,
        allowedRoles: ["approver"], allowedProjects: [project.id],
      });
      const connectionId = `mcp-${workerId}`;
      const challenge = beginAgentAuth(store, registration.credentialId, connectionId);
      const timestamp = new Date().toISOString();
      const protocolVersion = "2025-06-18";
      return completeAgentAuth(store, {
        challengeId: challenge.challengeId, challenge: challenge.challenge, connectionId, timestamp, protocolVersion,
        response: expectedChallengeResponse(registration.credentialSecret, challenge.challenge, connectionId,
          registration.credentialId, timestamp, protocolVersion),
      }).authSessionToken;
    };
    const approvalToken = authenticate("coord-main-approval");
    const anonymousClaim = await external.callTool("claim_coordination_lease", {
      projectRef: project.id, planId: plan.id, mainAgentId: "Main Agent", workerId: "coord-main-approval", idempotencyKey: "coord-parent-anonymous",
    });
    expect(mcpResultText(anonymousClaim, 100_000)).toContain("AUTH_REQUIRED");
    const spoofedClaim = await external.callTool("claim_coordination_lease", {
      projectRef: project.id, planId: plan.id, mainAgentId: "Other Agent", workerId: "coord-main-approval",
      authSessionToken: approvalToken, idempotencyKey: "coord-parent-spoofed",
    });
    expect(mcpResultText(spoofedClaim, 100_000)).toContain("PRINCIPAL_SPOOF_REJECTED");
    const crossProjectClaim = await external.callTool("claim_coordination_lease", {
      projectRef: projectId, planId: plan.id, mainAgentId: "Main Agent", workerId: "coord-main-approval",
      authSessionToken: approvalToken, idempotencyKey: "coord-parent-cross-project",
    });
    expect(mcpResultText(crossProjectClaim, 100_000)).toContain("PERMISSION_DENIED");
    const beforeClaim = JSON.parse(mcpResultText(await external.callTool("list_coordination_leases", { projectRef: project.id }), 100_000));
    expect(beforeClaim).toEqual([]);
    const parent = json(await external.callTool("claim_coordination_lease", {
      projectRef: project.id, planId: plan.id, mainAgentId: "Main Agent", workerId: "coord-main-approval",
      authSessionToken: approvalToken, idempotencyKey: "coord-parent-approval",
    }));
    const approved = json(await client.callTool("transition_plan_delivery", {
      planId: plan.id, action: "approve_plan", actor: "Main Agent", agentId: "Main Agent",
      coordinationLeaseId: parent.id, coordinationLeaseToken: parent.leaseToken, idempotencyKey: "coord-approve-plan",
    }));
    expect(approved.lifecycleStatus).toBe("approved");
    await client.callTool("release_coordination_lease", {
      projectRef: project.id, coordinationLeaseId: parent.id, leaseToken: parent.leaseToken, mainAgentId: "Main Agent", reason: "切换到验收验证",
    });
    store.updatePlan(plan.id, {
      lifecycleStatus: "pending_manager", status: "已完成", progress: 100, completedAt: "2026-09-12T01:00:00.000Z",
      implementationRevision: "coord-implementation", auditStatus: "passed", managerDecision: "pending",
    });
    store.insertEvidence({
      projectId: project.id, nodeId, sourceType: "manual", sourcePath: "test", command: "coord-test", resultStatus: "pass",
      summary: "实现审计证据", details: { auditScope: "implementation", implementationRevision: "coord-implementation" },
      commitSha: "coord-implementation", digest: "coord-digest", collectedAt: "2026-09-12T01:00:00.000Z",
      planItemId: plan.id, actorRole: "auditor", agentId: "coord-auditor", status: "active",
    });
    const acceptanceParent = json(await external.callTool("claim_coordination_lease", {
      projectRef: project.id, planId: plan.id, mainAgentId: "Main Agent", workerId: "coord-main-acceptance",
      authSessionToken: authenticate("coord-main-acceptance"), idempotencyKey: "coord-parent-acceptance",
    }));
    const accepted = json(await client.callTool("transition_plan_delivery", {
      planId: plan.id, action: "approve_acceptance", actor: "Main Agent", agentId: "Main Agent",
      coordinationLeaseId: acceptanceParent.id, coordinationLeaseToken: acceptanceParent.leaseToken, idempotencyKey: "coord-approve-acceptance",
    }));
    expect(accepted.lifecycleStatus).toBe("accepted");
    await client.callTool("release_coordination_lease", {
      projectRef: project.id, coordinationLeaseId: acceptanceParent.id, leaseToken: acceptanceParent.leaseToken, mainAgentId: "Main Agent", reason: "测试结束",
    });
    await external.close();
  });

  it("exposes list and exact task-context reads to the internal Agent bridge", async () => {
    const tools = await client.listAgentTools();
    expect(tools.map((tool) => tool.name)).toContain("list_plan_items");
    expect(tools.map((tool) => tool.name)).toContain("get_plan_item");
    expect(tools.map((tool) => tool.name)).toContain("get_design_doc");
    expect(tools.map((tool) => tool.name)).toContain("claim_next_agent_task");
    expect(tools.map((tool) => tool.name)).toContain("list_agent_worker_pools");
    expect(tools.map((tool) => tool.name)).toContain("request_design_change");
    const result = await client.callTool("list_plan_items", { projectRef: projectId, offset: 0, limit: 1 });
    expect(mcpResultText(result, 100_000)).toContain("计划项");
  });

  it("reads one exact document revision through bounded content cursors", async () => {
    const document = store.listDesignDocs(projectId).find((item) => item.title === "alpha")!;
    const first = await client.callTool("get_design_doc", {
      projectRef: projectId,
      documentId: document.id,
      revisionId: document.currentRevisionId,
      contentOffset: 0,
      maxContentChars: 1000,
    });
    const payload = JSON.parse(mcpResultText(first, 100_000)) as {
      revisionId: string; content: string; nextContentOffset: number | null; hasMore: boolean;
    };
    expect(payload.revisionId).toBe(document.currentRevisionId);
    expect(payload.content).toBe(contents.alpha.slice(0, 1000));
    expect(payload.nextContentOffset).toBe(1000);
    expect(payload.hasMore).toBe(true);
  });

  it("returns a deterministic no-plan Designer identity that claim_next can use", async () => {
    const project = store.insertProject({
      code: "MCPPREPLAN", name: "MCP 无计划设计", summary: "", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P0", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
      version: "1.0", author: "manager", content: "MCP 无计划设计任务合同",
    });
    store.insertDocumentReference({
      projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines",
    });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeIds = ["mcp-preplan-design-1", "mcp-preplan-design-2"];
    store.updateDiagram(main.id, { nodes: [...main.nodes, ...nodeIds.map((nodeId, index) => ({
      id: nodeId, kind: "feature" as const, label: `MCP 设计节点 ${index + 1}`, description: "验证 MCP 列表与领取一致",
      owner: "designer", acceptanceCriteria: "返回身份可领取",
      requirementStatus: "已批准" as const, designStatus: "进行中" as const, developmentStatus: "未开发" as const,
      acceptanceStatus: "未验收" as const, x: 600 + index * 220, y: 160,
    }))] });

    const listed = await client.callTool("list_claimable_agent_tasks", {
      projectRef: project.id, role: "designer", offset: 0, limit: 20,
    });
    const page = JSON.parse(mcpResultText(listed, 100_000)) as {
      items: Array<{ id: string; nodeId: string; available: boolean; poolId: string; assignee: { agentId: string } }>;
    };
    expect(page.items.filter((item) => nodeIds.includes(item.nodeId))).toHaveLength(2);
    const task = page.items.find((item) => item.nodeId === nodeIds[1])!;
    expect(task).toMatchObject({
      id: `design:${nodeIds[1]}`, available: true,
    });
    expect(task.assignee.agentId).toMatch(new RegExp(`^design-node-${nodeIds[1]}-[0-9a-f]{16}$`));
    expect(task.poolId).toBe(`pool:${project.id}:designer:${task.assignee.agentId}`);

    const claimInput = {
      projectRef: project.id, role: "designer", agentId: task.assignee.agentId,
      workerId: "mcp-preplan-worker", poolId: task.poolId,
      idempotencyKey: "mcp-preplan-claim",
    };
    store.updateProject(project.id, { repositoryPath: join(dataDir, "missing-claim-directory") });
    const failed = await client.callTool("claim_next_agent_task", claimInput);
    expect(mcpResultText(failed, 100_000)).toContain("WORKING_DIRECTORY_NOT_READY");
    expect(store.db.prepare("SELECT count(*) AS n FROM agent_task_leases WHERE project_id = ?").get(project.id)).toEqual({ n: 0 });
    store.updateProject(project.id, { repositoryPath: dataDir });
    const claimed = await client.callTool("claim_next_agent_task", claimInput);
    const replay = await client.callTool("claim_next_agent_task", claimInput);
    expect(JSON.parse(mcpResultText(replay, 100_000)).lease)
      .toEqual(JSON.parse(mcpResultText(claimed, 100_000)).lease);
    const taskPackage = JSON.parse(mcpResultText(claimed, 100_000)) as {
      assignment: { agentId: string; poolId: string };
      worker: { agentId: string; workerId: string; poolId: string };
      planSnapshot: null;
      node: { nodeId: string };
      lease: { leaseToken: string; agentId: string; poolId: string };
    };
    expect(taskPackage).toMatchObject({
      assignment: { agentId: task.assignee.agentId, poolId: task.poolId },
      worker: { agentId: task.assignee.agentId, workerId: "mcp-preplan-worker", poolId: task.poolId },
      planSnapshot: null,
      node: { nodeId: nodeIds[1] },
      lease: { agentId: task.assignee.agentId, poolId: task.poolId },
    });

    const released = await client.callTool("release_agent_task", {
      leaseToken: taskPackage.lease.leaseToken,
      agentId: task.assignee.agentId,
      idempotencyKey: "mcp-preplan-release",
    });
    expect(mcpResultText(released, 100_000)).toContain('"status": "released"');
  });

  it("keeps the default directory response metadata-only", async () => {
    const result = await client.callTool("list_design_docs", { projectRef: projectId, offset: 0, limit: 20 });
    const text = mcpResultText(result, 100_000);
    expect(text).toContain("共 3 篇设计文档");
    expect(text).not.toContain("ALPHA-aaaa");
  });

  it("reconstructs every document through bounded content cursors", async () => {
    const reconstructed = new Map<string, string>();
    let offset = 0;
    let contentOffset = 0;
    let calls = 0;
    let hasMore = true;

    while (hasMore) {
      calls += 1;
      expect(calls).toBeLessThan(10);
      const result = await client.callTool("list_design_docs", {
        projectRef: projectId,
        includeContent: true,
        offset,
        contentOffset,
        limit: 20,
        maxContentChars: 12_000,
      });
      const text = mcpResultText(result, 100_000);
      expect(text.length).toBeLessThanOrEqual(20_000);
      const page = JSON.parse(text) as {
        items: Array<{ id: string; title: string; content: string; contentStart: number; contentEnd: number; contentLength: number }>;
        nextOffset: number;
        nextContentOffset: number;
        hasMore: boolean;
      };
      for (const item of page.items) {
        reconstructed.set(item.title, `${reconstructed.get(item.title) ?? ""}${item.content}`);
        expect(item.contentEnd).toBeLessThanOrEqual(item.contentLength);
      }
      offset = page.nextOffset;
      contentOffset = page.nextContentOffset;
      hasMore = page.hasMore;
    }

    expect(reconstructed.get("alpha")).toBe(contents.alpha);
    expect(reconstructed.get("beta")).toBe(contents.beta);
    expect(reconstructed.get("gamma")).toBe(contents.gamma);
  });

  it("exposes orchestration and controlled plan transitions to external agents", async () => {
    const blueprintResult = await client.callTool("get_agent_orchestration", { projectRef: projectId, includePrompts: true });
    const blueprint = JSON.parse(mcpResultText(blueprintResult, 100_000)) as { schemaVersion: string; recommendedAgents: Array<{ key: string }>; bootstrapPrompt: string };
    expect(blueprint.schemaVersion).toBe("1.3");
    expect(blueprint.recommendedAgents.map((agent) => agent.key)).toEqual(["designer", "builder", "auditor", "approver"]);
    expect(blueprint.bootstrapPrompt).toContain("禁止自动创建管理员 Agent");

    store.updateProject(projectId, { repositoryPath: dataDir });
    const brief = store.insertDesignDoc({
      projectId, category: "需求文档", title: "任务包项目简报", summary: "", status: "已批准",
      version: "v1.0", author: "manager", content: "范围",
    });
    store.insertDocumentReference({ projectId, documentId: brief.id, targetType: "project", targetId: projectId, relationType: "defines" });
    const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: "mcp-package-feature", kind: "feature", label: "外部任务包", description: "生成外部 Agent 任务包", owner: "team",
      acceptanceCriteria: "任务包明确目标工作目录", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "开发中", acceptanceStatus: "未验收", requiresDatabase: false, x: 620, y: 160,
    }] });
    const packageDesign = store.insertDesignDoc({
      projectId, category: "功能说明", title: "任务包详细设计", summary: "", status: "已批准",
      version: "v1.0", author: "designer", content: "只生成任务包，不启动外部进程",
    });
    store.insertDocumentReference({ projectId, documentId: packageDesign.id, targetType: "diagramNode", targetId: "mcp-package-feature", relationType: "defines" });
    const packagePlan = store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: "mcp-package-feature", parentId: null, kind: "task", title: "实现任务包", description: "",
      status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer",
      submittedAt: "2026-08-30T01:00:00.000Z", approvedBy: "manager", approvedAt: "2026-08-30T01:05:00.000Z",
      roleAssignments: {
        designer: { agentId: "designer-id", displayName: "Designer" },
        builder: { agentId: "builder-id", displayName: "Builder", poolId: "mcp-builder-pool" },
        auditor: { agentId: "auditor-id", displayName: "Auditor" },
      },
    });
    const packageResult = await client.callTool("get_agent_task_package", {
      projectRef: projectId, role: "builder", agentId: "builder-id", workerId: "mcp-worker-1", poolId: "mcp-builder-pool", taskId: `development:${packagePlan.id}`,
      idempotencyKey: "mcp-package-claim",
    });
    const taskPackage = JSON.parse(mcpResultText(packageResult, 100_000)) as {
      project: { repositoryPath: string };
      task: { role: string; planItemId: string };
      launch: { manualStartRequired: boolean; workingDirectory: string; prompt: string };
      worker: { workerId: string; poolId: string };
      lease: { status: string; agentId: string; workerId: string; poolId: string; leaseToken: string; workScopes: string[] };
    };
    expect(taskPackage.project.repositoryPath).toBe(dataDir);
    expect(taskPackage.task).toEqual(expect.objectContaining({ role: "builder", planItemId: packagePlan.id }));
    expect(taskPackage.launch).toEqual(expect.objectContaining({ manualStartRequired: true, workingDirectory: dataDir }));
    expect(taskPackage.launch.prompt).toContain("ProductDesign 系统内 Agent 不负责写目标项目代码");
    expect(taskPackage.lease).toEqual(expect.objectContaining({
      status: "claimed", agentId: "builder-id", heartbeatSeconds: 300,
    }));
    expect(new Date(taskPackage.lease.leaseExpiresAt).getTime() - Date.now()).toBeGreaterThan(1_790_000);
    expect(taskPackage.worker).toEqual({ workerId: "mcp-worker-1", poolId: "mcp-builder-pool", agentId: "builder-id" });
    expect(taskPackage.lease.workScopes).toEqual([`node:${main.id}:mcp-package-feature`]);
    const duplicatePackage = await client.callTool("get_agent_task_package", {
      projectRef: projectId, role: "builder", agentId: "builder-id", taskId: `development:${packagePlan.id}`,
      idempotencyKey: "mcp-package-duplicate",
    });
    expect(mcpResultText(duplicatePackage, 100_000)).toContain("TASK_ALREADY_CLAIMED");
    const startedPackagePlan = await client.callTool("transition_plan_delivery", {
      planId: packagePlan.id, action: "start_development", actor: "Builder", agentId: "builder-id",
      leaseToken: taskPackage.lease.leaseToken, idempotencyKey: "mcp-package-start", correlationId: packagePlan.id,
    });
    expect(mcpResultText(startedPackagePlan, 100_000)).toContain('"lifecycleStatus": "in_progress"');
    const completedPackagePlan = await client.callTool("transition_plan_delivery", {
      planId: packagePlan.id, action: "complete_development", actor: "Builder", agentId: "builder-id",
      leaseToken: taskPackage.lease.leaseToken, idempotencyKey: "mcp-package-complete",
      implementationRevision: "build-mcp-1", correlationId: packagePlan.id,
    });
    expect(mcpResultText(completedPackagePlan, 100_000)).toContain('"lifecycleStatus": "pending_audit"');

    const lockedSameNodePlan = store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: "mcp-package-feature", parentId: null, kind: "task", title: "同节点第二层", description: "",
      status: "未开始", priority: "P0", progress: 0, owner: "builder", versionTag: "v2", startAt: "", dueAt: "",
      dependencyIds: [packagePlan.id], blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer",
      submittedAt: "2026-08-30T02:00:00.000Z", approvedBy: "manager", approvedAt: "2026-08-30T02:05:00.000Z",
      roleAssignments: packagePlan.roleAssignments,
    });
    const lockedBlueprintResult = await client.callTool("get_agent_orchestration", { projectRef: projectId, includePrompts: false });
    const lockedBlueprint = JSON.parse(mcpResultText(lockedBlueprintResult, 100_000)) as { queues: Record<string, Array<{ planItemId: string | null }>> };
    expect(Object.values(lockedBlueprint.queues).flat().some((item) => item.planItemId === lockedSameNodePlan.id)).toBe(false);
    const lockedPackageResult = await client.callTool("get_agent_task_package", {
      projectRef: projectId, role: "builder", agentId: "builder-id", taskId: `development:${lockedSameNodePlan.id}`,
      idempotencyKey: "mcp-locked-claim",
    });
    expect(mcpResultText(lockedPackageResult, 100_000)).toContain("PLAN_LAYER_LOCKED");

    const refreshedMain = store.getDiagram(main.id)!;
    store.updateDiagram(main.id, { nodes: [...refreshedMain.nodes, {
      id: "mcp-controlled-feature", kind: "feature", label: "MCP 受控流转", description: "验证租约约束的证据写入", owner: "team",
      acceptanceCriteria: "施工 Agent 仅可凭有效租约写入证据", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "未开始", acceptanceStatus: "未验收", requiresDatabase: false, x: 860, y: 160,
    }] });
    store.insertDocumentReference({
      projectId, documentId: packageDesign.id, targetType: "diagramNode", targetId: "mcp-controlled-feature", relationType: "defines",
    });

    const plan = store.insertPlan({
      projectId, diagramId: main.id, diagramNodeId: "mcp-controlled-feature", parentId: null, kind: "task", title: "MCP 受控计划", description: "",
      status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "",
      roleAssignments: {
        designer: { agentId: "designer-id", displayName: "Designer" },
        builder: { agentId: "builder-id", displayName: "Builder" },
        auditor: { agentId: "auditor-id", displayName: "Auditor" },
      },
    });
    const wrongSubmission = await client.callTool("transition_plan_delivery", {
      planId: plan.id, action: "submit_plan", actor: "fake", agentId: "builder-id", correlationId: "mcp-flow",
    });
    expect(mcpResultText(wrongSubmission, 100_000)).toContain("TASK_LEASE_REQUIRED");
    const designTaskResult = await client.callTool("get_agent_task_package", {
      projectRef: projectId,
      role: "designer",
      agentId: "designer-id",
      taskId: `design:${plan.id}`,
      sessionId: "mcp-session",
      idempotencyKey: "mcp-design-claim",
    });
    const designTask = JSON.parse(mcpResultText(designTaskResult, 100_000)) as AgentTaskPackage;
    const submitted = await client.callTool("transition_plan_delivery", {
      planId: plan.id, action: "submit_plan", actor: "designer", agentId: "designer-id", correlationId: "mcp-flow", sessionId: "mcp-session",
      leaseToken: designTask.lease?.leaseToken, idempotencyKey: "mcp-design-submit",
    });
    const submittedText = mcpResultText(submitted, 100_000);
    expect(JSON.parse(submittedText.slice(submittedText.indexOf("{"))).lifecycleStatus).toBe("pending_approval");
    const designAuditPackageResult = await client.callTool("get_agent_task_package", {
      projectRef: projectId,
      role: "auditor",
      agentId: "auditor-id",
      workerId: "mcp-design-auditor-worker",
      taskId: `audit:${plan.id}`,
      sessionId: "mcp-design-audit-session",
      idempotencyKey: "mcp-design-audit-claim",
    });
    const designAuditPackage = JSON.parse(mcpResultText(designAuditPackageResult, 100_000)) as AgentTaskPackage;
    expect(designAuditPackage).toMatchObject({
      schemaVersion: "1.3", deliveryTrack: "design", auditScope: "design", managerApprovalRequired: false,
      producerWorkerId: "designer-id:mcp-session",
    });
    expect(designAuditPackage.documentRevisionIds).toContain(packageDesign.currentRevisionId);
    await client.callTool("create_evidence", {
      projectRef: projectId, nodeId: "mcp-controlled-feature", planItemId: plan.id,
      documentRevisionId: packageDesign.currentRevisionId, summary: "MCP 设计审计通过", resultStatus: "pass",
      details: { auditScope: "design" }, actor: "auditor", actorRole: "auditor", agentId: "auditor-id",
      sessionId: "mcp-design-audit-session", leaseToken: designAuditPackage.lease?.leaseToken,
      idempotencyKey: "mcp-design-audit-evidence",
    });
    const designAudited = await client.callTool("transition_plan_delivery", {
      planId: plan.id, action: "pass_design_audit", actor: "auditor", agentId: "auditor-id",
      leaseToken: designAuditPackage.lease?.leaseToken, idempotencyKey: "mcp-design-audit-pass", correlationId: "mcp-flow",
    });
    expect(mcpResultText(designAudited, 100_000)).toContain('"auditStatus": "passed"');
    const approved = await client.callTool("transition_plan_delivery", { planId: plan.id, action: "approve_plan", actor: "manager", correlationId: "mcp-flow" });
    const approvedText = mcpResultText(approved, 100_000);
    expect(JSON.parse(approvedText.slice(approvedText.indexOf("{"))).lifecycleStatus).toBe("approved");

    const evidenceTaskResult = await client.callTool("get_agent_task_package", {
      projectRef: projectId,
      role: "builder",
      agentId: "builder-id",
      taskId: `development:${plan.id}`,
      sessionId: "builder-session",
      idempotencyKey: "mcp-evidence-claim",
    });
    const evidenceTask = JSON.parse(mcpResultText(evidenceTaskResult, 100_000)) as AgentTaskPackage;
    await client.callTool("transition_plan_delivery", {
      planId: plan.id,
      action: "start_development",
      actor: "builder",
      agentId: "builder-id",
      leaseToken: evidenceTask.lease?.leaseToken,
      idempotencyKey: "mcp-evidence-start",
      correlationId: "mcp-flow",
      sessionId: "builder-session",
    });

    await client.callTool("create_evidence", {
      projectRef: projectId, nodeId: null, planItemId: plan.id, summary: "MCP 施工证据", resultStatus: "pass",
      actor: "builder", actorRole: "builder", agentId: "builder-id", sessionId: "builder-session",
      leaseToken: evidenceTask.lease?.leaseToken, idempotencyKey: "mcp-evidence-create",
    });
    const auditPage = store.listAuditPage({ correlationId: "mcp-flow", offset: 0, limit: 20 });
    expect(auditPage.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: "evidence", action: "create", sessionId: "builder-session" }),
    ]));
  });

  it("runs two sequential child plans on one node through independent MCP lifecycles", async () => {
    const project = store.insertProject({
      code: "MCP-CHILD-LIFECYCLE", name: "MCP 同节点子工单", summary: "逐单治理", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P0", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({
      projectId: project.id, category: "需求文档", title: "子工单项目简报", summary: "", status: "已批准",
      version: "1.0", author: "manager", content: "同节点父子计划分别治理",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const main = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    const nodeId = "mcp-same-node-children";
    store.updateDiagram(main.id, { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "同节点顺序子工单", description: "两步交付", owner: "team",
      acceptanceCriteria: "两个子工单均独立验收", requirementStatus: "已批准", designStatus: "已批准",
      developmentStatus: "开发中", acceptanceStatus: "未验收", x: 620, y: 160,
    }] });
    const design = store.insertDesignDoc({
      projectId: project.id, category: "功能说明", title: "子工单详细设计", summary: "", status: "已批准",
      version: "1.0", author: "designer", content: "每个 planId 固定相同节点设计修订并独立审计",
    });
    store.insertDocumentReference({ projectId: project.id, documentId: design.id, targetType: "diagramNode", targetId: nodeId, relationType: "defines" });
    const roleAssignments = {
      designer: { agentId: "child-designer", displayName: "Child Designer" },
      builder: { agentId: "child-builder", displayName: "Child Builder" },
      auditor: { agentId: "child-auditor", displayName: "Child Auditor" },
    };
    const parent = store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: null, kind: "task", title: "已批准父工单",
      description: "", status: "已完成", priority: "P0", progress: 100, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "approved",
      submittedAt: "2026-08-31T00:00:00.000Z", approvedAt: "2026-08-31T01:00:00.000Z", managerDecision: "pending", roleAssignments,
    });
    const child = (title: string, dependencyIds: string[] = []) => store.insertPlan({
      projectId: project.id, diagramId: main.id, diagramNodeId: nodeId, parentId: parent.id, kind: "task", title,
      description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "",
      dependencyIds, blockedReason: "", completedAt: "", lifecycleStatus: "draft", roleAssignments,
    });
    const first = child("步骤 01");
    const second = child("步骤 02", [first.id]);

    const json = (result: Awaited<ReturnType<LocalMcpClient["callTool"]>>) => JSON.parse(mcpResultText(result, 100_000));
    const runChild = async (planId: string, suffix: string) => {
      const listed = json(await client.callTool("list_claimable_agent_tasks", {
        projectRef: project.id, role: "designer", offset: 0, limit: 100,
      })) as { items: Array<{ id: string; planItemId: string; taskKey: string; taskRevision: string; available: boolean; poolId: string }> };
      const listedTask = listed.items.find((item) => item.planItemId === planId)!;
      expect(listedTask).toMatchObject({ id: `design:${planId}`, available: true });
      const designerPackage = json(await client.callTool("claim_next_agent_task", {
        projectRef: project.id, role: "designer", agentId: "child-designer", workerId: `designer-${suffix}`,
        poolId: listedTask.poolId, sessionId: `design-session-${suffix}`, runId: `design-run-${suffix}`,
        taskId: listedTask.id, taskKey: listedTask.taskKey, idempotencyKey: `claim-design-${suffix}`,
      })) as AgentTaskPackage;
      expect(designerPackage.task).toMatchObject({ id: listedTask.id, planItemId: planId });
      expect(designerPackage.lease).toMatchObject({ taskKey: listedTask.taskKey, taskRevision: listedTask.taskRevision });
      expect(json(await client.callTool("claim_next_agent_task", {
        projectRef: project.id, role: "designer", agentId: "child-designer", workerId: `designer-${suffix}`,
        poolId: listedTask.poolId, sessionId: `design-session-${suffix}`, runId: `design-run-${suffix}`,
        taskId: listedTask.id, taskKey: listedTask.taskKey, idempotencyKey: `claim-design-${suffix}`,
      })).lease.leaseToken).toBe(designerPackage.lease!.leaseToken);
      await client.callTool("transition_plan_delivery", {
        planId, action: "submit_plan", actor: "designer", agentId: "child-designer",
        leaseToken: designerPackage.lease!.leaseToken, idempotencyKey: `submit-${suffix}`,
      });

      const designAuditPackage = json(await client.callTool("get_agent_task_package", {
        projectRef: project.id, role: "auditor", agentId: "child-auditor", workerId: `design-auditor-${suffix}`,
        taskId: `audit:${planId}`, idempotencyKey: `claim-design-audit-${suffix}`,
      })) as AgentTaskPackage;
      expect(designAuditPackage).toMatchObject({ auditScope: "design", producerWorkerId: `designer-${suffix}` });
      await client.callTool("create_evidence", {
        projectRef: project.id, nodeId, planItemId: planId, documentRevisionId: design.currentRevisionId,
        summary: `设计审计 ${suffix}`, resultStatus: "pass", details: { auditScope: "design" },
        actor: "auditor", actorRole: "auditor", agentId: "child-auditor",
        leaseToken: designAuditPackage.lease!.leaseToken, idempotencyKey: `design-evidence-${suffix}`,
      });
      await client.callTool("transition_plan_delivery", {
        planId, action: "pass_design_audit", actor: "auditor", agentId: "child-auditor",
        leaseToken: designAuditPackage.lease!.leaseToken, idempotencyKey: `pass-design-${suffix}`,
      });
      await client.callTool("transition_plan_delivery", { planId, action: "approve_plan", actor: "human-manager" });

      const builderPackage = json(await client.callTool("get_agent_task_package", {
        projectRef: project.id, role: "builder", agentId: "child-builder", workerId: `builder-${suffix}`,
        taskId: `development:${planId}`, idempotencyKey: `claim-builder-${suffix}`,
      })) as AgentTaskPackage;
      await client.callTool("transition_plan_delivery", {
        planId, action: "start_development", actor: "builder", agentId: "child-builder",
        leaseToken: builderPackage.lease!.leaseToken, idempotencyKey: `start-${suffix}`,
      });
      const implementationRevision = `implementation-${suffix}`;
      await client.callTool("create_evidence", {
        projectRef: project.id, nodeId, planItemId: planId, summary: `开发者测试 ${suffix}`, resultStatus: "pass",
        command: `npm test -- child-${suffix}`, commitSha: implementationRevision, details: { implementationRevision },
        actor: "builder", actorRole: "builder", agentId: "child-builder",
        leaseToken: builderPackage.lease!.leaseToken, idempotencyKey: `builder-evidence-${suffix}`,
      });
      await client.callTool("transition_plan_delivery", {
        planId, action: "complete_development", actor: "builder", agentId: "child-builder", implementationRevision,
        leaseToken: builderPackage.lease!.leaseToken, idempotencyKey: `complete-${suffix}`,
      });

      const implementationAuditPackage = json(await client.callTool("get_agent_task_package", {
        projectRef: project.id, role: "auditor", agentId: "child-auditor", workerId: `implementation-auditor-${suffix}`,
        taskId: `audit:${planId}`, idempotencyKey: `claim-implementation-audit-${suffix}`,
      })) as AgentTaskPackage;
      expect(implementationAuditPackage).toMatchObject({ auditScope: "implementation", producerWorkerId: `builder-${suffix}` });
      await client.callTool("create_evidence", {
        projectRef: project.id, nodeId, planItemId: planId, summary: `实现审计 ${suffix}`, resultStatus: "pass",
        commitSha: implementationRevision, details: { auditScope: "implementation", implementationRevision },
        actor: "auditor", actorRole: "auditor", agentId: "child-auditor",
        leaseToken: implementationAuditPackage.lease!.leaseToken, idempotencyKey: `implementation-evidence-${suffix}`,
      });
      await client.callTool("transition_plan_delivery", {
        planId, action: "pass_audit", actor: "auditor", agentId: "child-auditor",
        leaseToken: implementationAuditPackage.lease!.leaseToken, idempotencyKey: `pass-implementation-${suffix}`,
      });
      await client.callTool("transition_plan_delivery", { planId, action: "approve_acceptance", actor: "human-manager" });
      expect(store.getPlan(planId)).toMatchObject({ lifecycleStatus: "accepted", managerDecision: "approved" });
    };

    const initial = json(await client.callTool("list_claimable_agent_tasks", {
      projectRef: project.id, role: "designer", offset: 0, limit: 100,
    })) as { items: Array<{ planItemId: string }> };
    expect(initial.items.some((item) => item.planItemId === first.id)).toBe(true);
    // 设计阶段允许先形成各自的设计基线；依赖只锁定后续施工/审计/验收动作。
    expect(initial.items.some((item) => item.planItemId === second.id)).toBe(true);
    const initialBuilders = json(await client.callTool("list_claimable_agent_tasks", {
      projectRef: project.id, role: "builder", offset: 0, limit: 100,
    })) as { items: Array<{ planItemId: string }> };
    expect(initialBuilders.items.some((item) => item.planItemId === parent.id)).toBe(false);
    const initialWorkflow = json(await client.callTool("get_project_workflow", {
      projectRef: project.id, includeNodes: false, offset: 0, limit: 100,
    })) as { nextAction: { code: string; entityId: string } | null };
    expect(initialWorkflow.nextAction).toMatchObject({ code: "submit_plan", entityId: first.id });
    await runChild(first.id, "01");
    const afterRelease = json(await client.callTool("list_claimable_agent_tasks", {
      projectRef: project.id, role: "designer", offset: 0, limit: 100,
    })) as { items: Array<{ planItemId: string; available: boolean }> };
    expect(afterRelease.items).toEqual(expect.arrayContaining([expect.objectContaining({ planItemId: second.id, available: true })]));
    await runChild(second.id, "02");
    const finalBuilders = json(await client.callTool("list_claimable_agent_tasks", {
      projectRef: project.id, role: "builder", offset: 0, limit: 100,
    })) as { items: Array<{ planItemId: string; id: string; available: boolean }> };
    expect(finalBuilders.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ planItemId: parent.id, id: `development:${parent.id}`, available: true }),
    ]));
  });

  it("enforces MCP design-change rollback, idempotency, ownership and diagram revision contracts", async () => {
    const project = store.insertProject({
      code: "MCPCHANGE", name: "MCP 设计变更合同", summary: "", stage: "开发", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir, startAt: "", dueAt: "",
    });
    const foreignProject = store.insertProject({
      code: "MCPCHANGEF", name: "MCP 外部项目", summary: "", stage: "开发", health: "正常", progress: 0,
      riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir, startAt: "", dueAt: "",
    });
    const main = store.listDiagrams(project.id).find((item) => item.type === "main")!;
    const foreignMain = store.listDiagrams(foreignProject.id).find((item) => item.type === "main")!;
    const diagram = store.updateDiagram(main.id, { nodes: [...main.nodes,
      { id: "mcp-change-node", kind: "feature", label: "MCP 变更节点", description: "", owner: "team", acceptanceCriteria: "可验证", requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160 },
      { id: "mcp-other-node", kind: "feature", label: "MCP 其他节点", description: "", owner: "team", acceptanceCriteria: "可验证", requirementStatus: "已批准", designStatus: "已批准", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 820, y: 160 },
    ] })!;
    const document = store.insertDesignDoc({ projectId: project.id, category: "功能说明", title: "MCP 变更设计", summary: "", status: "已批准", version: "1.0", author: "designer", sourceUrl: "", content: "旧设计" });
    store.insertDocumentReference({ projectId: project.id, documentId: document.id, targetType: "diagramNode", targetId: "mcp-change-node", relationType: "defines" });
    const foreignDocument = store.insertDesignDoc({ projectId: foreignProject.id, category: "功能说明", title: "MCP 外部设计", summary: "", status: "已批准", version: "1.0", author: "designer", sourceUrl: "", content: "外部设计" });
    const roleAssignments = {
      designer: { agentId: "designer-id", displayName: "Designer" },
      builder: { agentId: "builder-id", displayName: "Builder" },
      auditor: { agentId: "auditor-id", displayName: "Auditor" },
    };
    const plan = store.insertPlan({ projectId: project.id, diagramId: diagram.id, diagramNodeId: "mcp-change-node", parentId: null, kind: "task", title: "MCP 变更计划", description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "", roleAssignments });
    const otherPlan = store.insertPlan({ projectId: project.id, diagramId: diagram.id, diagramNodeId: "mcp-other-node", parentId: null, kind: "task", title: "MCP 其他计划", description: "", status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "", roleAssignments });
    const basePayload = {
      projectRef: project.id, diagramId: diagram.id, nodeId: "mcp-change-node", actor: "manager", reason: "设计错误",
      changeSummary: "修订设计", requirementImpact: false, impactedDocumentIds: [document.id], impactedPlanIds: [plan.id],
      reusableWorkSummary: "", reworkScope: "重新实现", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: diagram.updatedAt, idempotencyKey: "mcp-design-change-idempotency",
    };
    const negativeCases = [
      { patch: { diagramId: foreignMain.id }, code: "DIAGRAM_PROJECT_MISMATCH" },
      { patch: { nodeId: "missing-node" }, code: "NODE_NOT_FOUND" },
      { patch: { impactedDocumentIds: [foreignDocument.id] }, code: "DOCUMENT_SCOPE_MISMATCH" },
      { patch: { impactedPlanIds: [otherPlan.id] }, code: "PLAN_SCOPE_MISMATCH" },
      { patch: { expectedUpdatedAt: "stale-revision" }, code: "DIAGRAM_REVISION_CONFLICT" },
    ];
    for (const [index, testCase] of negativeCases.entries()) {
      const response = await client.callTool("request_design_change", { ...basePayload, ...testCase.patch, idempotencyKey: `mcp-negative-${index}` });
      expect(mcpResultText(response, 100_000)).toContain(testCase.code);
    }
    expect(store.getDesignDoc(document.id)).toMatchObject({ status: "已批准", currentRevisionId: document.currentRevisionId });
    expect(store.getPlan(plan.id)).toMatchObject({ lifecycleStatus: plan.lifecycleStatus });

    const created = await client.callTool("request_design_change", basePayload);
    const createdText = mcpResultText(created, 100_000);
    expect(createdText).toContain('"changeId"');
    const replay = await client.callTool("request_design_change", basePayload);
    expect(mcpResultText(replay, 100_000)).toBe(createdText);
    const conflict = await client.callTool("request_design_change", { ...basePayload, reason: "另一个设计错误" });
    expect(mcpResultText(conflict, 100_000)).toContain("IDEMPOTENCY_CONFLICT");
  });
});

describe("scoped requirement revision", () => {
  it("routes an existing pending change to Designer, limits edits, then unlocks independent approval", async () => {
    const project = store.insertProject({
      code: "MCP-REQ-REV", name: "节点需求修订", summary: "修正过时验收条件", stage: "设计", health: "正常",
      progress: 0, riskLevel: "P1", riskSummary: "", blockerSummary: "", nextStep: "", repositoryPath: dataDir,
      startAt: "", dueAt: "",
    });
    const brief = store.insertDesignDoc({ projectId: project.id, category: "需求文档", title: "项目简报", summary: "",
      status: "已批准", version: "1", author: "manager", content: "需求必须先修订再批准" });
    store.insertDocumentReference({ projectId: project.id, documentId: brief.id, targetType: "project", targetId: project.id, relationType: "defines" });
    const main = store.insertDiagram({ projectId: project.id, title: "Profile 子画布", type: "functional", nodes: [], edges: [] });
    const changeId = "00000000-0000-4000-8000-000000000091";
    const targetId = "legacy-pending-requirement";
    const otherId = "unrelated-requirement";
    store.updateDiagram(main.id, { nodes: [...main.nodes,
      { id: targetId, kind: "feature", label: "旧需求", description: "旧说明", owner: "team", acceptanceCriteria: "旧标准",
        requirementStatus: "待评审", designStatus: "进行中", developmentStatus: "未开发", acceptanceStatus: "未验收",
        blockedReason: `设计变更处理中 · ${changeId}`, x: 100, y: 100 },
      { id: otherId, kind: "feature", label: "其他需求", description: "独立范围", owner: "team", acceptanceCriteria: "不变",
        requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 300, y: 100 },
    ] });
    const systemMain = store.listDiagrams(project.id).find((diagram) => diagram.type === "main")!;
    store.updateDiagram(systemMain.id, { nodes: [...systemMain.nodes, {
      id: targetId, kind: "feature", label: "同 ID 的另一画布节点", description: "独立需求", owner: "team",
      acceptanceCriteria: "不受本工单影响", requirementStatus: "已批准", designStatus: "进行中",
      developmentStatus: "未开发", acceptanceStatus: "未验收", x: 400, y: 100,
    }] });
    store.insertGovernance({ id: changeId, projectId: project.id, type: "decision", title: "正式需求变更",
      content: JSON.stringify({ diagramId: main.id, nodeId: targetId, requirementImpact: true }),
      rationale: "旧需求错误", status: "有效", author: "Main Agent" });
    store.db.exec(`CREATE TABLE IF NOT EXISTS design_change_requests (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      change_id TEXT NOT NULL UNIQUE, response_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
    store.db.prepare("INSERT INTO design_change_requests VALUES (?, ?, ?, ?, ?)").run("mcp-formal-change", "digest", changeId,
      JSON.stringify({ changeId, projectId: project.id, diagramId: main.id, nodeId: targetId }), new Date().toISOString());
    const task = listClaimableAgentTasks(store, project.id).find((item) => item.nodeId === targetId && item.actionCode === "revise_node_requirement")!;
    expect(task).toMatchObject({ available: true, taskRevision: `revise_node_requirement:${changeId}` });
    expect(task.id).toBe(`design:${main.id}:${targetId}`);
    expect(listClaimableAgentTasks(store, project.id).some((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")).toBe(false);
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    const call = (name: string, args: Record<string, unknown>) =>
      (external as unknown as { request: (method: string, params: unknown) => Promise<unknown> })
        .request("tools/call", { name, arguments: args }) as Promise<AgentMcpResult>;
    try {
      const packet = JSON.parse(mcpResultText(await call("get_agent_task_package", {
        projectRef: project.id, taskId: task.id, role: "designer", agentId: task.assignee!.agentId,
        workerId: "requirement-editor", idempotencyKey: "claim-requirement-editor",
      }), 100_000)) as { lease: { workOrderId: string; leaseToken: string; taskKey: string; taskRevision: string; workerId: string; agentId: string };
        roleBlueprint: { allowedMcpTools: string[] } };
      expect(packet.roleBlueprint.allowedMcpTools).toEqual(expect.arrayContaining(["get_diagram", "mutate_diagram", "validate_diagram"]));
      expect(packet.roleBlueprint.allowedMcpTools).not.toContain("patch_design_doc");
      const context = { workOrderId: packet.lease.workOrderId, leaseToken: packet.lease.leaseToken,
        taskKey: packet.lease.taskKey, taskRevision: packet.lease.taskRevision, workerId: packet.lease.workerId,
        agentId: packet.lease.agentId, role: "designer" };
      const update = (nodeId: string, patch: Record<string, unknown>, key: string) => call("mutate_diagram", {
        ...context, diagramId: main.id, expectedUpdatedAt: store.getDiagram(main.id)!.updatedAt,
        operations: [{ op: "update_node", nodeId, patch }], idempotencyKey: key,
      });
      expect(mcpResultText(await update(targetId, { acceptanceCriteria: "修订标准" }, "before-start"), 10_000)).toContain("NODE_REQUIREMENT_SCOPE_REQUIRED");
      const started = mcpResultText(await call("start_agent_task", { ...context, baselineRevision: "forged",
        idempotencyKey: "start-requirement-editor" }), 10_000);
      expect(started).toContain("running");
      expect(started).not.toContain("forged");
      expect(mcpResultText(await call("complete_agent_task", { ...context, idempotencyKey: "premature-requirement-complete",
        resultDigest: "尚未修改" }), 10_000)).toContain("NODE_REQUIREMENT_REVISION_INCOMPLETE");
      expect(mcpResultText(await update(targetId, { description: "临时说明" }, "temporary-edit"), 10_000)).toContain("已原子执行");
      expect(mcpResultText(await update(targetId, { description: "旧说明" }, "restore-original"), 10_000)).toContain("已原子执行");
      expect(mcpResultText(await call("complete_agent_task", { ...context, idempotencyKey: "restored-complete",
        resultDigest: "改回原值" }), 10_000)).toContain("NODE_REQUIREMENT_REVISION_INCOMPLETE");
      const staleDiagram = store.getDiagram(main.id)!;
      store.updateDiagram(main.id, { nodes: staleDiagram.nodes.map((node) => node.id === targetId
        ? { ...node, blockedReason: "设计变更处理中 · 00000000-0000-4000-8000-000000000092" } : node) });
      expect(mcpResultText(await update(targetId, { acceptanceCriteria: "旧租约越界" }, "stale-change"), 10_000)).toContain("NODE_REQUIREMENT_SCOPE_REQUIRED");
      const restoredDiagram = store.getDiagram(main.id)!;
      store.updateDiagram(main.id, { nodes: restoredDiagram.nodes.map((node) => node.id === targetId
        ? { ...node, blockedReason: `设计变更处理中 · ${changeId}` } : node) });
      expect(mcpResultText(await update(otherId, { acceptanceCriteria: "越界" }, "other-node"), 10_000)).toContain("NODE_REQUIREMENT_SCOPE_REQUIRED");
      expect(mcpResultText(await update(targetId, { acceptanceStatus: "已通过" }, "forbidden-field"), 10_000)).toContain("NODE_REQUIREMENT_SCOPE_REQUIRED");
      expect(mcpResultText(await update(targetId, { kind: "note" }, "forbidden-kind"), 10_000)).toContain("NODE_REQUIREMENT_SCOPE_REQUIRED");
      expect(mcpResultText(await call("update_diagram", { ...context, diagramId: main.id,
        nodes: store.getDiagram(main.id)!.nodes, idempotencyKey: "whole-diagram" }), 10_000)).toContain("ACTION_MISMATCH");
      const trusted = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir, trustedInternal: true }));
      try {
        const deletion = await (trusted as unknown as { request: (method: string, params: unknown) => Promise<AgentMcpResult> })
          .request("tools/call", { name: "delete_diagram", arguments: { diagramId: main.id, confirm: true } });
        expect(mcpResultText(deletion, 10_000))
          .toContain("NODE_REQUIREMENT_REVISION_REQUIRED");
      } finally { await trusted.close(); }
      expect(mcpResultText(await update(targetId, { acceptanceCriteria: "新标准", mainFlow: "进入 Profile → 禁用 MFA → 回查因子", requirementStatus: "待评审" }, "edit-requirement"), 10_000)).toContain("已原子执行");
      expect(listClaimableAgentTasks(store, project.id).some((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")).toBe(false);
      store.updateGovernance(changeId, { status: "已废弃" });
      expect(mcpResultText(await call("complete_agent_task", { ...context, idempotencyKey: "revoked-complete",
        resultDigest: "失效来源不得完工" }), 10_000)).toContain("NODE_REQUIREMENT_REVISION_INVALID");
      store.updateGovernance(changeId, { status: "有效" });
      expect(mcpResultText(await call("complete_agent_task", { ...context, idempotencyKey: "complete-requirement-editor",
        resultDigest: "已修正验收标准与流程，提交独立需求审批" }), 10_000)).toContain("completed");
      expect(listClaimableAgentTasks(store, project.id)).toEqual(expect.arrayContaining([expect.objectContaining({
        nodeId: targetId, actionCode: "approve_node_requirement", available: true,
      })]));
      expect(store.getDiagram(main.id)?.nodes.find((node) => node.id === targetId)?.requirementStatus).toBe("待评审");
      const approvalRevision = listClaimableAgentTasks(store, project.id)
        .find((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")!.taskRevision;
      const beforeFlowEdit = store.getDiagram(main.id)!;
      store.updateDiagram(main.id, { nodes: beforeFlowEdit.nodes.map((node) => node.id === targetId
        ? { ...node, mainFlow: "修订后的另一流程" } : node) });
      expect(listClaimableAgentTasks(store, project.id)
        .find((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")!.taskRevision).not.toBe(approvalRevision);
      const conflictPlan = store.insertPlan({
        projectId: project.id, diagramId: main.id, diagramNodeId: targetId, parentId: null,
        kind: "task", title: "同节点实现", description: "", status: "未开始", priority: "P1", progress: 0,
        owner: "builder", versionTag: "v1", startAt: "", dueAt: "", dependencyIds: [], blockedReason: "", completedAt: "",
        lifecycleStatus: "approved", proposedBy: "designer", submittedAt: "2026-09-27T00:00:00.000Z",
        approvedBy: "manager", approvedAt: "2026-09-27T00:01:00.000Z",
        roleAssignments: { designer: { agentId: "plan-designer", displayName: "Designer" },
          builder: { agentId: "Main Agent", displayName: "Builder" },
          auditor: { agentId: "plan-auditor", displayName: "Auditor" } },
      });
      let approvalTask = listClaimableAgentTasks(store, project.id)
        .find((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")!;
      expect(mcpResultText(await call("get_agent_task_package", {
        projectRef: project.id, taskId: approvalTask.id, taskKey: approvalTask.taskKey,
        role: "approver", agentId: "Main Agent", workerId: "independent-requirement-approver",
        idempotencyKey: "reject-self-approval",
      }), 10_000)).toContain("SELF_APPROVAL_FORBIDDEN");
      store.updatePlan(conflictPlan.id, { roleAssignments: { ...conflictPlan.roleAssignments,
        builder: { agentId: "plan-builder", displayName: "Builder" } } });
      const historicalTaskKey = `historical-builder:${conflictPlan.id}`;
      store.db.prepare(`INSERT INTO agent_task_leases (id, task_key, task_id, task_revision, project_id, queue, role,
        action_code, status, lease_token, agent_id, worker_id, lease_expires_at, claimed_at, heartbeat_at, updated_at)
        VALUES (?, ?, ?, 'old', ?, 'development', 'builder', 'develop_plan', 'completed', ?, ?, ?, ?, ?, ?, ?)`).run(
        historicalTaskKey, historicalTaskKey, `development:${conflictPlan.id}`, project.id,
        historicalTaskKey, "Main Agent", "historical-builder", new Date().toISOString(),
        new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
      approvalTask = listClaimableAgentTasks(store, project.id)
        .find((item) => item.nodeId === targetId && item.actionCode === "approve_node_requirement")!;
      expect(mcpResultText(await call("get_agent_task_package", {
        projectRef: project.id, taskId: approvalTask.id, taskKey: approvalTask.taskKey,
        role: "approver", agentId: "Main Agent", workerId: "independent-requirement-approver",
        idempotencyKey: "reject-historical-builder",
      }), 10_000)).toContain("SELF_APPROVAL_FORBIDDEN");
      store.db.prepare("DELETE FROM agent_task_leases WHERE task_key=?").run(historicalTaskKey);
      const approval = JSON.parse(mcpResultText(await call("get_agent_task_package", {
        projectRef: project.id, taskId: approvalTask.id, taskKey: approvalTask.taskKey,
        role: "approver", agentId: "Main Agent", workerId: "independent-requirement-approver",
        idempotencyKey: "claim-requirement-approver",
      }), 100_000)) as { lease: typeof packet.lease };
      const approvalContext = { workOrderId: approval.lease.workOrderId, leaseToken: approval.lease.leaseToken,
        taskKey: approval.lease.taskKey, taskRevision: approval.lease.taskRevision,
        workerId: approval.lease.workerId, agentId: approval.lease.agentId, role: "approver" };
      expect(mcpResultText(await call("start_agent_task", { ...approvalContext, idempotencyKey: "start-requirement-approver" }), 10_000)).toContain("running");
      expect(mcpResultText(await call("complete_agent_task", { ...approvalContext, idempotencyKey: "complete-requirement-approver",
        resultDigest: "已独立复核当前需求与流程" }), 10_000)).toContain("completed");
      expect(store.getDiagram(main.id)?.nodes.find((node) => node.id === targetId)?.requirementStatus).toBe("已批准");
    } finally { await external.close(); }
  });
});

describe("delegated high-risk delete is scoped to the lease work scope", () => {
  it("keeps the human-only default, then allows exactly the in-scope leased node and audits it", async () => {
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    try {
      const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
      const scopedNodeId = "mcp-hr-scoped-node";
      const otherNodeId = "mcp-hr-other-node";
      store.updateDiagram(main.id, { nodes: [...(store.getDiagram(main.id)?.nodes ?? []), {
        id: scopedNodeId, kind: "feature", label: "委派作用域内", description: "", owner: "team",
        acceptanceCriteria: "只允许作用域内删除", requirementStatus: "已批准", designStatus: "已批准",
        developmentStatus: "开发中", acceptanceStatus: "未验收", requiresDatabase: false, x: 40, y: 40,
      }, {
        id: otherNodeId, kind: "feature", label: "作用域外", description: "", owner: "team",
        acceptanceCriteria: "不得被委派删除", requirementStatus: "已批准", designStatus: "已批准",
        developmentStatus: "开发中", acceptanceStatus: "未验收", requiresDatabase: false, x: 80, y: 40,
      }] });

      const approvedDoc = store.insertDesignDoc({
        projectId, category: "功能说明", title: "作用域内设计", summary: "", status: "已批准",
        version: "v1.0", author: "designer", content: "作用域内",
      });
      store.insertDocumentReference({ projectId, documentId: approvedDoc.id, targetType: "diagramNode", targetId: scopedNodeId, relationType: "defines" });
      const staleDoc = store.insertDesignDoc({
        projectId, category: "功能说明", title: "过期修订设计", summary: "", status: "已批准",
        version: "v0.9", author: "designer", content: "过期",
      });
      const staleRef = store.insertDocumentReference({ projectId, documentId: staleDoc.id, targetType: "diagramNode", targetId: scopedNodeId, relationType: "defines" });
      const outsideDoc = store.insertDesignDoc({
        projectId, category: "功能说明", title: "作用域外设计", summary: "", status: "已批准",
        version: "v1.0", author: "designer", content: "作用域外",
      });
      const outsideRef = store.insertDocumentReference({ projectId, documentId: outsideDoc.id, targetType: "diagramNode", targetId: otherNodeId, relationType: "defines" });

      const plan = store.insertPlan({
        projectId, diagramId: main.id, diagramNodeId: scopedNodeId, parentId: null, kind: "task", title: "作用域内委派任务", description: "",
        status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "",
        dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer",
        submittedAt: "2026-08-30T03:00:00.000Z", approvedBy: "manager", approvedAt: "2026-08-30T03:05:00.000Z",
        roleAssignments: {
          designer: { agentId: "hr-designer", displayName: "Designer" },
          builder: { agentId: "hr-builder", displayName: "Builder" },
          auditor: { agentId: "hr-auditor", displayName: "Auditor" },
        },
      });
      const packageResult = await external.callTool("get_agent_task_package", {
        projectRef: projectId, role: "builder", agentId: "hr-builder", workerId: "hr-worker-1",
        taskId: `development:${plan.id}`, idempotencyKey: "hr-delegate-claim",
      });
      const taskPackage = JSON.parse(mcpResultText(packageResult, 100_000)) as {
        lease: { workOrderId: string; leaseToken: string; taskKey: string; taskRevision: string; agentId: string; workerId: string; workScopes: string[] };
      };
      expect(taskPackage.lease.workScopes).toEqual([`node:${main.id}:${scopedNodeId}`]);
      const leaseContext = {
        workOrderId: taskPackage.lease.workOrderId, leaseToken: taskPackage.lease.leaseToken,
        taskKey: taskPackage.lease.taskKey, taskRevision: taskPackage.lease.taskRevision,
        workerId: taskPackage.lease.workerId, agentId: taskPackage.lease.agentId, role: "builder",
      };

      // The HTTP /mcp surface is not limited to the console built-in agent surface
      // (AGENT_MCP_TOOL_NAMES); use the raw JSON-RPC tool call to emulate an external agent.
      const callExternalTool = (target: LocalMcpClient, name: string, args: Record<string, unknown>) =>
        (target as unknown as { request: (method: string, params: unknown) => Promise<unknown> })
          .request("tools/call", { name, arguments: args }) as Promise<AgentMcpResult>;

      // 1) no work-order context: the original human-only refusal must stay intact
      const withoutContext = await callExternalTool(external, "delete_document_reference", { referenceId: staleRef.id, confirm: true });
      expect(mcpResultText(withoutContext, 10_000)).toContain("HIGH_RISK_HUMAN_REQUIRED");
      expect(store.getDocumentReference(staleRef.id)).toBeTruthy();

      // 2) leased but without explicit confirmation: still refused, nothing deleted
      const withoutConfirm = await callExternalTool(external, "delete_document_reference", { ...leaseContext, referenceId: staleRef.id, idempotencyKey: "hr-delegate-noconfirm" });
      expect(mcpResultText(withoutConfirm, 10_000)).toContain("HIGH_RISK_HUMAN_REQUIRED");
      expect(store.getDocumentReference(staleRef.id)).toBeTruthy();

      // 3) leased, in scope, confirmed: delegated and recorded in security_audit_events
      const delegated = await callExternalTool(external, "delete_document_reference", { ...leaseContext, referenceId: staleRef.id, confirm: true, idempotencyKey: "hr-delegate-ok" });
      expect(mcpResultText(delegated, 10_000)).toContain("deletedId");
      expect(store.getDocumentReference(staleRef.id)).toBeFalsy();
      const auditRow = store.db.prepare("SELECT action, risk_class, actor_type, result FROM security_audit_events WHERE work_order_id=? AND result='success'")
        .get(taskPackage.lease.workOrderId);
      expect(auditRow).toEqual(expect.objectContaining({
        action: "delete_document_reference", risk_class: "high", actor_type: "agent", result: "success",
      }));

      // 4) leased but the reference belongs to another node: refused, nothing deleted
      const outOfScope = await callExternalTool(external, "delete_document_reference", { ...leaseContext, referenceId: outsideRef.id, confirm: true, idempotencyKey: "hr-delegate-scope" });
      expect(mcpResultText(outOfScope, 10_000)).toContain("HIGH_RISK_SCOPE_REQUIRED");
      expect(store.getDocumentReference(outsideRef.id)).toBeTruthy();
    } finally {
      await external.close();
    }
  });
});

describe("scope-guarded governance correction", () => {
  it("requires a work scope and explicit confirmation, then records the correction", async () => {
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    const callTool = (name: string, args: Record<string, unknown>) =>
      (external as unknown as { request: (method: string, params: unknown) => Promise<unknown> })
        .request("tools/call", { name, arguments: args }) as Promise<AgentMcpResult>;
    try {
      const main = store.listDiagrams(projectId).find((diagram) => diagram.type === "main")!;
      const scopedNodeId = "mcp-gov-scoped-node";
      const otherNodeId = "mcp-gov-other-node";
      store.updateDiagram(main.id, { nodes: [...(store.getDiagram(main.id)?.nodes ?? []), {
        id: scopedNodeId, kind: "feature", label: "治理作用域内", description: "", owner: "team",
        acceptanceCriteria: "允许修正", requirementStatus: "已批准", designStatus: "已批准",
        developmentStatus: "开发中", acceptanceStatus: "未验收", requiresDatabase: false, x: 200, y: 200,
      }, {
        id: otherNodeId, kind: "feature", label: "治理作用域外", description: "", owner: "team",
        acceptanceCriteria: "不允许修正", requirementStatus: "已批准", designStatus: "已批准",
        developmentStatus: "开发中", acceptanceStatus: "未验收", requiresDatabase: false, x: 240, y: 200,
      }] });

      const scopedDoc = store.insertDesignDoc({
        projectId, category: "功能说明", title: "治理作用域设计", summary: "", status: "已批准",
        version: "v1.0", author: "designer", content: "治理作用域",
      });
      store.insertDocumentReference({ projectId, documentId: scopedDoc.id, targetType: "diagramNode", targetId: scopedNodeId, relationType: "defines" });

      const governance = store.insertGovernance({
        projectId, type: "decision", title: "设计变更 · 治理作用域",
        content: JSON.stringify({ diagramId: main.id, nodeId: scopedNodeId, impactedDocumentIds: [scopedDoc.id], impactedPlanIds: [] }),
        rationale: "", status: "有效", author: "designer",
      });
      const outsideGovernance = store.insertGovernance({
        projectId, type: "decision", title: "设计变更 · 作用域外",
        content: JSON.stringify({ diagramId: main.id, nodeId: otherNodeId, impactedDocumentIds: [scopedDoc.id], impactedPlanIds: [] }),
        rationale: "", status: "有效", author: "designer",
      });

      const plan = store.insertPlan({
        projectId, diagramId: main.id, diagramNodeId: scopedNodeId, parentId: null, kind: "task", title: "治理作用域任务", description: "",
        status: "未开始", priority: "P1", progress: 0, owner: "builder", versionTag: "v1", startAt: "", dueAt: "",
        dependencyIds: [], blockedReason: "", completedAt: "", lifecycleStatus: "approved", proposedBy: "designer",
        submittedAt: "2026-08-30T04:00:00.000Z", approvedBy: "manager", approvedAt: "2026-08-30T04:05:00.000Z",
        roleAssignments: {
          designer: { agentId: "gov-designer", displayName: "Designer" },
          builder: { agentId: "gov-builder", displayName: "Builder" },
          auditor: { agentId: "gov-auditor", displayName: "Auditor" },
        },
      });
      const packageResult = await external.callTool("get_agent_task_package", {
        projectRef: projectId, role: "builder", agentId: "gov-builder", workerId: "gov-worker-1",
        taskId: `development:${plan.id}`, idempotencyKey: "gov-claim",
      });
      const taskPackage = JSON.parse(mcpResultText(packageResult, 100_000)) as {
        lease: { workOrderId: string; leaseToken: string; taskKey: string; taskRevision: string; agentId: string; workerId: string; workScopes: string[] };
      };
      expect(taskPackage.lease.workScopes).toEqual([`node:${main.id}:${scopedNodeId}`]);
      const leaseContext = {
        workOrderId: taskPackage.lease.workOrderId, leaseToken: taskPackage.lease.leaseToken,
        taskKey: taskPackage.lease.taskKey, taskRevision: taskPackage.lease.taskRevision,
        workerId: taskPackage.lease.workerId, agentId: taskPackage.lease.agentId, role: "builder",
      };

      // 1) without a work-order context the record must not change
      const withoutContext = await callTool("patch_governance", { governanceId: governance.id, rationale: "不应生效" });
      expect(mcpResultText(withoutContext, 10_000)).not.toContain("治理记录已更新");
      expect(store.getGovernance(governance.id)!.rationale).toBe("");

      // 2) in scope but not explicitly confirmed: refused
      const withoutConfirm = await callTool("patch_governance", { ...leaseContext, governanceId: governance.id, rationale: "未确认", idempotencyKey: "gov-noconfirm" });
      expect(mcpResultText(withoutConfirm, 10_000)).toContain("CONFIRM_REQUIRED");
      expect(store.getGovernance(governance.id)!.rationale).toBe("");

      // 3) confirmed but outside the lease work scope: refused
      const outOfScope = await callTool("patch_governance", { ...leaseContext, governanceId: outsideGovernance.id, rationale: "作用域外", confirm: true, idempotencyKey: "gov-outscope" });
      expect(mcpResultText(outOfScope, 10_000)).toContain("GOVERNANCE_SCOPE_REQUIRED");
      expect(store.getGovernance(outsideGovernance.id)!.rationale).toBe("");

      // 4) in scope and confirmed: applied and recorded as a controlled scoped write
      const applied = await callTool("patch_governance", { ...leaseContext, governanceId: governance.id, rationale: "受影响文档已由 v3.1.0 收敛为 v3.3.0 生效真源", confirm: true, idempotencyKey: "gov-ok" });
      expect(mcpResultText(applied, 10_000)).toContain("治理记录已更新");
      expect(store.getGovernance(governance.id)!.rationale).toBe("受影响文档已由 v3.1.0 收敛为 v3.3.0 生效真源");
      const auditRow = store.db.prepare("SELECT action, risk_class, actor_type, result FROM security_audit_events WHERE work_order_id=? AND action='patch_governance' AND result='success'")
        .get(taskPackage.lease.workOrderId);
      expect(auditRow).toEqual(expect.objectContaining({
        action: "patch_governance", risk_class: "controlled", actor_type: "agent", result: "success",
      }));
      const deniedCount = store.db.prepare("SELECT COUNT(*) AS c FROM security_audit_events WHERE work_order_id=? AND action='patch_governance' AND result='denied'")
        .get(taskPackage.lease.workOrderId) as { c: number };
      expect(deniedCount.c).toBe(2);
    } finally {
      await external.close();
    }
  });
});
