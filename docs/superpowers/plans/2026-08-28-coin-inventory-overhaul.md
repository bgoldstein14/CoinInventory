# Coin Inventory Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul the coin inventory app — rewrite database schema, improve QIF import with net-quantity filtering and attribute parsing, add denomination/mintmark dropdowns, COMEX proxy, logging, exception handling, and database-first storage with IndexedDB fallback.

**Architecture:** Angular 22 frontend with signal-based state management talks to an Express backend backed by SQL Server Express. All persistence routes through an ApiService that falls back to IndexedDB when the backend is unreachable. A simple file logger handles both backend and frontend log entries.

**Tech Stack:** Angular 22, TypeScript, Express 4, mssql 11, SQL Server Express, Vitest 4, IndexedDB (fallback)

**Spec:** `docs/superpowers/specs/2026-08-28-coin-inventory-overhaul-design.md`

## Global Constraints

- Build/serve from `C:/Users/BR651094/source/dev/` (local C: drive), not I:/ network share
- Angular 22 standalone components with signals — no NgModules
- Vitest 4.x for all tests — mock all database interactions
- SQL Server CamelCase naming convention for all tables/columns
- Add helpful comments throughout all code (user is Angular novice)
- App must never crash — catch all errors, show user-facing messages, log, continue
- Keep IndexedDB fallback for dev/testing when database is unavailable
- Copy finished work back to I:/ when complete

---

### Task 1: Database Schema Script

**Files:**
- Create: `server/setup-database.sql`
- Delete: `server/schema.sql` (replaced)

**Produces:**
- All table DDL with CamelCase naming
- Seeded Denominations table (US + GB)
- Seeded MintMarks table
- Used by Task 4 (server queries) and Task 3 (model types must match)

- [ ] **Step 1: Write the setup-database.sql script**

Create `server/setup-database.sql` with:
- `USE master; IF NOT EXISTS create database CoinInventory`
- Drop all existing tables (reverse FK order)
- Create Coins table: CoinId (UNIQUEIDENTIFIER PK DEFAULT NEWID()), Denomination NVARCHAR(100), Year NVARCHAR(50), CoinType NVARCHAR(100), Category NVARCHAR(100), Country NVARCHAR(100), Grade NVARCHAR(50), CertCompany NVARCHAR(100), CertNumber NVARCHAR(100), Variety NVARCHAR(100), MintMark NVARCHAR(20), Composition NVARCHAR(100), PurchaseDate NVARCHAR(30), PurchasePrice DECIMAL(12,2), CurrentValue DECIMAL(12,2), Notes NVARCHAR(MAX), Source NVARCHAR(50), HasCacSticker BIT DEFAULT 0, SoldPrice DECIMAL(12,2) NULL, SoldDate NVARCHAR(30) NULL, Dealer NVARCHAR(200) NULL, Weight DECIMAL(10,4) NULL, MetalContent NVARCHAR(50) NULL, PmWeightGrams DECIMAL(10,4) NULL, PmPercent DECIMAL(5,2) NULL, CoinSet NVARCHAR(100) NULL
- NO Name column
- Create CoinImages: ImageId INT IDENTITY PK, CoinId UNIQUEIDENTIFIER FK CASCADE, ImageData NVARCHAR(MAX), SortOrder INT DEFAULT 0
- Create CoinTags: CoinId + Tag composite PK, FK CASCADE
- Create Categories: CategoryName NVARCHAR(100) PK
- Create CoinSets: SetName NVARCHAR(100) PK
- Create Transactions: TransactionId UNIQUEIDENTIFIER PK DEFAULT NEWID(), CoinId FK CASCADE, TransactionType NVARCHAR(50), TransactionDate NVARCHAR(30), Amount DECIMAL(12,2), Dealer NVARCHAR(200), Notes NVARCHAR(MAX)
- Create SpotPrices: SpotPriceId INT IDENTITY PK, Gold/Silver/Platinum DECIMAL(10,2), Copper DECIMAL(10,4), Source NVARCHAR(200), FetchedAt DATETIME2 DEFAULT GETDATE()
- Create AppSettings: SettingKey NVARCHAR(100) PK, SettingValue NVARCHAR(MAX)
- Create Denominations: DenominationId INT IDENTITY PK, Label NVARCHAR(100), Country NVARCHAR(100), SortOrder INT, IsActive BIT DEFAULT 1
- Create MintMarks: MintMarkId INT IDENTITY PK, Label NVARCHAR(20), Description NVARCHAR(200), IsActive BIT DEFAULT 1
- All indexes: CoinImages(CoinId), CoinTags(CoinId), Coins(Category), Coins(Grade), Coins(Year), Coins(CoinSet), Coins(Dealer), Coins(MetalContent), Coins(CoinType), Transactions(CoinId)
- Seed US denominations (16 rows): ½¢, 1¢, 2¢, 3¢ Silver, 3¢ Nickel, 5¢, 10¢, 20¢, 25¢, 50¢, $1, $2.50, $3, $5, $10, $20
- Seed GB denominations (21 rows): Farthing, ½d, 1d, 3d, 6d, 1/-, 2/- (Florin), 2/6 (Half Crown), 5/- (Crown), ½ Sovereign, Sovereign, Guinea, ½p, 1p, 2p, 5p, 10p, 20p, 50p, £1, £2, £5
- Seed MintMarks (9 rows): (blank), P, D, S, W, O, CC, C, Other

