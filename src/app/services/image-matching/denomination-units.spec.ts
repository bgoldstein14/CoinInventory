 /*
 * Face value vs price: a dollar amount is the coin's face value only if it is
 * written exactly as an amount in DOLLAR_FACE_VALUES and the words haven't
 * already named a different denomination. Tested through the real entry
 * points `parseFilename` and `parseCoin`.
  */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { parseCoin } from './coin-signature';
import { parseFilename } from './filename-parser';

function coin(overrides: Partial<CoinRecord> & { id: string }): CoinRecord {
  return {
    denomination: '', year: '', coinType: '', category: '', country: 'United States',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths: [], source: 'manual',
    ...overrides
  };
}

/** The denomination key a FILENAME produces. */
const fileKey = (name: string) => parseFilename(name).denomination;
/** The denomination key a RECORD's denomination column produces. */
const recordKey = (denomination: string) =>
  parseCoin(coin({ id: 'd', denomination })).denomination;

describe('a dollar amount is a face value only if a coin is worth exactly that', () => {
  it.each([
    ['1870 $1 - Obverse.jpg',          'dollar',        'the silver dollar'],
    ['1911 $2.50 Indian.jpg',          'quarter eagle', 'the Quarter Eagle -- a real denomination WITH cents'],
    ['1854 $3 - Obverse.jpg',          'three dollar',  'the three dollar gold piece'],
    ['1906-S $5 - XF-AU.jpg',          'half eagle',    'the Half Eagle'],
    ['1907 $10 - Obverse.jpg',         'eagle',         'the Eagle'],
    ['1904 $20 - PCGS MS63.jpg',       'double eagle',  'the Double Eagle'],
    ['2015 $25 - MS70.jpg',            'twenty five dollar', 'the half-ounce bullion Eagle'],
    ['2015 $50 - MS70.jpg',            'fifty dollar',  'the one-ounce bullion Eagle']
  ])('%s is %s -- %s', (name, key) => {
    expect(fileKey(name)).toBe(key);
  });

  it('$2.50 needs no special case any more -- it is simply in the table', () => {
    expect(fileKey('1911 $2.50 Indian - Obverse.jpg')).toBe('quarter eagle');
    expect(fileKey('1878 $2.50 Liberty - AU55 - Reverse.jpg')).toBe('quarter eagle');
    // Both spellings of the same coin land on the same key.
    expect(fileKey('1911 Quarter Eagle - Obverse.jpg')).toBe('quarter eagle');
    expect(recordKey('$2.50')).toBe('quarter eagle');
  });

  it.each([
    ['1881-S Morgan $4 - Obverse.jpg',   '$4 -- the Stella was a pattern, not a denomination here'],
    ['1881-S Morgan $15 - Obverse.jpg',  '$15 -- no US coin was ever worth fifteen dollars'],
    ['1881-S Morgan $40 - Obverse.jpg',  '$40 -- likewise'],
    ['1881-S Morgan $99 - Obverse.jpg',  '$99 -- likewise']
  ])('%s yields no denomination at all (%s)', name => {
    // No coin has this face value, so it is a price.
    expect(fileKey(name)).toBeNull();
  });
});

describe('an amount written with cents is money', () => {
  it.each([
    ['1904 $20.00 - Obverse.jpg',   '$20.00 -- nothing is denominated "twenty dollars and no cents"'],
    ['2015 $25.00 - MS70.jpg',      '$25.00 -- a price, even though $25 is a real denomination'],
    ['2015 $50.00 - MS70.jpg',      '$50.00 -- likewise'],
    ['1870 $1.00 - Obverse.jpg',    '$1.00 -- likewise']
  ])('%s yields no denomination (%s)', name => {
    expect(fileKey(name)).toBeNull();
  });

  it('a thousands separator is refused before the table is even consulted', () => {
    // "$1,250" would otherwise match its leading "$1" and be read as a Dollar.
    expect(fileKey('1881-S Morgan $1,250.00 - Obverse.jpg')).toBeNull();
    expect(fileKey('1881-S Morgan $1,250 - Obverse.jpg')).toBeNull();
    expect(fileKey('1904 $2,000.00 - Obverse.jpg')).toBeNull();
  });

  it('a coin RECORD column answers the same way, from the same table', () => {
    expect(recordKey('$50')).toBe('fifty dollar');
    expect(recordKey('$50.00')).toBeNull();
    expect(recordKey('$25.00')).toBeNull();
    expect(recordKey('$20.00')).toBeNull();
  });
});

