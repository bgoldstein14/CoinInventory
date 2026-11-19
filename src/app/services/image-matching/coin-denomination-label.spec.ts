 /*
 * The coin side reads its denomination from the lookup label its
 * `denominationId` points at, not the free source text (Coins.Denomination),
 * which may disagree ("Pillar Dollar" vs "8 Reales"). The label only feeds the
 * denomination readers; everything downstream is unchanged.
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

/** One filename, through the real parser, as a comparable signature. */
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

/** Real seed rows, spelled exactly as in `issuers-denominations.json`. */
const LOOKUP = [
  { denominationId: 11, label: '8 Reales', isActive: true },   // Mexico / Spanish Colonial
  { denominationId: 22, label: '3CS', isActive: true },        // United States
  { denominationId: 33, label: '3CN', isActive: true },        // United States
  { denominationId: 44, label: '50¢', isActive: true },        // United States
  { denominationId: 55, label: '5/- (Crown)', isActive: true },// Great Britain
  { denominationId: 66, label: '25¢', isActive: false },       // soft-deleted, §4.4
  { denominationId: 77, label: '5¢', isActive: true }          // United States
];

const LABELS = denominationLabelSnapshot(LOOKUP);

describe('the coin side is parsed from the LABEL, not from the source text', () => {
  it('stops a Spanish Colonial 8 Reales claiming to be a Dollar', () => {
    // "8 Reales" is outside the filename vocabulary, so the denomination
    // drops out of the comparison instead of falsely reading 'dollar'.
    const pillar = coin({ id: 'c1', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });

    expect(parseCoin(pillar).denomination).toBe('dollar');          // today, wrongly
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();      // after: no false claim
    expect(parseCoin(pillar, LABELS).denominationLabel).toBe('8 Reales');
  });

  it('reads the lookup row a Half Dime is actually linked to, generic and all', () => {
     /*
     * The seed has a single five-cent row ('5¢'), so a "Half Dime" coin links
     * to it and reads the generic 'five cent', which agrees with a "Nickel"
     * photo. Intended: a too-wide match costs a review, a wrong veto hides the
     * coin. Seeding separate Half Dime / Nickel rows would restore specificity.
     */
    const halfDime = coin({ id: 'c2', denomination: 'Half Dime', denominationId: 77, year: '1853' });
    expect(parseCoin(halfDime).denomination).toBe('half dime');           // the text's reading
    expect(parseCoin(halfDime, LABELS).denomination).toBe('five cent');   // the row it is linked to

    const nickelPhoto = photo('1853 Nickel - Obverse.jpg');
    expect(findVetoes(nickelPhoto, parseCoin(halfDime)).vetoed).toBe(true);          // was
    expect(findVetoes(nickelPhoto, parseCoin(halfDime, LABELS)).vetoed).toBe(false); // is
  });

  it('lets the label overrule a text that says a DIFFERENT coin', () => {
    // The id points at the 3CS row, so the label wins over "Half Dollar".
    const mislabelled = coin({ id: 'c3', denomination: 'Half Dollar', denominationId: 22, year: '1866' });
    expect(parseCoin(mislabelled).denomination).toBe('half dollar');
    expect(parseCoin(mislabelled, LABELS).denomination).toBe('three cent silver');
  });

  it('keeps the SOURCE TEXT as coin-type evidence, because the filenames echo it', () => {
    // Filenames echo the source text ("Pillar Dollar"), so it still feeds
    // `tokens`; only the denomination readers use the label.
    const pillar = coin({ id: 'c4', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });
    expect(parseCoin(pillar, LABELS).tokens).toEqual(parseCoin(pillar).tokens);
    expect(parseCoin(pillar, LABELS).tokens).toContain('pillar');
  });
});

// A coin without a resolvable id (the ordinary state) parses as if no
// snapshot were given.
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
    // Inactive rows are left out of the snapshot.
    unchanged(coin({ id: 'u3', denomination: 'Quarter', denominationId: 66, year: '1932' }), LABELS);
  });

  it('when the id names a row the lookup does not contain', () => {
    unchanged(coin({ id: 'u4', denomination: '5¢', denominationId: 9999, year: '1883' }), LABELS);
  });

  // The matcher takes a snapshot once per batch rather than reading the
  // lookup itself, so a response arriving mid-import (rows are matched in
  // chunks) can't split one folder across two behaviours. Not loaded yet =
  // empty snapshot.
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

describe('a coin that recorded nothing goes on saying nothing', () => {
  it('ignores the label when Coins.Denomination is blank', () => {
    // An id with blank text is not a state the app creates; treat it as
    // silent so the label can't introduce a veto.
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

describe('a label outside the filename vocabulary', () => {
  const pillar = coin({ id: 'f1', denomination: 'Pillar Dollar', denominationId: 11, year: '1753' });

  it('leaves the denomination attribute out of the comparison entirely', () => {
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();
  });

  it('vetoes nothing, whatever the photograph claims to be', () => {
    // A veto needs both sides to state a denomination; this one can only
    // lose vetoes, never gain them.
    const halfPhoto = photo('1753 50¢ - Obverse.jpg');
    expect(findVetoes(halfPhoto, parseCoin(pillar)).vetoed).toBe(true);        // was
    expect(findVetoes(halfPhoto, parseCoin(pillar, LABELS)).vetoed).toBe(false); // is
  });

  it('and stops the coin AGREEING with a Dollar photograph it is not', () => {
    // Reading the text, the coin agreed with every $1 photograph.
    const dollarPhoto = photo('1753 $1 - Obverse.jpg');
    expect(
      denominationsAgree(dollarPhoto.denomination!, parseCoin(pillar).denomination!)
    ).toBe(true);
    expect(parseCoin(pillar, LABELS).denomination).toBeNull();
  });

  it('still shows the user the authoritative name', () => {
    // Display only; the scorer never reads this.
    expect(parseCoin(pillar, LABELS).denominationLabel).toBe('8 Reales');
  });
});

describe('the agreement table and the vetoes are the ones that were there', () => {
  it('generic still agrees with specific, and two specifics still do not', () => {
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
    // End to end: with the snapshot, the $1 photo no longer agrees on
    // denomination with the Pillar Dollar record.
    const service = new ImageMatchingService();
    const photo = '1753 $1 - PCGS VF30 - Obverse.jpg';

    const before = service.matchImages([photo], inventory);
    const after = service.matchImages([photo], inventory, LABELS);

    expect(before[0].reason).toContain('Dollar');
    expect(after[0].reason).not.toContain('denomination Dollar ($1) matches');
  });
});
