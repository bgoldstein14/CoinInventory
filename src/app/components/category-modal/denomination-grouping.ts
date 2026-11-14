/*
 * denomination-grouping.ts — over a thousand denominations made navigable.
 *
 * The pane groups by issuer and offers search. Both live here rather than in
 * the component because the component cannot be tested: this project's
 * frontend suite runs under Node with no jsdom, so anything that matters has
 * to be reachable without rendering.
 *
 * THE FOUR SEARCH RULES, AND THE BUG EACH ONE PREVENTS
 *
 * 1. A LABEL MATCHES AS A SUBSTRING, ANYWHERE, ACROSS ALL ISSUERS.
 *    Two different issuers can carry the same label — Mexico and Spanish
 *    Colonial both have an "8 Reales" — and they are different reference
 *    rows. A search scoped to one issuer would hide the one the user wants
 *    and invite them to link coins to the wrong row.
 *
 * 2. AN ISSUER NAME MATCHES AS A SUBSTRING, AND BRINGS ITS WHOLE GROUP.
 *    "mexico" appears in none of Mexico's labels. Matching labels only would
 *    answer "nothing found" to the most natural thing a user can type on a
 *    screen whose headings are issuer names.
 *
 * 3. AN ISO CODE MATCHES ONLY EXACTLY.
 *    As a substring, two letters hit everything: `us` is inside "Russia",
 *    `in` inside "China" and "Argentina". The code is something the user
 *    types deliberately and in full, so it is compared in full. Names stay
 *    substring-matched, so incidental hits are still possible there — but
 *    those are visible and explicable, which a silent flood of ISO noise is
 *    not.
 *
 * 4. AN ISSUER THAT MATCHED IS SHOWN EVEN WITH NO DENOMINATIONS.
 *    A freshly added issuer has none yet. Hiding the empty group would hide
 *    the issuer the user just created, along with the Add control under it.
 *
 * WHY TEXT IS NORMALISED RATHER THAN COMPARED RAW
 * The reference data contains `Écu`, `Øre` and `25¢`. A raw `includes()`
 * means a user with a UK keyboard cannot find the accented ones at all.
 * Accents are folded through NFD, case is folded, and runs of whitespace
 * collapse so that "8   reales" pasted out of a spreadsheet still matches.
 *
 * THIS IS NOT, AND MUST NOT BECOME, A SECOND ALIAS TABLE.
 * `denominationKey` in coin-editor-form/denomination-aliases.ts already folds
 * '3CS' onto '3¢ Silver', and services/denominations/denomination-resolution.ts
 * reuses it rather than copying it, because two vocabularies diverge the
 * first time either is edited. This module does plain substring matching on
 * normalised text and nothing cleverer. If search needs to understand
 * aliases, it should call that function — not grow its own list here.
 */

import { IssuerKind } from '../../types/reference-data.model';

/**
 * One row of `Issuers`, reduced to WHAT GROUPING NEEDS and nothing more.
 *
 * Deliberately narrower than `IssuerRecord`: this module should still work
 * when handed a half-built issuer from an add form, and a test fixture
 * should not have to invent a `coinCount` to exercise a sort order.
 * `IssuerRecord` satisfies it structurally, so callers pass theirs straight
 * in.
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
  /**
   * `Issuers.SortOrder`. Carried because the wire carries it, NOT because
   * this module reads it: group order is alphabetical (see
   * `compareIssuersByName`). Denomination order within a group still uses
   * the denomination's own sortOrder.
   */
  sortOrder?: number;
  /** How many denominations point at it. Supplied by the server's count. */
  denominationCount?: number;
}

/** One row of `Denominations`, reduced to what this screen needs. */
export interface MaintenanceDenomination {
  denominationId: number;
  /**
   * Nullable, and that is an ordinary state rather than a defect: the column
   * is nullable and a denomination that was never attributed to an issuer
   * still has none.
   */
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
  /** Sum of `inUseCount` over the rows IN THIS GROUP AS RETURNED. */
  inUseTotal: number;
  /** True when the issuer itself matched the search, not just its rows. */
  issuerMatched: boolean;
}

