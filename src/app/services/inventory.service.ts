import { Injectable, computed, signal, inject } from '@angular/core';
import { CoinRecord, SpotPrices, TransactionRecord, Denomination, MintMarkOption } from '../types/coin.model';
import { ApiService } from './api.service';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { firstValueFrom } from 'rxjs';

const defaultSpotPrices: SpotPrices = { gold: 0, silver: 0, platinum: 0, copper: 0 };

@Injectable({ providedIn: 'root' })
export class InventoryService {
  readonly inventory = signal<CoinRecord[]>([]);
  readonly selectedCoinId = signal<string | null>(null);
  readonly categoryOptions = signal<string[]>([]);
  readonly coinSets = signal<string[]>([]);
  readonly transactions = signal<TransactionRecord[]>([]);
  readonly spotPrices = signal<SpotPrices>({ ...defaultSpotPrices });

  readonly connected = signal(false);
  readonly connectionError = signal<string | null>(null);

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

  private readonly apiService = inject(ApiService);
  private readonly logger = inject(LoggingService);
  private readonly notificationService = inject(NotificationService);

  async hydrate(): Promise<void> {
    this.logger.info('Starting inventory hydration');

    try {
      const coins = await firstValueFrom(this.apiService.getCoins());

      this.logger.info(`Successfully loaded ${coins.length} coins from database`);
      this.connected.set(true);
      this.connectionError.set(null);
      this.inventory.set(coins);
      this.ensureSelectedCoin();

      const [categories, coinSets, transactions, denominations, mintMarks] = await Promise.all([
        firstValueFrom(this.apiService.getCategories()),
        firstValueFrom(this.apiService.getCoinSets()),
        firstValueFrom(this.apiService.getTransactions()),
        firstValueFrom(this.apiService.getDenominations()),
        firstValueFrom(this.apiService.getMintMarks())
      ]);

      if (Array.isArray(categories)) this.categoryOptions.set(categories);
      if (Array.isArray(coinSets)) this.coinSets.set(coinSets);
      if (Array.isArray(transactions)) this.transactions.set(transactions);
      if (Array.isArray(denominations)) this.denominations.set(denominations);
      if (Array.isArray(mintMarks)) this.mintMarks.set(mintMarks);

      this.notificationService.showInfo('Connected to database');
      this.logger.info('Database hydration complete');

    } catch (error) {
      const msg = error instanceof Error ? error.message : JSON.stringify(error);
      this.logger.error('Failed to connect to database', msg);
      this.connected.set(false);
      this.connectionError.set(`Cannot connect to database: ${msg}`);
      this.notificationService.showError('Cannot connect to database — please check that the backend server is running');
      throw new Error(`Database connection failed: ${msg}`);
    }
  }

  selectCoin(coinId: string): void {
    this.selectedCoinId.set(coinId);
  }

  addBlankCoin(): CoinRecord {
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      denomination: '',
      year: '',
      coinType: '',
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
      pmWeightGrams: undefined,
      pmPercent: undefined
    };

    this.inventory.set([...this.inventory(), coin]);
    this.selectedCoinId.set(coin.id);

    firstValueFrom(this.apiService.createCoin(coin))
      .then(() => this.logger.info(`Created coin ${coin.id} in database`))
      .catch((error) => {
        this.logger.error('Failed to create coin in database', JSON.stringify(error));
        this.notificationService.showError('Failed to save coin to database');
      });

