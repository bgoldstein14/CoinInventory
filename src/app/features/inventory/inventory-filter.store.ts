import { WritableSignal, computed, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord } from '../../types/coin.model';
import { formatCatalogRefs, mainCatalogRefLabel } from '../../types/catalog-reference';
import {
  COLLECTION_STATUSES,
  COLLECTION_STATUS_OPTIONS,
  CollectionStatus,
  normalizeCollectionStatus
} from '../../types/collection-status';
import { NO_DENOMINATION } from '../../services/denominations/denomination-display';
import {
  InventoryColumn,
  SortState,
  coinDenominationDisplay,
  inventoryColumnOrder
} from '../../types/inventory-columns';
import { compareColumnValues, compareDenominationValues, compareText } from './denomination-sort';
import {
  CoinGroup,
  DEFAULT_GROUPING,
  ExpandAllControl,
  GROUPING_COLUMN_LABELS,
  GROUPING_OPTIONS,
  GridRow,
  GroupExpansion,
  applyExpandAllControl,
  buildCoinGroups,
  collapseAllGroups,
  describeExpandAllControl,
  flatGridRows,
  groupedGridRows,
  isGroupExpanded,
  isGroupableColumn,
  renderedCoins,
  restoreGrouping,
  serializeGrouping,
  toggleGroup
} from './grid-grouping';
import {
  GroupMove,
  GroupOrders,
  NO_GROUP_ORDERS,
  applyGroupOrder,
  canReorderGroups,
  describeGroupMove,
  describeGroupOrderReset,
  hasGroupOrder,
  moveGroupByStep,
  moveGroupToTarget,
  restoreGroupOrders,
  serializeGroupOrders,
  withGroupOrder,
  withoutGroupOrder
} from './group-order';
import {
  StoredFilterState,
  restoreFilterState,
  shouldRevealAdvancedFilters
} from './inventory-filter-persistence';

/** Sentinel value meaning "don't filter by category at all". */
export const allCategoriesFilter = 'All';

/** Sentinel value meaning "don't filter by set/album at all". */
export const allSetsFilter = 'All';

/**
 * Default grid sort before the user picks a column. Year is stored as text
 * (e.g. "1878-S"); `compareColumnValues` handles the ordering.
 */
export const DEFAULT_SORT_STATE: SortState = { column: 'year', direction: 'asc' };

/**
 * A WritableSignal that calls `save` after every `set`/`update`, so filters
 * written directly from templates are persisted without each caller having to
 * remember. Not an `effect()` because this store is built with `new` outside
 * an injection context (including in specs).
 */
function remembered<T>(initial: T, save: () => void): WritableSignal<T> {
  const inner = signal<T>(initial);
  const set = inner.set.bind(inner);
  const update = inner.update.bind(inner);

  inner.set = (value: T) => { set(value); save(); };
  inner.update = (mutate: (value: T) => T) => { update(mutate); save(); };

  return inner;
}

/**
 * Filter, sort and grouping state for the inventory grid, shared by the filter
 * bar, the table and the App shell. A plain class: App creates one instance
 * and passes it to children via `input()`.
 */
export class InventoryFilterStore {
  // Quick filters (always-visible toolbar row)
  readonly searchQuery = remembered<string>('', () => this.persistFilters());
  readonly categoryFilter = remembered<string>(allCategoriesFilter, () => this.persistFilters());

  // Advanced filters (collapsible panel)
  readonly showAdvancedFilters = remembered(false, () => this.persistFilters());
  readonly gradeFilter = remembered<string>('', () => this.persistFilters());
  readonly valueMinFilter = remembered<string>('', () => this.persistFilters());
  readonly valueMaxFilter = remembered<string>('', () => this.persistFilters());
  readonly sourceFilter = remembered<string>('', () => this.persistFilters());
  readonly countryFilter = remembered<string>('', () => this.persistFilters());
  readonly coinSetFilter = remembered<string>(allSetsFilter, () => this.persistFilters());
  /**
   * Collection statuses to show; all selected by default. An empty set shows
   * no coins (it is not treated as "show everything").
   */
  readonly collectionStatusFilter = remembered<readonly CollectionStatus[]>(
    [...COLLECTION_STATUSES],
    () => this.persistFilters()
  );

  /**
   * Current grid sort. Starts at the default and is replaced asynchronously by
   * restoreFromStorage() so the grid can render immediately.
   */
  readonly sortState = signal<SortState>({ ...DEFAULT_SORT_STATE });

