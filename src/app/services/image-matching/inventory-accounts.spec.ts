/*
 * Matcher tests over full, dense inventories: every coin account in the
 * synthetic Quicken corpus (`src/app/testing/qif-corpus/`, which reproduces
 * the real export's duplicate density; see generate-corpus.mjs before
 * regenerating). Each suite runs over all accounts via `describe.each`; to
 * add a collection, add a row to `QIF_ACCOUNTS` in qif-accounts.fixture.ts.
 * Assertions discover the interesting coins rather than naming them.
 *
 * Unlike import-tiers.spec.ts, whose inventory is built from its own
 * filenames, these accounts hold many coins of the same year and
 * denomination, which is where ambiguity bugs show up. Ancients are excluded
 * (see the fixture and docs/ancients-matching-plan.md).
 */

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

// Each account is matched once at module load; every test reads that snapshot.

interface AccountRun {
  account: QifAccount;
  /** Every coin the account has ever held, as the real importer reads it. */
  inventory: CoinRecord[];
  /** The filename convention applied to every security: obverse + reverse. */
  photos: string[];
  /** One deliberately uninformative extra shot per coin. */
  silentPhotos: string[];
  /** Results for `photos`. */
  results: ImageMatchResult[];
  /** Results for `silentPhotos`, matched as their own import. */
  silentResults: ImageMatchResult[];
  /**
   * Results for obverse + reverse + slab label. Separate from `results` so
   * the census stays two-shot; label shots are what produce inferred rows.
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

/** `[name, account]` pairs for `describe.each`, so titles show the account name. */
const ACCOUNTS: ReadonlyArray<[string, QifAccount]> =
  QIF_ACCOUNTS.map(account => [account.account, account]);

// Part 1: sanity checks that the fixture data loaded and is still dense;
// otherwise the rest of the file would pass while testing nothing.
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
    // "¢" (0xA2) and "½" (0xBD) become U+FFFD if decoded as UTF-8.
    // quicken-import-modal.ts and the fixture both decode as windows-1252.
    const names = securityNamesFor(account).join(' ');
    expect(names, 'a replacement character means the decode is wrong')
      .not.toContain('�');
  });

  it('holds at least one group of coins a filename cannot tell apart', () => {
    // Two or more coins sharing year and denomination: what this file tests.
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

// Part 2: invariants over every derived photo of every account, each phrased
// as something the matcher must never do.
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
    // Obverse and reverse of one security must land on the same coin.
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
    // A filename silent about the strike means business strike (see match-vetoes.ts).
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

/*
 * Part 3: a slab-label shot only rides along with a coin photo; on its own it
 * is not attached and the skip line says why. The anchor coin is the first
 * security whose plain obverse attaches.
 */
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
    // Precondition for the tests below. `Odd Type Set` legitimately attaches
    // nothing (its names are too bare to tell apart), so that case is allowed.
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
    // Inference never chains: only a row matched on its own may vouch for a
    // sibling. Keep the obverse out of this batch, or it would place both
    // labels directly and the chain case would not be exercised.
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
    // Over the three-shot corpus: every "by inference from X" must cite an X
    // that is itself a genuine 'auto' match.
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

    // Ensure the loop checked something (except for accounts attaching nothing).
    if (run.tiers.matched.length > 0) expect(inferred).toBeGreaterThan(0);
  });
});

/*
 * Part 4: a generic denomination ("1867 3-cent") never auto-attaches and
 * offers nothing when the account holds two or more of its specific forms
 * that year, whatever the scores. Those years are discovered per account via
 * `isSpecificFormOf`.
 */

/** Generic denomination keys and how the filename convention spells them. */
const GENERIC_SPELLINGS: ReadonlyArray<{ key: string; spelling: string }> = [
  { key: 'three cent', spelling: '3-cent' },
  { key: 'five cent', spelling: '5-cent' },
  { key: 'cent', spelling: '1-cent' },
  { key: 'dollar', spelling: '$1' }
];

