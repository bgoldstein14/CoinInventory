/* ===========================================================================
 * import-tiers.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That the three review tiers actually divide THIS COLLECTION the way the
 *   redesign claims they do, measured across the whole verbatim filename
 *   corpus rather than one case at a time.
 *
 *   near-match.spec.ts covers the RULE (the four attributes, the grade
 *   tolerance, both directions). This file covers the CONSEQUENCE: how much
 *   manual work is actually left.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT, AND ITS HONEST LIMITS
 * ---------------------------------------------------------------------------
 *   There is no copy of the user's 200-odd coin records in the repository, so
 *   the inventory here is DERIVED from the filenames themselves: one coin per
 *   distinct (year, denomination, coin type) the parser reads out of the
 *   corpus, carrying the mint mark / grade / cert details of the first
 *   filename that produced it.
 *
 *   That is a fair stand-in and it reproduces both of the ambiguous situations
 *   the owner described, because the corpus really does contain several shots
 *   of one coin and several coins that differ only in the details:
 *     - multiple images for one coin (six "1913 50-Cent Canadian" shots),
 *     - images whose extra attributes disagree with the record they match.
 *
 *   What it is NOT is a prediction of the exact split on all 2,140 files. Read
 *   the printed table as "this is the shape", not "this is the forecast".
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { CoinRecord, ImportTier } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import { REAL_FILENAMES } from '../../testing/real-filenames.fixture';

const service = () => new ImageMatchingService();

/** A CoinRecord with sensible blanks, so each case states only what it needs. */
function coin(overrides: Partial<CoinRecord> & { id: string }): CoinRecord {
  return {
    denomination: '', year: '', coinType: '', category: '', country: 'United States',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths: [], source: 'manual',
    ...overrides
  };
}

/**
 * Build a plausible inventory out of the corpus itself: one coin per distinct
 * (year, denomination, coin type) the parser can read, with the mint mark,
 * grade and certification details merged in from whichever of that coin's
 * photos happened to mention them.
 *
 * The merge matters. A real coin record is filled in once and completely,
 * while its eight photos each mention a different subset of its attributes --
 * so merging is what makes the synthetic records resemble real ones rather
 * than being perfect copies of a single filename.
 */
function inventoryFromFilenames(files: readonly string[]): CoinRecord[] {
  const matcher = service();
  const byKey = new Map<string, CoinRecord>();

  for (const file of files) {
    const parsed = matcher.parseFilename(file);
    if (parsed.isNonCoin || parsed.isEmpty) continue;

    const key = [parsed.year ?? '', parsed.denomination ?? '', parsed.coinTypeTokens.join(' ')].join('|');
    let record = byKey.get(key);
    if (!record) {
      record = coin({
        id: `coin-${byKey.size + 1}`,
        year: parsed.year === null ? '' : String(parsed.year),
        // The canonical KEY, not the display label, so parseCoin reads back
        // the same denomination the filename parser produced.
        denomination: parsed.denomination ?? '',
        coinType: parsed.coinTypeTokens.join(' ')
      });
      byKey.set(key, record);
    }
    if (!record.mintMark && parsed.mintMark) record.mintMark = parsed.mintMark;
    if (!record.grade && parsed.grade) record.grade = parsed.grade;
    if (!record.certCompany && parsed.certCompanies[0]) record.certCompany = parsed.certCompanies[0];
    if (!record.certNumber && parsed.certNumbers[0]) record.certNumber = parsed.certNumbers[0];
  }

  return [...byKey.values()];
}

/** Tally the corpus by tier, and by the OLD two-bucket split, side by side. */
function measure(files: readonly string[], inventory: CoinRecord[]) {
  const results = service().matchImages([...files], inventory);

  const tiers: Record<ImportTier, string[]> = { matched: [], near: [], 'not-imported': [] };
  /* The OLD screen had only two buckets and both of them cost the user a
   * per-file decision: 'review' (ranked candidates, a search box) and 'none'
   * (the same card, with nothing to rank). */
  const oldManual: string[] = [];
  const oldAuto: string[] = [];

  for (const result of results) {
    tiers[result.tier].push(result.parsed.fileName);
    if (result.status === 'auto') oldAuto.push(result.parsed.fileName);
    else oldManual.push(result.parsed.fileName);
  }

  return { results, tiers, oldAuto, oldManual };
}

