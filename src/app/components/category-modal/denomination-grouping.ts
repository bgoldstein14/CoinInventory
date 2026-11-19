/*
 * Grouping and search for the Denominations pane.
 *
 * Search rules:
 * 1. Labels match as a substring across all issuers (labels repeat across issuers).
 * 2. An issuer name substring match brings the issuer's whole group.
 * 3. ISO codes match only exactly (two letters as a substring would hit everything).
 * 4. A matching issuer is shown even with no denominations, so a new issuer stays visible.
 *
 * Text is normalised (accents, case, whitespace) so 'ecu' finds 'Écu'. This is
 * plain matching, not an alias table; use `denominationKey` for aliases.
 */

import { IssuerKind } from '../../types/reference-data.model';

/**
 * The issuer fields grouping needs. Narrower than `IssuerRecord`, which
 * satisfies it structurally.
 */
export interface MaintenanceIssuer {
  issuerId: number;
  /** `Issuers.Name` — 'Mexico', 'Roman Empire', 'Great Britain'. */
  name: string;
  /** `Issuers.IsoCode` — null for ancients and most historical states. */
  isoCode?: string | null;
  kind: IssuerKind;
  /** Plain INT years. Negative means BC; null means open-ended. */
  validFrom?: number | null;
  validTo?: number | null;
  /** `Issuers.SortOrder`. Not used for group order, which is alphabetical. */
  sortOrder?: number;
  /** How many denominations point at it. Supplied by the server's count. */
  denominationCount?: number;
}

/** One row of `Denominations`, reduced to what this screen needs. */
export interface MaintenanceDenomination {
  denominationId: number;
  /** Null when the denomination was never attributed to an issuer. */
  issuerId: number | null;
  label: string;
  sortOrder?: number;
  /** How many coins carry this `DenominationId`. Counted by the server. */
  inUseCount?: number;
}

export interface DenominationGroup {
  /** Null for the catch-all group below. */
  issuer: MaintenanceIssuer | null;
  /** What the group heading says — the issuer's name, or the catch-all. */
  heading: string;
  denominations: MaintenanceDenomination[];
  /** Sum of `inUseCount` over the rows returned in this group. */
  inUseTotal: number;
  /** True when the issuer itself matched the search, not just its rows. */
  issuerMatched: boolean;
}

/**
 * Heading for denominations with no issuer, or an issuer id not in the list.
 * These are grouped rather than dropped so they can still be fixed.
 */
export const UNASSIGNED_ISSUER_HEADING = 'No issuer yet';

/**
 * Fold text for search comparison: NFD + strip combining marks, lower-case,
 * collapse whitespace. `\p{Mn}` covers non-Latin marks too (Greek, Cyrillic, Hebrew).
 */
export function normalizeSearchText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Name as a substring; ISO code compared whole. */
function issuerMatchesQuery(issuer: MaintenanceIssuer, query: string): boolean {
  if (normalizeSearchText(issuer.name).includes(query)) return true;
  return normalizeSearchText(issuer.isoCode) === query;
}

/**
 * Group order: issuer name A-Z, case-insensitive but accent-sensitive, with a
 * pinned 'en' locale so the order is the same on every machine. The id breaks
 * ties so the order is stable.
 */
export function compareIssuersByName(
  left: Pick<MaintenanceIssuer, 'issuerId' | 'name'>,
  right: Pick<MaintenanceIssuer, 'issuerId' | 'name'>
): number {
  const byName = left.name.localeCompare(right.name, 'en', { sensitivity: 'accent' });
  if (byName !== 0) return byName;
  return left.issuerId - right.issuerId;
}

/**
 * Row order within a group: SortOrder, then label. Not FaceValue, which isn't
 * comparable across currencies (e.g. '1 Franc' vs '1 Euro').
 */
function compareDenominations(left: MaintenanceDenomination, right: MaintenanceDenomination): number {
  const bySortOrder = (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
  if (bySortOrder !== 0) return bySortOrder;
  return left.label.localeCompare(right.label);
}

function totalInUse(rows: readonly MaintenanceDenomination[]): number {
  return rows.reduce((sum, row) => sum + (Number(row.inUseCount) || 0), 0);
}

/**
 * Group the denominations under their issuers, optionally filtered by search.
 * Inputs are copied before sorting because they are signal state.
 *
 * @param search free text. Blank, whitespace or absent means no filter.
 */
export function groupDenominations(
  denominations: readonly MaintenanceDenomination[],
  issuers: readonly MaintenanceIssuer[],
  search?: string | null
): DenominationGroup[] {
  const query = normalizeSearchText(search);
  const filtering = query.length > 0;

  const knownIssuerIds = new Set(issuers.map((issuer) => issuer.issuerId));
  const byIssuer = new Map<number, MaintenanceDenomination[]>();
  const unassigned: MaintenanceDenomination[] = [];

  for (const denomination of denominations) {
    const issuerId = denomination.issuerId;
    // An unknown issuer id is treated like null.
    if (issuerId === null || issuerId === undefined || !knownIssuerIds.has(issuerId)) {
      unassigned.push(denomination);
      continue;
    }
    const bucket = byIssuer.get(issuerId);
    if (bucket) bucket.push(denomination);
    else byIssuer.set(issuerId, [denomination]);
  }

  const groups: DenominationGroup[] = [];

  for (const issuer of [...issuers].sort(compareIssuersByName)) {
    const all = byIssuer.get(issuer.issuerId) ?? [];
    const issuerMatched = filtering ? issuerMatchesQuery(issuer, query) : false;

    // A matching issuer brings all its rows (rules 2 and 4); otherwise only matching rows.
    const rows = !filtering || issuerMatched
      ? [...all]
      : all.filter((row) => normalizeSearchText(row.label).includes(query));

    if (filtering && !issuerMatched && rows.length === 0) continue;

    rows.sort(compareDenominations);
    groups.push({
      issuer,
      heading: issuer.name,
      denominations: rows,
      inUseTotal: totalInUse(rows),
      issuerMatched,
    });
  }

  const unassignedRows = filtering
    ? unassigned.filter((row) => normalizeSearchText(row.label).includes(query))
    : [...unassigned];

  if (unassignedRows.length > 0) {
    unassignedRows.sort(compareDenominations);
    groups.push({
      issuer: null,
      heading: UNASSIGNED_ISSUER_HEADING,
      denominations: unassignedRows,
      inUseTotal: totalInUse(unassignedRows),
      issuerMatched: false,
    });
  }

  return groups;
}
