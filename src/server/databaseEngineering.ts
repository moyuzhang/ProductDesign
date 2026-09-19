import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { Client } from "pg";
import { generateDatabaseDdl } from "../shared/databaseModel.js";
import type {
  DatabaseConnectionCheck,
  DatabaseConnectionInput,
  DatabaseDataType,
  DatabaseDeployPreview,
  DatabaseDeployResult,
  DatabaseDialect,
  DatabaseField,
  DatabaseIndex,
  DatabaseModel,
  DatabaseRelation,
  DatabaseReversePreview,
  DatabaseSchemaChange,
  DatabaseSchemaSnapshot,
  DatabaseTable,
} from "../shared/types.js";

type TypeDetails = Pick<DatabaseField, "type" | "length" | "precision" | "scale">;

function id(): string {
  return randomUUID();
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function typeDetails(nativeType: string, length?: unknown, precision?: unknown, scale?: unknown): TypeDetails {
  const normalized = nativeType.toLowerCase();
  const match = normalized.match(/\((\d+)(?:\s*,\s*(\d+))?\)/);
  const nativeLength = numberOrUndefined(length) ?? numberOrUndefined(match?.[1]);
  const nativePrecision = numberOrUndefined(precision) ?? numberOrUndefined(match?.[1]);
  const nativeScale = numberOrUndefined(scale) ?? numberOrUndefined(match?.[2]);
  let type: DatabaseDataType = "text";
  if (normalized.includes("uuid")) type = "uuid";
  else if (normalized.includes("json")) type = "json";
  else if (normalized.includes("blob") || normalized.includes("binary") || normalized.includes("bytea")) type = "binary";
  else if (normalized.includes("timestamp") || normalized.includes("datetime")) type = "datetime";
  else if (normalized === "date") type = "date";
  else if (normalized.startsWith("time")) type = "time";
  else if (normalized.includes("bool") || normalized === "tinyint(1)") type = "boolean";
  else if (normalized.includes("bigint") || normalized.includes("int8")) type = "bigint";
  else if (normalized.includes("int") || normalized.includes("serial")) type = "integer";
  else if (/(decimal|numeric|real|double|float|money)/.test(normalized)) type = "decimal";
  else if (/(char|varchar|string)/.test(normalized)) type = "string";
  else if (/(text|clob)/.test(normalized)) type = "text";
  return {
    type,
    ...(type === "string" && nativeLength ? { length: Math.min(65_535, nativeLength) } : {}),
    ...(type === "decimal" && nativePrecision ? { precision: Math.min(65, nativePrecision) } : {}),
    ...(type === "decimal" && nativeScale !== undefined ? { scale: Math.min(30, nativeScale) } : {}),
  };
}

function position(index: number, total: number): { x: number; y: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(total)));
  return { x: 80 + (index % columns) * 360, y: 80 + Math.floor(index / columns) * 340 };
}

function normalizeDeleteRule(value: unknown): DatabaseRelation["onDelete"] {
  const rule = String(value ?? "NO ACTION").toUpperCase();
  return rule === "CASCADE" || rule === "SET NULL" || rule === "RESTRICT" ? rule : "NO ACTION";
}

