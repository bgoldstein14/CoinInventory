# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, an admin-managed category system, a Quicken (QIF) import workflow, a batch photo-import workflow that matches whole folders of images to coins by filename, and persistence in SQL Server via a small Express API (the browser's IndexedDB now only holds UI preferences) — all designed around an inventory-first layout where the collection table is the center of the experience.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next — rather than re-discovering the codebase from scratch.

---

## ⚠ Do this after pulling this change

Two steps, in this order. Neither is optional — the app will look broken without them.

**1. Run the outstanding SQL migrations.** `server/setup-database.sql` is the build-from-scratch script and it **DROPS every table**, so it must never be run against a database that has your coins in it. Schema changes to a live database live in `server/migrations/` instead, as small guarded scripts that are safe to run twice. Two are outstanding:

```powershell
cd C:\Users\BR651094\source\dev
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\002-add-image-source-path.sql
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\003-multiple-images-per-coin.sql
```

Substitute whatever `DB_SERVER` in `server/.env` says for `localhost` (for a named instance that is something like `-S "BRUCE_PC\SQLEXPRESS"`). `-E` means "use my Windows login", which is the easy path; if `server/.env` has `DB_USER`/`DB_PASSWORD` filled in and you would rather use that SQL login, swap `-E` for `-U CoinApp -P <password>`. Each script prints a line saying what it did, and 003 prints a short summary of the `CoinImages` table at the end. You can equally open either file in SQL Server Management Studio or Azure Data Studio with the `CoinInventory` database selected and press Execute.

Running them twice is harmless — every step is guarded and the second run prints "nothing to do" for each one. If you have already run 002, 003 will see the column and skip that step. If you have *not* run 002, 003 adds the column itself, so 003 alone is sufficient.

**2. Restart the app.** The API server caches query plans, and 003 replaces the index those plans were built against. Close the launcher window and start it again.

If you skip step 1, the batch image import will fail on the `SourcePath` column and no photo will show a source path.

## Current state (as of 2026-09-26)

The application is functioning end-to-end. The previous round of work was a large refactor driven by a real production crash. Since then the work has been about photos: many photos per coin, knowing where each original file lives, and importing a 4.2 GB folder of them without killing the browser tab. The COMEX spot-price fetch was also found to be silently dead and was replaced.

**The crash and its fix.** The symptom was: edit a coin after a pause, get "Failed to update coin", refresh the browser and it still fails, and only restarting the whole app recovers. The database was fine — the *backend process was dying*. `server/db.ts` created an mssql `ConnectionPool` but never attached an `'error'` listener to it. `ConnectionPool` extends Node's `EventEmitter`, and an `EventEmitter` with zero `'error'` listeners **throws when `'error'` is emitted**. That throw happened inside a tedious socket callback where nothing could catch it, so it became an uncaught exception and killed the Express process. Nothing appeared in `app.log` because the process died before any logging ran.

The fix is a `pool.on('error', ...)` listener attached *before* `connect()` is called, in `server/db/pool.ts`. Three contributing factors were fixed alongside it:

- Every `catch` in `routes/coins.ts` called `resetPool()`, so an ordinary validation error (a too-long string, a constraint violation) destroyed the shared pool and broke every other request in flight. Route handlers are now forbidden from calling `resetPool()`; they go through `withDb()`, which retries exactly once and only for connection-class errors.
- There was no single-flight guard on connect. The Angular app fires roughly seven API calls in parallel on load, and each one saw "no pool" and opened a competing one. Concurrent callers now share one connect attempt, and a generation counter stops a late failure from tearing down a pool that was created after it.
- A per-request `SELECT 1` health check could close the pool while other requests were still using it. It is gone.

**Parameter types were wrong too.** Several mssql bindings did not match `server/setup-database.sql`, which silently truncates data when the parameter is shorter than the column and raises SQL error 8152 when it is longer. `Year` was bound as `NVarChar(10)` against an `NVARCHAR(50)` column, `Dealer` at 255 against a 200-char column, and `PurchaseDate`/`SoldDate` as `sql.Date` against `NVARCHAR(30)` text columns. `server/db/coin-fields.ts` is now the single source of truth for the Coins table and `server/db/bindings.ts` for every other table, and `server/db/coin-fields.spec.ts` checks them against the SQL script.

