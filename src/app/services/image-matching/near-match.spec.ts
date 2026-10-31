/* ===========================================================================
 * near-match.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   The near-match RULE, on its own, away from the UI:
 *
 *     1. the grade tolerance, in BOTH directions -- extra information is
 *        forgiven, a different grade never is;
 *     2. the four required attributes, one failure at a time;
 *     3. that the three tiers come out where they should;
 *     4. that a near match can never attach itself.
 *
 *   import-tiers.spec.ts measures the CONSEQUENCE across the whole real
 *   filename corpus. This file pins down the rule.
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import { buildCoinSignatures, parseCoin } from './coin-signature';
import { parseFilename, toSignature } from './filename-parser';
import { GRADE_DESIGNATION_WORDS } from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';
import { matchOneImage } from './match-decider';
import {
  GRADE_DESIGNATION_SYNONYMS,
  NEAR_MATCH_EXTRA_DESIGNATIONS,
  assessNearMatch,
  assignImportTier,
  compareGrades,
  parseGradeParts
} from './near-match';

const service = () => new ImageMatchingService();

function coin(overrides: Partial<CoinRecord> & { id: string }): CoinRecord {
  return {
    denomination: '', year: '', coinType: '', category: '', country: 'United States',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths: [], source: 'manual',
    ...overrides
  };
}

/* =========================================================================
 * 1. THE GRADE TOLERANCE
 * =======================================================================
 * The owner's rule, verbatim: the grade may be "a little off" only when the
 * difference is EXTRA INFORMATION. Both directions are tested, because the
 * easy mistake is to be lenient enough that MS64 starts matching MS63.
 */
describe('grade tolerance - extra information is forgiven', () => {
  const SAME_GRADE_MORE_DETAIL: Array<[string, string, string]> = [
    ['MS64', 'MS64 CAC', 'a CAC sticker noted on the record only'],
    ['MS64 CAC', 'MS64', 'the same, with the sides swapped'],
    ['PF69', 'PF69DCAM', 'deep cameo noted on one side'],
    ['PF69 DCAM', 'PF69', 'the same, swapped'],
    ['AU58', 'AU58+', 'the plus noted on one side'],
    ['AU58+', 'AU58', 'the same, swapped'],
    ['VF', 'Choice VF', 'an adjective in front'],
    ['MS-63', 'ms63', 'the same grade spelled two ways'],
    ['PF64', 'PF64Cameo', 'a cameo designation'],
    ['MS65', 'MS65 PQ', 'premium quality'],
    ['XF', 'XF40', 'the record states the number, the filename does not']
  ];

  for (const [left, right, why] of SAME_GRADE_MORE_DETAIL) {
    it(`"${left}" and "${right}" are the same grade (${why})`, () => {
      const forwards = compareGrades(left, right);
      expect(forwards.relation, `${left} vs ${right}`).not.toBe('different');
      expect(forwards.relation).not.toBe('missing');
    });
  }

  it('reports an identical grade as exact, not merely tolerated', () => {
    expect(compareGrades('MS63', 'MS-63').relation).toBe('exact');
    expect(compareGrades('PF69 DCAM', 'pf69dcam').relation).toBe('exact');
  });

  it('names the extra detail so the user can see what differs', () => {
    const comparison = compareGrades('MS64', 'MS64 CAC');
    expect(comparison.relation).toBe('extra-detail');
    expect(comparison.extraDetail).toContain('cac');
    expect(comparison.description).toContain('MS64CAC');
  });
});

