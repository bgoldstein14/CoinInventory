/**
 * backup/restore.spec.ts — THE REFUSALS, AND THE PROMISE THAT THE OLD
 * COLLECTION IS STILL THERE.
 *
 * Real files throughout, for the same reason backup.spec.ts uses them: a
 * mocked restore proves that restore.ts called rename with the arguments
 * restore.ts was written to call it with. What is in question is whether
 * the user's coins are readable afterwards and whether the file they had
 * before still exists — and only a real swap on a real disk answers that.
 *
 * The structure follows the danger:
 *
 *   1. what it REFUSES, with the collection untouched afterwards
 *   2. what it does with the OLD collection when it accepts
 *   3. what the user can see BEFORE committing
 *   4. the rollback
 */

import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { DB_BINDINGS, readDatabaseFileFacts } from '../db';
// The data layer's own opener, not a second import of `node:sqlite` —
// db/driver-isolation.spec.ts would (correctly) fail the build for that.
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
  // Byte offset 60 of the SQLite header IS user_version, big-endian. Written
  // directly rather than through a connection so the test does not depend on
  // the application being willing to write that number — which it is not:
  // db/schema.ts refuses to stamp a version DOWN, and refusing is the
  // behaviour under test elsewhere.
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
    // A zero-length file is a valid SQLite database as far as the driver is
    // concerned: opening one creates a schema in it. Restoring from it would
    // produce an empty collection that passed every other check.
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

    // A real, valid, perfectly healthy SQLite file — just not ours. Built by
    // taking one of our backups and dropping a table out of it, so it is
    // indistinguishable from a Coin Inventory backup in every way except the
    // one that matters.
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

  /**
   * *** THE REFUSAL WITH NO WAY ROUND IT. ***
   * There is no migration runner, so a file from a later build cannot be
   * read down. Accepting it would mean moving the user's good collection
   * aside to make room for something this build will silently mis-read.
   */
  it('refuses a backup from a NEWER build, by number, before anything moves', async () => {
    database = await useFileDatabase('restore-newer');
    await insertCoins(5);

    const fromTheFuture = await takeBackup();
    forceSchemaVersion(fromTheFuture, 99);

    await expect(performRestore(fromTheFuture)).rejects.toThrow(
      /newer version of Coin Inventory/i
    );

    // Untouched, and still OURS — not renamed, not moved aside, not partly
    // replaced.
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

    // ...and then it changes. These twelve coins are what the user is about
    // to lose, and what the aside file has to keep recoverable.
    await insertCoins(12, 'later');
    expect(await liveCoinCount()).toBe(15);

    // LOCAL time, on purpose: the aside name is read by a human looking at
    // their own folder, so backup/names.ts builds it from local time. A UTC
    // literal here would make this spec pass or fail by timezone.
    const result = await performRestore(backupPath, new Date(2026, 10, 14, 16, 20, 30));

    // The live collection is now the backup's.
    expect(await liveCoinCount()).toBe(3);
    expect(result.coinCount).toBe(3);

    // *** AND THE OLD ONE IS STILL THERE. ***
    expect(result.previousCollectionMovedTo).not.toBeNull();
    const aside = result.previousCollectionMovedTo!;
    expect(fs.existsSync(aside)).toBe(true);
    expect(path.basename(aside)).toBe('coin-inventory.replaced-2026-11-14-162030.db');
    expect(readDatabaseFileFacts(aside).coinCount).toBe(15);

    // Next to the collection, so the user finds it where they are told to
    // look, and still a .db so copying it back is the whole recovery.
    expect(path.dirname(aside)).toBe(path.dirname(database.file));
  });

  it('is recoverable BY HAND — copying the aside file back undoes it', async () => {
    // The actual promise being made to the user, performed.
    database = await useFileDatabase('restore-undo');
    await insertCoins(2, 'in-backup');
    const backupPath = await takeBackup();
    await insertCoins(20, 'precious');

    const result = await performRestore(backupPath);
    expect(await liveCoinCount()).toBe(2);

    // The user realises their mistake and does the one obvious thing:
    // closes the app and copies the file the message named back over the
    // collection. (`resetPool()` is this spec standing in for "closes the
    // app"; the file copy is exactly what the user does.)
    await resetPool();
    fs.copyFileSync(result.previousCollectionMovedTo!, database.file);

    expect(await liveCoinCount()).toBe(22);
  });

  it('leaves no sidecar of the OLD database beside the new one', async () => {
    // A -wal belonging to the database that was just renamed away would be
    // applied to the restored one. That is a corruption, not an error.
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

    // No reset, no reopen, no restart: an ordinary query through the
    // ordinary pool, which is exactly what the next API call will do.
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
   * *** CONSEQUENCE OF PORTABILITY #1: REFERENCED PHOTOGRAPHS. ***
   * In 'referenced' mode the database holds only a SourcePath into a folder
   * on the machine the import ran on. Carried to another PC that folder is
   * not there, and the user gets a grid of broken pictures with no
   * explanation. This is the explanation, delivered before the restore
   * rather than discovered after it.
   */
  it('warns that referenced photographs point at folders that are not on this machine', async () => {
    database = await useFileDatabase('inspect-photos');
    await insertCoins(2, 'photo');

    const connection = await getPool();
    // Two referenced-only photos (a path, no picture) in a folder that does
    // not exist here, and one stored photo, which travels fine.
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

    // And the same facts come back out of the restore, so the "after" panel
    // can repeat the warning rather than leaving the user to remember it.
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
    // Inspecting is something the user does while deciding. It must not
    // make files appear next to their backup.
    database = await useFileDatabase('inspect-clean');
    await insertCoins(1);
    const backupPath = await takeBackup();

    inspectBackupFile(backupPath);

    expect(fs.existsSync(`${backupPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${backupPath}-shm`)).toBe(false);
  });
});

