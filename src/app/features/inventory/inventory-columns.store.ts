import { signal } from '@angular/core';
import { StorageKeys, StorageService } from '../../services/storage.service';
import {
  InventoryColumn, defaultVisibleColumns, inventoryColumnLabels, inventoryColumnOrder
} from '../../types/inventory-columns';

/**
 * InventoryColumnsStore — which inventory table columns are visible, and the
 * little checkbox panel that lets the user change that.
 *
 * WHY THIS FILE EXISTS
 * Column visibility is a user preference that survives a page reload, so it
 * needs to talk to StorageService. Keeping that persistence logic (plus the
 * fiddly "year must always be immediately followed by mint mark" normalisation)
 * next to the signal it protects means the inventory table component itself
 * stays purely about rendering.
 *
 * Like the other stores in this folder this is a plain class: the App shell
 * creates one and passes it to the table through a signal `input()`.
 */
export class InventoryColumnsStore {
  /** Every column the user is allowed to switch on, in canonical order. */
  readonly inventoryColumnOptions = signal<InventoryColumn[]>([...inventoryColumnOrder]);

  /** The columns currently rendered, in the order they are rendered. */
  readonly visibleInventoryColumns = signal<InventoryColumn[]>([...defaultVisibleColumns]);

  /** Human-readable header text, re-exported so templates can reach it. */
  readonly inventoryColumnLabels = inventoryColumnLabels;

  /** Whether the column checkbox panel is expanded. */
  readonly showColumnPicker = signal(false);

  constructor(private readonly storage: StorageService) {}

  toggleColumnPicker(): void {
    this.showColumnPicker.set(!this.showColumnPicker());
  }

  /**
   * Switch a single column on or off.
   *
   * Guard rail: the table would be unreadable with zero columns, so if the user
   * unticks the last one we keep it ticked instead.
   */
  toggleColumn(column: InventoryColumn): void {
    const next = this.visibleInventoryColumns();
    const exists = next.includes(column);
    const updated = exists ? next.filter(c => c !== column) : [...next, column];
    const safeUpdated = updated.length > 0 ? updated : [column];
    this.visibleInventoryColumns.set(safeUpdated);
    this.persistVisibleColumns(safeUpdated);
  }

  /**
   * Load the saved column selection during app start-up.
   *
   * Anything unrecognised in storage (a column that has since been renamed or
   * removed) is discarded by normalizeVisibleColumns(), so a stale saved value
   * can never break the table.
   */
  async restoreFromStorage(): Promise<void> {
    const storedColumns = await this.storage.get<InventoryColumn[]>(StorageKeys.VisibleColumns);
    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(this.normalizeVisibleColumns(storedColumns));
    }
  }

  /**
   * Clean up a stored column list:
   *  - drop anything that is no longer a real column
   *  - fall back to the defaults if nothing usable is left
   *  - always include the default columns, in canonical order
   *  - keep "MM" (mint mark) sitting immediately after "Year", because reading
   *    "1916" and "D" split apart by other columns is confusing.
   */
  normalizeVisibleColumns(columns: InventoryColumn[]): InventoryColumn[] {
    const order = new Map(inventoryColumnOrder.map((column, index) => [column, index]));
    const valid = [...new Set(columns.filter((column): column is InventoryColumn => inventoryColumnOrder.includes(column)))];

    if (valid.length === 0) return [...defaultVisibleColumns];

    const preferred = [...new Set([...defaultVisibleColumns, ...valid])];
    preferred.sort((left, right) => {
      const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });

    const withYear = preferred.includes('year') ? preferred : ['year', ...preferred];
    const withMintMark = withYear.includes('mintMark') ? withYear : [...withYear];
    const yearIndex = withMintMark.indexOf('year');
    const mintMarkIndex = withMintMark.indexOf('mintMark');

    if (yearIndex >= 0 && mintMarkIndex === -1) {
      withMintMark.splice(yearIndex + 1, 0, 'mintMark');
    } else if (yearIndex >= 0 && mintMarkIndex >= 0 && mintMarkIndex !== yearIndex + 1) {
      withMintMark.splice(mintMarkIndex, 1);
      withMintMark.splice(yearIndex + 1, 0, 'mintMark');
    }

    return [...new Set(withMintMark)] as InventoryColumn[];
  }

  private persistVisibleColumns(columns: InventoryColumn[]): void {
    void this.storage.set(StorageKeys.VisibleColumns, columns);
  }
}
