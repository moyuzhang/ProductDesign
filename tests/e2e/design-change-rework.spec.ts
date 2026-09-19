import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildApp } from "../../src/server/index.js";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1100 } });

const dataDir = mkdtempSync(join(tmpdir(), "pcs-design-change-browser-"));
const app = buildApp({ dbPath: join(dataDir, "browser.db"), dataDir });
let origin = "";
let projectId = "";
let diagramId = "";
let nodeId = "browser-design-change";
let documentId = "";
let planId = "";

test.beforeAll(async () => {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("浏览器测试服务监听失败");
  origin = `http://127.0.0.1:${address.port}`;
  const project = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { code: "BROWSER_CHANGE", name: "设计变更浏览器测试", summary: "验证设计变更闭环", stage: "开发", health: "正常" },
  });
  expect(project.statusCode).toBe(200);
  projectId = project.json().id;
  const brief = await app.inject({
    method: "POST", url: "/api/design-docs",
    payload: {
      projectId, category: "需求文档", title: "浏览器测试项目简报", summary: "项目范围",
      status: "已批准", version: "1.0", author: "Manager", content: "项目目标与范围",
      references: [{ targetType: "project", targetId: projectId, relationType: "defines" }],
    },
  });
  expect(brief.statusCode, brief.body).toBe(200);
  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
  const main = (diagrams.json() as Array<{ id: string; type: string; nodes: unknown[]; updatedAt: string }>).find((item) => item.type === "main")!;
  diagramId = main.id;
  const updatedDiagram = await app.inject({
    method: "PATCH", url: `/api/diagrams/${diagramId}`,
    payload: { nodes: [...main.nodes, {
      id: nodeId, kind: "feature", label: "设计变更测试节点", description: "浏览器验证节点", owner: "QA",
      acceptanceCriteria: "可发起设计变更并进入文档返工",
      developmentStatus: "未开发", acceptanceStatus: "未验收", x: 620, y: 180,
    }] },
  });
  expect(updatedDiagram.statusCode, updatedDiagram.body).toBe(200);
  const document = await app.inject({
    method: "POST", url: "/api/design-docs",
    payload: {
      projectId, category: "功能说明", title: "浏览器测试详细设计", summary: "已批准旧设计",
      status: "已批准", version: "1.0", author: "Designer", content: "旧设计正文",
      references: [{ targetType: "diagramNode", targetId: nodeId, relationType: "defines" }],
    },
  });
  expect(document.statusCode).toBe(200);
  documentId = document.json().id;
  const diagramBeforeApproval = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}` });
  const approvedNodes = diagramBeforeApproval.json().nodes.map((item: { id: string }) => item.id === nodeId
    ? { ...item, requirementStatus: "已批准", designStatus: "已批准" }
    : item);
  const approvedDiagram = await app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}`, payload: { nodes: approvedNodes } });
  expect(approvedDiagram.statusCode, approvedDiagram.body).toBe(200);
  const plan = await app.inject({
    method: "POST", url: "/api/plans",
    payload: {
      projectId, diagramId, diagramNodeId: nodeId, kind: "task", title: "浏览器测试开发计划",
      description: "实现旧设计", status: "未开始", priority: "P1", progress: 0,
      roleAssignments: {
        designer: { agentId: "browser-designer", displayName: "Browser Designer" },
        builder: { agentId: "browser-builder", displayName: "Browser Builder" },
        auditor: { agentId: "browser-auditor", displayName: "Browser Auditor" },
      },
    },
  });
  expect(plan.statusCode).toBe(200);
  planId = plan.json().id;
  const evidence = await app.inject({
    method: "POST", url: "/api/evidence",
    payload: {
      projectId, nodeId, documentRevisionId: document.json().currentRevisionId,
      sourceType: "manual", resultStatus: "pass", summary: "旧设计浏览器证据",
      details: { note: "设计变更后应显示为 revoked" },
    },
  });
  expect(evidence.statusCode, evidence.body).toBe(200);
});

