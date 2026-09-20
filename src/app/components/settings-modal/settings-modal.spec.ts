import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { StorageService } from '../../services/storage.service';
import { SettingsModal } from './settings-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

/**
 * SettingsModal uses inject() for InventoryService and StorageService, so it
 * must be created inside an injection context — the same pattern the other
 * component specs use.
 */
function createModal() {
  const { inv, storage } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: StorageService, useValue: storage }
    ]
  });
  const modal = runInInjectionContext(injector, () => new SettingsModal());
  return { modal, inv };
}

describe('SettingsModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // Moved here from app.spec.ts along with the code it exercises.
  it('allows category maintenance from settings', () => {
    const { modal, inv } = createModal();

    modal['categoryDraft'].set('Custom Category');
    modal['addCategory']();
    expect(inv.categoryOptions()).toContain('Custom Category');

    modal['removeCategory']('Custom Category');
    expect(inv.categoryOptions()).not.toContain('Custom Category');
  });

  it('mirrors the live reference lists into the bulk-edit textareas', () => {
    const { modal, inv } = createModal();

    modal['metalContentDraft'].set('Electrum');
    modal['addMetalContent']();

    expect(inv.metalContents()).toContain('Electrum');
    // The textarea is refreshed after every immediate edit, so it can never
    // show a stale copy of the list.
    expect(modal['metalContentListText']().split('\n')).toContain('Electrum');
  });

  it('ignores blank drafts', () => {
    const { modal, inv } = createModal();

    modal['categoryDraft'].set('   ');
    modal['addCategory']();
    expect(inv.categoryOptions()).toHaveLength(0);

    modal['metalContentDraft'].set('   ');
    const before = inv.metalContents().length;
    modal['addMetalContent']();
    expect(inv.metalContents()).toHaveLength(before);
  });
});
