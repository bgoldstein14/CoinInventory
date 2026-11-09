 /*
 * denomination-index.ts — asking `resolveDenomination` the same question
 * once per spreadsheet row without paying for it once per spreadsheet row
 *
 * WHAT THIS IS, AND WHAT IT IS CAREFULLY NOT
 *
 * *** THIS IS NOT A SECOND RESOLVER. *** Every answer below comes out of
 * `resolveDenomination` in denomination-resolution.ts, unchanged, which is
 * the single source of the matching rules for the editor, migration 014 and
 * now the importers. What this file adds is an INDEX over the lookup table
 * and nothing else. If you find yourself writing a comparison here, you are
 * writing the second vocabulary the design forbids -- stop.
 *
 * THE COST THIS EXISTS TO REMOVE
 *
 * `resolveDenomination`'s first act is to fold EVERY row it is given through
 * `denominationKey` and keep the ones matching the text's key. That is right
 * for one coin in an editor and ruinous for an import: the seed carries
 * 1,161 denominations (design §4.3), so a 2,000-row spreadsheet would cost
 * 2.3 million alias folds plus 2,000 reconstructions of a 61-entry issuer
 * map. The CSV preview re-plans on every change to the mapping grid, so that
 * is not a one-off at the moment the user presses Import; it is on the
 * keystroke path.
 *
 * So the folding is done ONCE per lookup array:
 *
 *     1,161 folds + 61 issuers, once
 *     per row: one fold of the row's own text, one Map lookup, and a
 *     resolution over the handful of rows that could possibly match.
 *
 * WHY HANDING OVER A SUBSET IS THE SAME QUESTION, NOT A CHEAPER ONE
 *
 * Two reductions, and both are exact rather than approximate. The sweep in
 * denomination-index.spec.ts runs the real authored seed through both paths
 * and asserts the id, the outcome AND the candidate list agree, because an
 * "optimisation" that quietly resolves differently from the editor is the
 * precise failure design §5 is written against.
 *
 *   THE ROWS. `resolveDenomination` keeps exactly the active rows whose
 *   label folds to the text's key. Filtering by that predicate twice is
 *   idempotent, so handing it the pre-filtered bucket leaves it looking at
 *   the identical set. (denomination-picker.ts makes the same argument for
 *   the same reason; it now shares this code rather than restating it.)
 *
 *   THE ISSUERS. The issuer list is used for ONE thing: a lookup of
 *   `row.issuerId` for each candidate row. An issuer no candidate points at
 *   is never queried, so passing only the issuers the bucket actually
 *   references cannot change an answer -- it only shrinks a Map the resolver
 *   rebuilds on every call.
 *
 * WHERE "ISSUER" COMES FROM
 *
 * The client does not have the Issuers table on the wire yet (§4.2 records
 * that as deliberate debt). Migration 013 inserts every seeded denomination
 * with `Country = COALESCE(Issuer.IsoCode, Issuer.Name)`, so the published
 * `Denominations.Country` column holds 'MX' for Mexico and 'Roman Empire'
 * for the Roman Empire, and the issuers are reconstructed from it here.
 *
 * *** THERE MUST BE EXACTLY ONE COPY OF THIS DERIVATION. *** Two copies is
 * not a tidiness problem: the editor would offer a coin a denomination the
 * importer declined to link it to, on the same data, with nothing failing
 * anywhere. The picker and the importers both read this one.
  */

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import { countryDisplayName } from '../coin-countries';
import {
  resolveDenomination,
  type DenominationMatch,
  type ResolverDenomination,
  type ResolverIssuer
} from './denomination-resolution';

/**
 * What the index needs of a lookup row.
 *
 * Structurally satisfied by `types/coin.model.ts`'s `Denomination` and by
 * the picker's `PickerDenomination`. Declared here so this module states its
 * own requirements rather than inheriting fields it does not read.
 */
export interface IndexableDenomination {
  denominationId: number;
  label: string;
  /** The issuer, as `Denominations.Country` spells it — 'US', 'Roman Empire'. */
  country: string;
  isActive: boolean;
}

/**
 * Every active row that folds to one alias key, with the issuers those rows
 * point at and nothing else. The unit `resolveDenomination` is handed.
 */
export interface DenominationAliasBucket {
  readonly candidates: readonly ResolverDenomination[];
  readonly issuers: readonly ResolverIssuer[];
}

export interface DenominationIndex<T extends IndexableDenomination = IndexableDenomination> {
  /**
   * Active rows by id. A retired row is absent, not present-and-flagged:
   * §4.4 soft-deletes, and a soft-deleted denomination must not be offered
   * by the picker or linked to by an import.
   */
  readonly activeById: ReadonlyMap<number, T>;
  /** Buckets by alias key. Absent means no row in the table names it. */
  readonly byAliasKey: ReadonlyMap<string, DenominationAliasBucket>;
  /** One synthetic issuer per distinct `Denominations.Country` value. */
  readonly issuers: readonly ResolverIssuer[];
}

/**
 * Keyed on the ARRAY IDENTITY of the lookup list.
 *
 * `InventoryService.denominations` is a signal holding one array per fetch,
 * so the index is rebuilt when the lookup is refreshed and never while an
 * import is running or a user is typing. A WeakMap, so a replaced lookup
 * list is collectable.
 */
const INDEX_CACHE = new WeakMap<readonly IndexableDenomination[], DenominationIndex<never>>();

