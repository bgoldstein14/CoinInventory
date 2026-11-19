 /*
  * An index over the denominations lookup so `resolveDenomination` can be asked
  * once per import row cheaply. It is not a second resolver: every answer comes
  * from `resolveDenomination` (denomination-resolution.ts); don't add matching
  * rules here.
  *
  * `resolveDenomination` folds every row it is given through `denominationKey`.
  * With ~1,161 denominations and a 2,000-row sheet that is millions of folds,
  * and the CSV preview re-plans on every mapping change. So the folding is done
  * once per lookup array; each row then costs one fold, one Map lookup and a
  * resolution over its few candidates.
  *
  * The reduced input gives identical answers (denomination-index.spec.ts sweeps
  * the seed through both paths):
  * - Rows: the bucket is exactly the active rows whose label folds to the key,
  *   the same filter the resolver applies (also used by denomination-picker.ts).
  * - Issuers: only used to look up candidates' `issuerId`, so passing just the
  *   issuers the bucket references changes nothing.
  *
  * Issuers aren't sent to the client yet (§4.2), so they are reconstructed from
  * `Denominations.Country`, which migration 013 fills with
  * `COALESCE(Issuer.IsoCode, Issuer.Name)` ('MX', 'Roman Empire'). The editor's
  * picker and the importers must share this single derivation.
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
 * What the index needs of a lookup row; satisfied by `Denomination`
 * (types/coin.model.ts) and `PickerDenomination`.
 */
export interface IndexableDenomination {
  denominationId: number;
  label: string;
  /** The issuer as `Denominations.Country` spells it: 'US', 'Roman Empire'. */
  country: string;
  isActive: boolean;
}

/**
 * Every active row that folds to one alias key, plus only the issuers those
 * rows reference: the input handed to `resolveDenomination`.
 */
export interface DenominationAliasBucket {
  readonly candidates: readonly ResolverDenomination[];
  readonly issuers: readonly ResolverIssuer[];
}

export interface DenominationIndex<T extends IndexableDenomination = IndexableDenomination> {
  /** Active rows by id; soft-deleted rows (§4.4) are absent. */
  readonly activeById: ReadonlyMap<number, T>;
  /** Buckets by alias key; absent means no row names it. */
  readonly byAliasKey: ReadonlyMap<string, DenominationAliasBucket>;
  /** One synthetic issuer per distinct `Denominations.Country` value. */
  readonly issuers: readonly ResolverIssuer[];
}

/**
 * Cache keyed on the lookup array's identity. `InventoryService.denominations`
 * holds one array per fetch, so the index is rebuilt only when the lookup is
 * refreshed. A WeakMap, so replaced arrays can be collected.
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
        * A two-letter value is an ISO code; anything longer is the issuer's own name
        * (e.g. 'Confederate States of America') and is kept exactly as written.
        * Don't pass names through countryDisplayName: it maps places to modern
        * countries ('Confederate States of America' -> 'United States'), which would
        * merge issuers, make ordinary coins ambiguous, and disagree with migration 014.
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
      // Only the issuers these candidates reference.
      issuers: issuers.filter(issuer => bucket.issuerIds.has(issuer.issuerId))
    });
  }

  return { activeById, byAliasKey, issuers };
}

/** The index for this lookup array, built once and cached. */
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
 * `resolveDenomination` through the index: same arguments, same
 * `DenominationMatch` (including `outcome` and `candidateIds`). A missing
 * bucket gives an empty candidate list, as the unfiltered call would.
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
 * The call every importer makes: free text plus the coin's country in, a
 * `DenominationId` or null out.
 *
 * Null is a normal result, not an error: the coin imports with its text and
 * displays e.g. `Other (Trade Dollar)` (§4.1).
 *
 * Pass the row's own country, not a constant: the country scopes the search
 * before it widens (`resolveDenomination` rule 2), so it decides which coins link.
 *
 * @param recordedText what the source said, exactly as stored
 * @param country      this row's country as the importer has it
 * @param denominations the lookup list from the denominations signal; empty
 *   (not loaded yet) answers null for everything
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
