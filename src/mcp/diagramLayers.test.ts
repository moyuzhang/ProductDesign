import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/index.js";
import { Store } from "../server/db.js";
import { LocalMcpClient, type AgentMcpResult } from "../server/localMcpClient.js";
import { classifyMcpTool } from "../server/controlledWriteRegistry.js";
import { createMcpServer } from "./index.js";

// MCP 契约（设计第 7 节 + 第 12 节 MCP-LAY-01..03 / MCP-TMP-01..04 / MCP-REG-01）：
// MCP 工具与等价 REST 端点必须逐字段一致——它们共用 src/server/whiteboard.ts 的同一服务层函数。
const dataDir = mkdtempSync(join(tmpdir(), "pcs-whiteboard-mcp-"));
const dbPath = join(dataDir, "whiteboard-mcp.db");
const app = buildApp({ dbPath, dataDir });
const store = new Store(dbPath, dataDir);
let client: LocalMcpClient;
let projectId = "";
let diagramId = "";
const NODE_ID = "mcp-layer-node-1";
const FREEFORM_ID = "fr_mcp_1";
const SCHEMA_V1 = "whiteboard.template/1.0";

const mcpText = (result: AgentMcpResult) => (result.content ?? []).map((part) => part.text ?? "").join("");
const mcpBody = (result: AgentMcpResult) => {
  const text = mcpText(result);
  // 成功结果是纯 JSON（对象或数组）；错误结果首行是 "CODE: message"。
  const start = text.search(/[{[]/);
  return JSON.parse(start >= 0 ? text.slice(start) : text) as Record<string, any>;
};
const mcpCode = (result: AgentMcpResult) => /^([A-Z][A-Z0-9_]+):/.exec(mcpText(result))?.[1] ?? "";

const rest = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool(name, args);
  expect(result.isError, mcpText(result)).not.toBe(true);
  return mcpBody(result);
};

const customLayer = (id: string, name: string) => ({
  id, name, kind: "custom" as const, memberKind: "mixed" as const, locked: false, hidden: false,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
});

const templateContent = () => ({
  schemaVersion: SCHEMA_V1,
  diagram: { nodes: [{ id: "tpl_node_a", kind: "feature", label: "模板节点A", x: 0, y: 0 }], edges: [], groups: [] },
});

const layerSavedAt = async () => mcpBody(await client.callTool("get_diagram_layers", { diagramId })).diagramUpdatedAt as string;

beforeAll(async () => {
  client = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir, trustedInternal: true }));

  const project = await rest("POST", "/api/projects", { code: "MCP_WB", name: "MCP 白板", summary: "", stage: "开发", health: "正常" });
  expect(project.statusCode, project.body).toBe(200);
  projectId = project.json().id;

  const diagrams = await rest("GET", `/api/diagrams?projectId=${projectId}`);
  diagramId = (diagrams.json() as Array<{ id: string; type: string }>).find((item) => item.type === "main")!.id;

  const patched = await rest("PATCH", `/api/diagrams/${diagramId}`, {
    nodes: [{ id: NODE_ID, kind: "feature", label: "MCP 交付节点", x: 0, y: 0 }],
  });
  expect(patched.statusCode, patched.body).toBe(200);

  const freeform = await rest("PATCH", `/api/diagrams/${diagramId}/freeform`, {
    schemaVersion: 1,
    elements: [{
      id: FREEFORM_ID, kind: "rect", x: 0, y: 0, w: 100, h: 80, rotation: 0, groupId: null, style: {},
      locked: false, hidden: false, cornerStyle: "rounded",
      createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
    }],
    expectedUpdatedAt: null,
  });
  expect(freeform.statusCode, freeform.body).toBe(200);
});

