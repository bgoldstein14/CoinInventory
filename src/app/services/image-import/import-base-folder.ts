/* ===========================================================================
 * import-base-folder.ts — remembering the folder the coin photos live in.
 * ---------------------------------------------------------------------------
 * The batch import needs one piece of information the browser cannot give it:
 * the absolute path of the folder the user pointed the picker at. (See
 * source-path.ts for why — in short, browsers never reveal a file's real
 * location, only its path relative to the picked folder.)
 *
 * Asking for it on every import would be tedious and error-prone, so it is
 * saved with the rest of the user's preferences and prefilled next time.
 *
 * ---------------------------------------------------------------------------
 * THE PRIORITY ORDER, WHICH IS THE WHOLE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *     saved value  ->  ''
 *
 * ---------------------------------------------------------------------------
 * THERE USED TO BE A RUNG IN THE MIDDLE, AND REMOVING IT WAS THE FIX
 * ---------------------------------------------------------------------------
 * The order was `saved -> the app's own folder (from GET /api/app-info) -> ''`,
 * implementing the owner's original requirement: "The import base folder should
 * always start out from the app folder and then memorize subsequent choices as
 * the next base folder." The reasoning was sound on paper — a hardcoded guess
 * is valid only on one machine, whereas the app's own directory is at least a
 * REAL path on the right host with the right drive letter, so it gave the user
 * a correct shape to edit rather than a blank box.
 *
 * In practice it bit the owner twice in one day. It is a *plausible-looking*
 * path that is **never the right answer**, and plausible-but-wrong is worse
 * than blank precisely because it does not prompt anyone to look at it: he
 * imported a folder and every row was stamped under his development directory.
 * (base-folder-check.ts has the full account.) Nor does it improve once this
 * ships — in a packaged install it resolves to `C:\Program Files\...`, equally
 * wrong, so there is no deployment in which the rung earns its place.
 *
 * It also caused a second, sneakier bug. An empty saved value was read as
 * "nothing saved" and fell through to the app folder, so CLEARING THE BOX —
 * the exact thing a user does on discovering the path is wrong — brought the
 * wrong path straight back on the next open. With no fallback left, a cleared
 * box simply stays cleared.
 *
 * An empty box is the honest rendering of "we do not know where your photos
 * are", the screen already warns about it, and emptiness demands attention in
 * a way a filled-in wrong answer does not.
 *
 * ---------------------------------------------------------------------------
 * WHY READ-MODIFY-WRITE AND NOT JUST `storage.set(...)`
 * ---------------------------------------------------------------------------
 * `StorageKeys.AppSettings` holds ONE object shared by every preference. Two
 * places write it: the Settings modal and this file. Writing a freshly built
 * object would delete whatever the other one had put there — save the base
 * folder and the user's "show transactions" choice vanishes, or vice versa. So
 * both writers now merge into the stored object instead of replacing it.
 * =========================================================================== */

import { AppSettings } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';

/**
 * Read the base folder to prefill:
 *
 *   1. THE SAVED VALUE, whenever there is one. Once the user has told us where
 *      their photos are, nothing may override it.
 *
 *   2. OTHERWISE AN EMPTY STRING. Reached on a fresh install, when the user has
 *      deliberately cleared the box, or when storage cannot be read at all.
 *      Empty is a safe and honest state: the import screen shows its "no folder
 *      given" warning and `sourcePathForFile` records null — the same "no path
 *      known" result as every photo imported before this feature existed. It
 *      does NOT stop the import screen from opening.
 *
 * A saved value of the wrong type, or one that is nothing but whitespace, is
 * normalised to `''`. Whitespace would be worse than empty: it is truthy, so it
 * would pass the screen's "is a folder set?" check while joining into paths
 * that begin with a space and resolve to nothing.
 *
 * @param storage where the user's choice is remembered. Optional; without it
 *                the box simply starts empty every time.
 */
export async function loadImportBaseFolder(storage?: StorageService): Promise<string> {
  if (!storage) return '';

  try {
    const settings = await storage.get<AppSettings>(StorageKeys.AppSettings);
    const saved = settings?.imageImportBaseFolder;
    return typeof saved === 'string' ? saved.trim() : '';
  } catch {
    // StorageService is already best-effort; an IndexedDB failure must leave
    // the user with an empty box, never an exception on screen.
    return '';
  }
}

/**
 * Persist the base folder, leaving every other saved preference alone.
 *
 * Best-effort, like the rest of StorageService: a failed write must never
 * interrupt an import. The value stays correct for this session either way.
 */
export async function saveImportBaseFolder(
  storage: StorageService,
  baseFolder: string
): Promise<void> {
  const existing = (await storage.get<AppSettings>(StorageKeys.AppSettings)) ?? undefined;
  await storage.set<AppSettings>(StorageKeys.AppSettings, {
    // Spread first so the new value wins, and so any preference we do not know
    // about survives untouched.
    ...(existing ?? { showTransactionsInDetails: false }),
    imageImportBaseFolder: baseFolder
  });
}
