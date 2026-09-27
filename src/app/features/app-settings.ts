/**
 * AppSettings — the small bag of user preferences that is persisted between
 * sessions (currently in IndexedDB, via StorageService / StorageKeys.AppSettings).
 *
 * WHY THIS FILE EXISTS
 * Two places care about this shape: the App shell reads it back during startup
 * hydration, and the Settings modal writes it when the user clicks Save.
 * Keeping the interface in its own tiny module means neither has to import the
 * other just to agree on the format.
 */
export interface AppSettings {
  /** When true, the coin detail panel shows the per-coin transaction history. */
  showTransactionsInDetails: boolean;

  /**
   * The folder the coin photos live in **on the machine hosting the app**,
   * written the way that machine sees it — a local drive letter, for example
   * `D:\Coin Pictures`. It is the server process that later opens these files,
   * so a path that only resolves on someone's workstation is useless here: it
   * saves cleanly and then reports every photo as missing.
   *
   * The batch image import needs it to rebuild each photo's ABSOLUTE path: a
   * browser only ever hands us a path relative to the folder that was picked,
   * never where that folder actually is. Remembering the answer means the user
   * confirms it once rather than on every import.
   *
   * Optional because it has no value until the first import, and because
   * settings objects saved by earlier versions of the app do not contain it.
   * See services/image-import/import-base-folder.ts.
   */
  imageImportBaseFolder?: string;
}
