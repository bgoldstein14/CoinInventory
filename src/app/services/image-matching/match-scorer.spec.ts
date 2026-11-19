/*
 * Tests that `scorePair` uses the shared grade tolerance, and that extra
 * detail on one side earns the grade's weight but not a strong attribute.
 * The grade comparison itself is tested in near-match.spec.ts.
 */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import { parseCoin } from './coin-signature';
import { toSignature } from './filename-parser';
import { compareGrades } from './grade-tolerance';
// Second import path, to check both lead to one implementation.
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
    // A second copy of the comparison would let the scorer and tier 2 drift
    // apart (e.g. PF65CAM vs PF65 Cameo scoring either side of the bar).
    expect(nearMatchCompareGrades).toBe(compareGrades);
  });
});

describe('the scorer reads a grade with the same tolerance tier 2 does', () => {
  it('treats PR and PF as one grade', () => {
    // PCGS prints PR, NGC prints PF, for the same striking.
    expect(compareGrades('PF64', 'PR64').relation).toBe('exact');
    expect(compareGrades('PF64CAM', 'PR64 Cameo').relation).toBe('exact');
  });

  it('but a different grade is still a different grade', () => {
    expect(compareGrades('PF64', 'PF65').relation).toBe('different');
    expect(compareGrades('PF64CAM', 'PF64DCAM').relation).toBe('different');
    expect(compareGrades('MS64RB', 'MS64BN').relation).toBe('different');
  });
});

describe('extra detail agrees, but never earns a STRONG attribute', () => {
  it('scores the same, with one fewer strong attribute', () => {
    // "PF64" vs "PF64RB": same grade with extra detail, so full weight but no
    // strong attribute. Record modelled on "1866 2¢ - PCGS/CAC PF64RB".
    const comparison = compareGrades('PF64', 'PF64RB');
    expect(comparison.relation).toBe('extra-detail');

    const file = toSignature(service().parseFilename('1866 2 cent - PCGS PF64 - Obverse.jpg'));
    const record = parseCoin(
      coin({ id: 'two-cent-1866', year: '1866', denomination: '2¢', coinType: 'Two Cent',
             grade: 'PF64RB', certCompany: 'PCGS' })
    );

    const exact = scorePair(file, { ...record, grade: 'pf64' });
    const detailed = scorePair(file, record); // the record's own PF64RB

    expect(detailed.score).toBe(exact.score);
    // Cert company + grade only form a strong attribute on an exact grade.
    expect(detailed.strongAttributeCount).toBe(exact.strongAttributeCount - 1);
  });
});
