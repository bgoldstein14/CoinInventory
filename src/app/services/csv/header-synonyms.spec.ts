/**
 * Tests for the header synonym layer.
 *
 * WHAT THEY PIN DOWN
 *
 * Comparing a header to each field's key or label with `===` after
 * lower-casing is exactly right for the app's own exported CSV -- every
 * column matches, by construction -- and close to useless for a spreadsheet
 * a collector built in 2009. `Cost`, `Paid`, `Yr`, `MM`, `TPG`, `Cert #` all
 * arrive unmapped, so a 30-column workbook means 30 dropdowns before the
 * first coin can be imported.
 *
 * THE OPPOSITE FAILURE, WHICH IS WORSE
 *
 * A wrong-but-confident mapping beats a blank one only until somebody
 * notices. A user re-checks a dropdown that says "(skip)". They do not
 * re-check one that already says "Purchase Price", so a `Value` column
 * silently mapped onto `purchasePrice` corrupts every row and is discovered
 * months later, if ever. Every assertion below that expects `undefined` is
 * guarding that side of the trade, and is as load-bearing as the ones that
 * expect a match.
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
    // Load-bearing. `Weight (g)` and `Weight (oz)` differ ONLY in the
    // parenthetical, and the whole point of the grams migration is that the
    // second one must not match. Stripping parentheses during normalisation
    // would collapse them into the same string and silently reintroduce a 31x
    // weight error -- see export-import-round-trip.spec.ts.
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
    // `Date` meaning the year struck is numismatic convention, but a sheet
    // that spells out `Date Purchased` means something else entirely and the
    // two must not collide.
    expect(matchHeaderToField('Date Purchased')).toBe('purchaseDate');
    expect(matchHeaderToField('Acquired')).toBe('purchaseDate');
    expect(matchHeaderToField('Date Acquired')).toBe('purchaseDate');
    expect(matchHeaderToField('Date Sold')).toBe('soldDate');
  });

  it('returns nothing for a header it cannot place, rather than guessing', () => {
    // `Price` and `Amount` are the headline refusals: each one could be the
    // purchase price, the current value or the sale price, and picking one
    // produces a filled-in dropdown nobody will re-read.
    for (const header of ['Price', 'Amount', 'Total', 'Qty', 'AGW', 'Box', 'Ref']) {
      expect(matchHeaderToField(header)).toBeUndefined();
    }
  });

  it('still refuses Weight (oz), which is the 31x error guard', () => {
    // If this fails, read the block comment in csv.service.ts before touching
    // anything: `Weight (oz)` holds troy ounces and the column is grams.
    expect(matchHeaderToField('Weight (oz)')).toBeUndefined();
    expect(matchHeaderToField('Weight oz')).toBeUndefined();
    expect(matchHeaderToField('ozt')).toBeUndefined();
  });

  it('places Dealer on Purchased From, now that there is a field for it', () => {
    /* THIS ASSERTION USED TO BE `toBeUndefined()`, AND THE CHANGE IS NOT A
     * RELAXATION. `Dealer` was refused because the COIN-LEVEL dealer field
     * had been removed and there was nowhere for the column to land -- the
     * refusal was about the absence of a field, never about the word. The
     * transactions rework put the buy side's counterparty back on the coin
     * as `purchasedFrom`, so the heading now has a correct destination and
     * refusing it would throw away the one column a collector's spreadsheet
     * reliably carries.
     *
     * `Weight (oz)` is the case this must NOT be confused with: that field
     * exists and always did, and the refusal there is about the UNIT. It is
     * asserted directly above and stays. */
    expect(matchHeaderToField('Dealer')).toBe('purchasedFrom');
    expect(matchHeaderToField('Bought From')).toBe('purchasedFrom');
    expect(matchHeaderToField('Seller')).toBe('purchasedFrom');
    expect(matchHeaderToField('Vendor')).toBe('purchasedFrom');
    expect(matchHeaderToField('Purchased From')).toBe('purchasedFrom');
  });

  it('keeps the buy side and the sale side apart', () => {
    // The one pair in the table that could be got backwards. A swap here
    // writes the dealer into "Sold To" on every owned coin, which reads as
    // a sale that never happened.
    expect(matchHeaderToField('Buyer')).toBe('soldTo');
    expect(matchHeaderToField('Sold To')).toBe('soldTo');
    expect(matchHeaderToField('Seller')).not.toBe('soldTo');
    expect(matchHeaderToField('Dealer')).not.toBe('soldTo');
  });

  it('refuses the counterparty headings that could mean either side', () => {
    // `Sold By` is the near-miss: `sold` and `sold for` belong to soldPrice,
    // so the heading reads as the sale side while meaning the purchase side.
    // `Auction House` and `Consignor` genuinely are either side.
    for (const header of ['Sold By', 'Auction House', 'Consignor', 'From']) {
      expect(matchHeaderToField(header)).toBeUndefined();
    }
  });

  it('places a transaction note without ever taking the coin note', () => {
    expect(matchHeaderToField('Transaction Notes')).toBe('transactionNotes');
    expect(matchHeaderToField('Deal Notes')).toBe('transactionNotes');
    expect(matchHeaderToField('Purchase Notes')).toBe('transactionNotes');

    // The coin's own note keeps every bare spelling. Coins.Notes and
    // Coins.TransactionNotes are two columns; see server/db/coin-fields.ts.
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
    // A duplicate here would make the mapping depend on object key order,
    // which is the sort of thing that works until somebody alphabetises the
    // table.
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
    // Absent rather than mapped-to-empty-string: csv-import-modal.html reads
    // `csvFieldMapping()[header] ?? ''`, and export-import-round-trip.spec.ts
    // asserts `toBeUndefined()` for the refused Weight (oz) column.
    const mapping = mapHeadersToFields(['Coin Type', 'AGW', 'Weight (oz)']);
    expect(mapping['Coin Type']).toBe('coinType');
    expect(mapping['AGW']).toBeUndefined();
    expect(mapping['Weight (oz)']).toBeUndefined();
    expect(Object.keys(mapping)).toEqual(['Coin Type']);
  });

  it('lets an exact match win when a synonym claims the same field', () => {
    // `Year` is an exact key match; `Date` is only a synonym. Mapping both
    // onto `year` would mean the second one silently overwrites the first for
    // every row. The precise one wins and the loose one is handed back to the
    // user.
    const mapping = mapHeadersToFields(['Year', 'Date', 'Coin Type']);
    expect(mapping['Year']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('leaves BOTH blank when two equally loose headers claim one field', () => {
    // `Cost` and `Paid` are both synonyms of purchasePrice. There is no
    // principled way to pick, and picking wrong puts the other column's
    // numbers into the field. So neither is chosen.
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
    // Two columns literally headed `Notes` collapse to one dictionary entry,
    // because the mapping is keyed by header text. That is pre-existing
    // behaviour; this records it rather than changing it.
    const mapping = mapHeadersToFields(['Notes', 'Notes']);
    expect(mapping['Notes']).toBe('notes');
  });
});

/**
 * A `Date` heading is decided by the column's VALUES, not by the heading.
 *
 * THE BUG THIS BLOCK EXISTS TO PREVENT
 *
 * `date` is a synonym of `year`, because in numismatic usage a coin's date
 * is the date it was STRUCK -- that is the number printed on the coin. A
 * sheet headed `Date` whose cells read `1881`, `1909-S`, `1873` is exactly
 * that, and mapping it onto Year saves the user a dropdown.
 *
 * The same heading over `3/15/2024` is not that at all. It is a calendar
 * date, and the owner of the sheet knows what it means -- bought, sold,
 * catalogued, appraised -- while we do not. Mapped onto Year it writes
 * "2024" onto a Morgan dollar, in a dropdown that already says "Year" so
 * nobody re-reads it. That is the exact confident-wrong-mapping failure the
 * rest of this file is built to refuse, arriving through the one synonym
 * that is ambiguous about what kind of date it means.
 *
 * WHY A FULL-DATE COLUMN IS LEFT BLANK RATHER THAN RE-AIMED
 *
 * The obvious second guess is `purchaseDate`. It is still a guess: the
 * column could as easily be the sale date or the date it was catalogued,
 * and there is nothing in the file to tell them apart. Rule 1 at the top of
 * header-synonyms.ts -- NO SYNONYM FOR AN AMBIGUOUS WORD -- is the same
 * decision for the same reason. Blank puts the question in front of the
 * user, which is what the mapping grid is for. A heading that SAYS which
 * date it is (`Date Purchased`, `Date Sold`) still maps, because then it is
 * not a guess.
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
    // Starts with four digits. Anything that tests /^\d{4}/ and stops reading
    // turns every ISO date in the file into a coin year.
    const mapping = mapHeadersToFields(
      ['Date'],
      column('Date', ['2024-03-15', '2023-01-02', '2022-12-31'])
    );
    expect(mapping['Date']).toBeUndefined();
  });

  it('leaves a Date column unmapped when the cells are typed dates', () => {
    // The `.xlsx` case: `read-excel-file` hands back real `Date` objects for
    // cells with a date number format. The TYPE settles it on its own.
    // Written with YEAR-LOOKING text on purpose. A cell whose text is
    // `1881` and whose type is Date is a date -- Excel said so -- and this
    // is the only assertion in the file that the pattern matcher cannot
    // also satisfy on its own, so it is the one that goes red if the type
    // stops being consulted.
    const mapping = mapHeadersToFields(['Date'], {
      'Date': [
        { text: '1881', typedDate: true },
        { text: '1922', typedDate: true }
      ]
    });
    expect(mapping['Date']).toBeUndefined();
  });

  it('keeps year ranges, ancient dates and BC dates on year', () => {
    // CoinRecord.year is a string so that a type can carry a span, and the
    // collection has BC material in it. Rejecting either as "not a year"
    // would break the case the string field exists for.
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
    // No values means no evidence, and a column with nothing in it cannot
    // put a wrong value anywhere. Reverting to the numismatic reading of the
    // heading is the harmless answer, and it is the one answer that keeps a
    // header-only caller (matchHeaderToField, or any caller with no rows yet)
    // behaving the way it always has.
    const mapping = mapHeadersToFields(['Date'], column('Date', ['', '   ', '']));
    expect(mapping['Date']).toBe('year');
  });

  it('behaves exactly as before when no values are supplied at all', () => {
    expect(mapHeadersToFields(['Date'])['Date']).toBe('year');
    expect(matchHeaderToField('Date')).toBe('year');
  });

  it('still lets an exact Year heading beat a Date column of coin years', () => {
    // Guarantee 2 from the file header, unchanged. Even when `Date` looks
    // every bit like a coin year, the column that SAYS year wins and the
    // loose one goes back to the user.
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
    // Guarantee 3, unchanged. `Yr` and `Date` are both synonyms of year and
    // both look like years, so there is no principled way to pick.
    const mapping = mapHeadersToFields(
      ['Yr', 'Date'],
      textColumnSamples(['Yr', 'Date'], [['1881', '1881'], ['1922', '1922']])
    );
    expect(mapping['Yr']).toBeUndefined();
    expect(mapping['Date']).toBeUndefined();
  });

  it('lets Yr win when the Date column turns out to hold full dates', () => {
    // The tie above dissolves once the values are read: `Date` never claims
    // year at all, so `Yr` is the only claimant and the user gets a correct
    // mapping instead of two blank dropdowns.
    const mapping = mapHeadersToFields(
      ['Yr', 'Date'],
      textColumnSamples(['Yr', 'Date'], [['1881', '3/15/2024'], ['1922', '1/2/2023']])
    );
    expect(mapping['Yr']).toBe('year');
    expect(mapping['Date']).toBeUndefined();
  });

  it('still maps a heading that says WHICH date it is, whatever the values', () => {
    // `Date Purchased` is not ambiguous, so its values are not consulted --
    // and neither are `Date Minted`'s, for the same reason in the other
    // direction. The values are read only where the heading leaves the
    // question open.
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
    // `Weight (oz)` is the wrong unit and `Auction House` could be either
    // counterparty; neither is a question a column of values can settle.
    // (`Dealer` stood here until the transactions rework gave it a field --
    // see the Purchased From tests above. It is kept in the sheet so this
    // spec also proves a refused column does not poison its neighbours.)
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
    // The value check applies to one synonym. Supplying evidence for the
    // whole sheet must not disturb anything else on it.
    const headers = ['Yr', 'Denom', 'Type', 'MM', 'Cond', 'TPG', 'Cert #', 'Cost', 'FMV'];
    const rows = [['1881', 'Dollar', 'Morgan', 'CC', 'MS63', 'PCGS', '12345', '1250', '1400']];
    expect(mapHeadersToFields(headers, textColumnSamples(headers, rows)))
      .toEqual(mapHeadersToFields(headers));
  });
});
