/* ===========================================================================
 * pm-reference.ts — WHAT IS THIS COIN MADE OF?
 * ---------------------------------------------------------------------------
 * ONE table, TWO questions:
 *
 *   1. "How much precious metal is in it?"   -> lookupPmData()
 *      Feeds the melt-value calculation. Precious metal ONLY; a bronze cent
 *      answers `null` here, because it has no melt value.
 *
 *   2. "What is it made of, and what does it weigh?"  -> lookupCoinAlloy()
 *      Feeds the FIVE editor fields every import path is supposed to
 *      pre-fill:  Metal / Composition / PM % / PM weight / Weight.
 *      Answers for EVERY coin in the table, precious or base metal.
 *      (It was four fields until gross Weight was promoted from a prose
 *      comment to a real column — see the UNITS section below.)
 *
 * ---------------------------------------------------------------------------
 * THE GOVERNING PRINCIPLE: WHEN IN DOUBT, ANSWER NOTHING
 * ---------------------------------------------------------------------------
 * This project already follows that rule for image matching ("only assume a
 * match if it is very close, otherwise let the user decide"). The same rule
 * applies here, and for a sharper reason:
 *
 *     A WRONG PURITY SILENTLY PRODUCES A WRONG MELT VALUE.
 *     A BLANK FIELD IS VISIBLE AND THE USER CAN FIX IT.
 *
 * So wherever a year/denomination combination genuinely had TWO different
 * alloys in circulation, this file deliberately has NO entry, and the lookup
 * returns null. The three places that happens are each called out in a
 * "*** DELIBERATE GAP ***" comment below:
 *
 *     - 1942 Jefferson nickel  (cupronickel AND 35% silver were both struck)
 *     - 1982 Lincoln cent      (bronze AND copper-plated zinc were both struck)
 *     - 1971-1978 Eisenhower $1 (clad business strikes AND 40% silver collector
 *                                issues; nothing in a Quicken name tells them
 *                                apart)
 *
 * A fourth kind of ambiguity is handled in code rather than by omission: when
 * two entries match the same denomination and year but name DIFFERENT metals
 * (the classic case is "$1" in 1849-1889, when the US struck both a silver
 * dollar and a gold dollar), the lookup refuses to choose and returns null --
 * UNLESS the caller passes a `metalHint`, because the security name said
 * "Gold" or "G$1" out loud.
 *
 * ---------------------------------------------------------------------------
 * UNITS -- READ THIS BEFORE ADDING A ROW
 * ---------------------------------------------------------------------------
 * `pmWeightGrams` is the weight of the PURE PRECIOUS METAL, in grams. It is
 * NOT the weight of the coin.
 *
 *     1927 $20 Saint-Gaudens:  coin weighs 33.436 g, is 90% gold,
 *                              so pmWeightGrams = 30.09  (= 0.9675 oz AGW)
 *
 * `pmPercent` is the fineness of the alloy as a percentage (90 for 90% gold).
 * The two together describe the coin completely; `pmDescription` restates the
 * same fact in the trade's own shorthand ("0.9675 oz AGW", "0.3617 oz ASW").
 *
 * To convert between them:  pmWeightGrams = pmDescription_oz x 31.1035
 *
 * AGW = Actual Gold Weight, ASW = Actual Silver Weight. Both are always the
 * PURE content, which is why they line up with pmWeightGrams and not with the
 * coin's gross weight.
 *
 * `grossWeightGrams` is the THIRD weight, and the newest: the weight of the
 * whole coin, alloy and all, in grams. It is what a jeweller's scale reads.
 *
 *     1927 $20 Saint-Gaudens:  grossWeightGrams = 33.436   <- the whole coin
 *                              pmWeightGrams    = 30.09    <- just the gold
 *
 * These three numbers are not independent, and that is the point:
 *
 *     grossWeightGrams x (pmPercent / 100) = pmWeightGrams
 *
 * Every row that carries all three satisfies that identity, and
 * `pm-reference.spec.ts` asserts it across the whole table. A transcription
 * slip in any one of the three therefore fails a test rather than quietly
 * producing a wrong melt value. (The tolerance is 0.01 g, because
 * `pmWeightGrams` is published rounded to two decimals -- see the spec.)
 *
 * Gross weight used to live only in PROSE in the comments of this file
 * ("1.672 g gross", "5.015 g gross", "11.50 g gross"). Nothing could read it,
 * so the coin editor's Weight field came up empty on every imported coin. It
 * is now data.
 *
 * *** UNITS: GRAMS, NOT TROY OUNCES ***
 * `CoinRecord.weight` was a count of TROY OUNCES until migration 008 and is a
 * count of GRAMS afterwards. This column is grams, which is what makes it
 * directly comparable with -- and divisible by -- pmWeightGrams.
 * =========================================================================== */

