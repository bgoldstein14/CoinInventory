import { describe, expect, it } from 'vitest';
import { ImageMatchingService } from './image-matching.service';
import { CoinRecord } from '../types/coin.model';

/**
 * Builds a CoinRecord with sensible blanks, so each test only has to state the
 * handful of fields it actually cares about.
 */
function coin(overrides: Partial<CoinRecord> & { id: string }): CoinRecord {
  return {
    id: overrides.id,
    denomination: '',
    year: '',
    coinType: '',
    category: '',
    country: 'United States',
    grade: '',
    certCompany: '',
    certNumber: '',
    variety: '',
    mintMark: '',
    composition: '',
    purchaseDate: '',
    purchasePrice: 0,
    currentValue: 0,
    notes: '',
    imagePaths: [],
    tags: [],
    source: 'manual',
    ...overrides
  };
}

const service = () => new ImageMatchingService();

/* =========================================================================
 * PARSING
 * ======================================================================= */
describe('ImageMatchingService - filename parsing', () => {
  it('parses year, mint mark, denomination and coin type from a canonical name', () => {
    const parsed = service().parseFilename('1881-S Morgan Dollar obverse.jpg');

    expect(parsed.year).toBe(1881);
    expect(parsed.mintMark).toBe('s');
    expect(parsed.denomination).toBe('dollar');
    expect(parsed.coinTypeTokens).toEqual(['morgan']);
    expect(parsed.isEmpty).toBe(false);
  });

  it('parses underscore-separated names and picks up the grade token', () => {
    const parsed = service().parseFilename('1921_Peace_Dollar_MS63.png');

    expect(parsed.year).toBe(1921);
    expect(parsed.denomination).toBe('dollar');
    expect(parsed.coinTypeTokens).toEqual(['peace']);
    expect(parsed.grade).toBe('ms63');
    // "1921_Peace" must NOT be read as mint mark "P".
    expect(parsed.mintMark).toBeNull();
  });

  it('parses a hyphenated mint mark with parenthesised view word', () => {
    const parsed = service().parseFilename('1916-D Mercury Dime (reverse).jpeg');

    expect(parsed.year).toBe(1916);
    expect(parsed.mintMark).toBe('d');
    expect(parsed.denomination).toBe('dime');
    expect(parsed.coinTypeTokens).toEqual(['mercury']);
  });

  it('strips directories and file extensions', () => {
    const parsed = service().parseFilename('C:\\photos\\coins\\1881-CC Morgan Dollar.JPG');

    expect(parsed.fileName).toBe('1881-CC Morgan Dollar.JPG');
    expect(parsed.year).toBe(1881);
    expect(parsed.mintMark).toBe('cc');
  });

  it('recognises spelled-out mint names', () => {
    expect(service().parseFilename('1889 Carson City Morgan Dollar.jpg').mintMark).toBe('cc');
    expect(service().parseFilename('1916 Denver Mercury Dime.jpg').mintMark).toBe('d');
  });

  it('treats a camera sequence number as a sequence number, not a year', () => {
    const parsed = service().parseFilename('IMG_2024.jpg');

    expect(parsed.year).toBeNull();
    expect(parsed.denomination).toBeNull();
    expect(parsed.coinTypeTokens).toEqual([]);
    expect(parsed.isEmpty).toBe(true);
  });

  it('still reads a year that is not preceded by a camera prefix', () => {
    expect(service().parseFilename('2024 Silver Eagle.jpg').year).toBe(2024);
  });

  it('rejects year-shaped numbers outside the plausible minting range', () => {
    expect(service().parseFilename('Morgan Dollar 1234.jpg').year).toBeNull();
  });

  it('does not invent mint marks from stray single letters (defect #6)', () => {
    // The "s" in "reverse side" and the "d" in "detail" must not become mint marks.
    expect(service().parseFilename('morgan dollar reverse side detail.jpg').mintMark).toBeNull();
    expect(service().parseFilename('peace dollar scan 3.jpg').mintMark).toBeNull();
  });

  it('returns null for an ambiguous pair of mint-mark candidates', () => {
    // Two fenced codes disagree -> treat as no evidence rather than guessing.
    expect(service().parseFilename('1881-S-morgan-d-dollar.jpg').mintMark).toBeNull();
  });
});

/* =========================================================================
 * DEFECT #3 -- BARE-DIGIT DENOMINATION COLLISIONS
 * ======================================================================= */
