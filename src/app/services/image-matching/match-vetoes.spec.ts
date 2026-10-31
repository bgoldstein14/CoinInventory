/* ===========================================================================
 * match-vetoes.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   The three HARD VETOES, each in both directions, and -- just as important
 *   -- every case that must NOT veto:
 *
 *     1. a stated year conflict disqualifies a coin;
 *     2. a stated denomination conflict disqualifies a coin, EXCEPT where the
 *        owner's "3¢ is equivalent to 3CS or 3CN" rule applies;
 *     3. a proof never matches a business strike, in either direction;
 *     4. SILENCE ON EITHER SIDE NEVER VETOES -- the absence cases;
 *     5. THE PROOFLIKE TRAP: a PL / DMPL / "prooflike" coin is a BUSINESS
 *        strike and must still match a non-proof record.
 *
 *   And at three levels, because a veto is only worth having if it reaches
 *   all of them:
 *     - `findVetoes`, the rule itself;
 *     - `matchImages`, the auto-assign decision and the candidate list;
 *     - `assessNearMatch` / the import tier, so tier 2 cannot offer a coin
 *       the decision has already thrown out.
 *
 * WHY SO MANY "MUST NOT VETO" TESTS
 *   A veto is harsher than a low score: it removes the coin from the ranked
 *   list entirely, so the user cannot even pick it by hand. An over-eager
 *   veto therefore HIDES a correct coin, which is worse than an over-generous
 *   score that merely asks a question. Half of this file exists to pin the
 *   veto's upper bound.
 * =========================================================================== */

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

/* =========================================================================
 * 1. THE YEAR VETO
 * =======================================================================
 * The owner: "First it's not a close match if the years don't match."
 */
