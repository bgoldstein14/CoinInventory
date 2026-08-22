import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { CsvService } from './services/csv.service';
import { InventoryService } from './services/inventory.service';
import { StorageService } from './services/storage.service';
import { CoinRecord } from './types/coin.model';

function createApp(): App {
  const storage = new StorageService();
  return new App(storage, new InventoryService(storage), new CsvService());
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
    expect(coin.name).toBe('New Coin');
    expect(coin.category).toBe('');
    expect(coin.grade).toBe('');
    expect(coin.source).toBe('manual');
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('deletes the selected coin from the inventory', () => {
    const app = createApp();
    const coin = addTestCoin(app, { name: 'Doomed Coin' });
    app['selectCoin'](coin.id);

    app['deleteSelectedCoin']();

    expect(app['inv'].inventory().some(c => c.id === coin.id)).toBe(false);
  });

  it('imports inventory JSON data', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Test Coin', category: 'Test Category', grade: 'MS65' });

    const exported = JSON.stringify(app['inv'].inventory());
    expect(exported).toContain('Test Coin');

    const replacement = [{
      id: 'new-1', name: 'Imported Coin', denomination: 'Dollar', year: 2024,
      type: 'Test', category: 'Imported Category', country: 'United States',
      grade: 'MS65', certCompany: '', certNumber: '', variety: '', mintMark: '',
      composition: '', purchaseDate: '2024-01-01', purchasePrice: 10,
      currentValue: 15, notes: '', imagePaths: [], tags: ['test'], source: 'manual'
    }] as const;

    app['inv'].importInventoryData(JSON.stringify(replacement));
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].name).toBe('Imported Coin');
    expect(app['inv'].categoryOptions()).toContain('Imported Category');
  });

  it('filters the inventory table by search text', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Mercury Dime' });
    addTestCoin(app, { name: 'Liberty Eagle' });

    app['onSearchQueryChange']('mercury');
    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Mercury Dime');
  });

  it('filters the inventory table by category', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Gold Coin', category: 'Gold' });
    addTestCoin(app, { name: 'Silver Coin', category: 'Silver' });

    app['onCategoryFilterChange']('Gold');
    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Gold');
  });

  it('sorts the inventory table and flips direction on repeat clicks', () => {
    const app = createApp();
    addTestCoin(app, { name: 'A', currentValue: 10 });
    addTestCoin(app, { name: 'B', currentValue: 50 });

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
    const coin = addTestCoin(app, { name: 'Test Coin' });
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
    const coin1 = addTestCoin(app, { name: 'Coin A' });
    const coin2 = addTestCoin(app, { name: 'Coin B' });

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
    addTestCoin(app, { name: 'Coin A' });
    addTestCoin(app, { name: 'Coin B' });
    addTestCoin(app, { name: 'Coin C' });

    app['toggleAllCoins']();
    expect(app['selectionCount']()).toBe(3);
    expect(app['allVisibleSelected']()).toBe(true);

    app['toggleAllCoins']();
    expect(app['selectionCount']()).toBe(0);
  });

  it('clears selection explicitly', () => {
    const app = createApp();
    const coin = addTestCoin(app, { name: 'Coin A' });
    const mockEvent = { stopPropagation: () => {}, shiftKey: false } as MouseEvent;

    app['toggleCoinSelection'](coin.id, mockEvent);
    expect(app['selectionCount']()).toBe(1);

    app['clearSelection']();
    expect(app['selectionCount']()).toBe(0);
  });

  it('bulk updates a field across selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { name: 'Coin A', category: '' });
    const coin2 = addTestCoin(app, { name: 'Coin B', category: '' });
    addTestCoin(app, { name: 'Coin C', category: '' });

    app['selectedCoinIds'].set(new Set([coin1.id, coin2.id]));
    app['bulkUpdateField']('category', 'Gold');

    expect(app['inv'].inventory().find(c => c.id === coin1.id)!.category).toBe('Gold');
    expect(app['inv'].inventory().find(c => c.id === coin2.id)!.category).toBe('Gold');
    expect(app['inv'].inventory()[2].category).toBe('');
  });

  it('bulk deletes selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { name: 'Keep' });
    const coin2 = addTestCoin(app, { name: 'Delete Me' });
    const coin3 = addTestCoin(app, { name: 'Also Delete' });

    app['selectedCoinIds'].set(new Set([coin2.id, coin3.id]));
    app['bulkDeleteCoins']();

    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].name).toBe('Keep');
    expect(app['selectionCount']()).toBe(0);
  });

  // --- Advanced filters ---

  it('filters by grade prefix', () => {
    const app = createApp();
    addTestCoin(app, { name: 'MS Coin', grade: 'MS65' });
    addTestCoin(app, { name: 'VF Coin', grade: 'VF30' });

    app['gradeFilter'].set('MS');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].name).toBe('MS Coin');
  });

  it('filters by value range', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Cheap', currentValue: 5 });
    addTestCoin(app, { name: 'Mid', currentValue: 50 });
    addTestCoin(app, { name: 'Expensive', currentValue: 500 });

    app['valueMinFilter'].set('10');
    app['valueMaxFilter'].set('100');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].name).toBe('Mid');
  });

  it('filters by source', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Manual Coin', source: 'manual' });
    addTestCoin(app, { name: 'Quicken Coin', source: 'quicken' });

    app['sourceFilter'].set('quicken');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].source).toBe('quicken');
  });

  it('filters by country', () => {
    const app = createApp();
    addTestCoin(app, { name: 'US Coin', country: 'United States' });
    addTestCoin(app, { name: 'UK Coin', country: 'United Kingdom' });

    app['countryFilter'].set('United Kingdom');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].country).toBe('United Kingdom');
  });

  it('filters by coin set', () => {
    const app = createApp();
    app['inv'].addCoinSet('Set A');

    addTestCoin(app, { name: 'In Set', coinSet: 'Set A' });
    addTestCoin(app, { name: 'Not in Set' });

    app['coinSetFilter'].set('Set A');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].name).toBe('In Set');
  });

  it('filters by dealer', () => {
    const app = createApp();
    addTestCoin(app, { name: 'Heritage Coin', dealer: 'Heritage' });
    addTestCoin(app, { name: 'Other Coin', dealer: 'Stack' });

    app['dealerFilter'].set('heritage');
    expect(app['filteredInventory']()).toHaveLength(1);
    expect(app['filteredInventory']()[0].name).toBe('Heritage Coin');
  });

  // --- Valuation ---

  it('computes total profit/loss', () => {
    const app = createApp();
    addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    addTestCoin(app, { purchasePrice: 200, currentValue: 180 });

    expect(app['inv'].totalProfit()).toBe(30);
  });

  it('formats profit/loss cell correctly', () => {
    const app = createApp();
    const coin = addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    expect(app['formatInventoryCell'](coin, 'profitLoss')).toBe('+$50.00');

    const lossCoin = addTestCoin(app, { purchasePrice: 200, currentValue: 180 });
    expect(app['formatInventoryCell'](lossCoin, 'profitLoss')).toBe('-$20.00');
  });

  it('returns correct profit/loss CSS class', () => {
    const app = createApp();
    const gainCoin = addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    expect(app['profitLossClass'](gainCoin)).toBe('gain');

    const lossCoin = addTestCoin(app, { purchasePrice: 200, currentValue: 180 });
    expect(app['profitLossClass'](lossCoin)).toBe('loss');

    const evenCoin = addTestCoin(app, { purchasePrice: 100, currentValue: 100 });
    expect(app['profitLossClass'](evenCoin)).toBe('');
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

    const coin = addTestCoin(app, { metalContent: 'Gold', weight: 0.5 });
    expect(app['meltValue'](coin)).toBe(1000);
  });

  it('returns null melt value when weight or metal is missing', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    const noWeight = addTestCoin(app, { metalContent: 'Gold' });
    expect(app['meltValue'](noWeight)).toBeNull();

    const noMetal = addTestCoin(app, { weight: 0.5 });
    expect(app['meltValue'](noMetal)).toBeNull();
  });

  // --- Transactions ---

  it('adds and deletes transactions for a coin', () => {
    const app = createApp();
    const coin = addTestCoin(app, { name: 'Test Coin' });
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
    const coin = addTestCoin(app, { name: 'Doomed Coin' });
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
    const coins: CoinRecord[] = [{
      id: 'q1', name: 'Quicken Coin', denomination: 'Dime', year: null,
      type: '', category: 'Coins', country: 'US', grade: 'Unknown',
      certCompany: '', certNumber: '', variety: '', mintMark: '',
      composition: '', purchaseDate: '2024-01-01', purchasePrice: 12.50,
      currentValue: 12.50, notes: '', imagePaths: [], tags: [],
      source: 'quicken', hasCacSticker: false
    }];

    app['onQuickenImported'](coins);
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].name).toBe('Quicken Coin');
  });
});
