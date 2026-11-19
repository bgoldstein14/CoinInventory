import { signal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { describeMissingCoinDetail } from '../coin-completeness';
import { canCreateCoin, describeMissingServerRequirement } from './coin-create-requirements';

 /*
  * Tracks whether a coin has ever existed in the database. A new coin is a local
  * draft until it is complete enough to save; then it saves itself and behaves
  * like any other coin. (Saving a blank coin straight away would get
  * `400 denomination is required`.)
  *
  *   'draft'     on screen only; no request has been made. Edits only repaint
  *               (there is no row to PUT to).
  *   'creating'  qualified; its POST is in flight. Edits only repaint: no PUT
  *               against an unacknowledged id and no second POST. CoinEditor
  *               reconciles them when the POST lands.
  *   (absent)    a normal server-backed coin: debounced PUTs of changed fields.
  *
  * Transitions:
  *     addBlankCoin()          -> 'draft'
  *     qualifies to be created -> 'creating'
  *     POST succeeds           -> (absent)
  *     POST fails              -> 'draft'   (the next edit retries)
  *     deleteCoin() / reload   -> (absent)
  * A failed create must never graduate the coin, or later edits would PUT to a
  * row that doesn't exist.
  *
  * Drafts aren't persisted: an unfinished row disappears on refresh.
  */

/** The two states of a not-yet-saved coin (see the file header). */
export type CoinDraftState = 'draft' | 'creating';

export class CoinDraftRegistry {
  /**
   * Coin id -> state, in a signal so the table's "Unsaved" chip updates when a
   * draft graduates. A new Map is stored on every change (signals compare by
   * reference).
   */
  private readonly states = signal<ReadonlyMap<string, CoinDraftState>>(new Map());

  /** Coins already shown a create-failure toast (one per coin, as CoinChangeTracker does for PUTs). */
  private readonly notifiedCreateFailures = new Set<string>();

  /**
   * Coin id -> why its last create failed, so the row keeps saying it isn't saved
   * after the toast is gone. Read via `describeWhatIsMissing`, which touches the
   * `states` signal so the tooltip re-renders.
   */
  private readonly createFailures = new Map<string, string>();

  /* Reading state */

  /** The raw state, or undefined for a server-backed coin. */
  stateOf(coinId: string): CoinDraftState | undefined {
    return this.states().get(coinId);
  }

  /**
   * True while a coin has no database row (a draft, or a create in flight).
   * Anything sending a PUT or DELETE for the coin must check this first.
   */
  isUnsaved(coinId: string): boolean {
    return this.states().has(coinId);
  }

  /** True only for a draft not yet sent at all. */
  isDraft(coinId: string): boolean {
    return this.states().get(coinId) === 'draft';
  }

  /** How many rows are unsaved (tests and diagnostics). */
  unsavedCount(): number {
    return this.states().size;
  }

  /* Transitions */

  /** Marks a coin as a local draft: a new row, or one whose create failed. */
  markDraft(coinId: string): void {
    this.setState(coinId, 'draft');
  }

  /** Marks a coin's create request as in flight. */
  markCreating(coinId: string): void {
    this.setState(coinId, 'creating');
  }

  /** Graduates a coin (or forgets a deleted one): now an ordinary server-backed record. */
  clear(coinId: string): void {
    this.notifiedCreateFailures.delete(coinId);
    this.createFailures.delete(coinId);
    if (!this.states().has(coinId)) return;

    const next = new Map(this.states());
    next.delete(coinId);
    this.states.set(next);
  }

  /** Forgets every draft; called when the list is replaced from the server. */
  clearAll(): void {
    this.notifiedCreateFailures.clear();
    this.createFailures.clear();
    if (this.states().size === 0) return;
    this.states.set(new Map());
  }

  /* The saving rule */

  /**
   * Whether a coin is ready to save: it passes the 2-of-3 rule shared with the
   * QIF importer, and the server will accept it (it requires a denomination).
   * See coin-create-requirements.ts.
   */
  qualifiesForSave(coin: CoinRecord): boolean {
    return canCreateCoin(coin);
  }

  /**
   * The hint shown on an unsaved row:
   *   "Not saved yet. Add 1 more of: Coin Type, Denomination."
   *       short of the 2-of-3 rule
   *   "Not saved yet. A Denomination is required before this coin can be saved."
   *       passes 2-of-3, but POST /api/coins would answer 400
   *   "Not saved yet — the last attempt failed: ..."
   *       the server refused or was unreachable (the toast is long gone)
   * '' when the row is just waiting for its debounced create.
   */
  describeWhatIsMissing(coin: CoinRecord): string {
    // Reactive dependency, so a tooltip re-renders when a create fails or a draft graduates.
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

  /* Failure-toast de-duplication */

  /** True the first time a coin's create fails, then false until it succeeds. */
  shouldNotifyCreateFailure(coinId: string): boolean {
    if (this.notifiedCreateFailures.has(coinId)) return false;
    this.notifiedCreateFailures.add(coinId);
    return true;
  }

  /**
   * Remembers why a coin's create failed, for the row's hint while it stays
   * unsaved. Call before `markDraft`, whose state change re-renders the hint.
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
