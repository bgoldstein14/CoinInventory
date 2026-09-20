import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ImageMatchingService } from '../../services/image-matching.service';
import { InventoryService } from '../../services/inventory.service';
import { ImageImportModal } from './image-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

function createModal() {
  // InventoryService uses inject() so must be created in an injection context
  const { inv } = createTestInventoryService();
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

function selectFiles(modal: ImageImportModal, names: string[]): Promise<void> {
  const files = names.map(name => new File(['img'], name, { type: 'image/jpeg' }));
  return modal['handleDirectorySelection']({ target: { files, value: '' } } as unknown as Event);
}

function rowFor(modal: ImageImportModal, fileName: string) {
  return modal['imageReviews']().find(r => r.fileName === fileName)!;
}

describe('ImageImportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('buckets images into confident / needs-choice / no-match', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    addCoin(inv, { coinType: 'Liberty Head', denomination: '20 Dollar', year: '1907' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'liberty_head.jpg', 'IMG_2024.jpg']);

    expect(modal['imageReviews']()).toHaveLength(3);
    expect(modal['autoMatches']().map(r => r.fileName)).toEqual(['mercury_dime_1945.jpg']);
    expect(modal['reviewMatches']().map(r => r.fileName)).toEqual(['liberty_head.jpg']);
    expect(modal['unmatchedImages']().map(r => r.fileName)).toEqual(['IMG_2024.jpg']);
  });

  it('pre-selects only confident matches, never review or no-match rows', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg']);

    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBe(merc.id);
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('auto');
    expect(rowFor(modal, 'IMG_2024.jpg').selectedCoinId).toBeNull();
    expect(rowFor(modal, 'IMG_2024.jpg').decision).toBe('review');
  });

  it('never pre-selects a coin when two near-identical records compete', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O' });

    await selectFiles(modal, ['1881-S Morgan Dollar.jpg']);

    const row = rowFor(modal, '1881-S Morgan Dollar.jpg');
    expect(row.result.status).toBe('review');
    expect(row.selectedCoinId).toBeNull();
    expect(row.result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(modal['attachCount']()).toBe(0);
  });

  it('exposes the parsed filename attributes as display chips', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });

    await selectFiles(modal, ['1881-S Morgan Dollar MS63.jpg']);

    const chips = modal['parsedChips'](rowFor(modal, '1881-S Morgan Dollar MS63.jpg'));
    expect(chips).toContain('Year 1881');
    expect(chips).toContain('Mint S');
    expect(chips).toContain('Grade MS63');
  });

  it('confirms and rejects a confident match', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);

    modal['confirmImageMatch']('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('confirmed');

    modal['rejectImageMatch']('mercury_dime_1945.jpg');
    const rejected = rowFor(modal, 'mercury_dime_1945.jpg');
    expect(rejected.decision).toBe('review');
    expect(rejected.selectedCoinId).toBeNull();
    expect(modal['attachCount']()).toBe(0);
  });

  it('lets the user pick one of the ranked candidates', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'S' });
    addCoin(inv, { coinType: 'Morgan', denomination: 'Dollar', year: '1881', mintMark: 'O' });

    await selectFiles(modal, ['1881-S Morgan Dollar.jpg']);

    const row = rowFor(modal, '1881-S Morgan Dollar.jpg');
    const top = row.result.candidates[0];
    modal['chooseCandidate']('1881-S Morgan Dollar.jpg', top);

    const chosen = rowFor(modal, '1881-S Morgan Dollar.jpg');
    expect(chosen.decision).toBe('confirmed');
    expect(chosen.selectedCoinId).toBe(top.coinId);
    expect(chosen.selectionReason).toContain('Chosen from suggestions');
    expect(modal['attachCount']()).toBe(1);
  });

  it('searches the inventory for a different coin', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    const peace = addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' });

    await selectFiles(modal, ['IMG_2024.jpg']);

    // Below the minimum search length -> no noise.
    modal['setCoinSearch']('IMG_2024.jpg', 'p');
    expect(modal['coinSearchResults']('IMG_2024.jpg')).toEqual([]);

    modal['setCoinSearch']('IMG_2024.jpg', 'peace 1922');
    const results = modal['coinSearchResults']('IMG_2024.jpg');
    expect(results.map(c => c.id)).toEqual([peace.id]);

    modal['setCoinSearch']('IMG_2024.jpg', 'nothing like this');
    expect(modal['coinSearchResults']('IMG_2024.jpg')).toEqual([]);
  });

  it('reassigns an image to any coin the user chooses', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });
    const peace = addCoin(inv, { coinType: 'Peace', denomination: 'Dollar', year: '1922' });

    await selectFiles(modal, ['IMG_2024.jpg']);
    modal['reassignImageMatch']('IMG_2024.jpg', peace.id);

    const row = rowFor(modal, 'IMG_2024.jpg');
    expect(row.selectedCoinId).toBe(peace.id);
    expect(row.decision).toBe('confirmed');
    expect(row.confidence).toBe(1);
    expect(row.selectionReason).toContain('Manually assigned');
  });

  it('clears the selection when reassigned to an empty coin id', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);
    modal['reassignImageMatch']('mercury_dime_1945.jpg', '');

    expect(rowFor(modal, 'mercury_dime_1945.jpg').selectedCoinId).toBeNull();
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('review');
  });

  it('skips an image and can undo the skip', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);

    modal['skipImage']('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('skipped');
    expect(modal['attachCount']()).toBe(0);

    modal['resetDecision']('mercury_dime_1945.jpg');
    expect(rowFor(modal, 'mercury_dime_1945.jpg').decision).toBe('auto');
    expect(modal['attachCount']()).toBe(1);
  });

  it('counts images still awaiting a decision', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg', 'IMG_2025.jpg']);

    // The confident one is already decided; the two camera files are not.
    expect(modal['outstandingCount']()).toBe(2);
  });

  it('attaches only confirmed / auto matches to their coins', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg', 'IMG_2024.jpg']);
    await modal['applyConfirmedMatches']();

    const updated = inv.inventory().find(c => c.id === merc.id)!;
    expect(updated.imagePaths.length).toBe(1);
  });

  it('attaches nothing when every image was skipped', async () => {
    const { modal, inv } = createModal();
    const merc = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await selectFiles(modal, ['mercury_dime_1945.jpg']);
    modal['skipImage']('mercury_dime_1945.jpg');
    await modal['applyConfirmedMatches']();

    expect(inv.inventory().find(c => c.id === merc.id)!.imagePaths).toHaveLength(0);
  });

  it('ignores a selection that contains no image files', async () => {
    const { modal, inv } = createModal();
    addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    await modal['handleDirectorySelection']({
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], value: '' }
    } as unknown as Event);

    expect(modal['imageReviews']()).toHaveLength(0);
  });

  it('resolves coin name by id', () => {
    const { modal, inv } = createModal();
    const coin = addCoin(inv, { coinType: 'Mercury', denomination: 'Dime', year: '1945' });

    expect(modal['coinNameById'](coin.id)).toBe('Mercury Dime 1945');
    expect(modal['coinNameById'](null)).toBe('None');
    expect(modal['coinNameById']('nonexistent')).toBe('Unknown');
  });
});