**Crashes are now visible.** `server/process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load, so a fatal error lands in `server/logs/app.log` instead of ending the process silently.

**The page-level scrollbar is gone.** `src/styles.scss` — the global stylesheet, the only one that is *not* scoped to a component — was completely empty. With no reset in it, the browser's default `body { margin: 8px }` was still in effect, and combined with an app root asking for a full `100vh` the document came out 100vh + 16px tall. The whole window therefore scrolled by a sliver no matter what the app did internally. `styles.scss` now zeroes the body margin and sets `overflow: hidden`, because this is a fixed-height single-screen application that manages its own scrolling inside the table and the detail panel. Anything that overflows the window is a layout bug and should be visible as clipping rather than hidden behind a page scrollbar.

The status bar was part of the same problem and changed at the same time — see the SCSS section below.

**Spot prices were silently broken.** See "Spot prices and melt value". The short version: the free API the app called had been discontinued, and because the route answers 200 with zeroed prices on failure, nothing ever surfaced an error — the prices just sat at $0 forever.

The regression suite is passing: **516 frontend tests across 30 files** and **135 server tests across 15 files**.

## Architecture

### Layout philosophy: inventory first

The UI is organized around the principle that the inventory table *is* the application. Import workflows, category management, and other administrative functions live in modal dialogs — accessible from the toolbar but never dominating the main view. The layout is:

1. **Header** — title and the toolbar
2. **Toolbar** — action buttons (Add Coin, Import, Export, Settings)
3. **Filter bar** — search, category filter, and a collapsible advanced panel for grade, value range, source, country, coin set, dealer
4. **Main content grid** — inventory table (full width) + detail sidebar (shown when a coin is selected)
5. **Bulk edit bar** — fixed bottom bar when coins are multi-selected
6. **Modal dialogs** — Quicken import, CSV import, image import, category management, reports, spot prices, settings
7. **Status bar** — the last row of the shell's flex column, showing the database connection state with a Retry button

That last point used to read "fixed to the bottom of the window", and that was the bug. The status bar was `position: fixed; bottom: 0`, which took it out of the document flow — nothing reserved space for it, so it sat on top of the bottom of the inventory table and hid the last row, and the shell's `calc(100vh - 24px)` was an attempt to compensate that never quite lined up. It is now an ordinary flex item that occupies its own height, and the shell simply gets whatever is left.

### Component structure

`src/app/app.ts` is 277 lines and `app.html` is 139 (they were 878 and 751). The root component is only a shell: it owns the modal open/closed flags, the selected coin, and the wiring between child components. Everything that draws a region of the screen is its own component, and everything that holds state is its own store.

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
| `CoinImagePathLink` | `app-coin-image-path-link` | `src/app/components/coin-image-path-link/` |
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

Two components exist only to keep the image-import modal's template from running away with itself. Both are "dumb" — every piece of state arrives as an input and every decision leaves as an output, and the modal owns the row list:

| Component | Selector | What it draws |
| --- | --- | --- |
| `CoinImageGroup` | `app-coin-image-group` | One coin and every photo the matcher thinks belongs to it — the unit of review |
| `ImageMatchResolver` | `app-image-match-resolver` | One card for a photo the matcher could *not* confidently place, with parsed-attribute chips, a ranked candidate list and a coin search box |

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
| `features/inventory/image-path-display.ts` | Pure functions deciding *how* one image's original path is rendered — the three states, the tooltip wording, the middle-ellipsis shortening |
| `features/app-settings.ts` | The `AppSettings` shape, shared by the shell, the Settings modal and the image importer's base folder |
| `features/confirm-action.ts` | Safe wrapper around `window.confirm` for the two delete paths |

### SCSS organization

Component styles live with the component that owns them. Angular scopes a component's styles to that component's own markup, so a rule written in `app.scss` could not reach into a child template anyway — `_inventory-table.scss`, `_detail-panel.scss` and `_overlays.scss` were deleted and their contents moved into the owning components.

`src/styles.scss` at the project root is the one genuinely global stylesheet — the only place a rule can reach `html` and `body`. It holds the margin/padding reset and `overflow: hidden`. It used to be empty; see "The page-level scrollbar is gone" above for why that mattered.

What is left under `src/app/styles/` is only the genuinely shared material:

| Partial | Contents |
| --- | --- |
| `_base.scss` | Host element, page background, resets |
| `_layout.scss` | Shell, topbar, main content grid |
| `_controls.scss` | Buttons, badges, file pickers, the eyebrow caption, box-sizing reset |
| `_panel.scss` | The white rounded card shared by the inventory table and the detail sidebar |
| `_field.scss` | `.detail-field` — a small caption sitting directly above its control |
| `_modal.scss` | Shared modal backdrop and chrome |

`app.scss` uses `base` and `layout`, plus the status bar and the database error banner. Each component imports whichever of `controls`, `panel`, `field` and `modal` it needs via `@use`.

`_field.scss` is the newest of these and it exists for the usual reason: two components now render `.detail-field` — the coin editor form and the add-transaction row in the detail sidebar — and Angular's style scoping means a rule written in one cannot reach the other's template, so each has to `@use` it. The rule was promoted out of `coin-editor-form.scss` when the transaction row was given real labels; that row previously used `placeholder` text as its only label ("Amount", "Dealer", "Notes"), which disappears the moment you start typing and is skipped by some screen readers. Component-specific width and layout modifiers deliberately stay in the component that uses them — only the base look is shared.

### Services

| Service | Responsibility |
| --- | --- |
| `InventoryService` | The single front door to the collection — owns the signals components read |
| `ApiService` | HTTP calls to the Express backend |
| `StorageService` | IndexedDB persistence for UI preferences (async get/set keyed by `StorageKeys`) |
| `QuickenImportService` | QIF parser — accounts, transactions, denomination inference, grade, cert company, CAC sticker |
| `CsvService` | CSV parsing, auto-mapping headers, export to CSV/insurance CSV |
| `ImageMatchingService` | Filename-to-coin matching |
| `BatchImageImportService` | The engine behind "point at a folder and attach the photos to my coins" |
| `CoinImagePathsService` | "Where did this photo come from, and is that file still there?" — with one batched existence check per coin and a session cache |
| `SpotPriceService` | Spot prices, proxied through the backend |
| `LoggingService` | Sends frontend log lines to `POST /api/log` so they interleave with server logs |
| `NotificationService` | Toast messages (info/warning auto-dismiss, errors are sticky) |
| `GlobalErrorHandler` | Angular `ErrorHandler` — logs unhandled errors and shows a toast |
| `coin-completeness.ts` | The 2-of-3 completeness rule, shared by QIF import and the manual "Add coin" path |
| `image-source-paths.ts` | `ImageSourcePathRegistry` — the side table mapping a displayed image to its original file's path |
| `pm-reference.ts` | Precious-metal weight and purity lookup for melt values |
| `http-utils.ts` | `resolveApiBaseUrl` / `describeHttpError`, dependency-free so `LoggingService` can use them without dragging `HttpClient` into the test module graph |

Note that `coin-completeness.ts`, `image-source-paths.ts`, `pm-reference.ts` and `http-utils.ts` are plain modules, not `@Injectable` services. `ImageSourcePathRegistry` in particular is deliberately *not* injectable: `InventoryService` has to stay constructible from an injection context providing only `ApiService`, `LoggingService` and `NotificationService`, which is how every existing test builds it, and a fourth injected dependency would break all of them. The class has no dependencies of its own, so a module-level singleton gives the same shared-instance guarantee with none of the wiring.

Three services were large enough to split into folders of focused helpers:

| Folder | Files |
| --- | --- |
| `src/app/services/inventory/` | `coin-change-tracker`, `coin-editor`, `coin-collection`, `coin-draft-registry`, `lookup-manager`, `transaction-manager`, `connection-manager`, `coin-factory`, `inventory-metrics` |
| `src/app/services/image-matching/` | `coin-signature`, `filename-parser`, `filename-vocabulary`, `denomination-units`, `year-mint-parser`, `grade-parser`, `photo-markers`, `catalog-refs`, `non-coin-detector`, `match-scorer`, `match-decider`, `matching-thresholds`, `reference-tables`, `text-tokens` |
| `src/app/services/image-import/` | `image-file-filter`, `batch-import-session`, `coin-lookup`, `row-decisions`, `selection-rules`, `thumbnail-cache`, `attach-runner`, `image-downscaler`, `photo-variant`, `source-path`, `base-folder-state`, `import-base-folder` |

`coin-draft-registry` is the newest of the inventory helpers and it fixes a small but annoying bug. Clicking "Add coin" used to build a completely empty `CoinRecord` and POST it immediately; the backend quite reasonably answered `400 {"error":"denomination is required"}`, so the user got a red error toast before typing a single character. The app saves aggressively — every edit is written a second later — and that is worth keeping, so the fix is not "add a Save button" but to delay only the *first* write until the coin has enough detail to be legal.

### Backend structure (`server/`)

`server.ts` is wiring only. `db.ts`, `routes/coins.ts`, `routes/lookups.ts` and `routes/data.ts` were all replaced by folders.

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
| `server/migrations/` | Guarded, idempotent schema changes for a database that already has data in it |
| `server/routes/health.ts` | `GET /api/health` — the launcher's readiness probe |
| `server/routes/coins/` | `index`, `reads`, `writes`, `write-helpers`, `images`, `image-payload`, `list-query` — mounted at `/api/coins` |
| `server/routes/images/` | `index`, `file`, `exists`, `allowed-types` — mounted at `/api/images` |
| `server/routes/lookups/` | `categories`, `coin-sets`, `denominations`, `metal-contents`, `mint-marks` — mounted at `/api` |
| `server/routes/data/` | `transactions`, `spot-prices`, `spot-price-source`, `settings`, `frontend-log` — mounted at `/api` |
| `server/routes/db-error-response.ts` | Translates SQL errors into HTTP status codes |
| `server/routes/error-handler.ts` | The app-wide Express error handler, mounted last |
| `server/routes/param-utils.ts` | Shared request-parameter helpers |
| `server/process-safety.ts` | The `unhandledRejection` / `uncaughtException` handlers |
| `server/logger.ts` | Appends timestamped lines to `server/logs/app.log` |
| `server/test-support/mssql-mock.ts` | The shared mssql mock used by every server spec |

`routes/images/` is worth a note because it is unlike everything else in this backend: neither endpoint touches the database or the connection pool at all. `withDb()` and `sendDbError()` make no appearance there. They are about files on disk, which is why they live outside `/api/coins`.

`routes/error-handler.ts` also fixes a real bug. It used to be four lines ending in an unconditional `res.status(500).json({ error: 'Internal server error' })`, which threw away information the error was already carrying. `express.json()` is configured with `limit: '50mb'`, and when a request body exceeds it, body-parser rejects the request with a `PayloadTooLargeError` that already has `status: 413` set on it. During a batch photo import that mattered: the real problem is "that batch of images is too big, send fewer at a time", which the user can act on, but what they saw was a generic server error suggesting the server itself was broken.

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

The detail entry fields no longer carry placeholder/watermark text — `coin-editor-form.html` has zero `placeholder` attributes in it now. Every field has a real caption above it instead, which is what `_field.scss` is for. Placeholder-as-label reads fine until you start typing, at which point the only thing telling you what the box was for disappears — and some screen readers skip it entirely.

The Cert Company input was widened at the same time, because at its old width it clipped the final letter of "ANACS". It used to carry an inline `width: 7.5ch`; the rule now lives in `.detail-field--cert-company` in `coin-editor-form.scss` at `12ch`. Two things made `7.5ch` too narrow: `ch` is the width of the digit "0", but grader names are uppercase letters, which are wider; and the global `box-sizing: border-box` meant that width had to cover the input's 7px horizontal padding and 1px border on each side as well as the text.

### Multi-select and bulk edit

- Checkbox selection per row with shift-click range selection
- Select/deselect all visible coins
- Fixed bottom toolbar showing selection count with bulk actions:
  - Bulk update any field (category, grade, country, etc.) across selected coins
  - Bulk delete selected coins
- Visual multi-selected row treatment (blue background, accent border)

### Spot prices and melt value

- Manual spot price entry for gold, silver, platinum, copper
- One-click fetch, proxied through the backend (`GET /api/spot-prices/fetch`)
- Per-coin melt value calculation based on metal content and weight (troy oz)
- Melt value displayed in the detail panel valuation summary

**The fetch was broken, and here is why it was invisible.** The old implementation called `https://api.metals.live/v1/spot`. That free API has been discontinued: the hostname still resolves (to a CloudFront address) but the TLS connection is refused, so every fetch failed. Because the route deliberately answers 200 with zeroed prices rather than erroring, the app showed nothing wrong — the prices simply stayed at $0 forever, which is what the user reported as "the COMEX PM prices fetch does not work".

