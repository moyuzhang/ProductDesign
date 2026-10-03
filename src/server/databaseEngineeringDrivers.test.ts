// Mock-driver regression tests. Real MySQL/PostgreSQL acceptance is separate evidence.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseConnectionInput, DatabaseModel, DatabaseTable } from "../shared/types.js";

const state = vi.hoisted(() => ({
  metadata: false,
  sharedConstraint: false,
  schema: "public" as string | null,
  failSecondCreate: false,
  rollbackFails: false,
  endFails: false,
  creates: 0,
  events: [] as Array<{ sql: string; args?: unknown[] }>,
}));
vi.mock("mysql2/promise", () => ({ createConnection: vi.fn(async () => ({
  async query(sql: string, args?: unknown[]) {
    state.events.push({ sql, args });
    if (sql.includes("information_schema.TABLES")) return [state.metadata ? [{ tableName: "unique_table" }, { tableName: "plain_table" }] : []];
    if (sql.includes("information_schema.COLUMNS")) return [["unique_table", "plain_table"].filter(() => state.metadata).map(tableName => ({ tableName, columnName: "code", columnType: "varchar(40)", dataType: "varchar", isNullable: "NO", columnKey: "", extra: "", columnDefault: null, charLength: 40 }))];
    if (sql.includes("information_schema.STATISTICS")) return [state.metadata ? [{ tableName: "unique_table", indexName: "unique_code", nonUnique: 0, columnName: "code", sequenceInIndex: 1 }] : []];
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return [[]];
    if (/CREATE TABLE/.test(sql) && ++state.creates === 2 && state.failSecondCreate) throw new Error("synthetic invalid default");
    return [[]];
  },
  async beginTransaction() { state.events.push({ sql: "BEGIN" }); },
  async commit() { state.events.push({ sql: "COMMIT" }); },
  async rollback() { state.events.push({ sql: "ROLLBACK" }); if (state.rollbackFails) throw new Error("synthetic rollback failure"); },
  async end() { state.events.push({ sql: "END" }); if (state.endFails && state.creates) throw new Error("synthetic close failure"); },
})) }));
vi.mock("pg", () => ({ Client: class {
  async connect() {}
  async query(sql: string, args?: unknown[]) {
    state.events.push({ sql, args });
    if (sql.includes("SELECT c.relname")) return { rows: state.metadata ? [{ tableName: "unique_table" }, { tableName: "plain_table" }] : [] };
    if (sql.includes("information_schema.table_constraints") && state.sharedConstraint) return { rows: [{ tableName: "unique_table", columnName: "code" }, ...(sql.includes("tc.table_name = kcu.table_name") ? [] : [{ tableName: "plain_table", columnName: "code" }])] };
    if (sql.includes("information_schema.columns")) return { rows: ["unique_table", "plain_table"].filter(() => state.metadata).map(tableName => ({ tableName, columnName: "code", dataType: "character varying", isNullable: "NO", isIdentity: "NO", columnDefault: null, charLength: 40 })) };
    if (sql.includes("FROM pg_class t")) return { rows: state.metadata ? [{ tableName: "unique_table", indexName: "unique_code", isUnique: true, fieldNames: sql.includes("a.attname::text") ? ["code"] : "{code}" }] : [] };
    if (sql.includes("current_schema()")) return { rows: [{ schema: state.schema }] };
    if (/CREATE TABLE/.test(sql) && ++state.creates === 2 && state.failSecondCreate) throw new Error("synthetic invalid default");
    if (sql === "ROLLBACK" && state.rollbackFails) throw new Error("synthetic rollback failure");
    return { rows: [] };
  }
  async end() { state.events.push({ sql: "END" }); if (state.endFails && state.creates) throw new Error("synthetic close failure"); }
} }));
import { deployDatabaseModel, inspectDatabase, previewDatabaseDeploy } from "./databaseEngineering.js";

