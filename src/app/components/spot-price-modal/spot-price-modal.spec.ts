import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { InventoryService } from '../../services/inventory.service';
import { SpotPriceService } from '../../services/spot-price.service';
import { SpotPriceModalComponent } from './spot-price-modal';
import { createTestInventoryService, createTestSpotPriceService } from '../../testing/test-helpers';

function createModal(spotPriceOverrides?: { mockApiService?: any }) {
  // Both InventoryService and SpotPriceService use inject()
  const { inv, mockApiService } = createTestInventoryService();
  const { service: spotPrice } = createTestSpotPriceService(spotPriceOverrides);
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: SpotPriceService, useValue: spotPrice }
    ]
  });
  const modal = runInInjectionContext(injector, () => new SpotPriceModalComponent());
  return { modal, inv, mockApiService };
}

describe('SpotPriceModalComponent', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('updates spot prices', () => {
    const { modal, inv } = createModal();
    modal['updateSpotPrice']('gold', 2650);
    expect(inv.spotPrices().gold).toBe(2650);
  });

  it('updates multiple spot prices independently', () => {
    const { modal, inv } = createModal();
    modal['updateSpotPrice']('gold', 2000);
    modal['updateSpotPrice']('silver', 25);
    expect(inv.spotPrices().gold).toBe(2000);
    expect(inv.spotPrices().silver).toBe(25);
  });

  it('treats a blank or nonsense box as "no price", not as a crash', () => {
    // An emptied number input arrives as null -> Number(null) is 0; a lone
    // "-" arrives as NaN. Both mean "I have no price for this metal".
    const { modal, inv } = createModal();
    modal['updateSpotPrice']('gold', Number.NaN);
    expect(inv.spotPrices().gold).toBe(0);
    modal['updateSpotPrice']('silver', -5);
    expect(inv.spotPrices().silver).toBe(0);
  });

  // ==========================================================================
  // THE HISTORY-ROW TRAP
  // --------------------------------------------------------------------------
  // POST /api/spot-prices INSERTS A NEW ROW every time. The price inputs are
  // bound with (ngModelChange), which fires per keystroke. These tests are the
  // guard rail against anyone "simplifying" the save back into the setter.
  // ==========================================================================

  describe('saving only on deliberate actions', () => {
    it('writes nothing while the user is typing', () => {
      const { modal, mockApiService } = createModal();

      // "2650", one character at a time.
      modal['updateSpotPrice']('gold', 2);
      modal['updateSpotPrice']('gold', 26);
      modal['updateSpotPrice']('gold', 265);
      modal['updateSpotPrice']('gold', 2650);

      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('writes exactly one row when the user closes after editing', async () => {
      const { modal, mockApiService } = createModal();
      modal['updateSpotPrice']('gold', 2);
      modal['updateSpotPrice']('gold', 26);
      modal['updateSpotPrice']('gold', 2650);

      await modal['close']();

      expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledWith(
        expect.objectContaining({ gold: 2650, source: 'Manual entry' })
      );
    });

    it('writes nothing when the modal is opened and closed without edits', async () => {
      const { modal, mockApiService } = createModal();

      await modal['close']();

      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });

    it('emits closed() so the shell still hides the modal', async () => {
      const { modal } = createModal();
      const emitted = vi.fn();
      modal.closed.subscribe(emitted);

      modal['updateSpotPrice']('gold', 2650);
      await modal['close']();

      expect(emitted).toHaveBeenCalled();
    });

    it('saves once after a successful fetch, and not again on close', async () => {
      const { modal, mockApiService } = createModal({
        mockApiService: {
          fetchSpotPrices: vi.fn(() => of({
            prices: { gold: 2700, silver: 33, platinum: 1000, copper: 5 },
            source: 'COMEX/NYMEX futures via Yahoo Finance',
            timestamp: '2026-10-03T09:00:00.000Z'
          }))
        }
      });

      await modal['fetchSpotPrices']();
      await modal['close']();

      // One deliberate action, one history row.
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledTimes(1);
      expect(mockApiService.saveSpotPrices).toHaveBeenCalledWith({
        gold: 2700, silver: 33, platinum: 1000, copper: 5,
        source: 'COMEX/NYMEX futures via Yahoo Finance'
      });
    });

    it('writes nothing when the fetch fails', async () => {
      const { modal, inv, mockApiService } = createModal({
        mockApiService: {
          fetchSpotPrices: vi.fn(() => of({
            prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
            source: 'COMEX/NYMEX futures via Yahoo Finance',
            timestamp: '',
            error: 'No price available for: gold, silver, platinum, copper'
          }))
        }
      });

      await modal['fetchSpotPrices']();

      expect(modal['spotPriceError']()).toContain('No price available');
      // A ZERO IS NOT A PRICE: the zeroed result is not adopted...
      expect(inv.spotPrices()).toEqual({ gold: 0, silver: 0, platinum: 0, copper: 0 });
      // ...and above all it is not written to the history table, where it
      // would be read back on every future launch.
      expect(mockApiService.saveSpotPrices).not.toHaveBeenCalled();
    });
  });

  describe('telling "no prices yet" apart from "no precious metal"', () => {
    it('flags an empty price set', () => {
      const { modal } = createModal();
      expect(modal['noPricesYet']()).toBe(true);
    });

    it('stops flagging once any metal has a price', () => {
      const { modal } = createModal();
      modal['updateSpotPrice']('silver', 30);
      expect(modal['noPricesYet']()).toBe(false);
    });

    it('shows the provenance of prices loaded at start-up, not just fetched ones', async () => {
      // Before this, reopening the app showed an empty fetch bar as though
      // nothing had ever been retrieved, even with good saved prices in use.
      const { modal, inv, mockApiService } = createModal();
      (mockApiService.getLatestSpotPrices as any).mockReturnValue(of({
        gold: 2600, silver: 30, platinum: 950, copper: 4,
        source: 'COMEX/NYMEX futures via Yahoo Finance',
        fetchedAt: '2026-10-02T14:02:00.000Z'
      }));

      await inv.hydrate();

      expect(modal['savedSource']()).toBe('COMEX/NYMEX futures via Yahoo Finance');
      expect(modal['savedAt']()).toBe('2026-10-02T14:02:00.000Z');
      expect(modal['noPricesYet']()).toBe(false);
    });
  });
});
