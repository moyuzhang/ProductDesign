import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

const dataDir = mkdtempSync(join(tmpdir(), "pcs-freeform-api-"));
const app = buildApp({ dbPath: join(dataDir, "freeform-api.db"), dataDir });

let projectId = "";
let diagramId = "";
let documentId = "";
const deliveryNodeId = "freeform-delivery-node";

// 最小可解码 1x1 PNG（真实 PNG 文件头，可被 sharp 解析）。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG_BYTES = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>", "utf8");

const rect = (id: string, x = 0, y = 0) => ({
  id, kind: "rect" as const, x, y, w: 100, h: 80, rotation: 0, groupId: null, style: {}, locked: false, hidden: false,
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", cornerStyle: "rounded" as const,
});

const saveFreeform = (payload: unknown) => app.inject({ method: "PATCH", url: `/api/diagrams/${diagramId}/freeform`, payload });

/** 只抽取与交付门禁相关的数值，用于断言自由层写入前后零变化（R4 / FT-10）。 */
async function deliveryGateSnapshot() {
  const response = await app.inject({ method: "GET", url: `/api/projects/${projectId}/workflow` });
  expect(response.statusCode, response.body).toBe(200);
  const workflow = response.json();
  return {
    topMissing: workflow.missing,
    layerGate: workflow.layerGate,
    nodes: (workflow.nodes as Array<Record<string, unknown>>).map((node) => ({
      nodeId: node.nodeId,
      missing: node.missing,
      approvedDocumentCount: node.approvedDocumentCount,
      planCount: node.planCount,
      completedPlanCount: node.completedPlanCount,
      evidenceCount: node.evidenceCount,
      requirementStatus: node.requirementStatus,
      designStatus: node.designStatus,
      developmentStatus: node.developmentStatus,
      acceptanceStatus: node.acceptanceStatus,
    })),
  };
}

