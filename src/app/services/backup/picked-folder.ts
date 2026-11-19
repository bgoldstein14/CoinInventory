/**
 * Turns a directory-picker result into a guessed folder path for the backup boxes.
 *
 * Browsers never expose a file's location on disk. A directory picker
 * (`<input type="file" webkitdirectory>`) only gives each file's path relative
 * to the chosen folder:
 *     "Backups/coin-inventory-backup-2026-11-14-1432.db"  -> folder name "Backups"
 *
 * So: take the folder name, guess the rest by assuming it sits inside the path
 * already in the box (initially the Desktop, from GET /api/backup/suggestion),
 * and tell the user it is a guess. The server listing
 * (server/backup/list-db-files.ts) then confirms or refutes the guess before
 * anything is written. See image-import/source-path.ts for the same problem
 * in the image import.
 */

/** Windows separator; these paths are used by a Windows host. */
const SEPARATOR = '\\';

/**
 * The part of `File` this module reads. Declared separately so specs can pass
 * plain objects (`webkitRelativePath` can't be set on a real File).
 */
export interface PickedFile {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

/**
 * Name of the picked folder, or null. Null for an empty folder (the picker
 * reports files, so it never names an empty folder) and for a plain multi-file
 * pick (no relative paths). The UI must handle null.
 */
export function folderNameFromPicker(files: readonly PickedFile[] | null | undefined): string | null {
  for (const file of files ?? []) {
    const relative = (file.webkitRelativePath ?? '').replace(/\\/g, '/');
    const first = relative.split('/').filter((segment) => segment.length > 0)[0];
    if (first) return first;
  }
  return null;
}

/** Trim, normalise to backslashes, and drop any trailing separator. */
function tidyFolder(value: string): string {
  const normalised = (value ?? '').trim().replace(/\//g, SEPARATOR);
  const stripped = normalised.replace(/[\\/]+$/, '');
  // A value of only separators is kept, so a half-typed UNC prefix survives.
  return stripped.length > 0 ? stripped : normalised;
}

/** The last named segment of a path, or '' for a bare root. */
function lastSegment(folder: string): string {
  const segments = folder.split(SEPARATOR).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * Best guess at the full path of a folder known only by name:
 *  1. No name: the box's current value.
 *  2. Empty box: the bare name (the caller must say it isn't a path).
 *  3. Box already ends in that name (case-insensitive): the box.
 *  4. Otherwise: the picked folder inside the box's folder (the assumption).
 *
 * Not joinWindowsPath() from the image import: its seam rule would double a
 * single segment (`...\Backups\Backups`).
 */
export function guessFolderPath(currentFolder: string, pickedName: string | null): string {
  const current = tidyFolder(currentFolder);
  const picked = (pickedName ?? '').trim();

  if (picked.length === 0) return current;
  if (current.length === 0) return picked;
  if (lastSegment(current).toLowerCase() === picked.toLowerCase()) return current;

  return `${current}${SEPARATOR}${picked}`;
}

/**
 * Sentence explaining what the browser reported, what was assumed, and which
 * part the user may need to fix. Always returns text.
 *
 * @param hadAnyFiles distinguishes an empty folder (no files) from a plain
 *                    multi-file pick (files but no folder)
 */
export function describeFolderGuess(
  pickedName: string | null,
  guessedPath: string,
  hadAnyFiles: boolean
): string {
  if (!pickedName) {
    return hadAnyFiles
      ? 'Those were files rather than a folder, so the box is unchanged. ' +
          'Use "Choose folder…" and pick the folder itself, or type its path.'
      : 'Your browser did not name that folder. It only ever reports the files ' +
          'inside a folder, and it found none there — an empty folder is invisible ' +
          'to it. Type or paste the folder path instead.';
  }

  return (
    `Your browser told us only the folder's NAME — "${pickedName}" — never where it is; ` +
    `no web page is allowed to know that. We have assumed it sits where the box was ` +
    `already pointing, which gives ${guessedPath}. If that is not right, correct the ` +
    `part before "${pickedName}" by hand.`
  );
}
