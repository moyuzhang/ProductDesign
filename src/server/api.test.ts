import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./index.js";
import * as orchestration from "./orchestration.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-api-"));
const dbPath = join(dataDir, "api-test.db");
const codexBinRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : "";
const localCodexAvailable = Boolean(codexBinRoot && existsSync(codexBinRoot) && readdirSync(codexBinRoot, { withFileTypes: true })
  .some((entry) => entry.isDirectory() && existsSync(join(codexBinRoot, entry.name, "codex.exe"))));

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = buildApp({ dbPath, dataDir, trustedInternalApi: true });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("REST API", () => {
  let projectId = "";

  it("health check responds ok", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const payload = res.json() as { ok: boolean; time: string; localTime: string; timeZone: string };
    expect(payload.ok).toBe(true);
    expect(payload.time).toMatch(/Z$/);
    expect(payload.localTime).toMatch(/\+08:00$/);
    expect(payload.timeZone).toBe("Asia/Shanghai");
    expect(Date.parse(payload.localTime)).toBe(Date.parse(payload.time));
  });

  it("keeps REST/Web task listing and package claims consistent for an unplanned design node", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/projects", payload: { code: "PREPLANREST", name: "REST 无计划设计任务" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const restProjectId = created.json().id as string;
    const configured = await app.inject({
      method: "PATCH", url: `/api/projects/${restProjectId}`, payload: { repositoryPath: dataDir },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const brief = await app.inject({
      method: "POST", url: "/api/design-docs", payload: {
        projectId: restProjectId, category: "需求文档", title: "项目简报", summary: "", status: "已批准",
        version: "1.0", author: "manager", content: "无计划设计任务 REST 合同",
        references: [{ targetType: "project", targetId: restProjectId, relationType: "defines" }],
      },
    });
    expect(brief.statusCode, brief.body).toBe(200);
    const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${restProjectId}` });
    const main = diagrams.json().find((item: { type: string }) => item.type === "main");
    const nodeId = "rest-preplan-design";
    const seeded = await app.inject({
      method: "PATCH", url: `/api/diagrams/${main.id}`, payload: { nodes: [...main.nodes, {
        id: nodeId, kind: "feature", label: "REST 设计节点", description: "验证列表与领取一致",
        owner: "designer", acceptanceCriteria: "REST 返回身份可直接领取",
        requirementStatus: "已批准", designStatus: "进行中", developmentStatus: "未开发",
        acceptanceStatus: "未验收", x: 600, y: 160,
      }] },
    });
    expect(seeded.statusCode, seeded.body).toBe(200);

    const listed = await app.inject({
      method: "GET", url: `/api/projects/${restProjectId}/agent-tasks?role=designer`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const task = listed.json().find((item: { nodeId: string }) => item.nodeId === nodeId);
    expect(task).toMatchObject({
      id: `design:${nodeId}`, planItemId: null, available: true,
    });
    expect(task.assignee.agentId).toMatch(new RegExp(`^design-node-${nodeId}-[0-9a-f]{16}$`));
    expect(task.poolId).toBe(`pool:${restProjectId}:designer:${task.assignee.agentId}`);

    const claimPayload = {
      role: "designer", agentId: task.assignee.agentId, workerId: "rest-preplan-worker",
      poolId: task.poolId, idempotencyKey: "rest-preplan-claim",
    };
    const build = orchestration.buildAgentTaskPackage;
    const packageFailure = vi.spyOn(orchestration, "buildAgentTaskPackage").mockImplementationOnce((...args) => {
      build(...args);
      throw new orchestration.AgentTaskPackageError(409, "WORKING_DIRECTORY_NOT_READY", "Injected package failure");
    });
    const failed = await app.inject({ method: "POST", url: `/api/projects/${restProjectId}/agent-task-package`, payload: claimPayload });
    packageFailure.mockRestore();
    expect(failed.statusCode).toBe(409);
    expect(failed.json().code).toBe("WORKING_DIRECTORY_NOT_READY");
    const claimed = await app.inject({ method: "POST", url: `/api/projects/${restProjectId}/agent-task-package`, payload: claimPayload });
    const replay = await app.inject({ method: "POST", url: `/api/projects/${restProjectId}/agent-task-package`, payload: claimPayload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().lease).toEqual(claimed.json().lease);
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json()).toMatchObject({
      assignment: task.assignee,
      worker: { agentId: task.assignee.agentId, workerId: "rest-preplan-worker", poolId: task.poolId },
      planSnapshot: null,
      node: { nodeId, label: "REST 设计节点" },
      lease: { agentId: task.assignee.agentId, poolId: task.poolId },
    });

    const manualRelease = await app.inject({
      method: "POST", url: `/api/projects/${restProjectId}/agent-task-leases/${claimed.json().lease.workOrderId}/release`,
      payload: { reason: "REST 人用租约管理回归" },
    });
    expect(manualRelease.statusCode, manualRelease.body).toBe(200);
    expect(manualRelease.json()).toMatchObject({ workOrderId: claimed.json().lease.workOrderId, status: "released" });
    expect(manualRelease.json().leaseToken).toBeUndefined();

    const reclaimed = await app.inject({ method: "POST", url: `/api/projects/${restProjectId}/agent-task-package`, payload: {
      ...claimPayload, workerId: "rest-preplan-worker-2", idempotencyKey: "rest-preplan-reclaim",
    } });
    expect(reclaimed.statusCode, reclaimed.body).toBe(200);
    const released = await app.inject({
      method: "POST", url: "/api/agent-task-leases/release", payload: {
        leaseToken: reclaimed.json().lease.leaseToken,
        agentId: task.assignee.agentId,
        idempotencyKey: "rest-preplan-release",
      },
    });
    expect(released.statusCode, released.body).toBe(200);
  });

  it("exposes the governed design-change contract", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/api/projects/missing-project/design-changes",
      payload: {
        diagramId: "missing-diagram", nodeId: "missing-node", actor: "manager",
        reason: "设计错误", changeSummary: "修订设计", requirementImpact: false,
        impactedDocumentIds: ["missing-document"], impactedPlanIds: ["missing-plan"],
        reusableWorkSummary: "", reworkScope: "重新实现", apiImpact: "", databaseImpact: "", deploymentImpact: "",
        expectedUpdatedAt: "2026-09-01T00:00:00.000Z", idempotencyKey: "api-design-change-contract",
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("enforces REST design-change rollback, idempotency, ownership and diagram revision contracts", async () => {
    const project = await app.inject({ method: "POST", url: "/api/projects", payload: { code: "DCRAPI", name: "REST 设计变更合同" } });
    const foreignProject = await app.inject({ method: "POST", url: "/api/projects", payload: { code: "DCRAPIF", name: "REST 外部项目" } });
    const contractProjectId = project.json().id as string;
    const foreignProjectId = foreignProject.json().id as string;
    const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${contractProjectId}` });
    const foreignDiagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${foreignProjectId}` });
    const main = diagrams.json().find((item: { type: string }) => item.type === "main");
    const foreignMain = foreignDiagrams.json().find((item: { type: string }) => item.type === "main");
    const seeded = await app.inject({
      method: "PATCH", url: `/api/diagrams/${main.id}`,
      payload: { nodes: [...main.nodes,
        { id: "rest-change-node", kind: "feature", label: "REST 变更节点", description: "验证 REST 设计变更合同", owner: "team", acceptanceCriteria: "可验证", requirementStatus: "已批准", designStatus: "未开始", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 600, y: 160 },
        { id: "rest-other-node", kind: "feature", label: "REST 其他节点", description: "验证跨节点计划归属", owner: "team", acceptanceCriteria: "可验证", requirementStatus: "已批准", designStatus: "未开始", developmentStatus: "未开发", acceptanceStatus: "未验收", x: 820, y: 160 },
      ] },
    });
    expect(seeded.statusCode, seeded.body).toBe(200);
    const document = await app.inject({
      method: "POST", url: "/api/design-docs",
      payload: { projectId: contractProjectId, category: "功能说明", title: "REST 变更设计", summary: "", status: "已批准", version: "1.0", author: "designer", content: "旧设计", references: [{ targetType: "diagramNode", targetId: "rest-change-node", relationType: "defines" }] },
    });
    const foreignDocument = await app.inject({
      method: "POST", url: "/api/design-docs",
      payload: { projectId: foreignProjectId, category: "功能说明", title: "外部设计", summary: "", status: "已批准", version: "1.0", author: "designer", content: "外部设计", references: [{ targetType: "project", targetId: foreignProjectId, relationType: "defines" }] },
    });
    const plan = await app.inject({ method: "POST", url: "/api/plans", payload: { projectId: contractProjectId, diagramId: main.id, diagramNodeId: "rest-change-node", kind: "task", title: "REST 变更计划" } });
    const otherPlan = await app.inject({ method: "POST", url: "/api/plans", payload: { projectId: contractProjectId, diagramId: main.id, diagramNodeId: "rest-other-node", kind: "task", title: "REST 其他计划" } });
    expect(document.statusCode, document.body).toBe(200);
    expect(foreignDocument.statusCode, foreignDocument.body).toBe(200);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(otherPlan.statusCode, otherPlan.body).toBe(200);
    const currentDiagram = await app.inject({ method: "GET", url: `/api/diagrams/${main.id}` });
    const basePayload = {
      diagramId: main.id, nodeId: "rest-change-node", actor: "manager", reason: "设计错误", changeSummary: "修订设计",
      requirementImpact: false, impactedDocumentIds: [document.json().id], impactedPlanIds: [plan.json().id],
      reusableWorkSummary: "", reworkScope: "重新实现", apiImpact: "", databaseImpact: "", deploymentImpact: "",
      expectedUpdatedAt: currentDiagram.json().updatedAt, idempotencyKey: "rest-design-change-idempotency",
    };
    const negativeCases = [
      { patch: { diagramId: foreignMain.id }, code: "DIAGRAM_PROJECT_MISMATCH" },
      { patch: { nodeId: "missing-node" }, code: "NODE_NOT_FOUND" },
      { patch: { impactedDocumentIds: [foreignDocument.json().id] }, code: "DOCUMENT_SCOPE_MISMATCH" },
      { patch: { impactedPlanIds: [otherPlan.json().id] }, code: "PLAN_SCOPE_MISMATCH" },
      { patch: { expectedUpdatedAt: "stale-revision" }, code: "DIAGRAM_REVISION_CONFLICT" },
    ];
    for (const [index, testCase] of negativeCases.entries()) {
      const response = await app.inject({
        method: "POST", url: `/api/projects/${contractProjectId}/design-changes`,
        payload: { ...basePayload, ...testCase.patch, idempotencyKey: `rest-negative-${index}` },
      });
      expect(response.statusCode, response.body).toBe(testCase.code === "NODE_NOT_FOUND" ? 404 : 409);
      expect(response.json()).toMatchObject({ code: testCase.code });
    }
    const documentAfterFailures = await app.inject({ method: "GET", url: `/api/design-docs/${document.json().id}` });
    const planAfterFailures = await app.inject({ method: "GET", url: `/api/plans/${plan.json().id}` });
    expect(documentAfterFailures.json()).toMatchObject({ status: "已批准", currentRevisionId: document.json().currentRevisionId });
    expect(planAfterFailures.json()).toMatchObject({ lifecycleStatus: plan.json().lifecycleStatus });

    const created = await app.inject({ method: "POST", url: `/api/projects/${contractProjectId}/design-changes`, payload: basePayload });
    expect(created.statusCode, created.body).toBe(200);
    const replay = await app.inject({ method: "POST", url: `/api/projects/${contractProjectId}/design-changes`, payload: basePayload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(created.json());
    const conflict = await app.inject({
      method: "POST", url: `/api/projects/${contractProjectId}/design-changes`,
      payload: { ...basePayload, reason: "另一个设计错误" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("manages LLM profiles without exposing credential values", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/llm-profiles",
      payload: {
        name: "测试网关",
        provider: "Test Provider",
        protocol: "openai-responses",
        baseUrl: "https://llm.invalid/v1",
        apiKeyEnv: "PCS_TEST_LLM_KEY_NOT_SET",
        models: ["test-model"],
        defaultModel: "test-model",
        enabled: true,
        reasoningEffort: "max",
        timeoutMs: 1000,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().credentialConfigured).toBe(false);
    expect(created.json().reasoningEffort).toBe("max");
    expect(JSON.stringify(created.json())).not.toContain("api-key-value");
    const id = created.json().id;

    const invalid = await app.inject({
      method: "POST",
      url: "/api/llm-profiles",
      payload: {
        name: "无效默认模型", provider: "Test", protocol: "openai-chat",
        baseUrl: "https://llm.invalid/v1", apiKeyEnv: "PCS_TEST_LLM_KEY_NOT_SET",
        models: ["a"], defaultModel: "b",
      },
    });
    expect(invalid.statusCode).toBe(400);

    const checked = await app.inject({ method: "POST", url: `/api/llm-profiles/${id}/test`, payload: {} });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().status).toBe("missing_credential");

    const updated = await app.inject({ method: "PATCH", url: `/api/llm-profiles/${id}`, payload: { enabled: false } });
    expect(updated.json().enabled).toBe(false);

    const removed = await app.inject({ method: "DELETE", url: `/api/llm-profiles/${id}` });
    expect(removed.statusCode).toBe(200);
  });

  it("creates, reads and patches a project", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { code: "TEST1", name: "测试项目", stage: "规划", health: "正常" },
    });
    expect(created.statusCode).toBe(200);
    projectId = created.json().id;
    expect(created.json().code).toBe("TEST1");
    const managedRoot = join(dataDir, "projects", projectId);
    expect(existsSync(join(managedRoot, "project.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(managedRoot, "project.json"), "utf8")).id).toBe(projectId);
    for (const directory of ["docs", "diagrams", "db-models", "plans", "evidence", "files"]) {
      expect(existsSync(join(managedRoot, directory))).toBe(true);
    }

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { riskSummary: "风险待评估" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().riskSummary).toBe("风险待评估");

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { stage: "不存在的阶段" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("keeps documents project-owned and references immutable revisions", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/design-docs",
      payload: {
        projectId,
        category: "需求文档",
        title: "系统需求基线",
        summary: "项目范围",
        status: "已批准",
        version: "v1.0",
        content: "第一版",
        references: [{ targetType: "project", targetId: projectId, relationType: "defines" }],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().nodeId).toBeUndefined();
    const documentId = created.json().id as string;
    const firstRevisionId = created.json().currentRevisionId as string;

    const refs = await app.inject({ method: "GET", url: `/api/document-references?projectId=${projectId}&documentId=${documentId}` });
    expect(refs.json()).toHaveLength(1);
    const referenceId = refs.json()[0].id as string;
    expect(refs.json()[0].documentRevisionId).toBe(firstRevisionId);

    const updated = await app.inject({ method: "PATCH", url: `/api/design-docs/${documentId}`, payload: { version: "v1.1", content: "第二版" } });
    expect(updated.json().currentRevisionId).not.toBe(firstRevisionId);
    const staleRefs = await app.inject({ method: "GET", url: `/api/document-references?documentId=${documentId}` });
    expect(staleRefs.json()[0].documentRevisionId).toBe(firstRevisionId);

    const refreshed = await app.inject({ method: "PATCH", url: `/api/document-references/${referenceId}`, payload: { useCurrentRevision: true } });
    expect(refreshed.json().documentRevisionId).toBe(updated.json().currentRevisionId);
    const filtered = await app.inject({ method: "GET", url: `/api/design-docs?projectId=${projectId}&targetType=project&targetId=${projectId}` });
    expect(filtered.json().map((item: { id: string }) => item.id)).toContain(documentId);

    const pending = await app.inject({ method: "PATCH", url: `/api/design-docs/${documentId}`, payload: { status: "评审中", version: "v1.2", content: "待批准第三版" } });
    expect(pending.statusCode).toBe(200);
    const blockedRefresh = await app.inject({ method: "PATCH", url: `/api/document-references/${referenceId}`, payload: { useCurrentRevision: true } });
    expect(blockedRefresh.statusCode).toBe(409);
    expect(blockedRefresh.json().message).toContain("尚未批准");
    const stillApprovedRef = await app.inject({ method: "GET", url: `/api/document-references?documentId=${documentId}` });
    expect(stillApprovedRef.json()[0].documentRevisionId).toBe(updated.json().currentRevisionId);
    const reapproved = await app.inject({ method: "PATCH", url: `/api/design-docs/${documentId}`, payload: { status: "已批准", version: "v1.2", content: "已批准第三版" } });
    const refreshedAfterApproval = await app.inject({ method: "PATCH", url: `/api/document-references/${referenceId}`, payload: { useCurrentRevision: true } });
    expect(refreshedAfterApproval.json().documentRevisionId).toBe(reapproved.json().currentRevisionId);
  });

  it("stores API keys encrypted and runs openai-chat without Codex Harness", async () => {
    const fakeApiKey = "sk-test-productdesign-safe";
    const upstreamRequests: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
    let mutationTarget: { diagramId: string; nodeId: string; expectedUpdatedAt: string } | null = null;
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        upstreamRequests.push({
          url: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string }> : [];
        const isAgentTurn = Array.isArray(body.tools);
        const hasToolResult = messages.some((message) => message.role === "tool");
        const toolCalls = [{
          id: "call-create-brief",
          type: "function",
          function: {
            name: "create_design_doc",
            arguments: JSON.stringify({
              title: "Agent 工具测试简报",
              category: "需求文档",
              summary: "由兼容协议 Agent 通过 ProductDesign MCP 创建",
              status: "已批准",
              version: "v1.0",
              author: "Test Agent",
              content: "# 测试简报\n\n验证 MCP 工具闭环。",
            }),
          },
        }];
        if (mutationTarget) toolCalls.push({
          id: "call-update-selected-node",
          type: "function",
          function: {
            name: "mutate_diagram",
            arguments: JSON.stringify({
              diagramId: mutationTarget.diagramId,
              expectedUpdatedAt: mutationTarget.expectedUpdatedAt,
              operations: [{ op: "update_node", nodeId: mutationTarget.nodeId, patch: { label: "Agent 已更新选中节点" } }],
            }),
          },
        });
        if (mutationTarget) toolCalls.push({
          id: "call-open-diagram",
          type: "function",
          function: {
            name: "open_diagram",
            arguments: JSON.stringify({ diagramId: mutationTarget.diagramId, nodeId: mutationTarget.nodeId }),
          },
        });
        response.end(JSON.stringify(isAgentTurn && !hasToolResult ? {
          id: "chatcmpl-tool-test",
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: toolCalls,
          } }],
        } : {
          id: "chatcmpl-test",
          choices: [{ message: { role: "assistant", content: "本地兼容网关已响应" } }],
        }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("测试网关监听失败");

    const secureDataDir = mkdtempSync(join(tmpdir(), "pcs-chat-adapter-"));
    const secureDbPath = join(secureDataDir, "secure-api-test.db");
    let secureApp = buildApp({ dbPath: secureDbPath, dataDir: secureDataDir });
    try {
      await secureApp.ready();
      const profile = await secureApp.inject({
        method: "POST",
        url: "/api/llm-profiles",
        payload: {
          name: "本地 OpenAI 兼容网关",
          provider: "Test Provider",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: "PCS_DIRECT_CHAT_TEST_KEY",
          apiKey: fakeApiKey,
          models: ["test-chat-model"],
          defaultModel: "test-chat-model",
          enabled: true,
          timeoutMs: 3000,
        },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json()).toMatchObject({
        credentialConfigured: true,
        credentialMasked: "••••safe",
        credentialSource: "stored",
      });
      expect(JSON.stringify(profile.json())).not.toContain(fakeApiKey);
      const credentialFile = readFileSync(join(secureDataDir, "store", "llm-credentials.json"), "utf8");
      expect(credentialFile).not.toContain(fakeApiKey);

      const checked = await secureApp.inject({
        method: "POST",
        url: `/api/llm-profiles/${profile.json().id}/test`,
        payload: {},
      });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ ok: true, status: "connected" });

      const project = await secureApp.inject({
        method: "POST",
        url: "/api/projects",
        payload: { code: "CHAT", name: "兼容对话测试" },
      });
      const diagrams = await secureApp.inject({ method: "GET", url: `/api/diagrams?projectId=${project.json().id}` });
      const mainDiagram = diagrams.json().find((diagram: { type: string }) => diagram.type === "main");
      const selectedNode = { id: "selected-agent-context-node", kind: "feature", label: "待 Agent 修改的节点", x: 680, y: 340, shape: "rounded" };
      const seeded = await secureApp.inject({
        method: "PATCH",
        url: `/api/diagrams/${mainDiagram.id}`,
        payload: { nodes: [...mainDiagram.nodes, selectedNode] },
      });
      expect(seeded.statusCode).toBe(200);
      mutationTarget = { diagramId: mainDiagram.id, nodeId: selectedNode.id, expectedUpdatedAt: seeded.json().updatedAt };
      const session = await secureApp.inject({
        method: "POST",
        url: "/api/agent-sessions",
        payload: {
          projectId: project.json().id,
          profileId: profile.json().id,
          model: "test-chat-model",
          title: "协议路由验证",
        },
      });
      const contextDocument = await secureApp.inject({
        method: "POST",
        url: "/api/design-docs",
        payload: {
          projectId: project.json().id,
          title: "Agent 当前文档上下文",
          status: "评审中",
          content: "# 订单结算\nAgent 必须看见这段当前文档正文。",
        },
      });
      expect(contextDocument.statusCode).toBe(200);
      const otherProject = await secureApp.inject({
        method: "POST",
        url: "/api/projects",
        payload: { code: "OTHER", name: "其他上下文项目" },
      });
      const mismatched = await secureApp.inject({
        method: "POST",
        url: `/api/agent-sessions/${session.json().id}/messages`,
        payload: {
          content: "不应执行",
          contextEvent: {
            type: "STATE_SNAPSHOT",
            snapshot: {
              contextId: "cross-project",
              projectId: otherProject.json().id,
              route: `#/projects/${otherProject.json().id}`,
              title: "其他项目",
              pageType: "project",
              entityRefs: [{ type: "project", id: otherProject.json().id }],
              selection: { entityRefs: [] },
              draft: null,
              visibleContent: null,
              capturedAt: new Date().toISOString(),
            },
          },
        },
      });
      expect(mismatched.statusCode).toBe(409);
      expect(mismatched.json().message).toContain("不属于同一项目");
      const sent = await secureApp.inject({
        method: "POST",
        url: `/api/agent-sessions/${session.json().id}/messages`,
        payload: {
          content: "请修改我在画布中选中的节点",
          contextEvent: {
            type: "STATE_SNAPSHOT",
            snapshot: {
              contextId: "canvas-selection-1",
              projectId: project.json().id,
              route: `#/canvas/${mainDiagram.id}`,
              title: "文档 · Agent 当前文档上下文",
              pageType: "document",
              entityRefs: [
                { type: "project", id: project.json().id },
                { type: "diagram", id: mainDiagram.id, label: "系统主画布" },
                { type: "designDocument", id: contextDocument.json().id, label: contextDocument.json().title },
              ],
              selection: { entityRefs: [{ type: "diagramNode", id: selectedNode.id, parentId: mainDiagram.id, label: selectedNode.label }] },
              draft: null,
              visibleContent: {
                kind: "document",
                title: contextDocument.json().title,
                text: contextDocument.json().content,
                truncated: false,
              },
              capturedAt: new Date().toISOString(),
            },
          },
        },
      });
      expect(sent.statusCode).toBe(202);

      let messages: Array<{ role: string; status: string; content: string }> = [];
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const listed = await secureApp.inject({ method: "GET", url: `/api/agent-sessions/${session.json().id}/messages` });
        messages = listed.json();
        if (messages.some((message) => message.role === "assistant" && message.status === "completed")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        status: "completed",
        content: "本地兼容网关已响应",
      }));
      const docs = await secureApp.inject({ method: "GET", url: `/api/design-docs?projectId=${project.json().id}` });
      expect(docs.json()).toContainEqual(expect.objectContaining({
        title: "Agent 工具测试简报",
        projectId: project.json().id,
      }));
      const changedDiagram = await secureApp.inject({ method: "GET", url: `/api/diagrams/${mainDiagram.id}` });
      expect(changedDiagram.json().nodes).toContainEqual(expect.objectContaining({ id: selectedNode.id, label: "Agent 已更新选中节点" }));
      expect(upstreamRequests).toHaveLength(3);
      expect(upstreamRequests.every((item) => item.url === "/v1/chat/completions")).toBe(true);
      expect(upstreamRequests.every((item) => item.authorization === `Bearer ${fakeApiKey}`)).toBe(true);
      const agentRequest = upstreamRequests.find((item) => Array.isArray(item.body.tools));
      expect(JSON.stringify(agentRequest?.body.messages)).toContain("canvas-selection-1");
      expect(JSON.stringify(agentRequest?.body.messages)).toContain(selectedNode.id);
      expect(JSON.stringify(agentRequest?.body.messages)).toContain(contextDocument.json().id);
      expect(JSON.stringify(agentRequest?.body.messages)).toContain("Agent 必须看见这段当前文档正文");
      expect(JSON.stringify(agentRequest?.body.tools)).toContain("create_design_doc");
      expect(JSON.stringify(agentRequest?.body.tools)).toContain("mutate_diagram");
      expect(JSON.stringify(agentRequest?.body.tools)).toContain("create_database_model");
      expect(JSON.stringify(agentRequest?.body.tools)).toContain("open_diagram");
      expect(JSON.stringify(upstreamRequests)).toContain("已请求前端静默打开画布");

      await secureApp.close();
      secureApp = buildApp({ dbPath: secureDbPath, dataDir: secureDataDir });
      await secureApp.ready();
      const profiles = await secureApp.inject({ method: "GET", url: "/api/llm-profiles" });
      expect(profiles.json()).toContainEqual(expect.objectContaining({
        id: profile.json().id,
        credentialConfigured: true,
        credentialMasked: "••••safe",
        credentialSource: "stored",
      }));
    } finally {
      await secureApp.close();
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      rmSync(secureDataDir, { recursive: true, force: true });
    }
  });

  it.runIf(localCodexAvailable)("runs Responses dynamic tools through the project-scoped MCP bridge", async () => {
    const fakeApiKey = "sk-test-responses-dynamic-safe";
    const upstreamBodies: Record<string, unknown>[] = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        upstreamBodies.push(body);
        const hasToolOutput = JSON.stringify(body).includes('"type":"function_call_output"');
        const events = hasToolOutput ? [
          { type: "response.output_text.delta", delta: "Responses 动态工具已完成" },
          {
            type: "response.output_item.done",
            item: { type: "message", role: "assistant", id: "msg_dynamic_done", content: [{ type: "output_text", text: "Responses 动态工具已完成" }] },
          },
          { type: "response.completed", response: { id: "resp_dynamic_done" } },
        ] : [
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_dynamic_design_doc",
              name: "create_design_doc",
              arguments: JSON.stringify({
                title: "Responses Agent 动态工具测试",
                category: "需求文档",
                summary: "由 Codex 动态工具通过项目范围 MCP 创建",
                status: "草拟",
                version: "v0.1",
                content: "# Responses Agent 动态工具测试\n\n动态工具调用已生效。",
              }),
            },
          },
          { type: "response.completed", response: { id: "resp_dynamic_call" } },
        ];
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Responses 测试网关监听失败");

    const responseDataDir = mkdtempSync(join(tmpdir(), "pcs-responses-adapter-"));
    const responseDbPath = join(responseDataDir, "responses-api-test.db");
    const responseApp = buildApp({ dbPath: responseDbPath, dataDir: responseDataDir });
    try {
      await responseApp.ready();
      const profile = await responseApp.inject({
        method: "POST",
        url: "/api/llm-profiles",
        payload: {
          name: "本地 Responses 动态工具网关",
          provider: "Test Responses Provider",
          protocol: "openai-responses",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: "PCS_RESPONSES_DYNAMIC_TEST_KEY",
          apiKey: fakeApiKey,
          models: ["test-responses-model"],
          defaultModel: "test-responses-model",
          enabled: true,
          timeoutMs: 15_000,
        },
      });
      const project = await responseApp.inject({
        method: "POST",
        url: "/api/projects",
        payload: { code: "RESP", name: "Responses 动态工具测试" },
      });
      const session = await responseApp.inject({
        method: "POST",
        url: "/api/agent-sessions",
        payload: {
          projectId: project.json().id,
          profileId: profile.json().id,
          model: "test-responses-model",
          title: "Responses 动态工具验证",
        },
      });
      const sent = await responseApp.inject({
        method: "POST",
        url: `/api/agent-sessions/${session.json().id}/messages`,
        payload: { content: "请通过设计工具创建测试文档", pageContext: null },
      });
      expect(sent.statusCode).toBe(202);

      let messages: Array<{ role: string; status: string; content: string }> = [];
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const listed = await responseApp.inject({ method: "GET", url: `/api/agent-sessions/${session.json().id}/messages` });
        messages = listed.json();
        if (messages.some((message) => message.role === "assistant" && ["completed", "failed"].includes(message.status))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(messages).toContainEqual(expect.objectContaining({
        role: "assistant",
        status: "completed",
        content: expect.stringContaining("Responses 动态工具已完成"),
      }));
      const docs = await responseApp.inject({ method: "GET", url: `/api/design-docs?projectId=${project.json().id}` });
      expect(docs.json()).toContainEqual(expect.objectContaining({
        title: "Responses Agent 动态工具测试",
        projectId: project.json().id,
      }));
      expect(upstreamBodies.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(upstreamBodies[0].tools)).toContain("create_design_doc");
      expect(JSON.stringify(upstreamBodies[0].tools)).toContain("mutate_diagram");
      expect(JSON.stringify(upstreamBodies[0].tools)).toContain("create_database_model");
      expect(JSON.stringify(upstreamBodies)).toContain("function_call_output");
      // The API persists the completed message before the app-server child exits.
      // Let the turn's finally block release its Windows working-directory handle.
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    } finally {
      await responseApp.close();
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
      try {
        rmSync(responseDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM") throw error;
      }
    }
  }, 30_000);

  it("manages project Agent workspaces and blocks runs without credentials", async () => {
    const profile = await app.inject({
      method: "POST",
      url: "/api/llm-profiles",
      payload: {
        name: "Agent API 网关",
        provider: "OpenAI compatible",
        protocol: "openai-responses",
        baseUrl: "https://agent.invalid/v1",
        apiKeyEnv: "PCS_AGENT_TEST_KEY_NOT_SET",
        models: ["agent-model", "agent-model-fast"],
        defaultModel: "agent-model",
        enabled: true,
        timeoutMs: 1000,
      },
    });
    expect(profile.statusCode).toBe(200);

    const empty = await app.inject({ method: "GET", url: `/api/projects/${projectId}/agent-workspace` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().sessions).toEqual([]);

    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { projectId, profileId: profile.json().id, model: "agent-model", title: "项目讨论" },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().projectId).toBe(projectId);
    expect(session.json().controlMode).toBe("restricted");
    const sessionId = session.json().id;

    const workspace = await app.inject({ method: "GET", url: `/api/projects/${projectId}/agent-workspace` });
    expect(workspace.json().workspace.defaultProfileId).toBe(profile.json().id);
    expect(workspace.json().sessions).toHaveLength(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agent-sessions/${sessionId}`,
      payload: { title: "更新后的讨论", model: "agent-model-fast", controlMode: "ask" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().model).toBe("agent-model-fast");
    expect(updated.json().controlMode).toBe("ask");

    const narrowedProfile = await app.inject({
      method: "PATCH",
      url: `/api/llm-profiles/${profile.json().id}`,
      payload: { models: ["agent-model"], defaultModel: "agent-model" },
    });
    expect(narrowedProfile.statusCode).toBe(200);
    const modeOnly = await app.inject({
      method: "PATCH",
      url: `/api/agent-sessions/${sessionId}`,
      payload: { controlMode: "project-autonomous" },
    });
    expect(modeOnly.statusCode).toBe(200);
    expect(modeOnly.json()).toMatchObject({ model: "agent-model-fast", controlMode: "project-autonomous" });

    const approvals = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/approvals?status=pending` });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json()).toEqual([]);
    const missingApproval = await app.inject({
      method: "POST",
      url: "/api/agent-approvals/missing/decision",
      payload: { sessionId, decision: "approve_once" },
    });
    expect(missingApproval.statusCode).toBe(404);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/messages`,
      payload: { content: "分析项目", pageContext: { route: "#/projects/demo", title: "项目详情" } },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("PCS_AGENT_TEST_KEY_NOT_SET");
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    expect(messages.json()).toEqual([]);

    const removed = await app.inject({ method: "DELETE", url: `/api/agent-sessions/${sessionId}` });
    expect(removed.statusCode).toBe(200);
    const removedProfile = await app.inject({ method: "DELETE", url: `/api/llm-profiles/${profile.json().id}` });
    expect(removedProfile.statusCode).toBe(200);
  });

  it("cancels an active Agent run before deleting its session", async () => {
    let markRequestStarted: (() => void) | undefined;
    let markRequestAborted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    const requestAborted = new Promise<void>((resolve) => { markRequestAborted = resolve; });
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => markRequestStarted?.());
      response.on("close", () => markRequestAborted?.());
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("取消测试网关监听失败");

    const cancelDataDir = mkdtempSync(join(tmpdir(), "pcs-agent-cancel-"));
    const cancelApp = buildApp({ dbPath: join(cancelDataDir, "cancel.db"), dataDir: cancelDataDir });
    try {
      await cancelApp.ready();
      const project = await cancelApp.inject({ method: "POST", url: "/api/projects", payload: { code: "CANCEL", name: "取消运行测试" } });
      const profile = await cancelApp.inject({
        method: "POST",
        url: "/api/llm-profiles",
        payload: {
          name: "悬挂模型网关", provider: "Test", protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "PCS_CANCEL_TEST_KEY",
          apiKey: "sk-test-cancel-running", models: ["cancel-model"], defaultModel: "cancel-model",
          enabled: true, timeoutMs: 30_000,
        },
      });
      const session = await cancelApp.inject({
        method: "POST",
        url: "/api/agent-sessions",
        payload: { projectId: project.json().id, profileId: profile.json().id, model: "cancel-model", title: "运行中会话" },
      });
      const sessionId = session.json().id;
      const sent = await cancelApp.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/messages`, payload: { content: "保持运行" } });
      expect(sent.statusCode).toBe(202);
      await requestStarted;

      const removed = await cancelApp.inject({ method: "DELETE", url: `/api/agent-sessions/${sessionId}` });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ ok: true, cancelled: true });
      await requestAborted;
      const workspace = await cancelApp.inject({ method: "GET", url: `/api/projects/${project.json().id}/agent-workspace` });
      expect(workspace.json().sessions).toEqual([]);
      const messages = await cancelApp.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
      expect(messages.statusCode).toBe(404);
    } finally {
      await cancelApp.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      rmSync(cancelDataDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects duplicate project codes", async () => {
    const dup = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { code: "TEST1", name: "重复编号" },
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().code).not.toBe("TEST1");
  });

  it("returns the project workflow and next action", async () => {
    const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/workflow` });
    expect(response.statusCode).toBe(200);
    expect(response.json().policyVersion).toBe("1.1.0");
    expect(response.json().nextAction?.code).toBeTruthy();
  });

  it("manages work nodes and plan items", async () => {
    const node = await app.inject({
      method: "POST",
      url: "/api/nodes",
      payload: { projectId, kind: "feature", title: "核心功能" },
    });
    expect(node.statusCode).toBe(200);
    const nodeId = node.json().id;

    const listed = await app.inject({ method: "GET", url: `/api/projects/${projectId}/nodes` });
    expect(listed.json()).toHaveLength(1);

    const plan = await app.inject({
      method: "POST",
      url: "/api/plans",
      payload: { projectId, kind: "milestone", title: "M1", dueAt: "2026-09-30", owner: "测试负责人" },
    });
    expect(plan.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/api/plans/${plan.json().id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: plan.json().id, title: "M1", owner: "测试负责人" });

    const missingDetail = await app.inject({ method: "GET", url: "/api/plans/missing-plan" });
    expect(missingDetail.statusCode).toBe(404);

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/plans/${plan.json().id}`,
      payload: { status: "已完成" },
    });
    expect(completed.json()).toMatchObject({
      status: "已完成",
      progress: 100,
      dueAt: "2026-09-30",
      owner: "测试负责人",
    });

    const badDep = await app.inject({
      method: "POST",
      url: "/api/plans",
      payload: { projectId, kind: "task", title: "T", dependencyIds: ["missing"] },
    });
    expect(badDep.statusCode).toBe(400);

    const delNode = await app.inject({ method: "DELETE", url: `/api/nodes/${nodeId}` });
    expect(delNode.statusCode).toBe(200);
  });

  it("manual evidence and git collect validation", async () => {
    const longRevision = `working-tree:${"x".repeat(105)}`;
    const longRevisionEvidence = await app.inject({
      method: "POST",
      url: "/api/evidence",
      payload: {
        projectId,
        sourceType: "manual",
        summary: "长实现修订证据",
        commitSha: longRevision,
        details: { implementationRevision: longRevision },
      },
    });
    expect(longRevisionEvidence.statusCode, longRevisionEvidence.body).toBe(200);

    const manual = await app.inject({
      method: "POST",
      url: "/api/evidence",
      payload: { projectId, sourceType: "manual", summary: "手工验证记录" },
    });
    expect(manual.statusCode).toBe(200);

    const noRepo = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/evidence/collect`,
      payload: { source: "git" },
    });
    expect(noRepo.statusCode).toBe(400);
  });

  it("governance records support status transitions", async () => {
    const record = await app.inject({
      method: "POST",
      url: "/api/governance",
      payload: { projectId, type: "decision", title: "使用 SQLite 存储", author: "owner" },
    });
    expect(record.statusCode).toBe(200);
    const id = record.json().id;

    const replaced = await app.inject({
      method: "PATCH",
      url: `/api/governance/${id}`,
      payload: { status: "已替代" },
    });
    expect(replaced.json().status).toBe("已替代");
  });

  it("design docs support create/read/patch", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/design-docs",
      payload: { projectId, title: "登录模块设计", status: "评审中", author: "designer", content: "# 登录流程\nSSO 接入。" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(created.json().version).toBe("v0.1");

    const list = await app.inject({ method: "GET", url: "/api/design-docs" });
    expect(list.json().some((d: { id: string }) => d.id === id)).toBe(true);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/design-docs/${id}`,
      payload: { status: "已批准", version: "v1.0" },
    });
    expect(patched.json().status).toBe("已批准");
    expect(patched.json().version).toBe("v1.0");

    const exact = await app.inject({
      method: "GET",
      url: `/api/design-docs/${id}?projectId=${projectId}&revisionId=${patched.json().currentRevisionId}&contentOffset=0&maxContentChars=1000`,
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toEqual(expect.objectContaining({
      id,
      projectId,
      revisionId: patched.json().currentRevisionId,
      content: "# 登录流程\nSSO 接入。",
      hasMore: false,
    }));

    const wrongProject = await app.inject({ method: "GET", url: `/api/design-docs/${id}?projectId=missing` });
    expect(wrongProject.statusCode).toBe(404);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/design-docs",
      payload: { projectId: "missing", title: "x" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("keeps paged document and evidence search contracts", async () => {
    const document = await app.inject({
      method: "POST", url: "/api/design-docs",
      payload: { projectId, title: "分页_%_中文", status: "已批准", author: "designer", content: "分页正文" },
    });
    const documentQuery = new URLSearchParams({ projectId, q: "_%_中文", status: "已批准", limit: "1", offset: "0" });
    const documents = await app.inject({ method: "GET", url: `/api/design-docs?${documentQuery}` });
    expect(documents.statusCode, documents.body).toBe(200);
    expect(documents.json()).toMatchObject({ count: 1, offset: 0 });
    expect(documents.json().items[0].id).toBe(document.json().id);

    const evidence = await app.inject({
      method: "POST", url: "/api/evidence",
      payload: { projectId, sourceType: "manual", sourcePath: "reports/_literal%.json", resultStatus: "pass", summary: "分页中文证据" },
    });
    const evidenceQuery = new URLSearchParams({ q: "_literal%", status: "pass", limit: "1", offset: "0" });
    const evidencePage = await app.inject({ method: "GET", url: `/api/projects/${projectId}/evidence?${evidenceQuery}` });
    expect(evidencePage.statusCode, evidencePage.body).toBe(200);
    expect(evidencePage.json()).toMatchObject({ total: 1, count: 1, offset: 0, hasMore: false });
    expect(evidencePage.json().items[0]).toMatchObject({ id: evidence.json().id, details: {} });

    const invalidWindow = await app.inject({ method: "GET", url: `/api/design-docs?projectId=${projectId}&limit=1.5&offset=1e100` });
    expect(invalidWindow.json().offset).toBe(0);
    expect(invalidWindow.json().count).toBeLessThanOrEqual(20);
  });

  it("diagrams support create and patch nodes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/diagrams",
      payload: { projectId, title: "登录模块图", nodes: [{ id: "a", kind: "module", label: "前端", x: 10, y: 20 }] },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${id}`,
      payload: { edges: [{ id: "e1", from: "a", to: "b", style: "ortho", points: [{ x: 98, y: 20 }, { x: 120, y: 20 }, { x: 120, y: 80 }] }] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().edges).toHaveLength(1);
    expect(patched.json().edges[0].points).toHaveLength(3);

    const list = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
    expect(list.json().some((d: { id: string }) => d.id === id)).toBe(true);
  });

  it("rejects diagram group overlaps without changing the saved layout", async () => {
    const nodes = [
      { id: "a1", kind: "feature", label: "A1", x: 0, y: 0, w: 40, h: 40 },
      { id: "a2", kind: "feature", label: "A2", x: 40, y: 0, w: 40, h: 40 },
      { id: "b1", kind: "feature", label: "B1", x: 112, y: 0, w: 40, h: 40 },
      { id: "b2", kind: "feature", label: "B2", x: 152, y: 0, w: 40, h: 40 },
    ];
    const groups = [
      { id: "group-a", name: "区域 A", nodeIds: ["a1", "a2"] },
      { id: "group-b", name: "区域 B", nodeIds: ["b1", "b2"] },
    ];
    const created = await app.inject({
      method: "POST",
      url: "/api/diagrams",
      payload: { projectId, title: "组合防重叠", nodes, edges: [], groups },
    });
    expect(created.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/diagrams/${created.json().id}`,
      payload: { nodes: nodes.map((node) => node.id === "b1" ? { ...node, x: 111 } : node) },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().message).toContain("组合区域“区域 A”与“区域 B”不允许重叠");

    const saved = await app.inject({ method: "GET", url: `/api/diagrams/${created.json().id}` });
    expect(saved.json().nodes.find((node: { id: string }) => node.id === "b1").x).toBe(112);
  });

  it("does not expose the removed directory scan endpoint", async () => {
    const response = await app.inject({ method: "POST", url: "/api/scan", payload: { rootPath: "D:\\project" } });
    expect(response.statusCode).toBe(404);
  });

  it("backup writes snapshot file and records row", async () => {
    const backup = await app.inject({
      method: "POST",
      url: "/api/backups",
      payload: { label: "接口测试备份" },
    });
    expect(backup.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/backups" });
    expect(list.json().length).toBeGreaterThanOrEqual(1);
  });

  it("returns a machine-readable orchestration blueprint and controlled plan transitions", async () => {
    const orchestration = await app.inject({ method: "GET", url: `/api/projects/${projectId}/agent-orchestration` });
    expect(orchestration.statusCode).toBe(200);
    expect(orchestration.json().schemaVersion).toBe("1.3");
    expect(orchestration.json().recommendedAgents.map((agent: { key: string }) => agent.key)).toEqual(["designer", "builder", "auditor", "approver"]);
    expect(orchestration.json().bootstrapPrompt).toContain("禁止自动创建管理员 Agent");
    expect(orchestration.json().workingDirectory.ready).toBe(false);

    const blockedPackage = await app.inject({ method: "GET", url: `/api/projects/${projectId}/agent-task-package` });
    expect(blockedPackage.statusCode).toBe(409);
    expect(blockedPackage.json().code).toBe("TASK_CLAIM_REQUIRED");

    const missingProject = await app.inject({ method: "GET", url: "/api/projects/not-found/agent-task-package" });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json().code).toBe("PROJECT_NOT_FOUND");

    await app.inject({ method: "PATCH", url: `/api/projects/${projectId}`, payload: { repositoryPath: dataDir } });
    const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
    const main = diagrams.json().find((diagram: { type: string }) => diagram.type === "main");
    const nodeCreated = await app.inject({
      method: "PATCH", url: `/api/diagrams/${main.id}`,
      payload: { nodes: [...main.nodes, {
        id: "api-controlled-feature", kind: "feature", label: "API 受控流转", description: "验证租约约束的证据写入", owner: "team",
        acceptanceCriteria: "施工 Agent 仅可凭有效租约写入证据", requirementStatus: "已批准", designStatus: "未开始",
        developmentStatus: "未开发", acceptanceStatus: "未验收", requiresDatabase: false, x: 680, y: 160,
      }] },
    });
    expect(nodeCreated.statusCode, nodeCreated.body).toBe(200);
    const detail = await app.inject({
      method: "POST", url: "/api/design-docs",
      payload: {
        projectId, category: "功能说明", title: "API 受控流转详细设计", summary: "租约门禁", status: "已批准", version: "v1.0",
        author: "designer", content: "施工 Agent 写证据时必须提交有效租约。",
        references: [{ targetType: "diagramNode", targetId: "api-controlled-feature", relationType: "defines" }],
      },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const diagramAfterDocument = await app.inject({ method: "GET", url: `/api/diagrams/${main.id}` });
    const designApproved = await app.inject({
      method: "PATCH", url: `/api/diagrams/${main.id}`,
      payload: {
        nodes: diagramAfterDocument.json().nodes.map((node: { id: string }) => node.id === "api-controlled-feature"
          ? { ...node, designStatus: "已批准" }
          : node),
      },
    });
    expect(designApproved.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST", url: "/api/plans",
      payload: {
        projectId, diagramId: main.id, diagramNodeId: "api-controlled-feature", kind: "task", title: "受控计划", owner: "builder",
        roleAssignments: {
          designer: { agentId: "designer-id", displayName: "designer" },
          builder: { agentId: "builder-id", displayName: "builder" },
          auditor: { agentId: "auditor-id", displayName: "auditor" },
        },
      },
    });
    const planId = created.json().id;
    const wrongDesigner = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: { action: "submit_plan", actor: "伪装设计者", agentId: "builder-id", correlationId: "flow-1" },
    });
    expect(wrongDesigner.statusCode).toBe(409);
    expect(wrongDesigner.json().code).toBe("TASK_LEASE_REQUIRED");
    const designTaskPackage = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/agent-task-package`,
      payload: {
        role: "designer", agentId: "designer-id", taskId: `design:${planId}`,
        sessionId: "session-1", idempotencyKey: "api-design-claim",
      },
    });
    expect(designTaskPackage.statusCode, designTaskPackage.body).toBe(200);
    const designLeaseToken = designTaskPackage.json().lease.leaseToken as string;
    const submitted = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: {
        action: "submit_plan", actor: "designer", agentId: "designer-id", correlationId: "flow-1", clientId: "api-test", sessionId: "session-1",
        leaseToken: designLeaseToken, idempotencyKey: "api-design-submit",
      },
    });
    expect(submitted.json().lifecycleStatus).toBe("pending_approval");
    const designAuditTaskPackage = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/agent-task-package`,
      payload: {
        role: "auditor", agentId: "auditor-id", workerId: "api-design-auditor-worker", taskId: `audit:${planId}`,
        sessionId: "api-design-audit-session", idempotencyKey: "api-design-audit-claim",
      },
    });
    expect(designAuditTaskPackage.statusCode, designAuditTaskPackage.body).toBe(200);
    expect(designAuditTaskPackage.json()).toMatchObject({
      schemaVersion: "1.3", deliveryTrack: "design", auditScope: "design", managerApprovalRequired: false,
    });
    const designAuditLeaseToken = designAuditTaskPackage.json().lease.leaseToken as string;
    const designAuditEvidence = await app.inject({
      method: "POST", url: "/api/evidence",
      payload: {
        projectId, nodeId: "api-controlled-feature", planItemId: planId, sourceType: "manual", resultStatus: "pass",
        summary: "独立设计审计通过", details: { auditScope: "design" }, documentRevisionId: detail.json().currentRevisionId,
        actorRole: "auditor", agentId: "auditor-id", sessionId: "api-design-audit-session",
        leaseToken: designAuditLeaseToken, idempotencyKey: "api-design-audit-evidence",
      },
    });
    expect(designAuditEvidence.statusCode, designAuditEvidence.body).toBe(200);
    const designAudited = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: {
        action: "pass_design_audit", actor: "auditor", agentId: "auditor-id", correlationId: "flow-1",
        leaseToken: designAuditLeaseToken, idempotencyKey: "api-design-audit-pass",
      },
    });
    expect(designAudited.statusCode, designAudited.body).toBe(200);
    expect(designAudited.json().auditStatus).toBe("passed");
    const approved = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: { action: "approve_plan", actor: "manager", correlationId: "flow-1" },
    });
    expect(approved.json().lifecycleStatus).toBe("approved");

    const skippedStart = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: { action: "complete_development", actor: "builder", agentId: "builder-id", implementationRevision: "build-1", correlationId: "flow-1" },
    });
    expect(skippedStart.statusCode).toBe(409);

    const wrongEvidence = await app.inject({
      method: "POST", url: "/api/evidence",
      payload: {
        projectId, nodeId: null, planItemId: planId, sourceType: "manual", resultStatus: "pass",
        summary: "伪装的审计证据", actorRole: "auditor", agentId: "builder-id",
      },
    });
    expect(wrongEvidence.statusCode).toBe(409);
    expect(wrongEvidence.json().message).toContain("证据身份不匹配");

    const taskPackage = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/agent-task-package`,
      payload: {
        role: "builder", agentId: "builder-id", taskId: `development:${planId}`,
        sessionId: "builder-session", idempotencyKey: "api-evidence-claim",
      },
    });
    expect(taskPackage.statusCode).toBe(200);
    const leaseToken = taskPackage.json().lease.leaseToken as string;
    const started = await app.inject({
      method: "POST", url: `/api/plans/${planId}/transition`,
      payload: {
        action: "start_development", actor: "builder", agentId: "builder-id",
        leaseToken, idempotencyKey: "api-evidence-start", correlationId: "flow-1", sessionId: "builder-session",
      },
    });
    expect(started.statusCode).toBe(200);

    const evidence = await app.inject({
      method: "POST", url: "/api/evidence",
      payload: {
        projectId, nodeId: null, planItemId: planId, sourceType: "manual", resultStatus: "pass",
        summary: "施工记录已关联正式计划", actor: "builder", actorRole: "builder", agentId: "builder-id", sessionId: "builder-session",
        leaseToken, idempotencyKey: "api-evidence-create",
      },
    });
    expect(evidence.statusCode).toBe(200);

    const audit = await app.inject({ method: "GET", url: `/api/audit?correlationId=flow-1&offset=0&limit=20` });
    expect(audit.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ action: "submit_plan", sessionId: "session-1" })]));
    expect(audit.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", entityType: "evidence", sessionId: "builder-session" }),
    ]));
  });

  it("returns PLAN_LAYER_LOCKED for a specified higher-layer task package on the same node", async () => {
    const project = await app.inject({
      method: "POST", url: "/api/projects",
      payload: { code: "API-LAYERS", name: "API 逐层门禁", summary: "逐层", stage: "开发", health: "正常", repositoryPath: dataDir },
    });
    const layerProjectId = project.json().id as string;
    await app.inject({ method: "PATCH", url: `/api/projects/${layerProjectId}`, payload: { repositoryPath: dataDir } });
    const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${layerProjectId}` });
    const main = diagrams.json().find((diagram: { type: string }) => diagram.type === "main");
    await app.inject({
      method: "PATCH", url: `/api/diagrams/${main.id}`,
      payload: { nodes: [...main.nodes, { id: "same-node", kind: "feature", label: "同节点跨层", x: 600, y: 160 }] },
    });
    const assignments = {
      designer: { agentId: "designer-id", displayName: "Designer" },
      builder: { agentId: "builder-id", displayName: "Builder" },
      auditor: { agentId: "auditor-id", displayName: "Auditor" },
    };
    const first = await app.inject({
      method: "POST", url: "/api/plans",
      payload: { projectId: layerProjectId, diagramId: main.id, diagramNodeId: "same-node", kind: "task", title: "第一层", roleAssignments: assignments },
    });
    const higher = await app.inject({
      method: "POST", url: "/api/plans",
      payload: { projectId: layerProjectId, diagramId: main.id, diagramNodeId: "same-node", kind: "task", title: "第二层", dependencyIds: [first.json().id], roleAssignments: assignments },
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${layerProjectId}/agent-task-package`,
      payload: {
        role: "builder", agentId: "builder-id", taskId: `development:${higher.json().id}`,
        idempotencyKey: "api-locked-claim",
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "PLAN_LAYER_LOCKED" });
  });

  it("reports storage retention without deleting files", async () => {
    const response = await app.inject({ method: "GET", url: "/api/storage-retention" });
    expect(response.statusCode).toBe(200);
    expect(response.json().policy.maxBackupCount).toBeGreaterThan(0);
    expect(response.json().backups.count).toBeGreaterThanOrEqual(1);
  });

  it("dashboard aggregates and audit trail fills up", async () => {
    const dash = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().totals.projects).toBeGreaterThanOrEqual(2);

    const audit = await app.inject({ method: "GET", url: "/api/audit?limit=50" });
    const events = audit.json().items;
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].createdAt).toBeTruthy();
  });
});
