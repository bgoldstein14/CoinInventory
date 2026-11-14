/**
 * db/sql-api.ts — the request-shaped API the twenty route modules already
 * speak, implemented over SQLite.
 *
 *     const rows = await withDb(async (db) => {
 *       const result = await db.request()
 *         .input('id', DB_BINDINGS.coinId, id)
 *         .query('SELECT * FROM Coins WHERE CoinId = @id');
 *       return result.recordset;
 *     });
 *
 * *** WHY THE SHAPE WAS PRESERVED RATHER THAN REPLACED. *** There are 82
 * `.input(...)` bindings across 15 route modules, every one of them annotated
 * with why it binds the type it binds. A different data-layer API would have
 * meant editing every one of those call sites — a change with a very large
 * blast radius, no behavioural benefit, and a merge conflict with every other
 * piece of work in flight. Keeping the shape means a route changes ONLY where
 * the SQL dialect genuinely differs, and those sites are enumerated in
 * docs/superpowers/plans/2026-11-13-sqlite-migration.md.
 *
 * WHAT THIS LAYER DOES THAT `mssql` DID
 *
 *   - converts and validates every bound value (db/bind-values.ts)
 *   - translates SQLite's errors into the SQL Server error numbers
 *     routes/db-error-response.ts already classifies, so the HTTP layer is
 *     untouched by the engine change
 *   - gives `recordset` / `rowsAffected` their familiar shapes
 *
 * WHAT IT DOES THAT `mssql` DID NOT, AND WHY
 *
 *   - REFUSES A MULTI-STATEMENT QUERY. `node:sqlite`'s prepare() compiles the
 *     FIRST statement of a string and DISCARDS THE REST SILENTLY. A batch
 *     that reads `UPDATE a; UPDATE b;` would run half of itself and report
 *     success. That is the single worst failure mode available here, so a
 *     query containing more than one statement is rejected outright and the
 *     caller is told to use an explicit transaction.
 *
 *   - REFUSES A STATEMENT WITH AN UNBOUND PARAMETER. SQLite binds a named
 *     parameter nobody supplied to NULL and runs happily, so a typo in
 *     `WHERE CoinId = @coinid` becomes "no rows" rather than an error.
 *     `mssql` threw. Every `@name` in the statement must have been `.input()`
 *     first. The reverse is allowed — an `.input()` the statement does not
 *     mention is ignored, which routes/coins/writes.ts relies on.
 *
 *   - SERIALISES ACCESS. `mssql` handed each `sql.Transaction` its own
 *     pooled connection. There is one SQLite handle, and SQLite has no
 *     nested transactions: without a lock, two concurrent POSTs would
 *     interleave BEGIN/COMMIT on the same handle and one request would
 *     commit the other's half-finished work. See DbTransaction below.
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
/** Cannot insert NULL into a NOT NULL column. SQL Server's number; like SQL
 *  Server, it is not in any of the route classifier's sets, so it surfaces as
 *  a 500 — a NOT NULL violation is a server bug, not bad user input. */
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
  /**
   * The driver's own code, carried through UNDER ITS OWN NAME.
   *
   * It would be tidier to rename this to something like `sqliteCode` — and
   * doing so is a silent bug. db/errors.ts asks `err.code` when deciding
   * whether a handle is dead, and EVERY error a route sees has been through
   * this constructor; renaming the property makes that branch unreachable
   * and leaves a closed database recognisable only by the wording of its
   * message. Keep the name.
   */
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

/**
 * The error raised when the handle is gone.
 *
 * Built in one place and given `ERR_INVALID_STATE` explicitly — the same code
 * `node:sqlite` uses for a method call on a closed database — so that
 * db/errors.ts classifies it as a connection failure by its CODE rather than
 * by matching its wording. A 503 that depends on a sentence nobody can
 * safely reword is not a guarantee.
 */
function closedConnectionError(): DbQueryError {
  return new DbQueryError('The database connection is closed.', {
    code: 'ERR_INVALID_STATE',
  });
}