  // Re-exported for the template, which cannot reach module-level constants.
  readonly allCategoriesFilter = allCategoriesFilter;
  readonly allSetsFilter = allSetsFilter;
  readonly collectionStatusOptions = COLLECTION_STATUS_OPTIONS;

  /** Is this status currently being shown? */
  isCollectionStatusSelected(status: CollectionStatus): boolean {
    return this.collectionStatusFilter().includes(status);
  }

  /** Tick or untick one status. The result is kept in COLLECTION_STATUSES order. */
  toggleCollectionStatus(status: CollectionStatus): void {
    const current = this.collectionStatusFilter();
    const next = current.includes(status)
      ? current.filter(entry => entry !== status)
      : [...current, status];
    this.collectionStatusFilter.set(
      COLLECTION_STATUSES.filter(entry => next.includes(entry))
    );
  }

  /** Select every status (the default). */
  selectAllCollectionStatuses(): void {
    this.collectionStatusFilter.set([...COLLECTION_STATUSES]);
  }

  /** Select no statuses, which shows no coins. */
  clearCollectionStatuses(): void {
    this.collectionStatusFilter.set([]);
  }

  // `storage` is optional: without it, preferences are simply not persisted.
  constructor(
    private readonly inv: InventoryService,
    private readonly storage?: StorageService
  ) {}

  /** The full inventory narrowed by every active filter, then sorted. */
  readonly filteredInventory = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const category = this.categoryFilter();
    const coinSet = this.coinSetFilter();
    const grade = this.gradeFilter().trim().toUpperCase();
    const valMin = this.valueMinFilter() ? Number(this.valueMinFilter()) : null;
    const valMax = this.valueMaxFilter() ? Number(this.valueMaxFilter()) : null;
    const source = this.sourceFilter();
    const country = this.countryFilter();
    const statuses = this.collectionStatusFilter();
    // Read lookup lists once, outside the per-coin predicate. `?? []` because
    // these signals are absent in some service stubs and may fail to hydrate.
    const catalogs = this.inv.catalogs?.() ?? [];
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
      // Normalise the coin's status: records saved before migration 010 have
      // none and count as Owned.
      if (!statuses.includes(normalizeCollectionStatus(coin.collectionStatus))) return false;
      if (!query) return true;

      // Search both the displayed denomination and the stored source text,
      // since they can differ after an import. The displayed strings must come
      // from the same functions the grid cells use. The em-dash placeholder is
      // excluded so searching for it doesn't match every unrecorded coin.
      const denominationShown = coinDenominationDisplay(coin, denominations);

