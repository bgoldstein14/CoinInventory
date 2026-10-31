import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { ReportModal } from './report-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

function createModal() {
  // InventoryService uses inject() so must be created in an injection context
  const { inv } = createTestInventoryService();
  const injector = Injector.create({
    providers: [{ provide: InventoryService, useValue: inv }]
  });
  const modal = runInInjectionContext(injector, () => new ReportModal());
  return { modal, inv };
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

  it('generates report stats', () => {
    const { modal, inv } = createModal();
    // CoinRecord no longer has 'name' property - use 'coinType' instead
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
});
