/**
 * IndexedDB-backed persistence for the coin inventory app.
 *
 * `localStorage` caps out around 5-10MB per origin, and this app stores
 * full base64 image data URLs alongside every coin record. A collector
 * with a few hundred photographed coins will blow past that ceiling
 * quickly, at which point `localStorage.setItem` throws and writes are
 * silently lost. IndexedDB has no such practical ceiling for this use
 * case, so all inventory + UI-preference persistence lives here instead.
 *
 * The service exposes a small async API (get/set per logical "store")
 * so the rest of the app never touches the IndexedDB transaction API
 * directly.
 */
import { Injectable } from '@angular/core';

const DATABASE_NAME = 'coin-inventory-db';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'app-state';

/** Keys used within the single key/value object store. */
export const StorageKeys = {
  Inventory: 'coin-inventory-data',
  VisibleColumns: 'coin-inventory-column-visibility',
  CategoryOptions: 'coin-inventory-category-options',
  CoinSets: 'coin-inventory-sets',
  // There was a `Transactions` key here, caching the rows of the dropped
  // Transactions table. The buy and the sale are coin fields now, so they
  // are already inside the `Inventory` blob above.
  SpotPrices: 'coin-inventory-spot-prices',
  AppSettings: 'coin-inventory-app-settings',
  /** Which grid column the inventory is sorted by, and which way. */
  SortState: 'coin-inventory-sort-state',
  /**
   * Which column the grid is grouped by, and which groups are open.
   *
   * ONE KEY FOR BOTH, because expansion is meaningless without the column
   * it folds: a set of open headings restored against a different grouping
   * names groups that do not exist. Written and validated together — see
   * `serializeGrouping` / `restoreGrouping` in features/inventory/grid-grouping.ts.
   */
  GridGrouping: 'coin-inventory-grid-grouping',
  /**
   * What the grid is filtered to: search text, category, and the advanced
   * panel's grade / value / country / source / set / status controls.
   *
   * ITS OWN KEY, not a field of AppSettings, for the same reason
   * IssuerLookupOnline has one: a filter hides rows, and a failure to read
   * the settings blob must not be able to leave the grid narrowed with
   * nothing on screen to explain it. Validated on the way back in by
   * `restoreFilterState` in features/inventory/inventory-filter-persistence.ts.
   */
  Filters: 'coin-inventory-filters',
  /**
   * Whether the issuer form may ask an outside service what denominations
   * an issuer struck.
   *
   * Remembered because it is the app's only unsolicited outbound request
   * and a user who turns it off once means it. Its own key rather than a
   * field of AppSettings so that a failure to read the settings blob
   * cannot silently re-enable it.
   */
  IssuerLookupOnline: 'coin-inventory-issuer-lookup-online'
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];

@Injectable({ providedIn: 'root' })
export class StorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Reads a value previously saved under `key`. Returns `undefined` when
   * the key has never been written or when IndexedDB is unavailable
   * (e.g. running outside a browser), letting callers fall back to a
   * sensible default.
   */
  async get<T>(key: StorageKey): Promise<T | undefined> {
    try {
      const db = await this.openDatabase();
      return await new Promise<T | undefined>((resolve, reject) => {
        const transaction = db.transaction(OBJECT_STORE_NAME, 'readonly');
        const request = transaction.objectStore(OBJECT_STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return undefined;
    }
  }

  /** Persists `value` under `key`, overwriting any previous value. */
  async set<T>(key: StorageKey, value: T): Promise<void> {
    try {
      const db = await this.openDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(OBJECT_STORE_NAME, 'readwrite');
        transaction.objectStore(OBJECT_STORE_NAME).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch {
      // Persistence is best-effort: a save failure should never crash the
      // app. The in-memory signal state remains correct for this session.
    }
  }

  /** Lazily opens (and caches) the single database connection. */
  private openDatabase(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB is not available in this environment.'));
          return;
        }

        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(OBJECT_STORE_NAME)) {
            db.createObjectStore(OBJECT_STORE_NAME);
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    return this.dbPromise;
  }
}
