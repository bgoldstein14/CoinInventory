/* ===========================================================================
 * metal-inference.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *
 * Two things, and they pull in opposite directions on purpose:
 *
 *   1. THAT IT ANSWERS. A coin whose metal is obvious from its own description
 *      — "a US $20 is gold", "a Morgan is silver", "a Gold Eagle says so" —
 *      gets a Metal Content even when the exact alloy is not catalogued. That
 *      is the defect the owner reported: he imported a file of gold coins and
 *      expected every one of them to come out marked Gold.
 *
 *   2. THAT IT REFUSES. Everywhere two metals genuinely shared a date or a
 *      face value, it answers nothing, because Metal Content feeds the melt
 *      calculation: a wrong metal produces a confidently wrong dollar figure,
 *      while a blank produces an honest dash.
 *
 * The REAL DATA block at the bottom follows the precedent set by
 * `services/image-matching/real-filenames.spec.ts` and
 * `services/quicken-real-securities.spec.ts`: every security name in it is
 * VERBATIM from the owner's own `GoldCoins.QIF`, copied without tidying, and
 * nothing in it should be "cleaned up".
 * =========================================================================== */

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

/* ===========================================================================
 * RULE 1 — AN EXPLICIT METAL WORD
 * ---------------------------------------------------------------------------
 * The strongest evidence, because it is not an inference: the source text, or
 * the owner, named the metal.
 * ======================================================================== */

