/**
 * 图层、组件与模板的 MCP 工具（设计第 7 节，12 个工具）。
 *
 * 硬契约：MCP 工具与 REST 端点必须是同一服务层函数的两个入口（禁止两套逻辑）。
 * 本文件只做三件事：入参 schema 声明、调用 src/server/whiteboard.ts 的服务函数、把 `{status, body}`
 * 转成 MCP 文本结果。业务判定全部在服务层，因此两端的状态码与错误码逐字段一致。
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LAYER_ITEM_KEY_MAX, LAYER_MAX, LAYER_SCHEMA_VERSION, diagramItemOverrideSchema, diagramLayerSchema } from "../shared/layers.js";
import { TEMPLATE_NAME_MAX, templateThumbnailMetaSchema } from "../shared/templates.js";
import type { Store } from "../server/db.js";
import {
  applyDiagramTemplate,
  createComponentInstances,
  createDiagramComponent,
  createDiagramTemplate,
  listDiagramTemplates,
  readDiagramComponents,
  readDiagramLayers,
  readDiagramTemplate,
  removeDiagramComponent,
  revokeDiagramTemplateRecord,
  saveDiagramLayers,
  updateDiagramTemplateRecord,
  type ServiceResult,
  type WhiteboardAuditContext,
  type WhiteboardServiceContext,
} from "../server/whiteboard.js";

export interface WhiteboardToolOptions {
  store: Store;
  dataDir: string;
}

/** MCP 侧 audit 归属：与 fullTools 的 recordAudit 约定一致（actor 缺省 mcp-client）。 */
function mcpAudit(actor?: string): WhiteboardAuditContext {
  const normalized = actor?.trim() || "mcp-client";
  const sessionId = normalized.startsWith("agent:") ? normalized.slice("agent:".length) : "";
  return {
    actor: normalized,
    source: "mcp",
    sessionId: sessionId || undefined,
    clientId: sessionId ? "productdesign-agent-harness" : "external-mcp",
  };
}

/** 服务结果 → MCP 文本结果；错误体带 code（与 REST 错误码一致，设计第 7 节）。 */
function toolResult(result: ServiceResult) {
  const text = JSON.stringify(result.body ?? null, null, 2);
  if (result.status >= 400) {
    const body = (result.body ?? {}) as { code?: string; message?: string };
    const code = typeof body.code === "string" && body.code ? body.code : `HTTP_${result.status}`;
    return { content: [{ type: "text" as const, text: `${code}: ${body.message ?? ""}\n${text}` }], isError: true };
  }
  return { content: [{ type: "text" as const, text }] };
}

const expectedUpdatedAtSchema = z.string().max(64).optional()
  .describe("目标画布/模板的当前 updatedAt；省略时按 null 提交，服务端会返回 409 + serverUpdatedAt，读取后重试即可");
const actorSchema = z.string().max(120).optional();
const selectionSchema = z.object({
  nodeIds: z.array(z.string().min(1)).max(2000).optional(),
  edgeIds: z.array(z.string().min(1)).max(2000).optional(),
  freeformIds: z.array(z.string().min(1)).max(2000).optional(),
}).strict();
const templatePatchInputSchema = z.object({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX).optional(),
  schemaVersion: z.string().trim().min(1).max(32).optional(),
  content: z.unknown().optional(),
  thumbnailMeta: templateThumbnailMetaSchema.optional(),
}).strict();

