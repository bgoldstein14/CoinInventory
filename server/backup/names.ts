/**
 * backup/names.ts — every file name §16 invents, in one pure module.
 *
 * Three names get made up by this feature and all three are read by a human
 * at the worst possible moment — the user is looking at a folder trying to
 * work out which file is which, or which one used to be their collection.
 * So they are built here, together, where they can be kept consistent and
 * tested without a filesystem.
 *
 *   coin-inventory-backup-2026-11-14-1432.db      what a backup is called
 *   coin-inventory.replaced-2026-11-14-143215.db  what the OLD collection
 *                                                 is renamed to by a restore
 *
 * LOCAL TIME, NOT UTC. These are shown to one person on one desktop, and a
 * backup taken at nine in the evening that is called `...-2100Z` is a file
 * they will not recognise. ISO-8601 belongs in the metadata INSIDE the file
 * (backup/metadata.ts), where a machine reads it; the name is for the human.
 *
 * NO COLONS, NO SPACES. Windows forbids `:` in a file name outright, and a
 * space turns every command-line and log line that mentions the path into
 * something that needs quoting.
 */

/** The extension every backup gets. One file, and it looks like a database. */
export const BACKUP_EXTENSION = '.db';

/** The stem of a suggested backup file name. */
export const BACKUP_NAME_STEM = 'coin-inventory-backup';

/** What a displaced collection is marked with. See asideFileName(). */
export const REPLACED_MARKER = 'replaced';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * `2026-11-14-1432` — local date and time to the minute.
 *
 * To the MINUTE for a backup name, because that is what a user recognises
 * and a second backup in the same minute is vanishingly rare (and is handled
 * by uniqueFileName() below rather than by a longer name on every file).
 */
export function minuteStamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

/**
 * `2026-11-14-143215` — local date and time to the second.
 *
 * To the SECOND for the displaced-collection name, where uniqueness is not
 * a nicety: two restores a minute apart must not produce the same aside
 * name, because the second one would be refused (or, far worse on a
 * platform that allows it, would overwrite the first user's rescue copy).
 */
export function secondStamp(now: Date): string {
  return `${minuteStamp(now)}${pad(now.getSeconds())}`;
}

/** `coin-inventory-backup-2026-11-14-1432.db`. */
export function backupFileName(now: Date): string {
  return `${BACKUP_NAME_STEM}-${minuteStamp(now)}${BACKUP_EXTENSION}`;
}

/**
 * What the CURRENT collection is renamed to when a restore displaces it:
 * `coin-inventory.db` -> `coin-inventory.replaced-2026-11-14-143215.db`.
 *
 * *** THE NAME IS PART OF THE SAFETY FEATURE. *** The single most likely
 * mistake in this whole feature is a user restoring the wrong file over a
 * good collection, so the displaced file has to be something they can find
 * and recognise without being told twice. It therefore:
 *
 *   - keeps the original stem, so it sorts next to `coin-inventory.db`
 *     in the same folder and is obviously related to it;
 *   - keeps the `.db` extension, so double-clicking it does something
 *     sensible and so copying it back over `coin-inventory.db` is the
 *     entire recovery procedure;
 *   - says `replaced` rather than `old`, `bak` or `~`, because the user
 *     did not make this file and needs to know what happened to it, not
 *     what it is for.
 */
export function asideFileName(currentFileName: string, now: Date): string {
  const dot = currentFileName.lastIndexOf('.');
  const stem = dot > 0 ? currentFileName.slice(0, dot) : currentFileName;
  const extension = dot > 0 ? currentFileName.slice(dot) : BACKUP_EXTENSION;
  return `${stem}.${REPLACED_MARKER}-${secondStamp(now)}${extension}`;
}

/**
 * The first of `name`, `name (2)`, `name (3)`... that `taken` says is free.
 *
 * *** A BACKUP MUST NEVER SILENTLY OVERWRITE A BACKUP. *** Two backups in
 * the same minute land on the same suggested name, and the obvious
 * behaviour — write it anyway — destroys the earlier one. The earlier one
 * may be the good copy of a collection the user has since broken, which is
 * the exact situation in which they are pressing Backup repeatedly.
 *
 * `taken` is injected rather than being `fs.existsSync` so this stays pure.
 * The suffix is Windows Explorer's ` (2)` and goes before the extension,
 * where Explorer puts it, so the file still opens as a database.
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

  // A thousand files with the same name in one folder is not a situation to
  // paper over with a random suffix; it means something is badly wrong.
  throw new Error(`Could not find a free name for ${desired} after ${limit} attempts.`);
}

/** Characters Windows will not accept in a file name. */
const ILLEGAL_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Why a destination path is unusable, or null when it looks fine.
 *
 * Pure, and deliberately NOT a filesystem check — whether the folder exists
 * is a separate question answered against the real disk in
 * backup/run-backup.ts. This catches the shapes that are wrong before any
 * disk is touched: a blank box, a relative path (which would resolve
 * against the server's working directory and put the file somewhere the
 * user will never find), a folder, and a name Windows cannot store.
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
 * Absolute on Windows (`C:\...`, `\\server\share`) or on POSIX (`/...`).
 *
 * `path.isAbsolute` is not used, because it answers for the platform the
 * SERVER is running on and `C:\Users\You\Desktop` is not absolute to a
 * POSIX Node — which would make every spec on a CI box disagree with the
 * machine the feature ships to.
 */
export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return /^[a-zA-Z]:[\\/]/.test(trimmed) || /^[\\/]{2}[^\\/]/.test(trimmed) || /^\//.test(trimmed);
}
