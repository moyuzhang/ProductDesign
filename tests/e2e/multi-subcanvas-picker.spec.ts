import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1440, height: 960 } });

const projectId = "93775248-c4e3-4697-8ef9-41d5dd1b8a21";
const parentId = "test-multi-parent";
const childAId = "test-multi-child-a";
const childBId = "test-multi-child-b";

function diagram(id: string, title: string, nodes: Array<Record<string, unknown>> = []) {
  return {
    id,
    projectId,
    title,
    type: "functional",
    nodes,
    edges: [],
    groups: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

test("chooses the second canvas when a node has multiple sub-canvas links", async ({ page }) => {
  const parent = diagram(parentId, "多子画布测试", [{
    id: "multi-node",
    kind: "feature",
    label: "多画布节点",
    x: 300,
    y: 220,
    linkDiagramIds: [childAId, childBId],
  }]);
  const childA = diagram(childAId, "业务视角");
  const childB = diagram(childBId, "数据视角");
  const synthetic = new Map([parent, childA, childB].map((item) => [item.id, item]));

  await page.route("**/agent-events**", (route) => route.abort());
  await page.route("**/api/diagrams**", async (route) => {
    const url = new URL(route.request().url());
    const diagramId = url.pathname.startsWith("/api/diagrams/") ? url.pathname.slice("/api/diagrams/".length) : "";
    const target = synthetic.get(diagramId);
    if (target) {
      await route.fulfill({ status: 200, contentType: "application/json", json: target });
      return;
    }
    if (url.pathname === "/api/diagrams") {
      const items = [parent, childA, childB];
      const paginated = url.searchParams.has("offset") || url.searchParams.has("limit");
      await route.fulfill({ status: 200, contentType: "application/json", json: paginated
        ? { items, total: items.length, offset: 0, limit: Number(url.searchParams.get("limit") ?? items.length), hasMore: false }
        : items });
      return;
    }
    await route.continue();
  });

  await page.goto(`/#/canvas/${parentId}`);
  const quickOpen = page.getByRole("button", { name: "打开 多画布节点 关联的子画布，共 2 个" });
  await expect(quickOpen).toBeVisible();
  await quickOpen.click();

  const picker = page.getByRole("dialog", { name: "选择 多画布节点 的子画布" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "业务视角 打开关联画布" })).toBeVisible();
  await picker.getByRole("button", { name: "数据视角 打开关联画布" }).click();
  await expect(page).toHaveURL(new RegExp(`/#/canvas/${childBId}$`));
});
