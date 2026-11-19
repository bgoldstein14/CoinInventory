 /*
  * Runs the QIF importer over a whole account: the 44 distinct `Y` lines of
  * testing/qif-corpus/GoldCoins.QIF, copied verbatim. The shapes come from a real
  * export (see testing/qif-corpus/generate-corpus.mjs), so quirks such as the
  * missing hyphen in "1898 $20 NGC/CAC MS64", "G$" prefixes, the bare "1874 $5",
  * "Open 3" and the one non-US entry each matter. Don't tidy them; if the corpus
  * is regenerated, update this table with it. (Same approach as
  * image-matching/real-filenames.spec.ts.)
  *
  * Guards against: alloy fields not filled on import, and "1967 Peru 100 Soles"
  * failing the 2-of-3 rule. `expectedCoinType: ''` means Coin Type is correctly
  * left blank.
  */

import { describe, expect, it } from 'vitest';
import { QuickenImportService } from './quicken-import.service';

/** Runs one security name through the full parse, as the import button does. */
function parseSecurity(securityName: string) {
  const service = new QuickenImportService();
  const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
  const result = service.parse(qif);
  return result;
}

/** The parsed record, asserting it was importable. */
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
  /** One of the 44 names in qif-corpus/GoldCoins.QIF; keep in step with the corpus. */
  name: string;
  year: string;
  denomination: string;
  /** '' means correctly left blank. */
  coinType: string;
  country: string;
  metal: string;
  pmPercent: number;
  /** Weight of the pure gold, in grams. */
  pmWeightGrams: number;
  /**
   * Weight of the whole coin in grams; must exceed `pmWeightGrams` and agree with
   * `pmPercent` (both checked on every row).
   */
  grossWeightGrams: number;
}

