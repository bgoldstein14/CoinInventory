/**
 * Excel import through the real import modal. Workbooks are converted to the
 * CSV headers + rows shape, so everything after that is shared code. Fixtures
 * are built by src/app/testing/xlsx-fixture.ts.
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
import { buildXlsxWorkbook, buildSimpleXlsx, FixtureCell } from '../../testing/xlsx-fixture';

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
  return { modal: modal as unknown as Record<string, any>, inv };
}

/** A change event carrying one file, as the file input would produce. */
function selectionEvent(bytes: Uint8Array, name = 'coins.xlsx'): Event {
  const file = new File(
    [bytes.slice().buffer as ArrayBuffer],
    name,
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  );
  return { target: { files: [file], value: '' } } as unknown as Event;
}

function oneSheet(headers: string[], rows: FixtureCell[][], name = 'Sheet1') {
  return selectionEvent(buildSimpleXlsx(name, headers, rows));
}

describe('choosing an .xlsx file', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('loads a single-sheet workbook straight into the mapping screen', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Year'],
      [['Morgan Dollar', 'Dollar', 1881]],
      'Silver'
    ));

    expect(modal['showSheetPicker']()).toBe(false);
    expect(modal['hasFile']()).toBe(true);
    expect(modal['mappableColumns']().map((c: any) => c.header))
      .toEqual(['Coin Type', 'Denomination', 'Year']);
    expect(modal['csvPreviewCount']()).toBe(1);
  });

  it('auto-maps real-world headings the old exact matcher would have missed', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Yr', 'Denom', 'Type', 'MM', 'Cond', 'Cost'],
      [[1881, 'Dollar', 'Morgan Dollar', 'S', 'MS63', { currency: 1250 }]]
    ));

    expect(modal['csvFieldMapping']()).toEqual({
      'Yr': 'year',
      'Denom': 'denomination',
      'Type': 'coinType',
      'MM': 'mintMark',
      'Cond': 'grade',
      'Cost': 'purchasePrice'
    });
  });

  it('leaves a column it cannot place blank for the user to set', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'AGW'],
      [['Gold Eagle', '$5', 0.1]]
    ));

    expect(modal['csvFieldMapping']()['AGW']).toBeUndefined();
  });

  it('imports a serial date as a date and a currency cell as a number', async () => {
    // Serial 45678 is 21 January 2025; `$1,250.00` is a format over the value 1250.
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Purchase Date', 'Purchase Price'],
      [['Morgan Dollar', 'Dollar', { dateSerial: 45678 }, { currency: 1250 }]]
    ));
    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.purchaseDate).toBe('2025-01-21');
    expect(coin.purchasePrice).toBe(1250);
  });

  it('imports a formula cell as its cached result', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Current Value'],
      [['Morgan Dollar', 'Dollar', { formula: 'D2*1.1', cachedNumber: 1400 }]]
    ));
    modal['importCsv']();

    expect(inv.inventory()[0].currentValue).toBe(1400);
  });

  it('reports an unreadable file instead of throwing', async () => {
    // A `.csv` renamed to `.xlsx`, or a genuine old `.xls`.
    const { modal } = createModal();
    const notAWorkbook = new TextEncoder().encode('Coin Type,Year\nMorgan,1881');

    await modal['handleFileSelection'](selectionEvent(notAWorkbook, 'coins.xlsx'));

    expect(modal['fileError']()).toMatch(/could not be read as an Excel workbook/i);
    expect(modal['hasFile']()).toBe(false);
  });

  it('still reads a .csv through the same picker', async () => {
    const { modal, inv } = createModal();
    const csv = 'Coin Type,Denomination,Year\nMorgan Dollar,Dollar,1881\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    await modal['handleFileSelection']({ target: { files: [file], value: '' } } as unknown as Event);
    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(1);
    expect(inv.inventory()[0].coinType).toBe('Morgan Dollar');
  });
});

