# Coin Inventory Application Overhaul — Design Spec

**Date:** 2026-08-28
**Status:** Approved and implemented in practice for the completed work through 2026-09-19

## Overview

Comprehensive overhaul of the coin inventory Angular 22 application covering: database schema rewrite, QIF import improvements, attribute parsing, new UI fields and dropdowns, COMEX proxy, logging, exception handling, and database-first storage with local fallback.

---

## 1. Database Schema Rewrite

### 1.1 Naming Convention

All tables and columns use SQL Server CamelCase convention. No snake_case or json-style naming.

### 1.2 Tables

**Coins** (primary record table):

| Column | Type | Notes |
|--------|------|-------|
| CoinId | UNIQUEIDENTIFIER PK | DEFAULT NEWID() |
| Denomination | NVARCHAR(100) | Text value, not FK — allows freeform/Other |
| Year | NVARCHAR(50) | String to support ranges ("350-300 BCE") |
| CoinType | NVARCHAR(100) | e.g., "Washington", "Buffalo", "Jefferson" |
| Category | NVARCHAR(100) | |
| Country | NVARCHAR(100) | |
| Grade | NVARCHAR(50) | Freeform: "VF", "VF30", "VF Details", "VF/XF" |
| CertCompany | NVARCHAR(100) | |
| CertNumber | NVARCHAR(100) | |
| Variety | NVARCHAR(100) | e.g., "Type I", "Type II" |
| MintMark | NVARCHAR(20) | Text value, allows oddities like "O/S" |
| Composition | NVARCHAR(100) | |
| PurchaseDate | NVARCHAR(30) | |
| PurchasePrice | DECIMAL(12,2) | |
| CurrentValue | DECIMAL(12,2) | |
| Notes | NVARCHAR(MAX) | |
| Source | NVARCHAR(50) | 'manual', 'quicken', 'import', 'csv' |
| HasCacSticker | BIT | DEFAULT 0 |
| SoldPrice | DECIMAL(12,2) NULL | |
| SoldDate | NVARCHAR(30) NULL | |
| Dealer | NVARCHAR(200) NULL | |
| Weight | DECIMAL(10,4) NULL | Total coin weight, troy oz (optional) |
| MetalContent | NVARCHAR(50) NULL | Primary metal: Gold, Silver, Platinum, Copper, etc. |
| PmWeightGrams | DECIMAL(10,4) NULL | Precious metal weight in grams — pre-filled from known coin data |
| PmPercent | DECIMAL(5,2) NULL | PM fineness as percentage: 90.00, 92.50, 50.00, 99.99, etc. |
| CoinSet | NVARCHAR(100) NULL | |

**Removed:** `Name` column (no longer used).

**CoinImages:**

| Column | Type | Notes |
|--------|------|-------|
| ImageId | INT IDENTITY PK | |
| CoinId | UNIQUEIDENTIFIER FK | CASCADE DELETE |
| ImageData | NVARCHAR(MAX) | Base64 |
| SortOrder | INT | DEFAULT 0 |

**CoinTags:**

| Column | Type | Notes |
|--------|------|-------|
| CoinId | UNIQUEIDENTIFIER FK | CASCADE DELETE |
| Tag | NVARCHAR(100) | |
| PK: (CoinId, Tag) | | |

**Categories:**

| Column | Type |
|--------|------|
| CategoryName | NVARCHAR(100) PK |

**CoinSets:**

| Column | Type |
|--------|------|
| SetName | NVARCHAR(100) PK |

**Transactions:**

| Column | Type | Notes |
|--------|------|-------|
| TransactionId | UNIQUEIDENTIFIER PK | DEFAULT NEWID() |
| CoinId | UNIQUEIDENTIFIER FK | CASCADE DELETE |
| TransactionType | NVARCHAR(50) | purchase, sale, trade, appraisal |
| TransactionDate | NVARCHAR(30) | |
| Amount | DECIMAL(12,2) | |
| Dealer | NVARCHAR(200) | |
| Notes | NVARCHAR(MAX) | |

**SpotPrices:**

