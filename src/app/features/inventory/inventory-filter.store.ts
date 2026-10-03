import { computed, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord } from '../../types/coin.model';
import { InventoryColumn, SortState, inventoryColumnOrder } from '../../types/inventory-columns';
import { compareColumnValues, compareDenominationValues, compareText } from './denomination-sort';

/** Sentinel value meaning "don't filter by category at all". */
export const allCategoriesFilter = 'All';

/** Sentinel value meaning "don't filter by set/album at all". */
export const allSetsFilter = 'All';

/**
 * How a brand-new installation sorts the grid, before the user has ever
 * clicked a column header.
 *
 * Year ascending, at the owner's request. It is the most useful default for a
 * coin collection: a numismatic inventory reads naturally in date order, and
 * unlike Coin Type (the previous default) every coin has one. Note that Year
 * is stored as TEXT, not a number, so that ranges and designations like
 * "1878-S" survive — `compareColumnValues` handles the ordering.
 */
export const DEFAULT_SORT_STATE: SortState = { column: 'year', direction: 'asc' };

/**
 * InventoryFilterStore — everything about *which* coins are shown and *in what
 * order*.
 *
 * WHY THIS FILE EXISTS
 * The search box, the advanced filter panel and the inventory table all need to
 * agree on the same filter and sort state. Passing eleven separate signals down
 * through `@Input()`s would be miserable, so instead all of that state lives in
 * one small object. The filter bar writes to it, the table reads from it, and
 * the App shell uses `filteredInventory()` to decide which coin to auto-select.
 *
 * This is a plain class, not an `@Injectable()`. The App shell creates exactly
 * one instance and hands it to the children that need it via a signal `input()`.
 * That keeps the ownership obvious (there is one store, and App owns it) and
 * makes it easy to create a throwaway store in a unit test.
 */
export class InventoryFilterStore {
  // --- Quick filters (the always-visible toolbar row) ---
  readonly searchQuery = signal<string>('');
  readonly categoryFilter = signal<string>(allCategoriesFilter);

  // --- Advanced filters (the collapsible panel below the toolbar) ---
  readonly showAdvancedFilters = signal(false);
  readonly gradeFilter = signal<string>('');
  readonly valueMinFilter = signal<string>('');
  readonly valueMaxFilter = signal<string>('');
  readonly sourceFilter = signal<string>('');
  readonly countryFilter = signal<string>('');
  readonly coinSetFilter = signal<string>(allSetsFilter);
  // NOTE: there used to be a `dealerFilter` here, driving a "Search dealers"
  // text box in the advanced panel. The coin-level dealer field was removed, so
  // there is nothing left for it to match against. (Transactions still record a
  // dealer, but transactions are not what this store filters.)

  /**
   * How the grid is sorted. Persisted between sessions — see
   * restoreFromStorage() and the note on DEFAULT_SORT_STATE.
   *
   * It starts at the default and is overwritten a moment later if a saved
   * preference exists, rather than the store blocking on storage in its
   * constructor. Reading IndexedDB is asynchronous and the grid must render
   * immediately, so "sorted by Year, then re-sorted once your preference
   * loads" is the right trade — the alternative is an empty table while a
   * database opens.
   */
  readonly sortState = signal<SortState>({ ...DEFAULT_SORT_STATE });

  // Re-exported for the template, which cannot reach module-level constants.
  readonly allCategoriesFilter = allCategoriesFilter;
  readonly allSetsFilter = allSetsFilter;

  // `storage` is optional so the store stays constructible without it — a
  // number of specs build one with just an InventoryService, and a missing
  // StorageService simply means the sort is not remembered between sessions
  // rather than a crash.
  constructor(
    private readonly inv: InventoryService,
    private readonly storage?: StorageService
  ) {}

  /**
   * The coins the table actually renders: the full inventory, narrowed by every
   * active filter, then sorted by the current sort column/direction.
   */
  readonly filteredInventory = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const category = this.categoryFilter();
    const coinSet = this.coinSetFilter();
    const grade = this.gradeFilter().trim().toUpperCase();
    const valMin = this.valueMinFilter() ? Number(this.valueMinFilter()) : null;
    const valMax = this.valueMaxFilter() ? Number(this.valueMaxFilter()) : null;
    const source = this.sourceFilter();
    const country = this.countryFilter();
    const { column, direction } = this.sortState();

