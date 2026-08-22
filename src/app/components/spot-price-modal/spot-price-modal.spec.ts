import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { SpotPriceService } from '../../services/spot-price.service';
import { StorageService } from '../../services/storage.service';
import { SpotPriceModalComponent } from './spot-price-modal';

function createModal() {
  const storage = new StorageService();
  const inv = new InventoryService(storage);
  const spotPrice = new SpotPriceService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: SpotPriceService, useValue: spotPrice }
    ]
  });
  const modal = runInInjectionContext(injector, () => new SpotPriceModalComponent());
  return { modal, inv };
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
});
