/**
 * db/connection.spec.ts — tests for the connection half of the database
 * layer: db/config.ts, db/pool.ts and db/errors.ts.
 *
 * ============================================================
 * *** A TEST WAS DELETED FROM THIS FILE. READ THIS BEFORE ASKING WHERE THE
 * CRASH REGRESSION WENT. ***
 * ============================================================
 *
 * This file used to open with the sentence "If you only read one spec in this
 * project, read the crash regression below", and the describe it pointed at
 * was `connection pool error handling (crash regression)`. It is gone, and it
 * was removed on purpose rather than ported.
 *
 * WHAT THE CRASH WAS. `mssql`'s ConnectionPool is a Node EventEmitter. When
 * SQL Server dropped or errored an idle pooled connection, mssql called
 * `pool.emit('error', err)`. A Node EventEmitter with ZERO 'error' listeners
 * THROWS when 'error' is emitted on it, and that throw happened inside an
 * internal socket callback where nothing could catch it — so it became an
 * uncaught exception and killed the whole Express process, with nothing in
 * app.log because the process died before any logging ran. The fix was one
 * `pool.on('error', ...)` listener attached before `connect()`, and the test
 * emitted 'error' on the pool and asserted nothing threw.
 *
 * WHY IT CANNOT BE PORTED. Every noun in that paragraph is gone. There is no
 * pool, because SQLite is a file and a second handle on the same file buys
 * contention rather than throughput. There is no socket, so there is nothing
 * to drop. There is no EventEmitter anywhere in db/, so there is no
 * emit-with-no-listener rule to violate. The failure the test guarded against
 * is not merely unlikely now — it is unreachable.
 *
 * WHY NOT KEEP A VERSION OF IT ANYWAY. Because the only way to keep it would
 * have been to give `DbConnection` an EventEmitter it does not otherwise
 * need, emit 'error' on it from the test, and assert that nothing threw —
 * a test that exercises scaffolding built for the test. That is a comment
 * pretending to be code, and it would read to the next person as evidence
 * that a real hazard is covered.
 *
 * WHAT SURVIVED, AND WHY. Everything else in db/pool.ts was kept, because
 * the reasons for it outlive the engine, and all of it is tested below:
 * single-flight opening, the generation counter, the absence of a
 * per-request health check, and withDb()'s one retry for connection-class
 * errors only. See the header of db/pool.ts.
 *
 * ============================================================
 *
 * Note this file deliberately does NOT import the Express app — everything
 * here is exercised through the db/ API directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

import {
  rebuildTestDatabase,
  executedSql,
  withTestDb,
} from '../test-support/sqlite-test-db';

import {
  buildDbConfig,
  getPool,
  resetPool,
  withDb,
  isConnectionError,
  DB_PATH_ENV_VAR,
  DB_DIR_ENV_VAR,
  resolveDataDirectory,
} from './index';
import { BUSY_TIMEOUT_MS, DATABASE_FILE_NAME, DATA_DIR_NAME, IN_MEMORY_DATABASE } from './config';

/**
 * Runs `work` with some environment variables set, then puts every one of
 * them back exactly as it was — including COIN_INVENTORY_DB_PATH, which the
 * harness relies on to keep the suite off the owner's real collection.
 */