describe.each(ACCOUNTS)('%s - a general word never picks between two coins', (_name, account) => {
  const { inventory } = RUNS.get(account.account)!;

  /**
   * Every (generic, year) in this account holding TWO OR MORE of the
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
    // Informational only; most accounts have none.
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
      // PF is stated so the strike veto does not remove the proofs and leave
      // only one metal, which would make the word decidable.
      const fileName = `${year} ${spelling} - PCGS PF64 - Obverse.jpg`;
      const [result] = service().matchImages([fileName], inventory);

      expect(result.status, `${fileName}: ${result.reason}`).not.toBe('auto');
      expect(result.matchedRecordId, fileName).toBeNull();
      expect(result.candidates, fileName).toEqual([]);
      expect(result.skipReason, fileName).toContain('which does not say which of the');
    }
  });

  it('refuses even when one of the two would otherwise win by a mile', () => {
    // A matching cert number would normally win by far more than the margin;
    // it must still not attach.
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
  // Synthetic records, because the database seed stores half dimes and
  // nickels both as '5¢' (likewise large/small cents as '1¢'), so only the
  // three-cent case can arise in the accounts. Half dimes and nickels were
  // both struck 1866-1873.
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
    // Only one kind owned, so nothing is ambiguous and it is still offered.
    const onlyHalfDime = [
      base({ id: 'half-dime-1870', year: '1870', denomination: 'Half Dime', coinType: 'Seated Liberty', grade: 'PF64', certCompany: 'PCGS' })
    ];
    const [result] = service().matchImages(['1870 5-cent - PCGS PF64 - Obverse.jpg'], onlyHalfDime);

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].coinLabel).toContain('1870');
  });
});

// Part 5: groups of coins sharing year and denomination, differing only by
// grade (discovered per account).
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
    // Within a group only the grade separates records, so a photo naming a
    // grade must land on that grade's record or nothing. Few of these photos
    // attach at all (refusing is usually right); Part 2 is the broad check.
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
    // Groups mixing one proof with business strikes: the vetoed business
    // strikes must not count as runner-up, nor be offered.
    for (const group of groups) {
      const proofs = group.coins.filter(c => parseCoin(c).strike === 'proof');
      const business = group.coins.filter(c => parseCoin(c).strike === 'business');
      if (proofs.length !== 1 || business.length === 0) continue;

      const proof = proofs[0];
      const fileName =
        `${proof.year} ${proof.denomination} - ${proof.certCompany || 'PCGS'} ${proof.grade} - Obverse.jpg`;
      const [result] = service().matchImages([fileName], run.inventory);

      for (const candidate of result.candidates) {
        const coin = run.coinOf(candidate.coinId)!;
        expect(parseCoin(coin).strike, `${fileName} offered ${candidate.coinLabel}`)
          .not.toBe('business');
      }
    }
  });

  it('a photo that names NO grade is not attached to any member of a group', () => {
    // E.g. "1859 3CS - Obverse 2.jpg": the proof is vetoed (silent = business)
    // and the business strikes differ only by grade, so nothing attaches.
    for (const group of groups) {
      if (group.coins.length < 2) continue;
      const fileName = `${group.year} ${group.denomination} - Obverse 2.jpg`;
      const [result] = service().matchImages([fileName], run.inventory);

      if (result.matchedRecordId === null) {
        expect(result.skipReason, fileName).toBeTruthy();
        continue;
      }
      // If attached, every other member must have been vetoed (proofs by the
      // strike veto, fakes by the authenticity veto), leaving one eligible coin.
      const eligible = group.coins.filter(
        c => parseCoin(c).strike === 'business' && !isCounterfeitRecord(c)
      );
      expect(eligible.length, `${fileName} attached despite rivals`).toBe(1);
    }
  });
});

/*
 * Part 6: census per account, printed rather than asserted.
 *   derived  obverse + reverse per security, repeating the record's text
 *            (so the strike veto never fires).
 *   silent   one extra shot per coin with only year, mint mark and
 *            denomination ("1872 3CN - Obverse 2.jpg"); shows the cost of
 *            treating silence as "business strike".
 */
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
    // 80% floor, comfortably under the actual figure. Only this account is
    // checked; others (e.g. Odd Type Set) legitimately attach far less.
    const { results } = RUNS.get('Early Proofs')!;
    const matched = results.filter(r => r.tier === 'matched').length;
    expect(matched).toBeGreaterThan(results.length * 0.8);
  });

  it('the proof rule costs the Early Proofs account almost all of its silent shots', () => {
    // Every coin here is a proof, so silent shots read as business strikes
    // and are vetoed. Upper bound: weakening the rule would make this climb.
    const { silentResults } = RUNS.get('Early Proofs')!;
    const matched = silentResults.filter(r => r.tier === 'matched').length;
    expect(matched).toBeLessThan(silentResults.length * 0.1);
  });
});

// Part 7: awkward spellings in the records, checked against a real inventory.
describe('the odd characters in his record text', () => {
  it('a slash in a PATH is a directory separator, and always will be', () => {
    // Record text like "1887/6 3CN" is fine, but "/" cannot appear in a
    // Windows filename (the fixture uses "-"). If it did, `baseName` keeps
    // only the last segment, the year is lost and nothing attaches.
    const { inventory } = RUNS.get('Early Proofs')!;
    const [result] = service().matchImages(['1887/6 3CN - NGC PF66 - Obverse.jpg'], inventory);

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
    // The filename grade reader needs grade letters, so "65CAM" is not read
    // as a grade (record "1868 5¢ - NGC/CAC 65CAM").
    const { inventory } = RUNS.get('Early Proofs')!;
    const [result] = service().matchImages(['1868 5¢ - NGC 65CAM - Obverse.jpg'], inventory);
    expect(result.parsed.grade).toBeNull();
  });
});

