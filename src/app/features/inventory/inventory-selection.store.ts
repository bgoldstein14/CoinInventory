import { computed, signal } from '@angular/core';
import { confirmAction } from '../confirm-action';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { InventoryFilterStore } from './inventory-filter.store';

/**
 * InventorySelectionStore — the checkbox "multi-select" in the inventory table
 * and the bulk actions that operate on it.
 *
 * WHY THIS FILE EXISTS
 * Two very different pieces of UI share this state: the checkboxes inside the
 * table rows, and the floating bulk-edit bar at the bottom of the screen. They
 * are nowhere near each other in the template, so the state has to live
 * somewhere both can reach.
 *
 * Note this is a *different* idea from `InventoryService.selectedCoinId`. That
 * is "the one coin whose details are on screen"; this is "the set of coins the
 * user has ticked for a bulk operation".
 */
export class InventorySelectionStore {
  /** Ids of every ticked coin. A Set so membership checks stay cheap. */
  readonly selectedCoinIds = signal<Set<string>>(new Set());

  /**
   * Row index of the last checkbox the user clicked, so shift-click can select
   * a contiguous range. -1 means "nothing clicked yet".
   */
  private lastClickedIndex = -1;

  constructor(
    private readonly inv: InventoryService,
    private readonly filters: InventoryFilterStore
  ) {}

  readonly selectionCount = computed(() => this.selectedCoinIds().size);

  readonly selectedCoins = computed(() => {
    const ids = this.selectedCoinIds();
    return this.inv.inventory().filter(c => ids.has(c.id));
  });

  /** True when every currently *visible* row is ticked (drives the header checkbox). */
  readonly allVisibleSelected = computed(() => {
    const visible = this.filters.filteredInventory();
    if (visible.length === 0) return false;
    const ids = this.selectedCoinIds();
    return visible.every(c => ids.has(c.id));
  });

  /**
   * Tick/untick one row. Holding shift extends the selection from the last
   * clicked row to this one, the way a file explorer behaves.
   */
  toggleCoinSelection(coinId: string, event: MouseEvent): void {
    event.stopPropagation();
    const current = new Set(this.selectedCoinIds());
    const visible = this.filters.filteredInventory();
    const clickedIndex = visible.findIndex(c => c.id === coinId);

    if (event.shiftKey && this.lastClickedIndex >= 0 && clickedIndex >= 0) {
      const start = Math.min(this.lastClickedIndex, clickedIndex);
      const end = Math.max(this.lastClickedIndex, clickedIndex);
      for (let i = start; i <= end; i++) current.add(visible[i].id);
    } else {
      if (current.has(coinId)) current.delete(coinId);
      else current.add(coinId);
    }

    this.lastClickedIndex = clickedIndex;
    this.selectedCoinIds.set(current);
  }

  /**
   * The header checkbox: ticks every visible row, or unticks them all if they
   * were already ticked. Rows hidden by the current filter are left alone.
   */
  toggleAllCoins(): void {
    const visible = this.filters.filteredInventory();
    if (this.allVisibleSelected()) {
      const current = new Set(this.selectedCoinIds());
      for (const c of visible) current.delete(c.id);
      this.selectedCoinIds.set(current);
    } else {
      const current = new Set(this.selectedCoinIds());
      for (const c of visible) current.add(c.id);
      this.selectedCoinIds.set(current);
    }
  }

  clearSelection(): void {
    this.selectedCoinIds.set(new Set());
    this.lastClickedIndex = -1;
  }

  isCoinSelected(coinId: string): boolean {
    return this.selectedCoinIds().has(coinId);
  }

  /**
   * Write the same value into one field of every selected coin.
   *
   * The bulk edit bar only ever hands us strings (it is a plain text input), so
   * numeric fields have to be coerced back to numbers before they are saved.
   */
  bulkUpdateField(field: string, value: string): void {
    const ids = this.selectedCoinIds();
    if (ids.size === 0) return;

    let coerced: unknown = value;
    if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
      coerced = Number(value) || 0;
    } else if (field === 'year') {
      coerced = value ? Number(value) : null;
    }

    for (const id of ids) {
      this.inv.updateCoin(id, { [field]: coerced } as Partial<CoinRecord>);
    }
  }

  /** Delete every selected coin, after one confirmation prompt for the whole batch. */
  bulkDeleteCoins(): void {
    const ids = this.selectedCoinIds();
    if (ids.size === 0) return;
    const itemCount = ids.size;
    const confirmed = confirmAction(`Delete ${itemCount} selected coin${itemCount === 1 ? '' : 's'}?`);

    if (!confirmed) return;

    for (const id of ids) {
      this.inv.deleteCoin(id);
    }
    this.selectedCoinIds.set(new Set());
  }
}
