/*
 * inventory-filter-persistence.ts — remembering what the grid was filtered to.
 *
 * WHY A FILTER IS THE DANGEROUS THING TO PERSIST. Columns and sort are
 * cosmetic: restore the wrong ones and the user sees all his coins in an
 * order he did not expect. A filter is not cosmetic, because it REMOVES
 * ROWS. A country filter restored three weeks later, from a panel that
 * opens closed, shows a collector eleven coins and no reason at all for the
 * other four hundred being gone. The grid is not wrong, it is LYING, and
 * there is nothing on screen to argue with.
 *
 * So two rules run through this file, and both exist to stop that:
 *
 *   1. ANYTHING RESTORED MUST BE VISIBLE. `shouldRevealAdvancedFilters`
 *      forces the advanced panel open when what came back out of storage
 *      narrows anything. The controls in that panel are already bound to the
 *      store, so opening it IS the explanation: the country dropdown shows
 *      "Mexico" and the user can see why.
 *
 *   2. A SAVED STATE THAT SHOWS NOTHING IS NOT RESTORED. An empty status set
 *      deliberately shows no coins (see collectionStatusFilter in
 *      inventory-filter.store.ts) and that is right WITHIN a session, where
 *      the user just unticked the last box and the panel is open in front of
 *      him saying so. Restored into a fresh session it is an empty grid with
 *      no author. It degrades to all five, which is also where a saved
 *      status that no longer exists lands.
 *
 * Pure and DOM-free: the suite runs under Node with no jsdom.
 */
import {
  COLLECTION_STATUSES,
  CollectionStatus
} from '../../types/collection-status';

/**
 * Every filter the grid can be narrowed by, as written to storage.
 *
 * Flat strings, mirroring the signals one-for-one, so adding a filter means
 * adding a field here and nothing else. The sentinels ('All' for category
 * and set, '' for the rest) are the stores', not this file's — see
 * allCategoriesFilter / allSetsFilter.
 */
export interface StoredFilterState {
  readonly searchQuery: string;
  readonly categoryFilter: string;
  readonly gradeFilter: string;
  readonly valueMinFilter: string;
  readonly valueMaxFilter: string;
  readonly sourceFilter: string;
  readonly countryFilter: string;
  readonly coinSetFilter: string;
  readonly collectionStatuses: readonly CollectionStatus[];
  /** Whether the advanced panel was open. Overridden by rule 1 above. */
  readonly showAdvancedFilters: boolean;
}

/** The sentinel meaning "every category". Duplicated from the store as a
 *  plain constant so this module stays free of it; the store's value is the
 *  one that is compared against, and a spec pins the two together. */
const ALL = 'All';

/** An unfiltered grid. What a fresh install has, and what anything
 *  unreadable degrades to. */
export const DEFAULT_FILTER_STATE: StoredFilterState = {
  searchQuery: '',
  categoryFilter: ALL,
  gradeFilter: '',
  valueMinFilter: '',
  valueMaxFilter: '',
  sourceFilter: '',
  countryFilter: '',
  coinSetFilter: ALL,
  collectionStatuses: [...COLLECTION_STATUSES],
  showAdvancedFilters: false
};

/** Read a string field, or fall back. Anything that is not a string — a
 *  number, a null, an object an older build wrote — is not a filter. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Read a saved filter set back, DEGRADING RATHER THAN THROWING.
 *
 * Nothing in here is trusted. It is JSON from a browser database that an
 * older build may have written, and every field is validated on its own so
 * that one unrecognisable value costs the user that one filter rather than
 * all of them.
 *
 * THE STATUS LIST IS THE ONE WITH TEETH. Statuses are tokens stored on every
 * coin, and the set has changed before. A saved `['owned', 'consigned']`
 * loses the token that no longer exists; a saved `['consigned']` would lose
 * all of them and leave an empty set, which shows an empty grid — so an
 * empty result, however it arose, becomes all five. Order is rebuilt from
 * COLLECTION_STATUSES rather than taken from storage, for the same reason
 * the store rebuilds it on every toggle.
 */
export function restoreFilterState(stored: unknown): StoredFilterState {
  if (!stored || typeof stored !== 'object') return DEFAULT_FILTER_STATE;
  const value = stored as Partial<Record<keyof StoredFilterState, unknown>>;

  const savedStatuses = Array.isArray(value.collectionStatuses) ? value.collectionStatuses : [];
  const statuses = COLLECTION_STATUSES.filter(status => savedStatuses.includes(status));

  return {
    searchQuery: text(value.searchQuery, DEFAULT_FILTER_STATE.searchQuery),
    categoryFilter: text(value.categoryFilter, DEFAULT_FILTER_STATE.categoryFilter),
    gradeFilter: text(value.gradeFilter, DEFAULT_FILTER_STATE.gradeFilter),
    valueMinFilter: text(value.valueMinFilter, DEFAULT_FILTER_STATE.valueMinFilter),
    valueMaxFilter: text(value.valueMaxFilter, DEFAULT_FILTER_STATE.valueMaxFilter),
    sourceFilter: text(value.sourceFilter, DEFAULT_FILTER_STATE.sourceFilter),
    countryFilter: text(value.countryFilter, DEFAULT_FILTER_STATE.countryFilter),
    coinSetFilter: text(value.coinSetFilter, DEFAULT_FILTER_STATE.coinSetFilter),
    collectionStatuses: statuses.length > 0 ? statuses : [...COLLECTION_STATUSES],
    showAdvancedFilters: value.showAdvancedFilters === true
  };
}

/**
 * How many of the ADVANCED filters are narrowing the grid.
 *
 * The advanced ones only, because they are the ones that hide inside a
 * collapsed panel. The search box and the category dropdown live in the
 * always-visible toolbar row and show their own state; nothing needs to be
 * revealed for them.
 *
 * The status set counts as narrowing only when it is not all five — all five
 * ticked is the default and hides nothing.
 */
export function activeAdvancedFilterCount(state: StoredFilterState): number {
  let count = 0;
  if (state.gradeFilter.trim()) count += 1;
  if (state.valueMinFilter.trim()) count += 1;
  if (state.valueMaxFilter.trim()) count += 1;
  if (state.sourceFilter) count += 1;
  if (state.countryFilter) count += 1;
  if (state.coinSetFilter !== ALL) count += 1;
  if (state.collectionStatuses.length !== COLLECTION_STATUSES.length) count += 1;
  return count;
}

/**
 * Must the advanced filter panel be open after a restore?
 *
 * Yes whenever anything in it is narrowing the grid, whatever the saved
 * panel state said. This is rule 1 at the top of the file: a restored filter
 * the user cannot see is a grid that lies about the collection, and the
 * cheapest honest answer is to put the control that caused it on screen next
 * to the result.
 *
 * It only ever forces the panel OPEN. A saved open panel with nothing in it
 * is restored open too, because the user left it that way.
 */
export function shouldRevealAdvancedFilters(state: StoredFilterState): boolean {
  return state.showAdvancedFilters || activeAdvancedFilterCount(state) > 0;
}
