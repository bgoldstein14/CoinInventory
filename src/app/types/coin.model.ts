import { CollectionStatus } from './collection-status';
import type { CatalogRef } from './catalog-reference';

/**
 * Re-exported so all coin types can be imported from this file. Defined in
 * collection-status.ts, which imports nothing, so it can never join an import cycle.
 */
export type { CollectionStatus } from './collection-status';

/**
 * A single coin in the inventory. Mirrors the Coins table.
 *
 * There is no `dealer` field: the buy and sell counterparties are separate
 * (`purchasedFrom`, `soldTo`). Old exports with `dealer` or `tags` keys still
 * load because the import normaliser ignores unknown keys.
 */
export interface CoinRecord {
  id: string;
  /*
   * `denomination` is the text the source gave (typed or imported) and is never
   * rewritten. `denominationId` links to the Denominations lookup when one could
   * be resolved; null is normal. The two may disagree (e.g. "Pillar Dollar" vs
   * 8 Reales). Build display text only via `denominationDisplay()` in
   * services/denominations/denomination-display.ts.
   */
  denomination: string;
  denominationId?: number | null;
  year: string; // String to allow ranges, e.g. "1916-1945"
  coinType: string; // Coin variant, e.g. "Walking Liberty", "Morgan"
  category: string;
  country: string;
  grade: string; // Free text (PCGS, NGC or custom grades)
  certCompany: string;
  certNumber: string;
  variety: string;
  mintMark: string;
  composition: string;
  purchaseDate: string;
  purchasePrice: number;
  currentValue: number;
  /** The coin's own description. Not `transactionNotes`, which is the note on the deal. Backed by Coins.Notes. */
  notes: string;
  /*
   * Downscaled `data:` URLs in display order; index 0 is the main photo.
   *
   * Three states:
   *   [...]      loaded, the coin has these photos
   *   []         loaded, the coin has none
   *   undefined  not loaded (`GET /api/coins` never includes image bytes)
   *
   * Never default this to []: a PUT carrying `imagePaths` replaces the coin's
   * whole image set, so an empty array deletes every photo. Read counts via
   * `coinPhotoCount()` / `coinHasPhotos()` in services/coin-photos.ts;
   * `InventoryService.loadCoinImages()` fills it when a coin is selected.
   */
  imagePaths?: string[];
  /**
   * Photo count from the list endpoint (SQL COUNT), available for every coin on
   * load. May be stale after edits; `coinPhotoCount()` prefers the loaded array.
   */
  imageCount?: number;
  source: 'manual' | 'quicken' | 'import' | 'csv';
  hasCacSticker?: boolean;
  soldPrice?: number;
  soldDate?: string;
  /*
   * Acquisition / disposal: a coin has one purchase and at most one sale. Dates
   * and amounts are `purchaseDate` / `purchasePrice` and `soldDate` / `soldPrice` above.
   */
  /** Who the coin was bought from. Backed by Coins.PurchasedFrom. */
  purchasedFrom?: string;
  /** Who the coin was sold to. Backed by Coins.SoldTo. */
  soldTo?: string;
  /** Note on the purchase/sale. Not `notes` (the coin's description). Backed by Coins.TransactionNotes. */
  transactionNotes?: string;
  /** Gross weight of the whole coin in grams. Melt value uses `pmWeightGrams`, not this. */
  weight?: number;
  metalContent?: string;
  coinSet?: string;
  pmWeightGrams?: number; // Precious metal weight in grams (for melt value calculations)
  pmPercent?: number; // Precious metal purity percentage (e.g., 90 for 90% silver)
  /**
   * Owned, wanted, ordered, for sale, or sold. Undefined means 'owned'. Always
   * read through `normalizeCollectionStatus()` / `isHeldInCollection()` in
   * collection-status.ts, since old data may hold missing or unknown values.
   */
  collectionStatus?: CollectionStatus;
  /**
   * Free-text physical location, e.g. "Safe deposit box 2". Searched and shown
   * as a grid column; never parsed. Distinct from `coinSet` (a conceptual grouping).
   */
  storageLocation?: string;
  /**
   * Catalogue references in entry order ("Sear 6819", "RIC 123"). Display them
   * through the helpers in types/catalog-reference.ts; the main one is Sear if present.
   */
  catalogRefs?: CatalogRef[];
}

/**
 * An importer reading that was a guess between several valid values (e.g. two
 * coins struck under the same name). The import preview flags the row so the
 * user can change or drop it. Not persisted.
 */
