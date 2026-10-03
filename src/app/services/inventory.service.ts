import { Injectable, computed, signal, inject } from '@angular/core';
import {
  CoinRecord,
  SpotPrices,
  SpotPriceMeta,
  TransactionRecord,
  Denomination,
  MintMarkOption
} from '../types/coin.model';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { CoinChangeTracker } from './inventory/coin-change-tracker';
import { CoinDraftRegistry } from './inventory/coin-draft-registry';
import { CoinEditor } from './inventory/coin-editor';
import { CoinCollection } from './inventory/coin-collection';
import { LookupManager } from './inventory/lookup-manager';
import { TransactionManager } from './inventory/transaction-manager';
import { ConnectionManager } from './inventory/connection-manager';
// The one-time "fill in the missing precious-metal data" maintenance pass.
// The inference itself is shared with the Quicken import — see pm-fill.ts.
import {
  PmBackfillOutcome,
  PmBackfillPlan,
  PmBackfillProgress,
  planPmBackfill,
  runPmBackfill
} from './pm-backfill';
import {
  computeMeltValue,
  describeMeltValue,
  distinctCategories,
  distinctCountries,
  distinctSources,
  hasAnySpotPrice,
  sumCurrentValue,
  sumProfit,
  sumPurchasePrice
} from './inventory/inventory-metrics';
import { firstValueFrom } from 'rxjs';

const defaultSpotPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };

/* ===========================================================================
 * InventoryService
 * ---------------------------------------------------------------------------
 * The single front door to the coin collection. Components talk to THIS
 * service and nothing else. It owns the signals everybody reads, and hands
 * the real work to focused helpers in ./inventory/:
 *
 *   coin-change-tracker.ts  what the server has confirmed vs. what is unsaved
 *   coin-draft-registry.ts  which coins have never reached the database yet
 *   coin-editor.ts          field edits: optimistic paint, debounce, minimal PUT
 *   coin-collection.ts      add / import / delete whole coins, and selection
 *   lookup-manager.ts       categories, coin sets, denominations, mint marks
 *   transaction-manager.ts  the buy/sell history rows
 *   connection-manager.ts   start-up loading and the connection banner
 *   coin-factory.ts         building a blank / imported CoinRecord
 *   inventory-metrics.ts    totals, distinct lists, melt value (all pure)
 *
 * Two rules worth knowing before you change anything here:
 *
 *  1. The helpers are ordinary classes created with `new`, NOT Angular
 *     services. That is deliberate: this service must stay constructible from
 *     a plain injection context that provides only ApiService, LoggingService
 *     and NotificationService (which is exactly how the tests build it).
 *
 *  2. The signals below are created here and PASSED IN to the helpers, so
 *     there is exactly one copy of every piece of state no matter who writes
 *     to it.
 * =========================================================================== */

@Injectable({ providedIn: 'root' })
export class InventoryService {
  // ==========================================================================
  // State — every signal below is public API; components read these directly.
  // ==========================================================================
  readonly inventory = signal<CoinRecord[]>([]);
  readonly selectedCoinId = signal<string | null>(null);
  readonly categoryOptions = signal<string[]>([]);
  readonly coinSets = signal<string[]>([]);
  readonly transactions = signal<TransactionRecord[]>([]);
  readonly spotPrices = signal<SpotPrices>({ ...defaultSpotPrices });

  /**
   * Provenance of the last SAVED set of prices. Filled in at start-up from
   * the database (see ConnectionManager.hydrate) and again after every
   * successful save. All-null means the SpotPrices table has never had a row.
   */
  readonly spotPriceMeta = signal<SpotPriceMeta>({ source: null, fetchedAt: null, prices: null });

  readonly connecting = signal(false);
  readonly connected = signal(false);
  readonly connectionError = signal<string | null>(null);

  readonly denominations = signal<Denomination[]>([]);
  readonly mintMarks = signal<MintMarkOption[]>([]);
  readonly metalContents = signal<string[]>([]);

  // ==========================================================================
  // Derived values — the calculations live in inventory-metrics.ts.
  // ==========================================================================
  readonly selectedCoin = computed(() =>
    this.inventory().find(c => c.id === this.selectedCoinId()) ?? null
  );

  readonly totalCost = computed(() => sumPurchasePrice(this.inventory()));

  readonly totalValue = computed(() => sumCurrentValue(this.inventory()));

  readonly totalProfit = computed(() => sumProfit(this.inventory()));

