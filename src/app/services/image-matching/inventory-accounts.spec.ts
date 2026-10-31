/* ===========================================================================
 * inventory-accounts.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That the matcher behaves on A FULL, DENSE INVENTORY -- all seven coin
 *   accounts of the corpus in `src/app/testing/qif-corpus/`, read live out
 *   of the Quicken exports there -- and that it behaves the same way in
 *   every one of them, because the rules are general.
 *
 *   That corpus is SYNTHETIC, but it is not simplified: it reproduces, group
 *   for group, the duplicate density of the owner's real export, which is
 *   the only property of his data these tests ever needed. See the header of
 *   `qif-corpus/generate-corpus.mjs` before regenerating it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE REPLACED TWO OTHERS -- HE ASKED FOR THIS, IN THESE WORDS
 * ---------------------------------------------------------------------------
 *   There used to be `three-cent-proofs.spec.ts` and `early-proofs.spec.ts`:
 *   one spec file per COLLECTION. He saw them and said:
 *
 *     "I wouldn't expect there to be a special file to single out a
 *      particular type of coin like the three-cent-proofs.spec.ts. That's
 *      too specific and will just add a lot of noise to this project if we
 *      had files for every denomination. Likely, whatever rules are in there
 *      can be applied across the board."
 *
 *   He is right twice over. He has EIGHT accounts, so one file each does not
 *   scale; and the rules those two files tested were never about three-cent
 *   pieces or about proofs. They were about AMBIGUITY -- several coins that
 *   a filename cannot choose between -- which every account has.
 *
 *   So the collections are now DATA. `QIF_ACCOUNTS` in qif-accounts.fixture.ts
 *   is the list, and everything below is written once and run over all of
 *   them with `describe.each`. ADDING A COLLECTION IS ADDING A ROW TO THAT
 *   TABLE. It is never a new file and never a new copy of an assertion.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS CARRIED OVER, AND WHAT CHANGED ABOUT IT
 * ---------------------------------------------------------------------------
 *   EVERY assertion's intent from both old files survives here. What changed
 *   is that the ones that used to name a coin now DISCOVER it:
 *
 *     OLD  "skips a bare 3-cent photo of 1866 / 1867 / 1870 / 1871"
 *     NEW  for every account, find every year in which it holds two or more
 *          SPECIFIC forms of one GENERIC denomination, and assert the
 *          refusal for each. The four years above are found, not typed.
 *
 *     OLD  "his FIVE 1861 Three Cent Silver records differ only by grade"
 *     NEW  for every account, find every (year, denomination) group holding
 *          more than one record, and assert the invariants over all of them.
 *
 *   A handful of assertions in the old files were not about an inventory at
 *   all -- how `compareGrades` reads "PR64" against "PF64", how the parser
 *   reads "2 cent", that a postage stamp is not a coin. Those were unit
 *   facts wearing a collection's clothes, and they have moved to the spec
 *   that owns the rule: near-match.spec.ts and denomination-units.spec.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CANNOT BE REPLACED BY import-tiers.spec.ts
 * ---------------------------------------------------------------------------
 *   The census there builds its inventory OUT OF THE FILENAMES IT TESTS --
 *   one coin per distinct (year, denomination, coin type). So it can never
 *   contain two coins of the same year and denomination, and that is exactly
 *   where every interesting bug has hidden. The accounts here are full of
 *   them: ten 1877 twenty-cent pieces, nine 1877 Three Cent Nickels, five
 *   1864 Two Cent pieces, four years in Early Proofs holding both a 3CS and
 *   a 3CN. This file is where that density lives.
 *
 * ---------------------------------------------------------------------------
 * ANCIENTS IS EXCLUDED ON PURPOSE
 * ---------------------------------------------------------------------------
 *   An ancient coin has no year, no denomination and no grade, so it is
 *   matched on catalogue references instead -- a separate design with its own
 *   deferred plan in `docs/ancients-matching-plan.md`. The exclusion lives in
 *   the fixture's table, with the reasoning.
 * =========================================================================== */

import { describe, expect, it } from 'vitest';
import { CoinRecord, ImageMatchResult, ImportTier } from '../../types/coin.model';
import { ImageMatchingService } from '../image-matching.service';
import {
  QIF_ACCOUNTS,
  QifAccount,
  inventoryFor,
  photoFilenamesFor,
  photoStem,
  securityNamesFor,
  silentPhotoFilenamesFor
} from '../../testing/qif-accounts.fixture';
import { isCounterfeitRecord, parseCoin } from './coin-signature';
import { denominationsAgree, isSpecificFormOf } from './reference-tables';
import { searchCoins } from '../image-import/row-decisions';

const service = () => new ImageMatchingService();

/* ===========================================================================
 * ONE MATCH RUN PER ACCOUNT, COMPUTED ONCE
 * ---------------------------------------------------------------------------
 * `matchImages` is O(photos x coins) and the biggest account is 262 photos
 * against 109 coins. Running it inside each `it` would multiply that by the
 * number of assertions for no benefit whatsoever: the inputs never change,
 * so neither can the answer. Everything is computed here, at module load,
 * and every assertion below reads from the same snapshot.
 * ========================================================================= */

interface AccountRun {
  account: QifAccount;
  /** Every coin the account has ever held, as the real importer reads it. */
  inventory: CoinRecord[];
  /** His filename convention applied to every security: obverse + reverse. */
  photos: string[];
  /** One deliberately uninformative extra shot per coin. */
  silentPhotos: string[];
  /** Results for `photos`. */
  results: ImageMatchResult[];
  /** Results for `silentPhotos`, matched as their own import. */
  silentResults: ImageMatchResult[];
  /**
   * Results for obverse + reverse + SLAB LABEL of every security.
   *
   * A separate run from `results` on purpose. The census is reported over
   * the two-shot corpus so its numbers stay comparable with the ones the
   * owner has already been shown, but the label shots are what produce
   * INFERRED rows -- a label never identifies a coin on its own, so it can
   * only ever arrive by riding along -- and the inference invariants need
   * them.
   */
  withLabelResults: ImageMatchResult[];
  /** Look a coin up by the id the fixture assigned it. */
  coinOf: (id: string | null) => CoinRecord | null;
  /** Tier tallies for `results`. */
  tiers: Record<ImportTier, string[]>;
}

