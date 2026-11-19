 /*
 * import-base-folder.ts — remembering the folder the coin photos live in.
 *
 * The browser can't reveal the absolute folder the picker pointed at (see
 * source-path.ts), so the user enters it once and it is saved with their
 * preferences.
 *
 * Starting value: the saved value, otherwise ''. There is deliberately no
 * fallback to the app's install folder: it looks plausible but is never
 * where the photos are, and with a fallback a cleared box would refill itself
 * on the next open. An empty box shows the "no folder" warning.
 *
 * `StorageKeys.AppSettings` is one object shared with the Settings modal, so
 * writes merge into it rather than replacing it.
  */

import { AppSettings } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';

/**
 * Read the base folder to prefill: the saved value, or '' when there is none
 * or storage can't be read. A wrong-typed or whitespace-only value becomes ''
 * (whitespace would pass the "is a folder set?" check yet build dead paths).
 *
 * @param storage where the user's choice is remembered. Optional; without it
 *                the box starts empty every time.
 */
export async function loadImportBaseFolder(storage?: StorageService): Promise<string> {
  if (!storage) return '';

  try {
    const settings = await storage.get<AppSettings>(StorageKeys.AppSettings);
    const saved = settings?.imageImportBaseFolder;
    return typeof saved === 'string' ? saved.trim() : '';
  } catch {
    // An IndexedDB failure leaves an empty box, not an exception.
    return '';
  }
}

/**
 * Persist the base folder, leaving every other saved preference alone.
 * Best-effort; a failed write never interrupts an import.
 */
export async function saveImportBaseFolder(
  storage: StorageService,
  baseFolder: string
): Promise<void> {
  const existing = (await storage.get<AppSettings>(StorageKeys.AppSettings)) ?? undefined;
  await storage.set<AppSettings>(StorageKeys.AppSettings, {
    // Spread first so the new value wins and other preferences survive.
    ...(existing ?? { showTransactionsInDetails: false }),
    imageImportBaseFolder: baseFolder
  });
}
