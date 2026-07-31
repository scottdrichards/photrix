import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { tables, type TableColumn, type TableDefinition } from "./tables.ts";

const tableColumnToString = (row: TableColumn): string =>
  `${row.name} ${row.type}${row.default !== undefined ? ` DEFAULT ${row.default}` : ""}`;

/**
 * Creates one table from its definition if it does not already exist.
 *
 * Exported because migrations that *move* data into a new table have to run
 * before `prepareTables`: prepareTables drops any column missing from the
 * definitions, so by the time it has run, a legacy column the migration still
 * needs to read is already gone. Such a migration creates its destination table
 * with this, copies, and then lets prepareTables drop the vacated columns.
 */
export const ensureTableExists = async (
  db: AsyncSqlite,
  tableName: keyof typeof tables,
): Promise<void> => {
  const { columns } = tables[tableName] as TableDefinition;
  const pkColumns = columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const pkClause = pkColumns.length ? `, PRIMARY KEY (${pkColumns.join(", ")})` : "";
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${tableName} (${columns
      .map(tableColumnToString)
      .join(", ")}${pkClause})`,
  );
};

export const prepareTables = async (db: AsyncSqlite) => {
  for (const [tableName, { columns, compositeIndexes }] of Object.entries(
    tables,
  ) as Array<[string, TableDefinition]>) {
    await ensureTableExists(db, tableName as keyof typeof tables);

    // Ensure all required columns exist in the table
    const columnsInTableResult = await db.all<{ name: string }>(
      `PRAGMA table_info(${tableName})`,
    );
    const columnsInTable = new Set(columnsInTableResult.map(({ name }) => name));
    const requiredColumns = new Set(columns.map(({ name }) => name));

    for (const column of requiredColumns) {
      if (columnsInTable.has(column)) continue;
      const columnDef = columns.find((c) => c.name === column)!;
      await db.exec(
        `ALTER TABLE ${tableName} ADD COLUMN ${tableColumnToString(columnDef)}`,
      );
    }

    const desiredIndexes = new Set<string>();

    // Add column indices
    for (const column of columns.filter((c) => "indexExpression" in c)) {
      const expression =
        column.indexExpression === true ? column.name : column.indexExpression;

      const indexName = `idx_${tableName}_${column.name}`;

      await db.exec(
        `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${expression})`,
      );
      desiredIndexes.add(indexName);
    }

    // Add composite indexes
    for (const { name, expression, unique, where } of compositeIndexes) {
      const whereClause = where ? ` WHERE ${where}` : "";
      const uniqueKeyword = unique ? "UNIQUE " : "";
      const indexName = `idx_${tableName}_${name}`;
      await db.exec(
        `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${expression})${whereClause}`,
      );
      desiredIndexes.add(indexName);
    }

    // Remove stale indexes before dropping columns so schema changes do not fail
    // when old indexes reference removed columns.
    const existingIndexes = await db.all<{ name: string; origin: string }>(
      `PRAGMA index_list(${tableName})`,
    );

    const tableIndexPrefix = `idx_${tableName}_`;
    const obsoleteIndexes = existingIndexes
      .filter(
        ({ name, origin }) =>
          origin !== "pk" &&
          name.startsWith(tableIndexPrefix) &&
          !desiredIndexes.has(name),
      )
      .map(({ name }) => name);

    for (const indexName of obsoleteIndexes) {
      await db.exec(`DROP INDEX IF EXISTS ${indexName}`);
    }

    // Remove any old columns that are no longer required
    for (const column of columnsInTable) {
      if (requiredColumns.has(column)) continue;
      await db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${column}`);
    }
  }

  // Refresh planner statistics so SQLite picks the right index for queries
  // like ORDER BY COALESCE(...) LIMIT N (the `sort_date` expression index).
  await db.exec("ANALYZE");
};