describe('a coin has one face value, so a second, different amount is the price', () => {
  it('the real filename this rule was written for stays an ordinary Peace dollar', () => {
    // Real filename: the words say "Dollar"; $25.00 is the price.
    expect(fileKey('1925-S Peace Dollar $25.00.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar NGC 2599001 $25.00.jpg')).toBe('dollar');
    expect(parseFilename('1925-S Peace Dollar $25.00.jpg').coinTypeTokens).toContain('peace');
  });

  it('!! A ROUND PRICE IS A PRICE WHEN THE WORDS ALREADY NAMED THE COIN !!', () => {
    // "$50" looks like the $50 Gold Eagle, but the words already named a
    // one-dollar coin, so the amount is a price.
    expect(fileKey('1881-S Morgan Dollar $50.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar $25 - Obverse.jpg')).toBe('dollar');
    expect(fileKey('1913 50-Cent Canadian $20 - Obverse.jpg')).toBe('half dollar');
    expect(fileKey('1875-CC 20-cent $5 - Choice F.jpg')).toBe('twenty cent');
  });

  it('an amount that AGREES with the words is the same coin said twice, and still wins', () => {
    // Agreement is decided by `denominationsAgree`; the amount is the more
    // precise statement, so it is the answer.
    expect(fileKey('2015 $25 Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
    expect(fileKey('2015 $50 Gold Eagle - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 $10 Gold Eagle.jpg')).toBe('eagle');
    expect(fileKey('1907 $20 Double Eagle - Obverse.jpg')).toBe('double eagle');
    expect(fileKey('1911 Quarter Eagle $2.50 - AU55.jpg')).toBe('quarter eagle');
    // "Silver Eagle" is "$1" (an alias row in the equivalence table).
    expect(fileKey('1986 Silver Eagle $1.jpg')).toBe('dollar');
  });

  it('with two amounts in one name, the one that is a coin wins -- in either order', () => {
    expect(fileKey('1904 $20 Double Eagle $1,500.00.jpg')).toBe('double eagle');
    expect(fileKey('1904 $1,500.00 Double Eagle $20.jpg')).toBe('double eagle');
    expect(fileKey('1904 $20 - $15 - Obverse.jpg')).toBe('double eagle');
  });

  it('WITH NO WORDS, a round price is still read as a face value -- the honest limit', () => {
    // Known limit: nothing here distinguishes a $50 coin from a $50 price.
    expect(fileKey('1881-S Morgan $50 - Obverse.jpg')).toBe('fifty dollar');
  });
});

describe('the Gold Eagle year resolution is untouched by all of this', () => {
  it('a modern year still means the $50 one-ounce bullion coin', () => {
    expect(fileKey('2015 Gold Eagle - Obverse.jpg')).toBe('fifty dollar');
    expect(fileKey('2021 Eagle - NGC MS70.jpg')).toBe('fifty dollar');
  });

  it('a classic year still means the $10 gold piece, and no year still means neither', () => {
    expect(fileKey('1907 Gold Eagle - Obverse.jpg')).toBe('eagle');
    expect(fileKey('Gold Eagle - Obverse.jpg')).toBe('gold eagle');
  });

  it('a weight word still names the exact bullion size', () => {
    expect(fileKey('2015 1 oz Gold Eagle - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 1-2 oz Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
    expect(fileKey('2015 1-10 oz Gold Eagle - MS70.jpg')).toBe('half eagle');
  });

  it('a price in the name does not disturb the resolution', () => {
    expect(fileKey('2015 Gold Eagle $1,850.00 - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 Gold Eagle $1,850.00 - MS70.jpg')).toBe(
      fileKey('2015 Gold Eagle - MS70.jpg')
    );
  });
});

describe('the cent forms are unaffected -- nobody prices a coin at "50c"', () => {
  it.each([
    ['1812 50¢ - Obverse.jpg',            'half dollar'],
    ['1875 20¢ - Obverse.jpg',            'twenty cent'],
    ['1875-CC 20-cent Choice F.jpg',      'twenty cent'],
    ['1870 1-cent NGC PF65RB.jpg',        'cent'],
    ['1964 Kennedy 50C - Obverse.jpg',    'half dollar']
  ])('%s is %s', (name, key) => {
    expect(fileKey(name)).toBe(key);
  });

  it('a dollar price beside a cent denomination changes nothing', () => {
    expect(fileKey('1875 20¢ $300.00 - Obverse.jpg')).toBe('twenty cent');
    expect(fileKey('1913 50-Cent Canadian $45.00 - Obverse.jpg')).toBe('half dollar');
  });

  it('"G$1" is still a GOLD dollar and is still read before the plain dollar sign', () => {
    expect(fileKey('G$1 1854 - Obverse.jpg')).toBe('gold dollar');
  });
});

 /*
 * Spaced face values ("2 cent", "20 cent") read as the face value, not as a
 * One Cent piece. Stamps and paper money are kept out by the non-coin
 * detector (last block below).
  */
describe('a spaced face value is a face value, because he said so', () => {
  it.each([
    ['1864 2 cent - Obverse.jpg',          'two cent'],
    ['1875 20 cent - Obverse.jpg',         'twenty cent'],
    ['1851 3 cent - VF - Obverse.jpg',     'three cent'],
    ['1866 2 cent - PCGS PF64RB - Obverse.jpg', 'two cent'],
    ['1876 20 cent - PCGS PF63 - Obverse.jpg',  'twenty cent']
  ])('%s reads as %s', (name, key) => {
    expect(fileKey(name)).toBe(key);
  });

  it('the count of ONE was always allowed through, and still is', () => {
    expect(fileKey('1870 1 cent - Obverse.jpg')).toBe('cent');
    expect(fileKey('1883 1 cent - NGC PF66BN - Obverse.jpg')).toBe('cent');
  });

  it('still reads a four-digit year in front of "cent" as a DATE, not a count', () => {
    expect(fileKey('1870 Cent - Obverse.jpg')).toBe('cent');
  });

  it.each([
    '1864 3-cent silver - PF64 - Obverse.jpg',
    '1864 3 cent silver - PF64 - Obverse.jpg',
    '1864 Three Cent Silver - PF64 - Obverse.jpg'
  ])('reads the METAL out of %s instead of settling for the generic', name => {
    // The generic 'three cent' would let a 3CS photo through the veto
    // against a 3CN record.
    expect(fileKey(name)).toBe('three cent silver');
  });
});

describe('the spaced form must not let a stamp or paper money in', () => {
  // A postage stamp and two pieces of fractional currency (real filenames).
  // `detectNonCoin` rules them out before the spaced reader sees them.
  it.each([
    ['Stamp - 11 - 3 cent.jpg',        'stamp'],
    ['3-cent paper - Large.jpg',       'paper'],
    ['3-cent Fractional - FR1227.jpg', 'fractional']
  ])('refuses to read a coin out of %s', (name, word) => {
    const parsed = parseFilename(name);
    expect(parsed.isNonCoin, name).toBe(true);
    expect(parsed.nonCoinReason?.toLowerCase(), name).toContain(word);
  });
});
