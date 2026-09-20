# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, an admin-managed category system, a Quicken (QIF) import workflow, a directory-based photo matching workflow, and persistence in SQL Server via a small Express API (the browser's IndexedDB now only holds UI preferences) — all designed around an inventory-first layout where the collection table is the center of the experience.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next — rather than re-discovering the codebase from scratch.

## Current state (as of 2026-09-20)

The application is functioning end-to-end. The most recent round of work was a large refactor driven by a real production crash, plus a split of the two biggest files in the project into per-region components and per-resource modules.

**The crash and its fix.** The symptom was: edit a coin after a pause, get "Failed to update coin", refresh the browser and it still fails, and only restarting the whole app recovers. The database was fine — the *backend process was dying*. `server/db.ts` created an mssql `ConnectionPool` but never attached an `'error'` listener to it. `ConnectionPool` extends Node's `EventEmitter`, and an `EventEmitter` with zero `'error'` listeners **throws when `'error'` is emitted**. That throw happened inside a tedious socket callback where nothing could catch it, so it became an uncaught exception and killed the Express process. Nothing appeared in `app.log` because the process died before any logging ran.

The fix is a `pool.on('error', ...)` listener attached *before* `connect()` is called, in `server/db/pool.ts`. Three contributing factors were fixed alongside it:

- Every `catch` in `routes/coins.ts` called `resetPool()`, so an ordinary validation error (a too-long string, a constraint violation) destroyed the shared pool and broke every other request in flight. Route handlers are now forbidden from calling `resetPool()`; they go through `withDb()`, which retries exactly once and only for connection-class errors.
- There was no single-flight guard on connect. The Angular app fires roughly seven API calls in parallel on load, and each one saw "no pool" and opened a competing one. Concurrent callers now share one connect attempt, and a generation counter stops a late failure from tearing down a pool that was created after it.
- A per-request `SELECT 1` health check could close the pool while other requests were still using it. It is gone.

**Parameter types were wrong too.** Several mssql bindings did not match `server/setup-database.sql`, which silently truncates data when the parameter is shorter than the column and raises SQL error 8152 when it is longer. `Year` was bound as `NVarChar(10)` against an `NVARCHAR(50)` column, `Dealer` at 255 against a 200-char column, and `PurchaseDate`/`SoldDate` as `sql.Date` against `NVARCHAR(30)` text columns. `server/db/coin-fields.ts` is now the single source of truth for the Coins table and `server/db/bindings.ts` for every other table, and `server/db/coin-fields.spec.ts` checks them against the SQL script.

