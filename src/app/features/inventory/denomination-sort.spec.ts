import { describe, expect, it } from 'vitest';
import { parseDenominationValue } from './denomination-sort';

/**
 * Longest-match ordering.
 *
 * `parseDenominationValue` scans a table of patterns. Taking the first whose
 * text appears anywhere in the label lets a short pattern shadow a longer
 * one starting the same way, and the failure is silent: nothing throws, rows
 * are just sorted into the wrong place. The inline notes below name the
 * pattern each assertion stops winning.
 */
describe('parseDenominationValue — a short pattern must not shadow a longer one', () => {
  it('reads the dollar denominations at their real value', () => {
    expect(parseDenominationValue('$1')).toBe(1);
    expect(parseDenominationValue('$2.50')).toBe(2.5);  // not "$2"
    expect(parseDenominationValue('$3')).toBe(3);
    expect(parseDenominationValue('$5')).toBe(5);
    expect(parseDenominationValue('$10')).toBe(10);     // not "$1"
    expect(parseDenominationValue('$20')).toBe(20);     // not "$2"
    expect(parseDenominationValue('$25')).toBe(25);     // not "$2"
    expect(parseDenominationValue('$50')).toBe(50);     // not "$5"
  });

  it('reads the cent denominations at their real value', () => {
    expect(parseDenominationValue('1¢')).toBe(0.01);
    expect(parseDenominationValue('5¢')).toBe(0.05);
    expect(parseDenominationValue('10¢')).toBe(0.1);
    expect(parseDenominationValue('20¢')).toBe(0.2);
    expect(parseDenominationValue('25¢')).toBe(0.25);   // not "5¢"
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