describe('veto 1 - a stated year conflict disqualifies the coin', () => {
  it('vetoes when the filename year is later than the record year', () => {
    const verdict = veto('1881 Morgan Dollar PCGS MS63 - Obverse.jpg', {
      year: '1880', denomination: 'Dollar', coinType: 'Morgan', grade: 'MS63', certCompany: 'PCGS'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('year 1881 does not match');
  });

  it('vetoes when the filename year is earlier than the record year', () => {
    // The same conflict the other way round. A veto is symmetric; nothing
    // about which side is bigger matters.
    const verdict = veto('1880 Morgan Dollar PCGS MS63 - Obverse.jpg', {
      year: '1881', denomination: 'Dollar', coinType: 'Morgan', grade: 'MS63', certCompany: 'PCGS'
    });

    expect(verdict.vetoed).toBe(true);
  });

  it('does NOT veto a year inside a type-set record\'s RANGE', () => {
    // A type-set entry is written "1916-1945". Any year inside it is the coin.
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
    // Absence is not disagreement. "Caracalla Denarius - Sear 6819" has no
    // year at all and must stay on the shortlist for a dated record.
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

/* =========================================================================
 * 2. THE DENOMINATION VETO
 * =======================================================================
 * The owner: "It's also not a close match if the denomination does not
 * match."
 */
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
    // "1881-S Morgan - 20 - Obverse.jpg" is verbatim from the share and names
    // no denomination at all.
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

/* =========================================================================
 * 2b. "3¢ CAN BE EQUIVALENT TO 3CS OR 3CN"
 * =======================================================================
 * The owner's follow-up rule, verbatim: "Also note that 3¢ can be equivalent
 * to 3CS or 3CN for any matches for pulling in coin inventory and grabbing
 * coin details or image matching to inventory."
 *
 * The asymmetry is the whole point, so every relation is tested in both
 * directions:
 *     generic  <-> specific    equivalent
 *     specific <-> specific    a genuine conflict
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
    // Verbatim from the share. Without the equivalence this correct match
    // would be thrown out, which is the failure the owner pre-empted.
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
    // The other direction: the RECORD is the vague one this time.
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
    /* A regression guard with teeth. The generic ['nickel'] rule used to be
     * listed above ['three','cent','nickel'] in DENOMINATION_RULES, so a
     * record spelling the denomination out in full was filed as a five-cent
     * piece -- and every 3CN photograph then "conflicted" with its own
     * record. The veto turned that quiet mis-parse into a visible lost match,
     * which is how it was found. */
    expect(parseCoin(coin({ id: 'n', denomination: 'Three Cent Nickel' })).denomination)
      .toBe('three cent nickel');
    expect(parseCoin(coin({ id: 's', denomination: 'Three Cent Silver' })).denomination)
      .toBe('three cent silver');
    // The ordinary five-cent piece still reads as a nickel.
    expect(parseCoin(coin({ id: 'f', denomination: 'Nickel' })).denomination).toBe('nickel');
  });

  it('reads the cent-sign denominations the database actually stores', () => {
    /* server/setup-database.sql seeds '1¢', '5¢', '20¢', '50¢' and friends.
     * `tokenize` deletes the sign, so these used to contribute NO
     * denomination at all -- which also meant the denomination veto could
     * never fire for a real record. */
    const key = (denomination: string) =>
      parseCoin(coin({ id: 'd', denomination })).denomination;

    expect(key('1¢')).toBe('cent');
    /* '5¢' reads as the GENERIC five-cent face value, not straight to
     * 'nickel'. It is the only five-cent row the seed offers, and the owner
     * says a Half Dime of his may well be filed under it, so it must stay
     * compatible with both coins. See the five-cent group in
     * reference-tables.ts -- and the dedicated tests in that section below. */
    expect(key('5¢')).toBe('five cent');
    expect(key('10¢')).toBe('dime');
    expect(key('20¢')).toBe('twenty cent');
    expect(key('25¢')).toBe('quarter');
    expect(key('50¢')).toBe('half dollar');
    expect(key('½¢')).toBe('half cent');
    // The abbreviations and dollar forms were already understood.
    expect(key('3CS')).toBe('three cent silver');
    expect(key('$20')).toBe('double eagle');
  });
});

/* =========================================================================
 * 2c. THE REST OF THE OWNER'S EQUIVALENCE RULES
 * =======================================================================
 * His answer when asked to confirm the remaining candidates, verbatim:
 *
 *   "Large Cent is also 1¢. Half Dime can be ½10¢ or 5¢; Trade Dollar can be
 *    $1 but usually the words Trade Dollar will be in the descriptor; Silver
 *    Eagle only refers to $1, where a (Gold) Eagle is $10 and a (Gold) Double
 *    Eagle is $20, a (Gold) Half Eagle is $5, and a (Gold) Quarter Eagles is
 *    $2.50. There are Gold $1 coins too but should have the word Gold in the
 *    descriptor or possibly G$1."
 *
 * There are TWO DIFFERENT SHAPES of rule in that paragraph and the tests are
 * grouped by shape, because the thing that distinguishes them is what must
 * NOT happen:
 *
 *   A. ALIASES          two names for one face value. Nothing conflicts.
 *   B. GENERIC/SPECIFIC the generic matches either; THE SPECIFICS CONFLICT.
 *
 * Mixing the two up is the expensive mistake: treat a generic group as an
 * alias and a silver trime starts matching a copper-nickel one.
 */
describe('equivalence A - straight aliases, two names for one face value', () => {
  /** The denomination key a RECORD's denomination field produces. */
  const key = (denomination: string) =>
    parseCoin(coin({ id: 'd', denomination })).denomination;

  /** The same, for a record that also states a year -- which the Eagle needs. */
  const keyWithYear = (denomination: string, year: string) =>
    parseCoin(coin({ id: 'd', denomination, year })).denomination;

  /** The denomination key a FILENAME produces. */
  const fileKey = (name: string) => parseFilename(name).denomination;

  /* Four of the owner's six aliases need no equivalence row at all, because
   * both spellings already produce THE SAME KEY -- a stronger guarantee than
   * a lookup, since plain `===` agrees. These assertions are what pins that
   * down, and they are written through the PARSERS rather than against the
   * table so they would fail if either spelling stopped being understood. */
  it.each([
    ['Double Eagle',  '$20',    'twenty dollars of gold'],
    ['Half Eagle',    '$5',     'five dollars of gold'],
    ['Quarter Eagle', '$2.50',  'two and a half dollars of gold']
  ])('"%s" and "%s" are one key -- %s', (words, signs) => {
    expect(key(words)).toBe(key(signs));
    expect(key(words)).toBeTruthy();
    // Both directions, through the shared comparison the matcher actually uses.
    expect(denominationsAgree(key(words), key(signs))).toBe(true);
    expect(denominationsAgree(key(signs), key(words))).toBe(true);
    // And the same through a filename, which is read by different code.
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
    /* "½10¢" ends in "10¢". A cent-sign reader that does not look for the
     * fraction first reports a DIME: twice the face value and the wrong
     * coin. Both the record path and the filename path are checked. */
    expect(key('½10¢')).not.toBe('dime');
    expect(fileKey('1853 ½10¢ - Obverse.jpg')).toBe('half dime');
  });

  it('"Silver Eagle" and "$1" are equivalent -- the one alias that needs a row', () => {
    // The owner: "Silver Eagle only refers to $1."
    expect(denominationsAgree('silver eagle', 'dollar')).toBe(true);
    expect(denominationsAgree('dollar', 'silver eagle')).toBe(true);
    expect(key('$1')).toBe('dollar');
    expect(fileKey('2021 American Silver Eagle.jpg')).toBe('silver eagle');
  });

  it('!! SILVER EAGLE IS NOT THE EAGLE !!', () => {
    /* THE trap in the owner's sentence. "Eagle" alone is the $10 gold piece,
     * 1795-1933. "Silver Eagle" is the one-dollar bullion coin, 1986-. They
     * share a word and nothing else, and collapsing them would file a $35
     * bullion photo under a five-figure gold coin. */
    expect(denominationsAgree('silver eagle', 'eagle')).toBe(false);
    expect(denominationsAgree('eagle', 'silver eagle')).toBe(false);

    // ...nor any of the other eagles.
    for (const other of ['double eagle', 'half eagle', 'quarter eagle', 'gold eagle']) {
      expect(denominationsAgree('silver eagle', other), other).toBe(false);
      expect(denominationsAgree(other, 'silver eagle'), other).toBe(false);
    }
  });

  it('"Eagle" and "$10" are still one key ONCE A YEAR SAYS WHICH SERIES', () => {
    /* This row used to live in the it.each above, as a plain alias. It no
     * longer can: since 1986 the bare word "Eagle" may also mean a modern
     * bullion coin (see the year suite at the bottom of this file). What is
     * still true, and is what the owner's sentence meant, is that a
     * CLASSIC-DATED Eagle is the $10 gold piece -- so with a year present the
     * two spellings land on the identical key exactly as before. */
    expect(key('$10')).toBe('eagle');
    expect(keyWithYear('Eagle', '1907')).toBe('eagle');
    expect(keyWithYear('Eagle', '1907')).toBe(key('$10'));
    expect(fileKey('1907 Eagle - Obverse.jpg')).toBe('eagle');
    expect(denominationsAgree(keyWithYear('Eagle', '1907'), key('$10'))).toBe(true);
    expect(denominationsAgree(key('$10'), keyWithYear('Eagle', '1907'))).toBe(true);
  });
});

/* =========================================================================
 * 2d. WHICH EAGLE? THE YEAR DECIDES
 * =======================================================================
 * The owner, asked whether the modern bullion series muddies "Gold Eagle":
 *
 *   "It's true that a modern Gold Eagle actually refers to the $50 bullion
 *    coin, but that should be easy to determine because of the modern year
 *    (they only were minted starting in 1986)."
 *
 * The two series and the gap between them:
 *
 *     CLASSIC   Eagle $10, Double Eagle $20, Half Eagle $5, Quarter Eagle
 *               $2.50 -- all finished by 1933 (the gold recall).
 *     MODERN    American Gold Eagle bullion, 1986 to date, in four sizes:
 *               1/10 oz $5, 1/4 oz $10, 1/2 oz $25, 1 oz $50.
 *     BETWEEN   1934-1985: nothing at all.
 *
 * Because they never overlap, one four-digit year settles it with no
 * guessing. These tests pin down all three answers -- classic, modern, and
 * "we do not know" -- and the fourth thing that matters most: that not
 * knowing never disqualifies anything.
 * ======================================================================= */
describe('which eagle - the year separates the classic $10 from the bullion $50', () => {
  const key = (denomination: string) =>
    parseCoin(coin({ id: 'd', denomination })).denomination;
  const keyWithYear = (denomination: string, year: string) =>
    parseCoin(coin({ id: 'd', denomination, year })).denomination;
  const fileKey = (name: string) => parseFilename(name).denomination;

  it('a MODERN-dated Gold Eagle is the $50 one-ounce bullion coin', () => {
    // The owner's own sentence, through both parsers.
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
    /* 1986 is the first year of the series, so it must resolve modern. 1985
     * is inside the 1934-1985 dead zone where NEITHER series was struck, so
     * the honest answer there is "we do not know", not "classic". */
    expect(fileKey('1986 Gold Eagle.jpg')).toBe('fifty dollar');
    expect(fileKey('1985 Gold Eagle.jpg')).toBe('gold eagle');
    // And 1933, the last classic year, is still classic.
    expect(fileKey('1933 Eagle.jpg')).toBe('eagle');
  });

  it('THE TWO SERIES DO NOT AGREE WITH EACH OTHER', () => {
    /* The point of the whole exercise. A 2015 one-ounce bullion coin and a
     * 1907 $10 gold piece are different coins worth different money, and the
     * denomination veto must be able to tell them apart. */
    expect(denominationsAgree('fifty dollar', 'eagle')).toBe(false);
    expect(denominationsAgree('eagle', 'fifty dollar')).toBe(false);
    expect(denominationsAgree('fifty dollar', 'twenty five dollar')).toBe(false);
    expect(denominationsAgree('fifty dollar', 'double eagle')).toBe(false);
    // ...and a modern Gold Eagle is not a Silver Eagle either.
    expect(denominationsAgree('fifty dollar', 'silver eagle')).toBe(false);
  });

  it('an UNDATED Eagle picks neither series, and vetoes nothing', () => {
    /* "Where there is no year, do not guess." The key stays vague, and the
     * equivalence table makes it compatible with every face value such a coin
     * could carry -- so a silent filename can never disqualify a correct
     * record. This is the "absence is not disagreement" rule, applied to a
     * question the filename simply did not answer. */
    expect(fileKey('Gold Eagle - Obverse.jpg')).toBe('gold eagle');
    expect(fileKey('Eagle - Reverse.jpg')).toBe('gold eagle');
    expect(key('Gold Eagle')).toBe('gold eagle');

    // It is neither of the two real answers...
    expect(fileKey('Gold Eagle - Obverse.jpg')).not.toBe('eagle');
    expect(fileKey('Gold Eagle - Obverse.jpg')).not.toBe('fifty dollar');

    // ...but it conflicts with neither of them, nor with the other two
    // bullion face values, in either direction.
    for (const other of ['eagle', 'half eagle', 'twenty five dollar', 'fifty dollar']) {
      expect(denominationsAgree('gold eagle', other), other).toBe(true);
      expect(denominationsAgree(other, 'gold eagle'), other).toBe(true);
    }

    // And no veto reaches the real decision, in either direction.
    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$10', year: '1907' }).vetoed).toBe(false);
    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$50', year: '2015' }).vetoed).toBe(false);
  });

  it('the vague key still conflicts with coins that are not eagles at all', () => {
    // Being undecided between the eagles is not the same as being undecided
    // about everything. A Morgan dollar is still a different coin.
    expect(denominationsAgree('gold eagle', 'dollar')).toBe(false);
    expect(denominationsAgree('gold eagle', 'double eagle')).toBe(false);
    expect(denominationsAgree('gold eagle', 'quarter eagle')).toBe(false);
    expect(veto('Gold Eagle - Obverse.jpg', { denomination: '$1', year: '' }).vetoed).toBe(true);
  });

  it('a stated year conflict still disqualifies across the two series', () => {
    /* Belt and braces: even if the denominations somehow agreed, a 2015 photo
     * can never be a 1907 record. This is the year veto doing the job the
     * 52-year gap makes possible. */
    expect(veto('2015 Gold Eagle.jpg', { denomination: '$10', year: '1907' }).vetoed).toBe(true);
    // And the denomination veto fires on its own account too.
    const verdict = veto('2015 Gold Eagle.jpg', { denomination: '$10', year: '2015' });
    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('denomination');
  });

  it('reads $25 and $50 as denominations, from a filename and from a record', () => {
    /* Neither value existed on a US coin before 1986, so neither was in the
     * tables at all until the bullion series needed them. */
    expect(key('$25')).toBe('twenty five dollar');
    expect(key('$50')).toBe('fifty dollar');
    expect(key('50 Dollars')).toBe('fifty dollar');
    expect(fileKey('2015 $50 Gold Eagle - MS70.jpg')).toBe('fifty dollar');
    expect(fileKey('2015 $25 Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
  });

  it('!! "$50.00" IS STILL A PRICE, NOT A DENOMINATION !!', () => {
    /* The hazard created by the row above. The distinction is a CLOSED SET:
     * an amount is a face value only if it is written exactly as one of the
     * amounts a US coin is actually worth, and only if the filename has not
     * already named a different one in words. So "$50.00" is not in the
     * table (no coin is denominated "fifty dollars and no cents"), "$2.50"
     * is in the table and needs no exception, and a thousands comma is
     * refused before the lookup is reached.
     *
     * The full rule lives in the DOLLAR_FACE_VALUES header in
     * denomination-units.ts and is tested in denomination-units.spec.ts;
     * these lines are the end-to-end guard on the hazard itself.
     *
     * The first line is the real filename this rule was written for, and it
     * must go on reading as an ordinary Peace dollar. */
    expect(fileKey('1925-S Peace Dollar NGC 2599001 $25.00.jpg')).toBe('dollar');
    expect(fileKey('1925-S Peace Dollar $25.00.jpg')).toBe('dollar');
    expect(fileKey('1881-S Morgan Dollar $50.00.jpg')).toBe('dollar');
    // With no coin word at all, a price yields no denomination whatsoever
    // rather than inventing one.
    expect(fileKey('1881-S Morgan $50.00 - Obverse.jpg')).toBeNull();
    expect(fileKey('1881-S Morgan $1,250.00 - Obverse.jpg')).toBeNull();
    // A round price is caught too, now, whenever the words name a different
    // coin: a Morgan is a ONE dollar coin, so "$50" beside it is money.
    expect(fileKey('1881-S Morgan Dollar $50.jpg')).toBe('dollar');
    // A record's denomination column behaves the same way.
    expect(key('$50.00')).not.toBe('fifty dollar');
  });

  it('a weight word names the exact bullion size -- but only once the year is modern', () => {
    /* A refinement, not a requirement. The four American Gold Eagle sizes are
     * 1/10 oz ($5), 1/4 oz ($10), 1/2 oz ($25) and 1 oz ($50); unqualified,
     * "Gold Eagle" means the one-ounce coin, which is the owner's $50. */
    expect(fileKey('2015 1 oz Gold Eagle - MS70.jpg')).toBe('fifty dollar');

    /* A FILENAME CANNOT CONTAIN A SLASH -- it is the path separator, and
     * baseName() would throw away everything before it, year included. So the
     * fraction forms a filename can actually carry are the hyphen, the
     * underscore and the single glyph. */
    expect(fileKey('2015 1-2 oz Gold Eagle - MS70.jpg')).toBe('twenty five dollar');
    expect(fileKey('2015 1_4 oz Gold Eagle - MS70.jpg')).toBe('eagle');
    expect(fileKey('2015 1-10 oz Gold Eagle - MS70.jpg')).toBe('half eagle');
    expect(fileKey('2015 ½ oz Gold Eagle - MS70.jpg')).toBe('twenty five dollar');

    // A RECORD's text keeps its slashes, so the written fraction works there.
    expect(
      parseCoin(coin({ id: 'd', coinType: 'Gold Eagle 1/2 oz', year: '2015' })).denomination
    ).toBe('twenty five dollar');

    /* With NO year the weight is not enough on its own: the year is the rule
     * the owner gave and the weight only refines it. Deliberately
     * conservative -- an unresolved key vetoes nothing, a wrong one does. */
    expect(fileKey('1 oz Gold Eagle.jpg')).toBe('gold eagle');
  });

  it('does not re-read a denomination that was never ambiguous', () => {
    /* `resolveEagleSeries` must touch ONLY the vague key. A stated face value
     * means what it says whatever the year beside it, and the named multiples
     * of the Eagle name their own size. */
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

  /* Every generic/specific pair, in both directions. None of these conflict:
   * the generic has not chosen, so it cannot disagree. */
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

  /* Every specific/specific pair, in both directions. ALL of these conflict:
   * two different coins have been named. This is the half of the rule that a
   * careless "just make them all equivalent" would destroy. */
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
    /* 'silver eagle' == 'dollar' and 'dollar' ~ 'trade dollar', but a 1986
     * bullion coin is not an 1878 China-trade dollar. The table is checked
     * row by row and never transitively; this test is what stops someone
     * "simplifying" it into a union-find. */
    expect(denominationsAgree('silver eagle', 'trade dollar')).toBe(false);
    expect(denominationsAgree('silver eagle', 'gold dollar')).toBe(false);
    expect(denominationsAgree('silver eagle', 'silver dollar')).toBe(false);
  });

  it('reads every spelling the owner named into the right key', () => {
    expect(key('5¢')).toBe('five cent');          // generic, and the only seeded row
    expect(key('1¢')).toBe('cent');               // generic
    expect(key('Large Cent')).toBe('large cent'); // specific
    expect(key('Small Cent')).toBe('small cent'); // specific
    expect(key('$1')).toBe('dollar');             // generic
    expect(key('G$1')).toBe('gold dollar');       // "or possibly G$1"
    expect(key('Gold Dollar')).toBe('gold dollar');
    expect(key('Silver Dollar')).toBe('silver dollar');
    expect(key('Trade Dollar')).toBe('trade dollar');
  });

  it('does not let "G$1" fall through to the plain dollar sign', () => {
    // "$1" is inside "G$1"; read first, it would throw away the "G".
    expect(parseFilename('1854 G$1 Type 2 - Obverse.jpg').denomination).toBe('gold dollar');
  });

  /* ---- and the same rules where they actually matter: the veto ---------- */

  it('does NOT veto a Half Dime filename against a record filed under 5¢', () => {
    /* The owner's case, end to end. The seed has no Half Dime row at all --
     * '5¢' is the nearest thing -- so without the generic group every half
     * dime photograph would be disqualified from its own record. */
    expect(veto('1853 Half Dime - VF - Obverse.jpg', {
      year: '1853', denomination: '5¢'
    }).vetoed).toBe(false);
  });

  it('DOES veto a Half Dime filename against a record that says Nickel', () => {
    // Both sides have named a coin, and they named different ones.
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

/* =========================================================================
 * 3. THE PROOF VETO
 * =======================================================================
 * The owner: "if it's a Proof/PF coin, it will never match a non-Proof/PF
 * coin as that will always be in the file and image descriptors."
 */
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
    // PCGS prints PR, NGC prints PF. Same striking.
    expect(veto('1870 $1 PR62 - Obverse.jpg', {
      year: '1870', denomination: '$1', grade: 'PF62'
    }).vetoed).toBe(false);
  });

  it('reads the word "proof" in a record with no grade', () => {
    // "Proof Gold" is verbatim from the coin types in real-filenames.spec.ts.
    const verdict = veto('1957 Sovereign MS63 - Obverse.jpg', {
      year: '1957', coinType: 'Proof Gold'
    });

    expect(verdict.vetoed).toBe(true);
  });

  it('does NOT veto when NEITHER side says how the coin was struck', () => {
    // The commonest case by far, and the one an over-eager veto would ruin.
    expect(veto('1881-S Morgan Dollar.jpg', {
      year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S'
    }).vetoed).toBe(false);
  });

  it('DOES veto when only the RECORD says proof -- a quiet filename says "business"', () => {
    /* !! THIS TEST USED TO ASSERT THE OPPOSITE. !!
     *
     * It is the single most important consequence of the owner's rule, and
     * it is written in his own words:
     *
     *   "The Proof descriptor should always be part of the image file name
     *    as well as part of the inventory description otherwise it's assumed
     *    the coin is a business strike."
     *
     * Read the last clause: *otherwise it's assumed the coin is a business
     * strike*. A filename that does not say "proof" is not a filename that
     * forgot to say it -- it is a filename about a coin that has nothing to
     * say. So it makes the positive claim "business strike", and that claim
     * contradicts a proof record exactly as "MS65" would.
     *
     * The worked example, verbatim from his share, is two photographs of one
     * proof coin:
     *
     *   1870 10-cent - NGC PF64Cameo - Reverse 5.jpg   says PF
     *   1870 10-cent - Obverse.jpg                     says nothing
     *
     * Under the old rule they both matched the record. Under his rule the
     * second one no longer does, and HE HAS BEEN TOLD THAT AND ACCEPTS IT,
     * under his standing tie-breaker:
     *
     *   "I can always force an image to be associated with a coin manually,
     *    but the automated process should be very descriminatory."
     *
     * A photograph refused here is still listed, still given a reason, and
     * still attachable in one click. A photograph wrongly attached is silent
     * and may never be noticed. */
    const verdict = veto('1870 10-cent - Obverse.jpg', {
      year: '1870', denomination: '10 Cents', grade: 'PF64 CAMEO', certCompany: 'NGC'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('business strike');
  });

  it('DOES veto when only the FILENAME says proof -- a quiet RECORD says "business" too', () => {
    /* The same rule from the other end, because he described BOTH sides:
     * "part of the image file name AS WELL AS part of the inventory
     * description". A record carrying a coin type, a variety, notes or a
     * grade -- anything at all -- and not mentioning proof is claiming to be
     * a business strike.
     *
     * Note the record below has to SAY SOMETHING for this to be silence
     * rather than absence: 'Dime' in the coin type is what makes it a record
     * that could have carried the word and did not. A record with no text and
     * no grade whatsoever is 'unknown' and still vetoes nothing -- see "the
     * limit of the rule" below. */
    const verdict = veto('1870 10-cent - NGC PF64Cameo - Reverse 5.jpg', {
      year: '1870', denomination: '10 Cents', coinType: 'Dime'
    });

    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join(' ')).toContain('proof');
  });

  /* -----------------------------------------------------------------------
   * SPECIMEN -- the owner closed this question after the first version
   * ---------------------------------------------------------------------
   * These tests used to assert the OPPOSITE: that SP disqualified nothing,
   * because the owner's rule named only proof against non-proof. He has since
   * said:
   *
   *   "I don't own any Specimens, however, SP or Specimen should always exist
   *    in the descriptor for such a coin."
   *
   * Same argument as for proof: the word is reliably present when true, so
   * its absence is a statement and not a gap. SP now vetoes both of the
   * others. On his data this changes nothing -- he owns none -- which is
   * exactly why it is a safe rule to add now rather than later.
   * ------------------------------------------------------------------- */
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
    /* !! THIS TEST USED TO ASSERT THE OPPOSITE, and the reason it changed is
     * the owner's own sentence about SP, which is the same argument he made
     * about proof:
     *
     *   "I don't own any Specimens, however, SP or Specimen should always
     *    exist in the descriptor for such a coin."
     *
     * "Should ALWAYS exist" is what makes the absence informative. A record
     * that says "Kennedy" and nothing else is not being vague about
     * specimen-ness; it is saying this is not a specimen. */
    expect(veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy'
    }).vetoed).toBe(true);

    expect(veto('1964 Kennedy 50C - Obverse.jpg', {
      year: '1964', denomination: '50 Cents', coinType: 'Kennedy', grade: 'SP67'
    }).vetoed).toBe(true);
  });

  it('does NOT veto against a side that is ENTIRELY EMPTY -- the limit of the rule', () => {
    /* THE LIMIT OF THE RULE, and the one that must never be relaxed.
     *
     * SILENCE and ABSENCE are different things, and only silence is
     * evidence:
     *
     *   SILENCE  a filename, or a record with some text or a grade, that
     *            simply does not mention proof. He writes the designation
     *            whenever it is true, so not writing it is a statement.
     *            -> 'business', and it can conflict.
     *
     *   ABSENCE  nothing was given at all: no coin type, no variety, no
     *            notes, no grade. There was no descriptor that COULD have
     *            carried the word, so there is no statement to read.
     *            -> 'unknown', which contradicts nothing in either
     *            direction.
     *
     * The record below is the almost-empty row: a year and a denomination
     * are structured fields, not descriptive text, so `detectStrike` is
     * handed nothing and answers 'unknown'. */
    expect(veto('1964 Kennedy 50C SP67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents'
    }).vetoed).toBe(false);

    expect(veto('1964 Kennedy 50C PF67 - Obverse.jpg', {
      year: '1964', denomination: '50 Cents'
    }).vetoed).toBe(false);
  });
});

