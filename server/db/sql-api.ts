/**
 * Request-style query API over SQLite, shaped like the `mssql` API the routes
 * were written against:
 *
 *     const rows = await withDb(async (db) => {
 *       const result = await db.request()
 *         .input('id', DB_BINDINGS.coinId, id)
 *         .query('SELECT * FROM Coins WHERE CoinId = @id');
 *       return result.recordset;
 *     });
 *
 * - Validates and converts every bound value (db/bind-values.ts).
 * - Translates SQLite errors to SQL Server error numbers so
 *   routes/db-error-response.ts can classify them.
 * - Rejects multi-statement queries: node:sqlite's prepare() silently ignores
 *   everything after the first statement.
 * - Rejects unbound `@name` parameters, which SQLite would bind to NULL.
 *   Extra `.input()` values the statement doesn't use are allowed.
 * - Serialises access to the single handle (see ConnectionLock).
 */

import type { SqliteBindValue, SqliteDatabase } from './driver';
import type { DbType } from './column-types';
import { toBindValue } from './bind-values';

/** What a query gives back. Deliberately the `mssql` shape. */
export interface DbResult {
  /** Rows, as plain objects. Empty for a statement that returns none. */
  recordset: Record<string, unknown>[];
  /**
   * `[n]` — a one-element array, like `mssql`'s. For INSERT / UPDATE /
   * DELETE it is the number of rows changed; for a row-returning statement
   * it is the number of rows returned.
   */
  rowsAffected: number[];
}

// ---------------------------------------------------------------------------
// SQL Server error numbers, reproduced so the HTTP layer needs no changes
// ---------------------------------------------------------------------------

/** Violation of PRIMARY KEY / UNIQUE constraint -> HTTP 409. */
export const ERR_DUPLICATE_KEY = 2627;
/** FOREIGN KEY / CHECK constraint violation -> HTTP 409. */
export const ERR_CONSTRAINT_VIOLATION = 547;
/** Cannot insert NULL into a NOT NULL column. Routes don't classify it, so it surfaces as a 500. */
export const ERR_NULL_NOT_ALLOWED = 515;

/** Low byte of a SQLite extended result code identifying SQLITE_CONSTRAINT. */
const SQLITE_CONSTRAINT = 19;

/** Extended SQLITE_CONSTRAINT_* codes we can be specific about. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_NOTNULL = 1299;

/**
 * An error that came out of SQLite, re-dressed with the SQL Server error
 * number routes/db-error-response.ts classifies on.
 *
 * The original is kept on `originalError` and the SQLite codes on `errcode` /
 * `sqliteCode`, so a log line still says what actually happened.
 */
export class DbQueryError extends Error {
  readonly number?: number;
  readonly errcode?: number;
  /** The driver's own code. db/errors.ts reads `err.code` to detect a dead handle, so keep the name. */
  readonly code?: string;
  readonly originalError: unknown;

  constructor(message: string, original: unknown, sqlServerNumber?: number) {
    super(message);
    this.name = 'DbQueryError';
    this.originalError = original;
    if (sqlServerNumber !== undefined) this.number = sqlServerNumber;

    const source = original as { errcode?: unknown; code?: unknown } | null;
    if (source && typeof source.errcode === 'number') this.errcode = source.errcode;
    if (source && typeof source.code === 'string') this.code = source.code;
  }
}

/** The error for a closed handle. Uses ERR_INVALID_STATE (as node:sqlite does) so db/errors.ts classifies it by code. */
function closedConnectionError(): DbQueryError {
  return new DbQueryError('The database connection is closed.', {
    code: 'ERR_INVALID_STATE',
  });
}

/**
 * Maps a SQLite failure onto the SQL Server error number with the same
 * meaning. Unrecognised errors get no number and become a 500.
 */
export function translateSqliteError(err: unknown): DbQueryError {
  const message = err instanceof Error ? err.message : String(err);
  const errcode = (err as { errcode?: unknown } | null)?.errcode;

  if (typeof errcode !== 'number') return new DbQueryError(message, err);

  if ((errcode & 0xff) !== SQLITE_CONSTRAINT) return new DbQueryError(message, err);

  switch (errcode) {
    case SQLITE_CONSTRAINT_UNIQUE:
    case SQLITE_CONSTRAINT_PRIMARYKEY:
      return new DbQueryError(message, err, ERR_DUPLICATE_KEY);
    case SQLITE_CONSTRAINT_NOTNULL:
      return new DbQueryError(message, err, ERR_NULL_NOT_ALLOWED);
    case SQLITE_CONSTRAINT_FOREIGNKEY:
    default:
      // CHECK, FOREIGN KEY, TRIGGER, ROWID and the rest all mean "this
      // conflicts with a rule the database enforces", which is the 409.
      return new DbQueryError(message, err, ERR_CONSTRAINT_VIOLATION);
  }
}

