/*
 * Issuers.Kind is derived from the year span rather than supplied:
 *
 *     ancient    := validFrom < 500
 *     historical := validTo is not null
 *     modern     := otherwise
 *
 * This reproduces all but one seeded issuer (issuer-kind.spec.ts checks
 * against the seed file). Ancient is tested first so the Byzantine Empire
 * (491-1453) is ancient. An empty span returns null and resolveIssuerKind()
 * decides: 'modern' for a new issuer, the stored value when editing (so the
 * undated, curated-historical British Colonial is preserved).
 *
 * src/app/components/category-modal/issuer-kind.ts is a client copy used to
 * preview the result; issuer-kind-parity.spec.ts checks the thresholds match.
 */

/** The three values `Issuers.Kind` is allowed to hold. */
export const ISSUER_KINDS = ['modern', 'historical', 'ancient'] as const;

export type IssuerKind = (typeof ISSUER_KINDS)[number];

/** An issuer that began before this year is ancient (500 so the seed's Byzantine Empire, from 491, counts). */
export const ANCIENT_BEFORE_YEAR = 500;

/** What an issuer with no years is created as. Edits keep the stored kind. */
export const UNDATED_ISSUER_KIND: IssuerKind = 'modern';

export function isIssuerKind(value: unknown): value is IssuerKind {
  return typeof value === 'string' && (ISSUER_KINDS as readonly string[]).includes(value);
}

/** The kind the year span implies, or null when the span is empty (legal for a catch-all). */
export function deriveIssuerKind(
  validFrom: number | null,
  validTo: number | null
): IssuerKind | null {
  // Ancient first (see the header).
  if (validFrom !== null && validFrom < ANCIENT_BEFORE_YEAR) return 'ancient';
  if (validTo !== null) return 'historical';
  if (validFrom !== null) return 'modern';
  return null;
}

/**
 * The kind to store: derived, else the row's current kind, else the default.
 *
 * @param storedKind the row's current Kind when updating; null when inserting.
 */
export function resolveIssuerKind(
  validFrom: number | null,
  validTo: number | null,
  storedKind: IssuerKind | null = null
): IssuerKind {
  return deriveIssuerKind(validFrom, validTo) ?? storedKind ?? UNDATED_ISSUER_KIND;
}
