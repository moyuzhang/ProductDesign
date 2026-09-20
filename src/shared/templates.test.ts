import { describe, expect, it } from "vitest";
import type { DiagramEdge, DiagramNode, DiagramTemplateContent } from "./types.js";
import {
  SUPPORTED_TEMPLATE_SCHEMA_VERSION,
  TEMPLATE_THUMBNAIL_MAX_BYTES,
  applyTemplateToDiagram,
  assertSafeThumbnailSvg,
  assertTemplateCompatible,
  assertTemplateContentNoDeliveryLeak,
  assertTemplateContentNoExternalUrl,
  assertTemplateReplaceAllowed,
  assertTemplateScopeInvariant,
  buildTemplateThumbnail,
  normalizeTemplateContent,
  parseTemplateSchemaVersion,
  resolveTemplateCompatibility,
  templateContentBytes,
  templateContentSchema,
  templateCreateSchema,
  toTemplateSummary,
} from "./templates.js";

function node(id: string, x = 0, y = 0, extra: Partial<DiagramNode> = {}): DiagramNode {
  return { id, kind: "feature", label: id, x, y, ...extra };
}

function edge(id: string, from: string, to: string): DiagramEdge {
  return { id, from, to };
}

function content(overrides: Partial<DiagramTemplateContent> = {}): DiagramTemplateContent {
  return {
    schemaVersion: SUPPORTED_TEMPLATE_SCHEMA_VERSION,
    diagram: { nodes: [node("n1", 10, 20)], edges: [], groups: [] },
    ...overrides,
  };
}

describe("模板：schema_version 兼容矩阵", () => {
  it("解析合法版本，拒绝非法形态", () => {
    expect(parseTemplateSchemaVersion("whiteboard.template/1.0")).toEqual({ raw: "whiteboard.template/1.0", major: 1, minor: 0 });
    expect(parseTemplateSchemaVersion("whiteboard.template/2.7")).toEqual({ raw: "whiteboard.template/2.7", major: 2, minor: 7 });
    expect(parseTemplateSchemaVersion("whiteboard.template/1")).toBeNull();
    expect(parseTemplateSchemaVersion("other/1.0")).toBeNull();
    expect(parseTemplateSchemaVersion("whiteboard.template/x.y")).toBeNull();
    expect(parseTemplateSchemaVersion(1)).toBeNull();
  });

  it("逐格判定：exact / downgrade / unsupported / invalid", () => {
    expect(resolveTemplateCompatibility("whiteboard.template/1.0").status).toBe("exact");
    expect(resolveTemplateCompatibility("whiteboard.template/1.0").migrated).toBe(false);
    expect(resolveTemplateCompatibility("whiteboard.template/0.9").status).toBe("downgrade");
    expect(resolveTemplateCompatibility("whiteboard.template/0.9").migrated).toBe(true);
    expect(resolveTemplateCompatibility("whiteboard.template/2.0").status).toBe("unsupported");
    // 设计 5.4 未单列「主版本相等且次版本更高」；按禁止新→旧原则判 unsupported
    expect(resolveTemplateCompatibility("whiteboard.template/1.1").status).toBe("unsupported");
    expect(resolveTemplateCompatibility("bad").status).toBe("invalid");
  });

  it("不兼容一律 409 且响应体带支持版本，服务端不写数据", () => {
    expect(() => assertTemplateCompatible("whiteboard.template/2.0")).toThrowError(/主版本/);
    try {
      assertTemplateCompatible("whiteboard.template/2.0");
    } catch (error) {
      const shape = error as { statusCode: number; code: string; details?: { supportedSchemaVersions?: string[]; templateSchemaVersion?: string } };
      expect(shape.statusCode).toBe(409);
      expect(shape.code).toBe("TEMPLATE_SCHEMA_UNSUPPORTED");
      expect(shape.details?.templateSchemaVersion).toBe("whiteboard.template/2.0");
      expect(shape.details?.supportedSchemaVersions).toEqual([SUPPORTED_TEMPLATE_SCHEMA_VERSION]);
    }
    expect(() => assertTemplateCompatible("nope")).toThrowError(/无法解析/);
    expect(assertTemplateCompatible("whiteboard.template/1.0").status).toBe("exact");
  });
});

