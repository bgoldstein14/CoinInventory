/**
 * backup/metadata.ts — WHAT A BACKUP SAYS ABOUT ITSELF, as pure functions.
 *
 * *** THE PROBLEM THIS SOLVES: TWO FILES IN A FOLDER AND NO WAY TO TELL
 * THEM APART. *** The user is about to replace their collection. They have
 * `coin-inventory-backup-2026-11-14-0900.db` and
 * `coin-inventory-backup-2026-11-14-1700.db` and they cannot remember which
 * one was before they deleted half the silver by accident. §16 therefore
 * requires restore to "say what is in the file before committing: coin
 * count, date taken" — and that is only possible if the file was asked to
 * carry those two facts at the moment it was written.
 *
 * The file modification time is not a substitute. Copying a backup to a USB
 * stick, emailing it, or restoring it from a cloud sync all rewrite it, and
 * the one place that happens most is exactly the portability case §16 is
 * about: the file has been MOVED TO ANOTHER MACHINE.
 *
 * The rows live in AppSettings under a `backup.` prefix — see
 * db/backup.ts's writeBackupMetadata() for why there and not in a sidecar
 * file or a new table. This module only decides what goes in them and how
 * to read them back, so both halves are one pure round trip a test can hold.
 */

import { BACKUP_METADATA_PREFIX } from '../db';

/** When the backup was taken. ISO-8601 UTC, because a machine reads this. */
export const TAKEN_AT_KEY = `${BACKUP_METADATA_PREFIX}takenAt`;

/** How many coins were in it. The number the user actually recognises. */
export const COIN_COUNT_KEY = `${BACKUP_METADATA_PREFIX}coinCount`;

/**
 * The `PRAGMA user_version` at the time of writing.
 *
 * REDUNDANT ON PURPOSE. The pragma is the authority and
 * backup/verdict.ts reads the pragma, never this. This row exists so that
 * somebody opening the file in a SQLite browser — or reading a support
 * report — can see the version without knowing that a pragma is a thing.
 * If the two ever disagree, the pragma wins and the file has been edited.
 */
export const SCHEMA_VERSION_KEY = `${BACKUP_METADATA_PREFIX}schemaVersion`;

/** What this file is, in words, for whoever opens it in five years. */
export const DESCRIPTION_KEY = `${BACKUP_METADATA_PREFIX}description`;

export const BACKUP_DESCRIPTION =
  'Backup of a Coin Inventory collection. Restore it from Settings > Backup and restore.';

/** The facts a finished backup is stamped with. */
export interface BackupStamp {
  readonly takenAt: Date;
  readonly coinCount: number;
  readonly schemaVersion: number;
}

/** The AppSettings rows to write into a finished copy. */
export function buildBackupMetadata(stamp: BackupStamp): Record<string, string> {
  return {
    [TAKEN_AT_KEY]: stamp.takenAt.toISOString(),
    [COIN_COUNT_KEY]: String(stamp.coinCount),
    [SCHEMA_VERSION_KEY]: String(stamp.schemaVersion),
    [DESCRIPTION_KEY]: BACKUP_DESCRIPTION,
  };
}

/** What a candidate file turned out to say about itself. */
export interface BackupProvenance {
  /** ISO-8601, or null when the file carries no stamp. */
  readonly takenAt: string | null;
  /** The count RECORDED when the backup was taken, or null. */
  readonly recordedCoinCount: number | null;
}

/**
 * Reads the stamp back out of whatever `backup.*` rows a file carried.
 *
 * *** EVERY FIELD IS OPTIONAL AND A MISSING ONE IS NOT AN ERROR. *** Any
 * backup taken before this feature existed has none of them, and any file
 * a user has edited may have nonsense in them. Neither is a reason to
 * refuse a restore — the pragma and the table list decide that — so this
 * returns nulls and lets the dialog say "unknown", which is the truth.
 */
export function readBackupProvenance(
  metadata: Readonly<Record<string, string>>
): BackupProvenance {
  return {
    takenAt: validIsoDate(metadata[TAKEN_AT_KEY]),
    recordedCoinCount: nonNegativeInteger(metadata[COIN_COUNT_KEY]),
  };
}

/** The string back if it parses as a date, else null. No half-answers. */
function validIsoDate(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : value;
}

function nonNegativeInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
