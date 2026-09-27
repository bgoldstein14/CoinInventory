/* ===========================================================================
 * real-filenames.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That the matcher works against THIS COLLECTION, not against invented
 *   names. Every filename below is VERBATIM from a survey of the user's image
 *   share (\\192.168.0.10\Coin Pictures, 2,140 files). Nothing here is made
 *   up, and nothing here should be "tidied" -- the odd spacing, the missing
 *   space in "PF62CAM- Obverse", the mixed-case ".JPG" and the lone "1875CC"
 *   with no separator are all real, and each one broke something.
 *
 *   image-matching.service.spec.ts covers the ALGORITHM (the safety gates,
 *   the ambiguity rules, the defect regressions). This file covers REALITY.
 *   If the collection's naming habits change, this is the file to extend.
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';

const service = () => new ImageMatchingService();

/** A CoinRecord with sensible blanks, so each case states only what it needs. */
function coin(overrides: Partial<CoinRecord> & { id: string }): CoinRecord {
  return {
    id: overrides.id,
    denomination: '', year: '', coinType: '', category: '', country: 'United States',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths: [], tags: [], source: 'manual',
    ...overrides
  };
}

/* =========================================================================
 * TABLE 1 -- SINGLE COINS: every attribute, from the real filename
 * =======================================================================
 * Columns are exactly what the import UI reads back to the user. `undefined`
 * means "this case does not pin that field down"; null means "we assert the
 * matcher found nothing", which for several of these is the whole point.
 */
interface ParseCase {
  file: string;
  year: number | null;
  denomination: string | null;
  mintMark: string | null;
  certCompany: string | null;
  grade: string | null;
  side: 'obverse' | 'reverse' | 'label' | null;
  take: number | null;
  /** Only asserted when present. */
  variant?: string | null;
  /** Only asserted when present. */
  typeTokens?: string[];
}

