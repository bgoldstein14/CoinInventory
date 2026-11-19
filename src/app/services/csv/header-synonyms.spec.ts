/**
 * Tests for the header synonym layer. Assertions expecting `undefined` matter
 * as much as matches: a wrong confident mapping is worse than a blank dropdown.
 */
import { describe, expect, it } from 'vitest';
import { CSV_MAPPABLE_FIELDS } from '../csv.service';
import {
  HEADER_SYNONYMS,
  matchHeaderToField,
  mapHeadersToFields,
  normalizeHeader
} from './header-synonyms';
import { textColumnSamples } from './date-column-shape';

describe('normalizeHeader', () => {
  it('lower-cases and collapses punctuation and whitespace to single spaces', () => {
    expect(normalizeHeader('  Purchase   Price  ')).toBe('purchase price');
    expect(normalizeHeader('Cert #')).toBe('cert');
    expect(normalizeHeader('Est. Value')).toBe('est value');
    expect(normalizeHeader('PURCHASE_PRICE')).toBe('purchase price');
    expect(normalizeHeader('Purchase $')).toBe('purchase');
  });

  it('keeps a parenthesised unit as part of the header', () => {
    // `Weight (g)` and `Weight (oz)` differ only in the parenthetical, which must
    // survive so the ounces column never matches the grams field.
    expect(normalizeHeader('Weight (g)')).toBe('weight g');
    expect(normalizeHeader('Weight (oz)')).toBe('weight oz');
  });

  it('returns an empty string for a blank or punctuation-only header', () => {
    expect(normalizeHeader('')).toBe('');
    expect(normalizeHeader('   ')).toBe('');
    expect(normalizeHeader('---')).toBe('');
    expect(normalizeHeader(null as unknown as string)).toBe('');
  });
});

describe('matchHeaderToField', () => {
  it('still matches a field key or label exactly, as it always did', () => {
    expect(matchHeaderToField('Coin Type')).toBe('coinType');
    expect(matchHeaderToField('coinType')).toBe('coinType');
    expect(matchHeaderToField('purchase price')).toBe('purchasePrice');
    expect(matchHeaderToField('Weight (g)')).toBe('weight');
  });

  it('matches the money synonyms a real spreadsheet uses', () => {
    for (const header of ['Cost', 'Paid', 'Price Paid', 'Purchase $', 'Cost Basis']) {
      expect(matchHeaderToField(header)).toBe('purchasePrice');
    }
  });

  it('matches the valuation synonyms', () => {
    for (const header of ['Value', 'Est. Value', 'Estimated Value', 'FMV', 'Market Value']) {
      expect(matchHeaderToField(header)).toBe('currentValue');
    }
  });

  it('matches the numismatic shorthand collectors actually type', () => {
    expect(matchHeaderToField('Yr')).toBe('year');
    expect(matchHeaderToField('Date')).toBe('year');
    expect(matchHeaderToField('Mint')).toBe('mintMark');
    expect(matchHeaderToField('MM')).toBe('mintMark');
    expect(matchHeaderToField('Denom')).toBe('denomination');
    expect(matchHeaderToField('Type')).toBe('coinType');
    expect(matchHeaderToField('Series')).toBe('coinType');
    expect(matchHeaderToField('Cert #')).toBe('certNumber');
    expect(matchHeaderToField('Slab #')).toBe('certNumber');
    expect(matchHeaderToField('Grader')).toBe('certCompany');
    expect(matchHeaderToField('Service')).toBe('certCompany');
    expect(matchHeaderToField('TPG')).toBe('certCompany');
    expect(matchHeaderToField('Cond')).toBe('grade');
  });

  it('does not let a purchase-date column be stolen by the Date -> Year rule', () => {
    // A spelled-out `Date Purchased` must not collide with `Date` (= year).
    expect(matchHeaderToField('Date Purchased')).toBe('purchaseDate');
    expect(matchHeaderToField('Acquired')).toBe('purchaseDate');
    expect(matchHeaderToField('Date Acquired')).toBe('purchaseDate');
    expect(matchHeaderToField('Date Sold')).toBe('soldDate');
  });

  it('returns nothing for a header it cannot place, rather than guessing', () => {
    // Each could be purchase price, current value or sale price.
    for (const header of ['Price', 'Amount', 'Total', 'Qty', 'AGW', 'Box', 'Ref']) {
      expect(matchHeaderToField(header)).toBeUndefined();
    }
  });

  it('still refuses Weight (oz), which is the 31x error guard', () => {
    // `Weight (oz)` holds troy ounces and the column is grams.
    expect(matchHeaderToField('Weight (oz)')).toBeUndefined();
    expect(matchHeaderToField('Weight oz')).toBeUndefined();
    expect(matchHeaderToField('ozt')).toBeUndefined();
  });

  it('places Dealer on Purchased From, now that there is a field for it', () => {
    // `Dealer` maps to purchasedFrom (the buy-side counterparty).
    expect(matchHeaderToField('Dealer')).toBe('purchasedFrom');
    expect(matchHeaderToField('Bought From')).toBe('purchasedFrom');
    expect(matchHeaderToField('Seller')).toBe('purchasedFrom');
    expect(matchHeaderToField('Vendor')).toBe('purchasedFrom');
    expect(matchHeaderToField('Purchased From')).toBe('purchasedFrom');
  });

  it('keeps the buy side and the sale side apart', () => {
    // Must not be swapped with purchasedFrom.
    expect(matchHeaderToField('Buyer')).toBe('soldTo');
    expect(matchHeaderToField('Sold To')).toBe('soldTo');
    expect(matchHeaderToField('Seller')).not.toBe('soldTo');
    expect(matchHeaderToField('Dealer')).not.toBe('soldTo');
  });

  it('refuses the counterparty headings that could mean either side', () => {
    // `Sold By` looks like the sale side but means the purchase side;
    // `Auction House` and `Consignor` could be either.
    for (const header of ['Sold By', 'Auction House', 'Consignor', 'From']) {
      expect(matchHeaderToField(header)).toBeUndefined();
    }
  });

  it('places a transaction note without ever taking the coin note', () => {
    expect(matchHeaderToField('Transaction Notes')).toBe('transactionNotes');
    expect(matchHeaderToField('Deal Notes')).toBe('transactionNotes');
    expect(matchHeaderToField('Purchase Notes')).toBe('transactionNotes');

    // Bare spellings belong to the coin's own notes, not transaction notes.
    expect(matchHeaderToField('Notes')).toBe('notes');
    expect(matchHeaderToField('Memo')).toBe('notes');
    expect(matchHeaderToField('Comments')).toBe('notes');
    expect(matchHeaderToField('Remarks')).toBe('notes');
  });
});

