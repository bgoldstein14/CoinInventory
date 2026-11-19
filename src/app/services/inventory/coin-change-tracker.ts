import { CoinRecord } from '../../types/coin.model';

 /*
  * Bookkeeping for "what has the user changed, and what has the server
  * accepted?". No HTTP or signals.
  *
  * The UI updates optimistically, so each coin has two versions:
  *   - `inventory()`     what the user sees (may be unsaved)
  *   - `confirmedCoins`  what the server has acknowledged
  * Edits are diffed against the confirmed version, never the on-screen one.
  * Diffing against the screen would make a retry after a failed save produce an
  * empty diff, silently losing the edit.
  */

/**
 * Compares two field values; arrays (imagePaths) by content. Exported because
 * the editor uses the same rule to decide whether to repaint.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

export class CoinChangeTracker {
  /**
   * @param findCoin looks up the current on-screen version of a coin; the
   *                 tracker reads the inventory but never owns it
   */
  constructor(private readonly findCoin: (coinId: string) => CoinRecord | undefined) {}

  /** Last server-confirmed state for each coin, by id. */
  private readonly confirmedCoins = new Map<string, CoinRecord>();

  /**
   * Per coin, the fields whose on-screen value isn't saved yet. A failed PUT
   * leaves them in place, so a retry re-sends.
   */
  private readonly dirtyCoinFields = new Map<string, Set<keyof CoinRecord>>();

  /** Coins already shown a save-failure toast (one per coin); cleared on success. */
  private readonly notifiedSaveFailures = new Set<string>();

  /** Debounce timers, so rapid typing produces one request. */
  private readonly pendingCoinUpdates = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

  /* Confirmed (server-acknowledged) state */

  /**
   * The server-confirmed state for a coin, seeded from the current local record
   * the first time (an unedited coin is in sync with the server).
   */
  confirmedSnapshot(coinId: string): CoinRecord | undefined {
    const existing = this.confirmedCoins.get(coinId);
    if (existing) return existing;

    const liveCoin = this.findCoin(coinId);
    if (!liveCoin) return undefined;

    const snapshot: CoinRecord = { ...liveCoin };
    this.confirmedCoins.set(coinId, snapshot);
    return snapshot;
  }

  /** Records a coin whose full record was just POSTed as its confirmed baseline. */
  seedConfirmed(coin: CoinRecord): void {
    this.confirmedCoins.set(coin.id, { ...coin });
  }

  /* Dirty fields */

  /**
   * Folds one edit into the coin's dirty set. A field is dirty when it differs
   * from what the server last acknowledged, so re-typing a value that failed to
   * save stays dirty and is sent again.
   *
   * @returns how many fields are still unsaved for this coin
   */
  recordEdit(
    coinId: string,
    proposed: Partial<CoinRecord>,
    confirmed: CoinRecord | undefined
  ): number {
    const dirty = this.dirtyCoinFields.get(coinId) ?? new Set<keyof CoinRecord>();

    for (const key of Object.keys(proposed) as (keyof CoinRecord)[]) {
      const alreadySaved = confirmed ? valuesEqual(confirmed[key], proposed[key]) : false;
      if (alreadySaved) {
        dirty.delete(key);
      } else {
        dirty.add(key);
      }
    }

    if (dirty.size === 0) {
      this.dirtyCoinFields.delete(coinId);
      return 0;
    }

    this.dirtyCoinFields.set(coinId, dirty);
    return dirty.size;
  }

  /**
   * The minimal PUT body: one entry per dirty field, from the current on-screen
   * value. Never built from the full record, which would overwrite untouched fields.
   */
  buildDirtyPayload(coinId: string): Partial<CoinRecord> {
    const dirty = this.dirtyCoinFields.get(coinId);
    const liveCoin = this.findCoin(coinId);
    if (!dirty || dirty.size === 0 || !liveCoin) return {};

    const payload: Record<string, unknown> = {};
    for (const field of dirty) {
      payload[field] = liveCoin[field];
    }
    return payload as Partial<CoinRecord>;
  }

  /** The server accepted these fields: merge them into the confirmed snapshot and clear their flags. */
  markSaved(coinId: string, payload: Partial<CoinRecord>): void {
    const confirmed = this.confirmedCoins.get(coinId);
    if (confirmed) {
      // Merge only the fields sent.
      this.confirmedCoins.set(coinId, { ...confirmed, ...payload });
    }

    const dirty = this.dirtyCoinFields.get(coinId);
    const liveCoin = this.findCoin(coinId);
    if (dirty) {
      for (const field of Object.keys(payload) as (keyof CoinRecord)[]) {
        // The user may have typed again during the request; clear the flag only if the
        // on-screen value still matches what was saved.
        if (!liveCoin || valuesEqual(liveCoin[field], payload[field])) {
          dirty.delete(field);
        }
      }
      if (dirty.size === 0) this.dirtyCoinFields.delete(coinId);
    }

    this.notifiedSaveFailures.delete(coinId);
  }

  /* Failure-toast de-duplication */

  /**
   * True the first time a coin's save fails, then false until it saves again, so
   * an outage doesn't stack an error per keystroke.
   */
  shouldNotifySaveFailure(coinId: string): boolean {
    if (this.notifiedSaveFailures.has(coinId)) return false;
    this.notifiedSaveFailures.add(coinId);
    return true;
  }

  /* Debounce timers */

  /**
   * Queues a write `delayMs` from now, replacing any queued write for the coin.
   * The entry is removed before `run` fires.
   */
  schedulePendingWrite(coinId: string, delayMs: number, run: () => void): void {
    this.cancelPendingWrite(coinId);

    const timer = setTimeout(() => {
      this.pendingCoinUpdates.delete(coinId);
      run();
    }, delayMs);

    this.pendingCoinUpdates.set(coinId, { timer });
  }

  /** Drops a queued write without sending it (when an edit is reverted). */
  cancelPendingWrite(coinId: string): void {
    const queued = this.pendingCoinUpdates.get(coinId);
    if (queued) {
      clearTimeout(queued.timer);
      this.pendingCoinUpdates.delete(coinId);
    }
  }

  /* Lifecycle */

  /** Forgets a coin's save state. */
  clear(coinId: string): void {
    this.cancelPendingWrite(coinId);
    this.confirmedCoins.delete(coinId);
    this.dirtyCoinFields.delete(coinId);
    this.notifiedSaveFailures.delete(coinId);
  }

  /** Re-baselines all tracking after a fresh load from the server. */
  reset(coins: CoinRecord[]): void {
    for (const { timer } of this.pendingCoinUpdates.values()) clearTimeout(timer);
    this.pendingCoinUpdates.clear();
    this.confirmedCoins.clear();
    this.dirtyCoinFields.clear();
    this.notifiedSaveFailures.clear();

    for (const coin of coins) {
      this.confirmedCoins.set(coin.id, { ...coin });
    }
  }
}