describe('import tiers - how the real corpus divides', () => {
  const inventory = inventoryFromFilenames(REAL_FILENAMES);
  const { results, tiers, oldAuto, oldManual } = measure(REAL_FILENAMES, inventory);

  it('prints the before/after distribution', () => {
    const total = REAL_FILENAMES.length;
    const line = (label: string, n: number) =>
      `  ${label.padEnd(22)} ${String(n).padStart(4)}  (${((n / total) * 100).toFixed(1)}%)`;

    // Deliberately a console table, not an assertion. The exact numbers are
    // asserted loosely below; this is here so the split is visible whenever
    // anyone runs the suite.
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `Image import tiers over ${total} verbatim filenames`,
        `(inventory: ${inventory.length} coins derived from the same corpus)`,
        '  BEFORE - two buckets:',
        line('attached', oldAuto.length),
        line('manual decisions', oldManual.length),
        '  AFTER - three tiers:',
        line('1 matched', tiers.matched.length),
        line('2 near (yes/no)', tiers.near.length),
        line('3 not imported', tiers['not-imported'].length),
        ''
      ].join('\n')
    );

    expect(total).toBe(tiers.matched.length + tiers.near.length + tiers['not-imported'].length);
  });

  it('leaves strictly fewer files needing attention than the old two-bucket screen', () => {
    // This is the point of the whole exercise: tier 2 is what the user has to
    // look at, and it must be smaller than the old manual pile.
    expect(tiers.near.length).toBeLessThan(oldManual.length);
  });

  it('does not attach a single file more than the old gates did', () => {
    // The tiers reorganise the ASKING. They must not make the matcher braver.
    expect(tiers.matched.length).toBe(oldAuto.length);
    expect(tiers.matched).toEqual(oldAuto);
  });

  it('gives every not-imported file a reason, so nothing is silently dropped', () => {
    const skipped = results.filter(r => r.tier === 'not-imported');
    expect(skipped.length).toBeGreaterThan(0);
    for (const result of skipped) {
      expect(result.skipReason, result.parsed.fileName).toBeTruthy();
      expect(result.skipReason!.length, result.parsed.fileName).toBeGreaterThan(10);
      // And no row in this tier may carry a coin to attach to.
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
    }
  });

  it('puts every group shot, non-coin and camera name in the read-only tier', () => {
    // These are the files that used to fill the manual list with nothing to
    // decide. None of them may ever reach tier 1 or tier 2.
    for (const name of [
      'Gold Coins.JPG', '20th Century Type Set.JPG', 'Stamp - 11 - 3 cent.jpg',
      '3-cent paper - Large.jpg', 'CSA Bond Coupon.jpg', 'Sovereign Proof Boxes.jpg',
      'Coin_026.JPG', 'IM000025.JPG', 'Canadian Cents - Part 1.jpg'
    ]) {
      expect(tiers['not-imported'], name).toContain(name);
    }
  });

  it('puts the ancients in the read-only tier, not in the user\'s queue', () => {
    // An ancient has no year, no denomination and no grade, so three of the
    // four required attributes are simply absent. There is no yes/no question
    // to ask about it, and under the old screen each one still cost a card.
    for (const name of [
      'Caracalla Denarius - Sear 6819 - Obverse.jpg',
      'Constantine - RIC 34 - Obverse.jpg',
      'Bar Kochba - Hendin 736 - Obverse 1.jpg',
      '67-68 CE 1st Revolt - Obverse - 2.jpg'
    ]) {
      expect(tiers['not-imported'], name).toContain(name);
    }
  });

  it('prints why each coin-like file was skipped, so the cost is visible', () => {
    /* The useful operational number. Most tier-3 rows are group shots and
     * stamps, which is as it should be -- but some are real single-coin photos
     * that failed the four-attribute bar, and the owner needs to see how many
     * and why, because the fix for those is in the DATA (fill in the record's
     * grade, or rename the file) and not in the matcher. */
    /* THREE BUCKETS, NOT TWO, SINCE THE EXCLUSION RULE LANDED.
     *
     * A counterfeit or multi-coin photo is `excludedFromAutoImport` but is
     * NOT `isNonCoin` -- the words are different verdicts on purpose (see
     * non-coin-detector.ts). Without this line such a file would be counted
     * below as "a single-coin photo that missed the near-match bar", which is
     * untrue twice over: it is not necessarily one coin, and it did not miss
     * anything -- it was held out deliberately.
     *
     * The count is ZERO today and the printed census is unmoved by that work,
     * because real-filenames.fixture.ts contains none of the 30 marker files
     * (they are tabled in real-filenames.spec.ts instead, with the reasoning).
     * The bucket exists so that the day one is added, the table says the
     * truth about it rather than quietly mis-filing it. */
    const excluded = results.filter(
      r => r.tier === 'not-imported' && r.parsed.excludedFromAutoImport
    );
    const coinLike = results.filter(
      r => r.tier === 'not-imported' && !r.parsed.isNonCoin && !r.parsed.excludedFromAutoImport
    );
    const tally = new Map<string, number>();
    const bump = (reason: string) => tally.set(reason, (tally.get(reason) ?? 0) + 1);

    for (const result of coinLike) {
      const why = result.skipReason ?? '';
      if (why.includes('filename does not give a grade')) bump('filename carries no grade');
      else if (why.includes('coin record does not give a grade')) bump('coin record carries no grade');
      else if (why.includes('not the same grade') || why.includes('different numeric grades')) bump('grades genuinely differ');
      else if (why.includes('names no coin type')) bump('filename names no coin type');
      else if (why.includes('carries no year')) bump('filename carries no year');
      else if (why.includes('carries no denomination')) bump('filename carries no denomination');
      else bump('other');
    }

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        `Of ${results.filter(r => r.tier === 'not-imported').length} not-imported files, ` +
        `${results.filter(r => r.tier === 'not-imported' && !r.parsed.excludedFromAutoImport && r.parsed.isNonCoin).length} are group shots / non-coins / camera names`,
        `${excluded.length} are counterfeits or multi-coin shots, held out of the run entirely`,
        `and ${coinLike.length} are single-coin photos that missed the near-match bar:`,
        ...[...tally.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `  ${String(count).padStart(3)}  ${reason}`),
        ''
      ].join('\n')
    );

    // The three buckets must still partition tier 3 exactly -- nothing in
    // the read-only list may go uncounted and nothing may be counted twice.
    const nonCoin = results.filter(
      r => r.tier === 'not-imported' && !r.parsed.excludedFromAutoImport && r.parsed.isNonCoin
    );
    expect(coinLike.length + nonCoin.length + excluded.length)
      .toBe(tiers['not-imported'].length);
  });

  it('never lets a near match carry a coin id of its own', () => {
    // The single most important invariant of tier 2: it is a QUESTION, not a
    // decision. Nothing here is attached until the user presses a button.
    for (const result of results.filter(r => r.tier === 'near')) {
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
      expect(result.status, result.parsed.fileName).not.toBe('auto');
      expect(result.nearMatch, result.parsed.fileName).not.toBeNull();
      expect(result.nearMatch!.candidates.length).toBeGreaterThan(0);
    }
  });
});

