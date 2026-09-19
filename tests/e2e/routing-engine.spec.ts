import path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1600, height: 1000 } });

const diagramId = "f362be99-5733-490d-af8e-b6fb82f70a0f";

test("renders intelligent routes and exposes precise edge controls", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    const sourceUrl = message.location().url;
    if (message.type() === "error" && !sourceUrl.endsWith("/favicon.ico")) {
      consoleErrors.push(`${message.text()} ${sourceUrl}`.trim());
    }
  });

  await page.goto(`/#/canvas/${diagramId}`);
  await expect(page.locator(".canvas-svg")).toBeVisible();
  await expect(page.locator("[data-edge-id]")).toHaveCount(6);

  const routedEdge = page.locator('path[data-edge-id="edge-routing-layers"]');
  await expect(routedEdge).toHaveAttribute("d", /Q/);
  await expect(routedEdge).not.toHaveAttribute("d", /NaN|Infinity/);
  await routedEdge.focus();
  await expect(routedEdge).toHaveCSS("outline-style", "none");

  const inspector = page.locator(".canvas-inspector");
  await expect(inspector.getByText("连线编辑")).toBeVisible();
  await expect(inspector.getByText("路由", { exact: true })).toBeVisible();
  await expect(inspector.getByText("交叉", { exact: true })).toBeVisible();
  await expect(inspector.locator(".edge-routing-status")).toContainText(/路径正常|已降级/);
  await expect(page.locator('.edge-endpoint-handles [role="slider"]').first()).toBeVisible();

  await page.screenshot({
    path: path.resolve("screenshots/routing-engine-chrome.png"),
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});

test("lays out decision branches with outward ports and readable labels", async ({ page }) => {
  const fixtureId = diagramId;
  const fixture = {
    id: fixtureId,
    projectId: "93775248-c4e3-4697-8ef9-41d5dd1b8a21",
    title: "判断分支布局回归",
    type: "flow",
    nodes: [
      { id: "decision", kind: "requirement", label: "inputMode", x: 520, y: 260, w: 260, h: 150, shape: "diamond", flowType: "decision" },
      { id: "amount", kind: "feature", label: "金额输入", x: 280, y: 540, w: 160, h: 60, shape: "rect", flowType: "process" },
      { id: "numbers", kind: "feature", label: "号码输入", x: 800, y: 540, w: 160, h: 60, shape: "rect", flowType: "process" },
    ],
    edges: [
      { id: "amount-edge", from: "decision", to: "amount", sourcePort: "bottom", targetPort: "top", label: "AMOUNT", style: "ortho" },
      { id: "numbers-edge", from: "decision", to: "numbers", sourcePort: "right", targetPort: "top", label: "NUMBERS", style: "ortho" },
    ],
    groups: [],
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
  await page.route(`**/api/diagrams/${fixtureId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(fixture),
    });
  });
  await page.route("**/api/diagrams?projectId=*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify([fixture]) });
  });

  await page.goto(`/#/canvas/${fixtureId}`);
  await expect(page.locator(".canvas-svg")).toBeVisible();
  const amountPath = page.locator('[data-edge-id="amount-edge"]');
  const numbersPath = page.locator('[data-edge-id="numbers-edge"]');
  await expect(amountPath).toHaveAttribute("d", /^M 520 335 L 520 /);
  const numbersD = await numbersPath.getAttribute("d");
  const firstNumbersSegment = numbersD?.match(/^M 650 260 L ([\d.]+) 260/);
  expect(Number(firstNumbersSegment?.[1])).toBeGreaterThan(650);
  await expect(page.locator(".canvas-edge-label", { hasText: "AMOUNT" })).toBeVisible();
  await expect(page.locator(".canvas-edge-label", { hasText: "NUMBERS" })).toBeVisible();

  await page.screenshot({
    path: path.resolve("screenshots/decision-branch-routing-chrome.png"),
    fullPage: true,
  });
});
