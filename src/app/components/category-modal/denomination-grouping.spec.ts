/*
 * denomination-grouping.spec.ts — a thousand-odd rows made navigable.
 *
 * At this size grouping and search are not polish: they are the only thing
 * that makes the pane openable at all.
 *
 * Everything below is pure: no DOM, no service, no signals. The tests run
 * under Node without jsdom like the rest of this project, which is exactly
 * why the logic is in this module and not in the component.
 */

import { describe, expect, it } from 'vitest';

import {
  MaintenanceDenomination,
  MaintenanceIssuer,
  UNASSIGNED_ISSUER_HEADING,
  compareIssuersByName,
  groupDenominations,
  normalizeSearchText,
} from './denomination-grouping';

/**
 * DELIBERATELY NOT IN ALPHABETICAL ORDER, AND DELIBERATELY NOT IN SortOrder
 * ORDER EITHER.
 *
 * If this list arrived already sorted, both "returns them A-Z" and "does not
 * mutate the arrays it was given" would pass whether or not the code sorted
 * anything, and whether or not it sorted IN PLACE. A fixture in the expected
 * order is cover that covers nothing.
 *
 * The `sortOrder` values are the OPPOSITE of the alphabetical answer on
 * purpose — United States is 1 and Burma is 99, so A-Z is very nearly the
 * reverse of the old SortOrder order. A grouping that quietly went back to
 * SortOrder cannot pass the order tests below by coincidence.
 */
const ISSUERS: readonly MaintenanceIssuer[] = Object.freeze([
  { issuerId: 5, name: 'Burma', isoCode: 'MM', kind: 'modern', sortOrder: 99 },
  { issuerId: 4, name: 'Roman Empire', isoCode: null, kind: 'ancient', sortOrder: 30 },
  { issuerId: 1, name: 'Mexico', isoCode: 'MX', kind: 'modern', sortOrder: 10 },
  { issuerId: 2, name: 'United States', isoCode: 'US', kind: 'modern', sortOrder: 1 },
  { issuerId: 3, name: 'Spanish Colonial', isoCode: null, kind: 'historical', sortOrder: 20 },
]);

const DENOMINATIONS: readonly MaintenanceDenomination[] = Object.freeze([
  { denominationId: 101, issuerId: 2, label: '25¢', sortOrder: 3, inUseCount: 7 },
  { denominationId: 102, issuerId: 2, label: '50¢', sortOrder: 4, inUseCount: 2 },
  { denominationId: 103, issuerId: 1, label: '8 Reales', sortOrder: 1, inUseCount: 3 },
  { denominationId: 104, issuerId: 1, label: '1 Peso', sortOrder: 2, inUseCount: 0 },
  { denominationId: 105, issuerId: 3, label: '8 Reales', sortOrder: 1, inUseCount: 0 },
  { denominationId: 106, issuerId: 4, label: 'Denarius', sortOrder: 1, inUseCount: 1 },
  { denominationId: 107, issuerId: null, label: 'Écu', sortOrder: 0, inUseCount: 4 },
  { denominationId: 108, issuerId: 999, label: 'Mystery', sortOrder: 0, inUseCount: 0 },
]);

function headings(groups: ReturnType<typeof groupDenominations>): string[] {
  return groups.map((group) => group.heading);
}

function labelsUnder(groups: ReturnType<typeof groupDenominations>, heading: string): string[] {
  const group = groups.find((candidate) => candidate.heading === heading);
  return (group?.denominations ?? []).map((denomination) => denomination.label);
}

