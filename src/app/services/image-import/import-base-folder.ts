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
 *     saved value  ->  the app's own folder (from the server)  ->  ''
 *
 * The owner's requirement was: "The import base folder should always start out
 * from the app folder and then memorize subsequent choices as the next base
 * folder." Those are the first two rungs, in that order — the app folder is
 * only ever a STARTING POINT, and the moment the user types something it takes
 * over permanently. `loadImportBaseFolder` below therefore checks storage
 * first and does not even call the server when a saved value exists.
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
 * How the app's own folder is obtained, expressed as a plain function rather
 * than as an ApiService dependency.
 *
 * WHY A CALLBACK AND NOT `ApiService`: this module is pure logic — read a
 * setting, decide a string — and importing ApiService here would drag Angular's
 * HttpClient and its XHR backend into the module graph of everything that reads
 * a base folder, including the unit tests. (api.service.ts has a note at the top
 * about the same problem, which is why `http-utils.ts` was split out of it.) A
 * one-line callback keeps the dependency pointing the right way and makes the
 * "the endpoint is down" test a three-line stub instead of an HTTP mock.
 *
 * The contract is that it RESOLVES rather than rejects — ApiService.getAppFolder
 * already maps every failure to `''` — but `loadImportBaseFolder` catches
 * anyway, because a rejected promise here would break the import screen and
 * nothing about a cosmetic default is worth that.
 */
export type AppFolderProvider = () => Promise<string>;

/**
 * Read the base folder to prefill, in strict priority order:
 *
 *   1. THE SAVED VALUE. This is the "memorize subsequent choices" half of the
 *      requirement and it is non-negotiable: once the user has told us where
 *      their photos are, nothing may override it. It is checked first and, when
 *      present, the server is not even asked.
 *
 *   2. THE APP'S OWN FOLDER, from `GET /api/app-info` via `appFolder()`. Only
 *      reached on a fresh install (or after the setting is cleared). It is not
 *      where the photos live, but it is a real path on the machine that will
 *      have to resolve these paths, with a drive letter that machine really has
 *      — a correct starting point to edit, which no hardcoded guess could be.
 *      See source-path.ts for the full history of this default.
 *
 *   3. AN EMPTY STRING. Reached when there is no saved value and no provider, or
 *      the provider could not get an answer (backend unreachable, endpoint
 *      missing because `dist/` was not rebuilt, request timed out). Empty is a
 *      perfectly safe state, which is why failing softly to it is right: the
 *      import screen shows its "no folder given" warning and
 *      `sourcePathForFile` records null — the same honest "no path known" state
 *      as every photo imported before this feature existed. Crucially it does
 *      NOT stop the import screen from opening.
 *
 * A saved value of the wrong type, or one that is nothing but whitespace, is
 * treated as absent — whitespace would silently mean "record no paths at all".
 *
 * @param storage where the user's choice is remembered. Optional so a caller
 *                without StorageService can still benefit from steps 2 and 3.
 * @param appFolder how to ask the server for the app's folder. Optional; omit
 *                  it and the fallback is simply the empty string.
 */
export async function loadImportBaseFolder(
  storage?: StorageService,
  appFolder?: AppFolderProvider
): Promise<string> {
  // ---- 1. The saved value always wins. ----
  if (storage) {
    try {
      const settings = await storage.get<AppSettings>(StorageKeys.AppSettings);
      const saved = settings?.imageImportBaseFolder;
      if (typeof saved === 'string' && saved.trim().length > 0) return saved;
    } catch {
      // StorageService is already best-effort, but belt and braces: an
      // IndexedDB failure must degrade to the server default, not throw.
    }
  }

  // ---- 2. The app's own folder, if anyone can tell us. ----
  if (appFolder) {
    try {
      const folder = await appFolder();
      if (typeof folder === 'string' && folder.trim().length > 0) return folder.trim();
    } catch {
      // Deliberately swallowed. See step 3 in the doc comment above: the import
      // screen must open even with no default to show.
    }
  }

  // ---- 3. Empty, and the screen's existing warning does the rest. ----
  return '';
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
