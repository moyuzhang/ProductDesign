import { expect, test } from "@playwright/test";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }, viewport: { width: 1440, height: 960 } });

// Deliberately isolated API fixtures: no project, approval, or execution is written to a live backend.
const project = { id: "flow-fixture", name: "交付主流程测试", code: "FLOW_FIXTURE", summary: "验证目标到交付的入口", nextStep: "", riskSummary: "", blockerSummary: "", stage: "设计", health: "正常", progress: 0, riskLevel: "P2", startAt: "", dueAt: "", updatedAt: "2026-09-30T00:00:00Z", unconfigured: true };
const workflow = { policyVersion: "1", phase: "discovery", phaseLabel: "了解项目", status: "blocked", summary: "请先确认项目目标与简报", nextAction: { title: "确认项目简报", description: "补齐目标和验收标准", href: "#/projects/flow-fixture?tab=documents" }, nodes: [], layerGate: { totalLayers: 0 } };

test("new projects open the real next-step surface; tools and browser history remain accessible", async ({ page }) => {
  let created = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (url.pathname === "/api/projects" && route.request().method() === "POST") { created = true; body = project; }
    else if (url.pathname === "/api/projects") body = url.searchParams.has("offset") ? { items: created ? [project] : [], total: created ? 1 : 0 } : created ? [project] : [];
    else if (url.pathname.endsWith("/workspace")) body = { project, mainDiagram: null, metrics: { functionalNodes: 0, completedNodes: 0, acceptedNodes: 0, pendingAcceptanceNodes: 0, completedPlans: 0, plans: 0, documents: 0, evidence: 0, missingEvidenceNodes: 0 } };
    else if (url.pathname.endsWith("/workflow")) body = workflow;
    else if (url.searchParams.has("offset")) body = { items: [], total: 0 };
    await route.fulfill({ json: body });
  });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByPlaceholder("如 ARRANGE_FIVE").fill("FLOW_FIXTURE");
  await page.getByPlaceholder("如 排列五助手").fill(project.name);
  await page.getByRole("button", { name: "创建并进入设计" }).click();
  await expect(page).toHaveURL(/flow-fixture\?tab=workflow$/);
  await expect(page.locator(".ws-context-copy strong")).toHaveText(project.name);
  await expect(page.getByRole("button", { name: "打开设计助手" })).toBeVisible();
  await expect(page.locator(".delivery-flow")).toContainText("生成设计");
  await expect(page.getByRole("button", { name: "画布节点", exact: true })).not.toBeVisible();
  await page.getByText("外部开发与辅助工具", { exact: true }).click();
  await expect(page.getByRole("button", { name: "画布节点", exact: true })).toBeVisible();
  await page.getByText("外部开发与辅助工具", { exact: true }).click();
  await page.screenshot({ path: "artifacts/main-flow-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "审阅设计文档" }).click();
  await expect(page).toHaveURL(/tab=documents$/);
  await page.goBack();
  await expect(page.getByRole("button", { name: "打开设计助手" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "审阅设计文档" })).toBeVisible();
  await page.screenshot({ path: "artifacts/main-flow-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("workflow failure is retryable and absence of an action is not presented as acceptance", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/workflow")) {
      reads += 1;
      if (reads === 1) return route.fulfill({ status: 503, json: { error: "流程服务暂不可用" } });
      return route.fulfill({ json: { ...workflow, nextAction: null } });
    }
    const body = url.pathname.endsWith("/workspace") ? { project, mainDiagram: null, metrics: {} } : url.searchParams.has("offset") ? { items: [], total: 0 } : [project];
    await route.fulfill({ json: body });
  });
  await page.goto("/#/projects/flow-fixture");
  await page.getByText("外部开发交付（由连接的 harness 执行）", { exact: true }).click();
  await page.getByRole("button", { name: "重试加载流程" }).click();
  await expect(page.getByText("当前没有可执行的下一步。请刷新流程并检查缺失门禁；这不代表已完成。", { exact: true })).toBeVisible();
  await expect(page.getByText("所有交付节点均已验收", { exact: true })).toHaveCount(0);
});