**Crashes are now visible.** `server/process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load, so a fatal error lands in `server/logs/app.log` instead of ending the process silently.

The regression suite is passing: 273 frontend tests across 18 files and 61 server tests across 8 files.

## Architecture

### Layout philosophy: inventory first

The UI is organized around the principle that the inventory table *is* the application. Import workflows, category management, and other administrative functions live in modal dialogs — accessible from the toolbar but never dominating the main view. The layout is:

1. **Header** — title and the toolbar
2. **Toolbar** — action buttons (Add Coin, Import, Export, Settings)
3. **Filter bar** — search, category filter, and a collapsible advanced panel for grade, value range, source, country, coin set, dealer
4. **Main content grid** — inventory table (full width) + detail sidebar (shown when a coin is selected)
5. **Bulk edit bar** — fixed bottom bar when coins are multi-selected
6. **Modal dialogs** — Quicken import, CSV import, image import, category management, reports, spot prices, settings
7. **Status bar** — fixed to the bottom of the window, showing the database connection state with a Retry button

### Component structure

`src/app/app.ts` is down to 277 lines and `app.html` to 139 (they were 878 and 751). The root component is now only a shell: it owns the modal open/closed flags, the selected coin, and the wiring between child components. Everything that draws a region of the screen is its own component, and everything that holds state is its own store.

Region components under `src/app/components/`:

| Component | Selector | Location |
| --- | --- | --- |
| `AppToolbar` | `app-toolbar` | `src/app/components/app-toolbar/` |
| `InventoryFilterBar` | `app-inventory-filter-bar` | `src/app/components/inventory-filter-bar/` |
| `InventoryTable` | `app-inventory-table` | `src/app/components/inventory-table/` |
| `CoinDetailPanel` | `app-coin-detail-panel` | `src/app/components/coin-detail-panel/` |
| `CoinEditorForm` | `app-coin-editor-form` | `src/app/components/coin-editor-form/` |
| `CoinImageGallery` | `app-coin-image-gallery` | `src/app/components/coin-image-gallery/` |
| `CoinPhotoViewer` | `app-coin-photo-viewer` | `src/app/components/coin-photo-viewer/` |
| `BulkEditBar` | `app-bulk-edit-bar` | `src/app/components/bulk-edit-bar/` |
| `NotificationToast` | `app-notification-toast` | `src/app/components/notification-toast/` |

Modal components, same folder:

| Component | Selector | Location |
| --- | --- | --- |
| `QuickenImportModal` | `app-quicken-import-modal` | `src/app/components/quicken-import-modal/` |
| `CsvImportModal` | `app-csv-import-modal` | `src/app/components/csv-import-modal/` |
| `ImageImportModal` | `app-image-import-modal` | `src/app/components/image-import-modal/` |
| `CategoryModal` | `app-category-modal` | `src/app/components/category-modal/` |
| `ReportModal` | `app-report-modal` | `src/app/components/report-modal/` |
| `SpotPriceModalComponent` | `app-spot-price-modal` | `src/app/components/spot-price-modal/` |
| `SettingsModal` | `app-settings-modal` | `src/app/components/settings-modal/` |

Each child component uses Angular's `inject()` pattern and `output()` to communicate back to the parent.

### State stores (`src/app/features/`)

These are plain classes created with `new`, not Angular services. They hold the state that more than one component needs, so the root component no longer has to act as a message bus between siblings.

| File | Responsibility |
| --- | --- |
| `features/inventory/inventory-filter.store.ts` | Search text, category filter, advanced filters, sorting |
| `features/inventory/inventory-selection.store.ts` | Checkbox multi-select, shift-click ranges, bulk edit target |
| `features/inventory/inventory-columns.store.ts` | Which columns are visible; persisted to IndexedDB |
| `features/inventory/coin-images.store.ts` | Gallery and full-screen photo viewer open/closed state |
| `features/inventory/inventory-file-io.ts` | JSON export/import and CSV export (the hidden file-input plumbing) |
| `features/inventory/denomination-sort.ts` | Ordering denominations by face value rather than alphabetically |
| `features/inventory/coin-icons.ts` | Shared image asset paths (the CAC green bean) |
| `features/app-settings.ts` | The `AppSettings` shape, shared by the shell and the Settings modal |
| `features/confirm-action.ts` | Safe wrapper around `window.confirm` for the two delete paths |

### SCSS organization

Component styles now live with the component that owns them. Angular scopes a component's styles to that component's own markup, so a rule written in `app.scss` could not reach into a child template anyway — `_inventory-table.scss`, `_detail-panel.scss` and `_overlays.scss` were deleted and their contents moved into the owning components.

What is left under `src/app/styles/` is only the genuinely shared material:

| Partial | Contents |
| --- | --- |
| `_base.scss` | Host element, page background, resets |
| `_layout.scss` | Shell, topbar, main content grid |
| `_controls.scss` | Buttons, badges, file pickers, the eyebrow caption, box-sizing reset |
| `_panel.scss` | The white rounded card shared by the inventory table and the detail sidebar |
| `_modal.scss` | Shared modal backdrop and chrome |

`app.scss` uses `base` and `layout`, plus the status bar and the database error banner. Each component imports whichever of `controls`, `panel` and `modal` it needs via `@use`.

### Services

| Service | Responsibility |
| --- | --- |
| `InventoryService` | The single front door to the collection — owns the signals components read |
| `ApiService` | HTTP calls to the Express backend |
| `StorageService` | IndexedDB persistence for UI preferences (async get/set keyed by `StorageKeys`) |
| `QuickenImportService` | QIF parser — accounts, transactions, denomination inference, the 2-of-3 detail rule |
| `CsvService` | CSV parsing, auto-mapping headers, export to CSV/insurance CSV |
| `ImageMatchingService` | Filename-to-coin matching |
| `SpotPriceService` | Spot prices, proxied through the backend |
| `LoggingService` | Sends frontend log lines to `POST /api/log` so they interleave with server logs |
| `NotificationService` | Toast messages (info/warning auto-dismiss, errors are sticky) |
| `GlobalErrorHandler` | Angular `ErrorHandler` — logs unhandled errors and shows a toast |
| `pm-reference.ts` | Precious-metal weight and purity lookup for melt values |
| `http-utils.ts` | `resolveApiBaseUrl` / `describeHttpError`, dependency-free so `LoggingService` can use them without dragging `HttpClient` into the test module graph |

`InventoryService` and `ImageMatchingService` were both large enough to split into folders of focused helpers:

| Folder | Files |
| --- | --- |
| `src/app/services/inventory/` | `coin-change-tracker`, `coin-editor`, `coin-collection`, `lookup-manager`, `transaction-manager`, `connection-manager`, `coin-factory`, `inventory-metrics` |
| `src/app/services/image-matching/` | `coin-signature`, `filename-parser`, `match-scorer`, `match-decider`, `matching-thresholds`, `reference-tables`, `text-tokens` |

### Backend structure (`server/`)

`server.ts` is 106 lines of wiring only. `db.ts`, `routes/coins.ts`, `routes/lookups.ts` and `routes/data.ts` were all replaced by folders.

| Path | Contents |
| --- | --- |
| `server/db/index.ts` | Barrel and the written-up story of the crash — read this first |
| `server/db/pool.ts` | `getPool` / `resetPool` / `withDb`; the `'error'` listener, single-flight guard and generation counter |
| `server/db/config.ts` | Builds the `sql.config` from `server/.env` |
| `server/db/errors.ts` | `isConnectionError` / `sqlErrorNumber` |
| `server/db/coin-fields.ts` | `COIN_FIELDS` — the Coins column map, with types, max lengths and normalizers |
| `server/db/bindings.ts` | `DB_BINDINGS` — parameter types for every other table |
| `server/db/value-normalizers.ts` | JSON value to SQL parameter value helpers |
| `server/db/row-mappers.ts` | SQL row to JSON for the Angular app |
| `server/routes/health.ts` | `GET /api/health` — the launcher's readiness probe |
| `server/routes/coins/` | `index`, `reads`, `writes`, `write-helpers`, `images` — mounted at `/api/coins` |
| `server/routes/lookups/` | `categories`, `coin-sets`, `denominations`, `metal-contents`, `mint-marks` — mounted at `/api` |
| `server/routes/data/` | `transactions`, `spot-prices`, `settings`, `frontend-log` — mounted at `/api` |
| `server/routes/db-error-response.ts` | Translates SQL errors into HTTP status codes |
| `server/routes/param-utils.ts` | Shared request-parameter helpers |
| `server/process-safety.ts` | The `unhandledRejection` / `uncaughtException` handlers |
| `server/logger.ts` | Appends timestamped lines to `server/logs/app.log` |
| `server/test-support/mssql-mock.ts` | The shared mssql mock used by every server spec |

## Features

### Inventory management

- Inventory table with photo thumbnails, color-coded grade badges (mint/proof green, circulated blue, worn gold, ungraded gray), certification badges (purple), and CAC green bean accent icons
- Free-text search across name, denomination, type, country, grade, certification, variety, mint mark, notes, dealer, coin set, and tags
- Category filter, coin set filter, and sortable column headers (click to sort, click again to reverse)
- Advanced filters: grade prefix, value range (min/max), source, country, coin set, dealer
- Collapsible column visibility picker (show/hide any tracked field)
- Sticky detail sidebar for the selected coin with inline editing of all fields
- Add / delete coins directly from the toolbar
- Export the full inventory as downloadable JSON, and re-import a previously exported file
- Selected row gets a left-border accent treatment for clear visual feedback

### Multi-select and bulk edit

- Checkbox selection per row with shift-click range selection
- Select/deselect all visible coins
- Fixed bottom toolbar showing selection count with bulk actions:
  - Bulk update any field (category, grade, country, etc.) across selected coins
  - Bulk delete selected coins
- Visual multi-selected row treatment (blue background, accent border)

### Spot prices and melt value

- Manual spot price entry for gold, silver, platinum, copper
- One-click fetch, proxied through the backend
- Per-coin melt value calculation based on metal content and weight (troy oz)
- Melt value displayed in the detail panel valuation summary

### Category and coin set administration (modal)

- Add or remove category names from the managed list
- Add or remove named coin sets
- Quicken-imported coins default their category to the Quicken account name
- Removing a category does not touch coins already assigned to it

### Transactions

- Per-coin transaction history (purchase, sale, appraisal, insurance)
- Add transactions with type, amount, dealer, date, and notes
- Transactions removed automatically when their parent coin is deleted
- Whether the detail panel shows transaction history is a Settings toggle

### Reports (modal)

- Summary stats: total coins, total cost, current value, profit/loss, graded count, image count
- Breakdown by category and denomination with counts and values
- Export to CSV and insurance CSV directly from the report modal

### Coin data model (`src/app/types/coin.model.ts`)

Each `CoinRecord` tracks: denomination, year, type, category, country, grade, certification company, certification number, variety, mint mark, composition, purchase date, purchase price, current value, sold price, dealer, coin set, metal content, weight, free-text notes, image paths, tags, a `source` marker (`manual` / `quicken` / `csv` / `import`), and `hasCacSticker`.

### CAC "green bean" accent

CAC stickers a coin already graded by PCGS/NGC as meeting a tighter quality bar within its stated grade. `hasCacSticker` is a layered accent on top of `certCompany`/`certNumber`. The accent image lives at `public/CACGreenBean-trimmed.png` and renders inline in the table, in the detail panel badge row, and as a checkbox toggle in the editor.

### Quicken (QIF) import (modal)

Parses real Quicken Interchange Format investment-transaction exports with:
- File picker, text area, and account selector with select/deselect all
- **QIF filters**: filter by date range, minimum price, and denomination before importing
- Preview with records grouped by account
- Import creates coins with category defaulting to account name

**The 2-of-3 rule.** A coin must carry at least two of the three main details — Year, Coin Type, Denomination — before it is allowed into the inventory. A record described by a year alone is not a coin, it is a fragment, and the backend rejects it anyway with `400 {"error":"denomination is required"}`.

Coins that fail the rule are no longer silently dropped mid-loop. They appear in an **"Exceptions — not imported"** panel showing the raw QIF security name, what the parser *was* able to read, and which details were missing, and each one can be individually overridden and imported anyway. The check is deliberately strict about what counts as "present": placeholder values like `-`, `0`, `n/a`, `none`, `unknown` and `other` are treated as blank, because a naive truthiness test accepted all of them.

### CSV import (modal)

> **User-facing guide:** [`docs/csv-import-guide.md`](docs/csv-import-guide.md) explains how to build an importable CSV without reference to any of the code below. Point people there rather than at this section.

**There is no fixed CSV schema.** The importer is column-mapping based, so almost any spreadsheet export will work — you tell it which of your columns means what.

The modal itself now carries first-run guidance: a **Download blank template** button (generated from `CSV_MAPPABLE_FIELDS`, so it cannot drift out of date), a pointer to `Export → CSV` as a round-trippable template, and an expandable list of recognised columns.

The flow is: pick a file → the first row is read as headers → recognised headers are auto-mapped → you adjust the mapping (or set a column to `(skip)`) → import.

**File requirements**

- A **header row** must be the first line.
- **Comma-delimited.** Semicolon-delimited files — which Excel produces in some European locales — are *not* supported.
- Either `\n` or `\r\n` line endings.
- Standard CSV quoting is handled properly: fields wrapped in `"` may contain commas and newlines, and `""` inside a quoted field means a literal `"`.

**Easiest way to get a valid file: export one.** `Export → CSV` writes exactly the header labels the importer recognises, so an exported file re-imports with every column auto-mapped. Use it as your template.

**Recognised header names**

A header auto-maps if it matches either the label or the field name, case-insensitively and ignoring surrounding spaces. Anything unrecognised is left unmapped for you to assign by hand.

| Label (as exported) | Field name | Notes |
| --- | --- | --- |
| Coin Type | `coinType` | |
| Denomination | `denomination` | |
| Year | `year` | Text, so ranges like `1878-S` are fine |
| Category | `category` | |
| Country | `country` | Defaults to `United States` if blank |
| Grade | `grade` | |
| Cert Company | `certCompany` | |
| Cert Number | `certNumber` | |
| Variety | `variety` | |
| Mint Mark | `mintMark` | |
| Composition | `composition` | |
| Purchase Date | `purchaseDate` | |
| Purchase Price | `purchasePrice` | `$` and thousands separators are stripped |
| Current Value | `currentValue` | `$` and thousands separators are stripped |
| Notes | `notes` | |
| Dealer | `dealer` | |
| Set | `coinSet` | |
| Metal Content | `metalContent` | |
| Weight (oz) | `weight` | `$` and thousands separators are stripped |
| Sold Price | `soldPrice` | `$` and thousands separators are stripped |
| Sold Date | `soldDate` | |

**Value handling**

- Empty cells are skipped entirely, leaving the field at its default rather than writing a blank.
- The four numeric fields strip `$` and `,` before parsing; anything that still isn't a number becomes `0`.
- Every imported coin gets `source = csv` and a freshly generated id.

**Minimal example**

```csv
Coin Type,Denomination,Year,Mint Mark,Grade,Purchase Price
Morgan Dollar,Dollar,1881,S,MS63,"$1,250.00"
Mercury Dime,Dime,1916,D,VG8,$895.00
```

**Known limitations**

- **The 2-of-3 completeness rule is not applied on this path.** QIF import requires at least two of Year / Coin Type / Denomination; CSV import currently does not, so an under-specified row will be sent to the backend and rejected there with `400 {"error":"denomination is required"}`.
- Several fields **cannot be imported at all**, because they are not in the mappable list: `hasCacSticker`, `tags`, `imagePaths`, and — worth noting — `pmWeightGrams` and `pmPercent`, which melt-value calculations depend on. A CSV round-trip therefore loses CAC flags and precious-metal weights.
- `Source` is written on export but ignored on import; imported coins are always marked `csv`.

### Image import from directories (modal)

Supports selecting an entire folder (`webkitdirectory`) or individual image files. Filenames are parsed semantically — year, denomination, mint mark, coin type, cert number — and scored against every coin, with each attribute carrying a weight and the score damped by how much of the available evidence could actually be compared. The tuning constants all live in one file, `src/app/services/image-matching/matching-thresholds.ts`.

**Auto-assignment is strict.** An image is attached automatically only when all three gates pass:

1. score >= **0.85**
2. at least **2** independent strong attributes agree
3. the runner-up is at least **0.15** behind

Everything else goes to a review list with up to five ranked candidates, where the user can confirm, reject, or reassign before applying. "Apply" reads confirmed files as base64 data URLs and attaches them to the matched coins.

The three gates exist because of specific failures. A single matching attribute, however clean, is never enough — a filename giving only a denomination and a design name cannot distinguish a 1904 Liberty Head Double Eagle from a 1907 one. And the margin gate means two coins differing only by mint mark (1881-S vs 1881-O) land about 0.10 apart, inside the margin, so both go to review rather than one being silently chosen. Mint mark is deliberately weighted *low* for exactly this reason.

Bare-digit denomination matching was removed: a cert number containing "25" used to parse as a quarter. Bare number tokens now contribute nothing.

### Per-coin image management

- Add images via file picker or drag-and-drop in the detail panel
- Click thumbnails to open a full-screen photo viewer with prev/next navigation
- Delete individual images from the gallery

### Persistence

#### SQL Server backend (`server/`)

The coin collection lives in SQL Server. A separate Express/TypeScript backend provides the REST API. The schema is created and seeded from `server/setup-database.sql`, which defines the canonical tables for coins, images, tags, categories, denominations, mint marks, metal contents, transactions, spot prices, and app settings with proper foreign keys and indexes. Authentication defaults to Windows (trusted connection) for easy local development.

API endpoints: `GET /api/health`; `GET/POST/PUT/DELETE /api/coins` (plus coin image routes), `/api/categories`, `/api/coin-sets`, `/api/denominations`, `/api/mintmarks`, `/api/metalcontents`, `/api/transactions`, `/api/spot-prices` (`GET /api/spot-prices/latest`), `/api/settings/:key`; and `POST /api/log`.

#### IndexedDB (`src/app/services/storage.service.ts`)

IndexedDB now holds only browser-local UI preferences — column visibility and app settings — keyed by `StorageKeys`. It is not where coin data lives. This is why the launcher opens Edge with your normal profile rather than a throwaway `--user-data-dir`: a fresh profile would silently reset those preferences on every launch.

## Tech stack

- Angular 22 (standalone components, signals, `@if`/`@for` control-flow syntax, `inject()`, `output()`)
- TypeScript 6 (frontend), TypeScript 5.7 (server)
- SCSS with partials
- Vitest 4.x for unit testing (with `fake-indexeddb` for storage tests)
- Express + mssql
- Supertest for Express API testing

## Prerequisites

- Node.js 22.22+ recommended (required for Angular CLI `ng` commands)
- npm 10+
- SQL Server Express (required for the `server/` backend; use the local instance or configure `DB_SERVER` in the server `.env` file)

## Run locally

Double-click **`launch-coin-inventory.cmd`** in the project root. Or run the launcher directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

`start-coin-inventory.ps1` **in the project root** is the real launcher. `setup\start-coin-inventory.ps1` is now just a shim that forwards to it — there used to be two independent implementations and they drifted apart, with different readiness probes, different lock files and different shutdown logic. Because the lock files differed, launching both at once started two copies of the servers that then fought over ports 3000 and 4200.

What the launcher does:

- Refuses to start twice (PID lock file at `.coin-inventory.lock` in the project directory; a stale lock is cleaned up).
- Installs dependencies **only when `node_modules` is missing**. The old script ran `npm install` on every single launch, which is slow over the I: network share and turned any transient npm hiccup into a failed startup.
- Starts both servers, then waits for **both** to be genuinely ready before opening the browser:
  - the Angular dev server on **4200** returning 200, and
  - `GET http://localhost:3000/api/health` returning 200 with `{"status":"ok","database":"connected"}` — which only happens after SQL Server answers a `SELECT 1`.