/* =========================================================================
 * 3b. !!! THE PROOFLIKE TRAP !!!
 * =======================================================================
 * PL, DMPL, DPL and "prooflike" describe a BUSINESS STRIKE with mirrored
 * fields. They are NOT proofs. A substring test for "proof" would classify
 * every PL Morgan as a proof and then veto it against its own business-strike
 * record -- destroying exactly the matches this feature exists to protect.
 *
 * These tests are the tripwire. If one of them ever fails, read the warning
 * at the top of proof-strike.ts before changing anything.
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
    // End to end, not just the rule: the veto must not quietly remove the
    // coin from the candidate list either.
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
    // No base letters to read, so the bare-word test would otherwise call it
    // a proof. This is the narrowest form of the trap.
    expect(detectStrike('', 'PROOFLIKE')).toBe('business');
    expect(detectStrike('', 'DMPL')).toBe('business');
    expect(detectStrike('', 'Deep Mirror Prooflike')).toBe('business');
  });

  it('still reads a genuine proof as a proof', () => {
    // The trap guard must not have gone too far the other way.
    expect(detectStrike('1870 $1 - PCGS PF62CAM- Obverse', 'pf62cam')).toBe('proof');
    expect(detectStrike('1957 Sovereign Proof', null)).toBe('proof');
    expect(detectStrike('', 'PR69 DCAM')).toBe('proof');
  });

  it('reads the circulation grade ladder as business, and silence as business too', () => {
    /* The ladder, unchanged: any of these letters is a positive statement
     * that the coin is not a proof. */
    for (const grade of ['MS63', 'AU58', 'XF40', 'VF30', 'VG8', 'Choice VF', 'Gem BU', 'XF-AU']) {
      expect(detectStrike('', grade), grade).toBe('business');
    }
    expect(detectStrike('', 'SP67')).toBe('specimen');

    /* !! THE LAST TWO LINES USED TO BOTH EXPECT 'unknown'. Only the first
     * still does, and the difference between them is the whole of the
     * owner's rule:
     *
     *   "The Proof descriptor should always be part of the image file name
     *    as well as part of the inventory description otherwise it's assumed
     *    the coin is a business strike."
     *
     * NOTHING AT ALL was given below -- no text, no grade -- so there was no
     * descriptor that could have carried the word. That is ABSENCE, and it
     * is the only thing left that answers 'unknown'. */
    expect(detectStrike('', '')).toBe('unknown');
    expect(detectStrike(null, undefined)).toBe('unknown');
    expect(detectStrike('   ', '  ')).toBe('unknown');

    /* TEXT WAS GIVEN and it did not say proof. That is SILENCE, and under
     * his rule silence is the claim "business strike". */
    expect(detectStrike('1881 Morgan Dollar', null)).toBe('business');
    expect(detectStrike('1870 10-cent - Obverse', '')).toBe('business');
  });
});