const SINGLE_COIN_CASES: ParseCase[] = [
  // --- 3CN / 3CS: digits bound to a metal abbreviation -------------------
  {
    file: '1865 3CN - Choice VF - Obverse - Photo.jpg',
    year: 1865, denomination: 'three cent nickel', mintMark: null,
    certCompany: null, grade: 'choicevf', side: 'obverse', take: null, variant: 'photo'
  },
  {
    file: '1873 3CN - Closed 3 - XF - Obverse.jpg',
    year: 1873, denomination: 'three cent nickel', mintMark: null,
    certCompany: null, grade: 'xf', side: 'obverse', take: null,
    // "Closed 3" is the variety and IS good evidence; the bare "3" is not.
    typeTokens: ['closed']
  },

  // --- the cent sign -----------------------------------------------------
  {
    file: '1875 20¢ - VF+ - Obverse - Orig.jpg',
    year: 1875, denomination: 'twenty cent', mintMark: null,
    certCompany: null, grade: 'vf+', side: 'obverse', take: null, variant: 'orig'
  },
  {
    file: '1812 50¢ VG - Obverse - Small.jpg',
    year: 1812, denomination: 'half dollar', mintMark: null,
    certCompany: null, grade: 'vg', side: 'obverse', take: null, variant: 'small'
  },

  // --- the hyphenated N-cent form ----------------------------------------
  {
    file: '1875-CC 20-cent Choice F - Obverse.jpg',
    year: 1875, denomination: 'twenty cent', mintMark: 'cc',
    certCompany: null, grade: 'choicef', side: 'obverse', take: null
  },
  {
    file: '1875-S 20-cent ANACS XF40.jpg',
    year: 1875, denomination: 'twenty cent', mintMark: 's',
    certCompany: 'anacs', grade: 'xf40', side: null, take: null
  },
  {
    file: '1870 1-cent NGC PF65RB - Obverse 2.jpg',
    year: 1870, denomination: 'cent', mintMark: null,
    certCompany: 'ngc', grade: 'pf65rb', side: 'obverse', take: 2
  },
  {
    file: '1870 10-cent - NGC PF64Cameo - Reverse 5.jpg',
    year: 1870, denomination: 'dime', mintMark: null,
    certCompany: 'ngc', grade: 'pf64cameo', side: 'reverse', take: 5
  },
  {
    file: '1913 50-Cent Canadian - Obverse.jpg',
    year: 1913, denomination: 'half dollar', mintMark: null,
    certCompany: null, grade: null, side: 'obverse', take: null,
    typeTokens: ['canadian']
  },

  // --- the dollar sign ---------------------------------------------------
  {
    file: '1870 $1 - PCGS PF62CAM- Obverse.jpg',
    year: 1870, denomination: 'dollar', mintMark: null,
    certCompany: 'pcgs', grade: 'pf62cam', side: 'obverse', take: null
  },
  {
    file: '1904 $20 - PCGS MS63 - small.jpg',
    year: 1904, denomination: 'double eagle', mintMark: null,
    certCompany: 'pcgs', grade: 'ms63', side: null, take: null, variant: 'small'
  },
  {
    file: '1906-S $5 - XF-AU.jpg',
    year: 1906, denomination: 'half eagle', mintMark: 's',
    certCompany: null, grade: 'xf-au', side: null, take: null
  },

  // --- mint mark glued to the year, no separator at all ------------------
  {
    file: '1875CC - VF30 - 2 - Obverse.jpg',
    year: 1875, denomination: null, mintMark: 'cc',
    certCompany: null, grade: 'vf30', side: 'obverse', take: 2
  },

  // --- a plain word denomination with a variety note ---------------------
  {
    file: '2008 Hawaii Quarter - Dropped D - 2.JPG',
    year: 2008, denomination: 'quarter', mintMark: null,
    certCompany: null, grade: null, side: null, take: 2,
    typeTokens: ['hawaii', 'dropped']
  },

  // --- a FOREIGN unit: "5S" is sheqels, NOT five US cents ----------------
  {
    file: 'Israel 1982 5S Qumran Gold - ANACS PF69 DCAM - Obverse.jpeg',
    year: 1982, denomination: null, mintMark: null,
    certCompany: 'anacs', grade: 'pf69dcam', side: 'obverse', take: null,
    typeTokens: ['israel', '5s', 'qumran', 'gold']
  },

  // --- ANCIENTS: no year, no denomination, a catalogue reference instead --
  {
    file: '67-68 CE 1st Revolt - Obverse - 2.jpg',
    year: null, denomination: null, mintMark: null,
    certCompany: null, grade: null, side: 'obverse', take: 2
  },
  {
    file: 'Caracalla Denarius - Sear 6819 - Obverse.jpg',
    year: null, denomination: null, mintMark: null,
    certCompany: null, grade: null, side: 'obverse', take: null
  },
  {
    file: 'Constantine - RIC 34 - Obverse.jpg',
    year: null, denomination: null, mintMark: null,
    certCompany: null, grade: null, side: 'obverse', take: null
  },
  {
    file: 'Bar Kochba - Hendin 736 - Obverse 1.jpg',
    year: null, denomination: null, mintMark: null,
    certCompany: null, grade: null, side: 'obverse', take: 1
  }
];

describe('real filenames - single coins parse to the right attributes', () => {
  for (const testCase of SINGLE_COIN_CASES) {
    it(`parses "${testCase.file}"`, () => {
      const parsed = service().parseFilename(testCase.file);

      expect(parsed.year, 'year').toBe(testCase.year);
      expect(parsed.denomination, 'denomination').toBe(testCase.denomination);
      expect(parsed.mintMark, 'mintMark').toBe(testCase.mintMark);
      expect(parsed.grade, 'grade').toBe(testCase.grade);
      expect(parsed.side ?? null, 'side').toBe(testCase.side);
      expect(parsed.take ?? null, 'take').toBe(testCase.take);

      // certCompanies is a list; the table names the one we expect (or none).
      expect(parsed.certCompanies[0] ?? null, 'certCompany').toBe(testCase.certCompany);

      if (testCase.variant !== undefined) {
        expect(parsed.photoVariant ?? null, 'photoVariant').toBe(testCase.variant);
      }
      if (testCase.typeTokens !== undefined) {
        expect(parsed.coinTypeTokens, 'coinTypeTokens').toEqual(testCase.typeTokens);
      }

      // A real single-coin photo must never be flagged as a group / non-coin.
      expect(parsed.isNonCoin, 'isNonCoin').toBe(false);
    });
  }
});