/**
 * The heading for denominations whose issuer is null — or whose issuer id
 * names a row that is not in the list we were handed.
 *
 * Both cases go here rather than being dropped. A row that vanishes from the
 * only screen that could fix it is unfixable, and "I cannot find 8 Reales
 * any more" is a far worse bug than an extra heading at the bottom.
 */
export const UNASSIGNED_ISSUER_HEADING = 'No issuer yet';

/**
 * Fold text to the form both sides of a search comparison use.
 *
 * NFD splits 'É' into 'E' + a combining acute, and `\p{Mn}` (Unicode
 * Nonspacing_Mark) then removes every such mark, so 'Écu' and 'ecu' meet in
 * the middle. Lower-casing happens after the fold because some locales'
 * upper-case forms carry marks of their own.
 *
 * `\p{Mn}` rather than the `[̀-ͯ]` range that is usually written
 * here: the range covers Latin diacritics only, and the seed contains Greek,
 * Hebrew and Cyrillic issuers whose marks live elsewhere in Unicode. It also
 * keeps the source free of literal combining characters, which are invisible
 * in an editor and get silently mangled by anything that re-encodes a file.
 */
export function normalizeSearchText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Rule 3: the two-letter code is compared whole, never as a substring. */
function issuerMatchesQuery(issuer: MaintenanceIssuer, query: string): boolean {
  if (normalizeSearchText(issuer.name).includes(query)) return true;
  return normalizeSearchText(issuer.isoCode) === query;
}

/**
 * Group order: THE ISSUER'S NAME, A-Z, case-insensitively.
 *
 * *** NOT SortOrder, AND THAT IS THE WHOLE POINT. *** The seed numbers its
 * issuers in bands — modern 100-420, historical 1000-1150, ancient
 * 2000-2120 — which is a curator's order, not an order anybody can search
 * by eye. Sixty-two headings in that order means scrolling to find
 * 'Portugal' because it happens to sit between Spain and Italy. The owner
 * asked for alphabetical and alphabetical is what a list of this length
 * needs.
 *
 * SortOrder HAS NOT STOPPED MATTERING. It still orders the denominations
 * WITHIN each group (see compareDenominations, which is deliberately
 * untouched), it is still what POST /issuers computes as MAX + 10, and it
 * is still carried on the wire. It simply no longer decides which heading
 * comes first.
 *
 * `sensitivity: 'accent'` folds case but NOT accents, which is exactly
 * "case-insensitive": 'austria' and 'Austria' tie, while 'Württemberg'
 * keeps its own place rather than being silently merged with a
 * hypothetical 'Wurttemberg'. The locale is pinned to 'en' rather than
 * left to the host so that the order a test asserts is the order the user
 * sees, on any machine.
 *
 * The id breaks the tie, which makes the order TOTAL. Without it two
 * issuers whose names differ only in case — which UQ_Issuers_Name allows
 * through only in theory, but a half-built draft row allows in practice —
 * would compare equal and could swap places between renders.
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
 * Row order within a group: SortOrder, then label.
 *
 * SortOrder and not FaceValue, deliberately: France carries both '1 Franc'
 * and '1 Euro' at FaceValue 1, which are not the same amount of anything, so
 * a face-value sort scrambles any issuer that changed currency. The label
 * tiebreak makes the order total,
 * which matters because a user's own additions all arrive with the same
 * computed SortOrder and an unstable sort would shuffle them between
 * renders.
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
 * Group the denominations under their issuers, optionally filtered.
 *
 * Neither argument is mutated: both are copied before sorting. That is not
 * defensive habit — the arrays handed in are component state read straight
 * out of signals, and sorting one in place reorders what every other reader
 * of that signal sees, intermittently, depending on who rendered first.
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
    // An id that names no issuer we were given is treated exactly like a
    // null one. See UNASSIGNED_ISSUER_HEADING for why it is not dropped.
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

    // Rule 2 / rule 4: a matching issuer brings everything it has, including
    // nothing at all. Otherwise only the rows that matched survive.
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
