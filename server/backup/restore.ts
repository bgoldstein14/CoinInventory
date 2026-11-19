/**
 * Restores a backup over the live collection. The current database is never
 * overwritten: it is renamed aside in the same folder, so a wrong restore can
 * be undone by copying it back.
 *
 *   1. Validate (backup/inspect.ts + verdict.ts), again at this point since
 *      the path may have changed after the dialog's check.
 *   2. Close the database (withDatabaseOffline); Windows can't rename an open file.
 *   3. Rename the current file aside (atomic within a volume).
 *   4. Write the new one via the online backup API (see restoreCopy()).
 *   5. Verify the result has the expected tables and coin count.
 *   6. On failure, delete the partial file and rename the old one back.
 *
 * There is no cancel: stopping midway would leave the collection renamed
 * and a partial file in its place.
 */

import fs from 'fs';
import path from 'path';

import {
  buildDbConfig,
  copyDatabaseFile,
  IN_MEMORY_DATABASE,
  readDatabaseFileFacts,
} from '../db';
import { withDatabaseOffline } from '../db/pool';
import { logError, logInfo, logWarn } from '../logger';
import { inspectBackupFile, type BackupInspection } from './inspect';
import { isBackupRunning } from './jobs';
import { asideFileName, uniqueFileName } from './names';
import { DEFAULT_BACKUP_RATE_PAGES } from './run-backup';

/** A refusal the user can understand and act on. Surfaces as a 400. */
export class RestoreRefused extends Error {
  constructor(
    message: string,
    /** The inspection that produced the refusal, for the dialog to show. */
    readonly inspection: BackupInspection | null
  ) {
    super(message);
    this.name = 'RestoreRefused';
  }
}

export interface RestoreResult {
  /** The file that was restored FROM. Unchanged by all of this. */
  readonly restoredFrom: string;
  /** Where the collection now lives — the same path it always did. */
  readonly databasePath: string;
  /** Where the old collection was moved (null if there was none). Shown to the user as the undo path. */
  readonly previousCollectionMovedTo: string | null;
  /** Coins now in the live collection, counted after the swap. */
  readonly coinCount: number;
  /** Photographs that are a path into a folder, not a picture in the file. */
  readonly referencedOnlyImageCount: number;
  /** Of those, the folders that are NOT on this machine. */
  readonly missingPhotoFolders: readonly string[];
  /** What the restored file says about when it was taken. */
  readonly takenAt: string | null;
  /** Always false: the next request reopens the file. */
  readonly serverRestartRequired: false;
}

/**
 * Replaces the live collection with the contents of `sourcePath`.
 *
 * Throws RestoreRefused for anything the user can fix. Throws an ordinary
 * Error only if the swap itself failed — in which case the rollback has
 * already run and the collection is back where it was.
 */
export async function performRestore(
  sourcePath: string,
  now: Date = new Date()
): Promise<RestoreResult> {
  const source = sourcePath.trim();

  if (source.length === 0) {
    throw new RestoreRefused('Enter the full path of the backup file to restore.', null);
  }

  const config = buildDbConfig();
  if (config.file === IN_MEMORY_DATABASE || config.directory === null) {
    throw new RestoreRefused(
      'This copy of Coin Inventory is running on a temporary in-memory collection, ' +
        'so there is nothing to restore over.',
      null
    );
  }

  // Restoring the live file over itself would rename the source away before copying it.
  if (samePath(source, config.file)) {
    throw new RestoreRefused(
      'That is the collection you are using now, not a backup of it. Choose a ' +
        'backup file instead.',
      null
    );
  }

  if (isBackupRunning()) {
    throw new RestoreRefused(
      'A backup is still running. Wait for it to finish before restoring — ' +
        'replacing the collection underneath it would corrupt the backup.',
      null
    );
  }

  // Step 1. Nothing moves if this refuses.
  const inspection = inspectBackupFile(source);
  if (!inspection.decision.acceptable) {
    logWarn(
      `Restore refused (${inspection.decision.verdict}) for ${source}: ` +
        inspection.decision.message
    );
    throw new RestoreRefused(inspection.decision.message, inspection);
  }

  const asidePath = chooseAsidePath(config.directory, config.file, now);

  // Steps 2-6.
  return withDatabaseOffline(async () => {
    const { movedAside, coinCount } = await swapInRestoredCollection({
      databasePath: config.file,
      asidePath,
      write: () => restoreCopy(source, config.file),
      verify: () => verifyRestored(config.file, inspection).coinCount ?? 0,
    });

    logInfo(
      `Restored the collection from ${source} (${coinCount} coin(s)). ` +
        (movedAside
          ? `The previous collection was moved to ${asidePath}.`
          : 'There was no previous collection to move aside.')
    );

    return {
      restoredFrom: source,
      databasePath: config.file,
      previousCollectionMovedTo: movedAside ? asidePath : null,
      coinCount,
      referencedOnlyImageCount: inspection.referencedOnlyImageCount ?? 0,
      missingPhotoFolders: inspection.referencedFolders
        .filter((entry) => !entry.presentOnThisMachine)
        .map((entry) => entry.folder),
      takenAt: inspection.provenance.takenAt,
      serverRestartRequired: false,
    };
  });
}

