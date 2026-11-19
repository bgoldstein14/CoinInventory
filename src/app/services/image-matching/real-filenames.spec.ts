/*
 * Matcher tests against real filenames from the user's image share (unless
 * marked CONSTRUCTED). Odd spacing and casing ("PF62CAM- Obverse", ".JPG",
 * "1875CC") are real and intentional; keep them as-is.
 */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
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

/*
 * Table 1: single coins. `undefined` = not asserted; null = asserted to be
 * absent.
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

/*
 * Table 2: not a single coin, must score 'none'. The inventory is baited
 * with the coins each filename would otherwise match (a Three Cent piece for
 * the stamp, gold for "Gold Coins", ...), so the non-coin veto is what stops them.
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
      expect(result.candidates, 'candidates').toEqual([]);
      expect(result.parsed.isNonCoin, 'isNonCoin').toBe(true);
      expect(result.parsed.nonCoinReason, 'nonCoinReason').toBeTruthy();
    });
  }

  it('proves the "3 cent" bait would otherwise be attractive', () => {
    // Control: "3-cent" does parse as a coin, so the veto is what stops the
    // stamp and paper above.
    const parsed = service().parseFilename('1851 3-cent - VF - Obverse.jpg');

    expect(parsed.denomination).toBe('three cent');
    expect(parsed.isNonCoin).toBe(false);
  });
});

/*
 * Table 3: ancients only have coin-type text (including the catalogue
 * reference), so they cap below 0.85 and always go to review.
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

// Table 4: a number with a unit attached is a denomination; a bare number is not.
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
    // A standalone "- 20 -" segment is a take number.
    expect(s.parseFilename('1881-S Morgan - 20 - Obverse.jpg').denomination).toBeNull();
    expect(s.parseFilename('1881-S Morgan Dollar - 20 - Obverse.jpg').denomination).toBe('dollar');
    // Digits inside a cert number stay inside it.
    expect(s.parseFilename('1881 Morgan Dollar NGC 2599001.jpg').denomination).toBe('dollar');
  });

  it('requires the hyphen before believing "N cent"', () => {
    const s = service();
    // Hyphenated: a real coin.
    expect(s.parseFilename('1875 20-cent - Obverse.jpg').denomination).toBe('twenty cent');
    // Space-separated inside a stamp's name: no Twenty/Three Cent coin here.
    expect(s.parseFilename('Stamp - 11 - 3 cent.jpg').denomination).not.toBe('three cent');
  });
});

// Table 5: cert company and grade are weak alone, strong together.
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
    // Only the grade agrees, and a grade alone is not a strong attribute.
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

// Table 6: photo markers (side, take, variant) never affect the score.
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

// Table 7: mint marks glued to the year, and words that are not mint marks.
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

/*
 * Table 8: counterfeits (matched, but only to counterfeit records) and
 * multi-coin shots (held out of the automated import; no candidates and no
 * "Attach anyway" link, unlike NOT_ONE_COIN rows). Real paths with their
 * directories. Not added to real-filenames.fixture.ts, which feeds the tier
 * census in import-tiers.spec.ts.
 */
interface ExclusionCase {
  file: string;
  /** The word in the FILENAME that fired, lower-cased. */
  marker: string;
  kind: 'counterfeit' | 'multi-coin';
}

// Counterfeits: matched normally; the authenticity veto keeps them off genuine records.
const COUNTERFEIT_FILES = [
  'Business Strikes/FAKE - 1860 3CS - VF - Obverse.jpg',
  'Business Strikes/FAKE - 1860 3CS - VF - Reverse.jpg',
  'Business Strikes/Archive/1861 3CS - Obverse - FAKE.jpg',
  'Business Strikes/Archive/1861 3CS - Reverse - FAKE.jpg',
  'Business Strikes/1860 Counterfeit 3CS - Obverse.jpg',
  'Business Strikes/1860 Counterfeit 3CS - Reverse.jpg',
  'Business Strikes/1861 Counterfeit 3CS - Obverse.jpg',
  'Business Strikes/1861 Counterfeit 3CS - Reverse.jpg'
];

