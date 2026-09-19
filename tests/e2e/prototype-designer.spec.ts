import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildApp } from "../../src/server/index.js";

test.use({
  channel: (process.env.PROTOTYPE_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge",
  viewport: { width: 1600, height: 1000 },
});

const dataDir = mkdtempSync(join(tmpdir(), "pcs-prototype-browser-"));
const app = buildApp({ dbPath: join(dataDir, "prototype-browser.db"), dataDir });
let origin = "";
let diagramId = "";
let baseDraft: Record<string, unknown>;

async function openDesigner(page: Page) {
  await page.goto(`${origin}/#/canvas/${diagramId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /页面原型/ }).click();
  const designer = page.getByRole("dialog", { name: "应用页面原型设计器" });
  await expect(designer).toBeVisible();
  await expect(designer.locator(".prototype-save-state")).toHaveText("已保存");
  return designer;
}

async function selectLayer(designer: Locator, text: string) {
  const layer = designer.locator(".prototype-layer", { hasText: text });
  await layer.locator(".prototype-layer-name").click();
  return layer;
}

async function dragBy(page: Page, component: Locator, dx: number, dy: number) {
  const box = await component.boundingBox();
  if (!box) throw new Error("组件没有可用边界");
  await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + Math.min(20, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(20, box.width / 2) + dx, box.y + Math.min(20, box.height / 2) + dy);
  await page.mouse.up();
}

async function setZoom(designer: Locator, target: 25 | 50 | 100 | 200) {
  const current = designer.locator(".prototype-zoom button").nth(1);
  await current.click();
  if (target < 100) {
    const count = target === 50 ? 2 : 3;
    for (let index = 0; index < count; index += 1) await designer.getByRole("button", { name: "缩小" }).click();
  } else if (target > 100) {
    for (let index = 0; index < 3; index += 1) await designer.getByRole("button", { name: "放大" }).click();
  }
  await expect(current).toHaveText(`${target}%`);
}

test.beforeAll(async ({ browser }) => {
  app.get("/prototype-fixture.svg", async (_request, reply) => reply.type("image/svg+xml").send(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#78d7ff"/><stop offset="1" stop-color="#19566f"/></linearGradient></defs><rect width="600" height="360" rx="28" fill="url(#g)"/><circle cx="470" cy="92" r="58" fill="#d7f6ff" opacity=".42"/><path d="M60 280L210 130l92 92 62-62 176 120" fill="none" stroke="#effbff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("页面原型浏览器测试服务监听失败");
  origin = `http://127.0.0.1:${address.port}`;
  console.log(`[prototype-e2e] origin=${origin}`);
  console.log(`[prototype-e2e] dataDir=${dataDir}`);
  console.log(`[prototype-e2e] browser=${browser.browserType().name()} version=${browser.version()} channel=${process.env.PROTOTYPE_BROWSER_CHANNEL ?? "chrome"}`);

  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { code: "PROTOTYPE_BROWSER", name: "应用页面设计", summary: "隔离浏览器测试", stage: "开发", health: "正常" },
  });
  expect(project.statusCode, project.body).toBe(200);
  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${project.json().id}` });
  diagramId = (diagrams.json() as Array<{ id: string; type: string }>).find((diagram) => diagram.type === "main")!.id;
  baseDraft = {
    version: 1,
    updatedAt: "2026-09-17T00:00:00.000Z",
    screens: [{
      id: "home",
      name: "运营总览",
      width: 800,
      height: 600,
      background: "#10222d",
      components: [
        { id: "eyebrow", kind: "text", x: 48, y: 42, w: 300, h: 26, text: "PRODUCT DESIGN CONTROL", textColor: "#78d7ff", fill: "transparent", borderColor: "transparent", borderWidth: 0, borderRadius: 0, opacity: 1, fontSize: 12, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
        { id: "title", kind: "text", x: 48, y: 76, w: 430, h: 56, text: "让交付状态一眼可见", textColor: "#f0f8fb", fill: "transparent", borderColor: "transparent", borderWidth: 0, borderRadius: 0, opacity: 1, fontSize: 30, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
        { id: "hero", kind: "image", x: 500, y: 42, w: 252, h: 152, text: "项目进度视觉摘要", textColor: "#d8edf8", fill: "#152d3a", borderColor: "#507287", borderWidth: 1, borderRadius: 18, opacity: 1, fontSize: 14, imageUrl: `${origin}/prototype-fixture.svg`, imageFit: "cover", hidden: false, locked: false },
        { id: "card-a", kind: "card", x: 48, y: 176, w: 216, h: 122, text: "12 个设计节点\n本周已批准 8 项", textColor: "#d8edf8", fill: "#183542", borderColor: "#315c70", borderWidth: 1, borderRadius: 14, opacity: 1, fontSize: 16, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
        { id: "card-b", kind: "card", x: 282, y: 176, w: 216, h: 122, text: "3 个实现任务\n全部按计划推进", textColor: "#d8edf8", fill: "#183542", borderColor: "#315c70", borderWidth: 1, borderRadius: 14, opacity: 1, fontSize: 16, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
        { id: "email", kind: "input", x: 48, y: 338, w: 450, h: 52, text: "输入项目名称快速定位", textColor: "#8fb0be", fill: "#0d1b24", borderColor: "#355a6b", borderWidth: 1, borderRadius: 10, opacity: 1, fontSize: 14, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
        { id: "primary", kind: "button", x: 48, y: 416, w: 216, h: 54, text: "打开项目工作台", textColor: "#07151d", fill: "#72d4ff", borderColor: "#8de0ff", borderWidth: 1, borderRadius: 12, opacity: 1, fontSize: 15, imageUrl: "", imageFit: "contain", hidden: false, locked: false },
      ],
    }, {
      id: "detail",
      name: "项目详情",
      width: 800,
      height: 600,
      background: "#10222d",
      components: [{ id: "detail-title", kind: "text", x: 48, y: 48, w: 400, h: 48, text: "项目详情", textColor: "#f0f8fb", fill: "transparent", borderColor: "transparent", borderWidth: 0, borderRadius: 0, opacity: 1, fontSize: 28, imageUrl: "", imageFit: "contain", hidden: false, locked: false }],
    }],
  };
  const saved = await app.inject({
    method: "PATCH",
    url: `/api/diagrams/${diagramId}/prototype`,
    payload: { expectedUpdatedAt: null, current: baseDraft, versions: [] },
  });
  expect(saved.statusCode, saved.body).toBe(200);
});

test.beforeEach(async () => {
  const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/prototype` });
  const stored = before.json();
  const reset = await app.inject({
    method: "PATCH",
    url: `/api/diagrams/${diagramId}/prototype`,
    payload: { expectedUpdatedAt: stored.updatedAt, current: baseDraft, versions: stored.versions },
  });
  expect(reset.statusCode, reset.body).toBe(200);
});

