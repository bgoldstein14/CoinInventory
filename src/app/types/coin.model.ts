import { CollectionStatus } from './collection-status';

/**
 * Re-exported so that `import { CollectionStatus } from './coin.model'` works
 * alongside every other coin type. The definition, and the argument for the
 * five values it allows, lives in collection-status.ts.
 *
 * THE DEPENDENCY RUNS THIS WAY ROUND ON PURPOSE. collection-status.ts imports
 * nothing at all, so it cannot take part in an import cycle; if its rules
 * lived here instead they would need CoinRecord, and anything wanting the
 * rules would drag in this whole file.
 */
export type { CollectionStatus } from './collection-status';

/**
 * A single coin in the inventory. Mirrors the Coins table.
 *
 * There is no `dealer` field and there must not be one. A single "where did
 * this coin come from" string cannot describe a coin bought from one dealer
 * and later sold to another, which is why the two counterparties are two
 * separate fields: `purchasedFrom` and `soldTo`, below.
 *
 * Old JSON/CSV exports may still carry `dealer` or `tags` keys. That is
 * harmless: the import normaliser in services/inventory/coin-factory.ts does
 * not copy unknown keys across, so an old file still loads.
 */
export interface CoinRecord {
  id: string;
  /* THE DENOMINATION, IN TWO FIELDS.
   *
   * `denomination` IS NOT THE AUTHORITY. It is WHAT THE SOURCE SAID -- typed
   * by the user, or read out of a QIF, a CSV or a spreadsheet -- and nothing
   * in this application rewrites it. `denominationId` is the canonical link
   * to a row in the Denominations lookup, when one could be established.
   *
   * They are allowed to disagree, and after an import they usually do: the
   * text keeps saying `Pillar Dollar` while the id says `8 Reales`. That is
   * the point of keeping both. An id-only model would DESTROY the string at
   * import, and neither the user nor a later, smarter resolver could get it
   * back.
   *
   * NULL IS THE ORDINARY STATE of `denominationId`, not an error: a coin
   * imported before its issuer was seeded has one, and deleting a
   * denomination puts its coins back into it.
   *
   * *** NEVER BUILD THE DISPLAY STRING BY HAND. ***
   * `denominationDisplay()` in services/denominations/denomination-display.ts
   * is the only place the label / unresolved / nothing-recorded rule may be
   * written, and its spec greps src/ and fails the build if a second copy
   * appears. The editor's picker writes BOTH fields when the user chooses a
   * denomination, so from then on they agree.
   */
  denomination: string;
  denominationId?: number | null;
  year: string; // Changed from number|null to string to support year ranges (e.g., "1916-1945")
  coinType: string; // Renamed from 'type' - describes the coin variant (e.g., "Walking Liberty", "Morgan")
  category: string;
  country: string;
  grade: string; // Changed from CoinGrade union to freeform string (supports PCGS, NGC, custom grades)
  certCompany: string;
  certNumber: string;
  variety: string;
  mintMark: string;
  composition: string;
  purchaseDate: string;
  purchasePrice: number;
  currentValue: number;
  /**
   * THE COIN'S OWN NOTE. What it is, how it looks, where it sits in the
   * collection, in the collector's own words.
   *
   * *** THIS IS NOT `transactionNotes`. *** That one, further down, is the
   * note on the DEAL. The two boxes are adjacent in the detail panel, so the
   * names are deliberately unlike each other: there is no `coinNotes` and
   * this is never spelled with a prefix, so a grep for either finds one
   * field and never both. Backed by Coins.Notes.
   */
  notes: string;
  /* THE COIN'S PHOTOGRAPHS — AND WHY THIS KEY IS OPTIONAL
   *
   * Downscaled `data:` URLs, in display order. Position 0 is the coin's main
   * photo (the one the grid shows); the server stores that order as
   * CoinImages.SortOrder and returns the rows ORDER BY SortOrder.
   *
   * THERE ARE THREE STATES HERE, NOT TWO, and conflating two of them deletes
   * somebody's photographs:
   *
   *   ['data:...', 'data:...']   loaded, and the coin has these photographs
   *   []                         loaded, and the coin genuinely has NONE
   *   undefined (key absent)     NOT LOADED. We do not know. Say nothing.
   *
   * `GET /api/coins` returns the third state for every coin: the list
   * endpoint must never carry image bytes, because concatenating them runs
   * past V8's maximum string length and the response cannot be serialised at
   * all. See server/routes/coins/list-query.ts.
   *
   * THE DANGER. `PUT /api/coins/:id` carrying an `imagePaths` key REPLACES
   * the coin's whole image set — it deletes every CoinImages row and
   * re-inserts the array it was given. So an empty array is a DESTRUCTIVE
   * instruction. If "not loaded" ever gets written as `[]`, the next save of
   * that coin erases every photograph on it, silently, with a 200 response.
   * That is why this key is absent rather than defaulted, all the way from
   * the SQL row assembly to here.
   *
   * READING IT: use `coinPhotoCount()` / `coinHasPhotos()` from
   * services/coin-photos.ts, which answer from `imageCount` when the array
   * is absent. Never `coin.imagePaths.length` — that throws on a record
   * straight from the list.
   *
   * GETTING IT: `InventoryService.loadCoinImages(coinId)` fetches one coin's
   * photographs from `GET /api/coins/:id/images` and writes them here. It is
   * called automatically when a coin is selected.
   */
  imagePaths?: string[];
  /**
   * How many photographs this coin has, according to the server.
   *
   * Added by `GET /api/coins` from a SQL `COUNT(*)`, so it costs nothing and
   * is available for EVERY coin on load — which is what lets the grid decide
   * whether to render a thumbnail, and the report decide whether a coin is
   * worth fetching, without touching a single byte of image data.
   *
   * It is a snapshot from load time, so it can be stale once the user starts
   * attaching or deleting photographs. `coinPhotoCount()` prefers the loaded
   * array for exactly that reason and only falls back to this.
   */
  imageCount?: number;
  source: 'manual' | 'quicken' | 'import' | 'csv';
  hasCacSticker?: boolean;
  soldPrice?: number;
  soldDate?: string;
  /*
   * THE ACQUISITION / DISPOSAL RECORD — the three fields that replaced the
   * Transactions table and its TransactionRecord type.
   *
   * There is no separate record type any more and no `transactions` list:
   * a coin has ONE purchase and at most ONE sale. The money and the dates
   * are the fields ALREADY ABOVE — `purchaseDate` / `purchasePrice` (shown
   * in the UI as **Cost**) and `soldDate` / `soldPrice`. Only these three
   * were missing.
   */
  /** Who the coin was bought FROM. Backed by Coins.PurchasedFrom. */
  purchasedFrom?: string;
  /** Who the coin was sold TO. Backed by Coins.SoldTo. */
  soldTo?: string;
  /**
   * THE NOTE ON THE DEAL: "paid in two instalments", "consigned through
   * Heritage, 18% buyer's premium". Backed by Coins.TransactionNotes.
   *
   * *** THIS IS NOT `notes`. *** `notes` above is the COIN's own note and
   * long predates this field. The two boxes sit next to each other in the
   * detail panel, which is precisely why the names share no spelling: a
   * grep for `transactionNotes` finds this one and nothing else, and code
   * that writes the wrong key would replace the user's coin description
   * with a line about a dealer's premium and report success.
   */
  transactionNotes?: string;
  /**
   * The coin's GROSS weight — the whole coin, alloy included — in GRAMS.
   *
   * Grams so that this and `pmWeightGrams` below share a unit: the two
   * fields measure different things (gross coin vs. pure metal inside it),
   * and in different units as well they are very easy to confuse.
   *
   * NOT used to compute melt value. That is `pmWeightGrams` only; see
   * `computeMeltValue` in services/inventory/inventory-metrics.ts.
   */
  weight?: number;
  metalContent?: string;
  coinSet?: string;
  pmWeightGrams?: number; // Precious metal weight in grams (for melt value calculations)
  pmPercent?: number; // Precious metal purity percentage (e.g., 90 for 90% silver)
  /**
   * Where this coin sits in the collecting cycle: owned, wanted, ordered,
   * for sale, or sold. Backed by Coins.CollectionStatus NVARCHAR(20) NOT NULL
   * DEFAULT 'owned'.
   *
   * *** OPTIONAL HERE, NOT NULL IN THE DATABASE, AND THAT IS DELIBERATE. ***
   * Undefined means exactly the same thing as 'owned'. Making it required
   * would turn every coin literal in the app and in the test suite into a
   * compile error, and — far worse — would offer no protection at all against
   * the case that actually matters, which is a value arriving at RUNTIME from
   * an old JSON backup or a database row the migration has not reached.
   * Nothing may read this property raw: go through
   * `normalizeCollectionStatus()` / `isHeldInCollection()` in
   * collection-status.ts, which treat absent, empty and unrecognised alike
   * and answer 'owned' for all three.
   *
   * WHAT IT CHANGES. Only two things, and both are about coins the owner does
   * NOT have: the money totals on the toolbar (see inventory-metrics.ts) and
   * the insurance schedule export (see features/inventory/inventory-file-io.ts)
   * count HELD coins only, so a want-list coin can never inflate the value of
   * a collection that does not exist. Per-coin melt value is untouched: the
   * metal in a coin is a fact about that coin whether or not it is yours yet,
   * and that figure is exactly what you want in front of you when deciding
   * what to bid.
   *
   * NOT derived from `soldDate` / `soldPrice` below, now or ever. Those record
   * what an event was worth; this records what is true today. The full
   * argument is in collection-status.ts.
   */
  collectionStatus?: CollectionStatus;
  /**
   * Where the physical coin actually is: "Safe deposit box 2", "Dansco 7070,
   * page 4", "Blue album, slot 12". Backed by Coins.StorageLocation
   * NVARCHAR(200) NULL.
   *
   * FREE TEXT, WITH NO VALIDATION AND NO LOOKUP TABLE, ON PURPOSE. Every
   * collector organises differently — by album page, by box, by safe, by
   * room, by "the one at my mother's house" — and any structure this app
   * imposed would be wrong for most of them and unusable for the rest. It is
   * searched by the inventory search box and shown as an optional grid
   * column; nothing parses it.
   *
   * It is NOT `coinSet`. A set is a conceptual grouping ("Morgan Set") that a
   * coin belongs to wherever it physically lives; this is the shelf. One coin
   * can be in the Morgan set AND in safe deposit box 2, and the whole reason
   * both exist is that neither answers the other's question — "which of my
   * sets is this part of" versus "where do I go to put my hands on it".
   */
  storageLocation?: string;
  /* THE CATALOGUE REFERENCE — "Sear 6819"
   *
   * TWO FIELDS, ONE IDEA. `catalogId` says WHICH catalogue (a row in the
   * Catalogs lookup, maintained like denominations and mint marks);
   * `catalogNumber` is the reference within it, stored exactly as the user
   * typed it -- `1A`, `6819`, `II.1 234`, `RRC 44/5`.
   *
   * NEVER CONCATENATE THEM BY HAND. `coinCatalogReference()` in
   * types/catalog-reference.ts is the only place that joins them, and it is
   * what stops the grid showing something the search box cannot find. It also
   * handles the three partial states -- number with no catalogue (an import),
   * catalogue with no number (half-typed), and neither (nearly every coin).
   *
   * WHY THIS FIELD EXISTS. Ancients have no year, no denomination and no
   * grade, so a catalogue reference is frequently the ONLY thing that
   * identifies them. Without it such references end up stuffed into
   * `variety`, which nothing can search on properly.
   *
   * There is ONE reference per coin rather than the child table that would
   * eventually be correct, and entering a reference does NOT look anything
   * up — it is recorded, not resolved.
   *
   * BOTH OPTIONAL: "no reference recorded" is the normal state of a modern
   * coin, not a gap to be filled.
   */
  catalogId?: number;
  catalogNumber?: string;
}

