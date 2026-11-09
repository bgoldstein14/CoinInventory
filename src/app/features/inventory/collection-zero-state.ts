/*
 * What an empty-looking grid is allowed to say.
 *
 * THE RULE
 *   "No coins yet. Add one manually or import from a QIF/CSV file." may be
 *   said in EXACTLY ONE situation: the coin list has ARRIVED and it was
 *   empty.
 *
 * `inv.inventory().length === 0` cannot distinguish "you own no coins" from
 * "we have not fetched them yet", and getting that wrong is not a cosmetic
 * slip: it tells a user with a full collection they have none AND invites
 * them to import, which would duplicate everything they own. Everywhere
 * other than the one case above, the app does not know the collection is
 * empty, so it does not get to say so. Same rule as `computeMeltValue`
 * returning null rather than $0.00 — a visible blank beats a silently wrong
 * answer — moved from numbers to STATUS.
 *
 * WHY A PURE MODULE
 *   The frontend suite runs under Node with no jsdom, so nothing decided
 *   inside an Angular template can be tested at all. Putting the decision
 *   here means the four-way choice is covered exhaustively by
 *   collection-zero-state.spec.ts, and the template is left with one
 *   interpolation. zero-state-wiring.spec.ts greps that the template really
 *   does ask.
 */

/**
 * What the app knows about its attempt to load the coin list.
 *
 * NOTE WHAT IS NOT HERE: `connecting`. It looks like it belongs, but it
 * answers "is a request in flight", and the question that decides every
 * branch below is "has the list arrived" — which `loaded` answers on its
 * own. Including `connecting` would add a state with no distinct message and
 * one more way to get the ordering wrong.
 */
export interface CollectionLoadStatus {
  /**
   * True once the coin fetch has actually come back.
   *
   * Read from `InventoryService.connected()`, which ConnectionManager sets in
   * phase 1 of hydrate() — AFTER the coins arrive and before anything else
   * happens. Nothing in phase 2 can flip it back, so it means exactly "we
   * have the list", which is exactly what is needed here.
   */
  loaded: boolean;

  /**
   * True when the coin fetch failed outright. Read from
   * `InventoryService.connectionError() !== null`.
   */
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

/** The invitation. CORRECT — but only in the one case below. */
const EMPTY_MESSAGE = 'No coins yet. Add one manually or import from a QIF/CSV file.';

const FILTERED_MESSAGE = 'No coins match the current search and filters.';

const LOADING_MESSAGE = 'Loading your collection…';

const FAILED_MESSAGE = 'Your collection could not be loaded.';

/**
 * Deliberately points at the banner instead of repeating the error. Two
 * different wordings of one failure on the same screen leave the user unsure
 * whether they have one problem or two, and the banner is the thing with the
 * Retry button on it.
 */
const FAILED_HINT = 'This is not an empty collection — see the message at the top of the window.';

/**
 * Work out what the grid should say when it has no rows to draw.
 *
 * ORDER OF THE BRANCHES IS THE DESIGN. Read it as "strongest evidence first":
 *
 *  1. Rows ON SCREEN -> there is nothing to say at all. Checked first so a
 *     reload behind a populated grid never grows a "Loading…" row under it.
 *  2. Coins IN HAND but none visible -> the filters hid them. True whatever
 *     the connection is doing, because the coins are right there.
 *  3. The load FAILED -> say so, and send the user to the banner.
 *  4. The list HAS NOT ARRIVED -> loading. The honest answer whenever we do
 *     not have the data, including the moment before hydrate() even starts.
 *  5. Only now, with the list in hand and genuinely empty, the invitation.
 *
 * @param status  - what we know about the load; see CollectionLoadStatus
 * @param total   - how many coins are in the collection as currently known
 * @param visible - how many survive the search box and the filters
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
 * The same rule for the screens that show AGGREGATES rather than a list —
 * Statistics and the Reports summary.
 *
 * Those have no "filtered to nothing" case; what they have is worse. Before
 * the coins arrive, every total on them is computed over an empty array, so
 * the hero figure reads "$0.00", "no coin is recorded as gold" appears, and
 * the Reports summary says the collection holds 0 coins worth $0.00. That is
 * the same lie as "No coins yet", told in numbers, and on the Reports screen
 * it sits one button away from a document that could go to an insurer.
 *
 * @returns the notice to show INSTEAD of the figures, or null when the data
 *          has arrived and the figures can be trusted.
 */
export function collectionNotReadyNotice(status: CollectionLoadStatus): string | null {
  if (status.loaded) return null;
  if (status.failed) return `${FAILED_MESSAGE} ${FAILED_HINT}`;
  return LOADING_MESSAGE;
}
