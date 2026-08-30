import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { CsvService } from './services/csv.service';
import { CoinRecord } from './types/coin.model';
import { createTestInventoryService } from './testing/test-helpers';

/**
 * Creates an App instance with all dependencies properly wired up.
 *
 * InventoryService uses Angular's inject() function internally, so it must be
 * created inside an injection context with all its dependencies provided.
 * The createTestInventoryService() helper handles this setup.
 */
function createApp(): App {
  const { inv, storage } = createTestInventoryService();
  return new App(storage, inv, new CsvService());
}

function addTestCoin(app: App, overrides: Partial<CoinRecord> = {}): CoinRecord {
  app['addBlankCoin']();
  const coin = app['inv'].inventory().at(-1)!;
  if (Object.keys(overrides).length > 0) {
    app['inv'].updateCoin(coin.id, overrides);
  }
  return app['inv'].inventory().find(c => c.id === coin.id)!;
}

describe('App', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('starts with an empty inventory', () => {
    const app = createApp();
    expect(app['inv'].inventory()).toHaveLength(0);
    expect(app['inv'].totalCost()).toBe(0);
    expect(app['inv'].totalValue()).toBe(0);
    expect(app['inv'].totalProfit()).toBe(0);
  });

  it('adds a blank coin with sensible defaults', () => {
    const app = createApp();
    app['addBlankCoin']();

    const coin = app['inv'].inventory().at(-1)!;
    // CoinRecord no longer has a 'name' field - it's derived from denomination/coinType/year
    expect(coin.denomination).toBe('');
    expect(coin.coinType).toBe('');
    expect(coin.category).toBe('');
    expect(coin.grade).toBe('');
    expect(coin.source).toBe('manual');
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('deletes the selected coin from the inventory', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    app['selectCoin'](coin.id);

    app['deleteSelectedCoin']();

    expect(app['inv'].inventory().some(c => c.id === coin.id)).toBe(false);
  });

  it('imports inventory JSON data', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Dime', coinType: 'Mercury', category: 'Test Category', grade: 'MS65' });

    const exported = JSON.stringify(app['inv'].inventory());
    expect(exported).toContain('Mercury');

    // Updated CoinRecord structure: no 'name', 'type' -> 'coinType', year is string
    const replacement = [{
      id: 'new-1', denomination: 'Dollar', year: '2024', coinType: 'Test',
      category: 'Imported Category', country: 'United States', grade: 'MS65',
      certCompany: '', certNumber: '', variety: '', mintMark: '',
      composition: '', purchaseDate: '2024-01-01', purchasePrice: 10,
      currentValue: 15, notes: '', imagePaths: [], tags: ['test'], source: 'manual'
    }] as const;

    app['inv'].importInventoryData(JSON.stringify(replacement));
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].denomination).toBe('Dollar');
    expect(app['inv'].inventory()[0].coinType).toBe('Test');
    expect(app['inv'].categoryOptions()).toContain('Imported Category');
  });

  it('filters the inventory table by search text', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Dime', coinType: 'Mercury' });
    addTestCoin(app, { denomination: 'Eagle', coinType: 'Liberty' });

    app['onSearchQueryChange']('mercury');
    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].coinType).toBe('Mercury');
  });

  it('filters the inventory table by category', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Eagle', category: 'Gold' });
    addTestCoin(app, { denomination: 'Dollar', category: 'Silver' });

    app['onCategoryFilterChange']('Gold');
    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Gold');
  });

  it('sorts the inventory table and flips direction on repeat clicks', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Cent', currentValue: 10 });
    addTestCoin(app, { denomination: 'Dollar', currentValue: 50 });

    app['setSortColumn']('currentValue');
    let results = app['filteredInventory']();
    expect(results[0].currentValue).toBeLessThan(results.at(-1)!.currentValue);

    app['setSortColumn']('currentValue');
    results = app['filteredInventory']();
    expect(results[0].currentValue).toBeGreaterThan(results.at(-1)!.currentValue);
  });

  it('builds a certification badge label only when cert data is present', () => {
    const app = createApp();
    const certified = addTestCoin(app, { certCompany: 'NGC', certNumber: '255481-016' });
    const uncertified = addTestCoin(app, { certCompany: '', certNumber: '' });

    expect(app['certBadgeLabel'](certified)).toBe('NGC #255481-016');
    expect(app['certBadgeLabel'](uncertified)).toBeNull();
  });

  // --- Modal controls ---

  it('opens and closes the Quicken import modal', () => {
    const app = createApp();
    expect(app['showQuickenModal']()).toBe(false);

    app['openQuickenModal']();
    expect(app['showQuickenModal']()).toBe(true);

    app['closeQuickenModal']();
    expect(app['showQuickenModal']()).toBe(false);
  });

  it('opens and closes the image import modal', () => {
    const app = createApp();
    app['openImageImportModal']();
    expect(app['showImageImportModal']()).toBe(true);

    app['closeImageImportModal']();
    expect(app['showImageImportModal']()).toBe(false);
  });

  it('opens and closes the category management modal', () => {
    const app = createApp();
    app['openCategoryModal']();
    expect(app['showCategoryModal']()).toBe(true);

    app['closeCategoryModal']();
    expect(app['showCategoryModal']()).toBe(false);
  });

  it('opens and closes the CSV import modal', () => {
    const app = createApp();
    app['openCsvImportModal']();
    expect(app['showCsvImportModal']()).toBe(true);

    app['closeCsvImportModal']();
    expect(app['showCsvImportModal']()).toBe(false);
  });

  it('opens and closes the report modal', () => {
    const app = createApp();
    app['openReportModal']();
    expect(app['showReportModal']()).toBe(true);

    app['closeReportModal']();
    expect(app['showReportModal']()).toBe(false);
  });

  it('opens and closes the spot price modal', () => {
    const app = createApp();
    app['openSpotPriceModal']();
    expect(app['showSpotPriceModal']()).toBe(true);

    app['closeSpotPriceModal']();
    expect(app['showSpotPriceModal']()).toBe(false);
  });

  it('toggles the column picker visibility', () => {
    const app = createApp();
    expect(app['showColumnPicker']()).toBe(false);

    app['toggleColumnPicker']();
    expect(app['showColumnPicker']()).toBe(true);

    app['toggleColumnPicker']();
    expect(app['showColumnPicker']()).toBe(false);
  });

  it('toggles the advanced filters panel', () => {
    const app = createApp();
    expect(app['showAdvancedFilters']()).toBe(false);

    app['toggleAdvancedFilters']();
    expect(app['showAdvancedFilters']()).toBe(true);
  });

  // --- Per-coin images ---

  it('tracks a selected coin and manages its images', async () => {
    const app = createApp();
    await app['ready']; // Wait for hydration to finish before adding test data
    const coin = addTestCoin(app, { denomination: 'Eagle', coinType: 'Gold' });
    app['selectCoin'](coin.id);

    await app['addCoinImages']({
      target: { files: [new File(['a'], 'front.jpg', { type: 'image/jpeg' })] }
    } as unknown as Event);
    expect(
      app.selectedCoin?.imagePaths.some(p => p.includes('data:') || p.endsWith('front.jpg'))
    ).toBe(true);

    app['removeCoinImage'](app.selectedCoin?.imagePaths[app.selectedCoin.imagePaths.length - 1] ?? '');
    expect(
      app.selectedCoin?.imagePaths.some(p => p.includes('data:') || p.endsWith('front.jpg'))
    ).toBe(false);
  });

  // --- Multi-select & Bulk edit ---

  it('selects and deselects coins individually', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Quarter' });
    const coin2 = addTestCoin(app, { denomination: 'Dime' });

    const mockEvent = { stopPropagation: () => {}, shiftKey: false } as MouseEvent;

    app['toggleCoinSelection'](coin1.id, mockEvent);
    expect(app['isCoinSelected'](coin1.id)).toBe(true);
    expect(app['selectionCount']()).toBe(1);

    app['toggleCoinSelection'](coin2.id, mockEvent);
    expect(app['selectionCount']()).toBe(2);

    app['toggleCoinSelection'](coin1.id, mockEvent);
    expect(app['isCoinSelected'](coin1.id)).toBe(false);
    expect(app['selectionCount']()).toBe(1);
  });

  it('selects and clears all visible coins', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter' });
    addTestCoin(app, { denomination: 'Dime' });
    addTestCoin(app, { denomination: 'Nickel' });

    app['toggleAllCoins']();
    expect(app['selectionCount']()).toBe(3);
    expect(app['allVisibleSelected']()).toBe(true);

    app['toggleAllCoins']();
    expect(app['selectionCount']()).toBe(0);
  });

  it('clears selection explicitly', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter' });
    const mockEvent = { stopPropagation: () => {}, shiftKey: false } as MouseEvent;

    app['toggleCoinSelection'](coin.id, mockEvent);
    expect(app['selectionCount']()).toBe(1);

    app['clearSelection']();
    expect(app['selectionCount']()).toBe(0);
  });

  it('bulk updates a field across selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Quarter', category: '' });
    const coin2 = addTestCoin(app, { denomination: 'Dime', category: '' });
    addTestCoin(app, { denomination: 'Nickel', category: '' });

    app['selectedCoinIds'].set(new Set([coin1.id, coin2.id]));
    app['bulkUpdateField']('category', 'Gold');

    expect(app['inv'].inventory().find(c => c.id === coin1.id)!.category).toBe('Gold');
    expect(app['inv'].inventory().find(c => c.id === coin2.id)!.category).toBe('Gold');
    expect(app['inv'].inventory()[2].category).toBe('');
  });

  it('bulk deletes selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Keep' });
    const coin2 = addTestCoin(app, { denomination: 'Delete Me' });
    const coin3 = addTestCoin(app, { denomination: 'Also Delete' });

    app['selectedCoinIds'].set(new Set([coin2.id, coin3.id]));
    app['bulkDeleteCoins']();

    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].denomination).toBe('Keep');
    expect(app['selectionCount']()).toBe(0);
  });

  // --- Advanced filters ---

  it('filters by grade prefix', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', grade: 'MS65' });
    addTestCoin(app, { denomination: 'Dime', grade: 'VF30' });

    app['gradeFilter'].set('MS');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].grade).toBe('MS65');
  });

  it('filters by value range', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Cent', currentValue: 5 });
    addTestCoin(app, { denomination: 'Quarter', currentValue: 50 });
    addTestCoin(app, { denomination: 'Eagle', currentValue: 500 });

    app['valueMinFilter'].set('10');
    app['valueMaxFilter'].set('100');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].currentValue).toBe(50);
  });

  it('filters by source', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', source: 'manual' });
    addTestCoin(app, { denomination: 'Dime', source: 'quicken' });

    app['sourceFilter'].set('quicken');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].source).toBe('quicken');
  });

  it('filters by country', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', country: 'United States' });
    addTestCoin(app, { denomination: 'Shilling', country: 'United Kingdom' });

    app['countryFilter'].set('United Kingdom');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].country).toBe('United Kingdom');
  });

  it('filters by coin set', () => {
    const app = createApp();
    app['inv'].addCoinSet('Set A');

    addTestCoin(app, { denomination: 'Quarter', coinSet: 'Set A' });
    addTestCoin(app, { denomination: 'Dime' });

    app['coinSetFilter'].set('Set A');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].coinSet).toBe('Set A');
  });

  it('filters by dealer', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Eagle', dealer: 'Heritage' });
    addTestCoin(app, { denomination: 'Dollar', dealer: 'Stack' });

    app['dealerFilter'].set('heritage');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].dealer).toBe('Heritage');
  });

  // --- Valuation ---

  it('computes total profit/loss', () => {
    const app = createApp();
    addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    addTestCoin(app, { purchasePrice: 200, currentValue: 180 });

    expect(app['inv'].totalProfit()).toBe(30);
  });


  it('returns correct grade badge class', () => {
    const app = createApp();
    expect(app['gradeBadgeClass']('MS65')).toContain('badge--mint');
    expect(app['gradeBadgeClass']('VF')).toContain('badge--circulated');
    expect(app['gradeBadgeClass']('G')).toContain('badge--worn');
    expect(app['gradeBadgeClass']('')).toContain('badge--ungraded');
  });

  // --- Spot prices & melt value ---

  it('calculates melt value for gold coins', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    // Melt value now uses pmWeightGrams and pmPercent instead of weight
    // pmWeightGrams: 15.55175 grams (exactly 0.5 troy oz), pmPercent: 90 (90% gold)
    const coin = addTestCoin(app, {
      metalContent: 'Gold',
      pmWeightGrams: 15.55175,
      pmPercent: 90
    });
    // Expected: (15.55175 / 31.1035) * (90 / 100) * 2000 = 0.5 * 0.9 * 2000 = 900
    expect(app['meltValue'](coin)).toBeCloseTo(900, 1);
  });

  it('returns null melt value when weight or metal is missing', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    // Missing pmWeightGrams
    const noWeight = addTestCoin(app, { metalContent: 'Gold', pmPercent: 90 });
    expect(app['meltValue'](noWeight)).toBeNull();

    // Missing metalContent
    const noMetal = addTestCoin(app, { pmWeightGrams: 15.5175, pmPercent: 90 });
    expect(app['meltValue'](noMetal)).toBeNull();
  });

  // --- Transactions ---

  it('adds and deletes transactions for a coin', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Eagle', coinType: 'Gold' });
    app['selectCoin'](coin.id);

    app['addTransactionForSelectedCoin']('purchase', 150, 'Heritage Auctions', '2024-01-15', 'Great deal');

    const txns = app['inv'].selectedCoinTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('purchase');
    expect(txns[0].amount).toBe(150);
    expect(txns[0].dealer).toBe('Heritage Auctions');

    app['deleteTransaction'](txns[0].id);
    expect(app['inv'].selectedCoinTransactions()).toHaveLength(0);
  });

  it('deleting a coin also removes its transactions', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    app['selectCoin'](coin.id);

    app['addTransactionForSelectedCoin']('purchase', 100, '', '', '');
    expect(app['inv'].transactions()).toHaveLength(1);

    app['deleteSelectedCoin']();
    expect(app['inv'].transactions()).toHaveLength(0);
  });

  // --- Column formatting ---

  it('formats dealer and coinSet columns', () => {
    const app = createApp();
    const coin = addTestCoin(app, { dealer: 'Heritage', coinSet: 'Morgan Set' });
    expect(app['formatInventoryCell'](coin, 'dealer')).toBe('Heritage');
    expect(app['formatInventoryCell'](coin, 'coinSet')).toBe('Morgan Set');
  });

  it('formats sold price and weight columns', () => {
    const app = createApp();
    const coin = addTestCoin(app, { soldPrice: 250, weight: 0.7734 });
    expect(app['formatInventoryCell'](coin, 'soldPrice')).toBe('$250.00');
    expect(app['formatInventoryCell'](coin, 'weight')).toBe('0.7734');
  });

  // --- onQuickenImported ---

  it('adds coins via onQuickenImported callback', () => {
    const app = createApp();
    // Updated CoinRecord structure: no 'name', 'type' -> 'coinType', year is string
    const coins: CoinRecord[] = [{
      id: 'q1', denomination: 'Dime', year: '1964', coinType: 'Roosevelt',
      category: 'Coins', country: 'US', grade: 'Unknown',
      certCompany: '', certNumber: '', variety: '', mintMark: '',
      composition: '', purchaseDate: '2024-01-01', purchasePrice: 12.50,
      currentValue: 12.50, notes: '', imagePaths: [], tags: [],
      source: 'quicken', hasCacSticker: false
    }];

    app['onQuickenImported'](coins);
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].denomination).toBe('Dime');
    expect(app['inv'].inventory()[0].coinType).toBe('Roosevelt');
  });
});
