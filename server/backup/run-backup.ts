/**
 * backup/run-backup.ts — TAKING THE BACKUP. One function, and the clean-up
 * rules that go with it.
 *
 * *** WHAT MAKES THIS CORRECT, IN ONE PARAGRAPH. *** The collection is a
 * WAL-mode SQLite database, so the newest transactions live in a `-wal`
 * sibling until a checkpoint folds them in. Copying the `.db` by itself
 * produces a database that opens cleanly, passes an integrity check, and is
 * missing the user's most recent coins — the worst failure shape available.
 * This uses SQLite's ONLINE BACKUP API instead (db/backup.ts ->
 * db/driver.ts), which reads the database through a connection and
 * therefore sees the WAL. The result is a consistent snapshot taken while
 * the application is running, and the "close the app before copying your
 * database" warning the earlier plan needed is simply not true of it.
 * backup/backup.spec.ts measures both halves of that claim.
 *
 * *** WHAT MAKES IT BEARABLE. *** The owner's database is around 600 MB
 * today and design §4.9a makes multi-gigabyte ordinary, so this is a job
 * measured in minutes, not a button that returns. It is incremental: a
 * batch of pages, a progress callback, back to the event loop. That is what
 * lets the dialog show a real percentage, lets Cancel work, and lets the
 * rest of the application keep answering requests while it runs.
 */

import fs from 'fs';
import path from 'path';

import {
  buildDbConfig,
  copyDatabaseFile,
  IN_MEMORY_DATABASE,
  readDatabaseFileFacts,
  writeBackupMetadata,
} from '../db';
import { logInfo, logWarn } from '../logger';
import { buildBackupMetadata } from './metadata';
import { backupFileName, describeBadDestination, uniqueFileName } from './names';

/**
 * Pages copied per batch.
 *
 * With SQLite's 4 KB default page size this is 2 MB of copying between
 * yields. It sets three things at once and is a compromise between them:
 *
 *   PROGRESS GRANULARITY  a 600 MB database reports ~300 times, which is a
 *                         bar that visibly moves without flooding the
 *                         status endpoint with no-op updates.
 *   CANCEL LATENCY        the longest a Cancel can wait is one batch.
 *   THROUGHPUT            smaller batches mean more round trips through the
 *                         event loop and a measurably slower backup.
 *
 * It is NOT tuned to make the tests fast; the specs pass their own rate
 * where they need many callbacks from a small database.
 */
export const DEFAULT_BACKUP_RATE_PAGES = 512;

/** Thrown by the progress callback to stop a backup. See cancellation below. */
export class BackupCancelled extends Error {
  constructor() {
    super('The backup was cancelled.');
    this.name = 'BackupCancelled';
  }
}

/** A problem the USER can fix, as opposed to a fault. Surfaces as a 400. */
export class BackupRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRequestError';
  }
}

export interface BackupRequest {
  /** The folder the user chose. Absolute. */
  readonly directory: string;
  /** The file name, or omitted to use today's suggested one. */
  readonly fileName?: string;
  /** Pages per batch. Defaults to DEFAULT_BACKUP_RATE_PAGES. */
  readonly rate?: number;
  /** Called after every batch, with the fraction done. */
  readonly onProgress?: (progress: BackupProgress) => void;
  /**
   * Asked after every batch. Returning true throws BackupCancelled out of
   * the progress callback, which is the only way to stop `backup()`.
   */
  readonly isCancelled?: () => boolean;
  /** Injected so the specs can pin the name. Defaults to now. */
  readonly now?: Date;
  /**
   * A destination already resolved by resolveBackupDestination().
   *
   * backup/jobs.ts resolves it BEFORE starting the job, so that "there is
   * no folder called D:\Backpus" is a 400 the user sees next to the box
   * they typed in, rather than a job that appears to start and then fails
   * in a progress panel. Passing it here means the answer is not computed
   * twice — which matters, because resolution picks a FREE name and
   * computing it twice could pick two.
   */
  readonly destinationPath?: string;
}

export interface BackupProgress {
  readonly totalPages: number;
  readonly copiedPages: number;
  /** 0-100, integer, monotonic. See percentComplete(). */
  readonly percent: number;
}

export interface BackupResult {
  /** The file that now exists. Report this to the user verbatim. */
  readonly path: string;
  readonly fileSizeBytes: number;
  readonly pagesCopied: number;
  readonly coinCount: number;
  /** ISO-8601. The same value written into the file. */
  readonly takenAt: string;
  readonly schemaVersion: number;
}

/**
 * Percentage done, from SQLite's count-down.
 *
 * `backup()` reports pages REMAINING, which is the opposite of what a
 * progress bar wants, and reports `totalPages: 0` for an empty database —
 * where 0/0 is NaN and a bar jammed at the left for a backup that has
 * actually finished. Both are handled here rather than at the call site so
 * there is one place to be wrong.
 *
 * Clamped to 0..100 and floored: a bar that reads 100% while the file is
 * still being written is a bar that gets Cancel pressed.
 */
