/**
 * migrate-sqlserver/source-reader.ts — WHAT THE ONE-TIME IMPORT IS ALLOWED
 * TO DO TO THE OWNER'S SQL SERVER, EXPRESSED AS AN INTERFACE.
 *
 * Stage 2 reads a database that exists exactly once in the world and cannot
 * be regenerated. Two things follow, and both are in this file rather than
 * in the mssql implementation, on purpose:
 *
 *   1. *** THE SOURCE IS READ-ONLY AND THAT IS ENFORCED, NOT INTENDED. ***
 *      Every statement the tool sends is built by `buildSelect()` from a
 *      validated table name and a validated column list, and is then passed
 *      through `assertReadOnlySql()` before it reaches a driver. There is no
 *      code path in this tool that can emit an INSERT, an UPDATE, a temp
 *      table or an EXEC against the source — not because nobody wrote one,
 *      but because the check refuses the string.
 *
 *      What that is and is not worth is stated plainly in the tool's output:
 *      it is a guarantee about THIS PROGRAM, not about the SQL Server login.
 *      The only guarantee the server itself can give is
 *      `ALTER DATABASE CoinInventory SET READ_ONLY`, which the owner can do
 *      and this tool deliberately does not (it would be a write).
 *
 *   2. *** THE DRIVER IS PLUGGABLE SO THE LOGIC IS TESTABLE. *** There is no
 *      SQL Server reachable from the machine this was built on, so every
 *      decision the migration makes — which columns must exist, seeded row
 *      versus the owner's own row, id remapping, the value-by-value
 *      verification — is driven through this interface and tested against
 *      fixtures. `mssql-source-reader.ts` is the only thing that cannot be
 *      tested here, and it is kept thin enough to read in one sitting for
 *      exactly that reason.
 *
 * MEMORY. `forEachRow` streams: it hands the caller one row at a time and
 * promises nothing about the rows before or after it. CoinImages holds ~2,140
 * base64 photographs in NVARCHAR(MAX) — several hundred megabytes — so a
 * `rows: SourceRow[]` return type would have been a design mistake that only
 * showed up on the owner's machine, with his data, once.
 */

/** A value a SQL Server column can hand to JavaScript through a driver. */
export type SourceValue = string | number | boolean | Date | Uint8Array | null;

/** One row, keyed by the alias the SELECT gave each column. */
export type SourceRow = Record<string, SourceValue>;

/**
 * One column as `INFORMATION_SCHEMA.COLUMNS` describes it.
 *
 * `dataType` is lower-cased ('nvarchar', 'uniqueidentifier', 'decimal'),
 * because that is how INFORMATION_SCHEMA spells it and comparing case
 * variants of a type name is a bug waiting to happen.
 *
 * `precision` / `scale` are the reason this is richer than a list of names:
 * `004-widen-weight-precision.sql` is what makes Weight DECIMAL(12,5), and a
 * source still at the old precision is detectable HERE, before anything is
 * written, rather than as a rounded weight afterwards.
 */
export interface SourceColumn {
  readonly name: string;
  readonly dataType: string;
  /** Characters for text types; -1 for MAX; null for everything else. */
  readonly maxLength: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
}

/** One item of a SELECT list: an expression and the name it comes back as. */
export interface SelectItem {
  readonly expression: string;
  readonly alias: string;
}

/** A read of one table. */
export interface SourceQuery {
  readonly table: string;
  readonly select: readonly SelectItem[];
  /** Bare column names. Order matters for CoinImages (CoinId, SortOrder). */
  readonly orderBy?: readonly string[];
}

/**
 * Everything the migration is permitted to ask of the owner's SQL Server.
 *
 * Note what is NOT here: no `execute`, no `query(sql)`, no escape hatch. A
 * caller that wanted to write would have to add a method, and adding a method
 * is a reviewable act.
 */
export interface SourceReader {
  /** Human-readable, for the log: 'SQL Server localhost:1433/CoinInventory'. */
  readonly description: string;
  /** Opens the connection. Read-only intent is requested here. */
  open(): Promise<void>;
  /** Closes it. Safe to call when never opened. */
  close(): Promise<void>;
  /** Base-table names that exist in the default schema. */
  tables(): Promise<string[]>;
  /** Columns of one table. Empty array when the table does not exist. */
  columns(table: string): Promise<SourceColumn[]>;
  /** COUNT(*). */
  count(table: string): Promise<number>;
  /**
   * Streams every row, calling `onRow` once per row, and resolves with how
   * many rows it saw. Implementations MUST NOT accumulate the result set.
   */
  forEachRow(query: SourceQuery, onRow: (row: SourceRow) => void): Promise<number>;
}

