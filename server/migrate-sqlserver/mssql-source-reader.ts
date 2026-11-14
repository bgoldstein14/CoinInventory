/**
 * migrate-sqlserver/mssql-source-reader.ts — THE ONLY FILE IN THIS
 * REPOSITORY THAT TALKS TO SQL SERVER, AND THE ONLY ONE THAT MAY IMPORT
 * `mssql`.
 *
 * db/driver-isolation.spec.ts enforces that, in the same way and for the
 * same reason it enforces that only db/driver.ts names a SQLite package: a
 * rule that is not checked quietly stops being true.
 *
 * *** THIS FILE IS DELIBERATELY THIN AND DELIBERATELY UNTESTED. *** There is
 * no SQL Server reachable from the machine this was written on, so nothing
 * here can be proved by a spec; the honest response to that is to put as
 * little decision-making in it as possible. Every judgement the migration
 * makes — which columns must exist, which reference rows are the owner's,
 * how ids are remapped, what the verification compares — lives behind
 * `SourceReader` in files that fixtures can drive. What is left here is
 * connect, ask, hand back rows.
 *
 * READ-ONLY, AND WHAT THAT ACTUALLY MEANS
 *
 *   - `readOnlyIntent` is set in the login packet. On a standalone instance
 *     SQL Server ignores it; it costs nothing and it is the truthful thing
 *     to send.
 *   - EVERY statement goes through `assertReadOnlySql()` first — including
 *     the two INFORMATION_SCHEMA lookups. Nothing in this file builds SQL by
 *     concatenation: table and column names are bracketed by
 *     `quoteIdentifier()` after being matched against a strict identifier
 *     pattern, and the two parameterised lookups bind their arguments.
 *   - No transaction is opened, no temp table is created, no session setting
 *     is changed.
 *
 * That is a guarantee about this program. It is NOT a guarantee about the
 * login: `CoinApp` is db_owner (see create-sql-login.sql), so the server
 * would accept a write if something sent one. The owner can have the real
 * guarantee any time he wants it, with
 * `ALTER DATABASE CoinInventory SET READ_ONLY`, and the tool says so in its
 * banner rather than implying it has done it.
 *
 * STREAMING. `forEachRow` uses mssql's row-at-a-time mode. CoinImages is
 * ~2,140 base64 photographs in NVARCHAR(MAX); `request.query()` without
 * streaming would materialise all of them as one array and the first time
 * anyone found out would be on the owner's machine.
 */

import * as sql from 'mssql';

import {
  assertReadOnlySql,
  buildSelect,
  quoteIdentifier,
  type SourceColumn,
  type SourceQuery,
  type SourceReader,
  type SourceRow,
} from './source-reader';

/** How to reach the owner's SQL Server. */
export interface MssqlConnectionOptions {
  readonly server: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** TLS to the instance. Off by default: a local SQL Server Express
   *  usually has no certificate, and mssql v11 defaults this ON. */
  readonly encrypt: boolean;
  /** Seconds to wait for the login. */
  readonly connectionTimeoutMs: number;
}

/** Only the columns of INFORMATION_SCHEMA.COLUMNS this tool reads. */
interface InformationSchemaColumnRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
}

export class MssqlSourceReader implements SourceReader {
  private pool: sql.ConnectionPool | null = null;

  constructor(private readonly options: MssqlConnectionOptions) {}

  get description(): string {
    return (
      `SQL Server ${this.options.server}:${this.options.port}/${this.options.database} ` +
      `as ${this.options.user} (read-only intent, encrypt=${this.options.encrypt})`
    );
  }

  async open(): Promise<void> {
    if (this.pool) return;

    const pool = new sql.ConnectionPool({
      server: this.options.server,
      port: this.options.port,
      database: this.options.database,
      user: this.options.user,
      password: this.options.password,
      connectionTimeout: this.options.connectionTimeoutMs,
      // No request timeout. A full scan of the image table is slow and
      // finishing is worth more than a deadline; the operator is watching
      // the progress output and can press Ctrl-C.
      requestTimeout: 0,
      pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
      options: {
        encrypt: this.options.encrypt,
        // A local SQL Server Express has a self-signed certificate. Refusing
        // it would just mean the owner cannot run the migration at all.
        trustServerCertificate: true,
        // Says "I only intend to read" in the login packet. Ignored by a
        // standalone instance; still the truthful thing to send.
        readOnlyIntent: true,
      },
    });

    // The pool is an EventEmitter and an EventEmitter with no 'error'
    // listener THROWS when one is emitted — the exact failure db/pool.ts's
    // header records as having killed the Express process. One listener.
    pool.on('error', (err: unknown) => {
      process.stderr.write(`\n[source] connection pool error: ${String(err)}\n`);
    });

    await pool.connect();
    this.pool = pool;
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.close();
  }

  async tables(): Promise<string[]> {
    const statement =
      'SELECT TABLE_NAME AS [name] FROM INFORMATION_SCHEMA.TABLES ' +
      "WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = SCHEMA_NAME()";
    assertReadOnlySql(statement);

    const result = await this.request().query<{ name: string }>(statement);
    return result.recordset.map((row) => row.name);
  }

  async columns(table: string): Promise<SourceColumn[]> {
    // The table name is BOUND, not interpolated. It is validated anyway, so
    // that a name this tool would refuse to query never reaches the server
    // at all.
    quoteIdentifier(table);

    const statement =
      'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE ' +
      'FROM INFORMATION_SCHEMA.COLUMNS ' +
      'WHERE TABLE_SCHEMA = SCHEMA_NAME() AND TABLE_NAME = @table ' +
      'ORDER BY ORDINAL_POSITION';
    assertReadOnlySql(statement);

    const request = this.request();
    request.input('table', sql.NVarChar(128), table);
    const result = await request.query<InformationSchemaColumnRow>(statement);

    return result.recordset.map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE.toLowerCase(),
      maxLength: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
    }));
  }

  async count(table: string): Promise<number> {
    const statement = `SELECT COUNT(*) AS [n] FROM ${quoteIdentifier(table)}`;
    assertReadOnlySql(statement);

    const result = await this.request().query<{ n: number }>(statement);
    return Number(result.recordset[0]?.n ?? 0);
  }

  forEachRow(query: SourceQuery, onRow: (row: SourceRow) => void): Promise<number> {
    const statement = buildSelect(query);
    assertReadOnlySql(statement);

    const request = this.request();
    request.stream = true;

    return new Promise<number>((resolve, reject) => {
      let seen = 0;
      let callbackError: unknown = null;
      let settled = false;

      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const finish = (): void => {
        if (settled) return;
        if (callbackError !== null) {
          fail(callbackError);
          return;
        }
        settled = true;
        resolve(seen);
      };

      request.on('row', (row: SourceRow) => {
        if (callbackError !== null) return;
        seen += 1;
        try {
          // Synchronous on purpose. The write into SQLite is synchronous too
          // (node:sqlite has no async API), so blocking here IS the
          // backpressure: tedious cannot run ahead of the writer, and peak
          // memory stays at one row rather than one result set.
          onRow(row);
        } catch (err) {
          callbackError = err;
          request.cancel();
        }
      });

      request.on('error', fail);
      request.on('done', finish);

      // In streaming mode the promise resolves after 'done'; it is attached
      // so that a rejection which never reaches the 'error' event cannot
      // leave this hanging for ever.
      request.query(statement).then(finish, fail);
    });
  }

  private request(): sql.Request {
    if (!this.pool) {
      throw new Error('The SQL Server reader was used before open() was called.');
    }
    return this.pool.request();
  }
}
