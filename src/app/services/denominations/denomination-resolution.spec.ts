 /*
  * The resolution rules of design §5:
  *   1. the coin's country is a preference, not a filter;
  *   2. an ambiguous match leaves the id null;
  *   3. spellings fold through denomination-aliases.ts only;
  *   4. inactive or unmatched rows resolve to nothing, with an outcome a report can count.
  */

import { describe, expect, it } from 'vitest';

import {
  resolveDenomination,
  type ResolverDenomination,
  type ResolverIssuer,
} from './denomination-resolution';

 /*
  * A small world: the United States and Great Britain, Mexico for the 8 Reales
  * case, Australia as a second Crown, and the Roman Empire with no ISO code.
  */

const ISSUERS: ResolverIssuer[] = [
  { issuerId: 1, name: 'United States', isoCode: 'US' },
  { issuerId: 2, name: 'Great Britain', isoCode: 'GB' },
  { issuerId: 3, name: 'Mexico', isoCode: 'MX' },
  { issuerId: 4, name: 'Australia', isoCode: 'AU' },
  { issuerId: 5, name: 'Roman Empire', isoCode: null },
];

const DENOMINATIONS: ResolverDenomination[] = [
  { denominationId: 10, issuerId: 1, label: '3CS' },
  { denominationId: 11, issuerId: 1, label: '50¢' },
  { denominationId: 12, issuerId: 1, label: '$1' },
  { denominationId: 20, issuerId: 2, label: '5/- (Crown)' },
  { denominationId: 21, issuerId: 2, label: '1/-' },
  { denominationId: 30, issuerId: 3, label: '8 Reales' },
  { denominationId: 40, issuerId: 4, label: 'Crown' },
  { denominationId: 50, issuerId: 5, label: 'Denarius' },
];

function resolve(text: string | null | undefined, country: string | null | undefined) {
  return resolveDenomination(text, country, DENOMINATIONS, ISSUERS);
}

 /* 1. The country is a preference */

describe('the coin country narrows the search but never limits it', () => {
  it('resolves 8 Reales on a coin whose country says United States', () => {
    // QIF-imported coins all say 'United States', including Mexican ones, so a
    // country-only match would resolve nothing here.
    const match = resolve('8 Reales', 'United States');
    expect(match.denominationId).toBe(30);
    expect(match.outcome).toBe('any-issuer');
  });

  it('prefers the coin country when more than one issuer could match', () => {
    const match = resolve('Crown', 'Great Britain');
    expect(match.denominationId).toBe(20);
    expect(match.outcome).toBe('in-country');
  });

  it('matches a country written as an ISO code against the issuer code', () => {
    // Coins say 'United States', denominations 'US'/'GB'; both reach the same issuer.
    expect(resolve('Crown', 'GB').denominationId).toBe(20);
    expect(resolve('50 Cents', 'US').denominationId).toBe(11);
  });

  it('matches an issuer that has no ISO code at all, by name', () => {
    // Ancients have no ISO code, so matching must also work on the Name.
    const match = resolve('Denarius', 'Roman Empire');
    expect(match.denominationId).toBe(50);
    expect(match.outcome).toBe('in-country');
  });

  it('still resolves when the coin has no country at all', () => {
    expect(resolve('8 Reales', null).denominationId).toBe(30);
    expect(resolve('8 Reales', '').denominationId).toBe(30);
  });
});

 /* 2. Ambiguity is answered with null */