- [ ] **Step 2: Delete old schema.sql**

```bash
rm server/schema.sql
```

- [ ] **Step 3: Commit**

```bash
git add server/setup-database.sql
git rm server/schema.sql
git commit -m "feat: rewrite database schema with CamelCase naming, denomination/mintmark seed data"
```

---

### Task 2: Update Data Models

**Files:**
- Modify: `src/app/types/coin.model.ts`
- Modify: `src/app/types/inventory-columns.ts`

**Produces:**
- Updated `CoinRecord` interface (no `name`, `year` is string, new `coinType`, `pmWeightGrams`, `pmPercent`)
- New `Denomination`, `MintMark`, `LogEntry`, `AppNotification` interfaces
- Updated column definitions (no `name`, add `coinType`, `meltValue`)
- Consumed by every subsequent task

- [ ] **Step 1: Update coin.model.ts**

Replace the full file. Key changes:
- Remove `CoinGrade` union type (grade is now freeform string)
- `CoinRecord`: remove `name`, rename `type` to `coinType`, change `year: number | null` to `year: string`, change `grade: CoinGrade | string` to `grade: string`, add `pmWeightGrams?: number`, `pmPercent?: number`
- `QuickenImportRecord`: remove `name`, add `year: string`, `coinType: string`, `grade: string`, `mintMark: string`, `variety: string`, `pmWeightGrams?: number`, `pmPercent?: number`
- Add `Denomination` interface: `denominationId: number, label: string, country: string, sortOrder: number, isActive: boolean`
- Add `MintMarkOption` interface: `mintMarkId: number, label: string, description: string, isActive: boolean`
- Add `LogEntry` interface: `level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string, source: 'frontend' | 'backend', timestamp: string`
- Add `AppNotification` interface: `id: string, type: 'info' | 'warning' | 'error', message: string, autoDismiss: boolean, duration?: number`

- [ ] **Step 2: Update inventory-columns.ts**

- Replace `'name'` with `'coinType'` in `inventoryColumnOrder`
- Add `'pmWeightGrams'`, `'pmPercent'`, `'meltValue'` to column order
- Update `inventoryColumnLabels`: remove `name: 'Name'`, add `coinType: 'Type'`, `pmWeightGrams: 'PM Weight (g)'`, `pmPercent: 'PM %'`, `meltValue: 'Melt Value'`
- Update `defaultVisibleColumns`: replace `'name'` with `'coinType'`
- Update `formatInventoryCell`: remove `name` case, add `coinType` case, update `year` case (already a string, no conversion needed), add `pmWeightGrams`/`pmPercent`/`meltValue` cases

- [ ] **Step 3: Run tests to see what breaks**

```bash
npx vitest run --root src 2>&1 | head -80
```

Expected: Many failures due to `name` references throughout tests and components.

- [ ] **Step 4: Commit**

```bash
git add src/app/types/coin.model.ts src/app/types/inventory-columns.ts
git commit -m "feat: update data models - remove name, year as string, add coinType/PM fields"
```

---

### Task 3: Backend Logger

**Files:**
- Create: `server/logger.ts`

**Produces:**
- `log(level, message, details?)` function
- `logInfo(msg)`, `logWarn(msg)`, `logError(msg, err?)` convenience functions
- Writes to `server/logs/app.log`
- Consumed by Task 4 (server) and Task 8 (log endpoint)

- [ ] **Step 1: Write server/logger.ts**

```typescript
import fs from 'fs';
import path from 'path';

// Log file lives alongside the server code
const LOG_DIR = path.resolve(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

// Ensure the logs directory exists on first import
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Appends a timestamped line to the log file.
// Uses appendFileSync so log writes are immediate and ordered.
export function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string): void {
  const timestamp = new Date().toISOString();
  const line = details
    ? `[${timestamp}] [${level}] ${message} | ${details}\n`
    : `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // If we can't write to the log file, fall back to console
    console.error(`[LOG WRITE FAILED] ${line}`);
  }
  // Also echo to console so dev-mode output is visible
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