describe("模板：content 脱敏", () => {
  it("命中交付字段即 TEMPLATE_DELIVERY_FIELD_FORBIDDEN", () => {
    const leaked = content({ diagram: { nodes: [node("n1", 0, 0, { requirementStatus: "已批准" })], edges: [], groups: [] } });
    expect(() => assertTemplateContentNoDeliveryLeak(leaked)).toThrowError(/交付状态字段/);
    try { assertTemplateContentNoDeliveryLeak(leaked); } catch (error) { expect((error as { code: string }).code).toBe("TEMPLATE_DELIVERY_FIELD_FORBIDDEN"); }
    expect(() => assertTemplateContentNoDeliveryLeak(content())).not.toThrow();
  });

  it("拒绝外部/内联资源引用", () => {
    const external = content({ diagram: { nodes: [node("n1", 0, 0, { description: "data:image/png;base64,AAA" })], edges: [], groups: [] } });
    expect(() => assertTemplateContentNoExternalUrl(external)).toThrowError(/外部\/内联资源引用/);
    expect(() => assertTemplateContentNoExternalUrl(content())).not.toThrow();
  });

  it("strict schema 拒绝交付字段与未知字段", () => {
    expect(templateContentSchema.safeParse(content()).success).toBe(true);
    expect(templateContentSchema.safeParse({ ...content(), extra: 1 }).success).toBe(false);
    expect(templateContentSchema.safeParse({ schemaVersion: SUPPORTED_TEMPLATE_SCHEMA_VERSION, diagram: { nodes: [{ id: "n1", kind: "feature", label: "", x: 0, y: 0, owner: "x" }], edges: [], groups: [] } }).success).toBe(false);
  });
});

describe("模板：缩略图", () => {
  it("确定性生成：同输入同输出，且通过安全校验", () => {
    const a = buildTemplateThumbnail(content(), { now: "T0" });
    const b = buildTemplateThumbnail(content(), { now: "T0" });
    expect(a.meta).toEqual(b.meta);
    expect(a.meta.kind).toBe("svg");
    expect(a.meta.source).toBe("auto");
    expect(a.meta.viewBox).toBe("0 0 160 120");
    expect(a.meta.content).toContain("<svg");
    expect(assertSafeThumbnailSvg(a.meta.content)).toBe(a.meta.content);
  });

  it("空内容降级为 none 并给出 warning，不阻塞", () => {
    const empty = content({ diagram: { nodes: [], edges: [], groups: [] } });
    const result = buildTemplateThumbnail(empty, { now: "T0" });
    expect(result.meta.kind).toBe("none");
    expect(result.warning).toMatch(/降级为 none/);
  });

  it("安全校验白名单：拒绝脚本/事件/外部引用/未允许标签/超限", () => {
    expect(() => assertSafeThumbnailSvg('<svg><script>alert(1)</script></svg>')).toThrowError(/被禁止的标签/);
    expect(() => assertSafeThumbnailSvg('<svg><rect onload="x"/></svg>')).toThrowError(/事件属性/);
    expect(() => assertSafeThumbnailSvg('<svg><image href="https://x/y.png"/></svg>')).toThrowError(/被禁止的标签/);
    expect(() => assertSafeThumbnailSvg('<svg><rect/></svg><unknown href="//evil"/>')).toThrowError(/未允许标签|被禁止的标签|外部引用/);
    expect(() => assertSafeThumbnailSvg('<svg><foreignObject/></svg>')).toThrowError(/被禁止的标签/);
    const oversized = `<svg>${"x".repeat(TEMPLATE_THUMBNAIL_MAX_BYTES)}</svg>`;
    expect(() => assertSafeThumbnailSvg(oversized)).toThrowError(/字节上限/);
    expect(() => assertSafeThumbnailSvg("")).toThrowError(/不能为空/);
  });
});

describe("模板：降级归一化", () => {
  const legacy = {
    schemaVersion: "whiteboard.template/0.9",
    diagram: {
      nodes: [
        { id: "n1", kind: "feature", label: "旧节点", x: 0, y: 0, requirementStatus: "已批准" },
        { id: "n2", kind: "feature", label: "保留", x: 200, y: 0 },
      ],
      edges: [edge("e1", "n1", "n2"), edge("e_dangling", "n1", "gone")],
      groups: [],
      zIndex: 3,
    },
  };

  it("剥离交付字段、丢弃悬空连线、标记 migrated，且迁移幂等", () => {
    const first = normalizeTemplateContent(legacy, { now: "T0" });
    expect(first.migrated).toBe(true);
    expect(first.droppedDeliveryFields).toContain("requirementStatus");
    expect(first.content.diagram.edges.map((item) => item.id)).toEqual(["e1"]);
    expect(first.warnings.join("|")).toMatch(/悬空连线/);
    expect(() => assertTemplateContentNoDeliveryLeak(first.content)).not.toThrow();

    const second = normalizeTemplateContent(first.content, { now: "T0" });
    expect(second.content).toEqual(first.content);
    expect(second.droppedDeliveryFields).toEqual([]);
  });
});

