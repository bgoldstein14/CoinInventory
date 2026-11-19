import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

 /*
  * Spot price persistence: prices are saved to the database and read back at
  * start-up so melt values survive a restart. POST /api/spot-prices inserts a
  * new history row every time, so the tests check when saving does not happen
  * as much as when it does.
  */

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

/** What GET /api/spot-prices/latest returns for a populated table. */
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

  // Loading saved prices at start-up

  describe('hydrate() loads saved spot prices', () => {
    it('applies the newest saved row so melt values work from the first second', async () => {
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 950, copper: 4 });
      expect(inv.hasSpotPrices()).toBe(true);
      // Provenance is restored too, so the modal can show where prices came from.
      expect(inv.spotPriceMeta().source).toBe('COMEX/NYMEX futures via Yahoo Finance');
      expect(inv.spotPriceMeta().fetchedAt).toBe('2026-10-02T14:02:00.000Z');
    });

    it('converts prices that arrive as strings from the SQL driver', async () => {
      // DECIMAL columns may arrive as strings; they must be converted to numbers.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of(savedRow({ gold: '2600.50', silver: '30.25' }))
      );

      await inv.hydrate();

      expect(inv.spotPrices().gold).toBe(2600.5);
      expect(inv.spotPrices().silver).toBe(30.25);
    });

    it('leaves the defaults alone when nothing has ever been saved', async () => {
      // An empty table answers 200 with zeros and nulls; `fetchedAt: null` marks it.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of({ gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null })
      );

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 0, silver: 0, platinum: 0, copper: 0 });
      expect(inv.hasSpotPrices()).toBe(false);
      expect(inv.spotPriceMeta().prices).toBeNull();
      // Not a failure, so no warning about missing reference data.
      expect(inv.connected()).toBe(true);
    });

    it('ignores a saved row whose prices are all zero', async () => {
      // An all-zero saved row (possible in older data) is ignored, not believed.
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
      // Partial data is normal (symbols are fetched independently): gold priced,
      // platinum not.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        of(savedRow({ platinum: 0, copper: 0 }))
      );

      await inv.hydrate();

      expect(inv.spotPrices()).toEqual({ gold: 2600, silver: 30, platinum: 0, copper: 0 });
      // Gold is priced...
      expect(inv.meltValue(makeCoin({ metalContent: 'Gold', pmWeightGrams: 31.1035 }))).toBeCloseTo(2600, 0);
      // ...platinum is "can't say", not "$0.00".
      expect(inv.meltValue(makeCoin({ metalContent: 'Platinum', pmWeightGrams: 31.1035 }))).toBeNull();
    });

    it('survives a failing spot price lookup with the defaults intact', async () => {
      // A failed price lookup doesn't sink hydration: connected, melt values blank.
      const { inv, mockApiService, mockNotification, mockLogger } = createTestInventoryService();
      (mockApiService.getCoins as any).mockReturnValue(of([makeCoin()]));
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(
        throwError(() => new Error('spot price table exploded'))
      );

      await expect(inv.hydrate()).resolves.toBeUndefined();

      expect(inv.connected()).toBe(true);
      expect(inv.connectionError()).toBeNull();
      expect(inv.inventory()).toHaveLength(1);
      // Defaults untouched.
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

  // Saving only on deliberate actions

  describe('updateSpotPrices() never writes to the database', () => {
    it('stays in memory no matter how many times it is called', () => {
      // The keystroke path: typing "2650" calls it four times.
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
      // Closing the modal without real changes must not duplicate the loaded row.
      const { inv, mockApiService } = createTestInventoryService();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow()));
      await inv.hydrate();

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(false);
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('refuses to record an all-zero price set', async () => {
      // An all-zero row would be read back at the next start-up and blank every melt value.
      const { inv, mockApiService } = createTestInventoryService();

      const wrote = await inv.commitSpotPrices('Manual entry');

      expect(wrote).toBe(false);
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('saves the metals that do have prices even when others are left blank', async () => {
      // A blank box means "no price for that metal"; only an entirely empty set is refused.
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
      // In-memory prices survive, so melt values still work this session.
      expect(inv.spotPrices().gold).toBe(2650);
      expect(inv.meltValue(makeCoin({ metalContent: 'Silver', pmWeightGrams: 31.1035 }))).toBeCloseTo(31, 1);
      // Warned, not a sticky error.
      expect(mockNotification.showWarning).toHaveBeenCalled();
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });
  });

  // The automatic COMEX refresh after start-up

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
      // One successful fetch, one history row.
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
      // No internet or blocked proxy: the saved prices must be kept.
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
      // No sticky error toast on launch.
      expect(mockNotification.showError).not.toHaveBeenCalled();
    });

    it('does not blank saved prices when the backend answers 200 with an error', async () => {
      // The /fetch route degrades to 200 with zeroed prices and `error`; storing
      // those zeros would wipe every melt value.
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

  // Melt value end to end after a restart

  it('shows a melt value for a silver coin after a restart, with no fetch at all', async () => {
    // Melt is calculated from the last saved prices with no fetch.
    const { inv, mockApiService } = createTestInventoryService();
    const kennedy = makeCoin({ metalContent: '40% Silver', pmWeightGrams: 4.6, pmPercent: 40 });
    (mockApiService.getCoins as any).mockReturnValue(of([kennedy]));
    (mockApiService.getLatestSpotPrices as any).mockReturnValue(of(savedRow({ silver: 30 })));

    await inv.hydrate();

    // 4.6 g of pure silver at $30/ozt; purity is not applied again (that would give $1.77).
    expect(inv.meltValue(inv.inventory()[0])).toBeCloseTo(4.436, 2);
  });
});
