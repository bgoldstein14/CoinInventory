/*
 * What an empty-looking grid is allowed to say.
 *
 * "No coins yet" is shown only when the coin list has arrived and is empty.
 * `inventory().length === 0` alone can't tell "no coins" from "not fetched yet",
 * and inviting a user with a full collection to import would duplicate it.
 * Kept as a pure module so the decision is unit-testable without a DOM.
 */

/** What the app knows about its attempt to load the coin list. */
export interface CollectionLoadStatus {
  /**
   * True once the coin fetch has come back. Read from
   * `InventoryService.connected()`, which is set as soon as the coins arrive.
   */
  loaded: boolean;

  /** True when the coin fetch failed (`connectionError() !== null`). */
  failed: boolean;
}

/** Which of the five situations the grid is in. */
export type ZeroStateKind = 'none' | 'loading' | 'failed' | 'empty' | 'filtered';

export interface CollectionZeroState {
  kind: ZeroStateKind;
  /** The sentence to render. Empty string when `kind` is 'none'. */
  message: string;
  /** An optional second line. Null when there is nothing useful to add. */
  hint: string | null;
}

const EMPTY_MESSAGE = 'No coins yet. Add one manually or import from a QIF/CSV file.';

const FILTERED_MESSAGE = 'No coins match the current search and filters.';

const LOADING_MESSAGE = 'Loading your collection…';

const FAILED_MESSAGE = 'Your collection could not be loaded.';

/** Points at the error banner (which has the Retry button) instead of repeating it. */
const FAILED_HINT = 'This is not an empty collection — see the message at the top of the window.';

/**
 * Work out what the grid should say when it has no rows to draw.
 * Branches are ordered strongest evidence first:
 *  1. Rows visible -> nothing to say.
 *  2. Coins loaded but none visible -> filtered out.
 *  3. Load failed -> point to the banner.
 *  4. List not arrived -> loading.
 *  5. Otherwise the collection is genuinely empty.
 */
export function collectionZeroState(
  status: CollectionLoadStatus,
  total: number,
  visible: number
): CollectionZeroState {
  if (visible > 0) {
    return { kind: 'none', message: '', hint: null };
  }

  if (total > 0) {
    return { kind: 'filtered', message: FILTERED_MESSAGE, hint: null };
  }

  if (status.failed) {
    return { kind: 'failed', message: FAILED_MESSAGE, hint: FAILED_HINT };
  }

  if (!status.loaded) {
    return { kind: 'loading', message: LOADING_MESSAGE, hint: null };
  }

  return { kind: 'empty', message: EMPTY_MESSAGE, hint: null };
}

/**
 * The same rule for aggregate screens (Statistics, Reports summary), whose
 * totals would read $0.00 before the coins arrive.
 * @returns the notice to show instead of the figures, or null once loaded.
 */
export function collectionNotReadyNotice(status: CollectionLoadStatus): string | null {
  if (status.loaded) return null;
  if (status.failed) return `${FAILED_MESSAGE} ${FAILED_HINT}`;
  return LOADING_MESSAGE;
}