/**
 * *** WHY THE ROLLBACK IS TESTED THROUGH swapInRestoredCollection() AND
 * NOT THROUGH performRestore(). ***
 *
 * Because it cannot be reached through performRestore(), and that is good
 * news rather than a gap. Every way a bad FILE can fail is caught by the
 * validation before anything moves — measured against this build: a
 * truncated backup, a half-copied one and one with a falsified page count
 * are all rejected at inspection with "database disk image is malformed",
 * so none of them ever gets as far as the swap. (An earlier version of
 * this test truncated the backup to 100 bytes to force a mid-copy failure
 * and got a REFUSAL instead, which is the system working.)
 *
 * What can still fail at the swap is the environment, not the file: a disk
 * that fills up, a USB stick pulled out, a scanner holding the destination
 * open. None of those can be staged in a spec. So the write — the one
 * genuinely unstageable step — is injected, and everything else below is
 * the production code doing the real thing to real files: the real rename,
 * the real rollback, the real sidecar handling.
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
          // The disk filled up, the stick was pulled out, the scanner had
          // the file. The collection has already been renamed away at this
          // point, which is the state the rollback exists for.
          throw new Error('ENOSPC: no space left on device');
        },
        verify: () => 0,
      })
    ).rejects.toThrow(/nothing was changed/i);

    // *** BACK EXACTLY WHERE THEY STARTED. ***
    expect(fs.existsSync(database.file)).toBe(true);
    expect(fs.existsSync(asidePath)).toBe(false);
    expect(await liveCoinCount()).toBe(10);
  });

  it('rolls back when what landed does not match what was promised', async () => {
    // The other half: the write SUCCEEDED and produced the wrong thing.
    // A short write or a truncated copy shows up here as a coin count that
    // disagrees, and must roll back rather than become a quietly
    // incomplete collection.
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
    // A -wal belonging to the renamed-away database would be applied to
    // whatever is written in its place. That is a corruption, not an error,
    // and it is why moveAside() deals with all three files.
    database = await useFileDatabase('restore-sidecar-move');
    await insertCoins(5, 'precious');
    await resetPool();

    // Stage the state a killed process leaves behind: a stale sidecar.
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