/*
 * Part 7b: counterfeit records ("1855 3CS - VF - FAKE", "1859 3CS - XF - FAKE",
 * "1859 3CS - XF40 - FAKE") sit beside genuine coins of the same dates. They
 * are matched like any coin, but the authenticity veto keeps fake and genuine
 * apart, and fakes stay findable in the manual search.
 */
describe('his counterfeit records', () => {
  // This account also holds the genuine 1855 and 1859 3CS records.
  const run = () => RUNS.get('2-3-20-cent Collection')!;

  it('recognises exactly the records whose descriptor says so', () => {
    const { inventory } = run();
    const flagged = inventory.filter(isCounterfeitRecord);

    // "FAKE" survives only in the raw Quicken security name, which is why
    // `isCounterfeitRecord` also reads `securityName`.
    expect(flagged.map(c => (c as unknown as { securityName: string }).securityName).sort())
      .toEqual([
        '1855 3CS - VF - FAKE',
        '1859 3CS - XF - FAKE',
        '1859 3CS - XF40 - FAKE'
      ]);
  });

  it('pairs a photograph only with a record of the same authenticity', () => {
    // Checked for the auto match, the candidate list and the tier-2 dropdown.
    const { results, coinOf } = run();
    const isFake = (id: string) => isCounterfeitRecord(coinOf(id)!);

    for (const result of results) {
      const file = result.parsed.fileName;
      const photoIsFake = result.parsed.counterfeit === true;
      if (result.matchedRecordId) {
        expect(isFake(result.matchedRecordId), `${file} auto-matched across authenticity`).toBe(photoIsFake);
      }
      for (const candidate of [...result.candidates, ...(result.nearMatch?.candidates ?? [])]) {
        expect(isFake(candidate.coinId), `${file} offered ${candidate.coinLabel}`).toBe(photoIsFake);
      }
    }
  });

  it('attaches a photograph of a fake to its own fake record', () => {
    const { results, coinOf } = run();
    const fakePhotos = results.filter(r => r.parsed.counterfeit === true);
    expect(fakePhotos.length).toBeGreaterThan(0);
    const attached = fakePhotos.filter(r => r.matchedRecordId && isCounterfeitRecord(coinOf(r.matchedRecordId)!));
    expect(attached.length).toBeGreaterThan(0);
  });

  it('does not take any GENUINE record out of the pool with them', () => {
    // A genuine proof's memo says "(exchange for a 3CS FAKE)", which is why
    // `isCounterfeitRecord` ignores `notes`.
    const { inventory } = run();
    const genuine = inventory.filter(c => !isCounterfeitRecord(c));

    expect(genuine.length, 'three excluded, the rest kept')
      .toBe(inventory.length - 3);
    const trimes1855 = genuine.filter(c => c.year === '1855' && c.denomination === '3CS');
    expect(trimes1855.length, 'the genuine 1855 3CS records survive').toBeGreaterThan(0);
  });

  it('leaves a fake perfectly findable by the manual coin search', () => {
    // `searchCoins` drives CoinLookup, the manual chooser on the import
    // screen; it must read the unfiltered inventory.
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

/*
 * Part 8: denomination parsing in quicken-import.service.ts. Its regex
 * ladder is order-sensitive: "25¢" contains "5¢", and "½10¢" contains "10¢".
 * A mis-read quarter or half dime collides with real coins in Early Proofs
 * and can be auto-attached to the wrong record.
 */
describe('his cent-sign spellings import as the coins they are', () => {
  const { inventory } = RUNS.get('Early Proofs')!;
  const securities = securityNamesFor(QIF_ACCOUNTS.find(a => a.account === 'Early Proofs')!);
  const recordFor = (security: string) => inventory[securities.indexOf(security)];

  it('"1871 25¢" is a QUARTER, not a five-cent piece', () => {
    expect(recordFor('1871 25¢ - PCGS/CAC PF65 Cameo').denomination).toBe('25¢');
  });

  it('"1855 ½10¢" is a HALF DIME, not a dime', () => {
    // '5¢' is the seeded denomination used for half dimes.
    expect(recordFor('1855 ½10¢ - NGC/CAC PF65').denomination).toBe('5¢');
  });

  it('his genuine 10¢ dimes are still dimes', () => {
    expect(recordFor('1908 10¢ PCGS PF65 Cameo').denomination).toBe('10¢');
    expect(recordFor('1868 10¢ - PCGS/CAC PF65 Cameo').denomination).toBe('10¢');
  });

  it('a QUARTER photo is never filed under a half dime again', () => {
    // With the wrong ladder order both read as 1871 five-cent pieces.
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
