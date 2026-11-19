import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { CsvImportModal } from './csv-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { buildSimpleXlsx, buildXlsxWorkbook } from '../../testing/xlsx-fixture';

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
    const csv = 'Coin Type,Denomination,Year,Grade\nMorgan Dollar,Dollar,1889,MS63\nWalking Liberty,Half Dollar,1943,VF30\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    await modal['handleFileSelection']({ target: { files: [file] } } as unknown as Event);

    expect(modal['csvHeaders']()).toEqual(['Coin Type', 'Denomination', 'Year', 'Grade']);
    expect(modal['csvRows']()).toHaveLength(2);
    expect(modal['csvFieldMapping']()['Coin Type']).toBe('coinType');
    expect(modal['csvFieldMapping']()['Grade']).toBe('grade');
  });

  it('imports CSV rows as new coins', async () => {
    const { modal, inv } = createModal();
    const csv = 'Coin Type,Denomination,Purchase Price\nMorgan Dollar,Dollar,150.00\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    await modal['handleFileSelection']({ target: { files: [file] } } as unknown as Event);
    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(1);
    expect(inv.inventory()[0].coinType).toBe('Morgan Dollar');
    expect(inv.inventory()[0].denomination).toBe('Dollar');
    expect(inv.inventory()[0].purchasePrice).toBe(150);
    expect(inv.inventory()[0].source).toBe('csv');
  });
});

/*
 * "Import only coins I still own" on this dialog: the control exists, is wired
 * to the plan, and drives the button count. Rule edge cases are in
 * services/csv/sold-filter.spec.ts.
 */
describe('the sold filter on the CSV / Excel dialog', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  const csv =
    'Coin Type,Denomination,Year,Sold Date\n' +
    'Morgan Dollar,Dollar,1881,2013-11-16\n' +
    'Walking Liberty,Half Dollar,1943,\n';

  async function loaded() {
    const { modal, inv } = createModal();
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });
    await modal['handleFileSelection']({ target: { files: [file] } } as unknown as Event);
    return { modal, inv };
  }

  it('starts UNTICKED, so a sold coin imports like any other', async () => {
    const { modal } = await loaded();

    expect(modal['onlyUnsoldCoins']()).toBe(false);
    expect(modal['plannedImportCount']()).toBe(2);
    expect(modal['plannedSoldExclusions']()).toBe(0);
  });

  it('drops the sold row, and the count on the button follows', async () => {
    const { modal } = await loaded();
    modal['setOnlyUnsoldCoins'](true);

    expect(modal['plannedImportCount']()).toBe(1);
    expect(modal['plannedSoldExclusions']()).toBe(1);
  });

  it('imports exactly what the preview promised', async () => {
    const { modal, inv } = await loaded();
    modal['setOnlyUnsoldCoins'](true);
    modal['importCsv']();

    expect(inv.inventory().map(coin => coin.coinType)).toEqual(['Walking Liberty']);
  });

  it('puts the row back when it is unticked again', async () => {
    const { modal } = await loaded();
    modal['setOnlyUnsoldCoins'](true);
    modal['setOnlyUnsoldCoins'](false);

    expect(modal['plannedImportCount']()).toBe(2);
    expect(modal['plannedSoldExclusions']()).toBe(0);
  });

  it('knows when the file maps no sold column, so it can say so', async () => {
    const { modal } = await loaded();
    expect(modal['mappedSoldFields']()).toEqual(['soldDate']);
    expect(modal['hasNoSoldColumn']()).toBe(false);

    const { modal: bare } = createModal();
    const file = new File(
      ['Coin Type,Denomination\nMorgan Dollar,Dollar\n'],
      'bare.csv',
      { type: 'text/csv' }
    );
    await bare['handleFileSelection']({ target: { files: [file] } } as unknown as Event);

    expect(bare['hasNoSoldColumn']()).toBe(true);
    bare['setOnlyUnsoldCoins'](true);
    expect(bare['plannedImportCount']()).toBe(1);
  });
});

