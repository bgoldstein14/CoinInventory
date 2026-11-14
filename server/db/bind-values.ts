/**
 * db/bind-values.ts — turning a JSON value into something SQLite will accept,
 * and refusing the ones SQL Server would have refused.
 *
 * `mssql` did three jobs at the parameter boundary that SQLite does not do at
 * all, and dropping any of them would be a silent change of behaviour:
 *
 *   1. CONVERSION. `node:sqlite` binds only null, number, bigint, string and
 *      byte arrays. A boolean, a `Date` or an `undefined` throws "Provided
 *      value cannot be bound to SQLite parameter N" — a message that names
 *      the parameter by POSITION and so tells the reader nothing about which
 *      field of which coin was wrong. Everything is converted here instead.
 *
 *   2. WIDTH AND RANGE. SQLite stores a 4,000-character string in a column
 *      declared NVARCHAR(50) without complaint. The declared widths in
 *      db/bindings.ts and db/coin-fields.ts are enforced here, so a value
 *      the old schema would have rejected still produces an HTTP 400 rather
 *      than quietly landing in the database.
 *
 *   3. DECIMAL ROUNDING. SQL Server rounded a value to its column's scale on
 *      the way in: a Weight of 1.234567 was stored as 1.23457 because the
 *      column is DECIMAL(12,5). SQLite would store all seven digits. The same
 *      rounding is applied here so that the same request produces the same
 *      stored value on both engines — which is precisely what Stage 2's
 *      value-by-value verification (design §4.1) compares.
 *
 * ERROR NUMBERS. routes/db-error-response.ts decides the HTTP status from a
 * SQL Server error number, and that mapping is good: it is readable, it is
 * tested, and rewriting it would spread this migration into the HTTP layer.
 * So the errors raised here (and the SQLite errors translated in
 * db/sql-api.ts) carry the matching SQL Server `number`:
 *
 *   8152  value too long for its column          -> 400
 *   8114  value is not convertible to the column -> 400  (also used for a
 *                                                         decimal that
 *                                                         overflows its
 *                                                         declared range)
 *   2627  PRIMARY KEY / UNIQUE violation         -> 409
 *   547   FOREIGN KEY / CHECK violation          -> 409
 *
 * Nothing else in the tree needs to know that the engine changed.
 */

import type { SqliteBindValue } from './driver';
import type { DbType } from './column-types';

/**
 * An error raised while converting a parameter, carrying the SQL Server error
 * number that routes/db-error-response.ts already knows how to classify.
 *
 * `number` rather than a new field, because db/errors.ts's `sqlErrorNumber()`
 * reads exactly that property and is used by the route layer unchanged.
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
 * Rounds to `scale` decimal places, half away from zero.
 *
 * Half AWAY FROM ZERO rather than `Math.round`, which is half towards
 * positive infinity: the two differ on negatives (`Math.round(-0.5)` is `-0`,
 * SQL Server's CONVERT gives `-1`). Nothing in this schema is routinely
 * negative, but a rule that is right only for the values we happen to see is
 * not a rule.
 *
 * SAFETY OF THE MULTIPLY. The intermediate `value * 10^scale` must stay below
 * 2^53 or the rounding is noise. For every column in this schema that holds a
 * real measurement it does: the widest is DECIMAL(12,5), whose largest
 * in-range value scales to 10^12. DECIMAL(18,6) (Denominations.FaceValue)
 * could in principle scale past 2^53, so the multiply is guarded and an
 * out-of-safe-range value is left exactly as it arrived rather than mangled.
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
 * @param name  - the bound parameter's name, used only to make the error
 *                message name the field the user actually typed in
 * @param type  - the column's declared type (from DB_BINDINGS / COIN_FIELDS)
 * @param value - whatever the route handed over
 */
export function toBindValue(name: string, type: DbType, value: unknown): SqliteBindValue {
  // `undefined` and `null` are both SQL NULL. This matches
  // db/value-normalizers.ts's normalizeNullable(), which most route paths
  // have already applied; doing it again here costs nothing and means a path
  // that forgot cannot bind `undefined` into the driver and get a positional
  // error message.
  if (value === null || value === undefined) return null;

  switch (type.storage) {
    case 'bit':
      // BIT columns in this schema are all NOT NULL DEFAULT 0, so there is no
      // third state to preserve: anything truthy is 1.
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

  // A CSV round trip turns the number 3 into the string "3"; see the notes on
  // catalogId in db/coin-fields.ts. `Number()` on a trimmed string is
  // all-or-nothing, which is what we want: "3 sheep" must not read as 3.
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

  // SQL Server raised an arithmetic-overflow error here rather than storing a
  // truncated number. Refusing is the important half; the exact error number
  // matters less, and 8114 is the one that already produces a 400 so the user
  // is told rather than shown a 500.
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
    // The date columns in this schema are TEXT, not DATE (see
    // db/value-normalizers.ts). 'YYYY-MM-DD' is the only form that round-trips
    // through rowToCoin(); a locale-formatted date does not.
    text = value.toISOString().slice(0, 10);
  } else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
    text = String(value);
  } else {
    // An object or an array reaching a text column is a caller bug, and
    // "[object Object]" in the database is the worst possible outcome of it.
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
