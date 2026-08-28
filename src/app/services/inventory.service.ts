import { Injectable, computed, signal, inject } from '@angular/core';
import { StorageKeys, StorageService } from './storage.service';
import { CoinRecord, SpotPrices, TransactionRecord, Denomination, MintMarkOption } from '../types/coin.model';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { firstValueFrom } from 'rxjs';

const defaultSpotPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };

@Injectable({ providedIn: 'root' })
export class InventoryService {
  // Core inventory signals
  readonly inventory = signal<CoinRecord[]>([]);
  readonly selectedCoinId = signal<string | null>(null);
  readonly categoryOptions = signal<string[]>([]);
  readonly coinSets = signal<string[]>([]);
  readonly transactions = signal<TransactionRecord[]>([]);
  readonly spotPrices = signal<SpotPrices>({ ...defaultSpotPrices });

  // Storage mode: 'database' when connected to backend, 'local' for IndexedDB fallback
  readonly storageMode = signal<'database' | 'local'>('local');

  // Reference data loaded from the backend API
  readonly denominations = signal<Denomination[]>([]);
  readonly mintMarks = signal<MintMarkOption[]>([]);

  readonly selectedCoin = computed(() =>
    this.inventory().find(c => c.id === this.selectedCoinId()) ?? null
  );

  readonly totalCost = computed(() =>
    this.inventory().reduce((sum, c) => sum + c.purchasePrice, 0)
  );

  readonly totalValue = computed(() =>
    this.inventory().reduce((sum, c) => sum + c.currentValue, 0)
  );

  readonly totalProfit = computed(() =>
    this.inventory().reduce((sum, c) => sum + (c.currentValue - c.purchasePrice), 0)
  );

  readonly inventoryCategories = computed(() => {
    const categories = this.inventory().map(c => c.category).filter(Boolean);
    return [...new Set(categories)];
  });

  readonly inventoryCountries = computed(() => {
    const countries = this.inventory().map(c => c.country).filter(Boolean);
    return [...new Set(countries)].sort();
  });

  readonly inventorySources = computed(() => {
    const sources = this.inventory().map(c => c.source).filter(Boolean);
    return [...new Set(sources)].sort();
  });

  readonly inventoryDealers = computed(() => {
    const dealers = this.inventory().map(c => c.dealer ?? '').filter(Boolean);
    return [...new Set(dealers)].sort();
  });

  readonly selectedCoinTransactions = computed(() => {
    const coinId = this.selectedCoinId();
    if (!coinId) return [];
    return this.transactions().filter(t => t.coinId === coinId);
  });

  // Inject services using Angular's modern inject() function
  private readonly storageService = inject(StorageService);
  private readonly apiService = inject(ApiService);
  private readonly logger = inject(LoggingService);
  private readonly notificationService = inject(NotificationService);

