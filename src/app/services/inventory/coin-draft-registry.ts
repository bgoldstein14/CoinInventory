import { signal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { describeMissingCoinDetail } from '../coin-completeness';
import { canCreateCoin, describeMissingServerRequirement } from './coin-create-requirements';

 /*
 * CoinDraftRegistry
 *
 * WHAT THIS FILE OWNS
 *   The answer to "has this coin ever existed in the database?", and nothing
 *   else. It is a tiny state machine with three states per coin id.
 *
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
 *       qualifies to be created -> 'creating'
 *       POST succeeds           -> (absent)   [now a real coin]
 *       POST fails              -> 'draft'    [so the next edit retries]
 *       deleteCoin() / reload   -> (absent)   [forget it entirely]
 *
 *   Note the failure edge in particular: a failed create must NOT silently
 *   graduate the coin, or the next edit would PUT to a row that does not
 *   exist and the user's coin would be lost. Dropping back to 'draft' means
 *   the very next qualifying edit tries the POST again.
 *
 * WHAT THIS DELIBERATELY DOES *NOT* DO
 *
 *   Drafts are not persisted anywhere. If the user adds a row, types nothing
 *   useful and refreshes the page, the row is gone. That is intended: an
 *   empty row is not data, and remembering it would mean inventing a second,
 *   client-only storage format for coins.
  */

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

  /**
   * Coin id -> why its last create attempt failed.
   *
   * The toast is shown once and dismissed; this is what keeps the ROW
   * honest afterwards. A row whose create failed looked exactly like a saved
   * row, which is what let the owner carry on editing (and attaching photos
   * to) a coin the database had never heard of. Readers reach this through
   * `describeWhatIsMissing`, which touches the `states` signal first so the
   * tooltip re-renders when a failure is recorded.
   */
  private readonly createFailures = new Map<string, string>();

  /* ---- Reading state ---- */

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

  /* ---- Transitions ---- */

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
    this.createFailures.delete(coinId);
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
    this.createFailures.clear();
    if (this.states().size === 0) return;
    this.states.set(new Map());
  }

  /* ---- The saving rule (borrowed wholesale from coin-completeness.ts) ---- */

  /**
   * Is this coin finally worth writing to the database — AND will the
   * database take it?
   *
   * Still the SAME 2-of-3 rule the QIF importer applies, from the same
   * module, so the manual and imported paths cannot disagree about what
   * counts as a coin. But that rule alone was not sufficient, and the gap is
   * what produced a phantom row:
   *
   *     22:55:22 [ERROR] Failed to create coin 423f9821-... in database
   *                      | 400 Bad Request: denomination is required
   *
   * A coin with a Year and a Coin Type passes 2-of-3 and is refused by
   * `POST /api/coins`, which requires a denomination outright. So the gate is
   * now "complete enough to be a coin AND acceptable to the endpoint that
   * would store it" — see coin-create-requirements.ts, which explains why the
   * server's rule is mirrored rather than relaxed and why the shared 2-of-3
   * rule was deliberately left alone.
   */
  qualifiesForSave(coin: CoinRecord): boolean {
    return canCreateCoin(coin);
  }

  /**
   * The hint shown on an unsaved row. Three things it may have to say, in
   * the order the user needs them:
   *
   *   "Not saved yet. Add 1 more of: Coin Type, Denomination."
   *       — still short of the 2-of-3 rule.
   *   "Not saved yet. A Denomination is required before this coin can be
   *    saved."
   *       — passes 2-of-3, but POST /api/coins would answer 400. This is the
   *         case the owner hit, and before the fix it produced an "Unsaved"
   *         chip with an EMPTY tooltip while doomed POSTs fired in the
   *         background.
   *   "Not saved yet — the last attempt failed: ..."
   *       — the server was asked and said no (or could not be reached). The
   *         toast for that is long gone by the time the user looks at the
   *         row, so the row has to carry it.
   *
   * Empty string when the row is simply waiting for its debounced create.
   */
  describeWhatIsMissing(coin: CoinRecord): string {
    // Subscribe to the state signal, so a tooltip rendered from this method
    // is re-evaluated when a create fails or a draft graduates.
    this.states();

    const missingDetail = describeMissingCoinDetail(coin);
    if (missingDetail) return missingDetail;

    const missingRequirement = describeMissingServerRequirement(coin);
    if (missingRequirement) return missingRequirement;

    const failure = this.createFailures.get(coin.id);
    return failure
      ? `Not saved yet — the last attempt failed: ${failure}. Edit this row to retry.`
      : '';
  }

  /* ---- Failure-toast de-duplication ---- */

  /**
   * True the FIRST time a coin's create fails, false for every failure after
   * that until it eventually succeeds.
   */
  shouldNotifyCreateFailure(coinId: string): boolean {
    if (this.notifiedCreateFailures.has(coinId)) return false;
    this.notifiedCreateFailures.add(coinId);
    return true;
  }

  /**
   * Remember why a coin's create failed, so the ROW can say so for as long
   * as it stays unsaved — not just the one toast.
   *
   * Call this BEFORE `markDraft`: the state change that follows is what
   * re-renders anything showing the hint.
   */
  recordCreateFailure(coinId: string, message: string): void {
    if (!coinId) return;
    this.createFailures.set(coinId, message);
  }


  private setState(coinId: string, state: CoinDraftState): void {
    if (this.states().get(coinId) === state) return;
    const next = new Map(this.states());
    next.set(coinId, state);
    this.states.set(next);
  }
}
