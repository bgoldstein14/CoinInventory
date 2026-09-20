import { Injectable, computed, signal, inject } from '@angular/core';
import {
  CoinRecord,
  SpotPrices,
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
import {
  computeMeltValue,
  distinctCategories,
  distinctCountries,
  distinctDealers,
  distinctSources,
  sumCurrentValue,
  sumProfit,
  sumPurchasePrice
} from './inventory/inventory-metrics';

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

  readonly inventoryDealers = computed(() => distinctDealers(this.inventory()));

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

  updateSpotPrices(prices: SpotPrices): void {
    this.spotPrices.set(prices);
  }

  /** What a coin's precious metal is worth today, or null if unknowable. */
  meltValue(coin: CoinRecord): number | null {
    return computeMeltValue(coin, this.spotPrices());
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