/**
 * Maps a SQLite failure onto the SQL Server error number with the same
 * meaning. Anything unrecognised gets no number at all, which is how it
 * reaches the generic 500 branch — exactly as an unrecognised `mssql` error
 * did.
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
 * Strips SQL comments and string literals, replacing each with a space.
 *
 * Both of the checks below — "how many statements is this?" and "which
 * parameters does it name?" — are wrong if they look inside a quoted string
 * or a comment. `WHERE Notes = ';'` is one statement, and the `@` in a
 * comment that reads `-- bind @id here` is not a parameter.
 *
 * Exported for direct unit testing.
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
 * A FIFO async mutex. One SQLite handle, one statement at a time.
 *
 * This is not about SQLite's own thread safety — `DatabaseSync` is
 * synchronous, so a single statement cannot be interrupted. It is about
 * TRANSACTIONS. A transaction is BEGIN, then an unbounded number of awaited
 * steps, then COMMIT; between those steps Node is free to run another HTTP
 * request's handler, and on one connection that request would be executing
 * inside — and could be committed or rolled back by — a transaction it knows
 * nothing about. `mssql` could not have this problem because each
 * `sql.Transaction` took its own pooled connection.
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

/**
 * One open database, standing in for `mssql`'s ConnectionPool.
 *
 * Named `DbConnection` rather than `DbPool` because there is nothing pooled
 * about it: SQLite is a file, and a second handle on the same file buys
 * contention rather than throughput. The things the old pool existed to
 * manage — a warm connection, a retry, a generation counter — live in
 * db/pool.ts and still do, because a file handle can still go bad.
 */
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
      // `columns()` is empty for a statement that produces no result set
      // (INSERT without RETURNING, UPDATE, DELETE, DDL) and non-empty for a
      // SELECT or a RETURNING clause. It is how we know which of the two
      // execution paths — and which of the two meanings of `rowsAffected` —
      // applies, without parsing the SQL.
      const producesRows = statement.columns().length > 0;

      if (!producesRows) {
        const outcome = statement.run(parameters);
        return { recordset: [], rowsAffected: [Number(outcome.changes)] };
      }

      // Rows arrive as null-prototype objects. Copying them into ordinary
      // objects costs a shallow clone per row and spares every consumer —
      // including `expect(...).toEqual(...)` — from having to care.
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
 * Stands in for `new sql.Transaction(db)`.
 *
 * `begin()` TAKES THE CONNECTION LOCK and `commit()` / `rollback()` release
 * it, so a transaction is the only thing running on the handle for its whole
 * life. The consequence a caller must respect: every transaction must be
 * committed or rolled back, or nothing else will ever run. Both route modules
 * that open one do so in a try/catch whose catch calls safeRollback(); do not
 * write a third that does not.
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
      // IMMEDIATE rather than DEFERRED: it takes the write lock up front, so
      // a transaction that is going to collide with the backup job does so at
      // BEGIN rather than half way through, where the application would have
      // to unwind work it had already reported as done.
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
      // Matches `mssql`, which throws "No transaction is active". The reason
      // safeRollback() in routes/coins/write-helpers.ts exists is that this
      // throw must never replace the error that caused the rollback.
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
 * Registers a callback invoked with every statement before it runs. Pass
 * `null` to remove it.
 *
 * *** THIS EXISTS FOR THE TEST SUITE, AND THAT IS WORTH JUSTIFYING. ***
 * The specs run against a real in-memory SQLite database now, and most of
 * what they used to assert — "did this write the right row?" — they can now
 * assert by reading the row, which is strictly better. A handful of them
 * assert something a row cannot show: that the generated UPDATE NAMES a
 * particular column (db/denomination-column.spec.ts, db/catalog-columns.spec.ts).
 * A column missing from a generated statement produces a 200, no error
 * anywhere, and a value that is gone on the next reload; those specs exist
 * because that failure is invisible from the outside.
 *
 * The alternative to these three lines was a second fake database to inspect
 * — which is how the hand-written mssql mock came to exist, and what this
 * work is removing. A null-by-default hook is the smaller cost. It is also
 * the natural place a slow-query log would go if one is ever wanted.
 */
export function setQueryObserver(observer: QueryObserver | null): void {
  queryObserver = observer;
}

/**
 * Stands in for `pool.request()` and for `new sql.Request(transaction)`.
 *
 * Chainable, exactly as before: `.input(...).input(...).query(sql)`.
 */
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

  /**
   * Binds one parameter.
   *
   * The value is NOT converted here. It is converted at `query()` time, so
   * that a conversion failure is thrown from the same place a query failure
   * is and the route's single try/catch sees both.
   */
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

    // Convert only the parameters the statement actually uses. An extra
    // `.input()` is ignored (routes/coins/writes.ts binds the whole
    // COIN_FIELDS map and then names only the supplied columns) — and
    // ignoring it means an unused binding's value is never validated, which
    // is the same thing SQL Server did with an unreferenced parameter.
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