- Opens Edge with your normal profile, and stops the server process tree when you close the window.

The old launcher only polled 4200. The Angular dev server is usually — but not always — slower to start than the API, and `InventoryService` hydrates exactly once at startup, so when the API lost the race the app came up showing "Cannot connect to database" a second before the backend was ready. That is why startup "usually worked but sometimes failed".

Note that the health check inspects the **response body**, not just the status code. The Express SPA catch-all (`app.get('*')`) returns `index.html` with a 200 for any unmatched GET, so a status-only check would call a missing health endpoint "healthy".

If you need to run the pieces yourself:

```powershell
# Backend only
cd server
npx tsx server.ts

# Frontend only
npm install
npm start -- --host 0.0.0.0
```

Then open the local URL shown in the Angular CLI output (commonly `http://localhost:4200`).

## Current database and startup notes

- Category, denomination, mint-mark, and metal-content reference data are database-backed and seeded via `server/setup-database.sql` rather than hard-coded runtime seed logic.
- Metal content values are repaired and persisted in the database, and `Other` is avoided unless the data truly does not fit a known value.
- The SQL configuration is read from `server/.env` by `server/db/config.ts`, with handling for named instances.
- Use the root launcher for normal startup; the direct `tsx` command is for troubleshooting.

## Build for production

