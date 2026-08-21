import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { ImageMatchingService } from './services/image-matching.service';
import { QuickenImportService } from './services/quicken-import.service';
import { StorageService } from './services/storage.service';

/**
 * Builds an `App` instance with fresh service instances, wired to the
 * IndexedDB stand-in reset in `beforeEach` below.
 *
 * `App`'s public surface is intentionally narrow (most members are
 * `protected`, exposed to the template but not to external callers).
 * Tests reach those members via bracket-notation property access
 * (`app['inventory']`) rather than dot access -- TypeScript only
 * enforces `protected`/`private` on dot access, so bracket access is the
 * conventional, compiler-sanctioned way to reach internal state from a
 * spec file without weakening the component's real API.
 */
function createApp(): App {
  return new App(new QuickenImportService(), new ImageMatchingService(), new StorageService());
}

describe('App', () => {
  beforeEach(() => {
    // Each test gets a brand-new, empty IndexedDB. App's storage hydration
    // runs asynchronously in the constructor, but only ever overwrites
    // signal state when it finds non-empty stored data -- against an
    // empty database it is always a no-op, so tests never race against it.
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('creates the app and starts with seeded inventory totals', () => {
    const app = createApp();

    expect(app).toBeTruthy();
    expect(app['inventory']().length).toBeGreaterThan(0);
    expect(app['totalCost']()).toBeGreaterThan(0);
    expect(app['totalValue']()).toBeGreaterThan(0);
  });

  it('imports Quicken records into the inventory', () => {
    const app = createApp();

    app['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\nMUS 1/2 Dime\n^`);

    app['importQuicken']();

    expect(app['importedRecords']()).toHaveLength(1);
    expect(app['inventory']().at(-1)?.name).toContain('Half Dime');
    expect(app['inventory']().at(-1)?.source).toBe('quicken');
  });

  it('defaults an imported coin\'s category to its Quicken account name', () => {
    const app = createApp();

    app['quickenText'].set(
      `!Account\nNCoin Collection\n^\n!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\nMUS 1/2 Dime\n^`
    );
    app['refreshQuickenAccounts']();

    app['importQuicken']();

    expect(app['inventory']().at(-1)?.category).toBe('Coin Collection');
    expect(app['categoryOptions']()).toContain('Coin Collection');
  });

  it('leaves category blank for an imported coin with no Quicken account', () => {
    const app = createApp();

    app['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\nMUS 1/2 Dime\n^`);

    app['importQuicken']();

    expect(app['inventory']().at(-1)?.category).toBe('');
  });

  it('adds and removes an admin-managed category option', () => {
    const app = createApp();

    app['onNewCategoryOptionChange']('Ancient Coins');
    app['addCategoryOptionFromDraft']();
    expect(app['categoryOptions']()).toContain('Ancient Coins');
    expect(app['newCategoryOption']()).toBe('');

    app['removeCategoryOption']('Ancient Coins');
    expect(app['categoryOptions']()).not.toContain('Ancient Coins');
  });

  it('defaults a newly added blank coin\'s category to empty', () => {
    const app = createApp();

    app['addBlankCoin']();

    expect(app['inventory']().at(-1)?.category).toBe('');
  });

  it('filters the image match list down to unmatched images only', () => {
    const app = createApp();

    app['imageMatches'].set([
      {
        imagePath: 'mercury_dime_1945.jpg',
        matchedRecordId: 'c-002',
        confidence: 0.92,
        reason: 'Matched Mercury Dime based on filename similarity.'
      },
      {
        imagePath: 'mystery_coin.jpg',
        matchedRecordId: null,
        confidence: 0,
        reason: 'No inventory record matched the image filename.'
      }
    ]);

    const unmatched = app['unmatchedImages']();

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].imagePath).toBe('mystery_coin.jpg');
  });

  it('tracks image matches from the selected files', () => {
    const app = createApp();
    const imageFile = new File(['image'], 'mercury_dime_1945.jpg', { type: 'image/jpeg' });

    const event = {
      target: {
        files: [imageFile]
      }
    } as unknown as Event;

    app['handleImageSelection'](event);

    expect(app['imageMatches']()).toHaveLength(1);
    expect(app['imageMatches']()[0].matchedRecordId).toBe('c-002');
    expect(app['imageMatches']()[0].confidence).toBeGreaterThan(0);
  });

  it('adds a blank coin and keeps the selected coin in sync', () => {
    const app = createApp();

    app['addBlankCoin']();

    expect(app['inventory']().at(-1)?.name).toBe('New Coin');
    expect(app.selectedCoin?.id).toBe(app['inventory']().at(-1)?.id);
  });

  it('selects and clears all Quicken accounts in one action', () => {
    const app = createApp();
    app['quickenAccounts'].set(['Checking', 'Savings', 'Brokerage']);

    app['toggleAllAccounts']();
    expect(app['selectedAccounts']()).toHaveLength(3);

    app['toggleAllAccounts']();
    expect(app['selectedAccounts']()).toHaveLength(0);
  });

  it('loads a Quicken file and imports the parsed record set', async () => {
    const app = createApp();
    const file = new File(
      ['!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\nMUS 1/2 Dime\n^'],
      'import.qif',
      { type: 'text/plain' }
    );

    await app['handleQuickenFileSelection']({ target: { files: [file] } } as unknown as Event);

    expect(app['importedRecords']()).toHaveLength(1);
    expect(app['importedRecords']()[0].name).toContain('Half Dime');
  });

  it('tracks a selected coin and manages its images from the detail view', async () => {
    const app = createApp();

    app['selectCoin']('c-002');
    expect(app.selectedCoin?.id).toBe('c-002');
    expect(app.selectedCoin?.grade).toBe('XF');

    await app['addCoinImages']({
      target: { files: [new File(['a'], 'front.jpg', { type: 'image/jpeg' })] }
    } as unknown as Event);
    expect(
      app.selectedCoin?.imagePaths.some((path) => path.includes('data:') || path.endsWith('front.jpg'))
    ).toBe(true);

    app['removeCoinImage'](app.selectedCoin?.imagePaths[app.selectedCoin.imagePaths.length - 1] ?? '');
    expect(
      app.selectedCoin?.imagePaths.some((path) => path.includes('data:') || path.endsWith('front.jpg'))
    ).toBe(false);
  });

  it('deletes the selected coin from the inventory', () => {
    const app = createApp();
    app['selectCoin']('c-002');

    app['deleteSelectedCoin']();

    expect(app['inventory']().some((coin) => coin.id === 'c-002')).toBe(false);
    expect(app.selectedCoin?.id).toBe('c-001');
  });

  it('exports and imports the inventory JSON payload', async () => {
    const app = createApp();
    const payload = JSON.stringify(app['inventory']());

    const exportData = app['exportInventoryData']();
    expect(exportData).toBe(payload);

    const replacement = [
      {
        id: 'new-1',
        name: 'Test Coin',
        denomination: 'Dollar',
        year: 2024,
        type: 'Test',
        category: 'Test Category',
        country: 'United States',
        grade: 'MS65',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '2024-01-01',
        purchasePrice: 10,
        currentValue: 15,
        notes: 'Imported from JSON',
        imagePaths: [],
        tags: ['test'],
        source: 'manual'
      }
    ] as const;

    await app['importInventoryData'](JSON.stringify(replacement));
    expect(app['inventory']()).toHaveLength(1);
    expect(app['inventory']()[0].name).toBe('Test Coin');
    expect(app['categoryOptions']()).toContain('Test Category');
  });

  it('groups preview records by account and supports manual review assignment', () => {
    const app = createApp();
    app['importedRecords'].set([
      {
        id: 'r1',
        name: 'Mercury Dime',
        denomination: 'Dime',
        account: 'Checking',
        purchasePrice: 10,
        currentValue: 12,
        country: 'United States',
        type: 'Mercury',
        notes: '',
        source: 'quicken'
      },
      {
        id: 'r2',
        name: 'Liberty Head Double Eagle',
        denomination: '20 Dollar',
        account: 'Savings',
        purchasePrice: 1800,
        currentValue: 1900,
        country: 'United States',
        type: 'Liberty Head',
        notes: '',
        source: 'quicken'
      }
    ]);

    const grouped = app['groupedImportedRecords']();
    expect(Object.keys(grouped)).toEqual(expect.arrayContaining(['Checking', 'Savings']));

    app['imageMatches'].set([
      {
        imagePath: 'unknown_coin.jpg',
        matchedRecordId: null,
        confidence: 0.25,
        reason: 'No inventory record matched the image filename.'
      }
    ]);

    app['assignManualReviewMatch']('unknown_coin.jpg', 'c-002');
    expect(app['manualReviewMatches']().length).toBe(0);
    expect(app['imageMatches']()[0].matchedRecordId).toBe('c-002');
  });

  it('filters the inventory table by search text', () => {
    const app = createApp();

    app['onSearchQueryChange']('mercury');

    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Mercury Dime');
  });

  it('filters the inventory table by category', () => {
    const app = createApp();

    app['onCategoryFilterChange']('Gold Coin');

    const results = app['filteredInventory']();
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Gold Coin');
  });

  it('sorts the inventory table and flips direction on repeat clicks', () => {
    const app = createApp();

    app['setSortColumn']('currentValue');
    let results = app['filteredInventory']();
    expect(results[0].currentValue).toBeLessThan(results.at(-1)!.currentValue);

    app['setSortColumn']('currentValue');
    results = app['filteredInventory']();
    expect(results[0].currentValue).toBeGreaterThan(results.at(-1)!.currentValue);
  });

  it('builds a certification badge label only when cert data is present', () => {
    const app = createApp();
    const certified = app['inventory']().find((coin) => coin.id === 'c-001')!;
    const uncertified = app['inventory']().find((coin) => coin.id === 'c-002')!;

    expect(app['certBadgeLabel'](certified)).toBe('NGC #255481-016');
    expect(app['certBadgeLabel'](uncertified)).toBeNull();
  });
});