export function logInfo(message: string): void { log('INFO', message); }
export function logWarn(message: string): void { log('WARN', message); }
export function logError(message: string, err?: unknown): void {
  const details = err instanceof Error ? `${err.message}\n${err.stack}` : String(err ?? '');
  log('ERROR', message, details);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/logger.ts
git commit -m "feat: add simple file-based backend logger"
```

---

### Task 4: Rewrite Express Server

**Files:**
- Modify: `server/server.ts`
- Modify: `server/.env`
- Modify: `server/.env.example`

**Consumes:** Task 1 schema (CamelCase column names), Task 3 logger
**Produces:**
- All SQL queries using CamelCase column names
- `rowToCoin()` mapping updated for new schema (no name, year as string, coinType, PM fields)
- New endpoints: GET/POST/PUT/DELETE `/api/denominations`, GET/POST/PUT/DELETE `/api/mintmarks`, GET `/api/spot-prices/fetch` (COMEX proxy), POST `/api/log`
- Updated `.env` with correct server name
- Consumed by Task 6 (ApiService) and Task 8 (SpotPriceService)

- [ ] **Step 1: Update .env and .env.example**

Both files should contain:
```
DB_SERVER=BRUCE_PC\SQLEXPRESS
DB_NAME=CoinInventory
DB_USER=
DB_PASSWORD=
PORT=3000
```
Remove `DB_PORT` — named instance resolution, no port needed.

- [ ] **Step 2: Rewrite buildDbConfig()**

Remove hard-coded `192.168.0.10` fallback and port. For named instances, omit port entirely:
```typescript
function buildDbConfig(): sql.config {
  const user = process.env['DB_USER'];
  const useWindowsAuth = !user;
  const config: sql.config = {
    server: process.env['DB_SERVER'] ?? 'BRUCE_PC\\SQLEXPRESS',
    database: process.env['DB_NAME'] ?? 'CoinInventory',
    options: { encrypt: false, trustServerCertificate: true },
  };
  if (useWindowsAuth) {
    config.driver = 'msnodesqlv8';
    (config.options as Record<string, unknown>)['trustedConnection'] = true;
  } else {
    config.user = user;
    config.password = process.env['DB_PASSWORD'];
  }
  return config;
}
```

- [ ] **Step 3: Update getPool() with logging and detailed errors**

```typescript
async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    const config = buildDbConfig();
    logInfo(`Connecting to SQL Server at ${config.server}/${config.database}...`);
    try {
      pool = await sql.connect(config);
      logInfo('Connected to SQL Server successfully');
    } catch (err) {
      logError('Failed to connect to SQL Server', err);
      throw err;
    }
  }
  return pool;
}
```

- [ ] **Step 4: Update rowToCoin() for new schema**

Map CamelCase DB columns to camelCase JS properties. Remove `name`, add `coinType`, `pmWeightGrams`, `pmPercent`, year as string:
```typescript
function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['CoinId'],
    denomination: row['Denomination'] ?? '',
    year: row['Year'] ?? '',
    coinType: row['CoinType'] ?? '',
    category: row['Category'] ?? '',
    country: row['Country'] ?? '',
    grade: row['Grade'] ?? '',
    certCompany: row['CertCompany'] ?? '',
    certNumber: row['CertNumber'] ?? '',
    variety: row['Variety'] ?? '',
    mintMark: row['MintMark'] ?? '',
    composition: row['Composition'] ?? '',
    purchaseDate: row['PurchaseDate'] ?? '',
    purchasePrice: row['PurchasePrice'] ?? 0,
    currentValue: row['CurrentValue'] ?? 0,
    notes: row['Notes'] ?? '',
    source: row['Source'] ?? 'manual',
    hasCacSticker: row['HasCacSticker'] === true || row['HasCacSticker'] === 1,
    soldPrice: row['SoldPrice'] ?? undefined,
    soldDate: row['SoldDate'] ?? undefined,
    dealer: row['Dealer'] ?? undefined,
    weight: row['Weight'] ?? undefined,
    metalContent: row['MetalContent'] ?? undefined,
    pmWeightGrams: row['PmWeightGrams'] ?? undefined,
    pmPercent: row['PmPercent'] ?? undefined,
    coinSet: row['CoinSet'] ?? undefined,
  };
}
```

- [ ] **Step 5: Update all coin CRUD queries**

Update GET /api/coins, GET /api/coins/:id, POST /api/coins, PUT /api/coins/:id, DELETE /api/coins/:id to use CamelCase column names (CoinId, Denomination, Year, CoinType, etc.), remove Name references, add CoinType/PmWeightGrams/PmPercent. Add `logInfo`/`logError` calls to every route. Change validation from `if (!body.name)` to just generate ID if missing.

- [ ] **Step 6: Update CoinImages, CoinTags, Categories, CoinSets, Transactions, SpotPrices, Settings queries**

All table/column references updated to CamelCase:
- `coin_images` → `CoinImages`, `coin_id` → `CoinId`, `image_data` → `ImageData`, `sort_order` → `SortOrder`
- `coin_tags` → `CoinTags`
- `categories` → `Categories`, `name` → `CategoryName`
- `coin_sets` → `CoinSets`, `name` → `SetName`
- `transactions` → `Transactions`, all columns CamelCase
- `spot_prices` → `SpotPrices`, `fetched_at` → `FetchedAt`
- `app_settings` → `AppSettings`, `setting_key` → `SettingKey`, `setting_value` → `SettingValue`

- [ ] **Step 7: Add Denominations CRUD endpoints**

```typescript
// GET /api/denominations — returns active denominations sorted by country then sort order
// POST /api/denominations — body: { label, country, sortOrder }
// PUT /api/denominations/:id — body: { label, country, sortOrder }
// DELETE /api/denominations/:id — sets IsActive = 0 (soft delete)
```

- [ ] **Step 8: Add MintMarks CRUD endpoints**

```typescript
// GET /api/mintmarks — returns active mintmarks
// POST /api/mintmarks — body: { label, description }
// PUT /api/mintmarks/:id — body: { label, description }
// DELETE /api/mintmarks/:id — sets IsActive = 0 (soft delete)
```

- [ ] **Step 9: Add COMEX proxy endpoint**

```typescript
// GET /api/spot-prices/fetch — proxies to metals.live, returns SpotPriceResult
app.get('/api/spot-prices/fetch', async (_req, res) => {
  logInfo('Fetching spot prices from metals.live...');
  try {
    const response = await fetch('https://api.metals.live/v1/spot');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const prices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
    for (const entry of data) {
      if (entry['gold'] !== undefined) prices.gold = entry['gold'];
      if (entry['silver'] !== undefined) prices.silver = entry['silver'];
      if (entry['platinum'] !== undefined) prices.platinum = entry['platinum'];
      if (entry['copper'] !== undefined) prices.copper = entry['copper'];
    }
    logInfo(`Spot prices fetched: Au=$${prices.gold} Ag=$${prices.silver}`);
    res.json({ prices, source: 'COMEX via metals.live', timestamp: new Date().toISOString() });
  } catch (err) {
    logError('Spot price fetch failed', err);
    res.json({ prices: { gold: 0, silver: 0, platinum: 0, copper: 0 }, source: 'COMEX via metals.live', timestamp: new Date().toISOString(), error: err instanceof Error ? err.message : 'Unknown error' });
  }
});
```

- [ ] **Step 10: Add frontend log endpoint**

```typescript
// POST /api/log — receives { level, message, details, source } from frontend
app.post('/api/log', (req, res) => {
  const { level, message, details, source } = req.body;
  log(level ?? 'INFO', `[${source ?? 'frontend'}] ${message}`, details);
  res.status(204).send();
});
```

- [ ] **Step 11: Add request logging middleware**

```typescript
// Log every API request
app.use('/api', (req, _res, next) => {
  logInfo(`${req.method} ${req.path}`);
  next();
});
```
Place this BEFORE all route definitions.

- [ ] **Step 12: Commit**

```bash
git add server/server.ts server/.env server/.env.example
git commit -m "feat: rewrite server for CamelCase schema, add COMEX proxy, denomination/mintmark endpoints, logging"
```

---

### Task 5: Frontend Logging, Notification, and API Services

**Files:**
- Create: `src/app/services/logging.service.ts`
- Create: `src/app/services/notification.service.ts`
- Create: `src/app/services/api.service.ts`
- Create: `src/app/components/notification-toast/notification-toast.ts`
- Create: `src/app/components/notification-toast/notification-toast.html`
- Create: `src/app/components/notification-toast/notification-toast.scss`
- Modify: `src/app/app.config.ts` — add `provideHttpClient()`

**Produces:**
- `LoggingService` with `info()`, `warn()`, `error()` methods
- `NotificationService` with `show()`, `showError()`, `showWarning()`, `showInfo()`, `dismiss()` methods and `notifications` signal
- `ApiService` with typed methods for all backend endpoints
- `NotificationToast` component for displaying stacked toasts
- Consumed by Task 6 (InventoryService), Task 7 (QIF), Task 8 (SpotPrice), Task 9 (UI)

- [ ] **Step 1: Add provideHttpClient to app.config.ts**

```typescript
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient()
  ]
};
```

- [ ] **Step 2: Create LoggingService**

`src/app/services/logging.service.ts` — Injectable service. Uses `HttpClient` to POST to `/api/log`. Falls back to console when backend unavailable. Methods: `info(msg)`, `warn(msg)`, `error(msg, details?)`.

- [ ] **Step 3: Create NotificationService**

`src/app/services/notification.service.ts` — Injectable service with a `notifications` signal. Methods: `showInfo(msg, duration=5000)`, `showWarning(msg, duration=8000)`, `showError(msg)` (sticky), `dismiss(id)`. Each notification gets a `crypto.randomUUID()` id. Auto-dismiss uses `setTimeout`.

- [ ] **Step 4: Create NotificationToast component**

`src/app/components/notification-toast/` — Standalone component that injects `NotificationService` and renders stacked toasts at top-right. Color-coded: blue=info, yellow=warning, red=error. Error toasts have an X dismiss button.

- [ ] **Step 5: Create ApiService**

`src/app/services/api.service.ts` — Injectable, uses `HttpClient`. Base URL from environment or defaults to `http://localhost:3000`. Methods:
- `getCoins(): Observable<CoinRecord[]>`
- `getCoin(id): Observable<CoinRecord>`
- `createCoin(coin): Observable<{id: string}>`
- `updateCoin(id, coin): Observable<void>`
- `deleteCoin(id): Observable<void>`
- `getDenominations(): Observable<Denomination[]>`
- `createDenomination(d): Observable<Denomination>`
- `updateDenomination(id, d): Observable<void>`
- `deleteDenomination(id): Observable<void>`
- `getMintMarks(): Observable<MintMarkOption[]>`
- `createMintMark(m): Observable<MintMarkOption>`
- `updateMintMark(id, m): Observable<void>`
- `deleteMintMark(id): Observable<void>`
- `getCategories(): Observable<string[]>`
- `createCategory(name): Observable<void>`
- `deleteCategory(name): Observable<void>`
- `getCoinSets(): Observable<string[]>`
- `createCoinSet(name): Observable<void>`
- `deleteCoinSet(name): Observable<void>`
- `getTransactions(coinId?): Observable<TransactionRecord[]>`
- `createTransaction(t): Observable<void>`
- `deleteTransaction(id): Observable<void>`
- `fetchSpotPrices(): Observable<SpotPriceResult>`
- `saveSpotPrices(prices): Observable<void>`
- `postLog(entry): Observable<void>`
- `healthCheck(): Observable<boolean>` — GET /api/coins with timeout, returns true/false