function withEnv(values: Record<string, string | undefined>, work: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) previous.set(key, process.env[key]);

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('buildDbConfig — where the database file lives', () => {
  it('puts the database under %LOCALAPPDATA%\\CoinInventory by default', () => {
    // Design §4.10a. NOT the install directory: Program Files is not writable
    // by a standard user, so a database there fails to open for writing on an
    // ordinary run — and fails intermittently, because an admin install
    // followed by a standard-user launch is the common case.
    withEnv(
      { [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: undefined, LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      () => {
        const config = buildDbConfig();
        expect(config.directory).toBe(path.join('C:\\Users\\x\\AppData\\Local', DATA_DIR_NAME));
        expect(config.file).toBe(path.join(config.directory as string, DATABASE_FILE_NAME));
      }
    );
  });

  it('never puts the database inside the install directory', () => {
    // The property that makes §4.7's "uninstall must not remove the
    // collection silently" structurally true rather than a promise.
    withEnv(
      { [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: undefined, LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      () => {
        expect(buildDbConfig().file.toLowerCase()).not.toContain('program files');
        expect(buildDbConfig().file).not.toContain(__dirname);
      }
    );
  });

  it('falls back to the home directory when LOCALAPPDATA is not set', () => {
    // A stripped environment or a CI container must still start, and the
    // data must still land outside the install directory.
    withEnv({ [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: undefined, LOCALAPPDATA: undefined }, () => {
      expect(resolveDataDirectory()).toBe(path.join(os.homedir(), '.coininventory'));
    });
  });

  it('is overridable by COIN_INVENTORY_DB_PATH, which is what keeps the suite off the real file', () => {
    // Every spec in this project now runs against a real database. Without
    // this override the suite would open — and the harness would truncate —
    // the owner's actual collection on every `npm test`.
    withEnv({ [DB_PATH_ENV_VAR]: IN_MEMORY_DATABASE }, () => {
      const config = buildDbConfig();
      expect(config.file).toBe(IN_MEMORY_DATABASE);
      expect(config.directory).toBeNull();
    });

    withEnv({ [DB_PATH_ENV_VAR]: 'D:\\elsewhere\\coins.db' }, () => {
      const config = buildDbConfig();
      expect(config.file).toBe(path.resolve('D:\\elsewhere\\coins.db'));
      expect(config.directory).toBe(path.resolve('D:\\elsewhere'));
    });
  });

  it('is overridable by COIN_INVENTORY_DATA_DIR, keeping the default file name', () => {
    withEnv({ [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: 'D:\\collections\\roman' }, () => {
      const config = buildDbConfig();
      expect(config.directory).toBe(path.resolve('D:\\collections\\roman'));
      expect(config.file).toBe(path.resolve('D:\\collections\\roman', DATABASE_FILE_NAME));
    });
  });

  it('always asks for foreign key enforcement, and for a bounded lock wait', () => {
    // *** THE MOST IMPORTANT LINE IN THE CONFIG. *** SQLite's foreign key
    // enforcement is OFF by default at the C-library level, per connection.
    // If this is ever false, every FOREIGN KEY in db/schema.sql becomes
    // decorative and nothing in the application notices.
    withEnv({ [DB_PATH_ENV_VAR]: IN_MEMORY_DATABASE }, () => {
      expect(buildDbConfig().enableForeignKeyConstraints).toBe(true);
      expect(buildDbConfig().busyTimeoutMs).toBe(BUSY_TIMEOUT_MS);
    });
  });
});

describe('foreign keys are enforced on the live connection', () => {
  // Asserting the config is not the same as asserting the connection. This
  // reads the pragma off the handle the routes actually use.
  it('reports PRAGMA foreign_keys = 1', async () => {
    const [row] = await withTestDb((database) => database.prepare('PRAGMA foreign_keys').all());
    expect(row['foreign_keys']).toBe(1);
  });

  it('actually refuses a child row whose parent does not exist', async () => {
    await expect(
      withTestDb((database) => {
        database
          .prepare('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (?, ?, 0)')
          .run('no-such-coin', 'data:image/png;base64,a');
      })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('opening the database (single-flight, generation-guarded)', () => {
  afterEach(async () => {
    await rebuildTestDatabase();
  });

  it('shares a single open attempt between concurrent callers (single-flight)', async () => {
    await resetPool();

    // The Angular app fires ~7 requests in parallel on load. Without the
    // single-flight guard each of them saw "no handle", and each one opened
    // the file, applied the schema and ran the 1,274-row seed — seven times,
    // concurrently, against one database.
    const connections = await Promise.all([
      getPool(), getPool(), getPool(), getPool(), getPool(), getPool(), getPool(),
    ]);

    expect(new Set(connections).size).toBe(1);
  });

  it('hands back the same connection on a second call rather than reopening', async () => {
    await resetPool();
    const first = await getPool();
    const second = await getPool();
    expect(second).toBe(first);
    expect(first.isClosed).toBe(false);
  });

  it('opens a genuinely new database after an unconditional reset', async () => {
    const before = await getPool();
    await before.request().query("INSERT INTO Categories (CategoryName) SELECT 'Reset Marker' WHERE NOT EXISTS (SELECT 1 FROM Categories WHERE CategoryName = 'Reset Marker')");

    await resetPool();
    expect(before.isClosed).toBe(true);

    const after = await getPool();
    expect(after).not.toBe(before);
    // A fresh `:memory:` database is a different database, so the marker is
    // gone and the seed has run again.
    const rows = await after
      .request()
      .query("SELECT CategoryName FROM Categories WHERE CategoryName = 'Reset Marker'");
    expect(rows.recordset).toEqual([]);
  });

  it('ignores a stale generation reset so a late failure cannot close a fresh handle', async () => {
    await resetPool();
    const live = await getPool();

    // Generation 1 (or whatever we are up to) is live. A request that started
    // on an older generation asks us to reset generation 0 — that must be a
    // no-op, or a slow failure would take down a handle opened after it.
    await resetPool(0);

    expect(live.isClosed).toBe(false);
    expect(await getPool()).toBe(live);
  });

  it('does not run a health check on every request', async () => {
    await resetPool();
    await getPool();

    const before = executedSql().length;
    await getPool();

    // The old getPool() issued 'SELECT 1' before handing back the pool,
    // doubling round trips and racing with in-flight queries. Here it would
    // also be pointless: the "connection" is a file descriptor.
    expect(executedSql().length).toBe(before);
  });
});

describe('isConnectionError', () => {
  it('recognises SQLite result codes that mean the handle is unusable', () => {
    // 5 BUSY, 6 LOCKED, 10 IOERR, 11 CORRUPT, 14 CANTOPEN, 26 NOTADB.
    for (const errcode of [5, 6, 10, 11, 14, 26]) {
      const err = Object.assign(new Error('nope'), { code: 'ERR_SQLITE_ERROR', errcode });
      expect(isConnectionError(err), String(errcode)).toBe(true);
    }
  });

  it('masks EXTENDED result codes down to their primary code', () => {
    // SQLite returns extended codes whose low byte is the primary one:
    // SQLITE_IOERR_READ is 266 and 266 & 0xFF is 10, SQLITE_CANTOPEN_ISDIR
    // is 526 and 526 & 0xFF is 14. A check that compared the whole number
    // would miss every one of them — which is most of them in practice.
    for (const errcode of [266, 526, 3338, 1038]) {
      const err = Object.assign(new Error('nope'), { code: 'ERR_SQLITE_ERROR', errcode });
      expect(isConnectionError(err), String(errcode)).toBe(true);
    }
  });

  it('recognises a closed handle by its Node code, not only by its wording', () => {
    // db/sql-api.ts builds this error with ERR_INVALID_STATE deliberately,
    // so the 503 does not depend on a sentence somebody could reword.
    expect(isConnectionError(Object.assign(new Error('whatever'), { code: 'ERR_INVALID_STATE' }))).toBe(true);
  });

  it('recognises connection failures by message as a last resort', () => {
    expect(isConnectionError(new Error('database is not open'))).toBe(true);
    expect(isConnectionError(new Error('unable to open database file'))).toBe(true);
  });

  it('does NOT treat a read-only database as a transient connection fault', () => {
    // SQLITE_READONLY (8) is deliberately absent from the set. Reopening a
    // read-only file changes nothing, and withDb()'s retry would run the
    // caller's work — including its writes — a second time for nothing.
    const err = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 8,
    });
    expect(isConnectionError(err)).toBe(false);
  });

  it('is conservative: ordinary query errors are NOT connection errors', () => {
    // If this ever returns true we would close a healthy database AND re-run
    // the caller's writes because of a constraint violation.
    const constraintViolation = Object.assign(new Error('UNIQUE constraint failed: Coins.CoinId'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 2067,
      number: 2627,
    });
    expect(isConnectionError(constraintViolation)).toBe(false);
    expect(isConnectionError(new Error('no such column: Nonsense'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });

  it('classifies a real constraint violation from the engine as NOT a connection error', () => {
    // The same claim, but driven by an error the database itself produced
    // rather than one this file invented. The two must agree, or the
    // hand-built fixtures above are testing a vocabulary nothing speaks.
    return withTestDb((database) => {
      database.prepare("INSERT INTO Categories (CategoryName) VALUES ('Clash')").run();
      try {
        database.prepare("INSERT INTO Categories (CategoryName) VALUES ('Clash')").run();
        throw new Error('expected a duplicate key error');
      } catch (err) {
        expect((err as { errcode?: number }).errcode).toBeDefined();
        expect(isConnectionError(err)).toBe(false);
      }
    });
  });
});

describe('withDb', () => {
  afterEach(async () => {
    await rebuildTestDatabase();
  });

  it('retries exactly once on a connection-class error', async () => {
    const work = vi_fn()
      .onceReject(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }))
      .thenResolve('second attempt');

    await expect(withDb(work.fn)).resolves.toBe('second attempt');
    expect(work.calls).toBe(2);
  });

  it('does NOT retry — and does not close the database — on an ordinary query error', async () => {
    const live = await getPool();

    const queryError = Object.assign(new Error('UNIQUE constraint failed'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 2067,
      number: 2627,
    });
    const work = vi_fn().alwaysReject(queryError);

    await expect(withDb(work.fn)).rejects.toBe(queryError);
    expect(work.calls).toBe(1);
    // The shared connection must survive an ordinary query failure. Closing
    // it would break every other request in flight, which is the defect the
    // whole layer was reorganised to remove.
    expect(live.isClosed).toBe(false);
    expect(await getPool()).toBe(live);
  });

  it('gives up after the single retry rather than looping', async () => {
    const persistent = Object.assign(new Error('disk I/O error'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 10,
    });
    const work = vi_fn().alwaysReject(persistent);

    await expect(withDb(work.fn)).rejects.toBe(persistent);
    expect(work.calls).toBe(2);
  });
});

/**
 * A tiny hand-rolled call recorder.
 *
 * `vi.fn().mockRejectedValueOnce(...)` would do, but these three tests are
 * about how many times withDb() invokes its callback, and spelling that out
 * in six lines is clearer than three chained mock verbs.
 */
function vi_fn() {
  const state = {
    calls: 0,
    onceError: undefined as unknown,
    alwaysError: undefined as unknown,
    resolveWith: undefined as unknown,
    fn: async (): Promise<unknown> => undefined,
  };

  state.fn = async () => {
    state.calls += 1;
    if (state.alwaysError !== undefined) throw state.alwaysError;
    if (state.calls === 1 && state.onceError !== undefined) throw state.onceError;
    return state.resolveWith;
  };

  const api = {
    get calls() {
      return state.calls;
    },
    fn: state.fn,
    onceReject(error: unknown) {
      state.onceError = error;
      return api;
    },
    alwaysReject(error: unknown) {
      state.alwaysError = error;
      return api;
    },
    thenResolve(value: unknown) {
      state.resolveWith = value;
      return api;
    },
  };

  return api;
}
