import { expect, test } from "@playwright/test";

interface ProjectSummary {
  id: string;
  name: string;
  code: string;
  stage: string;
}

interface ProjectWorkspaceResponse {
  project: ProjectSummary;
  mainDiagram?: { id: string } | null;
}

test.use({ channel: "chrome", viewport: { width: 1440, height: 960 } });

test("global project context stays visible and switches routes atomically", async ({ page, request }) => {
  const projectsResponse = await request.get("/api/projects");
  expect(projectsResponse.ok()).toBeTruthy();
  const projects = await projectsResponse.json() as ProjectSummary[];
  expect(projects.length).toBeGreaterThan(0);

  const source = projects.find((project) => project.code === "PRODUCTDESIGN") ?? projects[0];
  const sourceWorkspaceResponse = await request.get(`/api/projects/${source.id}/workspace`);
  expect(sourceWorkspaceResponse.ok()).toBeTruthy();
  const sourceWorkspace = await sourceWorkspaceResponse.json() as ProjectWorkspaceResponse;
  expect(sourceWorkspace.mainDiagram?.id).toBeTruthy();

  let targetWorkspace: ProjectWorkspaceResponse | undefined;
  for (const candidate of projects.filter((project) => project.id !== source.id).slice(0, 20)) {
    const response = await request.get(`/api/projects/${candidate.id}/workspace`);
    if (!response.ok()) continue;
    const workspace = await response.json() as ProjectWorkspaceResponse;
    if (workspace.mainDiagram?.id) {
      targetWorkspace = workspace;
      break;
    }
  }
  expect(targetWorkspace?.mainDiagram?.id).toBeTruthy();

  await page.goto(`/#/projects/${source.id}?tab=design`);
  await expect(page.locator(".ws-context-copy strong")).toHaveText(source.name);
  await expect(page.locator(".ws-context-copy > span")).toContainText(source.code);
  await expect(page.locator(".ws-context-copy > span")).toContainText(source.stage);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".main h1").first()).toHaveText(source.name);
  await page.screenshot({ path: "artifacts/regression/workspace-project-context.png", fullPage: true });

  await page.keyboard.press("Control+K");
  await expect(page.locator(".ws-menu")).toBeVisible();
  await expect(page.locator(".ws-menu-foot")).toContainText(`${projects.length} 个项目`);
  await page.locator(".ws-search input").fill(targetWorkspace!.project.code);
  const targetRow = page.locator(".ws-item-row", { hasText: targetWorkspace!.project.code });
  await expect(targetRow).toHaveCount(1);
  await page.screenshot({ path: "artifacts/regression/workspace-search.png", fullPage: true });
  await targetRow.locator(".ws-item").click();
  await expect.poll(() => page.url()).toContain(`#/projects/${targetWorkspace!.project.id}?tab=design`);
  await expect(page.locator(".ws-context-copy strong")).toHaveText(targetWorkspace!.project.name);

  await page.goto(`/#/canvas/${sourceWorkspace.mainDiagram!.id}`);
  await expect(page.locator(".ws-context-copy strong")).toHaveText(source.name);
  await page.keyboard.press("Control+K");
  await page.locator(".ws-search input").fill(targetWorkspace!.project.code);
  await page.locator(".ws-item-row", { hasText: targetWorkspace!.project.code }).locator(".ws-item").click();
  await expect.poll(() => page.url()).toContain(`#/canvas/${targetWorkspace!.mainDiagram!.id}`);
  await expect(page.locator(".ws-context-copy strong")).toHaveText(targetWorkspace!.project.name);

  await page.keyboard.press("Control+K");
  await page.locator(".ws-global-item").click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#/canvas");
  await expect(page.locator(".ws-context-copy strong")).toHaveText("全部项目");
  await page.screenshot({ path: "artifacts/regression/workspace-global-canvas.png", fullPage: true });
});

test("project context remains accessible on a mobile viewport", async ({ page, request }) => {
  const projects = await (await request.get("/api/projects")).json() as ProjectSummary[];
  const project = projects.find((item) => item.code === "PRODUCTDESIGN") ?? projects[0];

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#/projects/${project.id}`);
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".ws-btn")).toBeVisible();
  await expect(page.locator(".ws-context-copy strong")).toHaveText(project.name);
  await expect(page.locator(".ws-context-copy > span")).toContainText(project.code);
  await expect(page.locator(".ws-context-copy > span")).toContainText(project.stage);
  await page.screenshot({ path: "artifacts/regression/workspace-mobile.png", fullPage: true });
});
