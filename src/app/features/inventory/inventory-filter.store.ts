import { WritableSignal, computed, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { CoinRecord } from '../../types/coin.model';
import { coinCatalogReference } from '../../types/catalog-reference';
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
 * A signal that saves itself whenever ANYBODY writes to it.
 *
 * WHY NOT A SETTER METHOD PER FILTER, which is how the sort is persisted.
 * The sort has exactly one writer — `setSortColumn`, behind a column header
 * — so hanging the save off it catches every change there will ever be. The
 * filters have eight controls in two components writing `.set($event)`
 * straight into the signal from a template, plus the App shell writing two
 * of them, and that is the shape the bug comes in: the ninth control is
 * added, nobody remembers the save, and the preference silently stops being
 * remembered for that one field. Decorating the signal moves the obligation
 * from every caller to the declaration, where it cannot be forgotten.
 *
 * WHY NOT AN `effect()`. An effect needs an injection context, and this
 * store is a plain class that a dozen specs build with `new` outside one.
 * Making persistence depend on Angular's DI would mean either no tests or a
 * TestBed, and this suite runs under Node with no jsdom.
 *
 * The signal handed back is an ordinary WritableSignal in every other
 * respect: `computed()`s that read it still track it, because the value
 * cell underneath is untouched. Only `set` and `update` are wrapped.
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
  /* EVERY FILTER BELOW IS `remembered(...)`, NOT `signal(...)`, and that is
   * the whole of how filters survive a restart — see the helper above. The
   * controls that write them are unchanged: the filter bar still calls
   * `filters().gradeFilter.set($event)`. */

  // --- Quick filters (the always-visible toolbar row) ---
  readonly searchQuery = remembered<string>('', () => this.persistFilters());
  readonly categoryFilter = remembered<string>(allCategoriesFilter, () => this.persistFilters());

  // --- Advanced filters (the collapsible panel below the toolbar) ---
  readonly showAdvancedFilters = remembered(false, () => this.persistFilters());
  readonly gradeFilter = remembered<string>('', () => this.persistFilters());
  readonly valueMinFilter = remembered<string>('', () => this.persistFilters());
  readonly valueMaxFilter = remembered<string>('', () => this.persistFilters());
  readonly sourceFilter = remembered<string>('', () => this.persistFilters());
  readonly countryFilter = remembered<string>('', () => this.persistFilters());
  readonly coinSetFilter = remembered<string>(allSetsFilter, () => this.persistFilters());
  /**
   * WHICH collection statuses to show. A SET, and every one of them is
   * ticked to begin with.
   *
   * IT USED TO BE A SINGLE-SELECT DROPDOWN with an "All statuses" option on
   * top, and the user could ask for exactly one status or for all five. That
   * is the wrong shape for the question: "show me what I own and what is for
   * sale, but not the want list" is an ordinary thing to want and was
   * unaskable. With tick boxes it is two clicks, and THE "All statuses"
   * OPTION IS GONE — with every box ticked it said nothing that the boxes
   * were not already saying, and two ways to express "everything" is the
   * ambiguity this change exists to remove.
   *
   * *** NO STATUSES SELECTED SHOWS NO COINS. ***
   * This is a decision, not an oversight, and the alternative — treating an
   * empty set as "show everything" — was rejected for one reason: it would
   * put back the exact redundancy that removing "All statuses" got rid of.
   * All five ticked would mean everything and none ticked would also mean
   * everything, so the last untick would silently do nothing and the panel
   * would be telling the user something untrue about the grid in front of
   * him. Each box reads "include this status"; include none and there is
   * nothing to include. It is also the self-correcting failure: the grid
   * empties, the reason is on screen with five empty boxes next to it, and
   * one click undoes it. The filter bar says so in as many words.
   *
   * Typed `CollectionStatus[]` rather than `string[]`: there is no longer a
   * "show everything" sentinel that is not a status, so nothing in here is
   * anything but one of the five tokens. The comparison below still
   * normalises the COIN's side, which is what makes a pre-migration-010
   * record with no status at all read as Owned.
   *
   * THIS FILTER IS NOT OPTIONAL FURNITURE. The money totals exclude coins the
   * owner does not have (see inventory-metrics.ts). Without a way to list
   * exactly those coins, "my collection is worth less than I remember" and "I
   * have forty coins on a want list" would look identical from the toolbar.
   */
  readonly collectionStatusFilter = remembered<readonly CollectionStatus[]>(
    [...COLLECTION_STATUSES],
    () => this.persistFilters()
  );

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

  /** Is this status currently being shown? One call per tick box. */
  isCollectionStatusSelected(status: CollectionStatus): boolean {
    return this.collectionStatusFilter().includes(status);
  }

  /**
   * Tick or untick one status.
   *
   * The result is kept in COLLECTION_STATUSES order rather than click
   * order. Nothing downstream reads the order today — the filter is a
   * membership test — but an array whose order depends on what the user
   * clicked first is the kind of thing that gets persisted and then read as
   * meaningful later.
   */
  toggleCollectionStatus(status: CollectionStatus): void {
    const current = this.collectionStatusFilter();
    const next = current.includes(status)
      ? current.filter(entry => entry !== status)
      : [...current, status];
    this.collectionStatusFilter.set(
      COLLECTION_STATUSES.filter(entry => next.includes(entry))
    );
  }

  /** Every status. What the filter starts as. */
  selectAllCollectionStatuses(): void {
    this.collectionStatusFilter.set([...COLLECTION_STATUSES]);
  }

  /** None of them — which shows no coins. See the signal's comment. */
  clearCollectionStatuses(): void {
    this.collectionStatusFilter.set([]);
  }

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
    const statuses = this.collectionStatusFilter();
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
      // all, and all of them are Owned. A plain `includes(coin.collectionStatus)`
      // would match none of them, so showing "Owned" would return only the
      // coins touched since the feature shipped — and make the owner think
      // the rest had vanished.
      //
      // NOTE THE ABSENCE OF A `statuses.length === 0` SHORT CIRCUIT. An
      // empty set matches nothing, deliberately; see the signal's comment.
      if (!statuses.includes(normalizeCollectionStatus(coin.collectionStatus))) return false;
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

  /* =====================================================================
   * GROUPING THE GRID
   *
   * WHY IT LIVES IN THE FILTER STORE. Grouping is the last step of the same
   * question this store already answers — which coins the grid shows and in
   * what order — and it has to be persisted next to the sort it interacts
   * with. The alternative, a fourth store, would have to be created by the
   * App shell, handed to the table through a second input and restored by a
   * second line of hydration, for state that cannot be computed without
   * `filteredInventory()` anyway. The RULES are not here: they are in
   * features/inventory/grid-grouping.ts, which is pure and testable under
   * Node with no jsdom.
   *
   * NOTHING SELECTED IS NOT A GROUPING OF ONE. `gridRows()` below takes a
   * separate branch for it that produces one row per coin and no headings —
   * the identical grid this app has always drawn.
   * ===================================================================== */

  /** The Group by menu. Every groupable column, in canonical order. */
  readonly groupingOptions = GROUPING_OPTIONS;

  /** Which column the grid is grouped by; null is the flat grid. */
  readonly groupColumn = signal<InventoryColumn | null>(DEFAULT_GROUPING.column);

  /** Which groups are open. A default plus exceptions — see grid-grouping.ts. */
  readonly groupExpansion = signal<GroupExpansion>(DEFAULT_GROUPING.expansion);

  /**
   * The user's dragged order of headings, PER COLUMN.
   *
   * Empty until he drags one, and then only for the column he dragged it
   * under. Keyed by column because an order of countries cannot be applied
   * while the grid is grouped by Grade, and silently dropping it because he
   * glanced at Grade would throw away a minute of work; see the four
   * decisions at the top of features/inventory/group-order.ts.
   */
  readonly groupOrders = signal<GroupOrders>(NO_GROUP_ORDERS);

  /** What the <select> shows. '' is the "None" entry. */
  readonly groupColumnValue = computed<string>(() => this.groupColumn() ?? '');

  /** Is the grid grouped at all? The template's one guard. */
  readonly isGrouped = computed<boolean>(() => this.groupColumn() !== null);

  /**
   * The groups, with their counts and their money, in heading order.
   *
   * Built from `filteredInventory()`, so a group's count is the count of
   * coins the CURRENT FILTERS let through — a heading that said 40 while
   * the grid could only ever show 11 of them would be the grouping telling
   * the same lie the filters do.
   */
  readonly coinGroups = computed<CoinGroup[]>(() => {
    const column = this.groupColumn();
    if (!column) return [];

    const groups = buildCoinGroups(this.filteredInventory(), column, {
      // Read defensively and once, for the same two reasons as in
      // filteredInventory: the signals are absent in the small service stubs
      // several specs build, and a 457-row grid must not re-read them once
      // per row.
      catalogs: this.inv.catalogs?.() ?? [],
      denominations: this.inv.denominations?.() ?? [],
      sort: this.sortState()
    });

    // ALPHABETICAL FIRST, THEN THE USER'S ARRANGEMENT ON TOP OF IT. The
    // default order is still decided by `buildCoinGroups`, and with no saved
    // order for this column `applyGroupOrder` hands that list straight back.
    // See features/inventory/group-order.ts.
    return applyGroupOrder(groups, this.groupOrders()[column]);
  });

  /** Exactly what the table draws: headings and rows, or just rows. */
  readonly gridRows = computed<GridRow[]>(() =>
    this.groupColumn() === null
      ? flatGridRows(this.filteredInventory())
      : groupedGridRows(this.coinGroups(), this.groupExpansion())
  );

  /**
   * The coins ON SCREEN, in screen order — which is NOT `filteredInventory()`
   * once anything is collapsed.
   *
   * This is what the grid's arrow keys walk, so Down from the last row of an
   * open group lands on the first row of the next OPEN group and collapsed
   * groups are stepped straight over. Moving focus onto a row that is not
   * rendered would park the tab stop somewhere invisible.
   */
  readonly renderedInventory = computed<CoinRecord[]>(() =>
    this.groupColumn() === null ? this.filteredInventory() : renderedCoins(this.gridRows())
  );

  /** What the single expand/collapse button says and does right now. */
  readonly expandAllControl = computed<ExpandAllControl>(() =>
    describeExpandAllControl(this.groupExpansion(), this.coinGroups().map(group => group.label))
  );

  /** Is this group open? One call per heading. */
  isGroupOpen(heading: string): boolean {
    return isGroupExpanded(this.groupExpansion(), heading);
  }

  /* --------------------------------------------------------------------
   * RE-ORDERING THE GROUPS
   *
   * The owner wants to drag a grouping to the top, or wherever he likes.
   * Every rule that follows from that — what a move does, what happens to a
   * group a filter is hiding, why the empty bucket cannot be dragged, and
   * what is written to storage — is in features/inventory/group-order.ts,
   * which is pure and therefore testable under Node with no jsdom. What is
   * left here is signals and a save.
   * -------------------------------------------------------------------- */

  /** The grouping column's name as the menu spells it, for the controls that
   *  have to say WHICH groups they are about to reorder or reset. */
  readonly groupColumnLabel = computed<string>(() => {
    const column = this.groupColumn();
    return column ? GROUPING_COLUMN_LABELS[column] : '';
  });

  /** Is a custom order in force for the column being grouped by RIGHT NOW?
   *  The "Reset order" control is bound to this, which is how the UI stays
   *  honest about an order that is being kept but not applied. */
  readonly hasCustomGroupOrder = computed<boolean>(() =>
    hasGroupOrder(this.groupOrders(), this.groupColumn())
  );

  /** Is there anything to reorder? Two movable groups minimum — a grip on a
   *  heading that cannot move is a control that lies. */
  readonly canReorderGroups = computed<boolean>(() => canReorderGroups(this.coinGroups()));

  /**
   * The last thing a reorder did, in words, for the grid's aria-live region.
   *
   * A keyboard user who presses Alt+Down sees nothing: the rows shuffle
   * somewhere below the heading he is standing on. The announcement is the
   * only feedback that reaches him, so it carries the POSITION — "3 of 12" —
   * rather than a direction he already knows he asked for.
   */
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

  /**
   * BACK TO ALPHABETICAL — the way out of a one-way door.
   *
   * This column only. Resetting Country must not throw away the order the
   * user built under Grade, which he cannot even see from here.
   */
  resetGroupOrder(): void {
    const column = this.groupColumn();
    if (!column || !this.hasCustomGroupOrder()) return;

    this.groupOrders.set(withoutGroupOrder(this.groupOrders(), column));
    this.groupOrderAnnouncement.set(describeGroupOrderReset(GROUPING_COLUMN_LABELS[column]));
    this.persistGrouping();
  }

  /** The saved order for the column in force, or undefined for none. */
  private currentGroupOrder(): readonly string[] | undefined {
    const column = this.groupColumn();
    return column ? this.groupOrders()[column] : undefined;
  }

  /** Record a move the pure model has already decided is a real one. A null
   *  — a refused drop, a group already at the end — changes nothing and
   *  announces nothing. */
  private applyGroupMove(move: GroupMove | null): boolean {
    const column = this.groupColumn();
    if (!column || !move) return false;

    this.groupOrders.set(withGroupOrder(this.groupOrders(), column, move.order));
    this.groupOrderAnnouncement.set(describeGroupMove(move));
    this.persistGrouping();
    return true;
  }

  /**
   * Choose a grouping — or '' for none.
   *
   * ALL GROUPS START COLLAPSED. Choosing a grouping is asking what shape the
   * collection is, and sixty open groups answer that with the same scroll
   * the user was escaping, plus sixty rows of heading.
   *
   * Re-choosing the column that is already set does nothing at all: it must
   * not re-collapse groups the user has just opened, which is what a
   * `<select>` firing `change` on a reselect would otherwise cause.
   *
   * Takes a `string` because that is what a <select> hands over, and because
   * `isGroupableColumn` is then the one gate — a value that is not a
   * groupable column (a price, a column since deleted) means no grouping
   * rather than a crash.
   */
  setGroupColumn(column: string): void {
    const next = isGroupableColumn(column) ? column : null;
    if (next === this.groupColumn()) return;

    this.groupColumn.set(next);
    this.groupExpansion.set(collapseAllGroups());
    // THE CUSTOM ORDERS ARE NOT TOUCHED. They are keyed by column, so the
    // Country order is simply not consulted while the grid is grouped by
    // Grade — and it is waiting, intact, when he switches back. Clearing
    // them here would destroy a minute of dragging for a glance at another
    // column; applying them would be incoherent. Neither is necessary.
    this.groupOrderAnnouncement.set('');
    this.persistGrouping();
  }

  /** A heading was clicked: open it if shut, shut it if open. */
  toggleGroupExpansion(heading: string): void {
    this.groupExpansion.set(toggleGroup(this.groupExpansion(), heading));
    this.persistGrouping();
  }

  /** The one control: whichever of expand-all / collapse-all would change something. */
  applyExpandAll(): void {
    this.groupExpansion.set(applyExpandAllControl(this.expandAllControl().action));
    this.persistGrouping();
  }

  /** Fire-and-forget, like the sort: the grid must fold instantly, not after
   *  a database round trip. */
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

  /* ===================== Remembering the filters ===================== */

  /**
   * True only while restoreFromStorage is writing the signals back.
   *
   * Without it, restoring eight filters would write the same eight values
   * straight back to IndexedDB one at a time — harmless, but it would also
   * mean a half-applied restore could be persisted if one of the later
   * writes threw.
   */
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
      // Deliberately swallowed — see the doc comment. The default stands.
    }
  }

  /**
   * Load the remembered filters, and MAKE THEM VISIBLE.
   *
   * A restored filter is invisible state that makes the grid lie about the
   * collection: four hundred coins are missing and the only thing that
   * could say why is a panel that opens closed. So the last line here is
   * not the saved panel state, it is `shouldRevealAdvancedFilters` — the
   * panel is forced open whenever anything inside it is narrowing the grid,
   * which puts the country dropdown reading "Mexico" on screen next to the
   * eleven rows it is responsible for.
   *
   * Everything is validated rather than trusted, and every failure degrades
   * to the unfiltered default rather than throwing. The status set is the
   * one with teeth: a saved status that no longer exists is dropped, and if
   * that empties the set — or the user saved an empty one — it becomes all
   * five, because an empty set shows no coins and a restored empty grid has
   * nobody to blame. See inventory-filter-persistence.ts.
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
      // Deliberately swallowed. An unfiltered grid is the safe failure:
      // it shows the user everything he owns.
    }
  }

  /**
   * Load the remembered grouping and which of its groups were open.
   *
   * `Source` was removed from the grid yesterday, so a saved
   * `{ column: 'source' }` is not hypothetical. `restoreGrouping` answers
   * every unusable value — a deleted column, a column that has become
   * numeric, a truncated object, a string where an array should be — with
   * the same thing: no grouping, which is the flat grid the user has always
   * had. It never throws and it never produces a grid with rows missing.
   */
  private async restoreGroupingFromStorage(): Promise<void> {
    try {
      if (!this.storage) return;
      const stored = await this.storage.get<unknown>(StorageKeys.GridGrouping);
      if (!stored) return;

      const { column, expansion } = restoreGrouping(stored);
      this.groupColumn.set(column);
      this.groupExpansion.set(expansion);
      // READ SEPARATELY, AND SURVIVING A GROUPING THAT DID NOT. The orders
      // are validated per column by group-order.ts, so a blob whose `column`
      // was the deleted `source` still gives the user back the Country order
      // he dragged. A saved order naming groups that no longer exist is not
      // an error either: `applyGroupOrder` skips a heading it cannot find,
      // so the worst case is the alphabet and never an empty grid.
      this.groupOrders.set(restoreGroupOrders(stored));
    } catch {
      // Deliberately swallowed. The flat grid stands.
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