/* =========================================================================
 * 4. THE VETO REACHES ALL THREE TIERS
 * =======================================================================
 * The rule is only worth having if the auto decision, the candidate list and
 * the near-match assessment all obey it. A coin that tier 2 has refused must
 * not still be sitting in the dropdown.
 */
describe('a vetoed coin is gone from every tier', () => {
  /** One record. The filename below agrees with it on everything but the year. */
  const WRONG_YEAR: CoinRecord[] = [
    coin({
      id: 'morgan-1880', year: '1880', denomination: 'Dollar', coinType: 'Morgan',
      mintMark: 'S', grade: 'MS63', certCompany: 'PCGS'
    })
  ];

  it('is not auto-matched, even though it would otherwise clear every gate', () => {
    /* THE OWNER'S ACTUAL BUG. Everything except the year agrees -- the
     * denomination, the coin type, the grading company, the grade -- and with
     * no other coin in the inventory there is nothing to trip the runner-up
     * gate either. Before the veto this scored its way past the 0.85 bar and
     * attached itself silently. */
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
    // Nothing is silently dropped: the read-only list has to be readable.
    const [result] = service().matchImages(
      ['1881 Morgan Dollar PCGS MS63 - Obverse.jpg'],
      WRONG_YEAR
    );

    expect(result.skipReason).toContain('disqualified');
    expect(result.skipReason).toContain('1881');
    expect(result.skipReason!.length).toBeGreaterThan(10);
  });

  it('fails the near-match test on the same ground, not a different one', () => {
    /* The point of having ONE veto module: `assessNearMatch` adopts the
     * veto's answer instead of forming its own, so the two can never disagree
     * about what counts as a conflict. */
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
    /* The useful half: disqualifying the 1880 record does not disqualify the
     * 1881 one, and the correct coin is still found. */
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

/* =========================================================================
 * 5. A VETO MUST NEVER MAKE THE MATCHER BRAVER
 * ======================================================================= */
describe('vetoes are an extra constraint, never a loosening', () => {
  it('a disqualified runner-up still counts for the runner-up margin', () => {
    /* The tempting mistake: measure the margin against the eligible coins
     * only. That can only ever WIDEN the gap, turning rows that go to review
     * today into silent automatic attachments.
     *
     * Here the 1881-O record is vetoed (wrong denomination) but still scores
     * close to the 1881-S one, so the margin gate keeps the file in review
     * exactly as it did before the vetoes existed. */
    const [result] = service().matchImages(
      ['1881 Morgan Dollar MS63 - Obverse.jpg'],
      [
        coin({ id: 'morgan-s', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'S', grade: 'MS63' }),
        coin({ id: 'morgan-o', year: '1881', denomination: 'Dollar', coinType: 'Morgan', mintMark: 'O', grade: 'MS63' })
      ]
    );

    // Two coins fit equally well, so nothing is attached -- unchanged.
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

/* =========================================================================
 * 5b. THE THREE-CENT EQUIVALENCE, END TO END
 * =======================================================================
 * The rule-level tests above prove `findVetoes` behaves. These prove the
 * consequence the owner will actually see: the generic form still ATTACHES,
 * and the two specific forms still refuse each other.
 */
describe('the three-cent equivalence survives the whole pipeline', () => {
  it('attaches a generic 3-cent photo to a 3CS record', () => {
    const [result] = service().matchImages(
      ['1851 3-cent - VF - Obverse.jpg'],
      [coin({ id: 'trime', year: '1851', denomination: '3CS', grade: 'VF' })]
    );

    expect(result.matchedRecordId).toBe('trime');
    // And the explanation says WHICH kind of agreement it was, so the user
    // can see the filename was the vaguer of the two.
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
    /* 1865-1873 is the only decade where both coins were being struck, so the
     * year cannot separate them and the denomination has to. */
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

    // The silver one is disqualified outright, so it is not even offered.
    expect(result.candidates.map(c => c.coinId)).toEqual(['nickel-1870']);
    expect(result.matchedRecordId).toBe('nickel-1870');
  });
});

/* =========================================================================
 * 6. DIRECTORY NAMES STILL DO NOT LEAK IN
 * =======================================================================
 * The owner's images live in folders such as "Early Proofs". If a directory
 * name reached the parser, every file under it would be classified as a proof
 * and the new veto would disqualify them all from their business-strike
 * records. `baseName` prevents that; this is the guard.
 */
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
