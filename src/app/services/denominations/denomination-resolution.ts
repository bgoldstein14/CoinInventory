 /*
 * denomination-resolution.ts — free text in, a DenominationId out (or null)
 *
 * WHAT THIS IS FOR
 *
 * Every denomination in this database arrived as a string: typed into the old
 * flat dropdown, written by the QIF importer, pasted into a CSV, or read off
 * a spreadsheet column. Migration 011 gives coins a `DenominationId`; this is
 * the one piece of logic that decides what that id should be for a given
 * string, and it is deliberately pure so it can be used by the migration's
 * review tooling, by the importers (design §6) and by the editor without any
 * of them re-deriving the rules.
 *
 * Background on why a coin carries two denomination fields, and why null is
 * a result rather than a failure, is in
 * docs/rationale/image-and-denominations.md.
 *
 * THE FOUR RULES, AND THE BUG EACH ONE PREVENTS
 *
 * 1. SPELLINGS FOLD THROUGH THE EXISTING ALIAS TABLE.
 *    `denominationKey` in components/coin-editor-form/denomination-aliases.ts
 *    already folds '3CS', 'Three Cent Silver' and 'Trime' onto one key, and
 *    already knows that the QIF importer writes '5s' where the lookup says
 *    '5/- (Crown)'. A second alias table here would be a second vocabulary to
 *    keep in step, and the two would diverge the first time either was
 *    edited — producing an editor and a migration that disagree about what
 *    the same coin is. It is reused, not copied, and it is NOT extended here:
 *    growing that table changes the editor's dropdown, which is a different
 *    piece of work with its own tests.
 *
 * 2. THE COIN'S COUNTRY IS A PREFERENCE, NOT A FILTER.
 *    The bug that prompted the whole design: the QIF parser never set a
 *    country, so Mexican 8-Reales coins are all stored as 'United States'.
 *    Scoping the search to the coin's country would resolve NOTHING for
 *    precisely the case this work exists to fix. So the country
 *    only breaks ties; when it matches nothing, the search widens to every
 *    issuer.
 *
 * 3. AMBIGUITY ANSWERS NULL.
 *    Great Britain and Australia both struck a Crown. A coin reading 'Crown'
 *    with a country that picks neither has no right answer, and inventing one
 *    files the coin under a country the owner never chose — invisibly, and
 *    for good. `Other (Crown)` is honest; the wrong issuer is not.
 *
 * 4. NOTHING MATCHED IS A RESULT, NOT A FAILURE.
 *    `outcome` distinguishes "nothing was recorded" from "something was
 *    recorded and no row names it", because migration 014's review report
 *    must list the second and must not drown the reader in the first.
 *
 * ON COMPARING COUNTRIES
 *
 * `Coins.Country` holds 'United States'; `Denominations.Country` holds 'US';
 * `Issuers` carries both a Name and an IsoCode. Rather than invent a third
 * vocabulary, this uses `isSameCountry` from services/coin-countries.ts,
 * which already resolves 'GB' and 'Great Britain' to one another and which
 * falls back to a plain text comparison for anything it has never heard of —
 * which is what makes 'Roman Empire' match 'Roman Empire' even though no
 * country list contains it.
 *
 * Note the asymmetry with migration 014, which is deliberate and documented
 * there: SQL cannot call this function, so the migration compares the coin's
 * country against the issuer's Name and IsoCode only. That is STRICTLY
 * NARROWER, so the migration can leave an id null that this function would
 * have set, and can never set one this function would not. Null is the
 * recoverable direction.
  */

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import { isSameCountry } from '../coin-countries';

/** One row of `Issuers`, reduced to what matching needs. */
export interface ResolverIssuer {
  issuerId: number;
  /** `Issuers.Name` — 'Mexico', 'Roman Empire', 'Great Britain'. */
  name: string;
  /** `Issuers.IsoCode` — 'MX'. Null for ancients and historical states. */
  isoCode?: string | null;
}

/** One row of `Denominations`, reduced to what matching needs. */
export interface ResolverDenomination {
  denominationId: number;
  /** Nullable: the column is nullable through the migration window (§4.2). */
  issuerId: number | null;
  label: string;
  /** Absent means active. Soft-deleted rows (§4.4) must not pull coins back. */
  isActive?: boolean;
}

/**
 * Why the resolution came out the way it did.
 *
 *   'in-country' — one row matched, under an issuer the coin's country names.
 *   'any-issuer' — the country matched no candidate, and widening the search
 *                  left exactly one. This is the 8-Reales case.
 *   'ambiguous'  — more than one row could be meant. Id is null by rule 3.
 *   'unknown'    — text was recorded and no row names it. Belongs in the
 *                  migration's review report.
 *   'empty'      — nothing was recorded. Does NOT belong in the report.
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
   * Every active row whose label folds to the same key as the text, whatever
   * the outcome. A report can say "ambiguous across 2 issuers" with this; a
   * future maintenance screen can offer them as choices.
   */
  candidateIds: readonly number[];
}