/* "I GUESSED HERE." -- THE AMBIGUOUS-READING CHANNEL
 *
 * The importer reads a coin out of a hand-typed Quicken security name. Most
 * of what it reads is certain: "1927 $20" is a twenty dollar gold piece and
 * there is nothing to argue about. A few readings are NOT certain, because
 * two different coins were struck at the same time under the same wording,
 * and the name does not say which one the owner is holding.
 *
 * The importer still guesses — it does not stop at an ambiguity — but the
 * guess must not become indistinguishable from a fact. This type is how it
 * travels: the value we picked, every value we were picking BETWEEN, and one
 * plain sentence saying why we were unsure. The import preview renders it as
 * a flagged -- not quarantined -- row the user can re-point or drop.
 *
 * *** DELIBERATELY NOT ABOUT ANY ONE COIN. *** There are no per-denomination
 * special-case modules in this project; a rule that applies to one coin is
 * expected to be written so it applies across the board. `field` is a union
 * rather than a hard-coded 'denomination' precisely so the next ambiguous
 * reading -- a coin TYPE the name cannot pin down, say -- uses this channel
 * instead of inventing a second one.
 *
 * NOT A DATABASE COLUMN. This lives on the parsed record and is resolved at
 * import time. "Fix it later" is already served by the coin editor, where
 * denomination and coin type are both editable.
 */