describe('rule 1 — an explicit metal word', () => {
  it('takes the metal the caller already read out of the source text', () => {
    // The Quicken importer produces `metalHint` from a security name; the
    // Settings backfill produces it from the coin's own Metal Content. Both
    // are statements, not guesses, which is why this rule is first.
    const result = inferMetalContentDetailed({ metalHint: 'Gold' });

    expect(result?.metal).toBe('Gold');
    expect(result?.rule).toBe('explicit-metal-hint');
  });

  it('reads a metal word out of the COIN TYPE — the field the owner pointed at', () => {
    // "the coin type would have made that obvious" — the owner's own words.
    expect(inferMetalContent({ coinType: 'Gold Eagle' })).toBe('Gold');
    expect(inferMetalContent({ coinType: 'American Silver Eagle' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Gold Dollar' })).toBe('Gold');
    expect(inferMetalContent({ coinType: 'Platinum Eagle' })).toBe('Platinum');
    expect(inferMetalContent({ coinType: 'Palladium Eagle' })).toBe('Palladium');
  });

  it('lets the coin type beat the denomination when the two could disagree', () => {
    // A "$10" is a gold Eagle by face value, but a 1/10 oz PLATINUM Eagle also
    // carries a $10 face. When the type says platinum, the type wins.
    expect(
      inferMetalContent({ coinType: 'Platinum Eagle', denomination: '$10', year: '1998' })
    ).toBe('Platinum');
  });

  it('does NOT read "CAC Gold" as the coin being gold', () => {
    // CAC Gold is a STICKER TIER, not a metal, and it sits on silver coins all
    // the time. The importer scrubs it; this module scrubs it again because a
    // coin type is free text and could have had it pasted in.
    expect(inferMetalContent({ coinType: 'Barber CAC Gold', year: '1900' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Gold CAC' })).toBeNull();
  });

  it('does NOT read "Nickel" in a type name as the metal nickel', () => {
    /* "Nickel" in a coin type names the DENOMINATION. A Jefferson Nickel dated
     * 1943 is 35% SILVER and a Three Cent Nickel is 75% copper, so the word is
     * wrong in both directions and is ignored entirely. */
    expect(inferMetalContent({ coinType: 'Jefferson Nickel', year: '1943' })).toBeNull();
    expect(inferMetalContent({ coinType: 'Three Cent Nickel', year: '1870' })).toBeNull();
  });

  it('reads the FIRST metal named when a type somehow names two', () => {
    // Compositions and descriptions follow a majority-first convention.
    expect(inferMetalContent({ coinType: 'Silver and Gold commemorative' })).toBe('Silver');
  });
});

/* ===========================================================================
 * RULE 2 — A DENOMINATION THAT IS GOLD BY DEFINITION
 * ---------------------------------------------------------------------------
 * Not a statistical claim: these face values were never struck in anything but
 * gold by the United States.
 * ======================================================================== */

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
    // This is the whole point of the fallback. The table stops the $20 at 1933
    // and the $5 at 1929; the FACE VALUE still settles the metal.
    expect(inferMetalContent({ denomination: '$20', year: '1934', country: 'United States' })).toBe('Gold');
    expect(inferMetalContent({ denomination: '$5', year: '1990', country: 'United States' })).toBe('Gold');
  });

  it('accepts the collector\'s "G$" shorthand', () => {
    // "G$1", "G$2.50", "G$3" — four of the owner's own securities are written
    // this way. The "G" is what settles a $1, never the "1".
    expect(inferMetalContent({ denomination: 'G$1', year: '1855' })).toBe('Gold');
    expect(inferMetalContent({ denomination: 'G$2.50', year: '1873' })).toBe('Gold');
  });

  it('treats "$2.50" and "$2.5" as the same denomination', () => {
    expect(inferMetalContent({ denomination: '$2.5', year: '1911' })).toBe('Gold');
  });

  it('REFUSES a bare "$1", because the US struck it in four different metals', () => {
    /* 1849-1889: a 26.73 g SILVER dollar AND a 1.672 g GOLD dollar, in the
     * same years. Add the clad Eisenhower, the Susan B. Anthony and the
     * manganese-brass Sacagawea and "$1" has worn four metals. The face value
     * alone cannot tell them apart, so it says nothing. */
    expect(inferMetalContent({ denomination: '$1', year: '1860', country: 'United States' })).toBeNull();
    expect(inferMetalContent({ denomination: '$1', year: '1921', country: 'United States' })).toBeNull();
  });

  it('only applies the rule to US coinage', () => {
    // Canada has struck BOTH gold and silver $20 coins, so a non-US "$20"
    // proves nothing at all.
    expect(inferMetalContent({ denomination: '$20', year: '2011', country: 'Canada' })).toBeNull();
  });

  it('REFUSES a modern "$10", because that face value is gold AND platinum', () => {
    /* The bullion programmes reused the old face values: $10 is the 1/4 oz
     * American GOLD Eagle and also the 1/10 oz American PLATINUM Eagle (1997
     * onward). The rule is switched off from 1986, the start of the bullion
     * era, unless a type name settles it. */
    expect(inferMetalContent({ denomination: '$10', year: '2005', country: 'United States' })).toBeNull();
    // ...but a classic Eagle is unaffected.
    expect(inferMetalContent({ denomination: '$10', year: '1901', country: 'United States' })).toBe('Gold');
  });

  it('says nothing about $25 or $50, where no safe year cutoff exists', () => {
    // $50 is the 1 oz Gold Eagle, the 1 oz Gold Buffalo, the 1/2 oz PLATINUM
    // Eagle and the 1915 Panama-Pacific commemorative, all at once.
    expect(inferMetalContent({ denomination: '$50', year: '1915', country: 'United States' })).toBeNull();
    expect(inferMetalContent({ denomination: '$25', year: '1995', country: 'United States' })).toBeNull();
  });
});

/* ===========================================================================
 * RULE 3 — SERIES NAMES THAT IMPLY A METAL
 * ======================================================================== */

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
      // Morgan and Peace dollars were revived in 2021 — in 99.9% SILVER — so
      // these two need no year band at all.
      expect(inferMetalContent({ coinType })).toBe('Silver');
    });
  }

  /* -------------------------------------------------------------------------
   * THE YEAR-GATED SILVER SERIES
   * -------------------------------------------------------------------------
   * US silver was interrupted by the Coinage Act of 1965, and several classic
   * designs were later revived in GOLD for collectors (2016 saw gold Mercury
   * dime, Standing Liberty quarter and Walking Liberty half centennials). So
   * the design name alone does NOT prove silver — the name plus the year does.
   * ---------------------------------------------------------------------- */
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
      // The gate is the point: a year-dependent rule must not fire on a record
      // that has no year.
      expect(inferMetalContent({ coinType })).toBeNull();
    });
  }

  it('reads the 1964 Kennedy half as silver and the 1965-70 40% issues as silver too', () => {
    // The Kennedy half is the one exception to the 1965 cliff: it kept 40%
    // silver for six more years. Less silver, but still silver.
    expect(inferMetalContent({ coinType: 'Kennedy', year: '1964' })).toBe('Silver');
    expect(inferMetalContent({ coinType: 'Kennedy', year: '1970' })).toBe('Silver');
  });

  /* -------------------------------------------------------------------------
   * THE NAMES DELIBERATELY LEFT OFF THE LIST
   * -------------------------------------------------------------------------
   * Every one of these names coins in more than one metal, and the name alone
   * cannot say which. The DENOMINATION plus the YEAR settles them wherever
   * they can be settled, and that is `lookupCoinAlloy`'s job, not this one's.
   * ---------------------------------------------------------------------- */
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

