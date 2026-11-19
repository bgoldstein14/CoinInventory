 /*
  * The rule under test: an unknown figure renders as "—", never as "$0.00".
  */

import { describe, expect, it } from 'vitest';
import {
  coverageNote,
  formatAxisTick,
  formatChartDay,
  formatChartMonth,
  formatCount,
  formatGrams,
  formatStatDelta,
  formatStatMoney,
  formatTroyOunces,
  groupThousands
} from './stats-format';

describe('groupThousands', () => {
   /*
    * groupThousands must group only the integer part; the naive regex
    * `/(\d)(?=(\d{3})+(\.|$))/g` would also group decimals.
    */

  it('groups the integer part', () => {
    expect(groupThousands('1234567')).toBe('1,234,567');
    expect(groupThousands('1234.56')).toBe('1,234.56');
  });

  it('NEVER groups the fractional part, however many digits it has', () => {
    // The naive regex would render "0.9,674".
    expect(groupThousands('0.9674')).toBe('0.9674');
    expect(groupThousands('1.123456789')).toBe('1.123456789');
    expect(groupThousands('12345.678901')).toBe('12,345.678901');
  });

  it('leaves a currency prefix alone', () => {
    expect(groupThousands('$1234.50')).toBe('$1,234.50');
    expect(groupThousands('$999.99')).toBe('$999.99');
  });

  it('leaves text with no digits alone', () => {
    expect(groupThousands('—')).toBe('—');
  });
});

describe('formatStatMoney', () => {
  it('renders a known figure with two decimals and grouped thousands', () => {
    expect(formatStatMoney(1234567.891)).toBe('$1,234,567.89');
    expect(formatStatMoney(1234.5)).toBe('$1,234.50');
    expect(formatStatMoney(12.3)).toBe('$12.30');
  });

  it('does NOT group a figure under a thousand', () => {
    expect(formatStatMoney(999.99)).toBe('$999.99');
  });

  // null means "unknown", not "nothing".
  it('renders an unknown figure as an em-dash, never as $0.00', () => {
    expect(formatStatMoney(null)).toBe('—');
  });

  // A real zero still prints as money.
  it('renders a real zero as $0.00', () => {
    expect(formatStatMoney(0)).toBe('$0.00');
  });

  it('keeps the minus sign outside the dollar sign for a negative total', () => {
    expect(formatStatMoney(-1234.5)).toBe('-$1,234.50');
  });

  it('survives a very large collection without switching to exponent notation', () => {
    expect(formatStatMoney(98765432109.87)).toBe('$98,765,432,109.87');
  });

  it('rounds a sub-cent figure rather than printing a long tail', () => {
    expect(formatStatMoney(0.004)).toBe('$0.00');
    expect(formatStatMoney(0.005)).toBe('$0.01');
  });
});

describe('formatStatDelta', () => {
  it('signs a gain explicitly so the colour is never the only cue', () => {
    expect(formatStatDelta(1234.5)).toBe('+$1,234.50');
  });

  it('signs a loss explicitly', () => {
    expect(formatStatDelta(-1234.5)).toBe('-$1,234.50');
  });

  it('prints an exact break-even without a sign', () => {
    expect(formatStatDelta(0)).toBe('$0.00');
  });

  it('renders an unknown delta as an em-dash', () => {
    expect(formatStatDelta(null)).toBe('—');
  });
});

describe('formatGrams / formatTroyOunces', () => {
  it('prints grams to two decimals with a unit', () => {
    expect(formatGrams(30.09)).toBe('30.09 g');
  });

  it('groups thousands of grams — a silver hoard runs to five digits', () => {
    expect(formatGrams(12345.6)).toBe('12,345.60 g');
  });

  it('converts to troy ounces using the same constant the melt maths uses', () => {
    // 30.09 g of pure gold is the 0.9675 ozt AGW quoted for a $20 Saint-Gaudens.
    expect(formatTroyOunces(30.09)).toBe('0.967 ozt');
  });

  it('renders an unknown weight as an em-dash, never as "0.00 g"', () => {
    expect(formatGrams(null)).toBe('—');
    expect(formatTroyOunces(null)).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatAxisTick', () => {
  // Full under 10,000, compact above.
  it('prints values under ten thousand in full', () => {
    expect(formatAxisTick(0)).toBe('0');
    expect(formatAxisTick(1000)).toBe('1,000');
    expect(formatAxisTick(9999)).toBe('9,999');
  });

  it('compacts ten thousand and above', () => {
    expect(formatAxisTick(10000)).toBe('10K');
    expect(formatAxisTick(12500)).toBe('12.5K');
    expect(formatAxisTick(1000000)).toBe('1M');
    expect(formatAxisTick(2400000)).toBe('2.4M');
  });

  it('drops a trailing .0 so the axis reads 10K and not 10.0K', () => {
    expect(formatAxisTick(20000)).toBe('20K');
  });
});

describe('formatChartMonth / formatChartDay', () => {
  // Series timestamps are UTC midnight; local getters would show the previous
  // day west of Greenwich.
  const march15 = Date.UTC(2024, 2, 15);

  it('names the month and year in UTC', () => {
    expect(formatChartMonth(march15)).toBe('Mar 2024');
  });

  it('names the day in UTC', () => {
    expect(formatChartDay(march15)).toBe('15 Mar 2024');
  });

  it('does not slip a day at the very start of a UTC month', () => {
    expect(formatChartDay(Date.UTC(2024, 0, 1))).toBe('1 Jan 2024');
    expect(formatChartMonth(Date.UTC(2024, 0, 1))).toBe('Jan 2024');
  });

  it('handles December without rolling the year', () => {
    expect(formatChartDay(Date.UTC(1999, 11, 31))).toBe('31 Dec 1999');
  });
});

describe('coverageNote', () => {
  // Complete data: no note at all.
  it('says nothing at all when every coin is accounted for', () => {
    expect(coverageNote(125, 125)).toBeNull();
  });

  it('names how many coins are missing and out of how many', () => {
    expect(coverageNote(94, 125)).toBe('Not recorded for 31 of 125 coins');
  });

  it('uses the singular for a single missing coin', () => {
    expect(coverageNote(124, 125)).toBe('Not recorded for 1 of 125 coins');
  });

  it('says so plainly when nothing at all is known', () => {
    expect(coverageNote(0, 125)).toBe('Not recorded for any of the 125 coins');
  });

  it('says nothing for an empty collection — there is nothing to be missing', () => {
    expect(coverageNote(0, 0)).toBeNull();
  });

  it('accepts a caller-supplied noun so a weight note does not say "coins"', () => {
    expect(coverageNote(2, 5, 'gold coins')).toBe('Not recorded for 3 of 5 gold coins');
  });
});