export function percentComplete(totalPages: number, remainingPages: number): number {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 100;
  const copied = totalPages - Math.max(0, remainingPages);
  const fraction = copied / totalPages;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

/**
 * Takes the backup. Resolves with where it went; rejects with
 * BackupCancelled if the user stopped it, or BackupRequestError if the
 * destination was unusable.
 */
export async function performBackup(request: BackupRequest): Promise<BackupResult> {
  const now = request.now ?? new Date();
  const sourceFile = resolveSourceFile();
  const destination = request.destinationPath ?? resolveBackupDestination(request, now);

  logInfo(`Backing up the coin database to ${destination}`);

  const rate = request.rate ?? DEFAULT_BACKUP_RATE_PAGES;
  let lastTotalPages = 0;

  try {
    const pagesCopied = await copyDatabaseFile({
      sourceFile,
      destination,
      rate,
      onProgress: ({ totalPages, remainingPages }) => {
        lastTotalPages = totalPages;

        /* CANCELLATION.
         *
         * `backup()` offers no cancel token; throwing from the progress
         * callback is the documented way to abort it, and the rejection
         * carries what was thrown. So the Cancel button sets a flag, this
         * reads it once per batch, and the throw unwinds through the
         * driver — at which point the catch below deletes the half-written
         * file. A cancelled backup must leave NOTHING behind, because a
         * truncated `.db` sitting in the user's chosen folder with a
         * plausible name is a trap they will restore from later. */
        if (request.isCancelled?.()) throw new BackupCancelled();

        request.onProgress?.({
          totalPages,
          copiedPages: Math.max(0, totalPages - remainingPages),
          percent: percentComplete(totalPages, remainingPages),
        });
      },
    });

    // Counted from the COPY, not from the live database. The copy is the
    // thing the number describes, and between the snapshot and this line
    // the user may well have added a coin.
    const facts = readDatabaseFileFacts(destination);
    const coinCount = facts.coinCount ?? 0;
    const takenAt = now;

    // Stamped into the COPY after it is complete, never into the live
    // database — see db/backup.ts's writeBackupMetadata().
    writeBackupMetadata(
      destination,
      buildBackupMetadata({ takenAt, coinCount, schemaVersion: facts.schemaVersion })
    );

    const fileSizeBytes = fs.statSync(destination).size;
    logInfo(
      `Backup complete: ${destination} (${fileSizeBytes} bytes, ${coinCount} coin(s), ` +
        `${pagesCopied} page(s), collection format ${facts.schemaVersion}).`
    );

    return {
      path: destination,
      fileSizeBytes,
      pagesCopied,
      coinCount,
      takenAt: takenAt.toISOString(),
      schemaVersion: facts.schemaVersion,
    };
  } catch (err) {
    discardPartialFile(destination);
    if (err instanceof BackupCancelled) {
      logInfo(`Backup cancelled by the user after ~${lastTotalPages} page(s); ${destination} removed.`);
    }
    throw err;
  }
}

/**
 * The live database file. Refuses an in-memory one with a sentence that
 * says what is actually wrong.
 *
 * An in-memory database is what the test harness runs on, and it has no
 * file to copy: `backup()` would need a source connection this module does
 * not own. Rather than quietly producing an empty file, it stops.
 */
function resolveSourceFile(): string {
  const config = buildDbConfig();
  if (config.file === IN_MEMORY_DATABASE) {
    throw new BackupRequestError(
      'This copy of Coin Inventory is running on a temporary in-memory collection, ' +
        'so there is nothing on disk to back up.'
    );
  }
  if (!fs.existsSync(config.file)) {
    throw new BackupRequestError(
      'The collection file could not be found, so there is nothing to back up yet. ' +
        'Add a coin and try again.'
    );
  }
  return config.file;
}

/**
 * Turns the user's folder and (optional) name into a free path to write,
 * or throws BackupRequestError saying why it cannot.
 *
 * Called by backup/jobs.ts BEFORE the job starts, so every "you cannot
 * write there" is a synchronous 400 against the box the user typed in
 * rather than a job that fails a second later somewhere else on screen.
 *
 * THE OVERWRITE RULE IS THE IMPORTANT PART. Two backups in the same minute
 * suggest the same name, and writing over the first one destroys a copy the
 * user may be relying on — most likely at exactly the moment they are
 * pressing Backup repeatedly because something has gone wrong. So an
 * existing file is never replaced; the name gains ` (2)`.
 */
export function resolveBackupDestination(request: BackupRequest, now = new Date()): string {
  const directory = request.directory?.trim() ?? '';
  const fileName = (request.fileName?.trim() ?? '') || backupFileName(now);

  const complaint = describeBadDestination(directory, fileName);
  if (complaint !== null) throw new BackupRequestError(complaint);

  if (!directoryExists(directory)) {
    throw new BackupRequestError(
      `There is no folder called ${directory} on this computer. Check the path, ` +
        `or create the folder first.`
    );
  }

  const unique = uniqueFileName(fileName, (candidate) =>
    fs.existsSync(path.join(directory, candidate))
  );
  return path.join(directory, unique);
}

function directoryExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Removes a backup that did not finish, and its sidecars.
 *
 * *** A PARTIAL BACKUP MUST NOT SURVIVE. *** It is a plausible-looking file
 * with a plausible-looking name in the folder the user keeps their backups
 * in, and the whole point of the restore validation is undermined if the
 * most likely bad file is one we left there ourselves. (It would usually be
 * caught — a truncated database fails to open — but "usually" is not the
 * standard for the thing that replaces a collection.)
 */
function discardPartialFile(destination: string): void {
  for (const candidate of [destination, `${destination}-wal`, `${destination}-shm`]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch (err) {
      logWarn(
        `Could not remove the incomplete backup at ${candidate}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