/* All 44 securities, grouped by denomination to match pm-reference.ts's year bands. */
const GOLD_SECURITIES: SecurityCase[] = [
  // Gold Dollar ($1 gold, 1849-1889). "$1" in these years is also the silver
  // dollar; "Gold" and "G$" settle it.
  {
    name: '1850-S $1 Gold - ANACS XF40',
    year: '1850', denomination: '$1', coinType: 'Liberty Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },
  {
    // A Gold Dollar transition year (types overlap 1854-1856), so Coin Type is
    // blank; Year + Denomination still pass the 2-of-3 rule.
    name: '1856 G$1 - NGC/CAC AU53',
    year: '1856', denomination: '$1', coinType: '', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },
  {
    name: '1873 Open 3 G$1 - ANACS AU50',
    year: '1873', denomination: '$1', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 1.50,
    grossWeightGrams: 1.672
  },

  // Quarter Eagle ($2.50)
  {
    name: '1873 Open 3 G$2.50 - ANACS AU55',
    year: '1873', denomination: '$2.50', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1920 $2.50',
    year: '1920', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1920 $2.50 Gold Indian - ANACS AU50',
    year: '1920', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },
  {
    name: '1913 $2.50 Gold Indian - ANACS AU58',
    year: '1913', denomination: '$2.50', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 3.76,
    grossWeightGrams: 4.18
  },

  // Three Dollar ($3, 1854-1889, one specification)
  {
    name: '1854 G$3 - NGC/CAC AU53',
    year: '1854', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1856 $3 - NGC/CAC VF20',
    year: '1856', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1861 $3 - NGC/CAC AU53',
    year: '1861', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1863 $3 - PCGS/CAC AU58',
    year: '1863', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1863-O $3 - PCGS F12',
    year: '1863', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1860 $3 - PCGS/CAC AU58',
    year: '1860', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1867 $3 - NGC AU55',
    year: '1867', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1880 $3 - PCGS AU50',
    year: '1880', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },
  {
    name: '1878 $3 - NGC/CAC AU50',
    year: '1878', denomination: '$3', coinType: 'Indian Princess', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 4.52,
    grossWeightGrams: 5.015
  },

  // Half Eagle ($5)
  {
    // A Classic Head half eagle (Act of 1834): 0.8992 fine, the one coin here not 90%.
    name: '1836 $5 - PCGS/CAC XF40',
    year: '1836', denomination: '$5', coinType: 'Classic Head', country: 'United States',
    metal: 'Gold', pmPercent: 89.92, pmWeightGrams: 7.52,
    grossWeightGrams: 8.36
  },
  {
    name: '1874 $5',
    year: '1874', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    // "PCI" is an unknown grading company; certCompany isn't a main detail.
    name: '1893 $5 - PCI AU53',
    year: '1893', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1898 $5 - ANACS AU58',
    year: '1898', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1896-O $5',
    year: '1896', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1908 $5 - NGC/CAC XF40',
    year: '1908', denomination: '$5', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1909 $5 - NGC/CAC XF45',
    year: '1909', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1913-D $5 - NGC XF45',
    year: '1913', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1926-D $5 - NGC XF45',
    year: '1926', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },
  {
    name: '1914-D $5 - NGC XF45',
    year: '1914', denomination: '$5', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 7.52,
    grossWeightGrams: 8.359
  },

  // Eagle ($10)
  {
    name: '1899 $10 - ANACS MS62',
    year: '1899', denomination: '$10', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1908 WM $10 - PCGS/CAC MS62',
    year: '1908', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1922S $10 - NGC MS64',
    year: '1922', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },
  {
    name: '1915 $10 - NGC MS64',
    year: '1915', denomination: '$10', coinType: 'Indian Head', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 15.05,
    grossWeightGrams: 16.718
  },

  // Double Eagle ($20)
  {
    // No hyphen before "NGC", unlike every other row; must still parse.
    name: '1898 $20 NGC/CAC MS64',
    year: '1898', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1905 $20 - PCGS MS64',
    year: '1905', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1905 $20 - NGC MS64',
    year: '1905', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1902 $20 Liberty - NGC/CAC MS63',
    year: '1902', denomination: '$20', coinType: 'Coronet', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1908 NM $20 - PCGS/CAC MS65',
    year: '1908', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1908 NM $20 - NGC/CAC MS65',
    year: '1908', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1914-D $20 - PCGS MS65',
    year: '1914', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1928 $20 - NGC MS64',
    year: '1928', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1910 $20 - NGC/CAC MS65+',
    year: '1910', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1925 $20 - PCGS/CAC MS65',
    year: '1925', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1925 $20 - NGC MS65',
    year: '1925', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1912 $20 - NGC MS65',
    year: '1912', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },
  {
    name: '1923 $20 - NGC MS65',
    year: '1923', denomination: '$20', coinType: 'Saint-Gaudens', country: 'United States',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 30.09,
    grossWeightGrams: 33.436
  },

  // The one non-US coin in the file
  {
    // Country, denomination and alloy all come from the name; no sub-type to infer.
    name: '1967 Peru 100 Soles - PCGS MS65',
    year: '1967', denomination: '100 Soles', coinType: '', country: 'Peru',
    metal: 'Gold', pmPercent: 90, pmWeightGrams: 42.13,
    grossWeightGrams: 46.8069
  }
];

describe('GoldCoins.QIF — every security name in the account', () => {
  it('covers all 44 distinct securities in the export', () => {
    expect(GOLD_SECURITIES).toHaveLength(44);
  });

  for (const testCase of GOLD_SECURITIES) {
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
        // Composition must be present and name the metal.
        expect(coin.composition, 'composition should not be blank').toBeTruthy();
        expect(coin.composition?.toLowerCase()).toContain(testCase.metal.toLowerCase());
        expect(coin.pmPercent).toBeCloseTo(testCase.pmPercent, 2);
        expect(coin.pmWeightGrams).toBeCloseTo(testCase.pmWeightGrams, 2);
      });

      it('fills in the coin\'s GROSS weight, in grams', () => {
        /* `weight` (grams since migration 008) is compared with pmWeightGrams; they must
         * not be confused. */
        const coin = importedCoin(testCase.name);
        expect(coin.weight, 'weight should not be blank').toBeDefined();
        expect(coin.weight).toBeCloseTo(testCase.grossWeightGrams, 3);

        // The whole coin outweighs its gold; fails if the two fields are swapped.
        expect(coin.weight!).toBeGreaterThan(coin.pmWeightGrams!);

        // ...and all three agree, to 0.01 g (pmWeightGrams has two decimals; see
        // pm-reference.spec.ts).
        expect(Math.abs(coin.weight! * (coin.pmPercent! / 100) - coin.pmWeightGrams!))
          .toBeLessThanOrEqual(0.01);
      });
    });
  }
});

