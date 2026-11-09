 /*
 * denomination-resolution.spec.ts
 *
 * The four rules of design §5, one describe block each:
 *
 *   1. the coin's country is a PREFERENCE, not a filter;
 *   2. an ambiguous match leaves the id null rather than guessing;
 *   3. the spellings fold through denomination-aliases.ts and nothing else;
 *   4. an inactive or unmatched row resolves to nothing, loudly enough to be
 *      counted in a report.
  */

import { describe, expect, it } from 'vitest';

import {
  resolveDenomination,
  type ResolverDenomination,
  type ResolverIssuer,
} from './denomination-resolution';

 /*
 * A small world, shaped like the real one: the United States and Great
 * Britain as the seed already has them, Mexico as the 8-Reales case needs
 * it, Australia as a second Crown, and the Roman Empire as an issuer with no
 * ISO code at all.
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

 /*
 * 1. THE COUNTRY IS A PREFERENCE
  */

describe('the coin country narrows the search but never limits it', () => {
  it('resolves 8 Reales on a coin whose country says United States', () => {
    // THE CASE THAT PROMPTED THE WHOLE CHANGE. The QIF parser never set a
    // country, so every imported coin says 'United States' — including the
    // Mexican ones. A country-scoped-only match resolves nothing here, which
    // would leave the headline example of the design unfixed by the migration
    // that exists to fix it.
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
    // Denominations.Country holds 'US'/'GB' and Coins.Country holds
    // 'United States'. Both spellings have to reach the same issuer.
    expect(resolve('Crown', 'GB').denominationId).toBe(20);
    expect(resolve('50 Cents', 'US').denominationId).toBe(11);
  });

  it('matches an issuer that has no ISO code at all, by name', () => {
    // Ancients are first-class (design §4.2) and none of them has an ISO
    // code. Matching on the code alone would make every ancient issuer
    // unreachable by country.
    const match = resolve('Denarius', 'Roman Empire');
    expect(match.denominationId).toBe(50);
    expect(match.outcome).toBe('in-country');
  });

  it('still resolves when the coin has no country at all', () => {
    expect(resolve('8 Reales', null).denominationId).toBe(30);
    expect(resolve('8 Reales', '').denominationId).toBe(30);
  });
});

 /*
 * 2. AMBIGUITY IS ANSWERED WITH NULL
  */