| Column | Type |
|--------|------|
| SpotPriceId | INT IDENTITY PK |
| Gold | DECIMAL(10,2) |
| Silver | DECIMAL(10,2) |
| Platinum | DECIMAL(10,2) |
| Copper | DECIMAL(10,4) |
| Source | NVARCHAR(200) |
| FetchedAt | DATETIME2 DEFAULT GETDATE() |

**AppSettings:**

| Column | Type |
|--------|------|
| SettingKey | NVARCHAR(100) PK |
| SettingValue | NVARCHAR(MAX) |

**Denominations** (new — maintainable reference table):

| Column | Type | Notes |
|--------|------|-------|
| DenominationId | INT IDENTITY PK | |
| Label | NVARCHAR(100) | Display value: "25¢", "$5", "£1", "10p" |
| Country | NVARCHAR(100) | "US" or "GB" |
| SortOrder | INT | For dropdown ordering |
| IsActive | BIT | DEFAULT 1, soft delete |

Seeded with:
- **US (1792+):** ½¢, 1¢, 2¢, 3¢ Silver, 3¢ Nickel, 5¢, 10¢, 20¢, 25¢, 50¢, $1, $2.50, $3, $5, $10, $20
- **GB (1800+):** Farthing, ½d, 1d, 3d, 6d, 1/-, 2/- (Florin), 2/6 (Half Crown), 5/- (Crown), ½ Sovereign, Sovereign, Guinea, ½p, 1p, 2p, 5p, 10p, 20p, 50p, £1, £2, £5

**MintMarks** (new — maintainable reference table):

| Column | Type | Notes |
|--------|------|-------|
| MintMarkId | INT IDENTITY PK | |
| Label | NVARCHAR(20) | Display value |
| Description | NVARCHAR(200) | e.g., "Denver" for "D" |
| IsActive | BIT | DEFAULT 1 |

Seeded with:
- **Blank** (no mintmark / Philadelphia pre-1980)
- **P** — Philadelphia
- **D** — Denver (also Dahlonega for gold)
- **S** — San Francisco
- **W** — West Point
- **O** — New Orleans
- **CC** — Carson City
- **C** — Charlotte
- **Other** — catch-all for oddities like "O/S"

### 1.3 Indexes

Same index strategy as before, updated for new naming: CoinImages(CoinId), CoinTags(CoinId), Coins(Category), Coins(Grade), Coins(Year), Coins(CoinSet), Coins(Dealer), Coins(MetalContent), Coins(CoinType), Transactions(CoinId).

### 1.4 Script

Single `setup-database.sql` script that:
1. Creates the database if not exists
2. Drops all existing tables (clean slate)
3. Creates all tables with constraints and indexes
4. Seeds Denominations and MintMarks reference data
5. Seeds default AppSettings

---

## 2. QIF Import Improvements

### 2.1 Net-Quantity Filtering

After parsing all transactions from the QIF file:
1. Group transactions by security name (Y field)
2. For each security: sum +1 for acquisitions (Buy, BuyX, ShrsIn, ReinvDiv, Add) and -1 for dispositions (Sell, SellX, ShrsOut, Remove)
3. Only include securities where net quantity > 0
4. For coins with multiple buy transactions, use the most recent acquisition's price/date
5. Display skipped coins (net <= 0) in the import preview with a "Sold/Transferred" indicator so the user can see what was filtered

### 2.2 Attribute Parsing from Security Name

The Y field (security name) contains most coin attributes. Parsing order:

1. **Year**: Extract leading number(s). Support:
   - Simple: `1861`, `1875`
   - With mintmark suffix: `1875S` → year=1875, mintmark=S
   - Ranges/BCE: parse if detected (e.g., "350-300 BCE")
2. **Mintmark**: Single letter immediately following 4-digit year with no space (e.g., `S`, `D`, `O`, `CC`)
3. **Grade**: Look for grade patterns after a `-` or space:
   - Standard abbreviations: AG, G, VG, F, VF, EF, XF, AU, MS, PR, PF, Unc
   - With modifiers: `CH+AU`, `AU58`, `VF30`
   - Split grades: `VF/EF`, `VF/XF`
   - Preceded by `-` or space: `- AU`, `-XF`, ` EF`
4. **Denomination**: Pattern match remaining text:
   - `3CS` → 3¢ Silver
   - `3CN` → 3¢ Nickel
   - `2c` → 2¢
   - `20c` → 20¢
   - `half` → 50¢
   - `8 Real` → 8 Reales
   - Extend existing `inferDenomination()` patterns
