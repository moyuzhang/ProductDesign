import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

const createdProfileIds = new Set<string>();
const createdProjectIds = new Set<string>();
const createdSessionIds = new Set<string>();
const upstreamPaths: string[] = [];
const upstreamBodies: Record<string, unknown>[] = [];
let mutationTarget: { diagramId: string; nodeId: string; expectedUpdatedAt: string } | null = null;
let upstream: Server;
let upstreamBaseUrl = "";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1100 } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamPaths.push(request.url ?? "");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      upstreamBodies.push(body);
      const isAgentTurn = Array.isArray(body.tools);
      const messages = Array.isArray(body.messages) ? body.messages as Array<{ role?: string }> : [];
      const hasToolResult = messages.some((message) => message.role === "tool");
      const toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [{
        id: "call-browser-design-doc",
        type: "function",
        function: {
          name: "create_design_doc",
          arguments: JSON.stringify({
            title: "Chrome Agent 设计分析",
            category: "需求文档",
            summary: "通过 openai-chat 工具循环创建",
            status: "草拟",
            version: "v0.1",
            content: "# Chrome Agent 设计分析\n\n工具调用已生效。",
          }),
        },
      }];
      if (mutationTarget) toolCalls.push({
        id: "call-browser-update-selected-node",
        type: "function",
        function: {
          name: "mutate_diagram",
          arguments: JSON.stringify({
            diagramId: mutationTarget.diagramId,
            expectedUpdatedAt: mutationTarget.expectedUpdatedAt,
            operations: [{
              op: "update_node",
              nodeId: mutationTarget.nodeId,
              patch: { label: "Agent 已更新选中节点" },
            }],
          }),
        },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(isAgentTurn && !hasToolResult ? {
        id: "chatcmpl-browser-tool",
        choices: [{ message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
        } }],
      } : {
        id: "chatcmpl-browser-test",
        choices: [{ message: { role: "assistant", content: "Chrome 中的兼容对话已完成" } }],
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("浏览器测试网关监听失败");
  upstreamBaseUrl = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});

test.afterEach(async ({ request }) => {
  for (const id of createdSessionIds) await request.delete(`/api/agent-sessions/${id}`).catch(() => undefined);
  for (const id of createdProjectIds) await request.delete(`/api/projects/${id}`).catch(() => undefined);
  for (const id of createdProfileIds) await request.delete(`/api/llm-profiles/${id}`).catch(() => undefined);
  createdSessionIds.clear();
  createdProjectIds.clear();
  createdProfileIds.clear();
  upstreamPaths.length = 0;
  upstreamBodies.length = 0;
  mutationTarget = null;
});

test("DSH-style API key flow reaches openai-chat and the Agent workbench", async ({ page, request }) => {
  const profileName = `E2E Compatible Chat ${Date.now()}`;
  await page.goto("/#/llm");

  await expect(page.getByRole("heading", { name: "模型" })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加配置" })).toBeVisible();
  await page.getByRole("button", { name: "添加自定义提供方" }).click();

  const modal = page.locator(".modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".llm-provider-deck button")).toHaveCount(7);
  await expect(modal.locator(".llm-provider-deck button", { hasText: "自建网关" })).toHaveAttribute("aria-checked", "true");
  await modal.getByLabel("配置名称").fill(profileName);
  await modal.getByLabel("API 密钥").fill("sk-e2e-browser-safe");
  await modal.getByLabel("默认模型").fill("browser-chat-model");
  await modal.locator(".llm-advanced-fields > summary").click();
  await modal.getByLabel("Base URL").fill(upstreamBaseUrl);
  await modal.getByLabel("模型列表（每行一个）").fill("browser-chat-model");
  await expect(modal.getByLabel("模型协议")).toHaveValue("openai-chat");
  await page.screenshot({ path: "artifacts/regression/llm-dsh-flow-modal.png", fullPage: true });

  const createResponse = page.waitForResponse((response) => response.url().endsWith("/api/llm-profiles") && response.request().method() === "POST");
  await modal.getByRole("button", { name: "保存配置" }).click();
  const savedResponse = await createResponse;
  expect(savedResponse.ok()).toBeTruthy();
  const saved = await savedResponse.json() as { id: string; credentialMasked: string; credentialSource: string };
  createdProfileIds.add(saved.id);
  expect(saved.credentialMasked).toBe("••••safe");
  expect(saved.credentialSource).toBe("stored");

  const profileRow = page.locator(".llm-card", { hasText: profileName });
  await expect(profileRow).toHaveCount(1);
  await expect(profileRow).toContainText("密钥已配置");
  await profileRow.getByRole("button", { name: "测试" }).click();
  await expect(profileRow.locator(".llm-card-check.ok")).toBeVisible();
  await expect.poll(() => upstreamPaths.filter((path) => path === "/v1/chat/completions").length).toBeGreaterThanOrEqual(1);

  const projectResponse = await request.post("/api/projects", {
    data: { code: `E2E${Date.now().toString().slice(-6)}`, name: "E2E Agent 兼容协议" },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json() as { id: string };
  createdProjectIds.add(project.id);

  const diagramsResponse = await request.get(`/api/diagrams?projectId=${project.id}`);
  expect(diagramsResponse.ok()).toBeTruthy();
  const diagrams = await diagramsResponse.json() as Array<{
    id: string;
    type: string;
    nodes: Array<Record<string, unknown>>;
  }>;
  const mainDiagram = diagrams.find((diagram) => diagram.type === "main");
  if (!mainDiagram) throw new Error("测试项目未自动创建系统主画布");
  const selectedNode = {
    id: "e2e-agent-selected-node",
    kind: "feature",
    label: "待 Agent 修改的节点",
    x: 680,
    y: 340,
    shape: "rounded",
  };
  const seededResponse = await request.patch(`/api/diagrams/${mainDiagram.id}`, {
    data: { nodes: [...mainDiagram.nodes, selectedNode] },
  });
  expect(seededResponse.ok()).toBeTruthy();
  const seeded = await seededResponse.json() as { updatedAt: string };
  mutationTarget = { diagramId: mainDiagram.id, nodeId: selectedNode.id, expectedUpdatedAt: seeded.updatedAt };

  await page.goto(`/#/canvas/${mainDiagram.id}`);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "回车保存，Esc 取消" })).toHaveValue("系统主画布");
  const selectedNodeButton = page.getByRole("button", { name: /待 Agent 修改的节点/ });
  await expect(selectedNodeButton).toBeVisible();
  await selectedNodeButton.focus();
  await page.getByRole("button", { name: "打开项目 Agent 工作台" }).click();
  const dock = page.getByRole("region", { name: "项目 Agent 工作台" });
  await expect(dock).toBeVisible();
  await dock.getByLabel("项目工作台").selectOption(project.id);
  await dock.locator(".agent-runtime-selects select").first().selectOption(saved.id);
  await dock.getByTitle("新建会话").click();
  const narrowedProfile = await request.patch(`/api/llm-profiles/${saved.id}`, {
    data: { models: ["replacement-model"], defaultModel: "replacement-model" },
  });
  expect(narrowedProfile.ok()).toBeTruthy();
  const controlMode = dock.getByLabel("Agent 控制模式");
  await expect(controlMode).toHaveValue("restricted");
  await controlMode.selectOption("project-autonomous");
  await expect(controlMode).toHaveValue("project-autonomous");
  await expect(dock.locator(".agent-control-note")).toContainText("受管项目目录");
  await expect(dock.locator(".agent-composer-tools button")).toContainText("已关联当前页 · 1 项选中");
  const composer = dock.getByPlaceholder("向项目 Agent 说明目标，Enter 发送，Shift+Enter 换行");
  await expect(composer).toBeEnabled();
  await composer.fill("请修改我在画布中选中的节点");
  await dock.getByRole("button", { name: "发送" }).click();
  await expect(dock.locator(".agent-message.assistant.completed")).toContainText("Chrome 中的兼容对话已完成", { timeout: 10_000 });
  await expect.poll(() => upstreamPaths.filter((path) => path === "/v1/chat/completions").length).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: /Agent 已更新选中节点/ })).toBeVisible({ timeout: 10_000 });
  const agentRequest = upstreamBodies.find((body) => Array.isArray(body.tools));
  const agentMessages = agentRequest?.messages as Array<{ role?: string; content?: string }> | undefined;
  const agentUserPrompt = agentMessages?.find((message) => message.role === "user")?.content ?? "";
  expect(agentUserPrompt).toContain(selectedNode.id);
  expect(agentUserPrompt).toContain('"pageType": "canvas"');

  const docs = await request.get(`/api/design-docs?projectId=${project.id}`);
  expect(await docs.json()).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "Chrome Agent 设计分析", projectId: project.id }),
  ]));

  const workspace = await request.get(`/api/projects/${project.id}/agent-workspace`);
  const snapshot = await workspace.json() as { sessions: Array<{ id: string; controlMode: string }> };
  expect(snapshot.sessions.some((item) => item.controlMode === "project-autonomous")).toBe(true);
  for (const session of snapshot.sessions) createdSessionIds.add(session.id);
  await page.screenshot({ path: "artifacts/regression/agent-context-sync.png", fullPage: true });
});

test("DSH-style configuration modal remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/llm");
  await page.getByRole("button", { name: "添加配置" }).click();

  const modal = page.locator(".modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".llm-provider-deck button")).toHaveCount(7);
  await expect(modal.getByLabel("API 密钥")).toBeVisible();
  await expect(modal.getByRole("button", { name: "保存配置" })).toBeVisible();
  await page.screenshot({ path: "artifacts/regression/llm-dsh-flow-mobile.png", fullPage: true });
});
