/**
 * IndexedDB-backed persistence for inventory and UI preferences.
 * IndexedDB rather than localStorage because coin records carry base64 image
 * data URLs, which quickly exceed localStorage's 5-10MB limit.
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
  SpotPrices: 'coin-inventory-spot-prices',
  AppSettings: 'coin-inventory-app-settings',
  /** Which grid column the inventory is sorted by, and which way. */
  SortState: 'coin-inventory-sort-state',
  /**
   * Grouping column plus which groups are expanded, stored together because the
   * expanded set is only valid for its column. See features/inventory/grid-grouping.ts.
   */
  GridGrouping: 'coin-inventory-grid-grouping',
  /**
   * Grid filter state (search, category, advanced panel). Kept out of AppSettings
   * so a failure to read settings can't leave the grid filtered without the UI
   * showing it. Validated by `restoreFilterState`.
   */
  Filters: 'coin-inventory-filters',
  /**
   * Whether the issuer form may query an outside service for an issuer's
   * denominations. Kept out of AppSettings so a settings read failure can't
   * silently re-enable this outbound request.
   */
  IssuerLookupOnline: 'coin-inventory-issuer-lookup-online'
} as const;

export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys];

@Injectable({ providedIn: 'root' })
export class StorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /**
   * Reads the value saved under `key`; `undefined` if never written or if
   * IndexedDB is unavailable.
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
      // Best-effort: a failed save must not crash the app; in-memory state stays correct.
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