describe('the sold tick box is actually on the dialog', () => {
  /** HTML comments out, so documentation cannot satisfy a test. */
  function stripComments(source: string): string {
    return source.replace(/<!--[\s\S]*?-->/g, '');
  }

  const TEMPLATE = stripComments(
    readFileSync(join(__dirname, 'csv-import-modal.html'), 'utf8')
  );

  it('renders a checkbox bound to the option', () => {
    expect(TEMPLATE).toContain('onlyUnsoldCoins()');
    expect(TEMPLATE).toContain('setOnlyUnsoldCoins(');
  });

  it('says what counts as sold, from the module that decides it', () => {
    expect(TEMPLATE).toContain('soldRuleSentence');
  });

  it('tells the user when the option can have no effect', () => {
    expect(TEMPLATE).toContain('hasNoSoldColumn()');
  });
});

/* Both Import menu entries open this dialog; `mode` changes the wording, never what it can read. */
describe('CsvImportModal — which door it was opened through', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('defaults to Excel, which is the first Import menu entry', () => {
    // The split button's face runs the first entry; see app-toolbar.spec.ts.
    const { modal } = createModal();

    expect(modal.mode()).toBe('excel');
    expect(modal['heading']()).toBe('Import from an Excel workbook');
    expect(modal['filePickerLabel']()).toBe('Select Excel workbook');
  });

  it('suggests both formats whichever door was used', () => {
    const { modal } = createModal();

    expect(modal['acceptedExtensions']()).toContain('.xlsx');
    expect(modal['acceptedExtensions']()).toContain('.csv');
  });

  it('reads a CSV perfectly well through the Excel door', () => {
    // A file from the "wrong" menu entry is still read.
    const { modal } = createModal();
    const csv = 'Coin Type,Denomination,Year\nMorgan Dollar,Dollar,1889\n';
    const file = new File([csv], 'coins.csv', { type: 'text/csv' });

    expect(modal.mode()).toBe('excel');
    return modal['handleFileSelection']({ target: { files: [file] } } as unknown as Event)
      .then(() => {
        expect(modal['csvRows']()).toHaveLength(1);
        expect(modal['fileError']()).toBe('');
      });
  });

  it('binds the heading and the accept list rather than hard-coding them', () => {
    /* Comments stripped so template prose cannot satisfy an assertion. */
    const markup = readFileSync(join(__dirname, 'csv-import-modal.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');

    expect(markup).toContain('{{ heading() }}');
    expect(markup).toContain('[attr.accept]="acceptedExtensions()"');
    expect(markup, 'the old fixed title is gone').not.toContain('Import from a spreadsheet');
    expect(markup, 'the old fixed picker label is gone').not.toContain('Select Excel or CSV file');
  });
});

/** The 2-of-3 completeness rule (Year / Coin Type / Denomination) on the CSV path. */
describe('CsvImportModal completeness rule', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** Drive the modal straight from CSV text, as handleFileSelection would. */
  function loadCsv(modal: any, inv: any, text: string) {
    const csv = new CsvService();
    const rows = csv.parseCsv(text);
    const headers = rows[0];
    modal['csvHeaders'].set(headers);
    modal['csvRows'].set(rows.slice(1).filter((r: string[]) => r.some(c => c.trim())));
    modal['csvFieldMapping'].set(csv.autoMapHeaders(headers));
  }

  it('imports a row carrying two of the three main details', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year,Denomination\n1881,Dollar\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(1);
    expect(modal['csvExceptions']()).toEqual([]);
  });

  it('refuses a year-only row and reports it instead', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year,Notes\n1881,found in a drawer\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(0);

    const exceptions = modal['csvExceptions']();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].rowNumber).toBe(1);
    expect(exceptions[0].summary).toContain('1881');
    expect(exceptions[0].missing).toBeTruthy();
  });

  it('imports the good rows and reports only the bad ones', () => {
    const { modal, inv } = createModal();
    loadCsv(
      modal,
      inv,
      'Year,Coin Type,Denomination\n' +
      '1881,Morgan Dollar,Dollar\n' +
      '1916,,\n' +
      '1932,Washington Quarter,Quarter\n'
    );

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(2);
    expect(modal['importedCount']()).toBe(2);

    const exceptions = modal['csvExceptions']();
    expect(exceptions).toHaveLength(1);
    // Row numbering is 1-based and excludes the header, so the bad row is 2.
    expect(exceptions[0].rowNumber).toBe(2);
  });

  it('stays open when something was refused, so the report is seen', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year\n1881\n');

    modal['importCsv']();

    // Headers still present => the dialog did not reset itself and close.
    expect(modal['csvHeaders']().length).toBeGreaterThan(0);
    expect(modal['csvExceptions']().length).toBe(1);
  });

  it('closes on a clean import, keeping the common case one click', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year,Denomination\n1881,Dollar\n');

    modal['importCsv']();

    expect(modal['csvHeaders']()).toEqual([]);
  });

  it('treats placeholder text as missing, not as a value', () => {
    // Placeholder values such as "-", "n/a" and "unknown" count as missing.
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year,Coin Type,Denomination\n1881,n/a,-\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(0);
    expect(modal['csvExceptions']()).toHaveLength(1);
  });
});

