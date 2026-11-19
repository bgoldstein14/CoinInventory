 /*
  * The index must change no answer: swept over the real seed and compared with
  * `resolveDenomination` called directly.
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
    // Cached by array identity, so an import doesn't rebuild it per row.
    const first = denominationIndexFor(SEED_DENOMINATIONS);
    const second = denominationIndexFor(SEED_DENOMINATIONS);
    expect(second).toBe(first);
  });

  it('reads an issuer out of the Country column the way migration 013 wrote it', () => {
    const index = denominationIndexFor(SEED_DENOMINATIONS);
    const byName = new Map(index.issuers.map(issuer => [issuer.name, issuer]));

    // A two-letter value is an ISO code: Denominations.Country = 'MX'.
    expect(byName.get('Mexico')?.isoCode).toBe('MX');
    // Anything longer is the issuer's own name (e.g. ancients with no ISO code).
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

describe('the indexed resolution is the same resolution', () => {
  /* Every 17th seeded label (to cross every issuer), plus spellings the QIF
   * parser produces ('5s', '3CS') and ones that must stay unresolved. */
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

    // Non-vacuity: enough pairs must resolve for the sweep to mean something.
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

    // Six issuers struck one, so a coin filed under the United States stays unlinked.
    expect(resolveIndexedDenomination('8 Reales', 'United States', index).outcome)
      .toBe('ambiguous');

    // Nothing in the table names it; normal, not an error.
    expect(resolveIndexedDenomination('Pillar Dollar', 'United States', index).outcome)
      .toBe('unknown');
  });

  it('does not let a country vocabulary rename an issuer on top of another', () => {
    /* `Denominations.Country` holds 'Confederate States of America' for that
     * issuer. Mapping it to 'United States' (as countryDisplayName would) makes an
     * ordinary '1¢' ambiguous in-country. The index must keep the seed's name. */
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

    // The Confederate rows are still reachable by their own name.
    const csaCent = seedDenomination('Confederate States of America', '1¢');
    expect(csaCent, 'the seed should carry a Confederate 1¢').toBeTruthy();
    expect(resolveDenominationId('1¢', 'Confederate States of America', SEED_DENOMINATIONS))
      .toBe(csaCent!.denominationId);
  });

  it('widens past the coin\'s country rather than giving up', () => {
    // Only Peru struck a 100 Soles, so a coin filed under the United States still finds it.
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
    // No lookup: null, which is not a reason to refuse the import.
    expect(resolveDenominationId('$1', 'United States', [])).toBeNull();
  });

  it('folds the spellings the QIF importer actually writes', () => {
    // '5s' is what the parser emits for a British crown; the alias table folds it.
    const crown = seedDenomination('Great Britain', '5/- (Crown)');
    expect(crown, 'the seed should carry a British crown').toBeTruthy();
    expect(resolveDenominationId('5s', 'Great Britain', SEED_DENOMINATIONS))
      .toBe(crown!.denominationId);
  });
});