All methods include `.pipe(catchError(...))` that logs via LoggingService and shows notification via NotificationService.

- [ ] **Step 6: Commit**

```bash
git add src/app/app.config.ts src/app/services/logging.service.ts src/app/services/notification.service.ts src/app/services/api.service.ts src/app/components/notification-toast/
git commit -m "feat: add ApiService, LoggingService, NotificationService, toast component"
```

---

### Task 6: Rewire InventoryService for API-First with Fallback

**Files:**
- Modify: `src/app/services/inventory.service.ts`

**Consumes:** Task 5 (ApiService, LoggingService, NotificationService), Task 2 (updated CoinRecord)
**Produces:**
- `storageMode` signal: `'database' | 'local'`
- `hydrate()` tries backend first, falls back to IndexedDB
- All mutations (add/update/delete) route through active storage mode
- `denominations` and `mintMarks` signals loaded from API
- Updated `meltValue()` using pmWeightGrams and pmPercent
- Consumed by Task 9 (UI binds to these signals)

- [ ] **Step 1: Add new dependencies and signals**

Inject `ApiService`, `LoggingService`, `NotificationService` alongside existing `StorageService`. Add signals:
```typescript
readonly storageMode = signal<'database' | 'local'>('local');
readonly denominations = signal<Denomination[]>([]);
readonly mintMarks = signal<MintMarkOption[]>([]);
```

