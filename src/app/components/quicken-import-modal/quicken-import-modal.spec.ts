import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../services/inventory.service';
import { QuickenImportService } from '../../services/quicken-import.service';
import { QuickenImportModal } from './quicken-import-modal';
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

    // Category should be set from the Quicken account name
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
   * END-TO-END: the certification company and the CAC sticker have to survive
   * the whole trip -- security name -> parsed attributes -> QuickenImportRecord
   * -> CoinRecord -> the object handed to ApiService.createCoin().
   *
   * `importQuicken()` is the last hop we can observe from a unit test: the
   * CoinRecord it emits is exactly the body that gets POSTed to
   * /api/coins (see coin-collection.ts addCoins(), which passes each coin
   * straight to ApiService.createCoin()). So asserting on the emitted record
   * is asserting on the request payload.
   */
  it('carries certCompany and hasCacSticker onto the imported CoinRecord', () => {
    const { modal } = createModal();
    let emitted: unknown[] = [];
    modal.imported.subscribe(coins => { emitted = coins; });

    // "PCGS/CAC" = PCGS slab carrying a green CAC sticker -- two separate
    // facts about the same coin.
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
    // The backend binds this to a BIT NOT NULL column, so it must be a real
    // boolean rather than a missing property.
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
    // QuickenImportRecord no longer has 'name' or 'type' - use 'coinType', 'year', 'grade', etc.
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

  // NOTE: these filter fixtures used placeholder security names ("Old Coin",
  // "Cheap Coin", ...). Those carry none of the three main details, so the
  // parser never produced a record to filter and the tests failed with an
  // empty list -- the date/price filters themselves were fine. Real Quicken
  // security names are used instead.
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

  // --- 2-of-3 main-detail rule, seen from the modal ---

  // A QIF with one good coin and one that only has a year.
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
   * THE "IMPORT ANYWAY" OVERRIDE IS GONE, AND MUST STAY GONE.
   *
   * It used to let the user force a record that fails the 2-of-3 rule into
   * the import. The coin appeared in the grid but was never saved -- the
   * backend rejects a coin with no denomination outright
   * (400 {"error":"denomination is required"}) -- so every later edit failed
   * against an id the server had never heard of. The two tests that used to
   * sit here asserted that broken behaviour worked.
   *
   * The replacement rule: THE UI MUST NEVER OFFER TO CREATE A COIN THE
   * BACKEND WOULD REFUSE.
   */
  it('offers no way to force an excepted coin into the import', () => {
    const { modal } = createModal();
    const surface = modal as unknown as Record<string, unknown>;

    // The whole override mechanism -- the state, both handlers and the
    // accessor the template used -- is removed, not merely hidden.
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
    // Removing the escape hatch must not remove the REPORTING -- the panel
    // is the part the owner asked for and it is load-bearing.
    const { modal } = createModal();
    modal['quickenText'].set(mixedQif);
    modal['previewImport']();

    const exception = modal['rejectedRecords']()[0];
    expect(exception.securityName).toBe('1943 Steel');
    expect(exception.record.year).toBe('1943');
    expect(exception.missing).toEqual(expect.arrayContaining(['Coin Type', 'Denomination']));
    expect(exception.reason).toContain('Only 1 of 3 required details found');
  });

  /* -------------------------------------------------------------------------
   * THE 1969 PERU 100 SOLES, END TO END.
   *
   * This is the record the owner reported as the only one that would not
   * import. The proof that the country and denomination fixes actually work
   * is that it now comes through the NORMAL path -- with the override gone,
   * there is no other path it could be using.
   * ---------------------------------------------------------------------- */
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

    // Not an exception any more.
    expect(modal['rejectedRecords']()).toHaveLength(0);
    expect(emitted).toHaveLength(1);

    const coin = emitted[0] as {
      year: string; denomination: string; coinType: string; country: string;
      composition: string; metalContent?: string; pmPercent?: number; pmWeightGrams?: number;
    };
    expect(coin.year).toBe('1969');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.country).toBe('Peru');
    // Blank Coin Type is the accepted outcome: Year + Denomination already
    // satisfy the 2-of-3 rule.
    expect(coin.coinType).toBe('');
    // And the alloy fields the import used to leave empty.
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
    // These four used to arrive blank on every single imported coin --
    // `composition` was hard-coded to '' in this component.
    expect(coin.metalContent).toBe('Gold');
    expect(coin.composition).toBe('90% Gold, 10% Copper');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(30.09, 2);
  });

  it('keeps net-quantity filtering working alongside the detail rule', () => {
    const { modal } = createModal();
    modal['quickenText'].set(
      `!Type:Invst\nD01/15/2024\nNBuy\nY1964 Quarter\nT5\n^` +
      `\n!Type:Invst\nD02/20/2024\nNSell\nY1964 Quarter\nT6\n^`
    );
    modal['previewImport']();

    expect(modal['importedRecords']()).toHaveLength(0);
    expect(modal['rejectedRecords']()).toHaveLength(0);
    expect(modal['skippedRecords']()).toHaveLength(1);
  });
});