afterAll(async () => {
  await client?.close();
  store.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("MCP 图层契约（MCP-LAY-01..03）", () => {
  it("get_diagram_layers 与 REST GET /layers 逐字段一致（MCP-LAY-01）", async () => {
    const restBody = (await rest("GET", `/api/diagrams/${diagramId}/layers`)).json();
    expect(await call("get_diagram_layers", { diagramId })).toEqual(restBody);
  });

  it("update_diagram_layers 与 REST PATCH /layers 同源：出参形状、双向可见、冲突码一致（MCP-LAY-02）", async () => {
    const before = await call("get_diagram_layers", { diagramId });
    const layers = [...before.layers, customLayer("ly_mcp", "MCP 层")];

    const saved = await call("update_diagram_layers", {
      diagramId, layers, itemOverrides: { [`freeform:${FREEFORM_ID}`]: { layerId: "ly_mcp" } },
      expectedUpdatedAt: before.diagramUpdatedAt, actor: "mcp-test",
    });
    expect(Object.keys(saved).sort()).toEqual(["diagramUpdatedAt", "layerState"]);
    expect(saved.layerState.layers.map((layer: { id: string }) => layer.id)).toContain("ly_mcp");

    // 方向一：MCP 写入 → REST 读取可见同一状态。
    const restAfter = (await rest("GET", `/api/diagrams/${diagramId}/layers`)).json();
    expect(saved.layerState).toEqual({ schemaVersion: restAfter.schemaVersion, layers: restAfter.layers, itemOverrides: restAfter.itemOverrides });
    expect(saved.diagramUpdatedAt).toBe(restAfter.diagramUpdatedAt);

    // 方向二：REST 写入 → MCP 读取可见同一状态（改名回到既有值）。
    const renamed = layers.map((layer: Record<string, unknown>) => layer.id === "ly_mcp" ? { ...layer, name: "REST 改名的层" } : layer);
    const restSaved = await rest("PATCH", `/api/diagrams/${diagramId}/layers`, {
      schemaVersion: 1, layers: renamed, itemOverrides: restAfter.itemOverrides, expectedUpdatedAt: restAfter.diagramUpdatedAt,
    });
    expect(restSaved.statusCode, restSaved.body).toBe(200);
    const mcpAfter = await call("get_diagram_layers", { diagramId });
    expect(mcpAfter).toEqual(restSaved.json());

    // 冲突路径：同一陈旧 expectedUpdatedAt，两端错误码一致且零写入。
    const revision = mcpAfter.diagramUpdatedAt as string;
    const conflictLayers = renamed.map((layer: Record<string, unknown>) => layer.id === "ly_mcp" ? { ...layer, hidden: true } : layer);
    const conflictMcp = await client.callTool("update_diagram_layers", {
      diagramId, layers: conflictLayers, itemOverrides: mcpAfter.itemOverrides, expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    const conflictRest = await rest("PATCH", `/api/diagrams/${diagramId}/layers`, {
      schemaVersion: 1, layers: conflictLayers, itemOverrides: mcpAfter.itemOverrides, expectedUpdatedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(conflictRest.statusCode).toBe(409);
    expect(mcpCode(conflictMcp)).toBe(conflictRest.json().code);
    expect(mcpCode(conflictMcp)).toBe("LAYER_STATE_CONFLICT");
    expect(await layerSavedAt()).toBe(revision);
  });

  it("组件工具与 REST 一致：列表同源、创建同源、名称冲突同码（MCP-LAY-03）", async () => {
    expect(await call("list_diagram_components", { diagramId }))
      .toEqual((await rest("GET", `/api/diagrams/${diagramId}/components`)).json());

    const created = await call("create_diagram_component", {
      diagramId, name: "MCP 组件", selection: { nodeIds: [NODE_ID] },
      expectedUpdatedAt: await layerSavedAt(), actor: "mcp-test",
    });
    expect(created.component.name).toBe("MCP 组件");
    expect(await call("list_diagram_components", { diagramId }))
      .toEqual((await rest("GET", `/api/diagrams/${diagramId}/components`)).json());

    const revision = await layerSavedAt();
    const duplicateMcp = await client.callTool("create_diagram_component", {
      diagramId, name: "MCP 组件", selection: { nodeIds: [NODE_ID] }, expectedUpdatedAt: revision,
    });
    const duplicateRest = await rest("POST", `/api/diagrams/${diagramId}/components`, {
      name: "MCP 组件", selection: { nodeIds: [NODE_ID] }, expectedUpdatedAt: revision,
    });
    expect(duplicateRest.statusCode).toBe(409);
    expect(mcpCode(duplicateMcp)).toBe(duplicateRest.json().code);
    expect(mcpCode(duplicateMcp)).toBe("COMPONENT_NAME_CONFLICT");
  });
});

describe("MCP 模板契约（MCP-TMP-01..04）", () => {
  let templateId = "";

  it("list_diagram_templates 与 REST 列表逐字段一致（含分页）（MCP-TMP-01）", async () => {
    expect(await call("list_diagram_templates", { projectId }))
      .toEqual((await rest("GET", `/api/projects/${projectId}/diagram-templates`)).json());
    expect(await call("list_diagram_templates", { projectId, offset: 0, limit: 1 }))
      .toEqual((await rest("GET", `/api/projects/${projectId}/diagram-templates?offset=0&limit=1`)).json());
  });

  it("create/get_diagram_template 与 REST 逐字段一致（含交付字段 400 同码）（MCP-TMP-02）", async () => {
    const created = await call("create_diagram_template", {
      projectId, name: "MCP 模板", schemaVersion: SCHEMA_V1, content: templateContent(), actor: "mcp-test",
    });
    templateId = created.id as string;
    expect(created.scope).toBe("project");
    expect(created.schemaVersion).toBe(SCHEMA_V1);

    expect(await call("get_diagram_template", { templateId, include: "thumbnail,content" }))
      .toEqual((await rest("GET", `/api/diagram-templates/${templateId}?include=thumbnail,content`)).json());

    const leak = templateContent();
    (leak.diagram.nodes[0] as Record<string, unknown>).requirementStatus = "已批准";
    const leakMcp = await client.callTool("create_diagram_template", { projectId, name: "MCP 泄露", schemaVersion: SCHEMA_V1, content: leak });
    const leakRest = await rest("POST", `/api/projects/${projectId}/diagram-templates`, { name: "MCP 泄露", schemaVersion: SCHEMA_V1, content: leak });
    expect(leakRest.statusCode).toBe(400);
    expect(mcpCode(leakMcp)).toBe(leakRest.json().code);
    expect(mcpCode(leakMcp)).toBe("TEMPLATE_DELIVERY_FIELD_FORBIDDEN");
  });

  it("apply_diagram_template 与 REST 一致：追加语义与画布落位同源（MCP-TMP-03）", async () => {
    const target = (await rest("POST", "/api/diagrams", { projectId, title: "MCP 目标画布", type: "free" })).json();
    const applied = await call("apply_diagram_template", {
      diagramId: target.id, templateId, mode: "append", expectedUpdatedAt: target.updatedAt, actor: "mcp-test",
    });
    expect(applied.migrated).toBe(false);
    expect(applied.thumbnailApplied).toBe(true);
    expect(applied.createdNodeIds.length).toBeGreaterThan(0);
    expect(applied.diagram.nodes.every((node: { linkDiagramIds?: string[] }) => (node.linkDiagramIds ?? []).length === 0)).toBe(true);

    const restDiagram = (await rest("GET", `/api/diagrams/${target.id}`)).json();
    expect(applied.diagram.nodes).toEqual(restDiagram.nodes);
    expect(applied.diagram.updatedAt).toBe(restDiagram.updatedAt);
  });

  it("update/revoke_diagram_template 与 REST 一致：字段集相同、CAS 冲突同码、撤销幂等（MCP-TMP-04）", async () => {
    const current = await call("get_diagram_template", { templateId });
    const updatedMcp = await call("update_diagram_template", {
      templateId, patch: { name: "MCP 模板改" }, expectedUpdatedAt: current.updatedAt, actor: "mcp-test",
    });
    const updatedRest = (await rest("PATCH", `/api/diagram-templates/${templateId}`, {
      name: "REST 模板改", expectedUpdatedAt: updatedMcp.updatedAt,
    })).json();
    expect(Object.keys(updatedMcp).sort()).toEqual(Object.keys(updatedRest).sort());
    expect(updatedMcp.id).toBe(updatedRest.id);
    expect(updatedMcp.schemaVersion).toBe(updatedRest.schemaVersion);

    const stale = "1999-01-01T00:00:00.000Z";
    const conflictMcp = await client.callTool("update_diagram_template", { templateId, patch: { name: "x" }, expectedUpdatedAt: stale });
    const conflictRest = await rest("PATCH", `/api/diagram-templates/${templateId}`, { name: "x", expectedUpdatedAt: stale });
    expect(conflictRest.statusCode).toBe(409);
    expect(mcpCode(conflictMcp)).toBe(conflictRest.json().code);
    expect(mcpCode(conflictMcp)).toBe("TEMPLATE_REVISION_CONFLICT");

    const revokedMcp = await call("revoke_diagram_template", { templateId });
    const revokedRest = (await rest("POST", `/api/diagram-templates/${templateId}/revoke`, {})).json();
    expect(revokedMcp.revokedAt).toBe(revokedRest.revokedAt);
    expect(revokedMcp.id).toBe(templateId);
  });
});

describe("MCP 受控写登记（MCP-REG-01）", () => {
  it("读工具登记只读集合、写工具登记受控写集合并注入租约上下文", async () => {
    for (const name of ["get_diagram_layers", "list_diagram_components", "list_diagram_templates", "get_diagram_template"]) {
      expect(classifyMcpTool(name)).toBe("read");
    }
    const writeTools = [
      "update_diagram_layers", "create_diagram_component", "instantiate_diagram_component", "delete_diagram_component",
      "create_diagram_template", "update_diagram_template", "revoke_diagram_template", "apply_diagram_template",
    ];
    for (const name of writeTools) expect(classifyMcpTool(name)).toBe("controlled");

    // 外部 Agent 视角（未声明 trustedInternal）：受控写必须携带租约上下文。
    const external = await LocalMcpClient.connect(() => createMcpServer({ store, dbPath, dataDir }));
    const tools = await external.listAgentTools();
    for (const name of writeTools) {
      const tool = tools.find((item) => item.name === name);
      expect(tool, name).toBeTruthy();
      expect((tool!.inputSchema.required ?? []) as string[], name).toEqual(expect.arrayContaining(["workOrderId", "leaseToken", "taskKey", "taskRevision", "workerId", "agentId", "role", "idempotencyKey"]));
    }
    const readTool = tools.find((item) => item.name === "get_diagram_layers")!;
    expect((readTool.inputSchema.required ?? []) as string[]).not.toContain("leaseToken");
    await external.close();
  });
});