/** The move-write-verify-or-roll-back dance. See swapInRestoredCollection(). */
export interface RestoreSwap {
  /** The live collection's path. Renamed away, then written afresh. */
  readonly databasePath: string;
  /** Where the live collection is renamed to. Must be free. */
  readonly asidePath: string;
  /** Puts the new collection at `databasePath`. May throw. */
  readonly write: () => Promise<void>;
  /** Checks what landed and returns its coin count. Throws to roll back. */
  readonly verify: () => number;
}

/**
 * Steps 3-6: move the collection aside, write the new one, verify it, and
 * roll back if any of that fails. The write is injected so
 * backup/restore.spec.ts can test the rollback with a failing write (disk
 * full, drive removed), which can't otherwise be staged; bad files are
 * already rejected in step 1.
 */
export async function swapInRestoredCollection(
  swap: RestoreSwap
): Promise<{ movedAside: boolean; coinCount: number }> {
  const movedAside = moveAside(swap.databasePath, swap.asidePath);

  try {
    await swap.write();
    return { movedAside, coinCount: swap.verify() };
  } catch (err) {
    rollBack(swap.databasePath, swap.asidePath, movedAside);
    const message = err instanceof Error ? err.message : String(err);
    logError('Restore failed; the previous collection has been put back', message);
    throw new Error(`The collection could not be restored, so nothing was changed: ${message}`);
  }
}

/**
 * Writes the chosen backup into place through the online backup API rather
 * than a file copy, so a hot -wal beside the source is included and the
 * result is one self-contained file. Uses the backup's batch rate so the
 * server stays responsive. No progress or cancel (see the file header).
 */
async function restoreCopy(source: string, destination: string): Promise<void> {
  await copyDatabaseFile({
    sourceFile: source,
    destination,
    rate: DEFAULT_BACKUP_RATE_PAGES,
    onProgress: () => {
      /* No progress reporting for restore. */
    },
  });
}

/**
 * Re-reads what landed and checks the coin count matches the inspection of
 * the source, so a short write or full disk rolls back rather than leaving
 * an incomplete collection.
 */
function verifyRestored(
  databasePath: string,
  inspection: BackupInspection
): { coinCount: number | null } {
  const facts = readDatabaseFileFacts(databasePath);

  if (facts.coinCount === null) {
    throw new Error('the restored file has no Coins table');
  }

  if (inspection.coinCount !== null && facts.coinCount !== inspection.coinCount) {
    throw new Error(
      `the restored collection has ${facts.coinCount} coin(s) but the backup has ` +
        `${inspection.coinCount}`
    );
  }

  return { coinCount: facts.coinCount };
}

/**
 * Picks a free name for the displaced collection in the same folder (where
 * the user is told to look, and where a rename is atomic).
 */
function chooseAsidePath(directory: string, databasePath: string, now: Date): string {
  const desired = asideFileName(path.basename(databasePath), now);
  const unique = uniqueFileName(desired, (candidate) =>
    fs.existsSync(path.join(directory, candidate))
  );
  return path.join(directory, unique);
}

/**
 * Renames the current collection out of the way; returns false when there
 * was none. Any -wal/-shm sidecars move with it: left behind, SQLite would
 * apply the old database's WAL to the restored file. Moving them keeps the
 * displaced database complete.
 */
function moveAside(databasePath: string, asidePath: string): boolean {
  if (!fs.existsSync(databasePath)) return false;

  fs.renameSync(databasePath, asidePath);

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    if (!fs.existsSync(sidecar)) continue;
    try {
      fs.renameSync(sidecar, `${asidePath}${suffix}`);
    } catch (err) {
      // A sidecar that can't be moved must not be left behind.
      logWarn(
        `Could not move ${sidecar} aside (${err instanceof Error ? err.message : String(err)}); ` +
          `removing it so it cannot be applied to the restored collection.`
      );
      fs.rmSync(sidecar, { force: true });
    }
  }

  return true;
}

/**
 * Puts the user back where they started: deletes the partial file and
 * renames the displaced collection back. Logs rather than throws, since it
 * runs inside a catch and must not mask the original error. If the rename
 * fails, the collection is still on disk under the aside name.
 */
function rollBack(databasePath: string, asidePath: string, movedAside: boolean): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    } catch (err) {
      logWarn(
        `Rollback: could not remove the partially restored ${databasePath}${suffix}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!movedAside) return;

  try {
    fs.renameSync(asidePath, databasePath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${asidePath}${suffix}`)) {
        fs.renameSync(`${asidePath}${suffix}`, `${databasePath}${suffix}`);
      }
    }
    logInfo('Rollback complete: the previous collection is back in place.');
  } catch (err) {
    logError(
      'Rollback could not put the previous collection back automatically. ' +
        `It is still on disk at ${asidePath} — copy it back to ${databasePath} to recover it.`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Same file, allowing for `/` vs `\` and Windows case-insensitivity. Compared
 * as text because the user-typed path may not exist.
 */
function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string =>
    path.resolve(value.trim()).replace(/[\\/]+$/, '').toLowerCase();
  return normalise(a) === normalise(b);
}