describe('groupDenominations — unfiltered', () => {
  it('returns one group per issuer, A-Z by name', () => {
    // NOT SortOrder. The fixture's SortOrder would give United States,
    // Mexico, Spanish Colonial, Roman Empire, Burma — very nearly the
    // reverse of this — so the assertion distinguishes the two orders
    // rather than merely agreeing with whichever one the code picked.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(headings(groups).slice(0, 5)).toEqual([
      'Burma',
      'Mexico',
      'Roman Empire',
      'Spanish Colonial',
      'United States',
    ]);
  });

  it('keeps an issuer with no denominations yet', () => {
    // A freshly added issuer has no denominations yet. Hiding the empty
    // group would hide the issuer the user just created, and the Add
    // control under it.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    const burma = groups.find((group) => group.heading === 'Burma');
    expect(burma).toBeDefined();
    expect(burma?.denominations).toEqual([]);
  });

  it('puts denominations with no issuer in one group, last', () => {
    // Denominations.IssuerId is nullable, so a null here is an ordinary
    // state and not a bug. The group goes last because it is a tidy-up
    // list, not an issuer.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(headings(groups).at(-1)).toBe(UNASSIGNED_ISSUER_HEADING);
    expect(labelsUnder(groups, UNASSIGNED_ISSUER_HEADING)).toContain('Écu');
  });

  it('files a denomination whose issuer id matches nothing under the same group rather than dropping it', () => {
    // THE BUG THIS PREVENTS: a row pointing at an issuer that was deleted,
    // or at an id the snapshot did not include, silently disappearing from
    // the only screen that could fix it.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(labelsUnder(groups, UNASSIGNED_ISSUER_HEADING)).toContain('Mystery');
  });

  it('omits the unassigned group entirely when every row has an issuer', () => {
    const tidy = DENOMINATIONS.filter((d) => d.issuerId === 1 || d.issuerId === 2);
    const groups = groupDenominations(tidy, ISSUERS);
    expect(headings(groups)).not.toContain(UNASSIGNED_ISSUER_HEADING);
  });

  it('orders denominations within a group by sort order, then label', () => {
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(labelsUnder(groups, 'Mexico')).toEqual(['8 Reales', '1 Peso']);
  });

  it('breaks a sort-order tie on the label so the order is total and stable', () => {
    const tied: MaintenanceDenomination[] = [
      { denominationId: 1, issuerId: 1, label: 'Zwanziger', sortOrder: 5 },
      { denominationId: 2, issuerId: 1, label: 'Ateler', sortOrder: 5 },
    ];
    expect(labelsUnder(groupDenominations(tied, ISSUERS), 'Mexico')).toEqual(['Ateler', 'Zwanziger']);
  });

  it('totals the in-use counts of the rows it is showing', () => {
    // So the sidebar / heading can say "Mexico — 2 denominations, 3 coins"
    // without the template re-deriving a sum.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    const mexico = groups.find((group) => group.heading === 'Mexico');
    expect(mexico?.inUseTotal).toBe(3);
  });

  it('treats a missing in-use count as zero rather than NaN', () => {
    const noCounts: MaintenanceDenomination[] = [{ denominationId: 1, issuerId: 1, label: 'Onza' }];
    const groups = groupDenominations(noCounts, ISSUERS);
    expect(groups.find((group) => group.heading === 'Mexico')?.inUseTotal).toBe(0);
  });

  it('does not mutate the arrays it was given', () => {
    // BOTH halves of this matter, and the comparison alone was not enough.
    //
    // The fixtures are FROZEN, so an in-place `.sort()` throws immediately
    // wherever it happens. Comparing copies before and after cannot do that
    // job on its own: `groupDenominations` is called with the shared
    // fixtures by a dozen tests above, so a version that sorted in place
    // would have sorted ISSUERS during the first of them, and by the time
    // this test ran the "before" and "after" would agree — on the wrong
    // order. Verified: without the freeze, that mutation passes this test.
    //
    // The arrays handed in by the component are read straight out of
    // signals, and sorting one in place reorders what every other reader of
    // that signal sees, intermittently, depending on who rendered first.
    const denominations = [...DENOMINATIONS];
    const issuers = [...ISSUERS];
    groupDenominations(denominations, issuers);
    expect(denominations).toEqual(DENOMINATIONS);
    expect(issuers).toEqual(ISSUERS);
  });
});

