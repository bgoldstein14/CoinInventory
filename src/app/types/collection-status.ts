/* collection-status.ts — "do I actually have this coin?"
 *
 * One field on every coin recording where it sits in the collecting cycle:
 * on the want list, on its way, in the cabinet, up for sale, or gone.
 *
 * WHY ONE FIELD RATHER THAN SEPARATE LISTS
 *
 * The alternative design is a "wish list" that is its own collection of its
 * own objects. A want-list entry is a coin description — year, mint mark,
 * denomination, the grade you are hunting for, what you will pay — which is
 * precisely a CoinRecord. A second object type would duplicate every field,
 * every importer, every editor control and every column, and then the day
 * the coin arrives you would copy it across by hand and lose the notes you
 * had been keeping on it. With one field, that day is one dropdown.
 *
 * THE FIVE VALUES
 *
 *   owned     The default, and what every pre-existing coin becomes. In hand.
 *   wanted    On the want list. NOT in hand, NOT paid for. This is the whole
 *             reason the field exists.
 *   ordered   Bought, won at auction, or otherwise committed to — but not yet
 *             delivered. Kept as a separate value from `wanted` because the
 *             two call for different behaviour from the OWNER (one is a thing
 *             to hunt for, the other a thing to chase the post about) even
 *             though they agree on the only thing the APP cares about, which
 *             is that the coin is not on the shelf.
 *   for-sale  In hand, and listed. Still the owner's coin in every sense that
 *             matters to a total or an insurance schedule.
 *   sold      Disposed of. The terminal state, and the reason `for-sale`
 *             exists at all: without somewhere for a sold coin to go, the only
 *             way to stop counting it would be to DELETE the row, which throws
 *             away the photographs, the purchase price and the entire history
 *             of a coin the owner used to have.
 *
 * DUPLICATE IS DELIBERATELY ABSENT. A duplicate is a coin you own; "duplicate"
 * describes your holding of it, not its state. Making it one of these values
 * would make it mutually exclusive with For Sale — and a duplicate being for
 * sale is the single most likely thing to be true about a duplicate. Anyone
 * who wants to mark one has Notes, Category and Set already.
 *
 * HOW THIS RELATES TO SoldPrice / SoldDate
 *
 * `soldPrice` and `soldDate` record the DETAILS OF AN EVENT: what the coin
 * went for and when. `collectionStatus` records a FACT ABOUT NOW: whether the
 * coin is in the collection. They are not the same question and neither is
 * derived from the other:
 *
 *   *** NOTHING AUTOMATICALLY SETS collectionStatus FROM soldDate. ***
 *
 * It is tempting, and it would be wrong. A coin can have a sold date recorded
 * from a sale that fell through; a coin can be gone with no price ever typed
 * in. And auto-deriving it would silently change the totals of an existing
 * collection — every coin with an old sold date would leave the valuation
 * without the user asking. Only the dropdown changes a total.
 *
 * WHY THIS IS ITS OWN LEAF MODULE
 *
 * It imports nothing. coin.model.ts imports the type FROM here rather than
 * the other way round, which keeps the pair acyclic — a cycle here throws a
 * temporal-dead-zone ReferenceError at application start, nowhere near the
 * code at fault. It also means the rules below are plain functions testable
 * under Node with no DOM, which is all this project's test runner provides.
 */

/**
 * Every status a coin may be in, in the order they are offered to the user.
 *
 * The order is deliberate: it runs along the collecting cycle, from "I do not
 * have it" through to "I no longer have it", with the default first so that
 * the overwhelmingly common answer is the one at the top of the dropdown.
 */
export const COLLECTION_STATUSES = [
  'owned',
  'wanted',
  'ordered',
  'for-sale',
  'sold'
] as const;

/** One of the five tokens above. This is what the database column holds. */
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/**
 * What a coin is when nothing says otherwise.
 *
 * *** THIS IS THE SAFETY PROPERTY OF THE WHOLE FEATURE. ***
 * Every coin that existed before this field, every old JSON backup, every CSV
 * written by an earlier build and every row the migration has not reached yet
 * arrives with no status. All of them must read as Owned. A collection that
 * silently becomes status-less — and therefore drops out of the totals and the
 * insurance schedule — is worse than not having the feature at all.
 */
export const DEFAULT_COLLECTION_STATUS: CollectionStatus = 'owned';

/** Display text. Change freely: the stored value is the token, not this. */
export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  owned: 'Owned',
  wanted: 'Wanted',
  ordered: 'Ordered',
  'for-sale': 'For Sale',
  sold: 'Sold'
};