`server/routes/data/spot-price-source.ts` now reads the actual COMEX/NYMEX front-month futures contracts, which is precisely what "COMEX prices" means, from an endpoint that needs no API key or signup:

| Symbol | Metal | Exchange |
| --- | --- | --- |
| `GC=F` | Gold | COMEX |
| `SI=F` | Silver | COMEX |
| `PL=F` | Platinum | NYMEX |
| `HG=F` | Copper | COMEX |

Three things about that file are load-bearing:

- **Copper is quoted per POUND, not per troy ounce.** Gold, silver and platinum are per troy ounce; copper (HG) is not. The frontend melt calculation in `inventory-metrics.ts` divides a coin's gram weight by 31.1035 and multiplies by the spot price — i.e. it assumes every price is per troy ounce. Storing copper per pound would therefore overstate copper melt values by a factor of about **14.58** (1 lb = 453.59237 g, 1 troy oz = 31.1034768 g). The conversion happens in `spot-price-source.ts`, at the single point where the unit is actually known, rather than being left to callers. Copper is also rounded to four decimal places instead of two, because per troy ounce it comes out well under a dollar.
- **A missing or non-numeric price is a FAILURE, never a zero.** Anything that is not a finite number greater than zero is reported as a failed metal and listed in the response's `failed` array, so the user is told which ones are missing instead of being shown a zero as though it were a real price. Zero-as-a-price is the exact failure mode that hid the dead API for so long.
- **Every symbol is fetched independently**, with a 10-second timeout each, so one dead symbol cannot take the other three down with it. The endpoint is undocumented, so it is treated as best-effort. The base URL can be overridden with the **`SPOT_PRICE_BASE_URL`** environment variable if it ever needs swapping without a code change.

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

Each `CoinRecord` tracks: denomination, year, coin type, category, country, grade, certification company, certification number, variety, mint mark, composition, purchase date, purchase price, current value, sold price, sold date, dealer, coin set, metal content, weight, precious-metal weight in grams, precious-metal purity percent, free-text notes, image paths, tags, a `source` marker (`manual` / `quicken` / `csv` / `import`), and `hasCacSticker`.

`imagePaths` is still a `string[]` of `data:` URLs, deliberately. Widening it to an array of objects was considered and rejected: it is bound directly to `<img [src]>` in four places (the gallery, the photo viewer, the table thumbnail, the report) and it is one of the fields the change tracker diffs, and a mistake in the change-tracking path is how the user previously lost data. The original file paths therefore live in a side table instead — see "Where each photo came from" below.

`src/app/types/coin-image.model.ts` holds the image-specific shapes: `AttachedImage` (`{ imageData, sourcePath }`), `CoinImageRecord` (what `GET /api/coins/:id/images` returns) and `ImageFileExistence` (`'present' | 'missing' | 'unknown'`).

### CAC "green bean" accent

CAC stickers a coin already graded by PCGS/NGC as meeting a tighter quality bar within its stated grade. `hasCacSticker` is a layered accent on top of `certCompany`/`certNumber`. The accent image lives at `public/CACGreenBean-trimmed.png` and renders inline in the table, in the detail panel badge row, and as a checkbox toggle in the editor.

### Quicken (QIF) import (modal)

Parses real Quicken Interchange Format investment-transaction exports with:
- File picker, text area, and account selector with select/deselect all
- **QIF filters**: filter by date range, minimum price, and denomination before importing
- Preview with records grouped by account
- Import creates coins with category defaulting to account name

**Grade, certification company and the CAC sticker are now read out of the security name.** Quicken security names in this collection carry a surprising amount of structure, and the parser mines it.

*Certification company.* Seven companies are recognised, each matched as a **whole token** with `\b` on both sides and case-insensitively:

| Token | Why it is there |
| --- | --- |
| `CACG` | CAC's own grading service. **Listed first, deliberately.** |
| `PCGS` | |
| `NGC` | |
| `ANACS` | |
| `ICG` | |
| `SEGS` | |
| `NNC` | |

They are regexes rather than plain `includes()` checks for two reasons: a substring test would fire on "NGC" buried inside a longer word, and it would be case-sensitive against hand-typed names. The `\b` anchoring means the company is found in every real-world punctuation it appears in — `- PCGS MS64`, `-PCGS PF65`, `PCGS/CAC AU58`, `(CLEANED/PCGS)` — while `XPCGSY` matches nothing.