describe('groupDenominations — search', () => {
  it('finds a denomination wherever it lives', () => {
    // Typing "reales" finds them. There are two 8 Reales — under Mexico and
    // under Spanish Colonial — and a search that only reached the one filed
    // under the coin's own country would miss the one the user wants.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'reales');
    expect(headings(groups)).toEqual(['Mexico', 'Spanish Colonial']);
    expect(labelsUnder(groups, 'Mexico')).toEqual(['8 Reales']);
    expect(labelsUnder(groups, 'Spanish Colonial')).toEqual(['8 Reales']);
  });

  it('drops a group whose denominations all failed to match', () => {
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'denarius');
    expect(headings(groups)).toEqual(['Roman Empire']);
  });

  it('ignores case, surrounding space and repeated inner space', () => {
    const expected = headings(groupDenominations(DENOMINATIONS, ISSUERS, '8 reales'));
    expect(headings(groupDenominations(DENOMINATIONS, ISSUERS, '  8   REALES  '))).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('matches through accents, so an unaccented keyboard still finds the row', () => {
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'ecu');
    expect(labelsUnder(groups, UNASSIGNED_ISSUER_HEADING)).toEqual(['Écu']);
  });

  it('shows a whole issuer when the ISSUER NAME matches', () => {
    // "mexico" appears in no label. Matching only labels would answer
    // "nothing found" for the most natural thing a user can type.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'mexico');
    expect(headings(groups)).toEqual(['Mexico']);
    expect(labelsUnder(groups, 'Mexico')).toEqual(['8 Reales', '1 Peso']);
  });

  it('shows an issuer that matched even when it has no denominations', () => {
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'burma');
    expect(headings(groups)).toEqual(['Burma']);
    expect(labelsUnder(groups, 'Burma')).toEqual([]);
  });

  it('matches a full ISO code', () => {
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, 'mx');
    expect(headings(groups)).toEqual(['Mexico']);
  });

  it('does NOT match half an ISO code', () => {
    // Exact, not substring. Two letters as a substring hit everything: 'us'
    // is inside "Russia", 'in' inside "China" and "Argentina". The code is
    // something the user types deliberately and in full.
    //
    // The fixture is local and minimal on purpose: the single letter has to
    // match the ISO code and NOTHING else, or the test cannot tell exact
    // matching from substring matching.
    const issuers: MaintenanceIssuer[] = [
      { issuerId: 1, name: 'Zedland', isoCode: 'XQ', kind: 'modern', sortOrder: 1 },
    ];
    const denominations: MaintenanceDenomination[] = [
      { denominationId: 1, issuerId: 1, label: 'Thaler' },
    ];

    expect(groupDenominations(denominations, issuers, 'x')).toEqual([]);
    expect(groupDenominations(denominations, issuers, 'xq')).toHaveLength(1);
  });

  it('reports whether the issuer itself matched', () => {
    const byIssuer = groupDenominations(DENOMINATIONS, ISSUERS, 'mexico');
    expect(byIssuer[0]?.issuerMatched).toBe(true);

    const byLabel = groupDenominations(DENOMINATIONS, ISSUERS, 'denarius');
    expect(byLabel[0]?.issuerMatched).toBe(false);
  });

  it('returns nothing at all when nothing matches', () => {
    expect(groupDenominations(DENOMINATIONS, ISSUERS, 'zzzz')).toEqual([]);
  });

  it('treats a blank search as no search', () => {
    const unfiltered = headings(groupDenominations(DENOMINATIONS, ISSUERS));
    expect(headings(groupDenominations(DENOMINATIONS, ISSUERS, '   '))).toEqual(unfiltered);
  });

  it('totals only the rows that survived the filter', () => {
    // The heading count has to describe what is on screen. Showing Mexico's
    // full total next to one filtered row would be a number that explains
    // nothing.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, '25');
    expect(groups.find((group) => group.heading === 'United States')?.inUseTotal).toBe(7);
  });
});

