import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";
import { Store } from "./db.js";
import type { DiagramTemplateContent } from "../shared/types.js";

// 模板服务契约（设计第 6.4 节 / 第 12 节 TMP-11..22）。
const dataDir = mkdtempSync(join(tmpdir(), "pcs-templates-api-"));
const dbPath = join(dataDir, "templates-api.db");
const app = buildApp({ dbPath, dataDir });

const SCHEMA_V1 = "whiteboard.template/1.0";

let projectA = "";
let projectB = "";
let mainA = "";
let targetA = "";
let deliveryA = "";
let templateId = "";

const templateContent = () => ({
  schemaVersion: SCHEMA_V1,
  diagram: {
    nodes: [
      { id: "tpl-1", kind: "feature" as const, label: "模板节点", x: 0, y: 0, linkDiagramIds: ["child-of-template"] },
      { id: "tpl-2", kind: "feature" as const, label: "模板节点二", x: 240, y: 0 },
    ],
    edges: [{ id: "tpl-edge-1", from: "tpl-1", to: "tpl-2" }],
    groups: [{ id: "tpl-group-1", name: "模板组", nodeIds: ["tpl-1", "tpl-2"] }],
  },
});

const noneThumbnail = () => ({ kind: "none" as const, width: 0, height: 0, viewBox: "0 0 0 0", generatedAt: "2026-09-20T00:00:00.000Z", source: "auto" as const });