describe('ImageMatchingService - denomination parsing safety', () => {
  it('does not read "25" inside a cert number or a price as a quarter', () => {
    const parsed = service().parseFilename('1925-S Peace Dollar NGC 2510345 $25.00.jpg');

    expect(parsed.denomination).toBe('dollar');
    expect(parsed.certNumbers).toContain('2510345');
    expect(parsed.year).toBe(1925);
  });

  it('does not read bare "10" or "5" as a dime or a nickel', () => {
    const parsed = service().parseFilename('1916 lot 10 price 5.00 cert 25999.jpg');

    expect(parsed.denomination).toBeNull();
  });

  it('does not read "cent" out of the middle of another word', () => {
    // "center" contains "cent"; the old substring matcher called this a penny.
    expect(service().parseFilename('coin_center_closeup.jpg').denomination).toBeNull();
  });

  it('does not read the "25" inside a year as a quarter', () => {
    expect(service().parseFilename('1925 Peace.jpg').denomination).toBeNull();
  });

  it('still accepts unambiguous collector shorthand', () => {
    expect(service().parseFilename('1964 Kennedy 50c.jpg').denomination).toBe('half dollar');
    expect(service().parseFilename('1943 steel 1c.jpg').denomination).toBe('cent');
    expect(service().parseFilename('1938 Jefferson 5c.jpg').denomination).toBe('nickel');
  });

  it('keeps the eagle denominations distinct (defect #4)', () => {
    const s = service();
    expect(s.parseFilename('2021 American Silver Eagle.jpg').denomination).toBe('silver eagle');
    expect(s.parseFilename('1907 Liberty Head Double Eagle.jpg').denomination).toBe('double eagle');
    expect(s.parseFilename('1909 Indian Half Eagle.jpg').denomination).toBe('half eagle');
    expect(s.parseFilename('1929 Indian Quarter Eagle.jpg').denomination).toBe('quarter eagle');
    expect(s.parseFilename('1932 Indian Eagle.jpg').denomination).toBe('eagle');

    // "20 Dollar" on a coin record is the same thing as "Double Eagle".
    expect(s.parseFilename('1907 20 Dollar Liberty Head.jpg').denomination).toBe('double eagle');
  });

  it('prefers the more specific dollar denominations', () => {
    const s = service();
    expect(s.parseFilename('1937 Walking Liberty Half Dollar.jpg').denomination).toBe('half dollar');
    expect(s.parseFilename('1878 Trade Dollar.jpg').denomination).toBe('trade dollar');
    expect(s.parseFilename('1881 Morgan Silver Dollar.jpg').denomination).toBe('dollar');
  });
});

/* =========================================================================
 * AUTO-MATCH (the happy path)
 * ======================================================================= */