describe('a workbook with several worksheets', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  const twoSheets = () => buildXlsxWorkbook([
    {
      name: 'Silver',
      rows: [
        ['Coin Type', 'Denomination', 'Year'],
        ['Morgan Dollar', 'Dollar', 1881],
        ['Peace Dollar', 'Dollar', 1922]
      ]
    },
    {
      name: 'Gold',
      rows: [
        ['Coin Type', 'Denomination', 'Year'],
        ['Gold Eagle', '$5', 1996]
      ]
    }
  ]);

  it('asks which sheets to import, listing each with its row count', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));

    expect(modal['showSheetPicker']()).toBe(true);
    expect(modal['workbookSheets']().map((s: any) => [s.name, s.rowCount]))
      .toEqual([['Silver', 2], ['Gold', 1]]);
  });

  it('ticks every sheet that looks like inventory by default', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));

    expect(modal['selectedSheetNames']()).toEqual(['Silver', 'Gold']);
  });

  it('imports all ticked sheets together', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));
    modal['continueToMapping']();
    modal['importCsv']();

    expect(inv.inventory().map((c: any) => c.coinType).sort())
      .toEqual(['Gold Eagle', 'Morgan Dollar', 'Peace Dollar']);
  });

  it('imports one sheet at a time when that is what the user picks', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));
    modal['setSheetSelected']('Silver', false);
    modal['continueToMapping']();
    modal['importCsv']();

    expect(inv.inventory().map((c: any) => c.coinType)).toEqual(['Gold Eagle']);
  });

  it('offers select-all and clear so neither choice is fiddly', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));

    modal['clearSheetSelection']();
    expect(modal['selectedSheetNames']()).toEqual([]);
    expect(modal['canContinue']()).toBe(false);

    modal['selectAllSheets']();
    expect(modal['selectedSheetNames']()).toEqual(['Silver', 'Gold']);
    expect(modal['canContinue']()).toBe(true);
  });

  it('shows one dropdown per distinct column, shared across sheets', async () => {
    // The mapping is keyed by header text, so a shared column is one dropdown.
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(twoSheets()));
    modal['continueToMapping']();

    expect(modal['mappableColumns']().map((c: any) => c.header))
      .toEqual(['Coin Type', 'Denomination', 'Year']);
    expect(modal['mappableColumns']().every((c: any) => c.onEverySheet)).toBe(true);
  });

  it('maps correctly when a sheet has its columns in a different order', async () => {
    // Each sheet is mapped against its own header array, not by position.
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      {
        name: 'Silver',
        rows: [['Coin Type', 'Denomination', 'Cost'], ['Morgan Dollar', 'Dollar', 1250]]
      },
      {
        name: 'Gold',
        rows: [['Cost', 'Denomination', 'Coin Type'], [395, '$5', 'Gold Eagle']]
      }
    ])));
    modal['continueToMapping']();
    modal['importCsv']();

    const byType = Object.fromEntries(inv.inventory().map((c: any) => [c.coinType, c]));
    expect(byType['Morgan Dollar'].purchasePrice).toBe(1250);
    expect(byType['Gold Eagle'].purchasePrice).toBe(395);
    expect(byType['Gold Eagle'].denomination).toBe('$5');
  });

  it('names exactly what differs when the sheets disagree', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      {
        name: 'Silver',
        rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']]
      },
      {
        name: 'Gold',
        rows: [['Coin Type', 'Denomination', 'AGW'], ['Gold Eagle', '$5', 0.1]]
      }
    ])));

    expect(modal['sheetWarnings']()).toEqual([
      `Sheet 'Gold' has a column 'AGW' that 'Silver' does not.`
    ]);
  });

  it('marks a column that only some sheets have', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      {
        name: 'Silver',
        rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']]
      },
      {
        name: 'Gold',
        rows: [['Coin Type', 'Denomination', 'AGW'], ['Gold Eagle', '$5', 0.1]]
      }
    ])));
    modal['continueToMapping']();

    const agw = modal['mappableColumns']().find((c: any) => c.header === 'AGW');
    expect(agw.onEverySheet).toBe(false);
    expect(agw.sheets).toEqual(['Gold']);
  });

  it('leaves an empty tab out of the picker selection but still lists it', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      { name: 'Silver', rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']] },
      { name: 'Sheet3', rows: [] }
    ])));

    expect(modal['workbookSheets']().map((s: any) => s.name)).toEqual(['Silver', 'Sheet3']);
    expect(modal['selectedSheetNames']()).toEqual(['Silver']);
    expect(modal['workbookSheets']()[1].skipReason).toBe('This sheet is empty.');
  });

  it('leaves a tab with no recognised columns unticked, but tickable', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      { name: 'Coins', rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']] },
      { name: 'Totals', rows: [['Metric', 'Figure'], ['Count', 412]] }
    ])));

    expect(modal['selectedSheetNames']()).toEqual(['Coins']);

    modal['setSheetSelected']('Totals', true);
    expect(modal['selectedSheetNames']()).toEqual(['Coins', 'Totals']);
  });

  it('one bad tab does not cost the user the good ones', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      { name: 'Sheet2', rows: [] },
      { name: 'Silver', rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']] }
    ])));
    modal['continueToMapping']();
    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(1);
  });
});

