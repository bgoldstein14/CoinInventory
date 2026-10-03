/* ===========================================================================
 * quicken-real-securities.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That the QIF importer works against THIS COLLECTION, not against invented
 *   security names. Every string in the table below is VERBATIM from the `Y`
 *   (security name) lines of the owner's own `GoldCoins.QIF` export -- all 44
 *   distinct securities it contains, copied without tidying.
 *
 *   Nothing here should be "cleaned up". The missing space in
 *   "1900 $20 PCGS/CAC MS63", the "G$" prefixes, the bare "1885 $5" with no
 *   grade, the "Open 3" variety text and the lone non-US entry are all real,
 *   and most of them broke something.
 *
 *   This follows the precedent set by
 *   `services/image-matching/real-filenames.spec.ts`, which does the same
 *   thing for photo filenames: the other spec files cover the ALGORITHM, this
 *   one covers REALITY.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEFECTS THIS FILE WAS WRITTEN FOR
 * ---------------------------------------------------------------------------
 *   1. Metal / Composition / PM % / PM weight were never filled in on import.
 *      Every row below now asserts them, because getting an alloy wrong is a
 *      silent error -- it produces a plausible-looking but wrong melt value.
 *
 *   2. "1969 Peru 100 Soles - NGC MS64" would not import at all. The parser
 *      hard-coded the country to "United States" and had no idea what a Sol
 *      was, so the record carried a Year and nothing else, failed the 2-of-3
 *      completeness rule, and landed in the exceptions list.
 *
 * `expectedCoinType: ''` is never an oversight. It means the parser is
 * SUPPOSED to leave Coin Type blank, which the owner explicitly accepted:
 * "the coin type might be left blank if the code couldn't try to figure
 * anything out."
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { QuickenImportService } from './quicken-import.service';

/**
 * Runs one real security name through the FULL parse -- not a private helper
 * -- so these assertions cover the same code path the import button uses.
 */
function parseSecurity(securityName: string) {
  const service = new QuickenImportService();
  const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
  const result = service.parse(qif);
  return result;
}

/** The parsed record, asserting it was actually importable. */
function importedCoin(securityName: string) {
  const result = parseSecurity(securityName);
  expect(
    result.rejectedRecords,
    `"${securityName}" should import, not land in the exceptions list`
  ).toHaveLength(0);
  expect(result.importedRecords).toHaveLength(1);
  return result.importedRecords[0];
}

interface SecurityCase {
  /** VERBATIM from GoldCoins.QIF. Do not edit. */
  name: string;
  year: string;
  denomination: string;
  /** '' means "correctly left blank" -- see the header. */
  coinType: string;
  country: string;
  metal: string;
  pmPercent: number;
  /** Weight of the PURE gold, in grams. */
  pmWeightGrams: number;
  /**
   * Weight of the WHOLE COIN, in grams — alloy included. Always strictly
   * larger than `pmWeightGrams`, and the two must agree with `pmPercent`;
   * both of those are asserted below, on every row.
   */
  grossWeightGrams: number;
}

/* ---------------------------------------------------------------------------
 * ALL 44 SECURITIES IN GoldCoins.QIF
 *
 * Grouped by denomination so the year bands in pm-reference.ts are easy to
 * check by eye. Every one of them is gold except where noted; this is a gold
 * collection.
 * ------------------------------------------------------------------------- */