test.afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("real Chromium edits, saves, previews and visibly renders an application page", async ({ page }) => {
  const designer = await openDesigner(page);
  await expect(designer.locator(".prototype-canvas")).toHaveCSS("width", "800px");
  await expect(designer.locator(".prototype-canvas")).toHaveCSS("height", "600px");
  await expect(designer.locator(".prototype-canvas").getByText("让交付状态一眼可见", { exact: true })).toBeVisible();
  await expect(designer.locator(".prototype-component-image img")).toBeVisible();

  const titleLayer = designer.locator(".prototype-layer", { hasText: "让交付状态一眼可见" });
  await titleLayer.locator(".prototype-layer-name").click();
  await expect(designer.getByLabel("X")).toHaveValue("48");
  await designer.getByRole("button", { name: "缩小" }).click();
  await designer.getByRole("button", { name: "缩小" }).click();
  await expect(designer.getByRole("button", { name: "50%" })).toBeVisible();
  const title = designer.locator(".prototype-component", { hasText: "让交付状态一眼可见" });
  const box = await title.boundingBox();
  if (!box) throw new Error("标题组件没有可用边界");
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 20);
  await page.mouse.up();
  await expect(designer.getByLabel("X")).toHaveValue("128");

  await designer.getByLabel("文字颜色").fill("#fff4c2");
  await designer.getByLabel("文字颜色").press("Enter");

  const canvas = designer.locator(".prototype-canvas");
  await canvas.click({ position: { x: 390, y: 290 } });
  await designer.getByLabel("页面名称").fill("运营中心");
  await designer.getByLabel("页面名称").press("Enter");
  await designer.getByLabel("画板宽").fill("900");
  await designer.getByLabel("画板宽").press("Enter");
  await designer.getByLabel("画板高").fill("650");
  await designer.getByLabel("画板高").press("Enter");
  await designer.getByLabel("画板背景").fill("#0e1d27");
  await designer.getByLabel("画板背景").press("Enter");
  await expect(canvas).toHaveCSS("width", "900px");
  await expect(canvas).toHaveCSS("height", "650px");
  await expect(canvas).toHaveCSS("background-color", "rgb(14, 29, 39)");
  await designer.getByRole("button", { name: "保存草稿" }).click();
  await expect(designer.locator(".prototype-save-state")).toHaveText("已保存");

  await designer.getByRole("button", { name: "只读预览" }).click();
  await expect(designer.getByRole("button", { name: "保存草稿" })).toHaveCount(0);
  await expect(designer.locator(".prototype-palette")).toHaveCount(0);
  await expect(designer.locator(".prototype-canvas")).toHaveCSS("background-image", "none");
  await designer.locator(".prototype-component-button", { hasText: "打开项目工作台" }).click();
  await expect(designer.getByText("项目详情", { exact: true }).first()).toBeVisible();
  await designer.getByRole("button", { name: "退出预览" }).click();
  await expect(designer.locator(".prototype-canvas").getByText("让交付状态一眼可见", { exact: true })).toBeVisible();

  await designer.getByRole("button", { name: "50%" }).click();
  const cardLayer = designer.locator(".prototype-layer", { hasText: "12 个设计节点" });
  await cardLayer.locator(".prototype-layer-name").click();
  const screenshotPath = resolve(process.env.PROTOTYPE_SCREENSHOT ?? "test-results/prototype-designer.png");
  mkdirSync(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /页面原型/ }).click();
  const reopened = page.getByRole("dialog", { name: "应用页面原型设计器" });
  await expect(reopened.locator(".prototype-screens button.active")).toContainText("运营中心");
  await expect(reopened.getByLabel("页面名称")).toHaveValue("运营中心");
  await expect(reopened.getByLabel("画板宽")).toHaveValue("900");
  await expect(reopened.getByLabel("画板高")).toHaveValue("650");
  await expect(reopened.getByLabel("画板背景")).toHaveValue("#0e1d27");
  await expect(reopened.locator(".prototype-canvas")).toHaveCSS("background-color", "rgb(14, 29, 39)");
  await reopened.locator(".prototype-layer", { hasText: "让交付状态一眼可见" }).locator(".prototype-layer-name").click();
  await expect(reopened.getByLabel("X")).toHaveValue("128");
  await expect(reopened.getByLabel("文字颜色")).toHaveValue("#fff4c2");
});