async function getDiagram(id: string) {
  const response = await app.inject({ method: "GET", url: `/api/diagrams/${id}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

const createTemplate = (payload: unknown) =>
  app.inject({ method: "POST", url: `/api/projects/${projectA}/diagram-templates`, payload });

const applyTemplate = (diagramId: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/diagrams/${diagramId}/template-applications`, payload });

async function createProject(code: string, name: string) {
  const created = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { code, name, summary: "", stage: "开发", health: "正常" },
  });
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json().id as string;
  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${id}` });
  const main = (diagrams.json() as Array<{ id: string; type: string }>).find((item) => item.type === "main")!.id;
  return { projectId: id, mainId: main };
}

beforeAll(async () => {
  const a = await createProject("TPL_A", "模板项目 A");
  const b = await createProject("TPL_B", "模板项目 B");
  projectA = a.projectId;
  mainA = a.mainId;
  projectB = b.projectId;

  // 目标画布：既有节点 + 既有组合区域（append 目标 / replace 合法目标）。
  const target = await app.inject({
    method: "POST", url: "/api/diagrams",
    payload: {
      projectId: projectA, title: "模板目标画布", type: "free",
      nodes: [{ id: "target-1", kind: "feature", label: "既有节点", x: 0, y: 0 }],
      groups: [{ id: "g-target", name: "既有组", nodeIds: ["target-1"] }],
    },
  });
  expect(target.statusCode, target.body).toBe(200);
  targetA = target.json().id;

  // 含交付状态字段的画布：replace 必须被拒绝。
  const delivery = await app.inject({
    method: "POST", url: "/api/diagrams",
    payload: {
      projectId: projectA, title: "交付画布", type: "free",
      nodes: [{ id: "delivery-1", kind: "feature", label: "交付节点", x: 0, y: 0, requirementStatus: "已批准" }],
    },
  });
  expect(delivery.statusCode, delivery.body).toBe(200);
  deliveryA = delivery.json().id;

  // 系统内置模板（project_id IS NULL）只能由平台通道写入：直接落库模拟部署初始化数据。
  const seed = new Store(dbPath, dataDir);
  seed.insertDiagramTemplate({
    projectId: null, scope: "system", name: "系统内置模板", schemaVersion: SCHEMA_V1,
    content: templateContent() as unknown as DiagramTemplateContent, thumbnailMeta: noneThumbnail(), createdBy: "system",
  });
  seed.db.close();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("模板 CRUD（TMP-11 / TMP-12）", () => {
  it("创建项目级模板：自动生成缩略图、scope=project、列表不回传 content", async () => {
    const created = await createTemplate({ name: "流程图模板", schemaVersion: SCHEMA_V1, content: templateContent(), actor: "builder" });
    expect(created.statusCode, created.body).toBe(201);
    const template = created.json();
    templateId = template.id;
    expect(template.scope).toBe("project");
    expect(template.projectId).toBe(projectA);
    expect(template.createdBy).toBe("builder");
    expect(template.thumbnailMeta.kind).toBe("svg");
    expect(template.content.diagram.nodes).toHaveLength(2);

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates` });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json() as Array<Record<string, unknown>>;
    expect(items.map((item) => item.scope)).toEqual(["system", "project"]);
    expect(items.every((item) => item.content === undefined)).toBe(true);
    expect((items.find((item) => item.id === templateId)!.thumbnailMeta as Record<string, unknown>).content).toBeUndefined();

    const single = await app.inject({ method: "GET", url: `/api/diagram-templates/${templateId}?include=thumbnail,content` });
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json().content.diagram.nodes).toHaveLength(2);
    expect(String(single.json().thumbnailMeta.content)).toContain("<svg");

    const badScope = await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates?scope=global` });
    expect(badScope.statusCode).toBe(400);
    expect(badScope.json().code).toBe("TEMPLATE_SCOPE_INVALID");

    const filtered = await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates?scope=project` });
    expect((filtered.json() as unknown[]).length).toBe(1);
  });

  it("跨项目读取 404（不泄露存在性）；系统模板对项目用户只读 403", async () => {
    const cross = await app.inject({ method: "GET", url: `/api/diagram-templates/${templateId}?projectId=${projectB}` });
    expect(cross.statusCode).toBe(404);
    const crossList = await app.inject({ method: "GET", url: `/api/projects/${projectB}/diagram-templates?scope=project` });
    expect(crossList.json()).toEqual([]);

    const systemId = ((await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates?scope=system` })).json() as Array<{ id: string }>)[0].id;
    const patch = await app.inject({ method: "PATCH", url: `/api/diagram-templates/${systemId}`, payload: { name: "改名", expectedUpdatedAt: null } });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().code).toBe("TEMPLATE_SYSTEM_READONLY");
    const revoke = await app.inject({ method: "POST", url: `/api/diagram-templates/${systemId}/revoke`, payload: {} });
    expect(revoke.statusCode).toBe(403);
    const remove = await app.inject({ method: "DELETE", url: `/api/diagram-templates/${systemId}` });
    expect(remove.statusCode).toBe(403);
  });

  it("契约拒绝路径：重名 409、交付字段 400、不安全缩略图 400、高主版本 409、未知字段 400", async () => {
    const conflict = await createTemplate({ name: "流程图模板", schemaVersion: SCHEMA_V1, content: templateContent() });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("TEMPLATE_NAME_CONFLICT");

    const leak = templateContent();
    (leak.diagram.nodes[0] as Record<string, unknown>).requirementStatus = "已批准";
    const leakResponse = await createTemplate({ name: "泄露模板", schemaVersion: SCHEMA_V1, content: leak });
    expect(leakResponse.statusCode).toBe(400);
    expect(leakResponse.json().code).toBe("TEMPLATE_DELIVERY_FIELD_FORBIDDEN");

    const unsafe = await createTemplate({
      name: "不安全缩略图", schemaVersion: SCHEMA_V1, content: templateContent(),
      thumbnailMeta: { kind: "svg", width: 160, height: 120, viewBox: "0 0 160 120", content: "<svg><script>alert(1)</script></svg>", generatedAt: "T0", source: "custom" },
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().code).toBe("TEMPLATE_THUMBNAIL_UNSAFE");

    const unsupported = await createTemplate({ name: "未来模板", schemaVersion: "whiteboard.template/2.0", content: templateContent() });
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().code).toBe("TEMPLATE_SCHEMA_UNSUPPORTED");
    expect(unsupported.json().supportedSchemaVersions).toEqual([SCHEMA_V1]);

    const unknownField = await createTemplate({ name: "未知字段", schemaVersion: SCHEMA_V1, content: templateContent(), zIndex: 1 });
    expect(unknownField.statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates?scope=project` });
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it("模板 CAS：过期 expectedUpdatedAt 409 TEMPLATE_REVISION_CONFLICT 且零写入；正确版本更新成功（TMP-19）", async () => {
    const current = (await app.inject({ method: "GET", url: `/api/diagram-templates/${templateId}?include=content` })).json();
    const stale = await app.inject({
      method: "PATCH", url: `/api/diagram-templates/${templateId}`,
      payload: { name: "不该生效", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("TEMPLATE_REVISION_CONFLICT");
    expect(stale.json().serverUpdatedAt).toBe(current.updatedAt);

    const updated = await app.inject({
      method: "PATCH", url: `/api/diagram-templates/${templateId}`,
      payload: { name: "流程图模板 v2", expectedUpdatedAt: current.updatedAt, actor: "builder" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().name).toBe("流程图模板 v2");
    expect(updated.json().updatedAt).not.toBe(current.updatedAt);
    expect(updated.json().content.diagram.nodes).toHaveLength(2);
  });
});

describe("模板应用（TMP-15 / TMP-16 / TMP-22）", () => {
  it("append 语义：id 重生成、确定性偏移不重叠、不还原跨画布关联", async () => {
    const before = await getDiagram(targetA);
    const applied = await applyTemplate(targetA, { templateId, mode: "append", expectedUpdatedAt: before.updatedAt, actor: "builder" });
    expect(applied.statusCode, applied.body).toBe(200);
    const result = applied.json();
    expect(result.createdNodeIds).toHaveLength(2);
    expect(result.createdEdgeIds).toHaveLength(1);
    expect(result.migrated).toBe(false);
    expect(result.thumbnailApplied).toBe(true);
    expect(result.diagram.nodes).toHaveLength(3);
    expect(result.diagram.groups).toHaveLength(2);

    const created = (result.diagram.nodes as Array<Record<string, unknown>>).filter((node) => result.createdNodeIds.includes(node.id));
    expect(created.every((node) => Number(node.x) >= 100)).toBe(true);
    expect(result.droppedLinkDiagramIds).toHaveLength(1);
    const linked = created.find((node) => node.label === "模板节点")!;
    expect(linked.linkDiagramIds).toEqual([]);
    expect(result.droppedLinkDiagramIds).toContain(linked.id);
  });

  it("replace 对主画布与含交付数据画布一律 409 TEMPLATE_REPLACE_FORBIDDEN（TMP-17）", async () => {
    const main = await getDiagram(mainA);
    const onMain = await applyTemplate(mainA, { templateId, mode: "replace", expectedUpdatedAt: main.updatedAt });
    expect(onMain.statusCode).toBe(409);
    expect(onMain.json().code).toBe("TEMPLATE_REPLACE_FORBIDDEN");

    const delivery = await getDiagram(deliveryA);
    const onDelivery = await applyTemplate(deliveryA, { templateId, mode: "replace", expectedUpdatedAt: delivery.updatedAt });
    expect(onDelivery.statusCode).toBe(409);
    expect(onDelivery.json().code).toBe("TEMPLATE_REPLACE_FORBIDDEN");
    expect(onDelivery.json().details.nodeIds).toEqual(["delivery-1"]);

    const untouched = await getDiagram(deliveryA);
    expect(untouched.nodes).toEqual(delivery.nodes);
    expect(untouched.updatedAt).toBe(delivery.updatedAt);
  });

  it("replace 清空目标画布旧内容（TMP-16）", async () => {
    const before = await getDiagram(targetA);
    const applied = await applyTemplate(targetA, { templateId, mode: "replace", expectedUpdatedAt: before.updatedAt });
    expect(applied.statusCode, applied.body).toBe(200);
    const result = applied.json();
    expect(result.diagram.nodes.map((node: { id: string }) => node.id)).not.toContain("target-1");
    expect(result.diagram.nodes).toHaveLength(2);
    expect(result.diagram.groups.map((group: { id: string }) => group.id)).not.toContain("g-target");
  });

  it("画布 CAS 失败返回 409 TEMPLATE_APPLY_CONFLICT + serverUpdatedAt 且零写入", async () => {
    const before = await getDiagram(targetA);
    const conflict = await applyTemplate(targetA, { templateId, mode: "append", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("TEMPLATE_APPLY_CONFLICT");
    expect(conflict.json().serverUpdatedAt).toBe(before.updatedAt);

    const after = await getDiagram(targetA);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.nodes).toEqual(before.nodes);
  });

  it("高主版本模板应用 409 TEMPLATE_SCHEMA_UNSUPPORTED 且画布零变化（TMP-18）", async () => {
    const seed = new Store(dbPath, dataDir);
    const future = seed.insertDiagramTemplate({
      projectId: projectA, scope: "project", name: "未来主版本模板", schemaVersion: "whiteboard.template/9.0",
      content: templateContent() as unknown as DiagramTemplateContent, thumbnailMeta: noneThumbnail(), createdBy: "platform",
    });
    seed.db.close();

    const before = await getDiagram(targetA);
    const response = await applyTemplate(targetA, { templateId: future.id, mode: "append", expectedUpdatedAt: before.updatedAt });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("TEMPLATE_SCHEMA_UNSUPPORTED");

    const after = await getDiagram(targetA);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.groups).toEqual(before.groups);
  });
});

describe("撤销语义（TMP-12 / TMP-13）", () => {
  it("撤销幂等、撤销后不可读/不可用/不可更新，DELETE 等价软撤销", async () => {
    const revoked = await app.inject({ method: "POST", url: `/api/diagram-templates/${templateId}/revoke`, payload: { actor: "builder" } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().revokedAt).toBeTruthy();

    const again = await app.inject({ method: "POST", url: `/api/diagram-templates/${templateId}/revoke`, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json().revokedAt).toBe(revoked.json().revokedAt);

    const deleted = await app.inject({ method: "DELETE", url: `/api/diagram-templates/${templateId}` });
    expect(deleted.statusCode).toBe(200);

    const single = await app.inject({ method: "GET", url: `/api/diagram-templates/${templateId}` });
    expect(single.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectA}/diagram-templates?scope=project` });
    expect((list.json() as Array<{ id: string }>).some((item) => item.id === templateId)).toBe(false);

    const patch = await app.inject({
      method: "PATCH", url: `/api/diagram-templates/${templateId}`,
      payload: { name: "复活", expectedUpdatedAt: null },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("TEMPLATE_REVOKED");

    const before = await getDiagram(targetA);
    const apply = await applyTemplate(targetA, { templateId, mode: "append", expectedUpdatedAt: before.updatedAt });
    expect(apply.statusCode).toBe(404);

    // 撤销不影响已应用到画布的内容（快照语义）：已生成的节点仍在。
    const after = await getDiagram(targetA);
    expect(after.nodes).toHaveLength(before.nodes.length);
  });
});