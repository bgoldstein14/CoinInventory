import { CoinRecord } from '../../types/coin.model';

/* ===========================================================================
 * CoinChangeTracker
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   All the bookkeeping that answers "what has the user changed, and what has
 *   the server actually accepted?". It holds no HTTP code and no Angular
 *   signals — it is a plain object you can reason about (and test) on its own.
 *
 * WHY IT IS ITS OWN FILE
 *   This machinery exists because of a bug that was painful to find (see the
 *   comment block below). Keeping it apart from the HTTP calls and the UI
 *   signals makes the rule it enforces impossible to miss: we diff against
 *   what the SERVER confirmed, never against what the SCREEN shows.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE MAPS? The UI updates "optimistically": the moment you type, the
 * on-screen value changes, and only a second later do we PUT it to the
 * server. That means there are TWO versions of every coin:
 *
 *   * `inventory()`      — what the user SEES (optimistic, may be unsaved)
 *   * `confirmedCoins`   — what the SERVER has actually acknowledged
 *
 * The old code diffed new edits against the optimistic version. That looked
 * fine until a save failed: the optimistic copy already held the new value,
 * so re-typing the same value produced an empty diff and NOTHING was ever
 * re-sent — the edit was silently lost forever. Diffing against the
 * server-confirmed copy instead makes a retry actually retry.
 * =========================================================================== */

/**
 * Compare two field values. Arrays (imagePaths, tags) are compared by
 * content rather than by reference, since a new array with the same items
 * is not a real change.
 *
 * Exported because the editor needs the identical rule when deciding whether
 * an edit is even worth repainting on screen.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  }
  return a === b;
}

export class CoinChangeTracker {
  /**
   * @param findCoin - how to look up the CURRENT on-screen version of a coin.
   *                   The tracker never owns the inventory; it only borrows a
   *                   way to read it, so there is exactly one source of truth.
   */
  constructor(private readonly findCoin: (coinId: string) => CoinRecord | undefined) {}

  /** Last state the SERVER confirmed for each coin, keyed by coin id. */
  private readonly confirmedCoins = new Map<string, CoinRecord>();

  /**
   * Per coin, the set of field names whose on-screen value has NOT yet been
   * saved to the server. This is the "dirty flag". A failed PUT leaves these
   * entries in place, which is what makes a retry re-send.
   */
  private readonly dirtyCoinFields = new Map<string, Set<keyof CoinRecord>>();

  /**
   * Coins we have already shown a save-failure toast for. Prevents spamming
   * the user with one identical error per keystroke. Cleared on success.
   */
  private readonly notifiedSaveFailures = new Set<string>();

  /** Debounce timers, so rapid typing produces one request instead of ten. */
  private readonly pendingCoinUpdates = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

  /* =========================================================================
   * CONFIRMED (server-acknowledged) STATE
   * ======================================================================= */

  /**
   * Remember the server-confirmed state for a coin, seeding it from the
   * current local record the first time we see it (which is correct, because
   * a coin we've never edited is by definition in sync with the server).
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

  /**
   * Record a coin whose full record we just POSTed. Once it lands, the
   * server's copy matches this object exactly — that becomes our confirmed
   * baseline for diffing.
   */
  seedConfirmed(coin: CoinRecord): void {
    this.confirmedCoins.set(coin.id, { ...coin });
  }

  /* =========================================================================
   * DIRTY FIELDS
   * ======================================================================= */

  /**
   * Fold one edit into the dirty-field set for a coin.
   *
   * A field is dirty when the new value differs from what the server last
   * acknowledged. Re-typing a value that failed to save therefore stays
   * dirty and WILL be sent again.
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
   * Build the minimal PUT body: one entry per dirty field, read from the
   * coin's current on-screen value.
   *
   * THIS IS THE PAYLOAD RULE. An earlier refactor sent whole records and wiped
   * out data the user had not touched. The body is built from the dirty-field
   * set and from nothing else — never from the full record.
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

  /**
   * The server accepted these fields: promote them into the confirmed
   * snapshot and drop their dirty flags.
   */
  markSaved(coinId: string, payload: Partial<CoinRecord>): void {
    const confirmed = this.confirmedCoins.get(coinId);
    if (confirmed) {
      // Merge ONLY the fields we sent — never the whole record.
      this.confirmedCoins.set(coinId, { ...confirmed, ...payload });
    }

    const dirty = this.dirtyCoinFields.get(coinId);
    const liveCoin = this.findCoin(coinId);
    if (dirty) {
      for (const field of Object.keys(payload) as (keyof CoinRecord)[]) {
        // The user may have typed again while the request was in flight. Only
        // clear the flag if the on-screen value still matches what we saved.
        if (!liveCoin || valuesEqual(liveCoin[field], payload[field])) {
          dirty.delete(field);
        }
      }
      if (dirty.size === 0) this.dirtyCoinFields.delete(coinId);
    }

    this.notifiedSaveFailures.delete(coinId);
  }

  /* =========================================================================
   * FAILURE-TOAST DE-DUPLICATION
   * ======================================================================= */

  /**
   * True the FIRST time a coin's save fails, false for every failure after
   * that until it saves successfully again — otherwise every keystroke during
   * an outage would stack up another sticky error.
   */
  shouldNotifySaveFailure(coinId: string): boolean {
    if (this.notifiedSaveFailures.has(coinId)) return false;
    this.notifiedSaveFailures.add(coinId);
    return true;
  }

  /* =========================================================================
   * DEBOUNCE TIMERS
   * ======================================================================= */

  /**
   * Queue a write for `delayMs` from now, replacing any write already queued
   * for this coin. The timer entry is removed before `run` fires, so the
   * callback always sees an empty queue for that coin.
   */
  schedulePendingWrite(coinId: string, delayMs: number, run: () => void): void {
    this.cancelPendingWrite(coinId);

    const timer = setTimeout(() => {
      this.pendingCoinUpdates.delete(coinId);
      run();
    }, delayMs);

    this.pendingCoinUpdates.set(coinId, { timer });
  }

  /** Drop a queued write without sending it (used when an edit is reverted). */
  cancelPendingWrite(coinId: string): void {
    const queued = this.pendingCoinUpdates.get(coinId);
    if (queued) {
      clearTimeout(queued.timer);
      this.pendingCoinUpdates.delete(coinId);
    }
  }

  /* =========================================================================
   * LIFECYCLE
   * ======================================================================= */

  /** Forget everything we knew about a coin's save state. */
  clear(coinId: string): void {
    this.cancelPendingWrite(coinId);
    this.confirmedCoins.delete(coinId);
    this.dirtyCoinFields.delete(coinId);
    this.notifiedSaveFailures.delete(coinId);
  }

  /** Re-baseline all change tracking after a fresh load from the server. */
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
