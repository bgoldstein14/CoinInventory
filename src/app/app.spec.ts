import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
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
 * so tests can drive detail-panel behaviour (transactions) against the same
 * inventory the App sees.
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

  // ==========================================================================
  // Regression tests: a failed save must stay recoverable.
  //
  // THE BUG THESE GUARD AGAINST: updateCoin() used to diff new edits against
  // the OPTIMISTIC local record. When a PUT failed, the local record already
  // held the new value, so re-typing the same value produced an empty diff,
  // updateCoin() returned early, and the edit was lost forever with no further
  // feedback. Diffing against the last SERVER-CONFIRMED value fixes that.
  // ==========================================================================

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

  // `imagePaths` is now the ONLY array field on a coin. This test used to use
  // `tags` for its second half; tags were removed (nothing could ever set one),
  // so both halves are expressed with imagePaths instead. The rule being
  // protected is unchanged: arrays are compared by CONTENT, not by identity.
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

  // ==========================================================================
  // Regression tests: a NEW coin is a local draft until it is worth saving.
  //
  // THE BUG THESE GUARD AGAINST: "Add coin" used to POST a completely empty
  // record straight away. The backend answered
  // `400 {"error":"denomination is required"}`, so the user got a red error
  // toast before typing a single character.
  //
  // The rule now: a new row lives only on screen until it has at least 2 of
  // Year / Coin Type / Denomination (the SAME 2-of-3 rule the QIF importer
  // uses, from services/coin-completeness.ts). Then it POSTs itself once and
  // behaves like any other coin from that moment on.
  // ==========================================================================

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

  // ==========================================================================
  // Regression tests: connection recovery
  // ==========================================================================

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
    // order unambiguous under the DEFAULT sort. That default is Year
    // ascending (it used to be Coin Type, which is why this test previously
    // distinguished its coins by 'Alpha' and 'Zebra'), so the years are what
    // decide the order here.
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
    const certified = addTestCoin(app, { certCompany: 'NGC', certNumber: '255481-016' });
    const uncertified = addTestCoin(app, { certCompany: '', certNumber: '' });

    expect(certBadgeLabel(certified)).toBe('NGC #255481-016');
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

  it('keeps the detail sidebar closed until a details button is clicked', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });

    app['selectCoin'](coin.id);
    expect(app['showDetailPanel']()).toBe(false);
    expect(app.selectedCoin?.id).toBe(coin.id);

    app['openCoinDetail'](coin.id);
    expect(app['showDetailPanel']()).toBe(true);
    expect(app.selectedCoin?.id).toBe(coin.id);
  });

  it('disables the image action when a coin has no images', () => {
    const app = createApp();
    const coin = addTestCoin(app, { denomination: 'Dime', coinType: 'Roosevelt', imagePaths: [] });

    app['openCoinDetail'](coin.id);
    expect(app['images'].canOpenImageGallery(coin)).toBe(false);
    expect(app['images'].showImageGallery()).toBe(false);
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


  it('returns correct grade badge class', () => {
    expect(gradeBadgeClass('MS65')).toContain('badge--mint');
    expect(gradeBadgeClass('VF')).toContain('badge--circulated');
    expect(gradeBadgeClass('G')).toContain('badge--worn');
    expect(gradeBadgeClass('')).toContain('badge--ungraded');
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

  // Adding/deleting a single transaction now belongs to CoinDetailPanel, which
  // owns that part of the UI — the panel is driven directly here.
  it('adds and deletes transactions for a coin', () => {
    const app = createApp();
    const panel = createDetailPanelFor(app['inv']);
    const coin = addTestCoin(app, { denomination: 'Eagle', coinType: 'Gold' });
    app['selectCoin'](coin.id);

    panel.addTransactionForSelectedCoin('purchase', 150, 'Heritage Auctions', '2024-01-15', 'Great deal');

    const txns = app['inv'].selectedCoinTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('purchase');
    expect(txns[0].amount).toBe(150);
    expect(txns[0].dealer).toBe('Heritage Auctions');

    panel.deleteTransaction(txns[0].id);
    expect(app['inv'].selectedCoinTransactions()).toHaveLength(0);
  });

  it('deleting a coin also removes its transactions', () => {
    const app = createApp();
    const panel = createDetailPanelFor(app['inv']);
    const coin = addTestCoin(app, { denomination: 'Quarter', coinType: 'Washington' });
    app['selectCoin'](coin.id);

    panel.addTransactionForSelectedCoin('purchase', 100, '', '', '');
    expect(app['inv'].transactions()).toHaveLength(1);

    app['deleteSelectedCoin']();
    expect(app['inv'].transactions()).toHaveLength(0);
  });

  // --- Column formatting ---

  // Was 'formats dealer and coinSet columns'. The dealer column is gone; the
  // coinSet half of the assertion is all that remains.
  it('formats the coinSet column', () => {
    const app = createApp();
    const coin = addTestCoin(app, { coinSet: 'Morgan Set' });
    expect(formatInventoryCell(coin, 'coinSet')).toBe('Morgan Set');
  });

  // `weight` is the coin's GROSS weight in GRAMS. It used to be troy ounces,
  // and this test used to assert '0.7734' -- the troy-ounce weight of a Morgan
  // dollar, at the four decimals the grid showed then. 26.73 g is the SAME
  // coin expressed the new way, and the grid now shows three decimals to match
  // the PM Weight (g) column beside it. See migrations/008-weight-to-grams.sql.
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
