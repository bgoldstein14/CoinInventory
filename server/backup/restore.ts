/**
 * backup/restore.ts — THE HALF THAT CAN DESTROY A COLLECTION.
 *
 * Everything in this file exists to make one sentence true:
 *
 *   *** THE CURRENT DATABASE IS NEVER OVERWRITTEN. IT IS MOVED ASIDE. ***
 *
 * The single most likely mistake in this feature is a user restoring the
 * wrong file over a good collection. Not a corrupt backup, not a disk
 * error — the wrong file, chosen confidently, from a folder with four in
 * it. That mistake must be recoverable by hand, with no tooling and no
 * support call, and it is: the old collection is still there, next to the
 * new one, under a name that says what happened to it, and copying it back
 * over `coin-inventory.db` undoes the whole thing.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN:
 *
 *   1. VALIDATE. backup/inspect.ts + backup/verdict.ts, before anything
 *      moves. A newer schema, a stranger's database, a JPEG renamed to
 *      `.db`, a half-copied file — all refused here, with the collection
 *      untouched. Re-validated at this moment even though the dialog
 *      already showed the user a verdict, because the path is a text box
 *      and they can have changed it since.
 *   2. CLOSE. db/pool.ts's withDatabaseOffline(). On Windows a file with an
 *      open handle cannot be renamed at all, so this is not hygiene.
 *   3. MOVE ASIDE. A rename, which is atomic within a volume, so there is
 *      no instant at which the collection exists in neither place.
 *   4. WRITE THE NEW ONE, through the same online-backup path the BACKUP
 *      uses rather than a file copy — see restoreCopy() below.
 *   5. VERIFY WHAT LANDED. Re-open the result and check it has the tables
 *      and the coin count the inspection promised.
 *   6. ROLL BACK IF 5 FAILED. Delete the partial, rename the old one back.
 *      A failed restore must leave the user exactly where they started.
 *
 * THERE IS NO CANCEL, AND THAT IS DELIBERATE — unlike the backup, which
 * has one. A cancelled backup leaves nothing at stake: no file, and the
 * collection never moved. A cancel halfway through step 4 would leave the
 * user with their collection renamed and a truncated file where it used to
 * be, which is the precise state this whole file exists to make impossible.
 * So the swap runs to completion or rolls back, and the only "cancel" is
 * the one before step 1: not pressing the button.
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
  /**
   * *** WHERE THE OLD COLLECTION WENT. *** Null only when there was no
   * collection to displace (a first run). Told to the user in words, every
   * time, because it is the undo button.
   */
  readonly previousCollectionMovedTo: string | null;
  /** Coins now in the live collection, counted after the swap. */
  readonly coinCount: number;
  /** Photographs that are a path into a folder, not a picture in the file. */
  readonly referencedOnlyImageCount: number;
  /** Of those, the folders that are NOT on this machine. */
  readonly missingPhotoFolders: readonly string[];
  /** What the restored file says about when it was taken. */
  readonly takenAt: string | null;
  /**
   * Does the SERVER need restarting? No, and this is here to say so
   * explicitly rather than leave it to be inferred — see the note on
   * withDatabaseOffline() in db/pool.ts. The next request reopens the file.
   */
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

  /* RESTORING THE LIVE FILE OVER ITSELF.
   *
   * Harmless-looking and not harmless: step 3 renames the collection away,
   * and step 4 would then be copying from a path that no longer exists —
   * leaving the user with no collection at all and a confusing error. It
   * is also never what anybody means. */
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

  // STEP 1. Nothing has moved and nothing will if this refuses.
  const inspection = inspectBackupFile(source);
  if (!inspection.decision.acceptable) {
    logWarn(
      `Restore refused (${inspection.decision.verdict}) for ${source}: ` +
        inspection.decision.message
    );
    throw new RestoreRefused(inspection.decision.message, inspection);
  }

  const asidePath = chooseAsidePath(config.directory, config.file, now);

  // STEPS 2-6.
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
 * STEPS 3-6: move the collection aside, write the new one, check it, and
 * put everything back if any of that failed.
 *
 * *** WHY THIS IS A SEPARATE, INJECTED-WRITE FUNCTION. ***
 * The rollback is the most important code in this feature and the hardest
 * to reach. Every way a bad FILE can fail is caught by the validation
 * before anything moves — measured, not assumed: a truncated database, a
 * half-copied one and one with a falsified page count are all rejected by
 * `readDatabaseFileFacts()` at step 1 with "database disk image is
 * malformed", so none of them ever gets as far as the swap. What is left
 * are the failures of the ENVIRONMENT rather than the file: a disk that
 * fills up mid-copy, a USB stick pulled out, a virus scanner holding the
 * destination open. Those cannot be staged in a spec.
 *
 * So the one genuinely unstageable step — the write — is a parameter, and
 * backup/restore.spec.ts drives this function with a write that throws
 * against real files in a real directory. Everything else it exercises is
 * the production code: the real rename, the real rollback, the real
 * sidecar handling. The seam is at a real boundary and it is the only
 * reason the rollback is tested at all rather than hoped about.
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
 * Writes the chosen backup into place.
 *
 * *** THROUGH THE ONLINE BACKUP API, NOT `fs.copyFileSync`, AND FOR THE
 * SAME REASON THE BACKUP USES IT. *** The file the user picked may be a
 * WAL-mode database with a hot `-wal` beside it — most obviously when they
 * are restoring a collection they copied off another machine while that app
 * was running. A plain copy of the `.db` would take the stale main file and
 * silently drop whatever is in the WAL. Reading it through a connection
 * takes the complete, committed, logical database and writes it out as ONE
 * self-contained file, which also means the restored collection arrives
 * with no sidecars to be confused by.
 *
 * The rate is the backup's, so a multi-gigabyte restore keeps yielding to
 * the event loop and the server stays able to answer /api/health while it
 * runs. There is no progress callback and no cancel: see this file's
 * header for why a cancel here would be a loaded gun.
 */
