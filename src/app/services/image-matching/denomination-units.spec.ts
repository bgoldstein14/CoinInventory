/* ===========================================================================
 * denomination-units.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PINS DOWN
 *   The one rule that tells a coin's FACE VALUE from a PRICE:
 *
 *     A DOLLAR AMOUNT IN A FILENAME IS THIS COIN'S FACE VALUE ONLY IF IT IS
 *     WRITTEN EXACTLY AS ONE OF THE AMOUNTS IN DOLLAR_FACE_VALUES, AND ONLY IF
 *     NOTHING ELSE IN THE NAME HAS ALREADY NAMED A DIFFERENT ONE.
 *
 *   It is true of COINS, not just of this code: a face value is struck by a
 *   mint and comes from a short, closed list ($1, $2.50, $3, $5, $10, $20 and,
 *   since 1986, the bullion $25 and $50), whereas a price is whatever this one
 *   happened to cost. So the question is "is there a coin worth that?", and
 *   the denomination table is the list of coins there are.
 *
 * WHAT IT REPLACED
 *   A count of decimal places: "whole dollars are a face value, an amount with
 *   cents is a price, except $2.50, which was whitelisted by name". That was a
 *   rule plus a hand-written exception, and it could not see that "$15" is not
 *   a coin or that a round "$50" beside the word "Dollar" is a purchase.
 *
 * WHY THE TESTS GO THROUGH `parseFilename` AND `parseCoin`
 *   Both are the real entry points, so these assertions fail if any layer
 *   between the filename and the answer stops honouring the rule -- not just
 *   if the table changes.
 * =========================================================================== */

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
    /* THE POINT OF THE WHOLE REFACTOR. The old rule said "an amount with cents
     * is a price" and then had to carve the Quarter Eagle back out by name.
     * The Quarter Eagle was never an exception: it is one of the amounts a US
     * coin is worth, and its cents are part of how that amount is spelled. */
    expect(fileKey('1911 $2.50 Indian - Obverse.jpg')).toBe('quarter eagle');
    expect(fileKey('1878 $2.50 Liberty - AU55 - Reverse.jpg')).toBe('quarter eagle');
    // Both spellings of the same coin land on the same key, as they always did.
    expect(fileKey('1911 Quarter Eagle - Obverse.jpg')).toBe('quarter eagle');
    expect(recordKey('$2.50')).toBe('quarter eagle');
  });

  it.each([
    ['1881-S Morgan $4 - Obverse.jpg',   '$4 -- the Stella was a pattern, not a denomination here'],
    ['1881-S Morgan $15 - Obverse.jpg',  '$15 -- no US coin was ever worth fifteen dollars'],
    ['1881-S Morgan $40 - Obverse.jpg',  '$40 -- likewise'],
    ['1881-S Morgan $99 - Obverse.jpg',  '$99 -- likewise']
  ])('%s yields no denomination at all (%s)', name => {
    /* THE ROUND-NUMBER HOLE, CLOSED WHERE IT CAN BE. The old rule read every
     * whole-dollar amount as a face value, so these all invented a coin. The
     * table says no such coin exists, so they are prices and say nothing. */
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
    // This side has always worked by exact lookup; the filename side has now
    // caught up with it.
    expect(recordKey('$50')).toBe('fifty dollar');
    expect(recordKey('$50.00')).toBeNull();
    expect(recordKey('$25.00')).toBeNull();
    expect(recordKey('$20.00')).toBeNull();
  });
});