function mysqlDefault(value: unknown, nativeType: string): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(text) || /^(null|true|false|current_timestamp(?:\(\))?)$/i.test(text) || /\w+\(.*\)/.test(text)) return text;
  if (/(int|decimal|numeric|float|double|bit|bool)/i.test(nativeType)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function connectionPort(connection: DatabaseConnectionInput): number {
  return connection.port ?? (connection.dialect === "mysql" ? 3306 : 5432);
}

export function databaseConnectionLabel(connection: DatabaseConnectionInput): string {
  if (connection.dialect === "sqlite") return `SQLite · ${resolve(connection.filePath ?? "")}`;
  return `${connection.dialect === "mysql" ? "MySQL" : "PostgreSQL"} · ${connection.host}:${connectionPort(connection)}/${connection.database}`;
}

async function inspectSqlite(connection: DatabaseConnectionInput, allowMissing: boolean): Promise<DatabaseSchemaSnapshot> {
  const filePath = resolve(connection.filePath ?? "");
  if (!existsSync(filePath)) {
    if (allowMissing) return { dialect: "sqlite", databaseName: basename(filePath), tables: [], relations: [] };
    throw new Error(`SQLite 文件不存在: ${filePath}`);
  }
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const master = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string | null }>;
    const tables: DatabaseTable[] = master.map((entry, index) => {
      const escaped = entry.name.replace(/'/g, "''");
      const columnRows = db.prepare(`PRAGMA table_xinfo('${escaped}')`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
      const indexRows = db.prepare(`PRAGMA index_list('${escaped}')`).all() as Array<{ name: string; unique: number; origin: string }>;
      const indexColumns = new Map<string, string[]>();
      for (const item of indexRows) {
        const indexName = item.name.replace(/'/g, "''");
        const names = (db.prepare(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>).map((row) => row.name);
        indexColumns.set(item.name, names);
      }
      const singleUnique = new Set(indexRows.filter((item) => item.unique === 1 && (indexColumns.get(item.name)?.length ?? 0) === 1).map((item) => indexColumns.get(item.name)![0]));
      const fields = columnRows.map((row) => ({
        id: id(), name: row.name, ...typeDetails(row.type || "TEXT"), nullable: row.notnull === 0 && row.pk === 0,
        primaryKey: row.pk > 0, autoIncrement: row.pk > 0 && /\bAUTOINCREMENT\b/i.test(entry.sql ?? ""), unique: singleUnique.has(row.name),
        defaultValue: row.dflt_value === null || row.dflt_value === undefined ? "" : String(row.dflt_value), comment: "",
      }));
      const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
      const indexes: DatabaseIndex[] = indexRows.filter((item) => item.origin !== "pk" && !item.name.startsWith("sqlite_autoindex_")).map((item) => ({
        id: id(), name: item.name, unique: item.unique === 1,
        fieldIds: (indexColumns.get(item.name) ?? []).map((name) => fieldByName.get(name)).filter((fieldId): fieldId is string => Boolean(fieldId)),
      })).filter((item) => item.fieldIds.length > 0);
      return { id: id(), name: entry.name, displayName: "", comment: "", ...position(index, master.length), fields, indexes };
    });
    const tableByName = new Map(tables.map((table) => [table.name, table]));
    const relations: DatabaseRelation[] = [];
    for (const table of tables) {
      const escaped = table.name.replace(/'/g, "''");
      const rows = db.prepare(`PRAGMA foreign_key_list('${escaped}')`).all() as Array<{ id: number; seq: number; table: string; from: string; to: string; on_delete: string }>;
      for (const row of rows) {
        const target = tableByName.get(row.table);
        const sourceField = table.fields.find((field) => field.name === row.from);
        const targetField = target?.fields.find((field) => field.name === row.to) ?? target?.fields.find((field) => field.primaryKey);
        if (!target || !sourceField || !targetField) continue;
        relations.push({ id: id(), name: `fk_${table.name}_${row.id}_${row.seq}`, type: sourceField.unique ? "one-to-one" : "one-to-many", sourceTableId: table.id, sourceFieldId: sourceField.id, targetTableId: target.id, targetFieldId: targetField.id, onDelete: normalizeDeleteRule(row.on_delete) });
      }
    }
    return { dialect: "sqlite", databaseName: basename(filePath), tables, relations };
  } finally {
    db.close();
  }
}

async function inspectMysql(connection: DatabaseConnectionInput): Promise<DatabaseSchemaSnapshot> {
  const client = await createConnection({
    host: connection.host, port: connectionPort(connection), user: connection.username, password: connection.password,
    database: connection.database, ssl: connection.ssl ? {} : undefined, connectTimeout: 7000,
  });
  try {
    const [tableRows] = await client.query<RowDataPacket[]>("SELECT TABLE_NAME AS tableName, TABLE_COMMENT AS tableComment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [connection.database]);
    const [columnRows] = await client.query<RowDataPacket[]>("SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, DATA_TYPE AS dataType, IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey, EXTRA AS extra, COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment, CHARACTER_MAXIMUM_LENGTH AS charLength, NUMERIC_PRECISION AS numericPrecision, NUMERIC_SCALE AS numericScale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [connection.database]);
    const [indexRows] = await client.query<RowDataPacket[]>("SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName, SEQ_IN_INDEX AS sequenceInIndex FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME <> 'PRIMARY' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX", [connection.database]);
    const [foreignRows] = await client.query<RowDataPacket[]>("SELECT k.TABLE_NAME AS sourceTable, k.COLUMN_NAME AS sourceColumn, k.REFERENCED_TABLE_NAME AS targetTable, k.REFERENCED_COLUMN_NAME AS targetColumn, k.CONSTRAINT_NAME AS constraintName, r.DELETE_RULE AS deleteRule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION", [connection.database]);
    const groupedIndexes = new Map<string, RowDataPacket[]>();
    for (const row of indexRows) {
      const key = `${row.tableName}\0${row.indexName}`;
      groupedIndexes.set(key, [...(groupedIndexes.get(key) ?? []), row]);
    }
    const tables: DatabaseTable[] = tableRows.map((entry, index) => {
      const rows = columnRows.filter((row) => row.tableName === entry.tableName);
      const uniqueColumns = new Set(Array.from(groupedIndexes.values()).filter((items) => items.length === 1 && Number(items[0].nonUnique) === 0).map((items) => String(items[0].columnName)));
      const fields = rows.map((row) => ({
        id: id(), name: String(row.columnName), ...typeDetails(String(row.columnType), row.charLength, row.numericPrecision, row.numericScale),
        nullable: row.isNullable === "YES", primaryKey: row.columnKey === "PRI", autoIncrement: String(row.extra).includes("auto_increment"),
        unique: row.columnKey === "UNI" || uniqueColumns.has(String(row.columnName)), defaultValue: mysqlDefault(row.columnDefault, String(row.dataType)), comment: String(row.columnComment ?? ""),
      }));
      const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
      const indexes = Array.from(groupedIndexes.entries()).filter(([key]) => key.startsWith(`${entry.tableName}\0`)).map(([, items]) => ({
        id: id(), name: String(items[0].indexName), unique: Number(items[0].nonUnique) === 0,
        fieldIds: items.sort((a, b) => Number(a.sequenceInIndex) - Number(b.sequenceInIndex)).map((row) => fieldByName.get(String(row.columnName))).filter((fieldId): fieldId is string => Boolean(fieldId)),
      })).filter((item) => item.fieldIds.length > 0);
      return { id: id(), name: String(entry.tableName), displayName: "", comment: String(entry.tableComment ?? ""), ...position(index, tableRows.length), fields, indexes };
    });
    return { dialect: "mysql", databaseName: connection.database ?? "", tables, relations: relationsFromRows(tables, foreignRows) };
  } finally {
    await client.end();
  }
}

function relationsFromRows(tables: DatabaseTable[], rows: Array<Record<string, unknown>>): DatabaseRelation[] {
  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const relations: DatabaseRelation[] = [];
  for (const row of rows) {
    const source = tableByName.get(String(row.sourceTable));
    const target = tableByName.get(String(row.targetTable));
    const sourceField = source?.fields.find((field) => field.name === row.sourceColumn);
    const targetField = target?.fields.find((field) => field.name === row.targetColumn);
    if (!source || !target || !sourceField || !targetField) continue;
    relations.push({ id: id(), name: String(row.constraintName ?? ""), type: sourceField.unique ? "one-to-one" : "one-to-many", sourceTableId: source.id, sourceFieldId: sourceField.id, targetTableId: target.id, targetFieldId: targetField.id, onDelete: normalizeDeleteRule(row.deleteRule) });
  }
  return relations;
}

async function inspectPostgresql(connection: DatabaseConnectionInput): Promise<DatabaseSchemaSnapshot> {
  const schema = connection.schema || "public";
  const client = new Client({ host: connection.host, port: connectionPort(connection), database: connection.database, user: connection.username, password: connection.password, ssl: connection.ssl ? {} : undefined, connectionTimeoutMillis: 7000 });
  await client.connect();
  try {
    const tableRows = (await client.query("SELECT c.relname AS \"tableName\", COALESCE(obj_description(c.oid, 'pg_class'), '') AS \"tableComment\" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname = $1 ORDER BY c.relname", [schema])).rows as Array<Record<string, unknown>>;
    const columnRows = (await client.query("SELECT c.table_name AS \"tableName\", c.column_name AS \"columnName\", c.data_type AS \"dataType\", c.udt_name AS \"udtName\", c.is_nullable AS \"isNullable\", c.column_default AS \"columnDefault\", c.character_maximum_length AS \"charLength\", c.numeric_precision AS \"numericPrecision\", c.numeric_scale AS \"numericScale\", c.is_identity AS \"isIdentity\", COALESCE(pgd.description, '') AS \"columnComment\" FROM information_schema.columns c JOIN pg_catalog.pg_class pc ON pc.relname = c.table_name JOIN pg_catalog.pg_namespace pn ON pn.oid = pc.relnamespace AND pn.nspname = c.table_schema JOIN pg_catalog.pg_attribute pa ON pa.attrelid = pc.oid AND pa.attname = c.column_name LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = pc.oid AND pgd.objsubid = pa.attnum WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position", [schema])).rows as Array<Record<string, unknown>>;
    const primaryRows = (await client.query("SELECT kcu.table_name AS \"tableName\", kcu.column_name AS \"columnName\" FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1", [schema])).rows as Array<Record<string, unknown>>;
    const indexRows = (await client.query("SELECT t.relname AS \"tableName\", i.relname AS \"indexName\", ix.indisunique AS \"isUnique\", array_agg(a.attname ORDER BY ord.ordinality) AS \"fieldNames\" FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_index ix ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ord.attnum WHERE n.nspname = $1 AND NOT ix.indisprimary GROUP BY t.relname, i.relname, ix.indisunique ORDER BY t.relname, i.relname", [schema])).rows as Array<Record<string, unknown>>;
    const foreignRows = (await client.query("SELECT src.relname AS \"sourceTable\", sa.attname AS \"sourceColumn\", tgt.relname AS \"targetTable\", ta.attname AS \"targetColumn\", con.conname AS \"constraintName\", CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS \"deleteRule\" FROM pg_constraint con JOIN pg_class src ON src.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = src.relnamespace JOIN pg_class tgt ON tgt.oid = con.confrelid CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tk(attnum, ord) ON tk.ord = sk.ord JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = sk.attnum JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = tk.attnum WHERE con.contype = 'f' AND ns.nspname = $1 ORDER BY src.relname, con.conname, sk.ord", [schema])).rows as Array<Record<string, unknown>>;
    const primary = new Set(primaryRows.map((row) => `${row.tableName}\0${row.columnName}`));
    const tables: DatabaseTable[] = tableRows.map((entry, index) => {
      const rows = columnRows.filter((row) => row.tableName === entry.tableName);
      const uniqueColumns = new Set(indexRows.filter((row) => row.isUnique && Array.isArray(row.fieldNames) && row.fieldNames.length === 1).map((row) => String((row.fieldNames as unknown[])[0])));
      const fields = rows.map((row) => {
        const nativeType = String(row.dataType === "USER-DEFINED" ? row.udtName : row.dataType);
        const defaultValue = String(row.columnDefault ?? "");
        return {
          id: id(), name: String(row.columnName), ...typeDetails(nativeType, row.charLength, row.numericPrecision, row.numericScale), nullable: row.isNullable === "YES",
          primaryKey: primary.has(`${row.tableName}\0${row.columnName}`), autoIncrement: row.isIdentity === "YES" || /^nextval\(/.test(defaultValue), unique: uniqueColumns.has(String(row.columnName)),
          defaultValue: /^nextval\(/.test(defaultValue) ? "" : defaultValue, comment: String(row.columnComment ?? ""),
        };
      });
      const fieldByName = new Map(fields.map((field) => [field.name, field.id]));
      const indexes = indexRows.filter((row) => row.tableName === entry.tableName).map((row) => ({ id: id(), name: String(row.indexName), unique: Boolean(row.isUnique), fieldIds: (Array.isArray(row.fieldNames) ? row.fieldNames : []).map((name) => fieldByName.get(String(name))).filter((fieldId): fieldId is string => Boolean(fieldId)) })).filter((item) => item.fieldIds.length > 0);
      return { id: id(), name: String(entry.tableName), displayName: "", comment: String(entry.tableComment ?? ""), ...position(index, tableRows.length), fields, indexes };
    });
    return { dialect: "postgresql", databaseName: `${connection.database ?? ""}.${schema}`, tables, relations: relationsFromRows(tables, foreignRows) };
  } finally {
    await client.end();
  }
}

export async function inspectDatabase(connection: DatabaseConnectionInput, allowMissingSqlite = false): Promise<DatabaseSchemaSnapshot> {
  if (connection.dialect === "sqlite") return inspectSqlite(connection, allowMissingSqlite);
  if (connection.dialect === "mysql") return inspectMysql(connection);
  return inspectPostgresql(connection);
}

function fieldSignature(field: DatabaseField): string {
  return JSON.stringify([field.type, field.length ?? null, field.precision ?? null, field.scale ?? null, field.nullable, field.primaryKey, field.autoIncrement, field.unique, field.defaultValue.trim()]);
}

function indexSignature(index: DatabaseIndex, table: DatabaseTable): string {
  const names = index.fieldIds.map((fieldId) => table.fields.find((field) => field.id === fieldId)?.name.toLowerCase() ?? "?");
  return JSON.stringify([index.unique, names]);
}

function relationKey(relation: DatabaseRelation, tables: DatabaseTable[]): string {
  const source = tables.find((table) => table.id === relation.sourceTableId);
  const target = tables.find((table) => table.id === relation.targetTableId);
  const sourceField = source?.fields.find((field) => field.id === relation.sourceFieldId);
  const targetField = target?.fields.find((field) => field.id === relation.targetFieldId);
  return `${source?.name}.${sourceField?.name}->${target?.name}.${targetField?.name}`.toLowerCase();
}

export function diffDatabaseSchemas(desired: Pick<DatabaseModel, "tables" | "relations"> | DatabaseSchemaSnapshot, actual: Pick<DatabaseModel, "tables" | "relations"> | DatabaseSchemaSnapshot): DatabaseSchemaChange[] {
  const changes: DatabaseSchemaChange[] = [];
  const desiredTables = new Map(desired.tables.map((table) => [table.name.toLowerCase(), table]));
  const actualTables = new Map(actual.tables.map((table) => [table.name.toLowerCase(), table]));
  for (const [name, table] of desiredTables) {
    const current = actualTables.get(name);
    if (!current) { changes.push({ kind: "add", objectKind: "table", path: table.name, detail: "新增数据表", destructive: false }); continue; }
    const desiredFields = new Map(table.fields.map((field) => [field.name.toLowerCase(), field]));
    const actualFields = new Map(current.fields.map((field) => [field.name.toLowerCase(), field]));
    for (const [fieldName, field] of desiredFields) {
      const currentField = actualFields.get(fieldName);
      if (!currentField) changes.push({ kind: "add", objectKind: "field", path: `${table.name}.${field.name}`, detail: "新增字段", destructive: false });
      else if (fieldSignature(field) !== fieldSignature(currentField)) changes.push({ kind: "change", objectKind: "field", path: `${table.name}.${field.name}`, detail: "字段类型或约束发生变化", destructive: true });
      else if (field.comment.trim() !== currentField.comment.trim()) changes.push({ kind: "change", objectKind: "field", path: `${table.name}.${field.name}`, detail: "字段备注发生变化", destructive: false });
    }
    for (const [fieldName, field] of actualFields) if (!desiredFields.has(fieldName)) changes.push({ kind: "remove", objectKind: "field", path: `${table.name}.${field.name}`, detail: "目标结构中不存在该字段", destructive: true });
    const desiredIndexes = new Map(table.indexes.map((index) => [index.name.toLowerCase(), index]));
    const actualIndexes = new Map(current.indexes.map((index) => [index.name.toLowerCase(), index]));
    for (const [indexName, index] of desiredIndexes) {
      const currentIndex = actualIndexes.get(indexName);
      if (!currentIndex) changes.push({ kind: "add", objectKind: "index", path: `${table.name}.${index.name}`, detail: "新增索引", destructive: false });
      else if (indexSignature(index, table) !== indexSignature(currentIndex, current)) changes.push({ kind: "change", objectKind: "index", path: `${table.name}.${index.name}`, detail: "索引字段或唯一性发生变化", destructive: true });
    }
    for (const [indexName, index] of actualIndexes) if (!desiredIndexes.has(indexName)) changes.push({ kind: "remove", objectKind: "index", path: `${table.name}.${index.name}`, detail: "目标结构中不存在该索引", destructive: true });
  }
  for (const [name, table] of actualTables) if (!desiredTables.has(name)) changes.push({ kind: "remove", objectKind: "table", path: table.name, detail: "目标结构中不存在该表", destructive: true });
  const desiredRelations = new Map(desired.relations.map((relation) => [relationKey(relation, desired.tables), relation]));
  const actualRelations = new Map(actual.relations.map((relation) => [relationKey(relation, actual.tables), relation]));
  for (const [key, relation] of desiredRelations) {
    const current = actualRelations.get(key);
    if (!current) changes.push({ kind: "add", objectKind: "relation", path: key, detail: "新增外键关系", destructive: false });
    else if (relation.onDelete !== current.onDelete || relation.type !== current.type) changes.push({ kind: "change", objectKind: "relation", path: key, detail: "关系类型或删除规则发生变化", destructive: true });
  }
  for (const [key] of actualRelations) if (!desiredRelations.has(key)) changes.push({ kind: "remove", objectKind: "relation", path: key, detail: "目标结构中不存在该关系", destructive: true });
  return changes;
}

export function snapshotToModel(model: DatabaseModel, snapshot: DatabaseSchemaSnapshot): DatabaseModel {
  const positions = new Map(model.tables.map((table) => [table.name.toLowerCase(), { x: table.x, y: table.y }]));
  return {
    ...model,
    dialect: snapshot.dialect,
    tables: snapshot.tables.map((table, index) => ({ ...table, ...(positions.get(table.name.toLowerCase()) ?? position(index, snapshot.tables.length)) })),
    relations: snapshot.relations,
  };
}

export async function checkDatabaseConnection(connection: DatabaseConnectionInput): Promise<DatabaseConnectionCheck> {
  const snapshot = await inspectDatabase(connection);
  return { ok: true, target: databaseConnectionLabel(connection), dialect: snapshot.dialect, databaseName: snapshot.databaseName, tableCount: snapshot.tables.length };
}

export async function previewDatabaseReverse(model: Pick<DatabaseModel, "tables" | "relations">, connection: DatabaseConnectionInput): Promise<DatabaseReversePreview> {
  const snapshot = await inspectDatabase(connection);
  return { target: databaseConnectionLabel(connection), snapshot, changes: diffDatabaseSchemas(snapshot, model) };
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (!quote && char === "-" && next === "-") { lineComment = true; index += 1; continue; }
    if (!quote && char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === ";") {
      const statement = sql.slice(start, index + 1).trim();
      if (statement.replace(/^(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, "").trim()) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail && tail.replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/, "").trim()) statements.push(tail);
  return statements;
}

export async function previewDatabaseDeploy(model: DatabaseModel, connection: DatabaseConnectionInput): Promise<DatabaseDeployPreview> {
  if (model.dialect !== connection.dialect) throw new Error(`模型方言为 ${model.dialect}，目标连接为 ${connection.dialect}，禁止跨方言直接部署`);
  const actual = await inspectDatabase(connection, true);
  const changes = diffDatabaseSchemas(model, actual);
  const actualNames = new Set(actual.tables.map((table) => table.name.toLowerCase()));
  const missingNames = new Set(model.tables.filter((table) => !actualNames.has(table.name.toLowerCase())).map((table) => table.name.toLowerCase()));
  const blockingReasons = changes.filter((change) => change.objectKind !== "table" && change.kind !== "add" && actualNames.has(change.path.split(".")[0].toLowerCase())).map((change) => `${change.path}: ${change.detail}`);
  for (const table of model.tables) {
    if (!actualNames.has(table.name.toLowerCase())) continue;
    const tableChanges = changes.filter((change) => change.path === table.name || change.path.startsWith(`${table.name}.`) || change.path.startsWith(`${table.name.toLowerCase()}.`));
    if (tableChanges.length && !blockingReasons.some((reason) => reason.startsWith(`${table.name}:`) || reason.startsWith(`${table.name}.`))) blockingReasons.push(`${table.name}: 已有同名表且结构不同`);
  }
  const ddl = missingNames.size ? generateDatabaseDdl(model, missingNames).code : "";
  const statements = splitSqlStatements(ddl);
  return { target: databaseConnectionLabel(connection), ddl, statements, changes, createTableCount: missingNames.size, canApply: blockingReasons.length === 0, blockingReasons };
}

async function executeStatements(connection: DatabaseConnectionInput, statements: string[]): Promise<void> {
  if (connection.dialect === "sqlite") {
    const db = new Database(resolve(connection.filePath ?? ""));
    try {
      db.pragma("foreign_keys = ON");
      db.transaction(() => { for (const statement of statements) db.exec(statement); })();
    } finally { db.close(); }
    return;
  }
  if (connection.dialect === "mysql") {
    const client = await createConnection({ host: connection.host, port: connectionPort(connection), user: connection.username, password: connection.password, database: connection.database, ssl: connection.ssl ? {} : undefined, connectTimeout: 7000 });
    try {
      await client.beginTransaction();
      for (const statement of statements) await client.query(statement);
      await client.commit();
    } catch (cause) { await client.rollback(); throw cause; } finally { await client.end(); }
    return;
  }
  const client = new Client({ host: connection.host, port: connectionPort(connection), database: connection.database, user: connection.username, password: connection.password, ssl: connection.ssl ? {} : undefined, connectionTimeoutMillis: 7000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK"); throw cause; } finally { await client.end(); }
}

export async function deployDatabaseModel(model: DatabaseModel, connection: DatabaseConnectionInput): Promise<DatabaseDeployResult> {
  const preview = await previewDatabaseDeploy(model, connection);
  if (!preview.canApply) throw new Error(`目标数据库存在结构冲突：${preview.blockingReasons.join("；")}`);
  if (!preview.statements.length) throw new Error("目标数据库已经包含当前模型，没有需要执行的建表语句");
  await executeStatements(connection, preview.statements);
  return { ok: true, target: preview.target, executedStatements: preview.statements.length, executedAt: new Date().toISOString() };
}