export interface AmbiguousReading {
  /**
   * Which parsed field this is about. A union, not a literal, because the
   * channel is general -- see the block comment above.
   */
  field: 'denomination' | 'coinType';
  /**
   * The value the importer actually went with. Always one of `alternatives`.
   */
  chosen: string;
  /**
   * EVERY value that was genuinely on the table, `chosen` included, in no
   * particular order. The preview offers these as the choices the user can
   * switch to, so a value missing here is a value he cannot pick.
   */
  alternatives: readonly string[];
  /**
   * One plain-English sentence for a human: why the name was not conclusive,
   * and why we landed where we did. Shown verbatim in the preview, so write
   * it for the owner rather than for a developer.
   */
  why: string;
}

/**
 * A coin read out of a Quicken export. Maps to CoinRecord after enrichment
 * and normalization.
 */
export interface QuickenImportRecord {
  id: string;
  denomination: string;
  year: string; // Year or year range (e.g., "1916-1945")
  coinType: string; // Coin variant (e.g., "Walking Liberty", "Morgan")
  grade: string; // Grading information (e.g., "MS65", "AU50")
  /**
   * Third-party grading service that certified (slabbed) the coin, parsed out
   * of the Quicken security name -- e.g. "PCGS" from "1927 $20 - PCGS MS64".
   * Empty string when the name did not name a grading service.
   *
   * Stored as the bare company token only: the database column is
   * NVARCHAR(100) but the coin editor's input caps at 10 characters, so a
   * longer phrase would be un-editable in the UI.
   */
  certCompany: string;
  /**
   * True when the security name says the coin carries a green CAC sticker
   * (CAC = Certified Acceptance Corporation's sticker of approval, applied on
   * top of a PCGS/NGC slab). Always a real boolean -- never undefined -- so
   * the value can be POSTed straight into the BIT NOT NULL column.
   */
  hasCacSticker: boolean;
  mintMark: string; // Mint mark (e.g., "D", "S", "P")
  variety: string; // Coin variety (e.g., "Type 1", "Double Die")
  account?: string;
  purchaseDate?: string;
  purchasePrice: number;
  currentValue: number;
  country: string;
  notes: string;
  source: 'quicken';
  /* ---- THE DISPOSAL, WHEN THE QIF RECORDED ONE ----
   *
   * A Quicken investment account has no "sold" column: it has a Buy and,
   * later, a Sell / SellX / ShrsOut, and the importer reads a disposal off
   * the net quantity. These two carry what that disposal said, so a coin
   * known to be gone arrives with the evidence rather than with a bare
   * status -- and so it satisfies the one "is this sold?" rule the CSV and
   * Excel imports also use (services/import-sold.ts).
   *
   * Both UNDEFINED on a coin still held, and `soldPrice` is also undefined
   * when the disposal block stated no amount at all (a ShrsOut transfer
   * between accounts carries a quantity and nothing else). It is NOT 0 in
   * that case: 0 is a real sale price -- a coin given away -- and the sold
   * rule counts it as one. */
  /** ISO `YYYY-MM-DD` date of the latest disposal. */
  soldDate?: string;
  /** Proceeds of that same disposal, when the block stated an amount. */
  soldPrice?: number;
  /* THE FIVE ALLOY / WEIGHT FIELDS.
   *
   * All five come from ONE function -- `composePmFields` in pm-fill.ts, which
   * is also what the CSV import and the Settings > Maintenance backfill call,
   * so the three paths cannot drift. It has two sources, in a fixed order:
   *
   *   1. the REFERENCE TABLE (pm-reference.ts), keyed on country +
   *      denomination + YEAR. When it has a row, it fills all five at once, so
   *      they can never disagree with each other.
   *   2. failing that, the COARSE METAL INFERENCE (metal-inference.ts), which
   *      answers "what metal is this?" from the coin type, the denomination
   *      and the series name. It can only ever fill `metalContent`; the other
   *      four stay undefined, because knowing a US $20 is gold says nothing
   *      about how many grams of gold are in this particular one, nor what
   *      the whole coin weighs.
   *
   * All five are optional and are left UNDEFINED -- not zero, not empty string
   * -- whenever nothing determines them, because a blank the user can see and
   * fix beats a guess that silently produces a wrong melt value.
   */
  /** Canonical Metal value for the editor dropdown: "Gold", "Silver", "Clad", ... */
  metalContent?: string;
  /** Free-text alloy description, e.g. "90% Gold, 10% Copper". */
  composition?: string;
  /** PURE precious metal weight in grams (NOT the coin's gross weight). */
  pmWeightGrams?: number;
  /** Alloy fineness as a percentage (90 = 90% fine). */
  pmPercent?: number;
  /**
   * The WHOLE COIN's gross weight in GRAMS -- alloy included, the figure a
   * scale reads. Maps straight onto `CoinRecord.weight`, which also counts
   * GRAMS. Undefined when nothing determines it.
   */
  weight?: number;
  /* THE RAW QUICKEN SECURITY NAME THIS RECORD WAS READ FROM.
   *
   * Carried for ONE reason: it is the only stable identity a preview row has.
   * `id` is a fresh `crypto.randomUUID()` on every parse, and the import modal
   * re-parses the QIF text each time it refreshes (deliberately -- see the
   * "single choke point" note in quicken-import.service.ts), so anything the
   * user does to a row in the preview has to be remembered against something
   * that survives a re-parse. The security name is exactly that: the parser
   * keys its net-quantity map on it, so there is precisely one imported
   * record per distinct security name.
   *
   * Optional because a test fixture may build a record by hand, and because
   * nothing downstream of the import needs it -- it is NOT copied onto
   * CoinRecord and never reaches the database.
   */
  securityName?: string;
  /**
   * Readings the importer made but is NOT certain about -- see
   * `AmbiguousReading` above for the whole story. Left UNDEFINED (not an
   * empty array) on the overwhelming majority of records, which are not
   * ambiguous at all, so `record.ambiguities?.length` is the honest test.
   */
  ambiguities?: AmbiguousReading[];
}

