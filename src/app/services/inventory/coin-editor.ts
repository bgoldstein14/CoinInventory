import { WritableSignal } from '@angular/core';
import { CoinRecord } from '../../types/coin.model';
import { ApiService, describeHttpError } from '../api.service';
import { LoggingService } from '../logging.service';
import { NotificationService } from '../notification.service';
import { coinPhotoCount } from '../coin-photos';
import { CoinChangeTracker, valuesEqual } from './coin-change-tracker';
import { CoinDraftRegistry } from './coin-draft-registry';
import { coinThumbnailRevisions, writeTouchesImages } from './coin-thumbnail-revision';
import { imageSourcePaths } from '../image-source-paths';
import { firstValueFrom } from 'rxjs';

 /*
  * The "user edited a field" path:
  *   0. if the coin has never reached the database, don't PUT: repaint, and POST
  *      the whole record once it qualifies (see coin-draft-registry.ts);
  *   1. paint the new value immediately (optimistic update);
  *   2. work out which fields are unsaved (CoinChangeTracker);
  *   3. wait one second for more typing (debounce);
  *   4. PUT only the changed fields;
  *   5. record success or report failure.
  * Owns no state: the coin list is InventoryService's signal, and save
  * bookkeeping lives in CoinChangeTracker and CoinDraftRegistry.
  */

/** Delay after the last keystroke before writing to the server. */
const SAVE_DEBOUNCE_MS = 1000;

export class CoinEditor {
  constructor(
    /** The on-screen coin list (shared with InventoryService). */
    private readonly inventory: WritableSignal<CoinRecord[]>,
    private readonly tracker: CoinChangeTracker,
    /** Which coins have never reached the database. */
    private readonly drafts: CoinDraftRegistry,
    private readonly apiService: ApiService,
    private readonly logger: LoggingService,
    private readonly notificationService: NotificationService
  ) {}