/* =========================================================================
 * THE AMBIGUOUS CASES THE OWNER NAMED
 * =======================================================================
 * The measurement above runs against an inventory with no duplicates in it,
 * which is why tier 2 barely fires there. The two situations the owner
 * actually described both need near-identical records to be PRESENT, in the
 * same way real-filenames.spec.ts stocks a "baited" inventory to prove the
 * non-coin veto is doing the work.
 *
 * The 1881 Morgan Dollar is the right coin for this: the collection holds
 * several, they differ only by mint mark, and the filenames routinely omit
 * the mint mark that would separate them.
 */
describe('import tiers - the two ambiguous situations', () => {
  /** Two coins that differ ONLY by mint mark, both PCGS MS63. */
  const AMBIGUOUS: CoinRecord[] = [
    coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63', certCompany: 'PCGS' }),
    coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63', certCompany: 'PCGS' }),
    coin({ id: 'morgan-cc', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'CC', grade: 'MS66', certCompany: 'PCGS' })
  ];

  it('several coins fitting one image becomes ONE question with a dropdown', () => {
    const [result] = service().matchImages(['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'], AMBIGUOUS);

    expect(result.tier).toBe('near');
    // The two MS63 coins are offered; the MS66 is ranked by the matcher but
    // fails the grade test, so it never reaches the dropdown.
    expect(result.nearMatch!.candidates).toHaveLength(2);
    expect(result.nearMatch!.candidates.map(c => c.coinId).sort()).toEqual(['morgan-o', 'morgan-s']);
  });

  it('several sides of one coin all land on the same suggestion', () => {
    /* The owner's second case. The "- Obverse" name is verbatim from the
     * share; the other three follow the Obverse / Reverse / take-number
     * convention the survey shows everywhere (see
     * "1913 50-Cent Canadian - Obverse.jpg" / "- Reverse.jpg" /
     * "- Obverse 2.jpg" in the fixture). Grouping them by the coin they
     * point at is what turns four questions into one. */
    const sides = [
      '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',
      '1881 Morgan Dollar PCGS MS63 - Reverse.jpg',
      '1881 Morgan Dollar PCGS MS63 - Obverse 2.jpg',
      '1881 Morgan Dollar PCGS MS63 - Label.jpg'
    ];
    const results = service().matchImages(sides, AMBIGUOUS);

    for (const result of results) {
      expect(result.tier, result.parsed.fileName).toBe('near');
      expect(result.nearMatch!.suggestedCoinId, result.parsed.fileName)
        .toBe(results[0].nearMatch!.suggestedCoinId);
    }
    // Photo markers never affect the score, so all four rank identically.
    expect(new Set(results.map(r => r.confidence)).size).toBe(1);
  });

  /* ---------------------------------------------------------------------
   * THE NOTATION MISMATCH, END TO END
   * ---------------------------------------------------------------------
   * The owner: "the grade might slightly differ and still be correct like
   * 63CAM or 63 CAMEO or 63PL of 63 PL".
   *
   * WHY THIS IS NOT VISIBLE IN THE CENSUS ABOVE
   *   The census builds its inventory OUT OF THE FILENAMES, so both sides of
   *   every comparison are spelled by the same parser and a notation mismatch
   *   is impossible by construction. The owner's real records are typed by
   *   hand and his filenames are not, which is exactly where the two spellings
   *   come apart. These cases supply the mismatch the census cannot.
   * ------------------------------------------------------------------- */
  /** Two coins differing only by mint mark, graded in the VERBOSE notation. */
  const notated = (grade: string): CoinRecord[] => [
    coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade, certCompany: 'PCGS' }),
    coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade, certCompany: 'PCGS' })
  ];

  it('a filename saying CAMEO reaches tier 2 against a record saying CAM', () => {
    // Before the synonym table these were two unrelated tokens, each side held
    // something the other lacked, and a correct match was refused outright.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS PF64Cameo - Obverse.jpg'],
      notated('PF64 CAM')
    );

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.gradeRelation).toBe('exact');
  });

  it('a filename saying PL reaches tier 2 against a record saying PROOFLIKE', () => {
    // The harder half: "prooflike" was not in the grade vocabulary at all, so
    // the record's grade failed to parse and the pair was refused.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63PL - Obverse.jpg'],
      notated('MS63 PROOFLIKE')
    );

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.gradeRelation).toBe('exact');
  });

  it('but a DEEPER designation still keeps the row out of the queue', () => {
    // The hierarchy has to survive the end-to-end path too: deep cameo is a
    // stronger claim than cameo, and deep mirror prooflike than prooflike.
    for (const [file, grade] of [
      ['1881 Morgan Dollar PCGS PF64Cameo - Obverse.jpg', 'PF64 DCAM'],
      ['1881 Morgan Dollar PCGS MS63PL - Obverse.jpg', 'MS63 DEEP MIRROR PROOFLIKE']
    ]) {
      const [result] = service().matchImages([file], notated(grade));
      expect(result.tier, `${file} vs ${grade}`).toBe('not-imported');
    }
  });

  it('still refuses when the only MS63-graded coin is a different coin type', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      [coin({ id: 'peace', year: '1881', denomination: 'Dollar', coinType: 'Peace', grade: 'MS63', certCompany: 'PCGS' })]
    );

    expect(result.tier).toBe('not-imported');
    expect(result.skipReason).toContain('coin type');
  });
});