describe('grade tolerance - a different grade is never forgiven', () => {
  const DIFFERENT_GRADES: Array<[string, string, string]> = [
    ['MS64', 'MS63', 'one point apart is a different coin'],
    ['MS64 CAC', 'MS63 CAC', 'still a different coin with the sticker on both'],
    ['PF69', 'PF68DCAM', 'a different number, however much detail follows'],
    ['MS64', 'AU64', 'the same number, different letters'],
    ['AU58', 'AU58 details', 'a "details" coin is a problem coin, not an AU58'],
    ['MS64RB', 'MS64BN', 'red-brown and brown contradict one another'],
    ['MS64 CAC', 'MS64+', 'each side says something the other does not'],
    ['XF', 'XF-AU', 'a range is a different statement from a single grade'],
    ['VF', 'VF-XF', 'the same, the other way round']
  ];

  for (const [left, right, why] of DIFFERENT_GRADES) {
    it(`"${left}" is not "${right}" (${why})`, () => {
      expect(compareGrades(left, right).relation, `${left} vs ${right}`).toBe('different');
      expect(compareGrades(right, left).relation, `${right} vs ${left}`).toBe('different');
    });
  }

  it('treats a missing grade on either side as missing, never as agreement', () => {
    expect(compareGrades(null, 'MS63').relation).toBe('missing');
    expect(compareGrades('MS63', '').relation).toBe('missing');
    expect(compareGrades(null, null).relation).toBe('missing');
  });

  it('refuses a grade it cannot take apart rather than guessing', () => {
    // Unrecognised shapes must not be quietly treated as decoration.
    expect(parseGradeParts('ms64wibble')).toBeNull();
    expect(compareGrades('MS64', 'MS64 wibble').relation).toBe('different');
  });

  it('splits the real spellings this collection uses', () => {
    expect(parseGradeParts('pf69dcam')).toEqual({ modifiers: [], base: 'pf', number: '69', decorations: ['dcam'] });
    expect(parseGradeParts('choicevf')).toEqual({ modifiers: ['choice'], base: 'vf', number: null, decorations: [] });
    expect(parseGradeParts('xf-au')).toEqual({ modifiers: [], base: 'xf-au', number: null, decorations: [] });
    expect(parseGradeParts('au58+')).toEqual({ modifiers: [], base: 'au', number: '58', decorations: ['+'] });
    expect(parseGradeParts('vg')).toEqual({ modifiers: [], base: 'vg', number: null, decorations: [] });
  });
});

/* =========================================================================
 * 1b. EQUIVALENT NOTATIONS
 * =======================================================================
 * The owner's words, verbatim:
 *
 *   "Keep in mind that the grade might slightly differ and still be correct
 *    like 63CAM or 63 CAMEO or 63PL of 63 PL or something like that. Also,
 *    CAC might be missing on the picture but it's in the inventory."
 *
 * Two separate claims, tested separately below:
 *   (a) an ABBREVIATION and the WORD it abbreviates are one grade;
 *   (b) a designation present on one side only is extra detail, not a clash.
 *
 * Every pair is tested in BOTH directions, because the filename may be the
 * terse side or the verbose side and neither is privileged.
 */
