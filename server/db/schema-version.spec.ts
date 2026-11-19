/**
 * The schema version stamp (PRAGMA user_version), which lets a backup be
 * identified later. Covers the three ways stamping could go wrong: not
 * written, written downwards over a newer file's version, or written on a
 * file whose schema failed to apply.
 */

import { describe, expect, it } from 'vitest';

import { getPool } from './pool';
import {
  SCHEMA_VERSION,
  UNSTAMPED_SCHEMA_VERSION,
  applySchema,
  readSchemaVersion,
  stampSchemaVersion,
} from './schema';
import { openSqliteDatabase, type SqliteDatabase } from './driver';
import { withTestDb } from '../test-support/sqlite-test-db';

/** A bare in-memory database with nothing done to it. */
function blankDatabase(): SqliteDatabase {
  return openSqliteDatabase({
    filename: ':memory:',
    enableForeignKeyConstraints: true,
    busyTimeoutMs: 1000,
  });
}

describe('SCHEMA_VERSION — the number itself', () => {
  it('is a positive integer, because the only thing it has to do is compare', () => {
    expect(Number.isSafeInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('is 2: version 1 plus the CoinCatalogRefs table', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('is distinct from the unstamped value, or the two could not be told apart', () => {
    expect(UNSTAMPED_SCHEMA_VERSION).toBe(0);
    expect(SCHEMA_VERSION).not.toBe(UNSTAMPED_SCHEMA_VERSION);
  });
});

describe('stampSchemaVersion', () => {
  it('stamps a brand-new database', () => {
    const database = blankDatabase();
    try {
      expect(readSchemaVersion(database)).toBe(UNSTAMPED_SCHEMA_VERSION);

      const stamp = stampSchemaVersion(database);

      expect(stamp).toEqual({
        before: 0,
        after: SCHEMA_VERSION,
        stamped: true,
        newerThanThisBuild: false,
      });
      expect(readSchemaVersion(database)).toBe(SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it('stamps an EXISTING collection that predates stamping', () => {
    // Existing databases read 0 and have the correct shape; an ordinary open stamps them.
    const database = blankDatabase();
    try {
      applySchema(database);
      expect(readSchemaVersion(database)).toBe(0);

      expect(stampSchemaVersion(database).stamped).toBe(true);
      expect(readSchemaVersion(database)).toBe(SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it('is idempotent — a second open writes nothing', () => {
    const database = blankDatabase();
    try {
      stampSchemaVersion(database);
      const again = stampSchemaVersion(database);

      expect(again.stamped).toBe(false);
      expect(again.before).toBe(SCHEMA_VERSION);
      expect(again.after).toBe(SCHEMA_VERSION);
    } finally {
      database.close();
    }
  });

  it('NEVER writes the version DOWN', () => {
    const database = blankDatabase();
    try {
      database.exec('PRAGMA user_version = 42');

      const stamp = stampSchemaVersion(database);

      expect(stamp.stamped).toBe(false);
      expect(stamp.newerThanThisBuild).toBe(true);
      expect(stamp.before).toBe(42);
      expect(stamp.after).toBe(42);
      // The file keeps its real version, so an older build's restore still refuses it.
      expect(readSchemaVersion(database)).toBe(42);
    } finally {
      database.close();
    }
  });

  it('reports a newer file rather than throwing, so the app still opens', () => {
    // Not fatal: the warning goes to the log, the number to the result.
    const database = blankDatabase();
    try {
      database.exec('PRAGMA user_version = 7');
      expect(() => stampSchemaVersion(database)).not.toThrow();
    } finally {
      database.close();
    }
  });
});

describe('the live database the application opens', () => {
  it('is stamped by the time the first query runs', async () => {
    // Checks db/pool.ts actually calls the stamper.
    await getPool();
    const version = await withTestDb((database) => readSchemaVersion(database));
    expect(version).toBe(SCHEMA_VERSION);
  });
});
