/**
 * What a backup records about itself (taken-at time, coin count, schema
 * version), so restore can show which backup is which. File modification
 * times aren't reliable once a file is copied or synced. Stored in the
 * copy's AppSettings under `backup.` (see db/backup.ts).
 */

import { BACKUP_METADATA_PREFIX } from '../db';

/** When the backup was taken. ISO-8601 UTC. */
export const TAKEN_AT_KEY = `${BACKUP_METADATA_PREFIX}takenAt`;

/** How many coins were in it. */
export const COIN_COUNT_KEY = `${BACKUP_METADATA_PREFIX}coinCount`;

/**
 * The schema version at the time of writing, for people inspecting the file.
 * backup/verdict.ts uses the pragma, never this.
 */
export const SCHEMA_VERSION_KEY = `${BACKUP_METADATA_PREFIX}schemaVersion`;

/** A human-readable description of the file. */
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
 * Reads the stamp back from a file's `backup.*` rows. Every field is optional:
 * older or edited files may lack them, and missing values read as null.
 */
export function readBackupProvenance(
  metadata: Readonly<Record<string, string>>
): BackupProvenance {
  return {
    takenAt: validIsoDate(metadata[TAKEN_AT_KEY]),
    recordedCoinCount: nonNegativeInteger(metadata[COIN_COUNT_KEY]),
  };
}

/** The string if it parses as a date, else null. */
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