export interface ImageMatchCandidate {
  imagePath: string;
  matchedRecordId: string | null;
  confidence: number;
  reason: string;
}

export interface PendingImageMatch {
  fileName: string;
  thumbnailUrl: string;
  matchedCoinId: string | null;
  confidence: number;
  reason: string;
  status: 'auto-matched' | 'confirmed' | 'rejected' | 'pending' | 'unmatched';
}

// Image filename matching (see services/image-matching.service.ts)

/**
 * Everything the matcher believes it understood from an image filename.
 *
 * The UI shows this back to the user ("here is what I read from the name")
 * so a bad parse is obvious at a glance instead of silently producing a
 * wrong match. Every field is nullable/empty when the filename gave us no
 * trustworthy evidence -- we deliberately never guess.
 */
export interface ParsedImageAttributes {
  /** Original filename (directories stripped), kept for display. */
  fileName: string;
  /** 4-digit year, validated to a sane minting range. Null when absent or untrustworthy. */
  year: number | null;
  /** Mint mark code ("s", "d", "cc", ...) only when it appeared in an unambiguous form. */
  mintMark: string | null;
  /** Canonical denomination key used for equality, e.g. "dollar", "double eagle". */
  denomination: string | null;
  /** Human-readable denomination label for display, e.g. "Double Eagle ($20)". */
  denominationLabel: string | null;
  /** Remaining meaningful words that describe the coin design, e.g. ["morgan"]. */
  coinTypeTokens: string[];
  /** Grade token if one was spotted, e.g. "ms63". */
  grade: string | null;
  /** Long digit runs that look like certification numbers. */
  certNumbers: string[];
  /** Grading service names spotted in the filename, e.g. ["ngc"]. */
  certCompanies: string[];
  /** All normalized tokens, for debugging / display. */
  tokens: string[];
  /** True when nothing usable was found (e.g. "IMG_2024.jpg"). */
  isEmpty: boolean;

  // The fields below are always populated by
  // ImageMatchingService.parseFilename(); the `?` only keeps the published
  // shape backwards-compatible for hand-built callers and fixtures.

  /**
   * Which face of the coin the photo shows, from "- Obverse" / "- Reverse" /
   * "- Label". Null when the filename does not say.
   *
   * Descriptive only: never scored, because nearly every filename says
   * "Obverse" and agreement on it is not evidence. Exposed so the import UI
   * can group the obverse and reverse shots of one coin together.
   */
  side?: ImageSide | null;

  /**
   * Which shot in a series this is: the "2" in "- Obverse 2" or in
   * "- VF30 - 2 - Obverse". Null when the name is not numbered.
   */
  take?: number | null;

  /**
   * File variant: 'photo', 'orig', 'sharpened', 'small', 'large', ...
   * Two files differing only by this show the same coin at a different size
   * or processing stage.
   */
  photoVariant?: string | null;

  /**
   * Catalogue references for ancients, normalized to single tokens:
   * "Sear 6819" -> "sear6819", "RIC 34" -> "ric34".
   */
  catalogRefs?: string[];