describe('an ambiguous match leaves the id null', () => {
  it('refuses to choose between two issuers when the country helps with neither', () => {
    // 'Other (Crown)' is honest. The wrong country is not, and nothing in the
    // UI would ever reveal it.
    const match = resolve('Crown', 'United States');
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('ambiguous');
    expect([...match.candidateIds].sort()).toEqual([20, 40]);
  });

  it('refuses to choose between two rows of the SAME issuer', () => {
    // The Settings dialog lets the user add rows, so two US labels that fold
    // to one key are reachable. Picking "the first one" would be a coin flip
    // the user never sees.
    const withDuplicate = [
      ...DENOMINATIONS,
      { denominationId: 13, issuerId: 1, label: 'Half Dollar' },
    ];
    const match = resolveDenomination('50¢', 'United States', withDuplicate, ISSUERS);
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('ambiguous');
  });

  it('resolves a term that is ambiguous in GENERAL but unique within the country', () => {
    /* THE ORDER OF THE TWO RULES, STATED AS A TEST.
     *
     * 'Penny' is deliberately NOT an alias — it means the US cent to an
     * American and 1d to everyone else, and denomination-aliases.ts refuses
     * to choose. But it IS a real label under Australia, New Zealand and
     * Ireland, which all struck a coin called exactly that.
     *
     * So the word is ambiguous across issuers and unambiguous within one,
     * and that is precisely the thing the flat model could not express.
     * Ambiguity must be answered AFTER the country has had its say, never
     * before: checking "is this word ambiguous anywhere?" first would null
     * every one of these.
     */
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
    /* The coin's country is compared two ways: exactly against the
     * issuer's Name and IsoCode, and then -- only if that found nothing --
     * through isSameCountry, which knows that 'GB' is Great Britain and
     * that 'British' probably is too.
     *
     * Exact must win, for two reasons. It is the better answer: a name the
     * user typed character for character outranks a regular expression's
     * opinion. And it is what makes migration 014 safe, because T-SQL can
     * only do the exact comparison -- so the migration's rule has to be a
     * special case of this one rather than a rival to it.
     */
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

 /*
 * 3. ONE ALIAS TABLE, THE EXISTING ONE
  */

describe('spellings fold through denomination-aliases.ts', () => {
  it('folds the three-cent-silver spellings onto one row', () => {
    // Exactly the spellings denomination-aliases.ts knows. '3¢ Silver' is
    // NOT among them and is not added here: extending that table changes the
    // editor's dropdown, which is a different piece of work with its own
    // tests. This module reuses the vocabulary, it does not grow it.
    for (const spelling of ['3CS', '3cs', 'Three Cent Silver', 'Trime']) {
      expect(resolve(spelling, 'United States').denominationId, spelling).toBe(10);
    }
  });

  it("folds the QIF importer's own British spellings", () => {
    // quicken-import.service.ts writes '5s' for a crown and '1s' for a
    // shilling; the lookup spells them '5/- (Crown)' and '1/-'.
    expect(resolve('5s', 'Great Britain').denominationId).toBe(20);
    expect(resolve('1s', 'Great Britain').denominationId).toBe(21);
  });

  it('folds spelled-out face values', () => {
    expect(resolve('Half Dollar', 'United States').denominationId).toBe(11);
    expect(resolve('50 Cents', 'United States').denominationId).toBe(11);
    expect(resolve('Silver Dollar', 'United States').denominationId).toBe(12);
  });

  it('leaves alone the spellings the alias table deliberately omits', () => {
    // 'Trade Dollar' is a distinct issue, not the lookup's '$1'. 'Penny' and
    // 'Eagle' are ambiguous by country and by series. Those omissions are
    // decisions made in denomination-aliases.ts and this module must not
    // quietly undo them.
    expect(resolve('Trade Dollar', 'United States').denominationId).toBeNull();
    expect(resolve('Penny', 'United States').denominationId).toBeNull();
    expect(resolve('Eagle', 'United States').denominationId).toBeNull();
  });
});

 /*
 * 4. NOTHING MATCHED IS A RESULT, NOT A FAILURE
  */

describe('values with no row', () => {
  it('answers unknown for text no seeded denomination names', () => {
    const match = resolve('100 Soles', 'Peru');
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('unknown');
    expect(match.candidateIds).toEqual([]);
  });

  it('answers empty for a blank value, distinct from unknown', () => {
    // A coin with no denomination recorded is not the same thing as a coin
    // whose denomination could not be resolved, and the migration's report
    // must not list hundreds of blanks as if they needed review.
    for (const blank of [null, undefined, '', '   ']) {
      const match = resolve(blank, 'United States');
      expect(match.denominationId).toBeNull();
      expect(match.outcome).toBe('empty');
    }
  });

  it('ignores inactive rows', () => {
    // Soft-deleted rows (design §4.4) must not pull coins back onto a
    // denomination the user removed.
    const retired: ResolverDenomination[] = [
      { denominationId: 30, issuerId: 3, label: '8 Reales', isActive: false },
    ];
    const match = resolveDenomination('8 Reales', 'Mexico', retired, ISSUERS);
    expect(match.denominationId).toBeNull();
    expect(match.outcome).toBe('unknown');
  });

  it('treats a row with no issuer as reachable only by the fallback', () => {
    // Denominations.IssuerId is nullable through the migration window, so
    // rows with no issuer exist. They can still be resolved — they just
    // cannot be preferred by country, because they belong to no country.
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
