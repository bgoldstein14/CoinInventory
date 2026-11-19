/**
 * Tests for the "Other" (custom) state behind the Denomination and Mint mark selects. The
 * box's visibility must not depend on the field value, or typing closes it.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_OPTION_SENTINEL,
  CustomOptionMode,
  isCustomOptionValue,
  isKnownOptionValue,
  stripCustomSentinel
} from './custom-option-mode';

/** The real active US denomination labels, as seeded in setup-database.sql. */
const DENOMINATIONS = ['½¢', '1¢', '5¢', '10¢', '25¢', '50¢', '$1', '$20', '2/6 (Half Crown)'];

/** The real active mint mark labels, including a blank one and a literal "Other". */
const MINT_MARKS = ['', 'P', 'D', 'S', 'W', 'O', 'CC', 'C', 'Other'];

describe('isCustomOptionValue', () => {
  it('is true for a value that is not in the list', () => {
    expect(isCustomOptionValue('Trade Dollar', DENOMINATIONS)).toBe(true);
  });

  it('is false for a value that is in the list', () => {
    expect(isCustomOptionValue('$20', DENOMINATIONS)).toBe(false);
  });

  it('is false for blank, which means "not set" rather than "custom"', () => {
    expect(isCustomOptionValue('', DENOMINATIONS)).toBe(false);
    expect(isCustomOptionValue('   ', DENOMINATIONS)).toBe(false);
    expect(isCustomOptionValue(null, DENOMINATIONS)).toBe(false);
    expect(isCustomOptionValue(undefined, DENOMINATIONS)).toBe(false);
  });

  it('is false for the sentinel itself', () => {
    // A stored "__OTHER__" is a broken value, not a custom one.
    expect(isCustomOptionValue(CUSTOM_OPTION_SENTINEL, DENOMINATIONS)).toBe(false);
  });

  it('treats the real "Other" mint mark as a known option, not custom mode', () => {
    // A real mint mark is labelled "Other"; it must select normally.
    expect(isCustomOptionValue('Other', MINT_MARKS)).toBe(false);
    expect(isKnownOptionValue('Other', MINT_MARKS)).toBe(true);
  });
});

describe('stripCustomSentinel', () => {
  it('is the last line of defence against persisting the sentinel', () => {
    expect(stripCustomSentinel(CUSTOM_OPTION_SENTINEL)).toBe('');
  });

  it('leaves every real value alone', () => {
    expect(stripCustomSentinel('Trade Dollar')).toBe('Trade Dollar');
    expect(stripCustomSentinel('')).toBe('');
    expect(stripCustomSentinel(undefined)).toBe('');
  });
});

describe('CustomOptionMode', () => {
  it('starts closed', () => {
    expect(new CustomOptionMode().isCustom()).toBe(false);
  });

  it('opens when the user picks Other and stays open while they type', () => {
    // Typing must not close the box.
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-1', '$20', DENOMINATIONS);

    mode.enterCustomMode();
    expect(mode.isCustom()).toBe(true);

    // Each call simulates a saved keystroke.
    for (const partial of ['T', 'Tr', 'Tra', 'Trad', 'Trade']) {
      mode.syncForCoin('coin-1', partial, DENOMINATIONS);
      expect(mode.isCustom(), `after typing "${partial}"`).toBe(true);
    }
  });

  it('does not close when the typed text happens to match a real option', () => {
    // Typing "$1" on the way to "$1 Trade" must not close the box.
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-1', '', DENOMINATIONS);
    mode.enterCustomMode();

    mode.syncForCoin('coin-1', '$1', DENOMINATIONS);
    expect(mode.isCustom()).toBe(true);
  });

  it('reopens, populated, when a coin with a saved custom value is loaded', () => {
    // A saved custom value reopens in custom mode.
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-7', 'Trade Dollar', DENOMINATIONS);

    expect(mode.isCustom()).toBe(true);
    // The select reports Other while the field keeps the real text.
    expect(mode.selectValue('Trade Dollar')).toBe(CUSTOM_OPTION_SENTINEL);
  });

  it('stays closed when a coin with a standard value is loaded', () => {
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-7', '$20', DENOMINATIONS);
    expect(mode.isCustom()).toBe(false);
    expect(mode.selectValue('$20')).toBe('$20');
  });

  it('re-derives when a DIFFERENT coin is loaded', () => {
    const mode = new CustomOptionMode();

    mode.syncForCoin('coin-1', 'Trade Dollar', DENOMINATIONS);
    expect(mode.isCustom()).toBe(true);

    mode.syncForCoin('coin-2', '$20', DENOMINATIONS);
    expect(mode.isCustom()).toBe(false);

    mode.syncForCoin('coin-1', 'Trade Dollar', DENOMINATIONS);
    expect(mode.isCustom()).toBe(true);
  });

  it('waits for the lookup list before deciding anything', () => {
    // Ignore the empty list before lookups load, then derive once they arrive.
    const mode = new CustomOptionMode();

    mode.syncForCoin('coin-1', '$20', []);
    expect(mode.isCustom()).toBe(false);

    mode.syncForCoin('coin-1', '$20', DENOMINATIONS);
    expect(mode.isCustom()).toBe(false);

    const other = new CustomOptionMode();
    other.syncForCoin('coin-2', 'Trade Dollar', []);
    expect(other.isCustom()).toBe(false);
    other.syncForCoin('coin-2', 'Trade Dollar', DENOMINATIONS);
    expect(other.isCustom()).toBe(true);
  });

  it('closes again when the user goes back to a real option', () => {
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-1', 'Trade Dollar', DENOMINATIONS);
    expect(mode.isCustom()).toBe(true);

    mode.leaveCustomMode();
    expect(mode.isCustom()).toBe(false);
    expect(mode.selectValue('$20')).toBe('$20');
  });

  it('shows Other in the select while the field holds the custom text', () => {
    // Without the sentinel the select would render blank.
    const mode = new CustomOptionMode();
    mode.enterCustomMode();
    expect(mode.selectValue('Trade Dollar')).toBe(CUSTOM_OPTION_SENTINEL);
    expect(mode.selectValue('')).toBe(CUSTOM_OPTION_SENTINEL);
  });
});
