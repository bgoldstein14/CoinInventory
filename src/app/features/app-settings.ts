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
}