export interface AmbiguousReading {
  /** Which parsed field this is about. */
  field: 'denomination' | 'coinType';
  /** The value the importer went with. Always one of `alternatives`. */
  chosen: string;
  /** Every candidate value, `chosen` included; offered as choices in the preview. */
  alternatives: readonly string[];
  /** One plain-English sentence explaining the ambiguity; shown verbatim to the user. */
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
   * Grading service parsed from the security name, e.g. "PCGS"; empty when none.
   * Bare token only, because the editor input caps at 10 characters.
   */
  certCompany: string;
  /** True when the name mentions a CAC sticker. Always a boolean (BIT NOT NULL column). */
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
  /*
   * Disposal read from Sell / SellX / ShrsOut entries; undefined while held.
   * `soldPrice` is undefined (not 0) when no amount was stated, since 0 is a
   * real sale price. See services/import-sold.ts.
   */
  /** ISO `YYYY-MM-DD` date of the latest disposal. */
  soldDate?: string;
  /** Proceeds of that same disposal, when the block stated an amount. */
  soldPrice?: number;
  /*
   * Alloy / weight fields, all filled by `composePmFields` in pm-fill.ts: from the
   * reference table when it has a row, otherwise only `metalContent` from metal
   * inference. Left undefined when unknown rather than guessed.
   */
  /** Canonical Metal value for the editor dropdown: "Gold", "Silver", "Clad", ... */
  metalContent?: string;
  /** Free-text alloy description, e.g. "90% Gold, 10% Copper". */
  composition?: string;
  /** Pure precious metal weight in grams (not the coin's gross weight). */
  pmWeightGrams?: number;
  /** Alloy fineness as a percentage (90 = 90% fine). */
  pmPercent?: number;
  /** Gross coin weight in grams; maps to `CoinRecord.weight`. */
  weight?: number;
  /*
   * Raw Quicken security name. The stable identity of a preview row, since `id`
   * is regenerated on every re-parse. Not copied onto CoinRecord.
   */
  securityName?: string;
  /** Uncertain readings; undefined (not []) when there are none. */
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
 * What the matcher parsed from an image filename. Shown back to the user so a
 * bad parse is obvious. Fields are null/empty when the filename gave no reliable evidence.
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
   * Coin face from "- Obverse" / "- Reverse" / "- Label"; null when not stated.
   * Not scored, only used to group shots of one coin.
   */
  side?: ImageSide | null;

  /**
   * Which shot in a series this is: the "2" in "- Obverse 2" or in
   * "- VF30 - 2 - Obverse". Null when the name is not numbered.
   */
  take?: number | null;

  /** File variant: 'photo', 'orig', 'sharpened', 'small', 'large', ... */
  photoVariant?: string | null;

  /**
   * Catalogue references for ancients, normalized to single tokens:
   * "Sear 6819" -> "sear6819", "RIC 34" -> "ric34".
   */
  catalogRefs?: string[];

  /** Era date for ancients as written, e.g. "450-350 BC". Never parsed into `year`. */
  eraDate?: string | null;

  /**
   * True when the image is not one identifiable coin: a group shot, a non-coin
   * item, a container or a camera default name. Never auto-assigned.
   */
  isNonCoin?: boolean;

  /** Plain-English explanation of `isNonCoin`, for the UI. */
  nonCoinReason?: string | null;

  /**
   * True when the automated importer must skip this photo with no "Attach
   * anyway" option (e.g. a multi-coin shot). Still listed with
   * {@link autoImportExclusionReason}. Manual attach paths ignore this flag.
   * Set by `image-matching/non-coin-detector.detectAutoImportExclusion`.
   */
  excludedFromAutoImport?: boolean;

  /** Plain-English explanation of `excludedFromAutoImport`, for the UI. */
  autoImportExclusionReason?: string | null;

  /**
   * True when the filename says counterfeit ("FAKE", "Replica", ...). Matched
   * only against records that also say so; see image-matching/match-vetoes.ts.
   */
  counterfeit?: boolean;

  /**
   * Strike read from the filename. A name that says nothing reports 'business'
   * (proofs are always labelled); 'unknown' only for an empty name. See
   * `image-matching/proof-strike.ts`.
   */
  strike?: StrikeKind;
}

/**
 * How a coin was struck.
 *
 *   'proof'    struck as a proof (PF / PR grades, or the word "proof").
 *   'business' an ordinary circulation strike, including prooflike (PL / DMPL / DPL).
 *   'specimen' SP: a presentation strike.
 *   'unknown'  nothing to read (no text and no grade), not merely "proof not mentioned".
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
  /** Explanation, e.g. "Year 1881 matches; mint mark S matches". */
  reason: string;
  /** Number of independently-agreeing strong attributes behind this score. */
  strongAttributeCount: number;
}

/**
 * Which review tier an image lands in. Separate from `status` (matcher
 * confidence) so presentation rules can never attach anything. See
 * `services/image-matching/near-match.ts`.
 *
 * - 'matched'      : attached automatically. The user may untick or Skip it.
 * - 'near'         : same coin on year + type + denomination + grade, but
 *                    something else is off. One yes/no question.
 * - 'not-imported' : no apparent match; skipped and listed read-only.
 */
export type ImportTier = 'matched' | 'near' | 'not-imported';

/**
 * Data for one row of the 'near' tier. `matchedRecordId` stays null until the user accepts.
 */
