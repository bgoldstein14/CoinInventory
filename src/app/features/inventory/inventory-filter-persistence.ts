/*
 * Saving and restoring the grid's filters.
 *
 * Restored filters hide rows, so two rules apply:
 *   1. Anything restored must be visible: the advanced panel is forced open
 *      when a restored filter inside it is active.
 *   2. A saved status set that would show nothing (empty, or only removed
 *      statuses) restores as all statuses.
 */
import {
  COLLECTION_STATUSES,
  CollectionStatus
} from '../../types/collection-status';

/** Every grid filter as written to storage, one field per store signal. */
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

/** Same value as the store's allCategoriesFilter / allSetsFilter; a spec pins them together. */
const ALL = 'All';

/** An unfiltered grid: the fresh-install state and the fallback for unreadable data. */
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

/** Read a string field, or fall back. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Parse a saved filter set without throwing. Each field is validated on its
 * own, so one bad value only resets that filter. Unknown statuses are dropped
 * and an empty result becomes all statuses.
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
 * How many advanced-panel filters are narrowing the grid. The search box and
 * category live in the always-visible toolbar, so they aren't counted.
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

/** Should the advanced panel be open after a restore? Only ever forces it open. */
export function shouldRevealAdvancedFilters(state: StoredFilterState): boolean {
  return state.showAdvancedFilters || activeAdvancedFilterCount(state) > 0;
}
