/*
 * reference-data.model.ts — the wire shapes the maintenance screen reads
 * WHY A TYPES FILE AND NOT A DECLARATION BESIDE EACH USE
 * Two unrelated layers need these shapes — `services/api.service.ts`, which
 * fetches them, and the pure modules under `components/category-modal/`,
 * which group, count and validate them. Declaring them in the component
 * folder would make ApiService import from a component, which is backwards;
 * declaring them twice would make the HTTP layer and the screen disagree the
 * first time either is edited, silently, because TypeScript is structural
 * and two compatible-today shapes compile fine right up until they are not.
 *
 * Everything here mirrors a table created by
 * migrations/011-add-issuers-and-denomination-links.sql. Where a column is
 * nullable, the field is `| null` rather than optional: `undefined` and
 * `null` would then be two spellings of the same absence and every reader
 * would have to handle both.
 */

/**
 * `Issuers.Kind NVARCHAR(20)`.
 *
 * Three values, enumerated here rather than left as a string, because the UI
 * switches on them and the column has NO CHECK CONSTRAINT — SQL Server would
 * store 'imaginary' without complaint and the screen would then hold a row
 * it cannot group or label.
 */
export type IssuerKind = 'modern' | 'historical' | 'ancient';

/** The three kinds, in the order the form offers them. */
export const ISSUER_KINDS: readonly IssuerKind[] = ['modern', 'historical', 'ancient'] as const;

/** `Issuers.Name NVARCHAR(100)`. The input caps itself at the same number. */
export const ISSUER_NAME_MAX_LENGTH = 100;

/**
 * One row of `Issuers` as `GET /api/issuers` returns it.
 *
 * The two counts are not columns. They are computed by the endpoint, and
 * they are the reason the maintenance screen can say what removing an issuer
 * would cost before it offers to do it (design §4.6).
 */
export interface IssuerRecord {
  issuerId: number;
  name: string;
  /** Null for every ancient and most historical states, permanently. */
  isoCode: string | null;
  kind: IssuerKind;
  /** Plain INT years. NEGATIVE MEANS BC: the Roman Republic starts at -509. */
  validFrom: number | null;
  validTo: number | null;
  sortOrder: number;
  /** How many active denominations are filed under this issuer. */
  denominationCount: number;
  /** How many coins carry one of those denominations. */
  coinCount: number;
  isActive: boolean;
}

/** An issuer on its way to `POST /api/issuers` — no id yet, no counts yet. */
export interface NewIssuer {
  name: string;
  isoCode: string | null;
  kind: IssuerKind;
  validFrom: number | null;
  validTo: number | null;
}

/**
 * A key -> "how many coins" map.
 *
 * KEYS ARE ALWAYS STRINGS, including for the id-keyed types. JSON, template
 * interpolation and `Object.keys` all produce strings somewhere in the round
 * trip, and a count stored under the number 103 but read with the string
 * '103' answers zero — which on this screen reads as "nothing is using it".
 */
export type UsageIndex = Record<string, number>;

/**
 * Everything `GET /api/reference-usage` returns: one index per type.
 *
 * Categories, sets and mint marks are keyed by their TEXT, because that is
 * what the coin stores (`Coins.Category`, `Coins.CoinSet`, `Coins.MintMark`
 * — the mint mark's LABEL, not its id). Denominations and catalogues are
 * keyed by id, because those are real foreign keys.
 */
export interface ReferenceUsageCounts {
  categories: UsageIndex;
  coinSets: UsageIndex;
  denominations: UsageIndex;
  mintMarks: UsageIndex;
  catalogs: UsageIndex;
}
