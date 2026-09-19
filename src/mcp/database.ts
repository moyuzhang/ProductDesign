import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { autoLayoutDatabaseModel, generateDatabaseCode, validateDatabaseModel } from "../shared/databaseModel.js";
import { databaseConnectionSchema, databaseFieldSchema, databaseIndexSchema, databaseRelationSchema, databaseTableSchema } from "../shared/databaseSchemas.js";
import { DATABASE_CODE_TARGETS, DATABASE_DIALECTS, NODE_DATABASE_OPERATIONS, type DatabaseModel, type NodeDatabaseBinding, type Project } from "../shared/types.js";
import type { Store } from "../server/db.js";
import {
  checkDatabaseConnection,
  databaseConnectionLabel,
  deployDatabaseModel,
  inspectDatabase,
  previewDatabaseDeploy,
  previewDatabaseReverse,
  snapshotToModel,
} from "../server/databaseEngineering.js";

function result(data: unknown, message?: string) {
  const structuredContent = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { data };
  const payload = JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text: message ? `${message}\n${payload}` : payload }], structuredContent };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function projectByRef(store: Store, projectRef: string): Project | undefined {
  return store.getProject(projectRef) ?? store.listProjects().find((project) => project.code.toLowerCase() === projectRef.toLowerCase());
}

function summary(model: DatabaseModel): Record<string, unknown> {
  return { name: model.name, dialect: model.dialect, tables: model.tables.length, relations: model.relations.length, updatedAt: model.updatedAt };
}

function audit(store: Store, actor: string | undefined, model: DatabaseModel, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
  store.recordAudit({ projectId: model.projectId, entityType: "databaseModel", entityId: model.id, action, before, after, actor: actor?.trim() || "mcp-client", source: "mcp" });
}

function bindingSummary(binding: NodeDatabaseBinding): Record<string, unknown> {
  return {
    diagramId: binding.diagramId,
    diagramNodeId: binding.diagramNodeId,
    databaseModelId: binding.databaseModelId,
    schemaName: binding.schemaName,
    tableName: binding.tableName,
    operations: binding.operations,
    purpose: binding.purpose,
    updatedAt: binding.updatedAt,
  };
}

function bindingTargetError(store: Store, binding: Pick<NodeDatabaseBinding, "projectId" | "diagramId" | "diagramNodeId" | "databaseModelId" | "schemaName" | "tableName">, bindingId?: string): string | undefined {
  const project = store.getProject(binding.projectId);
  if (!project) return `未找到项目: ${binding.projectId}`;
  const diagram = store.getDiagram(binding.diagramId);
  if (!diagram || diagram.projectId !== project.id) return "画布不存在或不属于当前项目";
  if (diagram.type === "flow") return "流程图节点只保留基本信息，不支持数据库表关联";
  if (!diagram.nodes.some((node) => node.id === binding.diagramNodeId)) return "画布节点不存在";
  const model = store.getDatabaseModel(binding.databaseModelId);
  if (!model || model.projectId !== project.id) return "数据库模型不存在或不属于当前项目";
  if (!model.tables.some((table) => table.name.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase())) return "数据库模型中不存在该物理表";
  const duplicate = store.listNodeDatabaseBindings({ diagramId: binding.diagramId, diagramNodeId: binding.diagramNodeId })
    .some((item) => item.id !== bindingId
      && item.databaseModelId === binding.databaseModelId
      && item.schemaName.toLocaleLowerCase() === binding.schemaName.toLocaleLowerCase()
      && item.tableName.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase());
  return duplicate ? "当前节点已经关联该数据库表" : undefined;
}

