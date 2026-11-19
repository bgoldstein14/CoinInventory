/*
 * Wire shapes for the reference-data maintenance screen. Shared by
 * services/api.service.ts and components/category-modal/, so they live here
 * rather than in a component folder.
 *
 * Mirrors the tables from migrations/011-add-issuers-and-denomination-links.sql.
 * Nullable columns are `| null`, not optional.
 */

/**
 * `Issuers.Kind NVARCHAR(20)`. The column has no CHECK constraint, so the
 * allowed values are enforced here.
 */
export type IssuerKind = 'modern' | 'historical' | 'ancient';

/**
 * The column's allowed values, for validation. The form derives the kind from
 * the year span (components/category-modal/issuer-kind.ts) rather than offering a picker.
 */
export const ISSUER_KINDS: readonly IssuerKind[] = ['modern', 'historical', 'ancient'] as const;

/** `Issuers.Name NVARCHAR(100)`. The input caps itself at the same number. */
export const ISSUER_NAME_MAX_LENGTH = 100;

/**
 * One row of `Issuers` as `GET /api/issuers` returns it. The counts are computed
 * by the endpoint so the screen can show what removal would affect.
 */
export interface IssuerRecord {
  issuerId: number;
  name: string;
  /** Null for every ancient and most historical states, permanently. */
  isoCode: string | null;
  kind: IssuerKind;
  /** Plain INT years; negative means BC (Roman Republic starts at -509). */
  validFrom: number | null;
  validTo: number | null;
  sortOrder: number;
  /** How many active denominations are filed under this issuer. */
  denominationCount: number;
  /** How many coins carry one of those denominations. */
  coinCount: number;
  isActive: boolean;
}

/**
 * Body for `POST /api/issuers`. No `kind`: the server derives it from the
 * year span (server/routes/lookups/issuer-kind.ts).
 */
export interface NewIssuer {
  name: string;
  isoCode: string | null;
  validFrom: number | null;
  validTo: number | null;
}

/**
 * Response from `POST /api/issuers`. Removal is a soft delete, so re-adding a
 * removed name revives the existing row (same id) instead of inserting.
 */
export interface IssuerCreationResult extends IssuerRecord {
  /** True when a soft-deleted row was revived; absent on a plain creation. */
  revived?: boolean;
  /**
   * How many of its denominations came back with it. Zero means the issuer is
   * back but empty, which also triggers the online denomination lookup.
   */
  denominationsRestored?: number;
}

/**
 * What `DELETE /api/issuers/:id` actually did. The removal cascades to the
 * issuer's denominations and clears `DenominationId` on their coins
 * (`Coins.Denomination` text is kept). Counts come from the transaction.
 */
export interface IssuerRemovalResult {
  issuerId: number;
  denominationsRemoved: number;
  coinsUnlinked: number;
}

/**
 * Outcome of `GET /api/denomination-lookup`.
 *
 *   results      candidates came back
 *   none         the source had nothing (common for ancient/small issuers)
 *   unavailable  no network, a timeout, or the endpoint refused
 */
export type DenominationLookupOutcome = 'results' | 'none' | 'unavailable';

/** One denomination lookup's answer. */
export interface DenominationLookupResult {
  outcome: DenominationLookupOutcome;
  /** What to call the source on screen, e.g. 'Wikidata'. */
  source: string;
  /** Candidate labels; proposals only, nothing is written from these. */
  proposals: string[];
  /** Why it was unavailable, for the one-line message. Never an error. */
  reason: string | null;
}

/**
 * Key -> coin count. Keys are always strings, even for ids, because the
 * round trip through JSON and `Object.keys` yields strings.
 */
export type UsageIndex = Record<string, number>;

/**
 * `GET /api/reference-usage`: one index per type. Categories, sets, mint marks
 * (by label) and metals are keyed by the text the coin stores; denominations
 * and catalogues by id.
 */
export interface ReferenceUsageCounts {
  categories: UsageIndex;
  coinSets: UsageIndex;
  denominations: UsageIndex;
  mintMarks: UsageIndex;
  catalogs: UsageIndex;
  /** Keyed by metal name. Not a foreign key, so removing a metal leaves coin text unchanged. */
  metalContents: UsageIndex;
}
