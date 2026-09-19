import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1440, height: 960 } });

const projectId = "93775248-c4e3-4697-8ef9-41d5dd1b8a21";
const diagramId = "test-group-overlap-guard";

test("stops a dragged group before it overlaps another group", async ({ page }) => {
  const diagram = {
    id: diagramId,
    projectId,
    title: "组合区域防重叠",
    type: "functional",
    nodes: [
      { id: "a1", kind: "feature", label: "A1", x: 220, y: 220 },
      { id: "a2", kind: "feature", label: "A2", x: 320, y: 220 },
      { id: "b1", kind: "feature", label: "B1", x: 620, y: 220 },
      { id: "b2", kind: "feature", label: "B2", x: 720, y: 220 },
    ],
    edges: [],
    groups: [
      { id: "group-a", name: "区域 A", nodeIds: ["a1", "a2"] },
      { id: "group-b", name: "区域 B", nodeIds: ["b1", "b2"] },
    ],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };

  await page.route("**/agent-events**", (route) => route.abort());
  await page.route("**/api/diagrams**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === `/api/diagrams/${diagramId}`) {
      await route.fulfill({ status: 200, contentType: "application/json", json: diagram });
      return;
    }
    if (url.pathname === "/api/diagrams") {
      const paginated = url.searchParams.has("offset") || url.searchParams.has("limit");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: paginated
          ? { items: [diagram], total: 1, offset: 0, limit: 20, hasMore: false }
          : [diagram],
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/#/canvas/${diagramId}`);
  const groupA = page.locator('[data-group-id="group-a"]');
  const groupB = page.locator('[data-group-id="group-b"]');
  await expect(groupA).toBeVisible();

  const groupBorder = await groupA.locator("rect").boundingBox();
  if (!groupBorder) throw new Error("区域 A 未渲染");
  await page.mouse.click(groupBorder.x + 4, groupBorder.y + 4);

  const member = page.locator('[data-node-id="a1"]');
  const memberBox = await member.boundingBox();
  if (!memberBox) throw new Error("组合成员 A1 未渲染");
  const startX = memberBox.x + memberBox.width / 2;
  const startY = memberBox.y + memberBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 250, startY, { steps: 25 });
  await page.mouse.up();

  await expect(page.getByRole("alert").filter({ hasText: "组合区域“区域 A”与“区域 B”不允许重叠" })).toBeVisible();
  await expect(groupA).toHaveAttribute("data-overlap-conflict", "true");
  await expect(groupB).toHaveAttribute("data-overlap-conflict", "true");

  const transform = await member.getAttribute("transform");
  const movedX = Number(transform?.match(/translate\(([-\d.]+)/)?.[1]);
  expect(movedX).toBeLessThan(320);
});
