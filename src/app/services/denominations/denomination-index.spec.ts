 /*
 * denomination-index.spec.ts
 *
 * The index exists for ONE reason: `resolveDenomination` filters the whole
 * lookup table through `denominationKey` on every call, and an import asks
 * it the question once per row. 2,000 rows x 1,161 labels is 2.3 million
 * alias folds for one spreadsheet.
 *
 * So the thing this spec has to prove is not that the index is fast. It is
 * that THE SHORTCUT CHANGES NO ANSWER -- swept over the real authored seed,
 * against the resolver called the long way. A fast resolver that resolves
 * differently from the editor and the migration is the exact failure design
 * §5 spends a page warning about.
  */

import { describe, expect, it } from 'vitest';

import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';
import {
  denominationIndexFor,
  resolveDenominationId,
  resolveIndexedDenomination,
  type IndexableDenomination
} from './denomination-index';
import { resolveDenomination, type ResolverDenomination } from './denomination-resolution';

/** Every active row of an index, flattened out of its alias buckets. */
function allCandidates(rows: readonly IndexableDenomination[]): ResolverDenomination[] {
  const index = denominationIndexFor(rows);
  return [...index.byAliasKey.values()].flatMap(bucket => [...bucket.candidates]);
}

describe('denominationIndexFor', () => {
  it('is built once per lookup array, because the importer asks per row', () => {
    // Array IDENTITY, which is what InventoryService's denominations signal
    // hands out per fetch. Without this, a 2,000-row import rebuilds the
    // index 2,000 times and the shortcut is slower than the long way.
    const first = denominationIndexFor(SEED_DENOMINATIONS);
    const second = denominationIndexFor(SEED_DENOMINATIONS);
    expect(second).toBe(first);
  });

  it('reads an issuer out of the Country column the way migration 013 wrote it', () => {
    const index = denominationIndexFor(SEED_DENOMINATIONS);
    const byName = new Map(index.issuers.map(issuer => [issuer.name, issuer]));

    // A two-letter value is an ISO code: Denominations.Country = 'MX'.
    expect(byName.get('Mexico')?.isoCode).toBe('MX');
    // Anything longer is the issuer's own name -- every ancient, which has
    // no ISO code to be filled in with.
    expect(byName.get('Roman Empire')?.isoCode).toBeNull();
  });

  it('leaves retired rows out entirely, so a soft-delete cannot pull a coin back', () => {
    const live = seedDenomination('United States', '$1');
    expect(live, 'the seed should carry a United States $1').toBeTruthy();

    const retired = SEED_DENOMINATIONS.map(row =>
      row.denominationId === live!.denominationId ? { ...row, isActive: false } : row
    );

    expect(resolveDenominationId('$1', 'United States', SEED_DENOMINATIONS))
      .toBe(live!.denominationId);
    expect(denominationIndexFor(retired).activeById.has(live!.denominationId)).toBe(false);
    expect(resolveDenominationId('$1', 'United States', retired))
      .not.toBe(live!.denominationId);
  });
});

 /*
 * THE PROPERTY THE SHORTCUT STANDS ON
  */

