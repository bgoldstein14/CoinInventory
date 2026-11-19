import { signal } from '@angular/core';
import { StorageKeys, StorageService } from '../../services/storage.service';
import {
  InventoryColumn, defaultVisibleColumns, inventoryColumnLabels, inventoryColumnOrder
} from '../../types/inventory-columns';

/**
 * Which inventory table columns are visible, persisted via StorageService.
 * A plain class: the App shell creates one and passes it to the table.
 */
export class InventoryColumnsStore {
  /** Every column the user is allowed to switch on, in canonical order. */
  readonly inventoryColumnOptions = signal<InventoryColumn[]>([...inventoryColumnOrder]);

  /** The columns currently rendered, in the order they are rendered. */
  readonly visibleInventoryColumns = signal<InventoryColumn[]>([...defaultVisibleColumns]);

  /** Header text, re-exported so templates can reach it. */
  readonly inventoryColumnLabels = inventoryColumnLabels;

  /** Whether the column checkbox panel is expanded. */
  readonly showColumnPicker = signal(false);

  constructor(private readonly storage: StorageService) {}

  toggleColumnPicker(): void {
    this.showColumnPicker.set(!this.showColumnPicker());
  }

  /**
   * Switch a column on or off. The last visible column can't be removed.
   * The result is kept in canonical order so a newly ticked column appears in
   * its normal position immediately, not only after a reload.
   */
  toggleColumn(column: InventoryColumn): void {
    const next = this.visibleInventoryColumns();
    const exists = next.includes(column);
    const updated = this.sortIntoCanonicalOrder(
      exists ? next.filter(c => c !== column) : [...next, column]
    );
    const safeUpdated = updated.length > 0 ? updated : [column];
    this.visibleInventoryColumns.set(safeUpdated);
    this.persistVisibleColumns(safeUpdated);
  }

  /**
   * Load the saved column selection at start-up. The stored array is treated
   * as a set: its order is ignored and rebuilt from `inventoryColumnOrder`, so
   * changes to the canonical order apply to existing users without a migration.
   */
  async restoreFromStorage(): Promise<void> {
    const storedColumns = await this.storage.get<InventoryColumn[]>(StorageKeys.VisibleColumns);
    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(this.normalizeVisibleColumns(storedColumns));
    }
  }

  /**
   * Sort columns into canonical order and drop duplicates. Unknown entries
   * sort to the end; removing them is normalizeVisibleColumns()'s job.
   */
  private sortIntoCanonicalOrder(columns: InventoryColumn[]): InventoryColumn[] {
    const order = new Map(inventoryColumnOrder.map((column, index) => [column, index]));
    return [...new Set(columns)].sort((left, right) => {
      const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER;
      return leftIndex - rightIndex;
    });
  }

  /**
   * Clean up a stored column list:
   *  - drop anything that is no longer a real column
   *  - fall back to the defaults if nothing usable is left
   *  - always include the default columns, in canonical order
   *  - keep mint mark immediately after Year
   */
  normalizeVisibleColumns(columns: InventoryColumn[]): InventoryColumn[] {
    const valid = [...new Set(columns.filter((column): column is InventoryColumn => inventoryColumnOrder.includes(column)))];

    if (valid.length === 0) return [...defaultVisibleColumns];

    const preferred = this.sortIntoCanonicalOrder([...defaultVisibleColumns, ...valid]);

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
