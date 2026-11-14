/**
 * services/backup/backup-messages.ts — WHAT THE USER READS, as pure
 * functions over the server's answers.
 *
 * *** WHY THIS IS A MODULE AND NOT TEMPLATE EXPRESSIONS. ***
 * Two reasons, and the second is the one that decided it.
 *
 * 1. The suite runs under Node with NO jsdom, so nothing here can be
 *    tested through a rendered component. Logic that lives in a template
 *    is logic with no test.
 * 2. These sentences are the safety feature. Everything the server does
 *    to protect a collection — refusing a newer schema, moving the old
 *    database aside, warning that photographs will not follow — only
 *    protects anybody if the user UNDERSTANDS it at the moment they are
 *    about to press a button. "Verdict: newer-schema" protects nobody.
 *    So the wording is code, and it is held still by backup-messages.spec.ts.
 *
 * Nothing here talks to the network, holds state or touches the DOM.
 */

/* ===================== The server's shapes ===================== */

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
 * One `*.db` file the SERVER found in a folder the user named.
 *
 * The browser cannot read a folder, so this is the only way the restore
 * box can offer a choice instead of demanding an exact path. See
 * server/backup/list-db-files.ts for what the endpoint will and will not
 * tell us.
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

/* ===================== Formatting ===================== */

/**
 * `612.3 MB`. Decimal units, because that is what Windows Explorer shows
 * and a user comparing this figure with the one in their folder should
 * not have to wonder why they disagree.
 */
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

/**
 * `14 Nov 2026, 15:04` in the user's own timezone, or "unknown" when the
 * file carries no stamp.
 *
 * LOCAL, not the ISO string the file holds. The stamp is UTC because a
 * machine reads it; this is the human reading it, and the question they
 * are answering — "is this the one I took this morning?" — is about their
 * morning, not Greenwich's.
 */
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

/* ===================== The backup panel ===================== */

/**
 * The status line under the progress bar.
 *
 * *** IT NAMES THE FILE ON SUCCESS, EVERY TIME. *** §16 asks for the path
 * to be reported afterwards, and it is the single most useful thing on the
 * screen: a user who cannot find the file they just made does not have a
 * backup, whatever the application believes.
 */
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
      // Said explicitly, because an unfinished file WOULD be dangerous and
      // the user needs to know one was not left behind.
      return 'Backup cancelled. No file was left behind.';
    case 'failed':
      return status.error ?? 'The backup did not finish.';
  }
}

/** Should the Cancel button be on screen? */
export function canCancelBackup(status: BackupJobStatus | null): boolean {
  return status?.state === 'running';
}

/* ===================== The restore panel ===================== */

/**
 * The lines describing what is IN a candidate file, so the user can tell
 * one backup from another before replacing a collection with it.
 *
 * Empty for a file that was refused: there is nothing in it worth
 * summarising, and listing "0 coins" next to "that is not a Coin Inventory
 * backup" reads as though we looked and found it empty.
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
 * *** CONSEQUENCE OF PORTABILITY #1, SAID OUT LOUD. ***
 *
 * In 'referenced' mode the database holds only a path into a folder on the
 * machine the import ran on. Carried to another PC that folder is not
 * there, and the user gets a grid of empty picture frames with nothing to
 * explain it — and no way to tell whether the backup is bad, the restore
 * went wrong, or the app is broken.
 *
 * So it is said BEFORE the restore, in terms of what will actually be
 * missing. It does NOT pretend there is a fix: the photo-relocation tool
 * (design §4.4) is not built, and promising one would be worse than the
 * silence. What it does say is the part that stops the panic — the COINS
 * are all there; it is the link to the picture files that does not travel.
 *
 * Returns null when there is nothing to warn about, which is the common
 * case and must not produce an empty yellow box.
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
    // Referenced photos, but every folder is here. Still worth a word,
    // because it is true today and may not be tomorrow — a USB drive with
    // a different letter next time is the same problem.
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

/**
 * The one-line answer to "what will happen if I press Restore?".
 *
 * Deliberately blunt about the two facts that matter and that a user will
 * not infer: their current collection is REPLACED, and it is KEPT.
 */
export function describeRestoreConsequence(inspection: BackupInspection | null): string | null {
  if (!inspection || !inspection.decision.acceptable) return null;
  return (
    `Restoring will replace the collection you are using now with ` +
    `${describeCoinCount(inspection.coinCount)} from this file. Your current collection ` +
    `is not deleted — it is renamed and left in the same folder, and the next screen ` +
    `will tell you exactly where.`
  );
}

/**
 * What to say after a restore has succeeded.
 *
 * *** THE LOCATION OF THE OLD COLLECTION IS THE WHOLE MESSAGE. *** It is
 * the undo button, and a user who has just realised they picked the wrong
 * file needs it on screen, in full, not in a log.
 */
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

/* ===================== Choosing a file instead of typing one =====================
 *
 * Everything below exists because of one sentence of feedback after the
 * feature was first tested: *"It wasn't intuitive how to do the restore
 * because the watermarked restore field looked like it was filled in text
 * and it could leave the user bewildered why the buttons weren't
 * enabled."*
 *
 * Two separate faults in that sentence, and they compound:
 *
 *   1. A grey example path inside an empty box READS AS A VALUE. The user
 *      believed the field was set.
 *   2. A disabled button gives no reason. Believing the field was set,
 *      there was nothing on screen that could correct the belief.
 *
 * So a disabled control here owes the user a sentence, and that sentence
 * is written HERE rather than in the template for the reason the header
 * of this file gives: the suite has no jsdom, so wording that lives in a
 * template is wording with no test.
 */

/**
 * `612.3 MB · 14 Nov 2026, 16:20` — enough to tell two backups apart.
 *
 * Size AND date, because a folder of near-identically named files is
 * precisely the situation the chooser exists for, and the two questions
 * being asked are "which is the newest" and "which is the full one".
 */
export function describeBackupFile(entry: BackupFileEntry): string {
  return `${formatBytes(entry.sizeBytes)} · ${formatTakenAt(entry.modifiedAt)}`;
}

/**
 * The line above the list of files.
 *
 * *** AN EMPTY FOLDER IS A NORMAL OUTCOME AND MUST SAY SO. *** It is what
 * the user gets for guessing a folder, for a fresh install, and — the one
 * that matters — for a folder picker that narrowed the guess to the wrong
 * parent. "No backups in that folder" sends them to check the path;
 * silence, or a bare empty box, sends them to wonder whether their
 * backups are gone.
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

/**
 * *** WHY "BACK UP NOW" IS OFF. *** Null when it is not off.
 *
 * `running` is deliberately NOT a reason: while a backup is running there
 * is a progress bar and a Cancel button directly above, which say it
 * better than a sentence would.
 */
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

/**
 * *** WHY "CHECK THIS FILE" IS OFF. *** Null when it is not off.
 *
 * The one that caused the real confusion, so it names the grey text
 * explicitly: the user's belief was that the box was filled in, and
 * nothing short of contradicting that belief will shift it.
 */
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
