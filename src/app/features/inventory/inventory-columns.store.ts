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
   *
   * WHY THE SORT MATTERS (this used to be a real, visible bug)
   * ---------------------------------------------------------
   * This method used to append a newly ticked column with `[...next, column]`,
   * i.e. onto the END of the visible list. So ticking "Cert" put it at the far
   * RIGHT of the grid, not in its canonical position — and because the result
   * is persisted, that end-of-list order was then written to IndexedDB.
   *
   * (It happened to straighten itself out on the next page load, because
   * restoreFromStorage() re-sorts. But "my change only appears after a reload"
   * is indistinguishable from "my change did not work", so we sort here too.)
   *
   * Sorting on REMOVAL as well is deliberate: it costs nothing and it means a
   * legacy out-of-order array read from storage gets straightened out by the
   * first toggle, rather than being carried around for the rest of the session.
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
   * Load the saved column selection during app start-up.
   *
   * Anything unrecognised in storage (a column that has since been renamed or
   * removed) is discarded by normalizeVisibleColumns(), so a stale saved value
   * can never break the table.
   *
   * IMPORTANT, because it is the thing you would worry about when re-ordering
   * columns: the saved value IS an ordered array, but its order is NOT trusted.
   * normalizeVisibleColumns() throws the stored sequence away and re-derives it
   * from `inventoryColumnOrder`. The stored array is therefore only ever read
   * as a SET ("which columns did I tick?"), never as an order. That is what
   * makes a change to the canonical order take effect for an existing user on
   * their very next load, with no migration and no version stamp on the key.
   */
  async restoreFromStorage(): Promise<void> {
    const storedColumns = await this.storage.get<InventoryColumn[]>(StorageKeys.VisibleColumns);
    if (Array.isArray(storedColumns) && storedColumns.length > 0) {
      this.visibleInventoryColumns.set(this.normalizeVisibleColumns(storedColumns));
    }
  }

  /**
   * Put a list of columns into canonical (`inventoryColumnOrder`) order and
   * drop any duplicates.
   *
   * This is the ONE place the visible list's order is decided, so the grid can
   * never drift away from the column picker. It does not add or remove columns
   * — callers decide membership, this decides sequence.
   *
   * Anything not in the canonical list sorts to the end rather than being
   * dropped; removing unknown entries is normalizeVisibleColumns()'s job, and
   * doing it in two places would mean two subtly different answers.
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
   *  - keep "MM" (mint mark) sitting immediately after "Year", because reading
   *    "1916" and "D" split apart by other columns is confusing.
   */
  normalizeVisibleColumns(columns: InventoryColumn[]): InventoryColumn[] {
    const valid = [...new Set(columns.filter((column): column is InventoryColumn => inventoryColumnOrder.includes(column)))];

    if (valid.length === 0) return [...defaultVisibleColumns];

    // Note the sort: whatever order the caller (i.e. IndexedDB) handed us is
    // discarded here and rebuilt from inventoryColumnOrder.
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