```powershell
# Frontend
npm run build

# Server
cd server
npm run build      # tsc -p tsconfig.build.json
npm run typecheck  # tsc --noEmit, type-checks the specs too
```

The server build uses `tsconfig.build.json`, which extends `tsconfig.json` but excludes `**/*.spec.ts` and `test-support/`. `tsconfig.json` deliberately includes everything so `typecheck` covers the tests; the build must not emit them. When it did, `npm run build` produced `dist/*.spec.js`, Vitest discovered those stale compiled copies and tried to run them, and they failed with "Vitest cannot be imported in a CommonJS module using require()".

A stale `dist/` is worth taking seriously here: `npm start` runs `node dist/server.js`. **A `dist/` built before the connection-pool fix will silently run the old crashing code** — the version with no `pool.on('error')` listener. If you see the old symptoms after applying the fix, delete `server/dist/` and rebuild.

## Test

```powershell
# Frontend — 273 tests across 18 files
npm test

# Server — 61 tests across 8 files
cd server && npm test
```

**Note:** On Windows, if the project is at a drive root (e.g., `I:\`), the test command uses `--root src` to work around a Vitest 4.x path resolution issue with drive root directories.

Server specs sit next to the code they cover (`db/connection.spec.ts`, `db/coin-fields.spec.ts`, `routes/coins/reads.spec.ts`, `routes/coins/writes.spec.ts`, `routes/lookups/lookups.spec.ts`, `routes/data/data.spec.ts`, `routes/db-error-response.spec.ts`), and they all share `server/test-support/mssql-mock.ts`. `server.spec.ts` now only covers the app wiring and the health endpoint. `db/connection.spec.ts` includes the regression test for the crash — it emits `'error'` on the pool and asserts the process survives.

## Troubleshooting

**Start here: is the backend alive and talking to SQL?**

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health | Select-Object -ExpandProperty Content
```

- `{"status":"ok","database":"connected"}` — backend and database are both fine; the problem is in the browser or the dev server.
- `{"status":"error","database":"disconnected","message":"..."}` (HTTP 503) — the backend is running but cannot reach SQL Server. Check that the SQL Server service is started and that `DB_SERVER` in `server/.env` matches your instance name.
- Connection refused / nothing answers — the backend is not running. Start it and watch the console: `cd server; npx tsx server.ts`.
- HTML comes back instead of JSON — you are hitting the SPA catch-all, which means the health route is not registered. You are probably running a stale `dist/`; see the build section above.

**Check the log.** `server/logs/app.log` holds every API request plus all warnings and errors, and the Angular app posts its own messages there too via `POST /api/log`, so frontend and backend appear in one timeline. Thanks to the `unhandledRejection` / `uncaughtException` handlers in `server/process-safety.ts`, a fatal error is now written to the log; before those handlers existed a crash wrote nothing at all and the log simply stopped mid-session. If you see the log end abruptly with no error line, you are looking at an old crash from before the fix.

**Run the backend on its own.** Easiest way to see startup errors, which the launcher hides in a separate window:

```powershell
cd server
npx tsx server.ts
```

You should see the connection attempt logged, then `Coin Inventory server listening on http://localhost:3000`.

**"Coin Inventory is already running."** A lock file (`.coin-inventory.lock`) is present and its PID is still alive. If you are sure nothing is running, delete the file and relaunch.

**Startup times out after 180 seconds.** The launcher prints which side it was waiting for. If it was the database API, SQL Server is almost certainly the problem — check `server/logs/app.log`.

---

## Planned next steps

### 1. Certification company logos for PCGS, NGC, and ANACS

The CAC green bean accent is done. Official logos for grading companies were skipped due to trademark concerns. If revisited:
- Would need real logo assets or custom non-trademarked badges
- Data model needs a way to distinguish "raw / not certified" from "certified but certCompany is empty"

### 2. Premium feature research

Research premium coin inventory programs (PCGS CoinFacts, NGC Registry, Numismaster, etc.) and adopt the best ideas that make sense for this application.

### Longer-horizon ideas (not yet scheduled)

- Valuation-service integration (market pricing by denomination/grade)
- Stronger filename normalization for image matching (cert numbers, fuzzy edit-distance)
- "Raw" coin explicit visual state
- Dashboard with charts (value over time, category breakdown)

### Done (kept here so it is not re-planned)

- **Fix esbuild/ng serve** — resolved via the webpack builder plus the `esbuild-wasm` override in `package.json`. The app serves and builds.
- **Wire up SQL Server backend** — done. `InventoryService` goes through `ApiService` to the Express API; IndexedDB is now only UI preferences.