describe('grade tolerance - equivalent notations are one grade', () => {
  /** [terse, verbose, what the designation means]. */
  const EQUIVALENT: Array<[string, string, string]> = [
    // -- the owner's own examples ---------------------------------------
    ['MS63PL', 'MS63 PL', 'only the spacing differs'],
    ['63 CAM', '63CAM', 'only the spacing differs, with no grade letters'],
    ['MS63CAM', 'MS63 CAMEO', 'CAM is the abbreviation of CAMEO'],
    ['63CAM', '63 CAMEO', 'the same, written the way the owner writes it'],
    ['MS63PL', 'MS63 PROOFLIKE', 'PL is the abbreviation of PROOFLIKE'],
    ['MS63PL', 'MS63 PROOF LIKE', 'PROOFLIKE is also written as two words'],

    // -- cameo family ----------------------------------------------------
    ['PF64CAM', 'PF64Cameo', 'the spelling this collection actually uses'],
    ['PF69DCAM', 'PF69 DEEP CAMEO', 'DCAM is the abbreviation of DEEP CAMEO'],
    ['PF69DCAM', 'PF69DCAMEO', 'and of DCAMEO'],
    ['PF69DCAM', 'PF69 DC', 'DC is the short form of DCAM'],
    ['PF69UCAM', 'PF69 ULTRA CAMEO', 'UCAM is the abbreviation of ULTRA CAMEO'],

    // -- prooflike family ------------------------------------------------
    ['MS64DMPL', 'MS64 DPL', 'PCGS writes DMPL where NGC writes DPL'],
    ['MS64DMPL', 'MS64 DEEP MIRROR PROOFLIKE', 'and the words behind it'],

    // -- copper colour ---------------------------------------------------
    ['MS65RD', 'MS65 RED', 'RD is the abbreviation of RED'],
    ['MS64RB', 'MS64 RED BROWN', 'RB is the abbreviation of RED BROWN'],
    ['MS64RB', 'MS64 RED-BROWN', 'hyphenated, which normalizeGrade keeps'],
    ['MS64BN', 'MS64 BROWN', 'BN is the abbreviation of BROWN'],

    // -- strike completeness ---------------------------------------------
    ['MS66FB', 'MS66 FULL BANDS', 'Mercury dime'],
    ['MS65FS', 'MS65 FULL STEPS', 'Jefferson nickel'],
    ['MS65FH', 'MS65 FULL HEAD', 'Standing Liberty quarter'],
    ['MS67FT', 'MS67 FULL TORCH', 'Roosevelt dime'],
    ['MS65FBL', 'MS65 FULL BELL LINES', 'Franklin half'],
    ['MS66FSB', 'MS66 FULL SPLIT BANDS', 'Mercury dime, split-band wording'],

    // -- the grade LETTERS that are two spellings of one thing -----------
    ['PR69', 'PF69', 'PCGS prints PR where NGC prints PF'],
    ['PR69DCAM', 'PF69 DEEP CAMEO', 'both halves folded at once'],
    ['XF40', 'EF40', 'EF is the older spelling of XF'],
    ['XF-AU', 'EF-AU', 'and inside a range too'],

    // -- order is not meaning --------------------------------------------
    ['MS64 CAC PQ', 'MS64 PQ CAC', 'the same two notes, written in either order']
  ];

  for (const [terse, verbose, why] of EQUIVALENT) {
    it(`"${terse}" and "${verbose}" are one grade (${why})`, () => {
      // Neither side says anything the other does not, so this is not merely
      // tolerated as "extra detail" -- it is the SAME grade.
      expect(compareGrades(terse, verbose).relation, `${terse} vs ${verbose}`).toBe('exact');
      expect(compareGrades(verbose, terse).relation, `${verbose} vs ${terse}`).toBe('exact');
    });
  }

  it('canonicalises the spelling rather than keeping whichever side was read', () => {
    expect(parseGradeParts(normalizeGrade('PF69 DEEP CAMEO')!)).toEqual(
      { modifiers: [], base: 'pf', number: '69', decorations: ['dcam'] }
    );
    expect(parseGradeParts(normalizeGrade('MS64 RED-BROWN')!)).toEqual(
      { modifiers: [], base: 'ms', number: '64', decorations: ['rb'] }
    );
    expect(parseGradeParts(normalizeGrade('PR69')!)).toEqual(
      { modifiers: [], base: 'pf', number: '69', decorations: [] }
    );
  });

  it('reads "RED-BROWN" as the one designation RB, never as RED then BROWN', () => {
    // The ordering trap: 'red' and 'brown' are both recognised spellings, so a
    // shortest-first match would turn one designation into two contradicting
    // colour codes and refuse a perfectly good pair.
    expect(parseGradeParts('ms64red-brown')!.decorations).toEqual(['rb']);
    expect(parseGradeParts('ms64redbrown')!.decorations).toEqual(['rb']);
  });

  it('reads "CAMEO" as CAM, never as CAM plus a leftover', () => {
    expect(parseGradeParts('pf64cameo')!.decorations).toEqual(['cam']);
    expect(parseGradeParts('pf69dcameo')!.decorations).toEqual(['dcam']);
  });

  it('knows every designation the shared vocabulary lists', () => {
    // A word added to GRADE_DESIGNATION_WORDS (or to the extra list) must not
    // silently stop parsing here just because nobody gave it a synonym group.
    for (const word of [...GRADE_DESIGNATION_WORDS, ...NEAR_MATCH_EXTRA_DESIGNATIONS]) {
      expect(parseGradeParts(`ms65${word}`), word).not.toBeNull();
    }
  });

  it('gives every synonym group a distinct canonical token', () => {
    // Two groups sharing a canonical token would merge two designations that
    // the table says are different -- the exact mistake it exists to prevent.
    const canonicals = GRADE_DESIGNATION_SYNONYMS.map(group => group.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it('is not a grade at all when there are neither letters nor a number', () => {
    expect(parseGradeParts('cac')).toBeNull();
    expect(parseGradeParts('+')).toBeNull();
  });
});

describe('grade tolerance - abbreviations that only LOOK alike stay different', () => {
  /* The hierarchy must survive. CAM and DCAM share three letters and mean two
   * different things: a 1960s proof in DCAM can be worth several times the
   * same coin in plain CAM, so folding them together would offer the user the
   * wrong coin. The copper colours are the same story. */
  const NOT_THE_SAME: Array<[string, string, string]> = [
    ['PF69CAM', 'PF69DCAM', 'cameo is not deep cameo'],
    ['PF69 CAMEO', 'PF69 DEEP CAMEO', 'and the long spellings are not either'],
    ['PF69CAM', 'PF69UCAM', 'cameo is not ultra cameo'],
    ['MS64PL', 'MS64DMPL', 'prooflike is not deep mirror prooflike'],
    ['MS64 PROOFLIKE', 'MS64 DEEP MIRROR PROOFLIKE', 'nor spelled out'],
    ['MS64RD', 'MS64RB', 'red is not red-brown'],
    ['MS65 RED', 'MS65 RED-BROWN', 'nor spelled out'],
    ['MS64RB', 'MS64 BROWN', 'red-brown is not brown'],
    ['MS64 RED', 'MS64 BROWN', 'red is not brown'],
    ['MS66FB', 'MS66 FULL STEPS', 'full bands is not full steps'],
    ['MS63CAM', 'MS64 CAMEO', 'the number still rules, whatever follows it'],
    ['PF69 DCAM', 'SP69 DCAM', 'proof is not specimen, however alike the suffix']
  ];

  for (const [left, right, why] of NOT_THE_SAME) {
    it(`"${left}" is not "${right}" (${why})`, () => {
      expect(compareGrades(left, right).relation, `${left} vs ${right}`).toBe('different');
      expect(compareGrades(right, left).relation, `${right} vs ${left}`).toBe('different');
    });
  }
});

/* =========================================================================
 * 1c. THE CAC CASE, BY NAME
 * =======================================================================
 * The owner: "CAC might be missing on the picture but it's in the inventory."
 *
 * A CAC sticker is a second opinion bought AFTER grading; it is pasted on the
 * slab and typed into the record, and it is routinely left out of a filename.
 * Its absence on one side therefore says nothing about WHICH coin this is --
 * which is why the rule has always forgiven a token only one side carries.
 * These tests exist so that behaviour cannot be regressed silently.
 */
describe('grade tolerance - a CAC sticker on one side only', () => {
  it('forgives CAC on the coin record but not in the filename', () => {
    const comparison = compareGrades('MS64', 'MS64 CAC');
    expect(comparison.relation).toBe('extra-detail');
    expect(comparison.extraDetail).toEqual(['cac']);
  });

  it('forgives CAC in the filename but not on the coin record', () => {
    const comparison = compareGrades('MS64 CAC', 'MS64');
    expect(comparison.relation).toBe('extra-detail');
    expect(comparison.extraDetail).toEqual(['cac']);
  });

  it('forgives CAC alongside another designation, in both directions', () => {
    expect(compareGrades('PF69 DCAM', 'PF69 DCAM CAC').relation).toBe('extra-detail');
    expect(compareGrades('PF69 DEEP CAMEO CAC', 'PF69DCAM').relation).toBe('extra-detail');
  });

  it('still refuses when the grade under the sticker is a different grade', () => {
    // CAC is forgiven; MS63 against MS64 never is.
    expect(compareGrades('MS63', 'MS64 CAC').relation).toBe('different');
    expect(compareGrades('MS64 CAC', 'MS63').relation).toBe('different');
  });

  it('is a near match end to end when only the record names CAC', () => {
    const file = toSignature(parseFilename('1881 Morgan Dollar PCGS MS63 - Obverse.jpg'));
    const record = parseCoin(coin({
      id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan',
      mintMark: 'S', grade: 'MS63 CAC', certCompany: 'PCGS'
    }));

    const verdict = assessNearMatch(file, record);
    expect(verdict.isNear).toBe(true);
    expect(verdict.grade.relation).toBe('extra-detail');
    expect(verdict.grade.extraDetail).toEqual(['cac']);
  });

  it('is a near match end to end when only the FILENAME names CAC', () => {
    /* The mirror image. grade-parser.ts stops reading a filename grade at the
     * number, so a real filename rarely carries CAC through -- the grade is
     * overridden here to pin the RULE rather than the filename regex, and to
     * prove the tolerance is symmetrical. */
    const file = {
      ...toSignature(parseFilename('1881 Morgan Dollar PCGS MS63 CAC - Obverse.jpg')),
      grade: normalizeGrade('MS63 CAC')
    };
    const record = parseCoin(coin({
      id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan',
      mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
    }));

    const verdict = assessNearMatch(file, record);
    expect(verdict.isNear).toBe(true);
    expect(verdict.grade.relation).toBe('extra-detail');
    expect(verdict.grade.extraDetail).toEqual(['cac']);
  });
});

/* =========================================================================
 * 2. THE FOUR REQUIRED ATTRIBUTES
 * =======================================================================
 * Year, coin type, denomination AND grade. All four, on both sides.
 */
describe('near match - all four attributes are required', () => {
  /** A filename and a coin that agree on everything that matters. */
  const FILE = '1881 Morgan Dollar PCGS MS63 - Obverse.jpg';
  const baseCoin = {
    id: 'morgan', year: '1881', denomination: 'Dollar',
    coinType: 'Morgan', grade: 'MS63', certCompany: 'PCGS'
  };

  const assess = (overrides: Partial<CoinRecord> = {}, file = FILE) =>
    assessNearMatch(toSignature(parseFilename(file)), parseCoin(coin({ ...baseCoin, ...overrides })));

  it('passes when all four agree', () => {
    const verdict = assess();
    expect(verdict.blockers).toEqual([]);
    expect(verdict.isNear).toBe(true);
  });

  it('fails when the coin record has no year', () => {
    expect(assess({ year: '' }).isNear).toBe(false);
  });

  it('fails when the years contradict', () => {
    expect(assess({ year: '1882' }).isNear).toBe(false);
  });

  it('accepts a file year inside a record year RANGE', () => {
    // Type-set entries are stored as "1878-1904"; the scorer treats that as a
    // range and so must this.
    expect(assess({ year: '1878-1904' }).isNear).toBe(true);
  });

  it('fails when the coin record has no coin type', () => {
    expect(assess({ coinType: '' }).isNear).toBe(false);
  });

  it('fails when the coin types contradict', () => {
    expect(assess({ coinType: 'Peace' }).isNear).toBe(false);
  });

  it('fails when the coin record has no denomination', () => {
    expect(assess({ denomination: '' }).isNear).toBe(false);
  });

  it('fails when the denominations contradict', () => {
    expect(assess({ denomination: 'Half Dollar' }).isNear).toBe(false);
  });

  it('fails when the coin record has no grade', () => {
    const verdict = assess({ grade: '' });
    expect(verdict.isNear).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('grade');
  });

  it('fails when the FILENAME has no grade', () => {
    // "1881-S Morgan Dollar.jpg" is verbatim from the share and scores very
    // highly, but with no grade in the name there is no fourth attribute to
    // agree on, so it is not a near match. This is the strict reading of the
    // rule and it is deliberate.
    const verdict = assess({}, '1881-S Morgan Dollar.jpg');
    expect(verdict.isNear).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('grade');
  });

  it('fails when the grades are genuinely different', () => {
    expect(assess({ grade: 'MS64' }).isNear).toBe(false);
  });

  it('passes when the grade differs only by extra information', () => {
    const verdict = assess({ grade: 'MS63 CAC' });
    expect(verdict.isNear).toBe(true);
    expect(verdict.grade.relation).toBe('extra-detail');
    // And it says so, because the user is being asked to accept it.
    expect(verdict.discrepancies.join(' ')).toContain('extra detail');
  });

  it('reports a disagreeing mint mark as a discrepancy, not a blocker', () => {
    // "Something else seems off" is exactly what makes this NEAR rather than
    // automatic, so it must not stop the pairing being offered.
    const verdict = assess({ mintMark: 'O' }, '1881-S Morgan Dollar PCGS MS63 - Obverse.jpg');
    expect(verdict.isNear).toBe(true);
    expect(verdict.discrepancies.join(' ')).toContain('mint mark');
  });

  it('reports a disagreeing cert company as a discrepancy, not a blocker', () => {
    const verdict = assess({ certCompany: 'NGC' });
    expect(verdict.isNear).toBe(true);
    expect(verdict.discrepancies.join(' ')).toContain('NGC');
  });
});

/* =========================================================================
 * 3. THE THREE TIERS END TO END
 * ======================================================================= */
describe('import tiers - the three buckets', () => {
  it("tier 1: a confident match is 'matched' and keeps its coin", () => {
    const inventory = [coin({ id: 'merc', year: '1945', denomination: 'Dime', coinType: 'Mercury' })];
    const [result] = service().matchImages(['mercury_dime_1945.jpg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.tier).toBe('matched');
    expect(result.matchedRecordId).toBe('merc');
    expect(result.nearMatch).toBeNull();
    expect(result.skipReason).toBeNull();
  });

  it("tier 2: two coins that differ only by mint mark become one yes/no question", () => {
    // The owner's first ambiguous case: several coins fit the same filename.
    const inventory = [
      coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63', certCompany: 'PCGS' }),
      coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'], inventory);

    expect(result.status).toBe('review');
    expect(result.tier).toBe('near');
    expect(result.nearMatch).not.toBeNull();
    // Both coins pass the four-attribute test, so BOTH are offered.
    expect(result.nearMatch!.candidates.map(c => c.coinId).sort()).toEqual(['morgan-o', 'morgan-s']);
    expect(result.nearMatch!.discrepancies.join(' ')).toContain('fits this filename just as well');
  });

  it("tier 2: a CAC sticker on the record only still produces a yes/no question", () => {
    const inventory = [
      coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63 CAC', certCompany: 'PCGS' }),
      coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63 CAC', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'], inventory);

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.gradeRelation).toBe('extra-detail');
    expect(result.nearMatch!.gradeNote).toContain('extra detail');
  });

  it("tier 2 does NOT appear when the grade genuinely differs", () => {
    // Same two coins, but graded MS64 while the filename says MS63. The
    // single most important negative case: one grade point is a different
    // coin, so this must fall through to the read-only tier.
    const inventory = [
      coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS64', certCompany: 'PCGS' }),
      coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS64', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'], inventory);

    expect(result.tier).toBe('not-imported');
    expect(result.nearMatch).toBeNull();
    expect(result.skipReason).toContain('different numeric grades');
  });

  it("tier 3: a non-coin photo is skipped with a reason and no candidates", () => {
    const inventory = [coin({ id: '3cs', year: '1851', denomination: 'Three Cent', coinType: 'Silver Trime' })];
    const [result] = service().matchImages(['Stamp - 11 - 3 cent.jpg'], inventory);

    expect(result.tier).toBe('not-imported');
    expect(result.skipReason).toContain('stamp');
    expect(result.candidates).toEqual([]);
  });

  it('tier 3: a camera-default name is skipped with a reason', () => {
    const inventory = [coin({ id: 'merc', year: '1945', denomination: 'Dime', coinType: 'Mercury' })];
    const [result] = service().matchImages(['IM000025.JPG'], inventory);

    expect(result.tier).toBe('not-imported');
    expect(result.skipReason).toBeTruthy();
  });

  it('tier 3: a plausible but unconfirmable match names the closest coin and why', () => {
    // An ancient: no year, no denomination, no grade. Three of the four
    // required attributes are simply absent, so there is no question to ask.
    const inventory = [coin({ id: 'caracalla', coinType: 'Caracalla Denarius', variety: 'Sear 6819' })];
    const [result] = service().matchImages(['Caracalla Denarius - Sear 6819 - Obverse.jpg'], inventory);

    expect(result.status).toBe('review');       // the matcher still ranks it
    expect(result.tier).toBe('not-imported');   // but there is nothing to confirm
    expect(result.skipReason).toContain('Caracalla');
    expect(result.skipReason).toContain('no year');
  });
});

/* =========================================================================
 * 4. A NEAR MATCH CANNOT ATTACH ITSELF
 * =======================================================================
 * The hard constraint on the whole feature. Tier 2 exists to make the ASKING
 * cheaper, never to attach more.
 */
describe('near match - cannot attach itself', () => {
  const inventory = [
    coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63', certCompany: 'PCGS' }),
    coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63', certCompany: 'PCGS' })
  ];

  it('leaves matchedRecordId null and status non-auto', () => {
    const [result] = service().matchImages(['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'], inventory);

    expect(result.tier).toBe('near');
    expect(result.matchedRecordId).toBeNull();
    expect(result.status).not.toBe('auto');
  });

  it('the tier stage changes nothing the auto-assign gates own', () => {
    // Run the decision twice: once raw, once through the tier stage. Every
    // field the gates own must be byte-identical. This is the guard that stops
    // a future edit to near-match.ts from quietly loosening the matcher.
    const signatures = buildCoinSignatures(inventory);
    const files = [
      '1881 Morgan Dollar PCGS MS63 - Obverse.jpg',
      'Gold Coins.JPG',
      'mercury_dime_1945.jpg',
      'IM000025.JPG'
    ];

    for (const file of files) {
      const decided = matchOneImage(file, signatures);
      const reTiered = assignImportTier(decided, signatures);

      expect(reTiered.status, file).toBe(decided.status);
      expect(reTiered.matchedRecordId, file).toBe(decided.matchedRecordId);
      expect(reTiered.confidence, file).toBe(decided.confidence);
      expect(reTiered.reason, file).toBe(decided.reason);
      expect(reTiered.candidates, file).toEqual(decided.candidates);
      expect(reTiered.runnerUpGap, file).toBe(decided.runnerUpGap);
      // ...and the tier itself is stable, so the stage is idempotent.
      expect(reTiered.tier, file).toBe(decided.tier);
    }
  });

  it('only offers candidates that passed the four-attribute test', () => {
    // A third Morgan with the WRONG grade is scored and ranked by the matcher,
    // but it must never reach the "or pick a different one" dropdown.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      [...inventory, coin({ id: 'morgan-cc', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'CC', grade: 'MS66', certCompany: 'PCGS' })]
    );

    expect(result.tier).toBe('near');
    expect(result.candidates.map(c => c.coinId)).toContain('morgan-cc');
    expect(result.nearMatch!.candidates.map(c => c.coinId)).not.toContain('morgan-cc');
  });
});