beforeAll(async () => {
  const project = await app.inject({
    method: "POST", url: "/api/projects",
    payload: { code: "FREEFORM_API", name: "自由层 API", summary: "", stage: "开发", health: "正常" },
  });
  expect(project.statusCode, project.body).toBe(200);
  projectId = project.json().id;

  const diagrams = await app.inject({ method: "GET", url: `/api/diagrams?projectId=${projectId}` });
  diagramId = (diagrams.json() as Array<{ id: string; type: string }>).find((diagram) => diagram.type === "main")!.id;

  // 主画布挂一个交付节点，确保 workflow 的节点统计真实参与快照对比。
  const patched = await app.inject({
    method: "PATCH", url: `/api/diagrams/${diagramId}`,
    payload: { nodes: [{ id: deliveryNodeId, kind: "feature", label: "自由层交付节点", x: 0, y: 0 }] },
  });
  expect(patched.statusCode, patched.body).toBe(200);

  const doc = await app.inject({
    method: "POST", url: "/api/design-docs",
    payload: { projectId, title: "自由层引用基线", content: "# 基线" },
  });
  expect(doc.statusCode, doc.body).toBe(200);
  documentId = doc.json().id;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("自由层读写契约（FT-43 / FT-45 / FT-46）", () => {
  it("首次读取返回 null，未知画布返回 404", async () => {
    const empty = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toBeNull();
    const missing = await app.inject({ method: "GET", url: "/api/diagrams/not-a-diagram/freeform" });
    expect(missing.statusCode).toBe(404);
  });

  it("首次保存必须显式 expectedUpdatedAt=null，并发只有一个成功", async () => {
    const missingField = await saveFreeform({ schemaVersion: 1, elements: [rect("fr_a")] });
    expect(missingField.statusCode).toBe(400);

    const stringOnMissing = await saveFreeform({ schemaVersion: 1, elements: [rect("fr_a")], expectedUpdatedAt: "not-created" });
    expect(stringOnMissing.statusCode).toBe(409);
    expect(stringOnMissing.json().code).toBe("FREEFORM_DRAFT_CONFLICT");

    const responses = await Promise.all([
      saveFreeform({ schemaVersion: 1, elements: [rect("fr_a")], expectedUpdatedAt: null }),
      saveFreeform({ schemaVersion: 1, elements: [rect("fr_b", 40, 40)], expectedUpdatedAt: null }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });

  it("携带过期的 expectedUpdatedAt 时返回 409 且服务端不写库（FT-43）", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    const stored = before.json();
    const stale = structuredClone(stored.elements);
    stale.push(rect("fr_stale", 500, 500));
    const conflict = await saveFreeform({ schemaVersion: 1, elements: stale, expectedUpdatedAt: "1999-01-01T00:00:00.000Z" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("FREEFORM_DRAFT_CONFLICT");
    expect(conflict.json().serverUpdatedAt).toBe(stored.updatedAt);

    const after = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    expect(after.json().updatedAt).toBe(stored.updatedAt);
    expect(after.json().elements.map((element: { id: string }) => element.id)).toEqual(stored.elements.map((element: { id: string }) => element.id));
  });

  it("自由元素携带交付字段或未知字段一律 400，且不改变已存修订（FT-11 / C3）", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    const stored = before.json();

    const leak = await saveFreeform({
      schemaVersion: 1, expectedUpdatedAt: stored.updatedAt,
      elements: [{ ...rect("fr_leak"), requirementStatus: "待整理" }],
    });
    expect(leak.statusCode).toBe(400);
    expect(leak.json().message).toContain("requirementStatus");

    for (const field of ["designStatus", "developmentStatus", "acceptanceStatus", "owner", "acceptanceCriteria", "requiresDatabase", "blockedReason"]) {
      const response = await saveFreeform({ schemaVersion: 1, expectedUpdatedAt: stored.updatedAt, elements: [{ ...rect("fr_leak2"), [field]: "x" }] });
      expect(response.statusCode, field).toBe(400);
    }

    const unknown = await saveFreeform({ schemaVersion: 1, expectedUpdatedAt: stored.updatedAt, elements: [{ ...rect("fr_x"), glow: "high" }] });
    expect(unknown.statusCode).toBe(400);

    const duplicated = await saveFreeform({ schemaVersion: 1, expectedUpdatedAt: stored.updatedAt, elements: [rect("fr_dup"), rect("fr_dup", 10, 10)] });
    expect(duplicated.statusCode).toBe(400);

    const after = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    expect(after.json().updatedAt).toBe(stored.updatedAt);
  });

  it("unknown 容器原样往返，二次保存幂等（FT-45 / FT-46）", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    const stored = before.json();
    const unsupported = [{ id: "fr_unknown_1", raw: { id: "fr_unknown_1", kind: "sparkle", glow: "high" } }];

    const saved = await saveFreeform({ schemaVersion: 1, elements: stored.elements, unsupported, expectedUpdatedAt: stored.updatedAt });
    expect(saved.statusCode, saved.body).toBe(200);

    const read = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` });
    const document = read.json();
    expect(document.unsupported).toEqual(unsupported);

    const again = await saveFreeform({ schemaVersion: 1, elements: document.elements, unsupported: document.unsupported, expectedUpdatedAt: document.updatedAt });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().elements).toEqual(document.elements);
    expect(again.json().unsupported).toEqual(unsupported);
  });

  it("R1 自由层写入不触碰 diagram.nodes", async () => {
    const before = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}` });
    const beforeNodes = before.json().nodes;
    const stored = (await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` })).json();
    const saved = await saveFreeform({
      schemaVersion: 1, expectedUpdatedAt: stored.updatedAt,
      elements: [...stored.elements, rect("fr_nodes_probe", 640, 480)],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}` });
    expect(after.json().nodes).toEqual(beforeNodes);
    expect(after.json().nodes).toHaveLength(1);
  });
});

describe("受控图片资源（FT-30..FT-33）", () => {
  it("合法 PNG 入库返回指纹与尺寸，重复上传按 sha256 去重（FT-30）", async () => {
    const first = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: PNG_1X1, headers: { "content-type": "image/png" },
    });
    expect(first.statusCode, first.body).toBe(200);
    const asset = first.json();
    expect(asset.id.startsWith("fa_")).toBe(true);
    expect(asset.mime).toBe("image/png");
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);

    const second = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: PNG_1X1, headers: { "content-type": "image/png" },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().id).toBe(asset.id);

    const download = await app.inject({ method: "GET", url: `/api/freeform-assets/${asset.id}` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("image/png");
    expect(String(download.headers["content-security-policy"])).toContain("script-src 'none'");
    expect(String(download.headers["content-security-policy"])).toContain("object-src 'none'");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(download.rawPayload, PNG_1X1)).toBe(0);
  });

  it("拒绝 SVG / HTML / 脚本类型与伪装 MIME（FT-31 / FT-32）", async () => {
    const svg = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: SVG_BYTES, headers: { "content-type": "image/svg+xml" },
    });
    expect(svg.statusCode).toBe(400);

    const html = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: Buffer.from("<html><script>alert(1)</script></html>", "utf8"), headers: { "content-type": "text/html" },
    });
    expect(html.statusCode).toBe(400);

    const script = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: Buffer.from("alert(1)", "utf8"), headers: { "content-type": "application/javascript" },
    });
    expect(script.statusCode).toBe(400);

    // 声明为 PNG 但真实文件头是 SVG：必须因 magic number 不一致被拒绝。
    const disguised = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: SVG_BYTES, headers: { "content-type": "image/png" },
    });
    expect(disguised.statusCode).toBe(400);
    expect(disguised.json().message).toContain("文件头");

    const empty = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/freeform-assets`,
      payload: Buffer.alloc(0), headers: { "content-type": "image/png" },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("资源必须归属当前项目，未知项目与未知资源分别 404", async () => {
    const unknownProject = await app.inject({
      method: "POST", url: "/api/projects/not-a-project/freeform-assets",
      payload: PNG_1X1, headers: { "content-type": "image/png" },
    });
    expect(unknownProject.statusCode).toBe(404);

    const unknownAsset = await app.inject({ method: "GET", url: "/api/freeform-assets/fa_missing" });
    expect(unknownAsset.statusCode).toBe(404);
  });

  it("图片元素只接受已入库的受控引用，越权引用被 400 拒绝", async () => {
    const stored = (await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` })).json();
    const image = {
      id: "fr_image_1", kind: "image" as const, x: 10, y: 10, w: 60, h: 60, rotation: 0, groupId: null, style: {},
      locked: false, hidden: false, createdAt: "", updatedAt: "",
      assetRef: "fa_authorized", imageFit: "contain" as const, alt: "受控图片", sourceWidth: 1, sourceHeight: 1,
    };
    const ok = await saveFreeform({ schemaVersion: 1, expectedUpdatedAt: stored.updatedAt, elements: [...stored.elements, image] });
    expect(ok.statusCode, ok.body).toBe(200);

    for (const bad of ["https://evil.example/x.png", "data:image/png;base64,AAAA", "blob:http://localhost/x", "javascript:alert(1)"]) {
      const rejected = await saveFreeform({
        schemaVersion: 1, expectedUpdatedAt: ok.json().updatedAt,
        elements: [...stored.elements, { ...image, id: "fr_image_bad", assetRef: bad }],
      });
      expect(rejected.statusCode, bad).toBe(400);
    }
  });
});