describe('a coin has one face value, so a second, different amount is the price', () => {
  it('the real filename this rule was written for stays an ordinary Peace dollar', () => {
    // Verbatim from the owner's share. The words say "Dollar"; $25.00 is what
    // he paid for it.
    expect(fileKey('1925-S Peace Dollar $25.00.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar NGC 2599001 $25.00.jpg')).toBe('dollar');
    expect(parseFilename('1925-S Peace Dollar $25.00.jpg').coinTypeTokens).toContain('peace');
  });

  it('!! A ROUND PRICE IS A PRICE WHEN THE WORDS ALREADY NAMED THE COIN !!', () => {
    /* The hole the old decimal rule could not close: "$50" with no cents is
     * written exactly like the $50 Gold Eagle. The words are what give it
     * away -- a Morgan is a ONE dollar coin, so a fifty dollar amount in the
     * same name is money. */
    expect(fileKey('1881-S Morgan Dollar $50.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar $25 - Obverse.jpg')).toBe('dollar');
    expect(fileKey('1913 50-Cent Canadian $20 - Obverse.jpg')).toBe('half dollar');
    expect(fileKey('1875-CC 20-cent $5 - Choice F.jpg')).toBe('twenty cent');
  });

  it('an amount that AGREES with the words is the same coin said twice, and still wins', () => {
    /* Agreement, not equality, and it is `denominationsAgree` in
     * reference-tables.ts that decides -- so every alias and generic/specific
     * pair already agreed there is inherited rather than re-litigated. The
     * amount is the more precise of the two statements, so it is the answer. */
    expect(fileKey('2015 $25 Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
    expect(fileKey('2015 $50 Gold Eagle - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 $10 Gold Eagle.jpg')).toBe('eagle');
    expect(fileKey('1907 $20 Double Eagle - Obverse.jpg')).toBe('double eagle');
    expect(fileKey('1911 Quarter Eagle $2.50 - AU55.jpg')).toBe('quarter eagle');
    // "Silver Eagle" IS "$1" -- the one alias row in the equivalence table.
    expect(fileKey('1986 Silver Eagle $1.jpg')).toBe('dollar');
  });

  it('with two amounts in one name, the one that is a coin wins -- in either order', () => {
    expect(fileKey('1904 $20 Double Eagle $1,500.00.jpg')).toBe('double eagle');
    expect(fileKey('1904 $1,500.00 Double Eagle $20.jpg')).toBe('double eagle');
    expect(fileKey('1904 $20 - $15 - Obverse.jpg')).toBe('double eagle');
  });

  it('WITH NO WORDS, a round price is still read as a face value -- the honest limit', () => {
    /* Stated rather than hidden. There is nothing in this name to separate a
     * $50 coin from a coin that cost $50: the evidence is absent, not
     * misread. The exposure is as old as "$1", "$5" and "$20", and in this
     * collection the denomination is written first and a price carries cents.
     * If this test ever starts failing because the name now parses as null,
     * that is an improvement -- but it must be a deliberate one. */
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
    // The amount is thrown out as money, and the word + year decide as usual.
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

/* ===========================================================================
 * THE SPACED FACE VALUE -- "2 cent", "3 cent", "20 cent"
 * ---------------------------------------------------------------------------
 * THESE ASSERTIONS USED TO LIVE IN `three-cent-proofs.spec.ts`, a spec named
 * after one collection of coins. The owner saw that file and said:
 *
 *   "I wouldn't expect there to be a special file to single out a particular
 *    type of coin like the three-cent-proofs.spec.ts. That's too specific and
 *    will just add a lot of noise to this project if we had files for every
 *    denomination. Likely, whatever rules are in there can be applied across
 *    the board."
 *
 * He is right, and none of these is about three-cent pieces: they are facts
 * about how a FACE VALUE is read, which is what this file owns. The tests
 * that genuinely needed his inventory moved to inventory-accounts.spec.ts.
 *
 * ---------------------------------------------------------------------------
 * THE HISTORY, BECAUSE THE ANSWER HERE WAS ONCE THE OPPOSITE
 * ---------------------------------------------------------------------------
 *   The spaced form used to be REFUSED, and the refusal was deliberate: the
 *   bare word "cent" is a spelling of the ONE CENT piece, so "2 cent" came out
 *   as a penny -- and a wrong denomination is a HARD VETO, which disqualified
 *   his two-cent photographs from their own records. Reading nothing was the
 *   safe answer available at the time.
 *
 *   He was then asked the question directly, and answered it:
 *
 *       "Yes, read them as face values"
 *
 *   So "2 cent" is the Two Cent piece, "3 cent" a three-cent piece and
 *   "20 cent" the Twenty Cent. The hyphen that used to be required is no
 *   longer what keeps stamps and paper money out; the non-coin detector is,
 *   and the last block below names the exact files it has to refuse.
 * ========================================================================= */
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
    // The spaced reader must not swallow "1870 Cent", which is a one-cent coin
    // whose year happens to sit immediately before the word.
    expect(fileKey('1870 Cent - Obverse.jpg')).toBe('cent');
  });

  it.each([
    '1864 3-cent silver - PF64 - Obverse.jpg',
    '1864 3 cent silver - PF64 - Obverse.jpg',
    '1864 Three Cent Silver - PF64 - Obverse.jpg'
  ])('reads the METAL out of %s instead of settling for the generic', name => {
    /* All three say SILVER in so many letters, so all three must produce the
     * SPECIFIC key. Settling for the generic 'three cent' would leave the
     * denomination veto unable to separate a 3CS from a 3CN -- and reading
     * the bare "cent" instead would make it a ONE CENT piece, which is worse
     * still, because that is a hard veto against its own record. */
    expect(fileKey(name)).toBe('three cent silver');
  });
});

describe('the spaced form must not let a stamp or paper money in', () => {
  /* THE DEFENCE THE SPACED FACE VALUE WOULD OTHERWISE HAVE BROKEN.
   *
   * The first of these is a POSTAGE STAMP and the other two are FRACTIONAL
   * CURRENCY -- paper, not coins -- and all three are verbatim from his
   * share. The hyphen rule in denomination-units.ts was once documented as
   * "the entire defence" against the first one, because "3 cent" with a
   * space was refused outright.
   *
   * Now that the spaced form IS a face value, the defence comes from the word
   * that says what the thing is. Each of these names one, so `detectNonCoin`
   * rules the file out BEFORE the spaced reader is ever offered it. */
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
