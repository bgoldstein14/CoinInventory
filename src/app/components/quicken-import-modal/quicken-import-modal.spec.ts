import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { QuickenImportService } from '../../services/quicken-import.service';
import { QuickenImportModal } from './quicken-import-modal';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

function createModal() {
  // InventoryService uses inject() so must be created in an injection context
  const { inv } = createTestInventoryService();
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

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nY1853 US Half Dime\nT12.50\nMUS 1/2 Dime\n^`);
    modal['importQuicken']();

    expect(emitted).toHaveLength(1);
    // parseAttributes converts "US Half Dime" to symbolic "5¢"
    expect((emitted[0] as { denomination: string }).denomination).toBe('5¢');
  });

  it('defaults an imported coin category to its Quicken account name', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(
      `!Account\nNCoin Collection\n^\n!Type:Invst\nD2024-02-01\nNBuy\nY1853 US Half Dime\nT12.50\n^`
    );
    modal['refreshQuickenAccounts']();
    modal['importQuicken']();

    expect((emitted[0] as { category: string }).category).toBe('Coin Collection');
  });

  it('leaves category blank for imported coin with no Quicken account', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nY1853 US Half Dime\nT12.50\n^`);
    modal['importQuicken']();

    expect((emitted[0] as { category: string }).category).toBe('');
  });

  /*
     * Cert company and CAC sticker survive from security name to the emitted
     * CoinRecord, which is the body POSTed to /api/coins.
     */
  it('carries certCompany and hasCacSticker onto the imported CoinRecord', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    // "PCGS/CAC" = PCGS slab with a green CAC sticker.
    modal['quickenText'].set(
      `!Type:Invst\nD2024-02-01\nNBuy\nY1909 S-VDB 1¢ - PCGS/CAC AU58\nT1150.00\n^`
    );
    modal['importQuicken']();

    expect(emitted).toHaveLength(1);
    const coin = emitted[0] as { certCompany: string; hasCacSticker: boolean; grade: string };
    expect(coin.certCompany).toBe('PCGS');
    expect(coin.hasCacSticker).toBe(true);
    // And the grade is untouched by the company/CAC detection.
    expect(coin.grade).toBe('AU58');
  });

  it('emits hasCacSticker as false (never undefined) for a coin with no sticker', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nY1921 Morgan Dollar MS63\nT50.00\n^`);
    modal['importQuicken']();

    const coin = emitted[0] as { certCompany: string; hasCacSticker: boolean };
    expect(coin.certCompany).toBe('');
    // Must be a real boolean: the backend column is BIT NOT NULL.
    expect(coin.hasCacSticker).toBe(false);
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
      ['!Type:Invst\nD2024-02-01\nNBuy\nY1853 US Half Dime\nT12.50\n^'],
      'import.qif',
      { type: 'text/plain' }
    );

    await modal['handleQuickenFileSelection']({ target: { files: [file] } } as unknown as Event);
    expect(modal['importedRecords']()).toHaveLength(1);
  });

  it('groups preview records by account', () => {
    const { modal } = createModal();
    modal['importedRecords'].set([
      { id: 'r1', denomination: 'Dime', account: 'Checking', coinType: 'Mercury',
        purchasePrice: 10, currentValue: 12, country: 'US', year: '1945', grade: 'VF-30',
        mintMark: 'S', variety: '', notes: '', source: 'quicken',
        certCompany: '', hasCacSticker: false },
      { id: 'r2', denomination: '10 Dollar', account: 'Savings', coinType: 'Liberty Eagle',
        purchasePrice: 1800, currentValue: 1900, country: 'US', year: '1907', grade: 'MS-63',
        mintMark: '', variety: '', notes: '', source: 'quicken',
        certCompany: 'PCGS', hasCacSticker: true }
    ]);

    const grouped = modal['groupedImportedRecords']();
    expect(Object.keys(grouped)).toEqual(expect.arrayContaining(['Checking', 'Savings']));
  });

  // Fixtures need real Quicken security names; a placeholder parses to no record.
  it('applies QIF date filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT100\n^\n!Type:Invst\nD06/15/2024\nNBuy\nY1921 Morgan Dollar MS63\nT200\n^`
    );
    modal['qifDateFrom'].set('2024-03-01');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    // Only the June purchase survives a "from 2024-03-01" filter.
    expect(modal['importedRecords']()[0].purchasePrice).toBe(200);
  });

  it('applies QIF price filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\n^\n!Type:Invst\nD01/15/2024\nNBuy\nY1921 Morgan Dollar MS63\nT500\n^`
    );
    modal['qifPriceMin'].set('100');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['importedRecords']()[0].purchasePrice).toBe(500);
  });

  it('applies QIF denomination filter during import', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nY1853 US Half Dime\nT12\n^\n!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT30\n^`
    );
    // Filter by symbolic denomination "25" to match "25¢"
    modal['qifDenominationFilter'].set('25');
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['importedRecords']()[0].denomination).toBe('25¢');
  });

  // --- 2-of-3 main-detail rule ---

  const mixedQif =
    `!Type:Invst\nD01/15/2024\nNBuy\nY1921 Morgan Dollar MS63\nT50\n^` +
    `\n!Type:Invst\nD01/16/2024\nNBuy\nY1943 Steel\nT25\n^`;

  it('surfaces under-detailed coins as exceptions instead of dropping them', () => {
    const { modal } = createModal();
    modal['quickenText'].set(mixedQif);
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(1);
    expect(modal['rejectedRecords']()).toHaveLength(1);
    expect(modal['rejectedRecords']()[0].securityName).toBe('1943 Steel');
    expect(modal['rejectedRecords']()[0].reason).toContain('Only 1 of 3 required details found');
  });

  it('does not emit an excepted coin when importing', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(mixedQif);
    modal['importQuicken']();

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { coinType: string }).coinType).toBe('Morgan');
  });

  /*
     * No "import anyway" override: the backend rejects a coin with no
     * denomination, so a forced record would appear in the grid but never save.
     */
  it('offers no way to force an excepted coin into the import', () => {
    const { modal } = createModal();
    const surface = modal as unknown as Record<string, unknown>;

    // No override state, handlers or template accessor may exist at all.
    expect(surface['overriddenSecurities']).toBeUndefined();
    expect(surface['overrideException']).toBeUndefined();
    expect(surface['undoOverride']).toBeUndefined();
    expect(surface['overriddenSecurityNames']).toBeUndefined();
    expect(surface['applyDetailOverrides']).toBeUndefined();
  });

  it('keeps an excepted coin out of the import no matter how often it is re-previewed', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(mixedQif);
    modal['previewImport']();
    modal['previewImport']();
    modal['importQuicken']();

    expect(modal['rejectedRecords']()).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { coinType: string }).coinType).toBe('Morgan');
  });

  it('still reports the excepted coin in full so the user can act on it', () => {
    // The rejected row must still be reported.
    const { modal } = createModal();
    modal['quickenText'].set(mixedQif);
    modal['previewImport']();

    const exception = modal['rejectedRecords']()[0];
    expect(exception.securityName).toBe('1943 Steel');
    expect(exception.record.year).toBe('1943');
    expect(exception.missing).toEqual(expect.arrayContaining(['Coin Type', 'Denomination']));
    expect(exception.reason).toContain('Only 1 of 3 required details found');
  });

  /* Peru 100 Soles: a non-US coin named in the security string, through the normal path. */
  const peruQif =
    `!Account\nNGold Coins\n^\n` +
    `!Type:Invst\nD12/15/2023\nNBuy\nY1969 Peru 100 Soles - NGC MS64\nI3,199\nQ1\nT3,199.00\nM1.3544 ounces of gold\n^`;

  it('imports the 1969 Peru 100 Soles through the normal path', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(peruQif);
    modal['refreshQuickenAccounts']();
    modal['importQuicken']();

    expect(modal['rejectedRecords']()).toHaveLength(0);
    expect(emitted).toHaveLength(1);

    const coin = emitted[0] as {
      year: string; denomination: string; coinType: string; country: string;
      composition: string; metalContent?: string; pmPercent?: number; pmWeightGrams?: number;
    };
    expect(coin.year).toBe('1969');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.country).toBe('Peru');
    // Blank Coin Type is fine: Year + Denomination satisfy the 2-of-3 rule.
    expect(coin.coinType).toBe('');
    // And the alloy fields, inferred from country + denomination + year.
    expect(coin.metalContent).toBe('Gold');
    expect(coin.composition).toBe('90% Gold, 10% Copper');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(42.13, 2);
  });

  it('carries Metal and Composition onto an imported US coin as well', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nY1927 $20 - PCGS MS64\nT2000.00\n^`);
    modal['importQuicken']();

    const coin = emitted[0] as {
      composition: string; metalContent?: string; pmPercent?: number; pmWeightGrams?: number;
    };
    expect(coin.metalContent).toBe('Gold');
    expect(coin.composition).toBe('90% Gold, 10% Copper');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(30.09, 2);
  });

  /*
     * Guessed readings (see `AmbiguousReading`): the row imports by default,
     * can be switched to the other candidate (derived fields follow), or
     * dropped reversibly.
     */
  describe('a reading the parser had to guess at', () => {
    // "1870 3¢": three-cent silver and nickel were both struck; the parser
        // assumes the commoner nickel and flags it.
    const ambiguousQif =
      `!Account\nNType Coins\n^\n` +
      `!Type:Invst\nD01/15/2024\nNBuy\nY1870 3¢ - AU\nT100.00\n^` +
      `\n!Type:Invst\nD01/16/2024\nNBuy\nY1921 Morgan Dollar MS63\nT50.00\n^`;

    const previewRow = (modal: ReturnType<typeof createModal>['modal']) =>
      modal['importedRecords']().find(r => r.securityName === '1870 3¢ - AU')!;

    it('imports a guessed row by default, alongside the certain ones', () => {
      const { modal } = createModal();
      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();

      // The flagged row is not an exception.
      expect(modal['importedRecords']()).toHaveLength(2);
      expect(modal['rejectedRecords']()).toHaveLength(0);
      expect(modal['recordsToImport']()).toHaveLength(2);
      expect(modal['ambiguousCount']()).toBe(1);
    });

    it('exposes the guess, its alternatives and its reason to the template', () => {
      const { modal } = createModal();
      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();

      const guess = modal['ambiguity'](previewRow(modal));
      expect(guess).not.toBeNull();
      expect(guess!.chosen).toBe('3CN');
      expect([...guess!.alternatives].sort()).toEqual(['3CN', '3CS']);
      expect(guess!.why).toContain('1865-1873');

      const morgan = modal['importedRecords']().find(r => r.coinType === 'Morgan')!;
      expect(modal['ambiguity'](morgan)).toBeNull();
    });

    it('switches a guessed row to the other candidate, and re-derives with it', () => {
      const { modal } = createModal();
      let emitted: unknown[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();
      modal['chooseDenomination'](previewRow(modal), '3CS');

      // The choice re-runs the parse.
      const fixed = previewRow(modal);
      expect(fixed.denomination).toBe('3CS');
      // Fields derived from the denomination follow, because the choice goes to the parser.
      expect(fixed.coinType).toBe('Three Cent Silver');
      expect(fixed.pmPercent).toBe(90);

      // Survives the re-parse in `importQuicken` because it is keyed on the security name.
      modal['importQuicken']();
      const coin = emitted.find(
        c => (c as { coinType: string }).coinType === 'Three Cent Silver'
      ) as { denomination: string; pmPercent?: number };
      expect(coin.denomination).toBe('3CS');
      expect(coin.pmPercent).toBe(90);
    });

    it('drops a guessed row from the import, and puts it back again', () => {
      const { modal } = createModal();
      let emitted: unknown[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();
      modal['toggleDropped'](previewRow(modal));

      // Still listed, struck through, so Undo stays reachable.
      expect(modal['isDropped'](previewRow(modal))).toBe(true);
      expect(modal['importedRecords']()).toHaveLength(2);
      expect(modal['recordsToImport']()).toHaveLength(1);

      modal['importQuicken']();
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as { coinType: string }).coinType).toBe('Morgan');

      modal['toggleDropped'](previewRow(modal));
      expect(modal['recordsToImport']()).toHaveLength(2);
    });

    it('only ever offers the drop control on a row that was guessed', () => {
      // The Drop button is gated on `ambiguity(record)`, so certain rows get none.
      const { modal } = createModal();
      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();

      const morgan = modal['importedRecords']().find(r => r.coinType === 'Morgan')!;
      expect(modal['ambiguity'](morgan)).toBeNull();
      expect(modal['isDropped'](morgan)).toBe(false);
    });

    it('still has no way to force an under-detailed coin in', () => {
      // The guess controls must not reintroduce an override for rejected coins.
      const { modal } = createModal();
      modal['quickenText'].set(
        ambiguousQif + `\n!Type:Invst\nD01/17/2024\nNBuy\nY1943 Steel\nT25\n^`
      );
      modal['previewImport']();

      expect(modal['rejectedRecords']()).toHaveLength(1);
      expect(modal['recordsToImport']().some(r => r.securityName === '1943 Steel')).toBe(false);
    });
  });

  describe('coins the owner no longer has', () => {
    /** Bought in January, sold in February. Net quantity zero. */
    const boughtThenSold =
      `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\n^` +
      `\n!Type:Invst\nD02/20/2024\nNSell\nY1964 Quarter\nT6\n^`;

    it('imports them by default, because the tick box starts UNTICKED', () => {
      /* Sold coins are imported and listed by default. */
      const { modal } = createModal();
      modal['quickenText'].set(boughtThenSold);
      modal['previewImport']();

      expect(modal['onlyUnsoldCoins']()).toBe(false);
      expect(modal['recordsToImport']()).toHaveLength(1);
      expect(modal['skippedRecords']()).toHaveLength(0);
      expect(modal['soldImportCount']()).toBe(1);
    });

    it('marks what it imports as Sold, so it is not counted as owned', () => {
      /* A sold coin must not import as Owned (it would count toward value and insurance). */
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(boughtThenSold);
      modal['importQuicken']();

      expect(emitted).toHaveLength(1);
      expect(emitted[0].collectionStatus).toBe('sold');
    });

    it('still marks a coin that is STILL HELD as owned', () => {
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(`!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\n^`);
      modal['importQuicken']();

      expect(emitted[0].collectionStatus).toBe('owned');
    });

    it('holds them out, and lists them, once the tick box is ticked', () => {
      const { modal } = createModal();
      modal['quickenText'].set(boughtThenSold);
      modal['setOnlyUnsoldCoins'](true);

      expect(modal['importedRecords']()).toHaveLength(0);
      expect(modal['rejectedRecords']()).toHaveLength(0);
      expect(modal['skippedRecords']()).toHaveLength(1);
    });

    it('IMPORTS THE SALE ITSELF, not just the status', () => {
      /* Sold date and price come across, so the "is it sold?" rule matches CSV import. */
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(boughtThenSold);
      modal['importQuicken']();

      expect(emitted[0].soldDate).toBe('2024-02-20');
      expect(emitted[0].soldPrice).toBe(6);
    });

    it('leaves the sale fields alone on a coin still held', () => {
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(`!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\n^`);
      modal['importQuicken']();

      expect(emitted[0].soldDate).toBeUndefined();
      expect(emitted[0].soldPrice).toBeUndefined();
    });
  });

  describe('Quicken\'s own transfer memo', () => {
    it('does not arrive in Notes', () => {
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(
        `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\nMXfr From: Misc. Coins\n^`
      );
      modal['importQuicken']();

      expect(emitted[0].notes).toBe('');
    });

    it('but a memo the owner wrote does', () => {
      const { modal } = createModal();
      let emitted: CoinRecord[] = [];
      modal.imported.subscribe(coins => { emitted = coins; });

      modal['quickenText'].set(
        `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\nMBought at the Baltimore show\n^`
      );
      modal['importQuicken']();

      expect(emitted[0].notes).toBe('Bought at the Baltimore show');
    });
  });
});

