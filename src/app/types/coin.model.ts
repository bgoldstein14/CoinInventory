/**
 * Primary coin record interface representing a single coin in the inventory.
 * Aligns with the coins table in the database schema.
 *
 * Key changes from legacy schema:
 * - Removed 'name' field (was redundant with denomination/type/variety)
 * - Changed 'year' from number|null to string (supports ranges like "1916-1945")
 * - Changed 'type' to 'coinType' for clarity
 * - Changed 'grade' from union type to freeform string (supports any grading standard)
 * - Added 'pmWeightGrams' and 'pmPercent' for precious metal tracking
 * - Removed 'tags' (see below)
 * - Removed 'dealer' (see below)
 *
 * ABOUT THE REMOVED 'tags' FIELD
 * ------------------------------
 * There used to be a `tags: string[]` here, backed by a CoinTags table in SQL
 * Server and a "Tags" column in the grid. It was plumbed end to end EXCEPT for
 * one thing: there was never any way to type a tag in. The editor had no input,
 * bulk edit did not offer it, and neither importer could set one, so every coin
 * carried an empty array and the grid column could only ever render a dash.
 * Rather than build the missing UI the whole concept was dropped.
 *
 * Older JSON exports still contain a `tags` array. That is harmless: the import
 * normaliser in services/inventory/coin-factory.ts simply does not copy the key
 * across, so an old file still loads without error.
 *
 * ABOUT THE REMOVED 'dealer' FIELD
 * -------------------------------
 * There used to be a `dealer?: string` here — "who this coin came from" — backed
 * by a Coins.Dealer column, an editor input, a grid column, a free-text filter
 * and a CSV column. The owner asked for it to go: the same information is
 * already recorded, per event and more precisely, on the TRANSACTION rows
 * (see TransactionRecord.dealer further down this file), so the coin-level copy
 * was a second, weaker answer to a question that was already answered.
 *
 * ***********************************************************************
 * *** TransactionRecord.dealer IS A DIFFERENT FIELD AND IT STAYS. ***
 * A coin-level dealer said "this coin came from Heritage". A transaction-level
 * dealer says "THIS purchase, on this date, for this amount, was with
 * Heritage" — which survives a coin being bought from one dealer and later
 * sold to another. Only the coin-level one was removed. If you are grepping
 * for `dealer` to finish a cleanup, check which of the two you have found.
 * ***********************************************************************
 *
 * Older JSON and CSV exports still contain a `dealer` column/key. That is
 * harmless for the same reason the old `tags` arrays are: nothing copies the key
 * across any more, so an old file still loads, just without that value.
 */
export interface CoinRecord {
  id: string;
  denomination: string;
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
  notes: string;
  imagePaths: string[];
  source: 'manual' | 'quicken' | 'import' | 'csv';
  hasCacSticker?: boolean;
  soldPrice?: number;
  soldDate?: string;
  /**
   * The coin's GROSS weight — the whole coin, alloy included — in GRAMS.
   *
   * It was in TROY OUNCES until the switch recorded in
   * `server/migrations/008-weight-to-grams.sql`, which multiplied every
   * stored value by 31.1034768. Grams was chosen so that this and
   * `pmWeightGrams` below share a unit: the two fields measure different
   * things (gross coin vs. pure metal inside it) and having them in
   * different units as well made them easy to confuse — which is exactly
   * the mistake behind the melt-value bug written up in the README.
   *
   * NOT used to compute melt value. That is `pmWeightGrams` only; see
   * `computeMeltValue` in services/inventory/inventory-metrics.ts.
   */
  weight?: number;
  metalContent?: string;
  coinSet?: string;
  pmWeightGrams?: number; // Precious metal weight in grams (for melt value calculations)
  pmPercent?: number; // Precious metal purity percentage (e.g., 90 for 90% silver)
}