test("pointer math, resize commit and resize cancel work at the required zoom levels", async ({ page }) => {
  const designer = await openDesigner(page);
  await selectLayer(designer, "让交付状态一眼可见");
  const title = designer.locator(".prototype-canvas .prototype-component", { hasText: "让交付状态一眼可见" });
  for (const [zoom, delta] of [[25, 160], [50, 80], [100, 40], [200, 20]] as const) {
    await setZoom(designer, zoom);
    await dragBy(page, title, 40, 0);
    await expect(designer.getByLabel("X")).toHaveValue(String(48 + delta));
    await designer.locator('button[title="撤销"]').click();
    await expect(designer.getByLabel("X")).toHaveValue("48");
  }

  const stageScroll = designer.locator(".prototype-stage-scroll");
  await stageScroll.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
  const scrollBox = await title.boundingBox();
  if (!scrollBox) throw new Error("滚动手势组件没有可用边界");
  await page.mouse.move(scrollBox.x + 20, scrollBox.y + 20);
  await page.mouse.down();
  await stageScroll.evaluate((element) => { element.scrollLeft = 80; });
  await page.mouse.move(scrollBox.x + 60, scrollBox.y + 20);
  await page.mouse.up();
  await expect(designer.getByLabel("X")).toHaveValue("108");
  await designer.locator('button[title="撤销"]').click();
  await expect(designer.getByLabel("X")).toHaveValue("48");
  await stageScroll.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });

  await setZoom(designer, 100);
  const handle = title.locator(".prototype-resize-handle");
  const box = await handle.boundingBox();
  if (!box) throw new Error("尺寸手柄没有可用边界");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20);
  await page.mouse.up();
  await expect(designer.getByLabel("W")).toHaveValue("470");
  await expect(designer.getByLabel("H")).toHaveValue("76");
  await designer.locator('button[title="撤销"]').click();
  await expect(designer.getByLabel("W")).toHaveValue("430");
  await expect(designer.getByLabel("H")).toHaveValue("56");

  const cancelBox = await handle.boundingBox();
  if (!cancelBox) throw new Error("尺寸手柄没有可用边界");
  await page.mouse.move(cancelBox.x + 4, cancelBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + 84, cancelBox.y + 44);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(designer.getByLabel("W")).toHaveValue("430");
  await expect(designer.getByLabel("H")).toHaveValue("56");
});