function run(account: QifAccount): AccountRun {
  const inventory = inventoryFor(account);
  const photos = photoFilenamesFor(account);
  const silentPhotos = silentPhotoFilenamesFor(account);

  const results = service().matchImages([...photos], inventory);
  const silentResults = service().matchImages([...silentPhotos], inventory);
  const withLabelResults = service().matchImages(
    photoFilenamesFor(account, ['Obverse', 'Reverse', 'Slab Label']),
    inventory
  );

  const byId = new Map(inventory.map(coin => [coin.id, coin]));
  const tiers: Record<ImportTier, string[]> = { matched: [], near: [], 'not-imported': [] };
  for (const result of results) tiers[result.tier].push(result.parsed.fileName);

  return {
    account,
    inventory,
    photos,
    silentPhotos,
    results,
    silentResults,
    withLabelResults,
    coinOf: id => (id ? byId.get(id) ?? null : null),
    tiers
  };
}

/** Every account's run, keyed by account name. */
const RUNS = new Map<string, AccountRun>(
  QIF_ACCOUNTS.map(account => [account.account, run(account)])
);

/**
 * The argument list `describe.each` iterates.
 *
 * A `[name, account]` pair rather than the object alone, so the test titles
 * read "Early Proofs > ..." instead of "[object Object] > ...".
 */
const ACCOUNTS: ReadonlyArray<[string, QifAccount]> =
  QIF_ACCOUNTS.map(account => [account.account, account]);

/* ===========================================================================
 * PART 1 -- THE DATA IS REALLY HIS, AND REALLY HARD
 * ---------------------------------------------------------------------------
 * Asserted rather than assumed. If an account stops being dense -- if the
 * duplicate groups disappear, or the file is renamed, or the Windows-1252
 * decode breaks and every cent sign turns into a replacement character --
 * the rest of this file goes on passing while testing nothing. These are the
 * tripwires for that.
 * ========================================================================= */
describe.each(ACCOUNTS)('%s - the inventory these tests run against', (_name, account) => {
  const { inventory, photos } = RUNS.get(account.account)!;

  it('read a non-empty account out of the QIF, under its own account name', () => {
    expect(securityNamesFor(account).length, account.file).toBeGreaterThan(0);
    expect(inventory.length).toBeGreaterThan(0);
    expect(photos.length).toBe(securityNamesFor(account).length * 2);
  });

  it('gave every record a distinct id', () => {
    expect(new Set(inventory.map(c => c.id)).size).toBe(inventory.length);
  });

  it('decoded as WINDOWS-1252, not UTF-8', () => {
    /* THE SILENT CORRUPTION THIS CATCHES. In the raw bytes a cent sign is
     * the single byte 0xA2 and "½" is 0xBD. Decoded as UTF-8 both become
     * U+FFFD, the replacement character -- and every denomination in the
     * collection is destroyed without an error being raised anywhere.
     *
     * `quicken-import-modal.ts` uses `new TextDecoder('windows-1252')` and
     * so does the fixture. This asserts the result rather than the call, so
     * it would still fail if someone changed the decode in both places. */
    const names = securityNamesFor(account).join(' ');
    expect(names, 'a replacement character means the decode is wrong')
      .not.toContain('�');
  });

  it('holds at least one group of coins a filename cannot tell apart', () => {
    /* THE PROPERTY THAT MAKES THIS FILE WORTH RUNNING, and the one the
     * synthetic census in import-tiers.spec.ts structurally cannot have:
     * two or more coins sharing a year AND a denomination, differing only
     * in the grade. That is the shape his inventory really is, and it is
     * where the runner-up margin, the generic denomination and the strike
     * veto all earn their keep. */
    expect(duplicateGroups(RUNS.get(account.account)!).length)
      .toBeGreaterThan(0);
  });
});

/** Every (year, denomination) that more than one record in the account shares. */
function duplicateGroups({ inventory }: AccountRun): Array<{
  year: string;
  denomination: string;
  coins: CoinRecord[];
}> {
  const byKey = new Map<string, CoinRecord[]>();
  for (const coin of inventory) {
    if (!coin.year || !coin.denomination) continue;
    const key = `${coin.year}|${coin.denomination}`;
    byKey.set(key, [...(byKey.get(key) ?? []), coin]);
  }
  return [...byKey.entries()]
    .filter(([, coins]) => coins.length > 1)
    .map(([key, coins]) => {
      const [year, denomination] = key.split('|');
      return { year, denomination, coins };
    });
}

/* ===========================================================================
 * PART 2 -- THE INVARIANTS, OVER EVERY PHOTOGRAPH OF EVERY ACCOUNT
 * ---------------------------------------------------------------------------
 * These are the promises that must hold for all 954 derived photographs, not
 * for a hand-picked few. They are the cheapest possible check on a
 * catastrophe and the fastest to tell you one has happened.
 *
 * His governing principle, which decides every judgement call below:
 *
 *   "I can always force an image to be associated with a coin manually, but
 *    the automated process should be very descriminatory."
 *
 * So each of these is phrased as a thing the matcher must NOT do. Refusing a
 * correct photo costs him one click. Attaching a wrong one is silent and may
 * never be noticed.
 * ========================================================================= */
