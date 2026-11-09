/*
 * inventory-columns-denomination.spec.ts — the GRID's denomination cell.
 * WHAT IS BEING DEFENDED
 * Since migration 011 a coin carries a `denominationId` AND the text the
 * source wrote. The coin editor already reads the id. Until this change the
 * grid read only the text, so the moment migration 014 sets ids the SAME COIN
 * would have read `8 Reales` in the editor and `Pillar Dollar` in the grid,
 * with nothing failing and no error anywhere.
 *
 * Three properties are pinned here, and the second is the one that protects
 * the owner's live database:
 *
 *   1. THE DISPLAY RULE IS §4.1's, AND IT COMES FROM denominationDisplay().
 *      Not a second copy of it. denomination-display.spec.ts greps src/ and
 *      fails the build if any other file builds the string.
 *
 *   2. MIGRATION 014 CHANGES NOTHING ON SCREEN. The owner's 105 coins all
 *      have `DenominationId` NULL today. A read path keyed on the id alone
 *      would show every one of them as unresolved the day he upgrades and
 *      before he has run anything. So an id-less coin has its TEXT resolved
 *      through the same resolver the migration uses, exactly as the editor's
 *      picker already does, and a coin reads identically either side of 014.
 *
 *   3. NO LOOKUP, NO CHANGE. Until `GET /api/denominations` lands — and in
 *      every caller that has no lookup to give — the cell renders precisely
 *      what it rendered before this change. A blank-looking grid during
 *      hydration, or a flash of "unresolved" on every row, would both be
 *      worse than the text the app has had all along.
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
    // The post-import state the whole design exists to describe: the column
    // still says what the QIF said, the id says what it IS. The id wins.
    const coin = makeCoin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' });
    expect(cell(coin)).toBe('8 Reales');
  });

  it('names what was recorded when nothing resolves, rather than a bare Other', () => {
    // 'Trade Dollar' is deliberately NOT an alias of '$1' (see
    // denomination-aliases.ts: 420 grains, a different coin), and no row
    // carries that label, so there is no honest id for it.
    const coin = makeCoin({ denomination: 'Trade Dollar' });
    expect(cell(coin)).toBe('Other (Trade Dollar)');
  });

  it('refuses to guess an issuer when two of them struck the same coin', () => {
    // Great Britain's '5/- (Crown)' and Australia's 'Crown' fold to one alias
    // key. Picking either would file the coin under an issuer the owner never
    // chose, invisibly and for good.
    const coin = makeCoin({ denomination: 'Crown', country: 'United States' });
    expect(cell(coin)).toBe('Other (Crown)');
  });

  it('shows the placeholder when the coin has neither an id nor any text', () => {
    expect(cell(makeCoin())).toBe('—');
    expect(cell(makeCoin({ denomination: '   ' }))).toBe('—');
  });

  it('treats a soft-deleted denomination as unresolved, which is what it is', () => {
    // §4.4 nulls the id on deletion, so this should not occur — but a
    // hand-edited row or an older build can leave one behind, and showing a
    // retired row's label would name a denomination the app no longer offers.
    const coin = makeCoin({ denominationId: RETIRED_HALF_DOLLAR, denomination: 'Half Dollar' });
    expect(cell(coin)).toBe('Other (Half Dollar)');
  });
});

describe('the denomination cell — the un-migrated database', () => {
  it('reads an id-less coin exactly as it will read after migration 014', () => {
    // THE CENTRAL CLAIM OF THIS CHANGE. Same text, same country, id absent
    // and id present, one string. If these two ever diverge the owner sees
    // his collection rename itself the day he runs the migration.
    const before = makeCoin({ denomination: '8 Reales', country: 'United States' });
    const after = makeCoin({
      denominationId: MEXICO_8_REALES, denomination: '8 Reales', country: 'United States'
    });
    expect(cell(before)).toBe('8 Reales');
    expect(cell(after)).toBe(cell(before));
  });

  it('resolves across issuers, so the 8-Reales coins stop being filed as Other', () => {
    // The QIF parser never set a country, so every Mexican coin the owner
    // owns says 'United States'. A country-scoped lookup would resolve
    // nothing for precisely the case this work exists to fix.
    const coin = makeCoin({ denomination: '8 Reales', country: 'United States' });
    expect(cell(coin)).toBe('8 Reales');
  });

  it('folds the spellings the alias table already knows', () => {
    // The column holds 'Trime'; the lookup row is labelled '3CS'. The editor
    // has always sat on that row for this coin; now the grid agrees with it.
    const coin = makeCoin({ denomination: 'Trime', country: 'United States' });
    expect(cell(coin)).toBe('3CS');
  });
});

describe('the denomination cell — with no lookup, nothing changes at all', () => {
  const CASES = ['$1', '2/-', '5 Shilling', 'Trade Dollar', 'Pillar Dollar', ''];

  it('renders every value exactly as formatDenominationDisplay always has', () => {
    // During hydration, and in every caller that has no lookup to pass, the
    // cell must be the one the app has shown for years. Rendering
    // `Other (...)` on all 105 rows while a fetch is in flight would read as
    // the upgrade having destroyed the collection.
    for (const denomination of CASES) {
      const coin = makeCoin({ denomination });
      expect(coinDenominationDisplay(coin, [])).toBe(formatDenominationDisplay(denomination));
      expect(formatInventoryCell(coin, 'denomination')).toBe(formatDenominationDisplay(denomination));
    }
  });

  it('still prefers an id over the text when the id happens to be set', () => {
    // An id with no list to resolve it against is not a label. Falling back
    // to the text is the only thing left, and it is what the coin says.
    const coin = makeCoin({ denominationId: US_DOLLAR, denomination: 'Silver Dollar' });
    expect(coinDenominationDisplay(coin, [])).toBe('Silver Dollar');
  });
});

describe('the denomination cell — shilling notation', () => {
  it('normalises a RESOLVED label the same way the editor dropdown does', () => {
    // coin-editor-form.html renders every <option> through
    // formatDenominationDisplay, so the picker shows '5 sh (Crown)'. A grid
    // that printed the raw label '5/- (Crown)' would re-create, in a new
    // place, exactly the two-spellings-of-one-coin problem this change is
    // here to remove.
    const coin = makeCoin({ denominationId: GB_CROWN, denomination: '5s' });
    expect(cell(coin)).toBe('5 sh (Crown)');
  });

  it('leaves the recorded text verbatim inside the unresolved form', () => {
    // The text is EVIDENCE of what the source said — the one thing the
    // `Other (...)` form exists to show. Rewriting it would destroy the only
    // record of a value the owner has to recognise before he can re-map it.
    const coin = makeCoin({ denomination: '7/- (Nonesuch)' });
    expect(cell(coin)).toBe('Other (7/- (Nonesuch))');
  });

  it('does not let the em-dash from an empty label swallow the recorded text', () => {
    // THE TRAP. formatDenominationDisplay('') answers '—'. Normalising an
    // ABSENT label before handing it to denominationDisplay() would make that
    // em-dash look like a resolved label and win over the text, so every
    // unresolved coin in the grid would read '—' and the collection would
    // look empty. composition-breakdown.ts documents the same hazard.
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