export function registerWhiteboardTools(server: McpServer, options: WhiteboardToolOptions): void {
  const context: WhiteboardServiceContext = { store: options.store, dataDir: options.dataDir };

  server.registerTool("get_diagram_layers", {
    title: "查询画布图层",
    description: "返回画布图层状态（系统层 + 自定义层 + 元素级覆盖），与 REST GET /api/diagrams/:id/layers 完全同源；无记录时返回派生默认系统层且不写库。",
    inputSchema: { diagramId: z.string().min(1) },
  }, ({ diagramId }) => toolResult(readDiagramLayers(context, { diagramId })));

  server.registerTool("update_diagram_layers", {
    title: "保存画布图层",
    description: "整份替换画布图层状态（内容指纹相同则不写库）。CAS 失败返回 LAYER_STATE_CONFLICT + serverUpdatedAt；交付节点/连线不可搬运到非系统层。",
    inputSchema: {
      diagramId: z.string().min(1),
      layers: z.array(diagramLayerSchema).max(LAYER_MAX),
      itemOverrides: z.record(z.string().max(LAYER_ITEM_KEY_MAX), diagramItemOverrideSchema),
      expectedUpdatedAt: expectedUpdatedAtSchema,
      actor: actorSchema,
    },
  }, ({ diagramId, layers, itemOverrides, expectedUpdatedAt, actor }) => {
    const result = saveDiagramLayers(context, {
      diagramId,
      payload: { schemaVersion: LAYER_SCHEMA_VERSION, layers, itemOverrides, expectedUpdatedAt: expectedUpdatedAt ?? null, ...(actor ? { actor } : {}) },
      audit: mcpAudit(actor),
    });
    if (result.status >= 400) return toolResult(result);
    const { diagramUpdatedAt, ...layerState } = result.body as Record<string, unknown>;
    return toolResult({ status: 200, body: { layerState, diagramUpdatedAt } });
  });

  server.registerTool("list_diagram_components", {
    title: "列出画布组件",
    description: "列出画布内已保存的组件定义（含来源选区与载荷），与 REST GET /api/diagrams/:id/components 同源。",
    inputSchema: { diagramId: z.string().min(1) },
  }, ({ diagramId }) => toolResult(readDiagramComponents(context, { diagramId })));

  server.registerTool("create_diagram_component", {
    title: "从选区创建组件",
    description: "按当前画布选区快照创建组件定义（交付字段被剥离、悬空连线丢弃并上报）；组件不与既有实例联动。",
    inputSchema: {
      diagramId: z.string().min(1),
      name: z.string().trim().min(1).max(200),
      selection: selectionSchema,
      expectedUpdatedAt: expectedUpdatedAtSchema,
      actor: actorSchema,
    },
  }, ({ diagramId, name, selection, expectedUpdatedAt, actor }) => toolResult(createDiagramComponent(context, {
    diagramId,
    payload: { name, selection, expectedUpdatedAt: expectedUpdatedAt ?? null, ...(actor ? { actor } : {}) },
    audit: mcpAudit(actor),
  })));

  server.registerTool("instantiate_diagram_component", {
    title: "实例化组件",
    description: "在画布中按偏移复制一份组件实例；新 id 全部重生成、连线端点重映射，不产生跨画布隐式联动。",
    inputSchema: {
      diagramId: z.string().min(1),
      componentId: z.string().min(1),
      offsetX: z.number().finite().optional(),
      offsetY: z.number().finite().optional(),
      expectedUpdatedAt: expectedUpdatedAtSchema,
      actor: actorSchema,
    },
  }, ({ diagramId, componentId, offsetX, offsetY, expectedUpdatedAt, actor }) => toolResult(createComponentInstances(context, {
    diagramId,
    componentId,
    payload: {
      ...(offsetX !== undefined ? { offsetX } : {}),
      ...(offsetY !== undefined ? { offsetY } : {}),
      expectedUpdatedAt: expectedUpdatedAt ?? null,
      ...(actor ? { actor } : {}),
    },
    audit: mcpAudit(actor),
  })));

  server.registerTool("delete_diagram_component", {
    title: "删除组件定义",
    description: "删除组件定义（幂等）；既有实例保持独立、不被级联删除。",
    inputSchema: { diagramId: z.string().min(1), componentId: z.string().min(1), actor: actorSchema },
  }, ({ diagramId, componentId, actor }) => toolResult(removeDiagramComponent(context, {
    diagramId, componentId, audit: mcpAudit(actor),
  })));

  server.registerTool("list_diagram_templates", {
    title: "列出白板模板",
    description: "列出项目可见模板摘要（系统内置 + 项目级，默认过滤已撤销模板）；不含 content。",
    inputSchema: {
      projectId: z.string().min(1),
      scope: z.enum(["system", "project"]).optional(),
      schemaVersion: z.string().max(32).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, ({ projectId, scope, schemaVersion, offset, limit }) => toolResult(listDiagramTemplates(context, {
    projectId, scope, schemaVersion, offset, limit,
  })));

  server.registerTool("get_diagram_template", {
    title: "查询白板模板",
    description: "返回模板摘要；include=\"thumbnail,content\" 时附带缩略图与内容载荷（系统模板按只读矩阵放行）。",
    inputSchema: { templateId: z.string().min(1), include: z.string().max(64).optional() },
  }, ({ templateId, include }) => toolResult(readDiagramTemplate(context, { templateId, include })));

  server.registerTool("create_diagram_template", {
    title: "创建项目级模板",
    description: "从内容载荷创建项目级模板（交付字段/外链一律拒绝，缩略图缺省自动生成并做 SVG 安全校验）；schemaVersion 缺省为主版本当前值。",
    inputSchema: {
      projectId: z.string().min(1),
      name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX),
      schemaVersion: z.string().trim().min(1).max(32).optional(),
      content: z.unknown(),
      thumbnailMeta: templateThumbnailMetaSchema.optional(),
      actor: actorSchema,
    },
  }, ({ projectId, name, schemaVersion, content, thumbnailMeta, actor }) => toolResult(createDiagramTemplate(context, {
    projectId,
    payload: {
      name, content,
      ...(schemaVersion ? { schemaVersion } : {}),
      ...(thumbnailMeta ? { thumbnailMeta } : {}),
      ...(actor ? { actor } : {}),
    },
    audit: mcpAudit(actor),
  })));

  server.registerTool("update_diagram_template", {
    title: "更新白板模板",
    description: "局部更新模板名称/内容/版本/缩略图；系统模板只读（403），已撤销模板不可更新（409），CAS 失败返回 TEMPLATE_REVISION_CONFLICT。",
    inputSchema: {
      templateId: z.string().min(1),
      patch: templatePatchInputSchema,
      expectedUpdatedAt: expectedUpdatedAtSchema,
      actor: actorSchema,
    },
  }, ({ templateId, patch, expectedUpdatedAt, actor }) => toolResult(updateDiagramTemplateRecord(context, {
    templateId,
    payload: { ...patch, expectedUpdatedAt: expectedUpdatedAt ?? null, ...(actor ? { actor } : {}) },
    audit: mcpAudit(actor),
  })));

  server.registerTool("revoke_diagram_template", {
    title: "撤销白板模板",
    description: "软撤销模板（写 revoked_at，幂等）；撤销后模板不再出现在列表且不可被应用。",
    inputSchema: { templateId: z.string().min(1), actor: actorSchema },
  }, ({ templateId, actor }) => toolResult(revokeDiagramTemplateRecord(context, {
    templateId, payload: actor ? { actor } : {}, audit: mcpAudit(actor),
  })));

  server.registerTool("apply_diagram_template", {
    title: "应用白板模板到画布",
    description: "把模板内容应用到目标画布：append 追加（确定性偏移，不覆盖既有内容）、replace 整份替换（主画布/含交付数据的画布被拒绝）；组合区域重叠时 409 且零写入。",
    inputSchema: {
      diagramId: z.string().min(1),
      templateId: z.string().min(1),
      mode: z.enum(["append", "replace"]).optional(),
      expectedUpdatedAt: expectedUpdatedAtSchema,
      actor: actorSchema,
    },
  }, ({ diagramId, templateId, mode, expectedUpdatedAt, actor }) => toolResult(applyDiagramTemplate(context, {
    diagramId,
    payload: {
      templateId,
      ...(mode ? { mode } : {}),
      expectedUpdatedAt: expectedUpdatedAt ?? null,
      ...(actor ? { actor } : {}),
    },
    audit: mcpAudit(actor),
  })));
}