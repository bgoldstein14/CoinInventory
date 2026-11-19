/*
 * The import screen passes the denominations lookup to the mapper (CSV and
 * .xlsx), and the linked count is informational: it never blocks the button
 * or turns a row into a skip.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { CsvImportModal } from './csv-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';
import { buildSimpleXlsx } from '../../testing/xlsx-fixture';

function createModal() {
  const { inv } = createTestInventoryService();
  const csvService = new CsvService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: CsvService, useValue: csvService }
    ]
  });
  const modal = runInInjectionContext(injector, () => new CsvImportModal());
  inv.denominations.set([...SEED_DENOMINATIONS]);
  return { modal: modal as unknown as Record<string, any>, inv };
}

function csvEvent(text: string): Event {
  const file = new File([text], 'coins.csv', { type: 'text/csv' });
  return { target: { files: [file], value: '' } } as unknown as Event;
}

describe('the CSV import screen links what it imports', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('creates coins carrying both the text and the link', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year\nMorgan Dollar,Dollar,1881\n'
    ));
    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.denomination).toBe('Dollar');
    expect(coin.denominationId).toBe(seedDenomination('United States', '$1')!.denominationId);
  });

  it('passes the row\'s own Country column to the resolver', async () => {
    // 'Penny' exists in several countries; only the file's Country column decides.
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year,Country\nPenny,Penny,1920,Australia\n'
    ));
    modal['importCsv']();

    expect(inv.inventory()[0].denominationId)
      .toBe(seedDenomination('Australia', 'Penny')!.denominationId);
  });

  it('imports an unresolvable row anyway, with its text', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year\nPillar Dollar,8 Reales,1753\n'
    ));

    expect(modal['plannedImportCount']()).toBe(1);
    expect(modal['plannedSkipCount']()).toBe(0);

    modal['importCsv']();
    const coin = inv.inventory()[0];
    expect(coin.denomination).toBe('8 Reales');
    expect(coin.denominationId).toBeNull();
  });

  it('links an .xlsx the same way, because it is the same mapper', async () => {
    const { modal, inv } = createModal();
    const bytes = buildSimpleXlsx(
      'Sheet1',
      ['Coin Type', 'Denomination', 'Year'],
      [['Morgan Dollar', 'Dollar', '1881']]
    );
    const file = new File(
      [bytes.slice().buffer as ArrayBuffer],
      'coins.xlsx',
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    );
    await modal['handleFileSelection']({ target: { files: [file], value: '' } } as unknown as Event);
    modal['importCsv']();

    expect(inv.inventory()[0].denominationId)
      .toBe(seedDenomination('United States', '$1')!.denominationId);
  });

  it('links nothing, and complains about nothing, before the lookup arrives', async () => {
    // The import must still work before the denominations list has loaded.
    const { modal, inv } = createModal();
    inv.denominations.set([]);
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year\nMorgan Dollar,Dollar,1881\n'
    ));

    expect(modal['plannedImportCount']()).toBe(1);
    expect(modal['plannedLinkedCount']()).toBe(0);

    modal['importCsv']();
    expect(inv.inventory()[0].denomination).toBe('Dollar');
    expect(inv.inventory()[0].denominationId).toBeNull();
  });
});

describe('the preview\'s link count', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('says how many of the accepted rows will link', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year\n' +
      'Morgan Dollar,Dollar,1881\n' +
      'Trime,3CS,1861\n' +
      'Pillar Dollar,8 Reales,1753\n'
    ));

    expect(modal['plannedImportCount']()).toBe(3);
    expect(modal['plannedLinkedCount']()).toBe(2);
    expect(modal['plannedSkipCount']()).toBe(0);
  });

  it('reads zero when a column is mapped onto the wrong field', async () => {
    // A mis-mapped column shows up as zero links while every row still imports.
    const { modal } = createModal();
    await modal['handleFileSelection'](csvEvent(
      'Coin Type,Denomination,Year\nMorgan Dollar,MS63,1881\n'
    ));

    expect(modal['plannedImportCount']()).toBe(1);
    expect(modal['plannedLinkedCount']()).toBe(0);
    expect(modal['plannedSkipCount']()).toBe(0);
  });
});
