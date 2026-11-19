/*
 * QIF import: denomination linking. The parser produces a denomination string;
 * `importQuicken` resolves it to an id using the parsed country and the shared
 * resolver. Linking never changes which coins import: an unresolved coin still
 * imports with its text and reads `Other (...)`.
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
    // The shared alias layer folds the parser's spellings onto the seeded labels.
    expect(importSecurity('1853 US Half Dime').denomination).toBe('5¢');
    expect(importSecurity('1853 US Half Dime').denominationId)
      .toBe(seedDenomination('United States', '5¢')!.denominationId);
    expect(importSecurity('1861 3CS - AU').denominationId)
      .toBe(seedDenomination('United States', '3CS')!.denominationId);
  });

  it('links by widening past the country when only one issuer struck it', () => {
    // Only Peru struck a 100 Soles, so this links by widening regardless of country.
    const coin = importSecurity('1967 Peru 100 Soles - PCGS MS65');
    expect(coin.country).toBe('Peru');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.denominationId).toBe(seedDenomination('Peru', '100 Soles')!.denominationId);
  });

  it('passes the COUNTRY THE PARSER READ, not the collection default', () => {
    /* Six issuers struck an 8 Reales, so this links only if the parsed country
         * ('Mexico') reaches the resolver, catching a hard-coded 'United States'. */
    const coin = importSecurity('1754 Mexico 8 Reales - PCGS VF30');
    expect(coin.country).toBe('Mexico');
    expect(coin.denomination).toBe('8 Reales');
    expect(coin.denominationId).toBe(seedDenomination('Mexico', '8 Reales')!.denominationId);
  });

  it('does not file a Canadian dollar under the United States', () => {
    /* Both countries seed a '$1', so a hard-coded country would link to the wrong issuer. */
    const coin = importSecurity('1935 Canada Dollar - PCGS MS64');
    expect(coin.country).toBe('Canada');
    expect(coin.denominationId).toBe(seedDenomination('Canada', '$1')!.denominationId);
    expect(coin.denominationId)
      .not.toBe(seedDenomination('United States', '$1')!.denominationId);
  });

  it('imports an ambiguous value with its text and no link', () => {
    // No country in the name defaults to the US; with six 8 Reales issuers, no link, but it still imports.
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
    // Names like '1909 Lincoln Cent Roll' have no denomination, so nothing to resolve or report.
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