  /**
   * Era date for ancients, exactly as written: "67-68 CE", "450-350 BC".
   * Deliberately NOT parsed into `year` -- an era date is not a mint year and
   * must never be compared against one.
   */
  eraDate?: string | null;

  /**
   * True when the image is not a photograph of one identifiable coin: a group
   * shot ("Gold Coins", "20th Century Type Set"), a non-coin item ("Stamp",
   * "CSA Bond Coupon"), a container ("Sovereign Proof Boxes") or a camera
   * default name ("Coin_026"). These can never be auto-assigned.
   */
  isNonCoin?: boolean;

  /** Plain-English explanation of `isNonCoin`, for the UI. */
  nonCoinReason?: string | null;

  /**
   * True when the AUTOMATED IMPORTER must leave this photograph alone
   * entirely: a counterfeit ("FAKE - 1860 3CS - VF - Obverse.jpg",
   * "1861 Counterfeit 3CS - Obverse.jpg") or a shot of several coins at once
   * ("20¢ Collage.jpg", "1875 and 1876 3CN mini-hoard - Obverse.jpg").
   *
   * STRONGER THAN {@link isNonCoin}, AND THAT IS THE ONLY REASON IT EXISTS.
   * An `isNonCoin` row is skipped but still carries tier 3's opt-in
   * "Attach anyway..." link. These two groups get no rescue affordance at
   * all: a counterfeit or a group shot must never be offered as attachable
   * by the automated import. The row is still LISTED, with
   * {@link autoImportExclusionReason} as its skip reason, because nothing
   * may ever disappear silently.
   *
   * *** THIS IS A PROPERTY OF THE AUTOMATED DECISION, NEVER OF THE FILE. ***
   * No picture file is ever off limits for a MANUAL attach, however
   * irrelevant its name. Every manual path -- the per-coin image gallery,
   * the free-text coin search, the coin editor -- ignores this flag
   * completely.
   *
   * Set by `image-matching/non-coin-detector.detectAutoImportExclusion`.
   */
  excludedFromAutoImport?: boolean;

  /** Plain-English explanation of `excludedFromAutoImport`, for the UI. */
  autoImportExclusionReason?: string | null;

  /**
   * How the coin was struck, as far as the FILENAME says: a proof, a business
   * strike, a specimen, or 'unknown' only when the name was EMPTY.
   *
   * A FILENAME THAT SAYS NOTHING ABOUT THE STRIKE REPORTS 'business', NOT
   * 'unknown'. The convention in this collection is that a proof is always
   * labelled as one, in both the filename and the inventory description, so
   * silence means a business strike.
   *
   * Read by `image-matching/proof-strike.ts`, which carries the long warning
   * about why "PROOFLIKE" is a BUSINESS strike and not a proof. A proof and a
   * business strike of the same date are different coins, so a stated
   * disagreement is a hard veto -- see `image-matching/match-vetoes.ts`.
   */
  strike?: StrikeKind;
}

/**
 * How a coin was struck.
 *
 *   'proof'    struck as a proof (PF / PR grades, or the word "proof").
 *   'business' an ordinary circulation strike -- INCLUDING every prooflike
 *              (PL / DMPL / DPL) coin, which only LOOKS like a proof.
 *   'specimen' SP: a presentation strike, genuinely neither of the above.
 *   'unknown'  THERE WAS NOTHING TO READ -- no descriptive text and no grade
 *              on this side at all. It is NOT the answer for a side that
 *              merely failed to mention proof: that is 'business', because
 *              the designation is written whenever it applies. See
 *              `image-matching/proof-strike.ts` and the strike-only
 *              carve-out note in `match-vetoes.ts`.
 */
export type StrikeKind = 'proof' | 'business' | 'specimen' | 'unknown';

/**
 * Which face of a coin an image shows. 'label' is the certification label on
 * the front of a graded slab.
 */
export type ImageSide = 'obverse' | 'reverse' | 'label';

/**
 * A single scored inventory coin offered as a possible owner of an image.
 */
export interface RankedImageMatch {
  /** CoinRecord.id */
  coinId: string;
  /** Display label, e.g. "Morgan Dollar 1881". */
  coinLabel: string;
  /** Normalized 0..1 confidence. */
  score: number;
  /** Specific, honest explanation, e.g. "Year 1881 matches; mint mark S matches". */
  reason: string;
  /** Number of independently-agreeing strong attributes behind this score. */
  strongAttributeCount: number;
}

/**
 * Which of the three review tiers an image lands in.
 *
 * `status` says how sure the MATCHER is; `tier` says what the SCREEN should do
 * about it. They are deliberately separate: the auto-assign gates that produce
 * `status` must never be influenced by a presentation decision, and the tier
 * rules must never be able to attach anything. See
 * `services/image-matching/near-match.ts` for the full reasoning.
 *
 * - 'matched'      : attached automatically. The user may untick or Skip it.
 * - 'near'         : same coin on year + type + denomination + grade, but
 *                    something else is off. One yes/no question.
 * - 'not-imported' : no apparent match, so there is no question to ask.
 *                    Skipped automatically and listed read-only, with no
 *                    buttons, so a 2,140-file run does not become 2,140
 *                    decisions.
 */
export type ImportTier = 'matched' | 'near' | 'not-imported';

/**
 * Everything the "needs a yes/no" tier needs to render one row.
 *
 * Present only when {@link ImageMatchResult.tier} is 'near'. Note there is no
 * coin id anywhere in {@link ImageMatchResult} itself for a near match:
 * `matchedRecordId` stays null until the user says yes.
 */