  readonly inventoryCategories = computed(() => distinctCategories(this.inventory()));

  readonly inventoryCountries = computed(() => distinctCountries(this.inventory()));

  readonly inventorySources = computed(() => distinctSources(this.inventory()));

  // NOTE: an `inventoryDealers` computed sat here. It was removed with the
  // coin-level dealer field. Nothing ever read it: the dealer filter was a
  // free-text input, not a dropdown fed from this list.

  /**
   * True once we have at least one non-zero spot price in memory.
   *
   * The UI uses this to tell two very different "—" cells apart: a coin with
   * no precious metal (nothing to be done) versus the whole price table being
   * empty (one press of Fetch away from every melt figure appearing).
   */
  readonly hasSpotPrices = computed(() => hasAnySpotPrice(this.spotPrices()));

  readonly selectedCoinTransactions = computed(() => {
    const coinId = this.selectedCoinId();
    if (!coinId) return [];
    return this.transactions().filter(t => t.coinId === coinId);
  });

  private readonly apiService = inject(ApiService);
  private readonly logger = inject(LoggingService);
  private readonly notificationService = inject(NotificationService);

  // ==========================================================================
  // The helpers. Declared last, and in dependency order, because a class field
  // can only use fields that are already declared above it.
  // ==========================================================================

  /** Tracks confirmed-vs-unsaved state for every coin. See its file header. */
  private readonly changeTracker = new CoinChangeTracker(
    (coinId) => this.inventory().find(c => c.id === coinId)
  );

  /**
   * Which coins are still local-only drafts (added but not yet good enough
   * to save). See its file header for the state machine.
   */
  private readonly drafts = new CoinDraftRegistry();

  private readonly lookups = new LookupManager(
    this.categoryOptions,
    this.coinSets,
    this.denominations,
    this.mintMarks,
    this.apiService,
    this.logger,
    this.notificationService
  );

  private readonly txns = new TransactionManager(
    this.transactions,
    this.apiService,
    this.logger,
    this.notificationService
  );

  private readonly coins = new CoinCollection(
    this.inventory,
    this.selectedCoinId,
    this.txns,
    this.changeTracker,
    this.drafts,
    this.lookups,
    this.apiService,
    this.logger,
    this.notificationService
  );

  private readonly editor = new CoinEditor(
    this.inventory,
    this.changeTracker,
    this.drafts,
    this.apiService,
    this.logger,
    this.notificationService
  );

  private readonly connection = new ConnectionManager({
    connecting: this.connecting,
    connected: this.connected,
    connectionError: this.connectionError,
    categoryOptions: this.categoryOptions,
    coinSets: this.coinSets,
    transactions: this.transactions,
    denominations: this.denominations,
    mintMarks: this.mintMarks,
    metalContents: this.metalContents,
    spotPrices: this.spotPrices,
    spotPriceMeta: this.spotPriceMeta,
    coins: this.coins,
    apiService: this.apiService,
    logger: this.logger,
    notificationService: this.notificationService
  });

  // ==========================================================================
  // Start-up / connection — see connection-manager.ts
  // ==========================================================================

  /**
   * Load everything from the backend: the coins (fatal if they fail) and then
   * the optional lookup tables (a failure there is only a warning).
   *
   * @throws Error only when the coin fetch itself fails
   */
  hydrate(): Promise<void> {
    return this.connection.hydrate();
  }

  /**
   * Try connecting again after a failure, without reloading the page.
   *
   * @returns true if the app is now connected, false otherwise
   */
  retryConnection(): Promise<boolean> {
    return this.connection.retryConnection();
  }

  // ==========================================================================
  // Coins — whole records go to CoinCollection, field edits go to CoinEditor
  // ==========================================================================

  selectCoin(coinId: string): void {
    this.coins.selectCoin(coinId);
  }

  ensureSelectedCoin(): void {
    this.coins.ensureSelectedCoin();
  }

  /**
   * Create an empty coin and select it.
   *
   * NOTHING is sent to the server: a new coin is a local draft until it has
   * at least 2 of Year / Coin Type / Denomination, at which point it saves
   * itself automatically. See `isDraftCoin()` below and
   * inventory/coin-draft-registry.ts.
   */
  addBlankCoin(): CoinRecord {
    return this.coins.addBlankCoin();
  }

  /**
   * True while a coin exists only on screen — it has never been written to
   * the database because it is not yet complete enough to be a coin.
   *
   * The inventory table uses this to show the "Unsaved" chip.
   */
  isDraftCoin(coinId: string): boolean {
    return this.drafts.isUnsaved(coinId);
  }