5. **Coin Type**: Left blank during import — can be determined later via online lookup based on denomination + year + country
6. **Variety**: Only populated if explicit keywords found (Type I, Type II, DDO, DDR, etc.)

### 2.3 Precious Metal Pre-Fill

During import (and available as a lookup during manual editing), auto-populate `PmWeightGrams` and `PmPercent` based on denomination + year + country using known reference data. Common examples:

**US Coins:**
| Denomination | Years | Metal | PM Weight (g) | PM % |
|---|---|---|---|---|
| $20 (Double Eagle) | 1849-1933 | Gold | 30.09 | 90.00 |
| $10 (Eagle) | 1795-1933 | Gold | 15.05 | 90.00 |
| $5 (Half Eagle) | 1795-1929 | Gold | 7.52 | 90.00 |
| $2.50 (Quarter Eagle) | 1796-1929 | Gold | 3.76 | 90.00 |
| $3 | 1854-1889 | Gold | 4.54 | 90.00 |
| $1 (Gold) | 1849-1889 | Gold | 1.50 | 90.00 |
| 50¢ (Half Dollar) | 1794-1964 | Silver | 11.25 | 90.00 |
| 25¢ (Quarter) | 1796-1964 | Silver | 5.63 | 90.00 |
| 10¢ (Dime) | 1796-1964 | Silver | 2.25 | 90.00 |
| 5¢ (Half Dime) | 1794-1873 | Silver | 1.20 | 90.00 |
| 3¢ Silver | 1851-1873 | Silver | 0.75 | 90.00 |
| $1 (Silver) | 1794-1935 | Silver | 24.06 | 90.00 |
| 50¢ (Kennedy) | 1965-1970 | Silver | 9.20 | 40.00 |
| 20¢ | 1875-1878 | Silver | 4.50 | 90.00 |

**British Coins:**
| Denomination | Era | Metal | PM Weight (g) | PM % |
|---|---|---|---|---|
| Sovereign | 1817+ | Gold | 7.32 | 91.67 |
| ½ Sovereign | 1817+ | Gold | 3.66 | 91.67 |
| Crown (pre-1920) | 1800-1919 | Silver | 26.18 | 92.50 |
| Crown (1920-1946) | 1920-1946 | Silver | 26.18 | 50.00 |
| Half Crown (pre-1920) | 1800-1919 | Silver | 13.09 | 92.50 |
| Half Crown (1920-1946) | 1920-1946 | Silver | 13.09 | 50.00 |
| Florin (pre-1920) | 1849-1919 | Silver | 10.47 | 92.50 |
| Florin (1920-1946) | 1920-1946 | Silver | 10.47 | 50.00 |
| Shilling (pre-1920) | 1800-1919 | Silver | 5.24 | 92.50 |
| Shilling (1920-1946) | 1920-1946 | Silver | 5.24 | 50.00 |

This data is built into a reference lookup table in the code. When a coin's denomination, year, and country match a known entry, `PmWeightGrams` and `PmPercent` are auto-populated. Values can be manually overridden.

### 2.4 Melt Value Calculation

Replace the existing rough `weight × spotPrice` calculation with:

```
meltValue = (pmWeightGrams / 31.1035) × (pmPercent / 100) × spotPricePerTroyOz
```

Where 31.1035 converts grams to troy ounces. If `pmWeightGrams` or `pmPercent` is missing, melt value returns null (not a guess).

### 2.5 Performance

Skip `!Type:Prices` sections efficiently — when the parser encounters `!Type:Prices`, skip lines until the next `!Type:` or `!Account` header. This avoids iterating through 154K+ lines of stock price data.

---

## 3. UI Changes

### 3.1 Detail Sidebar Field Updates

| Field | Change |
|-------|--------|
| Name | **Removed** |
| Denomination | Free text → **Dropdown** from Denominations table + "Other" option (shows text input) |
| MintMark | Free text → **Dropdown** from MintMarks table + blank + "Other" option |
| CoinType | **New field** — free text input |
| Variety | **New field** — free text input |
| Grade | Stays free text, **widened** to fit "VF Details" |
| Year | Number → **text input** for ranges/BCE |
| PmWeightGrams | **New field** — numeric, auto-populated from reference data, editable |
| PmPercent | **New field** — numeric, auto-populated from reference data, editable |
| Melt Value | **New computed display** — read-only, calculated from PM fields × spot price |