test.afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("real Chrome completes design change request and renders the governed rework state", async ({ page }) => {
  await page.goto(`${origin}/#/canvas/${diagramId}/node/${nodeId}?tab=overview`, { waitUntil: "domcontentloaded" });
  const open = page.getByRole("button", { name: "发起设计变更" });
  await expect(open).toBeVisible();
  await expect(open).toBeEnabled();
  await open.click();

  const modal = page.locator(".modal", { hasText: "发起设计变更 · 设计变更测试节点" });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("1. 问题说明", { exact: true })).toBeVisible();
  await expect(modal.getByText("2. 影响范围", { exact: true })).toBeVisible();
  await expect(modal.getByText("3. 影响预览", { exact: true })).toBeVisible();
  await expect(modal).toContainText("浏览器测试详细设计 · 1.0 · 已批准");
  await expect(modal).toContainText("浏览器测试开发计划 · 计划草拟");
  await modal.getByLabel("错误原因").fill("浏览器验证发现接口边界错误");
  await modal.getByLabel("变更摘要").fill("修订接口边界并重排计划");
  await modal.getByLabel("必须返工范围").fill("文档、实现与独立测试");
  await modal.getByRole("button", { name: "确认冻结并进入返工" }).click();

  await expect(page.locator(".save-hint")).toContainText("设计变更");
  await expect.poll(() => new URL(page.url()).hash).toContain("tab=documents");
  await expect(page.locator(".document-reference-card.stale")).toContainText("版本已过期");
  await expect(page.locator(".document-reference-card.stale")).toContainText("评审中");
  await page.getByRole("tab", { name: "交付与验收" }).click();
  const revokedEvidence = page.locator(".node-detail-evidence", { hasText: "旧设计浏览器证据" });
  await expect(revokedEvidence).toContainText("revoked");
  await expect(revokedEvidence).toContainText("撤销原因：设计变更");
  const evidenceResponse = await app.inject({ method: "GET", url: `/api/projects/${projectId}/evidence?nodeId=${nodeId}` });
  const revokedEvidenceRecord = evidenceResponse.json().find((item: { summary: string }) => item.summary === "旧设计浏览器证据");
  expect(revokedEvidenceRecord.details.changeId).toBeTruthy();
  await expect(revokedEvidence).toContainText(`变更 ${revokedEvidenceRecord.details.changeId}`);
  await page.screenshot({ path: "artifacts/regression/design-change-rework-chrome.png", fullPage: true });

  const plan = await app.inject({ method: "GET", url: `/api/plans/${planId}` });
  expect(plan.json()).toMatchObject({ lifecycleStatus: "rework", status: "未开始", progress: 0 });
  const document = await app.inject({ method: "GET", url: `/api/design-docs/${documentId}?projectId=${projectId}` });
  expect(document.json()).toMatchObject({ status: "评审中" });
  const workflow = await app.inject({ method: "GET", url: `/api/projects/${projectId}/workflow` });
  const state = workflow.json().nodes.find((item: { nodeId: string }) => item.nodeId === nodeId);
  expect(state.nextAction.code).toBe("approve_node_document");

  const conflictIdempotencyKeys: string[] = [];
  await page.route("**/api/projects/*/design-changes", async (route) => {
    conflictIdempotencyKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey);
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "画布已变化，请刷新影响预览后重试" }) });
  });
  await page.getByRole("button", { name: "发起设计变更" }).click();
  const conflictModal = page.locator(".modal", { hasText: "发起设计变更 · 设计变更测试节点" });
  await conflictModal.getByLabel("错误原因").fill("并发冲突验证");
  await conflictModal.getByLabel("变更摘要").fill("不会实际提交");
  await conflictModal.getByLabel("必须返工范围").fill("不会实际提交");
  await conflictModal.getByRole("button", { name: "确认冻结并进入返工" }).click();
  await expect(conflictModal).toContainText("画布已变化，请刷新影响预览后重试");
  await conflictModal.getByRole("button", { name: "确认冻结并进入返工" }).click();
  await expect.poll(() => conflictIdempotencyKeys.length).toBe(2);
  expect(conflictIdempotencyKeys[1]).toBe(conflictIdempotencyKeys[0]);
  await page.screenshot({ path: "artifacts/regression/design-change-conflict-chrome.png", fullPage: true });
});
