/* ===========================================================================
 * match-scorer.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That `scorePair` applies the GRADE TOLERANCE the same way tier 2 does,
 *   and that it is stingy in the one place the owner asked it to be: extra
 *   detail on one side earns the grade's WEIGHT but not a STRONG ATTRIBUTE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *   These assertions used to live in `three-cent-proofs.spec.ts`, a spec
 *   named after one collection of coins. The owner saw that file and said:
 *
 *     "I wouldn't expect there to be a special file to single out a
 *      particular type of coin like the three-cent-proofs.spec.ts. That's
 *      too specific and will just add a lot of noise to this project if we
 *      had files for every denomination. Likely, whatever rules are in there
 *      can be applied across the board."
 *
 *   He is right, and these were the clearest example of the problem: not one
 *   of them is about three-cent pieces. They are facts about the SCORER, and
 *   they belong in a file named after the scorer. The collection-shaped tests
 *   that really did need his inventory moved to inventory-accounts.spec.ts,
 *   which runs every account through one data-driven suite.
 *
 *   `near-match.spec.ts` owns the grade comparison itself (every relation,
 *   both directions, every synonym table). This file owns only what the
 *   SCORER does with the answer.
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import { parseCoin } from './coin-signature';
import { toSignature } from './filename-parser';
import { compareGrades } from './grade-tolerance';
// Imported under a second name purely so one test can prove that the two
// import paths lead to ONE implementation. See the test below.
import { compareGrades as nearMatchCompareGrades } from './near-match';
import { scorePair } from './match-scorer';

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

describe('there is exactly ONE implementation of grade equivalence', () => {
  it('the scorer and tier 2 call the same function object', () => {
    /* THE REGRESSION TEST FOR THE REASON THIS WAS A MOVE AND NOT A COPY.
     *
     * The tolerance used to live in near-match.ts, where only the tier-2
     * four-attribute test could reach it, while match-scorer.ts still
     * compared grade strings with a plain `===`. The owner measured the
     * consequence himself on two photographs of ONE coin:
     *
     *     1867 3CS - NGC PF65CAM - Reverse.jpg       scored 0.84 -> skipped
     *     1867 3CS - NGC PF65 Cameo - Obverse.jpg    scored 0.88 -> attached
     *
     * 0.03 apart, which is exactly the distance across the 0.85 auto-match
     * bar. The fix could have been to copy the comparison into the scorer.
     * It was not, because TWO IMPLEMENTATIONS OF "ARE THESE THE SAME GRADE?"
     * WOULD DRIFT -- and the day they drifted, the scorer would be rewarding
     * a pairing the near-match test refuses, or the reverse.
     *
     * `compareGrades` now lives in grade-tolerance.ts; near-match.ts
     * re-exports it and match-scorer.ts imports it. If someone ever writes a
     * second copy, these two stop being the same function object and this
     * test fails. */
    expect(nearMatchCompareGrades).toBe(compareGrades);
  });
});

describe('the scorer reads a grade with the same tolerance tier 2 does', () => {
  it('treats PR and PF as one grade', () => {
    // PCGS prints PR, NGC prints PF, for the same striking. His Early Proofs
    // records use both notations, sometimes for coins of adjacent years.
    expect(compareGrades('PF64', 'PR64').relation).toBe('exact');
    expect(compareGrades('PF64CAM', 'PR64 Cameo').relation).toBe('exact');
  });

  it('but a different grade is still a different grade', () => {
    // Nothing above loosened the line he drew: "MS64 vs MS63 is a different
    // coin", and CAM is not DCAM.
    expect(compareGrades('PF64', 'PF65').relation).toBe('different');
    expect(compareGrades('PF64CAM', 'PF64DCAM').relation).toBe('different');
    expect(compareGrades('MS64RB', 'MS64BN').relation).toBe('different');
  });
});

describe('extra detail agrees, but never earns a STRONG attribute', () => {
  it('scores the same, with one fewer strong attribute', () => {
    /* THE DELIBERATELY STINGY HALF OF THE RULE.
     *
     * "PF64" and "PF64RB" are the same grade -- one side simply says more --
     * so the grade AGREES and earns its weight in the score. It may NOT help
     * clear the two-strong-attributes gate, because the two sides did not say
     * the same thing, and his tie-breaker is that the automated process
     * should be "very descriminatory".
     *
     * The record is the reference "1866 2¢ - PCGS/CAC PF64RB", stated here rather
     * than read out of a QIF because the assertion is about the SCORER and
     * nothing about it needs a whole inventory. */
    const comparison = compareGrades('PF64', 'PF64RB');
    expect(comparison.relation).toBe('extra-detail');

    const file = toSignature(service().parseFilename('1866 2 cent - PCGS PF64 - Obverse.jpg'));
    const record = parseCoin(
      coin({ id: 'two-cent-1866', year: '1866', denomination: '2¢', coinType: 'Two Cent',
             grade: 'PF64RB', certCompany: 'PCGS' })
    );

    const exact = scorePair(file, { ...record, grade: 'pf64' });
    const detailed = scorePair(file, record); // the record's own PF64RB

    // Same score...
    expect(detailed.score).toBe(exact.score);
    // ...but one fewer strong attribute, because the grading company and the
    // grade only pair up into a strong attribute when the grade agreement is
    // EXACT.
    expect(detailed.strongAttributeCount).toBe(exact.strongAttributeCount - 1);
  });
});