  /**
   * Hydrate the inventory from storage.
   * Tries to connect to the backend database first.
   * On failure, falls back to IndexedDB local storage.
   */
  async hydrate(): Promise<void> {
    this.logger.info('Starting inventory hydration');

    // Try to load from backend API first
    try {
      // Attempt to fetch coins from the backend
      const coins = await firstValueFrom(this.apiService.getCoins());

      // Success! We're connected to the database
      this.logger.info(`Successfully loaded ${coins.length} coins from database`);
      this.storageMode.set('database');
      this.inventory.set(coins);
      this.ensureSelectedCoin();

      // Load all reference data from the API in parallel
      const [categories, coinSets, transactions, spotPrices, denominations, mintMarks] = await Promise.all([
        firstValueFrom(this.apiService.getCategories()),
        firstValueFrom(this.apiService.getCoinSets()),
        firstValueFrom(this.apiService.getTransactions()),
        this.storageService.get<SpotPrices>(StorageKeys.SpotPrices), // Spot prices still come from local storage for now
        firstValueFrom(this.apiService.getDenominations()),
        firstValueFrom(this.apiService.getMintMarks())
      ]);

      // Update all signals with the fetched data
      if (Array.isArray(categories) && categories.length > 0) {
        this.categoryOptions.set(categories);
      }
      if (Array.isArray(coinSets) && coinSets.length > 0) {
        this.coinSets.set(coinSets);
      }
      if (Array.isArray(transactions) && transactions.length > 0) {
        this.transactions.set(transactions);
      }
      if (spotPrices && typeof spotPrices === 'object') {
        this.spotPrices.set(spotPrices);
      }
      if (Array.isArray(denominations) && denominations.length > 0) {
        this.denominations.set(denominations);
      }
      if (Array.isArray(mintMarks) && mintMarks.length > 0) {
        this.mintMarks.set(mintMarks);
      }

      this.notificationService.showInfo('Connected to database');
      this.logger.info('Database hydration complete');

    } catch (error) {
      // Backend is unavailable - fall back to IndexedDB
      this.logger.error('Failed to connect to database, falling back to local storage', JSON.stringify(error));
      this.notificationService.showWarning('Cannot connect to database — using local storage');
      this.storageMode.set('local');

      // Load from IndexedDB as fallback
      const [storedInventory, storedCategoryOptions, storedSets, storedTxns, storedSpot] = await Promise.all([
        this.storageService.get<CoinRecord[]>(StorageKeys.Inventory),
        this.storageService.get<string[]>(StorageKeys.CategoryOptions),
        this.storageService.get<string[]>(StorageKeys.CoinSets),
        this.storageService.get<TransactionRecord[]>(StorageKeys.Transactions),
        this.storageService.get<SpotPrices>(StorageKeys.SpotPrices)
      ]);

      if (Array.isArray(storedInventory) && storedInventory.length > 0) {
        this.inventory.set(storedInventory);
        this.ensureSelectedCoin();
      }
      if (Array.isArray(storedCategoryOptions) && storedCategoryOptions.length > 0) {
        this.categoryOptions.set(storedCategoryOptions);
      }
      if (Array.isArray(storedSets) && storedSets.length > 0) {
        this.coinSets.set(storedSets);
      }
      if (Array.isArray(storedTxns) && storedTxns.length > 0) {
        this.transactions.set(storedTxns);
      }
      if (storedSpot && typeof storedSpot === 'object') {
        this.spotPrices.set(storedSpot);
      }

      this.logger.info('Local storage hydration complete');
    }
  }

  selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
  }

  /**
   * Create a new blank coin record.
   * In database mode, the coin is created via API call.
   * In local mode, the coin is added to IndexedDB.
   */
  addBlankCoin(): CoinRecord {
    // Create a new blank coin with updated schema (no 'name', year is string, added PM fields)
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      denomination: '',
      year: '', // Changed from null to empty string to support year ranges
      coinType: '', // Renamed from 'type' for clarity
      category: '',
      country: 'United States',
      grade: '',
      certCompany: '',
      certNumber: '',
      variety: '',
      mintMark: '',
      composition: '',
      purchaseDate: '',
      purchasePrice: 0,
      currentValue: 0,
      notes: '',
      imagePaths: [],
      tags: [],
      source: 'manual',
      hasCacSticker: false,
      pmWeightGrams: undefined, // Precious metal weight for melt value calculations
      pmPercent: undefined // Precious metal purity percentage
    };

    // Add to local inventory signal immediately for responsive UI
    this.inventory.set([...this.inventory(), coin]);
    this.selectedCoinId.set(coin.id);

    // Persist based on storage mode
    if (this.storageMode() === 'database') {
      // Save to backend database
      firstValueFrom(this.apiService.createCoin(coin))
        .then(() => {
          this.logger.info(`Created coin ${coin.id} in database`);
        })
        .catch((error) => {
          this.logger.error('Failed to create coin in database', JSON.stringify(error));
          this.notificationService.showError('Failed to save coin to database');
        });
    } else {
      // Save to IndexedDB
      this.persistInventory();
    }

    return coin;
  }

  /**
   * Update a coin's data.
   * In database mode, the update is sent to the backend.
   * In local mode, the update is persisted to IndexedDB.
   */
  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    // Update local signal immediately for responsive UI
    this.inventory.set(
      this.inventory().map(c => c.id === coinId ? { ...c, ...updates } : c)
    );

    // Persist based on storage mode
    if (this.storageMode() === 'database') {
      // Save to backend database
      firstValueFrom(this.apiService.updateCoin(coinId, updates))
        .then(() => {
          this.logger.info(`Updated coin ${coinId} in database`);
        })
        .catch((error) => {
          this.logger.error(`Failed to update coin ${coinId} in database`, JSON.stringify(error));
          this.notificationService.showError('Failed to update coin in database');
        });
    } else {
      // Save to IndexedDB
      this.persistInventory();
    }
  }

  /**
   * Delete a coin from the inventory.
   * In database mode, the deletion is sent to the backend.
   * In local mode, the deletion is persisted to IndexedDB.
   * Also removes all associated transactions.
   */
  deleteCoin(coinId: string): void {
    // Update local signals immediately for responsive UI
    this.inventory.set(this.inventory().filter(c => c.id !== coinId));
    this.transactions.set(this.transactions().filter(t => t.coinId !== coinId));
    this.ensureSelectedCoin();

    // Persist based on storage mode
    if (this.storageMode() === 'database') {
      // Delete from backend database
      firstValueFrom(this.apiService.deleteCoin(coinId))
        .then(() => {
          this.logger.info(`Deleted coin ${coinId} from database`);
        })
        .catch((error) => {
          this.logger.error(`Failed to delete coin ${coinId} from database`, JSON.stringify(error));
          this.notificationService.showError('Failed to delete coin from database');
        });
    } else {
      // Delete from IndexedDB
      this.persistInventory();
      this.persistTransactions();
    }
  }

  /**
   * Add multiple coins to the inventory (used for bulk import).
   * In database mode, each coin is created via API call.
   * In local mode, coins are added to IndexedDB.
   */
  addCoins(coins: CoinRecord[]): void {
    // Add to local inventory signal immediately for responsive UI
    this.inventory.set([...this.inventory(), ...coins]);
    this.ensureSelectedCoin();

    const importedCategories = coins.map(c => c.category).filter(Boolean);
    this.mergeCategoryOptions(importedCategories);

    // Persist based on storage mode
    if (this.storageMode() === 'database') {
      // Create each coin in the backend database
      // Fire off all requests in parallel for better performance
      const createPromises = coins.map(coin =>
        firstValueFrom(this.apiService.createCoin(coin))
          .catch((error) => {
            this.logger.error(`Failed to create coin ${coin.id} in database`, JSON.stringify(error));
          })
      );

      Promise.all(createPromises)
        .then(() => {
          this.logger.info(`Successfully added ${coins.length} coins to database`);
          this.notificationService.showInfo(`Added ${coins.length} coins to database`);
        })
        .catch((error) => {
          this.logger.error('Failed to add some coins to database', JSON.stringify(error));
          this.notificationService.showError('Failed to add some coins to database');
        });
    } else {
      // Save to IndexedDB
      this.persistInventory();
    }
  }

  importInventoryData(json: string): void {
    try {
      const parsed = JSON.parse(json) as CoinRecord[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const normalized = parsed.map(coin => ({
        ...coin,
        id: coin.id || crypto.randomUUID(),
        imagePaths: Array.isArray(coin.imagePaths) ? coin.imagePaths : [],
        tags: Array.isArray(coin.tags) ? coin.tags : [],
        source: coin.source || 'manual',
        grade: coin.grade || '',
        category: coin.category || '',
        hasCacSticker: Boolean(coin.hasCacSticker)
      }));

      this.inventory.set(normalized);
      this.persistInventory();
      this.ensureSelectedCoin();

      const importedCategories = normalized.map(c => c.category).filter(Boolean);
      this.mergeCategoryOptions(importedCategories);
    } catch { /* noop */ }
  }

  addTransaction(txn: TransactionRecord): void {
    this.transactions.set([...this.transactions(), txn]);
    this.persistTransactions();
  }

  deleteTransaction(txnId: string): void {
    this.transactions.set(this.transactions().filter(t => t.id !== txnId));
    this.persistTransactions();
  }

  updateSpotPrices(prices: SpotPrices): void {
    this.spotPrices.set(prices);
    void this.storageService.set(StorageKeys.SpotPrices, prices);
  }

  mergeCategoryOptions(names: string[]): void {
    const current = new Set(this.categoryOptions());
    let changed = false;
    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed && !current.has(trimmed)) { current.add(trimmed); changed = true; }
    }
    if (!changed) return;
    const next = [...current].sort();
    this.categoryOptions.set(next);
    void this.storageService.set(StorageKeys.CategoryOptions, next);
  }

  removeCategoryOption(category: string): void {
    const next = this.categoryOptions().filter(o => o !== category);
    this.categoryOptions.set(next);
    void this.storageService.set(StorageKeys.CategoryOptions, next);
  }

  addCoinSet(name: string): void {
    const current = this.coinSets();
    if (!current.includes(name)) {
      const next = [...current, name].sort();
      this.coinSets.set(next);
      void this.storageService.set(StorageKeys.CoinSets, next);
    }
  }

  removeCoinSet(name: string): void {
    const next = this.coinSets().filter(s => s !== name);
    this.coinSets.set(next);
    void this.storageService.set(StorageKeys.CoinSets, next);
  }

  /**
   * Calculate the melt value of a coin based on its precious metal content.
   * Uses pmWeightGrams (precious metal weight in grams) and pmPercent (purity percentage).
   * Returns null if the coin doesn't have enough data or if spot prices are unavailable.
   *
   * Formula: (pmWeight / GRAMS_PER_TROY_OZ) * (pmPercent / 100) * spotPricePerOz
   *
   * Example: A coin with 24.7g of 90% silver:
   *   (24.7 / 31.1035) * (90 / 100) * $25 = $17.90
   */
  meltValue(coin: CoinRecord): number | null {
    const pmWeight = coin.pmWeightGrams ?? 0;
    const pmPct = coin.pmPercent ?? 0;
    const metal = (coin.metalContent ?? '').toLowerCase();

    // Need all three values to calculate melt value
    if (pmWeight <= 0 || pmPct <= 0 || !metal) return null;

    const prices = this.spotPrices();
    const GRAMS_PER_TROY_OZ = 31.1035; // Industry standard conversion factor

    // Determine which metal we're dealing with and get its spot price
    let spotPerOz = 0;
    if (metal.includes('gold')) spotPerOz = prices.gold;
    else if (metal.includes('silver')) spotPerOz = prices.silver;
    else if (metal.includes('platinum')) spotPerOz = prices.platinum;
    else if (metal.includes('copper')) spotPerOz = prices.copper;

    // If we don't have a spot price for this metal, we can't calculate melt value
    if (spotPerOz <= 0) return null;

    // Calculate melt value: convert grams to troy oz, apply purity, multiply by spot price
    return (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz;
  }

  ensureSelectedCoin(): void {
    if (this.inventory().length === 0) { this.selectedCoinId.set(null); return; }
    const current = this.selectedCoinId();
    if (!current || !this.inventory().some(c => c.id === current)) {
      this.selectedCoinId.set(this.inventory()[0].id);
    }
  }

  persistInventory(): void {
    void this.storageService.set(StorageKeys.Inventory, this.inventory());
  }

  private persistTransactions(): void {
    void this.storageService.set(StorageKeys.Transactions, this.transactions());
  }

  // ========================================
  // Denomination Management
  // ========================================

  /**
   * Load denominations from the backend API.
   * Only works in database mode. In local mode, uses empty array.
   */
  async loadDenominations(): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot load denominations in local mode');
      return;
    }

    try {
      const denominations = await firstValueFrom(this.apiService.getDenominations());
      this.denominations.set(denominations);
      this.logger.info(`Loaded ${denominations.length} denominations from database`);
    } catch (error) {
      this.logger.error('Failed to load denominations', JSON.stringify(error));
      this.notificationService.showError('Failed to load denominations');
    }
  }

  /**
   * Add a new denomination to the system.
   * Only works in database mode.
   */
  async addDenomination(d: Partial<Denomination>): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot add denomination in local mode');
      this.notificationService.showWarning('Denomination management requires database connection');
      return;
    }

    try {
      const created = await firstValueFrom(this.apiService.createDenomination(d));
      // Add to local signal for immediate UI update
      this.denominations.set([...this.denominations(), created]);
      this.logger.info(`Created denomination: ${created.label}`);
      this.notificationService.showInfo(`Added denomination: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create denomination', JSON.stringify(error));
      this.notificationService.showError('Failed to create denomination');
    }
  }

  /**
   * Remove a denomination from the system.
   * Only works in database mode.
   */
  async removeDenomination(id: number): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot remove denomination in local mode');
      this.notificationService.showWarning('Denomination management requires database connection');
      return;
    }

    try {
      await firstValueFrom(this.apiService.deleteDenomination(id));
      // Remove from local signal for immediate UI update
      this.denominations.set(this.denominations().filter(d => d.denominationId !== id));
      this.logger.info(`Deleted denomination: ${id}`);
      this.notificationService.showInfo('Denomination removed');
    } catch (error) {
      this.logger.error('Failed to delete denomination', JSON.stringify(error));
      this.notificationService.showError('Failed to delete denomination');
    }
  }

  // ========================================
  // Mint Mark Management
  // ========================================

  /**
   * Load mint marks from the backend API.
   * Only works in database mode. In local mode, uses empty array.
   */
  async loadMintMarks(): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot load mint marks in local mode');
      return;
    }

    try {
      const mintMarks = await firstValueFrom(this.apiService.getMintMarks());
      this.mintMarks.set(mintMarks);
      this.logger.info(`Loaded ${mintMarks.length} mint marks from database`);
    } catch (error) {
      this.logger.error('Failed to load mint marks', JSON.stringify(error));
      this.notificationService.showError('Failed to load mint marks');
    }
  }

  /**
   * Add a new mint mark to the system.
   * Only works in database mode.
   */
  async addMintMark(m: Partial<MintMarkOption>): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot add mint mark in local mode');
      this.notificationService.showWarning('Mint mark management requires database connection');
      return;
    }

    try {
      const created = await firstValueFrom(this.apiService.createMintMark(m));
      // Add to local signal for immediate UI update
      this.mintMarks.set([...this.mintMarks(), created]);
      this.logger.info(`Created mint mark: ${created.label}`);
      this.notificationService.showInfo(`Added mint mark: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create mint mark', JSON.stringify(error));
      this.notificationService.showError('Failed to create mint mark');
    }
  }

  /**
   * Remove a mint mark from the system.
   * Only works in database mode.
   */
  async removeMintMark(id: number): Promise<void> {
    if (this.storageMode() !== 'database') {
      this.logger.warn('Cannot remove mint mark in local mode');
      this.notificationService.showWarning('Mint mark management requires database connection');
      return;
    }

    try {
      await firstValueFrom(this.apiService.deleteMintMark(id));
      // Remove from local signal for immediate UI update
      this.mintMarks.set(this.mintMarks().filter(m => m.mintMarkId !== id));
      this.logger.info(`Deleted mint mark: ${id}`);
      this.notificationService.showInfo('Mint mark removed');
    } catch (error) {
      this.logger.error('Failed to delete mint mark', JSON.stringify(error));
      this.notificationService.showError('Failed to delete mint mark');
    }
  }
}
