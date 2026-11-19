import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { NotificationService } from '../../services/notification.service';
import { ReportModal } from './report-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

function createModal() {
  // InventoryService uses inject(), so it must be created in an injection context.
  const { inv } = createTestInventoryService();
  const api = { getCoinImages: vi.fn(() => of([])) } as unknown as ApiService;
  const notifications = {
    showInfo: vi.fn(), showWarning: vi.fn(), showError: vi.fn()
  } as unknown as NotificationService;

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ApiService, useValue: api },
      { provide: NotificationService, useValue: notifications }
    ]
  });
  const modal = runInInjectionContext(injector, () => new ReportModal());
  return { modal, inv, api, notifications };
}

function addCoin(inv: InventoryService, overrides: Record<string, unknown> = {}) {
  inv.addBlankCoin();
  const coin = inv.inventory().at(-1)!;
  if (Object.keys(overrides).length > 0) inv.updateCoin(coin.id, overrides);
  return inv.inventory().find(c => c.id === coin.id)!;
}

describe('ReportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // A coin with no collectionStatus reads as `owned`.
  it('leaves coins the user does not own out of the collection totals', () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', category: 'Silver', purchasePrice: 100, currentValue: 150 });
    addCoin(inv, {
      coinType: '1893-S Morgan', category: 'Silver',
      purchasePrice: 5000, currentValue: 6000,
      collectionStatus: 'wanted'
    });

    const stats = modal['reportStats']();

    expect(stats.totalCoins).toBe(1);
    expect(stats.totalCost).toBe(100);
    expect(stats.totalValue).toBe(150);
    expect(stats.byCategory).toEqual([['Silver', { count: 1, value: 150 }]]);
  });

  it('still counts sold coins in the sold figures, though they are not held', () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', purchasePrice: 100, currentValue: 150 });
    addCoin(inv, {
      coinType: 'Peace', purchasePrice: 50, currentValue: 90,
      soldPrice: 120, collectionStatus: 'sold'
    });

    const stats = modal['reportStats']();

    expect(stats.soldCount).toBe(1);
    expect(stats.totalSold).toBe(120);
    expect(stats.totalCoins).toBe(1);
    expect(stats.totalValue).toBe(150);
  });

  it('generates report stats', () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', category: 'Gold', purchasePrice: 100, currentValue: 150, certCompany: 'PCGS' });
    addCoin(inv, { coinType: 'Peace', category: 'Silver', purchasePrice: 50, currentValue: 40 });

    const stats = modal['reportStats']();
    expect(stats.totalCoins).toBe(2);
    expect(stats.totalCost).toBe(150);
    expect(stats.totalValue).toBe(190);
    expect(stats.totalProfit).toBe(40);
    expect(stats.gradedCount).toBe(1);
    expect(stats.byCategory).toHaveLength(2);
    expect(stats.byCategory[0][0]).toBe('Gold');
  });

  it('tells the user how many coins each report will print', () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan' });
    addCoin(inv, { coinType: 'Wish List Coin', collectionStatus: 'wanted' });

    // The schedule covers what is owned; the listing covers what is on screen.
    expect(modal['insurableCount']()).toBe(1);
    expect(modal['listingCount']()).toBe(2);
  });

  it('offers photographs by default, because they are the point of the schedule', () => {
    const { modal } = createModal();
    expect(modal['includePhotos']()).toBe(true);
  });

  it('is constructible without the filter and column stores', () => {
    const { modal } = createModal();
    expect(modal['filters']()).toBeNull();
    expect(modal['columns']()).toBeNull();
  });
});