describe("交付门禁与引用隔离（FT-10 / FT-12 / FT-42）", () => {
  it("自由层增删改前后，节点 missing / 计划数 / 证据数 / layerGate 零变化", async () => {
    const before = await deliveryGateSnapshot();
    expect(before.nodes).toHaveLength(1);
    expect(before.nodes[0].nodeId).toBe(deliveryNodeId);

    let stored = (await app.inject({ method: "GET", url: `/api/diagrams/${diagramId}/freeform` })).json();
    const created = await saveFreeform({
      schemaVersion: 1, expectedUpdatedAt: stored.updatedAt,
      elements: [...stored.elements, rect("fr_gate_1", 10, 10), rect("fr_gate_2", 200, 10)],
    });
    expect(created.statusCode, created.body).toBe(200);

    stored = created.json();
    const moved = await saveFreeform({
      schemaVersion: 1, expectedUpdatedAt: stored.updatedAt,
      elements: stored.elements.map((element: { id: string }) => element.id === "fr_gate_1" ? { ...element, x: 900, y: 900 } : element),
    });
    expect(moved.statusCode, moved.body).toBe(200);

    stored = moved.json();
    const deleted = await saveFreeform({
      schemaVersion: 1, expectedUpdatedAt: stored.updatedAt,
      elements: stored.elements.filter((element: { id: string }) => element.id !== "fr_gate_1"),
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    expect(deleted.json().elements.map((element: { id: string }) => element.id)).not.toContain("fr_gate_1");
    expect(await deliveryGateSnapshot()).toEqual(before);
  });

  it("自由元素 id 不能成为文档引用目标或计划绑定目标（FT-12 / C2 / C4）", async () => {
    const reference = await app.inject({
      method: "POST", url: "/api/document-references",
      payload: { projectId, documentId, targetType: "diagramNode", targetId: "fr_gate_2" },
    });
    expect(reference.statusCode).toBe(400);
    expect(reference.json().message).toContain("不存在");

    const plan = await app.inject({
      method: "POST", url: "/api/plans",
      payload: { projectId, diagramId, diagramNodeId: "fr_gate_2", kind: "task", title: "非法绑定自由元素" },
    });
    expect(plan.statusCode).toBe(400);
    expect(plan.json().message).toContain("绑定的画布节点不存在");

    // 反向确认：真实交付节点 id 可以被绑定，说明拒绝原因确实是 id 空间而不是别的约束。
    const legitimate = await app.inject({
      method: "POST", url: "/api/document-references",
      payload: { projectId, documentId, targetType: "diagramNode", targetId: deliveryNodeId },
    });
    expect(legitimate.statusCode, legitimate.body).toBe(200);
  });

  it("自由层写入与导出不产生证据，也不产生 node / plan 交付事件（R5 / R6 / FT-42）", async () => {
    const evidence = await app.inject({ method: "GET", url: `/api/projects/${projectId}/evidence` });
    expect(evidence.json()).toEqual([]);

    const events = await app.inject({ method: "GET", url: `/api/audit?projectId=${projectId}` });
    expect(events.statusCode, events.body).toBe(200);
    const auditEvents = events.json() as Array<{ entityType: string }>;
    expect(auditEvents.filter((event) => event.entityType === "freeformDocument").length).toBeGreaterThan(0);
    // R5：自由层写入只产生 freeform 域事件，绝不产生 node / plan / evidence 交付事件。
    expect(auditEvents.filter((event) => ["node", "plan", "evidence"].includes(event.entityType))).toEqual([]);
  });
});