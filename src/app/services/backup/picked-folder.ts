/**
 * services/backup/picked-folder.ts — HOW FAR A FOLDER PICKER ACTUALLY
 * GETS, AND THE HONEST NAME FOR THE REST OF THE DISTANCE.
 *
 * *** READ THIS BEFORE "FIXING" THE PICKER TO RETURN A REAL PATH. IT
 * CANNOT. *** A browser never tells a page where a file is on disk. It is
 * a deliberate, non-negotiable security rule, not an oversight and not a
 * setting: `file.path` does not exist and `input.value` reads back
 * `C:\fakepath\whatever`. All a directory picker
 * (`<input type="file" webkitdirectory>`) hands over is
 * `File.webkitRelativePath` — the path of each file RELATIVE to the
 * folder that was chosen:
 *
 *     "Backups/coin-inventory-backup-2026-11-14-1432.db"
 *      ^^^^^^^ the only new thing we learn: the folder's NAME
 *
 * So a picker tells us what the folder is CALLED and nothing whatever
 * about where it is. The image import reached the same wall and answered
 * it the same way (services/image-import/source-path.ts, and the long
 * comment at the top of image-import-modal.html): the user confirms the
 * missing front half once, and a live example built from a real selected
 * file makes a wrong answer obvious BEFORE anything is written.
 *
 * THIS MODULE IS THAT ANSWER FOR THE BACKUP BOXES:
 *
 *   1. Take the folder NAME out of the picker's first file.
 *   2. GUESS the rest by assuming the picked folder sits inside whatever
 *      path is already in the box — which starts as the Desktop, a real
 *      folder on the real host (GET /api/backup/suggestion).
 *   3. SAY IT IS A GUESS, in the UI, naming both halves, so the user can
 *      see which part is theirs to correct.
 *
 * And then the backup half has something the image import did not: the
 * server can LIST the folder (server/backup/list-db-files.ts). A guess
 * that is wrong comes back as "there is no folder called ..." or as an
 * empty list, before a single byte is written or replaced. That listing,
 * not this guess, is what makes the picker safe to offer at all.
 *
 * Pure functions over plain data. No DOM, no Angular, no network — the
 * suite runs under Node with no jsdom, so a `File` is only ever read for
 * the two fields named below.
 */

/** The Windows separator. These paths are read by a Windows host. */
const SEPARATOR = '\\';

/**
 * The minimum of `File` this module touches.
 *
 * Declared rather than using the DOM `File` type so the specs can pass a
 * two-field object literal: there is no jsdom under Node and constructing
 * a real `File` with a `webkitRelativePath` is not possible anyway — the
 * property is read-only and set by the browser.
 */
export interface PickedFile {
  readonly name: string;
  readonly webkitRelativePath?: string;
}

/**
 * The NAME of the folder the user picked, or null when the picker told us
 * nothing usable.
 *
 * *** NULL IS A REAL CASE AND THE UI MUST HANDLE IT. *** A directory
 * picker reports the FILES inside the folder, so an EMPTY folder arrives
 * as an empty list and the browser never names it. That is not an error
 * and not a bug to work around — it is the platform — and the only honest
 * response is to tell the user to type the path instead.
 *
 * Null also covers a plain multi-file pick, where `webkitRelativePath` is
 * empty on every file: we got files but no folder, so there is still no
 * folder name to report.
 */
export function folderNameFromPicker(files: readonly PickedFile[] | null | undefined): string | null {
  for (const file of files ?? []) {
    // Always forward slashes, whatever the platform.
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
  // A value that is nothing BUT separators is left alone rather than
  // reduced to an empty string, so a half-typed UNC prefix survives.
  return stripped.length > 0 ? stripped : normalised;
}

/** The last named segment of a path, or '' for a bare root. */
function lastSegment(folder: string): string {
  const segments = folder.split(SEPARATOR).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

/**
 * The best guess at the full path of a folder we know only the NAME of.
 *
 * The rules, and each one is a guess, not a fact:
 *
 *  1. No name  -> whatever is already in the box, untouched.
 *  2. No box   -> the bare name. It is not a path and the caller must say
 *                 so; returning '' instead would silently throw away the
 *                 one thing the picker did tell us.
 *  3. The box already ENDS in that name -> the box is already right (the
 *     user picked the folder the box was pointing at, which is the
 *     commonest case when they are just confirming). Case-insensitive,
 *     because Windows is.
 *  4. Otherwise -> assume the picked folder sits INSIDE the box's folder.
 *
 * Rule 4 is the assumption, and it is right whenever the user drills down
 * from the folder already shown and wrong whenever they jump somewhere
 * else — which is why describeFolderGuess() below says it out loud and
 * why the server listing exists to settle it.
 *
 * It is deliberately NOT joinWindowsPath() from the image import: that
 * function's seam rule only collapses a duplicate when the relative half
 * has more than one segment, so a single folder name would double up
 * (`...\Backups\Backups`). Same idea, different arithmetic; see the note
 * in source-path.ts for the original.
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
 * *** THE SENTENCE THAT KEEPS THE PICKER HONEST. *** What the browser
 * told us, what we made up, and which half is the user's to fix.
 *
 * Always returns something, because every outcome of a pick needs
 * explaining — including the two that look like nothing happening.
 * Whether a pick has happened at all is the caller's business; see
 * BackupFolderBrowser.guessNote.
 *
 * @param hadAnyFiles  did the picker hand over any files? It is how the
 *                     two "we learned nothing" cases are told apart: an
 *                     EMPTY folder (no files, so the browser never named
 *                     it) and a plain multi-file pick (files, but no
 *                     folder among them).
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
