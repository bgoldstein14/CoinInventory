/**
 * AppSettings — user preferences persisted between sessions (IndexedDB, via
 * StorageService / StorageKeys.AppSettings). Read by the App shell at startup
 * and written by the Settings modal.
 */
/**
 * Where an imported photo's picture ends up:
 * 'stored'     — downscaled into CoinImages.ImageData (default).
 * 'referenced' — only CoinImages.SourcePath is written; the original file is
 *                the only copy.
 *
 * Declared here (and re-exported by services/image-import/image-storage-settings.ts)
 * so this file doesn't have to import from `services/`.
 */
export type ImageStorageMode = 'stored' | 'referenced';

export interface AppSettings {
  /** When true, the coin detail panel shows the per-coin transaction history. */
  showTransactionsInDetails: boolean;

  /**
   * How newly imported photos are saved. Absent means 'stored'.
   * Applies to future imports only; changing it converts nothing.
   */
  imageStorageMode?: ImageStorageMode;

  /**
   * Maximum size in bytes of one photo as stored in the database (not a limit
   * on the user's files). Absent means 1 MB; capped at 10 MB. Ignored in
   * 'referenced' mode.
   */
  maxStoredImageBytes?: number;

  /**
   * Photo folder as seen by the machine hosting the server (e.g.
   * `D:\Coin Pictures`), since the server opens the files. The batch image
   * import uses it to rebuild absolute paths, because the browser only gives
   * paths relative to the picked folder. See services/image-import/import-base-folder.ts.
   */
  imageImportBaseFolder?: string;
}
