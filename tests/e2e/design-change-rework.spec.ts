import { expect, test } from "@playwright/test";
import { createGovernedProject } from "./helpers/governed-project";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1100 } });
let fixture: Awaited<ReturnType<typeof createGovernedProject>>;
let origin = "", projectId = "", diagramId = "", nodeId = "", documentId = "", planId = "";
test.beforeAll(async () => {
  fixture = await createGovernedProject();
  const design = await fixture.setupDesign();
  origin = fixture.origin; projectId = fixture.project.id; diagramId = design.diagramId;
  nodeId = design.nodeId; documentId = design.document.id; planId = design.plan.id;
});
test.afterAll(async () => { await fixture?.close(); });

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
  await expect(modal).toContainText("浏览器测试开发计划 · 已批准待施工");
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
  const evidenceRecords = await fixture.http("GET", `/api/projects/${projectId}/evidence?nodeId=${nodeId}`);
  const revokedEvidenceRecord = evidenceRecords.find((item: { summary: string }) => item.summary === "旧设计浏览器证据");
  expect(revokedEvidenceRecord.details.changeId).toBeTruthy();
  await expect(revokedEvidence).toContainText(`变更 ${revokedEvidenceRecord.details.changeId}`);
  await page.screenshot({ path: "artifacts/regression/design-change-rework-chrome.png", fullPage: true });

  const plan = await fixture.http("GET", `/api/plans/${planId}`);
  expect(plan).toMatchObject({ lifecycleStatus: "rework", status: "未开始", progress: 0 });
  const document = await fixture.http("GET", `/api/design-docs/${documentId}?projectId=${projectId}`);
  expect(document).toMatchObject({ status: "评审中" });
  const workflow = await fixture.workflow();
  const state = workflow.nodes.find((item: { nodeId: string }) => item.nodeId === nodeId);
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

// Scripted protocol and real subprocess evidence; no provider or autonomous model is involved.
test("accepted v1 is preserved while governed v2 is reimplemented independently tested and accepted", async ({}, testInfo) => {
  const versioned = await createGovernedProject("Versioned rework fixture");
  try {
    const v1 = await versioned.setupDesign();
    const first = await versioned.deliver(v1);
    const v2 = await versioned.reworkAccepted(v1);
    const second = await versioned.deliver(v2, 2);
    expect(second.lifecycleStatus).toBe("accepted");
    expect(second.implementationRevision).not.toBe(first.implementationRevision);
    expect(second.designRevisionIds).not.toEqual(first.designRevisionIds);
    const evidence = await versioned.http("GET", `/api/projects/${versioned.project.id}/evidence?nodeId=${v1.nodeId}`);
    const v2Evidence = evidence.filter((item: any) => item.planItemId === second.id && item.details.auditScope === "implementation");
    expect(v2Evidence).toHaveLength(2);
    expect(new Set(v2Evidence.map((item: any) => item.agentId)).size).toBe(2);
    for (const item of v2Evidence) {
      expect(item.commitSha).toBe(second.implementationRevision);
      expect(item.documentRevisionId).toBe(v2.document.currentRevisionId);
      expect(item.details.output).toContain("fractional and safe-integer boundaries");
      expect(item.details.output).toContain("# fail 0");
    }
    expect((await versioned.http("GET", `/api/plans/${first.id}`)).lifecycleStatus).toBe("accepted");
    const state = await versioned.workflow();
    expect(state.nodes.find((node: any) => node.nodeId === v1.nodeId).acceptanceStatus).toBe("已通过");
    await testInfo.attach("versioned-rework-evidence", { contentType: "application/json", body: JSON.stringify({
      scope: "scripted actors, ordinary public protocol, real local Git and Node subprocesses; no live model",
      projectId: versioned.project.id, changeId: v2.changeId,
      v1: { planId: first.id, status: first.lifecycleStatus, implementationRevision: first.implementationRevision, documentRevision: v1.document.currentRevisionId },
      v2: { planId: second.id, reworkOfPlanId: second.reworkOfPlanId, status: second.lifecycleStatus, implementationRevision: second.implementationRevision, documentRevision: v2.document.currentRevisionId },
      historicalDesignEvidenceRejected: true,
      evidence: v2Evidence.map((item: any) => ({ id: item.id, actorRole: item.actorRole, agentId: item.agentId, commitSha: item.commitSha, documentRevisionId: item.documentRevisionId, command: item.command, output: item.details.output })),
    }, null, 2) });
  } finally { await versioned.close(); }
});