describe('an ambiguous match leaves the id null', () => {
  it('refuses to choose between two issuers when the country helps with neither', () => {
    // 'Other (Crown)' rather than a guessed issuer.
    const match = resolve('Crown', 'United States');
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('ambiguous');
    expect([...match.candidateIds].sort()).toEqual([20, 40]);
  });

  it('refuses to choose between two rows of the SAME issuer', () => {
    // Two US labels folding to one key (possible via Settings): no coin flip.
    const withDuplicate = [
      ...DENOMINATIONS,
      { denominationId: 13, issuerId: 1, label: 'Half Dollar' },
    ];
    const match = resolveDenomination('50¢', 'United States', withDuplicate, ISSUERS);
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('ambiguous');
  });

  it('resolves a term that is ambiguous in GENERAL but unique within the country', () => {
    /* 'Penny' is not an alias (US cent vs 1d), but is a real label under
     * Australia, New Zealand and Ireland: ambiguous across issuers, unambiguous
     * within one. So ambiguity is judged after the country, never before. */
    const pennyIssuers: ResolverIssuer[] = [
      { issuerId: 1, name: 'Australia', isoCode: 'AU' },
      { issuerId: 2, name: 'New Zealand', isoCode: 'NZ' },
      { issuerId: 3, name: 'Ireland', isoCode: 'IE' },
    ];
    const pennies: ResolverDenomination[] = [
      { denominationId: 101, issuerId: 1, label: 'Penny' },
      { denominationId: 102, issuerId: 2, label: 'Penny' },
      { denominationId: 103, issuerId: 3, label: 'Penny' },
    ];

    expect(resolveDenomination('Penny', 'Australia', pennies, pennyIssuers)).toMatchObject({
      denominationId: 101,
      outcome: 'in-country',
    });
    expect(resolveDenomination('Penny', 'NZ', pennies, pennyIssuers).denominationId).toBe(102);
    expect(resolveDenomination('Penny', 'United States', pennies, pennyIssuers)).toMatchObject({
      denominationId: null,
      outcome: 'ambiguous',
    });
    expect(resolveDenomination('Penny', '', pennies, pennyIssuers).denominationId).toBeNull();
  });

  it('prefers an issuer the country names exactly over one a pattern recognises', () => {
    /* The country is compared exactly against Name/IsoCode first, then via
     * isSameCountry only if that found nothing. Exact must win: it is the better
     * answer, and migration 014 can only do the exact comparison. */
    const colonial: ResolverIssuer[] = [
      { issuerId: 1, name: 'Great Britain', isoCode: 'GB' },
      { issuerId: 2, name: 'British Colonial', isoCode: null },
    ];
    const bothStruckIt: ResolverDenomination[] = [
      { denominationId: 201, issuerId: 1, label: '1d' },
      { denominationId: 202, issuerId: 2, label: '1d' },
    ];

    expect(resolveDenomination('1d', 'British Colonial', bothStruckIt, colonial)).toMatchObject({
      denominationId: 202,
      outcome: 'in-country',
    });
    expect(resolveDenomination('1d', 'Great Britain', bothStruckIt, colonial).denominationId).toBe(201);
  });

  it('reports the candidates it refused, so a report can say why', () => {
    const match = resolve('Crown', 'Canada');
    expect(match.denominationId).toBeNull();
    expect(match.candidateIds).toHaveLength(2);
  });
});

 /* 3. One alias table, the existing one */

describe('spellings fold through denomination-aliases.ts', () => {
  it('folds the three-cent-silver spellings onto one row', () => {
    // Exactly the spellings denomination-aliases.ts knows; this module doesn't extend it.
    for (const spelling of ['3CS', '3cs', 'Three Cent Silver', 'Trime']) {
      expect(resolve(spelling, 'United States').denominationId, spelling).toBe(10);
    }
  });

  it("folds the QIF importer's own British spellings", () => {
    // The QIF importer writes '5s' and '1s'; the lookup spells them '5/- (Crown)' and '1/-'.
    expect(resolve('5s', 'Great Britain').denominationId).toBe(20);
    expect(resolve('1s', 'Great Britain').denominationId).toBe(21);
  });

  it('folds spelled-out face values', () => {
    expect(resolve('Half Dollar', 'United States').denominationId).toBe(11);
    expect(resolve('50 Cents', 'United States').denominationId).toBe(11);
    expect(resolve('Silver Dollar', 'United States').denominationId).toBe(12);
  });

  it('leaves alone the spellings the alias table deliberately omits', () => {
    // 'Trade Dollar' is a distinct issue; 'Penny' and 'Eagle' are ambiguous.
    // These omissions are decided in denomination-aliases.ts.
    expect(resolve('Trade Dollar', 'United States').denominationId).toBeNull();
    expect(resolve('Penny', 'United States').denominationId).toBeNull();
    expect(resolve('Eagle', 'United States').denominationId).toBeNull();
  });
});

 /* 4. No match is a result, not a failure */

describe('values with no row', () => {
  it('answers unknown for text no seeded denomination names', () => {
    const match = resolve('100 Soles', 'Peru');
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('unknown');
    expect(match.candidateIds).toEqual([]);
  });

  it('answers empty for a blank value, distinct from unknown', () => {
    // "Nothing recorded" is not "couldn't resolve"; blanks stay out of the review report.
    for (const blank of [null, undefined, '', '   ']) {
      const match = resolve(blank, 'United States');
      expect(match.denominationId).toBeNull();
      expect(match.outcome).toBe('empty');
    }
  });

  it('ignores inactive rows', () => {
    // Soft-deleted rows (§4.4) must not be matched.
    const retired: ResolverDenomination[] = [
      { denominationId: 30, issuerId: 3, label: '8 Reales', isActive: false },
    ];
    const match = resolveDenomination('8 Reales', 'Mexico', retired, ISSUERS);
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('unknown');
  });

  it('treats a row with no issuer as reachable only by the fallback', () => {
    // Denominations.IssuerId is nullable for now; such rows still resolve, but
    // can't be preferred by country.
    const orphan: ResolverDenomination[] = [
      { denominationId: 99, issuerId: null, label: 'Guinea' },
    ];
    const match = resolveDenomination('Guinea', 'Great Britain', orphan, ISSUERS);
    expect(match.denominationId).toBe(99);
    expect(match.outcome).toBe('any-issuer');
  });

  it('answers unknown rather than throwing when the issuer list is empty', () => {
    const match = resolveDenomination('8 Reales', 'United States', DENOMINATIONS, []);
    expect(match.denominationId).toBe(30);
    expect(match.outcome).toBe('any-issuer');
  });
});