*The CAC sticker.* `CAC` (Certified Acceptance Corporation) puts a small green sticker on a slab it agrees is solid for the grade. It is a **separate thing** from the grading company, and it is the most common "extra" in this collection's names — overwhelmingly written with a slash after the grader (`1909 S-VDB 1¢ - PCGS/CAC AU58`, `1835 $5 - NGC/CAC XF45`) but also seen as `CAC`, `CAC'd`, `CACd`, `w/CAC`, `+CAC`, `(CAC)`, and `CAC Gold` / `Gold CAC`.

**`CAC` vs `CACG` is the one trap in the whole file.** `CACG` is CAC's grading *service*. A CACG-slabbed coin is not a CAC-stickered coin, so seeing "CACG" must set `certCompany = 'CACG'` and must leave `hasCacSticker` **false**. The whole-token `\b` rule gives that for free: in "CACG" the character after "CAC" is "G", both are word characters, so there is no word boundary between them and `\bCAC\b` cannot match. `hasCacSticker` is always a boolean and never undefined, because the database column is `BIT NOT NULL DEFAULT 0` and the UI renders a checkbox from it.

*Grade.* Real filenames and security names in this collection write grades six different ways, several of which are destroyed by naive tokenizing — the `+` in `VF+` and the `/` in `PR/BU` both vanish. The parser therefore matches a grade core (`BU`, `UNC`, `VF`, `EF`, `XF`, `AU`, `MS`, `PR`, `PF`, `AG`, `VG`, `F`, `G`, optionally with a `CH+` prefix or a slashed second grade) plus an optional numeric grade and an optional designation suffix, and collapses internal separators so `PF65 Cameo` and `PF65Cameo` land on the same value. Forms handled include `PF65RB`, `PF64Cameo`, `PF69DCAM`, `MS64DMPL`, `MS70-FS` and `MS64+`.

**The 2-of-3 rule.** A coin must carry at least two of the three main details — Year, Coin Type, Denomination — before it is allowed into the inventory. A record described by a year alone is not a coin, it is a fragment, and the backend rejects it anyway with `400 {"error":"denomination is required"}`.

The rule now lives in its own shared module, **`src/app/services/coin-completeness.ts`**, because the manual "Add coin" path needs exactly the same judgement as the QIF importer. It exports:

| Export | What it is |
| --- | --- |
| `MAIN_COIN_DETAILS` | The three details, in order |
| `MINIMUM_MAIN_DETAILS` | `2` — the "of 3" |
| `isCoinDetailPresent(value)` | Is one detail genuinely filled in |
| `checkMainCoinDetails(record)` | The full `CoinDetailCheck` result |
| `hasEnoughCoinDetail(record)` | The boolean verdict |
| `describeMissingCoinDetail(record)` | Human-readable "what's missing" text for the UI |

`quicken-import.service.ts` re-exports the same symbols so its own unchanged tests still work, and `coin-draft-registry.ts` uses `hasEnoughCoinDetail` / `describeMissingCoinDetail` to decide when a newly added coin is legal enough to POST.

The check is deliberately strict about what counts as "present": placeholder values like `-`, `0`, `n/a`, `none`, `unknown` and `other` are treated as blank, because a naive truthiness test accepted all of them. That set is `PLACEHOLDER_DETAIL_VALUES`, which is module-private — you go through `isCoinDetailPresent()` rather than reading the set directly.

Coins that fail the rule are not silently dropped mid-loop. They appear in an **"Exceptions — not imported"** panel showing the raw QIF security name, what the parser *was* able to read, and which details were missing, and each one can be individually overridden and imported anyway.

### CSV import (modal)

> **User-facing guide:** [`docs/csv-import-guide.md`](docs/csv-import-guide.md) explains how to build an importable CSV without reference to any of the code below. Point people there rather than at this section.

**There is no fixed CSV schema.** The importer is column-mapping based, so almost any spreadsheet export will work — you tell it which of your columns means what.

The modal itself carries first-run guidance: a **Download blank template** button (generated from `CSV_MAPPABLE_FIELDS`, so it cannot drift out of date), a pointer to `Export → CSV` as a round-trippable template, and an expandable list of recognised columns.

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
| Purchase Price | `purchasePrice` | Numeric — see below |
| Current Value | `currentValue` | Numeric — see below |
| Notes | `notes` | |
| Dealer | `dealer` | |
| Set | `coinSet` | |
| Metal Content | `metalContent` | |
| Weight (oz) | `weight` | Numeric — a unit suffix or a fraction is fine |
| Sold Price | `soldPrice` | Numeric — see below |
| Sold Date | `soldDate` | |
| Source | `source` | Validated against `manual` / `quicken` / `import` / `csv` |

**Value handling**

- Empty cells are skipped entirely, leaving the field at its default rather than writing a blank.
- The four numeric fields go through `parseNumericCell()` in `src/app/services/csv/numeric-cell.ts`, which tolerates a currency symbol, thousands commas, a trailing unit (`0.7734 ozt`), a simple fraction (`1/10 oz` → `0.1`) and a parenthesised negative (`(1,250.00)` → `-1250`). A cell with no number in it at all still becomes `0`.
- Imported coins get a freshly generated id. `source` is honoured if a `Source` column is present and holds a recognised value; otherwise it defaults to `csv`.

**A fixed bug worth not reintroducing.** Those four fields used to be parsed with `Number(value.replace(/[$,]/g, '')) || 0`. `Number()` returns `NaN` unless the *entire* string is numeric, and `|| 0` then turned that `NaN` into a zero — so `0.7734 ozt`, `1/10 oz` and `1250 USD` all imported as **0**, silently. Weight was the worst affected, both because a troy-ounce figure invites its unit and because melt value is derived from weight. `numeric-cell.spec.ts` pins every one of those cases.

**Minimal example**

```csv
Coin Type,Denomination,Year,Mint Mark,Grade,Purchase Price
Morgan Dollar,Dollar,1881,S,MS63,"$1,250.00"
Mercury Dime,Dime,1916,D,VG8,$895.00
```

**Known limitations** — see "Known gaps and rough edges" near the bottom of this file; the CSV limitations are listed there with everything else.

### Batch image import (modal)

The photo library is about **2,140 files, 4.2 GB**, averaging 2.5 MB with the largest single JPEG at **46 MB**. (During development it is reached over a network share, `\\192.168.0.10\Coin Pictures`; on the machine that actually hosts the app the same files sit on a local drive under a drive letter. See the base-folder note below — this distinction matters more than it looks.) The importer's entire design comes out of those numbers. You point it at the folder (or at individual files), it works out which coin each photo belongs to from the filename, you review the result grouped by coin, and only then does it read a single byte.

**The four stages, in order, and why the order is the whole point:**

**1. Filter — by extension, not by `File.type`.** Pointing the picker at the share hands over ~2,140 files, and a big chunk of them are not web images at all: 343 `.dng` and 40 `.CR2` (camera RAW, an `<img>` renders nothing), 11 `.psd`, 2 `.tif`, plus `Thumbs.db`, `desktop.ini` and stray `.info` text files. If those reached the review screen the user would tick them, the importer would try to decode them, and they would fail silently at the very end of a long run.

The old code used `file.type.startsWith('image/')`, which on Windows is whatever the registry says: `.dng` often reports `image/x-adobe-dng` (passes the test, still undecodable) and `.webp` sometimes reports `""` (fails the test, perfectly displayable). The extension is the only thing that can be reasoned about consistently, so `image-file-filter.ts` uses an explicit allow-list — `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp` — and treats `File.type` as a hint only. Nothing is dropped silently: every rejection is returned with a reason and the reasons are tallied for the summary line.

**2. Match — filenames only, zero bytes read.** `<input webkitdirectory>` hands over `File` handles instantly, because a `File` is only a pointer to something on disk. The expensive part is `file.arrayBuffer()` and decoding, which pulls the bytes over the network share and into browser memory. Reading everything up front would ask the browser to hold gigabytes of pixel data; it will not, and the tab dies or freezes for minutes.

It would also be pointless work, because the matcher needs **nothing but the name**: `1880-S $1 - MS64 - Obverse - Photo.jpg` identifies the coin completely. Stage 2 touches only `file.name`, which makes the review screen appear in well under a second even for the whole share. Matching runs in chunks of `MATCH_CHUNK_SIZE` (200) with a yield to the browser after each, so the window stays responsive.

**3. Review — grouped by coin, collapsed by default.** The review screen has to answer one question per coin: "are these the right photos for this coin?" A flat list of 1,700 filenames cannot answer it, so the unit of review is the coin and `CoinImageGroup` is that unit. A group shows only its counts until you open it, because thumbnails are real `<img>` tags pointing at real multi-megabyte JPEGs — rendering all of them at once would decode gigabytes of pixel data and lock the tab. When you expand a group the parent creates object URLs for just that group, and `loading="lazy"` defers even those until they scroll into view. `ThumbnailCache` owns that on-demand creation.

Photos within a group are sorted, not merely listed, because a coin routinely has 8-10 files: both faces, the slab label, numbered retakes, and derivative renderings (`- Small`, `- Orig`, `- Sharpened`). `photo-variant.ts` works out from the filename alone which face a file shows, which variant it is, and which take in a series.

Anything the matcher could not place goes to one of two "needs a human" buckets, both drawn by `ImageMatchResolver`: **"Needs your choice"** (ranked candidates but no confident winner — an 1881 Morgan that could be the S or the O mint) and **"No match found"** (nothing worth suggesting: group shots like `Gold Coins.JPG` or `20th Century Type Set.JPG`, non-coin items such as stamps, bond coupons and albums, and camera-default names like `IM000025.JPG`).

**4. Attach — read, downscale, save. Strictly one file at a time.** `attach-runner.ts` is the only place in the whole feature that reads bytes off the share or writes to the inventory, and nothing in it runs until the confirm button is pressed.

**Why sequential rather than, say, eight in parallel — this is not a tuning choice.** Decoding a 46 MB JPEG onto a canvas needs its full uncompressed size in memory: an 8000×6000 photo is roughly **190 MB of RGBA**. Eight of those at once is an out-of-memory crash, not a speed-up. Two lesser reasons point the same way: when the files are reached over a network share the transfer rather than the CPU is the bottleneck, and parallel reads off one SMB mount do not help much; and sequential gives an honest, monotonic progress bar. Each file is followed by a yield to the event loop so Angular can repaint the progress bar and the Cancel button stays live, and each file is wrapped in its own `try`/`catch` so a corrupt JPEG is recorded as one failure and the run continues.

Writes are grouped **per coin**, not per file. Inventory saves are debounced per coin, so calling `updateCoin` eight times for one coin would mean eight rounds of change-tracking for a single save. One call per coin, with the coin's existing photos merged in — this is an **append**, never a replace.

**Downscaling: the numbers that drove it.** Images are stored in SQL Server as base64 text, and base64 inflates bytes by 4/3. Attaching the share untouched would mean 4.2 GB × 4/3 ≈ **5.6 GB of text in the database**, for pictures displayed in a gallery a few hundred pixels wide. `image-downscaler.ts` caps the long edge at **1600 px**, keeps the aspect ratio, and never upscales (enlarging a small photo adds no detail, just bytes and blur). Re-encoded at JPEG **quality 0.85** a 1600 px long edge lands around 250 KB, so base64 stores ~333 KB per photo — roughly 0.5 GB for the whole library instead of 5.6 GB, at a resolution that still looks sharp full-screen on a 1080p monitor. Quality 0.85 is the usual photographic sweet spot; below about 0.75 JPEG blocking starts showing in the flat fields of a coin, which is exactly where a collector looks for surface detail.

**Bulk selection rules** (`selection-rules.ts`, all pure `rows -> rows` functions so they can be unit tested without a component or a browser). Every matched image arrives ticked — that was an explicit request — and a coin often has 8-10 files, so unticking one at a time across ~200 coins would be miserable:

| Rule | What it does |
| --- | --- |
| Select / deselect all | Ticks or unticks everything that has a coin to go to |
| Keep only Obverse + Reverse | Ticks the two faces and unticks everything else — labels, retakes, derivatives, unknown sides. The single most useful control: it takes a 10-file coin down to the 2 photos the gallery actually wants. It keeps *all* obverse/reverse files including retakes of them, so pair it with the next rule to get to exactly one shot per face. |
| Deselect retakes | Unticks second-and-later shots (a trailing `-2`, `-3`) and derivative renderings (`- Small`, `- Orig`, `- Sharpened`), leaving the first shot of each face ticked. Only ever removes, never adds. |

One invariant runs through all of them: a row can only be ticked if the matcher or the user actually attached it to a coin. "Selected" can never mean "will be written to nowhere". All rules return a **new** array of **new** row objects, because Angular signals compare by reference and mutating rows in place would leave the UI stale.

**The base-folder input.** The modal asks you to supply the absolute path of the folder you picked — something like `D:\Coin Pictures` (that is an illustrative example, not a default; the folder is wherever you keep your photos). This is not redundant data entry — it is the one piece of information the browser refuses to provide. A browser **never** tells JavaScript where a file really lives on disk; it is a deliberate, non-negotiable security rule, because a page that could read `C:\Users\you\...` out of a file picker would learn your username and folder layout. `file.path` does not exist and `input.value` reads back the fake `C:\fakepath\whatever.jpg`.

What a directory picker *does* give is `File.webkitRelativePath` — the path relative to the folder you chose, always with forward slashes: `Coin Pictures/Business Strikes/1865 3CN - MS60 - Obverse.jpg`. That is the back half of the answer. The front half is something only you know, so the import screen asks once and remembers it with the rest of your preferences. `source-path.ts` glues the halves together (normalising forward slashes to backslashes and stripping the trailing separator Explorer sometimes copies) and the result is what goes into `CoinImages.SourcePath`. Individually picked files have an empty `webkitRelativePath`, so those fall back to `File.name`.

**The path must be valid on the machine hosting the app, not on yours.** The stored path is resolved by the **backend** — Express opens the file and streams it — and never by the browser, so it has to mean something to the host's filesystem. The host runs with a local drive, so these are ordinary drive-letter paths. If you run the importer from a different workstation and hand it a path that only makes sense there, every image will come back as "missing", because the host cannot see it. The import screen says so on the form for exactly this reason.

`CoinImages.SourcePath` values are host-local absolute paths for the same reason. A database populated with paths that are only valid on another machine will show every image as missing.

`import-base-folder.ts` persists the value, and it does a read-modify-write rather than a plain `storage.set()`. `StorageKeys.AppSettings` holds one object shared by every preference, and two places write it — the Settings modal and the importer. Writing a freshly built object would delete whatever the other one had put there, so saving the base folder would silently discard the "show transactions" choice or vice versa.

### Image matching engine

Filenames are parsed semantically and scored against every coin, with each attribute carrying a weight and the score damped by how much of the available evidence could actually be compared. All the tuning constants live in one file, `src/app/services/image-matching/matching-thresholds.ts`.

The folder is now a set of focused parsers, each owning one kind of information:

| File | What it owns |
| --- | --- |
| `filename-vocabulary.ts` | The words that appear in this collection's filenames but describe something *other* than which coin it is: side words (Obverse / Reverse / Label), photo qualifiers (Photo / Orig / Sharpened / Small / Large), grade vocabulary, non-coin words (Stamp / Bond / Set / Album) and catalogue prefixes for ancients |
| `denomination-units.ts` | Reading a denomination out of a number that carries a **unit** — `$20`, `50¢`, `20-cent`, `1-Cent`. Entry point `findUnitBoundDenomination` |
| `year-mint-parser.ts` | `extractYear` and `extractMintMark`. They live together because in real filenames they are physically joined: `1875-CC 20-cent Choice F - Obverse.jpg`, and the lone `1875CC` with no separator at all |
| `grade-parser.ts` | `parseGrade`, `findCertCompanies`, `normalizeGrade`. Real filenames write grades six different ways and several are destroyed by tokenizing — the `+` in `VF+`, the `/` in a slashed grade |
| `photo-markers.ts` | `parsePhotoMarkers` — which side is shown, which shot in a series, which variant of the file. Most coins here are photographed at least twice |
| `catalog-refs.ts` | `findCatalogRefs`, `findEraDate`, `foldCatalogRefs` — ancients and world coins, which are catalogued completely differently (Sear, RIC, Hendin) and have neither a US-style mint year nor a US denomination |
| `non-coin-detector.ts` | `detectNonCoin` — roughly one image in ten on the share is not a photograph of one identifiable coin, and those must never be auto-assigned |
| `coin-signature.ts` | Turning a `CoinRecord` into the comparable form the scorer uses |
| `filename-parser.ts` | The orchestrator over the parsers above |
| `match-scorer.ts` | Weighting and damping |
| `match-decider.ts` | Applying the auto-assign gates |
| `matching-thresholds.ts` | Every tuning constant, in one place |
| `reference-tables.ts` | Denomination / type / mint reference data |
| `text-tokens.ts` | Tokenizing and normalizing helpers |

**Auto-assignment is strict.** An image is attached automatically only when all three gates pass:

1. score >= **0.85** (`AUTO_SCORE_THRESHOLD`)
2. at least **2** independent strong attributes agree (`MIN_STRONG_ATTRIBUTES`)
3. the runner-up is at least **0.15** behind (`AUTO_MARGIN_THRESHOLD`)

Everything else goes to a review list with up to five ranked candidates (`MAX_CANDIDATES`), where the user can confirm, reject, or reassign before applying.

The three gates exist because of specific failures. A single matching attribute, however clean, is never enough — a filename giving only a denomination and a design name cannot distinguish a 1904 Liberty Head Double Eagle from a 1907 one. And the margin gate means two coins differing only by mint mark (1881-S vs 1881-O) land about 0.10 apart, inside the margin, so both go to review rather than one being silently chosen. Mint mark is deliberately weighted *low* for exactly this reason.

Bare-digit denomination matching was removed: a cert number containing "25" used to parse as a quarter. Bare number tokens now contribute nothing, and that is the rule `denomination-units.ts` exists to enforce — a bare number means nothing, a number bound to a unit means a lot.

**The tests match against real filenames.** `image-matching.service.spec.ts` covers the algorithm — the safety gates, the scoring — while `real-filenames.spec.ts` proves it works against *this* collection. Every filename in that spec is verbatim from a survey of the actual share, and nothing in it should be "tidied": the odd spacing, the missing space in `PF62CAM- Obverse`, the mixed-case `.JPG` and the separator-less `1875CC` are all real, and each one broke something.

### Per-coin image management and multiple photos

`CoinImages` has been a **child** table since the baseline schema: one **row** per photo, keyed by its own `ImageId` identity, pointing back at a coin via `CoinId`, with `SortOrder` deciding display order. A coin with ten photos is ten rows. There is deliberately no limit on how many a coin may have, and nothing about the design changes between one photo and twenty. In practice the library holds 8-10 files for a typical coin: obverse and reverse, the slab label, plus derivative renderings and occasional retakes.

So "multiple pictures per coin" was never a single-image column that needed widening. What the batch importer needed on top of the existing design is smaller but real, and that is what `server/migrations/003-multiple-images-per-coin.sql` does:

- **`SortOrder` had to become trustworthy.** Nothing ever stopped two photos of the same coin from sharing a `SortOrder` — the value defaults to 0 and older insert paths did not always assign one, so a coin could easily hold several rows all claiming position 0. With one or two images per coin that was invisible; with eight or ten it is not, because `ORDER BY SortOrder` over rows that all say 0 returns them in whatever order the engine finds cheapest, and the gallery was free to show Reverse first today and Obverse first tomorrow. Migration 003 renumbers each coin's photos 0, 1, 2, … in the order they sort *today*, so every ordering choice that was already unambiguous is preserved and only genuine collisions are touched (ties broken by ascending `ImageId`, which resolves them to insertion order). New inserts assign `MAX(SortOrder) + 1`.
- **The per-coin lookup had to stay cheap.** The hot query is `WHERE CoinId = @id ORDER BY SortOrder`. The old `IX_CoinImages_CoinId` covered only `CoinId`, so the plan had to sort the matching rows every time. Migration 003 creates `IX_CoinImages_CoinId_SortOrder` and then drops the old index — the new one is created first so there is never a moment with no index on `CoinId`, and dropping the old one afterwards is safe because `CoinId` is the new index's leading column. Barely measurable at two rows per coin; worth having at ten across a few thousand coins.

Migration 003 deliberately does **not** add a unique index on `(CoinId, SourcePath)` to stop the same file being attached twice. It is tempting, and the import already de-duplicates on the client, but a `UNIQUE` constraint turns any duplicate that slips through into a hard SQL error — and because the image insert runs as one transaction, a single duplicate would abort the whole batch. Silently re-attaching one photo is a much smaller problem than a 200-photo import failing at file 150.

From the UI:

- Add images via file picker or drag-and-drop in the detail panel, or in bulk through the batch importer
- Click thumbnails to open a full-screen photo viewer with prev/next navigation
- Delete individual images from the gallery

### Where each photo came from

`CoinImages.ImageData` is only a **downscaled** base64 copy, sized for display. `CoinImages.SourcePath NVARCHAR(400) NULL` records where the **original** full-resolution file lives on the machine hosting the app, so the app can show the user where a photo came from and offer a link that opens the full-scale image.

These are absolute paths **on the host machine**, which runs with a local drive — so ordinary drive-letter paths. They are resolved by the Express process, not the browser, and a database populated with paths that are only valid on some other machine will show every image as missing.

The column is **nullable and that is deliberate.** Every photo imported before the column existed has no known path, and "unknown" is not the same as "empty string". Those rows keep working exactly as they did; the UI simply shows no link for them. The count only goes down as photos are re-imported through the batch importer, which records the path as it attaches each file. `NVARCHAR(400)` is sized for real paths on this setup with room for deep subfolders, and is small enough to sit in an index key if a later migration ever needs one — which `NVARCHAR(MAX)` would not be.

**Two backend endpoints make the path useful** (`server/routes/images/`):

| Endpoint | What it does |
| --- | --- |
| `GET /api/images/file?path=<absolute path>` | Streams the original file off the host's disk |
| `POST /api/images/exists` | Batch-checks whether a list of paths is still readable: `{ "paths": [...] }` in, `{ "results": { path: boolean } }` out |

**Why the backend has to serve the file at all.** The obvious idea is to skip the server entirely — the file is right there on the same machine, so just make the link `file:///C:/Coin Pictures/a.jpg`. That does **not** work. Chrome and Edge refuse to navigate from an `http(s)` page to a `file://` URL. It is a deliberate security rule, not a bug or a setting, and the click is dropped **silently** — no error, no tab, nothing. Typing the same `file://` URL into the address bar by hand works fine, which makes the failure very confusing to diagnose. So the file has to arrive over http from an origin the page is allowed to link to, and the Express server is already running on that machine and can read the disk.