export interface NearMatchDetail {
  /** The coin we are proposing (the best-ranked candidate that passed). */
  suggestedCoinId: string;
  /** Its display label, e.g. "Morgan Dollar 1881-S". */
  suggestedCoinLabel: string;
  /**
   * Every candidate that independently passed the four-attribute near-match
   * test, best first — the suggestion is `candidates[0]`. This is what the
   * "or pick a different one" dropdown lists. Candidates that FAILED the test
   * are deliberately not here: offering a coin we have already judged wrong
   * would just be another way to mis-file a photo.
   */
  candidates: RankedImageMatch[];
  /** 'exact' when the grades are identical, 'extra-detail' when one says more. */
  gradeRelation: 'exact' | 'extra-detail';
  /** One sentence about the grades, shown so the tolerance is visible. */
  gradeNote: string;
  /**
   * Why this is "near" and not automatic — a mint mark that disagrees, a
   * variety, a cert number, or several coins fitting equally well.
   */
  discrepancies: string[];
}

/**
 * Per-image outcome of the matcher.
 *
 * Extends the legacy {@link ImageMatchCandidate} so existing callers that only
 * read imagePath/matchedRecordId/confidence/reason keep working unchanged.
 */
export interface ImageMatchResult extends ImageMatchCandidate {
  /**
   * - 'auto'   : near-certain, safe to attach without asking.
   * - 'review' : plausible candidates exist but we are not certain -- ask the user.
   * - 'none'   : nothing worth suggesting.
   */
  status: 'auto' | 'review' | 'none';
  /** Only populated when status === 'auto'. */
  matchedRecordId: string | null;
  /** Top candidates, best first (max 5). Present for 'review' and often for 'none'. */
  candidates: RankedImageMatch[];
  /** What the matcher read out of the filename. */
  parsed: ParsedImageAttributes;
  /** Score gap between the best and second-best candidate. */
  runnerUpGap: number;

  /*
   * Review-tier fields. Written by `near-match.assignImportTier`, which runs
   * AFTER the auto-assign gates and can only ever add advice — it never writes
   * `status` or `matchedRecordId`.
    */

  /** Which of the three review tiers this image belongs in. */
  tier: ImportTier;
  /** Populated only when `tier === 'near'`. */
  nearMatch: NearMatchDetail | null;
  /**
   * Populated only when `tier === 'not-imported'`: why this file was skipped,
   * in one sentence fit to show in the read-only list. Nothing is ever dropped
   * without a reason recorded here.
   */
  skipReason: string | null;
}

/**
 * UI-side row for the image import review screen.
 * Wraps one {@link ImageMatchResult} with the user's decision.
 */
export interface PendingImageReview {
  fileName: string;
  thumbnailUrl: string;
  /** Matcher output for this file. */
  result: ImageMatchResult;
  /** Coin the image will be attached to once applied (null = nothing yet). */
  selectedCoinId: string | null;
  /** Why the current selection was made (matcher reason, or "manually assigned"). */
  selectionReason: string;
  /** Confidence of the current selection (1 when the user picked it by hand). */
  confidence: number;
  /**
   * - 'auto'      : matcher is confident; will be applied unless rejected.
   * - 'review'    : waiting on the user.
   * - 'confirmed' : user accepted a coin.
   * - 'skipped'   : user chose to not attach this image.
   */
  decision: 'auto' | 'review' | 'confirmed' | 'skipped';
}

/*
 * TransactionRecord USED TO BE HERE AND IS GONE.
 *
 * It described a row of the Transactions table: id, coinId, type, date,
 * amount, dealer, notes. The table was dropped and its data moved onto the
 * coin — `purchaseDate` / `purchasePrice` / `purchasedFrom` for the buy,
 * `soldDate` / `soldPrice` / `soldTo` for the sale, and `transactionNotes`
 * for the note. See those fields on CoinRecord.
 *
 * The old type carried a `dealer` field and a long comment arguing that
 * CoinRecord must never grow one, because a single string cannot describe a
 * coin bought from one dealer and later sold to another. That argument is
 * ANSWERED, not ignored: there are two counterparty fields now, one per
 * side of the deal, which is what the owner actually records.
 */

export interface SpotPrices {
  gold: number;
  silver: number;
  platinum: number;
  copper: number;
}

export interface Denomination {
  denominationId: number; // Primary key
  label: string; // Display name (e.g., "Quarter", "Half Dollar")
  country: string; // Country of origin (e.g., "USA", "Canada")
  sortOrder: number; // Sort order for UI dropdowns
  isActive: boolean; // Whether this denomination is currently in use

  /* THE ISSUER LINK
   *
   * A denomination belongs to an ISSUING AUTHORITY, not to a country: the
   * Roman Empire, the Papal States and the German states are not countries,
   * and ancients are explicitly in scope. These three fields come from
   * `GET /api/denominations`, which LEFT JOINs Issuers.
   *
   * *** OPTIONAL, AND THAT IS NOT LAZINESS. ***
   * `Denominations.IssuerId` is nullable, and requiring it here would force
   * an issuer to be invented at every site that builds a Denomination by
   * hand. A wrong value the user has no reason to doubt is worse than a
   * visible blank.
   *
   * `country` is NOT replaced by them — it is flagged debt, and the coin
   * editor's dropdown still groups by it.
   */

  /** `Denominations.IssuerId`. Null means no issuer has been established. */
  issuerId?: number | null;
  /** `Issuers.Name` for that id, joined server-side so the UI need not. */
  issuerName?: string | null;
  /**
   * `Denominations.FaceValue`. Null is a real answer, not missing data: a
   * Denarius has no face value in any system this app knows about.
   *
   * *** COMPARABLE ONLY WITHIN ONE CURRENCY ERA OF ONE ISSUER. *** France
   * carries both '1 Franc' and '1 Euro' at 1. Anything SORTING a whole
   * issuer must use sortOrder.
   */
  faceValue?: number | null;
}

