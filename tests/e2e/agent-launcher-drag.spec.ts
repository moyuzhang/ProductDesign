import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1200, height: 800 } });

test("Agent launcher snaps to an edge without opening and remembers its position", async ({ page }) => {
  await page.goto("/#/canvas");
  await page.waitForLoadState("networkidle");

  const launcher = page.getByRole("button", { name: "打开项目 Agent 工作台" });
  const initial = await launcher.boundingBox();
  expect(initial).not.toBeNull();

  await page.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height / 2);
  await page.mouse.down();
  await page.mouse.move(70, 220, { steps: 8 });
  await page.mouse.up();

  await expect(launcher).toHaveAttribute("data-side", "left");
  await expect(page.locator(".agent-dock")).toHaveCount(0);
  const snapped = await launcher.boundingBox();
  expect(snapped).not.toBeNull();
  expect(snapped!.x).toBeLessThanOrEqual(26);

  await page.reload();
  await page.waitForLoadState("networkidle");
  const restored = await launcher.boundingBox();
  expect(restored).not.toBeNull();
  await expect(launcher).toHaveAttribute("data-side", "left");
  expect(restored!.x).toBeLessThanOrEqual(26);
  expect(Math.abs(restored!.y - snapped!.y)).toBeLessThanOrEqual(2);

  await launcher.click();
  await expect(page.locator(".agent-dock")).toBeVisible();
});
