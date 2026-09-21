/**
 * 图层、组件与模板的**唯一服务层**（节点 whiteboard-layers-templates，设计第 6、7 节）。
 *
 * 设计第 7 节的硬契约：MCP 工具与 REST 端点必须是同一服务层函数的两个入口（禁止两套逻辑）。
 * 因此本模块：
 *   - 承载全部业务判定（校验 → 指纹短路 → CAS → 写库 → 画布 revision → 项目 JSON 物化 → audit）；
 *   - 统一返回 `{ status, body }`，不依赖 Fastify 也不依赖 MCP 框架，两端都只是"薄封装"；
 *   - audit 事件由调用方传入的 actor/source 决定，故两端产生的 audit 结构一致（仅 source 不同）。
 *
 * 数据归属（设计第 2.4 节归属裁决）：图层/组件落 diagrams 旁路载荷 layers/components，模板落绑定表
 * diagram_templates。三者都不进入交付门禁统计。
 */
import { z } from "zod";
import {
  type Diagram,
  type DiagramComponentLibrary,
  type DiagramLayerState,
  type DiagramTemplate,
  type FreeformDocument,
} from "../shared/types.js";
import {
  LAYER_SCHEMA_VERSION,
  defaultLayerState,
  diagramLayerStateSchema,
  layerSaveSchema,
  layerStateFingerprint,
  normalizeLayerState,
  validateLayerState,
} from "../shared/layers.js";
import {
  componentCreateSchema,
  componentInstanceSchema,
  componentPatchSchema,
  instantiateComponent,
  snapshotComponent,
} from "../shared/components.js";
import {
  SUPPORTED_TEMPLATE_SCHEMA_VERSION,
  applyTemplateToDiagram,
  assertSafeThumbnailSvg,
  assertTemplateCompatible,
  assertTemplateContentNoDeliveryLeak,
  assertTemplateContentNoExternalUrl,
  assertTemplateReplaceAllowed,
  assertTemplateScopeInvariant,
  buildTemplateThumbnail,
  emptyComponentLibrary,
  mergeLayerStates,
  normalizeTemplateContent,
  normalizeTemplateThumbnail,
  templateApplySchema,
  templateContentBytes,
  templateCreateSchema,
  templatePatchSchema,
  templateRevokeSchema,
  toTemplateSummary,
} from "../shared/templates.js";
import { assertNoIntroducedDiagramGroupOverlap } from "../shared/diagramGroups.js";
import {
  DiagramTemplateNameConflictError,
  DiagramTemplateRevisionConflictError,
  DiagramTemplateRevokedError,
  nextPrototypeRevision,
  nowIso,
  type Store,
} from "./db.js";
import { materializeProjectJson } from "./projectFiles.js";

export interface WhiteboardServiceContext {
  store: Store;
  dataDir: string;
}

/** audit 归属：两端各自解析后传入，保证同一 service 函数产生同结构的 audit 事件。 */
export interface WhiteboardAuditContext {
  actor: string;
  source: "web" | "mcp" | "system";
  correlationId?: string;
  clientId?: string;
  sessionId?: string;
  model?: string;
}

export interface ServiceResult {
  status: number;
  body: unknown;
}

function service(status: number, body: unknown): ServiceResult {
  return { status, body };
}

function contractError(status: number, body: unknown): ServiceResult {
  return { status, body };
}

/** 与 api.ts 的 parse() 同语义：zod 失败 → 400 { message }（既有"纯 message"端点风格）。 */
function parseSchema<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw Object.assign(new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")), { statusCode: 400 });
  }
  return result.data;
}

/** 契约错误 → 结果；未识别错误继续抛给框架（REST 走 Fastify 默认处理器，MCP 由框架转 error）。 */
function mapContractError(cause: unknown): ServiceResult | null {
  if (cause instanceof DiagramTemplateNameConflictError) return contractError(409, { code: "TEMPLATE_NAME_CONFLICT", message: cause.message });
  if (cause instanceof DiagramTemplateRevisionConflictError) {
    return contractError(409, { code: "TEMPLATE_REVISION_CONFLICT", message: cause.message, serverUpdatedAt: cause.serverUpdatedAt });
  }
  if (cause instanceof DiagramTemplateRevokedError) return contractError(409, { code: "TEMPLATE_REVOKED", message: cause.message });
  if (cause && typeof cause === "object" && "statusCode" in cause) {
    const shape = cause as { statusCode: number; code?: string; message: string; details?: Record<string, unknown> };
    if (!shape.code) return contractError(shape.statusCode, { message: shape.message });
    // 契约错误体：details 同时平铺到根层（设计 5.4 要求 supportedSchemaVersions 等在根层可读）。
    return contractError(shape.statusCode, {
      code: shape.code,
      message: shape.message,
      ...(shape.details ?? {}),
      ...(shape.details ? { details: shape.details } : {}),
    });
  }
  return null;
}