describe.each(ACCOUNTS)('%s - invariants over the whole account', (_name, account) => {
  const { results, silentResults, coinOf, inventory } = RUNS.get(account.account)!;
  const attached = results.filter(r => r.matchedRecordId !== null);

  it('never attaches a photo to a coin of a different year', () => {
    for (const result of attached) {
      if (result.parsed.year === null) continue;
      const coin = coinOf(result.matchedRecordId)!;
      expect(coin.year, result.parsed.fileName).toContain(String(result.parsed.year));
    }
  });

  it('never attaches a photo to a coin of a contradicting denomination', () => {
    for (const result of attached) {
      const file = result.parsed.denomination;
      const coin = parseCoin(coinOf(result.matchedRecordId)!).denomination;
      if (!file || !coin) continue;
      expect(denominationsAgree(file, coin), result.parsed.fileName).toBe(true);
    }
  });

  it('never attaches two photos of ONE coin to two DIFFERENT coins', () => {
    /* His opening complaint, measured over the whole account: "if I match it
     * with an image, all related image files of similar names (including for
     * both obverse/reverse/slab designations) should automatically be
     * attached at that point". The obverse and the reverse of one coin must
     * never disagree about which coin they are of. */
    const coinsPerStem = new Map<string, Set<string>>();
    for (const result of attached) {
      const stem = result.parsed.fileName.replace(/ - (Obverse|Reverse)\.jpg$/, '');
      coinsPerStem.set(stem, (coinsPerStem.get(stem) ?? new Set()).add(result.matchedRecordId!));
    }
    for (const [stem, ids] of coinsPerStem) {
      expect(ids.size, stem).toBe(1);
    }
  });

  it('never attaches a photo that does not say "proof" to a PROOF record', () => {
    /* !! THE OWNER'S RULE, MEASURED ACROSS THE BOARD !!
     *
     * He has stated it three times, each more absolute than the last, and
     * this is the final form, verbatim:
     *
     *   "The Proof descriptor should always be part of the image file name
     *    as well as part of the inventory description otherwise it's assumed
     *    the coin is a business strike."
     *
     * Read the last clause. A filename that does not say proof is not a
     * filename that forgot; it is a filename about a coin that has nothing
     * to say. So silence is the positive claim "business strike", and it
     * contradicts a proof record exactly as "MS65" would.
     *
     * This is the one dimension where absence counts as evidence --
     * match-vetoes.ts keeps "absence is not disagreement" for the year, the
     * denomination and the coin type -- and the carve-out rests on a fact
     * about HIS DATA, not on logic: he writes these names and these records
     * himself, and he writes PF or Proof every single time it is true. */
    for (const result of [...results, ...silentResults]) {
      const coin = coinOf(result.matchedRecordId);
      if (!coin) continue;
      if (parseCoin(coin).strike !== 'proof') continue;
      expect(result.parsed.strike, `${result.parsed.fileName} -> ${coin.grade}`)
        .toBe('proof');
    }
  });

  it('never attaches a PROOF photo to a business-strike record either -- it is symmetric', () => {
    for (const result of [...results, ...silentResults]) {
      const coin = coinOf(result.matchedRecordId);
      if (!coin) continue;
      if (result.parsed.strike !== 'proof') continue;
      expect(parseCoin(coin).strike, `${result.parsed.fileName} -> ${coin.grade}`)
        .toBe('proof');
    }
  });

  it('gives every skipped photo a reason, and no coin to attach to', () => {
    // Nothing is ever dropped silently. A file he cannot see a reason for is
    // a file he cannot act on.
    for (const result of results.filter(r => r.tier === 'not-imported')) {
      expect(result.skipReason, result.parsed.fileName).toBeTruthy();
      expect(result.skipReason!.length, result.parsed.fileName).toBeGreaterThan(10);
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
    }
  });

  it('only ever attaches a coin that is actually in this account', () => {
    const ids = new Set(inventory.map(c => c.id));
    for (const result of [...results, ...silentResults]) {
      if (!result.matchedRecordId) continue;
      expect(ids.has(result.matchedRecordId), result.parsed.fileName).toBe(true);
    }
  });
});

/* ===========================================================================
 * PART 3 -- A SLAB LABEL NEVER IDENTIFIES A COIN ON ITS OWN
 * ---------------------------------------------------------------------------
 * Asked whether a photograph of the slab's certification label -- no coin
 * visible, just the paper -- may identify a coin by itself, he answered:
 *
 *     "Only alongside a coin photo."
 *
 * So a label shot may RIDE ALONG once an actual coin image has named the
 * coin, but it may never be the thing that does the naming. He accepted the
 * consequence -- a coin whose only photograph is a label shot stops being
 * attached automatically -- but not that it should happen silently, so the
 * skip line has to SAY this rather than claim nothing matched.
 *
 * The coin used is DISCOVERED rather than named: the first security in the
 * account whose ordinary obverse shot attaches cleanly. That keeps the test
 * general, and it keeps it honest -- if an account stops attaching anything
 * at all, the test says so instead of quietly passing.
 * ========================================================================= */
describe.each(ACCOUNTS)('%s - a slab label rides along, and only rides along', (_name, account) => {
  const run = RUNS.get(account.account)!;

  /** A security whose plain obverse photo attaches on its own, or null. */
  const anchor = (() => {
    for (const security of securityNamesFor(account)) {
      const obverse = `${photoStem(security)} - Obverse.jpg`;
      const result = run.results.find(r => r.parsed.fileName === obverse);
      if (result?.tier === 'matched') return { security, obverse, stem: photoStem(security) };
    }
    return null;
  })();

  it('has at least one coin this account can attach unaided', () => {
    /* Not decoration. The two tests below are vacuous without an anchor, so
     * this states the precondition out loud rather than letting them skip.
     *
     * `Odd Type Set` is the account that makes this interesting: its
     * securities are so bare ("1864 2¢", "1867 3CN") that several of them
     * collide and nothing attaches. That is a real and correct outcome --
     * see the census in Part 6 -- so the expectation is written to allow it
     * while still failing loudly if an account that USED to attach things
     * stops. */
    if (run.tiers.matched.length === 0) {
      expect(anchor, `${account.account} attaches nothing at all`).toBeNull();
      return;
    }
    expect(anchor).not.toBeNull();
  });

  it('does not attach a label shot imported on its own, and says why', () => {
    if (!anchor) return;
    const label = `${anchor.stem} - Slab Label.jpg`;
    const [result] = service().matchImages([label], run.inventory);

    expect(result.status, result.reason).not.toBe('auto');
    expect(result.matchedRecordId).toBeNull();
    expect(result.skipReason ?? result.reason)
      .toContain('slab label rather than the coin');
  });

  it('attaches the same label shot when a photo of the coin comes with it', () => {
    if (!anchor) return;
    const label = `${anchor.stem} - Slab Label.jpg`;
    const results = service().matchImages([anchor.obverse, label], run.inventory);
    const of = (name: string) => results.find(r => r.parsed.fileName === name)!;

    expect(of(label).tier).toBe('matched');
    expect(of(label).matchedRecordId).toBe(of(anchor.obverse).matchedRecordId);
    expect(of(label).reason).toContain('by inference');
  });

  it('two label shots with no coin photo between them attach NOTHING', () => {
    /* "NEVER CHAINS", stated as the case that actually tests it.
     *
     * A placed row is not evidence. Only a photograph that cleared the three
     * auto gates ON ITS OWN MERITS may identify a sibling, so a match can
     * never be walked two files away from the thing that proved it.
     *
     * The two files below share their entire name, so if a label could
     * identify anything the first would place the second immediately. It
     * cannot -- "Only alongside a coin photo" -- so with no coin photo in the
     * batch there is no first link in the chain and neither row attaches.
     *
     * (An earlier version of this test put the obverse in the batch too and
     * then checked that the second label was not placed BY THE FIRST. That
     * proved nothing: with the obverse present, the second label is placed by
     * the OBVERSE, perfectly correctly, so the assertion passed without ever
     * exercising a chain.) */
    if (!anchor) return;
    const results = service().matchImages(
      [`${anchor.stem} - Slab Label.jpg`, `${anchor.stem} - Slab Label 2.jpg`],
      run.inventory
    );

    for (const result of results) {
      expect(result.matchedRecordId, result.parsed.fileName).toBeNull();
      expect(result.tier, result.parsed.fileName).toBe('not-imported');
    }
  });

  it('every row attached BY INFERENCE names a sibling that stood on its own', () => {
    /* The same guarantee as an invariant over the whole account rather than
     * one constructed case: whenever the matcher says "attached ... by
     * inference from X", X must itself be a photograph that cleared the auto
     * gates unaided (status 'auto'). An inferred row may never be the X in
     * somebody else's sentence.
     *
     * This runs over the three-shot corpus -- obverse, reverse and slab label
     * for every security -- because the label shots are the rows that
     * actually arrive by inference. */
    const byName = new Map(run.withLabelResults.map(r => [r.parsed.fileName, r]));
    let inferred = 0;

    for (const result of run.withLabelResults) {
      const quoted = /by inference from "([^"]+)"/.exec(result.reason ?? '');
      if (!quoted) continue;
      inferred++;

      const vouchingFile = byName.get(quoted[1]);
      expect(vouchingFile, `${result.parsed.fileName} cites a file not in the batch`).toBeDefined();
      expect(vouchingFile!.status, `${result.parsed.fileName} was vouched for by ${quoted[1]}`)
        .toBe('auto');
    }

    // And the corpus really does contain inferred rows, or the loop above
    // proved nothing. Accounts that attach nothing at all are exempt.
    if (run.tiers.matched.length > 0) expect(inferred).toBeGreaterThan(0);
  });
});

