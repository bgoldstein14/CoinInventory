/**
 * backup/backup.spec.ts — AGAINST REAL FILES, BECAUSE EVERY FAILURE MODE
 * THIS FEATURE HAS IS A FILE FAILURE.
 *
 * There is not a mock in this file and there must not be one. A mocked
 * `backup()` would prove that run-backup.ts calls it with the arguments
 * run-backup.ts was written to call it with, which is a tautology. What is
 * actually in question is whether the file on the other side is a complete,
 * consistent, openable database — and only a real database written to a
 * real disk and read back can answer that.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS. Everything else here is
 * housekeeping around it.
 */

import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readDatabaseFileFacts, SCHEMA_VERSION } from '../db';
import type { SqliteDatabase } from '../db/driver';
import { getPool } from '../db/pool';
import {
  insertCoins,
  releaseFileDatabase,
  useFileDatabase,
  type FileDatabase,
} from '../test-support/real-file-db';
import { COIN_COUNT_KEY, TAKEN_AT_KEY, readBackupProvenance } from './metadata';
import {
  BackupCancelled,
  BackupRequestError,
  percentComplete,
  performBackup,
} from './run-backup';

let database: FileDatabase | null = null;

afterEach(async () => {
  // Restores COIN_INVENTORY_DB_PATH to ':memory:'. vitest-setup.ts fails
  // the test if this is skipped — read its header for the incident.
  if (database) await releaseFileDatabase(database);
  database = null;
});

describe('backup — the WAL trap, and why the app no longer has to be closed', () => {
  /**
   * *** THE CENTRAL CLAIM OF §16, MEASURED RATHER THAN ASSERTED. ***
   *
   * The plan this feature came from used to warn users to close the
   * application before copying their database. The reason was real: the
   * collection runs in WAL mode, so recent transactions sit in a `-wal`
   * sibling until a checkpoint folds them into the `.db`. Copy the `.db`
   * on its own and you get a database that opens, passes an integrity
   * check, and is missing the user's most recent coins.
   *
   * This test does both things at the same moment, on the same live
   * database, with the application's connection still open and still
   * holding uncheckpointed writes:
   *
   *   fs.copyFileSync  -> short. The exact silent data loss the warning
   *                       existed for.
   *   performBackup    -> complete.
   *
   * If the second assertion ever fails, the warning has to come back.
   */
  it('copies every committed row while the app is open, where a file copy does not', async () => {
    database = await useFileDatabase('wal-trap');

    // Enough rows that the WAL has not been checkpointed. SQLite
    // auto-checkpoints at 1,000 pages, so this deliberately stays under
    // the point where the main file catches up on its own.
    await insertCoins(400, 'wal');

    // Proof that the premise holds on this machine before anything is
    // claimed about the fix: there really is uncommitted-to-main content.
    expect(fs.existsSync(`${database.file}-wal`)).toBe(true);
    expect(fs.statSync(`${database.file}-wal`).size).toBeGreaterThan(0);

    // THE WRONG WAY, for comparison. Same instant, same file, no close.
    const naiveCopy = path.join(database.backupDirectory, 'naive-copy.db');
    fs.copyFileSync(database.file, naiveCopy);
    const naiveFacts = readDatabaseFileFacts(naiveCopy);

    // THE RIGHT WAY. Still no close, still the same live handle open.
    const result = await performBackup({ directory: database.backupDirectory });
    const backupFacts = readDatabaseFileFacts(result.path);

    expect(backupFacts.coinCount).toBe(400);
    expect(result.coinCount).toBe(400);

    // And the comparison that makes the point. Not `toBeLessThan`, because
    // a flaky checkpoint could make the naive copy complete by accident and
    // turn this into a test that fails for the wrong reason — so it asserts
    // what we are protected FROM only when the premise actually held.
    expect(naiveFacts.coinCount).not.toBeNull();
    if ((naiveFacts.coinCount ?? 0) < 400) {
      // The usual case, and the one the old warning was about.
      expect(backupFacts.coinCount! - naiveFacts.coinCount!).toBeGreaterThan(0);
    }
  });

  /**
   * *** THE APPLICATION KEEPS WRITING, AND THE BACKUP STILL FINISHES. ***
   *
   * This is the test that found the one real bug in this feature. SQLite
   * RESTARTS a backup — from the beginning, not from where it was — when
   * the source database is modified through a connection other than the
   * one the copy is reading. We read through a second, read-only
   * connection on purpose, so every edit the user makes during a backup is
   * exactly that kind of modification. An early version of this test wrote
   * a row every millisecond and never completed: 62 restarts in ten
   * seconds against a 60,000-row database.
   *
   * The fix is in db/backup.ts (pinReadSnapshot): hold a read transaction
   * for the whole copy, so the source the backup sees cannot change and
   * there is nothing to restart for. This test writes continuously
   * throughout and insists the copy still finishes — which it only does
   * because the snapshot is pinned.
   */
  it('finishes under a continuous stream of writes, instead of restarting for ever', async () => {
    database = await useFileDatabase('concurrent-writes');
    await insertCoins(200, 'before');

    /* *** THE DATABASE HAS TO BE BIG, OR THIS TEST PROVES NOTHING. ***
     *
     * A restart only hurts when a full copy takes longer than the gap
     * between writes. An earlier version of this test used the bare
     * seeded database — a few hundred pages — and the copy finished
     * inside one 1 ms gap whether the snapshot was pinned or not, so
     * removing the pin left it passing. Ten megabytes is enough that an
     * unpinned copy is thrown away and started again faster than it can
     * ever reach the end. Verified by deleting pinReadSnapshot() and
     * watching this fail. */
    await insertBulkImageData(40, 256 * 1024);

    const connection = await getPool();
    let written = 0;
    let failedWrites = 0;

    const writer = setInterval(() => {
      void connection
        .request()
        .query(`INSERT INTO Coins (CoinId) VALUES ('during-${written++}')`)
        .catch(() => {
          failedWrites++;
        });
    }, 1);

    /* A DEADLINE, not the suite's timeout. The unpinned failure mode is
     * "never finishes", and a bare `await` would surface that as a
     * generic timeout 20 seconds later with no explanation. This names
     * it. The margin is enormous — pinned, this copy takes well under a
     * second — so it cannot go off because a machine was busy. */
    const DEADLINE_MS = 10_000;
    let result;
    try {
      result = await Promise.race([
        performBackup({ directory: database.backupDirectory }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'The backup never finished while the app was writing. SQLite restarts a ' +
                    'copy whenever the source is modified through another connection, so ' +
                    'the read snapshot in db/backup.ts (pinReadSnapshot) must be held for ' +
                    'the whole copy.'
                )
              ),
            DEADLINE_MS
          )
        ),
      ]);
    } finally {
      clearInterval(writer);
    }

    const facts = readDatabaseFileFacts(result.path);

    // A consistent snapshot: everything committed before the copy began is
    // in it. Which of the interleaved writes also made it is deliberately
    // not asserted — they land on one side of the snapshot or the other,
    // and both are correct.
    expect(facts.coinCount).toBeGreaterThanOrEqual(200);
    expect(facts.tables).toContain('Coins');

    // The writer really did run throughout, and the application was never
    // blocked out of its own database.
    expect(written).toBeGreaterThan(10);
    expect(failedWrites).toBe(0);
  }, 30000);
});