/* ===========================================================================
 * RULE 4 — THE COMPOSITION TEXT
 * ---------------------------------------------------------------------------
 * The trap the brief calls out: composition strings name several metals,
 * majority first, so a naive "contains Copper" test turns a Double Eagle into
 * a copper coin.
 * ======================================================================== */

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
    /* The 1943-45 wartime nickel is "56% Copper, 35% Silver, 9% Manganese" and
     * pm-reference.ts records its Metal as SILVER, not copper. Metal Content
     * feeds the melt calculation, so the precious component is the answer the
     * field is actually asking for. Matching the reference table here is what
     * stops an imported coin and a backfilled coin disagreeing. */
    expect(metalFromComposition('56% Copper, 35% Silver, 9% Manganese (wartime alloy)')).toBe('Silver');
  });

  it('reads a plating as a skin, not as the coin', () => {
    // "Copper-plated zinc" is a zinc cent, not a copper one; "Zinc-coated
    // steel" is the 1943 steel cent.
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
    // A coin typed as a Morgan with a nonsense composition is still silver.
    expect(
      inferMetalContentDetailed({ coinType: 'Morgan', composition: '100% Copper' })?.rule
    ).toBe('series-name');
  });
});

/* ===========================================================================
 * THE OUTPUT VOCABULARY
 * ---------------------------------------------------------------------------
 * Whatever this module produces has to be one of the values seeded into the
 * `MetalContents` table by `server/setup-database.sql`, or the coin editor's
 * <select> cannot display it.
 * ======================================================================== */

describe('the output vocabulary', () => {
  /** Copied verbatim from the INSERT INTO MetalContents in setup-database.sql. */
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
    // "Electrum" is a real alloy and a real thing to collect, but it is not in
    // MetalContents, so claiming it would produce an un-editable field.
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

/* ===========================================================================
 * STAYING CONSERVATIVE — the cases that must stay blank
 * ---------------------------------------------------------------------------
 * "Only assume when the evidence is strong, otherwise leave it and let the
 * user decide." The owner's standing principle, applied here because Metal
 * Content feeds the melt calculation.
 * ======================================================================== */

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
    /* A coin filed under "Gold Coins" is a statement about the owner's filing
     * cabinet, not about the coin. Collections routinely keep a silver token
     * or a copper medal in a gold folder. `category` is not even a field this
     * module accepts, which is the strongest form this guarantee can take —
     * the test asserts that passing it changes nothing. */
    const withCategory = { category: 'Gold Coins', denomination: '1¢', year: '1909' } as Record<string, string>;

    expect(inferMetalContent(withCategory)).toBeNull();
  });
});