/**
 * Interface for coins imported from Quicken CSV exports.
 * Maps to CoinRecord after enrichment and normalization.
 *
 * Key changes from legacy schema:
 * - Removed 'name' field (redundant)
 * - Added year, coinType, grade, mintMark, variety fields
 * - Added pmWeightGrams and pmPercent for precious metal tracking
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
  /* -------------------------------------------------------------------------
   * THE FIVE ALLOY / WEIGHT FIELDS.
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
   *
   * `metalContent` and `composition` were added when the import used to fill
   * in only the two PM numbers, which is why the editor's Metal and
   * Composition fields came up empty on every imported coin. `weight` is the
   * most recent addition, for the same reason: the gross weights existed only
   * in prose comments in pm-reference.ts, so nothing could read them.
   * ---------------------------------------------------------------------- */
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
   * scale reads. Maps straight onto `CoinRecord.weight`, which counts GRAMS
   * from migration 008 onward. Undefined when nothing determines it.
   */
  weight?: number;
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

// ---------------------------------------------------------------------------
// Image filename matching (see services/image-matching.service.ts)
// ---------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Fields added for this collection's real filename conventions.
  //
  // All OPTIONAL, so every existing caller keeps compiling untouched. They
  // are always populated by ImageMatchingService.parseFilename(); the `?` is
  // purely there to keep the published shape backwards-compatible.
  // -------------------------------------------------------------------------

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
}

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

export interface TransactionRecord {
  id: string;
  coinId: string;
  type: 'purchase' | 'sale' | 'trade' | 'appraisal';
  date: string;
  amount: number;
  /**
   * Who this ONE transaction was with — the seller on a purchase, the buyer on
   * a sale, the appraiser on an appraisal.
   *
   * KEEP. This is NOT the `dealer` field that was removed from CoinRecord
   * above. That one was a single "where did this coin come from" string on the
   * coin itself; this one belongs to an individual dated, priced event, so a
   * coin bought from one dealer and sold to another records both correctly.
   * It is backed by the Transactions.Dealer column, which is untouched.
   */
  dealer: string;
  notes: string;
}

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
}

/**
 * Mint mark reference data from the database.
 * Defines available mint marks (e.g., "D" for Denver, "S" for San Francisco).
 */
export interface MintMarkOption {
  mintMarkId: number; // Primary key
  label: string; // Short code (e.g., "D", "S", "P", "W")
  description: string; // Full description (e.g., "Denver Mint", "San Francisco Mint")
  isActive: boolean; // Whether this mint mark is currently in use
}

/**
 * Log entry for application-level logging.
 * Used to track operations, errors, and debugging information.
 */
export interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR'; // Severity level
  message: string; // Log message
  details?: string; // Optional additional details (e.g., stack trace, JSON payload)
  source: 'frontend' | 'backend'; // Origin of the log entry
  timestamp: string; // ISO 8601 timestamp (e.g., "2026-08-28T14:30:00Z")
}

/**
 * UI notification for displaying messages to the user.
 * Used by the notification service to show info/warning/error banners.
 */
export interface AppNotification {
  id: string; // Unique identifier for the notification
  type: 'info' | 'warning' | 'error'; // Notification type (affects styling and icon)
  message: string; // Message to display to the user
  autoDismiss: boolean; // Whether the notification should auto-dismiss after duration
  duration?: number; // Auto-dismiss duration in milliseconds (only if autoDismiss is true)
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

// ===========================================================================
// BATCH IMAGE IMPORT
// ---------------------------------------------------------------------------
// Types for "point at a folder, match the photos to coins, attach the ones I
// tick". See services/image-import/* and components/image-import-modal.
//
// Why these live here rather than next to the service: the modal, the two
// child components and three services all traffic in the same shapes, and
// putting them in one place stops the components from importing each other.
// ===========================================================================

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
  /** What we are doing right now, so the UI can label the bar honestly. */
  phase: 'idle' | 'matching' | 'attaching' | 'done';
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