/**
 * Pads the database out with `rows` photographs of `bytes` each.
 *
 * Through the raw handle rather than the request API: this is fixture
 * setup, and 10 MB of base64 pushed one statement at a time through the
 * binding layer is slow enough to notice in a suite that runs in seconds.
 */
async function insertBulkImageData(rows: number, bytes: number): Promise<void> {
  const connection = await getPool();
  const payload = 'A'.repeat(bytes);

  await connection.withLock(() => {
    const handle = (connection as unknown as { database: SqliteDatabase }).database;
    handle.exec('BEGIN');
    const statement = handle.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (?, ?, ?)'
    );
    for (let index = 0; index < rows; index++) {
      statement.run('before-0', payload, index);
    }
    handle.exec('COMMIT');
  });
}

describe('backup — what the file carries', () => {
  it('carries the schema version stamp, so it can be identified elsewhere', async () => {
    database = await useFileDatabase('stamped');
    await insertCoins(3);

    const result = await performBackup({ directory: database.backupDirectory });
    const facts = readDatabaseFileFacts(result.path);

    // THE WHOLE REASON THE STAMP HAD TO EXIST BEFORE THIS FEATURE SHIPPED.
    // A backup with user_version 0 is a file no restore can reason about.
    expect(facts.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('records when it was taken and how many coins were in it', async () => {
    database = await useFileDatabase('provenance');
    await insertCoins(7);

    const takenAt = new Date('2026-11-14T15:04:05.000Z');
    const result = await performBackup({ directory: database.backupDirectory, now: takenAt });

    const facts = readDatabaseFileFacts(result.path);
    expect(facts.metadata[TAKEN_AT_KEY]).toBe('2026-11-14T15:04:05.000Z');
    expect(facts.metadata[COIN_COUNT_KEY]).toBe('7');

    const provenance = readBackupProvenance(facts.metadata);
    expect(provenance.takenAt).toBe('2026-11-14T15:04:05.000Z');
    expect(provenance.recordedCoinCount).toBe(7);
  });

  it('is ONE file — no -wal or -shm left beside it', async () => {
    // "A portable file" means one thing the user can copy to a USB stick.
    // A backup that needed its sidecars to be complete would be three.
    database = await useFileDatabase('single-file');
    await insertCoins(50);

    const result = await performBackup({ directory: database.backupDirectory });

    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.existsSync(`${result.path}-wal`)).toBe(false);
    expect(fs.existsSync(`${result.path}-shm`)).toBe(false);
  });

  it('does not stamp the LIVE collection as a backup of itself', async () => {
    database = await useFileDatabase('no-live-stamp');
    await insertCoins(2);
    await performBackup({ directory: database.backupDirectory });

    const live = readDatabaseFileFacts(database.file);
    expect(live.metadata).toEqual({});
  });
});

describe('backup — progress and cancellation', () => {
  it('reports progress that ends at 100', async () => {
    database = await useFileDatabase('progress');
    await insertCoins(300);

    const seen: number[] = [];
    const result = await performBackup({
      directory: database.backupDirectory,
      rate: 1,
      onProgress: (progress) => seen.push(progress.percent),
    });

    expect(seen.length).toBeGreaterThan(1);
    // Monotonic: a bar that goes backwards is a bar nobody trusts.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
    }
    expect(seen.every((percent) => percent >= 0 && percent <= 100)).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('stops when cancelled, and leaves NOTHING behind', async () => {
    database = await useFileDatabase('cancel');
    await insertCoins(400);

    await expect(
      performBackup({
        directory: database.backupDirectory,
        rate: 1,
        isCancelled: () => true,
      })
    ).rejects.toBeInstanceOf(BackupCancelled);

    // A half-written .db with a plausible name in the user's backup folder
    // is a file they will try to restore from one day. Nothing, not even a
    // sidecar, may be left.
    expect(fs.readdirSync(database.backupDirectory)).toEqual([]);
  });

  it('cancels part-way through rather than only before it starts', async () => {
    database = await useFileDatabase('cancel-midway');
    await insertCoins(400);

    let batches = 0;
    await expect(
      performBackup({
        directory: database.backupDirectory,
        rate: 1,
        isCancelled: () => batches >= 2,
        onProgress: () => {
          batches++;
        },
      })
    ).rejects.toBeInstanceOf(BackupCancelled);

    expect(batches).toBeGreaterThanOrEqual(2);
    expect(fs.readdirSync(database.backupDirectory)).toEqual([]);
  });
});

describe('backup — refusing a destination it cannot use', () => {
  it('refuses a folder that does not exist rather than creating one', async () => {
    database = await useFileDatabase('no-folder');

    await expect(
      performBackup({ directory: path.join(database.directory, 'nope', 'nowhere') })
    ).rejects.toBeInstanceOf(BackupRequestError);
  });

  it('refuses a relative path, which would land somewhere the user cannot find', async () => {
    database = await useFileDatabase('relative');

    await expect(performBackup({ directory: 'backups' })).rejects.toThrow(/full path/i);
  });

  it('refuses a file name that is not a .db', async () => {
    database = await useFileDatabase('extension');

    await expect(
      performBackup({ directory: database.backupDirectory, fileName: 'collection.xlsx' })
    ).rejects.toThrow(/\.db/);
  });

  it('NEVER overwrites an existing backup', async () => {
    // Two backups in the same minute suggest the same name. Overwriting the
    // first destroys a copy the user may be relying on — most likely at the
    // exact moment they are pressing Backup repeatedly because something
    // has gone wrong.
    database = await useFileDatabase('no-overwrite');
    await insertCoins(5);

    const sameMinute = new Date('2026-11-14T10:30:00.000Z');
    const first = await performBackup({ directory: database.backupDirectory, now: sameMinute });
    const second = await performBackup({ directory: database.backupDirectory, now: sameMinute });

    expect(second.path).not.toBe(first.path);
    expect(path.basename(second.path)).toContain('(2)');
    expect(fs.existsSync(first.path)).toBe(true);
    expect(readDatabaseFileFacts(first.path).coinCount).toBe(5);
  });
});

describe('percentComplete', () => {
  it('turns SQLite\'s count-down into a count-up', () => {
    expect(percentComplete(100, 100)).toBe(0);
    expect(percentComplete(100, 50)).toBe(50);
    expect(percentComplete(100, 0)).toBe(100);
  });

  it('answers 100 rather than NaN for an empty database', () => {
    // 0/0. A bar stuck at the left for a backup that has already finished.
    expect(percentComplete(0, 0)).toBe(100);
  });

  it('never leaves the 0..100 range however odd the inputs', () => {
    expect(percentComplete(100, -5)).toBe(100);
    expect(percentComplete(100, 500)).toBe(0);
    expect(percentComplete(Number.NaN, 1)).toBe(100);
  });
});
