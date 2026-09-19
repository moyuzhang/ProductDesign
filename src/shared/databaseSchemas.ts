import { z } from "zod";
import {
  DATABASE_CODE_TARGETS,
  DATABASE_DATA_TYPES,
  DATABASE_DIALECTS,
  DATABASE_RELATION_TYPES,
  NODE_DATABASE_OPERATIONS,
} from "./types.js";

export const databaseFieldSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(128),
  type: z.enum(DATABASE_DATA_TYPES),
  length: z.number().int().min(1).max(65_535).optional(),
  precision: z.number().int().min(1).max(65).optional(),
  scale: z.number().int().min(0).max(30).optional(),
  nullable: z.boolean().default(true),
  primaryKey: z.boolean().default(false),
  autoIncrement: z.boolean().default(false),
  unique: z.boolean().default(false),
  defaultValue: z.string().max(500).default(""),
  comment: z.string().max(1000).default(""),
}).strict();

export const databaseIndexSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(128),
  fieldIds: z.array(z.string().min(1)).min(1).max(32),
  unique: z.boolean().default(false),
}).strict();

export const databaseTableSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(128),
  displayName: z.string().max(200).default(""),
  comment: z.string().max(2000).default(""),
  x: z.number().finite(),
  y: z.number().finite(),
  fields: z.array(databaseFieldSchema).max(500),
  indexes: z.array(databaseIndexSchema).max(100).default([]),
}).strict();

export const databaseRelationSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(128).default(""),
  type: z.enum(DATABASE_RELATION_TYPES),
  sourceTableId: z.string().min(1),
  sourceFieldId: z.string().min(1),
  targetTableId: z.string().min(1),
  targetFieldId: z.string().min(1),
  onDelete: z.enum(["NO ACTION", "CASCADE", "SET NULL", "RESTRICT"] as const).default("NO ACTION"),
}).strict();

export const databaseModelCreateSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  dialect: z.enum(DATABASE_DIALECTS).default("mysql"),
  tables: z.array(databaseTableSchema).max(1000).default([]),
  relations: z.array(databaseRelationSchema).max(5000).default([]),
  actor: z.string().max(100).optional(),
  source: z.enum(["web", "mcp", "system"] as const).optional(),
}).strict();

export const databaseModelPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  dialect: z.enum(DATABASE_DIALECTS).optional(),
  tables: z.array(databaseTableSchema).max(1000).optional(),
  relations: z.array(databaseRelationSchema).max(5000).optional(),
  expectedUpdatedAt: z.string().max(64).optional(),
  actor: z.string().max(100).optional(),
  source: z.enum(["web", "mcp", "system"] as const).optional(),
}).strict();

export const nodeDatabaseBindingCreateSchema = z.object({
  projectId: z.string().min(1),
  diagramId: z.string().min(1),
  diagramNodeId: z.string().min(1),
  databaseModelId: z.string().min(1),
  schemaName: z.string().trim().max(128).default(""),
  tableName: z.string().trim().min(1).max(128),
  operations: z.array(z.enum(NODE_DATABASE_OPERATIONS)).min(1).max(NODE_DATABASE_OPERATIONS.length),
  purpose: z.string().trim().max(2000).default(""),
  actor: z.string().max(100).optional(),
  source: z.enum(["web", "mcp", "system"] as const).optional(),
}).strict();

export const nodeDatabaseBindingPatchSchema = z.object({
  databaseModelId: z.string().min(1).optional(),
  schemaName: z.string().trim().max(128).optional(),
  tableName: z.string().trim().min(1).max(128).optional(),
  operations: z.array(z.enum(NODE_DATABASE_OPERATIONS)).min(1).max(NODE_DATABASE_OPERATIONS.length).optional(),
  purpose: z.string().trim().max(2000).optional(),
  expectedUpdatedAt: z.string().max(64).optional(),
  actor: z.string().max(100).optional(),
  source: z.enum(["web", "mcp", "system"] as const).optional(),
}).strict();

export const databaseCodeTargetSchema = z.enum(DATABASE_CODE_TARGETS);

export const databaseConnectionSchema = z.object({
  dialect: z.enum(DATABASE_DIALECTS),
  filePath: z.string().trim().min(1).max(2000).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  database: z.string().trim().min(1).max(255).optional(),
  schema: z.string().trim().min(1).max(255).optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(2000).optional(),
  ssl: z.boolean().optional(),
}).strict().superRefine((connection, context) => {
  if (connection.dialect === "sqlite") {
    if (!connection.filePath) context.addIssue({ code: "custom", path: ["filePath"], message: "SQLite 文件路径不能为空" });
    return;
  }
  if (!connection.host) context.addIssue({ code: "custom", path: ["host"], message: "数据库主机不能为空" });
  if (!connection.database) context.addIssue({ code: "custom", path: ["database"], message: "数据库名称不能为空" });
  if (!connection.username) context.addIssue({ code: "custom", path: ["username"], message: "数据库用户名不能为空" });
});