- [ ] **Step 2: Rewrite hydrate()**

Try `apiService.getCoins()` first. On success: set storageMode='database', load denominations and mintmarks from API. On failure: log error, show notification "Cannot connect to database — using local storage", fall back to IndexedDB hydrate.

- [ ] **Step 3: Update all mutation methods**

`addBlankCoin()`, `updateCoin()`, `deleteCoin()`, `addCoins()`: when storageMode='database', call ApiService methods. When 'local', use IndexedDB as before. Wrap in try/catch, show notification on failure.

Remove `name: 'New Coin'` from `addBlankCoin()`. Change `year: null` to `year: ''`. Add `coinType: ''`, `pmWeightGrams: undefined`, `pmPercent: undefined`.

- [ ] **Step 4: Update meltValue()**

Replace weight-based calculation with PM-based:
```typescript
meltValue(coin: CoinRecord): number | null {
  const pmWeight = coin.pmWeightGrams ?? 0;
  const pmPct = coin.pmPercent ?? 0;
  const metal = (coin.metalContent ?? '').toLowerCase();
  if (pmWeight <= 0 || pmPct <= 0 || !metal) return null;
  const prices = this.spotPrices();
  const GRAMS_PER_TROY_OZ = 31.1035;
  let spotPerOz = 0;
  if (metal.includes('gold')) spotPerOz = prices.gold;
  else if (metal.includes('silver')) spotPerOz = prices.silver;
  else if (metal.includes('platinum')) spotPerOz = prices.platinum;
  else if (metal.includes('copper')) spotPerOz = prices.copper;
  if (spotPerOz <= 0) return null;
  return (pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz;
}
```

