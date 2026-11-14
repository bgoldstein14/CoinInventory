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
// Imported through the QIF service on purpose: the draft tests below assert
// that the manual add-a-coin path agrees with THIS rule, so reaching for it
// via the import path's own front door is what makes a future divergence fail.
import { checkMainCoinDetails } from './services/quicken-import.service';
import { CoinRecord } from './types/coin.model';
import {
  certBadgeLabel, defaultVisibleColumns, formatDenominationDisplay,
  formatInventoryCell, gradeBadgeClass
} from './types/inventory-columns';
import { StorageKeys } from './services/storage.service';
import { createTestInventoryService } from './testing/test-helpers';

/**
 * Creates an App instance with all dependencies properly wired up.
 *
 * InventoryService uses Angular's inject() function internally, so it must be
 * created inside an injection context with all its dependencies provided.
 * The createTestInventoryService() helper handles this setup.
 *
 * NOTE ON WHERE BEHAVIOUR NOW LIVES
 * App is a thin shell. State that several parts of the screen share lives in
 * small stores that App creates and hands to its children, so tests reach
 * through them:
 *   app['filters']   — search, filters, sort order, filteredInventory()
 *   app['columns']   — visible inventory table columns
 *   app['selection'] — the row tick-boxes and bulk actions
 *   app['images']    — the photo gallery and full-screen viewer
 */
function createApp(): App {
  const { inv, storage } = createTestInventoryService();
  return new App(storage, inv, new CsvService());
}

/**
 * Creates a CoinDetailPanel wired to the same InventoryService an App is using,
 * so tests can drive detail-panel behaviour against the same inventory the
 * App sees.
 *
 * The panel uses inject(), so it must be constructed inside an injection
 * context — the same pattern the other component specs use.
 */
function createDetailPanelFor(inv: InventoryService): CoinDetailPanel {
  const injector = Injector.create({
    providers: [{ provide: InventoryService, useValue: inv }]
  });
  return runInInjectionContext(injector, () => new CoinDetailPanel());
}


