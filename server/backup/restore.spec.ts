/**
 * Restore tests against real files: what it refuses (leaving the collection
 * untouched), what happens to the old collection, what the user sees before
 * committing, and the rollback.
 */

import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DB_BINDINGS, readDatabaseFileFacts } from '../db';
// Use the data layer's opener; only db/ imports node:sqlite.
import { openSqliteDatabase } from '../db/driver';
import { getPool, resetPool } from '../db/pool';
import {
  insertCoins,
  liveCoinCount,
  releaseFileDatabase,
  useFileDatabase,
  type FileDatabase,
} from '../test-support/real-file-db';
import { inspectBackupFile } from './inspect';
import { performRestore, RestoreRefused, swapInRestoredCollection } from './restore';
import { performBackup } from './run-backup';

let database: FileDatabase | null = null;

afterEach(async () => {
  if (database) await releaseFileDatabase(database);
  database = null;
});

/** A backup of the live collection, taken now. */
async function takeBackup(): Promise<string> {
  const result = await performBackup({ directory: database!.backupDirectory });
  return result.path;
}

/** Rewrites a file's `PRAGMA user_version` by hand, to fake another build. */
function forceSchemaVersion(filePath: string, version: number): void {
  // Byte offset 60 of the SQLite header is user_version (big-endian). Written
  // directly because the app refuses to stamp a version downwards.
  const handle = fs.openSync(filePath, 'r+');
  try {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(version, 0);
    fs.writeSync(handle, buffer, 0, 4, 60);
  } finally {
    fs.closeSync(handle);
  }
}

describe('restore — what it refuses, with the collection untouched', () => {
  it('refuses a file that does not exist', async () => {
    database = await useFileDatabase('restore-missing');
    await insertCoins(5);

    await expect(
      performRestore(path.join(database.directory, 'not-here.db'))
    ).rejects.toBeInstanceOf(RestoreRefused);

    expect(await liveCoinCount()).toBe(5);
  });

  it('refuses a file that is not SQLite at all', async () => {
    database = await useFileDatabase('restore-not-sqlite');
    await insertCoins(5);

    const impostor = path.join(database.backupDirectory, 'holiday.db');
    fs.writeFileSync(impostor, 'this is a photograph, honestly');

    await expect(performRestore(impostor)).rejects.toThrow(/not a Coin Inventory backup/i);
    expect(await liveCoinCount()).toBe(5);
  });

  it('refuses an EMPTY file, which SQLite would happily adopt', async () => {
    // SQLite treats a zero-length file as an empty database; restoring it would
    // produce an empty collection.
    database = await useFileDatabase('restore-empty');
    await insertCoins(5);

    const empty = path.join(database.backupDirectory, 'empty.db');
    fs.writeFileSync(empty, '');

    await expect(performRestore(empty)).rejects.toBeInstanceOf(RestoreRefused);
    expect(await liveCoinCount()).toBe(5);
  });

  it("refuses somebody else's SQLite database", async () => {
    database = await useFileDatabase('restore-foreign');
    await insertCoins(5);

    // A valid SQLite file that isn't ours: one of our backups minus a table.
    const foreign = await takeBackup();
    const connection = await getPool();
    void connection; // the live handle stays open; the edit is on the copy
    dropTable(foreign, 'Denominations');

    await expect(performRestore(foreign)).rejects.toThrow(/not a Coin Inventory collection/i);
    expect(await liveCoinCount()).toBe(5);

    const inspection = inspectBackupFile(foreign);
    expect(inspection.decision.verdict).toBe('not-this-app');
    expect(inspection.decision.missingTables).toContain('Denominations');
  });

  /** A newer build's file can't be read safely, so it is refused before anything moves. */
  it('refuses a backup from a NEWER build, by number, before anything moves', async () => {
    database = await useFileDatabase('restore-newer');
    await insertCoins(5);

    const fromTheFuture = await takeBackup();
    forceSchemaVersion(fromTheFuture, 99);

    await expect(performRestore(fromTheFuture)).rejects.toThrow(
      /newer version of Coin Inventory/i
    );

    // Untouched and not moved aside.
    expect(await liveCoinCount()).toBe(5);
    expect(fs.existsSync(database.file)).toBe(true);
    expect(fs.readdirSync(database.directory).filter((n) => n.includes('replaced'))).toEqual([]);
  });

  it('refuses to restore the live collection over itself', async () => {
    database = await useFileDatabase('restore-self');
    await insertCoins(5);

    await expect(performRestore(database.file)).rejects.toThrow(/collection you are using now/i);
    expect(await liveCoinCount()).toBe(5);
  });
});