    const filtered = this.inv.inventory().filter(coin => {
      if (category !== allCategoriesFilter && coin.category !== category) return false;
      if (coinSet !== allSetsFilter && (coin.coinSet ?? '') !== coinSet) return false;
      if (grade && !(coin.grade || '').toUpperCase().startsWith(grade)) return false;
      if (valMin !== null && coin.currentValue < valMin) return false;
      if (valMax !== null && coin.currentValue > valMax) return false;
      if (source && coin.source !== source) return false;
      if (country && coin.country !== country) return false;
      if (!query) return true;

      // Search across all coin fields (note: 'name' field removed, replaced by
      // 'coinType'; 'tags' removed along with the whole tag feature; 'dealer'
      // removed along with the coin-level dealer field).
      const haystack = [
        coin.coinType, coin.denomination, coin.country,
        coin.grade, coin.certCompany, coin.certNumber, coin.variety,
        coin.mintMark, coin.notes, coin.coinSet ?? ''
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });

    return [...filtered].sort((left, right) => {
      if (column === 'denomination') {
        const countryComparison = compareText(left.country ?? '', right.country ?? '');
        if (countryComparison !== 0) {
          return direction === 'asc' ? countryComparison : -countryComparison;
        }

        const denominationComparison = compareDenominationValues(left.denomination, right.denomination);
        return direction === 'asc' ? denominationComparison : -denominationComparison;
      }

      const comparison = compareColumnValues(left[column as keyof CoinRecord], right[column as keyof CoinRecord]);
      return direction === 'asc' ? comparison : -comparison;
    });
  });

  /** Show/hide the advanced filter panel. */
  toggleAdvancedFilters(): void {
    this.showAdvancedFilters.set(!this.showAdvancedFilters());
  }

  /**
   * Clicking a column header sorts by it; clicking the same header again flips
   * the direction.
   */
  setSortColumn(column: InventoryColumn): void {
    const current = this.sortState();
    const next: SortState = current.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: 'asc' };

    this.sortState.set(next);
    this.persistSortState(next);
  }

  /**
   * Load the remembered sort, if there is one.
   *
   * Called once by the App shell during start-up hydration, alongside the
   * column-visibility restore. Best-effort by design: any failure, or any
   * stored value that no longer makes sense, leaves the default in place. A
   * preference that cannot be read is a cosmetic loss, and it must never stop
   * the inventory from rendering.
   *
   * The stored value is VALIDATED rather than trusted. It is JSON from a
   * browser database that may have been written by an older build, so the
   * column it names might since have been renamed or removed entirely — both
   * of which have happened in this project (`name` became `coinType`; `tags`
   * and `dealer` were deleted). Sorting by a column that no longer exists
   * would silently produce a meaningless order, so an unrecognised column
   * falls back to the default instead.
   */
  async restoreFromStorage(): Promise<void> {
    try {
      if (!this.storage) return;
      const stored = await this.storage.get<SortState>(StorageKeys.SortState);
      if (!stored) return;

      const columnExists = (inventoryColumnOrder as readonly string[]).includes(stored.column);
      const directionValid = stored.direction === 'asc' || stored.direction === 'desc';

      if (columnExists && directionValid) {
        this.sortState.set({ column: stored.column, direction: stored.direction });
      }
    } catch {
      // Deliberately swallowed — see the doc comment. The default stands.
    }
  }

  /**
   * Write the sort preference, fire-and-forget.
   *
   * Not awaited anywhere: the user has just clicked a column header and the
   * grid should re-sort instantly, not after a database round trip. A failed
   * write costs them the preference next session and nothing else.
   */
  private persistSortState(state: SortState): void {
    void this.storage?.set(StorageKeys.SortState, state);
  }

  /** The little ▲/▼ arrow shown in the header of the currently sorted column. */
  sortIndicator(column: InventoryColumn): string {
    const current = this.sortState();
    return current.column !== column ? '' : current.direction === 'asc' ? '▲' : '▼';
  }
}