/**
 * The statuses that mean THE COIN IS PHYSICALLY IN THE COLLECTION.
 *
 * This set, and nothing else, is what the money totals and the insurance
 * schedule are built on. The test it encodes is POSSESSION, not title:
 *
 *   owned     — on the shelf.                                        held
 *   for-sale  — on the shelf with a price on it. Until somebody actually
 *               buys it, it is as much the owner's coin as any other, it is
 *               worth what it is worth, and if the house burns down the
 *               insurer owes for it.                                 held
 *   ordered   — paid for, perhaps, but NOT on the shelf. An insurance
 *               schedule listing a coin that is still in the post is a claim
 *               waiting to be denied, and a valuation that counts it is
 *               counting a coin and the money that bought it twice over —
 *               the purchase has not necessarily even cleared.    not held
 *   wanted    — the entire point of the feature.                 not held
 *   sold      — gone.                                            not held
 *
 * A Set rather than an array so the membership test is not a scan, and because
 * "is this one of the held statuses" is genuinely a set question.
 */
const HELD_STATUSES: ReadonlySet<CollectionStatus> = new Set<CollectionStatus>([
  'owned',
  'for-sale'
]);

/** Ready-made `{ value, label }` pairs for a <select>, in declared order. */
export const COLLECTION_STATUS_OPTIONS: ReadonlyArray<{ value: CollectionStatus; label: string }> =
  COLLECTION_STATUSES.map(value => ({ value, label: COLLECTION_STATUS_LABELS[value] }));

/**
 * Spellings that are NOT the stored token but unambiguously mean one.
 *
 * There is exactly one entry's worth of need for this and it is `for-sale`.
 * The app's own Export -> CSV writes the stored TOKEN, so an exported file
 * round-trips without any of this. The spellings below are for the human: the
 * grid shows him "For Sale", so that is what he types into his own spreadsheet
 * before importing it, and the hyphen is an implementation detail he has never
 * been shown. Without these three entries the import would quietly make every
 * one of those coins Owned — not an error, just a wrong answer.
 *
 * Keyed on the string AFTER lower-casing and collapsing whitespace, so one
 * entry covers "For Sale", "for sale" and "FOR  SALE".
 */
const STATUS_SYNONYMS: Readonly<Record<string, CollectionStatus>> = {
  'for sale': 'for-sale',
  forsale: 'for-sale'
};

/**
 * Turn anything at all into a status, defaulting to Owned.
 *
 * Takes `unknown` on purpose. Its callers are the places where untrusted data
 * crosses into the app — a JSON backup, a CSV cell, a database row from a
 * server build that may be older than this one — and every one of them would
 * otherwise have to cast first and would be free to invent its own fallback.
 * One function, one fallback, nothing to drift.
 *
 * AN UNRECOGNISED VALUE IS NOT AN ERROR. It becomes Owned. This is the right
 * answer for a typo in a spreadsheet, and it is also the right answer for a
 * status written by a FUTURE version of the app that this build has never
 * heard of: the coin is in the user's collection file, so the safe reading is
 * that he has it. Refusing the row, or leaving the field blank, would take a
 * coin out of his collection because of a word he does not know is there.
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

/**
 * The minimum a value needs to look like for the rules below to judge it.
 *
 * Structural rather than `CoinRecord` so that this module keeps importing
 * nothing (see the header). It also means a test can pass a two-key object
 * instead of building a whole coin.
 */
export interface CollectionStatusBearing {
  collectionStatus?: CollectionStatus;
}

/**
 * Is this coin actually in the collection?
 *
 * The one question the totals, the insurance schedule and any future "what do
 * I have" calculation must ask. Written once so the answer cannot differ
 * between two of them — the kind of split that produced this project's
 * melt-value bug, where the same sum lived in two places and only one of them
 * got fixed.
 */
export function isHeldInCollection(coin: CollectionStatusBearing): boolean {
  return HELD_STATUSES.has(normalizeCollectionStatus(coin.collectionStatus));
}

/**
 * The coins actually in the collection, in their original order.
 *
 * Generic so callers keep their own element type — `heldCoins(inventory())`
 * comes back as `CoinRecord[]`, not as the structural interface above.
 */
export function heldCoins<T extends CollectionStatusBearing>(coins: readonly T[]): T[] {
  return coins.filter(isHeldInCollection);
}

/**
 * The status as a human reads it.
 *
 * NEVER RETURNS A DASH. Everywhere else in the grid an em-dash means "we do
 * not know", and a coin with no status is not unknown — it is Owned. Rendering
 * a dash would put a visible gap in the record of every coin the user had
 * before this feature shipped, and invite him to go and "fix" several hundred
 * rows that were never broken.
 */
export function collectionStatusLabel(value: unknown): string {
  return COLLECTION_STATUS_LABELS[normalizeCollectionStatus(value)];
}