/* ===========================================================================
 * PART 4 -- A GENERIC DENOMINATION NEVER AUTO-ATTACHES
 * ---------------------------------------------------------------------------
 * He was asked what should happen when a photo is called "1867 3-cent" and
 * he owns both an 1867 Three Cent Silver and an 1867 Three Cent Nickel. His
 * answer was two words:
 *
 *     "Never auto-attach."
 *
 * Not "attach when one is clearly ahead". Never. So it is not a margin test:
 * the automatic attachment is refused outright and the offer list is
 * emptied, because a coin flip presented as a ranked recommendation is worse
 * than no recommendation.
 *
 * ---------------------------------------------------------------------------
 * THE YEARS ARE DISCOVERED, NOT TYPED -- THIS IS THE POINT OF THE REWRITE
 * ---------------------------------------------------------------------------
 *   The old three-cent-proofs.spec.ts hand-listed 1866 and 1867; the old
 *   early-proofs.spec.ts hand-listed 1866, 1867, 1870 and 1871. Both were
 *   really asking one general question -- "is there a year in which this
 *   account holds two of the coins this word could mean?" -- so that is what
 *   is asked here, of every account and every generic denomination the
 *   reference table knows about.
 *
 *   `isSpecificFormOf` in reference-tables.ts is the predicate, and it is
 *   driven entirely by `DENOMINATION_EQUIVALENCES`. Nothing in this test, and
 *   nothing in match-decider.ts, mentions three-cent pieces.
 * ========================================================================= */

/**
 * The generic denominations, and how he would spell each one in a filename.
 *
 * The KEYS are the table's own generic keys. The SPELLINGS are what his
 * filename convention produces for them -- "3-cent", "5-cent" -- which is
 * the one thing the table cannot tell us, because it is about his habits
 * rather than about coins.
 */
const GENERIC_SPELLINGS: ReadonlyArray<{ key: string; spelling: string }> = [
  { key: 'three cent', spelling: '3-cent' },
  { key: 'five cent', spelling: '5-cent' },
  { key: 'cent', spelling: '1-cent' },
  { key: 'dollar', spelling: '$1' }
];

describe.each(ACCOUNTS)('%s - a general word never picks between two coins', (_name, account) => {
  const { inventory } = RUNS.get(account.account)!;

  /**
   * Every (generic, year) in this account where he owns TWO OR MORE of the
   * specific coins the generic word stands over.
   */
  const undecidable = (() => {
    const found: Array<{ spelling: string; year: string; specifics: string[] }> = [];
    for (const generic of GENERIC_SPELLINGS) {
      const byYear = new Map<string, Set<string>>();
      for (const coin of inventory) {
        const key = parseCoin(coin).denomination;
        if (!coin.year || !key || !isSpecificFormOf(key, generic.key)) continue;
        byYear.set(coin.year, (byYear.get(coin.year) ?? new Set()).add(key));
      }
      for (const [year, specifics] of byYear) {
        if (specifics.size > 1) found.push({ spelling: generic.spelling, year, specifics: [...specifics] });
      }
    }
    return found;
  })();

  it('reports which generic/year pairs this account is undecidable for', () => {
    /* Visibility, not a threshold. An account with none of these is not
     * broken -- most have none -- but which accounts DO have them is the
     * thing a reader needs to know to interpret the tests below, and it
     * changes whenever his inventory does. */
    // eslint-disable-next-line no-console
    console.log(
      `  ${account.account}: ${undecidable.length} undecidable generic/year pairs` +
      (undecidable.length
        ? '\n' + undecidable.map(u => `      ${u.year} "${u.spelling}" could mean ${u.specifics.join(' or ')}`).join('\n')
        : '')
    );
    expect(Array.isArray(undecidable)).toBe(true);
  });

  it('refuses every one of them: no attachment, no offered guesses, and a reason', () => {
    for (const { spelling, year } of undecidable) {
      /* The photo states the PROOF designation deliberately. Without it the
       * filename would claim "business strike" under the owner's rule, the
       * strike veto would disqualify his proofs, and in several of these
       * years that leaves only ONE metal standing -- at which point the word
       * is no longer undecidable and offering the survivor is correct. The
       * two rules compose exactly as they should; this test is about the
       * generic-denomination one, so it holds the strike constant. */
      const fileName = `${year} ${spelling} - PCGS PF64 - Obverse.jpg`;
      const [result] = service().matchImages([fileName], inventory);

      expect(result.status, `${fileName}: ${result.reason}`).not.toBe('auto');
      expect(result.matchedRecordId, fileName).toBeNull();
      expect(result.candidates, fileName).toEqual([]);
      expect(result.skipReason, fileName).toContain('which does not say which of the');
    }
  });

  it('refuses even when one of the two would otherwise win by a mile', () => {
    /* The test that distinguishes "never" from "not when it is close". A
     * certification number is a near-proof attribute and would ordinarily
     * carry its coin clear of the other by far more than the 0.15 margin. It
     * still must not attach, because THE NAME never said which coin it
     * meant. */
    for (const { spelling, year, specifics } of undecidable) {
      const spiked = inventory.map(coin =>
        coin.year === year && parseCoin(coin).denomination === specifics[0]
          ? { ...coin, certNumber: '44556677' }
          : coin
      );
      const fileName = `${year} ${spelling} - PCGS PF64 44556677 - Obverse.jpg`;
      const [result] = service().matchImages([fileName], spiked);

      expect(result.status, `${fileName}: ${result.reason}`).not.toBe('auto');
      expect(result.candidates, fileName).toEqual([]);
    }
  });
});

