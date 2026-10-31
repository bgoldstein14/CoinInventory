/**
 * Tests for the denomination alias layer.
 *
 * WHY THESE TESTS AND NOT TEMPLATE TESTS
 * The symptom is a rendering outcome — "the Denomination dropdown sits on
 * Other instead of the coin's real denomination" — and this project's suite
 * runs under plain Node with no jsdom, so no template can be rendered here.
 * What CAN be tested is the decision behind it: which lookup label, if any, a
 * stored denomination string corresponds to. That decision is the whole of
 * this bug, and it lives in `denomination-aliases.ts`.
 *
 * The last block composes `resolveDenominationLabel` with `CustomOptionMode`
 * exactly the way `coin-editor-form.ts` does, which is as close to an
 * end-to-end test of the reported symptom as this suite can get.
 */
import { describe, expect, it } from 'vitest';
import { CustomOptionMode } from './custom-option-mode';
import { denominationKey, resolveDenominationLabel } from './denomination-aliases';
import { QIF_ACCOUNTS, inventoryFor } from '../../testing/qif-accounts.fixture';

/**
 * The real active denomination labels, VERBATIM from the seed rows in
 * server/setup-database.sql (the 18 US rows including migration 009's $25 and
 * $50, and the 22 GB rows). Not a trimmed-down sample: the collisions this
 * file has to avoid — '$1' against '$10', '5¢' against '25¢', '3CS' against
 * '3CN' — only exist when the whole list is present.
 */
const US_LABELS = [
  '½¢', '1¢', '2¢', '3CS', '3CN', '5¢', '10¢', '20¢', '25¢', '50¢',
  '$1', '$2.50', '$3', '$5', '$10', '$20', '$25', '$50'
];
const GB_LABELS = [
  'Farthing', '½d', '1d', '3d', '6d', '1/-', '2/- (Florin)', '2/6 (Half Crown)',
  '5/- (Crown)', '½ Sovereign', 'Sovereign', 'Guinea', '½p', '1p', '2p', '5p',
  '10p', '20p', '50p', '£1', '£2', '£5'
];
const LABELS = [...US_LABELS, ...GB_LABELS];

describe('denominationKey', () => {
  it('folds the symbols the lookup labels are written with', () => {
    // The same three substitutions migration 007 makes, for the same reason:
    // the column and the lookup disagree about symbols, not about coins.
    expect(denominationKey('50¢')).toBe('50c');
    expect(denominationKey('½¢')).toBe('halfc');
    expect(denominationKey('£5')).toBe('gbp5');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(denominationKey('  3cs ')).toBe(denominationKey('3CS'));
    expect(denominationKey('Half   Dollar')).toBe(denominationKey('half dollar'));
  });

  it('gives two different coins two different keys', () => {
    // The 1865-1873 overlap is the reason the importer flags a bare "3¢" at
    // all. Folding 3CS and 3CN together here would undo that work silently.
    expect(denominationKey('3CS')).not.toBe(denominationKey('3CN'));
  });
});