**The security tradeoff, stated plainly.** `GET /api/images/file` is "read any file on the host machine whose name ends in an image extension". There is no root directory it is confined to. On a public server that would be a serious vulnerability. It is acceptable here because of what this app is: a single-user inventory the owner runs on his own PC, serving photos that live in arbitrary folders on that same PC — a confined root would defeat the feature, since the whole point is that the pictures are wherever the user put them. Security is explicitly not a concern for this project. Two cheap mitigations are in place anyway: the extension allowlist in `allowed-types.ts` (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.tif`, `.tiff`), which means the route cannot be used to read `.env`, `app.log` or a source file; and every access is logged with the resolved path. If this app is ever exposed beyond localhost, this route is the first thing to lock down — confine it to a configured pictures root, or serve by `ImageId` and look the path up in the database instead of accepting it from the client.

The route **streams** rather than reading into memory. The originals are camera files up to ~46 MB; `fs.readFile()` would pull the whole thing into the Node heap before sending a byte, and several concurrent clicks could push the process into a heap OOM kill. `createReadStream().pipe(res)` hands the data over in 64 KB chunks at near-constant memory, with automatic backpressure. `Content-Length` is set so the browser can draw a real progress bar, and `Content-Disposition: inline` asks it to display the photo rather than download it. `.tif`/`.tiff` are on the allowlist even though Chrome and Edge will not render TIFF inline — the point of the feature is to let the user *reach* the original, and refusing to serve a format they actually have on disk would be worse than handing over a file the browser chooses to download.

`POST /api/images/exists` is a POST and a batch for concrete reasons. The UI needs the answer the moment a coin is opened, for every one of that coin's photos; a coin can easily have eight, and firing eight HTTP requests to render one panel is wasteful and makes the links pop in one at a time. POST rather than GET because the payload is a list of long Windows paths full of backslashes, spaces, colons and non-ASCII characters, and stuffing eight of those into a query string risks URL length limits and a pile of encoding bugs. The handler never throws because of a path — a malformed path, a disconnected network drive, a permissions error are all simply `false`, because to the user they all mean "we cannot open that file, so do not offer a link". It uses the **async** `fs` API, because `existsSync()` blocks the single Node event loop for the duration of the disk call and against a disconnected drive that stall can be seconds long, during which the server answers *nothing* — not other requests, not the launcher's health probe. A cap of 500 paths per request guards against a pathological record.

**On the frontend, a path is shown per image, and it has three states — not two.** `image-path-display.ts` works all of it out as pure functions and hands the template a plain object, which keeps the markup free of nested conditionals and makes the behaviour testable without a browser:

| State | How it renders | Why |
| --- | --- | --- |
| `present` | A real link, opening in a new tab | The backend confirmed the file is readable |
| `missing` | **Not** a link — rendered as a `<span>`, so no `href`, no underline, no pointer, not focusable — in a muted colour, with the path text still visible | The backend looked and it is not there. The text stays because the user explicitly wants it as a record of where the file *was* |
| `unknown` | Plain, un-muted text with no link | We could not ask — the server was unreachable, or the check has not finished. Showing "missing" here would tell the user his whole photo library had vanished every time the backend restarted |
| (no path recorded) | Nothing at all | An empty or dead affordance is worse than no affordance |

That `unknown` state is the point worth remembering: **"unknown" is deliberately distinct from "missing."** A failure to reach the backend must never be reported as a lost file.

Long paths are shortened from the **middle**, keeping both ends, at `PATH_DISPLAY_LIMIT` (58) characters. Truncating the end would hide the filename, which is the part the user actually reads; truncating the start would hide which drive and top-level folder it came from; so the intermediate folders — the least informative part — are what give way. The full path is always in the `title` tooltip regardless, along with a short explanation of the state.

`CoinImagePathLink` is its own component because three places show a photo — the gallery list, the full-screen viewer, and the detail sidebar's photo strip — and all three need identical behaviour, the same three states, the same tooltip wording and the same muted colour. All it takes as input is the image's `data:` URL.

`CoinImagePathsService` sits behind it and enforces four rules:

1. **Lazy.** Nothing is fetched until a coin is actually being viewed.
2. **One existence request per coin**, never one per image.
3. **Cached for the session.** Images are cached per coin id and existence per path — per *path*, not per coin, because the same file can legitimately be the source for more than one image. Clicking away from a coin and back issues no requests at all.
4. **A failure is "unknown", not "missing."**

**The data-loss bug this design prevents.** `PUT /api/coins/:id` **replaces** a coin's whole image set — it deletes the rows and re-inserts them. Any entry sent as a bare string comes back with `SourcePath NULL`. So re-ordering or deleting **one** photo, both of which send the full `imagePaths` array, would quietly wipe the recorded paths of every *other* photo on that coin. `ImageSourcePathRegistry` is what stops that: `CoinEditor` calls `imageSourcePaths.enrich()` on the way out to the server, turning

```
imagePaths: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"]
```

into the object form the backend also accepts:

```
imagePaths: [{ imageData: "data:...AAA", sourcePath: "D:\\Coin Pictures\\1881-S $1 - Obverse.jpg" },
             { imageData: "data:...BBB", sourcePath: null }]
```

Enriching every outgoing array from one place means a path, once known, survives deletes and reorders. The registry is keyed by the image data rather than by a database id, because at import time there is no id yet and the data URL is the only thing identifying the image on both sides of the wire. It is in-memory and session-scoped, and losing it costs nothing — the paths are in the database and the next fetch repopulates it. It is filled from both ends: the batch import, which has just computed the path, and the viewer, which learns paths from `GET /api/coins/:id/images`.

`server/routes/coins/image-payload.ts` normalises whichever shape arrived — plain string or `{ imageData, sourcePath }` — into one `NormalizedImage` before any insert code sees it. Both forms keep working, so nothing that still sends bare strings breaks. Adding a third field to an image later means editing that one file.

### Persistence

#### SQL Server backend (`server/`)

The coin collection lives in SQL Server. A separate Express/TypeScript backend provides the REST API. The schema is created and seeded from `server/setup-database.sql`, which defines the canonical tables for coins, images, tags, categories, denominations, mint marks, metal contents, transactions, spot prices, and app settings with proper foreign keys and indexes. Authentication defaults to Windows (trusted connection) for easy local development.

**`setup-database.sql` drops every table before creating it, so it is only for an empty or disposable database.** Changes to a database that already has coins in it go in `server/migrations/` instead, as numbered scripts following two rules: guard every statement so re-running the file is harmless (there is no migration-tracking table in this project, so "safe to run twice" is what takes its place), and never drop or rewrite a column that holds user data. The numbering starts at 002 because `setup-database.sql` is effectively migration 001 — the baseline every delta is measured against.

| Script | What it does |
| --- | --- |
| `002-add-image-source-path.sql` | Adds `CoinImages.SourcePath NVARCHAR(400) NULL`, guarded by a `COL_LENGTH` check |
| `003-multiple-images-per-coin.sql` | Adds `SourcePath` if 002 was never run, renumbers duplicate `SortOrder` values per coin, and replaces `IX_CoinImages_CoinId` with `IX_CoinImages_CoinId_SortOrder`. Prints a summary of the table when it finishes |

003 repeats 002's column deliberately: the two changes ship together, and a database that got the index but not the column would be a confusing half state. Run them in order if you have not run either; run 003 alone if you prefer.

**API endpoints**

| Group | Endpoints |
| --- | --- |
| Health | `GET /api/health` |
| Coins | `GET /api/coins`, `GET /api/coins/:id`, `POST /api/coins`, `PUT /api/coins/:id`, `DELETE /api/coins/:id` |
| Coin images | `GET /api/coins/:id/images`, `POST /api/coins/:id/images`, `DELETE /api/coins/:id/images/:imageId` |
| Original image files | `GET /api/images/file?path=`, `POST /api/images/exists` |
| Lookups | `GET/POST/DELETE /api/categories`, `/api/coin-sets`; `GET/POST/PUT/DELETE /api/denominations`, `/api/mintmarks`; `GET /api/metalcontents` |
| Transactions | `GET /api/transactions`, `POST /api/transactions`, `DELETE /api/transactions/:id` |
| Spot prices | `GET /api/spot-prices/latest`, `GET /api/spot-prices/fetch`, `POST /api/spot-prices` |
| Settings | `GET /api/settings/:key`, `PUT /api/settings/:key` |
| Logging | `POST /api/log` |

`express.json()` is configured with `limit: '50mb'`, which a large batch image POST can genuinely hit. When it does, the caller now gets a 413 with a message about batch size rather than a generic 500 — see `routes/error-handler.ts` above.

#### IndexedDB (`src/app/services/storage.service.ts`)

IndexedDB holds only browser-local UI preferences — column visibility, app settings, and the image importer's remembered base folder — keyed by `StorageKeys`. It is not where coin data lives. This is why the launcher opens Edge with your normal profile rather than a throwaway `--user-data-dir`: a fresh profile would silently reset those preferences on every launch.

## Tech stack

- Angular 22 (standalone components, signals, `@if`/`@for` control-flow syntax, `inject()`, `output()`)
- TypeScript 6 (frontend), TypeScript 5.7 (server)
- SCSS with partials
- Vitest 4.x for unit testing (with `fake-indexeddb` for storage tests, `jsdom` for DOM-facing specs)
- Express + mssql
- Supertest for Express API testing

## Prerequisites

- Node.js 22.22+ recommended (required for Angular CLI `ng` commands)
- npm 10+
- SQL Server Express (required for the `server/` backend; use the local instance or configure `DB_SERVER` in the server `.env` file)

## Run locally

These are the files that actually exist in the project root, so you know which one to look for:

| File | What it is |
| --- | --- |
| `launch-coin-inventory.cmd` | **Double-click this.** A tiny wrapper that forwards to `start-coin-inventory.ps1`. In Explorer it may appear as just "launch-coin-inventory" without the extension, because Explorer hides known extensions by default — look for the file with the gear icon. |
| `start-coin-inventory.ps1` | **The real launcher.** Everything described below lives here. |
| `run-coin-inventory.ps1` | Started *by* the launcher. Does nothing but `npm start` in the project directory. Not an entry point you run yourself. |
| `setup\start-coin-inventory.ps1` | A shim that forwards to the root launcher. |

There used to be an `open-edge.ps1` here as well. It was a leftover from before the launcher opened the browser itself, and it still had the old behaviour — poll port 4200 only, and do nothing at all if any Edge window was already open. Nothing called it, and keeping a script that waits on the wrong thing invites someone to use it and hit the original startup race, so it was deleted.

So:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

`setup\start-coin-inventory.ps1` used to be a second, independent implementation, and the two drifted apart — different readiness probes, different lock files and different shutdown logic. Because the lock files differed, launching both at once started two copies of the servers that then fought over ports 3000 and 4200. It is now a shim.

`run-coin-inventory.ps1` deliberately does **not** touch `.coin-inventory.lock`. The lock file belongs to the launcher, which creates it and removes it in its own `finally` block. A previous version deleted the lock here too, which meant this child process could remove the launcher's lock while the launcher was still running — so a second launch would think nothing was running and start a duplicate set of servers.

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

- **Run the outstanding migrations in `server/migrations/`** — see the section at the top of this file. Everything to do with photo source paths and reliable image ordering depends on them.
- Category, denomination, mint-mark, and metal-content reference data are database-backed and seeded via `server/setup-database.sql` rather than hard-coded runtime seed logic.
- Metal content values are repaired and persisted in the database, and `Other` is avoided unless the data truly does not fit a known value.
- The SQL configuration is read from `server/.env` by `server/db/config.ts`, with handling for named instances.
- `SPOT_PRICE_BASE_URL` in the environment overrides the spot-price endpoint if it ever needs swapping without a code change.
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
# Frontend — 516 tests across 30 files
npm test

# Server — 135 tests across 15 files
cd server && npm test
```

The frontend suite runs as **`vitest run --root src`** (that is what `npm test` expands to). On Windows, when the project sits at or near a drive root, Vitest 4.x has a path-resolution problem that makes it find zero test files; pointing `--root` at `src` works around it. Run it that way rather than a bare `npx vitest run`.

Server specs sit next to the code they cover — `db/connection.spec.ts`, `db/coin-fields.spec.ts`, `routes/coins/reads.spec.ts`, `routes/coins/writes.spec.ts`, `routes/coins/images.spec.ts`, `routes/coins/images-post.spec.ts`, `routes/coins/image-payload.spec.ts`, `routes/coins/list-query.spec.ts`, `routes/images/images.spec.ts`, `routes/lookups/lookups.spec.ts`, `routes/data/data.spec.ts`, `routes/data/spot-price-source.spec.ts`, `routes/db-error-response.spec.ts`, `routes/error-handler.spec.ts` — and they all share `server/test-support/mssql-mock.ts`. `server.spec.ts` covers the app wiring and the health endpoint. `db/connection.spec.ts` includes the regression test for the crash — it emits `'error'` on the pool and asserts the process survives.

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

Every `GET /api/images/file` access is also logged with the resolved path, which makes it easy to see exactly which original a click reached for.

**Run the backend on its own.** Easiest way to see startup errors, which the launcher hides in a separate window:

```powershell
cd server
npx tsx server.ts
```

You should see the connection attempt logged, then `Coin Inventory server listening on http://localhost:3000`.

**"Coin Inventory is already running."** A lock file (`.coin-inventory.lock`) is present and its PID is still alive. If you are sure nothing is running, delete the file and relaunch.

**Startup times out after 180 seconds.** The launcher prints which side it was waiting for. If it was the database API, SQL Server is almost certainly the problem — check `server/logs/app.log`.

**Spot prices all come back as $0, or some metals are missing.** The fetch endpoint reports failures explicitly now: the response carries an `error` message and a `failed` array naming which metals could not be retrieved. Check `app.log` for a `Spot price fetch for <metal> ... ` warning, which gives the HTTP status or the error message per symbol. A zero is never stored for a metal that failed.

**A photo's path shows but is not clickable.** That is the `missing` state: the backend looked for the file and it is not readable. Either it was moved or deleted, or the path is one the *host* machine cannot resolve. Paths are resolved by the Express process against the host's own local drives, so a whole folder of "missing" entries usually means the base folder given at import time was a path that made sense on some other machine. Re-import those photos with the host's own path and the links come back.

**Every photo's path is plain text with no link at all.** That is the `unknown` state, and it means the existence check itself did not come back — almost always because the backend is unreachable. Check `/api/health` first; the paths will become links again once it answers.

**No photo shows a path.** You probably have not run the migrations. See the top of this file.

## Known gaps and rough edges

Documented honestly so they are not rediscovered as surprises.

- **`app.scss` never imports `styles/_modal.scss`.** `_modal.scss` is where `.modal-backdrop` (`position: fixed; inset: 0`), `.modal`, `.modal--wide`, `.modal-header` and `.modal-close` are defined. Six modals `@use` it themselves — CSV import, category, spot price, report, image import, Quicken import — but the **Settings dialog** and the **image gallery** do not, even though their markup uses those exact class names. So both may render without a backdrop or fixed positioning. A comment at each site (`settings-modal.scss` and `coin-image-gallery.scss`) records that this is deliberately preserved behaviour rather than an oversight: the classes had no styling for as long as the markup lived in `app.html`, and the extraction into components changed nothing visually on purpose. The fix is a one-line `@use '../../styles/modal' as *;` in each. (The full-screen photo viewer is *not* affected — it defines its own fixed backdrop.)
- **CSV import does not apply the 2-of-3 completeness rule.** QIF import requires at least two of Year / Coin Type / Denomination; CSV import does not, so an under-specified row is sent to the backend and rejected there with `400 {"error":"denomination is required"}`.
- **Several fields cannot be imported from CSV at all**, because they are not in the mappable list: `hasCacSticker`, `tags`, `imagePaths`, and — worth noting — `pmWeightGrams` and `pmPercent`, which melt-value calculations depend on. A CSV round-trip therefore loses CAC flags and precious-metal weights, so a CSV export is a good report and a good starting template but **not** a backup. (The `Source` column *is* now importable, so provenance does survive a round trip; `exportCsv()` derives its columns from `CSV_MAPPABLE_FIELDS`, which makes an exportable-but-unimportable column structurally impossible. `export-import-round-trip.spec.ts` asserts it.)
- **One input still uses placeholder-as-label.** Just one, in the bulk edit bar: `<input #bulkValue type="text" placeholder="New value" />`, with no wrapping `<label>`, no `aria-label` and no caption span. The rest of the app has been cleaned up — the Settings modal's four inputs each sit inside a `<label>` with a caption span, the category modal's five all carry an explicit `aria-label`, and the coin editor form has no `placeholder` attributes at all. Two related but different defects are worth knowing about while you are in there: the `<select #bulkField>` next to that input has no accessible name either (it carries no `placeholder`, so it is not the same gap), and the Settings modal's four `<textarea>` elements share a `<label>` with an `<input>` that comes first — and HTML labels only the *first* labelable descendant, so those textareas end up unnamed.
- **`GET /api/transactions` does `SELECT *`** including an `NVARCHAR(MAX)` Notes column, with no row bound and no pagination. Fine at the current size, but it will be the first thing to feel slow.
- **`GET /api/coins` still returns `imagePaths` by default.** That is a temporary compatibility shim. The intent is for the default to flip to `includeImages=false` once the client is migrated to fetch images per coin, so the main list stops shipping the full base64 for every coin up front.
- **`GET /api/coins/:id` returns `imagePaths` as a flat string array with no source paths.** Source paths come from `GET /api/coins/:id/images`, which is what `CoinImagePathsService` calls; the single-coin read has not been widened.

---

## Planned next steps

### 1. Flip `GET /api/coins` to `includeImages=false` by default

The server already supports it and the client already has a per-coin image fetch (`CoinImagePathsService`). What remains is migrating the last readers of `imagePaths` on the list endpoint and then changing the default, so loading the inventory stops shipping every coin's base64.

### 2. Certification company logos for PCGS, NGC, and ANACS

The CAC green bean accent is done. Official logos for grading companies were skipped due to trademark concerns. If revisited:
- Would need real logo assets or custom non-trademarked badges
- Data model needs a way to distinguish "raw / not certified" from "certified but certCompany is empty"

### 3. Premium feature research

Research premium coin inventory programs (PCGS CoinFacts, NGC Registry, Numismaster, etc.) and adopt the best ideas that make sense for this application.

### Longer-horizon ideas (not yet scheduled)

- Valuation-service integration (market pricing by denomination/grade)
- Fuzzy edit-distance matching for filenames the current parsers cannot read
- "Raw" coin explicit visual state
- Dashboard with charts (value over time, category breakdown)
- Server-side de-duplication of image inserts (in the insert logic, where a duplicate can be dropped without killing the batch — *not* as a unique constraint; see migration 003)
- Apply the 2-of-3 completeness rule on the CSV import path too

### Done (kept here so it is not re-planned)

- **Fix esbuild/ng serve** — resolved via the webpack builder plus the `esbuild-wasm` override in `package.json`. The app serves and builds.
- **Wire up SQL Server backend** — done. `InventoryService` goes through `ApiService` to the Express API; IndexedDB is now only UI preferences.
- **Batch image import** — done. Point at the photo folder, match ~2,140 files on filename alone, review grouped by coin, then read and downscale only the confirmed files, sequentially.
- **Multiple images per coin** — done. `CoinImages` was always a child table; migration 003 made `SortOrder` deterministic and widened the index to match the hot query.
- **Image source paths** — done. `CoinImages.SourcePath`, the `/api/images` endpoints, `ImageSourcePathRegistry`, and a three-state path display per photo.
- **Fix the COMEX spot-price fetch** — done. metals.live was dead; replaced with COMEX/NYMEX futures symbols, with copper correctly converted from per-pound to per-troy-ounce and failures reported instead of stored as zero.
- **Fix the page-level scrollbar** — done. `src/styles.scss` was empty; it now carries the body reset, and the status bar became a normal flex row instead of a fixed overlay.
- **Remove placeholder text from the detail entry fields** — done, and the Cert Company input was widened so "ANACS" fits.
- **Share the 2-of-3 rule** — done. It lives in `src/app/services/coin-completeness.ts` and is used by both the QIF importer and the manual "Add coin" path.
- **Stronger filename normalization for image matching** — done. The `image-matching/` folder is now fourteen focused modules — seven of them new, single-purpose parsers — plus a spec that runs against verbatim real filenames from the collection.
