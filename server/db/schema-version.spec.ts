/**
 * db/schema-version.spec.ts — THE STAMP, AND THE THREE WAYS IT COULD GO
 * WRONG.
 *
 * `PRAGMA user_version` is the only part of §16 that cannot be added
 * retrospectively. A backup written without it is a file nobody can ever
 * identify: not this build, not next year's, not a support engineer with
 * a SQLite browser. So the thing worth testing is not "does the number get
 * written" but the three ways the write could be harmful:
 *
 *   1. NOT WRITTEN AT ALL  -> every backup is anonymous, for ever
 *   2. WRITTEN DOWNWARDS   -> a file from a later build is relabelled as
 *                             one this build understands, and the restore
 *                             that would have refused it now accepts it
 *   3. WRITTEN ON A FILE   -> the number stops meaning "this shape" and
 *      WHOSE SCHEMA FAILED    starts meaning "we tried"
 *
 * The second is the dangerous one, and it is the reason stampSchemaVersion
 * is not a one-line `exec`.
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

  it('starts at 1, which means "db/schema.sql at the dealer-readiness release"', () => {
    /* Asserted so that a casual bump is a deliberate act with a failing
     * test in front of it. Bumping this number is a promise to EVERY
     * earlier build that it should refuse the file — see the long note in
     * db/schema.ts — and it must not happen for a change an earlier build
     * could have read quite happily. */
    expect(SCHEMA_VERSION).toBe(1);
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
    // Every database the owner already has reads 0. Their shape is already
    // correct — nothing in the schema changed when the stamp was added —
    // so recording what they are is all that is owed, and it has to happen
    // on an ordinary open rather than needing a migration.
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

  /* *** THE DANGEROUS ONE. *** */
  it('NEVER writes the version DOWN', () => {
    const database = blankDatabase();
    try {
      database.exec('PRAGMA user_version = 42');

      const stamp = stampSchemaVersion(database);

      expect(stamp.stamped).toBe(false);
      expect(stamp.newerThanThisBuild).toBe(true);
      expect(stamp.before).toBe(42);
      expect(stamp.after).toBe(42);
      // The file still says what it really is. Relabelling it would
      // destroy the only record of that, and the restore that would have
      // refused it would start accepting it.
      expect(readSchemaVersion(database)).toBe(42);
    } finally {
      database.close();
    }
  });

  it('reports a newer file rather than throwing, so the app still opens', () => {
    // Refusing to open would leave a user whose file is from a newer build
    // with no application at all. The warning is in the log; the number is
    // in the result.
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
    // Not a unit test of the stamper — a test that db/pool.ts actually
    // calls it. The stamp is worthless if it only happens in a spec.
    await getPool();
    const version = await withTestDb((database) => readSchemaVersion(database));
    expect(version).toBe(SCHEMA_VERSION);
  });
});
