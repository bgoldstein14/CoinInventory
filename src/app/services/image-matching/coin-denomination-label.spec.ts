 /*
 * coin-denomination-label.spec.ts
 *
 * WHAT THIS FILE PROVES
 *   That the COIN side of the comparison now reads the denomination the
 *   coin's `denominationId` points at -- the authoritative Label -- instead
 *   of the free text the source happened to write, and that it does so
 *   WITHOUT changing anything else about the matcher.
 *
 * WHY, AND WHY IT IS THE SMALLEST CHANGE AVAILABLE
 *
 *   A coin carries both (design §4.1):
 *
 *       Coins.DenominationId   the canonical link. NULL is ordinary.
 *       Coins.Denomination     WHAT THE SOURCE SAID. Never rewritten.
 *
 *   They are allowed to disagree and after an import they usually do: the
 *   text keeps saying `Pillar Dollar` while the id says `8 Reales`. Reading
 *   the TEXT matches that coin against every photograph of a Dollar in the
 *   collection.
 *
 *   Design §6 names the fix and its limit together: resolve the coin's id to
 *   its label and feed the EXISTING string logic unchanged. Comparing ids on
 *   both sides would be better eventually; it is not this change.
 *
 *   So the label is substituted for the text at ONE point -- the input to the
 *   two denomination readers -- and every rule downstream of that point
 *   (`denominationsAgree`, `findVetoes`, `scorePair`, the three auto-assign
 *   gates, the thresholds) is untouched.
 *
 * THE ANTI-GOAL THIS FILE IS DEFENDING (design §2)
 *
 *     "The image matcher getting worse. It identifies coins partly by
 *      denomination; a regression there means photos attaching to the wrong
 *      coin, which is expensive to notice and painful to undo."
 *
 *   Across ~2,140 photographs a wrong attachment is silent. Every test below
 *   is therefore phrased as a thing the change must NOT do.
  */

import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import {
  buildCoinSignatures,
  denominationLabelSnapshot,
  parseCoin
} from './coin-signature';
import { parseFilename, toSignature } from './filename-parser';
import { findVetoes } from './match-vetoes';
import { denominationsAgree } from './reference-tables';

/**
 * One filename, parsed and reduced to the shape both sides are compared in.
 *
 * Through the REAL parser, never a hand-built attributes object: the whole
 * question here is what the coin side now says, and a fabricated file side
 * would let the coin side be wrong about a filename that cannot exist.
 */
function photo(fileName: string) {
  return toSignature(parseFilename(fileName));
}

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

/**
 * The lookup as the application holds it: a handful of real seed rows.
 *
 * Every label here is spelled exactly as `issuers-denominations.json` spells
 * it, because the whole point of the change is that the matcher reads THAT
 * string and not a tidied-up version of it.
 */
const LOOKUP = [
  { denominationId: 11, label: '8 Reales', isActive: true },   // Mexico / Spanish Colonial
  { denominationId: 22, label: '3CS', isActive: true },        // United States
  { denominationId: 33, label: '3CN', isActive: true },        // United States
  { denominationId: 44, label: '50¢', isActive: true },        // United States
  { denominationId: 55, label: '5/- (Crown)', isActive: true },// Great Britain
  { denominationId: 66, label: '25¢', isActive: false },       // soft-deleted, §4.4
  { denominationId: 77, label: '5¢', isActive: true }          // United States — see below
];

const LABELS = denominationLabelSnapshot(LOOKUP);

 /*
 * 1. THE LABEL IS WHAT THE COIN IS
  */
