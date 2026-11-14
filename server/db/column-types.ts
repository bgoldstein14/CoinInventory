/**
 * db/column-types.ts — the parameter type vocabulary, re-expressed for SQLite.
 *
 * WHY THIS FILE EXISTS AT ALL, GIVEN THAT SQLITE IS DYNAMICALLY TYPED.
 *
 * It would have been easy to delete the type table when SQL Server went away:
 * SQLite stores whatever it is given, so `NVarChar(100)` buys nothing at the
 * storage layer. Deleting it would also have thrown away the only
 * machine-readable record this project has of what each column is FOR —
 * how wide `Variety` is, how many decimals a weight keeps, that `IsoCode` is
 * two characters and not three. That record is used in three places:
 *
 *   1. db/bind-values.ts enforces it on the way in, so a value SQL Server
 *      would have refused is still refused (see the error-number table
 *      there). Without this, SQLite silently stores a 4,000-character
 *      "grade" and the problem surfaces as a wrecked UI months later.
 *   2. db/coin-fields.spec.ts and friends compare it against db/schema.sql
 *      and fail the build when the two drift.
 *   3. Stage 2's one-time migration needs to know the declared scale of
 *      `Weight` and `PmWeightGrams` to verify that nothing was rounded away
 *      in transit (design §4.1).
 *
 * The constructor names deliberately match the `mssql` ones they replace
 * (`NVarChar`, `Char`, `Int`, `Bit`, `Decimal`, `MAX`), so db/bindings.ts and
 * db/coin-fields.ts — two long, heavily annotated tables — change by one
 * import line rather than being retyped.
 */

/** Marker for "no declared maximum" — the old `NVARCHAR(MAX)`. */
export const MAX = 'max' as const;
export type MaxLength = typeof MAX;

/**
 * How a value is stored in SQLite, after conversion.
 *
 *   text  -> TEXT
 *   int   -> INTEGER
 *   real  -> REAL        (see the numeric-storage note on Decimal() below)
 *   bit   -> INTEGER constrained to 0 / 1
 */
export type DbStorageClass = 'text' | 'int' | 'real' | 'bit';

/** One column's declared type. */
export interface DbType {
  readonly storage: DbStorageClass;
  /**
   * Declared character width for `text`. `undefined` means unbounded
   * (the old NVARCHAR(MAX)).
   */
  readonly maxLength?: number;
  /** True for the old fixed-width CHAR(n). See the note on Char() below. */
  readonly fixedWidth?: boolean;
  /** Total digits, for `real` columns that came from a DECIMAL(p,s). */
  readonly precision?: number;
  /** Digits after the point, for `real` columns that came from a DECIMAL(p,s). */
  readonly scale?: number;
  /**
   * The SQL Server type this came from, verbatim: 'NVARCHAR(100)',
   * 'DECIMAL(12,5)', 'CHAR(2)', 'INT', 'BIT'.
   *
   * KEPT ON PURPOSE AND NOT COSMETIC. It is what db/schema.sql's trailing
   * `-- NVARCHAR(100)` comments are compared against, it is what the Stage 2
   * migration reads to decide how to verify a column, and it is the only
   * remaining description of the source schema once setup-database.sql is
   * finally deleted.
   */
  readonly declared: string;
}

/**
 * Variable-length text. `NVarChar(MAX)` is unbounded.
 *
 * The width is ENFORCED (db/bind-values.ts raises the 8152 equivalent, which
 * routes/db-error-response.ts turns into an HTTP 400). That is a deliberate
 * change of behaviour from `mssql`, which trimmed an over-long value to the
 * declared length before sending it and told nobody. Silently storing three
 * quarters of a user's note is worse than refusing it: the user can retype a
 * refused value, and cannot recover a truncated one.
 */
export function NVarChar(length: number | MaxLength): DbType {
  if (length === MAX) {
    return { storage: 'text', declared: 'NVARCHAR(MAX)' };
  }
  return { storage: 'text', maxLength: length, declared: `NVARCHAR(${length})` };
}

/**
 * Fixed-width text. Exactly one column in this schema is one: Issuers.IsoCode
 * CHAR(2).
 *
 * *** THE PADDING TRAP IS GONE, AND THAT IS AN IMPROVEMENT, NOT A REGRESSION. ***
 * SQL Server PADS a CHAR(2) — 'M' became 'M ' — and the padded value then
 * compared unequal to 'M' everywhere, so the issuer quietly stopped matching
 * anything. SQLite's TEXT stores exactly the characters it is given, so that
 * failure mode does not exist here and nothing pads. The width is still
 * declared and still enforced as a MAXIMUM, because the route's "exactly two
 * letters" rule deserves a second line of defence; what is NOT reproduced is
 * the padding, deliberately.
 */
export function Char(length: number): DbType {
  return { storage: 'text', maxLength: length, fixedWidth: true, declared: `CHAR(${length})` };
}

/** A whole number. Rejects anything that is not one — see db/bind-values.ts. */
export const Int: DbType = { storage: 'int', declared: 'INT' };

/** 0 or 1. Anything truthy becomes 1, anything falsy becomes 0. */
export const Bit: DbType = { storage: 'bit', declared: 'BIT' };

/**
 * A fixed-point column from SQL Server, stored in SQLite as REAL.
 *
 * *** THIS IS THE DECISION THE WHOLE MIGRATION TURNS ON. The argument is in
 * the header of db/schema.sql; read it before changing anything here. ***
 *
 * In short: SQLite has no decimal type, the application has only ever been
 * able to hold these values as JavaScript doubles anyway (`tedious` returns
 * DECIMAL columns as `number`), and REAL is the only storage class that
 * round-trips a double bit-for-bit. `precision` and `scale` are carried so
 * db/bind-values.ts can apply the SAME rounding and the SAME range check
 * SQL Server applied, which is what stops a value written through SQLite
 * differing from the value the identical request wrote through SQL Server.
 */
export function Decimal(precision: number, scale: number): DbType {
  return { storage: 'real', precision, scale, declared: `DECIMAL(${precision},${scale})` };
}

/**
 * The whole vocabulary under one name, so a module can write
 * `types.NVarChar(100)` where it used to write `sql.NVarChar(100)`.
 */
export const types = { MAX, NVarChar, Char, Int, Bit, Decimal } as const;