const REAL_SECURITIES: SecurityCase[] = [
  // --- Gold Dollar ($1 gold, 1849-1889) ----------------------------------
  // THE COLLISION THAT USED TO GET THESE WRONG: "$1" in these years is both
  // a 26.73 g SILVER dollar and a 1.67 g GOLD dollar. Before the fix all
  // three of these imported as "Liberty Seated" with 24.06 g of silver
  // attached. The word "Gold" and the "G$" shorthand are what settle it.
  {
    name: '1849-O $1 Gold - ANACS XF45',
    year: '1849', denomination: '$1', coinType: 'Liberty Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },
  {
    // 1855 is a Gold Dollar TRANSITION year (Type 1 / Type 2 / Type 3 all sit
    // in 1854-1856), so Coin Type is deliberately blank. Year + Denomination
    // still satisfy the 2-of-3 rule, so the coin imports anyway.
    name: '1855 G$1 - PCGS/CAC AU50',
    year: '1855', denomination: '$1', coinType: '', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },
  {
    name: '1873 Open 3 G$1 - ANACS AU58',
    year: '1873', denomination: '$1', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },

  // --- Quarter Eagle ($2.50) ---------------------------------------------
  {
    name: '1873 Open 3 G$2.50 - ANACS AU53',
    year: '1873', denomination: '$2.50', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1911 $2.50',
    year: '1911', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1911 $2.50 Gold Indian - ANACS AU58',
    year: '1911', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1913 $2.50 Gold Indian - ANACS AU55',
    year: '1913', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },

  // --- Three Dollar ($3, 1854-1889, one specification) --------------------
  {
    name: '1854 G$3 - PCGS/CAC AU50',
    year: '1854', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1855 $3 - PCGS/CAC VF35',
    year: '1855', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1856 $3 - PCGS/CAC AU50',
    year: '1856', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1857 $3 - NGC/CAC AU55',
    year: '1857', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1857-S $3 - NGC F15',
    year: '1857', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1859 $3 - NGC/CAC AU55',
    year: '1859', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1867 $3 - PCGS AU53',
    year: '1867', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1874 $3 - NGC AU58',
    year: '1874', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1878 $3 - PCGS/CAC AU58',
    year: '1878', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },

  // --- Half Eagle ($5) ----------------------------------------------------
  {
    // 1835 is a CLASSIC HEAD half eagle: the Act of 1834 cut the planchet and
    // set the fineness to 0.8992, so this is the one coin in the collection
    // that is NOT 90% fine.
    name: '1835 $5 - NGC/CAC XF45',
    year: '1835', denomination: '$5', coinType: 'Classic Head', country: 'United States',
    metal: 'Gold', pmPercent: 89.92, pmWeightGrams: 7.52,
    grossWeightGrams: 8.36
  },
  {
    name: '1885 $5',
    year: '1885', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    // "PCI" is a grading company this parser does not know, which is fine --
    // certCompany is not one of the three main details.
    name: '1893 $5 - PCI AU50',
    year: '1893', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1900 $5 - ANACS AU55',
    year: '1900', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1906-S $5',
    year: '1906', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1908 $5 - PCGS/CAC XF45',
    year: '1908', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1909 $5 - PCGS/CAC XF40',
    year: '1909', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1913-S $5 - PCGS XF40',
    year: '1913', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1914-S $5 - PCGS XF40',
    year: '1914', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1915-S $5 - PCGS XF40',
    year: '1915', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },

  // --- Eagle ($10) --------------------------------------------------------
  {
    name: '1895 $10 - ANACS MS61',
    year: '1895', denomination: '$10', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1908 WM $10 - NGC/CAC MS61',
    year: '1908', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1910D $10 - PCGS MS63',
    year: '1910', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1932 $10 - PCGS MS63',
    year: '1932', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },

  // --- Double Eagle ($20) -------------------------------------------------
  {
    // NOTE the missing hyphen before "PCGS" -- this one is written differently
    // from every other row in the file and must still parse.
    name: '1900 $20 PCGS/CAC MS63',
    year: '1900', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1904 $20 - NGC MS63',
    year: '1904', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1904 $20 - PCGS MS63',
    year: '1904', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1907 $20 Liberty - PCGS/CAC MS62',
    year: '1907', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1908 NM $20 - NGC/CAC MS64',
    year: '1908', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1908 NM $20 - PCGS/CAC MS64',
    year: '1908', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1915-S $20 - NGC MS64',
    year: '1915', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1920 $20 - PCGS MS63',
    year: '1920', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1924 $20 - PCGS/CAC MS64+',
    year: '1924', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1925 $20 - NGC/CAC MS64',
    year: '1925', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1925 $20 - PCGS MS64',
    year: '1925', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1926 $20 - PCGS MS64',
    year: '1926', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1927 $20 - PCGS MS64',
    year: '1927', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },

  // --- THE ONE NON-US COIN IN THE FILE ------------------------------------
  {
    // This is the record the owner reported: "the only coin that couldn't
    // import properly". Country, denomination and alloy all now come out of
    // the name; Coin Type is blank because the Peruvian 100 Soles has no
    // sub-type to infer, which the owner explicitly accepted.
    name: '1969 Peru 100 Soles - NGC MS64',
    year: '1969', denomination: '100 Soles', coinType: '', country: 'Peru',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 42.13,
    grossWeightGrams: 46.8069
  }
];

describe('GoldCoins.QIF — every real security name', () => {
  it('covers all 44 distinct securities in the export', () => {
    expect(REAL_SECURITIES).toHaveLength(44);
  });

  for (const testCase of REAL_SECURITIES) {
    describe(`"${testCase.name}"`, () => {
      it('parses year, denomination, coin type and country', () => {
        const coin = importedCoin(testCase.name);
        expect(coin.year).toBe(testCase.year);
        expect(coin.denomination).toBe(testCase.denomination);
        expect(coin.coinType).toBe(testCase.coinType);
        expect(coin.country).toBe(testCase.country);
      });

      it('fills in Metal, Composition, PM % and PM weight', () => {
        const coin = importedCoin(testCase.name);
        expect(coin.metalContent).toBe(testCase.metal);
        // Composition is free text, but it must be present and must name the
        // metal -- a blank Composition was exactly the reported defect.
        expect(coin.composition, 'composition should not be blank').toBeTruthy();
        expect(coin.composition?.toLowerCase()).toContain(testCase.metal.toLowerCase());
        expect(coin.pmPercent).toBeCloseTo(testCase.pmPercent, 2);
        expect(coin.pmWeightGrams).toBeCloseTo(testCase.pmWeightGrams, 2);
      });

      it('fills in the coin\'s GROSS weight, in grams', () => {
        /* THE FIFTH FIELD. Until the gross weights were moved out of prose
         * comments and into pm-reference.ts as real data, every one of these
         * 44 coins imported with an empty Weight. `weight` is in GRAMS from
         * migration 008 onward, which is the same unit as pmWeightGrams, so
         * the two can be compared directly -- and must be, because confusing
         * them is the mistake behind the melt-value bug in the README. */
        const coin = importedCoin(testCase.name);
        expect(coin.weight, 'weight should not be blank').toBeDefined();
        expect(coin.weight).toBeCloseTo(testCase.grossWeightGrams, 3);

        // The whole coin always outweighs the gold inside it. Trivially true
        // and worth asserting: it is what fails loudly if the two fields are
        // ever wired to each other's source.
        expect(coin.weight!).toBeGreaterThan(coin.pmWeightGrams!);

        // ...and the three numbers agree. Tolerance 0.01 g because
        // pmWeightGrams is published rounded to two decimals -- see the long
        // note on the same invariant in pm-reference.spec.ts.
        expect(Math.abs(coin.weight! * (coin.pmPercent! / 100) - coin.pmWeightGrams!))
          .toBeLessThanOrEqual(0.01);
      });
    });
  }
});

/* ===========================================================================
 * THE FILL CENSUS — HOW MUCH OF THE OWNER'S OWN FILE GETS FILLED IN
 * ---------------------------------------------------------------------------
 * The brief this work was done against asked for a NUMBER, not a reassurance:
 * of the 44 distinct securities in GoldCoins.QIF, how many come out of the
 * import with each of the five fields populated?
 *
 * The answer is 44 of 44 for all five, and this block is what keeps it that
 * way. It is a census rather than a spot check on purpose: a change to
 * pm-reference.ts that quietly stopped matching, say, the Classic Head half
 * eagle would drop one coin out of the count, and the per-coin tests above
 * would report it as one failure among forty-four passes. This reports it as
 * "43 of 44", which is the shape of the question the owner asked.
 *
 * It is driven off REAL_SECURITIES rather than off the .qif file on disk,
 * which is the same choice `image-matching/real-filenames.spec.ts` makes: the
 * data is verbatim, but it lives in the test so the suite needs no filesystem
 * and typechecks under tsconfig.spec.json without Node types.
 * ======================================================================== */
describe('GoldCoins.QIF — fill rate across all 44 securities', () => {
  /** The five fields, in the order the editor shows them. */
  const FIELDS = ['metalContent', 'composition', 'pmPercent', 'pmWeightGrams', 'weight'] as const;

  /** Blank means undefined, null, '' or NaN. A 0 would count as filled. */
  function isFilled(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return !Number.isNaN(value);
    return true;
  }

  /** How many of the 44 come out with `field` populated. */
  function fillCount(field: (typeof FIELDS)[number]): number {
    return REAL_SECURITIES.filter((testCase) => {
      const coin = importedCoin(testCase.name) as unknown as Record<string, unknown>;
      return isFilled(coin[field]);
    }).length;
  }

  for (const field of FIELDS) {
    it(`fills ${field} on all 44`, () => {
      const filled = fillCount(field);
      expect(filled, `${field} was filled on ${filled} of 44 securities`).toBe(44);
    });
  }

  it('fills every one of the five on every one of the 44', () => {
    // The same claim stated once, so a regression names the coins rather than
    // just a count.
    const incomplete: string[] = [];
    for (const testCase of REAL_SECURITIES) {
      const coin = importedCoin(testCase.name) as unknown as Record<string, unknown>;
      const missing = FIELDS.filter((field) => !isFilled(coin[field]));
      if (missing.length > 0) incomplete.push(`${testCase.name} -> missing ${missing.join(', ')}`);
    }
    expect(incomplete).toEqual([]);
  });
});

/* ===========================================================================
 * THE PERU RECORD, IN DETAIL
 * ===========================================================================
 * Item 2 of the defect report, given its own section because every part of it
 * failed for a different reason.
 * ======================================================================== */
describe('1969 Peru 100 Soles — the record that would not import', () => {
  const PERU = '1969 Peru 100 Soles - NGC MS64';

  it('recognises the country from the name instead of defaulting to the US', () => {
    expect(importedCoin(PERU).country).toBe('Peru');
  });

  it('reads "100 Soles" as the denomination', () => {
    expect(importedCoin(PERU).denomination).toBe('100 Soles');
  });

  it('leaves Coin Type blank rather than inventing one', () => {
    expect(importedCoin(PERU).coinType).toBe('');
  });

  it('still parses the grade and grading company', () => {
    const coin = importedCoin(PERU);
    expect(coin.grade).toBe('MS64');
    expect(coin.certCompany).toBe('NGC');
    expect(coin.hasCacSticker).toBe(false);
  });

  it('passes the 2-of-3 rule on Year + Denomination, with Coin Type blank', () => {
    const result = parseSecurity(PERU);
    expect(result.rejectedRecords).toHaveLength(0);
    expect(result.importedRecords).toHaveLength(1);
  });

  it('fills in the gold content, matching the memo on the Quicken transaction', () => {
    // The QIF transaction's own memo line reads "1.3544 ounces of gold".
    const coin = importedCoin(PERU);
    expect(coin.metalContent).toBe('Gold');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(42.13, 2);
    // 42.13 g / 31.1035 g-per-troy-oz = 1.3545 oz, i.e. the memo's figure.
    expect((coin.pmWeightGrams ?? 0) / 31.1035).toBeCloseTo(1.3544, 3);
  });
});

/* ===========================================================================
 * THE COUNTRY / FOREIGN-DENOMINATION VOCABULARY, BEYOND THIS FILE
 * ===========================================================================
 * Peru is the only non-US coin in GoldCoins.QIF today, but the owner buys
 * world gold, so the vocabulary is deliberately broader than one country.
 * These cases are NOT from the export -- they are written in the same style
 * as the real ones so that whatever turns up next already works.
 * ======================================================================== */
describe('other non-US coins the vocabulary now handles', () => {
  const cases: { name: string; country: string; denomination: string }[] = [
    { name: '1947 Mexico 50 Pesos - NGC MS63',       country: 'Mexico',        denomination: '50 Pesos' },
    { name: '1913 France 20 Francs - PCGS MS64',     country: 'France',        denomination: '20 Francs' },
    { name: '1915 Austria 100 Corona - NGC MS65',    country: 'Austria',       denomination: '100 Corona' },
    { name: '1899 Russia 5 Roubles - PCGS AU58',     country: 'Russia',        denomination: '5 Roubles' },
    { name: '1897 Germany 20 Marks - NGC AU55',      country: 'Germany',       denomination: '20 Marks' },
    { name: '1927 South Africa 1 Pond - NGC XF45',   country: 'South Africa',  denomination: '1 Pond' },
    { name: '1910 Netherlands 10 Gulden - MS64',     country: 'Netherlands',   denomination: '10 Gulden' },
    { name: '1912 Italy 20 Lire - NGC MS62',         country: 'Italy',         denomination: '20 Lire' },
    { name: '1908 Japan 20 Yen - PCGS AU58',         country: 'Japan',         denomination: '20 Yen' }
  ];

  for (const testCase of cases) {
    it(`"${testCase.name}" -> ${testCase.country}, ${testCase.denomination}`, () => {
      const coin = importedCoin(testCase.name);
      expect(coin.country).toBe(testCase.country);
      expect(coin.denomination).toBe(testCase.denomination);
    });
  }

  it('reads a currency unit that names its own country, with no country word', () => {
    // "Soles" has exactly one issuer, so it proves Peru on its own.
    const coin = importedCoin('1965 100 Soles - NGC MS64');
    expect(coin.country).toBe('Peru');
    expect(coin.denomination).toBe('100 Soles');
  });

  it('reads a SHARED currency unit as a denomination but NOT as a country', () => {
    // France, Belgium, Switzerland and Luxembourg all struck 20 Francs. The
    // denomination is certain; the country is not, so it is left at the
    // collection's default rather than guessed.
    const coin = importedCoin('1875 20 Francs - NGC MS63');
    expect(coin.denomination).toBe('20 Francs');
    expect(coin.country).toBe('United States'); // i.e. not guessed as France
  });

  it('does not report a non-US alloy it has no reference data for', () => {
    // We can read the country and the denomination off a 20 Francs, but the
    // table carries no French entry, so Metal and Composition stay blank
    // rather than borrowing the US figures.
    const coin = importedCoin('1913 France 20 Francs - PCGS MS64');
    expect(coin.metalContent).toBeUndefined();
    expect(coin.composition).toBeUndefined();
    expect(coin.pmPercent).toBeUndefined();
  });
});

/* ===========================================================================
 * THINGS THAT MUST *NOT* BE READ AS COUNTRIES OR METALS
 * ===========================================================================
 * Every one of these is a US coin whose name contains a word that looks like
 * a country or a metal. Each was checked deliberately when the vocabulary was
 * built; see the comments in coin-countries.ts.
 * ======================================================================== */
describe('false-positive guards', () => {
  /**
   * Country is asserted on whichever list the record landed in. Two of these
   * fixtures deliberately do NOT import -- the Panama-Pacific $50 has a face
   * value the US denomination table does not carry, so it fails the 2-of-3
   * rule and goes to the exceptions panel. Its COUNTRY still has to be right,
   * because that is what this block is testing.
   */
  function parsedCountry(securityName: string): string {
    const result = parseSecurity(securityName);
    const record = result.importedRecords[0] ?? result.rejectedRecords[0]?.record;
    expect(record, `"${securityName}" produced no record at all`).toBeDefined();
    return record!.country;
  }

  const usCases: string[] = [
    '1915-S Panama-Pacific $50 - PCGS MS64',  // a US commemorative, not Panama
    '1935 Old Spanish Trail 50¢ - NGC MS65',  // a US commemorative, not Spain
    '1908 $2.50 Indian Head - PCGS MS63',     // "Indian" is not India
    '1856 $1 Indian Princess Gold - AU55',    // ditto
    '1893 Columbian 50¢ - PCGS MS64'          // "Columbian", not Colombia
  ];

  for (const name of usCases) {
    it(`keeps "${name}" as a United States coin`, () => {
      expect(parsedCountry(name)).toBe('United States');
    });
  }

  it('does not read the CAC GOLD STICKER as the coin being gold', () => {
    // "CAC Gold" is CAC's top sticker tier. It sits on silver coins all the
    // time, and reading it as a metal would turn an 1875 twenty-cent piece
    // (90% SILVER) into gold.
    const coin = importedCoin('1875 20¢ - PCGS XF40 CAC Gold');
    expect(coin.denomination).toBe('20¢');
    expect(coin.metalContent).toBe('Silver');
    expect(coin.pmPercent).toBe(90);
  });

  it('does not read a reversed "Gold CAC" as the coin being gold either', () => {
    const coin = importedCoin('1875 20¢ - PCGS XF40 Gold CAC');
    expect(coin.metalContent).toBe('Silver');
  });

  it('does not mistake a four-digit year for a denomination quantity', () => {
    // "1969" is bound to nothing, and a bare number means nothing -- the same
    // rule denomination-units.ts enforces for photo filenames.
    const coin = importedCoin('1969 Peru 100 Soles - NGC MS64');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.year).toBe('1969');
  });
});