export interface NearMatchDetail {
  /** The coin we are proposing (the best-ranked candidate that passed). */
  suggestedCoinId: string;
  /** Its display label, e.g. "Morgan Dollar 1881-S". */
  suggestedCoinLabel: string;
  /** Every candidate that passed the near-match test, best first; `candidates[0]` is the suggestion. */
  candidates: RankedImageMatch[];
  /** 'exact' when the grades are identical, 'extra-detail' when one says more. */
  gradeRelation: 'exact' | 'extra-detail';
  /** One sentence about the grades, shown so the tolerance is visible. */
  gradeNote: string;
  /** Why this is "near" rather than automatic (mint mark, variety, cert number, ties). */
  discrepancies: string[];
}

/**
 * Per-image outcome of the matcher. Extends {@link ImageMatchCandidate} so
 * older callers keep working.
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

  /* Review-tier fields, set by `near-match.assignImportTier` after auto-assign; never changes `status`. */

  /** Which of the three review tiers this image belongs in. */
  tier: ImportTier;
  /** Populated only when `tier === 'near'`. */
  nearMatch: NearMatchDetail | null;
  /** Populated only when `tier === 'not-imported'`: one-sentence skip reason. */
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

  /*
   * Issuer fields from `GET /api/denominations` (LEFT JOIN Issuers). A
   * denomination belongs to an issuing authority, which need not be a country.
   * Optional because `Denominations.IssuerId` is nullable.
   */

  /** `Denominations.IssuerId`. Null means no issuer has been established. */
  issuerId?: number | null;
  /** `Issuers.Name` for that id, joined server-side so the UI need not. */
  issuerName?: string | null;
  /**
   * `Denominations.FaceValue`; null when none applies (e.g. a Denarius). Only
   * comparable within one currency era of one issuer, so sort by `sortOrder`.
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
 * Result of a live spot-price fetch via the backend COMEX proxy.
 *
 * Defined here rather than in spot-price.service.ts to avoid an import cycle
 * with api.service.ts, which broke unit tests ("BrowserXhr needs to be compiled
 * using the JIT compiler").
 */
export interface SpotPriceResult {
  prices: SpotPrices;   // The fetched metal prices
  source: string;       // Where the prices came from, e.g. "COMEX/NYMEX futures via Yahoo Finance"
  timestamp: string;    // ISO timestamp of the fetch
  error?: string;       // Present when the fetch failed; prices will be zeroed
}

/**
 * Newest saved row of the SpotPrices table (`GET /api/spot-prices/latest`),
 * loaded at start-up. When the table is empty, prices are zero and `source` /
 * `fetchedAt` are null, so test `fetchedAt` for "anything saved?".
 */
export interface LatestSpotPrices extends SpotPrices {
  /** Where the saved prices came from, or null when no row exists yet. */
  source: string | null;
  /** ISO timestamp of the saved row, or null when no row exists yet. */
  fetchedAt: string | null;
}

/**
 * The last spot prices written to the database. Used to label the UI after a
 * restart and to skip saving an identical row twice. All null = nothing saved yet.
 */
export interface SpotPriceMeta {
  /** Provenance label of the saved row, or null if nothing has been saved. */
  source: string | null;
  /** ISO timestamp of the saved row, or null if nothing has been saved. */
  fetchedAt: string | null;
  /** The exact prices in that saved row, or null if nothing has been saved. */
  prices: SpotPrices | null;
}

// --- Batch image import ---
// Shared by the image-import modal, its child components and services/image-import/*.

/**
 * Which face of the coin a photo shows, read from the filename. 'unknown' when
 * the name does not say; 'label' is the slab label photo.
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

/** A skip reason and how many files hit it. */
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
 * Side, processing variant and retake status of a photo, from the filename.
 * The matcher's side/take is preferred when present; see photo-variant.ts.
 */
export interface PhotoVariantInfo {
  side: PhotoSide;
  /** Processing variant in the name ("Small", "Orig", "Sharpened", ...), or null. */
  variant: string | null;
  /** Trailing take number, e.g. 2 for "1874 $3 - NGC AU 58-2.jpg"; null when absent. */
  takeNumber: number | null;
  /** True for a take above 1 or an Orig/Sharpened/Small derivative. Drives "deselect retakes". */
  isRetake: boolean;
}

/** One file in the review screen, with its tick-box state. */
export interface BatchImageRow extends PendingImageReview {
  /** Ticked = written on confirm. Matched images start ticked. */
  selected: boolean;
  /** Side / variant / take, read from the filename (or from the matcher). */
  photo: PhotoVariantInfo;
  /** Size in bytes of the original file. */
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
 * Near-match rows that point at one coin, so several images of the same coin
 * can be accepted together. (Several coins fitting one image is handled by
 * {@link NearMatchDetail.candidates}.)
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
   * Current phase, for the progress label:
   *   scanning   classifying picked files into images / not-images
   *   matching   filename -> coin, in chunks
   *   building   Angular rendering the review screen; keep `progress` set until it finishes
   *   attaching  reading, downscaling and saving the ticked photos
   * Labels live in services/image-import/import-progress.ts.
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
