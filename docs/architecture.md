# Architecture

How Coin Inventory is put together: the screen layout, the component
boundaries, the stores, the services and the backend.

For what each feature does and the rules it follows, see
[how-it-works.md](how-it-works.md). For the reasoning behind non-obvious
design choices, see [rationale.md](rationale.md). For running and building,
see the [README](../README.md).

## Overview

| Part | Technology | Where |
| --- | --- | --- |
| Front end | Angular 22 standalone components, signals, no router | `src/app/` |
| Back end | Express on Node 22+ | `server/` |
| Database | SQLite through Node's built-in `node:sqlite` | one file, `%LOCALAPPDATA%\CoinInventory\coin-inventory.db` |
| UI preferences | IndexedDB in the browser | `StorageService` |

The browser never touches the database or the disk. Every coin, photo and
lookup goes through the REST API on port 3000; under `ng serve` the page is on
port 4200 and calls the API by absolute URL.

## Front end

### Layout: inventory first

The inventory table is the application. Imports, reference data, reports and
settings are modal dialogs opened from the toolbar. From top to bottom:

1. **Header** with the toolbar (Add Coin, Import ▾, Export ▾, Settings, Help)
2. **Filter bar**: search, category, status tick boxes, and a collapsible advanced panel
3. **Main grid**: the inventory table, plus the detail sidebar when a coin is open
4. **Bulk edit bar**: fixed at the bottom while coins are multi-selected
5. **Status bar**: the last item of the shell's flex column (database state and a Retry button)

The page is one fixed-height screen that scrolls internally. The root
`:host` is a flex column: error banner, `.app-shell` (`flex: 1; min-height: 0`),
status bar. The status bar is in normal flow, not `position: fixed`, so it
never covers the last table row. Print styles release the height locks.

### The app shell (`src/app/app.ts`)

The shell owns only page-wide concerns: the connection banner, the status bar,
which panel or modal is open, whole-file import/export, start-up hydration and
the default selection.

- **Every dialog's open flag lives in the shell.** The toolbar only emits which
  menu entry was picked; `handleImportSelection` / `handleExportSelection`
  route it. A modal nothing opens is unreachable, so `app.spec.ts` drives each
  menu entry through these handlers.
- **`openCoinDetail`** is the single path behind a row click, Enter/Space on a
  row, and Add Coin. It is not a toggle; only the panel's Close button closes
  the panel. `selectCoin` alone (used by filtering and start-up) never opens it.
  When filtering hides the selected coin, the shell selects the first visible row.
- **Focus.** Add Coin bumps a counter input so the panel focuses its first
  field; closing the panel resets it. Row clicks never move focus, so arrow-key
  navigation stays in the grid.
- **Start-up.** `hydrate()` loads coins, lookups and the last saved spot prices.
  Afterwards `autoRefreshSpotPrices()` fetches live prices in the background,
  unawaited, at most once per session, and a failure shows no toast. If
  start-up fails, the first successful Retry runs it.
- **Unlinked-denomination banner.** The shell counts coins with no linked
  denomination and shows an amber `role="status"` banner whose Review button
  opens that pane of Reference Data. It stays silent at zero and until the
  denomination lookup has loaded.
- **Lazy loading.** Every dialog and the detail panel sit in `@defer` blocks.
  The detail panel, gallery and viewer use `prefetch on idle`; the rest load
  on demand. Each `@defer` keeps an inner `@if`, because a triggered `@defer`
  never reverts. `@loading (after 100ms)` with no `@placeholder` draws nothing
  on a normal open. The toolbar, filter bar, table, toast and bulk-edit bar are
  never deferred. `app.spec.ts` checks this by reading `app.html` as text.
- **No router.** `@angular/router` is installed but unused; adding routes means
  `provideRouter([...])` in `app.config.ts`.

### State stores

Shared state lives in plain classes created by the shell with `new` (not DI)
and passed to child components as signal inputs. That makes ownership explicit
and lets a test create a throwaway store.

