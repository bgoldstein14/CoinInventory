/*
 * Hard-veto tests (year, denomination, strike, authenticity), each in both
 * directions, plus the cases that must NOT veto: a veto removes a coin from
 * the candidate list entirely, so an over-eager one hides the correct coin.
 * Checked at the rule (`findVetoes`), the decision (`matchImages`) and the
 * near-match tier.
 */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import { parseCoin } from './coin-signature';
import { parseFilename, toSignature } from './filename-parser';
import { findVetoes } from './match-vetoes';
import { assessNearMatch } from './near-match';
import { detectStrike } from './proof-strike';
import { denominationsAgree } from './reference-tables';

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

/** The veto verdict for one filename against one record. */
const veto = (file: string, record: Partial<CoinRecord>) =>
  findVetoes(
    toSignature(parseFilename(file)),
    parseCoin(coin({ id: 'x', ...record }))
  );

// 1. Year veto.
describe('veto 1 - a stated year conflict disqualifies the coin', () => {
  it('vetoes when the filename year is later than the record year', () => {
    const verdict = veto('1881 Morgan Dollar PCGS MS63 - Obverse.jpg', {
      year: '1880', denomination: 'Dollar', coinType: 'Morgan', grade: 'MS63', certCompany: 'PCGS'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('year 1881 does not match');
  });

  it('vetoes when the filename year is earlier than the record year', () => {
    const verdict = veto('1880 Morgan Dollar PCGS MS63 - Obverse.jpg', {
      year: '1881', denomination: 'Dollar', coinType: 'Morgan', grade: 'MS63', certCompany: 'PCGS'
    });

    expect(verdict.vetoed).toBe(true);
  });

  it('does NOT veto a year inside a type-set record\'s RANGE', () => {
    expect(veto('1921 Mercury Dime - Obverse.jpg', {
      year: '1916-1945', denomination: 'Dime', coinType: 'Mercury'
    }).vetoed).toBe(false);
  });

  it('DOES veto a year outside a type-set record\'s range', () => {
    expect(veto('1950 Mercury Dime - Obverse.jpg', {
      year: '1916-1945', denomination: 'Dime', coinType: 'Mercury'
    }).vetoed).toBe(true);
  });

  it('does NOT veto when the FILENAME gives no year', () => {
    expect(veto('Caracalla Denarius - Sear 6819 - Obverse.jpg', {
      year: '1881', coinType: 'Caracalla Denarius'
    }).vetoed).toBe(false);
  });

  it('does NOT veto when the RECORD gives no year', () => {
    expect(veto('1881 Morgan Dollar PCGS MS63 - Obverse.jpg', {
      denomination: 'Dollar', coinType: 'Morgan'
    }).vetoed).toBe(false);
  });
});

// 2. Denomination veto.
describe('veto 2 - a stated denomination conflict disqualifies the coin', () => {
  it('vetoes a Half Dollar filename against a Double Eagle record', () => {
    const verdict = veto('1812 50¢ VG - Obverse - Small.jpg', {
      year: '1812', denomination: '$20'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('denomination');
  });

  it('vetoes with the sides swapped', () => {
    expect(veto('1904 $20 - PCGS MS63.jpg', {
      year: '1904', denomination: '50 Cents'
    }).vetoed).toBe(true);
  });

  it('does NOT veto when the FILENAME gives no denomination', () => {
    // Real filename; the "20" is a shot number, not a denomination.
    expect(veto('1881-S Morgan - 20 - Obverse.jpg', {
      year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S'
    }).vetoed).toBe(false);
  });

  it('does NOT veto when the RECORD gives no denomination', () => {
    expect(veto('1904 $20 - PCGS MS63.jpg', {
      year: '1904', coinType: 'Liberty Head Gold'
    }).vetoed).toBe(false);
  });
});

/*
 * 2b. Three-cent equivalence:
 *     generic  <-> specific    agree
 *     specific <-> specific    conflict (3CS vs 3CN)
 */
describe('veto 2b - the three-cent equivalence, generic to specific only', () => {
  it('agrees on the keys themselves, in both directions', () => {
    expect(denominationsAgree('three cent', 'three cent silver')).toBe(true);
    expect(denominationsAgree('three cent silver', 'three cent')).toBe(true);
    expect(denominationsAgree('three cent', 'three cent nickel')).toBe(true);
    expect(denominationsAgree('three cent nickel', 'three cent')).toBe(true);

    // The two SPECIFIC forms are different coins and never agree.
    expect(denominationsAgree('three cent silver', 'three cent nickel')).toBe(false);
    expect(denominationsAgree('three cent nickel', 'three cent silver')).toBe(false);

    // Absence is still not agreement.
    expect(denominationsAgree(null, 'three cent')).toBe(false);
    expect(denominationsAgree('three cent', null)).toBe(false);
  });

  it('does NOT veto a generic 3-cent filename against a 3CS record', () => {
    expect(veto('1851 3-cent - VF - Obverse.jpg', {
      year: '1851', denomination: '3CS'
    }).vetoed).toBe(false);
  });

  it('does NOT veto a generic 3-cent filename against a 3CN record', () => {
    expect(veto('1851 3-cent - VF - Obverse.jpg', {
      year: '1851', denomination: '3CN'
    }).vetoed).toBe(false);
  });

  it('does NOT veto a 3CS filename against a generic Three Cent record', () => {
    // Here the record is the generic side.
    expect(veto('1851 3CS - Obverse.jpg', {
      year: '1851', denomination: 'Three Cent'
    }).vetoed).toBe(false);
  });

  it('does NOT veto a 3CN filename against a generic Three Cent record', () => {
    expect(veto('1865 3CN - Choice VF - Obverse - Photo.jpg', {
      year: '1865', denomination: 'Three Cent'
    }).vetoed).toBe(false);
  });

  it('DOES veto 3CS against 3CN -- different metals, different coins', () => {
    const verdict = veto('1865 3CN - Choice VF - Obverse - Photo.jpg', {
      year: '1865', denomination: '3CS'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('denomination');
  });

  it('DOES veto 3CN against 3CS -- the same conflict, swapped', () => {
    expect(veto('1851 3CS - Obverse.jpg', {
      year: '1851', denomination: '3CN'
    }).vetoed).toBe(true);
  });

  it('reads "Three Cent Nickel" in a record as a THREE cent, not a FIVE cent', () => {
    // Rule order in DENOMINATION_RULES: ['nickel'] must not win over
    // ['three','cent','nickel'], or every 3CN photo conflicts with its record.
    expect(parseCoin(coin({ id: 'n', denomination: 'Three Cent Nickel' })).denomination)
      .toBe('three cent nickel');
    expect(parseCoin(coin({ id: 's', denomination: 'Three Cent Silver' })).denomination)
      .toBe('three cent silver');
    // The ordinary five-cent piece still reads as a nickel.
    expect(parseCoin(coin({ id: 'f', denomination: 'Nickel' })).denomination).toBe('nickel');
  });

  it('reads the cent-sign denominations the database actually stores', () => {
    // server/setup-database.sql seeds '1¢', '5¢', etc.; `tokenize` drops the
    // sign, so these rely on the cent-sign reader.
    const key = (denomination: string) =>
      parseCoin(coin({ id: 'd', denomination })).denomination;

    expect(key('1¢')).toBe('cent');
    // '5¢' is generic: half dimes may be filed under it too.
    expect(key('5¢')).toBe('five cent');
    expect(key('10¢')).toBe('dime');
    expect(key('20¢')).toBe('twenty cent');
    expect(key('25¢')).toBe('quarter');
    expect(key('50¢')).toBe('half dollar');
    expect(key('½¢')).toBe('half cent');
    expect(key('3CS')).toBe('three cent silver');
    expect(key('$20')).toBe('double eagle');
  });
});

/*
 * 2c. Other equivalences, in two shapes:
 *   A. Aliases: two names for one face value ($20 = Double Eagle).
 *   B. Generic/specific: the generic matches either, the specifics conflict
 *      (1¢ over large/small cent, 5¢ over half dime/nickel, $1 over
 *      gold/silver/trade dollar).
 */
describe('equivalence A - straight aliases, two names for one face value', () => {
  /** The denomination key a RECORD's denomination field produces. */
  const key = (denomination: string) =>
    parseCoin(coin({ id: 'd', denomination })).denomination;

  /** The same, with a year (needed to resolve "Eagle"). */
  const keyWithYear = (denomination: string, year: string) =>
    parseCoin(coin({ id: 'd', denomination, year })).denomination;

  /** The denomination key a FILENAME produces. */
  const fileKey = (name: string) => parseFilename(name).denomination;

  // These aliases produce the same key from both spellings; checked through
  // the parsers so a spelling that stops parsing fails the test.
  it.each([
    ['Double Eagle',  '$20',    'twenty dollars of gold'],
    ['Half Eagle',    '$5',     'five dollars of gold'],
    ['Quarter Eagle', '$2.50',  'two and a half dollars of gold']
  ])('"%s" and "%s" are one key -- %s', (words, signs) => {
    expect(key(words)).toBe(key(signs));
    expect(key(words)).toBeTruthy();
    expect(denominationsAgree(key(words), key(signs))).toBe(true);
    expect(denominationsAgree(key(signs), key(words))).toBe(true);
    // Filenames are read by different code.
    expect(fileKey(`1907 ${words} - Obverse.jpg`)).toBe(key(signs));
  });

  it('"Half Dime" and "½10¢" are one key -- half of ten cents', () => {
    expect(key('½10¢')).toBe('half dime');
    expect(key('1/2 10¢')).toBe('half dime');
    expect(key('Half Dime')).toBe('half dime');
    expect(key('½ Dime')).toBe('half dime');
    expect(denominationsAgree(key('½10¢'), key('Half Dime'))).toBe(true);
    expect(denominationsAgree(key('Half Dime'), key('½10¢'))).toBe(true);
  });

  it('does NOT read "½10¢" as a dime -- the trap in that notation', () => {
    // "½10¢" ends in "10¢"; the fraction must be read first.
    expect(key('½10¢')).not.toBe('dime');
    expect(fileKey('1853 ½10¢ - Obverse.jpg')).toBe('half dime');
  });

  it('"Silver Eagle" and "$1" are equivalent -- the one alias that needs a row', () => {
    expect(denominationsAgree('silver eagle', 'dollar')).toBe(true);
    expect(denominationsAgree('dollar', 'silver eagle')).toBe(true);
    expect(key('$1')).toBe('dollar');
    expect(fileKey('2021 American Silver Eagle.jpg')).toBe('silver eagle');
  });

  it('!! SILVER EAGLE IS NOT THE EAGLE !!', () => {
    // "Eagle" is the $10 gold piece (1795-1933); "Silver Eagle" is the $1
    // bullion coin (1986-).
    expect(denominationsAgree('silver eagle', 'eagle')).toBe(false);
    expect(denominationsAgree('eagle', 'silver eagle')).toBe(false);

    for (const other of ['double eagle', 'half eagle', 'quarter eagle', 'gold eagle']) {
      expect(denominationsAgree('silver eagle', other), other).toBe(false);
      expect(denominationsAgree(other, 'silver eagle'), other).toBe(false);
    }
  });

  it('"Eagle" and "$10" are still one key ONCE A YEAR SAYS WHICH SERIES', () => {
    // Not a plain alias: an undated "Eagle" may be modern bullion (see the
    // year suite below). A classic date makes it the $10 piece.
    expect(key('$10')).toBe('eagle');
    expect(keyWithYear('Eagle', '1907')).toBe('eagle');
    expect(keyWithYear('Eagle', '1907')).toBe(key('$10'));
    expect(fileKey('1907 Eagle - Obverse.jpg')).toBe('eagle');
    expect(denominationsAgree(keyWithYear('Eagle', '1907'), key('$10'))).toBe(true);
    expect(denominationsAgree(key('$10'), keyWithYear('Eagle', '1907'))).toBe(true);
  });
});

/*
 * 2d. Which eagle? The year decides.
 *     classic   Eagle $10, Double $20, Half $5, Quarter $2.50; ended 1933
 *     modern    American Gold Eagle bullion from 1986: 1/10 oz $5,
 *               1/4 oz $10, 1/2 oz $25, 1 oz $50
 *     1934-1985 neither series; resolves to the vague 'gold eagle'
 * An undated or unresolved eagle stays vague and vetoes nothing.
 */
describe('which eagle - the year separates the classic $10 from the bullion $50', () => {
  const key = (denomination: string) =>
    parseCoin(coin({ id: 'd', denomination })).denomination;
  const keyWithYear = (denomination: string, year: string) =>
    parseCoin(coin({ id: 'd', denomination, year })).denomination;
  const fileKey = (name: string) => parseFilename(name).denomination;

  it('a MODERN-dated Gold Eagle is the $50 one-ounce bullion coin', () => {
    expect(fileKey('2015 Gold Eagle - Obverse.jpg')).toBe('fifty dollar');
    expect(fileKey('1986 Gold Eagle - MS69 - Obverse.jpg')).toBe('fifty dollar');
    expect(keyWithYear('Gold Eagle', '2015')).toBe('fifty dollar');
    // And the bare word, not just the "Gold" spelling.
    expect(fileKey('2021 Eagle - NGC MS70.jpg')).toBe('fifty dollar');
  });

  it('a CLASSIC-dated Eagle is the $10 gold piece', () => {
    expect(fileKey('1907 Gold Eagle - Obverse.jpg')).toBe('eagle');
    expect(fileKey('1795 Eagle - Obverse.jpg')).toBe('eagle');
    expect(fileKey('1932 Indian Head Eagle - AU58.jpg')).toBe('eagle');
    expect(keyWithYear('Eagle', '1901')).toBe('eagle');
    // Same key a record filed under "$10" produces, so they match exactly.
    expect(fileKey('1907 Eagle - Obverse.jpg')).toBe(key('$10'));
  });

  it('1986 is the boundary: one year earlier is still not a bullion coin', () => {
    expect(fileKey('1986 Gold Eagle.jpg')).toBe('fifty dollar');
    expect(fileKey('1985 Gold Eagle.jpg')).toBe('gold eagle');
    // 1933 is the last classic year.
    expect(fileKey('1933 Eagle.jpg')).toBe('eagle');
  });

  it('THE TWO SERIES DO NOT AGREE WITH EACH OTHER', () => {
    expect(denominationsAgree('fifty dollar', 'eagle')).toBe(false);
    expect(denominationsAgree('eagle', 'fifty dollar')).toBe(false);
    expect(denominationsAgree('fifty dollar', 'twenty five dollar')).toBe(false);
    expect(denominationsAgree('fifty dollar', 'double eagle')).toBe(false);
    expect(denominationsAgree('fifty dollar', 'silver eagle')).toBe(false);
  });

  it('an UNDATED Eagle picks neither series, and vetoes nothing', () => {
    expect(fileKey('Gold Eagle - Obverse.jpg')).toBe('gold eagle');
    expect(fileKey('Eagle - Reverse.jpg')).toBe('gold eagle');
    expect(key('Gold Eagle')).toBe('gold eagle');

    expect(fileKey('Gold Eagle - Obverse.jpg')).not.toBe('eagle');
    expect(fileKey('Gold Eagle - Obverse.jpg')).not.toBe('fifty dollar');

    // The vague key agrees with every face value an eagle could be.
    for (const other of ['eagle', 'half eagle', 'twenty five dollar', 'fifty dollar']) {
      expect(denominationsAgree('gold eagle', other), other).toBe(true);
      expect(denominationsAgree(other, 'gold eagle'), other).toBe(true);
    }

    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$10', year: '1907' }).vetoed).toBe(false);
    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$50', year: '2015' }).vetoed).toBe(false);
  });

  it('the vague key still conflicts with coins that are not eagles at all', () => {
    expect(denominationsAgree('gold eagle', 'dollar')).toBe(false);
    expect(denominationsAgree('gold eagle', 'double eagle')).toBe(false);
    expect(denominationsAgree('gold eagle', 'quarter eagle')).toBe(false);
    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$1', year: '' }).vetoed).toBe(true);
  });

  it('a stated year conflict still disqualifies across the two series', () => {
    expect(veto('2015 Gold Eagle.jpg', { denomination: '$10', year: '1907' }).vetoed).toBe(true);
    // Same year: the denomination veto fires on its own.
    const verdict = veto('2015 Gold Eagle.jpg', { denomination: '$10', year: '2015' });
    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('denomination');
  });

  it('reads $25 and $50 as denominations, from a filename and from a record', () => {
    expect(key('$25')).toBe('twenty five dollar');
    expect(key('$50')).toBe('fifty dollar');
    expect(key('50 Dollars')).toBe('fifty dollar');
    expect(fileKey('2015 $50 Gold Eagle - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 $25 Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
  });

  it('!! "$50.00" IS STILL A PRICE, NOT A DENOMINATION !!', () => {
    // A dollar amount is a face value only if written exactly as one and no
    // other face value is named in words (rule in denomination-units.ts).
    // The first filename is a real one.
    expect(fileKey('1925-S Peace Dollar NGC 2599001 $25.00.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar $25.00.jpg')).toBe('dollar');
    expect(fileKey('1881-S Morgan Dollar $50.00.jpg')).toBe('dollar');
    // With no coin word, a price yields no denomination.
    expect(fileKey('1881-S Morgan $50.00 - Obverse.jpg')).toBeNull();
    expect(fileKey('1881-S Morgan $1,250.00 - Obverse.jpg')).toBeNull();
    // A round price beside a named one-dollar coin is money.
    expect(fileKey('1881-S Morgan Dollar $50.jpg')).toBe('dollar');
    expect(key('$50.00')).not.toBe('fifty dollar');
  });

  it('a weight word names the exact bullion size -- but only once the year is modern', () => {
    expect(fileKey('2015 1 oz Gold Eagle - MS70.jpg')).toBe('fifty dollar');

    // Filenames cannot contain "/", so fractions use "-", "_" or a glyph.
    expect(fileKey('2015 1-2 oz Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
    expect(fileKey('2015 1_4 oz Gold Eagle - MS70.jpg')).toBe('eagle');
    expect(fileKey('2015 1-10 oz Gold Eagle - MS70.jpg')).toBe('half eagle');
    expect(fileKey('2015 ½ oz Gold Eagle - MS70.jpg')).toBe('twenty five dollar');

    // Record text can use "/".
    expect(
      parseCoin(coin({ id: 'd', coinType: 'Gold Eagle 1/2 oz', year: '2015' })).denomination
    ).toBe('twenty five dollar');

    // Without a year the weight alone does not resolve the series.
    expect(fileKey('1 oz Gold Eagle.jpg')).toBe('gold eagle');
  });

  it('does not re-read a denomination that was never ambiguous', () => {
    // `resolveEagleSeries` only touches the vague key.
    expect(fileKey('2015 $10 Gold Eagle.jpg')).toBe('eagle');
    expect(fileKey('2015 Double Eagle.jpg')).toBe('double eagle');
    expect(fileKey('2015 Half Eagle.jpg')).toBe('half eagle');
    expect(fileKey('2015 Quarter Eagle.jpg')).toBe('quarter eagle');
    expect(fileKey('2021 American Silver Eagle.jpg')).toBe('silver eagle');
    expect(keyWithYear('$20', '2015')).toBe('double eagle');
  });
});

describe('equivalence B - a generic face value over the coins it might be', () => {
  const key = (denomination: string) =>
    parseCoin(coin({ id: 'd', denomination })).denomination;

  // Generic/specific pairs agree in both directions.
  it.each([
    ['three cent', 'three cent silver'],
    ['three cent', 'three cent nickel'],
    ['cent',       'large cent'],
    ['cent',       'small cent'],
    ['five cent',  'half dime'],
    ['five cent',  'nickel'],
    ['dollar',     'gold dollar'],
    ['dollar',     'silver dollar'],
    ['dollar',     'trade dollar']
  ])('generic "%s" agrees with specific "%s", both ways', (generic, specific) => {
    expect(denominationsAgree(generic, specific)).toBe(true);
    expect(denominationsAgree(specific, generic)).toBe(true);
  });

  // Specific/specific pairs always conflict.
  it.each([
    ['three cent silver', 'three cent nickel', 'silver trime vs copper-nickel, overlapping 1865-1873'],
    ['large cent',        'small cent',        '28mm copper vs the modern cent, overlapping 1856-1857'],
    ['half dime',         'nickel',            'silver half dime vs copper-nickel, overlapping 1866-1873'],
    ['gold dollar',       'silver dollar',     '1.67g of gold vs 26.7g of silver'],
    ['gold dollar',       'trade dollar',      'different metal, different decade, different purpose'],
    ['silver dollar',     'trade dollar',      'the Trade Dollar is heavier and was struck for export']
  ])('specific "%s" CONFLICTS with specific "%s" -- %s', (left, right) => {
    expect(denominationsAgree(left, right)).toBe(false);
    expect(denominationsAgree(right, left)).toBe(false);
  });

  it('does not chain one group into the next', () => {
    // 'silver eagle' = 'dollar' ~ 'trade dollar', but equivalence is not
    // transitive.
    expect(denominationsAgree('silver eagle', 'trade dollar')).toBe(false);
    expect(denominationsAgree('silver eagle', 'gold dollar')).toBe(false);
    expect(denominationsAgree('silver eagle', 'silver dollar')).toBe(false);
  });

  it('reads every spelling the owner named into the right key', () => {
    expect(key('5¢')).toBe('five cent');          // generic
    expect(key('1¢')).toBe('cent');               // generic
    expect(key('Large Cent')).toBe('large cent'); // specific
    expect(key('Small Cent')).toBe('small cent'); // specific
    expect(key('$1')).toBe('dollar');             // generic
    expect(key('G$1')).toBe('gold dollar');
    expect(key('Gold Dollar')).toBe('gold dollar');
    expect(key('Silver Dollar')).toBe('silver dollar');
    expect(key('Trade Dollar')).toBe('trade dollar');
  });

  it('does not let "G$1" fall through to the plain dollar sign', () => {
    // "$1" is inside "G$1"; read first, it would throw away the "G".
    expect(parseFilename('1854 G$1 Type 2 - Obverse.jpg').denomination).toBe('gold dollar');
  });

  // The same rules through the veto.

  it('does NOT veto a Half Dime filename against a record filed under 5¢', () => {
    // The seed has no Half Dime row, so half dimes are filed under '5¢'.
    expect(veto('1853 Half Dime - VF - Obverse.jpg', {
      year: '1853', denomination: '5¢'
    }).vetoed).toBe(false);
  });

  it('DOES veto a Half Dime filename against a record that says Nickel', () => {
    const verdict = veto('1870 Half Dime - Obverse.jpg', {
      year: '1870', denomination: 'Nickel'
    });
    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('denomination');
  });

  it('does NOT veto a Large Cent filename against a record filed under 1¢', () => {
    expect(veto('1851 Large Cent - VF - Obverse.jpg', {
      year: '1851', denomination: '1¢'
    }).vetoed).toBe(false);
  });

  it('does NOT veto a Trade Dollar filename against a record filed under $1', () => {
    expect(veto('1878-S Trade Dollar - XF - Obverse.jpg', {
      year: '1878', denomination: '$1'
    }).vetoed).toBe(false);
  });

  it('DOES veto a Trade Dollar filename against a record that says Gold Dollar', () => {
    expect(veto('1878-S Trade Dollar - XF - Obverse.jpg', {
      year: '1878', denomination: 'Gold Dollar'
    }).vetoed).toBe(true);
  });
});

// 3. Strike veto: proof, business and specimen never match each other.
describe('veto 3 - a proof is never a business strike', () => {
  it('vetoes a PF filename against an MS record', () => {
    const verdict = veto('1870 1-cent NGC PF65RB - Obverse 2.jpg', {
      year: '1870', denomination: '1 Cent', grade: 'MS65 RB', certCompany: 'NGC'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('proof');
  });

  it('vetoes an MS filename against a PF record -- the other direction', () => {
    expect(veto('1904 $20 - PCGS MS63 - small.jpg', {
      year: '1904', denomination: '$20', grade: 'PF63', certCompany: 'PCGS'
    }).vetoed).toBe(true);
  });

  it('treats PR and PF as the same thing, so neither vetoes the other', () => {
    // PCGS prints PR, NGC prints PF.
    expect(veto('1870 $1 PR62 - Obverse.jpg', {
      year: '1870', denomination: '$1', grade: 'PF62'
    }).vetoed).toBe(false);
  });

  it('reads the word "proof" in a record with no grade', () => {
    // "Proof Gold" is a real coin type.
    const verdict = veto('1957 Sovereign MS63 - Obverse.jpg', {
      year: '1957', coinType: 'Proof Gold'
    });

    expect(verdict.vetoed).toBe(true);
  });

  it('does NOT veto when NEITHER side says how the coin was struck', () => {
    expect(veto('1881-S Morgan Dollar.jpg', {
      year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S'
    }).vetoed).toBe(false);
  });

  it('DOES veto when only the RECORD says proof -- a quiet filename says "business"', () => {
    // Proof is always written when true, so a silent filename means
    // "business strike". Real pair of photos of one proof coin:
    //   1870 10-cent - NGC PF64Cameo - Reverse 5.jpg   says PF
    //   1870 10-cent - Obverse.jpg                     says nothing -> vetoed
    // (accepted; it can still be attached by hand).
    const verdict = veto('1870 10-cent - Obverse.jpg', {
      year: '1870', denomination: '10 Cents', grade: 'PF64 CAMEO', certCompany: 'NGC'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('business strike');
  });

  it('DOES veto when only the FILENAME says proof -- a quiet RECORD says "business" too', () => {
    // The record needs some descriptive text ('Dime') for this to be silence
    // rather than absence; a fully empty record is 'unknown' (see below).
    const verdict = veto('1870 10-cent - NGC PF64Cameo - Reverse 5.jpg', {
      year: '1870', denomination: '10 Cents', coinType: 'Dime'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('proof');
  });

  // Specimen: like proof, SP is always written when true.
  it('DOES veto a SPECIMEN filename against a PROOF record', () => {
    const verdict = veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'PF67'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('specimen');
  });

  it('DOES veto a PROOF filename against a SPECIMEN record -- swapped', () => {
    expect(veto('1964 Kennedy 50C PF67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'SP67'
    }).vetoed).toBe(true);
  });

  it('DOES veto a SPECIMEN filename against a BUSINESS STRIKE record', () => {
    expect(veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'MS67'
    }).vetoed).toBe(true);
  });

  it('DOES veto a BUSINESS STRIKE filename against a SPECIMEN record -- swapped', () => {
    expect(veto('1964 Kennedy 50C MS67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'SP67'
    }).vetoed).toBe(true);
  });

  it('DOES veto a SPECIMEN against a side that merely STAYS QUIET', () => {
    expect(veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy'
    }).vetoed).toBe(true);

    expect(veto('1964 Kennedy 50C - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'SP67'
    }).vetoed).toBe(true);
  });

  it('does NOT veto against a side that is ENTIRELY EMPTY -- the limit of the rule', () => {
    // Silence (some text, no strike word) -> 'business', can conflict.
    // Absence (no descriptive text or grade at all) -> 'unknown', never
    // conflicts. Year and denomination are not descriptive text.
    expect(veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents'
    }).vetoed).toBe(false);

    expect(veto('1964 Kennedy 50C PF67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents'
    }).vetoed).toBe(false);
  });
});

/*
 * 3b. PL, DMPL, DPL and "prooflike" are business strikes with mirrored
 * fields, not proofs. A substring test for "proof" would veto every PL Morgan
 * against its own record. See proof-strike.ts.
 */
describe('veto 3b - PROOFLIKE is a business strike, not a proof', () => {
  const PROOFLIKE_SPELLINGS = [
    ['1881 Morgan Dollar PCGS MS63PL - Obverse.jpg', 'PL, glued to the grade'],
    ['1881 Morgan Dollar PCGS MS63 PL - Obverse.jpg', 'PL, spaced'],
    ['1881 Morgan Dollar PCGS MS63 DMPL - Obverse.jpg', 'deep mirror prooflike (PCGS)'],
    ['1881 Morgan Dollar PCGS MS63 DPL - Obverse.jpg', 'deep prooflike (NGC)'],
    ['1881 Morgan Dollar PCGS MS63 Prooflike - Obverse.jpg', 'spelled out'],
    ['1881 Morgan Dollar PCGS MS63 Proof Like - Obverse.jpg', 'spelled out, two words'],
    ['1881 Morgan Dollar PCGS MS63 Proof-Like - Obverse.jpg', 'spelled out, hyphenated']
  ];

  for (const [file, how] of PROOFLIKE_SPELLINGS) {
    it(`reads "${how}" as a BUSINESS strike, not a proof`, () => {
      expect(toSignature(parseFilename(file)).strike).toBe('business');
    });

    it(`does not veto "${how}" against an ordinary MS63 record`, () => {
      expect(veto(file, {
        year: '1881', denomination: 'Dollar', coinType: 'Morgan',
        grade: 'MS63', certCompany: 'PCGS'
      }).vetoed).toBe(false);
    });
  }

  it('a PL Morgan still reaches tier 2 against its MS63 PL record', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63PL - Obverse.jpg'],
      [
        coin({
          id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan',
          mintMark: 'S', grade: 'MS63 PROOFLIKE', certCompany: 'PCGS'
        }),
        coin({
          id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan',
          mintMark: 'O', grade: 'MS63 PROOFLIKE', certCompany: 'PCGS'
        })
      ]
    );

    expect(result.tier).toBe('near');
    expect(result.nearMatch!.candidates.map(c => c.coinId).sort()).toEqual(['morgan-o', 'morgan-s']);
  });

  it('reads a record whose GRADE FIELD is nothing but "PROOFLIKE" as business', () => {
    // No grade letters, so only the word itself decides.
    expect(detectStrike('', 'PROOFLIKE')).toBe('business');
    expect(detectStrike('', 'DMPL')).toBe('business');
    expect(detectStrike('', 'Deep Mirror Prooflike')).toBe('business');
  });

  it('still reads a genuine proof as a proof', () => {
    expect(detectStrike('1870 $1 - PCGS PF62CAM- Obverse', 'pf62cam')).toBe('proof');
    expect(detectStrike('1957 Sovereign Proof', null)).toBe('proof');
    expect(detectStrike('', 'PR69 DCAM')).toBe('proof');
  });

  it('reads the circulation grade ladder as business, and silence as business too', () => {
    for (const grade of ['MS63', 'AU58', 'XF40', 'VF30', 'VG8', 'Choice VF', 'Gem BU', 'XF-AU']) {
      expect(detectStrike('', grade), grade).toBe('business');
    }
    expect(detectStrike('', 'SP67')).toBe('specimen');

    // Nothing given at all: the only 'unknown' case.
    expect(detectStrike('', '')).toBe('unknown');
    expect(detectStrike(null, undefined)).toBe('unknown');
    expect(detectStrike('   ', '  ')).toBe('unknown');

    // Text without a strike word: business.
    expect(detectStrike('1881 Morgan Dollar', null)).toBe('business');
    expect(detectStrike('1870 10-cent - Obverse', '')).toBe('business');
  });
});

// 4. A vetoed coin is excluded from the auto decision, candidates and tier 2.
describe('a vetoed coin is gone from every tier', () => {
  /** One record. The filename below agrees with it on everything but the year. */
  const WRONG_YEAR: CoinRecord[] = [
    coin({
      id: 'morgan-1880', year: '1880', denomination: 'Dollar', coinType: 'Morgan',
      mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
    })
  ];

  it('is not auto-matched, even though it would otherwise clear every gate', () => {
    // Everything but the year agrees and there is no runner-up, so without
    // the veto this would clear the 0.85 bar.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      WRONG_YEAR
    );

    expect(result.status).toBe('none');
    expect(result.matchedRecordId).toBeNull();
  });

  it('is not offered as a candidate the user could pick by accident', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      WRONG_YEAR
    );

    expect(result.candidates).toEqual([]);
    expect(result.tier).toBe('not-imported');
    expect(result.nearMatch).toBeNull();
  });

  it('still says WHY it was skipped, naming the coin and the conflict', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      WRONG_YEAR
    );

    expect(result.skipReason).toContain('disqualified');
    expect(result.skipReason).toContain('1881');
    expect(result.skipReason!.length).toBeGreaterThan(10);
  });

  it('fails the near-match test on the same ground, not a different one', () => {
    const verdict = assessNearMatch(
      toSignature(parseFilename('1881 Morgan Dollar PCGS MS63 - Obverse.jpg')),
      parseCoin(WRONG_YEAR[0])
    );

    expect(verdict.isNear).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('year 1881 does not match');
  });

  it('removes a proof-vs-business coin from the candidate list too', () => {
    const [result] = service().matchImages(
      ['1870 1-cent NGC PF65RB - Obverse 2.jpg'],
      [coin({
        id: 'cent-1870-ms', year: '1870', denomination: '1¢',
        grade: 'MS65 RB', certCompany: 'NGC'
      })]
    );

    expect(result.matchedRecordId).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.skipReason).toContain('disqualified');
  });

  it('leaves the RIGHT coin to be matched when a vetoed one sits beside it', () => {
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      [
        WRONG_YEAR[0],
        coin({
          id: 'morgan-1881', year: '1881', denomination: 'Dollar', coinType: 'Morgan',
          mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
        })
      ]
    );

    expect(result.candidates.map(c => c.coinId)).toEqual(['morgan-1881']);
    expect(result.matchedRecordId).toBe('morgan-1881');
  });
});