describe('the preview, before anything is created', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('counts only the rows that will actually become coins', async () => {
    // The year-only row lacks two of Year / Coin Type / Denomination.
    const { modal } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Year'],
      [
        ['Morgan Dollar', 'Dollar', 1881],
        ['', '', 1916],
        ['Walking Liberty', 'Half Dollar', 1943]
      ]
    ));

    expect(modal['csvPreviewCount']()).toBe(3);
    expect(modal['plannedImportCount']()).toBe(2);
    expect(modal['plannedSkipCount']()).toBe(1);
  });

  it('lists the rows that will be skipped BEFORE the import runs', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Year'],
      [['', '', 1916]]
    ));

    const skipped = modal['plannedSkips']();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].rowNumber).toBe(1);
    expect(skipped[0].summary).toBe('1916');
    expect(skipped[0].missing).toContain('Coin Type');
    expect(inv.inventory()).toHaveLength(0);
  });

  it('names the sheet a skipped row is on', async () => {
    const { modal } = createModal();
    await modal['handleFileSelection'](selectionEvent(buildXlsxWorkbook([
      { name: 'Silver', rows: [['Coin Type', 'Denomination'], ['Morgan Dollar', 'Dollar']] },
      // Denomination only: fails the 2-of-3 rule. (Fully blank rows are
      // dropped earlier, so would not test this.)
      { name: 'Gold', rows: [['Coin Type', 'Denomination'], ['', '$5']] }
    ])));
    modal['continueToMapping']();

    expect(modal['plannedSkips']()[0]).toMatchObject({ sheetName: 'Gold', rowNumber: 1 });
  });

  it('re-counts the moment the user changes a mapping', async () => {
    // `Thing` is unrecognised until it is mapped to Coin Type.
    const { modal } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Thing', 'Denomination'],
      [['Morgan Dollar', 'Dollar']]
    ));

    expect(modal['plannedImportCount']()).toBe(0);

    modal['updateCsvMapping']('Thing', 'coinType');
    expect(modal['plannedImportCount']()).toBe(1);
  });

  it('lets the user back out, leaving the inventory untouched', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination'],
      [['Morgan Dollar', 'Dollar']]
    ));

    modal['close']();

    expect(inv.inventory()).toHaveLength(0);
    expect(modal['hasFile']()).toBe(false);
    expect(modal['workbookSheets']()).toEqual([]);
  });

  it('creates exactly what it promised', async () => {
    const { modal, inv } = createModal();
    await modal['handleFileSelection'](oneSheet(
      ['Coin Type', 'Denomination', 'Year'],
      [
        ['Morgan Dollar', 'Dollar', 1881],
        ['', '', 1916],
        ['Walking Liberty', 'Half Dollar', 1943]
      ]
    ));

    const promised = modal['plannedImportCount']();
    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(promised);
    expect(modal['importedCount']()).toBe(promised);
    expect(modal['csvExceptions']()).toHaveLength(1);
  });
});
