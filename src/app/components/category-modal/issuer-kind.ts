/*
 * issuer-kind.ts — `Issuers.Kind` is DERIVED FROM THE YEAR SPAN, not asked for.
 *
 * WHY THE PICKER WENT
 *
 * `kind` drives no behaviour anywhere in this application. It is stored,
 * validated, and rendered as a tag beside the issuer's name. Nothing branches
 * on it: not the grid, not the reports, not resolution, not the editor's
 * dropdowns. It fed the seed's SortOrder bands (modern 100-420, historical
 * 1000-1150, ancient 2000-2120) and both issuer-shaped controls now sort A-Z
 * instead, so even that is gone.
 *
 * Asking the user to classify it was therefore asking them to restate, in a
 * vocabulary they have to learn, something the two year boxes beside the
 * picker already said. For an ancient city-state it was never a real
 * question: Miletos is a name and a span, and the span is what makes it
 * ancient.
 *
 * THE RULE, AND WHAT IT WAS MEASURED AGAINST
 *
 *     ancient    := validFrom < 500
 *     historical := validTo is not null
 *     modern     := otherwise
 *
 * Measured against the 62 issuers of the real seed
 * (server/migrations/seed-data/issuers-denominations.json) this reproduces
 * 61 of them exactly. issuer-kind.spec.ts re-measures that off disk, so the
 * claim cannot rot.
 *
 * THE ORDER OF THE BRANCHES IS LOAD-BEARING. The Byzantine Empire is
 * 491-1453: it has an end year, so a historical-first rule would call it
 * historical. Ancient is tested first, and 491 < 500 makes it ancient, which
 * is what the seed says and what a collector would say.
 *
 * THE ONE MISS, AND WHY IT IS THE INTERESTING CASE
 *
 * `British Colonial` is the single seeded issuer the rule does not
 * reproduce. It is a catch-all with NO DATES AT ALL — not a dated issuer —
 * and the seed files it as historical. It is the reason the rule needs a
 * defined answer for an empty span rather than an accident.
 *
 * SO THE EMPTY SPAN IS NOT FOLDED INTO "otherwise". `deriveIssuerKind`
 * returns NULL for it, meaning "the years say nothing", and the caller
 * decides:
 *
 *   * CREATING an issuer with no dates -> 'modern'. Of the 13 undated
 *     issuers in the seed, 12 are modern (Austria, Spain, Portugal,
 *     Denmark, Sweden, Norway, Russia, Poland, China, India, Brazil,
 *     Colombia). A user who types a name and no years is overwhelmingly
 *     adding a present-day country.
 *
 *   * EDITING one keeps the kind ALREADY STORED. This is what stops the
 *     13th — British Colonial — being silently rewritten to 'modern' the
 *     first time somebody opens it to fix a typo. Nothing about its years
 *     changed, so nothing about its kind should.
 *
 * Folding the empty span into 'modern' unconditionally would have been the
 * shorter rule and would have quietly destroyed a curated value on save.
 *
 * *** THIS RULE EXISTS TWICE. *** The server applies it on write
 * (server/routes/lookups/issuer-kind.ts) because the server is what the
 * column's NOT NULL answers to; this copy exists so the form can SHOW the
 * user what will be stored before they press Add. The server package cannot
 * import from src/ and this one cannot import from server/, which is the
 * same reason CATALOG_SEED exists four times. issuer-kind-parity.spec.ts
 * reads both files off disk and fails if the thresholds disagree.
 *
 * Pure and DOM-free, so it is testable under Node without jsdom.
 */

import { IssuerKind } from '../../types/reference-data.model';

/**
 * An issuer that began before this year is ancient.
 *
 * 500 and not 476 (the fall of the Western Empire) because the seed's own
 * Byzantine Empire starts at 491 and is filed as ancient. A threshold that
 * split those nine years would disagree with the data it was derived from.
 */
export const ANCIENT_BEFORE_YEAR = 500;

/**
 * What an issuer with NO years at all is created as.
 *
 * 12 of the seed's 13 undated issuers are modern. See the header for the
 * 13th and for why editing does not use this.
 */
export const UNDATED_ISSUER_KIND: IssuerKind = 'modern';

/**
 * The kind the year span implies, or NULL when the span is empty.
 *
 * Null is not a failure. It means the two year boxes contain no information
 * about this issuer, which is a legal and permanent state for a catch-all
 * like `British Colonial`. Callers resolve it with `resolveIssuerKind`.
 */
export function deriveIssuerKind(
  validFrom: number | null,
  validTo: number | null
): IssuerKind | null {
  // Ancient FIRST. The Byzantine Empire (491-1453) has an end year and is
  // still ancient; testing historical first would mislabel it.
  if (validFrom !== null && validFrom < ANCIENT_BEFORE_YEAR) return 'ancient';
  if (validTo !== null) return 'historical';
  if (validFrom !== null) return 'modern';
  return null;
}

/**
 * The kind to STORE: the derived one, else the one already stored, else the
 * default for an undated issuer.
 *
 * @param storedKind the value currently on the row, when editing one. Omit
 *   it (or pass null) when creating, which is what makes a new undated
 *   issuer 'modern' and an edited `British Colonial` stay 'historical'.
 */
export function resolveIssuerKind(
  validFrom: number | null,
  validTo: number | null,
  storedKind: IssuerKind | null = null
): IssuerKind {
  return deriveIssuerKind(validFrom, validTo) ?? storedKind ?? UNDATED_ISSUER_KIND;
}
