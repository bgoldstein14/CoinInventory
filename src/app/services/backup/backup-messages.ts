/**
 * User-facing backup and restore wording, as pure functions over the server's
 * responses. Kept out of templates so it can be tested under Node (no jsdom).
 */

/* Server response shapes */

export type BackupJobState = 'running' | 'done' | 'cancelled' | 'failed';

export interface BackupResult {
  readonly path: string;
  readonly fileSizeBytes: number;
  readonly pagesCopied: number;
  readonly coinCount: number;
  readonly takenAt: string;
  readonly schemaVersion: number;
}

export interface BackupJobStatus {
  readonly id: string;
  readonly state: BackupJobState;
  readonly destination: string;
  readonly percent: number;
  readonly totalPages: number;
  readonly copiedPages: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly result: BackupResult | null;
  readonly error: string | null;
}

export interface BackupSuggestion {
  readonly directory: string;
  readonly fileName: string;
  readonly databasePath: string | null;
  readonly databaseSizeBytes: number | null;
}

export type RestoreVerdict =
  | 'ok'
  | 'unversioned'
  | 'missing'
  | 'not-sqlite'
  | 'unreadable'
  | 'not-this-app'
  | 'newer-schema';

export interface RestoreDecision {
  readonly verdict: RestoreVerdict;
  readonly acceptable: boolean;
  readonly message: string;
  readonly missingTables: readonly string[];
}

export interface ReferencedFolder {
  readonly folder: string;
  readonly presentOnThisMachine: boolean;
}

export interface BackupInspection {
  readonly path: string;
  readonly fileSizeBytes: number | null;
  readonly decision: RestoreDecision;
  readonly schemaVersion: number | null;
  readonly coinCount: number | null;
  readonly imageCount: number | null;
  readonly storedImageCount: number | null;
  readonly referencedOnlyImageCount: number | null;
  readonly referencedFolders: readonly ReferencedFolder[];
  readonly provenance: {
    readonly takenAt: string | null;
    readonly recordedCoinCount: number | null;
  };
}

/**
 * One `*.db` file the server found in the named folder, letting the restore
 * box offer a choice (see server/backup/list-db-files.ts).
 */