/** Mint mark reference data, e.g. "D" for Denver, "S" for San Francisco. */
export interface MintMarkOption {
  mintMarkId: number;
  label: string; // Short code (e.g., "D", "S", "P", "W")
  description: string; // Full description (e.g., "Denver Mint")
  isActive: boolean;
}

export interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  details?: string; // e.g. stack trace or JSON payload
  source: 'frontend' | 'backend';
  timestamp: string; // ISO 8601
}

export interface AppNotification {
  id: string;
  type: 'info' | 'warning' | 'error';
  message: string;
  autoDismiss: boolean;
  duration?: number; // milliseconds; only read when autoDismiss is true
}

/**
 * Result of a spot-price fetch via the backend COMEX proxy.
 *
 * This type lives here rather than in spot-price.service.ts to break a
 * circular import: api.service.ts needs the type for its fetchSpotPrices()
 * return value, while spot-price.service.ts needs ApiService. Two modules
 * importing each other made Angular's HttpClient/XHR backend get pulled in
 * during module evaluation, which broke unit tests with
 * "BrowserXhr needs to be compiled using the JIT compiler".
 */
export interface SpotPriceResult {
  prices: SpotPrices;   // The fetched metal prices
  source: string;       // Where the prices came from, e.g. "COMEX/NYMEX futures via Yahoo Finance"
  timestamp: string;    // ISO timestamp of the fetch
  error?: string;       // Present when the fetch failed; prices will be zeroed
}

/**
 * The newest row of the SpotPrices history table — what
 * `GET /api/spot-prices/latest` answers with.
 *
 * NOT the same thing as SpotPriceResult above, and the difference matters:
 *
 *   SpotPriceResult   comes from GET /spot-prices/FETCH, which calls out to
 *                     COMEX/NYMEX live and touches no database at all.
 *   LatestSpotPrices  comes from GET /spot-prices/LATEST, which reads back the
 *                     last set of prices we SAVED. This is what the app loads
 *                     at start-up so melt values survive a restart.
 *
 * `fetchedAt` is the field to test for "has anything ever been saved?". When
 * the SpotPrices table is empty the route still answers 200, with every price
 * zeroed and BOTH `source` and `fetchedAt` null — see
 * server/routes/data/spot-prices.ts. So a null `fetchedAt` means "no row",
 * never "a row whose prices happened to be zero".
 */
export interface LatestSpotPrices extends SpotPrices {
  /** Where the saved prices came from, or null when no row exists yet. */
  source: string | null;
  /** ISO timestamp of the saved row, or null when no row exists yet. */
  fetchedAt: string | null;
}

/**
 * What the app knows about the newest set of spot prices that has actually
 * been WRITTEN to the database, as opposed to the ones sitting in memory.
 *
 * Held alongside `spotPrices` on InventoryService, for two reasons:
 *  - `source` / `fetchedAt` let the UI say "Updated: 3 Oct, 14:02 (COMEX)"
 *    after a restart, instead of looking like nothing has ever happened;
 *  - `prices` is the snapshot InventoryService.commitSpotPrices() compares
 *    against, so saving the same four numbers twice does not add a second
 *    identical row to a table that only ever grows.
 *
 * All three null means the SpotPrices table has never had a row in it.
 */
export interface SpotPriceMeta {
  /** Provenance label of the saved row, or null if nothing has been saved. */
  source: string | null;
  /** ISO timestamp of the saved row, or null if nothing has been saved. */
  fetchedAt: string | null;
  /** The exact prices in that saved row, or null if nothing has been saved. */
  prices: SpotPrices | null;
}

// --- BATCH IMAGE IMPORT ---
// Types for "point at a folder, match the photos to coins, attach the ones I
// tick". See services/image-import/* and components/image-import-modal.
//
// They live here rather than next to the service because the modal, its two
// child components and three services all traffic in the same shapes, and
// one shared home stops the components importing each other.

/**
 * Which face of the coin a photo shows, as read from the filename.
 *
 * The photo share is named like "1881-S $1 MS64 - Obverse - Photo.jpg", so the
 * side is almost always spelled out. 'unknown' covers files that say nothing
 * (e.g. "1874 $3 - NGC AU 58-2.jpg") and non-coin shots.
 *
 * 'label' is the slab/holder label photo - useful for provenance but not a
 * picture of the coin, which is why the UI offers "deselect Label shots".
 */
export type PhotoSide = 'obverse' | 'reverse' | 'label' | 'unknown';

/** Why a file the user selected was not even offered to the matcher. */
export type SkipCategory =
  | 'raw-photo'      // .dng / .cr2 / .nef - a browser cannot decode these
  | 'layered-image'  // .psd / .tif - not web-displayable
  | 'system-file'    // Thumbs.db / desktop.ini / .DS_Store
  | 'not-an-image';  // anything else: .txt, .info, .zip, no extension at all

/** One rejected file, with a reason we can show the user. */
export interface SkippedImageFile {
  fileName: string;
  category: SkipCategory;
  /** Human-readable, e.g. "RAW camera file (.dng) - browsers cannot display it". */
  reason: string;
}

/** A reason plus how many files hit it, for the "nothing was silently dropped" report. */
export interface SkipReasonTally {
  category: SkipCategory;
  reason: string;
  count: number;
}

