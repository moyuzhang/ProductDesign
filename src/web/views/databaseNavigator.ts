import type { DatabaseModel, DatabaseTable } from "../../shared/types.js";

export function databaseRelationCounts(model: DatabaseModel): Map<string, number> {
  const counts = new Map(model.tables.map((table) => [table.id, 0]));
  for (const relation of model.relations) {
    counts.set(relation.sourceTableId, (counts.get(relation.sourceTableId) ?? 0) + 1);
    if (relation.targetTableId !== relation.sourceTableId) {
      counts.set(relation.targetTableId, (counts.get(relation.targetTableId) ?? 0) + 1);
    }
  }
  return counts;
}

export function relatedDatabaseTableIds(model: DatabaseModel, tableId: string): Set<string> {
  const ids = new Set([tableId]);
  for (const relation of model.relations) {
    if (relation.sourceTableId === tableId) ids.add(relation.targetTableId);
    if (relation.targetTableId === tableId) ids.add(relation.sourceTableId);
  }
  return ids;
}

export function rankDatabaseTables(model: DatabaseModel): DatabaseTable[] {
  const counts = databaseRelationCounts(model);
  return [...model.tables].sort((left, right) => {
    const relationDifference = (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0);
    if (relationDifference !== 0) return relationDifference;
    const fieldDifference = right.fields.length - left.fields.length;
    if (fieldDifference !== 0) return fieldDifference;
    return left.name.localeCompare(right.name);
  });
}

export function matchesDatabaseTableQuery(table: DatabaseTable, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    table.name,
    table.displayName,
    table.comment,
    ...table.fields.flatMap((field) => [field.name, field.comment]),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}
