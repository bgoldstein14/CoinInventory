import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { CsvImportModal } from './csv-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

function createModal() {
  // InventoryService uses inject() so must be created in an injection context
  const { inv } = createTestInventoryService();
  const csvService = new CsvService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: CsvService, useValue: csvService }
    ]
  });
  const modal = runInInjectionContext(injector, () => new CsvImportModal());
  return { modal, inv };
}

describe('CsvImportModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('parses CSV with header auto-mapping', async () => {
    const { modal } = createModal();
    // CSV uses 'Coin Type' header which maps to 'coinType' field (not 'name')
    const csv = 'Coin Type,Denomination,Year,Grade\nMorgan Dollar,Dollar,1889,MS63\nWalking Liberty,Half Dollar,1943,VF30\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    await modal['handleCsvFileSelection']({ target: { files: [file] } } as unknown as Event);

    expect(modal['csvHeaders']()).toEqual(['Coin Type', 'Denomination', 'Year', 'Grade']);
    expect(modal['csvRows']()).toHaveLength(2);
    expect(modal['csvFieldMapping']()['Coin Type']).toBe('coinType');
    expect(modal['csvFieldMapping']()['Grade']).toBe('grade');
  });

  it('imports CSV rows as new coins', async () => {
    const { modal, inv } = createModal();
    // CoinRecord no longer has 'name' property - use 'coinType' instead
    const csv = 'Coin Type,Denomination,Purchase Price\nMorgan Dollar,Dollar,150.00\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    await modal['handleCsvFileSelection']({ target: { files: [file] } } as unknown as Event);
    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(1);
    expect(inv.inventory()[0].coinType).toBe('Morgan Dollar');
    expect(inv.inventory()[0].denomination).toBe('Dollar');
    expect(inv.inventory()[0].purchasePrice).toBe(150);
    expect(inv.inventory()[0].source).toBe('csv');
  });
});