- [ ] **Step 5: Update denomination/mintmark management methods**

Add methods: `loadDenominations()`, `loadMintMarks()`, `addDenomination()`, `removeDenomination()`, `addMintMark()`, `removeMintMark()`. When storageMode='database', call API. When 'local', manage in-memory signal arrays.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/inventory.service.ts
git commit -m "feat: rewire InventoryService for API-first with IndexedDB fallback"
```

---

### Task 7: QIF Import Improvements

**Files:**
- Modify: `src/app/services/quicken-import.service.ts`
- Create: `src/app/services/pm-reference.ts` (precious metal reference data)

**Consumes:** Task 2 (updated QuickenImportRecord)
**Produces:**
- Net-quantity filtering (only import coins with qty > 0)
- Improved attribute parsing: year (string), mintmark, grade, denomination, variety from security name
- PM weight/percent pre-fill from reference data
- Efficient `!Type:Prices` section skipping
- Updated `QuickenParseResult` with `skippedRecords` for sold/transferred coins

- [ ] **Step 1: Create pm-reference.ts**

Reference lookup table for precious metal content. Export `lookupPmData(denomination: string, year: string, country: string): { pmWeightGrams: number, pmPercent: number, metalContent: string } | null`.

Contains the known PM data from the spec:
- US gold coins: $20 (30.09g/90%), $10 (15.05g/90%), $5 (7.52g/90%), $2.50 (3.76g/90%), $3 (4.54g/90%), $1 gold (1.50g/90%)
- US silver coins: 50¢ pre-1965 (11.25g/90%), 25¢ pre-1965 (5.63g/90%), 10¢ pre-1965 (2.25g/90%), 5¢ half dime (1.20g/90%), 3¢ silver (0.75g/90%), $1 silver (24.06g/90%), 50¢ Kennedy 1965-1970 (9.20g/40%), 20¢ (4.50g/90%)
- GB gold: Sovereign (7.32g/91.67%), ½ Sovereign (3.66g/91.67%)
- GB silver pre-1920: Crown (26.18g/92.5%), Half Crown (13.09g/92.5%), Florin (10.47g/92.5%), Shilling (5.24g/92.5%)
- GB silver 1920-1946: same weights but 50% silver

Match by denomination label and year range.

- [ ] **Step 2: Add net-quantity filtering to parse()**

After parsing all transaction blocks, before returning:
1. Build a map: `Map<string, { qty: number, latestAcquisition: QuickenImportRecord | null }>`
2. For each record in `records`: increment qty by +1. Save as latestAcquisition if newer.
3. For disposition records (currently skipped with warning): decrement qty by -1 for that security name.
4. Filter `records` to only include securities with net qty > 0, using the latest acquisition record.
5. Add `skippedRecords` to result for securities with net qty <= 0.

This requires also tracking disposition records, so modify the disposition handling: instead of just adding a warning and continuing, also track the security name for net-quantity calculation.

- [ ] **Step 3: Improve attribute parsing**

Add private methods:
- `parseAttributes(securityName: string): { year: string, mintMark: string, grade: string, denomination: string, variety: string, coinType: string }`
- Uses regex to extract: year (leading digits, supports BCE ranges), mintmark (letter after 4-digit year), grade (patterns like VF, EF, XF, AU, AU58, CH+AU, VF/EF after - or space), denomination (3CS→3¢ Silver, 3CN→3¢ Nickel, 2c→2¢, 20c→20¢, half→50¢, etc.)

Update `inferDenomination()` to return symbolic format (25¢ not Quarter, etc.) matching the Denominations table labels.

- [ ] **Step 4: Update record construction to use parsed attributes and PM lookup**

In the record creation section, call `parseAttributes()` and `lookupPmData()`:
```typescript
const attrs = this.parseAttributes(fields.security);
const pmData = lookupPmData(attrs.denomination, attrs.year, 'United States');
records.push({
  id: crypto.randomUUID(),
  denomination: attrs.denomination,
  year: attrs.year,
  coinType: attrs.coinType,
  grade: attrs.grade,
  mintMark: attrs.mintMark,
  variety: attrs.variety,
  account: currentAccount ?? 'Unassigned',
  purchaseDate: fields.date ? this.normalizeDate(fields.date) : undefined,
  purchasePrice,
  currentValue: purchasePrice,
  country: 'United States',
  notes: fields.memo ?? '',
  source: 'quicken',
  pmWeightGrams: pmData?.pmWeightGrams,
  pmPercent: pmData?.pmPercent,
});
```

- [ ] **Step 5: Optimize !Type:Prices skipping**

In the block iteration, detect `!Type:Prices` and skip the entire block immediately without parsing fields.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/quicken-import.service.ts src/app/services/pm-reference.ts
git commit -m "feat: QIF import - net-quantity filtering, attribute parsing, PM pre-fill"
```

