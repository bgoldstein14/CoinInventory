import { computed, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { InventoryColumn, SortState } from '../../types/inventory-columns';
import { compareColumnValues, compareDenominationValues, compareText } from './denomination-sort';

/** Sentinel value meaning "don't filter by category at all". */
export const allCategoriesFilter = 'All';

/** Sentinel value meaning "don't filter by set/album at all". */
export const allSetsFilter = 'All';

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
  readonly dealerFilter = signal<string>('');

  // Default sort by coinType instead of name (which no longer exists)
  readonly sortState = signal<SortState>({ column: 'coinType', direction: 'asc' });

  // Re-exported for the template, which cannot reach module-level constants.
  readonly allCategoriesFilter = allCategoriesFilter;
  readonly allSetsFilter = allSetsFilter;

  constructor(private readonly inv: InventoryService) {}

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
    const dealer = this.dealerFilter().trim().toLowerCase();
    const { column, direction } = this.sortState();

    const filtered = this.inv.inventory().filter(coin => {
      if (category !== allCategoriesFilter && coin.category !== category) return false;
      if (coinSet !== allSetsFilter && (coin.coinSet ?? '') !== coinSet) return false;
      if (grade && !(coin.grade || '').toUpperCase().startsWith(grade)) return false;
      if (valMin !== null && coin.currentValue < valMin) return false;
      if (valMax !== null && coin.currentValue > valMax) return false;
      if (source && coin.source !== source) return false;
      if (country && coin.country !== country) return false;
      if (dealer && !(coin.dealer ?? '').toLowerCase().includes(dealer)) return false;
      if (!query) return true;

      // Search across all coin fields (note: 'name' field removed, replaced by 'coinType')
      const haystack = [
        coin.coinType, coin.denomination, coin.country,
        coin.grade, coin.certCompany, coin.certNumber, coin.variety,
        coin.mintMark, coin.notes, coin.dealer ?? '', coin.coinSet ?? '',
        ...coin.tags
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
    this.sortState.set(
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    );
  }

  /** The little ▲/▼ arrow shown in the header of the currently sorted column. */
  sortIndicator(column: InventoryColumn): string {
    const current = this.sortState();
    return current.column !== column ? '' : current.direction === 'asc' ? '▲' : '▼';
  }
}
