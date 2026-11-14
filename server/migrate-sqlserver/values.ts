/**
 * migrate-sqlserver/values.ts — the two conversions every row goes through,
 * and the identity rule every reference row is matched by.
 *
 * Small file, disproportionately important: both functions are places where
 * a wrong answer is invisible afterwards.
 */

import type { SqliteBindValue } from '../db/driver';
import type { SourceValue } from './source-reader';

/**
 * Turns what a SQL Server driver hands back into something the SQLite driver
 * will accept.
 *
 * `node:sqlite` binds null, number, bigint, string and byte arrays and
 * nothing else — a boolean or a Date throws "Provided value cannot be bound
 * to SQLite parameter N", a message that names the parameter by POSITION and
 * so says nothing about which column of which coin was wrong. Three
 * conversions are therefore done here, deliberately and in one place:
 *
 *   BIT -> 0 / 1. `tedious` returns a JavaScript boolean. The SQLite columns
 *   are `INTEGER ... CHECK (x IN (0, 1))`, which a boolean does not satisfy
 *   because it never arrives.
 *
 *   DATETIME2 -> ISO-8601 UTC text. The only such column is
 *   `SpotPrices.FetchedAt`, and db/schema.sql's default for it is
 *   `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` — exactly the shape
 *   `Date.prototype.toISOString()` produces, which is what keeps
 *   `ORDER BY FetchedAt DESC` meaning what it says. (`tedious` reads
 *   DATETIME2 as UTC by default, so the Date is already the right instant.)
 *
 *   *** NUMBERS ARE NOT TOUCHED. *** No rounding, no scaling, no
 *   `toFixed()`. `tedious` hands a DECIMAL to JavaScript as a binary64 and
 *   SQLite's REAL stores a binary64 bit for bit, so passing the number
 *   straight through is what makes the value-by-value verification an exact
 *   `===` rather than a tolerance (db/schema.sql's numeric-storage note).
 *   db/bind-values.ts DOES round, because it is reproducing what SQL Server
 *   did to an incoming HTTP request; this is a copy of what SQL Server
 *   already stored, and rounding it again could only change it.
 */
export function toBindValue(value: SourceValue): SqliteBindValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return value;
}

/**
 * The identity a reference row is matched by, across two databases whose
 * integer ids have nothing to do with each other.
 *
 * `toLowerCase()` because every one of these columns is COLLATE NOCASE in
 * db/schema.sql and case-insensitive in the source's collation, so 'sear'
 * and 'Sear' are one catalogue and must not become two.
 *
 * `trimEnd()` because SQL Server ignores TRAILING spaces in a text
 * comparison and SQLite does not. Without it, an issuer stored as 'Mexico '
 * would be one row to SQL Server and a second, separate row to SQLite —
 * and a second issuer called Mexico makes every denomination under it
 * ambiguous, which (see migrations/seed-sql.ts's header) does not add a
 * denomination, it removes one. Leading spaces are NOT trimmed: SQL Server
 * does not ignore those either, so ' Mexico' really is a different name.
 */
export function identityKey(value: string): string {
  return value.trimEnd().toLowerCase();
}

/**
 * The text actually written for an identity column.
 *
 * Trailing whitespace is removed for the reason above — the alternative is
 * to write a value whose uniqueness depends on which engine is reading it.
 * Everything else about the owner's text, including its capitalisation and
 * any leading space, is preserved.
 */
export function identityText(value: string): string {
  return value.trimEnd();
}

/** Reads a column that must be text. */
export function asText(row: Record<string, SourceValue>, name: string): string {
  const value = row[name];
  if (value === null || value === undefined) {
    throw new Error(`Source row has no value for ${name}, which cannot be null.`);
  }
  return String(value);
}

/** Reads a nullable text column. */
export function asNullableText(
  row: Record<string, SourceValue>,
  name: string
): string | null {
  const value = row[name];
  return value === null || value === undefined ? null : String(value);
}

/** Reads a column that must be a number. */
export function asNumber(row: Record<string, SourceValue>, name: string): number {
  const value = row[name];
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`Source column ${name} is ${JSON.stringify(value)}, not a number.`);
}

/** Reads a nullable numeric column. */
export function asNullableNumber(
  row: Record<string, SourceValue>,
  name: string
): number | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`Source column ${name} is ${JSON.stringify(value)}, not a number.`);
}

/** Reads a BIT column as 0 or 1. */
export function asFlag(row: Record<string, SourceValue>, name: string): number {
  const value = row[name];
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value === 0 ? 0 : 1;
  if (value === null || value === undefined) return 0;
  throw new Error(`Source column ${name} is ${JSON.stringify(value)}, not a bit.`);
}