      const haystack = [
        coin.coinType,
        denominationShown === NO_DENOMINATION ? '' : denominationShown,
        coin.denomination,
        coin.country,
        coin.grade, coin.certCompany, coin.certNumber, coin.variety,
        coin.mintMark, coin.notes, coin.coinSet ?? '', coin.storageLocation ?? '',
        formatCatalogRefs(catalogs, coin.catalogRefs)
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

      // Not a coin property: sort by the main reference, as the cell shows it.
      if (column === 'catalogReference') {
        const comparison = compareColumnValues(
          mainCatalogRefLabel(catalogs, left.catalogRefs),
          mainCatalogRefLabel(catalogs, right.catalogRefs)
        );
        return direction === 'asc' ? comparison : -comparison;
      }

      const comparison = compareColumnValues(left[column as keyof CoinRecord], right[column as keyof CoinRecord]);
      return direction === 'asc' ? comparison : -comparison;
    });
  });

  /* ---- Grouping (rules live in grid-grouping.ts and group-order.ts) ---- */

  /** The Group by menu. Every groupable column, in canonical order. */
  readonly groupingOptions = GROUPING_OPTIONS;

  /** Which column the grid is grouped by; null is the flat grid. */
  readonly groupColumn = signal<InventoryColumn | null>(DEFAULT_GROUPING.column);

  /** Which groups are open. A default plus exceptions — see grid-grouping.ts. */
  readonly groupExpansion = signal<GroupExpansion>(DEFAULT_GROUPING.expansion);

  /** The user's custom heading order, keyed by grouping column. */
  readonly groupOrders = signal<GroupOrders>(NO_GROUP_ORDERS);

  /** What the <select> shows. '' is the "None" entry. */
  readonly groupColumnValue = computed<string>(() => this.groupColumn() ?? '');

  /** Is the grid grouped at all? */
  readonly isGrouped = computed<boolean>(() => this.groupColumn() !== null);

  /** Groups with counts and totals, in heading order. Built from the filtered inventory. */
  readonly coinGroups = computed<CoinGroup[]>(() => {
    const column = this.groupColumn();
    if (!column) return [];

    const groups = buildCoinGroups(this.filteredInventory(), column, {
      catalogs: this.inv.catalogs?.() ?? [],
      denominations: this.inv.denominations?.() ?? [],
      sort: this.sortState()
    });

    // Default order first, then the user's saved order for this column on top.
    return applyGroupOrder(groups, this.groupOrders()[column]);
  });

  /** Exactly what the table draws: headings and rows, or just rows. */
  readonly gridRows = computed<GridRow[]>(() =>
    this.groupColumn() === null
      ? flatGridRows(this.filteredInventory())
      : groupedGridRows(this.coinGroups(), this.groupExpansion())
  );

  /**
   * The coins on screen, in screen order (excludes collapsed groups). Used for
   * arrow-key navigation so focus never lands on a hidden row.
   */
  readonly renderedInventory = computed<CoinRecord[]>(() =>
    this.groupColumn() === null ? this.filteredInventory() : renderedCoins(this.gridRows())
  );

  /** What the single expand/collapse button says and does right now. */
  readonly expandAllControl = computed<ExpandAllControl>(() =>
    describeExpandAllControl(this.groupExpansion(), this.coinGroups().map(group => group.label))
  );

  /** Is this group open? */
  isGroupOpen(heading: string): boolean {
    return isGroupExpanded(this.groupExpansion(), heading);
  }

  /** Menu label of the current grouping column. */
  readonly groupColumnLabel = computed<string>(() => {
    const column = this.groupColumn();
    return column ? GROUPING_COLUMN_LABELS[column] : '';
  });

  /** Is a custom order saved for the current grouping column? */
  readonly hasCustomGroupOrder = computed<boolean>(() =>
    hasGroupOrder(this.groupOrders(), this.groupColumn())
  );

  /** True when there are at least two movable groups. */
  readonly canReorderGroups = computed<boolean>(() => canReorderGroups(this.coinGroups()));

  /** Text of the last reorder, for the grid's aria-live region (includes position, e.g. "3 of 12"). */
  readonly groupOrderAnnouncement = signal<string>('');

  /** Alt+Arrow on a focused heading: one place up (-1) or down (+1). */
  moveGroup(heading: string, delta: -1 | 1): boolean {
    return this.applyGroupMove(
      moveGroupByStep(this.coinGroups(), this.currentGroupOrder(), heading, delta)
    );
  }

  /** A heading was dragged onto another one. */
  dropGroupOn(dragged: string, target: string): boolean {
    return this.applyGroupMove(
      moveGroupToTarget(this.coinGroups(), this.currentGroupOrder(), dragged, target)
    );
  }

  /** Reset the current column's group order to the default. Other columns' orders are kept. */
  resetGroupOrder(): void {
    const column = this.groupColumn();
    if (!column || !this.hasCustomGroupOrder()) return;

    this.groupOrders.set(withoutGroupOrder(this.groupOrders(), column));
    this.groupOrderAnnouncement.set(describeGroupOrderReset(GROUPING_COLUMN_LABELS[column]));
    this.persistGrouping();
  }

  /** The saved order for the current column, or undefined. */
  private currentGroupOrder(): readonly string[] | undefined {
    const column = this.groupColumn();
    return column ? this.groupOrders()[column] : undefined;
  }

  /** Apply and persist a move; a null move changes nothing. */
  private applyGroupMove(move: GroupMove | null): boolean {
    const column = this.groupColumn();
    if (!column || !move) return false;

    this.groupOrders.set(withGroupOrder(this.groupOrders(), column, move.order));
    this.groupOrderAnnouncement.set(describeGroupMove(move));
    this.persistGrouping();
    return true;
  }

  /**
   * Choose a grouping column, or '' for none. All groups start collapsed.
   * Re-selecting the current column is a no-op so open groups aren't collapsed.
   * Invalid values fall back to no grouping.
   */
  setGroupColumn(column: string): void {
    const next = isGroupableColumn(column) ? column : null;
    if (next === this.groupColumn()) return;

    this.groupColumn.set(next);
    this.groupExpansion.set(collapseAllGroups());
    // Custom orders are keyed by column, so they are kept for when the user switches back.
    this.groupOrderAnnouncement.set('');
    this.persistGrouping();
  }

  /** Toggle one group open/closed. */
  toggleGroupExpansion(heading: string): void {
    this.groupExpansion.set(toggleGroup(this.groupExpansion(), heading));
    this.persistGrouping();
  }

  /** Expand or collapse all, whichever the control currently offers. */
  applyExpandAll(): void {
    this.groupExpansion.set(applyExpandAllControl(this.expandAllControl().action));
    this.persistGrouping();
  }

  /** Fire-and-forget save of the grouping state. */
  private persistGrouping(): void {
    void this.storage?.set(
      StorageKeys.GridGrouping,
      serializeGrouping(
        this.groupColumn(),
        this.groupExpansion(),
        serializeGroupOrders(this.groupOrders())
      )
    );
  }

  /* ---- Filter persistence ---- */

  /** True while restoring, so restored values aren't written back one at a time. */
  private restoringFilters = false;

  /** Every filter, as it goes to storage. */
  private captureFilterState(): StoredFilterState {
    return {
      searchQuery: this.searchQuery(),
      categoryFilter: this.categoryFilter(),
      gradeFilter: this.gradeFilter(),
      valueMinFilter: this.valueMinFilter(),
      valueMaxFilter: this.valueMaxFilter(),
      sourceFilter: this.sourceFilter(),
      countryFilter: this.countryFilter(),
      coinSetFilter: this.coinSetFilter(),
      collectionStatuses: this.collectionStatusFilter(),
      showAdvancedFilters: this.showAdvancedFilters()
    };
  }

  /** Called by every `remembered` filter signal when it is written. */
  private persistFilters(): void {
    if (this.restoringFilters) return;
    void this.storage?.set(StorageKeys.Filters, this.captureFilterState());
  }

  /** Show/hide the advanced filter panel. */
  toggleAdvancedFilters(): void {
    this.showAdvancedFilters.set(!this.showAdvancedFilters());
  }

  /** Sort by a column; clicking the same column again flips the direction. */
  setSortColumn(column: InventoryColumn): void {
    const current = this.sortState();
    const next: SortState = current.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: 'asc' };

    this.sortState.set(next);
    this.persistSortState(next);
  }

  /**
   * Restore saved sort, filters and grouping during start-up. Best-effort:
   * stored values are validated, and anything unreadable leaves the default.
   */
  async restoreFromStorage(): Promise<void> {
    await this.restoreSortFromStorage();
    await this.restoreFiltersFromStorage();
    await this.restoreGroupingFromStorage();
  }

  private async restoreSortFromStorage(): Promise<void> {
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
      // Ignored; the default sort stands.
    }
  }

  /**
   * Restore saved filters. The advanced panel is forced open whenever a
   * restored filter inside it is active, so hidden coins are explained on
   * screen. See inventory-filter-persistence.ts for validation rules.
   */
  private async restoreFiltersFromStorage(): Promise<void> {
    try {
      if (!this.storage) return;
      const stored = await this.storage.get<unknown>(StorageKeys.Filters);
      if (!stored) return;

      const state = restoreFilterState(stored);
      this.restoringFilters = true;
      try {
        this.searchQuery.set(state.searchQuery);
        this.categoryFilter.set(state.categoryFilter);
        this.gradeFilter.set(state.gradeFilter);
        this.valueMinFilter.set(state.valueMinFilter);
        this.valueMaxFilter.set(state.valueMaxFilter);
        this.sourceFilter.set(state.sourceFilter);
        this.countryFilter.set(state.countryFilter);
        this.coinSetFilter.set(state.coinSetFilter);
        this.collectionStatusFilter.set(state.collectionStatuses);
        this.showAdvancedFilters.set(shouldRevealAdvancedFilters(state));
      } finally {
        this.restoringFilters = false;
      }
    } catch {
      // Ignored; the unfiltered grid stands.
    }
  }

  /**
   * Restore the saved grouping and open groups. Unusable values (e.g. a
   * removed column) fall back to the flat grid.
   */
  private async restoreGroupingFromStorage(): Promise<void> {
    try {
      if (!this.storage) return;
      const stored = await this.storage.get<unknown>(StorageKeys.GridGrouping);
      if (!stored) return;

      const { column, expansion } = restoreGrouping(stored);
      this.groupColumn.set(column);
      this.groupExpansion.set(expansion);
      // Orders are validated per column, so they survive even if the saved grouping column did not.
      this.groupOrders.set(restoreGroupOrders(stored));
    } catch {
      // Ignored; the flat grid stands.
    }
  }

  /** Fire-and-forget save of the sort preference. */
  private persistSortState(state: SortState): void {
    void this.storage?.set(StorageKeys.SortState, state);
  }

  /** The ▲/▼ arrow shown in the header of the currently sorted column. */
  sortIndicator(column: InventoryColumn): string {
    const current = this.sortState();
    return current.column !== column ? '' : current.direction === 'asc' ? '▲' : '▼';
  }
}
