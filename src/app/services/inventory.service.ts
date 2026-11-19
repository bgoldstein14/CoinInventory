import { Injectable, computed, signal, inject } from '@angular/core';
import {
  CoinRecord,
  SpotPrices,
  SpotPriceMeta,
  Denomination,
  MintMarkOption
} from '../types/coin.model';
import { CatalogOption } from '../types/catalog-reference';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { CoinChangeTracker } from './inventory/coin-change-tracker';
import { CoinDraftRegistry } from './inventory/coin-draft-registry';
import { CoinEditor } from './inventory/coin-editor';
import { CoinImageHydrator } from './inventory/coin-image-hydrator';
import { CoinCollection } from './inventory/coin-collection';
import { LookupManager } from './inventory/lookup-manager';
import { ConnectionManager } from './inventory/connection-manager';
import { LoadFailure } from './inventory/load-failure';
// The precious-metal backfill (inference shared with the Quicken import; see pm-fill.ts).
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

 /*
  * The front door to the coin collection: components use this service only. It
  * owns the shared signals and delegates to helpers in ./inventory/:
  *
  *   coin-change-tracker.ts  server-confirmed vs unsaved state
  *   coin-draft-registry.ts  coins not yet in the database
  *   coin-editor.ts          field edits: optimistic paint, debounce, minimal PUT
  *   coin-collection.ts      add / import / delete whole coins, and selection
  *   lookup-manager.ts       categories, coin sets, denominations, mint marks
  *   connection-manager.ts   start-up loading and the connection banner
  *   coin-factory.ts         building blank / imported CoinRecords
  *   inventory-metrics.ts    totals, distinct lists, melt value (pure)
  *
  * 1. Helpers are plain classes created with `new`, so this service stays
  *    constructible from an injection context providing only ApiService,
  *    LoggingService and NotificationService (as the tests do).
  * 2. Signals are created here and passed to the helpers, so there is one copy
  *    of each piece of state.
  */

@Injectable({ providedIn: 'root' })
export class InventoryService {
  // State. These signals are public API; components read them directly.
  readonly inventory = signal<CoinRecord[]>([]);
  readonly selectedCoinId = signal<string | null>(null);
  readonly categoryOptions = signal<string[]>([]);
  readonly coinSets = signal<string[]>([]);
  readonly spotPrices = signal<SpotPrices>({ ...defaultSpotPrices });

  /**
   * Provenance of the last saved spot prices, from the database at start-up
   * (ConnectionManager.hydrate) and after each save. All-null means none saved yet.
   */
  readonly spotPriceMeta = signal<SpotPriceMeta>({ source: null, fetchedAt: null, prices: null });

  readonly connecting = signal(false);
  readonly connected = signal(false);
  readonly connectionError = signal<string | null>(null);

   /*
    * The same failure as `connectionError`, classified: the stage the server
    * reported ('connection' / 'database' / 'delivery'), banner heading, short
    * status label, whether the data is known to be safe, and a technical line.
    * Lets the app avoid saying "failed to connect" when only the response failed.
    * `connectionError` is kept in step with its `message`. See inventory/load-failure.ts.
    */
  readonly loadFailure = signal<LoadFailure | null>(null);

  readonly denominations = signal<Denomination[]>([]);
  readonly mintMarks = signal<MintMarkOption[]>([]);
  readonly metalContents = signal<string[]>([]);
  /**
   * Reference catalogues (Sear, RIC, Hendin, Krause; migration 012), loaded with
   * the other lookups. Resolve names through types/catalog-reference.ts
   * (`catalogNameById()` handles string ids from CSV and soft-deleted catalogues).
   */
  readonly catalogs = signal<CatalogOption[]>([]);

  /** Catalogues still offered in pickers and the maintenance list (removed ones excluded). */
  readonly activeCatalogs = computed(() => this.catalogs().filter(catalog => catalog.isActive));

  // Derived values (calculations in inventory-metrics.ts).
  readonly selectedCoin = computed(() =>
    this.inventory().find(c => c.id === this.selectedCoinId()) ?? null
  );

  readonly totalCost = computed(() => sumPurchasePrice(this.inventory()));

  readonly totalValue = computed(() => sumCurrentValue(this.inventory()));

  readonly totalProfit = computed(() => sumProfit(this.inventory()));

  readonly inventoryCategories = computed(() => distinctCategories(this.inventory()));

  readonly inventoryCountries = computed(() => distinctCountries(this.inventory()));

  readonly inventorySources = computed(() => distinctSources(this.inventory()));

  /**
   * True once at least one non-zero spot price is in memory, so the UI can tell
   * "no precious metal" apart from "no prices fetched yet".
   */
  readonly hasSpotPrices = computed(() => hasAnySpotPrice(this.spotPrices()));

  private readonly apiService = inject(ApiService);
  private readonly logger = inject(LoggingService);
  private readonly notificationService = inject(NotificationService);

  // Helpers, declared last and in dependency order (field initialisers can only
  // use fields declared above them).

  /** Tracks confirmed vs unsaved state for every coin. */
  private readonly changeTracker = new CoinChangeTracker(
    (coinId) => this.inventory().find(c => c.id === coinId)
  );

