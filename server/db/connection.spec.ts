/**
 * Tests for the connection side of the database layer: db/config.ts,
 * db/pool.ts and db/errors.ts. Exercised through the db/ API directly, without
 * the Express app.
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
 * Runs `work` with some environment variables set, then restores them all,
 * including COIN_INVENTORY_DB_PATH, which keeps the suite off real data.
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
    // Not the install directory: Program Files isn't writable by a standard user.
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
    withEnv(
      { [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: undefined, LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      () => {
        expect(buildDbConfig().file.toLowerCase()).not.toContain('program files');
        expect(buildDbConfig().file).not.toContain(__dirname);
      }
    );
  });

  it('falls back to the home directory when LOCALAPPDATA is not set', () => {
    // A stripped environment must still start, with data outside the install directory.
    withEnv({ [DB_PATH_ENV_VAR]: undefined, [DB_DIR_ENV_VAR]: undefined, LOCALAPPDATA: undefined }, () => {
      expect(resolveDataDirectory()).toBe(path.join(os.homedir(), '.coininventory'));
    });
  });

  it('is overridable by COIN_INVENTORY_DB_PATH, which is what keeps the suite off the real file', () => {
    // Without this override the suite would open the real collection.
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
    // SQLite leaves foreign keys off by default; without this every FOREIGN KEY is ignored.
    withEnv({ [DB_PATH_ENV_VAR]: IN_MEMORY_DATABASE }, () => {
      expect(buildDbConfig().enableForeignKeyConstraints).toBe(true);
      expect(buildDbConfig().busyTimeoutMs).toBe(BUSY_TIMEOUT_MS);
    });
  });
});

describe('foreign keys are enforced on the live connection', () => {
    // Reads the pragma off the handle the routes actually use.
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

    // The app fires several requests in parallel on load; they must share one open.
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
    // A fresh :memory: database is a different database, so the seed ran again.
    const rows = await after
      .request()
      .query("SELECT CategoryName FROM Categories WHERE CategoryName = 'Reset Marker'");
    expect(rows.recordset).toEqual([]);
  });

  it('ignores a stale generation reset so a late failure cannot close a fresh handle', async () => {
    await resetPool();
    const live = await getPool();

    // A reset for an older generation must be a no-op.
    await resetPool(0);

    expect(live.isClosed).toBe(false);
    expect(await getPool()).toBe(live);
  });

  it('does not run a health check on every request', async () => {
    await resetPool();
    await getPool();

    const before = executedSql().length;
    await getPool();

    // No per-request health check query.
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
    // Extended codes are masked to their low byte (266 & 0xFF = 10, 526 & 0xFF = 14).
    for (const errcode of [266, 526, 3338, 1038]) {
      const err = Object.assign(new Error('nope'), { code: 'ERR_SQLITE_ERROR', errcode });
      expect(isConnectionError(err), String(errcode)).toBe(true);
    }
  });

  it('recognises a closed handle by its Node code, not only by its wording', () => {
    // db/sql-api.ts uses ERR_INVALID_STATE so classification doesn't depend on message text.
    expect(isConnectionError(Object.assign(new Error('whatever'), { code: 'ERR_INVALID_STATE' }))).toBe(true);
  });

  it('recognises connection failures by message as a last resort', () => {
    expect(isConnectionError(new Error('database is not open'))).toBe(true);
    expect(isConnectionError(new Error('unable to open database file'))).toBe(true);
  });

  it('does NOT treat a read-only database as a transient connection fault', () => {
    // SQLITE_READONLY is excluded: retrying would rerun the caller's writes for nothing.
    const err = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 8,
    });
    expect(isConnectionError(err)).toBe(false);
  });

  it('is conservative: ordinary query errors are NOT connection errors', () => {
    // A true here would reopen a healthy database and rerun the caller's writes.
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
    // The same claim, using an error SQLite itself produced.
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
    // An ordinary query failure must not close the shared connection.
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

/** A minimal call recorder, for counting how many times withDb() calls back. */
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
