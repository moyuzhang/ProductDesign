import { describe, expect, it } from "vitest";
import { generateDatabaseCode, generateDatabaseDdl } from "./databaseModel.js";
import type { DatabaseCodeTarget, DatabaseModel } from "./types.js";

function model(dialect: DatabaseModel["dialect"]): DatabaseModel {
  return {
    id: "model-1",
    projectId: "project-1",
    name: "Customer model",
    dialect,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    relations: [],
    tables: [{
      id: "table-1",
      name: "customer",
      displayName: "客户",
      comment: "客户主数据",
      x: 80,
      y: 80,
      indexes: [],
      fields: [{
        id: "field-1",
        name: "display_name",
        type: "string",
        length: 120,
        nullable: false,
        primaryKey: false,
        autoIncrement: false,
        unique: false,
        defaultValue: "",
        comment: "Customer's display name",
      }],
    }],
  };
}

describe("database field comments", () => {
  it("emits executable column comments for MySQL and PostgreSQL", () => {
    expect(generateDatabaseDdl(model("mysql")).code).toContain("COMMENT 'Customer''s display name'");
    expect(generateDatabaseDdl(model("postgresql")).code).toContain('COMMENT ON COLUMN "customer"."display_name" IS \'Customer\'\'s display name\';');
  });

  it("keeps field comments in every generated entity target", () => {
    const targets: DatabaseCodeTarget[] = ["java-jpa", "java-mybatis-plus", "typescript-typeorm", "csharp-ef-core", "go-gorm"];
    for (const target of targets) {
      expect(generateDatabaseCode(model("mysql"), target).files[0]?.code).toContain("// Customer's display name");
    }
  });
});
