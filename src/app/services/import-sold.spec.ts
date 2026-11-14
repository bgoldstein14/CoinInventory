/*
 * The import filter's definition of "sold", tested on the two cases that
 * pass review and fail on a real sheet: a sold price of ZERO, and a sold
 * field holding nothing but SPACES.
 */
import { describe, expect, it } from 'vitest';
import { SOLD_RULE_SENTENCE, isSoldRecord } from './import-sold';

describe('isSoldRecord', () => {
  it('is false for a record with none of the three fields', () => {
    expect(isSoldRecord({})).toBe(false);
    expect(isSoldRecord({ soldDate: '', soldPrice: undefined, soldTo: '' })).toBe(false);
    expect(isSoldRecord({ soldDate: null, soldPrice: null, soldTo: null })).toBe(false);
  });

  it('is true on a sold date alone', () => {
    expect(isSoldRecord({ soldDate: '2013-11-16' })).toBe(true);
  });

  it('is true on a sold price alone', () => {
    expect(isSoldRecord({ soldPrice: 474.55 })).toBe(true);
  });

  it('is true on a buyer alone', () => {
    expect(isSoldRecord({ soldTo: 'Tollgate Rarities' })).toBe(true);
  });

  /* ---- THE ZERO CASE ---- */

  it('COUNTS A SOLD PRICE OF 0 AS SOLD', () => {
    // A coin given away, written off, or traded at no cash value. `if
    // (soldPrice)` reads this as never sold, hands the row back in an
    // import the user asked to be free of sold coins, and nothing says so.
    expect(isSoldRecord({ soldPrice: 0 })).toBe(true);
  });

  it('counts 0 even when the other two fields are blank', () => {
    expect(isSoldRecord({ soldPrice: 0, soldDate: '', soldTo: '   ' })).toBe(true);
  });

  it('does not count a price that is not a number', () => {
    // An unparseable cell is not a price. NaN is the only "number" that is
    // not present.
    expect(isSoldRecord({ soldPrice: Number.NaN })).toBe(false);
  });

  /* ---- THE WHITESPACE CASE ---- */

  it('DOES NOT COUNT A WHITESPACE-ONLY BUYER AS SOLD', () => {
    // One stray space bar in a spreadsheet cell would otherwise mark the
    // coin sold and hide it from the default import.
    expect(isSoldRecord({ soldTo: '   ' })).toBe(false);
  });

  it('does not count a whitespace-only sold date as sold', () => {
    expect(isSoldRecord({ soldDate: ' \t ' })).toBe(false);
  });

  it('still counts a buyer that merely has spaces around it', () => {
    expect(isSoldRecord({ soldTo: '  Tollgate Rarities  ' })).toBe(true);
  });

  it('is true when all three are present', () => {
    expect(
      isSoldRecord({ soldDate: '2013-11-16', soldPrice: 0, soldTo: 'Kingsmere' })
    ).toBe(true);
  });
});

describe('the sentence shown to the user', () => {
  it('names all three fields, because the rule reads all three', () => {
    expect(SOLD_RULE_SENTENCE).toContain('sold date');
    expect(SOLD_RULE_SENTENCE).toContain('sold price');
    expect(SOLD_RULE_SENTENCE).toContain('buyer');
  });
});
