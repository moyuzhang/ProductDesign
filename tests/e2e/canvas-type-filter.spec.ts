import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1440, height: 960 } });

let projectId = "";
test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/projects", { data: { code: `FILTER-${Date.now()}`, name: "Synthetic canvas type filter" } });
  expect(response.ok()).toBeTruthy();
  projectId = (await response.json()).id;
  expect((await request.get(`/api/projects/${projectId}/workflow`)).ok()).toBeTruthy();
  const flow = await request.post("/api/diagrams", { data: { projectId, title: "Synthetic auxiliary flow", type: "flow", nodes: [], edges: [], groups: [] } });
  expect(flow.ok()).toBeTruthy();
});
test.afterEach(async ({ request }) => {
  const ownedProjectId = projectId;
  projectId = "";
  if (!ownedProjectId) return;
  const cleanupErrors: string[] = [];
  try {
    const state = await request.get(`/api/projects/${ownedProjectId}/workflow`);
    if (!state.ok()) cleanupErrors.push(`Read owned workflow: HTTP ${state.status()}`);
  } catch (error) { cleanupErrors.push(`Read owned workflow: ${String(error)}`); }
  try {
    const removed = await request.delete(`/api/projects/${ownedProjectId}`);
    if (!removed.ok()) cleanupErrors.push(`Delete owned project: HTTP ${removed.status()}`);
  } catch (error) { cleanupErrors.push(`Delete owned project: ${String(error)}`); }
  expect(cleanupErrors, "Synthetic canvas fixture cleanup failed").toEqual([]);
});

test("filters the paginated canvas list by diagram type", async ({ page }) => {
  await page.goto("/#/canvas");
  await expect(page.getByRole("heading", { name: "画布设计工作台" })).toBeVisible();

  if (await page.locator(".ws-context-copy strong").innerText() !== "全部项目") {
    await page.keyboard.press("Control+K");
    await page.locator(".ws-global-item").click();
    await expect(page.locator(".ws-context-copy strong")).toHaveText("全部项目");
  }

  const typeFilter = page.getByLabel("按画布类型筛选");
  await expect(typeFilter).toHaveValue("");
  await expect(typeFilter.locator("option")).toHaveText([
    "全部类型",
    "系统主画布",
    "自由画布",
    "功能架构图",
    "业务流程图",
    "部署架构图",
    "用例图",
  ]);

  const filteredResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/diagrams"
      && url.searchParams.get("type") === "main"
      && url.searchParams.get("offset") === "0";
  });
  await typeFilter.selectOption("main");
  await filteredResponse;

  const cards = page.locator(".board-card");
  await expect(cards.first()).toBeVisible();
  await expect(page.locator(".board-card:not(.board-card-main)")).toHaveCount(0);
  await expect(page.locator(".board-card-meta").getByText("系统主画布", { exact: true }).first()).toBeVisible();
});
