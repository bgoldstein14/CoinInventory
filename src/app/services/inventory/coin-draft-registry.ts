import { signal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { describeMissingCoinDetail, hasEnoughCoinDetail } from '../coin-completeness';

/* ===========================================================================
 * CoinDraftRegistry
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The answer to "has this coin ever existed in the database?", and nothing
 *   else. It is a tiny state machine with three states per coin id.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — THE BUG IT FIXES
 *
 *   Clicking "Add coin" used to build a completely empty CoinRecord and POST
 *   it to the server immediately. The backend, quite reasonably, answered
 *   `400 {"error":"denomination is required"}`, so the user got a red error
 *   toast before they had typed a single character.
 *
 *   The app saves aggressively (every edit is written a second later) and we
 *   want to keep that. The fix is therefore NOT "add a Save button" — it is
 *   to delay only the FIRST write:
 *
 *       A new coin is a purely LOCAL DRAFT until it is good enough to save.
 *       The moment it is good enough, it saves itself, and from then on it
 *       behaves exactly like every other coin.
 *
 * ---------------------------------------------------------------------------
 * THE THREE STATES
 *
 *   'draft'     The row exists on screen only. NO HTTP request has ever been
 *               made for it. Editing it repaints the screen and does nothing
 *               else — there is no server row to PUT to, so attempting one
 *               would be the original bug in a different costume.
 *
 *   'creating'  The row has just qualified and its POST is in flight. Edits
 *               still only repaint: we must not fire a PUT against an id the
 *               server has not acknowledged yet, and we must not fire a
 *               SECOND POST for the same coin. Anything typed during this
 *               window is reconciled by CoinEditor once the POST lands.
 *
 *   (absent)    A normal, server-backed coin. All the usual machinery in
 *               CoinChangeTracker / CoinEditor applies: debounced PUTs
 *               carrying only the changed fields.
 *
 *   The only legal transitions are:
 *
 *       addBlankCoin()          -> 'draft'
 *       qualifies (2-of-3)      -> 'creating'
 *       POST succeeds           -> (absent)   [now a real coin]
 *       POST fails              -> 'draft'    [so the next edit retries]
 *       deleteCoin() / reload   -> (absent)   [forget it entirely]
 *
 *   Note the failure edge in particular: a failed create must NOT silently
 *   graduate the coin, or the next edit would PUT to a row that does not
 *   exist and the user's coin would be lost. Dropping back to 'draft' means
 *   the very next qualifying edit tries the POST again.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES *NOT* DO
 *
 *   Drafts are not persisted anywhere. If the user adds a row, types nothing
 *   useful and refreshes the page, the row is gone. That is intended: an
 *   empty row is not data, and remembering it would mean inventing a second,
 *   client-only storage format for coins.
 * =========================================================================== */

/** The two states a not-yet-real coin can be in. See the header. */
export type CoinDraftState = 'draft' | 'creating';

export class CoinDraftRegistry {
  /**
   * Coin id -> state, held in a signal so the inventory table can show an
   * "Unsaved" chip and re-render the instant a draft graduates.
   *
   * A brand new Map is stored on every change (rather than mutating in
   * place) because signals compare by reference — mutating the same Map
   * would update nothing on screen.
   */
  private readonly states = signal<ReadonlyMap<string, CoinDraftState>>(new Map());

  /**
   * Coins we have already shown a create-failure toast for. Without this,
   * every keystroke during an outage would stack up another sticky error —
   * the same de-duplication CoinChangeTracker does for failed PUTs.
   */
  private readonly notifiedCreateFailures = new Set<string>();

  /* =========================================================================
   * Reading state
   * ======================================================================= */

  /** The raw state, or undefined for a normal server-backed coin. */
  stateOf(coinId: string): CoinDraftState | undefined {
    return this.states().get(coinId);
  }

  /**
   * True while a coin has no row in the database yet — i.e. it is either a
   * local draft or has a create in flight.
   *
   * This is THE question the rest of the app asks. Anything that would send
   * a PUT or a DELETE for this coin must check it first.
   */
  isUnsaved(coinId: string): boolean {
    return this.states().has(coinId);
  }

  /** True only for a draft that has not yet been sent at all. */
  isDraft(coinId: string): boolean {
    return this.states().get(coinId) === 'draft';
  }

  /** How many rows are currently unsaved (handy for tests and diagnostics). */
  unsavedCount(): number {
    return this.states().size;
  }

  /* =========================================================================
   * Transitions
   * ======================================================================= */

  /**
   * Mark a coin as a local-only draft. Used both for a freshly added row and
   * to put a coin BACK into draft after its create failed.
   */
  markDraft(coinId: string): void {
    this.setState(coinId, 'draft');
  }

  /** Mark a coin's create request as in flight. */
  markCreating(coinId: string): void {
    this.setState(coinId, 'creating');
  }

  /**
   * Graduate a coin (or forget a deleted one): it is now an ordinary
   * server-backed record and no longer this class's business.
   */
  clear(coinId: string): void {
    this.notifiedCreateFailures.delete(coinId);
    if (!this.states().has(coinId)) return;

    const next = new Map(this.states());
    next.delete(coinId);
    this.states.set(next);
  }

  /**
   * Forget every draft. Called whenever the whole list is replaced from the
   * server — at that point nothing on screen is a local invention any more.
   */
  clearAll(): void {
    this.notifiedCreateFailures.clear();
    if (this.states().size === 0) return;
    this.states.set(new Map());
  }

  /* =========================================================================
   * The saving rule (borrowed wholesale from coin-completeness.ts)
   * ======================================================================= */

  /**
   * Is this coin finally worth writing to the database?
   *
   * This is deliberately the SAME 2-of-3 rule the QIF importer applies, from
   * the same module, so the manual and imported paths can never disagree
   * about what counts as a coin.
   */
  qualifiesForSave(coin: CoinRecord): boolean {
    return hasEnoughCoinDetail(coin);
  }

  /**
   * The hint shown on an unsaved row, e.g.
   * "Not saved yet. Add 1 more of: Coin Type, Denomination."
   */
  describeWhatIsMissing(coin: CoinRecord): string {
    return describeMissingCoinDetail(coin);
  }

  /* =========================================================================
   * Failure-toast de-duplication
   * ======================================================================= */

  /**
   * True the FIRST time a coin's create fails, false for every failure after
   * that until it eventually succeeds.
   */
  shouldNotifyCreateFailure(coinId: string): boolean {
    if (this.notifiedCreateFailures.has(coinId)) return false;
    this.notifiedCreateFailures.add(coinId);
    return true;
  }

  // -------------------------------------------------------------------------

  private setState(coinId: string, state: CoinDraftState): void {
    if (this.states().get(coinId) === state) return;
    const next = new Map(this.states());
    next.set(coinId, state);
    this.states.set(next);
  }
}
