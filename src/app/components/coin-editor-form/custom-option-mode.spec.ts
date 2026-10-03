/**
 * Tests for the "the user picked Other" state behind the Denomination and
 * Mint mark selects.
 *
 * WHY THESE TESTS AND NOT TEMPLATE TESTS
 * The visible symptom — "only one letter can be typed and then the box goes
 * away" — is a rendering outcome, and this project's suite runs under plain
 * Node with no jsdom, so no template can be rendered here. What CAN be tested
 * is the state machine that decides whether the box is open, which is where
 * the bug actually lived: the old code used the coin's denomination VALUE as
 * that state, so writing a value closed the box.
 *
 * Each test below corresponds to one sentence of the owner's bug report.
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

/** The real active mint mark labels. Note the blank one, and the literal "Other". */
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
    // Defensive: if a legacy row in the database really does hold "__OTHER__"
    // (the old code could save it), that is a broken value, not a custom one.
    expect(isCustomOptionValue(CUSTOM_OPTION_SENTINEL, DENOMINATIONS)).toBe(false);
  });

  it('treats the real "Other" mint mark as a known option, not custom mode', () => {
    // The mint mark lookup table genuinely contains a mark labelled "Other"
    // (the catch-all for oddities like O/S). It must select normally.
    expect(isCustomOptionValue('Other', MINT_MARKS)).toBe(false);
    expect(isKnownOptionValue('Other', MINT_MARKS)).toBe(true);
  });
});

describe('stripCustomSentinel', () => {
  it('is the last line of defence against persisting the sentinel', () => {
    // "__OTHER__" must never reach the database as a denomination.
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
    // The headline bug: "only one letter/number can be typed and then the box
    // goes away". Typing used to change the value, and the value was the state.
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-1', '$20', DENOMINATIONS);

    mode.enterCustomMode();
    expect(mode.isCustom()).toBe(true);

    // Each of these is "the coin signal changed because a keystroke was saved".
    for (const partial of ['T', 'Tr', 'Tra', 'Trad', 'Trade']) {
      mode.syncForCoin('coin-1', partial, DENOMINATIONS);
      expect(mode.isCustom(), `after typing "${partial}"`).toBe(true);
    }
  });

  it('does not close when the typed text happens to match a real option', () => {
    // The nasty edge case. Typing "$1" on the way to "$1 Trade" must not yank
    // the box away just because "$1" is a denomination in the list.
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-1', '', DENOMINATIONS);
    mode.enterCustomMode();

    mode.syncForCoin('coin-1', '$1', DENOMINATIONS);
    expect(mode.isCustom()).toBe(true);
  });

  it('reopens, populated, when a coin with a saved custom value is loaded', () => {
    // "Even if I force an entry into there and bring the coin back up, it's not
    // coming up as Other with the Other text box showing the value."
    const mode = new CustomOptionMode();
    mode.syncForCoin('coin-7', 'Trade Dollar', DENOMINATIONS);

    expect(mode.isCustom()).toBe(true);
    // The box is bound straight to the coin field, so "populated" simply means
    // the select reports Other while the field still holds the real text.
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
    // The denominations come from the server. If a coin is opened before they
    // arrive, every value looks "not in the list" and every coin would wrongly
    // flip into custom mode. The empty list must be ignored, AND the decision
    // must still happen once the list does arrive.
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
    // The select has no <option> matching "Trade Dollar", so without this
    // substitution it would render as blank and look like nothing is chosen.
    const mode = new CustomOptionMode();
    mode.enterCustomMode();
    expect(mode.selectValue('Trade Dollar')).toBe(CUSTOM_OPTION_SENTINEL);
    expect(mode.selectValue('')).toBe(CUSTOM_OPTION_SENTINEL);
  });
});