describe('the coin side is parsed from the LABEL, not from the source text', () => {
  it('stops a Spanish Colonial 8 Reales claiming to be a Dollar', () => {
    /* THE CASE THAT PROMPTED THE WHOLE DESIGN. A Misc. Coins account holds
     * "1753 Pillar Dollar (8 Reales)". The word "Dollar" is right there in
     * the text, `findDenomination` reads it, and the coin then scores and
     * VETOES against every $1 photograph in a collection that holds 35 of
     * them.
     *
     * `8 Reales` is not in the filename vocabulary -- that vocabulary knows
     * US and GB face values -- so the honest answer is "this coin states no
     * denomination the matcher understands", and the denomination attribute
     * drops out of the comparison entirely. That is the SAFE direction: it
     * removes a false claim rather than adding a new one. */
    const pillar = coin({ id: 'c1', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });

    expect(parseCoin(pillar).denomination).toBe('dollar');          // today, wrongly
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();      // after: no false claim
    expect(parseCoin(pillar, LABELS).denominationLabel).toBe('8 Reales');
  });

  it('reads the lookup row a Half Dime is actually linked to, generic and all', () => {
     /*
     * !! THE ONE PLACE THIS CHANGE CAN LOOSEN THE MATCHER, PINNED HERE SO
     * IT IS A DECISION AND NOT A DISCOVERY. !!
     *
     * `denomination-aliases.ts` folds 'half dime' and 'nickel' onto the key
     * '5c', and the United States seed holds exactly ONE five-cent row:
     * '5¢'. So a spreadsheet column reading `Half Dime` links to '5¢' --
     * correctly, that is the row -- and the matcher, which used to read the
     * SPECIFIC key 'half dime' out of the text, now reads the GENERIC key
     * 'five cent' out of the label.
     *
     * Generic agrees with both specifics (reference-tables.ts, shape B), so
     * the coin stops conflicting with a photograph that says "Nickel".
     *
     * THIS IS THE DESIGNED BEHAVIOUR, NOT A SIDE EFFECT. The equivalence
     * table says so itself, in the row's own `why`:
     *
     *   "'5¢' -- which is the only five-cent row the database seeds -- is
     *    compatible with either; a stated Half Dime and a stated Nickel are
     *    different coins and conflict."
     *
     * It is also the safe direction. The cost of a too-wide generic is a
     * photograph that needs a human glance; the cost of a wrong veto is a
     * correct coin silently removed from the list. Same reasoning as the
     * 'gold eagle' row in that file.
     *
     * The honest fix, if the specificity is ever wanted back, is to seed
     * 'Half Dime' and 'Nickel' as their own rows -- a DATA change, not a
     * matcher change. */
    const halfDime = coin({ id: 'c2', denomination: 'Half Dime', denominationId: 77, year: '1853' });
    expect(parseCoin(halfDime).denomination).toBe('half dime');           // the text's reading
    expect(parseCoin(halfDime, LABELS).denomination).toBe('five cent');   // the row it is linked to

    const nickelPhoto = photo('1853 Nickel - Obverse.jpg');
    expect(findVetoes(nickelPhoto, parseCoin(halfDime)).vetoed).toBe(true);          // was
    expect(findVetoes(nickelPhoto, parseCoin(halfDime, LABELS)).vetoed).toBe(false); // is
  });

  it('lets the label overrule a text that says a DIFFERENT coin', () => {
    /* The normal post-import state. A spreadsheet column read `Half Dollar`;
     * the id was resolved to the lookup row `50¢`. They agree here, but the
     * assertion is that the LABEL is what was read: swap the id for the 3CS
     * row and the answer changes, which it could not do if the text won. */
    const mislabelled = coin({ id: 'c3', denomination: 'Half Dollar', denominationId: 22, year: '1866' });
    expect(parseCoin(mislabelled).denomination).toBe('half dollar');
    expect(parseCoin(mislabelled, LABELS).denomination).toBe('three cent silver');
  });

  it('keeps the SOURCE TEXT as coin-type evidence, because the filenames echo it', () => {
    /* *** THE PART OF THE SOURCE TEXT THAT IS NOT A DENOMINATION IS STILL
     * EVIDENCE, AND IT IS THE EVIDENCE THE FILENAMES ACTUALLY CARRY. ***
     *
     * A photo is named "1753 Pillar Dollar (8 Reales) - Obverse.jpg". Nobody
     * types "8 Reales" on its own into a filename for a coin whose record
     * says Pillar Dollar. If the label REPLACED the text wholesale the words
     * 'pillar' and 'dollar' would vanish from the coin's token evidence and
     * the photograph would lose the only thing still tying it to the record.
     *
     * So the substitution is surgical: the label feeds the denomination
     * READERS, and the recorded text goes on feeding `tokens` exactly as it
     * always did. */
    const pillar = coin({ id: 'c4', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });
    expect(parseCoin(pillar, LABELS).tokens).toEqual(parseCoin(pillar).tokens);
    expect(parseCoin(pillar, LABELS).tokens).toContain('pillar');
  });
});

 /*
 * 2. WITH NOTHING TO RESOLVE, THE MATCHER IS BYTE-FOR-BYTE WHAT IT WAS
 *
 * THIS IS THE SAFETY NET FOR THE WHOLE CHANGE. Every coin that has not been
 * linked -- and NULL is the ordinary state, not an error (§4.1) -- must
 * produce the signature it produced yesterday. If that holds, the blast
 * radius is exactly "coins with a resolved id" and nothing else.
  */