describe('restore — the old collection is moved aside, never overwritten', () => {
  it('restores the rows and leaves the previous collection on disk', async () => {
    database = await useFileDatabase('restore-happy');

    // The collection as it was when the backup was taken.
    await insertCoins(3, 'original');
    const backupPath = await takeBackup();

    // Later changes, which the aside file must keep recoverable.
    await insertCoins(12, 'later');
    expect(await liveCoinCount()).toBe(15);

    // Local time, since backup/names.ts uses local time; a UTC literal would be timezone-dependent.
    const result = await performRestore(backupPath, new Date(2026, 10, 14, 16, 20, 30));

    // The live collection is now the backup's.
    expect(await liveCoinCount()).toBe(3);
    expect(result.coinCount).toBe(3);

    // And the old one is still there.
    expect(result.previousCollectionMovedTo).not.toBeNull();
    const aside = result.previousCollectionMovedTo!;
    expect(fs.existsSync(aside)).toBe(true);
    expect(path.basename(aside)).toBe('coin-inventory.replaced-2026-11-14-162030.db');
    expect(readDatabaseFileFacts(aside).coinCount).toBe(15);

    // In the same folder and still a .db, so copying it back is the recovery.
    expect(path.dirname(aside)).toBe(path.dirname(database.file));
  });

  it('is recoverable BY HAND — copying the aside file back undoes it', async () => {
    // The undo the user is told about, performed.
    database = await useFileDatabase('restore-undo');
    await insertCoins(2, 'in-backup');
    const backupPath = await takeBackup();
    await insertCoins(20, 'precious');

    const result = await performRestore(backupPath);
    expect(await liveCoinCount()).toBe(2);

    // The user closes the app (resetPool() here) and copies the aside file back.
    await resetPool();
    fs.copyFileSync(result.previousCollectionMovedTo!, database.file);

    expect(await liveCoinCount()).toBe(22);
  });

  it('leaves no sidecar of the OLD database beside the new one', async () => {
    // A stale -wal from the old database must not be applied to the restored one.
    database = await useFileDatabase('restore-sidecars');
    await insertCoins(4, 'in-backup');
    const backupPath = await takeBackup();
    await insertCoins(40, 'added-after');

    await performRestore(backupPath);

    // The pool has not reopened yet, so anything here was left by the swap.
    expect(fs.existsSync(`${database.file}-wal`)).toBe(false);
    expect(fs.existsSync(`${database.file}-shm`)).toBe(false);
    expect(await liveCoinCount()).toBe(4);
  });

  it('needs no server restart — the next request just opens the new file', async () => {
    database = await useFileDatabase('restore-no-restart');
    await insertCoins(6, 'in-backup');
    const backupPath = await takeBackup();
    await insertCoins(1, 'added-after');

    const result = await performRestore(backupPath);
    expect(result.serverRestartRequired).toBe(false);

    // No restart needed: the next ordinary query reopens the file.
    expect(await liveCoinCount()).toBe(6);
  });

  it('accepts an UNVERSIONED backup, because 0 means "before stamping existed"', async () => {
    database = await useFileDatabase('restore-unversioned');
    await insertCoins(9);
    const backupPath = await takeBackup();
    forceSchemaVersion(backupPath, 0);

    expect(inspectBackupFile(backupPath).decision.verdict).toBe('unversioned');

    const result = await performRestore(backupPath);
    expect(result.coinCount).toBe(9);
  });
});

describe('restore — what the user is told before committing', () => {
  it('reports the coin count and the date the backup was taken', async () => {
    database = await useFileDatabase('inspect-says');
    await insertCoins(11);

    const takenAt = new Date('2026-11-14T09:15:00.000Z');
    const { path: backupPath } = await performBackup({
      directory: database.backupDirectory,
      now: takenAt,
    });

    const inspection = inspectBackupFile(backupPath);
    expect(inspection.decision.acceptable).toBe(true);
    expect(inspection.coinCount).toBe(11);
    expect(inspection.provenance.takenAt).toBe('2026-11-14T09:15:00.000Z');
    expect(inspection.fileSizeBytes).toBeGreaterThan(0);
  });

  /**
   * Referenced photos are only paths into folders on the importing machine;
   * the user is warned about missing folders before the restore.
   */
  it('warns that referenced photographs point at folders that are not on this machine', async () => {
    database = await useFileDatabase('inspect-photos');
    await insertCoins(2, 'photo');

    const connection = await getPool();
    // Two referenced-only photos in a folder that doesn't exist here, and one stored photo.
    await connection.request().query(
      `INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) VALUES
         ('photo-0', NULL, 0, 'Z:\\OtherPC\\Coins\\obverse.jpg'),
         ('photo-0', NULL, 1, 'Z:\\OtherPC\\Coins\\reverse.jpg'),
         ('photo-1', 'data:image/jpeg;base64,AAAA', 0, 'Z:\\OtherPC\\Coins\\stored.jpg')`
    );

    const backupPath = await takeBackup();
    const inspection = inspectBackupFile(backupPath);

    expect(inspection.imageCount).toBe(3);
    expect(inspection.storedImageCount).toBe(1);
    expect(inspection.referencedOnlyImageCount).toBe(2);

    const folders = inspection.referencedFolders;
    expect(folders).toHaveLength(1);
    expect(folders[0]!.folder).toBe('Z:\\OtherPC\\Coins');
    expect(folders[0]!.presentOnThisMachine).toBe(false);

    // The restore result repeats the warning for the "after" panel.
    const result = await performRestore(backupPath);
    expect(result.referencedOnlyImageCount).toBe(2);
    expect(result.missingPhotoFolders).toEqual(['Z:\\OtherPC\\Coins']);
  });

  it('says nothing alarming when the folders ARE here', async () => {
    database = await useFileDatabase('inspect-photos-present');
    await insertCoins(1, 'photo');

    const presentFolder = database.backupDirectory;
    const connection = await getPool();
    await connection
      .request()
      .input('p', DB_BINDINGS.imageSourcePath, path.join(presentFolder, 'a.jpg'))
      .query(
        `INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath)
         VALUES ('photo-0', NULL, 0, @p)`
      );

    const inspection = inspectBackupFile(await takeBackup());
    expect(inspection.referencedFolders).toEqual([
      { folder: presentFolder, presentOnThisMachine: true },
    ]);
  });

  it('does not leave -wal / -shm litter beside a file it merely LOOKED at', async () => {
    // Inspecting must not create sidecar files next to the backup.
    database = await useFileDatabase('inspect-clean');
    await insertCoins(1);
    const backupPath = await takeBackup();

    inspectBackupFile(backupPath);

    expect(fs.existsSync(`${backupPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${backupPath}-shm`)).toBe(false);
  });
});

