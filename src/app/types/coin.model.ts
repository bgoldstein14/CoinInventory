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
  tags: string[];
  source: 'manual' | 'quicken' | 'import' | 'csv';
  hasCacSticker?: boolean;
  soldPrice?: number;
  soldDate?: string;
  dealer?: string;
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
  pmWeightGrams?: number; // Precious metal weight in grams
  pmPercent?: number; // Precious metal purity percentage
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