test("numeric fields reject empty commits, preserve the model and still accept zero", async ({ page }) => {
  const designer = await openDesigner(page);
  const canvas = designer.locator(".prototype-canvas");
  await selectLayer(designer, "让交付状态一眼可见");

  const x = designer.getByLabel("X");
  await x.fill("");
  await x.press("Enter");
  await expect(x).toHaveValue("48");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  await expect(designer.getByText("请输入数值")).toBeVisible();
  await expect(canvas.locator(".prototype-component", { hasText: "让交付状态一眼可见" })).toHaveCSS("left", "48px");

  const y = designer.getByLabel("Y");
  await y.fill("");
  await designer.getByRole("button", { name: "放大" }).click();
  await expect(y).toHaveValue("76");
  await expect(y).toHaveAttribute("aria-invalid", "true");

  await selectLayer(designer, "12 个设计节点");
  const card = canvas.locator(".prototype-component", { hasText: "12 个设计节点" });
  const borderWidth = designer.getByLabel("边框宽");
  await borderWidth.fill("0");
  await borderWidth.press("Enter");
  await expect(borderWidth).toHaveValue("0");
  await expect(borderWidth).toHaveAttribute("aria-invalid", "false");
  await expect(card).toHaveCSS("border-left-width", "0px");

  const radius = designer.getByLabel("圆角");
  await radius.fill("");
  await radius.press("Enter");
  await expect(radius).toHaveValue("14");
  await expect(radius).toHaveAttribute("aria-invalid", "true");

  const opacity = designer.getByLabel("透明度");
  await opacity.fill("");
  await opacity.press("Enter");
  await expect(opacity).toHaveValue("1");
  await expect(opacity).toHaveAttribute("aria-invalid", "true");
  await opacity.fill("");
  await opacity.press("Escape");
  await expect(opacity).toHaveValue("1");
  await expect(opacity).toHaveAttribute("aria-invalid", "false");
  await expect(card).toHaveCSS("opacity", "1");
});

test("pending properties commit before gestures and keyboard history continues on the canvas", async ({ page }) => {
  const designer = await openDesigner(page);
  const canvas = designer.locator(".prototype-canvas");
  await designer.locator(".prototype-palette").getByRole("button", { name: "文本" }).click();
  const component = canvas.locator(".prototype-component", { hasText: "页面标题" });
  const x = designer.getByLabel("X");
  await expect(x).toHaveValue("28");

  await x.fill("100");
  await dragBy(page, component, 60, 0);
  await expect(x).toHaveValue("160");
  await expect(component).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(x).toHaveValue("161");
  await designer.locator('button[title="撤销"]').click();
  await expect(x).toHaveValue("160");
  await designer.locator('button[title="撤销"]').click();
  await expect(x).toHaveValue("100");
  await designer.locator('button[title="撤销"]').click();
  await expect(x).toHaveValue("28");

  const content = designer.getByLabel("内容 / 替代文本");
  await content.fill("待提交文本");
  await dragBy(page, component, 10, 0);
  await expect(content).toHaveValue("待提交文本");
  await expect(x).toHaveValue("38");
  await designer.locator('button[title="撤销"]').click();
  await expect(x).toHaveValue("28");
  await expect(content).toHaveValue("待提交文本");
  await designer.locator('button[title="撤销"]').click();
  await expect(content).toHaveValue("页面标题");

  const width = designer.getByLabel("W");
  await width.fill("300");
  const handle = component.locator(".prototype-resize-handle");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("待提交宽度的尺寸手柄没有可用边界");
  await page.mouse.move(handleBox.x + 4, handleBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 24, handleBox.y + 14);
  await page.mouse.up();
  await expect(width).toHaveValue("320");
  await expect(component).toBeFocused();
  await designer.locator('button[title="撤销"]').click();
  await expect(width).toHaveValue("300");
  await designer.locator('button[title="撤销"]').click();
  await expect(width).toHaveValue("260");

  await x.fill("");
  const box = await component.boundingBox();
  if (!box) throw new Error("非法待提交值的组件没有可用边界");
  await page.mouse.move(box.x + 16, box.y + 16);
  await page.mouse.down();
  await expect(x).toHaveValue("28");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  await page.mouse.move(box.x + 36, box.y + 16);
  await page.mouse.up();
  await expect(x).toHaveValue("48");
});