/*
 * Alloy/weight inference on the CSV path (shared pmFieldsToFill). A value from
 * the file always wins over an inferred one.
 */
describe('CsvImportModal fills in metal and weight the file did not state', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  function loadCsv(modal: any, text: string) {
    const csv = new CsvService();
    const rows = csv.parseCsv(text);
    const headers = rows[0];
    modal['csvHeaders'].set(headers);
    modal['csvRows'].set(rows.slice(1).filter((r: string[]) => r.some(c => c.trim())));
    modal['csvFieldMapping'].set(csv.autoMapHeaders(headers));
  }

  it('fills all five on a row that gives only year and denomination', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination\n1927,$20\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.metalContent).toBe('Gold');
    expect(coin.composition).toBe('90% Gold, 10% Copper');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(30.09, 2);
    // ...and the GROSS weight, in grams.
    expect(coin.weight).toBeCloseTo(33.436, 3);
  });

  it('NEVER overwrites a value the file supplied', () => {
    /* The file's weight and metal disagree with the catalogue and must be kept.
     * PM % and PM weight are not CSV-mappable, so only three fields are checked. */
    const { modal, inv } = createModal();
    loadCsv(
      modal,
      'Year,Denomination,Metal Content,Composition,Weight (g)\n' +
      '1927,$20,Silver,Hand-checked alloy,33.1\n'
    );

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.metalContent).toBe('Silver');
    expect(coin.composition).toBe('Hand-checked alloy');
    expect(coin.weight).toBeCloseTo(33.1, 2);
  });

  it('completes the gaps around a value the file did supply', () => {
    // A file that lists only the weight: it survives, the rest is filled.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination,Weight (g)\n1927,$20,33.1\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.weight).toBeCloseTo(33.1, 2);      // the user's own figure
    expect(coin.metalContent).toBe('Gold');        // inferred
    expect(coin.pmWeightGrams).toBeCloseTo(30.09, 2);
  });

  it('inherits the deliberate refusals rather than guessing', () => {
    /* Ambiguous coins (an 1855 "$1", a 1942 five-cent piece) are left blank. */
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination\n1855,$1\n1942,5¢\n');

    modal['importCsv']();

    for (const coin of inv.inventory()) {
      expect(coin.metalContent, `${coin.year} ${coin.denomination}`).toBeFalsy();
      expect(coin.pmWeightGrams).toBeUndefined();
      expect(coin.weight).toBeUndefined();
    }
  });

  it('settles that same ambiguity when the file names the metal', () => {
    // A "Gold" metal column is used as a hint.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination,Metal Content\n1855,$1,Gold\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.pmWeightGrams).toBeCloseTo(1.50, 2);
    expect(coin.weight).toBeCloseTo(1.672, 3);
  });

  it('fills a base-metal coin\'s weight even though it has no melt value', () => {
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination\n1983,1¢\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.metalContent).toBe('Zinc');
    expect(coin.weight).toBeCloseTo(2.50, 2);
    expect(coin.pmWeightGrams).toBeUndefined();
  });

  it('still manages the METAL alone when only the coin type gives it away', () => {
    // "Dollar" is not a known denomination; the coin-type fallback finds the
    // metal but not the weight.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Coin Type,Denomination,Year\nMorgan,Dollar,1881\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.metalContent).toBe('Silver');
    expect(coin.weight).toBeUndefined();
    expect(coin.pmWeightGrams).toBeUndefined();
  });

  it('reports how many coins gained something, for the summary line', () => {
    /* Includes an invalid row so the dialog stays open and the counters can be read. */
    const { modal } = createModal();
    loadCsv(modal, 'Year,Denomination,Notes\n1927,$20,\n1942,5¢,\n,,just a note\n');

    modal['importCsv']();

    expect(modal['importedCount']()).toBe(2);
    expect(modal['csvExceptions']()).toHaveLength(1);
    // The 1942 five-cent piece is a deliberate gap in pm-reference.ts.
    expect(modal['enrichedCount']()).toBe(1);
  });

  it('leaves a rejected row completely untouched', () => {
    // Rejected rows are reported as written; inference runs only on accepted rows.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Notes\n1927,found in a drawer\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(0);
    expect(modal['csvExceptions']()).toHaveLength(1);
    expect(modal['enrichedCount']()).toBe(0);
  });
});