export interface BackupFileEntry {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export interface BackupDirectoryListing {
  readonly directory: string;
  readonly files: readonly BackupFileEntry[];
  readonly truncated: boolean;
}

export interface RestoreResult {
  readonly restoredFrom: string;
  readonly databasePath: string;
  readonly previousCollectionMovedTo: string | null;
  readonly coinCount: number;
  readonly referencedOnlyImageCount: number;
  readonly missingPhotoFolders: readonly string[];
  readonly takenAt: string | null;
  readonly serverRestartRequired: boolean;
}

/* Formatting */

/** `612.3 MB`. Decimal units, matching Windows Explorer. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return 'unknown size';
  }
  if (bytes < 1000) return `${Math.round(bytes)} bytes`;

  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `14 Nov 2026, 15:04` in local time (the file stamp is UTC), or "unknown". */
export function formatTakenAt(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'unknown';

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (value: number): string => String(value).padStart(2, '0');

  return (
    `${when.getDate()} ${months[when.getMonth()]} ${when.getFullYear()}, ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** `412 coins` / `1 coin` / `an unknown number of coins`. */
export function describeCoinCount(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return 'an unknown number of coins';
  }
  return count === 1 ? '1 coin' : `${count} coins`;
}

/* Backup panel */

/** The status line under the progress bar; names the file on success. */
export function describeBackupStatus(status: BackupJobStatus | null): string {
  if (!status) return '';

  switch (status.state) {
    case 'running':
      return status.totalPages > 0
        ? `Copying your collection… ${status.percent}%`
        : 'Starting the backup…';
    case 'done':
      return (
        `Backup complete — ${describeCoinCount(status.result?.coinCount ?? null)}, ` +
        `${formatBytes(status.result?.fileSizeBytes ?? null)}.`
      );
    case 'cancelled':
      return 'Backup cancelled. No file was left behind.';
    case 'failed':
      return status.error ?? 'The backup did not finish.';
  }
}

/** Whether the Cancel button is shown. */
export function canCancelBackup(status: BackupJobStatus | null): boolean {
  return status?.state === 'running';
}

/* Restore panel */

/**
 * Lines describing what is in a candidate backup, so backups can be told
 * apart. Empty for a refused file.
 */
export function describeBackupContents(inspection: BackupInspection | null): string[] {
  if (!inspection || !inspection.decision.acceptable) return [];

  const lines = [
    `${describeCoinCount(inspection.coinCount)} in this backup.`,
    `Taken ${formatTakenAt(inspection.provenance.takenAt)}.`,
    `File size ${formatBytes(inspection.fileSizeBytes)}.`,
  ];

  if ((inspection.imageCount ?? 0) > 0) {
    lines.push(
      `${inspection.imageCount} photograph${inspection.imageCount === 1 ? '' : 's'}, ` +
        `${inspection.storedImageCount ?? 0} kept inside the file.`
    );
  }

  return lines;
}

/**
 * Warning about photos before a restore. In 'referenced' mode the database
 * holds only paths to image folders on the original machine, so on another PC
 * the photos will be missing although all coins restore. Null when there is
 * nothing to warn about.
 */
export function describePhotoWarning(
  referencedOnlyImageCount: number | null | undefined,
  missingFolders: readonly string[] | null | undefined
): string | null {
  const count = referencedOnlyImageCount ?? 0;
  if (count <= 0) return null;

  const photos = count === 1 ? '1 photograph' : `${count} photographs`;
  const folders = missingFolders ?? [];

  if (folders.length === 0) {
    // All folders are present now, but a drive letter can change next time.
    return (
      `${photos} in this backup are links to picture files on disk rather than copies ` +
      `kept inside it. Those folders are on this computer at the moment, so the photos ` +
      `will show — but they will disappear if the files are moved, renamed or deleted.`
    );
  }

  const folderList = folders.join(', ');
  return (
    `${photos} in this backup are links to picture files rather than copies kept inside ` +
    `it, and the folder${folders.length === 1 ? '' : 's'} they point to ` +
    `(${folderList}) ${folders.length === 1 ? 'is' : 'are'} not on this computer. ` +
    `Those coins will restore completely — every detail, price and note — but they will ` +
    `show no photograph until the picture files are available here again.`
  );
}

/** "What happens if I press Restore?": the current collection is replaced, and kept. */
export function describeRestoreConsequence(inspection: BackupInspection | null): string | null {
  if (!inspection || !inspection.decision.acceptable) return null;
  return (
    `Restoring will replace the collection you are using now with ` +
    `${describeCoinCount(inspection.coinCount)} from this file. Your current collection ` +
    `is not deleted — it is renamed and left in the same folder, and the next screen ` +
    `will tell you exactly where.`
  );
}

/** Message after a successful restore, including where the old collection was kept. */
export function describeRestoreOutcome(result: RestoreResult): string[] {
  const lines = [
    `Restored ${describeCoinCount(result.coinCount)} from ${result.restoredFrom}.`,
  ];

  if (result.previousCollectionMovedTo) {
    lines.push(
      `Your previous collection was NOT deleted. It is saved as ` +
        `${result.previousCollectionMovedTo} — if this was the wrong file, close Coin ` +
        `Inventory and copy that file back over ${result.databasePath}.`
    );
  } else {
    lines.push('There was no existing collection to keep.');
  }

  return lines;
}

/*
 * Choosing a file, and explaining disabled buttons. An empty box showing a grey
 * example path can look filled in, so every disabled control gives a reason.
 */

/** `612.3 MB · 14 Nov 2026, 16:20`: size and date, to tell backups apart. */
export function describeBackupFile(entry: BackupFileEntry): string {
  return `${formatBytes(entry.sizeBytes)} · ${formatTakenAt(entry.modifiedAt)}`;
}

/**
 * The line above the file list. An empty folder is a normal outcome (a guessed
 * or wrong folder, a fresh install) and gets a sentence naming the folder.
 */
export function describeFolderListing(listing: BackupDirectoryListing | null): string | null {
  if (!listing) return null;

  if (listing.files.length === 0) {
    return (
      `That folder exists, but there are no backup (.db) files in ${listing.directory}. ` +
      `Either this is not the folder your backups are in, or none have been made yet.`
    );
  }

  const count =
    listing.files.length === 1 ? '1 backup file' : `${listing.files.length} backup files`;
  const head = `${count} in ${listing.directory}, newest first.`;
  return listing.truncated ? `${head} Only the first 200 are shown.` : head;
}

/** Why "Back up now" is disabled, or null. Not given while running (the progress bar explains it). */
export function describeBackupBlock(directory: string, running: boolean): string | null {
  if (running) return null;
  if (directory.trim().length === 0) {
    return (
      'The folder box is empty, so there is nowhere to write the backup. ' +
      'Type or paste a folder, or use "Choose folder…" above. ' +
      'The grey text in the box is an example, not a value.'
    );
  }
  return null;
}

/** Why "Check this file" is disabled, or null; mentions that the grey text is only an example. */
export function describeRestoreBlock(
  chosenPath: string,
  inspecting: boolean,
  restoring: boolean
): string | null {
  if (inspecting || restoring) return null;
  if (chosenPath.trim().length === 0) {
    return (
      'No backup file is chosen yet, so there is nothing to check. ' +
      'Pick one from the list above, or paste the full path of a .db file. ' +
      'The grey text in the box is an example, not a value.'
    );
  }
  return null;
}