test("non-primary gestures are inert and pending values survive target and blank selection", async ({ page }) => {
  const designer = await openDesigner(page);
  const canvas = designer.locator(".prototype-canvas");
  await selectLayer(designer, "让交付状态一眼可见");
  const title = canvas.locator(".prototype-component", { hasText: "让交付状态一眼可见" });
  const x = designer.getByLabel("X");
  await x.focus();
  const box = await title.boundingBox();
  if (!box) throw new Error("非主指针组件没有可用边界");

  for (const button of ["right", "middle"] as const) {
    await page.mouse.move(box.x + 18, box.y + 18);
    await page.mouse.down({ button });
    await page.mouse.move(box.x + 58, box.y + 18);
    await page.mouse.up({ button });
    await expect(x).toBeFocused();
    await expect(x).toHaveValue("48");
    await expect(designer.locator('button[title="撤销"]')).toContainText("0");
  }

  await title.dispatchEvent("pointerdown", { pointerId: 7, pointerType: "touch", isPrimary: false, button: 0, clientX: box.x + 18, clientY: box.y + 18 });
  await title.dispatchEvent("pointermove", { pointerId: 7, pointerType: "touch", isPrimary: false, button: 0, clientX: box.x + 58, clientY: box.y + 18 });
  await title.dispatchEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: false, button: 0, clientX: box.x + 58, clientY: box.y + 18 });
  await expect(x).toBeFocused();
  await expect(x).toHaveValue("48");

  await page.mouse.move(box.x + 18, box.y + 18);
  await page.mouse.down();
  await title.dispatchEvent("pointerup", { pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, clientX: box.x + 18, clientY: box.y + 18 });
  await title.dispatchEvent("pointercancel", { pointerId: 8, pointerType: "touch", isPrimary: false, button: 0, clientX: box.x + 18, clientY: box.y + 18 });
  await page.mouse.move(box.x + 58, box.y + 18);
  await page.mouse.up();
  await expect(x).toHaveValue("88");
  await expect(designer.locator('button[title="撤销"]')).toContainText("1");
  await designer.locator('button[title="撤销"]').click();
  await expect(x).toHaveValue("48");

  const content = designer.getByLabel("内容 / 替代文本");
  await content.fill("旧标题已提交");
  await canvas.locator(".prototype-component", { hasText: "3 个实现任务" }).click();
  await expect(canvas.getByText("旧标题已提交", { exact: true })).toBeVisible();
  await expect(designer.getByLabel("内容 / 替代文本")).toHaveValue("3 个实现任务全部按计划推进");

  await designer.getByLabel("内容 / 替代文本").fill("卡片待提交");
  await canvas.click({ position: { x: 780, y: 580 } });
  await expect(canvas.getByText("卡片待提交", { exact: true })).toBeVisible();
  await expect(designer.getByLabel("页面名称")).toHaveValue("运营总览");

  await designer.getByTitle("新增页面").click();
  await expect(canvas.getByText("从左侧点击添加组件，再拖动调整位置", { exact: true })).toBeVisible();
  await expect(designer.getByText("点击添加组件，再拖动调整位置", { exact: true })).toBeVisible();
});

