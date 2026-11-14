/*
 * routes/lookups/issuer-kind.ts — `Issuers.Kind` is DERIVED, not supplied.
 *
 * The form no longer asks for it. `kind` drives no behaviour anywhere in the
 * application — it is stored, validated, and rendered as a tag — and the
 * year span the form already collects carries the same information:
 *
 *     ancient    := validFrom < 500
 *     historical := validTo is not null
 *     modern     := otherwise
 *
 * Measured against the 62 issuers of the real seed
 * (migrations/seed-data/issuers-denominations.json) this reproduces 61 of
 * them exactly. issuer-kind.spec.ts re-measures that off disk, against the
 * seed file itself, so the claim cannot quietly stop being true.
 *
 * THE ORDER OF THE BRANCHES IS LOAD-BEARING. The Byzantine Empire is
 * 491-1453: it has an end year, so a historical-first rule would call it
 * historical. Ancient is tested first and 491 < 500 makes it ancient, which
 * is both what the seed says and what a collector would say.
 *
 * THE EMPTY SPAN IS A SEPARATE ANSWER, NOT "otherwise"
 *
 * `British Colonial` is the single seeded issuer the rule does not
 * reproduce. It is a catch-all with NO DATES AT ALL and the seed files it as
 * historical. So `deriveIssuerKind` returns NULL for an empty span -- "the
 * years say nothing" -- and `resolveIssuerKind` decides:
 *
 *   POST  (no row yet)     -> 'modern'. 12 of the seed's 13 undated issuers
 *                             are modern; a user who types a name and no
 *                             years is adding a present-day country.
 *   PUT   (a row exists)   -> KEEP WHAT IS STORED. This is what stops
 *                             British Colonial being silently rewritten to
 *                             'modern' the first time somebody opens it to
 *                             fix a typo. Its years did not change, so its
 *                             kind must not.
 *
 * Folding the empty span into 'modern' unconditionally would have been the
 * shorter rule and would have destroyed a curated value on save.
 *
 * *** THIS RULE EXISTS TWICE. *** This copy is the one that decides what
 * goes in the column; src/app/components/category-modal/issuer-kind.ts is a
 * copy so the form can SHOW the user what will be stored before they press
 * Add. The server package cannot import from src/ and src/ cannot import
 * from here -- the same reason CATALOG_SEED exists four times.
 * src/app/components/category-modal/issuer-kind-parity.spec.ts reads both
 * files off disk and fails if the thresholds disagree.
 */

/** The three values `Issuers.Kind` is allowed to hold. */
export const ISSUER_KINDS = ['modern', 'historical', 'ancient'] as const;

export type IssuerKind = (typeof ISSUER_KINDS)[number];

/**
 * An issuer that began before this year is ancient.
 *
 * 500 and not 476 (the fall of the Western Empire) because the seed's own
 * Byzantine Empire starts at 491 and is filed as ancient. A threshold that
 * split those nine years would disagree with the data it came from.
 */
export const ANCIENT_BEFORE_YEAR = 500;

/**
 * What an issuer with NO years at all is CREATED as. Editing one does not
 * use this; see the header.
 */
export const UNDATED_ISSUER_KIND: IssuerKind = 'modern';

export function isIssuerKind(value: unknown): value is IssuerKind {
  return typeof value === 'string' && (ISSUER_KINDS as readonly string[]).includes(value);
}

/**
 * The kind the year span implies, or NULL when the span is empty.
 *
 * Null is not a failure. It means the two year columns carry no information
 * about this issuer, which is a legal and permanent state for a catch-all.
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
 * The kind to STORE: the derived one, else the one already on the row, else
 * the default for an undated issuer.
 *
 * @param storedKind the row's current Kind, when updating one. Null when
 *   inserting, which is what makes a new undated issuer 'modern' and an
 *   edited `British Colonial` stay 'historical'.
 */
export function resolveIssuerKind(
  validFrom: number | null,
  validTo: number | null,
  storedKind: IssuerKind | null = null
): IssuerKind {
  return deriveIssuerKind(validFrom, validTo) ?? storedKind ?? UNDATED_ISSUER_KIND;
}