---

### Task 8: Update SpotPriceService to Proxy Through Backend

**Files:**
- Modify: `src/app/services/spot-price.service.ts`

**Consumes:** Task 5 (ApiService, LoggingService, NotificationService)

- [ ] **Step 1: Rewrite fetchSpotPrices()**

Inject ApiService, LoggingService, NotificationService. Call backend proxy endpoint instead of metals.live directly:
```typescript
async fetchSpotPrices(): Promise<SpotPriceResult> {
  try {
    this.loggingService.info('Fetching spot prices via backend proxy...');
    const result = await firstValueFrom(this.apiService.fetchSpotPrices());
    if (result.error) {
      this.notificationService.showWarning(`Spot price fetch: ${result.error}`);
      this.loggingService.warn(`Spot price fetch returned error: ${result.error}`);
    } else {
      this.notificationService.showInfo('Spot prices updated successfully');
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    this.loggingService.error('Spot price fetch failed', msg);
    this.notificationService.showError(`COMEX price fetch failed: ${msg}`);
    return { prices: { gold: 0, silver: 0, platinum: 0, copper: 0 }, source: 'COMEX via metals.live', timestamp: new Date().toISOString(), error: msg };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/services/spot-price.service.ts
git commit -m "feat: proxy spot price fetch through backend, add error notifications"
```

---

### Task 9: UI Updates — Detail Sidebar, Dropdowns, Toasts

**Files:**
- Modify: `src/app/app.ts`
- Modify: `src/app/app.html`
- Modify: `src/app/components/category-modal/category-modal.ts`
- Modify: `src/app/components/category-modal/category-modal.html`
- Modify: `src/app/components/quicken-import-modal/quicken-import-modal.ts`
- Modify: `src/app/components/quicken-import-modal/quicken-import-modal.html`

**Consumes:** Task 2 (models), Task 5 (NotificationToast), Task 6 (InventoryService signals)

- [ ] **Step 1: Add NotificationToast to app.ts imports and template**

Import and add `<app-notification-toast />` at the top of app.html.

- [ ] **Step 2: Remove Name field from detail sidebar in app.html**

Delete the Name label/input pair.

- [ ] **Step 3: Add CoinType and Variety fields to detail sidebar**

Add free-text inputs for Coin Type and Variety in the detail form section.

- [ ] **Step 4: Change Denomination to dropdown**

Replace the text input with a `<select>` bound to `inv.denominations()`, grouped by country with `<optgroup>`. Include an "Other" option that reveals a text input for custom values.

- [ ] **Step 5: Change MintMark to dropdown**

Replace text input with `<select>` bound to `inv.mintMarks()`. Include blank option and "Other" that reveals text input.

- [ ] **Step 6: Change Year to text input**

Change `type="number"` to `type="text"` on the year input.

- [ ] **Step 7: Widen Grade field**

Ensure the grade input can display "VF Details" comfortably.

- [ ] **Step 8: Add PM fields and melt value display**

Add PM Weight (g) and PM % inputs. Show computed melt value as read-only display below them.

- [ ] **Step 9: Update app.ts — remove name references, update addBlankCoin call**

