import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1600, height: 1000 } });

interface DiagramPayload {
  id: string;
  projectId: string;
  title: string;
  type: string;
  nodes: unknown[];
  edges: unknown[];
  groups: unknown[];
}

/** 直接走 /mcp 的 JSON-RPC（服务器为无状态模式，单次 POST 即可完成 tools/call）。 */
async function mcpCall(request: APIRequestContext, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request.post("/mcp", {
    headers: { accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.ok()).toBeTruthy();
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`MCP 未返回 SSE data 帧：${text.slice(0, 200)}`);
  const envelope = JSON.parse(dataLine.slice(6)) as { result: { content: { text: string }[]; isError?: boolean } };
  const payload = envelope.result.content[0]?.text ?? "";
  if (envelope.result.isError) throw new Error(`MCP 工具失败：${payload}`);
  return JSON.parse(payload) as Record<string, unknown>;
}

/** 图层面板根节点：同级还挂着组件库，二者都渲染 role="status"，断言必须限定在面板作用域内。 */
const layerPanel = (page: Page): Locator => page.locator("section.layer-panel");

async function openLayers(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "图层/组件" }).click();
  const panel = layerPanel(page);
  await expect(panel.getByRole("listbox", { name: "图层列表" })).toBeVisible();
  return panel;
}

async function openTemplateDialog(page: Page) {
  await page.getByRole("button", { name: "模板", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "模板库" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("E2E-TMP-01..03 模板闭环、图层持久化与 MCP 一致", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    const sourceUrl = message.location().url;
    if (message.type() === "error" && !sourceUrl.endsWith("/favicon.ico")) {
      consoleErrors.push(`${message.text()} ${sourceUrl}`.trim());
    }
  });

  // ---- 引导：项目 + 源画布 + 目标画布 ----
  const projectResponse = await request.post("/api/projects", {
    data: { code: `e2e-tpl-${Date.now()}`, name: "E2E 模板闭环项目", summary: "图层/组件/模板闭环验证" },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = (await projectResponse.json()) as { id: string };

  const sourceResponse = await request.post("/api/diagrams", {
    data: {
      projectId: project.id, title: "E2E 源画布", type: "free", groups: [],
      nodes: [
        { id: "e2e-src-node", kind: "feature", label: "闭环节点", x: 200, y: 160, w: 200, h: 60 },
      ],
      edges: [],
    },
  });
  expect(sourceResponse.ok()).toBeTruthy();
  const source = (await sourceResponse.json()) as DiagramPayload;

  const targetResponse = await request.post("/api/diagrams", {
    data: { projectId: project.id, title: "E2E 目标画布", type: "free", nodes: [], edges: [], groups: [] },
  });
  expect(targetResponse.ok()).toBeTruthy();
  const target = (await targetResponse.json()) as DiagramPayload;

  // ---- E2E-TMP-02 图层锁定/隐藏落库 ----
  await page.goto(`/#/canvas/${source.id}`);
  await expect(page.locator(".canvas-svg")).toBeVisible();
  let panel = await openLayers(page);
  const nodeRow = () => panel.locator('.layer-row:has(.layer-name:text-is("交付节点"))');

  await panel.locator('button[title="隐藏图层交付节点"]').click();
  await expect(panel.locator(".layer-panel-status")).toContainText("已隐藏图层：交付节点");
  await panel.locator('button[title="锁定图层交付节点"]').click();
  await expect(panel.locator(".layer-panel-status")).toContainText("已锁定图层：交付节点");
  await expect(panel.locator('button[title="显示图层交付节点"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('button[title="解锁图层交付节点"]')).toHaveAttribute("aria-pressed", "true");
  await expect(nodeRow()).toHaveAttribute("aria-label", "交付节点，成员 1 项，已锁定，已隐藏");

  // 刷新后状态一致（服务端持久化）
  await page.reload();
  panel = await openLayers(page);
  await expect(panel.locator('button[title="显示图层交付节点"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('button[title="解锁图层交付节点"]')).toHaveAttribute("aria-pressed", "true");
  await expect(nodeRow()).toHaveAttribute("aria-label", "交付节点，成员 1 项，已锁定，已隐藏");

  // ---- E2E-TMP-01 从画布快照创建项目级模板，刷新后仍在 ----
  const templateName = "E2E 闭环模板";
  let dialog = await openTemplateDialog(page);
  await dialog.getByRole("button", { name: "从当前画布创建模板" }).click();
  await dialog.locator(".template-create input").fill(templateName);
  await dialog.locator(".template-create").getByRole("button", { name: "确定", exact: true }).click();
  await expect(dialog.locator(".layer-panel-status")).toContainText(`已创建项目级模板：${templateName}`);
  const templateRow = dialog.locator(`.template-row:has(.template-name:text-is("${templateName}"))`);
  await expect(templateRow).toBeVisible();
  await expect(templateRow.locator(".template-compat")).toHaveText("版本一致");

  await page.reload();
  dialog = await openTemplateDialog(page);
  await expect(dialog.locator(`.template-row:has(.template-name:text-is("${templateName}"))`)).toBeVisible();

  // ---- 应用到另一画布（append 默认）----
  await dialog.locator(`.template-row:has(.template-name:text-is("${templateName}"))`).getByRole("button", { name: "应用…" }).click();
  const applyPanel = dialog.locator(".template-apply");
  await expect(applyPanel).toBeVisible();
  await applyPanel.locator('select[aria-label="目标画布"]').selectOption({ label: "E2E 目标画布" });
  await applyPanel.getByRole("button", { name: "确认应用" }).click();
  await expect(dialog.locator(".layer-panel-status")).toContainText("已应用模板");
  await expect(dialog.locator(".layer-panel-status")).toContainText("新增 1 节点");

  const applied = (await (await request.get(`/api/diagrams/${target.id}`)).json()) as DiagramPayload;
  expect(applied.nodes).toHaveLength(1);
  expect((applied.nodes[0] as { id: string }).id).not.toBe("e2e-src-node");

  // ---- E2E-TMP-03 MCP get_diagram_layers 与 REST/UI 一致 ----
  const restLayers = (await (await request.get(`/api/diagrams/${source.id}/layers`)).json()) as {
    schemaVersion: number;
    layers: { id: string; name: string; locked: boolean; hidden: boolean }[];
    itemOverrides: Record<string, unknown>;
    diagramUpdatedAt: string;
  };
  const mcpLayers = await mcpCall(request, "get_diagram_layers", { diagramId: source.id }) as {
    schemaVersion: number;
    layers: { id: string; name: string; locked: boolean; hidden: boolean }[];
    itemOverrides: Record<string, unknown>;
    diagramUpdatedAt: string;
  };
  expect(mcpLayers).toEqual(restLayers);
  const nodeLayer = restLayers.layers.find((layer) => layer.id === "layer_nodes");
  expect(nodeLayer).toMatchObject({ name: "交付节点", locked: true, hidden: true });

  // 关闭模态对话框后再操作画布（对话框带焦点陷阱，会拦截底层点击）。
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByRole("dialog", { name: "模板库" })).toBeHidden();
  panel = await openLayers(page);
  await expect(nodeRow()).toHaveAttribute("aria-label", "交付节点，成员 1 项，已锁定，已隐藏");

  await page.screenshot({ path: path.resolve("screenshots/template-loop-chrome.png"), fullPage: true });
  expect(consoleErrors).toEqual([]);
});