/**
 * A legal SQL Server identifier for our purposes — deliberately narrower than
 * what SQL Server allows. Every name this tool uses is one of its own
 * constants or a column name read back from INFORMATION_SCHEMA, so nothing
 * legitimate needs a space, a bracket or a dot in it, and refusing them
 * removes the question of whether `[` was escaped correctly.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Wraps a validated identifier in brackets. Throws on anything else. */
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Refusing to build SQL around the identifier ${JSON.stringify(name)}: ` +
        `the migration only ever names its own tables and columns, so anything ` +
        `that is not a plain identifier is a bug rather than a quoting problem.`
    );
  }
  return `[${name}]`;
}

/** `[Weight]` — the ordinary case. */
export function column(name: string): SelectItem {
  return { expression: quoteIdentifier(name), alias: name };
}

/**
 * `LOWER(CONVERT(NVARCHAR(36), [CoinId]))` — for a UNIQUEIDENTIFIER column.
 *
 * *** WHY THIS IS NOT A LIBERTY TAKEN WITH THE OWNER'S DATA. *** A
 * UNIQUEIDENTIFIER is sixteen bytes; it has no text form at rest, so there
 * is no "faithful" casing to preserve. The casing is invented by whoever
 * renders it, and the renderers disagree: SQL Server's own CONVERT produces
 * lower case, `tedious` produces upper case.
 *
 * SQLite's CoinId column is TEXT and, by design, BINARY rather than
 * NOCASE (see db/schema.sql's collation note — the id columns are payload).
 * So the casing stops being cosmetic the moment the data lands: a coin stored
 * as 'A1B2...' is not found by a request for 'a1b2...'. Lower case is the
 * right target because it is what `crypto.randomUUID()` emits in
 * routes/coins/writes.ts, i.e. what every id this application has ever
 * generated for itself looks like.
 *
 * Columns that are ALREADY text in the source are copied verbatim instead —
 * see `idSelectItem()`. There the casing is the owner's and not ours.
 */
export function guidAsLowerText(name: string): SelectItem {
  return {
    expression: `LOWER(CONVERT(NVARCHAR(36), ${quoteIdentifier(name)}))`,
    alias: name,
  };
}

/**
 * The right SELECT item for an id column, given what the source says it is.
 *
 * `uniqueidentifier` -> normalised to lower-case text (see above).
 * anything else      -> copied exactly as stored.
 */
export function idSelectItem(columnInfo: SourceColumn): SelectItem {
  return columnInfo.dataType === 'uniqueidentifier'
    ? guidAsLowerText(columnInfo.name)
    : column(columnInfo.name);
}

/** Builds the one shape of statement this tool is allowed to send. */
export function buildSelect(query: SourceQuery): string {
  if (query.select.length === 0) {
    throw new Error(`Refusing to build a SELECT with no columns for ${query.table}.`);
  }

  const columns = query.select
    .map((item) => `${item.expression} AS ${quoteIdentifier(item.alias)}`)
    .join(', ');

  const order =
    query.orderBy && query.orderBy.length > 0
      ? ` ORDER BY ${query.orderBy.map(quoteIdentifier).join(', ')}`
      : '';

  return `SELECT ${columns} FROM ${quoteIdentifier(query.table)}${order}`;
}

/**
 * Everything that must never appear in a statement sent to the source.
 *
 * Matched as whole words against the statement text. This is a backstop, not
 * the primary defence — the primary defence is that the only SQL builder in
 * the tool is `buildSelect()` and it cannot produce any of these. A backstop
 * is worth having anyway because the next person to add a query here will add
 * a string literal, and a string literal is exactly what this catches.
 */
const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'EXEC',
  'EXECUTE',
  'GRANT',
  'REVOKE',
  'DENY',
  'BACKUP',
  'RESTORE',
  'INTO',
  'OUTPUT',
  'WAITFOR',
  'SHUTDOWN',
  'RECONFIGURE',
  'SET',
  'USE',
] as const;

/** Raised when a statement would have been sent to the read-only source. */
export class ReadOnlyViolationError extends Error {
  constructor(readonly sql: string, reason: string) {
    super(
      `REFUSED: this statement would have been sent to the owner's SQL Server, ` +
        `which this tool opens read-only. ${reason}\n  ${sql}`
    );
    this.name = 'ReadOnlyViolationError';
  }
}

/**
 * The last thing between a string and the owner's only copy of his
 * collection. Called by the mssql reader on EVERY statement.
 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim();

  if (!/^SELECT\s/i.test(trimmed)) {
    throw new ReadOnlyViolationError(sql, 'It does not begin with SELECT.');
  }
  if (trimmed.includes(';')) {
    throw new ReadOnlyViolationError(
      sql,
      'It contains a semicolon, so it could be more than one statement.'
    );
  }
  if (trimmed.includes('--') || trimmed.includes('/*')) {
    throw new ReadOnlyViolationError(
      sql,
      'It contains a comment, which is how a second statement gets hidden.'
    );
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(trimmed)) {
      throw new ReadOnlyViolationError(sql, `It contains the keyword ${keyword}.`);
    }
  }
}
