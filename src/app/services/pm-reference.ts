 /*
  * Reference table of coin compositions, answering two questions:
  *   1. lookupPmData()    how much precious metal is in it? (melt value;
  *                        a bronze cent answers null)
  *   2. lookupCoinAlloy() what is it made of and what does it weigh? Fills the
  *                        editor's Metal / Composition / PM % / PM weight / Weight
  *                        for every coin in the table, precious or base metal.
  *
  * When in doubt, answer nothing: a wrong purity silently gives a wrong melt
  * value; a blank is visible and fixable. Where one year/denomination had two
  * alloys in circulation there is deliberately no row (see "DELIBERATE GAP"):
  *   - 1942 Jefferson nickel   (cupronickel and 35% silver)
  *   - 1982 Lincoln cent       (bronze and copper-plated zinc)
  *   - 1971-1978 Eisenhower $1 (clad business strikes and 40% silver collector issues)
  * When two rows match but name different metals (e.g. "$1" in 1849-1889, silver
  * and gold dollars), the lookup returns null unless the caller passes a
  * `metalHint` (the security name said "Gold" or "G$1").
  *
  * Units (all grams):
  *   pmWeightGrams     weight of the pure precious metal, not the coin
  *   pmPercent         fineness as a percentage (90 = 90%)
  *   pmDescription     trade shorthand ("0.9675 oz AGW"; AGW/ASW = actual
  *                     gold/silver weight, i.e. pure content); oz x 31.1035 = grams
  *   grossWeightGrams  the whole coin, as a scale reads it
  *
  *   1927 $20 Saint-Gaudens:  grossWeightGrams 33.436, pmPercent 90,
  *                            pmWeightGrams 30.09 (0.9675 oz AGW)
  *
  * grossWeightGrams x (pmPercent / 100) = pmWeightGrams on every row with all
  * three; pm-reference.spec.ts checks this to 0.01 g (pmWeightGrams is published
  * to two decimals). `CoinRecord.weight` is in grams since migration 008.
  */

/**
 * Canonical Metal values. The editor's Metal <select> is fed by the
 * MetalContents table, seeded with exactly this list by server/setup-database.sql.
 * inventory-metrics.ts matches the substrings "gold"/"silver"/"platinum"/"copper"
 * to pick a spot price.
 */
export type CoinMetal =
  | 'Gold'
  | 'Silver'
  | 'Platinum'
  | 'Palladium'
  | 'Copper'
  | 'Nickel'
  | 'Copper-Nickel'
  | 'Bronze'
  | 'Brass'
  | 'Zinc'
  | 'Steel'
  | 'Aluminum'
  | 'Nickel-Brass'
  | 'Clad'
  | 'Other';

/**
 * One row of the reference table. Exported only so the spec can type
 * `PM_REFERENCE_ROWS`; app code should use `lookupCoinAlloy` / `lookupPmData`.
 */
export interface PmEntry {
  /** Denomination as the parser normalises it ("$20", "50¢", "100 Soles"). */
  denomination: string;
  /** Inclusive year range; undefined matches all years. */
  yearRange?: { min: number; max: number };
  /** Canonical Metal value (see CoinMetal). */
  metal: CoinMetal;
  /** Free-text alloy description for the Composition field, e.g. "90% Gold, 10% Copper". */
  composition: string;
  /** Pure precious metal weight in grams; omitted for base-metal coins. */
  pmWeightGrams?: number;
  /** Fineness as a percentage (90 = 90%); omitted for base-metal coins. */
  pmPercent?: number;
  /** Trade shorthand, e.g. "0.9675 oz AGW". */
  pmDescription?: string;
  /**
   * The whole coin's weight in grams. Present on base-metal rows too; omitted only
   * on the large cent and half cent rows, which each span two planchet standards.
   * Must satisfy grossWeightGrams * pmPercent / 100 === pmWeightGrams (checked by
   * the spec).
   */
  grossWeightGrams?: number;
  /** Country filter; omitted entries match any country. */
  country?: string;
  /**
   * When true, the row only matches if the caller passes a matching `metalHint`.
   * For issues indistinguishable by face value and year from a commoner coin,
   * e.g. 90% silver proof dimes and quarters from 1992 vs the clad ones.
   */
  requiresHint?: boolean;
}