/* =========================================================================
 * TABLE 2 -- NOT A SINGLE COIN: must score 'none'
 * =======================================================================
 * The inventory below is stocked ON PURPOSE with the coins each of these
 * filenames would otherwise be attracted to -- a Three Cent piece for the
 * stamp and the fractional paper, gold for "Gold Coins", a Canadian cent for
 * "Canadian Cents", a Half Dime for "Half Dimes and Cap and Rays". Without
 * the non-coin veto several of these score well into 'review' territory, and
 * the two "3 cent" traps score against a real coin. The test is only
 * meaningful because the bait is present.
 */
const BAITED_INVENTORY: CoinRecord[] = [
  coin({ id: '3cs-1851', denomination: 'Three Cent', coinType: 'Silver Trime', year: '1851' }),
  coin({ id: 'de-1904', denomination: '$20', coinType: 'Liberty Head Gold', year: '1904' }),
  coin({ id: 'cent-canada', denomination: '1 Cent', coinType: 'Canadian', year: '1913' }),
  coin({ id: 'hd-1853', denomination: 'Half Dime', coinType: 'Seated Liberty', year: '1853' }),
  coin({ id: 'sov-1957', denomination: 'Sovereign', coinType: 'Proof Gold', year: '1957' }),
  coin({ id: 'type-1900', denomination: 'Dollar', coinType: 'Morgan', year: '1900' })
];

const NOT_ONE_COIN: Array<{ file: string; why: string }> = [
  // group shots
  { file: '20th Century Type Set.JPG', why: 'a type set, not one coin' },
  { file: 'Ancient Judaica - 8 coins - Obverse.jpg', why: 'counts eight coins' },
  { file: 'Gold Coins.JPG', why: 'plural "Coins"' },
  { file: 'Canadian Cents - Part 1.jpg', why: '"Part" of a plural group' },
  { file: 'Coins - Obverse - Large.jpg', why: 'plural "Coins"' },
  { file: 'Half Dimes and Cap and Rays.jpg', why: 'plural "Dimes"' },

  // non-coin items -- both of these carry a valid-looking "3 cent"
  { file: 'Stamp - 11 - 3 cent.jpg', why: 'a postage STAMP, not a Three Cent coin' },
  { file: '3-cent paper - Large.jpg', why: 'paper money, not a Three Cent coin' },
  { file: '3-cent Fractional - FR1227.jpg', why: 'fractional currency' },
  { file: 'CSA Bond Coupon.jpg', why: 'a bond coupon' },

  // containers
  { file: 'Sovereign Proof Boxes.jpg', why: 'the boxes, not the coins' },

  // camera defaults
  { file: 'Coin_026.JPG', why: 'a camera default name' },
  { file: 'IM000025.JPG', why: 'a camera default name' }
];