test("layers, locks, hidden state, multiselect, alignment, delete and undo stay coherent", async ({ page }) => {
  const designer = await openDesigner(page);
  const canvas = designer.locator(".prototype-canvas");
  const firstCard = canvas.locator(".prototype-component", { hasText: "12 个设计节点" });
  const secondCard = canvas.locator(".prototype-component", { hasText: "3 个实现任务" });
  await firstCard.click();
  await secondCard.click({ modifiers: ["Shift"] });
  await expect(designer.getByText("已选择 2 个可编辑组件")).toBeVisible();
  await dragBy(page, firstCard, 30, 10);
  await expect(firstCard).toHaveCSS("left", "78px");
  await expect(secondCard).toHaveCSS("left", "312px");
  await designer.getByRole("button", { name: "左对齐" }).click();
  await expect(firstCard).toHaveCSS("left", "78px");
  await expect(secondCard).toHaveCSS("left", "78px");

  const heroLayer = designer.locator(".prototype-layer", { hasText: "项目进度视觉摘要" });
  await heroLayer.getByRole("button", { name: "锁定图层" }).click();
  await expect(heroLayer).toHaveClass(/is-locked/);
  await heroLayer.getByRole("button", { name: "隐藏图层" }).click();
  await expect(canvas.locator(".prototype-component-image")).toHaveCount(0);
  await heroLayer.getByRole("button", { name: "显示图层" }).click();
  await expect(canvas.locator(".prototype-component-image")).toHaveCount(1);
  await heroLayer.getByRole("button", { name: "解锁图层" }).click();

  await selectLayer(designer, "12 个设计节点");
  const secondCardLayer = designer.locator(".prototype-layer", { hasText: "3 个实现任务" });
  await secondCardLayer.locator(".prototype-layer-name").click({ modifiers: ["Shift"] });
  await secondCardLayer.locator(".prototype-layer-name").focus();
  await page.keyboard.press("Delete");
  await expect(firstCard).toHaveCount(0);
  await expect(secondCard).toHaveCount(0);
  await expect(canvas.getByText("让交付状态一眼可见", { exact: true })).toBeVisible();
  await designer.locator('button[title="撤销"]').click();
  await expect(canvas.locator(".prototype-component", { hasText: "12 个设计节点" })).toBeVisible();
  await expect(canvas.locator(".prototype-component", { hasText: "3 个实现任务" })).toBeVisible();
  await designer.locator('button[title="重做"]').click();
  await expect(canvas.locator(".prototype-component", { hasText: "12 个设计节点" })).toHaveCount(0);
});

test("history is capped at 50 and restoring a version is local, undoable and PATCH-free", async ({ page }) => {
  const designer = await openDesigner(page);
  await selectLayer(designer, "让交付状态一眼可见");
  for (let index = 0; index < 51; index += 1) await page.keyboard.press("ArrowRight");
  await expect(designer.locator('button[title="撤销"]')).toContainText("50");
  await expect(designer.getByLabel("X")).toHaveValue("99");

  const versionSelect = designer.locator(".prototype-version-select");
  await versionSelect.selectOption({ index: 1 });
  let patchCount = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith("/prototype")) patchCount += 1; });
  page.once("dialog", (dialog) => dialog.accept());
  await designer.getByRole("button", { name: "恢复此版本到草稿" }).click();
  await selectLayer(designer, "让交付状态一眼可见");
  await expect(designer.getByLabel("X")).toHaveValue("48");
  expect(patchCount).toBe(0);
  await designer.locator('button[title="撤销"]').click();
  await expect(designer.getByLabel("X")).toHaveValue("99");
  expect(patchCount).toBe(0);
});

