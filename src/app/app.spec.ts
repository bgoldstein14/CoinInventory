import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { App } from './app';
import { CoinDetailPanel } from './components/coin-detail-panel/coin-detail-panel';
import { formatMeltValue } from './types/inventory-columns';
import { parseDenominationValue } from './features/inventory/denomination-sort';
import { CsvService } from './services/csv.service';
import { InventoryService } from './services/inventory.service';
// Imported via the QIF service so the draft tests catch the import path
// diverging from the shared completeness rule.
import { checkMainCoinDetails } from './services/quicken-import.service';
import { CoinRecord } from './types/coin.model';
import {
  certBadgeLabel, defaultVisibleColumns, formatDenominationDisplay,
  formatInventoryCell, gradeBadgeClass
} from './types/inventory-columns';
import { StorageKeys } from './services/storage.service';
import { createTestInventoryService } from './testing/test-helpers';

/**
 * Creates an App wired to a test InventoryService. Shared state is reached
 * through its stores: app['filters'], ['columns'], ['selection'], ['images'].
 */
function createApp(): App {
  const { inv, storage } = createTestInventoryService();
  return new App(storage, inv, new CsvService());
}

/** Creates a CoinDetailPanel sharing the App's InventoryService (built in an injection context). */
function createDetailPanelFor(inv: InventoryService): CoinDetailPanel {
  const injector = Injector.create({
    providers: [{ provide: InventoryService, useValue: inv }]
  });
  return runInInjectionContext(injector, () => new CoinDetailPanel());
}