/**
 * A `Date` column is mapped by its values, on both the CSV and workbook paths:
 * coin years map to Year; calendar dates are left unmapped because their
 * meaning is unknown.
 */
describe('CsvImportModal — a `Date` column is decided by its values', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  async function loadFile(modal: any, file: File) {
    await modal['handleFileSelection']({ target: { files: [file] } } as unknown as Event);
  }

  it('maps a CSV Date column of coin years onto Year', async () => {
    const { modal } = createModal();
    await loadFile(modal, new File(
      ['Coin Type,Date,Grade\nMorgan Dollar,1881,MS63\nPeace Dollar,1922-S,VF30\n'],
      'coins.csv',
      { type: 'text/csv' }
    ));

    expect(modal['csvFieldMapping']()['Date']).toBe('year');
  });

  it('leaves a CSV Date column of purchase dates blank for the user', async () => {
    const { modal } = createModal();
    await loadFile(modal, new File(
      ['Coin Type,Date,Grade\nMorgan Dollar,3/15/2024,MS63\nPeace Dollar,2023-01-02,VF30\n'],
      'coins.csv',
      { type: 'text/csv' }
    ));

    expect(modal['csvFieldMapping']()['Date']).toBeUndefined();
    expect(modal['csvFieldMapping']()['Coin Type']).toBe('coinType');
    expect(modal['csvFieldMapping']()['Grade']).toBe('grade');
  });

  it('leaves an .xlsx Date column of real Excel date cells blank', async () => {
    // Serial 45678 (21 Jan 2025) with a date format: the cell type settles it.
    const { modal } = createModal();
    await loadFile(modal, new File(
      [buildSimpleXlsx('Silver', ['Coin Type', 'Date', 'Grade'], [
        ['Morgan Dollar', { dateSerial: 45678 }, 'MS63'],
        ['Peace Dollar', { dateSerial: 45000 }, 'VF30']
      ]) as unknown as BlobPart],
      'coins.xlsx'
    ));

    expect(modal['fileError']()).toBe('');
    expect(modal['csvFieldMapping']()['Date']).toBeUndefined();
    expect(modal['csvFieldMapping']()['Coin Type']).toBe('coinType');
  });

  it('maps an .xlsx Date column of coin years onto Year', async () => {
    const { modal } = createModal();
    await loadFile(modal, new File(
      [buildSimpleXlsx('Silver', ['Coin Type', 'Date', 'Grade'], [
        ['Morgan Dollar', 1881, 'MS63'],
        ['Peace Dollar', '1922-S', 'VF30']
      ]) as unknown as BlobPart],
      'coins.xlsx'
    ));

    expect(modal['csvFieldMapping']()['Date']).toBe('year');
  });

  it('pools the evidence across every ticked worksheet', async () => {
    // One mapping covers all ticked tabs: years on one tab and dates on the
    // other are ambiguous; unticking the ledger resolves it.
    const { modal } = createModal();
    await loadFile(modal, new File(
      [buildXlsxWorkbook([
        { name: 'Gold', rows: [['Coin Type', 'Date'], ['Saint-Gaudens', 1924]] },
        {
          name: 'Ledger',
          rows: [['Coin Type', 'Date'], ['Morgan Dollar', { dateSerial: 45678 }]]
        }
      ]) as unknown as BlobPart],
      'coins.xlsx'
    ));

    expect(modal['selectedSheetNames']()).toEqual(['Gold', 'Ledger']);
    expect(modal['csvFieldMapping']()['Date']).toBeUndefined();

    modal['setSheetSelected']('Ledger', false);
    expect(modal['csvFieldMapping']()['Date']).toBe('year');
  });
});
