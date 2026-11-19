/**
 * Converts JSON values into values SQLite will bind, enforcing the rules SQL
 * Server used to enforce:
 *
 *   1. Conversion: node:sqlite binds only null, number, bigint, string and
 *      bytes, and its errors name parameters by position only.
 *   2. Width and range: declared widths from db/bindings.ts and
 *      db/coin-fields.ts are enforced (HTTP 400 instead of silent storage).
 *   3. Decimal rounding: values are rounded to the column's scale, as SQL
 *      Server did (e.g. 1.234567 -> 1.23457 for DECIMAL(12,5)).
 *
 * Errors carry the SQL Server error number routes/db-error-response.ts maps:
 *
 *   8152  value too long for its column          -> 400
 *   8114  not convertible, or decimal overflow   -> 400
 *   2627  PRIMARY KEY / UNIQUE violation         -> 409  (db/sql-api.ts)
 *   547   FOREIGN KEY / CHECK violation          -> 409  (db/sql-api.ts)
 */

import type { SqliteBindValue } from './driver';
import type { DbType } from './column-types';

/**
 * A parameter conversion error. Uses `number` for the SQL Server error number
 * because that is what db/errors.ts's sqlErrorNumber() reads.
 */
export class DbValueError extends Error {
  constructor(
    message: string,
    readonly number: number
  ) {
    super(message);
    this.name = 'DbValueError';
  }
}

/** `number` for "string or binary data would be truncated". */
export const ERR_VALUE_TOO_LONG = 8152;
/** `number` for "error converting data type". */
export const ERR_VALUE_NOT_CONVERTIBLE = 8114;

/**
 * Rounds to `scale` decimal places, half away from zero (as SQL Server does;
 * Math.round differs on negatives).
 *
 * `value * 10^scale` must stay below 2^53 for the rounding to be exact.
 * DECIMAL(18,6) could exceed that, so out-of-range values are returned
 * unchanged.
 */
export function roundToScale(value: number, scale: number): number {
  const factor = 10 ** scale;
  const scaled = Math.abs(value) * factor;
  if (!Number.isFinite(scaled) || scaled > Number.MAX_SAFE_INTEGER) return value;
  return Math.sign(value) * (Math.round(scaled) / factor);
}

/** The exclusive upper bound on |value| for a DECIMAL(precision, scale). */
export function decimalLimit(precision: number, scale: number): number {
  return 10 ** (precision - scale);
}

/**
 * Converts one JSON value for one declared column type.
 *
 * @param name  - the bound parameter's name, used in error messages
 * @param type  - the column's declared type (from DB_BINDINGS / COIN_FIELDS)
 * @param value - whatever the route handed over
 */
export function toBindValue(name: string, type: DbType, value: unknown): SqliteBindValue {
  // undefined and null are both SQL NULL (normally already handled by normalizeNullable()).
  if (value === null || value === undefined) return null;

  switch (type.storage) {
    case 'bit':
      // All BIT columns are NOT NULL DEFAULT 0, so anything truthy is 1.
      return value ? 1 : 0;

    case 'int':
      return toInt(name, value);

    case 'real':
      return toReal(name, type, value);

    case 'text':
      return toText(name, type, value);
  }
}

function toInt(name: string, value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new DbValueError(
        `${name} must be a whole number (got ${value})`,
        ERR_VALUE_NOT_CONVERTIBLE
      );
    }
    return value;
  }

  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;

  // A CSV round trip turns 3 into "3". Number() on a trimmed string is
  // all-or-nothing, so "3 sheep" is rejected rather than read as 3.
  const text = String(value).trim();
  const parsed = text === '' ? NaN : Number(text);
  if (!Number.isInteger(parsed)) {
    throw new DbValueError(
      `${name} must be a whole number (got ${JSON.stringify(value)})`,
      ERR_VALUE_NOT_CONVERTIBLE
    );
  }
  return parsed;
}

function toReal(name: string, type: DbType, value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(String(value).trim());

  if (!Number.isFinite(raw)) {
    throw new DbValueError(
      `${name} must be a number (got ${JSON.stringify(value)})`,
      ERR_VALUE_NOT_CONVERTIBLE
    );
  }

  const { precision, scale } = type;
  if (precision === undefined || scale === undefined) return raw;

  const rounded = roundToScale(raw, scale);

  // Refuse out-of-range values, as SQL Server did. 8114 maps to a 400.
  const limit = decimalLimit(precision, scale);
  if (Math.abs(rounded) >= limit) {
    throw new DbValueError(
      `${name} is out of range for ${type.declared} (got ${raw})`,
      ERR_VALUE_NOT_CONVERTIBLE
    );
  }

  return rounded;
}

function toText(name: string, type: DbType, value: unknown): string {
  let text: string;

  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Date) {
    // Date columns are TEXT; 'YYYY-MM-DD' is the form rowToCoin() round-trips.
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    text = String(value);
  } else {
    // An object or array reaching a text column is a caller bug; don't store "[object Object]".
    throw new DbValueError(
      `${name} must be text (got ${Object.prototype.toString.call(value)})`,
      ERR_VALUE_NOT_CONVERTIBLE
    );
  }

  if (type.maxLength !== undefined && text.length > type.maxLength) {
    throw new DbValueError(
      `${name} is ${text.length} characters; ${type.declared} holds at most ${type.maxLength}`,
      ERR_VALUE_TOO_LONG
    );
  }

  return text;
}
