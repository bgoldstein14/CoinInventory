import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { StorageService } from '../../services/storage.service';
import { ImageImportModal } from './image-import-modal';

function createModal() {
  const storage = new StorageService();
  const inv = new InventoryService(storage);
  const imageMatching = new ImageMatchingService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: ImageMatchingService, useValue: imageMatching }
    ]
  });
  const modal = runInInjectionContext(injector, () => new ImageImportModal());
  return { modal, inv };
}

function addCoin(inv: InventoryService, overrides: Record<string, unknown> = {}) {
  inv.addBlankCoin();
  const coin = inv.inventory().at(-1)!;
  if (Object.keys(overrides).length > 0) inv.updateCoin(coin.id, overrides);
  return inv.inventory().find(c => c.id === coin.id)!;
}

describe('ImageImportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('classifies image matches from directory selection', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { name: 'Mercury Dime' });
    addCoin(inv, { name: 'Liberty Head Double Eagle' });

    const files = [
      new File(['img1'], 'mercury_dime_1945.jpg', { type: 'image/jpeg' }),
      new File(['img2'], 'random_photo.png', { type: 'image/png' })
    ];

    await modal['handleDirectorySelection']({
      target: { files, value: '' }
    } as unknown as Event);

    const pending = modal['pendingImageMatches']();
    expect(pending).toHaveLength(2);

    const matched = pending.find(m => m.fileName === 'mercury_dime_1945.jpg');
    expect(matched?.status).toBe('auto-matched');
    expect(matched?.matchedCoinId).toBeTruthy();

    const unmatched = pending.find(m => m.fileName === 'random_photo.png');
    expect(unmatched?.matchedCoinId).toBeNull();
  });

  it('confirms and rejects image matches', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { name: 'Mercury Dime' });

    await modal['handleDirectorySelection']({
      target: { files: [new File(['img'], 'mercury_dime.jpg', { type: 'image/jpeg' })], value: '' }
    } as unknown as Event);

    modal['confirmImageMatch']('mercury_dime.jpg');
    expect(modal['pendingImageMatches']()[0].status).toBe('confirmed');

    modal['rejectImageMatch']('mercury_dime.jpg');
    expect(modal['pendingImageMatches']()[0].status).toBe('rejected');
    expect(modal['pendingImageMatches']()[0].matchedCoinId).toBeNull();
  });

  it('reassigns an image match to a different coin', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { name: 'Mercury Dime' });
    const coin2 = addCoin(inv, { name: 'Liberty Eagle' });

    await modal['handleDirectorySelection']({
      target: { files: [new File(['img'], 'some_image.jpg', { type: 'image/jpeg' })], value: '' }
    } as unknown as Event);

    modal['reassignImageMatch']('some_image.jpg', coin2.id);
    const match = modal['pendingImageMatches']()[0];
    expect(match.matchedCoinId).toBe(coin2.id);
    expect(match.status).toBe('confirmed');
  });

  it('applies confirmed matches and attaches images to coins', async () => {
    const { modal, inv } = createModal();
    const coin = addCoin(inv, { name: 'Mercury Dime' });

    await modal['handleDirectorySelection']({
      target: { files: [new File(['img'], 'mercury_dime.jpg', { type: 'image/jpeg' })], value: '' }
    } as unknown as Event);

    modal['confirmImageMatch']('mercury_dime.jpg');
    await modal['applyConfirmedMatches']();

    const updated = inv.inventory().find(c => c.id === coin.id)!;
    expect(updated.imagePaths.length).toBeGreaterThan(0);
  });

  it('resolves coin name by id', () => {
    const { modal, inv } = createModal();
    const coin = addCoin(inv, { name: 'Test Coin' });

    expect(modal['coinNameById'](coin.id)).toBe('Test Coin');
    expect(modal['coinNameById'](null)).toBe('None');
    expect(modal['coinNameById']('nonexistent')).toBe('Unknown');
  });
});