  /**
   * Applies an edit: updates the screen at once and saves a second later.
   *
   *   - Coin exists on the server: debounced PUT of only the changed fields. The
   *     body is built from the dirty-field set, never the full record, so
   *     untouched fields can't be overwritten.
   *   - Coin is a local draft: no row to update; repaint, and once it qualifies
   *     POST the whole record once (a full body is correct only when creating).
   *
   * @param coinId id of the coin being edited
   * @param updates the changed field(s); keys set to `undefined` are ignored
   *                ("no opinion", not "clear")
   */
  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    // Drop `undefined` values.
    const proposed = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    ) as Partial<CoinRecord>;

    if (Object.keys(proposed).length === 0) return;

    const liveCoin = this.inventory().find(c => c.id === coinId);

    if (!liveCoin) {
      // Coin not in the local list (unusual): nothing to diff or repaint; forward as-is.
      this.sendCoinUpdate(coinId, proposed);
      return;
    }

    // 0. Draft route. Checked before touching CoinChangeTracker, which must only
    // hold server-confirmed state; a draft would seed a false baseline.
    if (this.drafts.isUnsaved(coinId)) {
      this.updateDraftCoin(coinId, liveCoin, proposed);
      return;
    }

    // Coins that exist in the database

    // Snapshot the confirmed state before the optimistic overwrite, or the snapshot
    // would capture the unsaved value.
    const confirmed = this.tracker.confirmedSnapshot(coinId);

    // 1. Optimistic UI update
    this.paintOptimistically(coinId, liveCoin, proposed);

    // 2. Dirty flags against the confirmed state: re-typing a value that failed to
    // save stays dirty and is sent again.
    const dirtyCount = this.tracker.recordEdit(coinId, proposed, confirmed);

    // 3. Nothing unsaved: cancel any queued write.
    if (dirtyCount === 0) {
      this.tracker.cancelPendingWrite(coinId);
      return;
    }

    // 4. Debounce the write by 1 second
    this.tracker.schedulePendingWrite(coinId, SAVE_DEBOUNCE_MS, () => this.flushCoinUpdate(coinId));
  }

  /**
   * Applies an edit and writes it now, resolving when the server accepts it.
   *
   * `updateCoin` debounces per coin, which suits typing but would fire every PUT
   * at once from a bulk loop. This does the same minimal-diff write without the
   * timer, so a caller can await each coin in turn.
   *
   * It does not cancel a debounced write already queued by the user's typing
   * (cancelling would lose what they typed). When that timer fires, these fields
   * are no longer dirty, so at worst identical values are resent: a duplicate,
   * never a loss.
   *
   * No toast on failure (a bulk caller would get one per coin); it rejects so the
   * caller can summarise. Dirty flags are left as the debounced path leaves them.
   *
   * @param coinId id of the coin to update
   * @param updates fields to write; `undefined` keys ignored, and only fields
   *                differing from the confirmed state are sent
   * @returns the payload sent (empty when nothing to do)
   * @throws when the coin is a local draft (no server row), or the PUT fails
   */
  async updateCoinNow(coinId: string, updates: Partial<CoinRecord>): Promise<Partial<CoinRecord>> {
    const proposed = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    ) as Partial<CoinRecord>;

    if (Object.keys(proposed).length === 0) return {};

    const liveCoin = this.inventory().find(c => c.id === coinId);
    if (!liveCoin) {
      throw new Error(`Coin ${coinId} is not in the inventory`);
    }

    // A draft has no row to PUT to (it would 404); callers should filter drafts out.
    if (this.drafts.isUnsaved(coinId)) {
      throw new Error(`Coin ${coinId} has not been saved to the database yet`);
    }

    // Snapshot the confirmed state before repainting, as in the debounced path.
    const confirmed = this.tracker.confirmedSnapshot(coinId);
    this.paintOptimistically(coinId, liveCoin, proposed);
    this.tracker.recordEdit(coinId, proposed, confirmed);

    // Built from `proposed`, not the dirty set, which may include fields the user is
    // still typing.
    const payload: Record<string, unknown> = {};
    for (const key of Object.keys(proposed) as (keyof CoinRecord)[]) {
      // Skip what the server already holds.
      if (confirmed && valuesEqual(confirmed[key], proposed[key])) continue;
      payload[key] = proposed[key];
    }
    if (Object.keys(payload).length === 0) return {};

    const body = payload as Partial<CoinRecord>;

    try {
      await firstValueFrom(this.apiService.updateCoin(coinId, this.withSourcePaths(body)));
    } catch (error) {
      // Log each failure, then rethrow rather than toast; dirty flags stay.
      this.logger.error(`Failed to update coin ${coinId} in database`, describeHttpError(error));
      throw error instanceof Error ? error : new Error(describeHttpError(error));
    }

    this.onCoinUpdateSaved(coinId, body);
    return body;
  }

  /* Draft coins: the first save */

  /**
   * Handles an edit to a coin that has never reached the database. The screen
   * always updates; what is sent depends on the draft state:
   *
   *   'creating'  a POST is in flight: send nothing (a second POST would
   *               duplicate the coin). `onDraftCreated` reconciles later edits.
   *   'draft', short of 2-of-3
   *               send nothing and cancel any queued create.
   *   'draft', meeting 2-of-3
   *               queue the create, debounced 1s like the normal save.
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
   * The debounce fired on a qualifying draft: create it. Everything is re-checked
   * because a second of typing (or a delete) may have happened.
   *
   * Don't run the alloy/weight inference here (services/pm-autofill.ts). This runs
   * once, so a later key-field change would leave a stale inferred value; and it
   * fires from a timer, possibly while the user is typing (see
   * components/coin-editor-form/custom-option-mode.ts). pm-autofill runs on each
   * committed `change` event and has already run by the time a draft qualifies.
   */
  private createDraftCoin(coinId: string): void {
    const liveCoin = this.inventory().find(c => c.id === coinId);
    if (!liveCoin) {
      // Deleted while the timer was pending; nothing was sent.
      this.drafts.clear(coinId);
      return;
    }

    // No longer a draft (created, or a create is in flight).
    if (this.drafts.stateOf(coinId) !== 'draft') return;

    // The last keystroke may have emptied a field.
    if (!this.drafts.qualifiesForSave(liveCoin)) return;

    // Snapshot exactly what is sent; this seeds the change tracker on success.
    const record: CoinRecord = { ...liveCoin };

    this.drafts.markCreating(coinId);

    // Keeps known original-file paths on the images, as the update path does.
    firstValueFrom(this.apiService.createCoin(this.withSourcePaths(record)))
      .then(() => this.onDraftCreated(coinId, record))
      .catch((error) => this.onDraftCreateFailed(coinId, error));
  }

  /**
   * The create succeeded: from now on the coin takes the normal debounced,
   * minimal-diff PUT route.
   */
  private onDraftCreated(coinId: string, record: CoinRecord): void {
    // Seed the tracker with exactly what was POSTed, before clearing the draft flag,
    // so the next edit diffs against what the server holds.
    this.tracker.seedConfirmed(record);
    this.drafts.clear(coinId);

    // The row only renders an <img> once server-backed; the bump avoids a cached 404
    // from the draft period leaving a broken thumbnail.
    if (coinPhotoCount(record) > 0) coinThumbnailRevisions.bump(coinId);

    this.logger.info(`Created coin ${coinId} in database`);

    const liveCoin = this.inventory().find(c => c.id === coinId);

    if (!liveCoin) {
      // Deleted while the create was in flight (deleteCoin skipped the server), so
      // remove the newly created row.
      this.deleteOrphanedCoin(coinId);
      return;
    }

    // Edits typed while the POST was in flight were painted but not sent; replay
    // the difference through the normal path as a minimal PUT.
    const drift: Record<string, unknown> = {};
    for (const key of Object.keys(record) as (keyof CoinRecord)[]) {
      if (!valuesEqual(liveCoin[key], record[key])) drift[key] = liveCoin[key];
    }
    if (Object.keys(drift).length > 0) {
      this.updateCoin(coinId, drift as Partial<CoinRecord>);
    }
  }

  /**
   * The create failed (server down, duplicate id, validation). The coin goes back
   * to being a draft, so the next qualifying edit retries the POST. Marking it
   * saved would make later edits PUT to a row that doesn't exist.
   */
  private onDraftCreateFailed(coinId: string, error: unknown): void {
    const message = describeHttpError(error);
    this.logger.error(`Failed to create coin ${coinId} in database`, message);

    // Deleted while the create was in flight: nothing to restore or report.
    if (!this.inventory().some(c => c.id === coinId)) return;

    // Record the reason before returning to 'draft': the row's chip keeps showing
    // why it isn't saved after the toast is gone, and the state change re-renders it.
    this.drafts.recordCreateFailure(coinId, message);
    this.drafts.markDraft(coinId);

    // One toast per coin until it saves.
    if (!this.drafts.shouldNotifyCreateFailure(coinId)) return;

    this.notificationService.showError(
      `Could not save ${this.describeCoin(coinId)} to the database — ${message}. ` +
      `The row is still on screen but is NOT saved; edit it again to retry.`
    );
  }

  /** Best-effort cleanup for a row created after the user deleted it. */
  private deleteOrphanedCoin(coinId: string): void {
    firstValueFrom(this.apiService.deleteCoin(coinId))
      .then(() => this.logger.info(`Removed coin ${coinId}: deleted while its create was in flight`))
      .catch((error) => this.logger.error(
        `Failed to remove coin ${coinId} that was deleted while its create was in flight`,
        describeHttpError(error)
      ));
  }

  /* Shared internals */

  /**
   * Writes the proposed values into the on-screen list and returns the coin as it
   * now looks; only updates the signal if something visibly changes.
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

  /** Sends the debounced PUT with the current value of every dirty field. */
  private flushCoinUpdate(coinId: string): void {
    const payload = this.tracker.buildDirtyPayload(coinId);
    if (Object.keys(payload).length === 0) return;

    this.sendCoinUpdate(coinId, payload);
  }

  /** Sends a partial-update PUT with success/failure bookkeeping. */
  private sendCoinUpdate(coinId: string, payload: Partial<CoinRecord>): void {
    firstValueFrom(this.apiService.updateCoin(coinId, this.withSourcePaths(payload)))
      .then(() => this.onCoinUpdateSaved(coinId, payload))
      .catch((error) => this.onCoinUpdateFailed(coinId, error));
  }

  /**
   * Attaches known original-file paths to an outgoing `imagePaths` array.
   *
   * `PUT /api/coins/:id` replaces the coin's image set; each entry can be a bare
   * base64 string (stores `SourcePath NULL`) or `{ imageData, sourcePath }` (see
   * server/routes/coins/image-payload.ts). The app keeps plain strings (bound to
   * `<img [src]>`), so this converts them in the one place all writes pass through.
   * Only `imagePaths` is touched; the set of fields sent is unchanged. With no
   * known paths the payload is returned untouched.
   */
  private withSourcePaths(payload: Partial<CoinRecord>): Partial<CoinRecord> {
    const imagePaths = payload.imagePaths;
    if (!Array.isArray(imagePaths) || imagePaths.length === 0) return payload;
    if (!imageSourcePaths.hasAnyPathFor(imagePaths)) return payload;

    // `CoinRecord.imagePaths` is `string[]` in the app; the wire format is wider.
    return {
      ...payload,
      imagePaths: imageSourcePaths.enrich(imagePaths) as unknown as string[]
    };
  }

  /** The server accepted the change: promote it into the confirmed snapshot. */
  private onCoinUpdateSaved(coinId: string, payload: Partial<CoinRecord>): void {
    this.tracker.markSaved(coinId, payload);

    // Change the thumbnail URL only now, when the server has the new photos;
    // bumping at paint time would request it too early (see coin-thumbnail-revision.ts).
    if (writeTouchesImages(payload)) coinThumbnailRevisions.bump(coinId);

    this.logger.info(`Updated coin ${coinId} in database (${Object.keys(payload).join(', ')})`);
  }

  /**
   * The server rejected (or never got) the change. Dirty flags stay and the screen
   * isn't rolled back; since the confirmed snapshot still holds the old value, the
   * next edit (even re-entering the same value) sends a fresh request.
   */
  private onCoinUpdateFailed(coinId: string, error: unknown): void {
    const message = describeHttpError(error);
    this.logger.error(`Failed to update coin ${coinId} in database`, message);

    // One toast per coin until it saves again, so an outage doesn't stack errors.
    if (!this.tracker.shouldNotifySaveFailure(coinId)) return;

    this.notificationService.showError(
      `Could not save changes to ${this.describeCoin(coinId)} — ${message}. ` +
      `Your edit is still on screen but is NOT saved; edit the field again to retry.`
    );
  }

  /** Short label for a coin, used in error messages. */
  private describeCoin(coinId: string): string {
    const coin = this.inventory().find(c => c.id === coinId);
    if (!coin) return `coin ${coinId}`;
    const label = [coin.year, coin.coinType, coin.denomination].filter(Boolean).join(' ').trim();
    return label ? `"${label}"` : `coin ${coinId}`;
  }
}
