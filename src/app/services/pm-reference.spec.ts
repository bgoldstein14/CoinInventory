import { describe, expect, it } from 'vitest';
import { PM_REFERENCE_ROWS, lookupCoinAlloy, lookupPmData } from './pm-reference';

/**
 * Tests for the composition reference table:
 *   lookupPmData     precious metal only (melt value); null for base-metal coins
 *   lookupCoinAlloy  every coin in the table; fills Metal / Composition / PM % /
 *                    PM weight on import
 * Denominations use the QIF parser's format (25¢, 50¢, $1, $20, "100 Soles").
 * Where a year/denomination had two alloys in circulation the lookup must
 * return null rather than pick one.
 */
describe('pm-reference', () => {
  describe('lookupPmData', () => {
    // US silver (90%, pre-1965)

    it('returns PM data for 1960 US Quarter (90% silver)', () => {
      const data = lookupPmData('25¢', '1960', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(5.63, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1964 US Dime (90% silver)', () => {
      const data = lookupPmData('10¢', '1964', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(2.25, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1950 US Half Dollar (90% silver)', () => {
      const data = lookupPmData('50¢', '1950', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(11.25, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1921 US Dollar (Morgan/Peace, 90% silver)', () => {
      // After the Gold Dollar ended (1889), "$1" needs no metal hint.
      const data = lookupPmData('$1', '1921', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(24.06, 2);
      expect(data?.pmPercent).toBe(90);
    });

    // US 40% silver half dollars (1965-1970)

    it('returns PM data for 1967 US Half Dollar (40% silver)', () => {
      const data = lookupPmData('50¢', '1967', 'United States');
      expect(data).toBeDefined();
      // 11.50 g gross, 0.1479 oz ASW = 4.60 g pure silver (pmWeightGrams is pure weight).
      expect(data?.pmWeightGrams).toBeCloseTo(4.60, 2);
      expect(data?.pmPercent).toBe(40);
    });

    // US gold

    it('returns PM data for 1907 US Double Eagle (90% gold)', () => {
      const data = lookupPmData('$20', '1907', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(30.09, 2);
      expect(data?.pmPercent).toBe(90);
    });

    it('returns PM data for 1895 US Eagle (90% gold)', () => {
      const data = lookupPmData('$10', '1895', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(15.05, 2);
      expect(data?.pmPercent).toBe(90);
    });

    // British silver (50%, 1920-1946)

    it('returns PM data for 1945 GB Shilling (50% silver)', () => {
      const data = lookupPmData('Shilling', '1945', 'Great Britain');
      expect(data).toBeDefined();
      // Same 5.655 g planchet at half the fineness: 5.655 x 0.50 = 2.83 g.
      expect(data?.pmWeightGrams).toBeCloseTo(2.83, 2);
      expect(data?.pmPercent).toBe(50);
    });

    it('returns PM data for 1930 GB Florin (50% silver)', () => {
      const data = lookupPmData('Florin', '1930', 'Great Britain');
      expect(data).toBeDefined();
      // 11.31 g planchet x 0.50 = 5.66 g.
      expect(data?.pmWeightGrams).toBeCloseTo(5.66, 2);
      expect(data?.pmPercent).toBe(50);
    });

    it('still returns the sterling figure for a pre-1920 GB Shilling', () => {
      const data = lookupPmData('Shilling', '1910', 'Great Britain');
      expect(data?.pmPercent).toBe(92.5);
      expect(data?.pmWeightGrams).toBeCloseTo(5.23, 2);
    });

    // Unknown coins

    it('returns null for unknown country', () => {
      const data = lookupPmData('25¢', '1960', 'Unknown Country');
      expect(data).toBeNull();
    });

    it('returns null for unknown denomination', () => {
      const data = lookupPmData('Doubloon', '1800', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for post-silver year (clad US quarter)', () => {
      // Clad from 1965: the alloy is known, but there is no precious metal.
      const data = lookupPmData('25¢', '1980', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for missing parameters', () => {
      expect(lookupPmData('', '1960', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '1960', '')).toBeNull();
    });
  });

   /* Year-driven transitions: the alloy depends on the year as much as the denomination. */
  describe('year-driven alloy transitions', () => {
    it('1964 quarter is silver and 1965 quarter is clad', () => {
      const silver = lookupCoinAlloy('25¢', '1964', 'United States');
      expect(silver?.metal).toBe('Silver');
      expect(silver?.pmPercent).toBe(90);

      const clad = lookupCoinAlloy('25¢', '1965', 'United States');
      expect(clad?.metal).toBe('Clad');
      // Clad: a composition but no precious metal numbers.
      expect(clad?.composition).toContain('Copper-Nickel');
      expect(clad?.pmPercent).toBeUndefined();
      expect(clad?.pmWeightGrams).toBeUndefined();
    });

    it('1964 dime is silver and 1965 dime is clad', () => {
      expect(lookupCoinAlloy('10¢', '1964', 'United States')?.metal).toBe('Silver');
      expect(lookupCoinAlloy('10¢', '1965', 'United States')?.metal).toBe('Clad');
    });

    it('keeps the Kennedy half at 40% silver through 1970, then clad', () => {
      // The half dollar didn't go straight to clad in 1965.
      for (const year of ['1965', '1966', '1967', '1968', '1969', '1970']) {
        const alloy = lookupCoinAlloy('50¢', year, 'United States');
        expect(alloy?.pmPercent, `half dollar ${year}`).toBe(40);
      }
      expect(lookupCoinAlloy('50¢', '1971', 'United States')?.metal).toBe('Clad');
      expect(lookupCoinAlloy('50¢', '1964', 'United States')?.pmPercent).toBe(90);
    });

    it('treats 1943-1945 nickels as the 35% silver wartime alloy', () => {
      for (const year of ['1943', '1944', '1945']) {
        const alloy = lookupCoinAlloy('5¢', year, 'United States');
        expect(alloy?.metal, `nickel ${year}`).toBe('Silver');
        expect(alloy?.pmPercent, `nickel ${year}`).toBe(35);
        expect(alloy?.pmWeightGrams, `nickel ${year}`).toBeCloseTo(1.75, 2);
      }
      // Either side of the war years, plain cupronickel.
      expect(lookupCoinAlloy('5¢', '1941', 'United States')?.metal).toBe('Copper-Nickel');
      expect(lookupCoinAlloy('5¢', '1946', 'United States')?.metal).toBe('Copper-Nickel');
    });

    it('REFUSES to decide the 1942 nickel, which was struck in both alloys', () => {
      // Both alloys struck in 1942, told apart only by the mint mark.
      expect(lookupCoinAlloy('5¢', '1942', 'United States')).toBeNull();
      expect(lookupPmData('5¢', '1942', 'United States')).toBeNull();
    });

    it('REFUSES to decide the 1982 cent, which was struck in both alloys', () => {
      // Bronze and copper-plated zinc, same date and design.
      expect(lookupCoinAlloy('1¢', '1982', 'United States')).toBeNull();
      expect(lookupCoinAlloy('1¢', '1981', 'United States')?.metal).toBe('Bronze');
      expect(lookupCoinAlloy('1¢', '1983', 'United States')?.metal).toBe('Zinc');
    });

    it('REFUSES to decide the 1971-1978 Eisenhower dollar', () => {
      // Clad business strikes and 40% silver collector issues share the date.
      for (const year of ['1971', '1974', '1978']) {
        expect(lookupCoinAlloy('$1', year, 'United States'), `dollar ${year}`).toBeNull();
      }
    });

    it('knows the 1943 steel cent', () => {
      const alloy = lookupCoinAlloy('1¢', '1943', 'United States');
      expect(alloy?.metal).toBe('Steel');
      expect(alloy?.pmPercent).toBeUndefined();
    });
  });

  /* Gold vs silver at the same face value */
  describe('the gold dollar / silver dollar collision', () => {
    it('refuses to choose for a bare "$1" in the overlap years', () => {
      // 1849-1889: both a silver and a gold dollar.
      expect(lookupCoinAlloy('$1', '1855', 'United States')).toBeNull();
      expect(lookupPmData('$1', '1855', 'United States')).toBeNull();
    });

    it('resolves to the Gold Dollar when the name said gold', () => {
      const alloy = lookupCoinAlloy('$1', '1855', 'United States', 'Gold');
      expect(alloy?.metal).toBe('Gold');
      expect(alloy?.pmWeightGrams).toBeCloseTo(1.50, 2);
      expect(alloy?.pmPercent).toBe(90);
    });

    it('resolves to the Silver Dollar when the name said silver', () => {
      const alloy = lookupCoinAlloy('$1', '1855', 'United States', 'Silver');
      expect(alloy?.metal).toBe('Silver');
      expect(alloy?.pmWeightGrams).toBeCloseTo(24.06, 2);
    });

    it('needs no hint outside the overlap: 1878 silver, 1849 is a tie', () => {
      // The gold dollar ran to 1889, so 1878 is still a tie.
      expect(lookupCoinAlloy('$1', '1878', 'United States')).toBeNull();
      // After the gold dollar: silver.
      expect(lookupCoinAlloy('$1', '1890', 'United States')?.metal).toBe('Silver');
      // Before the gold dollar: silver.
      expect(lookupCoinAlloy('$1', '1848', 'United States')?.metal).toBe('Silver');
    });

    it('keeps silver-proof clad-era coins hidden unless silver is named', () => {
      // Clad unless the name says silver (the proof row needs a hint).
      expect(lookupCoinAlloy('25¢', '1999', 'United States')?.metal).toBe('Clad');
      const proof = lookupCoinAlloy('25¢', '1999', 'United States', 'Silver');
      expect(proof?.metal).toBe('Silver');
      expect(proof?.pmPercent).toBe(90);
    });
  });

  /* US gold standards by era */
  describe('US gold fineness by era', () => {
    it('uses 91.67% for pre-1834 gold', () => {
      expect(lookupCoinAlloy('$5', '1800', 'United States')?.pmPercent).toBeCloseTo(91.67, 2);
      expect(lookupCoinAlloy('$10', '1799', 'United States')?.pmPercent).toBeCloseTo(91.67, 2);
    });

    it('uses 89.92% for the 1834-1838 Classic Head era', () => {
      // From a real security: "1835 $5 - NGC/CAC XF45".
      const alloy = lookupCoinAlloy('$5', '1835', 'United States');
      expect(alloy?.pmPercent).toBeCloseTo(89.92, 2);
      expect(alloy?.pmWeightGrams).toBeCloseTo(7.52, 2);
    });

    it('uses 90% from 1839 to the end of gold coinage in 1933', () => {
      expect(lookupCoinAlloy('$5', '1909', 'United States')?.pmPercent).toBe(90);
      expect(lookupCoinAlloy('$20', '1933', 'United States')?.pmPercent).toBe(90);
      // No circulating US gold after 1933.
      expect(lookupCoinAlloy('$20', '1950', 'United States')).toBeNull();
    });
  });

  /* Foreign */
  describe('foreign issues', () => {
    it('knows the 1950-1970 Peru gold Soles series', () => {
      // Matches the "1.3544 ounces of gold" memo on the real security.
      const alloy = lookupCoinAlloy('100 Soles', '1969', 'Peru');
      expect(alloy?.metal).toBe('Gold');
      expect(alloy?.pmPercent).toBe(90);
      expect(alloy?.pmWeightGrams).toBeCloseTo(42.13, 2);
      expect(alloy?.pmDescription).toBe('1.3544 oz AGW');
    });

    it('scales the rest of the Peru Soles series by face value', () => {
      expect(lookupCoinAlloy('50 Soles', '1965', 'Peru')?.pmWeightGrams).toBeCloseTo(21.06, 2);
      expect(lookupCoinAlloy('20 Soles', '1965', 'Peru')?.pmWeightGrams).toBeCloseTo(8.43, 2);
    });

    it('does not apply a Peru entry to another country', () => {
      expect(lookupCoinAlloy('100 Soles', '1969', 'United States')).toBeNull();
    });

    it('knows the British Sovereign regardless of year', () => {
      const alloy = lookupCoinAlloy('Sovereign', '1911', 'Great Britain');
      expect(alloy?.metal).toBe('Gold');
      expect(alloy?.pmPercent).toBeCloseTo(91.67, 2);
    });

    it('knows GB silver lost its silver in 1947', () => {
      expect(lookupCoinAlloy('Shilling', '1946', 'Great Britain')?.metal).toBe('Silver');
      expect(lookupCoinAlloy('Shilling', '1950', 'Great Britain')?.metal).toBe('Copper-Nickel');
      expect(lookupPmData('Shilling', '1950', 'Great Britain')).toBeNull();
    });
  });

  /* Base metal: a composition without precious metal numbers */
  describe('lookupCoinAlloy on base-metal coins', () => {
    it('describes a bronze Indian Head cent but reports no melt data', () => {
      const alloy = lookupCoinAlloy('1¢', '1890', 'United States');
      expect(alloy?.metal).toBe('Bronze');
      expect(alloy?.composition).toContain('95% Copper');
      expect(alloy?.pmWeightGrams).toBeUndefined();
      expect(alloy?.pmPercent).toBeUndefined();
      // ...and nothing from the melt lookup.
      expect(lookupPmData('1¢', '1890', 'United States')).toBeNull();
    });

    it('describes a modern clad quarter', () => {
      const alloy = lookupCoinAlloy('25¢', '1980', 'United States');
      expect(alloy?.metal).toBe('Clad');
      expect(alloy?.pmPercent).toBeUndefined();
    });

    it('still reports a GROSS weight for a coin with no precious metal', () => {
      // No melt value, but a known weight.
      const alloy = lookupCoinAlloy('1¢', '1983', 'United States');
      expect(alloy?.pmWeightGrams).toBeUndefined();
      expect(alloy?.grossWeightGrams).toBeCloseTo(2.50, 3);
    });
  });

  /*
   * Gross-weight invariant: grossWeightGrams x (pmPercent / 100) = pmWeightGrams.
   * The weights were copied by hand, so this catches a transposed digit (e.g.
   * 33.346 for 33.436). Tolerance 0.01 g because pmWeightGrams is published to two
   * decimals; the largest real deviation is 0.0065 g ($3 gold: 5.015 x 0.900 =
   * 4.5135, stored 4.52).
   */
  describe('gross weight agrees with purity and pure weight on every row', () => {
    /** See the derivation above. */
    const TOLERANCE_GRAMS = 0.01;

    /** Rows with all three numbers present. */
    const checkable = PM_REFERENCE_ROWS.filter(
      (row) =>
        row.grossWeightGrams !== undefined &&
        row.pmPercent !== undefined &&
        row.pmWeightGrams !== undefined
    );

    it('has rows to check (the filter above is not silently matching nothing)', () => {
      // Non-vacuity: deleting every gross weight must not pass.
      expect(checkable.length).toBeGreaterThan(30);
    });

    for (const row of checkable) {
      const years = row.yearRange ? `${row.yearRange.min}-${row.yearRange.max}` : 'all years';
      const label = `${row.country ?? 'any country'} ${row.denomination} (${years}, ${row.metal})`;

      it(`${label}: ${row.grossWeightGrams} g x ${row.pmPercent}% = ${row.pmWeightGrams} g`, () => {
        const derived = row.grossWeightGrams! * (row.pmPercent! / 100);
        expect(
          Math.abs(derived - row.pmWeightGrams!),
          `${label}: ${row.grossWeightGrams} g at ${row.pmPercent}% works out to ` +
          `${derived.toFixed(4)} g of pure metal, but the row says ${row.pmWeightGrams} g. ` +
          `One of the three numbers is wrong.`
        ).toBeLessThanOrEqual(TOLERANCE_GRAMS);
      });
    }
  });

  /*
   * The large cent and half cent rows have no gross weight: each spans two
   * planchet standards about 24% apart. Pinned so they aren't filled in later.
   */
  describe('gross weight is withheld where one row covers two planchets', () => {
    it('leaves the large cent without a gross weight (13.48 g then 10.89 g)', () => {
      const alloy = lookupCoinAlloy('1¢', '1820', 'United States');
      expect(alloy?.metal).toBe('Copper');
      expect(alloy?.grossWeightGrams).toBeUndefined();
    });

    it('leaves the half cent without a gross weight (6.74 g then 5.44 g)', () => {
      const alloy = lookupCoinAlloy('½¢', '1830', 'United States');
      expect(alloy?.metal).toBe('Copper');
      expect(alloy?.grossWeightGrams).toBeUndefined();
    });
  });

  /*
   * The invariant proves the columns are consistent, not correct (a shared wrong
   * factor still passes). These check a few figures against independent facts.
   */
  describe('gross weights against independently known facts', () => {
    it('a $20 Saint-Gaudens weighs 33.436 g and holds 0.9675 oz of gold', () => {
      const alloy = lookupCoinAlloy('$20', '1927', 'United States');
      expect(alloy?.grossWeightGrams).toBeCloseTo(33.436, 3);
      // The published AGW, from the gross weight.
      expect((alloy!.grossWeightGrams! * 0.9) / 31.1035).toBeCloseTo(0.9675, 4);
    });

    it('a Peru 100 Soles weighs 46.8069 g, i.e. the published 1.3544 oz AGW', () => {
      // The series' published gold content.
      const alloy = lookupCoinAlloy('100 Soles', '1969', 'Peru');
      expect(alloy?.grossWeightGrams).toBeCloseTo(46.8069, 4);
      expect((alloy!.grossWeightGrams! * 0.9) / 31.1035).toBeCloseTo(1.3544, 3);
    });

    it('a British Sovereign weighs 7.988 g', () => {
      expect(lookupCoinAlloy('Sovereign', '1900', 'Great Britain')?.grossWeightGrams)
        .toBeCloseTo(7.988, 3);
      // The half sovereign is exactly half.
      expect(lookupCoinAlloy('½ Sovereign', '1900', 'Great Britain')?.grossWeightGrams)
        .toBeCloseTo(3.994, 3);
    });

    it('the Act of 1873 made the quarter exactly 6.25 g and the dime 2.5 g', () => {
      expect(lookupCoinAlloy('25¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(6.25, 3);
      expect(lookupCoinAlloy('10¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(2.50, 3);
      expect(lookupCoinAlloy('50¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(12.50, 3);
    });

    it('every five-cent piece from 1866 on weighs 5.00 g, war nickel included', () => {
      // Only the alloy changed in 1942, never the planchet.
      expect(lookupCoinAlloy('5¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
      expect(lookupCoinAlloy('5¢', '1944', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
      expect(lookupCoinAlloy('5¢', '2000', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
    });

    it('the bronze cent is 3.11 g and the zinc cent 2.50 g — the 1982 tell', () => {
      // The two weights that distinguish the two 1982 cents.
      expect(lookupCoinAlloy('1¢', '1970', 'United States')?.grossWeightGrams).toBeCloseTo(3.11, 3);
      expect(lookupCoinAlloy('1¢', '1990', 'United States')?.grossWeightGrams).toBeCloseTo(2.50, 3);
    });

    it('British silver keeps the same gross weight across 1920 and 1947', () => {
      // The 1816 Act's gross weights outlived both the 1920 debasement and 1947.
      const sterling = lookupCoinAlloy('Shilling', '1910', 'Great Britain');
      const debased = lookupCoinAlloy('Shilling', '1930', 'Great Britain');
      const cupronickel = lookupCoinAlloy('Shilling', '1950', 'Great Britain');
      expect(sterling?.grossWeightGrams).toBeCloseTo(5.655, 2);
      expect(debased?.grossWeightGrams).toBeCloseTo(5.655, 2);
      expect(cupronickel?.grossWeightGrams).toBeCloseTo(5.655, 2);
    });
  });
});
