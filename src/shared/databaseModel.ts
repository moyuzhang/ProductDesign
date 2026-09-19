import {
  type DatabaseCodeResult,
  type DatabaseCodeTarget,
  type DatabaseDataType,
  type DatabaseDialect,
  type DatabaseField,
  type DatabaseModel,
  type DatabaseModelIssue,
  type DatabaseTable,
  type GeneratedCodeFile,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function words(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function pascal(value: string): string {
  return words(value).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("") || "Entity";
}

function camel(value: string): string {
  const result = pascal(value);
  return result.charAt(0).toLowerCase() + result.slice(1);
}

function quoteIdentifier(value: string, dialect: DatabaseDialect): string {
  return dialect === "mysql" ? `\`${value.replace(/`/g, "``")}\`` : `"${value.replace(/"/g, '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function generatedComment(value: string, indent: string): string[] {
  const normalized = value.trim();
  return normalized ? normalized.split(/\r?\n/).map((line) => `${indent}// ${line.trim()}`) : [];
}

function sqlType(field: DatabaseField, dialect: DatabaseDialect): string {
  const length = Math.max(1, field.length ?? 255);
  const precision = Math.max(1, field.precision ?? 18);
  const scale = Math.max(0, Math.min(field.scale ?? 2, precision));
  const map: Record<DatabaseDataType, string> = {
    uuid: dialect === "postgresql" ? "UUID" : dialect === "mysql" ? "CHAR(36)" : "TEXT",
    string: `VARCHAR(${length})`,
    text: "TEXT",
    integer: dialect === "mysql" ? "INT" : "INTEGER",
    bigint: "BIGINT",
    decimal: `DECIMAL(${precision}, ${scale})`,
    boolean: dialect === "sqlite" ? "INTEGER" : "BOOLEAN",
    date: "DATE",
    time: "TIME",
    datetime: dialect === "postgresql" ? "TIMESTAMP" : dialect === "sqlite" ? "TEXT" : "DATETIME",
    json: dialect === "postgresql" ? "JSONB" : dialect === "sqlite" ? "TEXT" : "JSON",
    binary: dialect === "postgresql" ? "BYTEA" : dialect === "sqlite" ? "BLOB" : "LONGBLOB",
  };
  return map[field.type];
}

export function validateDatabaseModel(model: Pick<DatabaseModel, "name" | "dialect" | "tables" | "relations">): DatabaseModelIssue[] {
  const issues: DatabaseModelIssue[] = [];
  const tableNames = new Set<string>();
  const tableMap = new Map(model.tables.map((table) => [table.id, table]));

  for (const table of model.tables) {
    const normalized = table.name.toLowerCase();
    if (!IDENTIFIER.test(table.name)) issues.push({ severity: "warning", code: "quoted_table_name", message: `表名“${table.name}”生成 SQL 时将使用方言引号`, tableId: table.id });
    if (tableNames.has(normalized)) issues.push({ severity: "error", code: "duplicate_table_name", message: `表名“${table.name}”重复`, tableId: table.id });
    tableNames.add(normalized);
    if (table.fields.length === 0) issues.push({ severity: "warning", code: "empty_table", message: `表“${table.name}”没有字段`, tableId: table.id });

    const fieldNames = new Set<string>();
    const fieldIds = new Set(table.fields.map((field) => field.id));
    for (const field of table.fields) {
      const fieldName = field.name.toLowerCase();
      if (!IDENTIFIER.test(field.name)) issues.push({ severity: "warning", code: "quoted_field_name", message: `字段名“${table.name}.${field.name}”生成 SQL 时将使用方言引号`, tableId: table.id, fieldId: field.id });
      if (fieldNames.has(fieldName)) issues.push({ severity: "error", code: "duplicate_field_name", message: `字段“${table.name}.${field.name}”重复`, tableId: table.id, fieldId: field.id });
      fieldNames.add(fieldName);
      if (field.autoIncrement && field.type !== "integer" && field.type !== "bigint") issues.push({ severity: "error", code: "invalid_auto_increment", message: `自增字段“${table.name}.${field.name}”必须是 integer 或 bigint`, tableId: table.id, fieldId: field.id });
    }
    for (const index of table.indexes) {
      if (index.fieldIds.length === 0 || index.fieldIds.some((fieldId) => !fieldIds.has(fieldId))) issues.push({ severity: "error", code: "broken_index", message: `索引“${table.name}.${index.name}”引用了不存在的字段`, tableId: table.id });
    }
  }

  for (const relation of model.relations) {
    const source = tableMap.get(relation.sourceTableId);
    const target = tableMap.get(relation.targetTableId);
    if (!source || !target) {
      issues.push({ severity: "error", code: "broken_relation_table", message: `关系“${relation.name || relation.id}”引用了不存在的表`, relationId: relation.id });
      continue;
    }
    const sourceField = source.fields.find((field) => field.id === relation.sourceFieldId);
    const targetField = target.fields.find((field) => field.id === relation.targetFieldId);
    if (!sourceField || !targetField) issues.push({ severity: "error", code: "broken_relation_field", message: `关系“${relation.name || relation.id}”引用了不存在的字段`, relationId: relation.id });
    else if (sourceField.type !== targetField.type) issues.push({ severity: "warning", code: "relation_type_mismatch", message: `关系“${source.name}.${sourceField.name} → ${target.name}.${targetField.name}”字段类型不同`, relationId: relation.id });
  }
  return issues;
}