// ---------------------------------------------------------------------------
// Statement inspection
// ---------------------------------------------------------------------------

/**
 * Replaces SQL comments and string literals with spaces, so the statement
 * and parameter checks below don't match text inside them.
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // '' inside a '...' is an escaped quote, not the end.
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }

    if (ch === '[') {
      // A bracketed identifier. SQLite accepts them for compatibility.
      while (i < sql.length && sql[i] !== ']') i++;
      i++;
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** How many statements a query string contains. A trailing `;` does not
 *  start a new one, and neither does a run of whitespace between two. */
export function countStatements(sql: string): number {
  const bare = stripLiteralsAndComments(sql);
  return bare
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/** Every `@name` the statement actually references, de-duplicated. */
export function parameterNamesIn(sql: string): string[] {
  const bare = stripLiteralsAndComments(sql);
  const found = new Set<string>();
  const pattern = /@([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(bare)) !== null) found.add(match[1]);
  return [...found];
}

// ---------------------------------------------------------------------------
// The serialising lock
// ---------------------------------------------------------------------------

/**
 * FIFO async mutex: one statement or transaction on the handle at a time.
 * Without it, another request's statements could run inside (and be
 * committed by) a transaction that is between awaited steps.
 */
class ConnectionLock {
  private tail: Promise<void> = Promise.resolve();

  /** Waits for the lock, then returns the function that releases it. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.tail;
    this.tail = this.tail.then(() => mine);
    await previous;
    return release;
  }
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/** The single open SQLite database. Retry and reopen logic lives in db/pool.ts. */
export class DbConnection {
  /** The transaction currently holding the lock, if any. */
  private activeTransaction: DbTransaction | null = null;
  private readonly lock = new ConnectionLock();
  private closed = false;

  constructor(private readonly database: SqliteDatabase) {}

  /** A new request bound to this connection (no transaction). */
  request(): DbRequest {
    return new DbRequest(this);
  }

  /** Closes the handle. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ----- internals used by DbRequest / DbTransaction ---------------------

  /** @internal */
  execute(sql: string, parameters: Record<string, SqliteBindValue>): DbResult {
    if (this.closed) {
      throw closedConnectionError();
    }

    let statement;
    try {
      statement = this.database.prepare(sql);
    } catch (err) {
      throw translateSqliteError(err);
    }

    try {
      // columns() is non-empty only for statements that return rows (SELECT or RETURNING).
      const producesRows = statement.columns().length > 0;

      if (!producesRows) {
        const outcome = statement.run(parameters);
        return { recordset: [], rowsAffected: [Number(outcome.changes)] };
      }

      // Rows arrive as null-prototype objects; copy them into plain objects.
      const rows = statement.all(parameters).map((row) => Object.assign({}, row));
      return { recordset: rows, rowsAffected: [rows.length] };
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  /** @internal Runs BEGIN / COMMIT / ROLLBACK. */
  control(keyword: string): void {
    if (this.closed) {
      throw closedConnectionError();
    }
    try {
      this.database.exec(keyword);
    } catch (err) {
      throw translateSqliteError(err);
    }
  }

  /** @internal */
  async withLock<T>(work: () => T): Promise<T> {
    const release = await this.lock.acquire();
    try {
      return work();
    } finally {
      release();
    }
  }

  /** @internal */
  acquireLock(): Promise<() => void> {
    return this.lock.acquire();
  }

  /** @internal */
  get currentTransaction(): DbTransaction | null {
    return this.activeTransaction;
  }

  /** @internal */
  set currentTransaction(transaction: DbTransaction | null) {
    this.activeTransaction = transaction;
  }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * A transaction. begin() takes the connection lock and commit()/rollback()
 * release it, so every transaction must end in one of them or the handle
 * stays locked. Callers wrap it in try/catch with safeRollback().
 */
export class DbTransaction {
  private releaseLock: (() => void) | null = null;
  private state: 'new' | 'active' | 'finished' = 'new';

  constructor(readonly connection: DbConnection) {}

  get isActive(): boolean {
    return this.state === 'active';
  }

  async begin(): Promise<void> {
    if (this.state !== 'new') {
      throw new DbQueryError('This transaction has already been started.', null);
    }

    const release = await this.connection.acquireLock();
    try {
      // IMMEDIATE takes the write lock up front, so a clash with the backup job fails at BEGIN, not midway.
      this.connection.control('BEGIN IMMEDIATE');
    } catch (err) {
      release();
      throw err;
    }

    this.releaseLock = release;
    this.state = 'active';
    this.connection.currentTransaction = this;
  }

  async commit(): Promise<void> {
    this.finish('COMMIT');
  }

  async rollback(): Promise<void> {
    this.finish('ROLLBACK');
  }

  private finish(keyword: 'COMMIT' | 'ROLLBACK'): void {
    if (this.state !== 'active') {
      // Same message as mssql. safeRollback() keeps this from masking the original error.
      throw new DbQueryError('No transaction is active.', null);
    }

    try {
      this.connection.control(keyword);
    } finally {
      this.state = 'finished';
      this.connection.currentTransaction = null;
      this.releaseLock?.();
      this.releaseLock = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** One recorded parameter binding. */
export interface BoundParameter {
  readonly type: DbType;
  readonly value: unknown;
}

/** What an observer is told about one executed statement. */
export interface QueryEvent {
  readonly sql: string;
  /** Every `.input()` on the request, in binding order — including any the
   *  statement does not actually name. */
  readonly parameters: ReadonlyArray<{ name: string } & BoundParameter>;
  readonly inTransaction: boolean;
}

export type QueryObserver = (event: QueryEvent) => void;

let queryObserver: QueryObserver | null = null;

/**
 * Registers a callback invoked with every statement before it runs; pass
 * `null` to remove it. Used by specs that assert which columns a generated
 * statement names.
 */
export function setQueryObserver(observer: QueryObserver | null): void {
  queryObserver = observer;
}

/** A chainable request: `.input(...).input(...).query(sql)`. */
export class DbRequest {
  private readonly parameters = new Map<string, BoundParameter>();
  private readonly connection: DbConnection;
  private readonly transaction: DbTransaction | null;

  constructor(target: DbConnection | DbTransaction) {
    if (target instanceof DbTransaction) {
      this.transaction = target;
      this.connection = target.connection;
    } else {
      this.transaction = null;
      this.connection = target;
    }
  }

  /** Binds one parameter. Conversion happens in query(), so conversion and query errors throw from the same place. */
  input(name: string, type: DbType, value: unknown): this {
    this.parameters.set(name, { type, value });
    return this;
  }

  /** The bound parameter names, in binding order. Used by the test harness. */
  get boundParameterNames(): string[] {
    return [...this.parameters.keys()];
  }

  async query(sql: string): Promise<DbResult> {
    if (queryObserver) {
      queryObserver({
        sql,
        parameters: [...this.parameters].map(([name, bound]) => ({ name, ...bound })),
        inTransaction: this.transaction !== null,
      });
    }

    const statements = countStatements(sql);
    if (statements === 0) {
      throw new DbQueryError('An empty statement was passed to query().', null);
    }
    if (statements > 1) {
      throw new DbQueryError(
        `query() was given ${statements} statements. SQLite's prepare() compiles the ` +
          `first and silently discards the rest, so a batch would half-execute and ` +
          `report success. Use a DbTransaction and one query() call per statement.`,
        null
      );
    }

    const required = parameterNamesIn(sql);
    const missing = required.filter((name) => !this.parameters.has(name));
    if (missing.length > 0) {
      throw new DbQueryError(
        `The statement references @${missing.join(', @')} but ${
          missing.length === 1 ? 'it was' : 'they were'
        } never bound with .input(). SQLite would bind ${
          missing.length === 1 ? 'it' : 'them'
        } to NULL and return the wrong rows.`,
        null
      );
    }

    // Convert only the parameters the statement uses. Extra .input() calls are
    // ignored (routes/coins/writes.ts binds all COIN_FIELDS and names only some).
    const bound: Record<string, SqliteBindValue> = {};
    for (const name of required) {
      const parameter = this.parameters.get(name)!;
      bound[name] = toBindValue(name, parameter.type, parameter.value);
    }

    if (this.transaction) {
      if (!this.transaction.isActive) {
        throw new DbQueryError(
          'This request is bound to a transaction that is not active. Call begin() first, ' +
            'and do not reuse a request after commit() or rollback().',
          null
        );
      }
      // The transaction already holds the connection lock; taking it again
      // here would deadlock.
      return this.connection.execute(sql, bound);
    }

    return this.connection.withLock(() => this.connection.execute(sql, bound));
  }
}
