import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./historical-fixtures";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } });

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message: { type: () => string; location: () => { url: string }; text: () => string }) => {
    const sourceUrl = message.location().url;
    if (message.type() === "error" && !sourceUrl.endsWith("/favicon.ico")) errors.push(`${message.text()} ${sourceUrl}`.trim());
  });
  return errors;
}

test("keeps the inspector docked and exposes focused workspace controls at 1366×768", async ({ page, historicalProject }) => {
  const { diagramId } = historicalProject;
  await page.setViewportSize({ width: 1366, height: 768 });
  const consoleErrors = collectConsoleErrors(page);
  await page.goto(`/#/canvas/${diagramId}`);
  await expect(page.locator(".canvas-svg")).toBeVisible({ timeout: 15_000 });

  const node = page.locator("[data-node-id]").first();
  await node.focus();
  const inspector = page.locator(".canvas-inspector");
  await expect(inspector).toBeVisible();

  const svgBox = await page.locator(".canvas-svg").boundingBox();
  const inspectorBox = await inspector.boundingBox();
  expect(svgBox).not.toBeNull();
  expect(inspectorBox).not.toBeNull();
  expect(svgBox!.x + svgBox!.width).toBeLessThanOrEqual(inspectorBox!.x);

  const toolbar = page.locator(".canvas-toolbar");
  const toolbarBox = await toolbar.boundingBox();
  const toolbarCenters = await toolbar.locator(":scope > *").evaluateAll((elements) => elements
    .filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }));
  expect(Math.max(...toolbarCenters) - Math.min(...toolbarCenters)).toBeLessThanOrEqual(2);
  expect(toolbarBox!.height).toBeLessThanOrEqual(56);

  const resizeHandle = page.getByRole("separator", { name: "调整属性面板宽度" });
  await resizeHandle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(resizeHandle).toHaveAttribute("aria-valuenow", "332");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem(`diagram-inspector-width:${location.hash.split("/")[2]}`))).toBe("332");

  await page.getByRole("button", { name: "折叠属性面板" }).click();
  await expect(inspector).toBeHidden();
  await expect(page.getByRole("button", { name: "展开属性面板" })).toBeVisible();
  await page.getByRole("button", { name: "展开属性面板" }).click();
  await expect(inspector).toBeVisible();

  const world = page.locator(".canvas-svg > g[transform]").first();
  const focusedTransform = await world.getAttribute("transform");
  await page.getByTitle("缩小").click();
  await page.keyboard.press("f");
  await expect.poll(() => world.getAttribute("transform")).not.toBe(focusedTransform);
  await page.keyboard.press("Control+0");

  await page.locator(".canvas-toolbar-more > summary").click();
  await expect(page.getByRole("button", { name: "导出 PNG" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出 SVG" })).toBeVisible();

  await page.getByRole("button", { name: "专注", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/canvas-focus-mode-active/);
  await expect(inspector).toBeHidden();
  await expect(node).toHaveAttribute("filter", "url(#node-selected)");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveClass(/canvas-focus-mode-active/);
  await expect(inspector).toBeVisible();

  await page.screenshot({ path: path.resolve("screenshots/canvas-workspace-1366.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("docks the element library and keeps navigation clear of Agent at 1600×1000", async ({ page, historicalProject }) => {
  const { diagramId } = historicalProject;
  await page.setViewportSize({ width: 1600, height: 1000 });
  const consoleErrors = collectConsoleErrors(page);
  await page.goto(`/#/canvas/${diagramId}`);
  await expect(page.locator(".canvas-minimap")).toBeVisible({ timeout: 15_000 });

  await page.locator(".palette-tab").focus();
  await page.keyboard.press("Enter");
  const palette = page.locator(".shape-palette-dock");
  await expect(palette).toBeVisible();
  const paletteBox = await palette.boundingBox();
  const canvasBox = await page.locator(".canvas-wrap").boundingBox();
  expect(paletteBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(paletteBox!.x + paletteBox!.width).toBeLessThanOrEqual(canvasBox!.x + 1);

  const miniMap = page.locator(".canvas-minimap");
  const launcher = page.locator(".agent-launcher");
  const miniMapBox = await miniMap.boundingBox();
  const launcherBox = await launcher.boundingBox();
  expect(miniMapBox).not.toBeNull();
  expect(launcherBox).not.toBeNull();
  const overlaps = miniMapBox!.x < launcherBox!.x + launcherBox!.width
    && miniMapBox!.x + miniMapBox!.width > launcherBox!.x
    && miniMapBox!.y < launcherBox!.y + launcherBox!.height
    && miniMapBox!.y + miniMapBox!.height > launcherBox!.y;
  expect(overlaps).toBe(false);

  const head = page.getByRole("button", { name: "拖动画布导航" });
  const headBox = await head.boundingBox();
  const viewportBox = await page.locator(".canvas-viewport").boundingBox();
  await page.mouse.move(headBox!.x + headBox!.width / 2, headBox!.y + headBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(viewportBox!.x + viewportBox!.width / 2, viewportBox!.y + viewportBox!.height / 2, { steps: 5 });
  await page.mouse.up();
  const snapped = await miniMap.evaluate((element) => ({ left: Number.parseFloat((element as HTMLElement).style.left), top: Number.parseFloat((element as HTMLElement).style.top) }));
  expect(Number.isFinite(snapped.left)).toBe(true);
  expect(Number.isFinite(snapped.top)).toBe(true);
  const snappedBox = await miniMap.boundingBox();
  const currentViewportBox = await page.locator(".canvas-viewport").boundingBox();
  const localX = snappedBox!.x - currentViewportBox!.x;
  const localY = snappedBox!.y - currentViewportBox!.y;
  const cornerDistances = [
    Math.hypot(localX - 12, localY - 12),
    Math.hypot(localX - 12, currentViewportBox!.height - snappedBox!.height - localY - 12),
    Math.hypot(currentViewportBox!.width - snappedBox!.width - localX - 12, localY - 12),
    Math.hypot(currentViewportBox!.width - snappedBox!.width - localX - 12, currentViewportBox!.height - snappedBox!.height - localY - 12),
  ];
  expect(Math.min(...cornerDistances)).toBeLessThanOrEqual(2);

  await page.screenshot({ path: path.resolve("screenshots/canvas-workspace-1600.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
});