export function generateDatabaseDdl(model: DatabaseModel, includedTableNames?: ReadonlySet<string>): GeneratedCodeFile {
  const q = (value: string) => quoteIdentifier(value, model.dialect);
  const lines: string[] = [`-- ${model.name}`, `-- dialect: ${model.dialect}`, ""];
  const tables = includedTableNames
    ? model.tables.filter((table) => includedTableNames.has(table.name.toLowerCase()))
    : model.tables;
  for (const table of tables) {
    const primaryKeys = table.fields.filter((field) => field.primaryKey);
    const columns = table.fields.map((field) => {
      let definition = `  ${q(field.name)} ${sqlType(field, model.dialect)}`;
      if (model.dialect === "sqlite" && field.autoIncrement && field.primaryKey && field.type === "integer") return `${definition} PRIMARY KEY AUTOINCREMENT`;
      if (!field.nullable || field.primaryKey) definition += " NOT NULL";
      if (field.autoIncrement) definition += model.dialect === "postgresql" ? " GENERATED BY DEFAULT AS IDENTITY" : model.dialect === "mysql" ? " AUTO_INCREMENT" : "";
      if (field.unique) definition += " UNIQUE";
      if (field.defaultValue.trim()) definition += ` DEFAULT ${field.defaultValue.trim()}`;
      if (model.dialect === "mysql" && field.comment.trim()) definition += ` COMMENT ${quoteSqlString(field.comment.trim())}`;
      return definition;
    });
    if (primaryKeys.length > 0 && !(model.dialect === "sqlite" && primaryKeys.length === 1 && primaryKeys[0].autoIncrement && primaryKeys[0].type === "integer")) columns.push(`  PRIMARY KEY (${primaryKeys.map((field) => q(field.name)).join(", ")})`);
    for (const relation of model.dialect === "sqlite" ? model.relations.filter((item) => item.sourceTableId === table.id) : []) {
      const target = model.tables.find((item) => item.id === relation.targetTableId);
      const sourceField = table.fields.find((field) => field.id === relation.sourceFieldId);
      const targetField = target?.fields.find((field) => field.id === relation.targetFieldId);
      if (target && sourceField && targetField) columns.push(`  CONSTRAINT ${q(relation.name || `fk_${table.name}_${sourceField.name}`)} FOREIGN KEY (${q(sourceField.name)}) REFERENCES ${q(target.name)} (${q(targetField.name)}) ON DELETE ${relation.onDelete}`);
    }
    lines.push(`CREATE TABLE ${q(table.name)} (`, columns.join(",\n"), ");", "");
    for (const field of table.fields.filter((item) => item.comment.trim())) {
      if (model.dialect === "postgresql") lines.push(`COMMENT ON COLUMN ${q(table.name)}.${q(field.name)} IS ${quoteSqlString(field.comment.trim())};`);
      if (model.dialect === "sqlite") lines.push(`-- ${table.name}.${field.name}: ${field.comment.trim().replace(/\s+/g, " ")}`);
    }
    if (table.fields.some((field) => field.comment.trim()) && model.dialect !== "mysql") lines.push("");
    for (const index of table.indexes) {
      const fields = index.fieldIds.map((fieldId) => table.fields.find((field) => field.id === fieldId)).filter((field): field is DatabaseField => Boolean(field));
      if (fields.length) lines.push(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${q(table.name)} (${fields.map((field) => q(field.name)).join(", ")});`);
    }
    if (table.indexes.length) lines.push("");
  }
  if (model.dialect !== "sqlite") {
    for (const relation of model.relations) {
      const source = model.tables.find((table) => table.id === relation.sourceTableId);
      const target = model.tables.find((table) => table.id === relation.targetTableId);
      const sourceField = source?.fields.find((field) => field.id === relation.sourceFieldId);
      const targetField = target?.fields.find((field) => field.id === relation.targetFieldId);
      if (!source || !target || !sourceField || !targetField || !tables.some((table) => table.id === source.id)) continue;
      lines.push(`ALTER TABLE ${q(source.name)} ADD CONSTRAINT ${q(relation.name || `fk_${source.name}_${sourceField.name}`)} FOREIGN KEY (${q(sourceField.name)}) REFERENCES ${q(target.name)} (${q(targetField.name)}) ON DELETE ${relation.onDelete};`);
    }
    if (model.relations.length) lines.push("");
  }
  return { name: `${model.name.replace(/\s+/g, "-").toLowerCase() || "schema"}.${model.dialect === "sqlite" ? "sqlite.sql" : "sql"}`, language: "sql", code: lines.join("\n").trim() + "\n" };
}

function javaType(field: DatabaseField): string {
  return ({ uuid: "UUID", string: "String", text: "String", integer: "Integer", bigint: "Long", decimal: "BigDecimal", boolean: "Boolean", date: "LocalDate", time: "LocalTime", datetime: "LocalDateTime", json: "String", binary: "byte[]" } as Record<DatabaseDataType, string>)[field.type];
}

function typescriptType(field: DatabaseField): string {
  return ({ uuid: "string", string: "string", text: "string", integer: "number", bigint: "string", decimal: "number", boolean: "boolean", date: "string", time: "string", datetime: "Date", json: "Record<string, unknown>", binary: "Buffer" } as Record<DatabaseDataType, string>)[field.type];
}

function csharpType(field: DatabaseField): string {
  const base = ({ uuid: "Guid", string: "string", text: "string", integer: "int", bigint: "long", decimal: "decimal", boolean: "bool", date: "DateOnly", time: "TimeOnly", datetime: "DateTime", json: "string", binary: "byte[]" } as Record<DatabaseDataType, string>)[field.type];
  return field.nullable && !["string", "text", "json", "binary"].includes(field.type) ? `${base}?` : base;
}

function goType(field: DatabaseField): string {
  return ({ uuid: "string", string: "string", text: "string", integer: "int", bigint: "int64", decimal: "float64", boolean: "bool", date: "time.Time", time: "time.Time", datetime: "time.Time", json: "datatypes.JSON", binary: "[]byte" } as Record<DatabaseDataType, string>)[field.type];
}

function generateJava(table: DatabaseTable, target: "java-jpa" | "java-mybatis-plus"): GeneratedCodeFile {
  const className = pascal(table.name);
  const imports = target === "java-jpa"
    ? ["import jakarta.persistence.*;"]
    : ["import com.baomidou.mybatisplus.annotation.*;"];
  if (table.fields.some((field) => field.type === "uuid")) imports.push("import java.util.UUID;");
  if (table.fields.some((field) => field.type === "decimal")) imports.push("import java.math.BigDecimal;");
  if (table.fields.some((field) => ["date", "time", "datetime"].includes(field.type))) imports.push("import java.time.*;");
  const lines = ["package com.example.domain;", "", ...imports, "", target === "java-jpa" ? "@Entity" : "", target === "java-jpa" ? `@Table(name = "${table.name}")` : `@TableName("${table.name}")`, `public class ${className} {`];
  for (const field of table.fields) {
    lines.push(...generatedComment(field.comment, "    "));
    if (field.primaryKey) lines.push(target === "java-jpa" ? "    @Id" : `    @TableId${field.autoIncrement ? "(type = IdType.AUTO)" : ""}`);
    else if (target === "java-jpa") lines.push(`    @Column(name = "${field.name}"${field.nullable ? "" : ", nullable = false"}${field.unique ? ", unique = true" : ""})`);
    else lines.push(`    @TableField("${field.name}")`);
    lines.push(`    private ${javaType(field)} ${camel(field.name)};`, "");
  }
  lines.push("    // Getters and setters can be generated by your IDE or Lombok.", "}");
  return { name: `${className}.java`, language: "java", code: lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n") + "\n" };
}

function generateTypeScript(table: DatabaseTable): GeneratedCodeFile {
  const className = pascal(table.name);
  const lines = ["import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from \"typeorm\";", "", `@Entity({ name: \"${table.name}\" })`, `export class ${className} {`];
  for (const field of table.fields) {
    lines.push(...generatedComment(field.comment, "  "));
    if (field.primaryKey) lines.push(field.autoIncrement ? "  @PrimaryGeneratedColumn()" : `  @PrimaryColumn({ type: \"${field.type === "string" ? "varchar" : field.type}\" })`);
    else lines.push(`  @Column({ name: \"${field.name}\", type: \"${field.type === "string" ? "varchar" : field.type}\", nullable: ${field.nullable}${field.unique ? ", unique: true" : ""} })`);
    lines.push(`  ${camel(field.name)}${field.nullable ? "?" : "!"}: ${typescriptType(field)};`, "");
  }
  lines.push("}");
  return { name: `${camel(table.name)}.entity.ts`, language: "typescript", code: lines.join("\n") + "\n" };
}

function generateCSharp(table: DatabaseTable): GeneratedCodeFile {
  const className = pascal(table.name);
  const lines = ["using System;", "using System.ComponentModel.DataAnnotations;", "using System.ComponentModel.DataAnnotations.Schema;", "", "namespace Example.Domain;", "", `[Table(\"${table.name}\")]`, `public class ${className}`, "{"];
  for (const field of table.fields) {
    lines.push(...generatedComment(field.comment, "    "));
    if (field.primaryKey) lines.push("    [Key]");
    lines.push(`    [Column(\"${field.name}\")]`, `    public ${csharpType(field)} ${pascal(field.name)} { get; set; }${field.nullable && ["string", "text", "json"].includes(field.type) ? "" : field.type === "binary" ? " = [];" : ""}`, "");
  }
  lines.push("}");
  return { name: `${className}.cs`, language: "csharp", code: lines.join("\n") + "\n" };
}

function generateGo(table: DatabaseTable): GeneratedCodeFile {
  const className = pascal(table.name);
  const imports = table.fields.some((field) => ["date", "time", "datetime"].includes(field.type)) ? ["import \"time\""] : [];
  if (table.fields.some((field) => field.type === "json")) imports.push("import \"gorm.io/datatypes\"");
  const lines = ["package model", "", ...imports, ...(imports.length ? [""] : []), `type ${className} struct {`];
  for (const field of table.fields) {
    const tags = [`column:${field.name}`];
    if (field.primaryKey) tags.push("primaryKey");
    if (field.autoIncrement) tags.push("autoIncrement");
    if (field.unique) tags.push("unique");
    if (!field.nullable) tags.push("not null");
    lines.push(...generatedComment(field.comment, "    "));
    lines.push(`    ${pascal(field.name)} ${goType(field)} \`gorm:\"${tags.join(";")}\" json:\"${field.name}\"\``);
  }
  lines.push("}", "", `func (${className}) TableName() string {`, `    return \"${table.name}\"`, "}");
  return { name: `${table.name}.go`, language: "go", code: lines.join("\n") + "\n" };
}

export function generateDatabaseCode(model: DatabaseModel, target: DatabaseCodeTarget | "ddl"): DatabaseCodeResult {
  const issues = validateDatabaseModel(model);
  if (issues.some((issue) => issue.severity === "error")) return { target, files: [], issues };
  if (target === "ddl") return { target, files: [generateDatabaseDdl(model)], issues };
  const files = model.tables.map((table) => {
    if (target === "java-jpa" || target === "java-mybatis-plus") return generateJava(table, target);
    if (target === "typescript-typeorm") return generateTypeScript(table);
    if (target === "csharp-ef-core") return generateCSharp(table);
    return generateGo(table);
  });
  return { target, files, issues };
}

export function autoLayoutDatabaseModel(model: DatabaseModel): DatabaseModel {
  const columns = Math.max(1, Math.ceil(Math.sqrt(model.tables.length)));
  return {
    ...model,
    tables: model.tables.map((table, index) => ({ ...table, x: 80 + (index % columns) * 360, y: 80 + Math.floor(index / columns) * 340 })),
  };
}