function guard(run: () => ServiceResult): ServiceResult {
  try {
    return run();
  } catch (cause) {
    const mapped = mapContractError(cause);
    if (mapped) return mapped;
    throw cause;
  }
}

function recordAudit(store: Store, audit: WhiteboardAuditContext, event: {
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): void {
  store.recordAudit({
    ...event,
    actor: audit.actor,
    source: audit.source,
    correlationId: audit.correlationId,
    clientId: audit.clientId,
    sessionId: audit.sessionId,
    model: audit.model,
  });
}

function readFreeformDocument(store: Store, diagramId: string): FreeformDocument | null {
  try {
    return store.getFreeformDocument(diagramId) ?? null;
  } catch {
    return null;
  }
}

/** 图层状态真源解析结果：派生后的完整 state + 载荷版本高于本实现的只读标记（设计 3.7 第 6 条）。 */
interface ResolvedLayerState {
  state: DiagramLayerState;
  /** 载荷 schemaVersion > 1：读取返回派生结果并标记，任何写入必须 409。 */
  unsupported: boolean;
  sourceVersion: number;
}

/** 图层状态真源：物理列有值即归一化，否则按当前画布内容派生默认系统层（读取不写库）。 */
function layerStateFor(store: Store, diagram: Diagram, freeform: FreeformDocument | null): ResolvedLayerState {
  const raw = store.getRawDiagramLayers(diagram.id) ?? diagram.layers;
  if (raw) {
    const normalized = normalizeLayerState(raw, {
      nodeIds: diagram.nodes.map((node) => node.id),
      edgeIds: diagram.edges.map((edge) => edge.id),
      freeformIds: (freeform?.elements ?? []).map((element) => element.id),
    });
    const sourceVersion = Number((raw as { schemaVersion?: unknown }).schemaVersion);
    return {
      state: normalized.state,
      unsupported: normalized.unsupported,
      sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : LAYER_SCHEMA_VERSION,
    };
  }
  return {
    state: defaultLayerState({ nodes: diagram.nodes, edges: diagram.edges, freeform }, ""),
    unsupported: false,
    sourceVersion: LAYER_SCHEMA_VERSION,
  };
}

/** 载荷 schemaVersion 高于本实现 → 409 LAYER_SCHEMA_UNSUPPORTED（设计 3.7 第 6 条）。 */
function layerSchemaUnsupported(version: number): ServiceResult {
  return contractError(409, {
    code: "LAYER_SCHEMA_UNSUPPORTED",
    message: `图层载荷版本 ${version} 高于本实现支持的 ${LAYER_SCHEMA_VERSION}`,
    supportedSchemaVersions: [LAYER_SCHEMA_VERSION],
  });
}

/**
 * 图层写入的统一契约校验（设计 3.6「同一合成函数」/ 3.7）。
 * 专用端点 PATCH /api/diagrams/:id/layers 与 diagrams PATCH 的可选 layers 字段**共用本函数**：
 * 同一 strict schema、同一 validateLayerState、同一三类 id 上下文，禁止任何一处绕开校验落库。
 */
function assertLayerStateAgainstDiagram(store: Store, diagram: Diagram, state: DiagramLayerState): DiagramLayerState {
  const freeform = readFreeformDocument(store, diagram.id);
  validateLayerState(state, {
    nodeIds: diagram.nodes.map((node) => node.id),
    edgeIds: diagram.edges.map((edge) => edge.id),
    freeformIds: (freeform?.elements ?? []).map((element) => element.id),
  });
  return state;
}

/**
 * diagrams PATCH 的可选 layers 字段解析入口（设计 3.6 加法式契约扩展）。
 * 返回 `{ state }` 表示通过校验，返回 `{ result }` 表示应原样回给客户端的契约错误结果。
 */
export function normalizeDiagramLayerField(
  context: WhiteboardServiceContext,
  diagram: Diagram,
  payload: unknown,
): { state: DiagramLayerState } | { result: ServiceResult } {
  const rawVersion = Number((payload as { schemaVersion?: unknown } | null | undefined)?.schemaVersion);
  if (Number.isFinite(rawVersion) && rawVersion > LAYER_SCHEMA_VERSION) return { result: layerSchemaUnsupported(rawVersion) };
  const stored = layerStateFor(context.store, diagram, readFreeformDocument(context.store, diagram.id));
  if (stored.unsupported) return { result: layerSchemaUnsupported(stored.sourceVersion) };
  try {
    const state = parseSchema(diagramLayerStateSchema, payload);
    return { state: assertLayerStateAgainstDiagram(context.store, diagram, state) };
  } catch (cause) {
    const mapped = mapContractError(cause);
    if (mapped) return { result: mapped };
    throw cause;
  }
}

function diagramComponents(diagram: Diagram): DiagramComponentLibrary {
  return diagram.components ?? emptyComponentLibrary();
}

function commitDiagramWrite(store: Store, dataDir: string, audit: WhiteboardAuditContext, before: Diagram, next: Diagram | undefined): void {
  if (!next) return;
  store.recordDiagramRevision(next.id, before, next, audit.actor);
  const project = store.getProject(next.projectId);
  if (project) {
    materializeProjectJson(dataDir, project.id, "diagrams", next.id, {
      id: next.id, projectId: next.projectId, title: next.title, type: next.type,
      nodes: next.nodes, edges: next.edges, groups: next.groups, createdAt: next.createdAt, updatedAt: next.updatedAt,
    });
  }
}

function writeFreeform(store: Store, diagram: Diagram, before: FreeformDocument | null, elements: FreeformDocument["elements"], unsupported: FreeformDocument["unsupported"]): void {
  store.upsertFreeformDocument(diagram.id, { schemaVersion: 1, elements, unsupported }, before ? before.updatedAt : null);
}

function diagramCasConflict(diagram: Diagram, code: string): ServiceResult {
  return contractError(409, { code, message: `画布已被其他操作修改；当前 updatedAt=${diagram.updatedAt}`, serverUpdatedAt: diagram.updatedAt });
}

function assetIds(store: Store, projectId: string): string[] {
  return store.listFreeformAssets(projectId).map((asset) => asset.id);
}

// ---------- 图层（设计 3、6.2、8.1） ----------

export function readDiagramLayers(context: WhiteboardServiceContext, input: { diagramId: string }): ServiceResult {
  const { store } = context;
  const diagram = store.getDiagram(input.diagramId);
  if (!diagram) return contractError(404, { message: "画布不存在" });
  const resolved = layerStateFor(store, diagram, readFreeformDocument(store, diagram.id));
  // 设计 3.7 第 6 条：未知 schemaVersion（>1）读取时返回派生结果并标记 unsupported: true（只读不写）。
  return service(200, { ...resolved.state, ...(resolved.unsupported ? { unsupported: true } : {}), diagramUpdatedAt: diagram.updatedAt });
}

export function saveDiagramLayers(
  context: WhiteboardServiceContext,
  input: { diagramId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  return guard(() => {
    const diagram = store.getDiagram(input.diagramId);
    if (!diagram) return contractError(404, { message: "画布不存在" });
    const raw = (input.payload ?? {}) as { schemaVersion?: unknown };
    const rawVersion = Number(raw.schemaVersion);
    if (Number.isFinite(rawVersion) && rawVersion > LAYER_SCHEMA_VERSION) return layerSchemaUnsupported(rawVersion);
    const freeform = readFreeformDocument(store, diagram.id);
    const stored = layerStateFor(store, diagram, freeform);
    // 设计 3.7 第 6 条：已存载荷版本高于本实现时只读不写，任何写入一律 409，防止新版本数据被旧实现覆盖破坏。
    if (stored.unsupported) {
      return layerSchemaUnsupported(stored.sourceVersion);
    }
    const body = parseSchema(layerSaveSchema, input.payload);
    const incoming: DiagramLayerState = assertLayerStateAgainstDiagram(store, diagram, {
      schemaVersion: body.schemaVersion, layers: body.layers, itemOverrides: body.itemOverrides,
    });
    const current = stored.state;
    // 内容指纹相同即无变化：直接返回当前状态，不写库、不产生 revision 与 audit 噪音（设计 8.1）。
    if (layerStateFingerprint(incoming) === layerStateFingerprint(current)) {
      return service(200, { ...current, diagramUpdatedAt: diagram.updatedAt });
    }
    if (body.expectedUpdatedAt !== diagram.updatedAt) return diagramCasConflict(diagram, "LAYER_STATE_CONFLICT");
    const next = store.updateDiagram(diagram.id, { layers: incoming });
    if (!next) return contractError(404, { message: "画布不存在" });
    commitDiagramWrite(store, dataDir, input.audit, diagram, next);
    recordAudit(store, input.audit, {
      projectId: diagram.projectId, entityType: "diagramLayer", entityId: diagram.id, action: "update",
      before: { layerCount: current.layers.length }, after: { layerCount: incoming.layers.length },
    });
    return service(200, { ...incoming, diagramUpdatedAt: next.updatedAt });
  });
}

// ---------- 组件（设计 4、6.3） ----------

export function readDiagramComponents(context: WhiteboardServiceContext, input: { diagramId: string }): ServiceResult {
  const { store } = context;
  const diagram = store.getDiagram(input.diagramId);
  if (!diagram) return contractError(404, { message: "画布不存在" });
  return service(200, { ...diagramComponents(diagram), diagramUpdatedAt: diagram.updatedAt });
}

export function createDiagramComponent(
  context: WhiteboardServiceContext,
  input: { diagramId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  return guard(() => {
    const diagram = store.getDiagram(input.diagramId);
    if (!diagram) return contractError(404, { message: "画布不存在" });
    const body = parseSchema(componentCreateSchema, input.payload);
    if (body.expectedUpdatedAt !== diagram.updatedAt) return diagramCasConflict(diagram, "LAYER_STATE_CONFLICT");
    const library = diagramComponents(diagram);
    if (library.components.some((component) => component.name === body.name.trim())) {
      return contractError(409, { code: "COMPONENT_NAME_CONFLICT", message: `组件名称已存在：${body.name.trim()}` });
    }
    const snapshot = snapshotComponent({
      diagram, freeform: readFreeformDocument(store, diagram.id), layerState: diagram.layers ?? null,
      selection: body.selection, name: body.name, actor: body.actor?.trim() || input.audit.actor, now: nowIso(),
      availableAssetIds: assetIds(store, diagram.projectId),
    });
    const definition = snapshot.definition;
    const next = store.updateDiagram(diagram.id, { components: { schemaVersion: 1, components: [...library.components, definition] } });
    if (!next) return contractError(404, { message: "画布不存在" });
    commitDiagramWrite(store, dataDir, input.audit, diagram, next);
    recordAudit(store, input.audit, {
      projectId: diagram.projectId, entityType: "diagramComponent", entityId: definition.id, action: "create",
      before: null, after: { name: definition.name, nodeCount: definition.payload.nodes.length, droppedEdgeIds: snapshot.droppedEdgeIds },
    });
    return service(201, { component: definition, droppedEdgeIds: snapshot.droppedEdgeIds, diagramUpdatedAt: next.updatedAt });
  });
}

export function updateDiagramComponent(
  context: WhiteboardServiceContext,
  input: { diagramId: string; componentId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  return guard(() => {
    const diagram = store.getDiagram(input.diagramId);
    if (!diagram) return contractError(404, { message: "画布不存在" });
    const body = parseSchema(componentPatchSchema, input.payload);
    if (body.expectedUpdatedAt !== diagram.updatedAt) return diagramCasConflict(diagram, "LAYER_STATE_CONFLICT");
    const library = diagramComponents(diagram);
    const current = library.components.find((component) => component.id === input.componentId);
    if (!current) return contractError(404, { message: "组件不存在" });
    const name = body.name?.trim() ?? current.name;
    if (name !== current.name && library.components.some((component) => component.id !== input.componentId && component.name === name)) {
      return contractError(409, { code: "COMPONENT_NAME_CONFLICT", message: `组件名称已存在：${name}` });
    }
    let payload = current.payload;
    let sourceSelection = current.sourceSelection;
    let droppedEdgeIds: string[] = [];
    if (body.selection) {
      const snapshot = snapshotComponent({
        diagram, freeform: readFreeformDocument(store, diagram.id), layerState: diagram.layers ?? null,
        selection: body.selection, name, actor: body.actor?.trim() || input.audit.actor, now: nowIso(),
        availableAssetIds: assetIds(store, diagram.projectId),
      });
      payload = snapshot.definition.payload;
      sourceSelection = snapshot.definition.sourceSelection;
      droppedEdgeIds = snapshot.droppedEdgeIds;
    }
    const updated = { ...current, name, payload, sourceSelection, updatedAt: nextPrototypeRevision(current.updatedAt) };
    const next = store.updateDiagram(diagram.id, {
      components: { schemaVersion: 1, components: library.components.map((component) => component.id === input.componentId ? updated : component) },
    });
    if (!next) return contractError(404, { message: "画布不存在" });
    commitDiagramWrite(store, dataDir, input.audit, diagram, next);
    recordAudit(store, input.audit, {
      projectId: diagram.projectId, entityType: "diagramComponent", entityId: input.componentId, action: "update",
      before: { name: current.name }, after: { name: updated.name, droppedEdgeIds },
    });
    return service(200, { component: updated, droppedEdgeIds, diagramUpdatedAt: next.updatedAt });
  });
}

export function removeDiagramComponent(
  context: WhiteboardServiceContext,
  input: { diagramId: string; componentId: string; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  const diagram = store.getDiagram(input.diagramId);
  if (!diagram) return contractError(404, { message: "画布不存在" });
  const library = diagramComponents(diagram);
  // 幂等删除：组件不存在时不写库、不产生噪音，仍返回成功（设计 4.5）。
  if (!library.components.some((component) => component.id === input.componentId)) {
    return service(200, { ok: true, diagramUpdatedAt: diagram.updatedAt });
  }
  const next = store.updateDiagram(diagram.id, {
    components: { schemaVersion: 1, components: library.components.filter((component) => component.id !== input.componentId) },
  });
  if (!next) return contractError(404, { message: "画布不存在" });
  commitDiagramWrite(store, dataDir, input.audit, diagram, next);
  recordAudit(store, input.audit, {
    projectId: diagram.projectId, entityType: "diagramComponent", entityId: input.componentId, action: "delete",
    before: null, after: null,
  });
  return service(200, { ok: true, diagramUpdatedAt: next.updatedAt });
}

export function createComponentInstances(
  context: WhiteboardServiceContext,
  input: { diagramId: string; componentId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  return guard(() => {
    const diagram = store.getDiagram(input.diagramId);
    if (!diagram) return contractError(404, { message: "画布不存在" });
    const body = parseSchema(componentInstanceSchema, input.payload);
    if (body.expectedUpdatedAt !== diagram.updatedAt) return diagramCasConflict(diagram, "LAYER_STATE_CONFLICT");
    const library = diagramComponents(diagram);
    const definition = library.components.find((component) => component.id === input.componentId);
    if (!definition) return contractError(404, { message: "组件不存在" });
    const before = readFreeformDocument(store, diagram.id);
    const instance = instantiateComponent({
      definition, offsetX: body.offsetX, offsetY: body.offsetY, now: nowIso(),
      availableAssetIds: assetIds(store, diagram.projectId),
    });
    const stored = layerStateFor(store, diagram, before);
    // 设计 10.3：实例化引入的新组（来自 payload.groups，nodeIds 只含新节点）必须在写入事务前做重叠校验；
    // 与既有组重叠 → 409 COMPONENT_GROUP_OVERLAP，且零写入（不做静默裁剪或改名）。
    const nextNodes = [...diagram.nodes, ...instance.nodes];
    const nextGroups = [...diagram.groups, ...instance.groups];
    if (instance.groups.length) {
      try {
        assertNoIntroducedDiagramGroupOverlap(diagram, { nodes: nextNodes, groups: nextGroups });
      } catch {
        return contractError(409, {
          code: "COMPONENT_GROUP_OVERLAP",
          message: "组件实例引入的组合区域与目标画布既有组合区域重叠，已拒绝（不做静默裁剪或改名）",
        });
      }
    }
    const layers = instance.layers ? mergeLayerStates(stored.state, instance.layers, nowIso()) : undefined;
    const next = store.updateDiagram(diagram.id, {
      nodes: nextNodes,
      edges: [...diagram.edges, ...instance.edges],
      groups: nextGroups,
      // 已存图层载荷版本高于本实现时只读不写（设计 3.7 第 6 条）：保留原载荷，不写归一化结果。
      ...(layers && !stored.unsupported ? { layers } : {}),
    });
    if (!next) return contractError(404, { message: "画布不存在" });
    if (instance.freeformElements.length) {
      writeFreeform(store, diagram, before, [...(before?.elements ?? []), ...instance.freeformElements], before?.unsupported ?? []);
    }
    commitDiagramWrite(store, dataDir, input.audit, diagram, next);
    recordAudit(store, input.audit, {
      projectId: diagram.projectId, entityType: "diagramComponent", entityId: input.componentId, action: "instantiate",
      before: null, after: { createdNodeIds: instance.createdNodeIds.length, createdFreeformIds: instance.createdFreeformIds.length },
    });
    return service(201, {
      diagram: next,
      createdNodeIds: instance.createdNodeIds,
      createdEdgeIds: instance.createdEdgeIds,
      createdFreeformIds: instance.createdFreeformIds,
      droppedEdgeIds: instance.droppedEdgeIds,
      diagramUpdatedAt: next.updatedAt,
    });
  });
}

// ---------- 模板（设计 5、6.4） ----------

export function listDiagramTemplates(
  context: WhiteboardServiceContext,
  input: { projectId: string; scope?: "system" | "project"; schemaVersion?: string; offset?: number; limit?: number },
): ServiceResult {
  const { store } = context;
  if (!store.getProject(input.projectId)) return contractError(404, { message: "项目不存在" });
  if (input.scope !== undefined && input.scope !== "system" && input.scope !== "project") {
    return contractError(400, { code: "TEMPLATE_SCOPE_INVALID", message: `模板 scope 非法：${String(input.scope)}` });
  }
  const templates = store.listDiagramTemplates(input.projectId, {
    scope: input.scope as DiagramTemplate["scope"] | undefined,
    schemaVersion: input.schemaVersion || undefined,
    offset: 0,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const summaries = templates.map((template) => toTemplateSummary(template, template.content));
  return service(200, paginateItems(summaries, input.offset, input.limit));
}

/** 与 api.ts 分页语义一致：offset/limit 都缺省时返回裸数组。 */
export function paginateItems<T>(items: T[], offset: number | undefined, limit: number | undefined): unknown {
  if (offset === undefined && limit === undefined) return items;
  const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? (limit as number) : 20, 1), 100);
  const safeOffset = Number.isSafeInteger(offset) ? Math.max(offset as number, 0) : 0;
  const pageItems = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + pageItems.length;
  return {
    total: items.length, count: pageItems.length, offset: safeOffset, items: pageItems,
    hasMore: nextOffset < items.length, nextOffset: nextOffset < items.length ? nextOffset : null,
  };
}

export function readDiagramTemplate(
  context: WhiteboardServiceContext,
  input: { templateId: string; include?: string; projectId?: string },
): ServiceResult {
  const { store } = context;
  const template = store.getDiagramTemplate(input.templateId);
  if (!template) return contractError(404, { message: "模板不存在" });
  if (input.projectId && template.scope === "project" && template.projectId !== input.projectId) {
    return contractError(404, { message: "模板不存在" });
  }
  const include = new Set((input.include ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  return service(200, {
    ...toTemplateSummary(template, template.content),
    ...(include.has("thumbnail") ? { thumbnailMeta: template.thumbnailMeta } : {}),
    ...(include.has("content") ? { content: template.content } : {}),
  });
}

export function createDiagramTemplate(
  context: WhiteboardServiceContext,
  input: { projectId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store } = context;
  return guard(() => {
    if (!store.getProject(input.projectId)) return contractError(404, { message: "项目不存在" });
    const body = parseSchema(templateCreateSchema, input.payload);
    assertTemplateScopeInvariant(body.scope, input.projectId);
    assertTemplateCompatible(body.schemaVersion);
    assertTemplateContentNoDeliveryLeak(body.content);
    assertTemplateContentNoExternalUrl(body.content);
    const normalized = normalizeTemplateContent(body.content, { now: nowIso(), availableAssetIds: assetIds(store, input.projectId) });
    const content = { ...normalized.content, schemaVersion: body.schemaVersion };
    const thumbnail = body.thumbnailMeta
      ? { meta: normalizeTemplateThumbnail({ ...body.thumbnailMeta, source: "custom" }, nowIso()) }
      : buildTemplateThumbnail(content, { now: nowIso() });
    // kind=none 时 content 为空，安全校验只针对 svg 载荷（避免把"无缩略图"误判为不安全）。
    if (thumbnail.meta.kind === "svg") assertSafeThumbnailSvg(thumbnail.meta.content ?? "");
    const warning = "warning" in thumbnail ? thumbnail.warning : undefined;
    const template = store.insertDiagramTemplate({
      projectId: input.projectId, scope: "project", name: body.name.trim(), schemaVersion: body.schemaVersion,
      content, thumbnailMeta: thumbnail.meta, createdBy: body.actor?.trim() || input.audit.actor,
    });
    recordAudit(store, input.audit, {
      projectId: input.projectId, entityType: "diagramTemplate", entityId: template.id, action: "create",
      before: null, after: { name: template.name, schemaVersion: template.schemaVersion, contentBytes: templateContentBytes(template.content) },
    });
    return service(201, { ...template, ...(warning ? { thumbnailWarning: warning } : {}) });
  });
}

export function updateDiagramTemplateRecord(
  context: WhiteboardServiceContext,
  input: { templateId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store } = context;
  return guard(() => {
    const current = store.findDiagramTemplate(input.templateId);
    if (!current) return contractError(404, { message: "模板不存在" });
    if (current.revokedAt) return contractError(409, { code: "TEMPLATE_REVOKED", message: "模板已撤销，不可更新" });
    if (current.scope === "system") return contractError(403, { code: "TEMPLATE_SYSTEM_READONLY", message: "系统内置模板只读，项目接口不可改写" });
    const body = parseSchema(templatePatchSchema, input.payload);
    const schemaVersion = body.schemaVersion ?? current.schemaVersion;
    if (body.schemaVersion) assertTemplateCompatible(schemaVersion);
    let content = current.content;
    let meta = current.thumbnailMeta;
    let warning: string | undefined;
    if (body.content !== undefined) {
      assertTemplateContentNoDeliveryLeak(body.content);
      assertTemplateContentNoExternalUrl(body.content);
      const normalized = normalizeTemplateContent(body.content, { now: nowIso(), availableAssetIds: assetIds(store, current.projectId ?? "") });
      content = { ...normalized.content, schemaVersion };
      if (!body.thumbnailMeta) {
        const thumbnail = buildTemplateThumbnail(content, { now: nowIso() });
        meta = thumbnail.meta;
        warning = thumbnail.warning;
      }
    }
    if (body.thumbnailMeta) {
      meta = normalizeTemplateThumbnail({ ...body.thumbnailMeta, source: "custom" }, nowIso());
      if (meta.kind === "svg") assertSafeThumbnailSvg(meta.content ?? "");
    }
    const name = body.name?.trim();
    const template = store.updateDiagramTemplate(input.templateId, {
      ...(name ? { name } : {}), schemaVersion, content, thumbnailMeta: meta,
    }, body.expectedUpdatedAt);
    if (!template) return contractError(404, { message: "模板不存在" });
    recordAudit(store, input.audit, {
      projectId: template.projectId, entityType: "diagramTemplate", entityId: template.id, action: "update",
      before: { name: current.name, updatedAt: current.updatedAt }, after: { name: template.name, updatedAt: template.updatedAt },
    });
    return service(200, { ...template, ...(warning ? { thumbnailWarning: warning } : {}) });
  });
}

export function revokeDiagramTemplateRecord(
  context: WhiteboardServiceContext,
  input: { templateId: string; payload?: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store } = context;
  return guard(() => {
    if (input.payload !== undefined) parseSchema(templateRevokeSchema, input.payload);
    const current = store.findDiagramTemplate(input.templateId);
    if (!current) return contractError(404, { message: "模板不存在" });
    if (current.scope === "system") return contractError(403, { code: "TEMPLATE_SYSTEM_READONLY", message: "系统内置模板只读，项目接口不可撤销" });
    const template = store.revokeDiagramTemplate(input.templateId);
    if (!template) return contractError(404, { message: "模板不存在" });
    recordAudit(store, input.audit, {
      projectId: template.projectId, entityType: "diagramTemplate", entityId: template.id, action: "revoke",
      before: { revokedAt: current.revokedAt }, after: { revokedAt: template.revokedAt },
    });
    return service(200, toTemplateSummary(template, template.content));
  });
}

export function applyDiagramTemplate(
  context: WhiteboardServiceContext,
  input: { diagramId: string; payload: unknown; audit: WhiteboardAuditContext },
): ServiceResult {
  const { store, dataDir } = context;
  return guard(() => {
    const diagram = store.getDiagram(input.diagramId);
    if (!diagram) return contractError(404, { message: "画布不存在" });
    const body = parseSchema(templateApplySchema, input.payload);
    if (body.expectedUpdatedAt !== diagram.updatedAt) return diagramCasConflict(diagram, "TEMPLATE_APPLY_CONFLICT");
    const template = store.getDiagramTemplate(body.templateId);
    if (!template) return contractError(404, { message: "模板不存在" });
    if (template.scope === "project" && template.projectId !== diagram.projectId) return contractError(404, { message: "模板不存在" });
    let content = template.content;
    let migrated = false;
    const compatibility = assertTemplateCompatible(template.schemaVersion);
    if (compatibility.status === "downgrade") {
      const normalized = normalizeTemplateContent(template.content, { now: nowIso(), availableAssetIds: assetIds(store, diagram.projectId) });
      content = { ...normalized.content, schemaVersion: SUPPORTED_TEMPLATE_SCHEMA_VERSION };
      migrated = true;
    }
    assertTemplateContentNoDeliveryLeak(content);
    if (body.mode === "replace") {
      const nodeIds = new Set(diagram.nodes.map((node) => node.id));
      assertTemplateReplaceAllowed({
        diagramType: diagram.type,
        nodes: diagram.nodes,
        planCount: store.listPlans(diagram.projectId, diagram.id).length,
        evidenceCount: store.listEvidence(diagram.projectId).filter((item) => item.nodeId && nodeIds.has(item.nodeId)).length,
      });
    }
    const before = readFreeformDocument(store, diagram.id);
    const storedLayers = layerStateFor(store, diagram, before);
    const applied = applyTemplateToDiagram({
      diagram: {
        type: diagram.type, nodes: diagram.nodes, edges: diagram.edges, groups: diagram.groups,
        layers: storedLayers.state, components: diagramComponents(diagram),
      },
      freeform: before,
      content,
      mode: body.mode,
      now: nowIso(),
      availableAssetIds: assetIds(store, diagram.projectId),
    });
    try {
      assertNoIntroducedDiagramGroupOverlap(diagram, { ...diagram, groups: applied.groups });
    } catch {
      return contractError(409, { code: "TEMPLATE_GROUP_OVERLAP", message: "模板组合区域与目标画布既有组合区域重叠，已拒绝（不做静默裁剪）" });
    }
    const next = store.updateDiagram(diagram.id, {
      nodes: applied.nodes, edges: applied.edges, groups: applied.groups,
      // 已存图层载荷版本高于本实现时只读不写（设计 3.7 第 6 条）：保留原载荷。
      ...(storedLayers.unsupported ? {} : { layers: applied.layers }),
      components: applied.components,
    });
    if (!next) return contractError(404, { message: "画布不存在" });
    writeFreeform(store, diagram, before, applied.freeform.elements, applied.freeform.unsupported);
    commitDiagramWrite(store, dataDir, input.audit, diagram, next);
    recordAudit(store, input.audit, {
      projectId: diagram.projectId, entityType: "diagramTemplate", entityId: template.id, action: "apply",
      before: { nodes: diagram.nodes.length },
      after: { nodes: next.nodes.length, mode: body.mode, migrated, thumbnailApplied: template.thumbnailMeta.kind === "svg" },
    });
    return service(200, {
      diagram: next,
      createdNodeIds: applied.createdNodeIds,
      createdEdgeIds: applied.createdEdgeIds,
      createdFreeformIds: applied.createdFreeformIds,
      droppedLinkDiagramIds: applied.droppedLinkDiagramIds,
      migrated,
      thumbnailApplied: template.thumbnailMeta.kind === "svg",
      diagramUpdatedAt: next.updatedAt,
    });
  });
}
