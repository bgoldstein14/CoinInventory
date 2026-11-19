/**
 * File names the backup feature creates:
 *
 *   coin-inventory-backup-2026-11-14-1432.db      a backup
 *   coin-inventory.replaced-2026-11-14-143215.db  the old collection, after a restore
 *
 * Local time (they're read by the user; the ISO timestamp lives inside the
 * file, see backup/metadata.ts). No colons or spaces.
 */

/** The extension every backup gets. */
export const BACKUP_EXTENSION = '.db';

/** The stem of a suggested backup file name. */
export const BACKUP_NAME_STEM = 'coin-inventory-backup';

/** What a displaced collection is marked with. See asideFileName(). */
export const REPLACED_MARKER = 'replaced';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2026-11-14-1432`: local date and time to the minute. Collisions are handled by uniqueFileName(). */
export function minuteStamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/** `2026-11-14-143215`: local time to the second, so two restores a minute apart get different aside names. */
export function secondStamp(now: Date): string {
  return `${minuteStamp(now)}${pad(now.getSeconds())}`;
}

/** `coin-inventory-backup-2026-11-14-1432.db`. */
export function backupFileName(now: Date): string {
  return `${BACKUP_NAME_STEM}-${minuteStamp(now)}${BACKUP_EXTENSION}`;
}

/**
 * What the current collection is renamed to when a restore displaces it:
 * `coin-inventory.db` -> `coin-inventory.replaced-2026-11-14-143215.db`.
 * Keeps the stem (sorts next to the original) and the `.db` extension, so
 * recovery is copying it back.
 */
export function asideFileName(currentFileName: string, now: Date): string {
  const dot = currentFileName.lastIndexOf('.');
  const stem = dot > 0 ? currentFileName.slice(0, dot) : currentFileName;
  const extension = dot > 0 ? currentFileName.slice(dot) : BACKUP_EXTENSION;
  return `${stem}.${REPLACED_MARKER}-${secondStamp(now)}${extension}`;
}

/**
 * The first of `name`, `name (2)`, `name (3)`... that `taken` says is free,
 * so a backup never overwrites an earlier one. The suffix goes before the
 * extension, as Windows Explorer does. `taken` is injected to keep this pure.
 */
export function uniqueFileName(
  desired: string,
  taken: (candidate: string) => boolean,
  limit = 999
): string {
  if (!taken(desired)) return desired;

  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : '';

  for (let n = 2; n <= limit; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken(candidate)) return candidate;
  }

  // This many collisions means something is badly wrong.
  throw new Error(`Could not find a free name for ${desired} after ${limit} attempts.`);
}

/** Characters Windows will not accept in a file name. */
const ILLEGAL_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Why a destination is unusable, or null. Checks only its shape (blank,
 * relative, a folder, illegal characters); whether it exists is checked in
 * backup/run-backup.ts.
 */
export function describeBadDestination(destination: string, fileName: string): string | null {
  if (destination.trim().length === 0) {
    return 'Choose a folder to save the backup in.';
  }
  if (fileName.trim().length === 0) {
    return 'Give the backup file a name.';
  }
  if (ILLEGAL_NAME_CHARACTERS.test(fileName)) {
    return 'A file name cannot contain any of  < > : " / \\ | ? *';
  }
  if (!fileName.toLowerCase().endsWith(BACKUP_EXTENSION)) {
    return `The backup file name must end in ${BACKUP_EXTENSION}`;
  }
  if (!isAbsolutePath(destination)) {
    return 'Enter the full path to the folder, for example C:\\Users\\You\\Desktop';
  }
  return null;
}

/**
 * Absolute on Windows (`C:\...`, `\server\share`) or POSIX (`/...`).
 * Not path.isAbsolute, which only knows the platform the server runs on.
 */
export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || /^[\\/]{2}[^\\/]/.test(trimmed) || /^\//.test(trimmed);
}