/**
 * Organised by country, then metal, then date. Year ranges within one
 * country+denomination never overlap; boundary years are explained at the row.
 */
const PM_REFERENCE_DATA: PmEntry[] = [
   /*
    * United States: gold. Three standards, told apart only by year:
    *   1795-1834  91.67% (11/12 fine) on a heavy planchet; most was melted, so rare
    *   1834-1838  Act of 1834: lighter planchet, 0.8992 fine (Classic Head era)
    *   1837/1839+ Act of 1837: 0.900 fine until gold coinage ended in 1933
    * The $5 and $2.50 pure weights barely moved 1834-1839: the 1837 fineness
    * increase offset the 1834 planchet cut.
    */

  // Gold Dollar (1849-1889): one specification, 1.672 g at 0.900. Its year range
  // separates it from the silver "$1" (see `resolveEntry`).
  {
    denomination: '$1',
    yearRange: { min: 1849, max: 1889 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 1.50,
    pmPercent: 90,
    // The smallest US coin ever struck.
    grossWeightGrams: 1.672,
    pmDescription: '0.0484 oz AGW',
    country: 'United States'
  },

  // Quarter Eagle ($2.50)
  {
    denomination: '$2.50',
    yearRange: { min: 1796, max: 1833 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 4.01,
    pmPercent: 91.67,
    // Heavy pre-1834 planchet.
    grossWeightGrams: 4.37,
    pmDescription: '0.1289 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$2.50',
    yearRange: { min: 1834, max: 1839 },
    metal: 'Gold',
    composition: '89.92% Gold, 10.08% Silver and Copper',
    pmWeightGrams: 3.76,
    pmPercent: 89.92,
    // The 1834 Act cut the planchet to 4.18 g; the 1837 Act changed only the
    // fineness, so the next row shares this weight.
    grossWeightGrams: 4.18,
    pmDescription: '0.1209 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$2.50',
    yearRange: { min: 1840, max: 1929 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 3.76,
    pmPercent: 90,
    // Same planchet as the row above; only the fineness changed in 1837.
    grossWeightGrams: 4.18,
    pmDescription: '0.1209 oz AGW',
    country: 'United States'
  },

  // Three Dollar (1854-1889, one specification): 0.1452 oz AGW.
  {
    denomination: '$3',
    yearRange: { min: 1854, max: 1889 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 4.52,
    pmPercent: 90,
    // 5.015 g x 0.900 = 4.5135 g of gold.
    grossWeightGrams: 5.015,
    pmDescription: '0.1452 oz AGW',
    country: 'United States'
  },

  // Half Eagle ($5)
  {
    denomination: '$5',
    yearRange: { min: 1795, max: 1833 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 8.02,
    pmPercent: 91.67,
    // Twice the pre-1834 quarter eagle; cut to 8.36 g in 1834.
    grossWeightGrams: 8.75,
    pmDescription: '0.2578 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$5',
    yearRange: { min: 1834, max: 1838 },
    metal: 'Gold',
    composition: '89.92% Gold, 10.08% Silver and Copper',
    pmWeightGrams: 7.52,
    pmPercent: 89.92,
    // Classic Head planchet under the Act of 1834.
    grossWeightGrams: 8.36,
    pmDescription: '0.2418 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$5',
    yearRange: { min: 1839, max: 1929 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 7.52,
    pmPercent: 90,
    // Statutory 129 grains; often quoted as 8.36 g.
    grossWeightGrams: 8.359,
    pmDescription: '0.2419 oz AGW',
    country: 'United States'
  },

  // Eagle ($10). None struck 1805-1837, so no Classic Head row.
  {
    denomination: '$10',
    yearRange: { min: 1795, max: 1804 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 16.04,
    pmPercent: 91.67,
    // Twice the pre-1834 half eagle.
    grossWeightGrams: 17.50,
    pmDescription: '0.5156 oz AGW',
    country: 'United States'
  },
  {
    denomination: '$10',
    yearRange: { min: 1838, max: 1933 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 15.05,
    pmPercent: 90,
    // Twice the half eagle, half the double eagle: the 0.900 series scales with face value.
    grossWeightGrams: 16.718,
    pmDescription: '0.4837 oz AGW',
    country: 'United States'
  },

  // Double Eagle ($20): 1849-1933, always 0.900.
  {
    denomination: '$20',
    yearRange: { min: 1849, max: 1933 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 30.09,
    pmPercent: 90,
    // 33.436 g x 0.900 = 30.09 g of gold.
    grossWeightGrams: 33.436,
    pmDescription: '0.9675 oz AGW',
    country: 'United States'
  },

   /*
    * United States: silver. Standards for the dime, quarter and half:
    *   1792 Act  0.8924 fine on a heavy planchet
    *   1837 Act  0.900 on a slightly lighter planchet, same pure content (so
    *             1792 and 1837 share one range)
    *   1853 Act  planchets cut ~7% so coins weren't melted ("arrows at the date")
    *   1873 Act  planchets raised slightly to metric-round weights (quarter 6.25 g),
    *             held until 1964
    * The Coinage Act of 1965 removed silver from the dime and quarter outright,
    * so every silver row stops at 1964.
    */

  // Silver Dollar (1794-1935). One row: both standards give the same content:
  //   1794-1803   26.96 g x 0.8924 = 24.06 g
  //   1836-1935   26.73 g x 0.900  = 24.06 g
  // The 1873-1885 Trade Dollar (27.22 g, 24.49 g silver) shares "$1" and is not
  // separated; the 1.8% difference is within melt-estimate noise.
  {
    denomination: '$1',
    yearRange: { min: 1794, max: 1935 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 24.06,
    pmPercent: 90,
     // The 1837-onward planchet (Seated, Morgan, Peace...); 1794-1803 dollars were
     // 26.96 g at 0.8924, with the same pure silver.
    grossWeightGrams: 26.73,
    pmDescription: '0.7734 oz ASW',
    country: 'United States'
  },

  // Half Dollar
  {
    denomination: '50¢',
    yearRange: { min: 1794, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 12.03,
    pmPercent: 89.24,
    // 1792 standard (13.48 g at 0.8924); the 1837 13.36 g at 0.900 holds the same
    // 12.03 g of silver.
    grossWeightGrams: 13.48,
    pmDescription: '0.3867 oz ASW',
    country: 'United States'
  },
  {
    denomination: '50¢',
    yearRange: { min: 1853, max: 1872 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 11.20,
    pmPercent: 90,
    // "Arrows at the date" planchet, cut ~7% by the Act of 1853.
    grossWeightGrams: 12.44,
    pmDescription: '0.3600 oz ASW',
    country: 'United States'
  },
  {
    denomination: '50¢',
    yearRange: { min: 1873, max: 1964 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 11.25,
    pmPercent: 90,
    // The Act of 1873's 12.5 g: Barber, Walking Liberty, Franklin, 1964 Kennedy.
    grossWeightGrams: 12.50,
    pmDescription: '0.3617 oz ASW',
    country: 'United States'
  },
  // Kennedy half 1965-1970: 40% silver overall (80% outer layers on a 21% core).
  //   11.50 g x 0.40 = 4.60 g of silver = 0.1479 oz ASW.
  {
    denomination: '50¢',
    yearRange: { min: 1965, max: 1970 },
    metal: 'Silver',
    composition: '40% Silver clad (80% silver outer layers, 21% silver core)',
    pmWeightGrams: 4.60,
    pmPercent: 40,
    grossWeightGrams: 11.50,
    pmDescription: '0.1479 oz ASW',
    country: 'United States'
  },
  // 1971 onward: copper-nickel clad, no silver.
  {
    denomination: '50¢',
    yearRange: { min: 1971, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // No precious metal, but the weight is still filled in.
    grossWeightGrams: 11.34,
    country: 'United States'
  },

  // Quarter
  {
    denomination: '25¢',
    yearRange: { min: 1796, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 6.01,
    pmPercent: 89.24,
    // Half the 13.48 g half dollar (the 1837 6.68 g at 0.900 holds the same 6.01 g).
    grossWeightGrams: 6.74,
    pmDescription: '0.1933 oz ASW',
    country: 'United States'
  },
  {
    denomination: '25¢',
    yearRange: { min: 1853, max: 1872 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 5.60,
    pmPercent: 90,
    // Half the 12.44 g "arrows" half dollar.
    grossWeightGrams: 6.22,
    pmDescription: '0.1800 oz ASW',
    country: 'United States'
  },
  {
    denomination: '25¢',
    yearRange: { min: 1873, max: 1964 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 5.63,
    pmPercent: 90,
    // The Act of 1873's 6.25 g: Barber, Standing Liberty, silver Washington.
    grossWeightGrams: 6.25,
    pmDescription: '0.1808 oz ASW',
    country: 'United States'
  },
  {
    denomination: '25¢',
    yearRange: { min: 1965, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // Lighter than the silver quarter: the copper core is less dense.
    grossWeightGrams: 5.67,
    country: 'United States'
  },
  // Silver proof quarters from 1992 (90%; 99.9% from 2019). Same year as clad,
  // so this row only matches when the security name says "silver".
  {
    denomination: '25¢',
    yearRange: { min: 1992, max: 2100 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper (silver proof issue)',
    pmWeightGrams: 5.63,
    pmPercent: 90,
    // The pre-1965 silver planchet.
    grossWeightGrams: 6.25,
    pmDescription: '0.1808 oz ASW',
    country: 'United States',
    requiresHint: true
  },

  // Dime
  {
    denomination: '10¢',
    yearRange: { min: 1796, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 2.41,
    pmPercent: 89.24,
    // A fifth of the 13.48 g half (the 1837 2.67 g at 0.900 holds the same 2.41 g).
    grossWeightGrams: 2.70,
    pmDescription: '0.0773 oz ASW',
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1853, max: 1872 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 2.24,
    pmPercent: 90,
    // A fifth of the 12.44 g "arrows" half dollar.
    grossWeightGrams: 2.49,
    pmDescription: '0.0720 oz ASW',
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1873, max: 1964 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 2.25,
    pmPercent: 90,
    // The Act of 1873's 2.5 g: Barber, Mercury, silver Roosevelt.
    grossWeightGrams: 2.50,
    pmDescription: '0.0723 oz ASW',
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1965, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // Set as exactly 35 grains, so not a round metric figure.
    grossWeightGrams: 2.268,
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1992, max: 2100 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper (silver proof issue)',
    pmWeightGrams: 2.25,
    pmPercent: 90,
    // The pre-1965 silver planchet.
    grossWeightGrams: 2.50,
    pmDescription: '0.0723 oz ASW',
    country: 'United States',
    requiresHint: true
  },

  // Twenty Cent (1875-1878)
  {
    denomination: '20¢',
    yearRange: { min: 1875, max: 1878 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 4.50,
    pmPercent: 90,
    // Exactly 5 g; easily confused with the 6.25 g quarter.
    grossWeightGrams: 5.00,
    pmDescription: '0.1447 oz ASW',
    country: 'United States'
  },

  // Half Dime: the silver five-cent piece, 1794-1873. Circulated alongside the
  // nickel from 1866 to 1873.
  {
    denomination: '5¢',
    yearRange: { min: 1794, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 1.20,
    pmPercent: 89.24,
    // Half the 2.70 g dime (the 1837 1.34 g at 0.900 holds the same 1.20 g).
    grossWeightGrams: 1.35,
    pmDescription: '0.0386 oz ASW',
    country: 'United States'
  },
  {
    denomination: '5¢',
    yearRange: { min: 1853, max: 1873 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 1.12,
    pmPercent: 90,
    // Half the 2.49 g "arrows" dime.
    grossWeightGrams: 1.24,
    pmDescription: '0.0360 oz ASW',
    country: 'United States'
  },

  // Three Cent Silver ("trime", 1851-1873). 0.750 fine for its first three years
  // only (an anti-hoarding measure reversed in 1853).
  {
    denomination: '3CS',
    yearRange: { min: 1851, max: 1853 },
    metal: 'Silver',
    composition: '75% Silver, 25% Copper',
    pmWeightGrams: 0.60,
    pmPercent: 75,
    // The lightest US coin ever struck.
    grossWeightGrams: 0.80,
    pmDescription: '0.0193 oz ASW',
    country: 'United States'
  },
  {
    denomination: '3CS',
    yearRange: { min: 1854, max: 1873 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 0.675,
    pmPercent: 90,
    // The 1853 Act made it lighter but finer, so the silver content rose.
    grossWeightGrams: 0.75,
    pmDescription: '0.0217 oz ASW',
    country: 'United States'
  },

   /*
    * United States: base metal. No pmWeightGrams or pmPercent, so `lookupPmData`
    * answers null while `lookupCoinAlloy` still fills Metal and Composition. They
    * do carry grossWeightGrams for the Weight field.
    */

  // Five cents, the nickel (1866 onward): always 5.00 g, including the 35% silver
  // wartime issue; only the alloy changed.
  {
    denomination: '5¢',
    yearRange: { min: 1866, max: 1941 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 5.00,
    country: 'United States'
  },
  // DELIBERATE GAP: 1942. Both the cupronickel and the silver war alloy were
  // struck in 1942, told apart only by the large mint mark, which a Quicken name
  // doesn't carry. No row, so the lookup returns null.
  {
    denomination: '5¢',
    yearRange: { min: 1943, max: 1945 },
    metal: 'Silver',
    composition: '56% Copper, 35% Silver, 9% Manganese (wartime alloy)',
    pmWeightGrams: 1.75,
    pmPercent: 35,
    // 5.00 g x 0.35 = 1.75 g of silver.
    grossWeightGrams: 5.00,
    pmDescription: '0.0563 oz ASW',
    country: 'United States'
  },
  {
    denomination: '5¢',
    yearRange: { min: 1946, max: 2100 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 5.00,
    country: 'United States'
  },

  // One Cent
  {
    denomination: '1¢',
    yearRange: { min: 1793, max: 1857 },
    metal: 'Copper',
    composition: '100% Copper (large cent)',
     /*
      * No gross weight: the large cent was struck on two planchets that this row
      * spans (13.48 g for 1793-1795, 10.89 g for late 1795-1857). Unlike the silver
      * standards, these differ by 24%, and splitting the row would change matching.
      */
    country: 'United States'
  },
  {
    denomination: '1¢',
    yearRange: { min: 1856, max: 1863 },
    metal: 'Copper-Nickel',
    composition: '88% Copper, 12% Nickel',
    // The thick copper-nickel planchet (Flying Eagle, early Indian Head).
    grossWeightGrams: 4.67,
    country: 'United States'
  },
  {
    denomination: '1¢',
    yearRange: { min: 1864, max: 1942 },
    metal: 'Bronze',
    composition: '95% Copper, 5% Tin and Zinc',
    grossWeightGrams: 3.11,
    country: 'United States'
  },
  // 1943 only: zinc-coated steel (copper went to the war effort).
  {
    denomination: '1¢',
    yearRange: { min: 1943, max: 1943 },
    metal: 'Steel',
    composition: 'Zinc-coated steel',
    // Steel is less dense than bronze: 2.70 g vs 3.11 g.
    grossWeightGrams: 2.70,
    country: 'United States'
  },
  {
    denomination: '1¢',
    yearRange: { min: 1944, max: 1981 },
    metal: 'Bronze',
    composition: '95% Copper, 5% Zinc',
    grossWeightGrams: 3.11,
    country: 'United States'
  },
  // DELIBERATE GAP: 1982. The cent changed from bronze (3.11 g) to copper-plated
  // zinc (2.50 g) partway through the year; same date and design. No row.
  {
    denomination: '1¢',
    yearRange: { min: 1983, max: 2100 },
    metal: 'Zinc',
    composition: 'Copper-plated zinc (97.5% Zn, 2.5% Cu)',
    grossWeightGrams: 2.50,
    country: 'United States'
  },

  // Two Cent (1864-1873) and Three Cent Nickel (1865-1889)
  {
    denomination: '2¢',
    yearRange: { min: 1864, max: 1873 },
    metal: 'Bronze',
    composition: '95% Copper, 5% Tin and Zinc',
    // Twice the 3.11 g bronze cent.
    grossWeightGrams: 6.22,
    country: 'United States'
  },
  {
    denomination: '3CN',
    yearRange: { min: 1865, max: 1889 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 1.94,
    country: 'United States'
  },

  // Half Cent (1793-1857)
  {
    denomination: '½¢',
    yearRange: { min: 1793, max: 1857 },
    metal: 'Copper',
    composition: '100% Copper',
    // No gross weight, as for the large cent: 6.74 g for 1793-1795, then 5.44 g.
    country: 'United States'
  },

  // Modern base-metal dollars.
  // DELIBERATE GAP: 1971-1978 Eisenhower dollar (clad business strikes and 40%
  // silver collector issues, indistinguishable by name). No rows for those years.
  {
    denomination: '$1',
    yearRange: { min: 1979, max: 1999 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // Susan B. Anthony: 8.1 g, matching the later Sacagawea for vending machines.
    grossWeightGrams: 8.1,
    country: 'United States'
  },
  {
    denomination: '$1',
    yearRange: { min: 2000, max: 2100 },
    metal: 'Brass',
    composition: 'Manganese brass (88.5% Cu, 6% Zn, 3.5% Mn, 2% Ni)',
    // Sacagawea / Presidential: 8.1 g.
    grossWeightGrams: 8.1,
    country: 'United States'
  },

   /*
    * Great Britain:
    *   1920  sterling (92.5%) reduced to 50% silver
    *   1947  silver removed; the same denominations continued in cupronickel
    * The Sovereign has been 22 carat (91.67%) gold since 1817.
    */

  // Gold
  {
    denomination: 'Sovereign',
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Copper (22 carat crown gold)',
    pmWeightGrams: 7.32,
    pmPercent: 91.67,
    // 7.98805 g by statute since 1817 (usually quoted as 7.99 g).
    grossWeightGrams: 7.988,
    pmDescription: '0.2354 oz AGW',
    country: 'Great Britain'
  },
  {
    denomination: '½ Sovereign',
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Copper (22 carat crown gold)',
    pmWeightGrams: 3.66,
    pmPercent: 91.67,
    // Half the Sovereign.
    grossWeightGrams: 3.994,
    pmDescription: '0.1177 oz AGW',
    country: 'Great Britain'
  },

  /* Sterling silver, 1707-1919 (92.5%).
   * The Coinage Act of 1816 fixed gross weights that never changed afterwards,
   * through 1920 and 1947; only the alloy changed. So a British silver coin's
   * gross weight depends only on its denomination:
   *     Crown       28.2759 g   (quoted as 28.276)
   *     Half Crown  14.1379 g   (14.138)
   *     Florin      11.3104 g   (11.310)
   *     Shilling     5.6552 g   (5.655)
   */
  {
    denomination: 'Crown',
    yearRange: { min: 1707, max: 1919 },
    metal: 'Silver',
    composition: '92.5% Silver, 7.5% Copper (sterling)',
    pmWeightGrams: 26.16,
    pmPercent: 92.5,
    grossWeightGrams: 28.276,
    pmDescription: '0.8410 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Half Crown',
    yearRange: { min: 1707, max: 1919 },
    metal: 'Silver',
    composition: '92.5% Silver, 7.5% Copper (sterling)',
    pmWeightGrams: 13.08,
    pmPercent: 92.5,
    grossWeightGrams: 14.138,
    pmDescription: '0.4205 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Florin',
    yearRange: { min: 1849, max: 1919 },
    metal: 'Silver',
    composition: '92.5% Silver, 7.5% Copper (sterling)',
    pmWeightGrams: 10.46,
    pmPercent: 92.5,
    grossWeightGrams: 11.310,
    pmDescription: '0.3364 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Shilling',
    yearRange: { min: 1707, max: 1919 },
    metal: 'Silver',
    composition: '92.5% Silver, 7.5% Copper (sterling)',
    pmWeightGrams: 5.23,
    pmPercent: 92.5,
    grossWeightGrams: 5.655,
    pmDescription: '0.1682 oz ASW',
    country: 'Great Britain'
  },

  // Debased silver, 1920-1946 (50%). Same gross weights, so pure = gross x 0.50:
  //     Crown       28.28 g x 0.50 = 14.14 g
  //     Half Crown  14.14 g x 0.50 =  7.07 g
  //     Florin      11.31 g x 0.50 =  5.66 g
  //     Shilling     5.66 g x 0.50 =  2.83 g
  {
    denomination: 'Crown',
    yearRange: { min: 1920, max: 1946 },
    metal: 'Silver',
    composition: '50% Silver, 40% Copper, 10% Nickel',
    pmWeightGrams: 14.14,
    pmPercent: 50,
    // Same disc as the sterling crown; only the fineness changed.
    grossWeightGrams: 28.276,
    pmDescription: '0.4546 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Half Crown',
    yearRange: { min: 1920, max: 1946 },
    metal: 'Silver',
    composition: '50% Silver, 40% Copper, 10% Nickel',
    pmWeightGrams: 7.07,
    pmPercent: 50,
    grossWeightGrams: 14.138,
    pmDescription: '0.2273 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Florin',
    yearRange: { min: 1920, max: 1946 },
    metal: 'Silver',
    composition: '50% Silver, 40% Copper, 10% Nickel',
    pmWeightGrams: 5.66,
    pmPercent: 50,
    grossWeightGrams: 11.310,
    pmDescription: '0.1819 oz ASW',
    country: 'Great Britain'
  },
  {
    denomination: 'Shilling',
    yearRange: { min: 1920, max: 1946 },
    metal: 'Silver',
    composition: '50% Silver, 40% Copper, 10% Nickel',
    pmWeightGrams: 2.83,
    pmPercent: 50,
    grossWeightGrams: 5.655,
    pmDescription: '0.0909 oz ASW',
    country: 'Great Britain'
  },

  // Cupronickel, 1947 onward (no silver). Same gross weights, quoted as usually
  // published (28.28 / 14.14 / 11.31 / 5.66).
  {
    denomination: 'Crown',
    yearRange: { min: 1947, max: 2100 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 28.28,
    country: 'Great Britain'
  },
  {
    denomination: 'Half Crown',
    yearRange: { min: 1947, max: 1970 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 14.14,
    country: 'Great Britain'
  },
  {
    denomination: 'Florin',
    yearRange: { min: 1947, max: 1970 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 11.31,
    country: 'Great Britain'
  },
  {
    denomination: 'Shilling',
    yearRange: { min: 1947, max: 1970 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 5.66,
    country: 'Great Britain'
  },

   /*
    * Peru: the 1950-1970 gold Soles series. 0.900 fine, gross weight proportional
    * to face value (100 Soles 46.8069 g, 50 Soles half that, ...).
    *   46.8069 g x 0.900 = 42.13 g of gold = 1.3544 oz AGW
    * (Matches the "1.3544 ounces of gold" memo on a real "1969 Peru 100 Soles" security.)
    */
  {
    denomination: '100 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 42.13,
    pmPercent: 90,
    // 46.8069 g x 0.900 = 42.13 g; 42.13 / 31.1035 = 1.3544 oz AGW.
    grossWeightGrams: 46.8069,
    pmDescription: '1.3544 oz AGW',
    country: 'Peru'
  },
  {
    denomination: '50 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 21.06,
    pmPercent: 90,
    // Half the 100 Soles.
    grossWeightGrams: 23.4035,
    pmDescription: '0.6772 oz AGW',
    country: 'Peru'
  },
  {
    denomination: '20 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 8.43,
    pmPercent: 90,
    grossWeightGrams: 9.3614,
    pmDescription: '0.2709 oz AGW',
    country: 'Peru'
  },
  {
    denomination: '10 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 4.21,
    pmPercent: 90,
    grossWeightGrams: 4.6807,
    pmDescription: '0.1354 oz AGW',
    country: 'Peru'
  },
  {
    denomination: '5 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 2.11,
    pmPercent: 90,
    grossWeightGrams: 2.3403,
    pmDescription: '0.0677 oz AGW',
    country: 'Peru'
  }
];

/** Everything known about what a coin is made of. */
export interface CoinAlloy {
  /** Canonical Metal value for the editor's Metal dropdown. */
  metal: CoinMetal;
  /** Free-text alloy description for the Composition field. */
  composition: string;
  /** Pure precious metal weight in grams; undefined for base-metal coins. */
  pmWeightGrams?: number;
  /** Fineness as a percentage; undefined for base-metal coins. */
  pmPercent?: number;
  /** Trade shorthand such as "0.9675 oz AGW"; undefined for base-metal coins. */
  pmDescription?: string;
  /**
   * The whole coin's weight in grams, for the editor's Weight field. Undefined
   * only for the large cent and half cent.
   */
  grossWeightGrams?: number;
}

/**
 * Every row of the table, for tests only: the spec checks
 *     grossWeightGrams x (pmPercent / 100) === pmWeightGrams
 * on each row to catch mistyped weights. Readonly so app code goes through
 * `lookupCoinAlloy`.
 */
export const PM_REFERENCE_ROWS: readonly Readonly<PmEntry>[] = PM_REFERENCE_DATA;

/**
 * Leading 4-digit year from "1969", "1920-1930" (range) or "1862/1" (overdate);
 * null when there is none.
 */
function parseLeadingYear(year: string): number | null {
  const match = String(year ?? '').match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Core resolver; enforces "refuse to guess".
 *
 * @param metalHint metal stated in the security name ("1849-O $1 Gold",
 *   "1855 G$1"). Admits `requiresHint` rows and breaks a gold-vs-silver tie.
 */
function resolveEntry(
  denomination: string,
  year: string,
  country: string,
  metalHint?: string
): PmEntry | null {
  const denom = String(denomination ?? '').trim().toLowerCase();
  const nation = String(country ?? '').trim().toLowerCase();
  if (!denom || !nation) return null;

  const yearInt = parseLeadingYear(year);
  if (yearInt === null) return null;

  const hint = metalHint ? metalHint.trim().toLowerCase() : '';

  // 1. Every row for this denomination in this country.
  let candidates = PM_REFERENCE_DATA.filter(
    (entry) =>
      entry.denomination.toLowerCase() === denom &&
      (!entry.country || entry.country.toLowerCase() === nation)
  );

  // 2. With a hint, only rows in that metal survive ("1849-O $1 Gold" ->
  //    Gold Dollar). Without one, hint-only rows stay hidden.
  if (hint) {
    candidates = candidates.filter((entry) => entry.metal.toLowerCase() === hint);
  } else {
    candidates = candidates.filter((entry) => !entry.requiresHint);
  }
  if (candidates.length === 0) return null;

  // 3. Prefer rows whose year range contains the year; fall back to undated rows
  //    (e.g. the Sovereign) only when none match.
  const dated = candidates.filter(
    (entry) => entry.yearRange && yearInt >= entry.yearRange.min && yearInt <= entry.yearRange.max
  );
  const pool = dated.length > 0 ? dated : candidates.filter((entry) => !entry.yearRange);
  if (pool.length === 0) return null;

  // 4. If more than one metal survives (e.g. the 1849-1889 "$1"), the pair
  //    doesn't determine the alloy: answer nothing.
  const metals = new Set(pool.map((entry) => entry.metal));
  if (metals.size > 1) return null;

  return pool[0];
}

/**
 * What a coin is made of, for precious and base metal coins. Used by imports to
 * pre-fill the editor's Metal / Composition / PM % / PM weight fields.
 *
 * @param denomination normalised denomination ("50¢", "$20", "100 Soles")
 * @param year year string; ranges and overdates tolerated
 * @param country country name ("United States", "Great Britain", "Peru")
 * @param metalHint optional metal named in the source text
 * @returns the alloy, or null when the combination doesn't determine one
 */
export function lookupCoinAlloy(
  denomination: string,
  year: string,
  country: string,
  metalHint?: string
): CoinAlloy | null {
  const entry = resolveEntry(denomination, year, country, metalHint);
  if (!entry) return null;

  return {
    metal: entry.metal,
    composition: entry.composition,
    pmWeightGrams: entry.pmWeightGrams,
    pmPercent: entry.pmPercent,
    pmDescription: entry.pmDescription,
    // Absent on the large cent and half cent rows.
    grossWeightGrams: entry.grossWeightGrams
  };
}

/**
 * How much precious metal is in a coin: `lookupCoinAlloy` filtered to coins
 * with precious content, so a bronze cent returns null rather than 0 grams.
 * Use this for melt value; use `lookupCoinAlloy` to fill the editor.
 */
export function lookupPmData(
  denomination: string,
  year: string,
  country: string,
  metalHint?: string
): { pmWeightGrams: number; pmPercent: number; metal: CoinMetal; pmDescription: string } | null {
  const alloy = lookupCoinAlloy(denomination, year, country, metalHint);
  if (!alloy || alloy.pmWeightGrams === undefined || alloy.pmPercent === undefined) {
    return null;
  }

  return {
    pmWeightGrams: alloy.pmWeightGrams,
    pmPercent: alloy.pmPercent,
    metal: alloy.metal,
    pmDescription: alloy.pmDescription ?? ''
  };
}