function buildIndex<T extends IndexableDenomination>(
  rows: readonly T[]
): DenominationIndex<T> {
  const activeById = new Map<number, T>();
  const issuers: ResolverIssuer[] = [];
  const issuerIdByCountry = new Map<string, number>();
  const buckets = new Map<string, { candidates: ResolverDenomination[]; issuerIds: Set<number> }>();

  for (const row of rows) {
    if (!row.isActive) continue;

    activeById.set(row.denominationId, row);

    const country = String(row.country ?? '').trim();
    let issuerId = issuerIdByCountry.get(country);
    if (issuerId === undefined) {
      issuerId = issuers.length + 1;
      issuerIdByCountry.set(country, issuerId);
       /*
       * A TWO-LETTER VALUE IS A CODE; ANYTHING LONGER IS ALREADY A NAME.
       *
       * `Denominations.Country` holds `COALESCE(Issuer.IsoCode,
       * Issuer.Name)`, so 'US' is a code to be expanded and 'Confederate
       * States of America' is the issuer's Name, written there verbatim
       * because that issuer has no ISO code.
       *
       * *** THE LONG FORM MUST NOT GO THROUGH countryDisplayName. ***
       * That function is the QIF importer's country vocabulary, and it does
       * not merely tidy spellings: it RESOLVES a place to the modern country
       * that contains it -- 'United States' for 'Confederate States of
       * America', 'Spain' for 'Spanish Colonial', 'Great Britain' for
       * 'British Colonial'. Applying it here renames three issuers on top of
       * three others, and `resolveDenomination` then finds TWO in-country
       * rows for an ordinary '1¢' coin, which is rule 3's ambiguity, which
       * is a null id. Measured against the QIF corpus that costs 52 of 457
       * coins their link, while migration 014 -- which compares against the
       * real `Issuers.Name` -- links them all. The client and the migration
       * disagreeing about the same coin is precisely what design §5 exists
       * to prevent.
       *
       * So: expand a code, and leave a name exactly as the seed wrote it.
        */
      const isIsoCode = /^[A-Za-z]{2}$/.test(country);
      issuers.push({
        issuerId,
        name: isIsoCode ? (countryDisplayName(country) || country) : country,
        isoCode: isIsoCode ? country : null
      });
    }

    const key = denominationKey(row.label);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { candidates: [], issuerIds: new Set() };
      buckets.set(key, bucket);
    }
    bucket.candidates.push({
      denominationId: row.denominationId,
      issuerId,
      label: row.label,
      isActive: true
    });
    bucket.issuerIds.add(issuerId);
  }

  const byAliasKey = new Map<string, DenominationAliasBucket>();
  for (const [key, bucket] of buckets) {
    byAliasKey.set(key, {
      candidates: bucket.candidates,
      // Only the issuers these candidates point at. See the header for why
      // that cannot change an answer.
      issuers: issuers.filter(issuer => bucket.issuerIds.has(issuer.issuerId))
    });
  }

  return { activeById, byAliasKey, issuers };
}

/** The index for this lookup array, built once and remembered. */
export function denominationIndexFor<T extends IndexableDenomination>(
  rows: readonly T[]
): DenominationIndex<T> {
  const cached = INDEX_CACHE.get(rows);
  if (cached) return cached as unknown as DenominationIndex<T>;

  const index = buildIndex(rows);
  INDEX_CACHE.set(rows, index as unknown as DenominationIndex<never>);
  return index;
}

/**
 * `resolveDenomination`, asked through the index.
 *
 * Same arguments in the same order and the same `DenominationMatch` out --
 * including `outcome` and `candidateIds`, which the review tooling and the
 * import preview read. A bucket that does not exist is an empty candidate
 * list, which is exactly what the unfiltered call would have produced, so
 * 'unknown' still means "text was recorded and no row names it" and 'empty'
 * still means "nothing was recorded".
 */
export function resolveIndexedDenomination(
  recordedText: string | null | undefined,
  country: string | null | undefined,
  index: DenominationIndex
): DenominationMatch {
  const bucket = index.byAliasKey.get(denominationKey(String(recordedText ?? '')));
  return resolveDenomination(
    recordedText,
    country,
    bucket?.candidates ?? [],
    bucket?.issuers ?? []
  );
}

/**
 * THE ONE CALL EVERY IMPORTER MAKES: free text plus the coin's country in,
 * a `DenominationId` or null out.
 *
 * NULL IS A RESULT. IT IS NOT AN ERROR, A WARNING OR A REASON TO STOP.
 *
 * A QIF security reading `Trade Dollar`, or a column reading `8 Reales` that
 * six issuers could have struck, resolves to nothing. The coin imports with
 * its text and no link and reads `Other (Trade Dollar)` (§4.1). That text is
 * the only surviving record of what the file said, and a later, smarter
 * resolver -- or a user, in the editor -- can still act on it. An
 * importer that treated null as a problem would be reporting the normal case
 * as a fault several hundred times per file.
 *
 * PASS THE COIN'S OWN COUNTRY. NOT A CONSTANT, NOT THE FILE'S.
 *
 * The country scopes the search before it widens (`resolveDenomination`
 * rule 2), so getting it wrong silently changes which coins link. The
 * QIF-imported coins carry Country = 'United States' even for
 * Mexican pieces -- which is precisely why the resolver widens rather than
 * giving up, and precisely why feeding it a hard-coded 'United States' for
 * a row whose file DID say Mexico would throw away the one piece of
 * evidence that disambiguates six issuers.
 *
 * @param recordedText what the source said, exactly as it will be stored
 * @param country      the coin's country as the importer has it for THIS row
 * @param denominations the lookup list, straight from the denominations
 *   signal. An empty list -- the lookup has not arrived yet -- answers null
 *   for everything, which is the honest answer and not a failure.
 */
export function resolveDenominationId(
  recordedText: string | null | undefined,
  country: string | null | undefined,
  denominations: readonly IndexableDenomination[]
): number | null {
  if (denominations.length === 0) return null;
  return resolveIndexedDenomination(
    recordedText,
    country,
    denominationIndexFor(denominations)
  ).denominationId;
}