test("slow save preserves newer edits and a 409 keeps the local draft exportable", async ({ page }) => {
  const designer = await openDesigner(page);
  await selectLayer(designer, "让交付状态一眼可见");
  await designer.getByLabel("X").fill("64");
  await designer.getByLabel("X").press("Enter");

  let releaseSave!: () => void;
  let signalStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
  const slowPatch = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    signalStarted();
    await saveGate;
    return route.continue();
  };
  await page.route("**/api/diagrams/**/prototype", slowPatch);
  await designer.getByRole("button", { name: "保存草稿" }).click();
  await saveStarted;
  await expect(designer.locator(".prototype-save-state")).toHaveText("保存中");
  await designer.getByLabel("文字颜色").fill("#ffdd88");
  await designer.getByLabel("文字颜色").press("Enter");
  releaseSave();
  await expect(designer.locator(".prototype-save-state")).toHaveText("有未保存修改");
  await expect(designer.getByLabel("文字颜色")).toHaveValue("#ffdd88");
  await page.unroute("**/api/diagrams/**/prototype", slowPatch);
  await designer.getByRole("button", { name: "保存草稿" }).click();
  await expect(designer.locator(".prototype-save-state")).toHaveText("已保存");

  const before = await app.inject({ method: "GET", url: "/api/diagrams/" + diagramId + "/prototype" });
  const remote = before.json();
  const external = await app.inject({
    method: "PATCH",
    url: "/api/diagrams/" + diagramId + "/prototype",
    payload: {
      expectedUpdatedAt: remote.updatedAt,
      current: { ...remote.current, screens: [{ ...remote.current.screens[0], name: "服务器版本" }, ...remote.current.screens.slice(1)] },
      versions: remote.versions,
    },
  });
  expect(external.statusCode, external.body).toBe(200);

  await designer.getByLabel("X").fill("150");
  await designer.getByLabel("X").press("Enter");
  await designer.getByRole("button", { name: "保存草稿" }).click();
  await expect(designer.locator(".prototype-save-state")).toHaveText("保存冲突");
  await expect(designer.getByLabel("X")).toHaveValue("150");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    designer.getByRole("button", { name: /导出本地 JSON/ }).click(),
  ]);
  expect(download.suggestedFilename()).toContain("prototype-");
  page.once("dialog", (dialog) => dialog.accept());
  await designer.getByRole("button", { name: "重新加载服务器" }).click();
  await expect(designer.locator(".prototype-save-state")).toHaveText("已保存");
  await expect(designer.locator(".prototype-screens button.active")).toContainText("服务器版本");
});

test("preview and form editing stay isolated while dirty and saving close guards hold", async ({ page }) => {
  const designer = await openDesigner(page);
  const canvas = designer.locator(".prototype-canvas");
  await selectLayer(designer, "让交付状态一眼可见");
  const content = designer.getByLabel("内容 / 替代文本");
  await content.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await expect(content).toHaveValue("");
  await expect(canvas.locator(".prototype-component")).toHaveCount(7);
  await page.keyboard.press("Control+Z");
  await expect(content).toHaveValue("让交付状态一眼可见");

  let patchCount = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url().endsWith("/prototype")) patchCount += 1; });
  await designer.getByRole("button", { name: "只读预览" }).click();
  await expect(designer.locator(".prototype-canvas")).toHaveCSS("background-image", "none");
  await page.keyboard.press("Control+S");
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+Z");
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "切换项目" })).toHaveCount(0);
  await designer.locator(".prototype-component-button", { hasText: "打开项目工作台" }).click();
  await expect(designer.locator(".prototype-canvas").getByText("项目详情", { exact: true })).toBeVisible();
  await designer.getByRole("button", { name: "退出预览" }).click();
  expect(patchCount).toBe(0);

  await selectLayer(designer, "让交付状态一眼可见");
  await designer.getByLabel("X").fill("88");
  await designer.getByLabel("X").press("Enter");
  page.once("dialog", (dialog) => dialog.dismiss());
  await designer.getByRole("button", { name: "关闭原型设计器" }).click();
  await expect(designer).toBeVisible();
  await expect(designer.getByLabel("X")).toHaveValue("88");

  let releaseSave!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const slowPatch = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    signalStarted();
    await gate;
    return route.continue();
  };
  await page.route("**/api/diagrams/**/prototype", slowPatch);
  await designer.getByRole("button", { name: "保存草稿" }).click();
  await started;
  await designer.getByRole("button", { name: "关闭原型设计器" }).click();
  await expect(designer).toBeVisible();
  await expect(designer.getByText("保存进行中，请等待请求结束")).toBeVisible();
  releaseSave();
  await expect(designer.locator(".prototype-save-state")).toHaveText("已保存");
  await page.unroute("**/api/diagrams/**/prototype", slowPatch);
  await designer.getByRole("button", { name: "关闭原型设计器" }).click();
  await expect(designer).toHaveCount(0);
});