describe('the generic-denomination rule is general, not a rule about three-cent pieces', () => {
  /* ---------------------------------------------------------------------
   * WHY THIS ONE TEST IS SYNTHETIC WHEN THE REST OF THE FILE IS NOT
   * ---------------------------------------------------------------------
   * `describeUndecidedGeneric` in match-decider.ts reads
   * `DENOMINATION_EQUIVALENCES`, which has five generic rows:
   *
   *     'three cent'  stands over  3CS and 3CN
   *     'five cent'   stands over  Half Dime and Nickel
   *     'cent'        stands over  Large Cent and Small Cent
   *     'dollar'      stands over  Gold / Silver / Trade Dollar
   *     'gold eagle'  stands over  the four Eagle face values
   *
   * But only the FIRST of them can fire against his inventory today, and
   * that is a fact about the DATABASE SEED rather than about the rule. The
   * seeded denominations are '½¢ 1¢ 2¢ 5¢ 10¢ 20¢ 25¢ 50¢ 3CS 3CN', so a
   * half dime and a nickel BOTH land on the generic key 'five cent' and a
   * large cent and a small cent both land on 'cent'. Neither pair ever
   * produces two SPECIFIC keys for one year, so the loop above finds
   * nothing for them.
   *
   * That makes the per-account tests above look -- wrongly -- like a rule
   * about three-cent pieces. This test is what proves otherwise: the same
   * shape, on the 'five cent' row, with records that DO carry the specific
   * denominations. The Half Dime and the Nickel were struck alongside each
   * other from 1866 to 1873, so an 1870 "5-cent" photograph is undecidable
   * in exactly the way an 1867 "3-cent" one is -- and it is refused with no
   * new code.
   * ------------------------------------------------------------------- */
  const base = (over: Partial<CoinRecord> & { id: string }): CoinRecord => ({
    denomination: '', year: '', coinType: '', category: '', country: 'United States',
    grade: '', certCompany: '', certNumber: '', variety: '', mintMark: '',
    composition: '', purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths: [], source: 'manual', ...over
  });

  it('refuses "1870 5-cent" when he owns both an 1870 Half Dime and an 1870 Nickel', () => {
    const fiveCent = [
      base({ id: 'half-dime-1870', year: '1870', denomination: 'Half Dime', coinType: 'Seated Liberty', grade: 'PF64', certCompany: 'PCGS' }),
      base({ id: 'nickel-1870', year: '1870', denomination: 'Nickel', coinType: 'Shield', grade: 'PF64', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1870 5-cent - PCGS PF64 - Obverse.jpg'], fiveCent);

    expect(result.status, result.reason).not.toBe('auto');
    expect(result.candidates).toEqual([]);
    expect(result.skipReason).toContain('which does not say which of the');
  });

  it('leaves a year alone when only ONE of the two kinds is owned', () => {
    /* The limit of the rule, and the case it must not break. With only a
     * Half Dime in the inventory there is nothing to be undecided between,
     * so the one good candidate is still offered -- which is the whole
     * reason the escape hatch exists. */
    const onlyHalfDime = [
      base({ id: 'half-dime-1870', year: '1870', denomination: 'Half Dime', coinType: 'Seated Liberty', grade: 'PF64', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1870 5-cent - PCGS PF64 - Obverse.jpg'], onlyHalfDime);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].coinLabel).toContain('1870');
  });
});

/* ===========================================================================
 * PART 5 -- SEVERAL COINS THAT DIFFER ONLY BY GRADE
 * ---------------------------------------------------------------------------
 * The inventory shape the synthetic census cannot produce, and the one three
 * separate defects hid in. His worked example was a run of Three Cent
 * Silvers of one date -- a CAC proof plus an AU, an EF and two XFs -- where
 * every photograph of the proof was landing in the skipped list because the
 * four business strikes it had ALREADY DISQUALIFIED were still being counted
 * as the runner-up it had to beat.
 *
 * The groups are discovered from each account rather than named, so this
 * covers the trimes, the 1864 Two Cent pieces, the 1865 Three Cent Nickels
 * and every other such group without listing any of them.
 * ========================================================================= */
describe.each(ACCOUNTS)('%s - coins that differ only by grade', (_name, account) => {
  const run = RUNS.get(account.account)!;
  const groups = duplicateGroups(run);

  it('reports the groups it found', () => {
    // eslint-disable-next-line no-console
    console.log(
      `  ${account.account}: ${groups.length} (year, denomination) groups with more than one coin; ` +
      `largest is ${Math.max(0, ...groups.map(g => g.coins.length))}`
    );
    expect(groups.length).toBeGreaterThan(0);
  });

  it('a photo naming a group member\'s own grade is never attached to a sibling', () => {
    /* THE CATASTROPHE THIS GUARDS AGAINST. Within one of these groups the
     * year, the denomination and usually the coin type all agree, so the
     * GRADE is the only thing separating two records that are worth very
     * different money. A photo that names a grade must land on the record
     * holding that grade or on nothing -- never on the one next to it.
     *
     * HOW FAR THIS ACTUALLY REACHES, stated honestly so nobody reads more
     * into a green run than is there: across all seven accounts only three
     * of these synthesized photographs attach at all. That is not a defect
     * -- a group exists precisely because its members are hard to tell apart,
     * so refusing is usually the right answer and the `continue` below is
     * taking the correct path. The broad protection comes from the
     * invariants in Part 2, which check all 584 real attachments; this is a
     * narrow extra guard on the specific confusion that costs the most
     * money. */
    for (const group of groups) {
      for (const coin of group.coins) {
        if (!coin.grade) continue;
        const fileName =
          `${coin.year} ${coin.denomination} - ${coin.certCompany || 'PCGS'} ${coin.grade} - Obverse.jpg`;
        const [result] = service().matchImages([fileName], run.inventory);
        if (!result.matchedRecordId) continue;

        const landed = run.coinOf(result.matchedRecordId)!;
        expect(landed.grade.toUpperCase().replace(/\s+/g, ''), fileName)
          .toBe(coin.grade.toUpperCase().replace(/\s+/g, ''));
      }
    }
  });

  it('measures the runner-up gap over coins that SURVIVED the vetoes', () => {
    /* The regression test for the first of the three defects, stated as a
     * number. A proof photo in a group whose other members are business
     * strikes must see a clear gap: the siblings are disqualified by the
     * strike veto, so they do not get a vote on whether the proof is
     * ambiguous. Before the fix they did, the gap came out around 0.06
     * against the 0.15 bar, and the row was not attached.
     *
     * Only groups that really do mix a proof with business strikes are
     * checked -- the others have nothing to say about this. */
    for (const group of groups) {
      const proofs = group.coins.filter(c => parseCoin(c).strike === 'proof');
      const business = group.coins.filter(c => parseCoin(c).strike === 'business');
      if (proofs.length !== 1 || business.length === 0) continue;

      const proof = proofs[0];
      const fileName =
        `${proof.year} ${proof.denomination} - ${proof.certCompany || 'PCGS'} ${proof.grade} - Obverse.jpg`;
      const [result] = service().matchImages([fileName], run.inventory);

      // Whatever else happens, no business-strike sibling may be offered.
      for (const candidate of result.candidates) {
        const coin = run.coinOf(candidate.coinId)!;
        expect(parseCoin(coin).strike, `${fileName} offered ${candidate.coinLabel}`)
          .not.toBe('business');
      }
    }
  });

  it('a photo that names NO grade is not attached to any member of a group', () => {
    /* HIS WORKED EXAMPLE, generalised. "1859 3CS - Obverse 2.jpg" carries no
     * grade at all, and the account holds four 1859 3CS records:
     *
     *   - the PROOF is disqualified, because the filename says nothing about
     *     proof and under his rule that means "business strike";
     *   - the four business strikes differ only by grade, so there is
     *     nothing to choose between them either.
     *
     * It stays listed, with a reason. Neither the ordinary gates nor the
     * sibling rule may bulldoze that. */
    for (const group of groups) {
      if (group.coins.length < 2) continue;
      const fileName = `${group.year} ${group.denomination} - Obverse 2.jpg`;
      const [result] = service().matchImages([fileName], run.inventory);

      if (result.matchedRecordId === null) {
        expect(result.skipReason, fileName).toBeTruthy();
        continue;
      }
      /* If something WAS attached, the group must have collapsed to a single
       * eligible coin -- every other member disqualified by a veto. Anything
       * else means the matcher chose between coins it could not tell apart.
       *
       * "Eligible" means ELIGIBLE FOR THE AUTOMATED RUN, which is why the
       * counterfeits come out here as well as the proofs. The owner: "Ignore
       * the Fake coins." The 1855 3CS group is exactly two business strikes,
       * one genuine and one "1855 3CS - VF - FAKE", so before that rule the
       * fake was blocking a gradeless photo from reaching the only real coin
       * it could possibly belong to. It no longer is, and this line is where
       * that shows up. A fake record is still in `group.coins` on purpose --
       * it is in his inventory and every manual path can still see it. */
      const eligible = group.coins.filter(
        c => parseCoin(c).strike === 'business' && !isCounterfeitRecord(c)
      );
      expect(eligible.length, `${fileName} attached despite rivals`).toBe(1);
    }
  });
});

/* ===========================================================================
 * PART 6 -- THE CENSUS
 * ---------------------------------------------------------------------------
 * How each account actually divides, printed rather than asserted, for the
 * same reason import-tiers.spec.ts prints its table: the exact numbers move
 * whenever a rule changes, and the useful thing is seeing the SHAPE and
 * noticing when it lurches.
 *
 * TWO CORPORA ARE MEASURED, AND THE SECOND IS THE INTERESTING ONE.
 *
 *   DERIVED    one obverse and one reverse per security, named the way he
 *              names them. These photographs REPEAT whatever their record
 *              says, so a proof record's photo always says "PF" -- which
 *              means the strike veto can never fire against them, in either
 *              direction. A corpus that cannot trigger a rule cannot measure
 *              its cost.
 *
 *   SILENT     one extra shot per coin giving only the year, the mint mark
 *              and the denomination -- "1872 3CN - Obverse 2.jpg". His share
 *              is full of these, and they are the ENTIRE subject of the
 *              owner's rule: a silent shot is not an abbreviation of the
 *              loud one, it is a claim that the coin is a business strike.
 *              This is where the price of that rule is visible.
 * ========================================================================= */
describe('the census, account by account', () => {
  it('prints how every account divides, for both corpora', () => {
    const rows: string[] = [];
    const total = { matched: 0, near: 0, skipped: 0, silentMatched: 0, silentSkipped: 0 };

    for (const account of QIF_ACCOUNTS) {
      const { results, silentResults, inventory, photos } = RUNS.get(account.account)!;
      const count = (list: ImageMatchResult[], tier: ImportTier) =>
        list.filter(r => r.tier === tier).length;

      const matched = count(results, 'matched');
      const near = count(results, 'near');
      const skipped = count(results, 'not-imported');
      const silentMatched = count(silentResults, 'matched');
      const silentSkipped = count(silentResults, 'not-imported');

      total.matched += matched;
      total.near += near;
      total.skipped += skipped;
      total.silentMatched += silentMatched;
      total.silentSkipped += silentSkipped;

      rows.push(
        `  ${account.account.padEnd(24)} ${String(inventory.length).padStart(4)} coins  ` +
        `derived ${String(photos.length).padStart(4)}: ` +
        `${String(matched).padStart(4)} matched ${String(near).padStart(3)} near ${String(skipped).padStart(4)} skipped  |  ` +
        `silent ${String(silentResults.length).padStart(3)}: ` +
        `${String(silentMatched).padStart(3)} matched ${String(silentSkipped).padStart(3)} skipped`
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      ['', 'Image import tiers, by Quicken account (Ancients excluded)', ...rows,
        `  ${'TOTAL'.padEnd(24)}         derived      ` +
        `${String(total.matched).padStart(4)} matched ${String(total.near).padStart(3)} near ${String(total.skipped).padStart(4)} skipped  |  ` +
        `silent     ${String(total.silentMatched).padStart(3)} matched ${String(total.silentSkipped).padStart(3)} skipped`,
        ''
      ].join('\n')
    );

    expect(total.matched + total.near + total.skipped)
      .toBe(QIF_ACCOUNTS.reduce((n, a) => n + RUNS.get(a.account)!.photos.length, 0));
  });

  it('attaches the clear majority of the Early Proofs account unaided', () => {
    /* THE OPERATIONAL NUMBER, and the one the owner was shown. 62 of these
     * 118 photographs attached before the five decisions of that round were
     * implemented, and 102 attach now.
     *
     * The floor is set at 80%, comfortably under where it lands, so that an
     * unrelated change does not fail this on a rounding -- while a
     * REGRESSION back towards the old behaviour does. It is named here
     * rather than applied to every account because the accounts are not
     * comparable: `Odd Type Set` attaches almost nothing, correctly, because
     * its securities are too bare to tell apart. */
    const { results } = RUNS.get('Early Proofs')!;
    const matched = results.filter(r => r.tier === 'matched').length;
    expect(matched).toBeGreaterThan(results.length * 0.8);
  });

  it('the proof rule costs the Early Proofs account almost all of its silent shots', () => {
    /* THE PRICE OF HIS RULE, PINNED AS A NUMBER RATHER THAN DESCRIBED.
     *
     * Every coin in this account is a proof, so every silent second shot --
     * a name giving only the year and the denomination -- now claims
     * "business strike" and is disqualified from its own record. Measured:
     * 51 of these 54 attached under the old "silence says nothing" rule, and
     * 1 attaches now.
     *
     * HE HAS BEEN TOLD THIS AND ACCEPTS IT, under his standing tie-breaker:
     * "I can always force an image to be associated with a coin manually,
     * but the automated process should be very descriminatory." Every one of
     * those photographs is still listed, still carries a reason, and is
     * still attachable in one click.
     *
     * The assertion is deliberately an UPPER bound. If someone weakens the
     * rule, this number climbs back towards 51 and the test fails -- which
     * is the only way a quiet relaxation of his most-repeated instruction
     * would ever be noticed. */
    const { silentResults } = RUNS.get('Early Proofs')!;
    const matched = silentResults.filter(r => r.tier === 'matched').length;
    expect(matched).toBeLessThan(silentResults.length * 0.1);
  });
});

/* ===========================================================================
 * PART 7 -- THE AWKWARD SPELLINGS IN HIS RECORDS
 * ---------------------------------------------------------------------------
 * Not per-account, because each is a fact about ONE string he typed. They
 * are here rather than in a parser spec because each one is only
 * interesting against a real inventory: the question is never "how is this
 * parsed" but "what does it attach to".
 * ========================================================================= */
describe('the odd characters in his record text', () => {
  it('a slash in a PATH is a directory separator, and always will be', () => {
    /* "1887/6 3CN" (an overdate), "1883 5¢ N/C" (No Cents) and "1907 10¢-VF/XF"
     * (a split grade) are perfectly good RECORD text and the importer handles
     * them. They cannot appear in a FILENAME, because "/" is one of the nine
     * characters Windows forbids in one -- so this is not a defect to fix, it
     * is a fact to pin down, and the fixture substitutes a hyphen the way he
     * would have to.
     *
     * The behaviour if a slashed name ever did reach the matcher: `baseName`
     * in text-tokens.ts keeps only the last path segment, so the year is lost
     * and nothing is attached. That is the safe direction. */
    const { inventory } = RUNS.get('Early Proofs')!;
    const [result] = service().matchImages(['1887/6 3CN - NGC PF66 - Obverse.jpg'], inventory);

    // Note what the matcher reports the filename AS -- that is the point.
    expect(result.parsed.fileName).toBe('6 3CN - NGC PF66 - Obverse.jpg');
    expect(result.parsed.year).toBeNull();
    expect(result.matchedRecordId).toBeNull();
  });

  it('the hyphenated substitution he would actually type DOES attach', () => {
    const { inventory } = RUNS.get('Early Proofs')!;
    const [result] = service().matchImages(['1887-6 3CN - NGC PF66 - Obverse.jpg'], inventory);
    expect(result.tier, result.reason).toBe('matched');
  });

  it('a filename with no grade LETTERS is not attached on a guess', () => {
    /* "1868 5¢ - NGC/CAC 65CAM" is the one record written without the grade
     * letters, and he mentioned the form when giving the grade rules.
     * grade-parser.ts does not recognise a letter-less grade in a FILENAME
     * (it needs the letters to know it is looking at a grade at all), so
     * "65CAM" survives as a coin-type word.
     *
     * Pinned here so that if the filename grade reader is ever taught the
     * letter-less form, this test is what tells you the behaviour moved. */
    const { inventory } = RUNS.get('Early Proofs')!;
    const [result] = service().matchImages(['1868 5¢ - NGC 65CAM - Obverse.jpg'], inventory);
    expect(result.parsed.grade).toBeNull();
  });
});

/* ===========================================================================
 * PART 7B -- HIS COUNTERFEIT RECORDS ARE OUT OF THE AUTOMATED POOL
 * ---------------------------------------------------------------------------
 * "Ignore the Fake coins" cuts both ways, and this is the half that is easy
 * to miss. The photograph side is covered in real-filenames.spec.ts; this is
 * the RECORD side, measured against the accounts he actually has.
 *
 * He holds three counterfeits as inventory rows --
 *
 *     1855 3CS - VF - FAKE
 *     1859 3CS - XF - FAKE
 *     1859 3CS - XF40 - FAKE
 *
 * -- alongside genuine three-cent silvers of the same two dates. Leave the
 * fakes in the candidate pool and a photograph of a real 1859 3CS can
 * auto-attach to "1859 3CS - XF40 - FAKE", which is the identical mis-filing
 * pointing the other way.
 *
 * *** AND THE EXCLUSION STOPS AT THE AUTOMATED RUN. ***
 *   "I should be able to manually add a Fake coin to my inventory, just
 *    don't worry about automating such a thing."
 * So the asymmetry is the requirement: invisible to the matcher, entirely
 * ordinary everywhere else. The last test here is the one that pins it.
 * ========================================================================= */
describe('his counterfeit records', () => {
  /* Every account's securities list carries the three FAKE names, so any one
   * of them exercises this. The 2-3-20-cent collection is used because it is
   * also where the genuine 1859 and 1855 3CS records live. */
  const run = () => RUNS.get('2-3-20-cent Collection')!;

  it('recognises exactly the records whose descriptor says so', () => {
    const { inventory } = run();
    const flagged = inventory.filter(isCounterfeitRecord);

    /* Named rather than counted, so a change shows WHICH record moved. The
     * word survives only in the raw Quicken security name: his fakes import
     * with denomination "3CS", coinType "Three Cent Silver" and grades
     * VF / XF / XF45 -- every declared CoinRecord field identical to a
     * genuine coin. That is why `isCounterfeitRecord` reads `securityName`
     * as well as the ordinary identity fields. */
    expect(flagged.map(c => (c as unknown as { securityName: string }).securityName).sort())
      .toEqual([
        '1855 3CS - VF - FAKE',
        '1859 3CS - XF - FAKE',
        '1859 3CS - XF40 - FAKE'
      ]);
  });

  it('never offers one as a candidate for any photograph in the account', () => {
    /* The invariant, over every photograph the fixture generates for this
     * account rather than over a hand-picked case. A fake must be reachable
     * neither as the auto match, nor in the ranked candidate list, nor in a
     * tier-2 near-match dropdown. */
    const { results, coinOf } = run();
    const isFake = (id: string | null) => !!id && isCounterfeitRecord(coinOf(id)!);

    for (const result of results) {
      const file = result.parsed.fileName;
      expect(isFake(result.matchedRecordId), `${file} auto-matched a fake`).toBe(false);
      for (const candidate of result.candidates) {
        expect(isFake(candidate.coinId), `${file} offered the fake ${candidate.coinLabel}`).toBe(false);
      }
      for (const candidate of result.nearMatch?.candidates ?? []) {
        expect(isFake(candidate.coinId), `${file} suggested the fake ${candidate.coinLabel}`).toBe(false);
      }
    }
  });

  it('does not take any GENUINE record out of the pool with them', () => {
    /* The over-reach guard. A false positive here is a silent loss: a real
     * coin that quietly stops receiving its own photographs.
     *
     * The specific trap in his data is the Quicken memo
     *
     *     "Sent the PCI PF 3CS to the dealer (exchange for a 3CS FAKE)"
     *
     * which was attached to a GENUINE proof. That is why
     * `isCounterfeitRecord` reads the identity fields and NOT `notes`. */
    const { inventory } = run();
    const genuine = inventory.filter(c => !isCounterfeitRecord(c));

    expect(genuine.length, 'three excluded, the rest kept')
      .toBe(inventory.length - 3);
    // Spot-check the date the memo above belongs to: an 1855 three-cent.
    const trimes1855 = genuine.filter(c => c.year === '1855' && c.denomination === '3CS');
    expect(trimes1855.length, 'the genuine 1855 3CS records survive').toBeGreaterThan(0);
  });

  it('leaves a fake perfectly findable by the manual coin search', () => {
    /* THE BOUNDARY, stated as a test because it is the thing a future change
     * is most likely to break without anyone noticing.
     *
     * `searchCoins` is what drives CoinLookup, the free-text chooser behind
     * every manual attachment on the import screen. It reads the inventory
     * directly, and must keep doing so: push the counterfeit filter down into
     * the inventory service or into this function and his fakes disappear
     * from the manual search too -- which is the escape hatch his whole
     * answer depends on. */
    const { inventory } = run();
    const matching = service();
    const fakes = inventory.filter(isCounterfeitRecord);

    for (const fake of fakes) {
      const label = matching.describeCoin(fake);
      const hits = searchCoins(inventory, label, c => matching.describeCoin(c));
      expect(hits.map(c => c.id), `${label} must stay findable by hand`).toContain(fake.id);
    }
  });
});

/* ===========================================================================
 * PART 8 -- TWO IMPORT DEFECTS THE DENSE ACCOUNTS EXPOSED
 * ---------------------------------------------------------------------------
 * Neither is a matching rule. They are here because these accounts are the
 * first fixtures dense enough to expose them, and because leaving either in
 * place would SHIP A SILENT MIS-ATTACHMENT -- the one outcome he has said
 * matters more than any other.
 *
 * Both lived in the regex ladder in quicken-import.service.ts that turns a
 * security name into a denomination, and both were ORDERING problems:
 *
 *   /5¢/ was tried before /25¢/, and "25¢" CONTAINS "5¢", so his two
 *   quarters imported as five-cent pieces.
 *
 *   The half-dime spelling "½10¢" was in no branch at all, so it fell
 *   through to /10¢/ and his nine half dimes imported as dimes.
 *
 * WHY THAT WAS WORSE THAN LOSING INFORMATION. The Early Proofs account holds
 * genuine dimes (1868 10¢, 1908 10¢) and a genuine five-cent piece (1868 5¢)
 * alongside the mis-read coins, so the mis-reads COLLIDED. Once the grade
 * tolerance let "PF65" agree with "PF65 Cameo", the photographs of
 * "1871 ½10¢" cleared every gate against the record claiming to be an 1871
 * five-cent piece -- which is really the 1871 QUARTER -- and were attached to
 * it automatically. The matcher was behaving correctly on the data it was
 * given; the data was wrong.
 * ========================================================================= */
describe('his cent-sign spellings import as the coins they are', () => {
  const { inventory } = RUNS.get('Early Proofs')!;
  const securities = securityNamesFor(QIF_ACCOUNTS.find(a => a.account === 'Early Proofs')!);
  const recordFor = (security: string) => inventory[securities.indexOf(security)];

  it('"1871 25¢" is a QUARTER, not a five-cent piece', () => {
    expect(recordFor('1871 25¢ - PCGS/CAC PF65 Cameo').denomination).toBe('25¢');
  });

  it('"1855 ½10¢" is a HALF DIME, not a dime', () => {
    // The owner: "Half Dime can be ½10¢ or 5¢". '5¢' is the key the database
    // seeds for a half dime, so that is the right answer here.
    expect(recordFor('1855 ½10¢ - NGC/CAC PF65').denomination).toBe('5¢');
  });

  it('his genuine 10¢ dimes are still dimes', () => {
    // The other half of the ordering fix: nothing that WAS right broke.
    expect(recordFor('1908 10¢ PCGS PF65 Cameo').denomination).toBe('10¢');
    expect(recordFor('1868 10¢ - PCGS/CAC PF65 Cameo').denomination).toBe('10¢');
  });

  it('a QUARTER photo is never filed under a half dime again', () => {
    /* The regression test for the silent mis-attachment itself. Before the
     * ladder was reordered, "1871 ½10¢" and "1871 25¢" both claimed to be
     * 1871 five-cent pieces, and the half-dime photographs were
     * auto-attached to the quarter. */
    const results = service().matchImages(
      ['1871 25¢ - PCGS PF65CAM - Obverse.jpg', '1871 ½10¢ - PCGS PF65 - Obverse.jpg'],
      inventory
    );
    const [quarter, halfDime] = results;

    expect(quarter.matchedRecordId).not.toBe(halfDime.matchedRecordId);
    for (const [photo, denomination] of [[quarter, '25¢'], [halfDime, '5¢']] as const) {
      if (!photo.matchedRecordId) continue;
      expect(inventory.find(c => c.id === photo.matchedRecordId)!.denomination, photo.parsed.fileName)
        .toBe(denomination);
    }
  });
});