describe("模板：应用（append / replace）", () => {
  const template = content({
    diagram: {
      nodes: [node("n1", 10, 20, { linkDiagramIds: ["child-a"] }), node("n2", 210, 20)],
      edges: [edge("e1", "n1", "n2")],
      groups: [{ id: "g1", name: "组", nodeIds: ["n1", "n2"] }],
    },
  });

  it("append：不重叠偏移、id 全重生成、linkDiagramIds 不还原", () => {
    const target = { nodes: [node("t1", 0, 0, { w: 100, h: 50 })], edges: [], groups: [] };
    const result = applyTemplateToDiagram({ diagram: target, content: template, mode: "append", now: "T0" });
    expect(result.createdNodeIds).toHaveLength(2);
    expect(result.createdNodeIds).not.toContain("n1");
    // 现有内容右下角(100,50) + 32 → 新内容左上角(132,82)
    expect(result.nodes.find((item) => item.id === result.createdNodeIds[0])?.x).toBe(132);
    expect(result.nodes.find((item) => item.id === result.createdNodeIds[0])?.y).toBe(82);
    expect(result.droppedLinkDiagramIds).toEqual([result.createdNodeIds[0]]);
    expect(result.nodes.find((item) => item.id === result.createdNodeIds[0])).not.toHaveProperty("linkDiagramIds");
    expect(result.edges).toHaveLength(1);
    expect(result.groups).toHaveLength(1);
    expect(result.layers.layers).toHaveLength(3);
  });

  it("replace：清空目标既有内容后写入模板内容", () => {
    const target = { nodes: [node("t1", 0, 0)], edges: [edge("te", "t1", "t1")], groups: [] };
    const result = applyTemplateToDiagram({ diagram: target, content: template, mode: "replace", now: "T0" });
    expect(result.nodes.map((item) => item.id)).not.toContain("t1");
    expect(result.nodes).toHaveLength(2);
    expect(result.droppedLinkDiagramIds).toEqual([]);
  });

  it("replace 前置校验：主画布 / 交付节点 / 计划证据绑定一律 409", () => {
    expect(() => assertTemplateReplaceAllowed({ diagramType: "main", nodes: [] })).toThrowError(/主画布/);
    expect(() => assertTemplateReplaceAllowed({ diagramType: "free", nodes: [node("n1", 0, 0, { acceptanceStatus: "已通过" })] })).toThrowError(/交付状态节点/);
    expect(() => assertTemplateReplaceAllowed({ diagramType: "free", nodes: [], planCount: 1 })).toThrowError(/计划\/证据绑定/);
    expect(() => assertTemplateReplaceAllowed({ diagramType: "free", nodes: [] })).not.toThrow();
  });
});

describe("模板：scope 不变式与列表投影", () => {
  it("scope=system ⇔ project_id IS NULL", () => {
    expect(assertTemplateScopeInvariant("system", null)).toBe("system");
    expect(assertTemplateScopeInvariant("project", "p1")).toBe("project");
    expect(() => assertTemplateScopeInvariant("system", "p1")).toThrowError(/project_id 为空/);
    expect(() => assertTemplateScopeInvariant("project", null)).toThrowError(/project_id 非空/);
    expect(() => assertTemplateScopeInvariant("global", null)).toThrowError(/scope 非法/);
  });

  it("列表投影不回传 content，仅回传字节数", () => {
    const summary = toTemplateSummary({
      id: "t1", projectId: "p1", scope: "project", name: "模板", schemaVersion: SUPPORTED_TEMPLATE_SCHEMA_VERSION,
      thumbnailMeta: { kind: "svg", width: 160, height: 120, viewBox: "0 0 160 120", content: "<svg/>", generatedAt: "T0", source: "auto" },
      createdBy: "builder", createdAt: "T0", updatedAt: "T0", revokedAt: null,
    }, content());
    expect(summary).not.toHaveProperty("content");
    expect(summary.thumbnailMeta).not.toHaveProperty("content");
    expect(summary.contentBytes).toBe(templateContentBytes(content()));
    expect(summary.contentBytes).toBeGreaterThan(0);
  });

  it("创建 schema 默认 scope=project，strict 拒绝未知字段", () => {
    const parsed = templateCreateSchema.parse({ name: "模板", content: {} });
    expect(parsed.scope).toBe("project");
    expect(parsed.schemaVersion).toBe(SUPPORTED_TEMPLATE_SCHEMA_VERSION);
    expect(templateCreateSchema.safeParse({ name: "模板", content: {}, scope: "system" }).success).toBe(false);
    expect(templateCreateSchema.safeParse({ name: "模板", content: {}, owner: "x" }).success).toBe(false);
  });
});