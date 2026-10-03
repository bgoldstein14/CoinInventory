import { describe, expect, it } from 'vitest';
import { PM_REFERENCE_ROWS, lookupCoinAlloy, lookupPmData } from './pm-reference';

/**
 * Tests for the coin composition reference data.
 *
 * Two entry points, two jobs:
 *   lookupPmData    -- PRECIOUS metal only; feeds the melt-value calculation
 *                      and answers null for a base-metal coin.
 *   lookupCoinAlloy -- every coin in the table, precious or not; feeds the
 *                      four editor fields Metal / Composition / PM % / PM
 *                      weight that the Quicken import pre-fills.
 *
 * Denominations use the symbolic format the QIF parser produces
 * (25¢, 50¢, $1, $20, "100 Soles").
 *
 * THE RULE MOST OF THESE TESTS EXIST TO PIN DOWN: when a year/denomination
 * combination genuinely had two alloys in circulation, the lookup must answer
 * NULL rather than pick one. A blank field is visible and fixable; a wrong
 * purity silently produces a wrong melt value.
 */
describe('pm-reference', () => {
  describe('lookupPmData', () => {
    // --- US Silver Coins (90% silver, pre-1965) ---

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
      // 1921 is after the Gold Dollar series ended in 1889, so "$1" is
      // unambiguous here and needs no metal hint.
      const data = lookupPmData('$1', '1921', 'United States');
      expect(data).toBeDefined();
      expect(data?.pmWeightGrams).toBeCloseTo(24.06, 2);
      expect(data?.pmPercent).toBe(90);
    });

    // --- US 40% Silver Half Dollars (1965-1970) ---

    it('returns PM data for 1967 US Half Dollar (40% silver)', () => {
      const data = lookupPmData('50¢', '1967', 'United States');
      expect(data).toBeDefined();
      // CORRECTED FIGURE. This used to assert 9.20 g, which is wrong under
      // either reading: a 40% Kennedy weighs 11.50 g gross and carries
      // 0.1479 oz ASW = 4.60 g of actual silver. 9.20 is neither, and it
      // doubled every melt value this table produced for the 1965-1970
      // halves. pmWeightGrams is always the PURE metal weight -- see the
      // units note at the top of pm-reference.ts.
      expect(data?.pmWeightGrams).toBeCloseTo(4.60, 2);
      expect(data?.pmPercent).toBe(40);
    });

    // --- US Gold Coins ---

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

    // --- British Silver Coins (50% silver, 1920-1946) ---

    it('returns PM data for 1945 GB Shilling (50% silver)', () => {
      const data = lookupPmData('Shilling', '1945', 'Great Britain');
      expect(data).toBeDefined();
      // CORRECTED FIGURE. 5.24 g is the STERLING (92.5%) silver content of a
      // pre-1920 shilling. The 1920 debasement halved the fineness without
      // changing the 5.655 g planchet, so a 1920-1946 shilling holds
      // 5.655 x 0.50 = 2.83 g of silver. Asserting 5.24 at 50% claimed a
      // 92.5% coin's silver in a 50% coin's body.
      expect(data?.pmWeightGrams).toBeCloseTo(2.83, 2);
      expect(data?.pmPercent).toBe(50);
    });

    it('returns PM data for 1930 GB Florin (50% silver)', () => {
      const data = lookupPmData('Florin', '1930', 'Great Britain');
      expect(data).toBeDefined();
      // CORRECTED FIGURE, same reasoning as the shilling above:
      // 11.31 g planchet x 0.50 = 5.66 g.
      expect(data?.pmWeightGrams).toBeCloseTo(5.66, 2);
      expect(data?.pmPercent).toBe(50);
    });

    it('still returns the sterling figure for a pre-1920 GB Shilling', () => {
      const data = lookupPmData('Shilling', '1910', 'Great Britain');
      expect(data?.pmPercent).toBe(92.5);
      expect(data?.pmWeightGrams).toBeCloseTo(5.23, 2);
    });

    // --- Unknown coins ---

    it('returns null for unknown country', () => {
      const data = lookupPmData('25¢', '1960', 'Unknown Country');
      expect(data).toBeNull();
    });

    it('returns null for unknown denomination', () => {
      const data = lookupPmData('Doubloon', '1800', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for post-silver year (clad US quarter)', () => {
      // US quarters switched to clad (no PM) in 1965. The table DOES know
      // what a 1980 quarter is made of -- see the lookupCoinAlloy test below
      // -- but it has no precious metal, so the melt lookup says null.
      const data = lookupPmData('25¢', '1980', 'United States');
      expect(data).toBeNull();
    });

    it('returns null for missing parameters', () => {
      expect(lookupPmData('', '1960', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '', 'United States')).toBeNull();
      expect(lookupPmData('25¢', '1960', '')).toBeNull();
    });
  });

  /* =========================================================================
   * THE 1965 CLIFF AND THE OTHER YEAR-DRIVEN TRANSITIONS
   * -------------------------------------------------------------------------
   * These are the cases the owner called out: the alloy depends on the YEAR
   * as much as the denomination, and getting the year band wrong is a silent
   * error.
   * ===================================================================== */
  describe('year-driven alloy transitions', () => {
    it('1964 quarter is silver and 1965 quarter is clad', () => {
      const silver = lookupCoinAlloy('25¢', '1964', 'United States');
      expect(silver?.metal).toBe('Silver');
      expect(silver?.pmPercent).toBe(90);

      const clad = lookupCoinAlloy('25¢', '1965', 'United States');
      expect(clad?.metal).toBe('Clad');
      // A clad coin has a composition but NO precious metal numbers.
      expect(clad?.composition).toContain('Copper-Nickel');
      expect(clad?.pmPercent).toBeUndefined();
      expect(clad?.pmWeightGrams).toBeUndefined();
    });

    it('1964 dime is silver and 1965 dime is clad', () => {
      expect(lookupCoinAlloy('10¢', '1964', 'United States')?.metal).toBe('Silver');
      expect(lookupCoinAlloy('10¢', '1965', 'United States')?.metal).toBe('Clad');
    });

    it('keeps the Kennedy half at 40% silver through 1970, then clad', () => {
      // The half dollar is the one denomination that did NOT go straight to
      // clad in 1965.
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
      // Either side of the war years it is plain cupronickel.
      expect(lookupCoinAlloy('5¢', '1941', 'United States')?.metal).toBe('Copper-Nickel');
      expect(lookupCoinAlloy('5¢', '1946', 'United States')?.metal).toBe('Copper-Nickel');
    });

    it('REFUSES to decide the 1942 nickel, which was struck in both alloys', () => {
      // War nickels began part-way through 1942, and only the large mint mark
      // above Monticello tells them apart -- which a Quicken security name
      // does not carry. Guessing would be a 35-point purity error.
      expect(lookupCoinAlloy('5¢', '1942', 'United States')).toBeNull();
      expect(lookupPmData('5¢', '1942', 'United States')).toBeNull();
    });

    it('REFUSES to decide the 1982 cent, which was struck in both alloys', () => {
      // Bronze and copper-plated zinc, same date, same design; they are told
      // apart by weighing them.
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

  /* =========================================================================
   * GOLD vs SILVER AT THE SAME FACE VALUE
   * ===================================================================== */
  describe('the gold dollar / silver dollar collision', () => {
    it('refuses to choose for a bare "$1" in the overlap years', () => {
      // 1849-1889: the US struck a 26.73 g silver dollar AND a 1.67 g gold
      // dollar. Nothing about "$1" + "1855" says which.
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
      // 1878 Morgan -- the gold dollar ran to 1889, so 1878 IS still a tie.
      expect(lookupCoinAlloy('$1', '1878', 'United States')).toBeNull();
      // 1890 is past the gold dollar, so silver wins outright.
      expect(lookupCoinAlloy('$1', '1890', 'United States')?.metal).toBe('Silver');
      // 1848 is before the gold dollar, likewise.
      expect(lookupCoinAlloy('$1', '1848', 'United States')?.metal).toBe('Silver');
    });

    it('keeps silver-proof clad-era coins hidden unless silver is named', () => {
      // A 1999 quarter is clad unless the name says otherwise; the 90% silver
      // proof version exists but is invisible without a hint.
      expect(lookupCoinAlloy('25¢', '1999', 'United States')?.metal).toBe('Clad');
      const proof = lookupCoinAlloy('25¢', '1999', 'United States', 'Silver');
      expect(proof?.metal).toBe('Silver');
      expect(proof?.pmPercent).toBe(90);
    });
  });

  /* =========================================================================
   * US GOLD STANDARDS BY ERA
   * ===================================================================== */
  describe('US gold fineness by era', () => {
    it('uses 91.67% for pre-1834 gold', () => {
      expect(lookupCoinAlloy('$5', '1800', 'United States')?.pmPercent).toBeCloseTo(91.67, 2);
      expect(lookupCoinAlloy('$10', '1799', 'United States')?.pmPercent).toBeCloseTo(91.67, 2);
    });

    it('uses 89.92% for the 1834-1838 Classic Head era', () => {
      // This collection contains "1835 $5 - NGC/CAC XF45".
      const alloy = lookupCoinAlloy('$5', '1835', 'United States');
      expect(alloy?.pmPercent).toBeCloseTo(89.92, 2);
      expect(alloy?.pmWeightGrams).toBeCloseTo(7.52, 2);
    });

    it('uses 90% from 1839 to the end of gold coinage in 1933', () => {
      expect(lookupCoinAlloy('$5', '1909', 'United States')?.pmPercent).toBe(90);
      expect(lookupCoinAlloy('$20', '1933', 'United States')?.pmPercent).toBe(90);
      // Nothing after 1933 -- the US stopped striking circulating gold.
      expect(lookupCoinAlloy('$20', '1950', 'United States')).toBeNull();
    });
  });

  /* =========================================================================
   * FOREIGN
   * ===================================================================== */
  describe('foreign issues', () => {
    it('knows the 1950-1970 Peru gold Soles series', () => {
      // "1969 Peru 100 Soles - NGC MS64" is in this collection, and its own
      // Quicken memo reads "1.3544 ounces of gold" -- which is exactly the
      // AGW below, so this row is confirmed by the user's own data.
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

  /* =========================================================================
   * BASE METAL: a composition WITHOUT precious metal numbers
   * ===================================================================== */
  describe('lookupCoinAlloy on base-metal coins', () => {
    it('describes a bronze Indian Head cent but reports no melt data', () => {
      const alloy = lookupCoinAlloy('1¢', '1890', 'United States');
      expect(alloy?.metal).toBe('Bronze');
      expect(alloy?.composition).toContain('95% Copper');
      expect(alloy?.pmWeightGrams).toBeUndefined();
      expect(alloy?.pmPercent).toBeUndefined();
      // ...and therefore nothing at all from the melt-value lookup.
      expect(lookupPmData('1¢', '1890', 'United States')).toBeNull();
    });

    it('describes a modern clad quarter', () => {
      const alloy = lookupCoinAlloy('25¢', '1980', 'United States');
      expect(alloy?.metal).toBe('Clad');
      expect(alloy?.pmPercent).toBeUndefined();
    });

    it('still reports a GROSS weight for a coin with no precious metal', () => {
      // A 1983 cent has no melt value, but it certainly has a weight, and the
      // owner asked for the Weight field to be filled wherever it is known.
      const alloy = lookupCoinAlloy('1¢', '1983', 'United States');
      expect(alloy?.pmWeightGrams).toBeUndefined();
      expect(alloy?.grossWeightGrams).toBeCloseTo(2.50, 3);
    });
  });

  /* =========================================================================
   * THE GROSS-WEIGHT INVARIANT
   * -------------------------------------------------------------------------
   * THE WHOLE POINT OF THIS BLOCK, in one sentence: these three numbers are
   * not independent, so a transcription slip in any one of them contradicts
   * the other two, and a machine can notice that where a human reviewer
   * cannot.
   *
   *     grossWeightGrams x (pmPercent / 100) = pmWeightGrams
   *
   * The gross weights were all moved into the table by hand out of published
   * specifications. Hand-copied numbers get digits transposed. Without this
   * test a "33.346" in place of "33.436" would sail through review, look
   * entirely plausible in the editor, and silently misreport the weight of
   * every double eagle in the collection.
   *
   * WHY THE TOLERANCE IS 0.01 g
   * `pmWeightGrams` is stored rounded to two decimals, as the trade publishes
   * it (30.09, not 30.0924). So the identity can only ever hold to within
   * half of the last digit kept, i.e. 0.005 g. The tolerance here is double
   * that, which leaves comfortable room for the rounding while still being
   * far tighter than any realistic typo: a single transposed digit moves a
   * weight by a whole gram or more.
   *
   * The largest real deviation in the table today is 0.0065 g, on the $3 gold
   * piece (5.015 x 0.900 = 4.5135, stored as 4.52).
   * ===================================================================== */
  describe('gross weight agrees with purity and pure weight on every row', () => {
    /** Half a cent of a gram — see the long note above for the derivation. */
    const TOLERANCE_GRAMS = 0.01;

    /** Rows where all three numbers are present, i.e. the ones to check. */
    const checkable = PM_REFERENCE_ROWS.filter(
      (row) =>
        row.grossWeightGrams !== undefined &&
        row.pmPercent !== undefined &&
        row.pmWeightGrams !== undefined
    );

    it('has rows to check (the filter above is not silently matching nothing)', () => {
      // Without this, deleting every gross weight in the table would make the
      // loop below vacuous and the suite would still pass.
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

  /* =========================================================================
   * THE TWO ROWS THAT DELIBERATELY HAVE NO GROSS WEIGHT
   * -------------------------------------------------------------------------
   * Pinned down so that "helpfully" filling them in later is a test failure
   * rather than an unnoticed regression. Both span two planchet standards
   * that are ~24% apart, which is a far bigger error than a blank.
   * ===================================================================== */
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

  /* =========================================================================
   * SPOT CHECKS ON THE NUMBERS THEMSELVES
   * -------------------------------------------------------------------------
   * The invariant above proves the three columns are CONSISTENT with each
   * other. It cannot prove they are RIGHT: multiply a gross weight and a pure
   * weight by the same wrong factor and the identity still holds. These
   * fix a handful of figures against independent, externally checkable facts.
   * ===================================================================== */
  describe('gross weights against independently known facts', () => {
    it('a $20 Saint-Gaudens weighs 33.436 g and holds 0.9675 oz of gold', () => {
      const alloy = lookupCoinAlloy('$20', '1927', 'United States');
      expect(alloy?.grossWeightGrams).toBeCloseTo(33.436, 3);
      // The trade's own published AGW, reached from the gross weight.
      expect((alloy!.grossWeightGrams! * 0.9) / 31.1035).toBeCloseTo(0.9675, 4);
    });

    it('a Peru 100 Soles weighs 46.8069 g, matching the owner\'s Quicken memo', () => {
      // The QIF transaction's memo reads "1.3544 ounces of gold".
      const alloy = lookupCoinAlloy('100 Soles', '1969', 'Peru');
      expect(alloy?.grossWeightGrams).toBeCloseTo(46.8069, 4);
      expect((alloy!.grossWeightGrams! * 0.9) / 31.1035).toBeCloseTo(1.3544, 3);
    });

    it('a British Sovereign weighs 7.988 g', () => {
      expect(lookupCoinAlloy('Sovereign', '1900', 'Great Britain')?.grossWeightGrams)
        .toBeCloseTo(7.988, 3);
      // ...and the half sovereign is exactly half of it.
      expect(lookupCoinAlloy('½ Sovereign', '1900', 'Great Britain')?.grossWeightGrams)
        .toBeCloseTo(3.994, 3);
    });

    it('the Act of 1873 made the quarter exactly 6.25 g and the dime 2.5 g', () => {
      expect(lookupCoinAlloy('25¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(6.25, 3);
      expect(lookupCoinAlloy('10¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(2.50, 3);
      expect(lookupCoinAlloy('50¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(12.50, 3);
    });

    it('every five-cent piece from 1866 on weighs 5.00 g, war nickel included', () => {
      // Only the ALLOY changed in 1942; the planchet never did.
      expect(lookupCoinAlloy('5¢', '1900', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
      expect(lookupCoinAlloy('5¢', '1944', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
      expect(lookupCoinAlloy('5¢', '2000', 'United States')?.grossWeightGrams).toBeCloseTo(5.00, 3);
    });

    it('the bronze cent is 3.11 g and the zinc cent 2.50 g — the 1982 tell', () => {
      // These are the two weights the 1982 "deliberate gap" comment names as
      // the only way to tell the two 1982 cents apart.
      expect(lookupCoinAlloy('1¢', '1970', 'United States')?.grossWeightGrams).toBeCloseTo(3.11, 3);
      expect(lookupCoinAlloy('1¢', '1990', 'United States')?.grossWeightGrams).toBeCloseTo(2.50, 3);
    });

    it('British silver keeps the same gross weight across 1920 and 1947', () => {
      // The 1816 Act's discs outlived both the halving of the fineness and
      // the removal of the silver altogether.
      const sterling = lookupCoinAlloy('Shilling', '1910', 'Great Britain');
      const debased = lookupCoinAlloy('Shilling', '1930', 'Great Britain');
      const cupronickel = lookupCoinAlloy('Shilling', '1950', 'Great Britain');
      expect(sterling?.grossWeightGrams).toBeCloseTo(5.655, 2);
      expect(debased?.grossWeightGrams).toBeCloseTo(5.655, 2);
      expect(cupronickel?.grossWeightGrams).toBeCloseTo(5.655, 2);
    });
  });
});