    return coin;
  }

  updateCoin(coinId: string, updates: Partial<CoinRecord>): void {
    this.inventory.set(
      this.inventory().map(c => c.id === coinId ? { ...c, ...updates } : c)
    );

    firstValueFrom(this.apiService.updateCoin(coinId, updates))
      .then(() => this.logger.info(`Updated coin ${coinId} in database`))
      .catch((error) => {
        this.logger.error(`Failed to update coin ${coinId} in database`, JSON.stringify(error));
        this.notificationService.showError('Failed to update coin in database');
      });
  }

  deleteCoin(coinId: string): void {
    this.inventory.set(this.inventory().filter(c => c.id !== coinId));
    this.transactions.set(this.transactions().filter(t => t.coinId !== coinId));
    this.ensureSelectedCoin();

    firstValueFrom(this.apiService.deleteCoin(coinId))
      .then(() => this.logger.info(`Deleted coin ${coinId} from database`))
      .catch((error) => {
        this.logger.error(`Failed to delete coin ${coinId} from database`, JSON.stringify(error));
        this.notificationService.showError('Failed to delete coin from database');
      });
  }

  addCoins(coins: CoinRecord[]): void {
    this.inventory.set([...this.inventory(), ...coins]);
    this.ensureSelectedCoin();

    const importedCategories = coins.map(c => c.category).filter(Boolean);
    this.mergeCategoryOptions(importedCategories);

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
      this.ensureSelectedCoin();

      const importedCategories = normalized.map(c => c.category).filter(Boolean);
      this.mergeCategoryOptions(importedCategories);

      const createPromises = normalized.map(coin =>
        firstValueFrom(this.apiService.createCoin(coin))
          .catch((error) => {
            this.logger.error(`Failed to import coin ${coin.id} to database`, JSON.stringify(error));
          })
      );
      Promise.all(createPromises)
        .then(() => {
          this.logger.info(`Imported ${normalized.length} coins to database`);
          this.notificationService.showInfo(`Imported ${normalized.length} coins to database`);
        })
        .catch((error) => {
          this.logger.error('Failed to import some coins to database', JSON.stringify(error));
          this.notificationService.showError('Failed to import some coins to database');
        });
    } catch (e) {
      this.logger.error('Failed to parse import data', String(e));
      this.notificationService.showError('Failed to parse import data');
    }
  }

  addTransaction(txn: TransactionRecord): void {
    this.transactions.set([...this.transactions(), txn]);

    firstValueFrom(this.apiService.createTransaction(txn))
      .then(() => this.logger.info(`Created transaction ${txn.id} in database`))
      .catch((error) => {
        this.logger.error(`Failed to create transaction in database`, JSON.stringify(error));
        this.notificationService.showError('Failed to save transaction to database');
      });
  }

  deleteTransaction(txnId: string): void {
    this.transactions.set(this.transactions().filter(t => t.id !== txnId));

    firstValueFrom(this.apiService.deleteTransaction(txnId))
      .then(() => this.logger.info(`Deleted transaction ${txnId} from database`))
      .catch((error) => {
        this.logger.error(`Failed to delete transaction from database`, JSON.stringify(error));
        this.notificationService.showError('Failed to delete transaction from database');
      });
  }

  updateSpotPrices(prices: SpotPrices): void {
    this.spotPrices.set(prices);
  }

  mergeCategoryOptions(names: string[]): void {
    const current = new Set(this.categoryOptions());
    let changed = false;
    for (const name of names) {
      const trimmed = name.trim();
      if (trimmed && !current.has(trimmed)) { current.add(trimmed); changed = true; }
    }
    if (!changed) return;
    this.categoryOptions.set([...current].sort());
  }

  removeCategoryOption(category: string): void {
    this.categoryOptions.set(this.categoryOptions().filter(o => o !== category));
  }

  addCoinSet(name: string): void {
    const current = this.coinSets();
    if (!current.includes(name)) {
      this.coinSets.set([...current, name].sort());
    }
  }

  removeCoinSet(name: string): void {
    this.coinSets.set(this.coinSets().filter(s => s !== name));
  }

  meltValue(coin: CoinRecord): number | null {
    const pmWeight = coin.pmWeightGrams ?? 0;
    const pmPct = coin.pmPercent ?? 0;
    const metal = (coin.metalContent ?? '').toLowerCase();

    if (pmWeight <= 0 || pmPct <= 0 || !metal) return null;

    const prices = this.spotPrices();
    const GRAMS_PER_TROY_OZ = 31.1035;

    let spotPerOz = 0;
    if (metal.includes('gold')) spotPerOz = prices.gold;
    else if (metal.includes('silver')) spotPerOz = prices.silver;
    else if (metal.includes('platinum')) spotPerOz = prices.platinum;
    else if (metal.includes('copper')) spotPerOz = prices.copper;

    if (spotPerOz <= 0) return null;

    return (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz;
  }

  ensureSelectedCoin(): void {
    if (this.inventory().length === 0) { this.selectedCoinId.set(null); return; }
    const current = this.selectedCoinId();
    if (!current || !this.inventory().some(c => c.id === current)) {
      this.selectedCoinId.set(this.inventory()[0].id);
    }
  }

  // ========================================
  // Denomination Management
  // ========================================

  async loadDenominations(): Promise<void> {
    try {
      const denominations = await firstValueFrom(this.apiService.getDenominations());
      this.denominations.set(denominations);
      this.logger.info(`Loaded ${denominations.length} denominations from database`);
    } catch (error) {
      this.logger.error('Failed to load denominations', JSON.stringify(error));
      this.notificationService.showError('Failed to load denominations');
    }
  }

  async addDenomination(d: Partial<Denomination>): Promise<void> {
    try {
      const created = await firstValueFrom(this.apiService.createDenomination(d));
      this.denominations.set([...this.denominations(), created]);
      this.logger.info(`Created denomination: ${created.label}`);
      this.notificationService.showInfo(`Added denomination: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create denomination', JSON.stringify(error));
      this.notificationService.showError('Failed to create denomination');
    }
  }

  async removeDenomination(id: number): Promise<void> {
    try {
      await firstValueFrom(this.apiService.deleteDenomination(id));
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

  async loadMintMarks(): Promise<void> {
    try {
      const mintMarks = await firstValueFrom(this.apiService.getMintMarks());
      this.mintMarks.set(mintMarks);
      this.logger.info(`Loaded ${mintMarks.length} mint marks from database`);
    } catch (error) {
      this.logger.error('Failed to load mint marks', JSON.stringify(error));
      this.notificationService.showError('Failed to load mint marks');
    }
  }

  async addMintMark(m: Partial<MintMarkOption>): Promise<void> {
    try {
      const created = await firstValueFrom(this.apiService.createMintMark(m));
      this.mintMarks.set([...this.mintMarks(), created]);
      this.logger.info(`Created mint mark: ${created.label}`);
      this.notificationService.showInfo(`Added mint mark: ${created.label}`);
    } catch (error) {
      this.logger.error('Failed to create mint mark', JSON.stringify(error));
      this.notificationService.showError('Failed to create mint mark');
    }
  }

  async removeMintMark(id: number): Promise<void> {
    try {
      await firstValueFrom(this.apiService.deleteMintMark(id));
      this.mintMarks.set(this.mintMarks().filter(m => m.mintMarkId !== id));
      this.logger.info(`Deleted mint mark: ${id}`);
      this.notificationService.showInfo('Mint mark removed');
    } catch (error) {
      this.logger.error('Failed to delete mint mark', JSON.stringify(error));
      this.notificationService.showError('Failed to delete mint mark');
    }
  }
}
