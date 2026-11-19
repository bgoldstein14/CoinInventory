/**
 * Lists the `.db` files in a folder the user names, so restore can offer a
 * pick list instead of a typed path (a browser can't read local folders).
 *
 * Security: the client chooses the folder, and there is no confining root
 * because backups may be anywhere on this single-user PC (same reasoning as
 * routes/images/file.ts). Limits that still apply:
 *   1. only `*.db` names are returned, so it can't enumerate a directory;
 *   2. one folder only, no recursion or parent walking;
 *   3. regular files only (symlinks and directories are skipped);
 *   4. every listing is logged by the route.
 * Lock this down if the app is ever exposed beyond localhost. Read-only.
 */

import fs from 'fs';
import path from 'path';

import { BACKUP_EXTENSION } from './names';

/** One candidate file. Size and modified time help tell similar backups apart. */
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
 * A folder that can't be listed (missing, not a folder), as distinct from an
 * empty folder; the two need different messages.
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

/** Cap on files listed, to keep the response small. The UI says when it applies. */
export const MAX_LISTED_BACKUP_FILES = 200;

/**
 * Whether a directory entry name is a backup candidate. Uses path.extname so
 * `notes.db.txt` and a hidden file named `.db` are excluded; case-insensitive.
 */
function isBackupFileName(name: string): boolean {
  return path.extname(name).toLowerCase() === BACKUP_EXTENSION;
}

/**
 * The `*.db` files in one folder, newest first.
 *
 * @throws BackupDirectoryError when the folder is unnamed, absent, or not a
 *         folder. Other failures (permissions, dead share) propagate as 500s.
 */
export function listBackupFiles(directory: string): BackupDirectoryListing {
  const requested = (directory ?? '').trim();
  if (requested.length === 0) {
    throw new BackupDirectoryError(
      'Enter the folder to look in, for example C:\\Users\\You\\Desktop',
      'empty'
    );
  }

  // Resolve to the absolute path that is actually read and later restored from.
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

  // One folder only; no recursion.
  const entries = fs.readdirSync(resolved, { withFileTypes: true });

  const files: BackupFileEntry[] = [];
  for (const entry of entries) {
    // Extension filter first, so nothing else is stat'ed.
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
      // Deleted or unreadable since readdir: skip it.
      continue;
    }
  }

  // Newest first, with name as a stable tiebreak.
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