/**
 * Builds a complete CoinRecord for tests that drive InventoryService directly
 * (i.e. by calling `inv.inventory.set([...])` rather than going through the UI).
 */
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

  // Regression tests: a failed save must stay recoverable.
  //
  // updateCoin() diffs new edits against the last SERVER-CONFIRMED value,
  // never against the optimistic local record. Diff against the local one
  // and a retry after a failed PUT produces an empty diff, returns early,
  // and loses the edit with no feedback at all.

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

      // This is the whole point: a SECOND request must be issued.
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
      // The user now edits a DIFFERENT field. The still-unsaved grade rides
      // along, but nothing the user never touched may appear in the payload.
      inv.updateCoin('coin-1', { notes: 'Cleaned' });
      await vi.advanceTimersByTimeAsync(1000);

      const lastPayload = (mockApiService.updateCoin as any).mock.calls.at(-1)[1];
      expect(lastPayload).toEqual({ grade: 'MS66', notes: 'Cleaned' });
      // Guard against the old "send the whole record" regression.
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

  // `imagePaths` is the only array field on a coin. The rule being protected:
  // arrays are compared by CONTENT, not by identity.
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

      // ...but a DIFFERENT array object holding identical content is NOT. Note
      // this is a freshly-built array literal, so reference equality would say
      // "changed" and wrongly fire a second save.
      inv.updateCoin('coin-1', { imagePaths: ['data:image/png;base64,AAA'] });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression tests: a NEW coin is a local draft until it is worth saving.
  //
  // POSTing a blank record on "Add coin" earns a
  // `400 {"error":"denomination is required"}` and puts a red error toast in
  // front of the user before they have typed a character.
  //
  // The rule: a new row lives only on screen until it has at least 2 of
  // Year / Coin Type / Denomination (the SAME 2-of-3 rule the QIF importer
  // uses, from services/coin-completeness.ts). Then it POSTs itself once and
  // behaves like any other coin from that moment on.

  it('sends no HTTP request at all when a coin is added', async () => {
    vi.useFakeTimers();

    try {
      const { inv, mockApiService, mockNotification } = createTestInventoryService();

      const coin = inv.addBlankCoin();

      // The row is on screen and selected, exactly as before...
      expect(inv.inventory()).toHaveLength(1);
      expect(inv.selectedCoinId()).toBe(coin.id);
      expect(inv.isDraftCoin(coin.id)).toBe(true);

      // ...but nothing was sent, and nothing was complained about.
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
      // ...but a year on its own is a fragment, not a coin.
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

      // The second qualifying field tips it over the line.
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

      // A later edit must go down the normal route: one PUT, changed field only.
      inv.updateCoin(coin.id, { grade: 'MS64' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);
      expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
      const payload = (mockApiService.updateCoin as any).mock.calls[0][1];
      expect(payload).toEqual({ grade: 'MS64' });
      // Guard against the old "send the whole record" regression.
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
      // It must NOT be quietly treated as saved — there is no row to PUT to.
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
    // Both sides call into services/coin-completeness.ts. This test pins the
    // shared behaviour from both ends at once: if either ever grows its own
    // private copy of the rule, one half of each pair below will break.
    //
    // `checkMainCoinDetails` is imported from quicken-import.service — i.e.
    // through the import path's own front door — precisely so that a copy
    // made there would be caught here.
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

        // --- The draft path's answer, observed through its only visible
        //     effect: whether the row actually got POSTed. ---
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

      // Once it qualifies there is nothing left to ask for, and the row stops
      // being a draft as soon as the create lands.
      inv.updateCoin(coin.id, { denomination: 'Dollar' });
      expect(inv.draftHint(inv.inventory()[0])).toBe('');

      await vi.advanceTimersByTimeAsync(1000);
      expect(inv.isDraftCoin(coin.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression tests: connection recovery

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

    // Updated CoinRecord structure: no 'name', 'type' -> 'coinType', year is string.
    //
    // The `tags: ['test']` below is DELIBERATE and must stay. Tags were removed
    // from CoinRecord, but the user's older JSON exports still contain the key,
    // and importing one of those backups has to keep working. This object is
    // serialised to text and fed through importInventoryData exactly as a file
    // from disk would be, so the extra key is simply ignored. (The focused
    // regression tests for that live in
    // services/inventory/coin-factory.spec.ts.)
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
    // "First visible" depends on the sort, so the fixture has to make the
    // order unambiguous under the DEFAULT sort, which is Year ascending --
    // so the years are what decide the order here.
    const app = createApp();
    const coin1 = addTestCoin(app, { denomination: 'Quarter', year: '1999' });
    const coin2 = addTestCoin(app, { denomination: 'Dime', year: '1935' });

    expect(app['inv'].selectedCoinId()).toBe(coin2.id);
    expect(app.selectedCoin?.id).toBe(coin2.id);
    expect(app['filters'].filteredInventory()[0].id).toBe(coin2.id);
    // Guard the premise: coin1 really is the later year, so the assertion
    // above is about sorting rather than insertion order.
    expect(app['filters'].filteredInventory()[1].id).toBe(coin1.id);
  });

  // The category-maintenance half of this test moved to
  // components/settings-modal/settings-modal.spec.ts along with the code.
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
    // Built via makeCoin() rather than as a bare literal: `source` is a union
    // ('manual' | 'quicken' | 'import' | 'csv'), and an inline object widens
    // it to plain `string`, which then fails to satisfy CoinRecord.
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

  /*
   * THE "COINS WITH NO DENOMINATION" PROMPT
   * The cleanup pane lives inside Reference Data, which is where its fixes
   * are — and which a non-technical user would never think to open. This
   * banner is the discoverability half: it is the only thing in the app
   * that tells somebody the problem exists.
    */

  it('stays silent until the denomination lookup has arrived', () => {
    /* THE BUG THIS PREVENTS: with an empty lookup nothing resolves, so a
     * naive count reports the WHOLE collection as unlinked for the second
     * between start-up and `GET /api/denominations` landing. The banner
     * would flash "105 coins have no denomination" on every launch. */
    const app = createApp();
    app['inv'].inventory.set([makeCoin({ id: 'a', denomination: '8 Reales', denominationId: null })]);
    app['inv'].denominations.set([]);

    expect(app['unlinkedCount']()).toBe(0);
    expect(app['unlinkedPrompt']()).toBe('');
  });

  it('says nothing when every coin has a denomination', () => {
    // The banner is a prompt, not a status line. Zero is reported INSIDE the
    // pane (where "every coin has a denomination" is reassurance the user
    // went looking for); on the main screen it would be noise for ever.
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
    /* Landing the user on Categories after they pressed "Review" would make
     * them hunt for a pane they have never seen, which is the same dead end
     * the SQL report left them in. */
    const app = createApp();
    app['openUnlinkedCoins']();

    expect(app['showCategoryModal']()).toBe(true);
    expect(app['categoryModalSection']()).toBe('unlinked');
  });

  it('goes back to the default pane the next time Reference Data is opened', () => {
    // A sticky section would mean the Categories button on the filter bar
    // silently opens a different screen after the banner has been used once.
    const app = createApp();
    app['openUnlinkedCoins']();
    app['closeCategoryModal']();
    app['openCategoryModal']();

    expect(app['categoryModalSection']()).toBe('categories');
  });

  // --- The Import menu must actually REACH each modal ---
  //
  // The test above calls openImageImportModal() directly. That passed happily
  // for a long time while the batch image import was unreachable from the UI:
  // the modal, its signal and both methods existed, but nothing ever called
  // the open method, so there was no way in. Testing the method rather than
  // the route is what hid it. This goes through handleImportSelection(),
  // which is what the toolbar actually emits into.

  it('routes every Import menu choice somewhere', () => {
    // Guards the whole menu rather than one entry, so a future addition that
    // is wired into ImportKind but forgotten here fails loudly.
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
    /* REMOVED 2026-11-14 at the owner's request: the Settings dialog carried
     * a "Reference data" notice and an "Open Reference Data" button for one
     * day, and he judged it redundant because the toolbar already has an
     * obvious button. The handler went with the button — an unreferenced
     * handler is how a deleted button grows back — so this asserts its
     * ABSENCE, and the template binding's absence with it. */
    const app = createApp();

    expect(app['openReferenceDataFromSettings']).toBeUndefined();

    /* The binding too. An output that no longer exists on the component is
     * not a compile error — Angular would quietly treat it as a DOM event
     * listener — so the markup has to be checked by hand. Imported here
     * rather than at the top of this shared file to keep the edit to one
     * test. */
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

  /*
   * OPENING THE DETAILS PANEL
   *
   * This block replaces 'keeps the detail sidebar closed until a details
   * button is clicked'. There is no Details button any more — the row itself
   * opens the panel — and `addTestCoin` goes through Add Coin, which now
   * opens it too, so the old test's opening premise is no longer reachable.
   * What was worth keeping from it is the distinction it was really making:
   * merely SELECTING a coin is not the same gesture as asking to see it.
   */

  it('selecting a coin does not, on its own, open the detail sidebar', () => {
    // Still true, and still worth saying: `selectCoin` is called by the
    // filter bar and by start-up hydration, neither of which should throw a
    // sidebar open at the user.
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
    // The gesture this serves is a ROW CLICK, not a button press. Clicking
    // the row you are currently reading must not make the information
    // vanish; the panel's own Close button is the way out. The old per-row
    // Details button toggled, which was right for a button and is wrong
    // here.
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
    // Add Coin used to create a draft row and stop there, so the user got an
    // empty row with no visible place to type. It is the same gesture as a
    // row click — a new coin is a row you immediately want to look at — so
    // it goes through the same code path, and additionally asks the panel
    // for focus.
    const app = createApp();
    const before = app['detailFieldFocusRequest']();

    app['addBlankCoin']();

    const coin = app['inv'].inventory().at(-1)!;
    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(coin.id);
    expect(app['detailFieldFocusRequest']()).toBe(before + 1);
  });

  it('asks for the caret again on a second Add Coin', () => {
    // A counter, not a flag: a boolean already set to `true` would make the
    // second press change nothing, so the panel would never be told.
    const app = createApp();

    app['addBlankCoin']();
    const first = app['detailFieldFocusRequest']();
    app['addBlankCoin']();

    expect(app['detailFieldFocusRequest']()).toBe(first + 1);
  });

  it('cancels an outstanding caret request when the panel is closed', () => {
    // The panel is destroyed when it closes, so the next one is a fresh
    // instance that has never acted on the request. If the next thing the
    // user does is click a grid row, a left-over request would throw focus
    // out of the grid and the arrow keys would stop working.
    const app = createApp();
    app['addBlankCoin']();
    expect(app['detailFieldFocusRequest']()).toBeGreaterThan(0);

    app['closeDetailPanel']();
    expect(app['detailFieldFocusRequest']()).toBe(0);
  });

  it('does not ask for the caret when a row is activated', () => {
    // Opening the panel from the grid must leave focus in the grid, or the
    // arrow keys stop working the instant the panel appears.
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    const before = app['detailFieldFocusRequest']();

    app['openCoinDetail'](coin.id);

    expect(app['detailFieldFocusRequest']()).toBe(before);
  });

  it('still offers the image action for a coin with no images, and opens it closed', () => {
    // The gallery is the only place in the app where a photo can be attached
    // to one particular coin, so refusing to open it for a coin with no
    // photos would mean a coin could never get its first one from the UI.
    // `canOpenImageGallery` therefore means only "is a coin selected".
    //
    // Opening the detail panel still does NOT open the gallery by itself —
    // that takes a click.
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Dime', coinType: 'Roosevelt', imagePaths: [] });

    app['openCoinDetail'](coin.id);
    expect(app['images'].canOpenImageGallery(coin)).toBe(true);
    expect(app['images'].showImageGallery()).toBe(false);

    // ...and the button genuinely opens it on an empty coin.
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

  // NOTE: a 'filters by dealer' test sat here, covering the advanced panel's
  // "Search dealers" box. The coin-level dealer field, its filter signal and
  // that input were all removed, so there is nothing left to assert.

  // --- Valuation ---

  it('computes total profit/loss', () => {
    const app = createApp();
    addTestCoin(app, { purchasePrice: 100, currentValue: 150 });
    addTestCoin(app, { purchasePrice: 200, currentValue: 180 });

    expect(app['inv'].totalProfit()).toBe(30);
  });


  it('gives each grade tier its own badge colour', () => {
    // One shade per tier so the grid can be read by colour alone.
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
    // The tier is keyed on the COMPLETE letter run, so VF and F are simply
    // different keys and no reordering can confuse them. Kept as tests
    // because the failure would be a wrong COLOUR rather than an error.
    expect(gradeBadgeClass('VF20')).toContain('grade-vf');   // never F
    expect(gradeBadgeClass('VG8')).toContain('grade-vg');    // never G
    expect(gradeBadgeClass('FR2')).toContain('grade-basal'); // never F
    expect(gradeBadgeClass('F12')).toContain('grade-f');
    expect(gradeBadgeClass('G4')).toContain('grade-g');
  });

  it('ignores whatever follows the grade letters', () => {
    // A number, a designation, a plus -- all refine the grade without moving
    // it to a different tier.
    expect(gradeBadgeClass('MS64RB')).toContain('grade-ms');
    expect(gradeBadgeClass('PF69DCAM')).toContain('grade-pf');
    expect(gradeBadgeClass('AU58+')).toContain('grade-au');
    expect(gradeBadgeClass('MS')).toContain('grade-ms');
  });

  it('reads the grade through a leading qualifier', () => {
    // "Choice VF" is a VF; the prefix must not hide the letters behind it.
    expect(gradeBadgeClass('Choice VF')).toContain('grade-vf');
    expect(gradeBadgeClass('Gem BU')).toContain('grade-ms');
  });

  it('treats PR as proof and EF as XF', () => {
    // PCGS prints PR where NGC prints PF; EF and XF are the same grade.
    expect(gradeBadgeClass('PR64')).toContain('grade-pf');
    expect(gradeBadgeClass('EF40')).toContain('grade-xf');
  });

  it('falls back to grey for a grade it does not recognise', () => {
    // Grey says "no grade"; a guessed colour would assert something untrue.
    expect(gradeBadgeClass('wibble')).toContain('badge--ungraded');
  });

  // --- Spot prices & melt value ---

  it('calculates melt value for gold coins', () => {
    const app = createApp();
    app['inv'].updateSpotPrices({ ...app['inv'].spotPrices(), gold: 2000 });

    // pmWeightGrams is the PURE metal weight, so 15.55175 g is exactly half a
    // troy ounce OF GOLD -- not half an ounce of alloy that is 90% gold.
    const coin = addTestCoin(app, {
      metalContent: 'Gold',
      pmWeightGrams: 15.55175,
      pmPercent: 90
    });

    // Expected: (15.55175 / 31.1035) * 2000 = 0.5 * 2000 = 1000.
    //
    // This asserted 900 until the double-discount bug was fixed: the old
    // formula applied pmPercent a second time, even though pmWeightGrams had
    // already had purity baked into it. See computeMeltValue for the full
    // explanation. 900 is the value for a coin holding 0.45 oz of gold, which
    // is not what this fixture describes.
    expect(app['inv'].meltValue(coin)).toBeCloseTo(1000, 1);
  });

  it('still values a coin whose purity percentage was never recorded', () => {
    // Purity is not an input to the melt arithmetic, so its absence must not
    // suppress the answer when the pure weight and the metal are both known.
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
    // A "—" because nobody has ever fetched prices is two clicks from being
    // fixed; a "—" because the coin is base metal is not fixable at all. The
    // hint has to tell them apart, otherwise the feature just looks broken.
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
    // Melt is displayed in the coin editor's pricing row, directly after
    // Value, rather than in a summary block at the top of the detail panel —
    // "$412.63" on its own says little, but beside what the coin is valued at
    // it answers whether the coin is worth more than the metal in it.
    const { inv, storage } = createTestInventoryService();
    void new App(storage, inv, new CsvService());
    inv.updateSpotPrices({ gold: 2600, silver: 30, platinum: 950, copper: 4 });

    const coin = makeCoin({ id: 'melt-1', metalContent: 'Silver', pmWeightGrams: 31.1035 });
    inv.inventory.set([coin]);
    inv.selectCoin('melt-1');

    // Asserted through the two pieces the editor's `meltValueDisplay`
    // computed is composed of, rather than by constructing CoinEditorForm.
    // That component cannot be built here: its constructor calls `effect()`,
    // which needs a full environment injector, and its `coin` is a required
    // signal input needing TestBed.createComponent — both of which want a DOM
    // this suite does not have. The computed itself is a one-line composition
    // of exactly these two calls, so this covers the behaviour that matters.
    const selected = inv.selectedCoin()!;
    // Exactly one troy ounce of pure silver at $30.
    expect(formatMeltValue(inv.meltValue(selected))).toBe('$30.00');

    // A base-metal coin reads "—", never "$0.00": unknown is not worthless.
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
    // The fetch is deliberately NOT awaited by start-up, so let the
    // microtask queue drain before asserting on its effects.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(inv.spotPrices()).toEqual({ gold: 2700, silver: 33, platinum: 1000, copper: 5 });
    expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
  });

  it('still finishes starting up when the automatic COMEX fetch fails', async () => {
    // No internet, blocked proxy, dead upstream. The app must come up exactly
    // as if nothing had been attempted — and with the prices it loaded from
    // the database still in place, since those are the whole point.
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
    // Error toasts in this app are STICKY. A failed automatic fetch must
    // never leave one, or a machine with no internet gets a permanent red
    // banner on every single launch.
    expect(mockNotification.showError).not.toHaveBeenCalled();
  });

  it('does not attempt the automatic fetch when start-up itself failed', async () => {
    const { inv, storage, mockApiService } = createTestInventoryService();
    (mockApiService.getCoins as any).mockReturnValue(throwError(() => new Error('ECONNREFUSED')));

    const app = new App(storage, inv, new CsvService());
    await app['hydrateFromStorage']();
    await Promise.resolve();

    expect(mockApiService.fetchSpotPrices).not.toHaveBeenCalled();

    // ...but the retry that finally connects does get it, because THAT is
    // when start-up actually finished.
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

    // Pressing Retry again does not fetch a second time: at most one
    // successful automatic fetch per session.
    await app['retryConnection']();
    await Promise.resolve();
    expect(mockApiService.fetchSpotPrices).toHaveBeenCalledTimes(1);
  });

  // --- Transactions ---
  //
  // Two cases lived here and both drove CoinDetailPanel's
  // addTransactionForSelectedCoin / deleteTransaction against a Transactions
  // table: one added and deleted a transaction, one checked deleting a coin
  // took its transactions with it. Table, routes, client service and panel
  // methods are all gone, so neither case has a subject any more; a coin's
  // purchase and sale are fields on the coin and go with it by definition.
  //
  // The ONE thing worth keeping is that the panel no longer offers those
  // entry points at all — a surviving method would be calling an endpoint
  // that answers index.html.
  it('no longer offers transaction entry points on the detail panel', () => {
    const app = createApp();
    const panel = createDetailPanelFor(app['inv']) as unknown as Record<string, unknown>;

    expect(panel['addTransactionForSelectedCoin']).toBeUndefined();
    expect(panel['deleteTransaction']).toBeUndefined();
    expect((app['inv'] as unknown as Record<string, unknown>)['addTransaction']).toBeUndefined();
    expect((app['inv'] as unknown as Record<string, unknown>)['transactions']).toBeUndefined();
  });

  // --- Column formatting ---

  // Was 'formats dealer and coinSet columns'. The dealer column is gone; the
  // coinSet half of the assertion is all that remains.
  it('formats the coinSet column', () => {
    const app = createApp();
    const coin = addTestCoin(app, { coinSet: 'Morgan Set' });
    expect(formatInventoryCell(coin, 'coinSet')).toBe('Morgan Set');
  });

  // `weight` is the coin's GROSS weight in GRAMS -- 26.73 g is a Morgan
  // dollar. Three decimals, matching the PM Weight (g) column beside it.
  it('formats sold price and weight columns', () => {
    const app = createApp();
    const coin = addTestCoin(app, { soldPrice: 250, weight: 26.73 });
    expect(formatInventoryCell(coin, 'soldPrice')).toBe('$250.00');
    expect(formatInventoryCell(coin, 'weight')).toBe('26.730');
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
 * THE SHELL'S LAZY-LOADING CONTRACT (app.html)
 *
 * Every dialog, and the detail sidebar, are fetched on demand with @defer so
 * that none of them sits in the initial bundle. Two things about that are
 * easy to break silently, and invisible to the rest of this file: these
 * specs run without a DOM and never render the shell template at all, so
 * the only way to hold the contract is to read the template as text.
 *
 * 1. A @defer BLOCK NEVER REVERTS. Once its `when` condition has been true
 *    once, the block stays rendered for the life of the page. The original
 *    `@if` therefore has to survive INSIDE the block — it is what still
 *    closes the dialog. Delete it as a redundant-looking duplicate of the
 *    trigger and every dialog in the app becomes impossible to close, with
 *    nothing anywhere failing to say so.
 *
 * 2. THE ALWAYS-VISIBLE FURNITURE MUST NOT BE DEFERRED. Deferring the
 *    toolbar or the table would buy a smaller bundle with a blank screen on
 *    start-up, which is the opposite of the point.
 */
describe('the deferred screens in the shell template', () => {
  const TEMPLATE = readFileSync(join(__dirname, 'app.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');

  /*
   * Each @defer header, parsed. The condition is read by splitting the
   * header on `;` rather than by a regex that stops at the first `)`:
   * every trigger here ends in a call, `when showDetailPanel()`, and a
   * character class excluding `)` captures `showDetailPanel(` instead.
   */
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
    // The trigger decides when the CODE arrives. The @if still decides when
    // the dialog is on SCREEN. Without the second one, nothing ever closes.
    for (const condition of conditions) {
      expect(TEMPLATE, `@defer (when ${condition}) has no @if to close it again`)
        .toContain(`@if (${condition}`);
    }
  });

  it('prefetches the hot path, and only the hot path', () => {
    // A row click opens the detail panel, the photo button opens the
    // gallery, a thumbnail opens the viewer: all routine, all expected to
    // feel instant, so their chunks are fetched while the app is idle
    // instead of when the user clicks.
    const prefetched = deferBlocks.filter(b => b.prefetched).map(b => b.condition).sort();

    expect(prefetched).toEqual([
      'images.showImageGallery()',
      'images.showPhotoViewer()',
      'showDetailPanel()'
    ]);

    // Everything else — reports, statistics, spot prices, Reference Data,
    // the three import dialogs, settings, help, support — is opened
    // deliberately and rarely. Downloading all of it at start-up for a user
    // who opens none of it would hand the bundle saving straight back.
    expect(prefetched).toHaveLength(3);
  });

  it('shows nothing at all for the first 100ms of a load', () => {
    // No @placeholder anywhere, so until a trigger fires the shell renders
    // exactly what the bare @if used to: nothing. And the loading state
    // waits 100ms, so on a normal open — a few milliseconds from local
    // disk — nothing is drawn there either. A backdrop that flashes up and
    // vanishes is worse than no backdrop at all.
    expect(TEMPLATE).not.toContain('@placeholder');
    expect(TEMPLATE.match(/@loading \(after 100ms\)/g) ?? []).toHaveLength(deferBlocks.length);
  });

  it('leaves the always-visible furniture eagerly loaded', () => {
    // Walks each block to its matching close brace rather than matching a
    // lazy regex between the opener and a tag: that would happily run out
    // of one block and into a later one, and report a tag as deferred
    // because something else further down the file was.
    const deferredMarkup = deferBlockBodies(TEMPLATE).join('\n');

    for (const tag of ['app-toolbar', 'app-inventory-filter-bar', 'app-inventory-table',
                       'app-notification-toast', 'app-bulk-edit-bar']) {
      expect(TEMPLATE, `<${tag}> has gone missing from the shell`).toContain(`<${tag}`);
      expect(deferredMarkup, `<${tag}> is on screen from the first paint and must not be deferred`)
        .not.toContain(`<${tag}`);
    }
  });
});

/**
 * The body of every @defer block in a template, located by counting braces
 * from each block's opening `{`. Nested @if blocks are included; the
 * @loading block that follows the closing brace is not.
 */
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
