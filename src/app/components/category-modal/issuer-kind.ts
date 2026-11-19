/*
 * Derives `Issuers.Kind` from the year span instead of asking for it:
 *
 *     ancient    := validFrom < 500
 *     historical := validTo is not null
 *     modern     := otherwise
 *
 * Ancient is tested first (the Byzantine Empire, 491-1453, is ancient).
 * An empty span yields null: new undated issuers become 'modern', while
 * edits keep the stored kind (e.g. British Colonial stays 'historical').
 *
 * The server has its own copy (server/routes/lookups/issuer-kind.ts), since
 * neither package can import the other; issuer-kind.spec.ts checks they match.
 */

import { IssuerKind } from '../../types/reference-data.model';

/** An issuer that began before this year is ancient (500 so Byzantium, from 491, counts). */
export const ANCIENT_BEFORE_YEAR = 500;

/** The kind a new issuer with no years is created as. */
export const UNDATED_ISSUER_KIND: IssuerKind = 'modern';

/**
 * The kind the year span implies, or null when both years are empty.
 * Callers resolve null with `resolveIssuerKind`.
 */
export function deriveIssuerKind(
  validFrom: number | null,
  validTo: number | null
): IssuerKind | null {
  // Ancient first: the Byzantine Empire (491-1453) has an end year and is still ancient.
  if (validFrom !== null && validFrom < ANCIENT_BEFORE_YEAR) return 'ancient';
  if (validTo !== null) return 'historical';
  if (validFrom !== null) return 'modern';
  return null;
}

/**
 * The kind to store: derived, else the stored kind, else the undated default.
 *
 * @param storedKind the row's current kind when editing; omit when creating.
 */
export function resolveIssuerKind(
  validFrom: number | null,
  validTo: number | null,
  storedKind: IssuerKind | null = null
): IssuerKind {
  return deriveIssuerKind(validFrom, validTo) ?? storedKind ?? UNDATED_ISSUER_KIND;
}
