/**
 * Parameter type vocabulary (NVarChar, Char, Int, Bit, Decimal, MAX), named
 * after the SQL Server types the columns came from.
 *
 * SQLite stores any value in any column, so these declared types are the only
 * record of each column's width and scale. They are used by:
 *   1. db/bind-values.ts, which enforces them on the way in;
 *   2. the parity specs, which compare them with db/schema.sql;
 *   3. the one-time SQL Server import, to check nothing was rounded away.
 */

/** Marker for "no declared maximum" (NVARCHAR(MAX)). */
export const MAX = 'max' as const;
export type MaxLength = typeof MAX;

/**
 * How a value is stored in SQLite, after conversion.
 *
 *   text  -> TEXT
 *   int   -> INTEGER
 *   real  -> REAL        (see Decimal() below)
 *   bit   -> INTEGER constrained to 0 / 1
 */
export type DbStorageClass = 'text' | 'int' | 'real' | 'bit';

/** One column's declared type. */
export interface DbType {
  readonly storage: DbStorageClass;
  /** Declared character width for `text`; `undefined` means unbounded. */
  readonly maxLength?: number;
  /** True for fixed-width CHAR(n). */
  readonly fixedWidth?: boolean;
  /** Total digits, for `real` columns that came from a DECIMAL(p,s). */
  readonly precision?: number;
  /** Digits after the point, for `real` columns that came from a DECIMAL(p,s). */
  readonly scale?: number;
  /**
   * The SQL Server type, verbatim: 'NVARCHAR(100)', 'DECIMAL(12,5)', 'CHAR(2)',
   * 'INT', 'BIT'. Compared against db/schema.sql's trailing type comments and
   * used by the SQL Server import.
   */
  readonly declared: string;
}

/**
 * Variable-length text; `NVarChar(MAX)` is unbounded. The width is enforced:
 * an over-long value is rejected (HTTP 400), not truncated.
 */
export function NVarChar(length: number | MaxLength): DbType {
  if (length === MAX) {
    return { storage: 'text', declared: 'NVARCHAR(MAX)' };
  }
  return { storage: 'text', maxLength: length, declared: `NVARCHAR(${length})` };
}

/**
 * Fixed-width text (only Issuers.IsoCode CHAR(2)). The width is enforced as a
 * maximum; SQLite doesn't pad values the way SQL Server's CHAR did.
 */
export function Char(length: number): DbType {
  return { storage: 'text', maxLength: length, fixedWidth: true, declared: `CHAR(${length})` };
}

/** A whole number. Rejects anything that is not one — see db/bind-values.ts. */
export const Int: DbType = { storage: 'int', declared: 'INT' };

/** 0 or 1. Anything truthy becomes 1, anything falsy becomes 0. */
export const Bit: DbType = { storage: 'bit', declared: 'BIT' };

/**
 * A SQL Server DECIMAL(p,s) column, stored in SQLite as REAL. `precision` and
 * `scale` let db/bind-values.ts apply the same rounding and range check SQL
 * Server did. See the db/schema.sql header for why REAL.
 */
export function Decimal(precision: number, scale: number): DbType {
  return { storage: 'real', precision, scale, declared: `DECIMAL(${precision},${scale})` };
}

/** The whole vocabulary under one name, e.g. `types.NVarChar(100)`. */
export const types = { MAX, NVarChar, Char, Int, Bit, Decimal } as const;
