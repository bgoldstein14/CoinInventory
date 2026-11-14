/**
 * backup/list-db-files.ts — "what backups are actually in that folder?"
 *
 * *** WHY THE SERVER HAS TO ANSWER THIS. ***
 * A browser will not tell a page where a file lives on disk, and it will
 * not let a page read a folder it was not handed. That is the constraint
 * source-path.ts and the image import are built around, and it is why the
 * restore box started life as "type the exact path of the file that is
 * about to replace your whole collection".
 *
 * But the SERVER can read a directory. It is the thing that opens the
 * backup anyway. So the user names a folder and gets back the `.db` files
 * that are really in it, with a size and a date, and picks one. The
 * single most dangerous typo in the application stops being possible.
 *
 * *** THE SECURITY TRADEOFF — READ THIS BEFORE REUSING OR WIDENING IT. ***
 * This endpoint lists a directory whose path the CLIENT chooses. It is the
 * same class of thing as routes/images/file.ts ("read any file on the host
 * whose name ends in an image extension") and it is acceptable for the
 * same, narrow reason: this is a single-user inventory running on the
 * user's own PC, and the whole point is to reach backup folders anywhere
 * on that PC — a confined root would defeat the feature. There is
 * therefore no base directory to escape FROM, and `..` in the input is
 * just an unusual way of naming a folder, not an exploit.
 *
 * What is still true, deliberately, and what the specs hold:
 *
 *   1. ONLY `*.db` IS EVER NAMED. Anything else in the folder — .env,
 *      app.log, the user's tax return, a sub-folder — is not in the
 *      answer at all. The caller cannot use this to enumerate a
 *      directory; it can only ask "which databases are here".
 *   2. ONE FOLDER, NEVER A TREE. `readdir` of exactly the named
 *      directory. No recursion into sub-folders and no walking upward to
 *      a parent, so naming a folder reveals nothing about its
 *      neighbours or its children.
 *   3. REGULAR FILES ONLY. A symlink is not followed; a directory called
 *      `backups.db` is not offered as a file to restore.
 *   4. EVERY LISTING IS LOGGED by the route, with the resolved path, for
 *      the same reason images/file.ts logs every read.
 *
 * If this app is ever exposed beyond localhost this route is the second
 * thing to lock down, right behind images/file.ts.
 *
 * NOTHING HERE WRITES. It is `stat` and `readdir` and no more; it is safe
 * to call on every keystroke if the UI ever wants to.
 */

import fs from 'fs';
import path from 'path';

import { BACKUP_EXTENSION } from './names';

/**
 * One candidate file, with enough to tell two backups apart.
 *
 * Size AND modified time, because the names are the problem: a folder of
 * `coin-inventory-backup-2026-11-14-1432.db`,
 * `coin-inventory-backup-2026-11-14-1433.db` and `backup (2).db` is
 * exactly the situation a user is in when they cannot decide, and the
 * two questions they are really asking are "which is the newest" and
 * "which one is the full-sized one".
 */
export interface BackupFileEntry {
  /** `coin-inventory-backup-2026-11-14-1432.db`. */
  readonly name: string;
  /** The full path, which is what the restore is actually given. */
  readonly path: string;
  readonly sizeBytes: number;
  /** ISO-8601 UTC. The dialog renders it in the user's own timezone. */
  readonly modifiedAt: string;
}

export interface BackupDirectoryListing {
  /** The folder as resolved on the host — what was really looked in. */
  readonly directory: string;
  /** Newest first. Empty is a perfectly normal answer. */
  readonly files: readonly BackupFileEntry[];
  /** True when the folder held more than MAX_LISTED_BACKUP_FILES. */
  readonly truncated: boolean;
}

/**
 * A folder the user named that cannot be listed, as opposed to a folder
 * with nothing in it.
 *
 * The distinction is the whole value of the class: "there is no folder
 * called D:\Backpus" and "there are no backups in D:\Backups" send the
 * user to two completely different places, and a single empty list would
 * merge them into the more alarming one.
 */
export class BackupDirectoryError extends Error {
  constructor(
    message: string,
    readonly kind: 'empty' | 'missing' | 'not-a-folder'
  ) {
    super(message);
    this.name = 'BackupDirectoryError';
  }
}

/**
 * A cap, so a folder with ten thousand `.db` files in it cannot turn one
 * click into a multi-megabyte JSON response and a frozen dialog. 200 is
 * far more backups than anybody keeps and the UI says when it bites.
 */
export const MAX_LISTED_BACKUP_FILES = 200;

/**
 * Is this directory entry a file we are willing to name?
 *
 * `path.extname()` rather than `endsWith('.db')`, which matters twice:
 * `notes.db.txt` is NOT a database (extname gives `.txt`), and a Unix
 * hidden file literally called `.db` is not one either (extname gives
 * `''` for a leading dot). Case-insensitive because Windows is.
 */
function isBackupFileName(name: string): boolean {
  return path.extname(name).toLowerCase() === BACKUP_EXTENSION;
}

/**
 * The `*.db` files in one folder, newest first.
 *
 * @throws BackupDirectoryError when the folder is unnamed, absent, or not
 *         a folder at all. Every other failure (a permissions error, a
 *         dead network share) is left to propagate as itself, because
 *         those are faults rather than refusals and the route turns them
 *         into a 500.
 */
export function listBackupFiles(directory: string): BackupDirectoryListing {
  const requested = (directory ?? '').trim();
  if (requested.length === 0) {
    throw new BackupDirectoryError(
      'Enter the folder to look in, for example C:\\Users\\You\\Desktop',
      'empty'
    );
  }

  // Resolved so the answer names a real, absolute location on the host —
  // the same string the restore will later be handed. A relative path
  // would otherwise be reported back as the user typed it while actually
  // having been read relative to the server's working directory.
  const resolved = path.resolve(requested);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new BackupDirectoryError(`There is no folder called ${requested}`, 'missing');
    }
    throw err;
  }

  if (!stats.isDirectory()) {
    throw new BackupDirectoryError(
      `${requested} is a file, not a folder. Give the folder it is in.`,
      'not-a-folder'
    );
  }

  // ONE folder. `withFileTypes` so the directory/file decision costs
  // nothing extra, and there is deliberately no `recursive: true` here —
  // see point 2 of the header.
  const entries = fs.readdirSync(resolved, { withFileTypes: true });

  const files: BackupFileEntry[] = [];
  for (const entry of entries) {
    // Point 1 and point 3 of the header, in that order: the extension
    // allowlist first, so nothing else is even stat'ed.
    if (!isBackupFileName(entry.name)) continue;
    if (!entry.isFile()) continue;

    const full = path.join(resolved, entry.name);
    try {
      const fileStats = fs.statSync(full);
      files.push({
        name: entry.name,
        path: full,
        sizeBytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    } catch {
      // Deleted between the readdir and the stat, or unreadable. Dropping
      // it is right: a file we cannot measure is one we cannot describe,
      // and the user can always paste its path by hand.
      continue;
    }
  }

  // Newest first — the answer to "which one did I just make?" — with the
  // name as a stable tiebreak so two files written in the same
  // millisecond do not swap places between calls.
  files.sort((a, b) =>
    a.modifiedAt === b.modifiedAt
      ? a.name.localeCompare(b.name)
      : a.modifiedAt < b.modifiedAt
        ? 1
        : -1
  );

  return {
    directory: resolved,
    files: files.slice(0, MAX_LISTED_BACKUP_FILES),
    truncated: files.length > MAX_LISTED_BACKUP_FILES,
  };
}