describe('resolveDenominationLabel', () => {
  it('returns the label unchanged when the coin already holds one', () => {
    expect(resolveDenominationLabel('3CS', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('$20', LABELS)).toBe('$20');
  });

  it('matches a label that differs only in case — THE REPORTED BUG', () => {
    // `Denominations.Label` is '3CS'. Anything that typed it as '3cs' — a CSV
    // column, a hand-typed row, denomination-sort.ts's own vocabulary — missed
    // the exact-match test and opened the custom box.
    expect(resolveDenominationLabel('3cs', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('3Cn', LABELS)).toBe('3CN');
  });

  it('matches the spelled-out US names — THE REPORTED BUG', () => {
    expect(resolveDenominationLabel('Three Cent Silver', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('Trime', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('Three Cent Nickel', LABELS)).toBe('3CN');
    // The ones docs/csv-import-guide.md tells people to type.
    expect(resolveDenominationLabel('Dollar', LABELS)).toBe('$1');
    expect(resolveDenominationLabel('Quarter', LABELS)).toBe('25¢');
    expect(resolveDenominationLabel('Half Dollar', LABELS)).toBe('50¢');
    expect(resolveDenominationLabel('Dime', LABELS)).toBe('10¢');
    expect(resolveDenominationLabel('Half Cent', LABELS)).toBe('½¢');
    expect(resolveDenominationLabel('Nickel', LABELS)).toBe('5¢');
    expect(resolveDenominationLabel('Double Eagle', LABELS)).toBe('$20');
    expect(resolveDenominationLabel('Quarter Eagle', LABELS)).toBe('$2.50');
  });

  it('reads "<n> cents" and "<n> dollars" as face values', () => {
    // coin-signature.ts names "50 Cents" as a real value of this column.
    expect(resolveDenominationLabel('50 Cents', LABELS)).toBe('50¢');
    expect(resolveDenominationLabel('20 cent', LABELS)).toBe('20¢');
    expect(resolveDenominationLabel('20 Dollars', LABELS)).toBe('$20');
    expect(resolveDenominationLabel('2.50 dollars', LABELS)).toBe('$2.50');
  });

  it('matches the GB shilling notations the QIF importer actually writes', () => {
    // quicken-import.service.ts writes '5s' for a crown and '1s' for a
    // shilling; the lookup spells them '5/- (Crown)' and '1/-'. Every British
    // crown in the collection imported straight into the custom box.
    expect(resolveDenominationLabel('5s', LABELS)).toBe('5/- (Crown)');
    expect(resolveDenominationLabel('1s', LABELS)).toBe('1/-');
    expect(resolveDenominationLabel('Crown', LABELS)).toBe('5/- (Crown)');
    expect(resolveDenominationLabel('Half Crown', LABELS)).toBe('2/6 (Half Crown)');
    expect(resolveDenominationLabel('Florin', LABELS)).toBe('2/- (Florin)');
    expect(resolveDenominationLabel('Shilling', LABELS)).toBe('1/-');
  });

  it('answers null for a value that really is custom', () => {
    // These have no row in the lookup under any spelling, so the custom text
    // box opening for them is CORRECT and must keep happening.
    expect(resolveDenominationLabel('8 Reales', LABELS)).toBeNull();
    expect(resolveDenominationLabel('100 Soles', LABELS)).toBeNull();
    expect(resolveDenominationLabel('20 Francs', LABELS)).toBeNull();
    expect(resolveDenominationLabel('Pillar Dollar', LABELS)).toBeNull();
  });

  it('refuses the readings the rest of the app refuses', () => {
    // Deliberate non-aliases, each one copied from an existing decision:
    //   'Penny'        migration 007 — US cent to an American, GB penny to
    //                  everyone else, and the alloys part company in 1943.
    //   'Eagle'        migration 007 — Gold, Silver and the classic $10 Eagle
    //                  are three coins in three metals.
    //   'Trade Dollar' custom-option-mode.ts uses it as its worked example of
    //                  a legitimate custom denomination. It is a distinct coin
    //                  (420 grains, struck for the Orient), not a synonym for
    //                  the $1 the lookup offers.
    //   '3 cent'       the 1851-1889 three-cent span covers two different
    //                  coins; choosing one here is the guess the importer goes
    //                  out of its way to flag.
    expect(resolveDenominationLabel('Penny', LABELS)).toBeNull();
    expect(resolveDenominationLabel('Eagle', LABELS)).toBeNull();
    expect(resolveDenominationLabel('Trade Dollar', LABELS)).toBeNull();
    expect(resolveDenominationLabel('3 cent', LABELS)).toBeNull();
  });

  it('answers null for blank, which means "not set" rather than "custom"', () => {
    expect(resolveDenominationLabel('', LABELS)).toBeNull();
    expect(resolveDenominationLabel('   ', LABELS)).toBeNull();
    expect(resolveDenominationLabel(null, LABELS)).toBeNull();
    expect(resolveDenominationLabel(undefined, LABELS)).toBeNull();
  });

  it('never invents a label the lookup does not offer', () => {
    // The alias table is only ever a way of FINDING a row that is already
    // there. On a database whose Denominations table has been edited down —
    // the Settings dialog can deactivate rows — an alias with no surviving row
    // must answer null, not a label that would render as a missing <option>.
    expect(resolveDenominationLabel('Half Dollar', ['$1', '$20'])).toBeNull();
    expect(resolveDenominationLabel('Three Cent Silver', [])).toBeNull();
  });
});

describe('the editor decision this fixes', () => {
  /** The exact composition coin-editor-form.ts performs on every coin load. */
  function opensTheCustomBox(storedDenomination: string): boolean {
    const mode = new CustomOptionMode();
    const forSelect = resolveDenominationLabel(storedDenomination, LABELS) ?? storedDenomination;
    mode.syncForCoin('coin-1', forSelect, LABELS);
    return mode.isCustom();
  }

  it('leaves the dropdown on the coin, not on Other, for the reported coins', () => {
    // The owner's report: "I brought up the 1866 3CS NGC PF65 CAC... it shows
    // Other. I brought up another 3CS, same thing."
    expect(opensTheCustomBox('Three Cent Silver')).toBe(false);
    expect(opensTheCustomBox('3cs')).toBe(false);
    expect(opensTheCustomBox('Trime')).toBe(false);
    expect(opensTheCustomBox('3CS')).toBe(false);
  });

  it('still opens the box for a denomination that genuinely has no row', () => {
    expect(opensTheCustomBox('8 Reales')).toBe(true);
    expect(opensTheCustomBox('Trade Dollar')).toBe(true);
  });
});

describe('the real collection', () => {
  /**
   * REALITY, not a fixture. Every coin the owner's seven QIF accounts have
   * ever held, parsed by the importer that will parse them again, measured
   * against the labels the database is seeded with.
   *
   * Before this change six of them opened on "Other": four "8 Reales", one
   * "100 Soles" and one "5s". The 5s is the bug — the lookup has that coin,
   * spelled '5/- (Crown)'. The other five have no row under any spelling and
   * are supposed to open the box.
   */
  const coins = QIF_ACCOUNTS.flatMap(account => inventoryFor(account));

  it('covers every denomination the importer produces that the lookup can hold', () => {
    const unresolved = [
      ...new Set(
        coins
          .map(coin => coin.denomination ?? '')
          .filter(value => value.trim().length > 0)
          .filter(value => resolveDenominationLabel(value, LABELS) === null)
      )
    ].sort();

    // Exactly the foreign face values, and nothing else. '5s' must not be
    // here: it is a British crown and the lookup has one.
    expect(unresolved).toEqual(['100 Soles', '8 Reales']);
  });

  it('resolves every other coin to a label the dropdown really offers', () => {
    for (const coin of coins) {
      const value = coin.denomination ?? '';
      if (!value.trim()) continue;
      const resolved = resolveDenominationLabel(value, LABELS);
      if (resolved === null) continue;
      expect(LABELS, `"${value}" resolved to a label that is not in the lookup`).toContain(resolved);
    }
  });
});