### 3.2 Dropdown Behavior

- Denominations dropdown: grouped by country (US / GB), sorted by SortOrder, "Other" at bottom opens a text input
- MintMarks dropdown: sorted alphabetically with blank first, "Other" at bottom opens a text input
- Both dropdowns allow typing to filter/search

### 3.3 Maintainable Lists

Expand the existing Category modal (or a new "Settings" modal/tab) to manage:
- Denominations: add, remove (soft delete via IsActive), reorder
- MintMarks: add, remove (soft delete), edit description
- Same UX pattern as existing category/coin-set management

### 3.4 Inventory Table

- Add `CoinType` to `inventoryColumnOrder` as a selectable column
- Remove `Name` from column definitions
- Update `defaultVisibleColumns` to replace `name` with `coinType`

### 3.5 Notification Toasts

New toast/notification banner component at top of screen:
- **Info**: blue, auto-dismiss 5s
- **Warning**: yellow, auto-dismiss 8s
- **Error**: red, sticky with dismiss button
- Stacks multiple notifications
- Used for: database connection status, COMEX fetch results, import results, save errors

---

## 4. Backend Changes

### 4.1 Express Server Updates

- Update all SQL queries for new CamelCase schema
- Update `rowToCoin()` mapping for new column names
- Remove `Name` from all queries and mappings
- Add `CoinType` to all queries and mappings
- Change Year handling from numeric to string

### 4.2 New Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/denominations` | GET | List active denominations |
| `/api/denominations` | POST | Add new denomination |
| `/api/denominations/:id` | PUT | Update denomination |
| `/api/denominations/:id` | DELETE | Soft-delete (set IsActive=0) |
| `/api/mintmarks` | GET | List active mintmarks |
| `/api/mintmarks` | POST | Add new mintmark |
| `/api/mintmarks/:id` | PUT | Update mintmark |
| `/api/mintmarks/:id` | DELETE | Soft-delete (set IsActive=0) |
| `/api/spot-prices/fetch` | GET | Proxy call to metals.live API |
| `/api/log` | POST | Receive frontend log entries |

### 4.3 COMEX Proxy

- `GET /api/spot-prices/fetch` calls `https://api.metals.live/v1/spot` server-side
- Returns the same SpotPriceResult format
- Logs success/failure with details
- Avoids CORS issues on corporate network
- Frontend SpotPriceService calls this endpoint instead of metals.live directly

### 4.4 Database Connection

- `.env` updated: `DB_SERVER=BRUCE_PC\SQLEXPRESS`, no port (named instance resolution)
- Remove hard-coded `192.168.0.10` fallback from `buildDbConfig()`
- Connection errors return detailed messages: server unreachable, auth failure, database not found, etc.
- Startup: attempt connection, log result, report status to any connected frontend

---

## 5. Logging

### 5.1 Backend Logging

Simple file-based logger:
- Writes to `server/logs/app.log`
- Format: `[2026-08-28T14:30:00.000Z] [INFO] message`
- Levels: INFO, WARN, ERROR
- Uses `fs.appendFileSync` — no external dependencies
- Logs: all API requests (method, path, status), database operations, spot price fetches, errors with stack traces
- Log file rotation: not in v1 — file can be manually cleared

### 5.2 Frontend Logging

- `LoggingService` with methods: `info()`, `warn()`, `error()`
- When backend is available: POSTs to `/api/log` endpoint
- When backend unavailable: falls back to `console.log/warn/error`
- Automatically captures: component lifecycle errors, HTTP failures, import results

---

## 6. Exception Handling

### 6.1 Principle

The application never crashes out. Every error is caught, logged, shown to the user, and the app continues operating.

### 6.2 Frontend Strategy

- Angular `ErrorHandler` override to catch unhandled errors globally → log + show toast
- Every service method: try/catch with logging and user notification
- HTTP calls: catch network errors, timeouts, server errors → show specific messages
- Database unavailable: show banner, fall back to IndexedDB, continue working

### 6.3 Backend Strategy