/**
 * The rollback is tested through swapInRestoredCollection() with an injected
 * failing write, because bad files are already rejected at inspection and
 * can't reach the swap. What can fail there is the environment (disk full,
 * drive removed); everything else is the real rename, rollback and sidecar
 * handling.
 */
describe('restore — rollback', () => {
  it('puts the previous collection back when the write fails', async () => {
    database = await useFileDatabase('restore-rollback');
    await insertCoins(10, 'precious');
    expect(await liveCoinCount()).toBe(10);

    const asidePath = path.join(database.directory, 'coin-inventory.replaced-test.db');
    await resetPool();

    await expect(
      swapInRestoredCollection({
        databasePath: database.file,
        asidePath,
        write: async () => {
          // Simulated environment failure after the collection was renamed away.
          throw new Error('ENOSPC: no space left on device');
        },
        verify: () => 0,
      })
    ).rejects.toThrow(/nothing was changed/i);

    // Back exactly where they started.
    expect(fs.existsSync(database.file)).toBe(true);
    expect(fs.existsSync(asidePath)).toBe(false);
    expect(await liveCoinCount()).toBe(10);
  });

  it('rolls back when what landed does not match what was promised', async () => {
    // The write succeeded but produced the wrong thing (coin count mismatch).
    database = await useFileDatabase('restore-verify-fails');
    await insertCoins(8, 'precious');

    const asidePath = path.join(database.directory, 'coin-inventory.replaced-test.db');
    await resetPool();

    await expect(
      swapInRestoredCollection({
        databasePath: database.file,
        asidePath,
        write: async () => {
          fs.writeFileSync(database!.file, 'a file, but not a collection');
        },
        verify: () => {
          throw new Error('the restored collection has 0 coin(s) but the backup has 8');
        },
      })
    ).rejects.toThrow(/nothing was changed/i);

    expect(await liveCoinCount()).toBe(8);
    expect(fs.existsSync(asidePath)).toBe(false);
  });

  it('moves the old database\'s sidecars with it, never leaving them behind', async () => {
    // A stale -wal must move with the old database, not stay beside the new one.
    database = await useFileDatabase('restore-sidecar-move');
    await insertCoins(5, 'precious');
    await resetPool();

    // A stale sidecar, as a killed process might leave.
    fs.writeFileSync(`${database.file}-wal`, 'stale write-ahead log');

    const asidePath = path.join(database.directory, 'coin-inventory.replaced-test.db');
    const restored = path.join(database.directory, 'source-for-restore.db');
    fs.copyFileSync(database.file, restored);

    await swapInRestoredCollection({
      databasePath: database.file,
      asidePath,
      write: async () => {
        fs.copyFileSync(restored, database!.file);
      },
      verify: () => 5,
    });

    expect(fs.existsSync(`${database.file}-wal`)).toBe(false);
    expect(fs.existsSync(`${asidePath}-wal`)).toBe(true);
    expect(fs.readFileSync(`${asidePath}-wal`, 'utf8')).toBe('stale write-ahead log');
  });
});

/** Drops a table from a closed SQLite file, to build a "not ours" fixture. */
function dropTable(filePath: string, table: string): void {
  const handle = openSqliteDatabase({
    filename: filePath,
    enableForeignKeyConstraints: false,
    busyTimeoutMs: 5000,
  });
  try {
    handle.exec(`DROP TABLE ${table}`);
  } finally {
    handle.close();
  }
}