/*
 * ISSUER ORDER — THE OWNER ASKED FOR ALPHABETICAL
 *
 * "The Issuers and Denominations screens need to have the Issuers in
 * alphabetic order." Both screens read this comparator: the Issuers pane and
 * the Denominations pane's issuer <select> sort with it directly
 * (category-modal.ts `sortedIssuers`), and the Denominations pane's group
 * headings get it through `groupDenominations`.
 *
 * Every assertion below is written so that it FAILS for the obvious wrong
 * implementations, not merely passes for the right one:
 *   - sorting by SortOrder            -> caught by the fixture order tests
 *   - sorting by raw code point       -> caught by 'austria' vs 'Belgium'
 *   - case-SENSITIVE localeCompare    -> caught by 'Mexico' vs 'mexico'
 */
describe('compareIssuersByName', () => {
  const sorted = (issuers: MaintenanceIssuer[]): string[] =>
    [...issuers].sort(compareIssuersByName).map((issuer) => issuer.name);

  it('ignores case, so a lower-case name does not fall off the end', () => {
    // A raw `<` or a code-point sort puts every capital before every
    // lower-case letter: 'Belgium' (B = 66) ahead of 'austria' (a = 97).
    // The user typed the name, and the user's capitalisation is not an
    // instruction about where the row belongs.
    expect(
      sorted([
        { issuerId: 1, name: 'Belgium', kind: 'modern' },
        { issuerId: 2, name: 'austria', kind: 'modern' },
        { issuerId: 3, name: 'CANADA', kind: 'modern' },
      ])
    ).toEqual(['austria', 'Belgium', 'CANADA']);
  });

  it('pays no attention to SortOrder at all', () => {
    // The seed's bands — modern 100-420, historical 1000-1150, ancient
    // 2000-2120 — would put Zanzibar first here.
    expect(
      sorted([
        { issuerId: 1, name: 'Zanzibar', kind: 'modern', sortOrder: 1 },
        { issuerId: 2, name: 'Austria', kind: 'ancient', sortOrder: 9999 },
      ])
    ).toEqual(['Austria', 'Zanzibar']);
  });

  it('is total and stable when two names differ only in case', () => {
    // Case is folded, so these two tie on name and the ID decides. Without
    // that tiebreak the pair compares equal and may swap between renders;
    // with a case-SENSITIVE compare, ICU puts 'mexico' first instead, so
    // this assertion distinguishes the two.
    const pair: MaintenanceIssuer[] = [
      { issuerId: 7, name: 'mexico', kind: 'modern' },
      { issuerId: 3, name: 'Mexico', kind: 'modern' },
    ];
    expect(sorted(pair)).toEqual(['Mexico', 'mexico']);
    expect(sorted([...pair].reverse())).toEqual(['Mexico', 'mexico']);
  });

  it('answers zero only for a row compared with itself', () => {
    const issuer: MaintenanceIssuer = { issuerId: 1, name: 'Mexico', kind: 'modern' };
    expect(compareIssuersByName(issuer, issuer)).toBe(0);
    expect(compareIssuersByName(issuer, { issuerId: 2, name: 'Mexico', kind: 'modern' })).toBeLessThan(0);
  });

  it('keeps the groups A-Z while the rows inside one stay in SortOrder', () => {
    // THE HALF THAT MUST NOT BREAK. The request was about ISSUERS. A
    // denomination's SortOrder is the only sane order within an issuer --
    // France carries '1 Franc' and '1 Euro' both at FaceValue 1 -- so
    // alphabetising the headings must not alphabetise their contents.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(headings(groups).slice(0, 2)).toEqual(['Burma', 'Mexico']);
    expect(labelsUnder(groups, 'Mexico')).toEqual(['8 Reales', '1 Peso']);
  });
});

describe('normalizeSearchText', () => {
  it('lower-cases, trims, collapses inner whitespace and strips accents', () => {
    expect(normalizeSearchText('  ÉCU   d’Or  ')).toBe("ecu d’or");
  });

  it('answers an empty string for nothing', () => {
    expect(normalizeSearchText(null)).toBe('');
    expect(normalizeSearchText(undefined)).toBe('');
    expect(normalizeSearchText('   ')).toBe('');
  });
});