/*
 * HTML comments are stripped first so assertions match visible text only.
 */
const QIF_TEMPLATE = readFileSync(
  join(__dirname, 'quicken-import-modal.html'),
  'utf8'
).replace(/<!--[\s\S]*?-->/g, '');

describe('what the dialog says a Quicken file can and cannot fill', () => {
  it('names the transaction fields that DO come across', () => {
    for (const field of ['Cost', 'Purchase Date', 'Sold Price', 'Sold Date']) {
      expect(QIF_TEMPLATE).toContain(field);
    }
  });

  it('says Purchased From and Sold To are left empty, and why', () => {
    expect(QIF_TEMPLATE).toContain('Purchased From');
    expect(QIF_TEMPLATE).toContain('Sold To');
    expect(QIF_TEMPLATE).toMatch(/account name/i);
  });

  it('points at the import that CAN carry them, so the blank is not a dead end', () => {
    expect(QIF_TEMPLATE).toMatch(/CSV or Excel/i);
  });

  it('does not state the omission without stating what arrives', () => {
    const omission = QIF_TEMPLATE.indexOf('Purchased From');
    const filled = QIF_TEMPLATE.indexOf('Purchase Date');
    expect(omission).toBeGreaterThan(-1);
    expect(filled).toBeGreaterThan(-1);
    expect(filled).toBeLessThan(omission);
  });
});