describe('real filenames - group shots, non-coins and camera names score none', () => {
  for (const { file, why } of NOT_ONE_COIN) {
    it(`scores none for "${file}" (${why})`, () => {
      const [result] = service().matchImages([file], BAITED_INVENTORY);

      expect(result.status, 'status').toBe('none');
      expect(result.matchedRecordId, 'matchedRecordId').toBeNull();
      expect(result.confidence, 'confidence').toBe(0);
      // Nothing to confirm either: offering candidates would invite the user
      // to attach a stamp photo to a coin with one click.
      expect(result.candidates, 'candidates').toEqual([]);
      expect(result.parsed.isNonCoin, 'isNonCoin').toBe(true);
      expect(result.parsed.nonCoinReason, 'nonCoinReason').toBeTruthy();
    });
  }

  it('proves the "3 cent" bait would otherwise be attractive', () => {
    // Same three-cent record, but a genuine hyphenated three-cent FILENAME.
    // This is the control: the parser really does read "3-cent" as a coin, so
    // the stamp and the paper above are being stopped by the veto and not by
    // some accident of tokenizing.
    const parsed = service().parseFilename('1851 3-cent - VF - Obverse.jpg');

    expect(parsed.denomination).toBe('three cent');
    expect(parsed.isNonCoin).toBe(false);
  });
});

/* =========================================================================
 * TABLE 3 -- ANCIENTS GO TO REVIEW, NEVER TO AUTO
 * =======================================================================
 * An ancient's only comparable attribute is its coin-type text (which now
 * includes the folded catalogue reference). One attribute can never clear the
 * two-strong-attributes gate, and coin-type-only coverage caps the score below
 * the 0.85 bar. So a perfect textual match still asks the user.
 */
describe('real filenames - ancients match on catalogue text but never auto-assign', () => {
  const ancients: CoinRecord[] = [
    coin({ id: 'caracalla', coinType: 'Caracalla Denarius', variety: 'Sear 6819' }),
    coin({ id: 'constantine', coinType: 'Constantine', variety: 'RIC 34' }),
    coin({ id: 'kochba', coinType: 'Bar Kochba', variety: 'Hendin 736' })
  ];

  it('ranks the right ancient first from its catalogue reference', () => {
    const [result] = service().matchImages(['Caracalla Denarius - Sear 6819 - Obverse.jpg'], ancients);

    expect(result.candidates[0].coinId).toBe('caracalla');
    expect(result.status).toBe('review');
    expect(result.matchedRecordId).toBeNull();
  });

  it('folds a catalogue reference into one token on BOTH sides', () => {
    // "RIC 34" must become "ric34", or the bare "34" would be discarded as a
    // meaningless digit and the lone "ric" would match every RIC coin.
    const parsed = service().parseFilename('Constantine - RIC 34 - Obverse.jpg');

    expect(parsed.catalogRefs).toEqual(['ric34']);
    expect(parsed.coinTypeTokens).toContain('ric34');
    expect(parsed.year).toBeNull();
  });

  it('reports an era date but never treats it as a mint year', () => {
    const parsed = service().parseFilename('67-68 CE 1st Revolt - Obverse - 2.jpg');

    expect(parsed.eraDate).toBe('67-68 CE');
    expect(parsed.year).toBeNull();
  });

  it('never auto-assigns an ancient even on a perfect text match', () => {
    const [result] = service().matchImages(['Constantine - RIC 34 - Obverse.jpg'], ancients);

    expect(result.status).not.toBe('auto');
    expect(result.confidence).toBeLessThan(0.85);
  });
});

/* =========================================================================
 * TABLE 4 -- THE BARE-DIGIT RULE, RESTATED AGAINST REAL NAMES
 * =======================================================================
 * The rule the rewrite must not lose: a number with a UNIT attached is strong
 * evidence; the SAME number with nothing attached says nothing at all.
 */
