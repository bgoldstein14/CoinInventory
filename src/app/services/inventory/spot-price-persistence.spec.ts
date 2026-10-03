import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/* ===========================================================================
 * Spot price persistence — the plumbing that makes melt value actually work
 * ---------------------------------------------------------------------------
 * The melt ARITHMETIC was correct and tested long before any of this existed;
 * what was missing was everything around it. Prices were never written to the
 * database, never read back at start-up, and so reset to zero on every launch,
 * which made every melt figure in the app render as "—" for ever.
 *
 * These tests cover the three pieces of plumbing that fixed that, and one
 * trap. The trap is the reason this file exists at all:
 *
 *     POST /api/spot-prices INSERTS A NEW HISTORY ROW EVERY TIME.
 *
 * So the tests below care as much about when we DON'T save as when we do. A
 * save wired into the price setter would have written one row per keystroke.
 * =========================================================================== */

/** A complete CoinRecord, overridable per test. */
function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Half Dollar', year: '1964', coinType: 'Kennedy',
    category: 'Silver', country: 'United States', grade: 'MS65', certCompany: '',
    certNumber: '', variety: '', mintMark: 'P', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 10, currentValue: 15, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

/** The shape GET /api/spot-prices/latest returns for a populated table. */
function savedRow(overrides: Record<string, unknown> = {}) {
  return {
    gold: 2600, silver: 30, platinum: 950, copper: 4,
    source: 'COMEX/NYMEX futures via Yahoo Finance',
    fetchedAt: '2026-10-02T14:02:00.000Z',
    ...overrides
  };
}