Remove any references to `coin.name` in the component logic. Update search to not reference name.

- [ ] **Step 10: Expand Category Modal for denomination/mintmark management**

Add tabs or sections to `category-modal` for managing Denominations and MintMarks lists (add/remove), same pattern as existing category management.

- [ ] **Step 11: Update Quicken Import Modal**

Show "Sold/Transferred" indicator on filtered-out coins in the preview. Display parsed attributes (year, grade, mintmark, denomination) in the preview table.

- [ ] **Step 12: Commit**

```bash
git add src/app/app.ts src/app/app.html src/app/components/
git commit -m "feat: UI overhaul - dropdowns, new fields, toasts, remove Name"
```

---

### Task 10: Update All Tests

**Files:**
- Modify: `src/app/app.spec.ts`
- Modify: `src/app/services/quicken-import.service.spec.ts`
- Modify: `src/app/services/spot-price.service.spec.ts`
- Modify: `src/app/services/storage.service.spec.ts`
- Modify: `src/app/services/image-matching.service.spec.ts`
- Modify: `src/app/components/category-modal/category-modal.spec.ts`
- Modify: `src/app/components/csv-import-modal/csv-import-modal.spec.ts`
- Modify: `src/app/components/image-import-modal/image-import-modal.spec.ts`
- Modify: `src/app/components/quicken-import-modal/quicken-import-modal.spec.ts`
- Modify: `src/app/components/report-modal/report-modal.spec.ts`
- Modify: `src/app/components/spot-price-modal/spot-price-modal.spec.ts`
- Modify: `server/server.spec.ts`
- Create: `src/app/services/api.service.spec.ts`
- Create: `src/app/services/notification.service.spec.ts`
- Create: `src/app/services/logging.service.spec.ts`
- Create: `src/app/services/pm-reference.spec.ts`
- Create: `src/app/components/notification-toast/notification-toast.spec.ts`

**Approach:** Run tests after each sub-step, fix failures iteratively.

- [ ] **Step 1: Update all test fixtures**

Every test that creates a `CoinRecord` must be updated: remove `name` property, change `year` from number to string, add `coinType: ''`. Search for `name:` in all spec files and update.

- [ ] **Step 2: Update quicken-import.service.spec.ts**

Add tests for:
- Net-quantity filtering: coin bought then sold → not imported
- Net-quantity filtering: coin bought, never sold → imported
- Attribute parsing: `1875S 20c-XF` → year='1875', mintMark='S', denomination='20¢', grade='XF'
- Attribute parsing: `1861 3CS - AU` → year='1861', denomination='3¢ Silver', grade='AU'
- PM pre-fill: 25¢ year 1960 → pmWeightGrams=5.63, pmPercent=90

- [ ] **Step 3: Write pm-reference.spec.ts**

Test `lookupPmData()` for known US and GB coins, and unknown coins returning null.

- [ ] **Step 4: Write api.service.spec.ts**

Mock HttpClient using Vitest. Test each method calls the correct endpoint.

- [ ] **Step 5: Write notification.service.spec.ts**

Test show/dismiss behavior, auto-dismiss timers (use vi.useFakeTimers), notification stacking.

- [ ] **Step 6: Write logging.service.spec.ts**

Test that it calls HttpClient POST to /api/log, and falls back to console on error.

- [ ] **Step 7: Update server.spec.ts**

Update all mocked SQL queries for CamelCase column names. Add tests for new endpoints: denominations CRUD, mintmarks CRUD, spot-prices/fetch proxy, log endpoint.

- [ ] **Step 8: Run full test suite and fix remaining failures**

```bash
npx vitest run --root src
cd server && npx vitest run
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "test: update all tests for overhaul - new models, services, endpoints"
```

---

### Task 11: Global Error Handler

**Files:**
- Create: `src/app/services/global-error-handler.ts`
- Modify: `src/app/app.config.ts`

- [ ] **Step 1: Create GlobalErrorHandler**

```typescript
import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';

// Catches any unhandled error in the Angular app.
// Logs it and shows a toast so the user knows something went wrong
// without the app crashing.
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly logging = inject(LoggingService);
  private readonly notifications = inject(NotificationService);

  handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    this.logging.error('Unhandled error', message);
    this.notifications.showError(message);
  }
}
```

- [ ] **Step 2: Register in app.config.ts**

Add `{ provide: ErrorHandler, useClass: GlobalErrorHandler }` to providers.

- [ ] **Step 3: Commit**

```bash
git add src/app/services/global-error-handler.ts src/app/app.config.ts
git commit -m "feat: add global error handler - catches unhandled errors, shows toast"
```
