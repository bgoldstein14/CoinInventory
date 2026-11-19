 /*
  * Tests that metal inference answers when the metal is obvious (a US $20 is
  * gold, a Morgan is silver) and refuses where two metals shared a date or face
  * value, since a wrong metal gives a wrong melt value.
  *
  * The whole-account block at the bottom uses security names copied verbatim
  * from `Y` lines in testing/qif-corpus/GoldCoins.QIF; don't tidy them (the
  * corpus is synthetic but its shapes are real; see qif-corpus/generate-corpus.mjs).
  */

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_METALS,
  canonicalMetal,
  inferMetalContent,
  inferMetalContentDetailed,
  metalFromComposition
} from './metal-inference';
import { composePmFields } from './pm-fill';
import { QuickenImportService } from './quicken-import.service';

describe('rule 1 — an explicit metal word', () => {
  it('takes the metal the caller already read out of the source text', () => {
    // `metalHint` comes from the security name or the coin's own Metal Content:
    // a statement, not a guess.
    const result = inferMetalContentDetailed({ metalHint: 'Gold' });

    expect(result?.metal).toBe('Gold');
    expect(result?.rule).toBe('explicit-metal-hint');
  });

  it('reads a metal word out of the COIN TYPE field', () => {
    expect(inferMetalContent({ coinType: 'Gold Eagle' })).toBe('Gold');
    expect(inferMetalContent({ coinType: 'American Silver Eagle' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Gold Dollar' })).toBe('Gold');
    expect(inferMetalContent({ coinType: 'Platinum Eagle' })).toBe('Platinum');
    expect(inferMetalContent({ coinType: 'Palladium Eagle' })).toBe('Palladium');
  });

  it('lets the coin type beat the denomination when the two could disagree', () => {
    // $10 is also the 1/10 oz Platinum Eagle's face value; the type wins.
    expect(
      inferMetalContent({ coinType: 'Platinum Eagle', denomination: '$10', year: '1998' })
    ).toBe('Platinum');
  });

  it('does NOT read "CAC Gold" as the coin being gold', () => {
    // "CAC Gold" is a sticker tier, not a metal.
    expect(inferMetalContent({ coinType: 'Barber CAC Gold', year: '1900' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Gold CAC' })).toBeNull();
  });

  it('does NOT read "Nickel" in a type name as the metal nickel', () => {
    /* "Nickel" in a type is the denomination: a 1943 Jefferson Nickel is 35%
     * silver, a Three Cent Nickel 75% copper. Ignored. */
    expect(inferMetalContent({ coinType: 'Jefferson Nickel', year: '1943' })).toBeNull();
    expect(inferMetalContent({ coinType: 'Three Cent Nickel', year: '1870' })).toBeNull();
  });

  it('reads the FIRST metal named when a type somehow names two', () => {
    // Majority-first convention.
    expect(inferMetalContent({ coinType: 'Silver and Gold commemorative' })).toBe('Silver');
  });
});

describe('rule 2 — a US denomination that is gold by definition', () => {
  const goldByFaceValue: { denomination: string; why: string }[] = [
    { denomination: '$20',   why: 'the Double Eagle, 1849-1933, the only US $20 ever struck' },
    { denomination: '$10',   why: 'the Eagle, 1795-1933' },
    { denomination: '$5',    why: 'the Half Eagle, 1795-1929, and every modern $5 commemorative' },
    { denomination: '$3',    why: 'the Three Dollar piece, 1854-1889 — one series, always gold' },
    { denomination: '$2.50', why: 'the Quarter Eagle, 1796-1929' }
  ];

  for (const { denomination, why } of goldByFaceValue) {
    it(`${denomination} is Gold — ${why}`, () => {
      expect(
        inferMetalContent({ denomination, year: '1900', country: 'United States' })
      ).toBe('Gold');
    });
  }

  it('answers for a year the reference table has no row for', () => {
    // Outside the table's year bands, but the face value still settles the metal.
    expect(inferMetalContent({ denomination: '$20', year: '1934', country: 'United States' })).toBe('Gold');
    expect(inferMetalContent({ denomination: '$5', year: '1990', country: 'United States' })).toBe('Gold');
  });

  it('accepts the collector\'s "G$" shorthand', () => {
    // The "G" settles a $1 (written this way in real security names).
    expect(inferMetalContent({ denomination: 'G$1', year: '1855' })).toBe('Gold');
    expect(inferMetalContent({ denomination: 'G$2.50', year: '1873' })).toBe('Gold');
  });

  it('treats "$2.50" and "$2.5" as the same denomination', () => {
    expect(inferMetalContent({ denomination: '$2.5', year: '1911' })).toBe('Gold');
  });

  it('REFUSES a bare "$1", because the US struck it in four different metals', () => {
    /* 1849-1889 had both silver and gold dollars (and later clad and
     * manganese-brass ones), so "$1" alone says nothing. */
    expect(inferMetalContent({ denomination: '$1', year: '1860', country: 'United States' })).toBeNull();
    expect(inferMetalContent({ denomination: '$1', year: '1921', country: 'United States' })).toBeNull();
  });

  it('only applies the rule to US coinage', () => {
    // Canada has struck both gold and silver $20 coins.
    expect(inferMetalContent({ denomination: '$20', year: '2011', country: 'Canada' })).toBeNull();
  });

  it('REFUSES a modern "$10", because that face value is gold AND platinum', () => {
    /* $10 is also the 1/10 oz Platinum Eagle (1997 on), so the rule is off from
     * 1986 unless a type name settles it. */
    expect(inferMetalContent({ denomination: '$10', year: '2005', country: 'United States' })).toBeNull();
    // ...a classic Eagle is unaffected.
    expect(inferMetalContent({ denomination: '$10', year: '1901', country: 'United States' })).toBe('Gold');
  });

  it('says nothing about $25 or $50, where no safe year cutoff exists', () => {
    // $50 is the Gold Eagle, Gold Buffalo, Platinum Eagle and 1915 Panama-Pacific.
    expect(inferMetalContent({ denomination: '$50', year: '1915', country: 'United States' })).toBeNull();
    expect(inferMetalContent({ denomination: '$25', year: '1995', country: 'United States' })).toBeNull();
  });
});

describe('rule 3 — series names that imply a metal', () => {
  const alwaysGold: string[] = [
    'Saint-Gaudens',
    'St. Gaudens',
    'Double Eagle',
    'Liberty Head Double Eagle',
    'Half Eagle',
    'Quarter Eagle',
    'Indian Princess'
  ];

  for (const coinType of alwaysGold) {
    it(`"${coinType}" is Gold in every year the name was ever used`, () => {
      expect(inferMetalContent({ coinType })).toBe('Gold');
    });
  }

  const alwaysSilver: string[] = ['Morgan', 'Peace', 'Trade Dollar', 'Three Cent Silver'];

  for (const coinType of alwaysSilver) {
    it(`"${coinType}" is Silver in every year the name was ever used`, () => {
      // Morgan and Peace were revived in 2021 in 99.9% silver, so no year band.
      expect(inferMetalContent({ coinType })).toBe('Silver');
    });
  }

  /* Year-gated silver series: the 1965 Coinage Act removed silver, and several
   * designs were revived in gold in 2016, so name plus year proves silver. */
  const yearGated: { coinType: string; silverYear: string; notSilverYear: string; why: string }[] = [
    { coinType: 'Mercury',          silverYear: '1942', notSilverYear: '2016', why: 'the 2016 centennial Mercury dime is gold' },
    { coinType: 'Standing Liberty', silverYear: '1926', notSilverYear: '2016', why: 'the 2016 centennial quarter is gold' },
    { coinType: 'Walking Liberty',  silverYear: '1943', notSilverYear: '2016', why: 'the 2016 centennial half is gold' },
    { coinType: 'Barber',           silverYear: '1900', notSilverYear: '1930', why: 'the series ended in 1916' },
    { coinType: 'Franklin',         silverYear: '1958', notSilverYear: '1970', why: 'the series ran 1948-1963' },
    { coinType: 'Liberty Seated',   silverYear: '1870', notSilverYear: '1900', why: 'the series ended in 1891' },
    { coinType: 'Washington',       silverYear: '1942', notSilverYear: '1965', why: 'the Coinage Act of 1965 removed the silver' },
    { coinType: 'Roosevelt',        silverYear: '1955', notSilverYear: '1965', why: 'the Coinage Act of 1965 removed the silver' },
    { coinType: 'Kennedy',          silverYear: '1967', notSilverYear: '1971', why: '1971 onward are copper-nickel clad' }
  ];

  for (const { coinType, silverYear, notSilverYear, why } of yearGated) {
    it(`"${coinType}" is Silver in ${silverYear} but says nothing in ${notSilverYear} — ${why}`, () => {
      expect(inferMetalContent({ coinType, year: silverYear })).toBe('Silver');
      expect(inferMetalContent({ coinType, year: notSilverYear })).toBeNull();
    });

    it(`"${coinType}" says nothing at all with no year to read`, () => {
      // A year-gated rule must not fire without a year.
      expect(inferMetalContent({ coinType })).toBeNull();
    });
  }

  it('reads the 1964 Kennedy half as silver and the 1965-70 40% issues as silver too', () => {
    // The Kennedy half kept 40% silver through 1970.
    expect(inferMetalContent({ coinType: 'Kennedy', year: '1964' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Kennedy', year: '1970' })).toBe('Silver');
  });

  /* Names used on coins of more than one metal; denomination plus year settles
   * them in `lookupCoinAlloy`, not here. */
  const ambiguousNames: { coinType: string; why: string }[] = [
    { coinType: 'Liberty Head', why: 'the 5¢ nickel, the $20 double eagle and the Type 1 gold dollar all use it' },
    { coinType: 'Indian Head',  why: 'the bronze cent, and the $2.50 / $5 / $10 gold' },
    { coinType: 'Classic Head', why: 'copper half cents and cents, and $2.50 / $5 gold' },
    { coinType: 'Draped Bust',  why: 'copper cents, silver dimes-to-dollars, gold $2.50-$10' },
    { coinType: 'Capped Bust',  why: 'silver 10¢-50¢ and gold $2.50 / $5' },
    { coinType: 'Flowing Hair', why: 'silver half dimes-to-dollars and copper cents' },
    { coinType: 'Coronet',      why: 'gold $2.50-$20 and the Coronet Head large cent' },
    { coinType: 'Eisenhower',   why: '1971-78 clad business strikes AND 40% silver collector issues' },
    { coinType: 'Lincoln',      why: '1982 was struck in both bronze and copper-plated zinc' },
    { coinType: 'Jefferson',    why: '1942 was struck in both cupronickel and 35% silver' }
  ];

  for (const { coinType, why } of ambiguousNames) {
    it(`"${coinType}" alone says nothing — ${why}`, () => {
      expect(inferMetalContent({ coinType, year: '1909' })).toBeNull();
    });
  }

  it('still reads a Liberty Head DOUBLE EAGLE, because the compound name is unambiguous', () => {
    expect(inferMetalContent({ coinType: 'Liberty Head Double Eagle', year: '1904' })).toBe('Gold');
  });
});

/* Rule 4: compositions name several metals majority first, so a "contains
 * Copper" test would make a Double Eagle copper. */

describe('rule 4 — the majority metal in a composition string', () => {
  const realCompositions: { composition: string; metal: string; why: string }[] = [
    { composition: '90% Gold, 10% Copper', metal: 'Gold', why: 'a double eagle is not a copper coin' },
    { composition: '91.67% Gold, 8.33% Silver and Copper', metal: 'Gold', why: 'early US gold names three metals' },
    { composition: '90% Silver, 10% Copper', metal: 'Silver', why: 'a Morgan dollar is not a copper coin' },
    { composition: '92.5% Silver, 7.5% Copper (sterling)', metal: 'Silver', why: 'sterling' },
    { composition: '50% Silver, 40% Copper, 10% Nickel', metal: 'Silver', why: 'debased British silver, 1920-1946' },
    { composition: '40% Silver clad (80% silver outer layers, 21% silver core)', metal: 'Silver', why: 'the 1965-70 Kennedy half' },
    { composition: '91.67% Gold, 8.33% Copper (22 carat crown gold)', metal: 'Gold', why: 'a British sovereign' }
  ];

  for (const { composition, metal, why } of realCompositions) {
    it(`"${composition}" -> ${metal} (${why})`, () => {
      expect(metalFromComposition(composition)).toBe(metal);
    });
  }

  it('prefers the PRECIOUS metal even when a base metal is the majority by weight', () => {
    /* pm-reference.ts records the 1943-45 war nickel as Silver; matching it keeps
     * imported and backfilled coins consistent. */
    expect(metalFromComposition('56% Copper, 35% Silver, 9% Manganese (wartime alloy)')).toBe('Silver');
  });

  it('reads a plating as a skin, not as the coin', () => {
    // "Copper-plated zinc" is a zinc cent; "Zinc-coated steel" the 1943 steel cent.
    expect(metalFromComposition('Copper-plated zinc (97.5% Zn, 2.5% Cu)')).toBe('Zinc');
    expect(metalFromComposition('Zinc-coated steel')).toBe('Steel');
  });

  it('reads a named alloy rather than its first ingredient', () => {
    expect(metalFromComposition('Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)'))
      .toBe('Copper-Nickel');
    expect(metalFromComposition('Manganese brass (88.5% Cu, 6% Zn, 3.5% Mn, 2% Ni)')).toBe('Brass');
  });

  it('says nothing about text that names no metal at all', () => {
    expect(metalFromComposition('')).toBeNull();
    expect(metalFromComposition('unknown')).toBeNull();
    expect(metalFromComposition(undefined)).toBeNull();
  });

  it('is the LAST resort — a stronger rule always wins', () => {
    // A Morgan with a nonsense composition is still silver.
    expect(
      inferMetalContentDetailed({ coinType: 'Morgan', composition: '100% Copper' })?.rule
    ).toBe('series-name');
  });
});

/* Output must be one of the `MetalContents` values seeded by
 * server/setup-database.sql, or the editor's <select> can't show it. */

describe('the output vocabulary', () => {
  /** Copied verbatim from INSERT INTO MetalContents in setup-database.sql. */
  const SEEDED_METAL_CONTENTS = [
    'Gold', 'Silver', 'Platinum', 'Palladium', 'Copper', 'Nickel', 'Copper-Nickel',
    'Bronze', 'Brass', 'Zinc', 'Steel', 'Aluminum', 'Nickel-Brass', 'Clad', 'Other'
  ];

  it('matches the database seed exactly, in the same order', () => {
    expect([...CANONICAL_METALS]).toEqual(SEEDED_METAL_CONTENTS);
  });

  it('only ever returns a seeded value', () => {
    const probes = [
      { coinType: 'Gold Eagle' },
      { coinType: 'Morgan' },
      { denomination: '$20', year: '1927', country: 'United States' },
      { composition: 'Copper-Nickel clad (75% Cu / 25% Ni)' },
      { composition: 'Zinc-coated steel' },
      { metalHint: 'Clad' }
    ];

    for (const probe of probes) {
      const metal = inferMetalContent(probe);
      expect(metal).not.toBeNull();
      expect(SEEDED_METAL_CONTENTS).toContain(metal);
    }
  });

  it('rejects a metal word that is not in the dropdown', () => {
    // A real alloy, but not in MetalContents, so it would be un-editable.
    expect(canonicalMetal('Electrum')).toBeNull();
    expect(canonicalMetal('')).toBeNull();
    expect(canonicalMetal(undefined)).toBeNull();
  });

  it('accepts the spellings a human might type for a dropdown value', () => {
    expect(canonicalMetal('cupronickel')).toBe('Copper-Nickel');
    expect(canonicalMetal('aluminium')).toBe('Aluminum');
    expect(canonicalMetal('  gold  ')).toBe('Gold');
  });
});

/* Cases that must stay blank: only answer when the evidence is strong. */

describe('the deliberate refusals', () => {
  const refusals: { what: string; evidence: Record<string, string>; why: string }[] = [
    {
      what: 'a bare $1 in the gold-dollar era',
      evidence: { denomination: '$1', year: '1860', country: 'United States' },
      why: 'a 24 g silver dollar and a 1.5 g gold dollar were struck in the same years'
    },
    {
      what: 'the 1942 Jefferson nickel',
      evidence: { denomination: '5¢', year: '1942', coinType: 'Jefferson', country: 'United States' },
      why: 'cupronickel AND 35% silver were both struck that year'
    },
    {
      what: 'the 1982 Lincoln cent',
      evidence: { denomination: '1¢', year: '1982', coinType: 'Lincoln', country: 'United States' },
      why: 'bronze AND copper-plated zinc were both struck that year'
    },
    {
      what: 'a 1971-78 Eisenhower dollar',
      evidence: { denomination: '$1', year: '1974', coinType: 'Eisenhower', country: 'United States' },
      why: 'clad business strikes AND 40% silver collector issues share the date'
    },
    {
      what: 'a coin with nothing recorded at all',
      evidence: {},
      why: 'there is no evidence to read'
    },
    {
      what: 'a foreign coin the vocabulary does not cover',
      evidence: { denomination: '100 Yen', year: '1964', country: 'Japan' },
      why: 'nothing in the record says what a 100 Yen is made of'
    }
  ];

  for (const { what, evidence, why } of refusals) {
    it(`leaves ${what} blank — ${why}`, () => {
      expect(inferMetalContent(evidence)).toBeNull();
    });
  }

  it('never lets a CATEGORY decide the metal', () => {
    /* `category` is a filing choice ("Gold Coins" folders hold silver tokens too)
     * and isn't even an accepted field; passing it changes nothing. */
    const withCategory = { category: 'Gold Coins', denomination: '1¢', year: '1909' } as Record<string, string>;

    expect(inferMetalContent(withCategory)).toBeNull();
  });
});

/* composePmFields keeps the reference table authoritative */

describe('composePmFields — the fallback never displaces the reference table', () => {
  it('uses the catalogued answer unchanged when there is one', () => {
    const fields = composePmFields('$20', '1927', 'United States', undefined, {
      // Would also infer Gold; the catalogued row must still win, all fields intact.
      coinType: 'Saint-Gaudens'
    });

    expect(fields).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      // Gross weight, which only the catalogued row can supply.
      weight: 33.436
    });
  });

  it('supplies the metal ALONE when the table has no row', () => {
    /* A 1934 $20 is outside every band in pm-reference.ts: still gold, but the
     * gold weight is not invented. */
    const fields = composePmFields('$20', '1934', 'United States');

    expect(fields).toEqual({ metalContent: 'Gold' });
    expect(fields?.composition).toBeUndefined();
    expect(fields?.pmPercent).toBeUndefined();
    expect(fields?.pmWeightGrams).toBeUndefined();
    // No gross weight either: the fallback reasons about metal only.
    expect(fields?.weight).toBeUndefined();
  });

  it('never fills the unknown fields with zeros or empty strings', () => {
    // pmWeightGrams 0 would read as a recorded fact; an empty composition as checked.
    const fields = composePmFields('', '', 'France', 'Gold');

    expect(Object.keys(fields ?? {})).toEqual(['metalContent']);
    expect(fields?.metalContent).toBe('Gold');
  });

  it('reads the coin type when nothing else is known', () => {
    // No catalogued row and no US rule, but the coin type names the metal.
    const fields = composePmFields('20 Francs', '1913', 'France', undefined, {
      coinType: 'Gold 20 Francs'
    });

    expect(fields).toEqual({ metalContent: 'Gold' });
  });

  it('still answers null when neither source will commit', () => {
    expect(composePmFields('$1', '1855', 'United States')).toBeNull();
    expect(composePmFields('5¢', '1942', 'United States')).toBeNull();
    expect(composePmFields('20 Francs', '1913', 'France')).toBeNull();
  });
});

/*
 * All 44 distinct security names in the corpus's Gold Coins account, verbatim.
 * Quirks such as the missing hyphen in "1898 $20 NGC/CAC MS64", the "G$"
 * prefixes, the bare "1874 $5" and the one non-US entry each cover a branch.
 * Headline: importing the account sets every coin's metal to Gold.
 */

/** Every distinct `Y` (security name) line in the Gold Coins account. */
const GOLD_COINS_QIF_SECURITIES: readonly string[] = [
  '1836 $5 - PCGS/CAC XF40',
  '1850-S $1 Gold - ANACS XF40',
  '1854 G$3 - NGC/CAC AU53',
  '1856 $3 - NGC/CAC VF20',
  '1856 G$1 - NGC/CAC AU53',
  '1861 $3 - NGC/CAC AU53',
  '1863 $3 - PCGS/CAC AU58',
  '1863-O $3 - PCGS F12',
  '1860 $3 - PCGS/CAC AU58',
  '1867 $3 - NGC AU55',
  '1873 Open 3 G$1 - ANACS AU50',
  '1873 Open 3 G$2.50 - ANACS AU55',
  '1880 $3 - PCGS AU50',
  '1878 $3 - NGC/CAC AU50',
  '1874 $5',
  '1893 $5 - PCI AU53',
  '1899 $10 - ANACS MS62',
  '1898 $20 NGC/CAC MS64',
  '1898 $5 - ANACS AU58',
  '1905 $20 - PCGS MS64',
  '1905 $20 - NGC MS64',
  '1896-O $5',
  '1902 $20 Liberty - NGC/CAC MS63',
  '1908 $5 - NGC/CAC XF40',
  '1908 NM $20 - PCGS/CAC MS65',
  '1908 NM $20 - NGC/CAC MS65',
  '1908 WM $10 - PCGS/CAC MS62',
  '1909 $5 - NGC/CAC XF45',
  '1922S $10 - NGC MS64',
  '1920 $2.50',
  '1920 $2.50 Gold Indian - ANACS AU50',
  '1913 $2.50 Gold Indian - ANACS AU58',
  '1913-D $5 - NGC XF45',
  '1926-D $5 - NGC XF45',
  '1914-D $20 - PCGS MS65',
  '1914-D $5 - NGC XF45',
  '1928 $20 - NGC MS64',
  '1910 $20 - NGC/CAC MS65+',
  '1925 $20 - PCGS/CAC MS65',
  '1925 $20 - NGC MS65',
  '1912 $20 - NGC MS65',
  '1923 $20 - NGC MS65',
  '1915 $10 - NGC MS64',
  '1967 Peru 100 Soles - PCGS MS65'
];

/** Runs one security name through the full import and returns the record. */
function importedCoin(securityName: string) {
  const service = new QuickenImportService();
  const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
  const result = service.parse(qif);
  expect(result.importedRecords, `"${securityName}" should import`).toHaveLength(1);
  return result.importedRecords[0];
}

describe('GoldCoins.QIF — a whole account imported, end to end', () => {
  it('contains the 44 distinct securities this file was checked against', () => {
    expect(GOLD_COINS_QIF_SECURITIES).toHaveLength(44);
    expect(new Set(GOLD_COINS_QIF_SECURITIES).size).toBe(44);
  });

  it('gives every single one of them a Metal Content of Gold', () => {
    // All 44 must be Gold; a failure names the coins that came out blank.
    const blank = GOLD_COINS_QIF_SECURITIES.filter(
      (name) => importedCoin(name).metalContent !== 'Gold'
    );

    expect(blank, 'these securities did not come out as Gold').toEqual([]);
  });
});

/*
 * All 44 resolve through `lookupCoinAlloy`, so the fallback isn't reached for
 * this file. This block measures what the coarse rules achieve alone (metal
 * hint withheld), for future uncatalogued imports.
 */
describe('GoldCoins.QIF — what the coarse rules achieve unaided', () => {
  /** The parsed coin, without the metal hint. */
  function coarseMetalFor(securityName: string): string | null {
    const coin = importedCoin(securityName);
    return inferMetalContent({
      coinType: coin.coinType,
      denomination: coin.denomination,
      year: coin.year,
      country: coin.country
    });
  }

  it('reaches 41 of the 44 with no reference table and no metal hint', () => {
    const answered = GOLD_COINS_QIF_SECURITIES.filter((name) => coarseMetalFor(name) !== null);

    expect(answered).toHaveLength(41);
  });

  it('names exactly the three it declines, and each for a stated reason', () => {
    const declined = GOLD_COINS_QIF_SECURITIES.filter((name) => coarseMetalFor(name) === null);

    expect(declined).toEqual([
      // "$1" and "Liberty Head" are both ambiguous; only the word "Gold" (carried
      // by `metalHint` in the real import) settles it.
      '1850-S $1 Gold - ANACS XF40',
      // A Gold Dollar transition year leaves Coin Type blank and a bare "$1"; "G$" settles it.
      '1856 G$1 - NGC/CAC AU53',
      // Gold, but nothing in the record says so; the reference table has the row.
      '1967 Peru 100 Soles - PCGS MS65'
    ]);
  });

  it('gets every $20, $10, $5, $3 and $2.50 right from the face value alone', () => {
    const faceValueGold = GOLD_COINS_QIF_SECURITIES.filter((name) => {
      const coin = importedCoin(name);
      return ['$20', '$10', '$5', '$3', '$2.50'].includes(coin.denomination);
    });

    expect(faceValueGold.length).toBe(40);
    for (const name of faceValueGold) {
      expect(coarseMetalFor(name), name).toBe('Gold');
    }
  });

  it('reads the 1873 gold dollar from its Coin Type when the face value cannot', () => {
    // Denomination "$1" says nothing, but Coin Type "Indian Princess" is gold-only.
    expect(coarseMetalFor('1873 Open 3 G$1 - ANACS AU50')).toBe('Gold');
  });
});
