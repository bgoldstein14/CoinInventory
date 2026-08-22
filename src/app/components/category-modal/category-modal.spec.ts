import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { StorageService } from '../../services/storage.service';
import { CategoryModal } from './category-modal';

function createModal() {
  const storage = new StorageService();
  const inv = new InventoryService(storage);
  const injector = Injector.create({
    providers: [{ provide: InventoryService, useValue: inv }]
  });
  const modal = runInInjectionContext(injector, () => new CategoryModal());
  return { modal, inv };
}

describe('CategoryModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('adds and removes a category option', () => {
    const { modal, inv } = createModal();
    modal['newCategoryOption'].set('Ancient Coins');
    modal.addCategoryOptionFromDraft();
    expect(inv.categoryOptions()).toContain('Ancient Coins');

    modal.removeCategoryOption('Ancient Coins');
    expect(inv.categoryOptions()).not.toContain('Ancient Coins');
  });

  it('adds and removes coin sets', () => {
    const { modal, inv } = createModal();
    modal['newCoinSet'].set('Mercury Dime Collection');
    modal.addCoinSetFromDraft();
    expect(inv.coinSets()).toContain('Mercury Dime Collection');

    modal.removeCoinSet('Mercury Dime Collection');
    expect(inv.coinSets()).not.toContain('Mercury Dime Collection');
  });

  it('does not add empty category or coin set', () => {
    const { modal, inv } = createModal();
    modal['newCategoryOption'].set('   ');
    modal.addCategoryOptionFromDraft();
    expect(inv.categoryOptions()).toHaveLength(0);

    modal['newCoinSet'].set('   ');
    modal.addCoinSetFromDraft();
    expect(inv.coinSets()).toHaveLength(0);
  });
});