/** Result of filtering a raw directory selection down to displayable images. */
export interface ImageFileFilterResult {
  /** Files we will hand to the matcher (filenames only at this stage). */
  accepted: File[];
  /** Everything we rejected, in selection order. */
  skipped: SkippedImageFile[];
  /** The same rejections collapsed to one line per reason, biggest first. */
  tallies: SkipReasonTally[];
  /** accepted.length + skipped.length - i.e. what the user actually selected. */
  totalSelected: number;
}

/**
 * What we understood about a photo beyond "which coin is it" - the side, which
 * processing variant it is, and whether it is a retake.
 *
 * This is derived from the filename only. When the matcher supplies its own
 * side/take information we prefer that; see photo-variant.ts.
 */
export interface PhotoVariantInfo {
  side: PhotoSide;
  /**
   * Processing variant spelled out in the name: "Small", "Orig", "Photo",
   * "Sharpened", ... Null when the name carries no such word.
   */
  variant: string | null;
  /**
   * Trailing take number, e.g. 2 for "1874 $3 - NGC AU 58-2.jpg".
   * Null when the name has no trailing take counter.
   */
  takeNumber: number | null;
  /**
   * True when this file looks like a second-or-later shot of the same coin -
   * a take number above 1, or a "- Orig" / "- Sharpened" / "- Small"
   * derivative. Drives the "deselect retakes" bulk control.
   */
  isRetake: boolean;
}

/**
 * One file in the review screen: the matcher's verdict, the user's decision,
 * and the tick-box state.
 *
 * Extends {@link PendingImageReview} so everything the per-file review UI
 * already knew how to do (confirm / reject / choose candidate / skip) keeps
 * working unchanged.
 */
export interface BatchImageRow extends PendingImageReview {
  /**
   * Ticked = will be written on confirm. Every matched image starts ticked;
   * the user unticks the shots they do not want.
   */
  selected: boolean;
  /** Side / variant / take, read from the filename (or from the matcher). */
  photo: PhotoVariantInfo;
  /** Size in bytes of the ORIGINAL file, shown so the 46 MB monsters are obvious. */
  sizeBytes: number;
}

/** All the proposed photos for one coin - the unit the review screen shows. */
export interface CoinImageGroup {
  coinId: string;
  /** e.g. "Morgan Dollar 1881-S". */
  coinLabel: string;
  /** Every row proposed for this coin, obverse first, then reverse, then the rest. */
  rows: BatchImageRow[];
  /** Rows currently ticked. */
  selectedCount: number;
  /** Highest matcher confidence in the group, for sorting the weakest to the top. */
  topConfidence: number;
}

/**
 * The near-match rows that all point at ONE coin — the unit tier 2 is reviewed
 * in.
 *
 * WHY GROUPING MATTERS HERE. Two situations produce a near match, and this
 * type answers the second: several images of the same coin that none of them
 * match well enough. Obverse, reverse, the slab label and two retakes are
 * five files but ONE question, and answering it five times is the manual
 * work this screen exists to remove — so the group header carries an
 * "accept all".
 *
 * (The FIRST situation — several coins fitting one image — is handled inside
 * the row instead, by {@link NearMatchDetail.candidates} and its dropdown.)
 */
export interface NearMatchGroup {
  /** The coin the matcher suggests for every row in this group. */
  coinId: string;
  /** Its display label, e.g. "Morgan Dollar 1881-S". */
  coinLabel: string;
  /** The rows pointing at it, obverse first, then reverse, then the rest. */
  rows: BatchImageRow[];
  /** Rows in this group still waiting on an answer. */
  outstandingCount: number;
}

/** The bulk tick-box operations offered per coin and across the whole batch. */
export type SelectionBulkAction =
  | 'select-all'
  | 'deselect-all'
  | 'keep-obverse-reverse'
  | 'deselect-retakes'
  | 'deselect-labels';

/** Live progress while the confirmed files are being read, shrunk and saved. */
export interface BatchImportProgress {
  /** Files we intend to process. */
  total: number;
  /** Files finished (attached OR failed). */
  processed: number;
  attached: number;
  failed: number;
  /** Name of the file currently being worked on, for the progress line. */
  currentFile: string;
  /**
   * What we are doing right now, so the UI can label the bar honestly.
   *
   * There are FOUR working phases rather than two because the import has four
   * places where the main thread goes away long enough to look frozen:
   *
   *   scanning   classifying the picked File handles into images / not-images.
   *              Cheap per file, but the picker hands over thousands of them.
   *   matching   filename -> coin, in chunks. Roughly 1 s per 200-file chunk
   *              against a 2,000-coin inventory.
   *   building   Angular turning the finished rows into the review screen.
   *              This phase is not our code, so it is easy to forget: do NOT
   *              clear `progress` in the same task that hands the rows over,
   *              or the indicator comes down immediately before the longest
   *              render of the whole flow.
   *   attaching  reading, downscaling and saving the ticked photos.
   *
   * See services/image-import/import-progress.ts, which owns the labels and
   * the "is this busy?" rule for all of them.
   */
  phase: 'idle' | 'scanning' | 'matching' | 'building' | 'attaching' | 'done';
}

/** One file that could not be attached, with the reason. */
export interface BatchImportFailure {
  fileName: string;
  reason: string;
}

/** End-of-run report shown to the user. */
export interface BatchImportSummary {
  attached: number;
  /** Rows the user unticked or skipped. */
  skipped: number;
  failures: BatchImportFailure[];
  /** How many distinct coins received at least one image. */
  coinsTouched: number;
  /** Total bytes of the originals vs. bytes actually stored, for the size win. */
  originalBytes: number;
  storedBytes: number;
}