async function restoreCopy(source: string, destination: string): Promise<void> {
  await copyDatabaseFile({
    sourceFile: source,
    destination,
    rate: DEFAULT_BACKUP_RATE_PAGES,
    onProgress: () => {
      /* Nothing to report to, by design. */
    },
  });
}

/**
 * Re-reads what actually landed, and insists it matches what was promised.
 *
 * *** THE POINT IS THE COIN COUNT. *** The tables being present only proves
 * a database was written. Comparing the count against the number the
 * inspection read out of the SOURCE a moment ago proves the thing that was
 * written is the thing the user chose — a short write, a full disk or a
 * truncated copy all show up here as a number that does not match, and all
 * of them then roll back instead of becoming a quietly incomplete
 * collection.
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
 * Picks a free name for the displaced collection, in the SAME FOLDER.
 *
 * Same folder on purpose. It is the folder the user will be sent to by the
 * message, a rename within one volume is atomic where a move across volumes
 * is a copy-and-delete, and `%LOCALAPPDATA%\CoinInventory` is somewhere the
 * application already knows is writable.
 */
function chooseAsidePath(directory: string, databasePath: string, now: Date): string {
  const desired = asideFileName(path.basename(databasePath), now);
  const unique = uniqueFileName(desired, (candidate) =>
    fs.existsSync(path.join(directory, candidate))
  );
  return path.join(directory, unique);
}

/**
 * Renames the current collection out of the way. Returns false when there
 * was nothing there (a first run, or a restore onto a fresh install).
 *
 * *** THE SIDECARS MOVE WITH IT, AND THIS IS NOT OPTIONAL. *** A `-wal`
 * left behind belongs to the database that has just been renamed away.
 * SQLite would find it sitting next to the RESTORED file and try to apply
 * one database's write-ahead log to another, which is a corruption, not an
 * error message. The pool was closed cleanly a moment ago so there usually
 * are none — but "usually" is not a standard that applies here, and a
 * process killed during a previous run leaves exactly this state behind.
 *
 * Moving them rather than deleting them also keeps the displaced database
 * COMPLETE: whatever was in that WAL is still recoverable by copying all
 * three files back.
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
      // If it cannot be MOVED it must not be LEFT. See above.
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
 * Puts the user back exactly where they started.
 *
 * Deletes whatever partial file the failed restore left at the live path,
 * then renames the displaced collection back onto it. Every step is
 * best-effort and logged rather than thrown, because this runs inside a
 * `catch`: a throw from here would replace the real failure with a
 * secondary one and lose the explanation.
 *
 * If the rename back fails, the collection is still ON DISK under the aside
 * name — so the worst case is a user who has to copy one file, and the log
 * line tells them which.
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
 * Same file, allowing for `/` vs `\` and for Windows' case-insensitivity.
 *
 * Compared as text rather than by inode, because one of the two paths is
 * something the user typed and may not exist yet.
 */
function samePath(a: string, b: string): boolean {
  const normalise = (value: string): string =>
    path.resolve(value.trim()).replace(/[\\/]+$/, '').toLowerCase();
  return normalise(a) === normalise(b);
}
