import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { App } from './app';
import { ImageMatchingService } from './services/image-matching.service';
import { QuickenImportService } from './services/quicken-import.service';

describe('App', () => {
  it('creates the app and starts with seeded inventory totals', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());

    expect(app).toBeTruthy();
    expect(app['inventory']().length).toBeGreaterThan(0);
    expect(app['totalCost']()).toBeGreaterThan(0);
    expect(app['totalValue']()).toBeGreaterThan(0);
  });

  it('imports Quicken records into the inventory', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());

    app['quickenText'].set(`!Type:Invst
D2024-02-01
NUS Half Dime
T12.50
MUS 1/2 Dime
YCoin Collection
^`);

    app.importQuicken();

    expect(app['importedRecords']()).toHaveLength(1);
    expect(app['inventory']().at(-1)?.name).toContain('Half Dime');
    expect(app['inventory']().at(-1)?.source).toBe('quicken');
  });

  it('filters the image match list down to unmatched images only', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());

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

    const unmatched = app.unmatchedImages();

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].imagePath).toBe('mystery_coin.jpg');
  });

  it('tracks image matches from the selected files', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
    const imageFile = new File(['image'], 'mercury_dime_1945.jpg', { type: 'image/jpeg' });

    const event = {
      target: {
        files: [imageFile]
      }
    } as unknown as Event;

    app.handleImageSelection(event);

    expect(app['imageMatches']()).toHaveLength(1);
    expect(app['imageMatches']()[0].matchedRecordId).toBe('c-002');
    expect(app['imageMatches']()[0].confidence).toBeGreaterThan(0);
  });

  it('adds a blank coin and keeps the selected coin in sync', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());

    app.addBlankCoin();

    expect(app.inventory().at(-1)?.name).toBe('New Coin');
    expect(app.selectedCoin?.id).toBe(app.inventory().at(-1)?.id);
  });

  it('selects and clears all Quicken accounts in one action', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
    app['quickenAccounts'].set(['Checking', 'Savings', 'Brokerage']);

    app.toggleAllAccounts();
    expect(app['selectedAccounts']()).toHaveLength(3);

    app.toggleAllAccounts();
    expect(app['selectedAccounts']()).toHaveLength(0);
  });

  it('loads a Quicken file and imports the parsed record set', async () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
    const file = new File([
      '!Type:Invst\nD2024-02-01\nNUS Half Dime\nT12.50\nMUS 1/2 Dime\nYCoin Collection\n^'
    ], 'import.qif', { type: 'text/plain' });

    await app.handleQuickenFileSelection({ target: { files: [file] } } as unknown as Event);

    expect(app['importedRecords']()).toHaveLength(1);
    expect(app['importedRecords']()[0].name).toContain('Half Dime');
  });

  it('tracks a selected coin and manages its images from the detail view', async () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());

    app.selectCoin('c-002');
    expect(app.selectedCoin?.id).toBe('c-002');
    expect(app.selectedCoin?.grade).toBe('XF');

    await app.addCoinImages({ target: { files: [new File(['a'], 'front.jpg', { type: 'image/jpeg' })] } } as unknown as Event);
    expect(app.selectedCoin?.imagePaths.some((path) => path.includes('data:') || path.endsWith('front.jpg'))).toBe(true);

    app.removeCoinImage(app.selectedCoin?.imagePaths[app.selectedCoin.imagePaths.length - 1] ?? '');
    expect(app.selectedCoin?.imagePaths.some((path) => path.includes('data:') || path.endsWith('front.jpg'))).toBe(false);
  });

  it('deletes the selected coin from the inventory', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
    app.selectCoin('c-002');

    app.deleteSelectedCoin();

    expect(app.inventory().some((coin) => coin.id === 'c-002')).toBe(false);
    expect(app.selectedCoin?.id).toBe('c-001');
  });

  it('exports and imports the inventory JSON payload', async () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
    const payload = JSON.stringify(app.inventory());

    const exportData = app.exportInventoryData();
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

    await app.importInventoryData(JSON.stringify(replacement));
    expect(app.inventory()).toHaveLength(1);
    expect(app.inventory()[0].name).toBe('Test Coin');
  });

  it('groups preview records by account and supports manual review assignment', () => {
    const app = new App(new QuickenImportService(), new ImageMatchingService());
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

    app.assignManualReviewMatch('unknown_coin.jpg', 'c-002');
    expect(app['manualReviewMatches']().length).toBe(0);
    expect(app['imageMatches']()[0].matchedRecordId).toBe('c-002');
  });
});
