import { describe, expect, it } from 'vitest';
import { parseDenominationValue } from './denomination-sort';

/**
 * Longest-match ordering.
 *
 * `parseDenominationValue` used to take the FIRST entry in its table whose
 * text appeared anywhere in the label. The table runs smallest face value
 * first, so a short pattern reliably shadowed a longer one starting the same
 * way — and four of the victims are denominations the database actually
 * seeds, so this was live and silent: nothing failed, rows were just sorted
 * into the wrong place.
 */
describe('parseDenominationValue — a short pattern must not shadow a longer one', () => {
  it('reads the dollar denominations at their real value', () => {
    expect(parseDenominationValue('$1')).toBe(1);
    expect(parseDenominationValue('$2.50')).toBe(2.5);  // was 2   — matched "$2"
    expect(parseDenominationValue('$3')).toBe(3);
    expect(parseDenominationValue('$5')).toBe(5);
    expect(parseDenominationValue('$10')).toBe(10);     // was 1   — matched "$1"
    expect(parseDenominationValue('$20')).toBe(20);     // was 2   — matched "$2"
    expect(parseDenominationValue('$25')).toBe(25);     // new
    expect(parseDenominationValue('$50')).toBe(50);     // was 5   — matched "$5"
  });

  it('reads the cent denominations at their real value', () => {
    expect(parseDenominationValue('1¢')).toBe(0.01);
    expect(parseDenominationValue('5¢')).toBe(0.05);
    expect(parseDenominationValue('10¢')).toBe(0.1);
    expect(parseDenominationValue('20¢')).toBe(0.2);
    expect(parseDenominationValue('25¢')).toBe(0.25);   // was 0.05 — matched "5¢"
    expect(parseDenominationValue('50¢')).toBe(0.5);
  });

  it('sorts the US series into ascending order', () => {
    // The property that actually matters to the user: the dropdown and the
    // sorted grid read low to high.
    const series = ['$50', '25¢', '$10', '1¢', '$2.50', '$20', '$25', '5¢'];
    const sorted = [...series].sort((a, b) => parseDenominationValue(a) - parseDenominationValue(b));

    expect(sorted).toEqual(['1¢', '5¢', '25¢', '$2.50', '$10', '$20', '$25', '$50']);
  });

  it('still prefers an exact match over any substring', () => {
    expect(parseDenominationValue('$5')).toBe(5);
    expect(parseDenominationValue('$2')).toBe(2);
  });
});
