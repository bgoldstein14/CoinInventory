import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { QuickenImportService } from '../../services/quicken-import.service';
import { StorageService } from '../../services/storage.service';
import { QuickenImportModal } from './quicken-import-modal';

function createModal() {
  const storage = new StorageService();
  const inv = new InventoryService(storage);
  const quicken = new QuickenImportService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: QuickenImportService, useValue: quicken }
    ]
  });
  const modal = runInInjectionContext(injector, () => new QuickenImportModal());
  return { modal, inv };
}

describe('QuickenImportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('imports Quicken records and emits them', () => {
    const { modal, inv } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\nMUS 1/2 Dime\n^`);
    modal['importQuicken']();

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { name: string }).name).toContain('Half Dime');
  });

  it('defaults an imported coin category to its Quicken account name', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(
      `!Account\nNCoin Collection\n^\n!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\n^`
    );
    modal['refreshQuickenAccounts']();
    modal['importQuicken']();

    expect((emitted[0] as { category: string }).category).toBe('Coin Collection');
  });

  it('leaves category blank for imported coin with no Quicken account', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\n^`);
    modal['importQuicken']();

    expect((emitted[0] as { category: string }).category).toBe('');
  });

  it('selects and clears all accounts in one action', () => {
    const { modal } = createModal();
    modal['quickenAccounts'].set(['Checking', 'Savings', 'Brokerage']);

    modal['toggleAllAccounts']();
    expect(modal['selectedAccounts']()).toHaveLength(3);

    modal['toggleAllAccounts']();
    expect(modal['selectedAccounts']()).toHaveLength(0);
  });

  it('loads a Quicken file and runs a preview parse', async () => {
    const { modal } = createModal();
    const file = new File(
      ['!Type:Invst\nD2024-02-01\nNBuy\nYUS Half Dime\nT12.50\n^'],
      'import.qif',
      { type: 'text/plain' }
    );

    await modal['handleQuickenFileSelection']({ target: { files: [file] } } as unknown as Event);
    expect(modal['importedRecords']()).toHaveLength(1);
  });

  it('groups preview records by account', () => {
    const { modal } = createModal();
    modal['importedRecords'].set([
      { id: 'r1', name: 'Mercury Dime', denomination: 'Dime', account: 'Checking',
        purchasePrice: 10, currentValue: 12, country: 'US', type: '', notes: '', source: 'quicken' },
      { id: 'r2', name: 'Liberty Eagle', denomination: '10 Dollar', account: 'Savings',
        purchasePrice: 1800, currentValue: 1900, country: 'US', type: '', notes: '', source: 'quicken' }
    ]);

    const grouped = modal['groupedImportedRecords']();
    expect(Object.keys(grouped)).toEqual(expect.arrayContaining(['Checking', 'Savings']));
  });

  it('applies QIF date filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nYOld Coin\nT100\n^\n!Type:Invst\nD06/15/2024\nNBuy\nYNew Coin\nT200\n^`
    );
    modal['qifDateFrom'].set('2024-03-01');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['importedRecords']()[0].name).toBe('New Coin');
  });

  it('applies QIF price filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nYCheap Coin\nT5\n^\n!Type:Invst\nD01/15/2024\nNBuy\nYExpensive Coin\nT500\n^`
    );
    modal['qifPriceMin'].set('100');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['importedRecords']()[0].name).toBe('Expensive Coin');
  });

  it('applies QIF denomination filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nYUS Half Dime\nT12\n^\n!Type:Invst\nD01/15/2024\nNBuy\nYQuarter\nT30\n^`
    );
    modal['qifDenominationFilter'].set('quarter');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['importedRecords']()[0].denomination).toBe('Quarter');
  });
});