describe('real filenames - unit-bound digits count, bare digits do not', () => {
  it('reads a number that carries a unit', () => {
    const s = service();
    expect(s.parseFilename('1904 $20 - Obverse.jpg').denomination).toBe('double eagle');
    expect(s.parseFilename('1906-S $5.jpg').denomination).toBe('half eagle');
    expect(s.parseFilename('1870 $1 - Obverse.jpg').denomination).toBe('dollar');
    expect(s.parseFilename('1875 20¢ - Obverse.jpg').denomination).toBe('twenty cent');
    expect(s.parseFilename('1812 50¢ - Obverse.jpg').denomination).toBe('half dollar');
    expect(s.parseFilename('1870 10-cent - Obverse.jpg').denomination).toBe('dime');
    expect(s.parseFilename('1865 3CN - Obverse.jpg').denomination).toBe('three cent nickel');
    expect(s.parseFilename('1851 3CS - Obverse.jpg').denomination).toBe('three cent silver');
    expect(s.parseFilename('1964 Kennedy 50C - Obverse.jpg').denomination).toBe('half dollar');
  });

  it('ignores the same numbers when nothing is attached to them', () => {
    const s = service();
    // A price, not a Gold Eagle. A take number, not a Twenty Cent piece.
    expect(s.parseFilename('1925-S Peace Dollar $25.00.jpg').denomination).toBe('dollar');
    expect(s.parseFilename('1875CC - VF30 - 2 - Obverse.jpg').denomination).toBeNull();
    // A standalone "- 20 -" segment is a take number. It is NOT a Twenty Cent
    // piece, and it is not a Double Eagle either: with no unit attached it
    // contributes nothing, so this name yields no denomination at all.
    expect(s.parseFilename('1881-S Morgan - 20 - Obverse.jpg').denomination).toBeNull();
    // Add the unit back and the very same digits become evidence again.
    expect(s.parseFilename('1881-S Morgan Dollar - 20 - Obverse.jpg').denomination).toBe('dollar');
    // Digits inside a cert number stay inside it.
    expect(s.parseFilename('1881 Morgan Dollar NGC 2510345.jpg').denomination).toBe('dollar');
  });

  it('requires the hyphen before believing "N cent"', () => {
    const s = service();
    // Hyphenated: a real coin.
    expect(s.parseFilename('1875 20-cent - Obverse.jpg').denomination).toBe('twenty cent');
    // Space-separated inside a stamp's name: no Twenty/Three Cent coin here.
    expect(s.parseFilename('Stamp - 11 - 3 cent.jpg').denomination).not.toBe('three cent');
  });
});

/* =========================================================================
 * TABLE 5 -- CERT COMPANY + GRADE TOGETHER
 * =======================================================================
 * Individually weak, jointly strong. These tests pin down that asymmetry,
 * because it is easy to "fix" a missed match by promoting the grade and
 * thereby let every XF coin match every other XF coin.
 */
describe('real filenames - cert company and grade corroborate only together', () => {
  it('uses a matching company AND grade as corroboration', () => {
    const inventory = [
      coin({ id: 'de-1904', denomination: '$20', coinType: 'Liberty Head', year: '1904', certCompany: 'PCGS', grade: 'MS63' }),
      coin({ id: 'de-1907', denomination: '$20', coinType: 'Saint Gaudens', year: '1907', certCompany: 'NGC', grade: 'MS62' })
    ];

    const [result] = service().matchImages(['1904 $20 - PCGS MS63 - small.jpg'], inventory);

    expect(result.matchedRecordId).toBe('de-1904');
    expect(result.reason).toContain('certification company PCGS matches');
    expect(result.reason).toContain('grade MS63 matches');
  });

  it('normalizes "MS-63" on a record to the "MS63" a filename writes', () => {
    const inventory = [
      coin({ id: 'a', denomination: '$20', coinType: 'Liberty Head', year: '1904', certCompany: 'PCGS', grade: 'MS-63' })
    ];

    const [result] = service().matchImages(['1904 $20 - PCGS MS63.jpg'], inventory);

    expect(result.reason).toContain('grade MS63 matches');
  });

  it('will not let a shared grade alone clear the two-attribute gate', () => {
    // Nothing agrees except the grade. One attribute is never enough, and a
    // grade does not even count as one.
    const inventory = [coin({ id: 'other', denomination: 'Dime', coinType: 'Mercury', year: '1945', grade: 'XF' })];

    const [result] = service().matchImages(['1873 3CN - XF - Obverse.jpg'], inventory);

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
  });

  it('recognises every grading service this collection uses', () => {
    const s = service();
    for (const company of ['PCGS', 'NGC', 'ANACS', 'ICG', 'SEGS', 'CACG', 'NNC']) {
      expect(
        s.parseFilename(`1881 Morgan Dollar ${company} MS63 - Obverse.jpg`).certCompanies,
        company
      ).toContain(company.toLowerCase());
    }
  });
});