/* ===========================================================================
 * THE WIRING — composePmFields keeps the reference table authoritative
 * ======================================================================== */

describe('composePmFields — the fallback never displaces the reference table', () => {
  it('uses the catalogued answer unchanged when there is one', () => {
    const fields = composePmFields('$20', '1927', 'United States', undefined, {
      // Deliberately a coin type that would also infer Gold. The catalogued
      // row must still be what comes back, all five fields intact.
      coinType: 'Saint-Gaudens'
    });

    expect(fields).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      // The GROSS weight of the coin, which only the catalogued row can
      // supply — see the next test for what happens without one.
      weight: 33.436
    });
  });

  it('supplies the metal ALONE when the table has no row', () => {
    /* A 1934 $20 is outside every year band in pm-reference.ts, so the table
     * answers nothing. It is still unarguably gold — but how many grams of
     * gold is a different question, and one this module refuses to invent. */
    const fields = composePmFields('$20', '1934', 'United States');

    expect(fields).toEqual({ metalContent: 'Gold' });
    expect(fields?.composition).toBeUndefined();
    expect(fields?.pmPercent).toBeUndefined();
    expect(fields?.pmWeightGrams).toBeUndefined();
    // Nor a gross weight. The coarse fallback reasons about METAL only; it
    // has no idea what planchet an uncatalogued issue was struck on.
    expect(fields?.weight).toBeUndefined();
  });

  it('never fills the unknown fields with zeros or empty strings', () => {
    // A pmWeightGrams of 0 would be a lie that computeMeltValue reads as a
    // recorded fact; an empty composition would look like somebody checked.
    const fields = composePmFields('', '', 'France', 'Gold');

    expect(Object.keys(fields ?? {})).toEqual(['metalContent']);
    expect(fields?.metalContent).toBe('Gold');
  });

  it('reads the coin type when nothing else is known', () => {
    // No catalogued row for a French 20 Francs, and no US denomination rule —
    // but a coin type naming the metal settles it on its own.
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

/* ===========================================================================
 * REAL DATA — GoldCoins.QIF
 * ---------------------------------------------------------------------------
 * All 44 distinct security names from the `Gold Coins` account of the owner's
 * own export, VERBATIM. Nothing here should be tidied: the missing hyphen in
 * "1900 $20 PCGS/CAC MS63", the "G$" prefixes, the bare "1885 $5" with no
 * grade and the lone non-US entry are all real.
 *
 * This is the file the owner's report was about — "when I just imported in all
 * the gold coins, every one of those should have had the content set to Gold
 * automatically". So the headline assertion is simply: all 44, all Gold.
 * ======================================================================== */

/** Every distinct `Y` (security name) line in the Gold Coins account. */
const GOLD_COINS_QIF_SECURITIES: readonly string[] = [
  '1835 $5 - NGC/CAC XF45',
  '1849-O $1 Gold - ANACS XF45',
  '1854 G$3 - PCGS/CAC AU50',
  '1855 $3 - PCGS/CAC VF35',
  '1855 G$1 - PCGS/CAC AU50',
  '1856 $3 - PCGS/CAC AU50',
  '1857 $3 - NGC/CAC AU55',
  '1857-S $3 - NGC F15',
  '1859 $3 - NGC/CAC AU55',
  '1867 $3 - PCGS AU53',
  '1873 Open 3 G$1 - ANACS AU58',
  '1873 Open 3 G$2.50 - ANACS AU53',
  '1874 $3 - NGC AU58',
  '1878 $3 - PCGS/CAC AU58',
  '1885 $5',
  '1893 $5 - PCI AU50',
  '1895 $10 - ANACS MS61',
  '1900 $20 PCGS/CAC MS63',
  '1900 $5 - ANACS AU55',
  '1904 $20 - NGC MS63',
  '1904 $20 - PCGS MS63',
  '1906-S $5',
  '1907 $20 Liberty - PCGS/CAC MS62',
  '1908 $5 - PCGS/CAC XF45',
  '1908 NM $20 - NGC/CAC MS64',
  '1908 NM $20 - PCGS/CAC MS64',
  '1908 WM $10 - NGC/CAC MS61',
  '1909 $5 - PCGS/CAC XF40',
  '1910D $10 - PCGS MS63',
  '1911 $2.50',
  '1911 $2.50 Gold Indian - ANACS AU58',
  '1913 $2.50 Gold Indian - ANACS AU55',
  '1913-S $5 - PCGS XF40',
  '1914-S $5 - PCGS XF40',
  '1915-S $20 - NGC MS64',
  '1915-S $5 - PCGS XF40',
  '1920 $20 - PCGS MS63',
  '1924 $20 - PCGS/CAC MS64+',
  '1925 $20 - NGC/CAC MS64',
  '1925 $20 - PCGS MS64',
  '1926 $20 - PCGS MS64',
  '1927 $20 - PCGS MS64',
  '1932 $10 - PCGS MS63',
  '1969 Peru 100 Soles - NGC MS64'
];

/**
 * Runs one real security name through the FULL import, exactly as the import
 * button does, and returns the record it produced.
 */
function importedCoin(securityName: string) {
  const service = new QuickenImportService();
  const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
  const result = service.parse(qif);
  expect(result.importedRecords, `"${securityName}" should import`).toHaveLength(1);
  return result.importedRecords[0];
}

describe('GoldCoins.QIF — the owner\'s own import, end to end', () => {
  it('contains the 44 distinct securities this file was checked against', () => {
    expect(GOLD_COINS_QIF_SECURITIES).toHaveLength(44);
    expect(new Set(GOLD_COINS_QIF_SECURITIES).size).toBe(44);
  });

  it('gives every single one of them a Metal Content of Gold', () => {
    // The owner's expectation, stated as one assertion. If this ever fails,
    // the failure message names the coins that came out blank.
    const blank = GOLD_COINS_QIF_SECURITIES.filter(
      (name) => importedCoin(name).metalContent !== 'Gold'
    );

    expect(blank, 'these securities did not come out as Gold').toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * HOW MUCH OF THAT THE COARSE INFERENCE MANAGES ON ITS OWN
 * ---------------------------------------------------------------------------
 * The 44 above all pass through `lookupCoinAlloy` successfully, so the
 * fallback is never actually reached for this particular file. That is worth
 * writing down rather than leaving implied — and it is worth measuring what
 * the coarse rules WOULD have achieved unaided, because that is the capability
 * the next import of un-tabulated coins will depend on.
 *
 * The measurement below deliberately withholds the metal hint, so it tests the
 * coarse rules and nothing else.
 * ------------------------------------------------------------------------ */
describe('GoldCoins.QIF — what the coarse rules achieve unaided', () => {
  /** The parsed coin, with the metal hint deliberately NOT supplied. */
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
      // A "$1" is a silver dollar as often as a gold one, and "Liberty Head"
      // names the 5¢ nickel and the $20 as well as the Type 1 gold dollar.
      // Only the word "Gold" in the security name settles it — which is what
      // `metalHint` carries, and which is why the real import gets it right.
      '1849-O $1 Gold - ANACS XF45',
      // 1855 is a Gold Dollar transition year so the Coin Type is blank by
      // design, leaving a bare "$1". The "G$" shorthand settles it.
      '1855 G$1 - PCGS/CAC AU50',
      // A Peruvian 100 Soles is gold, but nothing in the record says so: no
      // metal word, no US denomination, no series name. The reference table
      // has a row for it; the coarse rules correctly refuse to guess.
      '1969 Peru 100 Soles - NGC MS64'
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
    // "1873 Open 3 G$1" parses to denomination "$1" — which says nothing — but
    // to Coin Type "Indian Princess", which is a gold-only design.
    expect(coarseMetalFor('1873 Open 3 G$1 - ANACS AU58')).toBe('Gold');
  });
});