describe('spot price persistence', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // ==========================================================================
  // B. Loading saved prices at start-up
  // ==========================================================================

  describe('hydrate() loads saved spot prices', () => {
    it('applies the newest saved row so melt values work from the first second', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
      expect(inv.hasSpotPrices()).toBe(true);
      // Provenance comes back too, so the modal can say where these are from
      // rather than looking as though nothing was ever fetched.
      expect(inv.spotPriceMeta().source).toBe('COMEX/NYMEX futures via Yahoo Finance');
      expect(inv.spotPriceMeta().fetchedAt).toBe('2026-10-02T14:02:00.000Z');
    });

    it('converts prices that arrive as strings from the SQL driver', async () => {
      // SQL Server DECIMAL columns can come back as strings depending on
      // precision. A string would silently fail the `spotPerOz <= 0` test in
      // computeMeltValue and produce dashes everywhere.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of(savedRow({ gold: '2600.50', silver: '30.25' }))
      );

      await inv.hydrate();

      expect(inv.spotPrices().gold).toBe(2600.5);
      expect(inv.spotPrices().silver).toBe(30.25);
    });

    it('leaves the defaults alone when nothing has ever been saved', async () => {
      // An empty SpotPrices table still answers 200 — zeros and two nulls.
      // `fetchedAt: null` is what distinguishes it from a real row of zeros.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of({ gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null })
      );

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 0, silver: 0, platinum: 0, copper: 0 });
      expect(inv.hasSpotPrices()).toBe(false);
      expect(inv.spotPriceMeta().prices).toBeNull();
      // Not a failure, so no warning toast about missing reference data.
      expect(inv.connected()).toBe(true);
    });

    it('ignores a saved row whose prices are all zero', async () => {
      // A ZERO IS NOT A PRICE. Such a row can exist from before the save
      // guards were added — a failed fetch used to be able to persist its
      // zeroed result. Believing it would mean permanently blank melt values
      // that the user could not explain.
      const { inv, mockApiService, mockLogger } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of(savedRow({ gold: 0, silver: 0, platinum: 0, copper: 0 }))
      );

      await inv.hydrate();

      expect(inv.hasSpotPrices()).toBe(false);
      expect(inv.spotPriceMeta().prices).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('all zero'));
    });

    it('accepts a saved row where only some metals have a price', async () => {
      // Partial data is normal: the four symbols are fetched independently
      // upstream, so one can fail on its own. Gold still has a price here;
      // platinum simply does not.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of(savedRow({ platinum: 0, copper: 0 }))
      );

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 0, copper: 0 });
      // Gold prices fine...
      expect(inv.meltValue(makeCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035 }))).toBeCloseTo(2600, 0);
      // ...platinum is "cannot say", NOT "$0.00".
      expect(inv.meltValue(makeCoin({ metalContent: 'Platinum', pmWeightGrams: 31.1035 }))).toBeNull();
    });

    it('survives a failing spot price lookup with the defaults intact', async () => {
      // This is the "one bad lookup cannot sink hydration" guarantee, applied
      // to spot prices. The coins loaded, so the app is connected and usable;
      // the only casualty is that melt values stay blank.
      const { inv, mockApiService, mockNotification, mockLogger } = createTestInventoryService();
      (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        throwError(() => new Error('spot price table exploded'))
      );

      await expect(inv.hydrate()).resolves.toBeUndefined();

      expect(inv.connected()).toBe(true);
      expect(inv.connectionError()).toBeNull();
      expect(inv.inventory()).toHaveLength(1);
      // Defaults untouched — never a partial or garbage price set.
      expect(inv.spotPrices()).toEqual({ gold: 0, silver: 0, platinum: 0, copper: 0 });
      expect(inv.spotPriceMeta().prices).toBeNull();
      // Warned, not errored.
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockNotification.showWarning).toHaveBeenCalledWith(
        expect.stringContaining('spot prices')
      );
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });

    it('does not let a failing spot price lookup take the other lookups down with it', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        throwError(() => new Error('nope'))
      );

      await inv.hydrate();

      expect(inv.metalContents().length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // C. Saving only on deliberate actions
  // ==========================================================================

  describe('updateSpotPrices() never writes to the database', () => {
    it('stays in memory no matter how many times it is called', () => {
      // This is the keystroke path. Typing "2650" calls it four times.
      const { inv, mockApiService } = createTestInventoryService();

      inv.updateSpotPrices({ gold: 2, silver: 0, platinum: 0, copper: 0 });
      inv.updateSpotPrices({ gold: 26, silver: 0, platinum: 0, copper: 0 });
      inv.updateSpotPrices({ gold: 265, silver: 0, platinum: 0, copper: 0 });
      inv.updateSpotPrices({ gold: 2650, silver: 0, platinum: 0, copper: 0 });

      expect(inv.spotPrices().gold).toBe(2650);
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });
  });

  describe('commitSpotPrices() writes exactly one row, and only when worthwhile', () => {
    it('writes one history row with its provenance', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      inv.updateSpotPrices({ gold: 2650, silver: 31, platinum: 0, copper: 0 });

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(true);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledWith({
        gold: 2650, silver: 31, platinum: 0, copper: 0, source: 'Manual entry'
      });
      expect(inv.spotPriceMeta().source).toBe('Manual entry');
      expect(inv.spotPriceMeta().prices).toEqual({ gold: 2650, silver: 31, platinum: 0, copper: 0 });
    });

    it('skips a second save of identical prices', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      inv.updateSpotPrices({ gold: 2650, silver: 31, platinum: 0, copper: 0 });

      await inv.commitSpotPrices('Manual entry');
      const second = await inv.commitSpotPrices('Manual entry');

      expect(second).toBe(false);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
    });

    it('skips a save of prices identical to the ones just loaded from the database', async () => {
      // Open the modal, change nothing of substance, close it. The prices on
      // screen are the ones hydrate() read out of the database, so writing
      // them back would duplicate a row for no information at all.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));
      await inv.hydrate();

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(false);
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('refuses to record an all-zero price set', async () => {
      // A ZERO IS NOT A PRICE. An all-zero row is persistent garbage: the
      // next start-up would read it straight back and blank every melt value
      // in the app, turning one bad moment into a permanent fault.
      const { inv, mockApiService } = createTestInventoryService();

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(false);
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('saves the metals that do have prices even when others are left blank', async () => {
      // A blank box means "no price for that metal", not "free" and not
      // "cancel the save". Only an entirely empty set is refused.
      const { inv, mockApiService } = createTestInventoryService();
      inv.updateSpotPrices({ gold: 2650, silver: 0, platinum: 0, copper: 0 });

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(true);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledWith({
        gold: 2650, silver: 0, platinum: 0, copper: 0, source: 'Manual entry'
      });
    });

    it('keeps the prices usable when the save fails', async () => {
      const { inv, mockApiService, mockNotification } = createTestInventoryService();
      (mockApiService.saveSpotPrices as any).mockReturnValue(throwError(() => new Error('db down')));
      inv.updateSpotPrices({ gold: 2650, silver: 31, platinum: 0, copper: 0 });

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(false);
      // The in-memory prices survive, so melt values still work this session.
      expect(inv.spotPrices().gold).toBe(2650);
      expect(inv.meltValue(makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 }))).toBeCloseTo(31, 1);
      // Warned, not a sticky error.
      expect(mockNotification.showWarning).toHaveBeenCalled();
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // The automatic COMEX refresh once start-up has finished
  // ==========================================================================

  describe('autoRefreshSpotPrices()', () => {
    it('applies and saves live prices when the fetch succeeds', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
        prices: { gold: 2700, silver: 33, platinum: 1000, copper: 5 },
        source: 'COMEX/NYMEX futures via Yahoo Finance',
        timestamp: '2026-10-03T09:00:00.000Z'
      }));

      const refreshed = await inv.autoRefreshSpotPrices();

      expect(refreshed).toBe(true);
      expect(inv.spotPrices()).toEqual({ gold: 2700, silver: 33, platinum: 1000, copper: 5 });
      // One successful fetch, one history row. Not two.
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledWith({
        gold: 2700, silver: 33, platinum: 1000, copper: 5,
        source: 'COMEX/NYMEX futures via Yahoo Finance'
      });
    });

    it('runs at most once successfully per session', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
        prices: { gold: 2700, silver: 33, platinum: 1000, copper: 5 },
        source: 'COMEX', timestamp: ''
      }));

      await inv.autoRefreshSpotPrices();
      const second = await inv.autoRefreshSpotPrices();

      expect(second).toBe(false);
      expect(mockApiService.fetchSpotPrices).toHaveBeenCalledTimes(1);
    });

    it('leaves database-loaded prices untouched when the fetch rejects', async () => {
      // No internet / blocked proxy. The saved prices are the whole point of
      // the feature; losing them here would be worse than not trying.
      const { inv, mockApiService, mockNotification } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));
      await inv.hydrate();
      (mockApiService.saveSpotPrices as any).mockClear();
      (mockApiService.fetchSpotPrices as any).mockReturnValue(
        throwError(() => new Error('getaddrinfo ENOTFOUND query1.finance.yahoo.com'))
      );

      const refreshed = await inv.autoRefreshSpotPrices();

      expect(refreshed).toBe(false);
      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
      // Above all: no sticky red toast greeting the owner on every launch.
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });

    it('does not blank saved prices when the backend answers 200 with an error', async () => {
      // The /fetch route degrades gracefully: 200, zeroed prices, `error` set.
      // Storing those zeros would wipe every melt value in the app.
      const { inv, mockApiService, mockNotification } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));
      await inv.hydrate();
      (mockApiService.saveSpotPrices as any).mockClear();
      (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
        prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
        source: 'COMEX/NYMEX futures via Yahoo Finance',
        timestamp: '',
        error: 'No price available for: gold, silver, platinum, copper'
      }));

      const refreshed = await inv.autoRefreshSpotPrices();

      expect(refreshed).toBe(false);
      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });

    it('ignores an all-zero "success" that carries no error field', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));
      await inv.hydrate();
      (mockApiService.fetchSpotPrices as any).mockReturnValue(of({
        prices: { gold: 0, silver: 0, platinum: 0, copper: 0 }, source: 'COMEX', timestamp: ''
      }));

      await inv.autoRefreshSpotPrices();

      expect(inv.spotPrices().gold).toBe(2600);
    });

    it('never throws, whatever the fetch does', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.fetchSpotPrices as any).mockImplementation(() => {
        throw new Error('synchronous explosion');
      });

      await expect(inv.autoRefreshSpotPrices()).resolves.toBe(false);
    });
  });

  // ==========================================================================
  // Melt value end to end, from a restart
  // ==========================================================================

  it('shows a melt value for a silver coin after a restart, with no fetch at all', async () => {
    // The owner's actual requirement, in one test: melt auto-calculates from
    // whatever the last retrieved prices were, with nothing updating live.
    const { inv, mockApiService } = createTestInventoryService();
    const kennedy = makeCoin({ metalContent: '40% Silver', pmWeightGrams: 4.6, pmPercent: 40 });
    (mockApiService.getCoins as any).mockReturnValue(of([kennedy]));
    (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow({ silver: 30 })));

    await inv.hydrate();

    // 4.6 g of PURE silver at $30/ozt. Purity is NOT applied again: 4.6 is
    // already the pure weight. Applying 40% a second time would give $1.77.
    expect(inv.meltValue(inv.inventory()[0])).toBeCloseTo(4.436, 2);
  });
});
