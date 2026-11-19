/**
 * Takes a backup using SQLite's online backup API (db/backup.ts), which reads
 * through a connection and so includes the -wal contents; copying the .db file
 * alone would silently miss recent changes. It runs while the app is in use,
 * in batches, so the dialog can show progress and Cancel works.
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
 * Pages copied per batch (2 MB at the default 4 KB page size). Balances
 * progress granularity, cancel latency (at most one batch) and throughput.
 * Specs pass their own rate where needed.
 */
export const DEFAULT_BACKUP_RATE_PAGES = 512;

/** Thrown by the progress callback to stop a backup. */
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
  /** Checked after every batch; true cancels the backup. */
  readonly isCancelled?: () => boolean;
  /** Injected so the specs can pin the name. Defaults to now. */
  readonly now?: Date;
  /**
   * A destination already resolved by resolveBackupDestination(). jobs.ts
   * resolves it before starting so the free name is chosen exactly once.
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
 * Percentage done from SQLite's remaining-pages count. Handles
 * totalPages = 0 (empty database), and clamps to 0..100 and floors so 100%
 * isn't shown while the file is still being written.
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

        // backup() has no cancel token; throwing from the progress callback
        // aborts it, and the catch below deletes the partial file.
        if (request.isCancelled?.()) throw new BackupCancelled();

        request.onProgress?.({
          totalPages,
          copiedPages: Math.max(0, totalPages - remainingPages),
          percent: percentComplete(totalPages, remainingPages),
        });
      },
    });

    // Counted from the copy, which may differ from the live database by now.
    const facts = readDatabaseFileFacts(destination);
    const coinCount = facts.coinCount ?? 0;
    const takenAt = now;

    // Stamped into the finished copy, never the live database.
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
 * The live database file. Refuses an in-memory database (as used by tests),
 * which has no file to copy.
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
 * Turns the user's folder and optional name into a free path to write, or
 * throws BackupRequestError. An existing file is never overwritten; the name
 * gets a ` (2)` suffix instead.
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
 * Removes a backup that did not finish, and its sidecars, so a truncated file
 * is never left in the user's backup folder.
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