/* =========================================================================
 * TABLE 6 -- PHOTO MARKERS NEVER AFFECT THE SCORE
 * ======================================================================= */
describe('real filenames - side and take are reported, not scored', () => {
  const inventory = [
    coin({ id: 'cad-50c', denomination: '50 Cents', coinType: 'Canadian', year: '1913' })
  ];

  it('scores the obverse and the reverse of one coin identically', () => {
    const results = service().matchImages(
      ['1913 50-Cent Canadian - Obverse.jpg', '1913 50-Cent Canadian - Reverse.jpg'],
      inventory
    );

    expect(results[0].confidence).toBe(results[1].confidence);
    expect(results[0].parsed.side).toBe('obverse');
    expect(results[1].parsed.side).toBe('reverse');
  });

  it('scores every take and variant of one coin identically', () => {
    const results = service().matchImages(
      [
        '1913 50-Cent Canadian - Obverse.jpg',
        '1913 50-Cent Canadian - Obverse 2.jpg',
        '1913 50-Cent Canadian - Obverse - Photo.jpg',
        '1913 50-Cent Canadian - Obverse - Sharpened.jpg',
        '1913 50-Cent Canadian - Obverse - Small.jpg'
      ],
      inventory
    );

    const scores = new Set(results.map(r => r.confidence));
    expect(scores.size, 'all five shots must score the same').toBe(1);
    expect(results.map(r => r.parsed.take ?? null)).toEqual([null, 2, null, null, null]);
    expect(results.map(r => r.parsed.photoVariant ?? null))
      .toEqual([null, null, 'photo', 'sharpened', 'small']);
  });

  it('reads a Label shot as the slab label', () => {
    expect(service().parseFilename('1904 $20 - PCGS MS63 - Label.jpg').side).toBe('label');
  });
});

/* =========================================================================
 * TABLE 7 -- MINT MARKS GLUED TO THE YEAR (and what is NOT a mint mark)
 * ======================================================================= */
describe('real filenames - mint marks attached to the year', () => {
  it('reads every separator style this collection uses', () => {
    const s = service();
    expect(s.parseFilename('1875-CC 20-cent Choice F - Obverse.jpg').mintMark).toBe('cc');
    expect(s.parseFilename('1875CC - VF30 - 2 - Obverse.jpg').mintMark).toBe('cc');
    expect(s.parseFilename('1875-S 20-cent ANACS XF40.jpg').mintMark).toBe('s');
    expect(s.parseFilename('1906-S $5 - XF-AU.jpg').mintMark).toBe('s');
  });

  it('still finds the year when the mint mark is glued to it', () => {
    // "1875CC" is ONE token, so a plain four-digit test misses it entirely.
    expect(service().parseFilename('1875CC - VF30 - 2 - Obverse.jpg').year).toBe(1875);
  });

  it('does not read "CLOSED" as a Charlotte mint mark', () => {
    const parsed = service().parseFilename('1873 - CLOSED.jpg');

    expect(parsed.mintMark).toBeNull();
    expect(parsed.year).toBe(1873);
  });

  it('does not invent a mint mark from a variety note', () => {
    expect(service().parseFilename('1873 3CN - Closed 3 - XF - Obverse.jpg').mintMark).toBeNull();
    expect(service().parseFilename('2008 Hawaii Quarter - Dropped D - 2.JPG').mintMark).toBeNull();
  });
});
