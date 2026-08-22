import { Injectable, computed, signal } from '@angular/core';
import { StorageKeys, StorageService } from './storage.service';
import { CoinRecord, SpotPrices, TransactionRecord } from '../types/coin.model';

const defaultSpotPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };

@Injectable({ providedIn: 'root' })
export class InventoryService {
  readonly inventory = signal<CoinRecord[]>([]);
  readonly selectedCoinId = signal<string | null>(null);
  readonly categoryOptions = signal<string[]>([]);
  readonly coinSets = signal<string[]>([]);
  readonly transactions = signal<TransactionRecord[]>([]);
  readonly spotPrices = signal<SpotPrices>({ ...defaultSpotPrices });

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

  constructor(private readonly storageService: StorageService) {}

  async hydrate(): Promise<void> {
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
  }

  selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
  }

  addBlankCoin(): CoinRecord {
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      name: 'New Coin',
      denomination: '',
      year: null,
      type: '',
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
      hasCacSticker: false
    };

    this.inventory.set([...this.inventory(), coin]);
    this.selectedCoinId.set(coin.id);
    this.persistInventory();
    return coin;
  }

  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    this.inventory.set(
      this.inventory().map(c => c.id === coinId ? { ...c, ...updates } : c)
    );
    this.persistInventory();
  }

  deleteCoin(coinId: string): void {
    this.inventory.set(this.inventory().filter(c => c.id !== coinId));
    this.transactions.set(this.transactions().filter(t => t.coinId !== coinId));
    this.persistInventory();
    this.persistTransactions();
    this.ensureSelectedCoin();
  }

  addCoins(coins: CoinRecord[]): void {
    this.inventory.set([...this.inventory(), ...coins]);
    this.persistInventory();
    this.ensureSelectedCoin();

    const importedCategories = coins.map(c => c.category).filter(Boolean);
    this.mergeCategoryOptions(importedCategories);
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

  meltValue(coin: CoinRecord): number | null {
    const w = coin.weight ?? 0;
    const metal = (coin.metalContent ?? '').toLowerCase();
    if (w <= 0 || !metal) return null;
    const prices = this.spotPrices();
    if (metal.includes('gold') && prices.gold > 0) return w * prices.gold;
    if (metal.includes('silver') && prices.silver > 0) return w * prices.silver;
    if (metal.includes('platinum') && prices.platinum > 0) return w * prices.platinum;
    if (metal.includes('copper') && prices.copper > 0) return w * prices.copper;
    return null;
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
}