/**
 * The canonical "Metal" values. These are not free text: the coin editor
 * renders Metal as a <select> fed by the MetalContents lookup table, which
 * `server/setup-database.sql` seeds with exactly this list. A value outside
 * it would show as a blank dropdown. `inventory-metrics.ts` additionally
 * looks for the substrings "gold" / "silver" / "platinum" / "copper" when it
 * picks a spot price, which these satisfy.
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
 * One row of the reference table.
 *
 * Exported only so the spec can type the `PM_REFERENCE_ROWS` export it walks;
 * nothing in the app should build or read a `PmEntry` directly — go through
 * `lookupCoinAlloy` / `lookupPmData`.
 */
export interface PmEntry {
  /** Denomination exactly as the parser normalises it ("$20", "50¢", "100 Soles"). */
  denomination: string;
  /** Year range (inclusive). If undefined, matches all years. */
  yearRange?: { min: number; max: number };
  /** Canonical Metal value — see CoinMetal. */
  metal: CoinMetal;
  /** Free-text alloy description for the Composition field, e.g. "90% Gold, 10% Copper". */
  composition: string;
  /** PURE precious metal weight in grams. Omitted for base-metal coins. */
  pmWeightGrams?: number;
  /** Alloy fineness as a percentage (90 = 90%). Omitted for base-metal coins. */
  pmPercent?: number;
  /** The trade's shorthand for the same fact, e.g. "0.9675 oz AGW". */
  pmDescription?: string;
  /**
   * The WHOLE COIN's weight in grams, alloy included — the figure a scale
   * reads. Present on base-metal rows too (a cent has a gross weight even
   * though it has no melt value), and omitted ONLY where the row genuinely
   * does not determine one. There are exactly two such rows, the large cent
   * and the half cent, each of which spans two different planchet standards;
   * both say so in a comment at the row.
   *
   * MUST satisfy `grossWeightGrams * pmPercent / 100 === pmWeightGrams`
   * wherever all three are present. pm-reference.spec.ts asserts it.
   */
  grossWeightGrams?: number;
  /** Country filter. Omitted entries match any country. */
  country?: string;
  /**
   * When true the entry is INVISIBLE unless the caller passes a matching
   * `metalHint`. Used for issues that share a face value and year with a much
   * commoner coin and can only be told apart by the security name saying so --
   * e.g. the 90% silver proof dimes and quarters struck from 1992 on, which
   * otherwise look exactly like the clad ones.
   */
  requiresHint?: boolean;
}

/**
 * Reference table of coin compositions.
 *
 * Organised by country, then by metal, then chronologically. Year ranges
 * within one country+denomination NEVER overlap: where two standards met, the
 * boundary year is assigned to one side and the reasoning is in a comment.
 */
