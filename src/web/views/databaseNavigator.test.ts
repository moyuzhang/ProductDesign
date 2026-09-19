import { describe, expect, it } from "vitest";
import type { DatabaseModel, DatabaseTable } from "../../shared/types.js";
import { matchesDatabaseTableQuery, rankDatabaseTables, relatedDatabaseTableIds } from "./databaseNavigator.js";

function table(id: string, name: string, fields: DatabaseTable["fields"] = []): DatabaseTable {
  return { id, name, displayName: "", comment: "", x: 0, y: 0, fields, indexes: [] };
}

function model(): DatabaseModel {
  return {
    id: "model-1",
    projectId: "project-1",
    name: "业务库",
    dialect: "mysql",
    tables: [table("users", "users"), table("orders", "orders"), table("items", "order_items")],
    relations: [
      { id: "r1", name: "orders_user", type: "one-to-many", sourceTableId: "orders", sourceFieldId: "user_id", targetTableId: "users", targetFieldId: "id", onDelete: "NO ACTION" },
      { id: "r2", name: "items_order", type: "one-to-many", sourceTableId: "items", sourceFieldId: "order_id", targetTableId: "orders", targetFieldId: "id", onDelete: "NO ACTION" },
    ],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("database navigator", () => {
  it("ranks the most connected table first", () => {
    expect(rankDatabaseTables(model()).map((item) => item.id)).toEqual(["orders", "items", "users"]);
  });

  it("returns the selected table and its direct neighbors", () => {
    expect([...relatedDatabaseTableIds(model(), "orders")].sort()).toEqual(["items", "orders", "users"]);
  });

  it("matches physical names, labels, comments and fields", () => {
    const candidate = table("orders", "bet_orders", [{
      id: "amount",
      name: "stake_amount",
      type: "decimal",
      nullable: false,
      primaryKey: false,
      autoIncrement: false,
      unique: false,
      defaultValue: "",
      comment: "投注金额",
    }]);
    candidate.displayName = "订单";
    expect(matchesDatabaseTableQuery(candidate, "stake")).toBe(true);
    expect(matchesDatabaseTableQuery(candidate, "投注金额")).toBe(true);
    expect(matchesDatabaseTableQuery(candidate, "用户")).toBe(false);
  });
});