- Every route handler: try/catch → log error with stack → return detailed JSON error response
- Global Express error handler: catches anything that slips through
- Database connection: retry logic on startup, detailed error in response
- COMEX fetch: timeout handling, network error details in response

### 6.4 Error Messages

User-facing messages are specific and actionable:
- "Cannot connect to database at BRUCE_PC\SQLEXPRESS — using local storage. Check that SQL Server is running."
- "COMEX price fetch failed: Connection timed out. Prices were not updated."
- "Failed to save coin: Database error — [specific SQL error]. Your changes are saved locally."

---

## 7. Storage Strategy

### 7.1 Primary: SQL Server via Express API

- New `ApiService` in Angular handles all HTTP calls to Express backend
- `InventoryService` uses `ApiService` for all CRUD operations
- On startup: attempt backend connection

### 7.2 Fallback: IndexedDB

- Keep existing `StorageService` as fallback
- Used when backend is unreachable (development, testing, database down)
- On startup failure: show notification, switch to IndexedDB mode
- No sync between IndexedDB and database — they are independent stores

### 7.3 Startup Flow

1. App starts → `InventoryService.hydrate()` called
2. Try `GET /api/coins` from backend
3. If successful: load from database, set `storageMode = 'database'`
4. If failed: log error, show notification, load from IndexedDB, set `storageMode = 'local'`
5. All subsequent operations route through the active storage mode

---

## 8. Model Changes

### 8.1 CoinRecord Interface

```typescript
export interface CoinRecord {
  id: string;
  // name: removed
  denomination: string;
  year: string;            // changed from number|null to string
  coinType: string;        // new field
  category: string;
  country: string;
  grade: string;           // simplified to string (freeform)
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
  pmWeightGrams?: number;    // precious metal weight in grams
  pmPercent?: number;        // fineness as percentage (90, 92.5, 50, 99.99, etc.)
  coinSet?: string;
}
```

### 8.2 New Interfaces

```typescript
export interface Denomination {
  denominationId: number;
  label: string;
  country: string;
  sortOrder: number;
  isActive: boolean;
}

export interface MintMark {
  mintMarkId: number;
  label: string;
  description: string;
  isActive: boolean;
}

export interface LogEntry {
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
  details?: string;
  source: 'frontend' | 'backend';
  timestamp: string;
}

export interface Notification {
  id: string;
  type: 'info' | 'warning' | 'error';
  message: string;
  autoDismiss: boolean;
  duration?: number;
}
```

---

## 9. Test Strategy

- All database interactions mocked (database may not be present on dev machine)
- Update existing 82+ frontend tests for model changes (Name removal, Year as string, new fields)
- Update existing 29 server tests for new schema
- New tests for:
  - Net-quantity QIF filtering
  - Improved attribute parsing (year, mintmark, grade, denomination extraction)
  - NotificationService toast behavior
  - LoggingService routing (backend vs console fallback)
  - ApiService HTTP calls and error handling
  - Denomination/MintMark dropdown components
  - Fallback storage mode switching

---

## 10. Files Affected

**New files:**
- `server/setup-database.sql` — complete database script
- `src/app/services/api.service.ts` — HTTP calls to backend
- `src/app/services/logging.service.ts` — frontend logging
- `src/app/services/notification.service.ts` — toast notifications
- `src/app/components/notification-toast/` — toast UI component
- `server/logger.ts` — backend file logger

**Major modifications:**
- `server/server.ts` — new endpoints, CamelCase queries, COMEX proxy, logging
- `server/.env` — corrected connection string
- `src/app/types/coin.model.ts` — model changes
- `src/app/types/inventory-columns.ts` — column changes
- `src/app/services/inventory.service.ts` — rewire to ApiService with fallback
- `src/app/services/quicken-import.service.ts` — net-quantity filter, attribute parsing
- `src/app/services/spot-price.service.ts` — proxy through backend
- `src/app/app.ts` — field changes, dropdowns, error handling
- `src/app/app.html` — template updates for new fields/dropdowns
- `src/app/components/quicken-import-modal/` — preview shows filtered results
- `src/app/components/category-modal/` — expanded for denomination/mintmark management

**Deleted/replaced:**
- `server/schema.sql` — replaced by `setup-database.sql`