const PM_REFERENCE_DATA: PmEntry[] = [
  /* =========================================================================
   * UNITED STATES — GOLD
   * -------------------------------------------------------------------------
   * US gold went through THREE standards, and the year is the only thing that
   * tells them apart, so each denomination needs up to three rows:
   *
   *   1795-1834  "11/12 fine"  = 91.67% gold, on a heavy planchet.
   *              Pre-1834 gold was worth more as metal than as money, so
   *              almost all of it was melted -- survivors are rare.
   *   1834-1838  Act of 1834 cut the weight and set the fineness to 0.8992,
   *              finally making US gold circulate. This is the "Classic Head"
   *              era.
   *   1837/1839+ The Act of 1837 rounded the fineness to a clean 0.900, which
   *              it stayed at until gold coinage ended in 1933.
   *
   * Note how little the PURE weight moved across 1834->1839 for the $5 and
   * $2.50: the 1834 Act cut the planchet, and the 1837 Act then raised the
   * fineness by almost exactly the offsetting amount.
   * ===================================================================== */

  // --- Gold Dollar (1849-1889 only) ---------------------------------------
  // The whole series shares one specification: 1.672 g gross, 0.900 fine.
  // Its year range is what lets the lookup tell a GOLD dollar from a SILVER
  // dollar -- see the "$1" silver row below and the ambiguity rule in
  // `resolveEntry`.
  {
    denomination: '$1',
    yearRange: { min: 1849, max: 1889 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 1.50,
    pmPercent: 90,
    // The smallest US coin ever struck: 13 mm across and lighter than a dime.
    grossWeightGrams: 1.672,
    pmDescription: '0.0484 oz AGW',
    country: 'United States'
  },

  // --- Quarter Eagle ($2.50) ----------------------------------------------
  {
    denomination: '$2.50',
    yearRange: { min: 1796, max: 1833 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 4.01,
    pmPercent: 91.67,
    // The heavy pre-1834 planchet, before the Act of 1834 cut it to 4.18 g.
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
    // The Act of 1834 cut the planchet from 4.37 g to 4.18 g. The Act of 1837
    // then left the PLANCHET alone and only rounded the fineness up to 0.900,
    // which is why this row and the one below share a gross weight.
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
    // Same 4.18 g planchet as the Classic Head row above; only the fineness
    // moved in 1837. See the note there.
    grossWeightGrams: 4.18,
    pmDescription: '0.1209 oz AGW',
    country: 'United States'
  },

  // --- Three Dollar (1854-1889 only, one specification) -------------------
  // 5.015 g gross x 0.900 = 4.5135 g of gold = 0.1452 oz AGW.
  {
    denomination: '$3',
    yearRange: { min: 1854, max: 1889 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 4.52,
    pmPercent: 90,
    // The 5.015 g that the comment above has always quoted, now readable.
    grossWeightGrams: 5.015,
    pmDescription: '0.1452 oz AGW',
    country: 'United States'
  },

  // --- Half Eagle ($5) ----------------------------------------------------
  {
    denomination: '$5',
    yearRange: { min: 1795, max: 1833 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 8.02,
    pmPercent: 91.67,
    // Exactly twice the pre-1834 quarter eagle's 4.37 g, as the face values
    // imply. The 1834 Act cut it to 8.36 g.
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
    // 8.359 g is the statutory figure (129 grains of standard gold); it is
    // very often quoted rounded to 8.36 g, which is the same coin.
    grossWeightGrams: 8.359,
    pmDescription: '0.2419 oz AGW',
    country: 'United States'
  },

  // --- Eagle ($10) --------------------------------------------------------
  // No Eagles were struck 1805-1837, so there is no "Classic Head" row here.
  {
    denomination: '$10',
    yearRange: { min: 1795, max: 1804 },
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Silver and Copper',
    pmWeightGrams: 16.04,
    pmPercent: 91.67,
    // Twice the pre-1834 half eagle's 8.75 g.
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
    // Exactly twice the 8.359 g half eagle, and exactly half the 33.436 g
    // double eagle -- the whole 0.900-fine series scales with the face value.
    grossWeightGrams: 16.718,
    pmDescription: '0.4837 oz AGW',
    country: 'United States'
  },

  // --- Double Eagle ($20) -------------------------------------------------
  // Only ever struck 1849-1933, and only ever at 0.900 fine.
  {
    denomination: '$20',
    yearRange: { min: 1849, max: 1933 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 30.09,
    pmPercent: 90,
    // The 33.436 g quoted in this file's header, now readable as data.
    grossWeightGrams: 33.436,
    pmDescription: '0.9675 oz AGW',
    country: 'United States'
  },

  /* =========================================================================
   * UNITED STATES — SILVER
   * -------------------------------------------------------------------------
   * Three weight standards for the subsidiary silver (dime / quarter / half):
   *
   *   1792 Act   0.8924 fine on a heavy planchet.
   *   1837 Act   0.900 fine on a slightly lighter planchet. Chosen so the
   *              PURE silver content stayed almost identical -- which is why
   *              the 1792 and 1837 rows below are merged into one range.
   *   1853 Act   Planchets cut by ~7% to stop the coins being melted during
   *              the California gold rush (silver had become too valuable
   *              relative to gold). "Arrows at the date" mark the new weight.
   *   1873 Act   Planchets nudged back UP by half a percent to make them
   *              metric-round (a quarter became exactly 6.25 g). This is the
   *              standard that then held all the way to 1964.
   *
   * THE 1965 CLIFF. The Coinage Act of 1965 removed silver from the dime and
   * the quarter outright. There is no gradual change and no overlap: a 1964
   * quarter is 90% silver and a 1965 quarter has none. That is why every
   * silver row below stops dead at 1964.
   * ===================================================================== */

  // --- Silver Dollar (1794-1935) ------------------------------------------
  // One row covers the whole run because the 1792 and 1837 standards give the
  // same silver content to four significant figures:
  //   1794-1803   26.96 g x 0.8924 = 24.06 g
  //   1836-1935   26.73 g x 0.900  = 24.06 g
  // (The 1873-1885 Trade Dollar is heavier -- 27.22 g x 0.900 = 24.49 g --
  // but it shares the "$1" denomination, so it is NOT broken out here; see
  // the note in the report. The 1.8% difference is inside the noise of a
  // melt estimate.)
  {
    denomination: '$1',
    yearRange: { min: 1794, max: 1935 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 24.06,
    pmPercent: 90,
    /* ---------------------------------------------------------------------
     * 26.73 g is the 1837-onward planchet: the Bust, Seated, Trade (near
     * enough), Morgan and Peace dollars -- i.e. everything a collection is
     * realistically going to contain. The 1794-1803 dollars were 26.96 g at
     * 0.8924 fine, 0.9% heavier.
     *
     * Quoting the commoner figure here is consistent with what this row
     * already does: it also quotes the 0.900 fineness, which is likewise the
     * 1837 standard rather than the 1792 one. The two standards were chosen
     * precisely so the PURE silver content came out the same (24.06 g either
     * way), which is why one row can cover both at all.
     * ------------------------------------------------------------------- */
    grossWeightGrams: 26.73,
    pmDescription: '0.7734 oz ASW',
    country: 'United States'
  },

  // --- Half Dollar --------------------------------------------------------
  {
    denomination: '50¢',
    yearRange: { min: 1794, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 12.03,
    pmPercent: 89.24,
    // 13.48 g at 0.8924 fine, the 1792 Act's standard. The 1837 Act restruck
    // the half on a 13.36 g planchet at 0.900 -- a different gross weight but
    // the SAME 12.03 g of silver, which is why this row covers both. The
    // figure here is the 1794-1836 one, matching the 89.24% this row quotes.
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
    // The "arrows at the date" planchet: 12.44 g, cut ~7% by the Act of 1853.
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
    // The Act of 1873's metric-round planchet: exactly 12.5 g. Barber,
    // Walking Liberty, Franklin and the 1964 Kennedy are all this weight.
    grossWeightGrams: 12.50,
    pmDescription: '0.3617 oz ASW',
    country: 'United States'
  },
  // The Kennedy half kept 40% silver for six more years after the dime and
  // quarter went clad -- the one exception to the 1965 cliff. It is a clad
  // sandwich too, just a silver-bearing one: 80% silver outer layers bonded
  // to a 21% silver core, 11.50 g gross, netting 40% overall.
  //   11.50 g x 0.40 = 4.60 g of silver = 0.1479 oz ASW.
  {
    denomination: '50¢',
    yearRange: { min: 1965, max: 1970 },
    metal: 'Silver',
    composition: '40% Silver clad (80% silver outer layers, 21% silver core)',
    pmWeightGrams: 4.60,
    pmPercent: 40,
    // The 11.50 g the comment above quotes. Note it is LIGHTER than both the
    // 12.50 g silver half it replaced and the 11.34 g clad half that followed
    // is lighter still -- three different gross weights in seven years.
    grossWeightGrams: 11.50,
    pmDescription: '0.1479 oz ASW',
    country: 'United States'
  },
  // 1971 onward: ordinary copper-nickel clad, no silver at all.
  {
    denomination: '50¢',
    yearRange: { min: 1971, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // No precious metal, but it still has a weight, and the owner wants the
    // Weight field filled wherever it is known.
    grossWeightGrams: 11.34,
    country: 'United States'
  },

  // --- Quarter ------------------------------------------------------------
  {
    denomination: '25¢',
    yearRange: { min: 1796, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 6.01,
    pmPercent: 89.24,
    // Half of the 13.48 g half dollar, as the face values imply. (The 1837
    // Act's 6.68 g at 0.900 fine carries the same 6.01 g of silver.)
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
    // Half of the 12.44 g "arrows" half dollar.
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
    // The Act of 1873 made the quarter exactly 6.25 g -- a quarter of the
    // 25 g "half-ounce metric" standard it was aiming at. Barber, Standing
    // Liberty and the silver Washington are all this weight.
    grossWeightGrams: 6.25,
    pmDescription: '0.1808 oz ASW',
    country: 'United States'
  },
  {
    denomination: '25¢',
    yearRange: { min: 1965, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // Slightly LIGHTER than the silver quarter it replaced (6.25 g), because
    // the copper core is less dense than the silver alloy.
    grossWeightGrams: 5.67,
    country: 'United States'
  },
  // Silver proof-set quarters resumed in 1992 at the old 90% standard (and
  // moved to 99.9% in 2019). They are indistinguishable from the clad ones by
  // year alone, so this row is HIDDEN unless the security name actually says
  // "silver".
  {
    denomination: '25¢',
    yearRange: { min: 1992, max: 2100 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper (silver proof issue)',
    pmWeightGrams: 5.63,
    pmPercent: 90,
    // Struck to the pre-1965 silver standard, so the same 6.25 g planchet.
    grossWeightGrams: 6.25,
    pmDescription: '0.1808 oz ASW',
    country: 'United States',
    requiresHint: true
  },

  // --- Dime ---------------------------------------------------------------
  {
    denomination: '10¢',
    yearRange: { min: 1796, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 2.41,
    pmPercent: 89.24,
    // A fifth of the 13.48 g half dollar. (The 1837 Act's 2.67 g at 0.900
    // fine carries the same 2.41 g of silver.)
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
    // Exactly 2.5 g under the Act of 1873 -- a tenth of the 25 g standard.
    // Barber, Mercury and the silver Roosevelt are all this weight.
    grossWeightGrams: 2.50,
    pmDescription: '0.0723 oz ASW',
    country: 'United States'
  },
  {
    denomination: '10¢',
    yearRange: { min: 1965, max: 2100 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // 2.268 g -- the one modern US coin whose weight is not a round metric
    // number, because it was set as exactly 35 grains.
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
    // Struck to the pre-1965 silver standard, so the same 2.5 g planchet.
    grossWeightGrams: 2.50,
    pmDescription: '0.0723 oz ASW',
    country: 'United States',
    requiresHint: true
  },

  // --- Twenty Cent (1875-1878 only) ---------------------------------------
  {
    denomination: '20¢',
    yearRange: { min: 1875, max: 1878 },
    metal: 'Silver',
    composition: '90% Silver, 10% Copper',
    pmWeightGrams: 4.50,
    pmPercent: 90,
    // Exactly 5 g -- a fifth of the Act of 1873's 25 g standard, which is why
    // the twenty-cent piece was so easily confused with the 6.25 g quarter
    // and lasted only four years.
    grossWeightGrams: 5.00,
    pmDescription: '0.1447 oz ASW',
    country: 'United States'
  },

  // --- Half Dime (the SILVER five-cent piece, 1794-1873) ------------------
  // Not to be confused with the nickel. Both were legal tender simultaneously
  // from 1866 to 1873, which is a genuine ambiguity -- see the nickel rows.
  {
    denomination: '5¢',
    yearRange: { min: 1794, max: 1852 },
    metal: 'Silver',
    composition: '89.24% Silver, 10.76% Copper',
    pmWeightGrams: 1.20,
    pmPercent: 89.24,
    // Half the 2.70 g dime. (The 1837 Act's 1.34 g at 0.900 fine carries the
    // same 1.20 g of silver.)
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

  // --- Three Cent Silver ("trime", 1851-1873) -----------------------------
  // The only US coin ever struck at 0.750 fine, and only for its first three
  // years: the debased alloy was a deliberate anti-hoarding measure, reversed
  // by the Act of 1853.
  {
    denomination: '3CS',
    yearRange: { min: 1851, max: 1853 },
    metal: 'Silver',
    composition: '75% Silver, 25% Copper',
    pmWeightGrams: 0.60,
    pmPercent: 75,
    // 0.80 g. The lightest coin the United States has ever struck.
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
    // The Act of 1853 made it LIGHTER (0.80 g -> 0.75 g) while making it
    // FINER (0.750 -> 0.900), so the silver content went up, not down.
    grossWeightGrams: 0.75,
    pmDescription: '0.0217 oz ASW',
    country: 'United States'
  },

  /* =========================================================================
   * UNITED STATES — BASE METAL
   * -------------------------------------------------------------------------
   * These carry NO pmWeightGrams and NO pmPercent, on purpose. A bronze cent
   * has no melt value worth tracking, and leaving those two fields absent is
   * what makes `lookupPmData` correctly answer "null" for it while
   * `lookupCoinAlloy` still fills in Metal and Composition.
   *
   * They DO carry `grossWeightGrams`, though. A cent has a weight even when
   * it has no melt value, and the owner asked for the Weight field to be
   * filled in wherever the figure is known. It feeds nothing but the display,
   * so there is no arithmetic for it to get wrong.
   * ===================================================================== */

  // --- Five Cents, the NICKEL (1866 onward) -------------------------------
  // Every five-cent piece from 1866 to today weighs exactly 5.00 g, including
  // the 35% silver wartime issue -- only the alloy changed, never the
  // planchet. That is why all three rows below carry the same figure.
  {
    denomination: '5¢',
    yearRange: { min: 1866, max: 1941 },
    metal: 'Copper-Nickel',
    composition: '75% Copper, 25% Nickel',
    grossWeightGrams: 5.00,
    country: 'United States'
  },
  // *** DELIBERATE GAP: 1942 ***
  // Nickel was a strategic war material, so from October 1942 the five-cent
  // piece was struck in a silver alloy instead. BOTH compositions were struck
  // during 1942, and the only reliable way to tell them apart is the large
  // mint mark above Monticello -- which a Quicken security name does not
  // carry. So there is no 1942 row, the lookup returns null, and the user
  // fills it in. Guessing here would be a 35-percentage-point error.
  {
    denomination: '5¢',
    yearRange: { min: 1943, max: 1945 },
    metal: 'Silver',
    composition: '56% Copper, 35% Silver, 9% Manganese (wartime alloy)',
    pmWeightGrams: 1.75,
    pmPercent: 35,
    // Same 5.00 g planchet as the ordinary nickel: 5.00 x 0.35 = 1.75 g.
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

  // --- One Cent -----------------------------------------------------------
  {
    denomination: '1¢',
    yearRange: { min: 1793, max: 1857 },
    metal: 'Copper',
    composition: '100% Copper (large cent)',
    /* -------------------------------------------------------------------
     * *** NO GROSS WEIGHT, AND NOT BECAUSE IT IS UNKNOWN ***
     * It is known twice over, and that is the problem. The large cent was
     * struck on TWO planchets:
     *
     *     1793 - mid 1795   13.48 g  (208 grains)
     *     late 1795 - 1857  10.89 g  (168 grains, cut after the price of
     *                                 copper rose)
     *
     * This row spans both, and unlike the silver rows above -- where the
     * two standards were deliberately chosen to leave the PURE content
     * identical, so one figure serves for both -- these two really are
     * different answers, 24% apart. Splitting the row would change
     * `lookupCoinAlloy`'s matching behaviour, which this change is not
     * allowed to do. So the field is left absent, per the standing rule at
     * the top of this file: when in doubt, answer nothing.
     * ----------------------------------------------------------------- */
    country: 'United States'
  },
  {
    denomination: '1¢',
    yearRange: { min: 1856, max: 1863 },
    metal: 'Copper-Nickel',
    composition: '88% Copper, 12% Nickel',
    // The thick "white cent" planchet: Flying Eagle and the first Indian
    // Heads. Noticeably heavier than the bronze cent that replaced it.
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
  // 1943 only: zinc-coated steel, because copper went to the war effort.
  {
    denomination: '1¢',
    yearRange: { min: 1943, max: 1943 },
    metal: 'Steel',
    composition: 'Zinc-coated steel',
    // Steel is much less dense than bronze, so the 1943 cent is the odd one
    // out at 2.70 g against the bronze cent's 3.11 g.
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
  // *** DELIBERATE GAP: 1982 ***
  // The cent switched from 95% copper bronze to copper-plated zinc partway
  // through 1982. Both exist with the same date and the same design; they are
  // told apart by weighing them (3.11 g vs 2.50 g). No row, so no guess.
  // (Note that the two weights named in that sentence are now both in this
  // table -- on the 1944-1981 row and on the 1983-onward row below -- which
  // is exactly why 1982 cannot have one.)
  {
    denomination: '1¢',
    yearRange: { min: 1983, max: 2100 },
    metal: 'Zinc',
    composition: 'Copper-plated zinc (97.5% Zn, 2.5% Cu)',
    grossWeightGrams: 2.50,
    country: 'United States'
  },

  // --- Two Cent (1864-1873) and Three Cent Nickel (1865-1889) -------------
  {
    denomination: '2¢',
    yearRange: { min: 1864, max: 1873 },
    metal: 'Bronze',
    composition: '95% Copper, 5% Tin and Zinc',
    // Exactly twice the 3.11 g bronze cent, as the face value implies.
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

  // --- Half Cent (1793-1857) ----------------------------------------------
  {
    denomination: '½¢',
    yearRange: { min: 1793, max: 1857 },
    metal: 'Copper',
    composition: '100% Copper',
    // *** NO GROSS WEIGHT, for the same reason as the large cent above ***
    // Two planchets inside one row: 6.74 g for 1793-1795, then 5.44 g from
    // late 1795 to 1857 after copper was cut. 24% apart, nothing in the row
    // distinguishes them, so the honest answer is no answer.
    country: 'United States'
  },

  // --- Modern base-metal dollars ------------------------------------------
  // *** DELIBERATE GAP: 1971-1978 Eisenhower dollar ***
  // Business strikes are copper-nickel clad; the collector issues sold by the
  // Mint are 40% silver. Same date, same design, nothing in a security name
  // separates them. No rows for those years.
  {
    denomination: '$1',
    yearRange: { min: 1979, max: 1999 },
    metal: 'Clad',
    composition: 'Copper-Nickel clad (75% Cu / 25% Ni over pure copper core)',
    // Susan B. Anthony. 8.1 g, deliberately the same as the Sacagawea that
    // replaced it so both would work in the same vending machines.
    grossWeightGrams: 8.1,
    country: 'United States'
  },
  {
    denomination: '$1',
    yearRange: { min: 2000, max: 2100 },
    metal: 'Brass',
    composition: 'Manganese brass (88.5% Cu, 6% Zn, 3.5% Mn, 2% Ni)',
    // Sacagawea / Presidential. Same 8.1 g as the SBA -- see above.
    grossWeightGrams: 8.1,
    country: 'United States'
  },

  /* =========================================================================
   * GREAT BRITAIN
   * -------------------------------------------------------------------------
   * Two cliffs, both abrupt:
   *   1920  sterling (92.5%) halved to 50% silver, to pay for the Great War.
   *   1947  silver removed entirely; the same denominations continued in
   *         cupronickel.
   * The Sovereign is untouched by either -- it has been 22 carat (91.67%)
   * gold without interruption since 1817.
   * ===================================================================== */

  // --- Gold ---------------------------------------------------------------
  {
    denomination: 'Sovereign',
    metal: 'Gold',
    composition: '91.67% Gold, 8.33% Copper (22 carat crown gold)',
    pmWeightGrams: 7.32,
    pmPercent: 91.67,
    // 7.98805 g by statute, unchanged since 1817 -- the longest-running coin
    // specification in this whole table. Usually quoted as 7.99 g.
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
    // Exactly half the Sovereign's 7.98805 g.
    grossWeightGrams: 3.994,
    pmDescription: '0.1177 oz AGW',
    country: 'Great Britain'
  },

  /* --- Sterling silver, 1707-1919 (92.5%) ---------------------------------
   * ONE SET OF GROSS WEIGHTS COVERS ALL TWELVE BRITISH SILVER ROWS BELOW.
   * The Coinage Act of 1816 fixed the "sixty-six shillings to the troy pound"
   * standard, and the gross weights it set never moved again: not in 1920
   * when the fineness was halved, and not in 1947 when the silver was removed
   * altogether. Only what the discs were MADE of changed.
   *
   *     Crown       28.2759 g   (quoted here as 28.276)
   *     Half Crown  14.1379 g   (14.138) -- exactly half a crown
   *     Florin      11.3104 g   (11.310) -- two shillings
   *     Shilling     5.6552 g   (5.655)
   *
   * That invariance is what makes the arithmetic in the 1920-1946 block below
   * work out so neatly, and it is a useful cross-check: a British silver
   * coin's gross weight depends only on its DENOMINATION, never on its date.
   * ---------------------------------------------------------------------- */
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

  // --- Debased silver, 1920-1946 (50%) ------------------------------------
  // The GROSS weight of each coin was unchanged across 1920 -- only the
  // fineness moved -- so each pure weight here is exactly half of the
  // sterling pure weight above divided by 0.925, i.e. gross x 0.50:
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
    // Same 28.276 g disc as the sterling crown -- only the fineness moved.
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

  // --- Cupronickel, 1947 onward (no silver) -------------------------------
  // The silver went, the discs did not: the same gross weights as the two
  // blocks above, quoted as they are normally published (28.28 / 14.14 /
  // 11.31 / 5.66) because with no fineness to multiply by there is no
  // arithmetic here that needs the extra digit.
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

  /* =========================================================================
   * PERU — the 1950-1970 gold Soles series
   * -------------------------------------------------------------------------
   * Added because this collection actually contains one: the security name
   * "1969 Peru 100 Soles - NGC MS64", whose own Quicken memo reads
   * "1.3544 ounces of gold" -- which is exactly the published AGW below, so
   * the figures here are confirmed by the user's own data and not just by a
   * catalogue.
   *
   * The whole series shares one standard: 0.900 fine, with the gross weight
   * scaling linearly with the face value (the 100 Soles is 46.8069 g, the
   * 50 Soles exactly half that, and so on).
   *   46.8069 g x 0.900 = 42.13 g of gold = 1.3544 oz AGW.
   * ===================================================================== */
  {
    denomination: '100 Soles',
    yearRange: { min: 1950, max: 1970 },
    metal: 'Gold',
    composition: '90% Gold, 10% Copper',
    pmWeightGrams: 42.13,
    pmPercent: 90,
    // 46.8069 g, the figure the comment above quotes. Confirmed against the
    // owner's own Quicken memo ("1.3544 ounces of gold"): 46.8069 x 0.900 =
    // 42.13 g, and 42.13 / 31.1035 = 1.3544 oz.
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
    // Half the 100 Soles -- the series scales linearly with the face value.
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

/** Everything we know about what a coin is made of. */
export interface CoinAlloy {
  /** Canonical Metal value for the editor's Metal dropdown. */
  metal: CoinMetal;
  /** Free-text alloy description for the Composition field. */
  composition: string;
  /** PURE precious metal weight in grams; undefined for base-metal coins. */
  pmWeightGrams?: number;
  /** Alloy fineness as a percentage; undefined for base-metal coins. */
  pmPercent?: number;
  /** Trade shorthand such as "0.9675 oz AGW"; undefined for base-metal coins. */
  pmDescription?: string;
  /**
   * The WHOLE COIN's weight in GRAMS — what goes in the editor's Weight
   * field. Present for base-metal coins too; undefined only where the table
   * genuinely does not determine one (the large cent and the half cent).
   */
  grossWeightGrams?: number;
}

/**
 * Every row of the reference table, for tests only.
 *
 * Exported so `pm-reference.spec.ts` can walk the whole table and assert the
 * gross-weight identity on each row —
 *
 *     grossWeightGrams x (pmPercent / 100) === pmWeightGrams
 *
 * — which is the cheapest possible guard against a mistyped weight. A single
 * transposed digit in any of the three numbers breaks the identity and fails
 * the test, where no amount of human review would reliably catch it.
 *
 * `readonly` and typed as a readonly array so nothing outside the tests can
 * be tempted to reach past `lookupCoinAlloy` and read the rows directly.
 */
export const PM_REFERENCE_ROWS: readonly Readonly<PmEntry>[] = PM_REFERENCE_DATA;

/**
 * Reads the leading 4-digit year out of a year string, tolerating the forms
 * the parser actually produces: "1969", "1920-1930" (a range) and "1862/1"
 * (an overdate). Returns null when there is no year to work with, because
 * almost every rule in the table is year-dependent.
 */
function parseLeadingYear(year: string): number | null {
  const match = String(year ?? '').match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * THE CORE RESOLVER — and the place the "refuse to guess" rule is enforced.
 *
 * @param metalHint When the security name said the metal out loud ("1849-O $1
 *   Gold", "1855 G$1"), pass 'Gold' / 'Silver' / ... here. It does two things:
 *   it admits `requiresHint` rows, and it breaks a gold-vs-silver tie.
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

  // 1. Everything written for this denomination in this country.
  let candidates = PM_REFERENCE_DATA.filter(
    (entry) =>
      entry.denomination.toLowerCase() === denom &&
      (!entry.country || entry.country.toLowerCase() === nation)
  );

  // 2. Apply the hint. With a hint, only entries in that metal survive --
  //    which is what makes "1849-O $1 Gold" resolve to the Gold Dollar and
  //    not the Silver Dollar. Without one, hidden entries stay hidden.
  if (hint) {
    candidates = candidates.filter((entry) => entry.metal.toLowerCase() === hint);
  } else {
    candidates = candidates.filter((entry) => !entry.requiresHint);
  }
  if (candidates.length === 0) return null;

  // 3. Prefer entries whose year range actually contains this coin's year.
  //    Fall back to the undated entries (e.g. the British Sovereign, whose
  //    specification never changed) only when no dated entry matches.
  const dated = candidates.filter(
    (entry) => entry.yearRange && yearInt >= entry.yearRange.min && yearInt <= entry.yearRange.max
  );
  const pool = dated.length > 0 ? dated : candidates.filter((entry) => !entry.yearRange);
  if (pool.length === 0) return null;

  // 4. THE REFUSAL. If what survived names more than one metal, the
  //    year/denomination pair genuinely did not determine the alloy -- the
  //    1849-1889 "$1" (gold dollar AND silver dollar) is the canonical case.
  //    Answer nothing and let the user decide, exactly as the image matcher
  //    does with a weak match.
  const metals = new Set(pool.map((entry) => entry.metal));
  if (metals.size > 1) return null;

  return pool[0];
}

/**
 * What is this coin made of? Answers for precious AND base metal coins.
 *
 * This is what the Quicken import calls to pre-fill the editor's
 * Metal / Composition / PM % / PM weight fields.
 *
 * @param denomination Normalised denomination ("50¢", "$20", "100 Soles")
 * @param year Year string; ranges and overdates are tolerated
 * @param country Country name ("United States", "Great Britain", "Peru")
 * @param metalHint Optional metal named explicitly in the source text
 * @returns The alloy, or null when the combination does not determine one.
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
    // The coin's GROSS weight. Absent on the two rows that span two planchet
    // standards (the large cent and the half cent), which is deliberate.
    grossWeightGrams: entry.grossWeightGrams
  };
}

/**
 * How much PRECIOUS metal is in this coin?
 *
 * A thin filter over `lookupCoinAlloy`: it answers null for anything with no
 * precious metal content, so a bronze cent reports "nothing to melt" rather
 * than "0 grams of bronze". Callers that only care about melt value should
 * use this; callers filling in the editor should use `lookupCoinAlloy`.
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
