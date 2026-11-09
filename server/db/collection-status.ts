/**
 * db/collection-status.ts — the five values Coins.CollectionStatus may hold.
 *
 * THE COLUMN
 *   CollectionStatus NVARCHAR(20) NOT NULL DEFAULT 'owned'
 *
 * Records where a coin sits in the collecting cycle: owned, wanted, ordered,
 * for sale, or sold. The argument for those five particular values — and for
 * it being ONE field rather than a separate wish-list table — is in
 * src/app/types/collection-status.ts and is not repeated here.
 *
 * *** THIS FILE IS A SECOND COPY OF THAT LIST. KEEP IT IN STEP. ***
 * server/ is a separate TypeScript project — its tsconfig has rootDir "." and
 * includes only the files beneath it — so it cannot import from src/app/.
 * db/collection-status.spec.ts READS src/app/types/collection-status.ts off
 * disk and fails the build if the two lists or the two defaults disagree, the
 * same technique db/coin-fields.spec.ts uses against setup-database.sql.
 *
 * IF YOU ADD OR RENAME A STATUS, three things change together: this array,
 * the Angular array, and a new migration widening or re-checking the column.
 * The spec will tell you if you forget the second.
 *
 * WHY THE SERVER VALIDATES AT ALL rather than binding whatever the request
 * body carried — two reasons the column itself makes sharp:
 *
 *   NOT NULL — binding null aborts the INSERT with a constraint violation and
 *     the user cannot save a coin at all. An absent `collectionStatus` in a
 *     request body (every request from an older client, and every request
 *     that is a partial edit of something else) must become 'owned', not
 *     null. normalizeNullable() — the default normalizer in coin-fields.ts —
 *     would turn an empty string into exactly the null that breaks it.
 *
 *   FIVE VALUES — this is a closed set that decides whether a coin counts
 *     towards the value of the collection. Arbitrary text in it would be a
 *     sixth value that nothing downstream has a rule for.
 */

/** Every value Coins.CollectionStatus may hold, in the app's declared order. */
export const COLLECTION_STATUSES = [
  'owned',
  'wanted',
  'ordered',
  'for-sale',
  'sold',
] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/**
 * What a coin is when nothing says otherwise — and what migration 010 stamps
 * on every row that existed before the column did.
 */
export const DEFAULT_COLLECTION_STATUS: CollectionStatus = 'owned';

/**
 * The declared width of the column, mirrored here so the spec can assert that
 * no token could ever be silently truncated by the driver.
 *
 * It must equal the NVARCHAR length in setup-database.sql and the maxLength on
 * the `collectionStatus` entry in coin-fields.ts. 20 leaves room for a longer
 * future token without a second ALTER.
 */
export const MAX_COLLECTION_STATUS_LENGTH = 20;

/**
 * Spellings that are not the stored token but unambiguously mean one.
 *
 * Only 'for-sale' needs any, because it is the only token with a hyphen in it
 * and therefore the only one a human writes differently from how it is
 * stored. Keyed after lower-casing and collapsing whitespace.
 */
const STATUS_SYNONYMS: Readonly<Record<string, CollectionStatus>> = {
  'for sale': 'for-sale',
  forsale: 'for-sale',
};

/**
 * Turn anything a request body might carry into a value this column accepts.
 *
 * ALWAYS returns one of the five tokens — never null, never undefined, never
 * the caller's text. Used as the `normalize` hook on the `collectionStatus`
 * entry in coin-fields.ts, so it runs for both the INSERT in POST /api/coins
 * and the UPDATE in PUT /api/coins/:id, and as the read-side default in
 * row-mappers.ts.
 *
 * An unrecognised value becomes 'owned' rather than being rejected with a 400.
 * That is deliberate: the alternative is a save that fails over a word, which
 * for a field the user may not even have been editing would be a baffling
 * place for an error to appear. 'owned' is also the honest reading — the coin
 * is in his collection file.
 */
export function normalizeCollectionStatus(value: unknown): CollectionStatus {
  if (typeof value !== 'string') return DEFAULT_COLLECTION_STATUS;

  const cleaned = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned) return DEFAULT_COLLECTION_STATUS;

  if ((COLLECTION_STATUSES as readonly string[]).includes(cleaned)) {
    return cleaned as CollectionStatus;
  }

  return STATUS_SYNONYMS[cleaned] ?? DEFAULT_COLLECTION_STATUS;
}