describe('a coin with no label to resolve is parsed exactly as before', () => {
  const unchanged = (c: CoinRecord, labels: ReadonlyMap<number, string>) =>
    expect(parseCoin(c, labels)).toEqual(parseCoin(c));

  it('when the coin has no denominationId at all (every pre-011 row)', () => {
    unchanged(coin({ id: 'u1', denomination: '3CS', year: '1861', grade: 'PF65' }), LABELS);
  });

  it('when denominationId is explicitly null (§4.4 deleted the denomination)', () => {
    unchanged(coin({ id: 'u2', denomination: '20¢', denominationId: null, year: '1875' }), LABELS);
  });

  it('when the id names a row that has been soft-deleted', () => {
    /* §4.4 soft-deletes and nulls the coins' ids, so this should not occur --
     * but a retired row must never be spoken for. `denominationLabelSnapshot`
     * leaves inactive rows out, which lands the coin here. */
    unchanged(coin({ id: 'u3', denomination: 'Quarter', denominationId: 66, year: '1932' }), LABELS);
  });

  it('when the id names a row the lookup does not contain', () => {
    unchanged(coin({ id: 'u4', denomination: '5¢', denominationId: 9999, year: '1883' }), LABELS);
  });

   /*
   * !! THE TIMING HAZARD, AND THE ONE THAT WOULD HAVE BEEN INVISIBLE !!
   *
   * `BatchImageImportService.buildRows` matches in chunks of 200 filenames
   * and yields to the browser between them, so a lookup response landing
   * mid-import could have made photographs 1-200 match under one set of
   * rules and 201-400 under another -- the same folder, split across two
   * behaviours, with nothing anywhere saying so.
   *
   * The matcher therefore performs NO LOOKUP OF ITS OWN and reads no signal.
   * It is handed a finished snapshot, taken once, and is a pure function of
   * its arguments. A lookup that has not returned is an empty snapshot,
   * which is the pre-change matcher exactly -- never some third behaviour.
    */
  it('when the denominations lookup has not come back yet', () => {
    const empty = denominationLabelSnapshot([]);
    unchanged(coin({ id: 'u5', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' }), empty);
  });

  it('and an un-resolvable coin is identical whether a snapshot is passed or not', () => {
    const c = coin({ id: 'u6', denomination: '3CN', year: '1865', coinType: 'Three Cent Nickel' });
    expect(parseCoin(c, LABELS)).toEqual(parseCoin(c, undefined));
    expect(parseCoin(c, LABELS)).toEqual(parseCoin(c));
  });
});

 /*
 * 3. A LABEL MAY NOT MAKE A SILENT COIN START VETOING
  */
describe('a coin that recorded nothing goes on saying nothing', () => {
  it('ignores the label when Coins.Denomination is blank', () => {
    /* *** THE VETOES' GOVERNING RULE IS "ONLY A STATED DISAGREEMENT". ***
     * (match-vetoes.ts, under that heading.) Silence on either side is not a
     * conflict, and a veto does far more damage than a bad score: it removes
     * a coin from the candidate list entirely, so the user cannot even see
     * it to correct it.
     *
     * An id with NO TEXT is a state this application does not create. The
     * editor's write rule sets both fields; §4.4 nulls the id and leaves the
     * text; migration 014 resolves FROM the text and never writes it. So a
     * blank text beside a live id is unexplained data, and the pessimistic
     * reading is the right one: say nothing, exactly as before, and let the
     * other attributes decide.
     *
     * Costing the user a click is recoverable. Silently hiding the correct
     * coin is not. */
    const blank = coin({ id: 'b1', denomination: '', denominationId: 22, year: '1861' });
    expect(parseCoin(blank, LABELS).denomination).toBeNull();
    expect(parseCoin(blank, LABELS)).toEqual(parseCoin(blank));
  });

  it('treats whitespace-only text as blank too', () => {
    const blank = coin({ id: 'b2', denomination: '   ', denominationId: 22, year: '1861' });
    expect(parseCoin(blank, LABELS).denomination).toBeNull();
  });

  it('so a 3CN photograph is still merely unmatched, never vetoed', () => {
    const blank = coin({ id: 'b3', denomination: '', denominationId: 22, year: '1865' });
    const file = photo('1865 3CN - Obverse.jpg');
    expect(findVetoes(file, parseCoin(blank, LABELS)).vetoed).toBe(false);
  });
});

 /*
 * 4. A LABEL THE FILENAME VOCABULARY HAS NEVER SEEN
  */
describe('a label outside the filename vocabulary', () => {
  const pillar = coin({ id: 'f1', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });

  it('leaves the denomination attribute out of the comparison entirely', () => {
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();
  });

  it('vetoes nothing, whatever the photograph claims to be', () => {
    /* Both sides must SAY something for a veto. The coin now says `8 Reales`,
     * which the filename parser has no way to say at all, so there is no
     * disagreement to state -- the pair is decided on year, type and grade
     * like any pair where one side is quiet about a denomination.
     *
     * Note which direction the silence moves things. The 50¢ photograph was
     * vetoed before and is merely unsupported now: a veto LOST, not a veto
     * gained, which is the only direction this change is allowed to move
     * them in. */
    const halfPhoto = photo('1753 50¢ - Obverse.jpg');
    expect(findVetoes(halfPhoto, parseCoin(pillar)).vetoed).toBe(true);        // was
    expect(findVetoes(halfPhoto, parseCoin(pillar, LABELS)).vetoed).toBe(false); // is
  });

  it('and stops the coin AGREEING with a Dollar photograph it is not', () => {
    /* The damaging half, and the reason the change exists. The record's text
     * says "Pillar Dollar", so the coin side read 'dollar' and agreed, at
     * full weight and as a STRONG ATTRIBUTE, with every $1 photograph in a
     * collection that holds 35 of them. */
    const dollarPhoto = photo('1753 $1 - Obverse.jpg');
    expect(
      denominationsAgree(dollarPhoto.denomination!, parseCoin(pillar).denomination!)
    ).toBe(true);
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();
  });

  it('still shows the user the authoritative name', () => {
    // Display only -- the scorer never reads this -- but the explanation the
    // user is given must name the coin's real denomination.
    expect(parseCoin(pillar, LABELS).denominationLabel).toBe('8 Reales');
  });
});

 /*
 * 5. NOTHING DOWNSTREAM OF THE SUBSTITUTION MOVED
  */
describe('the agreement table and the vetoes are the ones that were there', () => {
  it('generic still agrees with specific, and two specifics still do not', () => {
    // Pinned here as well as in match-vetoes.spec.ts because this change is
    // the one most likely to be "tidied" into comparing labels directly.
    expect(denominationsAgree('three cent', 'three cent silver')).toBe(true);
    expect(denominationsAgree('three cent', 'three cent nickel')).toBe(true);
    expect(denominationsAgree('three cent silver', 'three cent nickel')).toBe(false);
  });

  it('a 3¢ photograph still agrees with a coin the LOOKUP calls 3CS', () => {
    const c = coin({ id: 'g1', denomination: 'Trime', denominationId: 22, year: '1861' });
    const file = photo('1861 3-cent - VF - Obverse.jpg');
    expect(findVetoes(file, parseCoin(c, LABELS)).vetoed).toBe(false);
  });

  it('a 3CN photograph is still vetoed against a 3CS record', () => {
    const c = coin({ id: 'g2', denomination: 'Trime', denominationId: 22, year: '1865' });
    const file = photo('1865 3CN - Obverse.jpg');
    const verdict = findVetoes(file, parseCoin(c, LABELS));
    expect(verdict.vetoed).toBe(true);
    expect(verdict.reasons.join('; ')).toContain('does not match');
  });
});

 /*
 * 6. THE SNAPSHOT, AND HOW IT REACHES THE BATCH
  */
describe('denominationLabelSnapshot', () => {
  it('maps active rows by id', () => {
    expect(LABELS.get(11)).toBe('8 Reales');
    expect(LABELS.get(55)).toBe('5/- (Crown)');
  });

  it('leaves soft-deleted rows out, so nothing speaks for a retired row', () => {
    expect(LABELS.has(66)).toBe(false);
  });

  it('is empty for an empty lookup, which is the honest answer', () => {
    expect(denominationLabelSnapshot([]).size).toBe(0);
  });
});

describe('the snapshot reaches every coin in the batch', () => {
  const inventory = [
    coin({ id: 's1', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' }),
    coin({ id: 's2', denomination: 'Trime', denominationId: 22, year: '1851' })
  ];

  it('buildCoinSignatures applies it to all of them', () => {
    const built = buildCoinSignatures(inventory, LABELS);
    expect(built.map(b => b.signature.denomination)).toEqual([null, 'three cent silver']);
  });

  it('and matchImages threads it through to the coin side', () => {
    /* End to end through the public entry point: without the snapshot the
     * Pillar Dollar record is a $1 candidate, with it the $1 photograph no
     * longer has a denomination to agree with. */
    const service = new ImageMatchingService();
    const photo = '1753 $1 - PCGS VF30 - Obverse.jpg';

    const before = service.matchImages([photo], inventory);
    const after = service.matchImages([photo], inventory, LABELS);

    expect(before[0].reason).toContain('Dollar');
    expect(after[0].reason).not.toContain('denomination Dollar ($1) matches');
  });
});
