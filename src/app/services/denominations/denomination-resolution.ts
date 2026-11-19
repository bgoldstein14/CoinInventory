 /*
  * Free text in, a DenominationId (or null) out. The single place the matching
  * rules live, shared by the editor, the importers (design §6) and migration
  * 014's review tooling. Pure. Background: docs/rationale/image-and-denominations.md.
  *
  * Rules:
  * 1. Spellings fold through the existing alias table (`denominationKey` in
  *    components/coin-editor-form/denomination-aliases.ts): '3CS', 'Three Cent
  *    Silver' and 'Trime' share a key; '5s' matches '5/- (Crown)'. Reuse it; don't
  *    add a second table (extending it changes the editor dropdown too).
  * 2. The coin's country is a preference, not a filter. QIF-imported coins are
  *    all 'United States' (including Mexican 8 Reales), so when the country
  *    matches no candidate the search widens to every issuer.
  * 3. Ambiguity answers null. 'Crown' with a country that picks neither GB nor
  *    Australia stays unlinked and displays `Other (Crown)`.
  * 4. No match is a result: `outcome` separates "nothing recorded" from
  *    "recorded but no row names it" (the latter goes in the review report).
  *
  * Countries are compared with `isSameCountry` (coin-countries.ts), which maps
  * 'GB' to 'Great Britain' and falls back to plain text ('Roman Empire').
  * Migration 014 can only compare exactly against the issuer's Name and IsoCode,
  * which is strictly narrower: it may leave an id null that this sets, never the
  * reverse.
  */

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import { isSameCountry } from '../coin-countries';

/** One row of `Issuers`, reduced to what matching needs. */
export interface ResolverIssuer {
  issuerId: number;
  /** `Issuers.Name`: 'Mexico', 'Roman Empire', 'Great Britain'. */
  name: string;
  /** `Issuers.IsoCode`: 'MX'. Null for ancients and historical states. */
  isoCode?: string | null;
}

/** One row of `Denominations`, reduced to what matching needs. */
export interface ResolverDenomination {
  denominationId: number;
  /** Nullable during the migration window (§4.2). */
  issuerId: number | null;
  label: string;
  /** Absent means active. Soft-deleted rows (§4.4) are never matched. */
  isActive?: boolean;
}

/**
 * Why the resolution came out as it did:
 *   'in-country'  one row matched under an issuer the coin's country names
 *   'any-issuer'  the country matched nothing; widening left exactly one (the 8 Reales case)
 *   'ambiguous'   more than one row could be meant; id is null
 *   'unknown'     text was recorded and no row names it (for the review report)
 *   'empty'       nothing was recorded (not for the report)
 */
export type DenominationMatchOutcome =
  | 'in-country'
  | 'any-issuer'
  | 'ambiguous'
  | 'unknown'
  | 'empty';

export interface DenominationMatch {
  /** The resolved `Denominations.DenominationId`, or null. Never a guess. */
  denominationId: number | null;
  outcome: DenominationMatchOutcome;
  /**
   * Every active row whose label folds to the text's key, whatever the outcome
   * (e.g. "ambiguous across 2 issuers").
   */
  candidateIds: readonly number[];
}

/** Rows with no explicit `isActive: false` are active. */
function isActive(row: ResolverDenomination): boolean {
  return row.isActive !== false;
}

/**
 * Whether the coin's country spells this issuer's Name or IsoCode exactly
 * ('United States' / 'US'). Issuers without an IsoCode (ancients) match on Name.
 * Case-insensitive, matching SQL Server's default collation.
 */
function issuerNamedExactly(issuer: ResolverIssuer, country: string): boolean {
  const folded = country.toLowerCase();
  if (issuer.name.toLowerCase() === folded) return true;
  const code = String(issuer.isoCode ?? '').trim().toLowerCase();
  return code.length > 0 && code === folded;
}

/**
 * Whether the coin's country means this issuer, allowing for spelling, via
 * `isSameCountry` ('GB' = 'Great Britain', 'U.S.A.', 'British'); unknown names
 * compare as plain text.
 */
function issuerMeansCountry(issuer: ResolverIssuer, country: string): boolean {
  if (isSameCountry(country, issuer.name)) return true;
  const code = String(issuer.isoCode ?? '').trim();
  return code.length > 0 && isSameCountry(country, code);
}

/**
 * Which denomination row, if any, a stored string names.
 *
 * @param recordedText `Coins.Denomination` as stored
 * @param country      `Coins.Country` as stored; may be absent
 * @param denominations every `Denominations` row (inactive ones are filtered here)
 * @param issuers       every `Issuers` row
 */
export function resolveDenomination(
  recordedText: string | null | undefined,
  country: string | null | undefined,
  denominations: readonly ResolverDenomination[],
  issuers: readonly ResolverIssuer[]
): DenominationMatch {
  const text = String(recordedText ?? '').trim();
  if (text.length === 0) {
    return { denominationId: null, outcome: 'empty', candidateIds: [] };
  }

  const key = denominationKey(text);
  if (!key) {
    // Unreachable today (blank text is caught above); kept so a change to the
    // folding can't turn "nothing recorded" into "unknown".
    return { denominationId: null, outcome: 'empty', candidateIds: [] };
  }

  const candidates = denominations.filter(
    (row) => isActive(row) && denominationKey(row.label) === key
  );
  const candidateIds = candidates.map((row) => row.denominationId);

  if (candidates.length === 0) {
    return { denominationId: null, outcome: 'unknown', candidateIds: [] };
  }

  /* Rule 2: the country gets first refusal */
  const countryText = String(country ?? '').trim();
  if (countryText.length > 0) {
    const issuerById = new Map(issuers.map((issuer) => [issuer.issuerId, issuer]));
    const scope = (test: (issuer: ResolverIssuer) => boolean): ResolverDenomination[] =>
      candidates.filter((row) => {
        if (row.issuerId === null) return false;
        const issuer = issuerById.get(row.issuerId);
        return issuer !== undefined && test(issuer);
      });

    /* An exact Name/IsoCode match takes precedence. This makes migration 014's
     * exact-only comparison a special case of this rule (see
     * sql-denomination-resolution-parity.spec.ts), and a name typed exactly
     * outranks a pattern match. */
    const exact = scope((issuer) => issuerNamedExactly(issuer, countryText));
    const inCountry = exact.length > 0 ? exact : scope((issuer) => issuerMeansCountry(issuer, countryText));

    if (inCountry.length === 1) {
      return { denominationId: inCountry[0].denominationId, outcome: 'in-country', candidateIds };
    }
    if (inCountry.length > 1) {
      // Two rows under one issuer with the same key (possible via Settings): ambiguous.
      return { denominationId: null, outcome: 'ambiguous', candidateIds };
    }
    // No in-country match: widen rather than return null (the 8 Reales case).
  }

  /* Rule 2 continued: any issuer */
  if (candidates.length === 1) {
    return { denominationId: candidates[0].denominationId, outcome: 'any-issuer', candidateIds };
  }

  /* Rule 3 */
  return { denominationId: null, outcome: 'ambiguous', candidateIds };
}