const mysql: DatabaseConnectionInput = { dialect: "mysql", host: "mock.invalid", username: "synthetic", database: "synthetic" };
const pg: DatabaseConnectionInput = { ...mysql, dialect: "postgresql" };
function table(name: string): DatabaseTable {
  return { id: name, name, displayName: "", comment: "", x: 0, y: 0, indexes: [], fields: [{ id: `${name}_id`, name: "id", type: "integer", primaryKey: true, nullable: false, unique: false, autoIncrement: false, defaultValue: "", comment: "" }] };
}
function model(dialect: DatabaseModel["dialect"], tables = [table("new_one"), table("new_two")]): DatabaseModel {
  return { id: "model", projectId: "project", name: "Synthetic model", dialect, tables, relations: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
}
beforeEach(() => { state.metadata = false; state.sharedConstraint = false; state.schema = "public"; state.failSecondCreate = false; state.rollbackFails = false; state.endFails = false; state.creates = 0; state.events.length = 0; });
it.each([mysql, pg])("$dialect keeps a same-named column's uniqueness scoped to its table", async connection => {
  state.metadata = true;
  const snapshot = await inspectDatabase(connection);
  expect(snapshot.tables.find(t => t.name === "unique_table")?.fields[0].unique).toBe(true);
  expect(snapshot.tables.find(t => t.name === "plain_table")?.fields[0].unique).toBe(false);
  expect(snapshot.tables.find(t => t.name === "unique_table")?.indexes[0].fieldIds).toEqual([snapshot.tables.find(t => t.name === "unique_table")?.fields[0].id]);
  if (connection.dialect === "postgresql") expect(state.events.find(e => e.sql.includes("array_agg"))?.sql).toContain("a.attname::text");
});
it.each([undefined, "R06_Mixed"])("PostgreSQL selects the exact transaction-local schema %s before DDL", async schema => {
  state.schema = schema ?? "public";
  const result = await deployDatabaseModel(model("postgresql"), { ...pg, ...(schema ? { schema } : {}) });
  expect(result.ok).toBe(true);
  expect(result.target).toContain(`.${state.schema}`);
  const selection = state.events.findIndex(e => e.sql.includes("set_config"));
  const firstCreate = state.events.findIndex(e => e.sql.includes("CREATE TABLE"));
  expect(selection).toBeGreaterThan(state.events.findIndex(e => e.sql === "BEGIN"));
  expect(selection).toBeLessThan(firstCreate);
  expect(state.events[selection]).toEqual({ sql: "SELECT set_config('search_path', quote_ident($1), true)", args: [schema ?? "public"] });
  expect(state.events.some(e => e.sql === "COMMIT")).toBe(true);
});
it("PostgreSQL refuses missing schema without creating tables in a fallback schema", async () => {
  state.schema = null;
  await expect(deployDatabaseModel(model("postgresql"), { ...pg, schema: "missing" })).rejects.toThrow("目标 schema 不存在或不可访问");
  expect(state.creates).toBe(0);
  expect(state.events.some(e => e.sql === "ROLLBACK")).toBe(true);
});
it("PostgreSQL rolls back a second-statement error and preserves both errors if rollback also fails", async () => {
  state.failSecondCreate = true; state.rollbackFails = true;
  const failure = await deployDatabaseModel(model("postgresql"), pg).catch(error => error);
  expect(state.creates).toBe(2);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors.map((e: Error) => e.message)).toEqual(["synthetic invalid default", "synthetic rollback failure"]);
  expect(state.events.some(e => e.sql === "COMMIT")).toBe(false);
});
it.each([false, true])("MySQL reports confirmed statements and possible partial DDL even when rollback fails=%s", async rollbackFails => {
  state.failSecondCreate = true; state.rollbackFails = rollbackFails;
  const failure = await deployDatabaseModel(model("mysql"), mysql).catch(error => error);
  expect(state.creates).toBe(2);
  expect(failure.message).toContain("可能已部分提交");
  expect(failure.message).toContain("已收到 1 条语句成功响应");
  expect(failure.message).toContain("重新读取目标结构");
  expect(failure.cause.message).toBe("synthetic invalid default");
  if (rollbackFails) expect(failure.message).toContain("synthetic rollback failure");
  expect(state.events.some(e => /DROP TABLE/.test(e.sql))).toBe(false);
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("real SQLite preview ignores unrelated existing FKs but blocks removal from explicitly modeled old tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-db-preview-")); dirs.push(dir);
  const filePath = join(dir, "synthetic.db"); const db = new Database(filePath);
  db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES (1)"); db.close();
  const connection: DatabaseConnectionInput = { dialect: "sqlite", filePath };
  const before = await inspectDatabase(connection);
  const missing = await previewDatabaseDeploy(model("sqlite", [table("new_table")]), connection);
  expect(missing.canApply).toBe(true); expect(missing.createTableCount).toBe(1);
  expect(missing.statements.join("\n")).not.toMatch(/ALTER|DROP/);
  const explicit = await previewDatabaseDeploy(model("sqlite", before.tables), connection);
  expect(explicit.canApply).toBe(false); expect(explicit.blockingReasons.join()).toContain("child.parent_id");
  const after = new Database(filePath, { readonly: true });
  expect(after.prepare("SELECT * FROM parent").all()).toEqual([{ id: 1 }]);
  expect(after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "child" }, { name: "parent" }]); after.close();
});

it.each([mysql, pg])("$dialect retains the primary DDL failure when closing also fails", async connection => {
  state.failSecondCreate = true; state.endFails = true;
  const failure = await deployDatabaseModel(model(connection.dialect), connection).catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.message).toContain("synthetic invalid default");
  expect(failure.message).toContain("synthetic close failure");
  if (connection.dialect === "mysql") expect(failure.message).toContain("可能已部分提交");
  expect(failure.errors[1].message).toBe("synthetic close failure");
});
it.each([mysql, pg])("$dialect committed DDL returns success and warning if closing fails", async connection => {
  state.endFails = true;
  const result = await deployDatabaseModel(model(connection.dialect), connection);
  expect(result.ok).toBe(true);
  expect(result).toMatchObject({ warnings: [expect.stringContaining("synthetic close failure")] });
  expect(state.events.some(e => e.sql === "COMMIT")).toBe(true);
  expect(state.events.some(e => e.sql === "ROLLBACK")).toBe(false);
});

it("PostgreSQL same-named constraints on different tables do not transfer primary-key flags", async () => {
  state.metadata = true; state.sharedConstraint = true;
  const snapshot = await inspectDatabase(pg);
  expect(snapshot.tables.find(t => t.name === "unique_table")?.fields[0].primaryKey).toBe(true);
  expect(snapshot.tables.find(t => t.name === "plain_table")?.fields[0].primaryKey).toBe(false);
});
