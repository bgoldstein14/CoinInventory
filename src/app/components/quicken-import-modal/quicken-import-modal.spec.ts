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

  /* =========================================================================
   * A GUESSED READING, SEEN FROM THE PREVIEW
   * -------------------------------------------------------------------------
   * The parser flags a reading it had to assume (see `AmbiguousReading` in
   * coin.model.ts; a bare "3¢" dated 1865-1873 is today's only producer of
   * one). What this component owes the user, in the owner's words:
   *
   *   "It's okay to make an assumption and note to the user that there was
   *    ambiguity in a choice so they can either fix the choice right away or
   *    later or just cancel the match."
   *
   * Three outcomes, and the first one is the load-bearing one:
   *   - DEFAULT: the row imports. A flag is not an exception. If this ever
   *     stops being true the import counts fall, which is precisely what the
   *     owner refused.
   *   - FIX IT NOW: switch the denomination to the other candidate, and have
   *     everything derived from it follow.
   *   - CANCEL IT: drop the row from this import, reversibly.
   * The fourth, "fix it later", needs nothing here -- the coin editor has
   * always allowed it.
   * ======================================================================= */
  describe('a reading the parser had to guess at', () => {
    // "1870 3¢" sits in the 1865-1873 window where the three-cent silver and
    // the three-cent nickel were both being struck. Nothing in the name says
    // proof, so the parser assumes the far commoner nickel -- and says so.
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

      // Both coins. The flagged one is NOT quarantined and NOT an exception.
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

      // ...and says nothing at all about the coin it was sure of.
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

      // The preview updates immediately -- the choice re-runs the parse.
      const fixed = previewRow(modal);
      expect(fixed.denomination).toBe('3CS');
      // And the fields that hang off the denomination came with it. This is
      // the whole reason the choice goes to the parser rather than being
      // written over the finished record here.
      expect(fixed.coinType).toBe('Three Cent Silver');
      expect(fixed.pmPercent).toBe(90);

      // The correction then has to survive `importQuicken`'s deliberate
      // re-parse, which is why it is keyed on the security name and not on
      // `id` (a fresh UUID every parse).
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

      // Dropped, but still LISTED -- struck through in the table -- because
      // hiding it would put the Undo button out of reach.
      expect(modal['isDropped'](previewRow(modal))).toBe(true);
      expect(modal['importedRecords']()).toHaveLength(2);
      expect(modal['recordsToImport']()).toHaveLength(1);

      modal['importQuicken']();
      expect(emitted).toHaveLength(1);
      expect((emitted[0] as { coinType: string }).coinType).toBe('Morgan');

      // Same button, both directions.
      modal['toggleDropped'](previewRow(modal));
      expect(modal['recordsToImport']()).toHaveLength(2);
    });

    it('only ever offers the drop control on a row that was guessed', () => {
      // The template gates the Drop button on `ambiguity(record)`, so this is
      // the condition that keeps a two-candidate escape hatch from quietly
      // becoming a general per-row picker over 400 certain rows.
      const { modal } = createModal();
      modal['quickenText'].set(ambiguousQif);
      modal['previewImport']();

      const morgan = modal['importedRecords']().find(r => r.coinType === 'Morgan')!;
      expect(modal['ambiguity'](morgan)).toBeNull();
      expect(modal['isDropped'](morgan)).toBe(false);
    });

    it('still has no way to force an under-detailed coin in', () => {
      // The ambiguity channel adds an escape hatch for a GUESS. It must not
      // have reopened the one for a coin the backend would refuse -- see the
      // "IMPORT ANYWAY IS GONE" note above.
      const { modal } = createModal();
      modal['quickenText'].set(
        ambiguousQif + `\n!Type:Invst\nD01/17/2024\nNBuy\nY1943 Steel\nT25\n^`
      );
      modal['previewImport']();

      expect(modal['rejectedRecords']()).toHaveLength(1);
      expect(modal['recordsToImport']().some(r => r.securityName === '1943 Steel')).toBe(false);
    });
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