  /**
   * A short sentence telling the user what an unsaved row still needs, e.g.
   * "Not saved yet. Add 1 more of: Coin Type, Denomination."
   * Empty string for a coin that is already saved (or already qualifies).
   */
  draftHint(coin: CoinRecord): string {
    return this.drafts.describeWhatIsMissing(coin);
  }

  /** Append an imported batch of coins. */
  addCoins(coins: CoinRecord[]): void {
    this.coins.addCoins(coins);
  }

  /** Replace the whole inventory from an exported JSON string. */
  importInventoryData(json: string): void {
    this.coins.importInventoryData(json);
  }

  /** Remove a coin from the list, its transactions, and the database. */
  deleteCoin(coinId: string): void {
    this.coins.deleteCoin(coinId);
  }

  /**
   * Apply an edit to a coin: the screen updates immediately and only the
   * changed fields are PUT to the server a second later.
   *
   * @see CoinEditor — the optimistic-update, minimal-diff and failed-save
   *      retry rules all live there, and they are the most safety-critical
   *      code in the app.
   */
  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    this.editor.updateCoin(coinId, updates);
  }

  /**
   * Apply an edit and write it immediately, resolving once the server has
   * accepted it.
   *
   * FOR BULK MAINTENANCE PASSES ONLY — not for anything the user is typing
   * into. The debounce that `updateCoin` applies is per coin, so a loop over
   * several hundred coins would fire several hundred PUTs simultaneously one
   * second later. This variant has no timer, so a caller can await each write
   * in turn and know every coin was written exactly once.
   *
   * @see CoinEditor.updateCoinNow for the full reasoning, including why it
   *      deliberately does not cancel a pending debounced write.
   * @throws when the coin is an unsaved draft, or when the PUT fails
   */
  updateCoinNow(coinId: string, updates: Partial<CoinRecord>): Promise<Partial<CoinRecord>> {
    return this.editor.updateCoinNow(coinId, updates);
  }

  // ==========================================================================
  // Maintenance — the one-time precious-metal backfill
  // ==========================================================================

  /**
   * Work out which coins are missing alloy data that can be inferred, without
   * changing anything. See pm-backfill.ts for what each count means.
   *
   * Unsaved draft rows are excluded via `isDraftCoin`, because there is no
   * database row to update yet.
   */
  planPmBackfill(): PmBackfillPlan {
    return planPmBackfill(this.inventory(), (coinId) => this.drafts.isUnsaved(coinId));
  }

  /**
   * Write a plan produced by `planPmBackfill`, one coin at a time.
   *
   * Sequential and awaited on purpose — see `runPmBackfill`'s comment, and
   * `CoinEditor.updateCoinNow`, for why a `for` loop over the ordinary
   * debounced `updateCoin` would be the wrong tool.
   */
  async runPmBackfill(
    plan: PmBackfillPlan,
    onProgress?: (progress: PmBackfillProgress) => void
  ): Promise<PmBackfillOutcome> {
    const outcome = await runPmBackfill(
      plan,
      (coinId, updates) => this.updateCoinNow(coinId, updates).then(() => undefined),
      onProgress
    );

    this.logger.info(
      `PM backfill: filled ${outcome.filled} of ${outcome.attempted} coins ` +
      `(${outcome.fieldsWritten} fields written, ${outcome.failed} failed)`
    );

    return outcome;
  }

  // ==========================================================================
  // Transactions (buy / sell history attached to a coin)
  // ==========================================================================

  addTransaction(txn: TransactionRecord): void {
    this.txns.addTransaction(txn);
  }

  deleteTransaction(txnId: string): void {
    this.txns.deleteTransaction(txnId);
  }

  // ==========================================================================
  // Spot prices and melt value
  // ==========================================================================

  /**
   * Put new prices in memory. Every melt figure on screen re-calculates at
   * once, because they all read this signal.
   *
   * *** THIS DELIBERATELY DOES NOT SAVE ANYTHING. ***
   * POST /api/spot-prices is an INSERT into a price-history table, not an
   * update — one row per call, for ever. The spot price modal calls this from
   * `(ngModelChange)`, i.e. on EVERY KEYSTROKE: typing "2650" into the gold
   * box fires it four times. Saving from here would write four history rows
   * for one price, and a user who nudges the field with the arrow keys could
   * add dozens. So persistence lives in commitSpotPrices() below, which only
   * deliberate actions call.
   */
  updateSpotPrices(prices: SpotPrices): void {
    this.spotPrices.set(prices);
  }

  /**
   * Write the prices currently in memory to the database as a new history row.
   *
   * CALL THIS ONLY FROM A DELIBERATE USER ACTION. There are exactly two, both
   * in SpotPriceModalComponent:
   *   1. a successful "Fetch COMEX Prices" — the user asked for fresh prices
   *      and got them, so that is a moment worth recording; and
   *   2. closing the modal after hand-editing a price — one row for the whole
   *      editing session, written when the user is finished, not while they
   *      are still typing.
   * See updateSpotPrices() above for why the obvious place (the setter) is the
   * wrong place.
   *
   * Two guards stop pointless rows even so:
   *   - identical prices to the last row we saved -> skipped. Pressing Fetch
   *     twice in a minute, or opening and closing the modal after an
   *     accidental edit that was undone, should not grow the table.
   *   - all four prices zero -> skipped. That is the "we know nothing" state,
   *     and recording it would make the next start-up load zeros over the top
   *     of a perfectly good earlier row.
   *
   * Never throws, and never blocks the UI: a failed save is logged and
   * mentioned once, and the prices stay usable in memory for this session.
   *
   * @param source - provenance label stored with the row, e.g.
   *                 "COMEX/NYMEX futures via Yahoo Finance" or "Manual entry"
   * @returns true if a row was actually written
   */
  async commitSpotPrices(source: string): Promise<boolean> {
    const prices = { ...this.spotPrices() };
    const alreadySaved = this.spotPriceMeta().prices;

    if (alreadySaved && samePrices(alreadySaved, prices)) {
      this.logger.info('Spot prices unchanged since the last save — no new history row written');
      return false;
    }

    if (!hasAnySpotPrice(prices)) {
      this.logger.info('Spot prices are all zero — nothing worth saving');
      return false;
    }

    try {
      await firstValueFrom(this.apiService.saveSpotPrices({ ...prices, source }));
      this.spotPriceMeta.set({ source, fetchedAt: new Date().toISOString(), prices });
      this.logger.info(`Saved spot prices (${source}): Au=$${prices.gold} Ag=$${prices.silver}`);
      return true;
    } catch (error) {
      // Non-fatal on purpose. The prices are already in memory and every melt
      // value on screen is already correct; all that is lost is the ability to
      // reload them after a restart.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Failed to save spot prices', msg);
      this.notificationService.showWarning(
        'Spot prices could not be saved — they will work for now but will be lost when the app restarts.'
      );
      return false;
    }
  }

  /**
   * Refresh spot prices from live COMEX/NYMEX, automatically, once the app
   * has finished starting up. Fire-and-forget: callers do not await it.
   *
   * ---------------------------------------------------------------------
   * WHY IT RUNS AFTER HYDRATION RATHER THAN DURING IT
   * ---------------------------------------------------------------------
   * This is the only outbound call to the public internet the app makes, and
   * it goes through a corporate network. It can be slow, it can hang, it can
   * be blocked outright. None of that is allowed to come between the user and
   * a working screen, so it is started AFTER hydrate() has resolved and lands
   * whenever it lands. Until it does, the melt values are already populated
   * from the prices hydrate() read back out of the database — which is the
   * nice property of doing it in this order: melt is never blank while we
   * wait on the network, it merely gets more current a moment later.
   *
   * ---------------------------------------------------------------------
   * WHY IT DOES NOT USE SpotPriceService
   * ---------------------------------------------------------------------
   * SpotPriceService.fetchSpotPrices() — what the modal's Fetch button calls —
   * reports failure with `showError`, and error toasts in this app are STICKY
   * (see NotificationService: info and warning auto-dismiss, error does not).
   * That is exactly right for a button the user pressed and is waiting on. It
   * is exactly wrong for something that happens by itself: on a machine with
   * no internet it would greet the owner with a permanent red toast on every
   * single launch. So the automatic path talks to ApiService directly and
   * stays quiet — a log line and nothing else. The manual button's loud
   * behaviour is deliberately left alone.
   *
   * ---------------------------------------------------------------------
   * WHAT A FAILURE MUST NOT DO
   * ---------------------------------------------------------------------
   * It must not wipe the prices we loaded from the database. Note that the
   * backend answers 200 with ZEROED prices and an `error` field when the
   * upstream is unreachable, rather than failing the request — so "it
   * succeeded" is not `!threw`, it is `no error field AND at least one
   * non-zero price`. Storing a zeroed result would blank every melt value in
   * the app, which is the precise opposite of what this feature is for.
   *
   * ---------------------------------------------------------------------
   * HOW OFTEN IT RUNS
   * ---------------------------------------------------------------------
   * At most once SUCCESSFULLY per app session. A failed attempt does not burn
   * the budget, so if start-up failed because the backend was down and the
   * user then presses "Retry connection", they get the fetch they missed.
   * Repeated retries after a success do nothing. One successful fetch writes
   * exactly one history row (via commitSpotPrices, which additionally skips a
   * save whose numbers match the row already on disk — so a launch that
   * fetches the same prices as last time adds nothing at all).
   *
   * Never throws.
   *
   * @returns true only if live prices were fetched AND applied
   */
  async autoRefreshSpotPrices(): Promise<boolean> {
    if (this.autoSpotPriceFetchSucceeded || this.autoSpotPriceFetchInFlight) return false;
    this.autoSpotPriceFetchInFlight = true;

    try {
      const result = await firstValueFrom(this.apiService.fetchSpotPrices());

      // Graceful-degradation shape: 200 OK, zeroed prices, `error` set.
      if (result?.error) {
        this.logger.warn(`Automatic spot price fetch returned no prices: ${result.error}`);
        return false;
      }

      const prices = result?.prices;
      if (!prices || !hasAnySpotPrice(prices)) {
        // Defensive: an all-zero "success" tells us nothing and must not
        // overwrite good prices loaded from the database.
        this.logger.warn('Automatic spot price fetch returned all-zero prices — keeping the saved ones');
        return false;
      }

      this.updateSpotPrices(prices);
      this.logger.info('Spot prices refreshed automatically at start-up');

      // A successful automatic fetch is every bit as deliberate as pressing
      // the button, so it persists and becomes the "last retrieved prices"
      // the next launch reads back.
      await this.commitSpotPrices(result.source || 'COMEX/NYMEX futures');

      this.autoSpotPriceFetchSucceeded = true;
      return true;
    } catch (error) {
      // No internet, blocked proxy, backend not up yet. Completely non-fatal:
      // the app already works and the saved prices are already in place.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Automatic spot price fetch failed — using saved prices', msg);
      return false;
    } finally {
      this.autoSpotPriceFetchInFlight = false;
    }
  }

  /** Guards for autoRefreshSpotPrices — see its comment for the policy. */
  private autoSpotPriceFetchInFlight = false;
  private autoSpotPriceFetchSucceeded = false;

  /** What a coin's precious metal is worth today, or null if unknowable. */
  meltValue(coin: CoinRecord): number | null {
    return computeMeltValue(coin, this.spotPrices());
  }

  /**
   * A sentence explaining a coin's melt figure — above all, explaining WHY it
   * is a dash when it is one. Used as a tooltip in the grid and the detail
   * panel so "no prices fetched yet" never masquerades as "no precious metal".
   */
  meltValueHint(coin: CoinRecord): string {
    return describeMeltValue(coin, this.spotPrices());
  }

  // ==========================================================================
  // Lookup lists — all delegated to LookupManager
  // ==========================================================================

  mergeCategoryOptions(names: string[]): void {
    this.lookups.mergeCategoryOptions(names);
  }

  removeCategoryOption(category: string): void {
    this.lookups.removeCategoryOption(category);
  }

  addCoinSet(name: string): void {
    this.lookups.addCoinSet(name);
  }

  removeCoinSet(name: string): void {
    this.lookups.removeCoinSet(name);
  }

  loadDenominations(): Promise<void> {
    return this.lookups.loadDenominations();
  }

  addDenomination(d: Partial<Denomination>): Promise<void> {
    return this.lookups.addDenomination(d);
  }

  removeDenomination(id: number): Promise<void> {
    return this.lookups.removeDenomination(id);
  }

  loadMintMarks(): Promise<void> {
    return this.lookups.loadMintMarks();
  }

  addMintMark(m: Partial<MintMarkOption>): Promise<void> {
    return this.lookups.addMintMark(m);
  }

  removeMintMark(id: number): Promise<void> {
    return this.lookups.removeMintMark(id);
  }
}

/** Do two price sets hold exactly the same four numbers? */
function samePrices(a: SpotPrices, b: SpotPrices): boolean {
  return a.gold === b.gold
    && a.silver === b.silver
    && a.platinum === b.platinum
    && a.copper === b.copper;
}