// 5. Vetoes never loosen the other gates.
describe('vetoes are an extra constraint, never a loosening', () => {
  it('a disqualified runner-up still counts for the runner-up margin', () => {
    // Two non-vetoed coins differing only by mint mark: the margin gate
    // still keeps the file in review.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar MS63 - Obverse.jpg'],
      [
        coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63' }),
        coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63' })
      ]
    );

    expect(result.status).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
  });

  it('an empty inventory is still handled, and so is an all-vetoed one', () => {
    expect(service().matchImages(['1881 Morgan Dollar MS63.jpg'], [])[0].status).toBe('none');

    const [allVetoed] = service().matchImages(
      ['1881 Morgan Dollar MS63.jpg'],
      [coin({ id: 'a', year: '1799', denomination: 'Dollar', coinType: 'Morgan' })]
    );
    expect(allVetoed.status).toBe('none');
    expect(allVetoed.confidence).toBe(0);
    expect(allVetoed.candidates).toEqual([]);
  });
});

// 5b. Three-cent equivalence end to end.
describe('the three-cent equivalence survives the whole pipeline', () => {
  it('attaches a generic 3-cent photo to a 3CS record', () => {
    const [result] = service().matchImages(
      ['1851 3-cent - VF - Obverse.jpg'],
      [coin({ id: 'trime', year: '1851', denomination: '3CS', grade: 'VF' })]
    );

    expect(result.matchedRecordId).toBe('trime');
    expect(result.reason).toContain('general form of');
  });

  it('attaches a generic 3-cent photo to a 3CN record', () => {
    const [result] = service().matchImages(
      ['1865 3-cent - VF - Obverse.jpg'],
      [coin({ id: 'nickel-3c', year: '1865', denomination: '3CN', grade: 'VF' })]
    );

    expect(result.matchedRecordId).toBe('nickel-3c');
  });

  it('attaches a 3CS photo to a generic Three Cent record', () => {
    const [result] = service().matchImages(
      ['1851 3CS - VF - Obverse.jpg'],
      [coin({ id: 'generic', year: '1851', denomination: 'Three Cent', grade: 'VF' })]
    );

    expect(result.matchedRecordId).toBe('generic');
  });

  it('refuses a 3CN photo against a 3CS record even in the overlap years', () => {
    // Both were struck 1865-1873, so only the denomination separates them.
    const [result] = service().matchImages(
      ['1870 3CN - VF - Obverse.jpg'],
      [coin({ id: 'trime-1870', year: '1870', denomination: '3CS', grade: 'VF' })]
    );

    expect(result.matchedRecordId).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.skipReason).toContain('disqualified');
  });

  it('picks the right one when both three-cent records are present', () => {
    const [result] = service().matchImages(
      ['1870 3CN - VF - Obverse.jpg'],
      [
        coin({ id: 'trime-1870', year: '1870', denomination: '3CS', grade: 'VF' }),
        coin({ id: 'nickel-1870', year: '1870', denomination: '3CN', grade: 'VF' })
      ]
    );

    expect(result.candidates.map(c => c.coinId)).toEqual(['nickel-1870']);
    expect(result.matchedRecordId).toBe('nickel-1870');
  });
});