/*
 * Fill census: all five fields populated for 44 of 44 securities. A census
 * reports a regression as "43 of 44". Driven from GOLD_SECURITIES rather than
 * the .QIF, so the spec needs no filesystem or Node types
 * (testing/qif-accounts.fixture.ts is the one place that opens the corpus).
 */
describe('GoldCoins.QIF — fill rate across all 44 securities', () => {
  /** The five fields, in editor order. */
  const FIELDS = ['metalContent', 'composition', 'pmPercent', 'pmWeightGrams', 'weight'] as const;

  /** Blank means undefined, null, '' or NaN; 0 counts as filled. */
  function isFilled(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return !Number.isNaN(value);
    return true;
  }

  /** How many of the 44 have `field` populated. */
  function fillCount(field: (typeof FIELDS)[number]): number {
    return GOLD_SECURITIES.filter((testCase) => {
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
    // Names the incomplete coins rather than just a count.
    const incomplete: string[] = [];
    for (const testCase of GOLD_SECURITIES) {
      const coin = importedCoin(testCase.name) as unknown as Record<string, unknown>;
      const missing = FIELDS.filter((field) => !isFilled(coin[field]));
      if (missing.length > 0) incomplete.push(`${testCase.name} -> missing ${missing.join(', ')}`);
    }
    expect(incomplete).toEqual([]);
  });
});

/* The Peru 100 Soles in detail. */
describe('the Peru 100 Soles — the record that would not import', () => {
  const PERU = '1967 Peru 100 Soles - PCGS MS65';

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
    expect(coin.grade).toBe('MS65');
    expect(coin.certCompany).toBe('PCGS');
    expect(coin.hasCacSticker).toBe(false);
  });

  it('passes the 2-of-3 rule on Year + Denomination, with Coin Type blank', () => {
    const result = parseSecurity(PERU);
    expect(result.rejectedRecords).toHaveLength(0);
    expect(result.importedRecords).toHaveLength(1);
  });

  it('fills in the gold content, matching the published AGW for the series', () => {
    // The Peruvian 100 Soles contains 1.3544 troy ounces of gold.
    const coin = importedCoin(PERU);
    expect(coin.metalContent).toBe('Gold');
    expect(coin.pmPercent).toBe(90);
    expect(coin.pmWeightGrams).toBeCloseTo(42.13, 2);
    // 42.13 g / 31.1035 g per troy oz = 1.3545 oz.
    expect((coin.pmWeightGrams ?? 0) / 31.1035).toBeCloseTo(1.3544, 3);
  });
});

/*
 * Other non-US coins. Not from the export; written in the same style so other
 * world coins work.
 */
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
    // "Soles" has one issuer, so it proves Peru.
    const coin = importedCoin('1965 100 Soles - NGC MS64');
    expect(coin.country).toBe('Peru');
    expect(coin.denomination).toBe('100 Soles');
  });

  it('reads a SHARED currency unit as a denomination but NOT as a country', () => {
    // Several countries struck 20 Francs: the denomination is certain, the country
    // stays at the default.
    const coin = importedCoin('1875 20 Francs - NGC MS63');
    expect(coin.denomination).toBe('20 Francs');
    expect(coin.country).toBe('United States'); // i.e. not guessed as France
  });

  it('does not report a non-US alloy it has no reference data for', () => {
    // Country and denomination are read, but there is no French table entry, so
    // Metal and Composition stay blank.
    const coin = importedCoin('1913 France 20 Francs - PCGS MS64');
    expect(coin.metalContent).toBeUndefined();
    expect(coin.composition).toBeUndefined();
    expect(coin.pmPercent).toBeUndefined();
  });
});

/*
 * US coins whose names contain words that look like a country or metal (see
 * coin-countries.ts).
 */
describe('false-positive guards', () => {
  /**
   * Country from whichever list the record landed in. The Panama-Pacific $50
   * doesn't import (its face value isn't in the US table, so it fails 2-of-3),
   * but its country must still be right.
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
    // "CAC Gold" is a sticker tier; this 1875 twenty-cent piece is silver.
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
    // A bare number ("1967") is not a denomination.
    const coin = importedCoin('1967 Peru 100 Soles - PCGS MS65');
    expect(coin.denomination).toBe('100 Soles');
    expect(coin.year).toBe('1967');
  });
});