/** Builds a complete CoinRecord for tests that set InventoryService state directly. */
function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Quarter', year: '2024', coinType: 'Washington',
    category: 'Silver', country: 'United States', grade: 'MS65', certCompany: '',
    certNumber: '', variety: '', mintMark: 'P', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  };
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

  it('debounces coin updates before writing to the database', () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([{ id: 'coin-1', denomination: 'Quarter', year: '2024', coinType: 'Washington', category: 'Silver', country: 'United States', grade: 'MS65', certCompany: '', certNumber: '', variety: '', mintMark: 'P', composition: '', purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15, notes: '', imagePaths: [], source: 'manual', hasCacSticker: false }]);

      inv.updateCoin('coin-1', { year: '2024' });
      inv.updateCoin('coin-1', { year: '2025' });
      inv.updateCoin('coin-1', { notes: 'Needs cleanup' });

      expect(mockApiService.updateCoin).not.toHaveBeenCalled();

      vi.advanceTimersByTime(999);
      expect(mockApiService.updateCoin).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
      expect(mockApiService.updateCoin).toHaveBeenCalledWith('coin-1', { year: '2025', notes: 'Needs cleanup' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('only sends fields that actually changed', () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([{ id: 'coin-1', denomination: 'Quarter', year: '2024', coinType: 'Washington', category: 'Silver', country: 'United States', grade: 'MS65', certCompany: '', certNumber: '', variety: '', mintMark: 'P', composition: '', purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15, notes: 'Existing', imagePaths: [], source: 'manual', hasCacSticker: false }]);

      inv.updateCoin('coin-1', { year: '2024', notes: 'Existing' });
      inv.updateCoin('coin-1', { year: '2025' });

      expect(mockApiService.updateCoin).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
      expect(mockApiService.updateCoin).toHaveBeenCalledWith('coin-1', { year: '2025' });
    } finally {
      vi.useRealTimers();
    }
  });

  // A failed save must stay recoverable: updateCoin() diffs against the last
  // server-confirmed value, so a retry after a failed PUT still sends the edit.

  it('re-sends the same value after a failed save (a retry must actually retry)', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([makeCoin({ grade: 'MS65' })]);

      // --- Attempt 1: the backend is down, so the PUT rejects. ---
      (mockApiService.updateCoin as any).mockReturnValue(throwError(() => new Error('server down')));

      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
      expect(mockApiService.updateCoin).toHaveBeenLastCalledWith('coin-1', { grade: 'MS66' });

      // --- The backend comes back up. ---
      (mockApiService.updateCoin as any).mockReturnValue(of(undefined));

      // --- Attempt 2: the user re-enters the IDENTICAL value to retry. ---
      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);

      // A second request must be issued.
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(2);
      expect(mockApiService.updateCoin).toHaveBeenLastCalledWith('coin-1', { grade: 'MS66' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops re-sending once the value has been confirmed by the server', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([makeCoin({ grade: 'MS65' })]);

      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);

      // Re-entering a value the server already acknowledged is a no-op.
      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the retry payload a minimal diff after a failure', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([makeCoin({ grade: 'MS65', notes: 'Original' })]);

      (mockApiService.updateCoin as any).mockReturnValue(throwError(() => new Error('server down')));
      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);

      (mockApiService.updateCoin as any).mockReturnValue(of(undefined));
      // Editing another field sends the still-unsaved grade too, but nothing untouched.
      inv.updateCoin('coin-1', { notes: 'Cleaned' });
      await vi.advanceTimersByTimeAsync(1000);

      const lastPayload = (mockApiService.updateCoin as any).mock.calls.at(-1)[1];
      expect(lastPayload).toEqual({ grade: 'MS66', notes: 'Cleaned' });
      // Must not send the whole record.
      expect(lastPayload).not.toHaveProperty('purchasePrice');
      expect(lastPayload).not.toHaveProperty('id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows only one save-failure notification per coin', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService, mockNotification } = createTestInventoryService();
      inv.inventory.set([makeCoin({ grade: 'MS65' })]);
      (mockApiService.updateCoin as any).mockReturnValue(throwError(() => new Error('server down')));

      inv.updateCoin('coin-1', { grade: 'MS66' });
      await vi.advanceTimersByTimeAsync(1000);
      inv.updateCoin('coin-1', { grade: 'MS67' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(2);
      expect(mockNotification.showError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not send a request when an edit is reverted before the debounce fires', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([makeCoin({ year: '2024' })]);

      inv.updateCoin('coin-1', { year: '2025' });
      inv.updateCoin('coin-1', { year: '2024' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.updateCoin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Array fields (`imagePaths`) are compared by content, not identity.
  it('treats array fields (imagePaths) as changed by content, not identity', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      inv.inventory.set([makeCoin({ imagePaths: [] })]);

      // A new array with new content IS a change...
      inv.updateCoin('coin-1', { imagePaths: ['data:image/png;base64,AAA'] });
      await vi.advanceTimersByTimeAsync(1000);

      expect(inv.inventory()[0].imagePaths).toEqual(['data:image/png;base64,AAA']);
      expect(mockApiService.updateCoin).toHaveBeenCalledWith('coin-1', {
        imagePaths: ['data:image/png;base64,AAA']
      });

      // ...but a new array with identical content is not.
      inv.updateCoin('coin-1', { imagePaths: ['data:image/png;base64,AAA'] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A new coin is a local draft until it has 2 of Year / Coin Type /
  // Denomination (services/coin-completeness.ts); then it POSTs once.

  it('sends no HTTP request at all when a coin is added', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService, mockNotification } = createTestInventoryService();

      const coin = inv.addBlankCoin();

      // The row is on screen and selected...
      expect(inv.inventory()).toHaveLength(1);
      expect(inv.selectedCoinId()).toBe(coin.id);
      expect(inv.isDraftCoin(coin.id)).toBe(true);

      // ...but nothing was sent and no error shown.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockApiService.createCoin).not.toHaveBeenCalled();
      expect(mockApiService.updateCoin).not.toHaveBeenCalled();
      expect(mockNotification.showError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still sends nothing when a draft has only one of the three main details', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      inv.updateCoin(coin.id, { year: '1921' });
      await vi.advanceTimersByTimeAsync(5000);

      // The edit is visible on screen...
      expect(inv.inventory()[0].year).toBe('1921');
      // ...but a year alone does not qualify.
      expect(inv.isDraftCoin(coin.id)).toBe(true);
      expect(mockApiService.createCoin).not.toHaveBeenCalled();
      expect(mockApiService.updateCoin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('POSTs exactly once as soon as a draft reaches 2 of 3 main details', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      inv.updateCoin(coin.id, { year: '1921' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.createCoin).not.toHaveBeenCalled();

      // A second qualifying field triggers the create.
      inv.updateCoin(coin.id, { denomination: 'Dollar' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);
      const posted = (mockApiService.createCoin as any).mock.calls[0][0];
      expect(posted.id).toBe(coin.id);
      expect(posted.year).toBe('1921');
      expect(posted.denomination).toBe('Dollar');

      // It is a real coin now, not a draft.
      expect(inv.isDraftCoin(coin.id)).toBe(false);
      // And no stray PUT tagged along with the create.
      expect(mockApiService.updateCoin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches to minimal-diff PUTs once the draft has been created', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      inv.updateCoin(coin.id, { year: '1921', denomination: 'Dollar' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);

      // A later edit is one PUT of the changed field only.
      inv.updateCoin(coin.id, { grade: 'MS64' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
      const payload = (mockApiService.updateCoin as any).mock.calls[0][1];
      expect(payload).toEqual({ grade: 'MS64' });
      // Must not send the whole record.
      expect(payload).not.toHaveProperty('year');
      expect(payload).not.toHaveProperty('id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a coin a draft when its create fails, and retries on the next edit', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      // --- The backend is down when the draft first qualifies. ---
      (mockApiService.createCoin as any).mockReturnValue(throwError(() => new Error('server down')));

      inv.updateCoin(coin.id, { year: '1921', denomination: 'Dollar' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);
      // Still a draft: there is no server row to PUT to.
      expect(inv.isDraftCoin(coin.id)).toBe(true);

      // --- The backend comes back up and the user edits again. ---
      (mockApiService.createCoin as any).mockReturnValue(of({ id: coin.id }));

      inv.updateCoin(coin.id, { coinType: 'Morgan' });
      await vi.advanceTimersByTimeAsync(1000);

      // A SECOND create, not a PUT.
      expect(mockApiService.createCoin).toHaveBeenCalledTimes(2);
      expect(mockApiService.updateCoin).not.toHaveBeenCalled();
      expect(inv.isDraftCoin(coin.id)).toBe(false);
      // The retry carried everything typed so far, including the new field.
      expect((mockApiService.createCoin as any).mock.calls[1][0].coinType).toBe('Morgan');
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards an unfinished draft without calling DELETE', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      inv.deleteCoin(coin.id);
      await vi.advanceTimersByTimeAsync(1000);

      expect(inv.inventory()).toHaveLength(0);
      // There was never a row on the server, so DELETE would only 404.
      expect(mockApiService.deleteCoin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the SAME completeness rule for drafts as the QIF import does', async () => {
    // The import and draft paths must agree on the shared completeness rule.
    const cases: Array<{ edit: Partial<CoinRecord>; qualifies: boolean }> = [
      { edit: { year: '1921', denomination: 'Dollar' }, qualifies: true },
      { edit: { year: '1921' }, qualifies: false },
      { edit: { coinType: 'Morgan', denomination: 'Dollar' }, qualifies: true },
      // Placeholder and whitespace values look populated but carry no detail.
      { edit: { year: '1921', denomination: 'Unknown' }, qualifies: false },
      { edit: { year: '1921', denomination: '   ' }, qualifies: false },
      { edit: { year: '1921', denomination: '0' }, qualifies: false }
    ];

    vi.useFakeTimers();

    try {
      for (const { edit, qualifies } of cases) {
        const label = JSON.stringify(edit);

        // --- The import path's answer ---
        expect(checkMainCoinDetails(edit).passes, `import rule for ${label}`).toBe(qualifies);

        // --- The draft path's answer: whether the row got POSTed ---
        const { inv, mockApiService } = createTestInventoryService();
        const coin = inv.addBlankCoin();
        inv.updateCoin(coin.id, edit);
        await vi.advanceTimersByTimeAsync(1000);

        expect(
          (mockApiService.createCoin as any).mock.calls.length,
          `draft rule for ${label}`
        ).toBe(qualifies ? 1 : 0);
        expect(inv.isDraftCoin(coin.id), `draft state for ${label}`).toBe(!qualifies);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains what an unsaved row still needs', async () => {
    vi.useFakeTimers();

    try {
      const { inv } = createTestInventoryService();
      const coin = inv.addBlankCoin();

      expect(inv.draftHint(inv.inventory()[0]))
        .toBe('Not saved yet. Add 2 of: Year, Coin Type, Denomination.');

      inv.updateCoin(coin.id, { year: '1921' });
      expect(inv.draftHint(inv.inventory()[0]))
        .toBe('Not saved yet. Add 1 more of: Coin Type, Denomination.');

      // Once it qualifies, the row stops being a draft when the create lands.
      inv.updateCoin(coin.id, { denomination: 'Dollar' });
      expect(inv.draftHint(inv.inventory()[0])).toBe('');

      await vi.advanceTimersByTimeAsync(1000);
      expect(inv.isDraftCoin(coin.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Connection recovery

  it('recovers via retryConnection() after the initial hydrate fails', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();

    expect(inv.connected()).toBe(false);
    expect(inv.connectionError()).toBeTruthy();

    // Backend comes back; the user clicks "Retry connection".
    (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
    await app['retryConnection']();

    expect(inv.connected()).toBe(true);
    expect(inv.connectionError()).toBeNull();
    expect(inv.inventory()).toHaveLength(1);
  });

  it('stays connected when an optional lookup fails during hydration', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
    (mockApiService.getDenominations as any).mockReturnValue(throwError(() => new Error('lookup exploded')));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();

    // Coins loaded fine, so the connection is healthy despite the bad lookup.
    expect(inv.connected()).toBe(true);
    expect(inv.connectionError()).toBeNull();
    expect(inv.inventory()).toHaveLength(1);
    expect(inv.denominations()).toEqual([]);
    // Other lookups are unaffected.
    expect(inv.metalContents().length).toBeGreaterThan(0);
  });

  it('adds a blank coin with sensible defaults', () => {
    const app = createApp();
    app['addBlankCoin']();

    const coin = app['inv'].inventory().at(-1)!;
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

    // `tags` is intentional: older JSON exports still carry the removed key,
    // and importing them must keep working.
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

  it('persists newly imported categories to the database', () => {
    const { inv, mockApiService } = createTestInventoryService();
    const createSpy = vi.spyOn(mockApiService, 'createCategory');

    inv.mergeCategoryOptions(['Gold', 'Silver']);

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledWith('Gold');
    expect(createSpy).toHaveBeenCalledWith('Silver');
  });

  it('filters the inventory table by search text', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Dime', coinType: 'Mercury' });
    addTestCoin(app, { denomination: 'Eagle', coinType: 'Liberty' });

    app['onSearchQueryChange']('mercury');
    const results = app['filters'].filteredInventory();
    expect(results).toHaveLength(1);
    expect(results[0].coinType).toBe('Mercury');
  });

  it('filters the inventory table by category', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Eagle', category: 'Gold' });
    addTestCoin(app, { denomination: 'Dollar', category: 'Silver' });

    app['onCategoryFilterChange']('Gold');
    const results = app['filters'].filteredInventory();
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('Gold');
  });

  it('starts with the first visible item selected', () => {
    // The default sort is Year ascending, so the years decide "first visible".
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Quarter', year: '1999' });
    const coin2 = addTestCoin(app, { denomination: 'Dime', year: '1935' });

    expect(app['inv'].selectedCoinId()).toBe(coin2.id);
    expect(app.selectedCoin?.id).toBe(coin2.id);
    expect(app['filters'].filteredInventory()[0].id).toBe(coin2.id);
    // Premise: coin1 is the later year, so this tests sorting, not insertion order.
    expect(app['filters'].filteredInventory()[1].id).toBe(coin1.id);
  });

  it('keeps transactions hidden by default', () => {
    const app = createApp();
    expect(app['showTransactionsInDetails']()).toBe(false);
  });

  it('stabilizes the year and mint-mark ordering even when stored columns are stale', async () => {
    const { inv, storage } = createTestInventoryService();
    const app = new App(storage, inv, new CsvService());
    await storage.set(StorageKeys.VisibleColumns, ['coinType', 'year', 'category']);
    await app['hydrateFromStorage']();

    const visible = app['columns'].visibleInventoryColumns();
    expect(visible.indexOf('year')).toBeLessThan(visible.indexOf('mintMark'));
    expect(visible.indexOf('mintMark')).toBe(visible.indexOf('year') + 1);
  });

  it('falls back to inventory-derived categories when the API returns no category list', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    // makeCoin() keeps `source` typed as its union; a bare literal widens it to string.
    mockApiService.getCoins = vi.fn(() => of([makeCoin({
      id: 'coin-1', denomination: 'Quarter', year: '2024', coinType: 'Washington',
      category: 'Silver', grade: 'MS65', mintMark: 'P',
      purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15
    })]));
    mockApiService.getCategories = vi.fn(() => of([]));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();

    expect(inv.categoryOptions()).toContain('Silver');
  });

  it('loads metal content options from the database-backed lookup list', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    mockApiService.getMetalContents = vi.fn(() => of(['Gold', 'Silver', 'Copper-Nickel']));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();

    expect(inv.metalContents()).toEqual(['Copper-Nickel', 'Gold', 'Silver']);
    expect(app['inv'].metalContents()).toContain('Gold');
  });

  it('sorts the inventory table and flips direction on repeat clicks', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Cent', currentValue: 10 });
    addTestCoin(app, { denomination: 'Dollar', currentValue: 50 });

    app['filters'].setSortColumn('currentValue');
    let results = app['filters'].filteredInventory();
    expect(results[0].currentValue).toBeLessThan(results.at(-1)!.currentValue);

    app['filters'].setSortColumn('currentValue');
    results = app['filters'].filteredInventory();
    expect(results[0].currentValue).toBeGreaterThan(results.at(-1)!.currentValue);
  });

  it('sorts denomination by face value within country groups', () => {
    const app = createApp();
    const usPenny = addTestCoin(app, { denomination: 'Penny', country: 'United States', currentValue: 10 });
    const ukPence = addTestCoin(app, { denomination: '2p', country: 'United Kingdom', currentValue: 12 });
    const usQuarter = addTestCoin(app, { denomination: 'Quarter', country: 'United States', currentValue: 30 });
    const usDollar = addTestCoin(app, { denomination: 'Dollar', country: 'United States', currentValue: 60 });

    app['filters'].setSortColumn('denomination');
    const results = app['filters'].filteredInventory();

    expect(results.map(coin => coin.id)).toEqual([ukPence.id, usPenny.id, usQuarter.id, usDollar.id]);
  });

  it('sorts half-cent before one-cent in ascending denomination order', () => {
    const app = createApp();
    const oneCent = addTestCoin(app, { denomination: '1¢', country: 'United States', currentValue: 10 });
    const halfCent = addTestCoin(app, { denomination: '½¢', country: 'United States', currentValue: 5 });

    app['filters'].setSortColumn('denomination');
    const results = app['filters'].filteredInventory();

    expect(results.map(coin => coin.id)).toEqual([halfCent.id, oneCent.id]);
  });

  it('builds a certification badge label only when cert data is present', () => {
    const app = createApp();
    const certified = addTestCoin(app, { certCompany: 'NGC', certNumber: '9000002-001' });
    const uncertified = addTestCoin(app, { certCompany: '', certNumber: '' });

    expect(certBadgeLabel(certified)).toBe('NGC #9000002-001');
    expect(certBadgeLabel(uncertified)).toBeNull();
  });

  it('renders pre-decimal shillings in a readable UI format', () => {
    expect(formatDenominationDisplay('1/-')).toBe('1 sh');
    expect(formatDenominationDisplay('2/- (Florin)')).toBe('2 sh (Florin)');
    expect(parseDenominationValue('1/-')).toBeCloseTo(0.05, 5);
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

  // --- Unlinked-denomination banner ---

  it('stays silent until the denomination lookup has arrived', () => {
    // With an empty lookup every coin would count as unlinked, flashing the banner at start-up.
    const app = createApp();
    app['inv'].inventory.set([makeCoin({ id: 'a', denomination: '8 Reales', denominationId: null })]);
    app['inv'].denominations.set([]);

    expect(app['unlinkedCount']()).toBe(0);
    expect(app['unlinkedPrompt']()).toBe('');
  });

  it('says nothing when every coin has a denomination', () => {
    const app = createApp();
    app['inv'].denominations.set([
      { denominationId: 1, label: 'Quarter', country: 'US', sortOrder: 1, isActive: true }
    ]);
    app['inv'].inventory.set([makeCoin({ id: 'a', denomination: 'Quarter', denominationId: 1 })]);

    expect(app['unlinkedCount']()).toBe(0);
    expect(app['unlinkedPrompt']()).toBe('');
  });

  it('raises a prompt, with the number, when coins cannot be linked', () => {
    const app = createApp();
    app['inv'].denominations.set([
      { denominationId: 1, label: '8 Reales', country: 'MX', sortOrder: 1, isActive: true },
      { denominationId: 2, label: '8 Reales', country: 'ES', sortOrder: 2, isActive: true }
    ]);
    app['inv'].inventory.set([
      makeCoin({ id: 'a', denomination: '8 Reales', denominationId: null, country: 'United States' }),
      makeCoin({ id: 'b', denomination: '8 Reales', denominationId: null, country: 'United States' })
    ]);

    expect(app['unlinkedCount']()).toBe(2);
    expect(app['unlinkedPrompt']()).toBe('2 coins have no denomination linked, in 1 group.');
  });

  it('opens Reference Data ON the unlinked pane, not on Categories', () => {
    const app = createApp();
    app['openUnlinkedCoins']();

    expect(app['showCategoryModal']()).toBe(true);
    expect(app['categoryModalSection']()).toBe('unlinked');
  });

  it('goes back to the default pane the next time Reference Data is opened', () => {
    const app = createApp();
    app['openUnlinkedCoins']();
    app['closeCategoryModal']();
    app['openCategoryModal']();

    expect(app['categoryModalSection']()).toBe('categories');
  });

  // --- Import menu routing (through handleImportSelection, as the toolbar does) ---

  it('routes every Import menu choice somewhere', () => {
    const app = createApp();

    app['handleImportSelection']('qif');
    expect(app['showQuickenModal']()).toBe(true);

    app['handleImportSelection']('csv');
    expect(app['showCsvImportModal']()).toBe(true);

    app['handleImportSelection']('images');
    expect(app['showImageImportModal']()).toBe(true);
  });

  it('opens and closes the category management modal', () => {
    const app = createApp();
    app['openCategoryModal']();
    expect(app['showCategoryModal']()).toBe(true);

    app['closeCategoryModal']();
    expect(app['showCategoryModal']()).toBe(false);
  });

  it('no longer routes from Settings to Reference Data', async () => {
    const app = createApp();

    expect(app['openReferenceDataFromSettings']).toBeUndefined();

    // Checked in the markup: a binding to a removed output compiles as a DOM event listener.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const template = readFileSync(join(__dirname, 'app.html'), 'utf8');
    expect(template.replace(/<!--[\s\S]*?-->/g, '')).not.toContain('referenceDataRequested');
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
    expect(app['columns'].showColumnPicker()).toBe(false);

    app['columns'].toggleColumnPicker();
    expect(app['columns'].showColumnPicker()).toBe(true);

    app['columns'].toggleColumnPicker();
    expect(app['columns'].showColumnPicker()).toBe(false);
  });

  it('toggles the advanced filters panel', () => {
    const app = createApp();
    expect(app['filters'].showAdvancedFilters()).toBe(false);

    app['filters'].toggleAdvancedFilters();
    expect(app['filters'].showAdvancedFilters()).toBe(true);
  });

  // --- Opening the details panel ---

  it('selecting a coin does not, on its own, open the detail sidebar', () => {
    // selectCoin is also called by filtering and start-up, which must not open the panel.
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    app['closeDetailPanel']();

    app['selectCoin'](coin.id);
    expect(app['showDetailPanel']()).toBe(false);
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('activating a row opens the sidebar on that coin', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    app['closeDetailPanel']();

    app['openCoinDetail'](coin.id);
    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('does NOT close the sidebar when the same row is activated again', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });

    app['openCoinDetail'](coin.id);
    app['openCoinDetail'](coin.id);
    app['openCoinDetail'](coin.id);

    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('moves the sidebar to another row rather than closing it', () => {
    const app = createApp();
    const morgan = addTestCoin(app, { denomination: 'Dollar', coinType: 'Morgan' });
    const peace = addTestCoin(app, { denomination: 'Dollar', coinType: 'Peace' });

    app['openCoinDetail'](morgan.id);
    app['openCoinDetail'](peace.id);

    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(peace.id);
  });

  it('Add Coin opens the sidebar on the new row and asks for the caret', () => {
    const app = createApp();
    const before = app['detailFieldFocusRequest']();

    app['addBlankCoin']();

    const coin = app['inv'].inventory().at(-1)!;
    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(coin.id);
    expect(app['detailFieldFocusRequest']()).toBe(before + 1);
  });

  it('asks for the caret again on a second Add Coin', () => {
    // A counter, so a repeated request still registers as a change.
    const app = createApp();

    app['addBlankCoin']();
    const first = app['detailFieldFocusRequest']();
    app['addBlankCoin']();

    expect(app['detailFieldFocusRequest']()).toBe(first + 1);
  });

  it('cancels an outstanding caret request when the panel is closed', () => {
    // A left-over request would make the next panel steal focus from the grid.
    const app = createApp();
    app['addBlankCoin']();
    expect(app['detailFieldFocusRequest']()).toBeGreaterThan(0);

    app['closeDetailPanel']();
    expect(app['detailFieldFocusRequest']()).toBe(0);
  });

  it('does not ask for the caret when a row is activated', () => {
    // Focus stays in the grid so arrow-key navigation keeps working.
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    const before = app['detailFieldFocusRequest']();

    app['openCoinDetail'](coin.id);

    expect(app['detailFieldFocusRequest']()).toBe(before);
  });

  it('still offers the image action for a coin with no images, and opens it closed', () => {
    // The gallery is where photos are added, so it must open for a coin with none.
    // Opening the detail panel does not open it by itself.
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Dime', coinType: 'Roosevelt', imagePaths: [] });

    app['openCoinDetail'](coin.id);
    expect(app['images'].canOpenImageGallery(coin)).toBe(true);
    expect(app['images'].showImageGallery()).toBe(false);

    // ...and it opens on an empty coin.
    app['images'].openImageGallery();
    expect(app['images'].showImageGallery()).toBe(true);
  });

  // --- Per-coin images ---

  it('tracks a selected coin and manages its images', async () => {
    const app = createApp();
    await app['ready']; // Wait for hydration to finish before adding test data
    const coin = addTestCoin(app, { denomination: 'Eagle', coinType: 'Gold' });
    app['selectCoin'](coin.id);

    await app['images'].addCoinImages({
      target: { files: [new File(['a'], 'front.jpg', { type: 'image/jpeg' })] }
    } as unknown as Event);
    expect(
      app.selectedCoin?.imagePaths.some(p => p.includes('data:') || p.endsWith('front.jpg'))
    ).toBe(true);

    app['images'].removeCoinImage(app.selectedCoin?.imagePaths[app.selectedCoin.imagePaths.length - 1] ?? '');
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

    app['selection'].toggleCoinSelection(coin1.id, mockEvent);
    expect(app['selection'].isCoinSelected(coin1.id)).toBe(true);
    expect(app['selection'].selectionCount()).toBe(1);

    app['selection'].toggleCoinSelection(coin2.id, mockEvent);
    expect(app['selection'].selectionCount()).toBe(2);

    app['selection'].toggleCoinSelection(coin1.id, mockEvent);
    expect(app['selection'].isCoinSelected(coin1.id)).toBe(false);
    expect(app['selection'].selectionCount()).toBe(1);
  });

  it('selects and clears all visible coins', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter' });
    addTestCoin(app, { denomination: 'Dime' });
    addTestCoin(app, { denomination: 'Nickel' });

    app['selection'].toggleAllCoins();
    expect(app['selection'].selectionCount()).toBe(3);
    expect(app['selection'].allVisibleSelected()).toBe(true);

    app['selection'].toggleAllCoins();
    expect(app['selection'].selectionCount()).toBe(0);
  });

  it('clears selection explicitly', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter' });
    const mockEvent = { stopPropagation: () => {}, shiftKey: false } as MouseEvent;

    app['selection'].toggleCoinSelection(coin.id, mockEvent);
    expect(app['selection'].selectionCount()).toBe(1);

    app['selection'].clearSelection();
    expect(app['selection'].selectionCount()).toBe(0);
  });

  it('bulk updates a field across selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Quarter', category: '' });
    const coin2 = addTestCoin(app, { denomination: 'Dime', category: '' });
    addTestCoin(app, { denomination: 'Nickel', category: '' });

    app['selection'].selectedCoinIds.set(new Set([coin1.id, coin2.id]));
    app['selection'].bulkUpdateField('category', 'Gold');

    expect(app['inv'].inventory().find(c => c.id === coin1.id)!.category).toBe('Gold');
    expect(app['inv'].inventory().find(c => c.id === coin2.id)!.category).toBe('Gold');
    expect(app['inv'].inventory()[2].category).toBe('');
  });

  it('requires confirmation before bulk deleting selected coins', () => {
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Keep' });
    const coin2 = addTestCoin(app, { denomination: 'Delete Me' });
    const coin3 = addTestCoin(app, { denomination: 'Also Delete' });

    vi.stubGlobal('confirm', vi.fn(() => false));
    app['selection'].selectedCoinIds.set(new Set([coin2.id, coin3.id]));
    app['selection'].bulkDeleteCoins();

    expect(app['inv'].inventory()).toHaveLength(3);
    expect(app['inv'].inventory().map(c => c.id)).toContain(coin1.id);
    expect(app['inv'].inventory().map(c => c.id)).toContain(coin2.id);
    expect(app['inv'].inventory().map(c => c.id)).toContain(coin3.id);
    expect(app['selection'].selectionCount()).toBe(2);

    vi.stubGlobal('confirm', vi.fn(() => true));
    app['selection'].bulkDeleteCoins();
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].denomination).toBe('Keep');
    expect(app['selection'].selectionCount()).toBe(0);
  });

  it('keeps the mint mark column immediately after year by default', () => {
    const visible = defaultVisibleColumns;
    expect(visible.indexOf('year')).toBeLessThan(visible.indexOf('mintMark'));
    expect(visible.indexOf('mintMark')).toBe(visible.indexOf('year') + 1);
  });

  it('includes the full known metal-content options', async () => {
    const app = createApp();
    await app['ready'];

    expect(app['inv'].metalContents()).toEqual(expect.arrayContaining([
      'Gold', 'Silver', 'Platinum', 'Copper', 'Nickel', 'Bronze', 'Steel', 'Clad', 'Other'
    ]));
  });

  // --- Advanced filters ---

  it('filters by grade prefix', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', grade: 'MS65' });
    addTestCoin(app, { denomination: 'Dime', grade: 'VF30' });

    app['filters'].gradeFilter.set('MS');
    expect(app['filters'].filteredInventory()).toHaveLength(1);
    expect(app['filters'].filteredInventory()[0].grade).toBe('MS65');
  });

  it('filters by value range', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Cent', currentValue: 5 });
    addTestCoin(app, { denomination: 'Quarter', currentValue: 50 });
    addTestCoin(app, { denomination: 'Eagle', currentValue: 500 });

    app['filters'].valueMinFilter.set('10');
    app['filters'].valueMaxFilter.set('100');
    expect(app['filters'].filteredInventory()).toHaveLength(1);
    expect(app['filters'].filteredInventory()[0].currentValue).toBe(50);
  });

  it('filters by source', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', source: 'manual' });
    addTestCoin(app, { denomination: 'Dime', source: 'quicken' });

    app['filters'].sourceFilter.set('quicken');
    expect(app['filters'].filteredInventory()).toHaveLength(1);
    expect(app['filters'].filteredInventory()[0].source).toBe('quicken');
  });

  it('filters by country', () => {
    const app = createApp();
    addTestCoin(app, { denomination: 'Quarter', country: 'United States' });
    addTestCoin(app, { denomination: 'Shilling', country: 'United Kingdom' });

    app['filters'].countryFilter.set('United Kingdom');
    expect(app['filters'].filteredInventory()).toHaveLength(1);
    expect(app['filters'].filteredInventory()[0].country).toBe('United Kingdom');
  });

  it('filters by coin set', () => {
    const app = createApp();
    app['inv'].addCoinSet('Set A');

    addTestCoin(app, { denomination: 'Quarter', coinSet: 'Set A' });
    addTestCoin(app, { denomination: 'Dime' });

    app['filters'].coinSetFilter.set('Set A');
    expect(app['filters'].filteredInventory()).toHaveLength(1);
    expect(app['filters'].filteredInventory()[0].coinSet).toBe('Set A');
  });

  // --- Valuation ---

  it('computes total profit/loss', () => {
    const app = createApp();
    addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    addTestCoin(app, { purchasePrice: 200, currentValue: 180 });

    expect(app['inv'].totalProfit()).toBe(30);
  });


  it('gives each grade tier its own badge colour', () => {
    expect(gradeBadgeClass('MS65')).toContain('badge--grade-ms');
    expect(gradeBadgeClass('PF69DCAM')).toContain('badge--grade-pf');
    expect(gradeBadgeClass('AU58')).toContain('badge--grade-au');
    expect(gradeBadgeClass('XF45')).toContain('badge--grade-xf');
    expect(gradeBadgeClass('VF20')).toContain('badge--grade-vf');
    expect(gradeBadgeClass('F12')).toContain('badge--grade-f');
    expect(gradeBadgeClass('VG8')).toContain('badge--grade-vg');
    expect(gradeBadgeClass('G4')).toContain('badge--grade-g');
    expect(gradeBadgeClass('')).toContain('badge--ungraded');
  });

  it('does not let a short grade code stand in for a longer one', () => {
    // The tier is keyed on the complete letter run, so VF never matches F.
    expect(gradeBadgeClass('VF20')).toContain('grade-vf');   // never F
    expect(gradeBadgeClass('VG8')).toContain('grade-vg');    // never G
    expect(gradeBadgeClass('FR2')).toContain('grade-basal'); // never F
    expect(gradeBadgeClass('F12')).toContain('grade-f');
    expect(gradeBadgeClass('G4')).toContain('grade-g');
  });

  it('ignores whatever follows the grade letters', () => {
    expect(gradeBadgeClass('MS64RB')).toContain('grade-ms');
    expect(gradeBadgeClass('PF69DCAM')).toContain('grade-pf');
    expect(gradeBadgeClass('AU58+')).toContain('grade-au');
    expect(gradeBadgeClass('MS')).toContain('grade-ms');
  });

  it('reads the grade through a leading qualifier', () => {
    expect(gradeBadgeClass('Choice VF')).toContain('grade-vf');
    expect(gradeBadgeClass('Gem BU')).toContain('grade-ms');
  });

  it('treats PR as proof and EF as XF', () => {
    // PCGS prints PR where NGC prints PF; EF and XF are the same grade.
    expect(gradeBadgeClass('PR64')).toContain('grade-pf');
    expect(gradeBadgeClass('EF40')).toContain('grade-xf');
  });

  it('falls back to grey for a grade it does not recognise', () => {
    expect(gradeBadgeClass('wibble')).toContain('badge--ungraded');
  });

  // --- Spot prices & melt value ---

  it('calculates melt value for gold coins', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    // pmWeightGrams is the pure metal weight: 15.55175 g is half a troy ounce of gold.
    const coin = addTestCoin(app, {
      metalContent: 'Gold',
      pmWeightGrams: 15.55175,
      pmPercent: 90
    });

    // (15.55175 / 31.1035) * 2000 = 1000; pmPercent must not be applied again.
    expect(app['inv'].meltValue(coin)).toBeCloseTo(1000, 1);
  });

  it('still values a coin whose purity percentage was never recorded', () => {
    // Purity is not an input to melt value, so its absence must not suppress it.
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), silver: 30 });

    const bullion = addTestCoin(app, {
      metalContent: 'Silver',
      pmWeightGrams: 31.1035
    });

    expect(app['inv'].meltValue(bullion)).toBeCloseTo(30, 1);
  });

  it('returns null melt value when weight or metal is missing', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    // Missing pmWeightGrams
    const noWeight = addTestCoin(app, { metalContent: 'Gold', pmPercent: 90 });
    expect(app['inv'].meltValue(noWeight)).toBeNull();

    // Missing metalContent
    const noMetal = addTestCoin(app, { pmWeightGrams: 15.5175, pmPercent: 90 });
    expect(app['inv'].meltValue(noMetal)).toBeNull();
  });

  it('explains WHY a melt value is missing, so a dash is never ambiguous', () => {
    // The hint distinguishes "no prices loaded" from "not a precious metal".
    const app = createApp();

    const silver = addTestCoin(app, { metalContent: 'Silver', pmWeightGrams: 31.1035 });
    expect(app['inv'].meltValueHint(silver)).toContain('no spot prices have been loaded yet');

    app['inv'].updateSpotPrices({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
    expect(app['inv'].meltValueHint(silver)).toContain('current spot price');

    const clad = addTestCoin(app, { metalContent: 'Clad', pmWeightGrams: 5.67 });
    expect(app['inv'].meltValueHint(clad)).toContain('not a precious metal');

    // Names the field that is actually missing — PM Weight, not gross Weight.
    const noWeight = addTestCoin(app, { metalContent: 'Silver' });
    expect(app['inv'].meltValueHint(noWeight)).toContain('PM Weight');
  });

  it('shows the melt value in the editor, and a dash when it cannot', () => {
    const { inv, storage } = createTestInventoryService();
    void new App(storage, inv, new CsvService());
    inv.updateSpotPrices({ gold: 2600, silver: 30, platinum: 950, copper: 4 });

    const coin = makeCoin({ id: 'melt-1', metalContent: 'Silver', pmWeightGrams: 31.1035 });
    inv.inventory.set([coin]);
    inv.selectCoin('melt-1');

    // Tests the two calls the editor's `meltValueDisplay` composes; CoinEditorForm
    // itself needs TestBed and a DOM, which this suite does not have.
    const selected = inv.selectedCoin()!;
    // Exactly one troy ounce of pure silver at $30.
    expect(formatMeltValue(inv.meltValue(selected))).toBe('$30.00');

    // A base-metal coin reads "—", not "$0.00".
    const clad = makeCoin({ id: 'melt-2', metalContent: 'Clad', pmWeightGrams: 5.67 });
    expect(formatMeltValue(inv.meltValue(clad))).toBe('—');
  });

  // --- Automatic COMEX fetch once start-up has finished ---

  it('refreshes spot prices from COMEX once start-up has finished', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
    (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
      prices: { gold: 2700, silver: 33, platinum: 1000, copper: 5 },
      source: 'COMEX/NYMEX futures via Yahoo Finance',
      timestamp: '2026-10-03T09:00:00.000Z'
    }));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();
    // Start-up does not await the fetch; drain the microtask queue first.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(inv.spotPrices()).toEqual({ gold: 2700, silver: 33, platinum: 1000, copper: 5 });
    expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
  });

  it('still finishes starting up when the automatic COMEX fetch fails', async () => {
    // The app must start normally and keep the prices saved in the database.
    const { inv, storage, mockApiService, mockNotification } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
    (mockApiService.getLatestSpotPrices as any).mockReturnValue(of({
      gold: 2600, silver: 30, platinum: 950, copper: 4,
      source: 'COMEX/NYMEX futures via Yahoo Finance', fetchedAt: '2026-10-02T14:02:00.000Z'
    }));
    (mockApiService.saveSpotPrices as any).mockClear();
    (mockApiService.fetchSpotPrices as any).mockReturnValue(
      throwError(() => new Error('getaddrinfo ENOTFOUND'))
    );

    const app = new App(storage, inv, new CsvService());
    await expect(app['hydrateFromStorage']()).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(inv.connected()).toBe(true);
    expect(inv.inventory()).toHaveLength(1);
    // Saved prices survive the failed refresh.
    expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
    expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    // Error toasts are sticky, so a failed background fetch must not raise one.
    expect(mockNotification.showError).not.toHaveBeenCalled();
  });

  it('does not attempt the automatic fetch when start-up itself failed', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();
    await Promise.resolve();

    expect(mockApiService.fetchSpotPrices).not.toHaveBeenCalled();

    // ...but the retry that connects does run it.
    (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
    (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
      prices: { gold: 2700, silver: 33, platinum: 1000, copper: 5 },
      source: 'COMEX', timestamp: ''
    }));
    await app['retryConnection']();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockApiService.fetchSpotPrices).toHaveBeenCalledTimes(1);

    // At most one successful automatic fetch per session.
    await app['retryConnection']();
    await Promise.resolve();
    expect(mockApiService.fetchSpotPrices).toHaveBeenCalledTimes(1);
  });

  // --- Transactions (removed; purchase and sale are fields on the coin) ---
  it('no longer offers transaction entry points on the detail panel', () => {
    const app = createApp();
    const panel = createDetailPanelFor(app['inv']) as unknown as Record<string, unknown>;

    expect(panel['addTransactionForSelectedCoin']).toBeUndefined();
    expect(panel['deleteTransaction']).toBeUndefined();
    expect((app['inv'] as unknown as Record<string, unknown>)['addTransaction']).toBeUndefined();
    expect((app['inv'] as unknown as Record<string, unknown>)['transactions']).toBeUndefined();
  });

  // --- Column formatting ---

  it('formats the coinSet column', () => {
    const app = createApp();
    const coin = addTestCoin(app, { coinSet: 'Morgan Set' });
    expect(formatInventoryCell(coin, 'coinSet')).toBe('Morgan Set');
  });

  // `weight` is gross weight in grams, shown to three decimals.
  it('formats sold price and weight columns', () => {
    const app = createApp();
    const coin = addTestCoin(app, { soldPrice: 250, weight: 26.73 });
    expect(formatInventoryCell(coin, 'soldPrice')).toBe('$250.00');
    expect(formatInventoryCell(coin, 'weight')).toBe('26.730');
  });

  // --- onQuickenImported ---

  it('adds coins via onQuickenImported callback', () => {
    const app = createApp();
    const coins: CoinRecord[] = [{
      id: 'q1', denomination: 'Dime', year: '1964', coinType: 'Roosevelt',
      category: 'Coins', country: 'US', grade: 'Unknown',
      certCompany: '', certNumber: '', variety: '', mintMark: '',
      composition: '', purchaseDate: '2024-01-01', purchasePrice: 12.50,
      currentValue: 12.50, notes: '', imagePaths: [],
      source: 'quicken', hasCacSticker: false
    }];

    app['onQuickenImported'](coins);
    expect(app['inv'].inventory()).toHaveLength(1);
    expect(app['inv'].inventory()[0].denomination).toBe('Dime');
    expect(app['inv'].inventory()[0].coinType).toBe('Roosevelt');
  });
});

/*
 * Lazy-loading contract of app.html, checked as text (these specs have no DOM):
 * every deferred block keeps an inner @if (a triggered @defer never reverts),
 * and always-visible components are not deferred.
 */
describe('the deferred screens in the shell template', () => {
  const TEMPLATE = readFileSync(join(__dirname, 'app.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Each @defer header, split on `;` (a `[^)]` regex would cut `showDetailPanel()` short).
  const deferBlocks = [...TEMPLATE.matchAll(/@defer\s*\((.*?)\)\s*\{/g)].map(match => {
    const [trigger, ...modifiers] = match[1].split(';').map(part => part.trim());
    return {
      condition: trigger.replace(/^when\s+/, ''),
      prefetched: modifiers.includes('prefetch on idle')
    };
  });

  const conditions = deferBlocks.map(block => block.condition);

  it('defers every dialog and the detail panel', () => {
    expect([...conditions].sort()).toEqual([
      'images.showImageGallery()',
      'images.showPhotoViewer()',
      'showCategoryModal()',
      'showCsvImportModal()',
      'showDetailPanel()',
      'showHelpModal()',
      'showImageImportModal()',
      'showQuickenModal()',
      'showReportModal()',
      'showSettingsModal()',
      'showSpotPriceModal()',
      'showStatisticsModal()',
      'showSupportModal()'
    ]);
  });

  it('keeps the @if inside every block, so the dialogs can still be closed', () => {
    for (const condition of conditions) {
      expect(TEMPLATE, `@defer (when ${condition}) has no @if to close it again`)
        .toContain(`@if (${condition}`);
    }
  });

  it('prefetches the hot path, and only the hot path', () => {
    // Detail panel, gallery and viewer open on routine clicks, so they are prefetched.
    const prefetched = deferBlocks.filter(b => b.prefetched).map(b => b.condition).sort();

    expect(prefetched).toEqual([
      'images.showImageGallery()',
      'images.showPhotoViewer()',
      'showDetailPanel()'
    ]);

    expect(prefetched).toHaveLength(3);
  });

  it('shows nothing at all for the first 100ms of a load', () => {
    expect(TEMPLATE).not.toContain('@placeholder');
    expect(TEMPLATE.match(/@loading \(after 100ms\)/g) ?? []).toHaveLength(deferBlocks.length);
  });

  it('leaves the always-visible furniture eagerly loaded', () => {
    // Brace-matched block bodies, so a lazy regex can't run into a later block.
    const deferredMarkup = deferBlockBodies(TEMPLATE).join('\n');

    for (const tag of ['app-toolbar', 'app-inventory-filter-bar', 'app-inventory-table',
                       'app-notification-toast', 'app-bulk-edit-bar']) {
      expect(TEMPLATE, `<${tag}> has gone missing from the shell`).toContain(`<${tag}`);
      expect(deferredMarkup, `<${tag}> is on screen from the first paint and must not be deferred`)
        .not.toContain(`<${tag}`);
    }
  });
});

/** Body of every @defer block, found by brace counting (excludes the following @loading block). */
function deferBlockBodies(template: string): string[] {
  const bodies: string[] = [];

  for (const opener of template.matchAll(/@defer\s*\((.*?)\)\s*\{/g)) {
    const start = (opener.index ?? 0) + opener[0].length;
    let depth = 1;
    let i = start;

    while (i < template.length && depth > 0) {
      if (template[i] === '{') depth++;
      else if (template[i] === '}') depth--;
      i++;
    }

    bodies.push(template.slice(start, i - 1));
  }

  return bodies;
}