/** Rows with no explicit `isActive: false` are active. */
function isActive(row: ResolverDenomination): boolean {
  return row.isActive !== false;
}

/**
 * Does the coin's country spell this issuer's Name or IsoCode EXACTLY?
 *
 * Both spellings are tried because both are in live use: `Coins.Country`
 * says 'United States' and the legacy `Denominations.Country` says 'US'.
 * An issuer with no IsoCode -- every ancient -- is matched on its Name
 * alone, which is the only thing it has.
 *
 * Case-insensitive, because SQL Server's default collation is and this has
 * to mean the same thing on both sides of the wire.
 */
function issuerNamedExactly(issuer: ResolverIssuer, country: string): boolean {
  const folded = country.toLowerCase();
  if (issuer.name.toLowerCase() === folded) return true;
  const code = String(issuer.isoCode ?? '').trim().toLowerCase();
  return code.length > 0 && code === folded;
}

/**
 * Does the coin's country MEAN this issuer, allowing for spelling?
 *
 * `isSameCountry` resolves 'GB' and 'Great Britain' to one another and
 * carries seventy-odd patterns built for the QIF importer, so 'U.S.A.' and
 * 'British' land somewhere sensible. It falls back to a plain text
 * comparison for anything it has never heard of, which is what lets 'Roman
 * Empire' match 'Roman Empire' even though no country list contains it.
 */
function issuerMeansCountry(issuer: ResolverIssuer, country: string): boolean {
  if (isSameCountry(country, issuer.name)) return true;
  const code = String(issuer.isoCode ?? '').trim();
  return code.length > 0 && isSameCountry(country, code);
}

/**
 * Which denomination row, if any, is this stored string naming?
 *
 * @param recordedText `Coins.Denomination` exactly as stored
 * @param country      `Coins.Country` exactly as stored; may be absent
 * @param denominations every row of `Denominations` (inactive ones included;
 *                      they are filtered here so callers cannot forget to)
 * @param issuers       every row of `Issuers`
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
    // denominationKey folds to '' only for text that was blank to begin
    // with, which the guard above already caught. Kept so that a future
    // change to the folding cannot turn "nothing recorded" into "no row
    // names it" and flood the review report.
    return { denominationId: null, outcome: 'empty', candidateIds: [] };
  }

  const candidates = denominations.filter(
    (row) => isActive(row) && denominationKey(row.label) === key
  );
  const candidateIds = candidates.map((row) => row.denominationId);

  if (candidates.length === 0) {
    return { denominationId: null, outcome: 'unknown', candidateIds: [] };
  }

  /* ---- rule 2: the country gets first refusal ------------------------- */
  const countryText = String(country ?? '').trim();
  if (countryText.length > 0) {
    const issuerById = new Map(issuers.map((issuer) => [issuer.issuerId, issuer]));
    const scope = (test: (issuer: ResolverIssuer) => boolean): ResolverDenomination[] =>
      candidates.filter((row) => {
        if (row.issuerId === null) return false;
        const issuer = issuerById.get(row.issuerId);
        return issuer !== undefined && test(issuer);
      });

    /* AN EXACT NAME OR CODE MATCH IS THE WHOLE ANSWER WHEN THERE IS ONE,
     * and that is a deliberate ordering rather than an optimisation.
     *
     * Migration 014 has to answer this same question in T-SQL, which has no
     * access to `isSameCountry` and compares the country against the
     * issuer's Name and IsoCode and nothing else. Making the exact match
     * take precedence here means the migration's narrower rule is a SPECIAL
     * CASE of this one rather than a different rule: wherever the migration
     * finds an exact match, this function is looking at the same set.
     * Wherever it does not, this function may still find an issuer by
     * pattern and the migration leaves the id NULL -- the recoverable
     * direction. sql-denomination-resolution-parity.spec.ts sweeps the real
     * seed and asserts the migration never sets an id this would not.
     *
     * It is also simply the better answer. An issuer the user named
     * character for character outranks one a regular expression thinks it
     * recognises. */
    const exact = scope((issuer) => issuerNamedExactly(issuer, countryText));
    const inCountry = exact.length > 0 ? exact : scope((issuer) => issuerMeansCountry(issuer, countryText));

    if (inCountry.length === 1) {
      return { denominationId: inCountry[0].denominationId, outcome: 'in-country', candidateIds };
    }
    if (inCountry.length > 1) {
      // Two rows under ONE issuer folding to one key. The Settings dialog can
      // create this, and "take the first" would be a coin flip the user never
      // sees. Rule 3 applies inside an issuer exactly as it does across them.
      return { denominationId: null, outcome: 'ambiguous', candidateIds };
    }
    // Zero. Fall through and widen — NOT return null. This is the 8-Reales
    // case and it is the single most important line in the file.
  }

  /* ---- rule 2 continued: any issuer ----------------------------------- */
  if (candidates.length === 1) {
    return { denominationId: candidates[0].denominationId, outcome: 'any-issuer', candidateIds };
  }

  /* ---- rule 3 --------------------------------------------------------- */
  return { denominationId: null, outcome: 'ambiguous', candidateIds };
}
