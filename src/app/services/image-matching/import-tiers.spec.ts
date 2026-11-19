 /*
 * How the three import tiers divide the real filename corpus (the rule itself
 * is tested in near-match.spec.ts). The inventory is derived from the
 * filenames, so the printed split shows the shape, not an exact forecast.
  */

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
 * Build an inventory from the corpus: one coin per distinct (year,
 * denomination, coin type), with mint mark, grade and cert details merged from
 * whichever photos mention them, so records resemble complete real ones.
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
        // The canonical key, so parseCoin reads back the same denomination.
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

/** Tally the corpus by tier, and by the auto/manual status split, side by side. */
function measure(files: readonly string[], inventory: CoinRecord[]) {
  const results = service().matchImages([...files], inventory);

  const tiers: Record<ImportTier, string[]> = { matched: [], near: [], 'not-imported': [] };
  // Two-bucket comparison: 'auto' vs everything needing a per-file decision.
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

    // Printed so the split is visible; numbers are asserted loosely below.
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
    expect(tiers.near.length).toBeLessThan(oldManual.length);
  });

  it('does not attach a single file more than the old gates did', () => {
    // Tiers change how the user is asked, not what is auto-attached.
    expect(tiers.matched.length).toBe(oldAuto.length);
    expect(tiers.matched).toEqual(oldAuto);
  });

  it('gives every not-imported file a reason, so nothing is silently dropped', () => {
    const skipped = results.filter(r => r.tier === 'not-imported');
    expect(skipped.length).toBeGreaterThan(0);
    for (const result of skipped) {
      expect(result.skipReason, result.parsed.fileName).toBeTruthy();
      expect(result.skipReason!.length, result.parsed.fileName).toBeGreaterThan(10);
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
    }
  });

  it('puts every group shot, non-coin and camera name in the read-only tier', () => {
    for (const name of [
      'Gold Coins.JPG', '20th Century Type Set.JPG', 'Stamp - 11 - 3 cent.jpg',
      '3-cent paper - Large.jpg', 'CSA Bond Coupon.jpg', 'Sovereign Proof Boxes.jpg',
      'Coin_026.JPG', 'IM000025.JPG', 'Canadian Cents - Part 1.jpg'
    ]) {
      expect(tiers['not-imported'], name).toContain(name);
    }
  });

  it('puts the ancients in the read-only tier, not in the user\'s queue', () => {
    // Ancients lack year, denomination and grade, so there is no yes/no
    // question to ask.
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
    // Tier 3 splits into non-coins, auto-import exclusions (a separate
    // verdict from isNonCoin) and single-coin photos that missed the
    // near-match bar; the last group is usually fixed in the data.
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

    // The three buckets must partition tier 3 exactly.
    const nonCoin = results.filter(
      r => r.tier === 'not-imported' && !r.parsed.excludedFromAutoImport && r.parsed.isNonCoin
    );
    expect(coinLike.length + nonCoin.length + excluded.length)
      .toBe(tiers['not-imported'].length);
  });

  it('never lets a near match carry a coin id of its own', () => {
    // Tier 2 is a question: nothing is attached until the user confirms.
    for (const result of results.filter(r => r.tier === 'near')) {
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
      expect(result.status, result.parsed.fileName).not.toBe('auto');
      expect(result.nearMatch, result.parsed.fileName).not.toBeNull();
      expect(result.nearMatch!.candidates.length).toBeGreaterThan(0);
    }
  });
});

/*
 * Ambiguous cases need near-identical records present, which the derived
 * inventory above lacks. 1881 Morgans differing only by mint mark serve,
 * since filenames often omit the mint mark.
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

  // Grade notation mismatches (63CAM vs 63 CAMEO). The census above can't
  // produce these because both sides there come from the same parser.
  /** Two coins differing only by mint mark, graded in the verbose notation. */
  const notated = (grade: string): CoinRecord[] => [
    coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade, certCompany: 'PCGS' }),
    coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade, certCompany: 'PCGS' })
  ];

  it('a filename saying CAMEO reaches tier 2 against a record saying CAM', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS PF64Cameo - Obverse.jpg'],
      notated('PF64 CAM')
    );

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.gradeRelation).toBe('exact');
  });

  it('a filename saying PL reaches tier 2 against a record saying PROOFLIKE', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63PL - Obverse.jpg'],
      notated('MS63 PROOFLIKE')
    );

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.gradeRelation).toBe('exact');
  });

  it('but a DEEPER designation still keeps the row out of the queue', () => {
    // Deep cameo / DMPL are stronger claims than cameo / PL.
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
