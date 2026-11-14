/**
 * test-support/schema-columns.ts — reads db/schema.sql as data.
 *
 * Several specs guard the same invariant from different angles: the declared
 * widths and precisions in db/bindings.ts and db/coin-fields.ts must agree
 * with db/schema.sql. They used to parse server/setup-database.sql, whose
 * `NVARCHAR(100)` the SQL Server engine enforced.
 *
 * *** THE REASON THOSE SPECS MATTER MORE NOW, NOT LESS. *** SQLite enforces
 * no width at all. The binding table IS the enforcement (db/bind-values.ts),
 * so a binding that drifts away from the schema is no longer "a declaration
 * that disagrees with the engine" — it is the only rule there is, quietly
 * wrong. db/schema.sql therefore carries the width as a trailing comment:
 *
 *     Grade               TEXT        NULL     COLLATE NOCASE,   -- NVARCHAR(50)
 *     Weight              REAL        NULL,                      -- DECIMAL(12,5)
 *
 * which is honest about what SQLite stores (TEXT, REAL) while keeping the
 * declared intent machine-readable. This module is the one parser for that
 * format, so a change to the comment convention breaks in one place.
 */

import fs from 'fs';
import path from 'path';

/** One column, as db/schema.sql describes it. */
export interface SchemaColumn {
  /** Column name. */
  column: string;
  /** The SQLite storage class in the DDL: TEXT, INTEGER, REAL. */
  storage: string;
  /** The declared type from the trailing comment: 'NVARCHAR(100)',
   *  'DECIMAL(12,5)', 'CHAR(2)', 'INT', 'BIT', or '' when there is none. */
  declared: string;
  /** Declared character width, for NVARCHAR(n) / CHAR(n). Undefined for
   *  NVARCHAR(MAX) and for non-text columns. */
  maxLength?: number;
  /** Total digits, for DECIMAL(p,s). */
  precision?: number;
  /** Digits after the point, for DECIMAL(p,s). */
  scale?: number;
  /** True when the DDL says NOT NULL. */
  notNull: boolean;
}

export const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

/** The whole schema file. */
export function readSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * The body of one CREATE TABLE, without the surrounding statement.
 * Throws rather than returning empty: a parser that silently matches nothing
 * turns every assertion built on it into a trivial pass, which is worse than
 * no test because it looks like cover.
 */
export function tableBody(tableName: string, schema: string = readSchema()): string {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`);
  const body = schema.match(pattern)?.[1];
  if (!body) throw new Error(`db/schema.sql has no CREATE TABLE for ${tableName}`);
  return body;
}

/**
 * Every column of one table, keyed by column name.
 *
 * Lines that are comments, constraints or CHECK clauses are skipped; a line
 * is only read as a column when it starts with an identifier followed by one
 * of the three SQLite storage classes.
 */
export function parseTable(
  tableName: string,
  schema: string = readSchema()
): Map<string, SchemaColumn> {
  const columns = new Map<string, SchemaColumn>();

  for (const line of tableBody(tableName, schema).split('\n')) {
    const match = line.match(/^\s{4}(\w+)\s+(TEXT|INTEGER|REAL)\b([^\n]*)$/);
    if (!match) continue;

    const [, column, storage, rest] = match;
    const declared = rest.match(/--\s*([A-Z]+(?:\s*\([^)]*\))?)/)?.[1]?.replace(/\s+/g, '') ?? '';

    const textWidth = declared.match(/^(?:NVARCHAR|CHAR)\((\d+)\)$/)?.[1];
    const decimal = declared.match(/^DECIMAL\((\d+),(\d+)\)$/);

    columns.set(column, {
      column,
      storage,
      declared,
      maxLength: textWidth ? Number(textWidth) : undefined,
      precision: decimal ? Number(decimal[1]) : undefined,
      scale: decimal ? Number(decimal[2]) : undefined,
      notNull: /\bNOT NULL\b/.test(rest),
    });
  }

  if (columns.size === 0) throw new Error(`parsed no columns out of ${tableName}`);
  return columns;
}