describe('the indexed resolution is the same resolution', () => {
  /* The spellings swept. Every 17th seeded label (so the sweep crosses every
   * issuer rather than camping in the United States), plus the spellings
   * this collection is known to produce -- the QIF parser's '5s' and '3CS',
   * the ones the design names, and the ones that MUST stay unresolved. */
  const SPELLINGS = [
    ...SEED_DENOMINATIONS.filter((_row, i) => i % 17 === 0).map(row => row.label),
    '8 Reales', 'Crown', 'Sovereign', 'Penny', 'Trade Dollar', 'Pillar Dollar',
    '100 Soles', 'Dollar', 'Half Dollar', 'Quarter', 'Dime', 'Nickel', 'Trime',
    '3CS', '3CN', '5s', '1s', 'Florin', 'Denarius', '½¢', '50¢', '$20',
    '', '   ', 'not a denomination at all'
  ];

  const COUNTRIES = [
    'United States', 'US', 'Mexico', 'MX', 'Great Britain', 'GB', 'U.S.A.',
    'Australia', 'Roman Empire', 'Judaea', 'Burma', ''
  ];

  it('has a sweep worth running', () => {
    expect(SPELLINGS.length * COUNTRIES.length).toBeGreaterThan(900);
  });

  it('agrees with resolveDenomination called the long way, on every pair', () => {
    const index = denominationIndexFor(SEED_DENOMINATIONS);
    const everyRow = allCandidates(SEED_DENOMINATIONS);
    const disagreements: string[] = [];
    let resolvedPairs = 0;

    for (const spelling of SPELLINGS) {
      for (const country of COUNTRIES) {
        const long = resolveDenomination(spelling, country, everyRow, index.issuers);
        const short = resolveIndexedDenomination(spelling, country, index);

        if (long.denominationId !== null) resolvedPairs += 1;

        if (
          long.denominationId !== short.denominationId ||
          long.outcome !== short.outcome ||
          long.candidateIds.join(',') !== short.candidateIds.join(',')
        ) {
          disagreements.push(
            `'${spelling}' / '${country}': long ${long.denominationId}/${long.outcome}` +
            ` vs short ${short.denominationId}/${short.outcome}`
          );
        }
      }
    }

    // Non-vacuity: a sweep in which nothing resolves would agree perfectly
    // and prove nothing at all.
    expect(resolvedPairs).toBeGreaterThan(200);
    expect(disagreements.slice(0, 20)).toEqual([]);
  });

  it('keeps the design\'s three named outcomes', () => {
    const index = denominationIndexFor(SEED_DENOMINATIONS);
    const mexican = seedDenomination('Mexico', '8 Reales');
    expect(mexican, 'the seed should carry a Mexican 8 Reales').toBeTruthy();

    // Scoped by the coin's own country: one answer.
    expect(resolveIndexedDenomination('8 Reales', 'Mexico', index).denominationId)
      .toBe(mexican!.denominationId);

    // Six issuers struck one, so a coin filed under the United States has no
    // right answer and the id stays null. See the long note in
    // sql-denomination-resolution-parity.spec.ts: this is correct, not a
    // shortfall.
    expect(resolveIndexedDenomination('8 Reales', 'United States', index).outcome)
      .toBe('ambiguous');

    // Nothing in the table names it. Normal, and not an error.
    expect(resolveIndexedDenomination('Pillar Dollar', 'United States', index).outcome)
      .toBe('unknown');
  });

  it('does not let a country vocabulary rename an issuer on top of another', () => {
    /* THE DEFECT THIS LOCKS DOWN, WHICH COST 52 OF 457 CORPUS COINS THEIR
     * LINK. `Denominations.Country` holds 'Confederate States of America'
     * for the Confederate issuer, and `countryDisplayName` answers 'United
     * States' for that string — it resolves a place to the modern country
     * containing it. Two issuers then shared one name, an ordinary '1¢'
     * matched both of them in-country, and rule 3 nulled the id.
     *
     * Note what is NOT asserted: that the two issuers are distinguishable
     * by some clever rule. They are distinguishable because the seed wrote
     * the name down and this index leaves it alone. */
    const index = denominationIndexFor(SEED_DENOMINATIONS);
    const names = index.issuers.map(issuer => issuer.name);
    expect(names).toContain('Confederate States of America');
    expect(names).toContain('Spanish Colonial');
    expect(names.filter(name => name === 'United States')).toHaveLength(1);

    const usCent = seedDenomination('United States', '1¢');
    const usHalf = seedDenomination('United States', '50¢');
    expect(usCent && usHalf, 'the seed should carry a US 1¢ and 50¢').toBeTruthy();
    expect(resolveDenominationId('1¢', 'United States', SEED_DENOMINATIONS))
      .toBe(usCent!.denominationId);
    expect(resolveDenominationId('50¢', 'United States', SEED_DENOMINATIONS))
      .toBe(usHalf!.denominationId);

    // And the Confederate rows are still reachable by their own name.
    const csaCent = seedDenomination('Confederate States of America', '1¢');
    expect(csaCent, 'the seed should carry a Confederate 1¢').toBeTruthy();
    expect(resolveDenominationId('1¢', 'Confederate States of America', SEED_DENOMINATIONS))
      .toBe(csaCent!.denominationId);
  });

  it('widens past the coin\'s country rather than giving up', () => {
    // The rule the whole design turns on. '100 Soles' is Peruvian; a coin
    // the QIF importer filed under the United States must still find it,
    // because only one issuer struck one.
    const peruvian = seedDenomination('Peru', '100 Soles');
    expect(peruvian, 'the seed should carry a Peruvian 100 Soles').toBeTruthy();

    const match = resolveIndexedDenomination(
      '100 Soles',
      'United States',
      denominationIndexFor(SEED_DENOMINATIONS)
    );
    expect(match.denominationId).toBe(peruvian!.denominationId);
    expect(match.outcome).toBe('any-issuer');
  });
});

describe('resolveDenominationId', () => {
  it('answers null for an empty lookup, so an import before the list arrives links nothing', () => {
    // NOT an error, and specifically not a reason to refuse the import. A
    // coin with text and no id is a correct, recoverable outcome (§4.1).
    expect(resolveDenominationId('$1', 'United States', [])).toBeNull();
  });

  it('folds the spellings the QIF importer actually writes', () => {
    // '5s' is what the parser emits for a British crown, and the alias
    // table already folds it onto '5/- (Crown)'. If this stops working the
    // importers quietly stop linking every British coin.
    const crown = seedDenomination('Great Britain', '5/- (Crown)');
    expect(crown, 'the seed should carry a British crown').toBeTruthy();
    expect(resolveDenominationId('5s', 'Great Britain', SEED_DENOMINATIONS))
      .toBe(crown!.denominationId);
  });
});