| Store | File (`src/app/features/inventory/`) | Holds |
| --- | --- | --- |
| Filters | `inventory-filter.store.ts` | Search, filters, sort, grouping and group order |
| Columns | `inventory-columns.store.ts` | Visible columns |
| Selection | `inventory-selection.store.ts` | Row tick boxes, shift-click ranges, bulk-edit target |
| Images | `coin-images.store.ts` | Gallery and full-screen viewer state, file-to-base64, main photo |
| File I/O | `inventory-file-io.ts` | JSON export and CSV / insurance CSV export |

Pure helpers beside them:

| File | What it decides |
| --- | --- |
| `inventory-filter-persistence.ts` | Saving and validating restored filter state |
| `grid-grouping.ts`, `group-order.ts` | Group-by rows, the "(No X)" bucket, custom group order |
| `grid-keyboard.ts` | Arrow / Enter / Space handling and the roving tabindex |
| `collection-zero-state.ts` | Which empty-grid message to show |
| `denomination-sort.ts` | Ordering denominations by face value |
| `image-path-display.ts` | How an image's original-file path is rendered |
| `photo-viewer-window.ts` | The viewer window's initial and maximum size |
| `coin-icons.ts` | Shared image asset paths (the CAC bean) |

`src/app/features/app-settings.ts` holds the `AppSettings` shape shared by the
shell, the Settings dialog and the image import. `src/app/features/confirm-action.ts`
wraps `window.confirm` (see [how-it-works.md](how-it-works.md#confirmation-prompts)).

### Components (`src/app/components/`)

Each component uses `inject()` and `output()`. The frontend tests run under
plain Node (jsdom only where unavoidable), and a component with a required
signal `input()` cannot be built without `TestBed`, so the logic worth testing
is lifted into a pure module beside the component.

| Component | What it draws | Pure helpers beside it |
| --- | --- | --- |
| `AppToolbar` | Toolbar and split-button menus | |
| `InventoryFilterBar` | Search, category, status, advanced filters | |
| `InventoryTable` | The grid, grouping headings, thumbnails | |
| `CoinDetailPanel` | The sidebar frame (Show images / Close / Delete, draft note) | `first-editable-field` |
| `CoinEditorForm` | Every editable field of a coin | `custom-option-mode`, `denomination-picker`, `denomination-aliases`, `denomination-countries`, `country-denomination-link` |
| `CoinImageGallery` | A coin's photos; the only per-coin upload point | |
| `CoinPhotoViewer` | Full-size viewer | |
| `CoinImagePathLink` | One image's original-file link (gallery, viewer, sidebar) | |
| `BulkEditBar` | Bulk actions for ticked rows | |
| `NotificationToast` | Toasts | |
| `CsvImportModal` | Excel and CSV import (one dialog) | |
| `QuickenImportModal` | QIF import | |
| `ImageImportModal` | Batch image import | |
| `CoinImageGroup` | Image import tier 1: one coin and its matched photos | |
| `NearMatchReview` | Image import tier 2: one coin and its near-match photos | |
| `CategoryModal` | Reference Data screen | `reference-sections`, `denomination-grouping`, `denomination-expansion`, `reference-usage`, `issuer-draft`, `issuer-kind`, `issuer-lookup` |
| `ReportModal` | Printed reports | `reports/` (see below) |
| `StatisticsModal` | Statistics and charts | uses `services/statistics/` |
| `SpotPriceModalComponent` | Spot prices | |
| `SettingsModal` | App settings, PM backfill, backup and restore | uses `services/backup/` |
| `HelpModal` | Help and "Report a problem" entry | |
| `SupportModal` | Problem report | uses `services/support/` |

`report-modal/reports/` is the report pipeline: `build-report` →
`ReportDocument` (`report-types`) → `report-html` → `print-window`, with
`report-fields`, `report-totals`, `report-scope`, `report-images` and
`image-thumbnail` as pure helpers. Only `print-window` touches the DOM.

### Directives (`src/app/directives/`)

| File | What it is |
| --- | --- |
| `numeric-field.ts` | `appNumericField`, applied to every number box in the coin editor |
| `numeric-field-format.ts` | The pure parse/format pair it uses |

### Services (`src/app/services/`)

| Service or module | Responsibility |
| --- | --- |
| `InventoryService` | The single front door to the collection; owns the signals components read |
| `ApiService` | HTTP calls to the backend |
| `StorageService` | IndexedDB persistence for UI preferences, keyed by `StorageKeys` |
| `QuickenImportService` | QIF parser |
| `CsvService` | CSV parsing, header mapping, CSV and insurance CSV export |
| `ImageMatchingService` | Filename-to-coin matching |
| `BatchImageImportService` | Plans and applies a batch photo import |
| `CoinImagePathsService` | Per-coin original-file paths and existence checks, cached per session |
| `SpotPriceService` | Spot prices, through the backend |
| `LoggingService` | Console logging plus `POST /api/log` |
| `NotificationService` | Toasts |
| `GlobalErrorHandler` | Logs unhandled errors, records them for problem reports, shows a toast |
| `coin-completeness.ts` | The 2-of-3 rule shared by every coin-creating path |
| `coin-countries.ts` | Country names and codes; foreign denominations in QIF names |
| `coin-photos.ts` | The one answer to "what photos does this coin have?" |
| `image-source-paths.ts` | `ImageSourcePathRegistry`: displayed image → original file path |
| `import-sold.ts` | The "is this record sold?" rule shared by all importers |
| `pm-reference.ts`, `metal-inference.ts`, `pm-fill.ts` | Composition table, coarse metal fallback, and the adapter that writes both onto a coin |
| `pm-autofill.ts`, `pm-backfill.ts` | Editor autofill and the Settings backfill |
| `http-utils.ts` | `resolveApiBaseUrl`, `describeHttpError`, retry rules |

Plain modules (everything ending in `.ts` without `.service`) are not
injectable. `ImageSourcePathRegistry` is a module-level singleton because
`InventoryService` must stay constructible from an injection context providing
only `ApiService`, `LoggingService` and `NotificationService`.

Subfolders:

| Folder | Files |
| --- | --- |
| `inventory/` | `coin-change-tracker`, `coin-collection`, `coin-create-requirements`, `coin-draft-registry`, `coin-editor`, `coin-factory`, `coin-image-hydrator`, `coin-thumbnail-revision`, `connection-manager`, `draft-row-status`, `inventory-metrics`, `load-failure`, `lookup-manager` |
| `image-matching/` | `filename-parser`, `filename-vocabulary`, `text-tokens`, `year-mint-parser`, `denomination-units`, `grade-parser`, `grade-tolerance`, `photo-markers`, `catalog-refs`, `non-coin-detector`, `proof-strike`, `coin-signature`, `reference-tables`, `match-scorer`, `match-vetoes`, `match-decider`, `matching-thresholds`, `near-match`, `sibling-inference` |
| `image-import/` | `batch-import-session`, `image-file-filter`, `photo-variant`, `photo-sets`, `row-decisions`, `selection-rules`, `coin-lookup`, `thumbnail-cache`, `existing-photo-mode`, `already-attached`, `attach-runner`, `image-downscaler`, `encode-budget`, `image-storage-settings`, `referenced-encoder`, `reference-url`, `source-path`, `base-folder-state`, `base-folder-check`, `import-base-folder`, `import-progress` |
| `denominations/` | `denomination-display`, `denomination-resolution`, `denomination-index`, `unlinked-denominations` |
| `csv/` | `mappable-fields`, `header-synonyms`, `date-column-shape`, `numeric-cell`, `byte-order-mark`, `import-plan` |
| `xlsx/` | `read-workbook`, `workbook-sheets`, `workbook-cell-text`, `sheet-header-comparison` |
| `statistics/` | `collection-totals`, `composition-breakdown`, `precious-metal-holdings`, `spend-over-time`, `chart-geometry`, `stats-format` |
| `backup/` | `backup-runner`, `backup-folder-browser`, `picked-folder`, `backup-messages` |
| `support/` | `support.service`, `issue-url`, `recent-errors.service` |

The `inventory/` helpers are ordinary classes created by `InventoryService`;
the signals are created in the service and passed in, so each piece of state
exists once.

### Types (`src/app/types/`)

| File | Contents |
| --- | --- |
| `coin.model.ts` | `CoinRecord`, QIF records, image-matching and batch-import types, spot prices, denominations |
| `coin-image.model.ts` | `AttachedImage`, `CoinImageRecord`, `ImageFileExistence` |
| `reference-data.model.ts` | Issuers, usage counts, lookup outcomes (shared by API layer and screen) |
| `inventory-columns.ts` | Column order, labels, cell formatting, grade badges |
| `collection-status.ts` | Status tokens, `isHeldInCollection` |
| `catalog-reference.ts` | Catalogue list and reference formatting |

Batch-import types live in `coin.model.ts` so the modal, its child components
and the services share them without importing each other.

### Styles

Angular scopes component styles to the component's own template, so each
component holds its own styles and `@use`s the shared partials it needs.
`src/styles.scss` is the only global sheet (margin reset, `body { overflow: hidden }`).

| Partial (`src/app/styles/`) | Contents |
| --- | --- |
| `_base.scss` | Host element, page background, resets |
| `_layout.scss` | Shell, top bar, main grid (sidebar 420px; below 900px it drops beneath the table) |
| `_controls.scss` | Buttons, badges, grade badge colours, `box-sizing` |
| `_panel.scss` | The white card used by the table and the detail panel |
| `_field.scss` | `.detail-field`: a caption `<span>` above its control (never a placeholder as label) |
| `_modal.scss` | Dialog backdrop and chrome |

`app.scss` uses `base` and `layout` only, so the `.eyebrow` caption in
`app.html` currently renders unstyled.

### Testing layout

- `src/app/testing/` holds fixtures and helpers and is excluded by
  `tsconfig.app.json`, so nothing in it (or its dev-only dependencies such as
  `fflate`) reaches the bundle.
- Several specs read `.html`/`.ts` files as text because there is no DOM.
  They strip comments first, so a comment quoting the rule cannot satisfy it.
- Mocks of `ApiService` must stub every lookup getter, because
  `ConnectionManager.loadLookupTables` calls them all during `hydrate()`.

## Back end (`server/`)

`server.ts` is wiring only: CORS, `express.json({ limit: '50mb' })`, the
static Angular bundle, the routers, and the global error handler last.

### Data layer (`server/db/`)

| File | Contents |
| --- | --- |
| `driver.ts` | The only file that imports `node:sqlite`; opens the file and enables foreign keys |
| `sql-api.ts` | The query API routes use (see below) |
| `pool.ts` | `withDb`, single-flight open, retry, generation counter, `withDatabaseOffline` |
| `config.ts` | Database file location and overrides |
| `schema.sql`, `schema.ts` | The schema and its application on open |
| `seed.ts` | Reference-data seeding from `issuers-denominations.json` |
| `backup.ts` | File-level helpers for backup and restore |
| `coin-fields.ts`, `bindings.ts` | Column maps with types, widths and normalisers |
| `bind-values.ts`, `column-types.ts`, `value-normalizers.ts` | Value conversion and range/width checks |
| `collection-status.ts` | Server copy of the status set |
| `errors.ts`, `row-mappers.ts` | Error classification; row → JSON |

**Query API.** Routes call `db.request().input(name, type, value).query(sql)`
and receive `{ recordset, rowsAffected }`. `sql-api.ts` adds checks that
SQLite itself does not make:

- a string with more than one statement is rejected (`node:sqlite` would run
  only the first, silently);
- every `@name` in the SQL must be bound (SQLite would bind NULL);
- all access is serialised through one FIFO lock, because there is a single
  handle and a transaction spans `await`s.

Transactions use `BEGIN IMMEDIATE`, which holds the lock until commit or
rollback; always pair them with `try`/`catch` and `safeRollback()`, which keeps
a failing rollback from masking the original error. `setQueryObserver()`
exposes each statement and its bindings (used by specs that check generated
UPDATEs).

**Only `db/` may hold a SQLite handle**; `db/driver-isolation.spec.ts`
enforces it. If a future host lacks `node:sqlite`, `driver.ts` is the one file
to change (e.g. to `better-sqlite3`).

**Connection lifecycle.** On every open the server creates the folder, applies
the schema (all `IF NOT EXISTS`), seeds reference data, stamps the schema
version and enables WAL. All of it is idempotent, so there is no first-run
branch. `withDb()` is the only entry point for routes; it retries once, and
only for connection-class errors. See [rationale/server.md](rationale/server.md).

### Routes (`server/routes/`)

| Path | Mounted at | Notes |
| --- | --- | --- |
| `health.ts` | `/api/health` | Launcher readiness probe; response shape is a contract |
| `app-info.ts` | `/api/app-info` | The install folder; no database access |
| `coins/` | `/api/coins` | `reads`, `writes`, `write-helpers`, `images`, `image-payload`, `image-source-paths`, `thumbnail`, `list-query`, `catalog-refs` |
| `images/` | `/api/images` | `file`, `exists`, `allowed-types`, `reference-url`; no database access |
| `lookups/` | `/api` | categories, coin sets, issuers, denominations, mint marks, metal contents, catalogs, reference usage, Wikidata denomination lookup |
| `data/` | `/api` | spot prices, settings, frontend log |
| `backup/` | `/api` | backup jobs and restore |
| `support/` | `/api` | problem reports |
| `db-error-response.ts`, `failure-report.ts` | | Error → HTTP status and failure stage |
| `error-handler.ts` | | App-wide handler, mounted last |
| `param-utils.ts` | | Request-parameter helpers |

### Endpoints

| Group | Endpoints |
| --- | --- |
| Health and host | `GET /api/health`, `GET /api/app-info` |
| Coins | `GET /api/coins` (`?includeImages=true` to inline photos), `GET /api/coins/:id`, `POST /api/coins`, `PUT /api/coins/:id`, `DELETE /api/coins/:id` |
| Coin images | `GET /api/coins/:id/images`, `POST /api/coins/:id/images`, `DELETE /api/coins/:id/images/:imageId`, `GET /api/coins/:id/thumbnail`, `POST /api/coins/image-source-paths` |
| Original files | `GET /api/images/file?path=`, `POST /api/images/exists` |
| Lookups | `GET/POST/DELETE /api/categories`, `/api/coin-sets`; `GET/POST/PUT/DELETE /api/issuers`, `/api/denominations`, `/api/mintmarks`, `/api/catalogs`; `GET /api/metalcontents`; `GET /api/reference-usage`; `GET /api/denomination-lookup` |
| Spot prices | `GET /api/spot-prices/latest`, `GET /api/spot-prices/fetch`, `POST /api/spot-prices` |
| Settings and log | `GET/PUT /api/settings/:key`, `POST /api/log` (always 204) |
| Backup and restore | `GET /api/backup/suggestion`, `GET /api/backup/files?directory=`, `POST /api/backup/jobs` (202), `GET /api/backup/jobs/:id`, `POST /api/backup/jobs/:id/cancel`, `POST /api/restore/inspect`, `POST /api/restore` |
| Support | `GET /api/support/config`, `POST /api/support/preview`, `POST /api/support/report` |

Errors from database routes are `{ error, stage, detail }`; see
[how-it-works.md](how-it-works.md#errors-and-failure-stages).

### Other server folders

| Path | Contents |
| --- | --- |
| `backup/` | `jobs`, `run-backup`, `restore`, `inspect`, `verdict`, `metadata`, `names`, `list-db-files` |
| `support/` | `report`, `report-file`, `log-file`, `redaction` |
| `logger.ts`, `log-rotation.ts` | Daily log files under `server/logs/` (override `COIN_LOG_DIR`), 5 MB cap per file, about 14 days kept |
| `process-safety.ts` | `unhandledRejection` / `uncaughtException` handlers that log before exit |
| `test-support/` | `sqlite-test-db`, `vitest-setup`, `real-file-db`, `schema-columns` |

### Server tests

Server specs run against a real in-memory SQLite database built from
`db/schema.sql` and the real seed. `resetTestDatabase()` clears the
user-data tables before each test; `rebuildTestDatabase()` also restores the seeded
reference tables. `vitest-setup.ts` forces `COIN_INVENTORY_DB_PATH=':memory:'`
before every test and fails any test that leaves it pointing elsewhere, so no
test can write to the real collection folder. Backup and restore specs use
`real-file-db.ts` (a real file in a temp directory) and must call
`releaseFileDatabase()`.
