/*
 * The grid's denomination cell.
 *   1. The display string comes from denominationDisplay().
 *   2. An id-less coin has its text resolved, so it reads the same before and
 *      after ids are backfilled (migration 014).
 *   3. With no lookup loaded, the cell shows the coin's text as before.
 */

import { describe, expect, it } from 'vitest';
import {
  coinDenominationDisplay,
  formatDenominationDisplay,
  formatInventoryCell
} from './inventory-columns';
import { CoinRecord } from './coin.model';
import {
  DENOMINATION_LOOKUP,
  GB_CROWN,
  MEXICO_8_REALES,
  RETIRED_HALF_DOLLAR,
  US_DOLLAR
} from '../testing/denomination-lookup.fixture';

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: '', year: '1881', coinType: 'Morgan',
    category: '', country: '', grade: '', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

/** The cell as the grid renders it: the lookup is always passed there. */
function cell(coin: CoinRecord): string {
  return formatInventoryCell(coin, 'denomination', undefined, undefined, DENOMINATION_LOOKUP);
}

describe('the denomination cell — design §4.1, with a lookup loaded', () => {
  it('shows the Label of the id the coin carries, not the text it arrived with', () => {
    // The id wins over the imported text.
    const coin = makeCoin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' });
    expect(cell(coin)).toBe('8 Reales');
  });

  it('names what was recorded when nothing resolves, rather than a bare Other', () => {
    // 'Trade Dollar' is deliberately not an alias of '$1' (a different coin).
    const coin = makeCoin({ denomination: 'Trade Dollar' });
    expect(cell(coin)).toBe('Other (Trade Dollar)');
  });

  it('refuses to guess an issuer when two of them struck the same coin', () => {
    // GB '5/- (Crown)' and Australian 'Crown' share an alias key; don't guess the issuer.
    const coin = makeCoin({ denomination: 'Crown', country: 'United States' });
    expect(cell(coin)).toBe('Other (Crown)');
  });

  it('shows the placeholder when the coin has neither an id nor any text', () => {
    expect(cell(makeCoin())).toBe('—');
    expect(cell(makeCoin({ denomination: '   ' }))).toBe('—');
  });

  it('treats a soft-deleted denomination as unresolved, which is what it is', () => {
    // Deletion should null the id, but stale rows can remain; don't show a retired label.
    const coin = makeCoin({ denominationId: RETIRED_HALF_DOLLAR, denomination: 'Half Dollar' });
    expect(cell(coin)).toBe('Other (Half Dollar)');
  });
});

describe('the denomination cell — the un-migrated database', () => {
  it('reads an id-less coin exactly as it will read after migration 014', () => {
    const before = makeCoin({ denomination: '8 Reales', country: 'United States' });
    const after = makeCoin({
      denominationId: MEXICO_8_REALES, denomination: '8 Reales', country: 'United States'
    });
    expect(cell(before)).toBe('8 Reales');
    expect(cell(after)).toBe(cell(before));
  });

  it('resolves across issuers, so the 8-Reales coins stop being filed as Other', () => {
    // The QIF parser never set a country, so Mexican coins say 'United States';
    // resolution must not be scoped by country.
    const coin = makeCoin({ denomination: '8 Reales', country: 'United States' });
    expect(cell(coin)).toBe('8 Reales');
  });

  it('folds the spellings the alias table already knows', () => {
    // Column holds 'Trime'; the lookup row is labelled '3CS'.
    const coin = makeCoin({ denomination: 'Trime', country: 'United States' });
    expect(cell(coin)).toBe('3CS');
  });
});

describe('the denomination cell — with no lookup, nothing changes at all', () => {
  const CASES = ['$1', '2/-', '5 Shilling', 'Trade Dollar', 'Pillar Dollar', ''];

  it('renders every value exactly as formatDenominationDisplay always has', () => {
    // e.g. during hydration, before the lookup arrives.
    for (const denomination of CASES) {
      const coin = makeCoin({ denomination });
      expect(coinDenominationDisplay(coin, [])).toBe(formatDenominationDisplay(denomination));
      expect(formatInventoryCell(coin, 'denomination')).toBe(formatDenominationDisplay(denomination));
    }
  });

  it('still prefers an id over the text when the id happens to be set', () => {
    // An id with no list to resolve it against falls back to the text.
    const coin = makeCoin({ denominationId: US_DOLLAR, denomination: 'Silver Dollar' });
    expect(coinDenominationDisplay(coin, [])).toBe('Silver Dollar');
  });
});

describe('the denomination cell — shilling notation', () => {
  it('normalises a RESOLVED label the same way the editor dropdown does', () => {
    // Matches the editor's picker, which formats options the same way.
    const coin = makeCoin({ denominationId: GB_CROWN, denomination: '5s' });
    expect(cell(coin)).toBe('5 sh (Crown)');
  });

  it('leaves the recorded text verbatim inside the unresolved form', () => {
    // The recorded text is shown as the source wrote it.
    const coin = makeCoin({ denomination: '7/- (Nonesuch)' });
    expect(cell(coin)).toBe('Other (7/- (Nonesuch))');
  });

  it('does not let the em-dash from an empty label swallow the recorded text', () => {
    // formatDenominationDisplay('') returns '—'; normalising an absent label
    // first would make every unresolved coin read '—'.
    const coin = makeCoin({ denomination: 'Trade Dollar' });
    expect(cell(coin)).not.toBe('—');
    expect(cell(coin)).toBe('Other (Trade Dollar)');
  });
});

describe('formatInventoryCell threads the lookup to the right column only', () => {
  it('uses the fifth argument for denomination and ignores it elsewhere', () => {
    const coin = makeCoin({
      denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar', coinType: 'Morgan'
    });
    expect(formatInventoryCell(coin, 'denomination', undefined, undefined, DENOMINATION_LOOKUP))
      .toBe('8 Reales');
    expect(formatInventoryCell(coin, 'coinType', undefined, undefined, DENOMINATION_LOOKUP))
      .toBe('Morgan');
  });
});