// 6. Folder names (e.g. "Early Proofs") must never reach the parser.
describe('the folder a photo lives in never affects the match', () => {
  it('ignores an "Early Proofs" directory on the path', () => {
    const bare = parseFilename('1881 Morgan Dollar PCGS MS63 - Obverse.jpg');
    const nested = parseFilename(
      '\\\\NAS\\Coin Pictures\\Early Proofs\\1881 Morgan Dollar PCGS MS63 - Obverse.jpg'
    );

    expect(nested.fileName).toBe('1881 Morgan Dollar PCGS MS63 - Obverse.jpg');
    expect(nested.strike).toBe('business');
    expect(nested.strike).toBe(bare.strike);
    expect(nested.tokens).toEqual(bare.tokens);
    expect(nested.coinTypeTokens).toEqual(bare.coinTypeTokens);
  });

  it('a proof in the folder is still matched from its own name, not the folder', () => {
    const nested = parseFilename('C:/Coin Pictures/Early Proofs/1870 1-cent NGC PF65RB - Obverse 2.jpg');
    expect(nested.strike).toBe('proof');
  });
});

// 7. Authenticity veto: fake and genuine never match. Silence means genuine.
describe('veto 4 - fake never matches genuine, in either direction', () => {
  const record = { year: '1861', denomination: '3CS', coinType: 'Three Cent Silver', grade: 'XF45' };

  it('vetoes a fake photo against a genuine record', () => {
    const verdict = veto('1861 3CS - XF45 - Obverse - FAKE.jpg', record);
    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/counterfeit/);
  });

  it('vetoes a genuine photo against a fake record (word in Variety)', () => {
    expect(veto('1861 3CS - XF45 - Obverse.jpg', { ...record, variety: 'FAKE' }).vetoed).toBe(true);
  });

  it('does not veto fake against fake, whichever marker word each side uses', () => {
    expect(veto('1861 Counterfeit 3CS - XF45 - Obverse.jpg', { ...record, variety: 'FAKE' }).vetoed).toBe(false);
    expect(veto('1861 3CS - XF45 - Replica.jpg', { ...record, variety: 'Counterfeit' }).vetoed).toBe(false);
  });

  it('does not veto genuine against genuine', () => {
    expect(veto('1861 3CS - XF45 - Obverse.jpg', record).vetoed).toBe(false);
  });

  it('ignores the word inside a longer word', () => {
    expect(veto('1861 3CS - XF45 - Fakeout.jpg', record).vetoed).toBe(false);
  });
});