describe('ImageMatchingService - confident auto matches', () => {
  it('auto-assigns when year, denomination, coin type and mint mark all agree', () => {
    const inventory = [
      coin({ id: 'morgan-1881-s', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' }),
      coin({ id: 'peace-1921', denomination: 'Dollar', coinType: 'Peace', year: '1921' })
    ];

    const [result] = service().matchImages(['1881-S Morgan Dollar obverse.jpg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('morgan-1881-s');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.runnerUpGap).toBeGreaterThanOrEqual(0.15);
  });

  it('auto-assigns on year + denomination + coin type even without a mint mark', () => {
    const inventory = [
      coin({ id: 'merc-1945', denomination: 'Dime', coinType: 'Mercury', year: '1945' }),
      coin({ id: 'de-1907', denomination: '20 Dollar', coinType: 'Liberty Head', year: '1907' })
    ];

    const [result] = service().matchImages(['mercury_dime_1945.jpg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('merc-1945');
  });

  it('gives a specific, attribute-level reason rather than a vague one', () => {
    const inventory = [
      coin({ id: 'merc-1916-d', denomination: 'Dime', coinType: 'Mercury', year: '1916', mintMark: 'D' })
    ];

    const [result] = service().matchImages(['1916-D Mercury Dime (reverse).jpeg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.reason).toContain('Year 1916 matches');
    expect(result.reason).toContain('denomination Dime');
    expect(result.reason).toContain('mint mark D (Denver) matches');
  });

  it('matches a coin whose record stores a year range', () => {
    const inventory = [
      coin({ id: 'merc-type', denomination: 'Dime', coinType: 'Mercury', year: '1916-1945' })
    ];

    const [result] = service().matchImages(['1931 Mercury Dime.jpg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('merc-type');
  });

  it('exposes the parsed attributes alongside the decision', () => {
    const inventory = [coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' })];

    const [result] = service().matchImages(['1881-S Morgan Dollar.jpg'], inventory);

    expect(result.parsed.year).toBe(1881);
    expect(result.parsed.mintMark).toBe('s');
    expect(result.parsed.denominationLabel).toBe('Dollar ($1)');
  });
});

/* =========================================================================
 * DEFECT #2 -- RUNNER-UP / AMBIGUITY
 * ======================================================================= */
describe('ImageMatchingService - ambiguity goes to review', () => {
  it('sends near-identical coins to review instead of silently picking one', () => {
    const inventory = [
      coin({ id: 'morgan-1881-o', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'O' }),
      coin({ id: 'morgan-1881-s', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' })
    ];

    const [result] = service().matchImages(['1881-S Morgan Dollar obverse.jpg'], inventory);

    expect(result.status).toBe('review');
    expect(result.matchedRecordId).toBeNull();
    expect(result.runnerUpGap).toBeLessThan(0.15);

    // The S coin should still be ranked first, with the O coin right behind it.
    expect(result.candidates[0].coinId).toBe('morgan-1881-s');
    expect(result.candidates[1].coinId).toBe('morgan-1881-o');
    expect(result.reason).toContain('too close to call');
  });

  it('sends identical duplicate records to review, never to the first one found', () => {
    const inventory = [
      coin({ id: 'dup-a', denomination: 'Dollar', coinType: 'Morgan', year: '1881' }),
      coin({ id: 'dup-b', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })
    ];

    const [result] = service().matchImages(['1881 Morgan Dollar.jpg'], inventory);

    expect(result.status).toBe('review');
    expect(result.matchedRecordId).toBeNull();
    expect(result.candidates[0].score).toBe(result.candidates[1].score);
  });

  it('does not auto-assign when a coin record is missing the mint mark the filename supplies', () => {
    const inventory = [
      coin({ id: 'known-s', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' }),
      coin({ id: 'blank-mint', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })
    ];

    const [result] = service().matchImages(['1881-S Morgan Dollar.jpg'], inventory);

    // The blank record might BE the S coin - we cannot know, so ask.
    expect(result.status).toBe('review');
    expect(result.candidates).toHaveLength(2);
  });

  it('ranks at most five candidates, best first', () => {
    const inventory = Array.from({ length: 9 }, (_, i) =>
      coin({ id: `c${i}`, denomination: 'Dollar', coinType: 'Morgan', year: String(1878 + i) })
    );

    const [result] = service().matchImages(['1881 Morgan Dollar.jpg'], inventory);

    expect(result.candidates.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(result.candidates[i].score);
    }
  });
});

/* =========================================================================
 * DEFECT #1 -- SINGLE-ATTRIBUTE COINCIDENCES
 * ======================================================================= */
describe('ImageMatchingService - corroboration is required', () => {
  it('never auto-assigns on a bare year alone', () => {
    const inventory = [
      coin({ id: 'only-1945', denomination: 'Dime', coinType: 'Mercury', year: '1945' })
    ];

    const [result] = service().matchImages(['1945.jpg'], inventory);

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
    expect(result.confidence).toBeLessThan(0.85);
  });

  it('never auto-assigns on a denomination alone', () => {
    const inventory = [coin({ id: 'only-dime', denomination: 'Dime', coinType: 'Mercury', year: '1945' })];

    const [result] = service().matchImages(['dime.jpg'], inventory);

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
  });

  it('never auto-assigns on a coin type alone', () => {
    const inventory = [coin({ id: 'only-morgan', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })];

    const [result] = service().matchImages(['morgan.jpg'], inventory);

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
  });

  it('does not auto-assign denomination + coin type when neither side pins the year', () => {
    // Without a year there is no way to tell one Liberty Head Double Eagle
    // from another, so this stays a suggestion.
    const inventory = [
      coin({ id: 'de-1907', denomination: '20 Dollar', coinType: 'Liberty Head', year: '1907' })
    ];

    const [result] = service().matchImages(['DOUBLE_EAGLE_LIBERTY_HEAD.JPG'], inventory);

    expect(result.status).toBe('review');
    expect(result.matchedRecordId).toBeNull();
    expect(result.candidates[0].coinId).toBe('de-1907');
  });

  it('does not let a blank coin record accumulate credit for absent attributes', () => {
    const inventory = [
      coin({ id: 'blank' }),
      coin({ id: 'real', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' })
    ];

    const [result] = service().matchImages(['1881-S Morgan Dollar.jpg'], inventory);

    expect(result.status).toBe('auto');
    expect(result.matchedRecordId).toBe('real');
    expect(result.candidates.some(c => c.coinId === 'blank')).toBe(false);
  });
});

/* =========================================================================
 * NO MATCH
 * ======================================================================= */
describe('ImageMatchingService - no usable match', () => {
  it('reports "none" for a camera filename with no coin attributes', () => {
    const inventory = [
      coin({ id: 'merc', denomination: 'Dime', coinType: 'Mercury', year: '2024' }),
      coin({ id: 'ase', denomination: 'Silver Eagle', coinType: 'American Silver Eagle', year: '2024' })
    ];

    const [result] = service().matchImages(['IMG_2024.jpg'], inventory);

    expect(result.status).toBe('none');
    expect(result.matchedRecordId).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.reason).toContain('No inventory record matched');
  });

  it('reports "none" when nothing in the inventory resembles the filename', () => {
    const inventory = [coin({ id: 'merc', denomination: 'Dime', coinType: 'Mercury', year: '1945' })];

    const [result] = service().matchImages(['mystery_coin.jpg'], inventory);

    expect(result.status).toBe('none');
    expect(result.matchedRecordId).toBeNull();
    expect(result.reason).toContain('No inventory record matched');
  });

  it('does not confuse a Silver Eagle image with a Double Eagle record', () => {
    const inventory = [
      coin({ id: 'double-eagle', denomination: 'Double Eagle', coinType: 'Saint Gaudens', year: '2021' })
    ];

    const [result] = service().matchImages(['2021 American Silver Eagle.jpg'], inventory);

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
  });

  it('prefers the Silver Eagle record over the Double Eagle record of the same year', () => {
    const inventory = [
      coin({ id: 'double-eagle', denomination: 'Double Eagle', coinType: 'Liberty Head', year: '2021' }),
      coin({ id: 'silver-eagle', denomination: 'Silver Eagle', coinType: 'American Silver Eagle', year: '2021' })
    ];

    const [result] = service().matchImages(['2021 American Silver Eagle obverse.jpg'], inventory);

    expect(result.matchedRecordId).toBe('silver-eagle');
    expect(result.candidates[0].coinId).toBe('silver-eagle');
  });
});

/* =========================================================================
 * EDGE CASES
 * ======================================================================= */
describe('ImageMatchingService - edge cases', () => {
  it('returns an empty array for an empty image list', () => {
    const inventory = [coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })];
    expect(service().matchImages([], inventory)).toEqual([]);
  });

  it('handles an empty inventory without throwing', () => {
    const results = service().matchImages(['1881-S Morgan Dollar.jpg'], []);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('none');
    expect(results[0].matchedRecordId).toBeNull();
    expect(results[0].candidates).toEqual([]);
    expect(results[0].reason).toContain('inventory is empty');
  });

  it('handles both lists being empty', () => {
    expect(service().matchImages([], [])).toEqual([]);
  });

  it('handles a filename that is only an extension', () => {
    const inventory = [coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })];
    const [result] = service().matchImages(['.jpg'], inventory);

    expect(result.status).toBe('none');
  });

  it('is deterministic: the same inputs give the same ranking every time', () => {
    const inventory = [
      coin({ id: 'z', denomination: 'Dollar', coinType: 'Morgan', year: '1881' }),
      coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881' })
    ];

    const first = service().matchImages(['1881 Morgan Dollar.jpg'], inventory);
    const second = service().matchImages(['1881 Morgan Dollar.jpg'], inventory);

    expect(first[0].candidates.map(c => c.coinId)).toEqual(second[0].candidates.map(c => c.coinId));
  });

  it('keeps the legacy ImageMatchCandidate fields populated', () => {
    const inventory = [coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' })];
    const [result] = service().matchImages(['1881-S Morgan Dollar.jpg'], inventory);

    expect(result.imagePath).toBe('1881-S Morgan Dollar.jpg');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.reason).toBe('string');
  });

  it('matches a batch of images in one call, preserving input order', () => {
    const inventory = [
      coin({ id: 'morgan', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' }),
      coin({ id: 'merc', denomination: 'Dime', coinType: 'Mercury', year: '1916', mintMark: 'D' })
    ];

    const results = service().matchImages(
      ['1916-D Mercury Dime.jpg', 'IMG_0001.jpg', '1881-S Morgan Dollar.jpg'],
      inventory
    );

    expect(results.map(r => r.imagePath)).toEqual([
      '1916-D Mercury Dime.jpg',
      'IMG_0001.jpg',
      '1881-S Morgan Dollar.jpg'
    ]);
    expect(results[0].matchedRecordId).toBe('merc');
    expect(results[1].status).toBe('none');
    expect(results[2].matchedRecordId).toBe('morgan');
  });

  it('uses a matching certification number as corroborating evidence', () => {
    const inventory = [
      coin({
        id: 'certed',
        denomination: 'Dollar',
        coinType: 'Morgan',
        year: '1881',
        certCompany: 'NGC',
        certNumber: '2510345'
      }),
      coin({ id: 'other', denomination: 'Dollar', coinType: 'Peace', year: '1922' })
    ];

    const [result] = service().matchImages(['1881 Morgan Dollar NGC 2510345.jpg'], inventory);

    expect(result.matchedRecordId).toBe('certed');
    expect(result.reason).toContain('certification number 2510345 matches');
  });

  it('describes a coin for display', () => {
    const label = service().describeCoin(
      coin({ id: 'a', denomination: 'Dollar', coinType: 'Morgan', year: '1881', mintMark: 'S' })
    );
    expect(label).toBe('Morgan Dollar 1881-S');
  });
});