const EXCLUDED_FROM_AUTO_IMPORT: ExclusionCase[] = [
  // "collage"
  { file: '20¢/Archive/20¢ Collage.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: '20¢/Archive/20¢ Collage - Small.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: 'Business Strikes/Gold/$3 Collage.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: 'Business Strikes/Gold/Gold $20 Collage.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: 'Business Strikes/3CN/Archive/1875 3CN - Collage.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: 'Business Strikes/3CN/Archive/1875 3CN - Collage - Small.jpg', marker: 'collage', kind: 'multi-coin' },
  { file: 'Business Strikes/3CN/Archive/1875 3CN - Collage - BIG 3 - Small.jpg', marker: 'collage', kind: 'multi-coin' },

  // "hoard": "mini-hoard" needs a \b-anchored marker, not whitespace.
  { file: 'Business Strikes/3CN/Archive/1875 and 1876 3CN mini-hoard - Obverse.jpg', marker: 'hoard', kind: 'multi-coin' },
  { file: 'Business Strikes/3CN/Archive/1875 and 1876 3CN mini-hoard - Reverse.jpg', marker: 'hoard', kind: 'multi-coin' },

  // "montage" (so "set" need not be a marker; see Table 9).
  { file: 'Proofs/1870 Proof Set/Archive/1870 Proof Set Montage - Large.jpg', marker: 'montage', kind: 'multi-coin' },
  { file: 'Proofs/1870 Proof Set/Archive/1870 Proof Set Montage - Small.jpg', marker: 'montage', kind: 'multi-coin' },

  // "group": phone dumps showing several coins per frame.
  { file: 'Temp/Group PHOTO-2023-06-02-13-15-48.jpg', marker: 'group', kind: 'multi-coin' },
  { file: 'Temp/Group PHOTO-2023-06-23-07-48-23.jpg', marker: 'group', kind: 'multi-coin' }
];

describe('real filenames - counterfeits are matched, but only to counterfeit records', () => {
  for (const file of COUNTERFEIT_FILES) {
    it(`reads "${file}" as a counterfeit and does not exclude it`, () => {
      const [result] = service().matchImages([file], BAITED_INVENTORY);
      expect(result.parsed.counterfeit, 'counterfeit').toBe(true);
      expect(result.parsed.excludedFromAutoImport, 'excludedFromAutoImport').toBe(false);
    });
  }

  const genuine = coin({
    id: '3cs-1860', denomination: 'Three Cent', coinType: 'Silver Trime',
    year: '1860', grade: 'VF'
  });
  const fake = coin({
    id: '3cs-1860-fake', denomination: 'Three Cent', coinType: 'Silver Trime',
    year: '1860', grade: 'VF', variety: 'FAKE'
  });

  it('offers a fake photo the fake record and never the genuine one', () => {
    const [result] = service().matchImages(['FAKE - 1860 3CS - VF - Obverse.jpg'], [genuine, fake]);
    const offered = [
      result.matchedRecordId,
      ...result.candidates.map(c => c.coinId),
      ...(result.nearMatch?.candidates ?? []).map(c => c.coinId)
    ].filter(Boolean);
    expect(offered).toContain('3cs-1860-fake');
    expect(offered).not.toContain('3cs-1860');
  });

  it('offers a genuine photo the genuine record and never the fake one', () => {
    const [result] = service().matchImages(['1860 3CS - VF - Obverse.jpg'], [genuine, fake]);
    const offered = [
      result.matchedRecordId,
      ...result.candidates.map(c => c.coinId),
      ...(result.nearMatch?.candidates ?? []).map(c => c.coinId)
    ].filter(Boolean);
    expect(offered).toContain('3cs-1860');
    expect(offered).not.toContain('3cs-1860-fake');
  });
});

describe('real filenames - group shots are out of the automated run', () => {
  for (const { file, marker, kind } of EXCLUDED_FROM_AUTO_IMPORT) {
    it(`holds back "${file}" as a ${kind}, on the word "${marker}"`, () => {
      const [result] = service().matchImages([file], BAITED_INVENTORY);

      expect(result.parsed.excludedFromAutoImport, 'excludedFromAutoImport').toBe(true);
      // The reason names the marker word.
      expect(result.parsed.autoImportExclusionReason, 'reason').toContain(`"${marker}"`);

      expect(result.status, 'status').toBe('none');
      expect(result.matchedRecordId, 'matchedRecordId').toBeNull();
      expect(result.confidence, 'confidence').toBe(0);
      // Not offered either; `BatchImportSession.canRescue` hides the rescue link.
      expect(result.candidates, 'candidates').toEqual([]);

      // Still listed with its reason.
      expect(result.tier, 'tier').toBe('not-imported');
      expect(result.skipReason, 'skipReason').toBe(result.parsed.autoImportExclusionReason);
    });
  }

  it('keeps a fake photo off a genuine record (authenticity veto)', () => {
    // Control: without "FAKE" the same name is offered, so the veto is what
    // blocks it.
    const genuine = [coin({
      id: '3cs-1860', denomination: 'Three Cent', coinType: 'Silver Trime',
      year: '1860', grade: 'VF'
    })];

    const [control] = service().matchImages(['1860 3CS - VF - Obverse.jpg'], genuine);
    expect(control.candidates.length, 'the same name without "FAKE"').toBeGreaterThan(0);

    const [fake] = service().matchImages(['FAKE - 1860 3CS - VF - Obverse.jpg'], genuine);
    expect(fake.candidates, 'with "FAKE"').toEqual([]);
  });

  it('does not let a sibling photo drag a counterfeit in behind it', () => {
    // Sibling inference bypasses the gates; the fake shares all identifying
    // text with the genuine photo.
    const genuine = [coin({
      id: '3cs-1860', denomination: 'Three Cent', coinType: 'Silver Trime',
      year: '1860', grade: 'VF'
    })];

    const results = service().matchImages(
      ['1860 3CS - VF - Obverse.jpg', 'FAKE - 1860 3CS - VF - Reverse.jpg'],
      genuine
    );

    expect(results[1].matchedRecordId, 'the fake must stay unplaced').toBeNull();
  });
});

/*
 * Table 9: words that look like exclusion markers but must not exclude a
 * photo of a real coin. Each row gives the reason.
 */
const NOT_EXCLUDED: Array<{ file: string; why: string }> = [
  {
    file: 'Business Strikes/Archive/1882 O over S close-up.jpg',
    why: 'a close-up IS a photograph of the coin, just taken nearer to it'
  },
  {
    file: 'Proofs/3CN/Archive/1887 Over 6 3CN Close-Up 1.jpg',
    why: 'the same, with the other spelling'
  },
  {
    file: 'Business Strikes/Archive/1878-S Trade Dollar - AU58 Cleaned - Obverse.jpg',
    why: '"cleaned" is a condition descriptor he uses; his security names carry "(CLEANED/PCGS)"'
  },
  {
    file: 'Business Strikes/Archive/1876S Trade $1 - AU - cleaned.jpg',
    why: 'the same, lower case'
  },
  {
    file: 'Business Strikes/Gold/Gold Type Set.jpg',
    why:
      '"set" is NOT a marker: he owns dozens of records that genuinely ARE sets ' +
      '("1942 Proof Set", "1950 Proof Set"), so a "set" photo may legitimately ' +
      'belong to a "set" record. This file is still isNonCoin through ' +
      'GROUP_SHOT_WORDS, so it is still skipped -- but it keeps its rescue link, ' +
      'and that difference is the entire point'
  },
  {
    file: 'Proofs/1870 Proof Set/Archive/IM000037.JPG',
    why:
      'FOLDER vs FILE: its directory says "1870 Proof Set", and two files in that ' +
      'same directory ARE excluded for saying "Montage" in their own names. This ' +
      'one is judged on "IM000037" alone'
  },
  {
    file: 'Business Strikes/1881-S Morgan Dollar - Obverse - Copy.jpg',
    why:
      'CONSTRUCTED, not from the share -- there are zero "Copy" files today, and ' +
      'that is exactly why "copy" is not a marker. The hobby uses the word for a ' +
      'counterfeit; Windows uses it for a duplicated file; the next one to appear ' +
      'will overwhelmingly be the Windows kind'
  },
  {
    file: 'Collages/1881-S Morgan Dollar - Obverse.jpg',
    why:
      'CONSTRUCTED. The folder-vs-file rule stated the other way round: a marker ' +
      'in a DIRECTORY name says nothing about the file inside it'
  }
];

describe('real filenames - lookalike words do not exclude a photograph', () => {
  for (const { file, why } of NOT_EXCLUDED) {
    it(`keeps "${file}" in the automated run (${why})`, () => {
      const parsed = service().parseFilename(file);

      expect(parsed.excludedFromAutoImport, 'excludedFromAutoImport').toBe(false);
      expect(parsed.autoImportExclusionReason, 'reason').toBeNull();
    });
  }
});

// Table 10: real-filenames.fixture.ts (used by import-tiers.spec.ts) must
// include every filename asserted in tables 1 and 2.
describe('real filenames - the shared fixture covers every case asserted here', () => {
  it('lists every single-coin filename used above', () => {
    for (const testCase of SINGLE_COIN_CASES) {
      expect(REAL_FILENAMES, testCase.file).toContain(testCase.file);
    }
  });

  it('lists every not-one-coin filename used above', () => {
    for (const { file } of NOT_ONE_COIN) {
      expect(REAL_FILENAMES, file).toContain(file);
    }
  });
});
