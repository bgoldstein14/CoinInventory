import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { StorageService } from '../storage.service';
import { BaseFolderState } from './base-folder-state';

const DOCUMENTS = 'C:\\Users\\me\\Documents';

describe('the import folder box starts at the Documents folder', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('uses Documents when nothing has been remembered', async () => {
    const state = new BaseFolderState(signal(undefined), new StorageService(), async () => DOCUMENTS);
    await state.restore();
    expect(state.value()).toBe(DOCUMENTS);
  });

  it('keeps a folder the user set before', async () => {
    const storage = new StorageService();
    await new BaseFolderState(signal(undefined), storage).set('D:\\Coin Pictures');

    const state = new BaseFolderState(signal(undefined), storage, async () => DOCUMENTS);
    await state.restore();
    expect(state.value()).toBe('D:\\Coin Pictures');
  });

  it('stays empty when the Documents lookup gives nothing', async () => {
    const state = new BaseFolderState(signal(undefined), new StorageService(), async () => '');
    await state.restore();
    expect(state.value()).toBe('');
  });
});
