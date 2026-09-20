import { WritableSignal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { CoinChangeTracker, valuesEqual } from './coin-change-tracker';
import { CoinDraftRegistry } from './coin-draft-registry';
import { firstValueFrom } from 'rxjs';

/* ===========================================================================
 * CoinEditor
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The "the user typed something" path, end to end:
 *     1. paint the new value on screen straight away (optimistic update),
 *     2. work out which fields are genuinely unsaved (via CoinChangeTracker),
 *     3. wait one second in case more typing follows (debounce),
 *     4. PUT only the changed fields, and
 *     5. record success / report failure.
 *
 *   ...and, since the draft fix, the one-off FIRST save of a brand new row:
 *     0. if this coin has never reached the database, do not PUT anything.
 *        Just repaint, and POST the whole record the moment it becomes good
 *        enough to save. See coin-draft-registry.ts for the state machine.
 *
 * WHY IT IS ITS OWN FILE
 *   This is the one flow in the app where a mistake silently loses the user's
 *   data, so it deserves to be readable on a single screen without the CRUD,
 *   lookup and hydration code around it.
 *
 * It owns no state of its own: the coin list lives in a signal owned by
 * InventoryService, and all save bookkeeping lives in CoinChangeTracker and
 * CoinDraftRegistry.
 * =========================================================================== */

/** How long to wait after the last keystroke before writing to the server. */
const SAVE_DEBOUNCE_MS = 1000;

export class CoinEditor {
  constructor(
    /** The live, on-screen coin list (shared with InventoryService). */
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly tracker: CoinChangeTracker,
    /** Which coins have never reached the database. See its file header. */
    private readonly drafts: CoinDraftRegistry,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /**
   * Apply an edit to a coin: update the screen immediately, then save to the
   * server one second later.
   *
   * There are two save routes, and picking the wrong one is how data gets
   * lost, so the choice is made first and explicitly:
   *
   *   * The coin already exists on the server  -> debounced PUT of ONLY the
   *     changed fields. A previous refactor sent whole records and wiped out
   *     data the user had not touched, so this is a hard rule: the PUT body
   *     is built from the dirty-field set, never from the full record.
   *
   *   * The coin is still a local draft        -> no PUT is possible (there
   *     is no row to update), so we repaint and, once it qualifies, POST the
   *     whole record once. A full body is correct here and only here: we are
   *     creating the record, not patching it.
   *
   * @param coinId - id of the coin being edited
   * @param updates - the field(s) the user changed (keys set to `undefined`
   *                  are ignored — they mean "no opinion", not "clear this")
   */
  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    // Strip out `undefined` values up front.
    const proposed = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    ) as Partial<CoinRecord>;

    if (Object.keys(proposed).length === 0) return;

    const liveCoin = this.inventory().find(c => c.id === coinId);

    if (!liveCoin) {
      // The coin isn't in the local list (shouldn't normally happen). There is
      // nothing to diff or repaint, so just forward the request as-is.
      this.sendCoinUpdate(coinId, proposed);
      return;
    }

    // ---- 0. Draft route -----------------------------------------------------
    // Checked BEFORE we touch CoinChangeTracker. The tracker's whole job is to
    // remember what the server confirmed; letting a coin the server has never
    // seen into its maps would seed a bogus "confirmed" baseline of empty
    // strings, and the first real save would then diff against fiction.
    if (this.drafts.isUnsaved(coinId)) {
      this.updateDraftCoin(coinId, liveCoin, proposed);
      return;
    }

    // ---- The normal route, for coins that exist in the database ------------

    // Take a snapshot of the server-confirmed state BEFORE we optimistically
    // overwrite the local record — otherwise the snapshot would capture the
    // unsaved value and we would be back to the original bug.
    const confirmed = this.tracker.confirmedSnapshot(coinId);

    // ---- 1. Optimistic UI update -------------------------------------------
    this.paintOptimistically(coinId, liveCoin, proposed);

    // ---- 2. Recompute the dirty flags against the CONFIRMED state ----------
    // A field is dirty when the new value differs from what the server last
    // acknowledged. Re-typing a value that failed to save therefore stays
    // dirty and WILL be sent again.
    const dirtyCount = this.tracker.recordEdit(coinId, proposed, confirmed);

    // ---- 3. Nothing unsaved? Cancel any queued write and stop. -------------
    if (dirtyCount === 0) {
      this.tracker.cancelPendingWrite(coinId);
      return;
    }

    // ---- 4. Debounce the write by 1 second ---------------------------------
    this.tracker.schedulePendingWrite(coinId, SAVE_DEBOUNCE_MS, () => this.flushCoinUpdate(coinId));
  }

  /* =========================================================================
   * DRAFT COINS — the first-ever save
   * ======================================================================= */

  /**
   * Handle an edit to a coin that has never reached the database.
   *
   * The screen always updates. Whether anything is SENT depends on the draft
   * state machine:
   *
   *   'creating'  a POST is already in flight -> send nothing. Firing a second
   *               POST would duplicate the coin, and a PUT would race an id
   *               the server has not acknowledged. Whatever is typed now is
   *               reconciled by `onDraftCreated` when that POST lands.
   *
   *   'draft', still short of 2-of-3
   *               -> send nothing, and cancel any create an earlier keystroke
   *               queued (the user may have just cleared a field again).
   *
   *   'draft', now meeting 2-of-3
   *               -> queue the create, debounced by the same 1s the normal
   *               save path uses so that typing "Quarter" produces one POST
   *               rather than seven.
   */
  private updateDraftCoin(coinId: string, liveCoin: CoinRecord, proposed: Partial<CoinRecord>): void {
    const painted = this.paintOptimistically(coinId, liveCoin, proposed);

    if (this.drafts.stateOf(coinId) === 'creating') return;

    if (!this.drafts.qualifiesForSave(painted)) {
      this.tracker.cancelPendingWrite(coinId);
      return;
    }

    this.tracker.schedulePendingWrite(coinId, SAVE_DEBOUNCE_MS, () => this.createDraftCoin(coinId));
  }

  /**
   * The debounce timer fired on a qualifying draft: create it for real.
   *
   * Everything is re-checked here rather than trusted from when the timer was
   * scheduled, because a full second of typing (or a delete) can happen in
   * between.
   */
  private createDraftCoin(coinId: string): void {
    const liveCoin = this.inventory().find(c => c.id === coinId);
    if (!liveCoin) {
      // The row was deleted while the timer was pending. Nothing was ever
      // sent, so there is nothing to clean up on the server.
      this.drafts.clear(coinId);
      return;
    }

    // Not a draft any more (already created, or a create is in flight).
    if (this.drafts.stateOf(coinId) !== 'draft') return;

    // The last keystroke before the timer fired may have emptied a field.
    if (!this.drafts.qualifiesForSave(liveCoin)) return;

    // Snapshot exactly what we are about to send. This object — not whatever
    // the screen shows a moment later — is what the server will hold, so it
    // is what the change tracker must be seeded with on success.
    const record: CoinRecord = { ...liveCoin };

    this.drafts.markCreating(coinId);

    firstValueFrom(this.apiService.createCoin(record))
      .then(() => this.onDraftCreated(coinId, record))
      .catch((error) => this.onDraftCreateFailed(coinId, error));
  }

  /**
   * The create succeeded. The coin graduates: from here on it is an ordinary
   * server-backed record and every later edit takes the normal debounced,
   * minimal-diff PUT route.
   */
  private onDraftCreated(coinId: string, record: CoinRecord): void {
    // Seed the change tracker with EXACTLY what we POSTed, so the very next
    // edit diffs against what the server really holds. Do this before
    // clearing the draft flag so no edit can slip through in between.
    this.tracker.seedConfirmed(record);
    this.drafts.clear(coinId);
    this.logger.info(`Created coin ${coinId} in database`);

    const liveCoin = this.inventory().find(c => c.id === coinId);

    if (!liveCoin) {
      // The user deleted the row while the create was in flight. deleteCoin()
      // skipped the server call (the coin was still unsaved at the time), so
      // the row we just created would be orphaned — remove it now.
      this.deleteOrphanedCoin(coinId);
      return;
    }

    // The user may have kept typing while the POST was in flight. Those
    // keystrokes were painted on screen but deliberately not sent. Now that
    // the row exists, replay the difference through the normal edit path,
    // which produces a minimal PUT carrying only those fields.
    const drift: Record<string, unknown> = {};
    for (const key of Object.keys(record) as (keyof CoinRecord)[]) {
      if (!valuesEqual(liveCoin[key], record[key])) drift[key] = liveCoin[key];
    }
    if (Object.keys(drift).length > 0) {
      this.updateCoin(coinId, drift as Partial<CoinRecord>);
    }
  }

  /**
   * The create failed (server down, duplicate id, validation).
   *
   * The coin goes back to being a DRAFT. That is the important part: marking
   * it saved would mean the next edit PUTs to a row that does not exist and
   * the coin is lost forever. As a draft, the next qualifying edit simply
   * tries the POST again — and nothing was written to the change tracker, so
   * there is no phantom "confirmed" state to unwind.
   */
  private onDraftCreateFailed(coinId: string, error: unknown): void {
    const message = describeHttpError(error);
    this.logger.error(`Failed to create coin ${coinId} in database`, message);

    // The user deleted the row while the create was in flight. The failure no
    // longer matters to anyone — don't resurrect its draft state and don't
    // nag about a row that is gone.
    if (!this.inventory().some(c => c.id === coinId)) return;

    this.drafts.markDraft(coinId);

    // One toast per coin until it saves successfully.
    if (!this.drafts.shouldNotifyCreateFailure(coinId)) return;

    this.notificationService.showError(
      `Could not save ${this.describeCoin(coinId)} to the database — ${message}. ` +
      `The row is still on screen but is NOT saved; edit it again to retry.`
    );
  }

  /** Best-effort cleanup for a row created after the user had deleted it. */
  private deleteOrphanedCoin(coinId: string): void {
    firstValueFrom(this.apiService.deleteCoin(coinId))
      .then(() => this.logger.info(`Removed coin ${coinId}: deleted while its create was in flight`))
      .catch((error) => this.logger.error(
        `Failed to remove coin ${coinId} that was deleted while its create was in flight`,
        describeHttpError(error)
      ));
  }

  /* =========================================================================
   * Shared internals
   * ======================================================================= */

  /**
   * Write the proposed values into the on-screen list and return the coin as
   * it now looks.
   *
   * Only touches the signal if something visible actually changes, so we
   * don't trigger needless re-renders.
   */
  private paintOptimistically(
    coinId: string,
    liveCoin: CoinRecord,
    proposed: Partial<CoinRecord>
  ): CoinRecord {
    const displayChanges: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(proposed)) {
      if (!valuesEqual(liveCoin[key as keyof CoinRecord], value)) {
        displayChanges[key] = value;
      }
    }

    if (Object.keys(displayChanges).length === 0) return liveCoin;

    const painted = { ...liveCoin, ...displayChanges } as CoinRecord;
    this.inventory.set(this.inventory().map(c => c.id === coinId ? painted : c));
    return painted;
  }

  /**
   * Fire the debounced PUT for a coin, using the current value of every
   * dirty field. Called by the debounce timer.
   */
  private flushCoinUpdate(coinId: string): void {
    const payload = this.tracker.buildDirtyPayload(coinId);
    if (Object.keys(payload).length === 0) return;

    this.sendCoinUpdate(coinId, payload);
  }

  /** Send a partial-update PUT and wire up the success/failure bookkeeping. */
  private sendCoinUpdate(coinId: string, payload: Partial<CoinRecord>): void {
    firstValueFrom(this.apiService.updateCoin(coinId, payload))
      .then(() => this.onCoinUpdateSaved(coinId, payload))
      .catch((error) => this.onCoinUpdateFailed(coinId, error));
  }

  /** The server accepted the change: promote it into the confirmed snapshot. */
  private onCoinUpdateSaved(coinId: string, payload: Partial<CoinRecord>): void {
    this.tracker.markSaved(coinId, payload);
    this.logger.info(`Updated coin ${coinId} in database (${Object.keys(payload).join(', ')})`);
  }

  /**
   * The server rejected (or never received) the change.
   *
   * We deliberately do NOT clear the dirty flags and do NOT roll the screen
   * back — the user keeps seeing what they typed, and because the confirmed
   * snapshot still holds the old value, the very next edit (even re-entering
   * the identical value) will produce a fresh request.
   */
  private onCoinUpdateFailed(coinId: string, error: unknown): void {
    const message = describeHttpError(error);
    this.logger.error(`Failed to update coin ${coinId} in database`, message);

    // One toast per coin until it saves successfully again — otherwise every
    // keystroke during an outage would stack up another sticky error.
    if (!this.tracker.shouldNotifySaveFailure(coinId)) return;

    this.notificationService.showError(
      `Could not save changes to ${this.describeCoin(coinId)} — ${message}. ` +
      `Your edit is still on screen but is NOT saved; edit the field again to retry.`
    );
  }

  /** Short human label for a coin, used in error messages. */
  private describeCoin(coinId: string): string {
    const coin = this.inventory().find(c => c.id === coinId);
    if (!coin) return `coin ${coinId}`;
    const label = [coin.year, coin.coinType, coin.denomination].filter(Boolean).join(' ').trim();
    return label ? `"${label}"` : `coin ${coinId}`;
  }
}
