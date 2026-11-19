/**
 * Parses db/schema.sql so specs can check that db/bindings.ts and
 * db/coin-fields.ts agree with it.
 *
 * SQLite enforces no widths, so the bindings are the enforcement. The
 * declared width lives in a trailing comment on each column:
 *
 *     Grade               TEXT        NULL     COLLATE NOCASE,   -- NVARCHAR(50)
 *     Weight              REAL        NULL,                      -- DECIMAL(12,5)
 */

import fs from 'fs';
import path from 'path';

/** One column, as db/schema.sql describes it. */
export interface SchemaColumn {
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
  notNull: boolean;
}

export const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

/** The whole schema file. */
export function readSchema(): string {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * The body of one CREATE TABLE, without the surrounding statement.
 * Throws when not found so dependent assertions cannot pass vacuously.
 */
export function tableBody(tableName: string, schema: string = readSchema()): string {
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`);
  const body = schema.match(pattern)?.[1];
  if (!body) throw new Error(`db/schema.sql has no CREATE TABLE for ${tableName}`);
  return body;
}

/**
 * Every column of one table, keyed by column name. Only lines of the form
 * `<name> TEXT|INTEGER|REAL ...` are read; constraints and comments are skipped.
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
