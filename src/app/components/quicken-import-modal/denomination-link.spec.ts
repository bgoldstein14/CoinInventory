/*
 * The QIF import path, linking denominations.
 *
 * WHERE THE LINK IS MADE, AND WHY THERE. `QuickenImportService.parse` turns
 * a security name into a denomination STRING and must go on doing exactly
 * that: it is a pure text-in, records-out function, every one of its rules
 * (the 2-of-3 gate, the three-cent ladder, the alloy lookup) is keyed on
 * that string, and it has no business knowing what rows a database holds.
 *
 * The coin itself is built one layer up, in `importQuicken`, which is also
 * the only place with the lookup table. So that is where the text is
 * resolved to an id -- the text the parser produced, with the country the
 * parser worked out for THAT coin, through the one shared resolver.
 *
 * Linking must change nothing about WHICH coins import. The 2-of-3 rule, the
 * net-quantity rule and the deliberately absent "import anyway" override all
 * stand: a coin whose denomination resolves to nothing still imports, with
 * its text, and reads `Other (8 Reales)`.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CoinRecord } from '../../types/coin.model';
import { InventoryService } from '../../services/inventory.service';
import { QuickenImportService } from '../../services/quicken-import.service';
import { QuickenImportModal } from './quicken-import-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';

function createModal(withLookup = true) {
  const { inv } = createTestInventoryService();
  const quicken = new QuickenImportService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: QuickenImportService, useValue: quicken }
    ]
  });
  const modal = runInInjectionContext(injector, () => new QuickenImportModal());
  if (withLookup) inv.denominations.set([...SEED_DENOMINATIONS]);
  return { modal: modal as unknown as Record<string, any>, inv };
}

/** Import one security name and return the coin the modal emitted. */
function importSecurity(securityName: string, withLookup = true): CoinRecord {
  const { modal } = createModal(withLookup);
  let emitted: CoinRecord[] = [];
  (modal['imported'] as { subscribe: (fn: (c: CoinRecord[]) => void) => void })
    .subscribe(coins => { emitted = coins; });

  modal['quickenText'].set(`!Type:Invst\nD2024-02-01\nNBuy\nY${securityName}\nT100.00\n^`);
  modal['importQuicken']();

  expect(emitted, `"${securityName}" should have imported`).toHaveLength(1);
  return emitted[0];
}

describe('QIF import links the denomination it parsed', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('writes the parser\'s text AND the link', () => {
    const coin = importSecurity('1881 $1 - PCGS MS63');
    expect(coin.denomination).toBe('$1');
    expect(coin.denominationId).toBe(seedDenomination('United States', '$1')!.denominationId);
  });

  it('links a denomination the parser spells its own way', () => {
    // The parser writes '5¢' for a half dime and '3CS' for a trime; the
    // alias layer already folds those onto the seeded labels. Nothing here
    // re-states the spellings -- if it did, there would be two vocabularies.
    expect(importSecurity('1853 US Half Dime').denomination).toBe('5¢');
    expect(importSecurity('1853 US Half Dime').denominationId)
      .toBe(seedDenomination('United States', '5¢')!.denominationId);
    expect(importSecurity('1861 3CS - AU').denominationId)
      .toBe(seedDenomination('United States', '3CS')!.denominationId);
  });

  it('links by widening past the country when only one issuer struck it', () => {
    // Only Peru struck a 100 Soles, so this links whatever the country
    // says. It is here for the widening, NOT as evidence about the
    // country -- see the next two tests for that.
    const coin = importSecurity('1967 Peru 100 Soles - PCGS MS65');
    expect(coin.country).toBe('Peru');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.denominationId).toBe(seedDenomination('Peru', '100 Soles')!.denominationId);
  });

  it('passes the COUNTRY THE PARSER READ, not the collection default', () => {
    /* THE ASSERTION THAT CATCHES A HARD-CODED 'United States'.
     *
     * The obvious candidate -- the Peruvian 100 Soles above -- does NOT
     * catch it: only one issuer struck one, so it links by widening even if
     * the country is thrown away. A mutation replacing `record.country`
     * with the string 'United States' survives that test completely.
     *
     * This one cannot survive it. Six issuers struck an 8 Reales, so the
     * value resolves ONLY when scoped to one of them: with Mexico it is the
     * Mexican row, and with anything else it is null. The parser reads
     * 'Mexico' out of this security name, so the link is proof that the
     * real country reached the resolver. */
    const coin = importSecurity('1754 Mexico 8 Reales - PCGS VF30');
    expect(coin.country).toBe('Mexico');
    expect(coin.denomination).toBe('8 Reales');
    expect(coin.denominationId).toBe(seedDenomination('Mexico', '8 Reales')!.denominationId);
  });

  it('does not file a Canadian dollar under the United States', () => {
    /* The same defect seen from the other side, and the more expensive one.
     * Both countries seed a '$1', so a hard-coded country does not fail to
     * link here -- it links to the WRONG issuer, silently, and the coin
     * reads as a US dollar for ever after. */
    const coin = importSecurity('1935 Canada Dollar - PCGS MS64');
    expect(coin.country).toBe('Canada');
    expect(coin.denominationId).toBe(seedDenomination('Canada', '$1')!.denominationId);
    expect(coin.denominationId)
      .not.toBe(seedDenomination('United States', '$1')!.denominationId);
  });

  it('imports an ambiguous value with its text and no link', () => {
    // Mexican pieces end up filed under the United States when the security
    // name names no country, and six issuers struck an 8 Reales. The honest
    // answer is no link, and the coin still imports.
    const coin = importSecurity('1754 Mex. 8 Real');
    expect(coin.denomination).toBe('8 Reales');
    expect(coin.denominationId).toBeNull();
  });

  it('imports exactly as it always did when the lookup has not arrived', () => {
    const coin = importSecurity('1881 $1 - PCGS MS63', /* withLookup */ false);
    expect(coin.denomination).toBe('$1');
    expect(coin.denominationId).toBeNull();
  });

  it('links nothing when the parser read no denomination, and does not invent one', () => {
    // '1909 Lincoln Cent Roll' style names reach the import with a year and
    // a coin type and no denomination. Nothing recorded means nothing to
    // resolve -- and nothing to report either.
    const { modal } = createModal();
    let emitted: CoinRecord[] = [];
    (modal['imported'] as { subscribe: (fn: (c: CoinRecord[]) => void) => void })
      .subscribe(coins => { emitted = coins; });

    modal['quickenText'].set(
      '!Type:Invst\nD2024-02-01\nNBuy\nY1909 Lincoln Cent Roll\nT100.00\n^'
    );
    modal['importQuicken']();

    for (const coin of emitted) {
      if (!coin.denomination) expect(coin.denominationId).toBeNull();
    }
  });
});
