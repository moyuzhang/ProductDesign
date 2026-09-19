import { describe, expect, it } from "vitest";
import { diffDatabaseSchemas } from "./databaseEngineering.js";
import type { DatabaseModel } from "../shared/types.js";

function schema(comment: string): Pick<DatabaseModel, "tables" | "relations"> {
  return {
    relations: [],
    tables: [{
      id: "table-1",
      name: "customer",
      displayName: "客户",
      comment: "",
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
        comment,
      }],
    }],
  };
}

describe("database engineering field comments", () => {
  it("reports a comment-only change as non-destructive", () => {
    expect(diffDatabaseSchemas(schema("客户显示名称"), schema(""))).toEqual([{
      kind: "change",
      objectKind: "field",
      path: "customer.display_name",
      detail: "字段备注发生变化",
      destructive: false,
    }]);
  });
});
