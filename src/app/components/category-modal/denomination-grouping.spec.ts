/* Grouping and search for the Denominations pane. */

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
 * Deliberately neither alphabetical nor in SortOrder order (SortOrder is
 * roughly reverse-alphabetical), so the order and no-mutation tests can't
 * pass by coincidence.
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
    // Not SortOrder, which would give nearly the reverse.
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
    // A new issuer with no denominations is still shown.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    const burma = groups.find((group) => group.heading === 'Burma');
    expect(burma).toBeDefined();
    expect(burma?.denominations).toEqual([]);
  });

  it('puts denominations with no issuer in one group, last', () => {
    // Null issuer is a normal state; its group goes last.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS);
    expect(headings(groups).at(-1)).toBe(UNASSIGNED_ISSUER_HEADING);
    expect(labelsUnder(groups, UNASSIGNED_ISSUER_HEADING)).toContain('Écu');
  });

  it('files a denomination whose issuer id matches nothing under the same group rather than dropping it', () => {
    // Rows pointing at an unknown issuer must not disappear.
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
    // The fixtures are frozen so an in-place sort throws; comparing copies
    // alone isn't enough, since earlier tests would already have sorted them.
    const denominations = [...DENOMINATIONS];
    const issuers = [...ISSUERS];
    groupDenominations(denominations, issuers);
    expect(denominations).toEqual(DENOMINATIONS);
    expect(issuers).toEqual(ISSUERS);
  });
});

describe('groupDenominations — search', () => {
  it('finds a denomination wherever it lives', () => {
    // Both 8 Reales (Mexico and Spanish Colonial) are found.
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
    // "mexico" appears in no label, so the issuer name must match.
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
    // ISO codes match exactly, not as a substring ('us' is inside "Russia").
    // The fixture's letters match only the ISO code, to tell the two apart.
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
    // The group total reflects only the filtered rows.
    const groups = groupDenominations(DENOMINATIONS, ISSUERS, '25');
    expect(groups.find((group) => group.heading === 'United States')?.inUseTotal).toBe(7);
  });
});

/*
 * Issuer order: A-Z, case-insensitive. Used by the Issuers pane, the issuer
 * <select> (`sortedIssuers`) and the group headings. The tests catch sorting
 * by SortOrder, by code point, and case-sensitively.
 */
describe('compareIssuersByName', () => {
  const sorted = (issuers: MaintenanceIssuer[]): string[] =>
    [...issuers].sort(compareIssuersByName).map((issuer) => issuer.name);

  it('ignores case, so a lower-case name does not fall off the end', () => {
    // A code-point sort would put 'Belgium' before 'austria'.
    expect(
      sorted([
        { issuerId: 1, name: 'Belgium', kind: 'modern' },
        { issuerId: 2, name: 'austria', kind: 'modern' },
        { issuerId: 3, name: 'CANADA', kind: 'modern' },
      ])
    ).toEqual(['austria', 'Belgium', 'CANADA']);
  });

  it('pays no attention to SortOrder at all', () => {
    // SortOrder bands would put Zanzibar first.
    expect(
      sorted([
        { issuerId: 1, name: 'Zanzibar', kind: 'modern', sortOrder: 1 },
        { issuerId: 2, name: 'Austria', kind: 'ancient', sortOrder: 9999 },
      ])
    ).toEqual(['Austria', 'Zanzibar']);
  });

  it('is total and stable when two names differ only in case', () => {
    // Case is folded, so these tie on name and the id decides.
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
    // Denominations within a group keep SortOrder order ('1 Franc' and '1 Euro' share FaceValue 1).
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
