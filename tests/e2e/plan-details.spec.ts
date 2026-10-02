import { expect, test } from "./historical-fixtures";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }, viewport: { width: 1440, height: 960 } });

test("project plans expose details and open the selected construction workflow", async ({ page, historicalProject }) => {
  const { projectId } = historicalProject;
  const plan = await historicalProject.createPlan();

  await page.goto(`/#/projects/${projectId}?tab=plans`);
  await page.getByRole("button", { name: plan.title, exact: true }).click();

  const detail = page.locator(".modal", { has: page.locator(".plan-detail") });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: plan.title, exact: true })).toBeVisible();
  await expect(detail.locator(".plan-detail-flow")).toContainText("实施流程");
  await expect(detail.getByRole("button", { name: "编辑补充" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "补充施工依据" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "进入实施流程" })).toBeVisible();
  await page.screenshot({ path: "artifacts/regression/plan-details-chrome.png", fullPage: true });

  await detail.getByRole("button", { name: "进入实施流程" }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(
    `#/canvas/${plan.diagramId}/node/${plan.diagramNodeId}?tab=development&plan=${plan.id}`,
  );
  await expect(page.locator(".development-plan-item.selected")).toContainText(plan.title);
  await expect(page.locator(".plan-delivery-console h3")).toHaveText(plan.title);
  await page.screenshot({ path: "artifacts/regression/plan-delivery-selected-chrome.png", fullPage: true });
});

test("draft plan details and delivery console expose three distinct assigned agents", async ({ page, historicalProject }) => {
  const project = { id: historicalProject.projectId };
  const prerequisite = await historicalProject.createPlan();
  const plan = await historicalProject.createPlan([prerequisite.id]);
  const assignedIds = Object.values(plan.roleAssignments).map((item) => item.agentId);
  expect(new Set(assignedIds).size).toBe(3);
  expect(assignedIds.every(Boolean)).toBeTruthy();

  await page.goto(`/#/projects/${project.id}?tab=plans`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("workflow-layer-summary")).toHaveCount(0);
  await expect(page.locator("table.table")).toContainText("第 2 层");
  await page.getByRole("button", { name: plan.title, exact: true }).click();
  const detail = page.locator(".modal", { has: page.locator(".plan-detail") });
  await expect(detail.getByRole("heading", { name: "角色分配" })).toBeVisible();
  await expect(detail).toContainText("ProductDesign Designer（方案 B）");
  await expect(detail).toContainText("Codex Builder");
  await expect(detail).toContainText("Codex Auditor（独立审计 Agent）");
  await detail.locator(".plan-detail-section", { hasText: "角色分配" }).screenshot({
    path: "artifacts/regression/plan-role-separation-chrome.png",
  });

  await detail.getByRole("button", { name: "进入实施流程" }).click();
  const delivery = page.locator(".plan-delivery-console");
  await expect(page.locator(".development-plan-item.selected")).toContainText("第 2 层");
  await delivery.getByRole("button", { name: "展开角色与交付信息", exact: true }).click();
  await expect(delivery).toContainText("设计者");
  await expect(delivery).toContainText("施工者");
  await expect(delivery).toContainText("审计者");
  await expect(delivery).toContainText("ProductDesign Designer（方案 B）");
  await expect(delivery).toContainText("Codex Builder");
  await expect(delivery).toContainText("Codex Auditor（独立审计 Agent）");
  await delivery.locator(".plan-delivery-facts").screenshot({
    path: "artifacts/regression/plan-role-delivery-console-chrome.png",
  });
});