describe('the synonym table itself', () => {
  it('only ever names fields that actually exist', () => {
    const known = new Set(CSV_MAPPABLE_FIELDS.filter(f => f.key).map(f => f.key));
    for (const key of Object.keys(HEADER_SYNONYMS)) {
      expect(known.has(key)).toBe(true);
    }
  });

  it('contains no synonym claimed by two different fields', () => {
    // A duplicate would make the mapping depend on object key order.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      for (const synonym of synonyms) {
        const normalized = normalizeHeader(synonym);
        const owner = seen.get(normalized);
        if (owner && owner !== field) {
          duplicates.push(`"${synonym}" claimed by ${owner} and ${field}`);
        }
        seen.set(normalized, field);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('stores every synonym already normalised, so lookups cannot miss', () => {
    for (const synonyms of Object.values(HEADER_SYNONYMS)) {
      for (const synonym of synonyms) {
        expect(synonym).toBe(normalizeHeader(synonym));
      }
    }
  });

  it('never shadows another field exact key or label', () => {
    const exact = new Set<string>();
    for (const field of CSV_MAPPABLE_FIELDS) {
      if (!field.key) continue;
      exact.add(normalizeHeader(field.key));
      exact.add(normalizeHeader(field.label));
    }
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      for (const synonym of synonyms) {
        if (!exact.has(synonym)) continue;
        // Allowed only when the synonym belongs to the same field it spells.
        const owner = CSV_MAPPABLE_FIELDS.find(
          f => f.key && (normalizeHeader(f.key) === synonym || normalizeHeader(f.label) === synonym)
        );
        expect(owner?.key).toBe(field);
      }
    }
  });
});

describe('mapHeadersToFields', () => {
  it('maps a whole real-world header row in one go', () => {
    const headers = ['Yr', 'Denom', 'Type', 'MM', 'Cond', 'TPG', 'Cert #', 'Cost', 'FMV'];
    expect(mapHeadersToFields(headers)).toEqual({
      'Yr': 'year',
      'Denom': 'denomination',
      'Type': 'coinType',
      'MM': 'mintMark',
      'Cond': 'grade',
      'TPG': 'certCompany',
      'Cert #': 'certNumber',
      'Cost': 'purchasePrice',
      'FMV': 'currentValue'
    });
  });

  it('omits a header it cannot place, leaving the dropdown blank', () => {
    // Absent rather than '': the template reads `csvFieldMapping()[header] ?? ''`.
    const mapping = mapHeadersToFields(['Coin Type', 'AGW', 'Weight (oz)']);
    expect(mapping['Coin Type']).toBe('coinType');
    expect(mapping['AGW']).toBeUndefined();
    expect(mapping['Weight (oz)']).toBeUndefined();
    expect(Object.keys(mapping)).toEqual(['Coin Type']);
  });

  it('lets an exact match win when a synonym claims the same field', () => {
    // `Year` is exact, `Date` only a synonym: the exact one wins, `Date` is left blank.
    const mapping = mapHeadersToFields(['Year', 'Date', 'Coin Type']);
    expect(mapping['Year']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('leaves BOTH blank when two equally loose headers claim one field', () => {
    // Two synonyms of purchasePrice: neither is chosen.
    const mapping = mapHeadersToFields(['Cost', 'Paid', 'Coin Type']);
    expect(mapping['Cost']).toBeUndefined();
    expect(mapping['Paid']).toBeUndefined();
    expect(mapping['Coin Type']).toBe('coinType');
  });

  it('ignores blank header cells instead of mapping them', () => {
    const mapping = mapHeadersToFields(['Coin Type', '', '   ']);
    expect(mapping).toEqual({ 'Coin Type': 'coinType' });
  });

  it('maps a header row that repeats the same text only once', () => {
    // Two columns headed `Notes` collapse to one entry (keyed by header text).
    const mapping = mapHeadersToFields(['Notes', 'Notes']);
    expect(mapping['Notes']).toBe('notes');
  });
});

/**
 * A `Date` heading is decided by the column's values. Coin years map to `year`;
 * calendar dates are left blank rather than guessed as `purchaseDate` (it could
 * equally be a sale or catalogue date). Headings that name the date still map.
 */
describe('mapHeadersToFields with column values — the ambiguous `Date` heading', () => {
  /** Evidence for one column, from plain text cells. */
  function column(header: string, values: string[]) {
    return textColumnSamples([header], values.map(value => [value]));
  }

  it('maps a Date column of bare coin years onto year', () => {
    const mapping = mapHeadersToFields(
      ['Date'],
      column('Date', ['1881', '1909-S', '1873'])
    );
    expect(mapping['Date']).toBe('year');
  });

  it('leaves a Date column of MM/DD/YYYY text unmapped', () => {
    const mapping = mapHeadersToFields(
      ['Date'],
      column('Date', ['3/15/2024', '1/2/2023', '12/31/2022'])
    );
    expect(mapping['Date']).toBeUndefined();
  });

  it('leaves a Date column of YYYY-MM-DD text unmapped', () => {
    // Starts with four digits but is an ISO date.
    const mapping = mapHeadersToFields(
      ['Date'],
      column('Date', ['2024-03-15', '2023-01-02', '2022-12-31'])
    );
    expect(mapping['Date']).toBeUndefined();
  });

  it('leaves a Date column unmapped when the cells are typed dates', () => {
    // `.xlsx`: a cell typed as a date is a date even if its text is `1881`.
    // The only assertion the pattern alone can't satisfy.
    const mapping = mapHeadersToFields(['Date'], {
      'Date': [
        { text: '1881', typedDate: true },
        { text: '1922', typedDate: true }
      ]
    });
    expect(mapping['Date']).toBeUndefined();
  });

  it('keeps year ranges, ancient dates and BC dates on year', () => {
    // Spans and BC dates are valid coin years.
    expect(mapHeadersToFields(['Date'], column('Date', ['1916-1945', '1878-1921']))['Date'])
      .toBe('year');
    expect(mapHeadersToFields(['Date'], column('Date', ['-480', '44 BC', 'AD 117']))['Date'])
      .toBe('year');
  });

  it('leaves a Date column that mixes years and full dates unmapped', () => {
    const mapping = mapHeadersToFields(
      ['Date'],
      column('Date', ['1881', '3/15/2024', '1909', '2024-01-02'])
    );
    expect(mapping['Date']).toBeUndefined();
  });

  it('judges a mostly-blank Date column on the few values it has', () => {
    const years = mapHeadersToFields(
      ['Date'],
      column('Date', ['', '', '', '1881', '', '', '1909-S', ''])
    );
    expect(years['Date']).toBe('year');

    const dates = mapHeadersToFields(
      ['Date'],
      column('Date', ['', '', '', '3/15/2024', '', ''])
    );
    expect(dates['Date']).toBeUndefined();
  });

  it('falls back to the heading when the column is entirely empty', () => {
    // No values: fall back to the heading's numismatic reading.
    const mapping = mapHeadersToFields(['Date'], column('Date', ['', '   ', '']));
    expect(mapping['Date']).toBe('year');
  });

  it('behaves exactly as before when no values are supplied at all', () => {
    expect(mapHeadersToFields(['Date'])['Date']).toBe('year');
    expect(matchHeaderToField('Date')).toBe('year');
  });

  it('still lets an exact Year heading beat a Date column of coin years', () => {
    // Rule 2: the column that says Year wins.
    const mapping = mapHeadersToFields(
      ['Year', 'Date', 'Coin Type'],
      textColumnSamples(
        ['Year', 'Date', 'Coin Type'],
        [['1881', '1881', 'Morgan Dollar'], ['1922', '1922', 'Peace Dollar']]
      )
    );
    expect(mapping['Year']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('still leaves both blank when Yr and a year-like Date tie', () => {
    // Rule 3: `Yr` and `Date` both look like years, so neither is picked.
    const mapping = mapHeadersToFields(
      ['Yr', 'Date'],
      textColumnSamples(['Yr', 'Date'], [['1881', '1881'], ['1922', '1922']])
    );
    expect(mapping['Yr']).toBeUndefined();
    expect(mapping['Date']).toBeUndefined();
  });

  it('lets Yr win when the Date column turns out to hold full dates', () => {
    // With calendar-date values, `Date` withdraws and `Yr` wins.
    const mapping = mapHeadersToFields(
      ['Yr', 'Date'],
      textColumnSamples(['Yr', 'Date'], [['1881', '3/15/2024'], ['1922', '1/2/2023']])
    );
    expect(mapping['Yr']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('still maps a heading that says WHICH date it is, whatever the values', () => {
    // Headings that name the date are not value-checked.
    const purchased = mapHeadersToFields(
      ['Date Purchased'],
      column('Date Purchased', ['3/15/2024', '1/2/2023'])
    );
    expect(purchased['Date Purchased']).toBe('purchaseDate');

    const minted = mapHeadersToFields(
      ['Date Minted'],
      column('Date Minted', ['1881', '1909-S'])
    );
    expect(minted['Date Minted']).toBe('year');

    const sold = mapHeadersToFields(['Sale Date'], column('Sale Date', ['3/15/2024']));
    expect(sold['Sale Date']).toBe('soldDate');
  });

  it('does not let values rescue a heading that is refused outright', () => {
    // Neither column can be settled by values; also proves a refused column
    // doesn't affect its neighbours.
    const headers = ['Weight (oz)', 'Auction House', 'Dealer'];
    const mapping = mapHeadersToFields(
      headers,
      textColumnSamples(headers, [['0.7734', 'Stack’s', 'Heritage']])
    );
    expect(mapping['Weight (oz)']).toBeUndefined();
    expect(mapping['Auction House']).toBeUndefined();
    expect(mapping['Dealer']).toBe('purchasedFrom');
  });

  it('reads the values of every other column without changing their mapping', () => {
    // Evidence for the whole sheet must not disturb other mappings.
    const headers = ['Yr', 'Denom', 'Type', 'MM', 'Cond', 'TPG', 'Cert #', 'Cost', 'FMV'];
    const rows = [['1881', 'Dollar', 'Morgan', 'CC', 'MS63', 'PCGS', '12345', '1250', '1400']];
    expect(mapHeadersToFields(headers, textColumnSamples(headers, rows)))
      .toEqual(mapHeadersToFields(headers));
  });
});
