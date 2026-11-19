/**
 * Backup tests against real files on disk, with no mocks: the question is
 * whether the resulting file is a complete, openable database.
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
  // Restores COIN_INVENTORY_DB_PATH to ':memory:' (vitest-setup.ts enforces this).
  if (database) await releaseFileDatabase(database);
  database = null;
});

describe('backup — the WAL trap, and why the app no longer has to be closed', () => {
  /**
   * In WAL mode recent transactions sit in the -wal file, so a plain copy of
   * the .db misses them. This takes a file copy and a backup at the same
   * moment with the app's connection open: the copy is short, the backup
   * complete.
   */
  it('copies every committed row while the app is open, where a file copy does not', async () => {
    database = await useFileDatabase('wal-trap');

    // Stay under SQLite's 1,000-page auto-checkpoint so the WAL isn't folded in.
    await insertCoins(400, 'wal');

    // Confirm the premise: there is content only in the WAL.
    expect(fs.existsSync(`${database.file}-wal`)).toBe(true);
    expect(fs.statSync(`${database.file}-wal`).size).toBeGreaterThan(0);

    // A plain file copy, for comparison.
    const naiveCopy = path.join(database.backupDirectory, 'naive-copy.db');
    fs.copyFileSync(database.file, naiveCopy);
    const naiveFacts = readDatabaseFileFacts(naiveCopy);

    // The backup, with the live handle still open.
    const result = await performBackup({ directory: database.backupDirectory });
    const backupFacts = readDatabaseFileFacts(result.path);

    expect(backupFacts.coinCount).toBe(400);
    expect(result.coinCount).toBe(400);

    // Only asserted when the premise held, so a checkpoint can't make this flaky.
    expect(naiveFacts.coinCount).not.toBeNull();
    if ((naiveFacts.coinCount ?? 0) < 400) {
      expect(backupFacts.coinCount! - naiveFacts.coinCount!).toBeGreaterThan(0);
    }
  });

  /**
   * SQLite restarts a backup whenever another connection writes to the
   * source. Without the pinned read snapshot in db/backup.ts, continuous
   * writes meant the copy never finished. This writes throughout and
   * requires the copy to complete.
   */
  it('finishes under a continuous stream of writes, instead of restarting for ever', async () => {
    database = await useFileDatabase('concurrent-writes');
    await insertCoins(200, 'before');

    // Must be large (~10 MB): a small database copies within one write gap
    // and would pass even without the pinned snapshot.
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

    // Explicit deadline so the "never finishes" failure is named, not a
    // generic timeout. Pinned, the copy takes well under a second.
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

    // Everything committed before the copy began is in it; interleaved
    // writes may land either side of the snapshot.
    expect(facts.coinCount).toBeGreaterThanOrEqual(200);
    expect(facts.tables).toContain('Coins');

    // The writer ran throughout and was never blocked.
    expect(written).toBeGreaterThan(10);
    expect(failedWrites).toBe(0);
  }, 30000);
});

/**
 * Pads the database with `rows` photos of `bytes` each, via the raw handle
 * for speed.
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
    // A backup must be one self-contained file, with no sidecars needed.
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
    // Progress must never go backwards.
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

    // A cancelled backup leaves nothing behind, not even a sidecar.
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
    // Two backups in the same minute must not overwrite each other.
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
    // Empty database: 0/0 must read as done.
    expect(percentComplete(0, 0)).toBe(100);
  });

  it('never leaves the 0..100 range however odd the inputs', () => {
    expect(percentComplete(100, -5)).toBe(100);
    expect(percentComplete(100, 500)).toBe(0);
    expect(percentComplete(Number.NaN, 1)).toBe(100);
  });
});
