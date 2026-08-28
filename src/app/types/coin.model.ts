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

/**
 * Denomination reference data from the database.
 * Defines available coin denominations (e.g., "Quarter", "Half Dollar").
 */
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
