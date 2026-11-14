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
/**
 * Where an imported photograph's picture actually ends up.
 *
 * 'stored'     — downscaled into CoinImages.ImageData, the app's long-standing
 *                behaviour and the default. The database carries the picture,
 *                so moving or deleting the original cannot lose it.
 * 'referenced' — only CoinImages.SourcePath is written. The database carries
 *                the location and NOT the picture, so the original file is the
 *                only copy there is.
 *
 * Declared here rather than beside the loader in
 * services/image-import/image-storage-settings.ts so that this file, which
 * every writer of the preferences blob imports, does not have to import back
 * out of `features/` into `services/`. That module re-exports it, so callers
 * still get the type from the place that explains it.
 */
export type ImageStorageMode = 'stored' | 'referenced';

export interface AppSettings {
  /** When true, the coin detail panel shows the per-coin transaction history. */
  showTransactionsInDetails: boolean;

  /**
   * Whether newly imported photographs put the picture in the database or
   * only a path to it. Optional because settings saved by earlier builds do
   * not contain it; absent means 'stored', the behaviour those builds had.
   *
   * *** IT APPLIES TO FUTURE IMPORTS ONLY. *** Changing it converts nothing
   * and deletes nothing — see the header of
   * services/image-import/image-storage-settings.ts.
   */
  imageStorageMode?: ImageStorageMode;

  /**
   * The largest a single photograph may be AS STORED IN THE DATABASE, in
   * bytes. Not a limit on the user's own files, which are never modified and
   * never refused for being large.
   *
   * Optional, and absent means the default (1 MB), which is above anything
   * the existing 1600 px / quality 0.85 encoder produces and therefore leaves
   * the import behaving exactly as it always has. Capped at 10 MB. Ignored
   * entirely in 'referenced' mode, where nothing is stored.
   */
  maxStoredImageBytes?: number;

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