function auditBinding(store: Store, actor: string | undefined, binding: NodeDatabaseBinding, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): void {
  store.recordAudit({ projectId: binding.projectId, entityType: "nodeDatabaseBinding", entityId: binding.id, action, before, after, actor: actor?.trim() || "mcp-client", source: "mcp" });
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const externalRead = { ...readOnly, openWorldHint: true } as const;
const externalWrite = { ...write, openWorldHint: true } as const;

export function registerDatabaseTools(server: McpServer, store: Store): void {
  server.registerTool("list_database_models", {
    title: "列出数据库模型",
    description: "分页列出全部或指定项目的数据库模型，可按名称和数据库方言筛选。",
    inputSchema: {
      projectRef: z.string().optional(), q: z.string().max(200).optional(), dialect: z.enum(DATABASE_DIALECTS).optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  }, ({ projectRef, q, dialect, offset, limit }) => {
    const project = projectRef ? projectByRef(store, projectRef) : undefined;
    if (projectRef && !project) return error(`未找到项目: ${projectRef}`);
    let models = store.listDatabaseModels(project?.id);
    if (q) models = models.filter((model) => `${model.name} ${JSON.stringify(model.tables)}`.toLowerCase().includes(q.toLowerCase()));
    if (dialect) models = models.filter((model) => model.dialect === dialect);
    const items = models.slice(offset, offset + limit);
    return result({ total: models.length, count: items.length, offset, hasMore: offset + items.length < models.length, nextOffset: offset + items.length < models.length ? offset + items.length : null, items });
  });

  server.registerTool("get_database_model", {
    title: "获取数据库模型",
    description: "返回数据库模型的表、字段、索引、关系和画布位置。",
    inputSchema: { modelId: z.string().min(1) },
    annotations: readOnly,
  }, ({ modelId }) => {
    const model = store.getDatabaseModel(modelId);
    return model ? result(model) : error(`未找到数据库模型: ${modelId}`);
  });

  server.registerTool("create_database_model", {
    title: "创建数据库模型",
    description: "为项目创建 MySQL、PostgreSQL 或 SQLite 数据库模型，可同时提供完整表和关系。",
    inputSchema: {
      projectRef: z.string().min(1), name: z.string().trim().min(1).max(200), dialect: z.enum(DATABASE_DIALECTS).default("mysql"),
      tables: z.array(databaseTableSchema).max(1000).default([]), relations: z.array(databaseRelationSchema).max(5000).default([]), actor: z.string().max(100).optional(),
    },
    annotations: write,
  }, ({ projectRef, name, dialect, tables, relations, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    if (store.listDatabaseModels(project.id).some((model) => model.name.toLowerCase() === name.toLowerCase())) return error("当前项目已存在同名数据库模型");
    const draft = { projectId: project.id, name, dialect, tables, relations };
    const issues = validateDatabaseModel(draft);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length) return error(errors.map((issue) => issue.message).join("; "));
    const model = store.insertDatabaseModel(draft);
    audit(store, actor, model, "create", null, summary(model));
    return result(model, "数据库模型已创建");
  });

  server.registerTool("update_database_model", {
    title: "更新数据库模型",
    description: "整体更新数据库模型名称、方言、表、字段、索引和关系；使用 expectedUpdatedAt 防止覆盖并发修改。",
    inputSchema: {
      modelId: z.string().min(1), expectedUpdatedAt: z.string().optional(), name: z.string().trim().min(1).max(200).optional(), dialect: z.enum(DATABASE_DIALECTS).optional(),
      tables: z.array(databaseTableSchema).max(1000).optional(), relations: z.array(databaseRelationSchema).max(5000).optional(), actor: z.string().max(100).optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, ({ modelId, expectedUpdatedAt, name, dialect, tables, relations, actor }) => {
    const before = store.getDatabaseModel(modelId);
    if (!before) return error(`未找到数据库模型: ${modelId}`);
    if (expectedUpdatedAt && before.updatedAt !== expectedUpdatedAt) return error(`数据库模型已被其他操作修改；当前 updatedAt=${before.updatedAt}`);
    const next: DatabaseModel = { ...before, ...(name !== undefined ? { name } : {}), ...(dialect !== undefined ? { dialect } : {}), ...(tables !== undefined ? { tables } : {}), ...(relations !== undefined ? { relations } : {}) };
    if (store.listDatabaseModels(before.projectId).some((model) => model.id !== before.id && model.name.toLowerCase() === next.name.toLowerCase())) return error("当前项目已存在同名数据库模型");
    const errors = validateDatabaseModel(next).filter((issue) => issue.severity === "error");
    if (errors.length) return error(errors.map((issue) => issue.message).join("; "));
    const updated = store.updateDatabaseModel(modelId, next);
    if (!updated) return error(`未找到数据库模型: ${modelId}`);
    audit(store, actor, updated, "update", summary(before), summary(updated));
    return result(updated, "数据库模型已更新");
  });

  server.registerTool("auto_layout_database_model", {
    title: "自动布局数据库模型",
    description: "按表数量重新排列 ER 画布中的表卡片，并持久化位置。",
    inputSchema: { modelId: z.string().min(1), expectedUpdatedAt: z.string().optional(), actor: z.string().max(100).optional() },
    annotations: { ...write, idempotentHint: true },
  }, ({ modelId, expectedUpdatedAt, actor }) => {
    const before = store.getDatabaseModel(modelId);
    if (!before) return error(`未找到数据库模型: ${modelId}`);
    if (expectedUpdatedAt && before.updatedAt !== expectedUpdatedAt) return error(`数据库模型已被其他操作修改；当前 updatedAt=${before.updatedAt}`);
    const updated = store.updateDatabaseModel(modelId, autoLayoutDatabaseModel(before));
    if (!updated) return error(`未找到数据库模型: ${modelId}`);
    audit(store, actor, updated, "layout", summary(before), summary(updated));
    return result(updated, "数据库模型已自动布局");
  });

  server.registerTool("validate_database_model", {
    title: "校验数据库模型",
    description: "校验表名、字段名、索引引用、外键引用、自增字段和关系字段类型。",
    inputSchema: { modelId: z.string().min(1) },
    annotations: readOnly,
  }, ({ modelId }) => {
    const model = store.getDatabaseModel(modelId);
    if (!model) return error(`未找到数据库模型: ${modelId}`);
    const issues = validateDatabaseModel(model);
    return result({ ok: !issues.some((issue) => issue.severity === "error"), issues });
  });

  server.registerTool("generate_database_code", {
    title: "生成数据库实体代码",
    description: "从数据库模型生成 DDL 或 Java JPA、MyBatis-Plus、TypeScript TypeORM、C# EF Core、Go GORM 实体代码。只返回代码，不写入项目文件。",
    inputSchema: { modelId: z.string().min(1), target: z.union([z.enum(DATABASE_CODE_TARGETS), z.literal("ddl")]) },
    annotations: readOnly,
  }, ({ modelId, target }) => {
    const model = store.getDatabaseModel(modelId);
    return model ? result(generateDatabaseCode(model, target), "代码已生成") : error(`未找到数据库模型: ${modelId}`);
  });

  server.registerTool("check_database_connection", {
    title: "检查数据库连接",
    description: "连接 SQLite、MySQL 或 PostgreSQL 并返回数据库名称与表数量。密码只用于当前调用，不保存、不审计。",
    inputSchema: { connection: databaseConnectionSchema },
    annotations: externalRead,
  }, async ({ connection }) => {
    try { return result(await checkDatabaseConnection(connection), "数据库连接成功"); }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("inspect_database_schema", {
    title: "读取真实数据库结构",
    description: "从 SQLite sqlite_master/PRAGMA 或 MySQL、PostgreSQL information_schema 读取表、字段、主键、索引、外键和注释。",
    inputSchema: { connection: databaseConnectionSchema },
    annotations: externalRead,
  }, async ({ connection }) => {
    try { return result(await inspectDatabase(connection), "数据库结构已读取"); }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("import_database_schema_as_model", {
    title: "从真实数据库创建模型",
    description: "读取 SQLite、MySQL 或 PostgreSQL 的完整结构，并在指定项目下创建可视化 ER 模型。",
    inputSchema: { projectRef: z.string().min(1), name: z.string().trim().min(1).max(200), connection: databaseConnectionSchema, actor: z.string().max(100).optional() },
    annotations: externalWrite,
  }, async ({ projectRef, name, connection, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    if (store.listDatabaseModels(project.id).some((model) => model.name.toLowerCase() === name.toLowerCase())) return error("当前项目已存在同名数据库模型");
    try {
      const snapshot = await inspectDatabase(connection);
      const errors = validateDatabaseModel({ name, dialect: snapshot.dialect, tables: snapshot.tables, relations: snapshot.relations }).filter((issue) => issue.severity === "error");
      if (errors.length) return error(errors.map((issue) => issue.message).join("; "));
      const model = store.insertDatabaseModel({ projectId: project.id, name, dialect: snapshot.dialect, tables: snapshot.tables, relations: snapshot.relations });
      audit(store, actor, model, "reverse_import", null, { ...summary(model), target: databaseConnectionLabel(connection) });
      return result(model, "数据库结构已创建为 ER 模型");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("preview_database_reverse", {
    title: "预览数据库反向工程",
    description: "比较真实数据库和现有 ER 模型，返回导入后将新增、删除或变更的表、字段、索引与关系，不修改模型。",
    inputSchema: { modelId: z.string().min(1), connection: databaseConnectionSchema },
    annotations: externalRead,
  }, async ({ modelId, connection }) => {
    const model = store.getDatabaseModel(modelId);
    if (!model) return error(`未找到数据库模型: ${modelId}`);
    try { return result(await previewDatabaseReverse(model, connection), "反向工程差异已生成"); }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("reverse_database_into_model", {
    title: "反向导入数据库模型",
    description: "重新读取真实数据库并覆盖现有 ER 模型的表、字段、索引和关系。必须用当前模型名称确认。",
    inputSchema: { modelId: z.string().min(1), connection: databaseConnectionSchema, confirmation: z.string().min(1), expectedUpdatedAt: z.string().optional(), actor: z.string().max(100).optional() },
    annotations: externalWrite,
  }, async ({ modelId, connection, confirmation, expectedUpdatedAt, actor }) => {
    const before = store.getDatabaseModel(modelId);
    if (!before) return error(`未找到数据库模型: ${modelId}`);
    if (confirmation !== before.name) return error(`必须提供 confirmation="${before.name}"`);
    if (expectedUpdatedAt && expectedUpdatedAt !== before.updatedAt) return error(`数据库模型已被其他操作修改；当前 updatedAt=${before.updatedAt}`);
    try {
      const snapshot = await inspectDatabase(connection);
      const next = snapshotToModel(before, snapshot);
      const errors = validateDatabaseModel(next).filter((issue) => issue.severity === "error");
      if (errors.length) return error(errors.map((issue) => issue.message).join("; "));
      const updated = store.updateDatabaseModel(modelId, next);
      if (!updated) return error(`未找到数据库模型: ${modelId}`);
      audit(store, actor, updated, "reverse_import", summary(before), { ...summary(updated), target: databaseConnectionLabel(connection) });
      return result(updated, "真实数据库结构已导入模型");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("preview_database_deploy", {
    title: "预览数据库部署",
    description: "比较 ER 模型和真实数据库，返回可执行建表 DDL、结构差异和阻塞原因，不写入数据库。",
    inputSchema: { modelId: z.string().min(1), connection: databaseConnectionSchema },
    annotations: externalRead,
  }, async ({ modelId, connection }) => {
    const model = store.getDatabaseModel(modelId);
    if (!model) return error(`未找到数据库模型: ${modelId}`);
    try { return result(await previewDatabaseDeploy(model, connection), "数据库部署预览已生成"); }
    catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("deploy_database_model", {
    title: "部署模型到真实数据库",
    description: "把模型中缺失的数据表建到 SQLite、MySQL 或 PostgreSQL。不会自动修改或删除已有同名表，必须用模型名称确认。",
    inputSchema: { modelId: z.string().min(1), connection: databaseConnectionSchema, confirmation: z.string().min(1), actor: z.string().max(100).optional() },
    annotations: externalWrite,
  }, async ({ modelId, connection, confirmation, actor }) => {
    const model = store.getDatabaseModel(modelId);
    if (!model) return error(`未找到数据库模型: ${modelId}`);
    if (confirmation !== model.name) return error(`必须提供 confirmation="${model.name}"`);
    try {
      const deployed = await deployDatabaseModel(model, connection);
      audit(store, actor, model, "deploy", summary(model), { ...deployed, target: databaseConnectionLabel(connection) });
      return result(deployed, "数据库建表已执行");
    } catch (cause) { return error(cause instanceof Error ? cause.message : String(cause)); }
  });

  server.registerTool("list_node_database_bindings", {
    title: "列出节点数据库表关联",
    description: "分页查询功能节点与数据库物理表的关联，可按项目、画布、节点或数据库模型筛选。关联即使失效也会返回。",
    inputSchema: {
      projectRef: z.string().optional(), diagramId: z.string().optional(), diagramNodeId: z.string().optional(), databaseModelId: z.string().optional(),
      offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  }, ({ projectRef, diagramId, diagramNodeId, databaseModelId, offset, limit }) => {
    const project = projectRef ? projectByRef(store, projectRef) : undefined;
    if (projectRef && !project) return error(`未找到项目: ${projectRef}`);
    const bindings = store.listNodeDatabaseBindings({ projectId: project?.id, diagramId, diagramNodeId, databaseModelId });
    const items = bindings.slice(offset, offset + limit);
    const resolvedItems = items.map((binding) => {
      const model = store.getDatabaseModel(binding.databaseModelId);
      const tableExists = model?.tables.some((table) => table.name.toLocaleLowerCase() === binding.tableName.toLocaleLowerCase()) ?? false;
      return { ...binding, status: model && tableExists ? "valid" : "stale", databaseModelName: model?.name ?? null };
    });
    return result({ total: bindings.length, count: items.length, offset, hasMore: offset + items.length < bindings.length, nextOffset: offset + items.length < bindings.length ? offset + items.length : null, items: resolvedItems });
  });

  server.registerTool("create_node_database_binding", {
    title: "关联节点与数据库表",
    description: "把一个画布功能节点关联到同项目数据库模型中的物理表，并记录查询、新增、修改、删除操作与使用说明。",
    inputSchema: {
      projectRef: z.string().min(1), diagramId: z.string().min(1), diagramNodeId: z.string().min(1), databaseModelId: z.string().min(1),
      schemaName: z.string().trim().max(128).default(""), tableName: z.string().trim().min(1).max(128),
      operations: z.array(z.enum(NODE_DATABASE_OPERATIONS)).min(1).max(NODE_DATABASE_OPERATIONS.length), purpose: z.string().trim().max(2000).default(""), actor: z.string().max(100).optional(),
    },
    annotations: write,
  }, ({ projectRef, diagramId, diagramNodeId, databaseModelId, schemaName, tableName, operations, purpose, actor }) => {
    const project = projectByRef(store, projectRef);
    if (!project) return error(`未找到项目: ${projectRef}`);
    const input = { projectId: project.id, diagramId, diagramNodeId, databaseModelId, schemaName, tableName, operations: [...new Set(operations)], purpose };
    const targetError = bindingTargetError(store, input);
    if (targetError) return error(targetError);
    const binding = store.insertNodeDatabaseBinding(input);
    auditBinding(store, actor, binding, "create", null, bindingSummary(binding));
    return result(binding, "节点数据库表关联已创建");
  });

  server.registerTool("update_node_database_binding", {
    title: "更新节点数据库表关联",
    description: "修改已有关联的数据库模型、物理表、CRUD 操作或使用说明，并使用 expectedUpdatedAt 防止覆盖并发修改。",
    inputSchema: {
      bindingId: z.string().min(1), expectedUpdatedAt: z.string().optional(), databaseModelId: z.string().min(1).optional(), schemaName: z.string().trim().max(128).optional(),
      tableName: z.string().trim().min(1).max(128).optional(), operations: z.array(z.enum(NODE_DATABASE_OPERATIONS)).min(1).max(NODE_DATABASE_OPERATIONS.length).optional(),
      purpose: z.string().trim().max(2000).optional(), actor: z.string().max(100).optional(),
    },
    annotations: { ...write, idempotentHint: true },
  }, ({ bindingId, expectedUpdatedAt, databaseModelId, schemaName, tableName, operations, purpose, actor }) => {
    const before = store.getNodeDatabaseBinding(bindingId);
    if (!before) return error(`未找到节点数据库表关联: ${bindingId}`);
    if (expectedUpdatedAt && expectedUpdatedAt !== before.updatedAt) return error(`数据库表关联已被其他操作修改；当前 updatedAt=${before.updatedAt}`);
    const next: NodeDatabaseBinding = {
      ...before,
      ...(databaseModelId !== undefined ? { databaseModelId } : {}),
      ...(schemaName !== undefined ? { schemaName } : {}),
      ...(tableName !== undefined ? { tableName } : {}),
      ...(operations !== undefined ? { operations: [...new Set(operations)] } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
    };
    const targetError = bindingTargetError(store, next, bindingId);
    if (targetError) return error(targetError);
    const binding = store.updateNodeDatabaseBinding(bindingId, next);
    if (!binding) return error(`未找到节点数据库表关联: ${bindingId}`);
    auditBinding(store, actor, binding, "update", bindingSummary(before), bindingSummary(binding));
    return result(binding, "节点数据库表关联已更新");
  });

  server.registerTool("delete_node_database_binding", {
    title: "解除节点数据库表关联",
    description: "永久解除指定节点与数据库表的关联，必须显式提供 confirm=true。不会删除数据库模型或表。",
    inputSchema: { bindingId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ bindingId, confirm, actor }) => {
    if (!confirm) return error("解除数据库表关联需要 confirm=true");
    const before = store.getNodeDatabaseBinding(bindingId);
    if (!before) return error(`未找到节点数据库表关联: ${bindingId}`);
    store.deleteNodeDatabaseBinding(bindingId);
    auditBinding(store, actor, before, "delete", bindingSummary(before), null);
    return result({ ok: true, deletedId: bindingId }, "节点数据库表关联已解除");
  });

  server.registerTool("delete_database_model", {
    title: "删除数据库模型",
    description: "永久删除指定数据库模型，必须显式提供 confirm=true。",
    inputSchema: { modelId: z.string().min(1), confirm: z.boolean().default(false), actor: z.string().max(100).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ modelId, confirm, actor }) => {
    if (!confirm) return error("删除数据库模型需要 confirm=true");
    const before = store.getDatabaseModel(modelId);
    if (!before) return error(`未找到数据库模型: ${modelId}`);
    store.deleteDatabaseModel(modelId);
    audit(store, actor, before, "delete", summary(before), null);
    return result({ ok: true, deletedId: modelId }, "数据库模型已删除");
  });
}

export const databaseTableInputSchema = databaseTableSchema;
export const databaseFieldInputSchema = databaseFieldSchema;
export const databaseIndexInputSchema = databaseIndexSchema;
