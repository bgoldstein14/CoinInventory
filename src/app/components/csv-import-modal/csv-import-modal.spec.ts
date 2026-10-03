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

/**
 * The 2-of-3 completeness rule on the CSV path.
 *
 * QIF import has refused under-specified records for some time; CSV did not,
 * so the same row was accepted on one path and rejected on the other. That was
 * not a cosmetic inconsistency: the backend refuses a coin with no denomination
 * (`400 denomination is required`), so an accepted-but-invalid row became a
 * record visible in the grid with no database row behind it, and every later
 * edit failed against an id the server had never seen.
 */
describe('CsvImportModal completeness rule', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** Drive the modal straight from CSV text, as handleCsvFileSelection would. */
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
    // The exact shape that kept slipping through on the QIF side.
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
    // isCoinDetailPresent rejects "-", "n/a", "unknown" and friends; a naive
    // truthiness test accepted all of them.
    const { modal, inv } = createModal();
    loadCsv(modal, inv, 'Year,Coin Type,Denomination\n1881,n/a,-\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(0);
    expect(modal['csvExceptions']()).toHaveLength(1);
  });
});

/* ===========================================================================
 * THE ALLOY / WEIGHT INFERENCE ON THE CSV PATH
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE WERE WRITTEN FOR
 * `mapRowToCoin` copies cells across and stops. A coin imported from Quicken
 * has had its Metal, Composition, PM %, PM weight and gross Weight worked out
 * from its country / denomination / year since that feature shipped; the very
 * same coin imported from a spreadsheet got NONE of them, and therefore
 * showed a blank melt value forever after. The owner asked for every import
 * path to make the same best effort.
 *
 * The inference is the SAME function the Settings backfill uses
 * (`pmFieldsToFill`), reached through the SAME single entry point the QIF
 * import uses (`composePmFields`). There is no second copy of the rules, so
 * the two paths cannot drift and the deliberate refusals are inherited for
 * free.
 *
 * THE RULE THAT MATTERS MOST HERE: a value that came out of the user's file
 * always wins. He typed it; a table did not.
 * ======================================================================== */
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
    // ...and the GROSS weight, in grams, which is the field nothing used to
    // write on any path at all.
    expect(coin.weight).toBeCloseTo(33.436, 3);
  });

  it('NEVER overwrites a value the file supplied', () => {
    /* The user's spreadsheet says this double eagle weighs 33.1 g and is
     * made of silver -- both disagree with the catalogue. He may have
     * weighed it; a worn coin really is lighter. The import has no business
     * arguing with either.
     *
     * (Only three of the five are mappable from a CSV at all: PM % and PM
     * weight are not in CSV_MAPPABLE_FIELDS, so a file cannot state them and
     * the inference always supplies them. The three that CAN come from a
     * file are all asserted here.) */
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
    // The commonest real shape: a file that lists the weight and nothing
    // else about the metal. The weight survives; the rest is filled.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Denomination,Weight (g)\n1927,$20,33.1\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.weight).toBeCloseTo(33.1, 2);      // the user's own figure
    expect(coin.metalContent).toBe('Gold');        // inferred
    expect(coin.pmWeightGrams).toBeCloseTo(30.09, 2);
  });

  it('inherits the deliberate refusals rather than guessing', () => {
    /* A bare "$1" dated 1855 is a 26.73 g silver dollar or a 1.672 g gold
     * dollar and nothing in the row says which; a 1942 five-cent piece was
     * struck in both cupronickel and 35% silver. pm-reference.ts answers
     * nothing for both, and the CSV path must not invent a second opinion. */
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
    // The file saying "Gold" is evidence, not a guess -- exactly what a QIF
    // security name reading "G$1" is on the other path.
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
    // "Dollar" is not a denomination pm-reference.ts knows -- it wants "$1".
    // The coarse fallback reads the coin type instead, and gets the metal
    // without pretending to know the weight.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Coin Type,Denomination,Year\nMorgan,Dollar,1881\n');

    modal['importCsv']();

    const coin = inv.inventory()[0];
    expect(coin.metalContent).toBe('Silver');
    expect(coin.weight).toBeUndefined();
    expect(coin.pmWeightGrams).toBeUndefined();
  });

  it('reports how many coins gained something, for the summary line', () => {
    /* Three rows: one the table can fill, one it deliberately refuses, and
     * one that is not a coin at all. The third is there on purpose -- a
     * CLEAN import closes the dialog and resets these counters, so the only
     * way to read them back is a run that has something to report. */
    const { modal } = createModal();
    loadCsv(modal, 'Year,Denomination,Notes\n1927,$20,\n1942,5¢,\n,,just a note\n');

    modal['importCsv']();

    expect(modal['importedCount']()).toBe(2);
    expect(modal['csvExceptions']()).toHaveLength(1);
    // Only the double eagle gained anything; the 1942 five-cent piece is one
    // of pm-reference.ts's deliberate gaps.
    expect(modal['enrichedCount']()).toBe(1);
  });

  it('leaves a rejected row completely untouched', () => {
    // A row that fails the 2-of-3 rule is reported as the file wrote it; the
    // inference runs only on rows that are actually being imported.
    const { modal, inv } = createModal();
    loadCsv(modal, 'Year,Notes\n1927,found in a drawer\n');

    modal['importCsv']();

    expect(inv.inventory()).toHaveLength(0);
    expect(modal['csvExceptions']()).toHaveLength(1);
    expect(modal['enrichedCount']()).toBe(0);
  });
});
