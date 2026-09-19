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
export const DEFAULT_DENOMINATION_OPTIONS: Denomination[] = [
  { denominationId: 1, label: '½¢', country: 'US', sortOrder: 1, isActive: true },
  { denominationId: 2, label: '1¢', country: 'US', sortOrder: 2, isActive: true },
  { denominationId: 3, label: '2¢', country: 'US', sortOrder: 3, isActive: true },
  { denominationId: 4, label: '3CS', country: 'US', sortOrder: 4, isActive: true },
  { denominationId: 5, label: '3CN', country: 'US', sortOrder: 5, isActive: true },
  { denominationId: 6, label: '5¢', country: 'US', sortOrder: 6, isActive: true },
  { denominationId: 7, label: '10¢', country: 'US', sortOrder: 7, isActive: true },
  { denominationId: 8, label: '20¢', country: 'US', sortOrder: 8, isActive: true },
  { denominationId: 9, label: '25¢', country: 'US', sortOrder: 9, isActive: true },
  { denominationId: 10, label: '50¢', country: 'US', sortOrder: 10, isActive: true },
  { denominationId: 11, label: '$1', country: 'US', sortOrder: 11, isActive: true },
  { denominationId: 12, label: '$2.50', country: 'US', sortOrder: 12, isActive: true },
  { denominationId: 13, label: '$3', country: 'US', sortOrder: 13, isActive: true },
  { denominationId: 14, label: '$5', country: 'US', sortOrder: 14, isActive: true },
  { denominationId: 15, label: '$10', country: 'US', sortOrder: 15, isActive: true },
  { denominationId: 16, label: '$20', country: 'US', sortOrder: 16, isActive: true },
  { denominationId: 17, label: 'Farthing', country: 'GB', sortOrder: 17, isActive: true },
  { denominationId: 18, label: '½d', country: 'GB', sortOrder: 18, isActive: true },
  { denominationId: 19, label: '1d', country: 'GB', sortOrder: 19, isActive: true },
  { denominationId: 20, label: '3d', country: 'GB', sortOrder: 20, isActive: true },
  { denominationId: 21, label: '6d', country: 'GB', sortOrder: 21, isActive: true },
  { denominationId: 22, label: '1/-', country: 'GB', sortOrder: 22, isActive: true },
  { denominationId: 23, label: '2/- (Florin)', country: 'GB', sortOrder: 23, isActive: true },
  { denominationId: 24, label: '2/6 (Half Crown)', country: 'GB', sortOrder: 24, isActive: true },
  { denominationId: 25, label: '5/- (Crown)', country: 'GB', sortOrder: 25, isActive: true },
  { denominationId: 26, label: '½ Sovereign', country: 'GB', sortOrder: 26, isActive: true },
  { denominationId: 27, label: 'Sovereign', country: 'GB', sortOrder: 27, isActive: true },
  { denominationId: 28, label: 'Guinea', country: 'GB', sortOrder: 28, isActive: true },
  { denominationId: 29, label: '½p', country: 'GB', sortOrder: 29, isActive: true },
  { denominationId: 30, label: '1p', country: 'GB', sortOrder: 30, isActive: true },
  { denominationId: 31, label: '2p', country: 'GB', sortOrder: 31, isActive: true },
  { denominationId: 32, label: '5p', country: 'GB', sortOrder: 32, isActive: true },
  { denominationId: 33, label: '10p', country: 'GB', sortOrder: 33, isActive: true },
  { denominationId: 34, label: '20p', country: 'GB', sortOrder: 34, isActive: true },
  { denominationId: 35, label: '50p', country: 'GB', sortOrder: 35, isActive: true },
  { denominationId: 36, label: '£1', country: 'GB', sortOrder: 36, isActive: true },
  { denominationId: 37, label: '£2', country: 'GB', sortOrder: 37, isActive: true },
  { denominationId: 38, label: '£5', country: 'GB', sortOrder: 38, isActive: true },
];

export const DEFAULT_MINT_MARK_OPTIONS: MintMarkOption[] = [
  { mintMarkId: 1, label: '', description: 'No mint mark / Philadelphia pre-1980', isActive: true },
  { mintMarkId: 2, label: 'P', description: 'Philadelphia', isActive: true },
  { mintMarkId: 3, label: 'D', description: 'Denver / Dahlonega', isActive: true },
  { mintMarkId: 4, label: 'S', description: 'San Francisco', isActive: true },
  { mintMarkId: 5, label: 'W', description: 'West Point', isActive: true },
  { mintMarkId: 6, label: 'O', description: 'New Orleans', isActive: true },
  { mintMarkId: 7, label: 'CC', description: 'Carson City', isActive: true },
  { mintMarkId: 8, label: 'C', description: 'Charlotte', isActive: true },
  { mintMarkId: 9, label: 'M', description: 'Royal Mint / GB mintmark', isActive: true },
  { mintMarkId: 10, label: 'F', description: 'Birmingham / GB mintmark', isActive: true },
  { mintMarkId: 11, label: 'R', description: 'UK mint mark / rare issue', isActive: true },
  { mintMarkId: 12, label: 'H', description: 'Heaton / GB mintmark', isActive: true },
  { mintMarkId: 13, label: 'A', description: 'Additional / alternate mintmark', isActive: true },
  { mintMarkId: 14, label: 'Other', description: 'Catch-all for nonstandard marks', isActive: true },
];

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
