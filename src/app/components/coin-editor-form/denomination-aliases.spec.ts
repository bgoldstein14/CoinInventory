/**
 * Tests for the denomination alias layer: which lookup label, if any, a stored denomination
 * string corresponds to. The last block combines it with CustomOptionMode as the editor does.
 */
import { describe, expect, it } from 'vitest';
import { CustomOptionMode } from './custom-option-mode';
import { denominationKey, resolveDenominationLabel } from './denomination-aliases';
import { QIF_ACCOUNTS, inventoryFor } from '../../testing/qif-accounts.fixture';

/**
 * The real active labels from setup-database.sql (US and GB). The full list is needed so
 * near-collisions like '$1'/'$10' and '3CS'/'3CN' are exercised.
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
    // Same symbol folding as migration 007.
    expect(denominationKey('50¢')).toBe('50c');
    expect(denominationKey('½¢')).toBe('halfc');
    expect(denominationKey('£5')).toBe('gbp5');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(denominationKey('  3cs ')).toBe(denominationKey('3CS'));
    expect(denominationKey('Half   Dollar')).toBe(denominationKey('half dollar'));
  });

  it('gives two different coins two different keys', () => {
    // 3CS and 3CN are different coins and must stay distinct.
    expect(denominationKey('3CS')).not.toBe(denominationKey('3CN'));
  });
});

describe('resolveDenominationLabel', () => {
  it('returns the label unchanged when the coin already holds one', () => {
    expect(resolveDenominationLabel('3CS', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('$20', LABELS)).toBe('$20');
  });

  it('matches a label that differs only in case — THE REPORTED BUG', () => {
    // Case differences ('3cs') must still match.
    expect(resolveDenominationLabel('3cs', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('3Cn', LABELS)).toBe('3CN');
  });

  it('matches the spelled-out US names — THE REPORTED BUG', () => {
    expect(resolveDenominationLabel('Three Cent Silver', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('Trime', LABELS)).toBe('3CS');
    expect(resolveDenominationLabel('Three Cent Nickel', LABELS)).toBe('3CN');
    // Spellings suggested by docs/csv-import-guide.md.
    expect(resolveDenominationLabel('Dollar', LABELS)).toBe('$1');
    expect(resolveDenominationLabel('Quarter', LABELS)).toBe('25¢');
    expect(resolveDenominationLabel('Half Dollar', LABELS)).toBe('50¢');
    expect(resolveDenominationLabel('Dime', LABELS)).toBe('10¢');
    expect(resolveDenominationLabel('Half Cent', LABELS)).toBe('½¢');
    expect(resolveDenominationLabel('Double Eagle', LABELS)).toBe('$20');
    expect(resolveDenominationLabel('Quarter Eagle', LABELS)).toBe('$2.50');
  });

  it('reads "<n> cents" and "<n> dollars" as face values', () => {
    // Face values written as words.
    expect(resolveDenominationLabel('50 Cents', LABELS)).toBe('50¢');
    expect(resolveDenominationLabel('20 cent', LABELS)).toBe('20¢');
    expect(resolveDenominationLabel('20 Dollars', LABELS)).toBe('$20');
    expect(resolveDenominationLabel('2.50 dollars', LABELS)).toBe('$2.50');
  });

  it('matches the GB shilling notations the QIF importer actually writes', () => {
    // Forms written by the QIF importer.
    expect(resolveDenominationLabel('5s', LABELS)).toBe('5/- (Crown)');
    expect(resolveDenominationLabel('1s', LABELS)).toBe('1/-');
    expect(resolveDenominationLabel('Crown', LABELS)).toBe('5/- (Crown)');
    expect(resolveDenominationLabel('Half Crown', LABELS)).toBe('2/6 (Half Crown)');
    expect(resolveDenominationLabel('Florin', LABELS)).toBe('2/- (Florin)');
    expect(resolveDenominationLabel('Shilling', LABELS)).toBe('1/-');
  });

  it('answers null for a value that really is custom', () => {
    // No lookup row under any spelling, so these stay custom.
    expect(resolveDenominationLabel('8 Reales', LABELS)).toBeNull();
    expect(resolveDenominationLabel('100 Soles', LABELS)).toBeNull();
    expect(resolveDenominationLabel('20 Francs', LABELS)).toBeNull();
    expect(resolveDenominationLabel('Pillar Dollar', LABELS)).toBeNull();
  });

  it('refuses the readings the rest of the app refuses', () => {
    // Deliberately not aliases: 'Penny' and 'Eagle' are ambiguous, 'Trade Dollar' is a distinct
    // coin, and '3 cent' could be silver or nickel.
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
    // An alias with no active row answers null rather than a label with no <option>.
    expect(resolveDenominationLabel('Half Dollar', ['$1', '$20'])).toBeNull();
    expect(resolveDenominationLabel('Three Cent Silver', [])).toBeNull();
  });
});

describe('the editor decision this fixes', () => {
  /** The same composition coin-editor-form.ts performs on coin load. */
  function opensTheCustomBox(storedDenomination: string): boolean {
    const mode = new CustomOptionMode();
    const forSelect = resolveDenominationLabel(storedDenomination, LABELS) ?? storedDenomination;
    mode.syncForCoin('coin-1', forSelect, LABELS);
    return mode.isCustom();
  }

  it('leaves the dropdown on the coin, not on Other, for the reported coins', () => {
    // A 3CS coin must not open as "Other".
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
   * Real QIF data: every denomination parsed from the sample accounts, checked against the
   * seeded labels. Only genuinely foreign face values should be custom.
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

    // Only foreign face values; '5s' is a British crown and must resolve.
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

/* "Nickel" and "Half Dime" are distinct seeded coins and must not fold onto 5¢. */
describe('the five-cent rows are distinct, not aliases of one another', () => {
  const FIVE_CENT_LABELS = ['5¢', 'Half Dime', 'Nickel'];

  it('resolves each spelling to its own row', () => {
    expect(resolveDenominationLabel('Nickel', FIVE_CENT_LABELS)).toBe('Nickel');
    expect(resolveDenominationLabel('Half Dime', FIVE_CENT_LABELS)).toBe('Half Dime');
    expect(resolveDenominationLabel('5¢', FIVE_CENT_LABELS)).toBe('5¢');
  });

  it('keeps all three on separate keys, which is what makes that possible', () => {
    const keys = FIVE_CENT_LABELS.map(denominationKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('still folds "Five Cents" onto the generic row', () => {
    // A plain spelling of 5¢, so this alias stays.
    expect(resolveDenominationLabel('Five Cents', FIVE_CENT_LABELS)).toBe('5¢');
  });
});
