import { computed, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord } from '../../types/coin.model';
import { coinCatalogReference } from '../../types/catalog-reference';
import { COLLECTION_STATUS_OPTIONS, normalizeCollectionStatus } from '../../types/collection-status';
import { NO_DENOMINATION } from '../../services/denominations/denomination-display';
import {
  InventoryColumn,
  SortState,
  coinDenominationDisplay,
  inventoryColumnOrder
} from '../../types/inventory-columns';
import { compareColumnValues, compareDenominationValues, compareText } from './denomination-sort';

/** Sentinel value meaning "don't filter by category at all". */
export const allCategoriesFilter = 'All';

/** Sentinel value meaning "don't filter by set/album at all". */
export const allSetsFilter = 'All';

/**
 * How a brand-new installation sorts the grid, before the user has ever
 * clicked a column header.
 *
 * Year ascending: a numismatic inventory reads naturally in date order, and
 * every coin has a year. Note that Year is stored as TEXT, not a number, so
 * that ranges and designations like "1878-S" survive — `compareColumnValues`
 * handles the ordering.
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
  /**
   * Which collection status to show, or '' for "all of them".
   *
   * EMPTY STRING IS THE "no filter" VALUE, matching sourceFilter and
   * countryFilter directly above rather than the 'All' sentinel that category
   * and set use. Those two sentinels exist because a category or a set could
   * in principle BE the literal text "All"; a collection status cannot — it is
   * one of five fixed tokens, none of which is empty — so the extra sentinel
   * would be ceremony with no hazard behind it.
   *
   * Holds a raw `string`, not `CollectionStatus`, for the same reason: the
   * "show everything" value is not a status, and widening the type here is
   * honest about that. The comparison below normalises the coin's side, so a
   * value that is not a real status simply matches nothing.
   *
   * THIS FILTER IS NOT OPTIONAL FURNITURE. The money totals exclude coins the
   * owner does not have (see inventory-metrics.ts). Without a way to list
   * exactly those coins, "my collection is worth less than I remember" and "I
   * have forty coins on a want list" would look identical from the toolbar.
   */
  readonly collectionStatusFilter = signal<string>('');

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
  /**
   * The five status choices, for the filter bar's dropdown.
   *
   * Re-exported here for the same reason as the two sentinels above: an
   * Angular template cannot reach a module-level constant, only members of
   * its component or of something a component hands it. Taking it from
   * COLLECTION_STATUS_OPTIONS rather than writing five <option> tags by hand
   * means the filter, the editor dropdown and the grid can never offer
   * different sets of values.
   */
  readonly collectionStatusOptions = COLLECTION_STATUS_OPTIONS;

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
    const status = this.collectionStatusFilter();
    // Read ONCE, outside the per-coin predicate below, so the lookup list is
    // not re-read for every row of a hundred-coin grid on every keystroke.
    // `?? []` because the signal is absent in the two-line service stubs the
    // filter specs build, and because phase 2 of hydration is allowed to fail
    // without taking the search box down with it.
    const catalogs = this.inv.catalogs?.() ?? [];
    // Read once, for the same two reasons as `catalogs` directly above: a
    // hundred-coin grid must not re-read the signal per row per keystroke,
    // and the signal is absent in the small service stubs several filter
    // specs build. An empty list is a working answer — see
    // coinDenominationDisplay(), which then falls back to the coin's text.
    const denominations = this.inv.denominations?.() ?? [];
    const { column, direction } = this.sortState();

    const filtered = this.inv.inventory().filter(coin => {
      if (category !== allCategoriesFilter && coin.category !== category) return false;
      if (coinSet !== allSetsFilter && (coin.coinSet ?? '') !== coinSet) return false;
      if (grade && !(coin.grade || '').toUpperCase().startsWith(grade)) return false;
      if (valMin !== null && coin.currentValue < valMin) return false;
      if (valMax !== null && coin.currentValue > valMax) return false;
      if (source && coin.source !== source) return false;
      if (country && coin.country !== country) return false;
      // *** NORMALISE THE COIN'S SIDE, NEVER COMPARE IT RAW. ***
      // Every coin saved before migration 010 has no `collectionStatus` at
      // all, and all of them are Owned. A plain
      // `coin.collectionStatus !== status` would match none of them, so
      // filtering to "Owned" would return only the coins touched since the
      // feature shipped — and make the owner think the rest had vanished.
      if (status && normalizeCollectionStatus(coin.collectionStatus) !== status) return false;
      if (!query) return true;

      // `storageLocation` is in the haystack because "which coins are in the
      // safe deposit box?" is the question that field exists to answer. Note
      // the `?? ''` — a coin saved before the field existed has none, and
      // `undefined` would put the literal string "undefined" into the
      // haystack and make a search for "undefined" return the whole
      // collection.
      //
      // THE CATALOGUE REFERENCE IS BUILT, NOT READ. The coin stores a
      // foreign key (`catalogId`) and a number; what the user sees in the
      // grid is "Sear 6819". He will type what he sees, so the haystack has
      // to contain that exact string -- and it has to be produced by the
      // SAME function the grid cell uses (coinCatalogReference), because two
      // hand-rolled `${name} ${number}` joins are how a cell ends up visible
      // but unfindable. For an ancient coin this is often the only
      // identifying text there is: no year, no denomination, no grade. It
      // returns '' for a coin with no reference, so no `undefined` leaks in.
      //
      // THE DENOMINATION IS IN HERE TWICE, ON PURPOSE. What the grid SHOWS
      // and what the column HOLDS are two different strings, and after an
      // import they routinely disagree: the id resolves to '8 Reales' while
      // `coin.denomination` still says 'Pillar Dollar'. Each earns its place:
      //
      //   coinDenominationDisplay(...) is WHAT THE USER CAN SEE. Without it
      //   a resolved coin is visible in the grid and unfindable from the
      //   search box -- the user types what is on screen and concludes the
      //   coin has gone. It must be BUILT BY THE SAME FUNCTION THE GRID CELL
      //   USES; two hand-rolled copies of the rule is precisely how a cell
      //   ends up visible but unsearchable. See denomination-display.spec.ts,
      //   which greps src/ to keep there being one.
      //
      //   coin.denomination is WHAT THE SOURCE SAID -- the original text as
      //   it was typed, and the artefact that answers "which coins came in
      //   saying this?". Dropping it would be a regression.
      //
      // A coin with NO denomination at all is the one case the display
      // string is withheld. It renders as the em-dash placeholder, and an
      // em-dash in the haystack would make a search for it return every
      // unrecorded coin in the collection -- same family as the literal
      // 'undefined' the storage-location field is defended from.
      const denominationShown = coinDenominationDisplay(coin, denominations);

      const haystack = [
        coin.coinType,
        denominationShown === NO_DENOMINATION ? '' : denominationShown,
        coin.denomination,
        coin.country,
        coin.grade, coin.certCompany, coin.certNumber, coin.variety,
        coin.mintMark, coin.notes, coin.coinSet ?? '', coin.storageLocation ?? '',
        coinCatalogReference(catalogs, coin.catalogId, coin.catalogNumber)
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
   * column it names may since have been renamed or removed. Sorting by a
   * column that no longer exists would silently produce a meaningless order,
   * so an unrecognised column falls back to the default instead.
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