  /** Which coins are still local-only drafts (see its file header). */
  private readonly drafts = new CoinDraftRegistry();

  private readonly lookups = new LookupManager(
    this.categoryOptions,
    this.coinSets,
    this.denominations,
    this.mintMarks,
    this.catalogs,
    this.apiService,
    this.logger,
    this.notificationService
  );

  private readonly coins = new CoinCollection(
    this.inventory,
    this.selectedCoinId,
    this.changeTracker,
    this.drafts,
    this.lookups,
    this.apiService,
    this.logger,
    this.notificationService
  );

  /** Loads one coin's photos on demand (the list endpoint doesn't send them). */
  private readonly coinImages = new CoinImageHydrator(
    this.inventory,
    this.apiService,
    this.logger
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
    loadFailure: this.loadFailure,
    categoryOptions: this.categoryOptions,
    coinSets: this.coinSets,
    denominations: this.denominations,
    mintMarks: this.mintMarks,
    catalogs: this.catalogs,
    metalContents: this.metalContents,
    spotPrices: this.spotPrices,
    spotPriceMeta: this.spotPriceMeta,
    coins: this.coins,
    apiService: this.apiService,
    logger: this.logger,
    notificationService: this.notificationService
  });

  // Start-up / connection (connection-manager.ts)

  /**
   * Loads the coins (fatal on failure), then the optional lookup tables (failure
   * is only a warning).
   *
   * @throws Error only when the coin fetch fails
   */
  hydrate(): Promise<void> {
    return this.connection.hydrate();
  }

  /**
   * Tries connecting again after a failure, without reloading the page.
   *
   * @returns true if now connected
   */
  retryConnection(): Promise<boolean> {
    return this.connection.retryConnection();
  }

  // Coins: whole records go to CoinCollection, field edits to CoinEditor.

  selectCoin(coinId: string): void {
    this.coins.selectCoin(coinId);
    // Load the selected coin's photos (the detail panel, gallery and viewer read
    // them). Cached per coin; skipped when `imageCount` is 0.
    this.coinImages.ensure(coinId);
  }

  ensureSelectedCoin(): void {
    this.coins.ensureSelectedCoin();
  }

  // Photographs, fetched one coin at a time (see coin-image-hydrator.ts):
  // `GET /api/coins` returns `imageCount` but no `imagePaths`.

  /**
   * Fetches one coin's photos and writes them onto its record. Rejects on failure
   * rather than resolving `[]`, so callers about to save an image array are stopped.
   */
  loadCoinImages(coinId: string): Promise<string[]> {
    return this.coinImages.load(coinId);
  }

  /** Fire-and-forget `loadCoinImages`. */
  ensureCoinImages(coinId: string | null | undefined): void {
    this.coinImages.ensure(coinId);
  }

  /**
   * Creates an empty coin and selects it. Nothing is sent: it stays a local draft
   * until it has 2 of Year / Coin Type / Denomination, then saves itself (see
   * inventory/coin-draft-registry.ts).
   */
  addBlankCoin(): CoinRecord {
    return this.coins.addBlankCoin();
  }

  /** True while a coin exists only on screen (shown as the "Unsaved" chip). */
  isDraftCoin(coinId: string): boolean {
    return this.drafts.isUnsaved(coinId);
  }

  /**
   * What an unsaved row still needs, e.g. "Not saved yet. Add 1 more of: Coin
   * Type, Denomination."; '' for a saved or qualifying coin.
   */
  draftHint(coin: CoinRecord): string {
    return this.drafts.describeWhatIsMissing(coin);
  }

  /** Appends an imported batch of coins. */
  addCoins(coins: CoinRecord[]): void {
    this.coins.addCoins(coins);
  }

  /** Replaces the whole inventory from exported JSON. */
  importInventoryData(json: string): void {
    this.coins.importInventoryData(json);
  }

  /** Removes a coin from the list, the change tracker and the database. */
  deleteCoin(coinId: string): void {
    this.coins.deleteCoin(coinId);
  }

  /**
   * Applies an edit: the screen updates at once and only changed fields are PUT a
   * second later.
   *
   * @see CoinEditor for the optimistic-update, minimal-diff and retry rules
   */
  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    this.editor.updateCoin(coinId, updates);
  }

  /**
   * Applies an edit and writes it immediately; resolves when the server accepts.
   * For bulk maintenance passes only: `updateCoin` debounces per coin, so a loop
   * would fire every PUT at once. This lets a caller await each write in turn.
   *
   * @see CoinEditor.updateCoinNow
   * @throws when the coin is an unsaved draft, or the PUT fails
   */
  updateCoinNow(coinId: string, updates: Partial<CoinRecord>): Promise<Partial<CoinRecord>> {
    return this.editor.updateCoinNow(coinId, updates);
  }

  // Maintenance: precious-metal backfill

  /**
   * Which coins are missing inferable alloy data, without changing anything (see
   * pm-backfill.ts). Draft rows are excluded.
   */
  planPmBackfill(): PmBackfillPlan {
    return planPmBackfill(this.inventory(), (coinId) => this.drafts.isUnsaved(coinId));
  }

  /**
   * Writes a plan from `planPmBackfill`, one coin at a time, sequentially (see
   * `runPmBackfill` and `CoinEditor.updateCoinNow`).
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

  // Spot prices and melt value

  /**
   * Puts new prices in memory; every melt figure recalculates. Does not save:
   * the spot price modal calls this on every keystroke, and each save inserts a
   * history row. Persistence is in commitSpotPrices().
   */
  updateSpotPrices(prices: SpotPrices): void {
    this.spotPrices.set(prices);
  }

  /**
   * Writes the in-memory prices to the database as a new history row. Call only
   * from a deliberate action; there are two, in SpotPriceModalComponent:
   *   1. a successful "Fetch COMEX Prices";
   *   2. closing the modal after hand-editing (one row per editing session).
   *
   * Skipped when the prices equal the last saved row, or are all zero (which
   * would load zeros over good prices on the next start-up).
   *
   * Never throws: a failed save is logged and mentioned once; prices stay in memory.
   *
   * @param source provenance label, e.g. "COMEX/NYMEX futures via Yahoo Finance"
   *               or "Manual entry"
   * @returns true if a row was written
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
      // Non-fatal: prices are in memory; only reloading them after a restart is lost.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Failed to save spot prices', msg);
      this.notificationService.showWarning(
        'Spot prices could not be saved — they will work for now but will be lost when the app restarts.'
      );
      return false;
    }
  }

  /**
   * Refreshes spot prices from live COMEX/NYMEX automatically after start-up.
   * Fire-and-forget; never throws.
   *
   * - Runs after hydrate() so a slow or blocked network never delays the app;
   *   melt values already show the prices loaded from the database.
   * - Calls ApiService directly rather than SpotPriceService, whose error toasts
   *   are sticky (right for the Fetch button, wrong for a background task).
   *   Failures are only logged.
   * - Must not wipe loaded prices. The backend answers 200 with zeroed prices and
   *   an `error` field when the upstream fails, so success means no `error` and
   *   at least one non-zero price.
   * - At most one successful run per session; a failure doesn't use it up, so
   *   "Retry connection" can try again. A success writes one history row via
   *   commitSpotPrices (skipped if unchanged).
   *
   * @returns true only if live prices were fetched and applied
   */
  async autoRefreshSpotPrices(): Promise<boolean> {
    if (this.autoSpotPriceFetchSucceeded || this.autoSpotPriceFetchInFlight) return false;
    this.autoSpotPriceFetchInFlight = true;

    try {
      const result = await firstValueFrom(this.apiService.fetchSpotPrices());

      // 200 OK with zeroed prices and `error` set.
      if (result?.error) {
        this.logger.warn(`Automatic spot price fetch returned no prices: ${result.error}`);
        return false;
      }

      const prices = result?.prices;
      if (!prices || !hasAnySpotPrice(prices)) {
        // An all-zero "success" must not overwrite good saved prices.
        this.logger.warn('Automatic spot price fetch returned all-zero prices — keeping the saved ones');
        return false;
      }

      this.updateSpotPrices(prices);
      this.logger.info('Spot prices refreshed automatically at start-up');

      // A successful automatic fetch is saved like a manual one.
      await this.commitSpotPrices(result.source || 'COMEX/NYMEX futures');

      this.autoSpotPriceFetchSucceeded = true;
      return true;
    } catch (error) {
      // No internet, blocked proxy, or backend not up yet: non-fatal.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn('Automatic spot price fetch failed — using saved prices', msg);
      return false;
    } finally {
      this.autoSpotPriceFetchInFlight = false;
    }
  }

  /** Guard for autoRefreshSpotPrices. */
  private autoSpotPriceFetchInFlight = false;
  private autoSpotPriceFetchSucceeded = false;

  /** What a coin's precious metal is worth today, or null if unknown. */
  meltValue(coin: CoinRecord): number | null {
    return computeMeltValue(coin, this.spotPrices());
  }

  /**
   * Explains a coin's melt figure, especially why it is a dash (tooltip in the
   * grid and detail panel), so "no prices yet" isn't mistaken for "no precious metal".
   */
  meltValueHint(coin: CoinRecord): string {
    return describeMeltValue(coin, this.spotPrices());
  }

  // Lookup lists (delegated to LookupManager)

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

  /* Catalogues (migration 012): the same delegations as the other lookups. */

  loadCatalogs(): Promise<void> {
    return this.lookups.loadCatalogs();
  }

  addCatalog(c: Partial<CatalogOption>): Promise<void> {
    return this.lookups.addCatalog(c);
  }

  renameCatalog(id: number, name: string): Promise<void> {
    return this.lookups.renameCatalog(id, name);
  }

  removeCatalog(id: number): Promise<void> {
    return this.lookups.removeCatalog(id);
  }
}

/** Whether two price sets hold exactly the same four numbers. */
function samePrices(a: SpotPrices, b: SpotPrices): boolean {
  return a.gold === b.gold
    && a.silver === b.silver
    && a.platinum === b.platinum
    && a.copper === b.copper;
}
