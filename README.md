# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, an admin-managed category system, a Quicken (QIF) import workflow, a batch photo-import workflow that matches whole folders of images to coins by filename, and persistence in SQL Server via a small Express API (the browser's IndexedDB now only holds UI preferences) — all designed around an inventory-first layout where the collection table is the center of the experience.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next — rather than re-discovering the codebase from scratch.

---

## ⚠ Do this after pulling this change

Two steps, in this order. Neither is optional — the app will look broken without them.

**1. Run the outstanding SQL migrations.** `server/setup-database.sql` is the build-from-scratch script and it **DROPS every table**, so it must never be run against a database that has your coins in it. Schema changes to a live database live in `server/migrations/` instead, as small guarded scripts that are safe to run twice. There are now eight. **002 and 003 have already been run on this database; 004 through 008 are outstanding** and must be run in that order:

```powershell
cd C:\Users\BR651094\source\dev
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\004-widen-weight-precision.sql
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\005-drop-coin-tags.sql
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\006-drop-coin-dealer.sql
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\007-infer-coin-metal-data.sql
sqlcmd -S localhost -d CoinInventory -E -i server\migrations\008-weight-to-grams.sql
```

| Script | What it does | Status |
| --- | --- | --- |
| `002-add-image-source-path.sql` | Adds `CoinImages.SourcePath` | already run |
| `003-multiple-images-per-coin.sql` | Deterministic `SortOrder`, new covering index | already run |
| `004-widen-weight-precision.sql` | `Coins.Weight` and `Coins.PmWeightGrams` from `DECIMAL(10,4)` to `DECIMAL(12,5)` | **outstanding** |
| `005-drop-coin-tags.sql` | Drops the `CoinTags` table — the tag feature is gone | **outstanding** |
| `006-drop-coin-dealer.sql` | Drops `IX_Coins_Dealer`, then the `Coins.Dealer` column | **outstanding** |
| `007-infer-coin-metal-data.sql` | Fills in `MetalContent`, `Composition`, `PmWeightGrams` and `PmPercent` from what each row already implies | **outstanding** |
| `008-weight-to-grams.sql` | Converts `Coins.Weight` from troy ounces to **grams**, then derives the gross weights 007 has made derivable | **outstanding** |

**The order is not a suggestion for 008.** It reads `PmWeightGrams` and `PmPercent` to fill in blank gross weights, and 007 is what populates those, so running 008 first leaves most of that work undone. Getting it wrong is recoverable — just run 008 again after 007; it skips the conversion and completes the fill.

Substitute whatever `DB_SERVER` in `server/.env` says for `localhost` (for a named instance that is something like `-S "BRUCE_PC\SQLEXPRESS"`). `-E` means "use my Windows login", which is the easy path; if `server/.env` has `DB_USER`/`DB_PASSWORD` filled in and you would rather use that SQL login, swap `-E` for `-U CoinApp -P <password>`. Each script prints a line saying what it did; 003 prints a summary of the `CoinImages` table, 004 prints the resulting shape of both weight columns, and 006 prints a confirmation that `Coins.Dealer` is gone and `Transactions.Dealer` is untouched. You can equally open any of them in SQL Server Management Studio or Azure Data Studio with the `CoinInventory` database selected and press Execute.

Running any of them twice is harmless — every step is guarded and the second run prints "nothing to do". Three guards are worth knowing about specifically:

- **008 is the one migration that is NOT self-describing, and it is the most dangerous script in the folder.** It changes no column, no index and no type — it rewrites the *values* in `Coins.Weight`, multiplying each by 31.1034768 so that the column means grams instead of troy ounces. Because the column's shape is identical before and after, and because 0.7734 and 24.05582 are both perfectly plausible weights, **nothing in the database can reveal whether it has already run**. And running it twice multiplies twice: a Morgan dollar would go from 24 g to 748 g, which still looks like a number rather than a bug. So 008 records that it ran by writing a marker row into `AppSettings` (`SettingKey = 'migration-008-weight-grams'`), commits that marker in the same transaction as the conversion so it can never lag behind, and skips the conversion entirely if it finds it. It also snapshots the whole column into `Coins_Weight_TroyOz_Backup` first — every row, `NULL`s included — and the file's header gives the two statements that restore from it. **Do not delete the marker** unless you have genuinely restored from that backup.
- **005 refuses to drop `CoinTags` if there is anything in it.** No version of this application could ever create a tag, so rows in that table came from somewhere else — a manual insert, a restored backup, an experiment — and the script will not destroy them unseen. Instead it prints the `SELECT` that shows you what is in there, the `SELECT * INTO CoinTags_Backup` that copies it, and the `DROP TABLE` to run once you are satisfied. Leaving the table in place costs nothing in the meantime; the app does not read or write it at all any more.
- **006 is scoped to the `Coins` table at every step.** `setup-database.sql` declares a `Dealer NVARCHAR(200) NULL` column on *two* tables, and `Transactions.Dealer` is still in active use. Every statement in 006 names `Coins` explicitly and every catalog lookup is scoped with `OBJECT_ID('Coins')`, because a bare search for a column called "Dealer" would hit both and silently delete a working feature.

**2. Restart the app.** The API server caches query plans, and these migrations change the columns and indexes those plans were built against. Close the launcher window and start it again.

If you skip 004, the fifth decimal place the coin editor shows for Weight and PM Weight is silently rounded away on save. 005 and 006 are cleanup — the application has already stopped using both the tags table and the coin-level dealer column, so nothing breaks if you delay them, but the database will keep an unused table and an unused column until you run them.

**If you skip 008, the application actively lies.** The coin editor, the inventory grid and the CSV export have all been relabelled to say grams, but the numbers in the column are still troy ounces until the script runs — so every weight on screen reads as about a thirty-first of what it really is, with nothing to indicate it. This is the one outstanding migration whose absence is worse than cosmetic.

## Current state (as of 2026-10-03)

The application is functioning end-to-end. An earlier round of work was a large refactor driven by a real production crash. The round after that was about photos: many photos per coin, knowing where each original file lives, and importing a 4.2 GB folder of them without killing the browser tab. The COMEX spot-price fetch was also found to be silently dead and was replaced.

**The most recent round was about the data being right and the forms being usable**, and it turned up one genuinely serious arithmetic bug along the way. In rough order of how much they mattered:

- **Every melt value in the app was understated** — about 10% on US 90% gold and silver, and 60% on a 40% silver Kennedy half. `computeMeltValue` applied purity a second time to a figure that was already the pure-metal weight. See "Spot prices and melt value".
- **Three reference weights in `pm-reference.ts` were simply factually wrong**, including a 1965-70 Kennedy half recorded as holding twice the silver it does.
- **Four input bugs in the coin editor**, each of which made a field either unusable or lossy: numeric boxes that reformatted while you typed, an "Other" box that destroyed itself on the first keystroke, a denomination dropdown showing country headings with nothing under them, and a Settings dialog that rendered inline with no backdrop.
- **Coin sets were never saved.** Add one, reload, it was gone.
- **QIF import now works out what a coin is made of** from year + type + denomination, and the "import anyway" override that produced unsaveable coins was removed.
- **CSV import now applies the same 2-of-3 completeness rule as QIF import.**
- **Two fields were retired**: `tags` (which never had any way to enter one) and the coin-level `dealer` (redundant with `Transactions.Dealer`).

**The crash and its fix.** The symptom was: edit a coin after a pause, get "Failed to update coin", refresh the browser and it still fails, and only restarting the whole app recovers. The database was fine — the *backend process was dying*. `server/db.ts` created an mssql `ConnectionPool` but never attached an `'error'` listener to it. `ConnectionPool` extends Node's `EventEmitter`, and an `EventEmitter` with zero `'error'` listeners **throws when `'error'` is emitted**. That throw happened inside a tedious socket callback where nothing could catch it, so it became an uncaught exception and killed the Express process. Nothing appeared in `app.log` because the process died before any logging ran.

The fix is a `pool.on('error', ...)` listener attached *before* `connect()` is called, in `server/db/pool.ts`. Three contributing factors were fixed alongside it:

- Every `catch` in `routes/coins.ts` called `resetPool()`, so an ordinary validation error (a too-long string, a constraint violation) destroyed the shared pool and broke every other request in flight. Route handlers are now forbidden from calling `resetPool()`; they go through `withDb()`, which retries exactly once and only for connection-class errors.
- There was no single-flight guard on connect. The Angular app fires roughly seven API calls in parallel on load, and each one saw "no pool" and opened a competing one. Concurrent callers now share one connect attempt, and a generation counter stops a late failure from tearing down a pool that was created after it.
- A per-request `SELECT 1` health check could close the pool while other requests were still using it. It is gone.

**Parameter types were wrong too.** Several mssql bindings did not match `server/setup-database.sql`, which silently truncates data when the parameter is shorter than the column and raises SQL error 8152 when it is longer. `Year` was bound as `NVarChar(10)` against an `NVARCHAR(50)` column, the coin-level `Dealer` at 255 against a 200-char column (that column has since been removed entirely — see the coin data model below), and `PurchaseDate`/`SoldDate` as `sql.Date` against `NVARCHAR(30)` text columns. `server/db/coin-fields.ts` is now the single source of truth for the Coins table and `server/db/bindings.ts` for every other table, and `server/db/coin-fields.spec.ts` checks them against the SQL script.

**Crashes are now visible.** `server/process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load, so a fatal error lands in `server/logs/app.log` instead of ending the process silently.

**The page-level scrollbar is gone.** `src/styles.scss` — the global stylesheet, the only one that is *not* scoped to a component — was completely empty. With no reset in it, the browser's default `body { margin: 8px }` was still in effect, and combined with an app root asking for a full `100vh` the document came out 100vh + 16px tall. The whole window therefore scrolled by a sliver no matter what the app did internally. `styles.scss` now zeroes the body margin and sets `overflow: hidden`, because this is a fixed-height single-screen application that manages its own scrolling inside the table and the detail panel. Anything that overflows the window is a layout bug and should be visible as clipping rather than hidden behind a page scrollbar.

The status bar was part of the same problem and changed at the same time — see the SCSS section below.

**Spot prices were silently broken.** See "Spot prices and melt value". The short version: the free API the app called had been discontinued, and because the route answers 200 with zeroed prices on failure, nothing ever surfaced an error — the prices just sat at $0 forever.

The regression suite is passing: **836 frontend tests across 41 files** and **154 server tests across 16 files**.

## Architecture

### Layout philosophy: inventory first

The UI is organized around the principle that the inventory table *is* the application. Import workflows, category management, and other administrative functions live in modal dialogs — accessible from the toolbar but never dominating the main view. The layout is:

1. **Header** — title and the toolbar
2. **Toolbar** — action buttons (Add Coin, Import, Export, Settings)
3. **Filter bar** — search, category filter, and a collapsible advanced panel for grade, value range, source, country, coin set
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

**`CoinEditorForm` has two helper modules sitting beside it**, both plain classes/functions with no Angular injection. The reason is always the same in this project: `CoinEditorForm` takes a required signal `input()`, which means constructing it needs `TestBed` and a DOM, and this test suite runs under plain Node. Anything worth testing therefore has to be liftable out of the component.

| File | What it owns |
| --- | --- |
| `coin-editor-form/custom-option-mode.ts` | "The user picked **Other**" as a piece of state, independent of the field's value — see "The 'Other' boxes" below |
| `coin-editor-form/denomination-countries.ts` | Which `<optgroup>` headings the denomination dropdown shows, derived from the data rather than hard-coded |

### Directives (`src/app/directives/`)

One directive, and it exists to fix a bug rather than to add a feature.

| File | What it is |
| --- | --- |
| `numeric-field.ts` | `NumericField` — the `appNumericField` directive, applied to every number box in the coin editor |
| `numeric-field-format.ts` | `formatNumericValue` / `parseNumericInput` — the pure parse/format pair, kept separate so it is testable without a DOM |

See "Typing in a number box" under Features for the failure it fixes and the one rule that must not be broken.

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
| `_controls.scss` | Buttons, badges, file pickers, the box-sizing reset — and `.eyebrow`, which is now effectively dead; see below |
| `_panel.scss` | The white rounded card shared by the inventory table and the detail sidebar |
| `_field.scss` | `.detail-field` — a small caption sitting directly above its control |
| `_modal.scss` | Shared modal backdrop and chrome |

`app.scss` uses `base` and `layout`, plus the status bar and the database error banner. Each component imports whichever of `controls`, `panel`, `field` and `modal` it needs via `@use`.

**`.eyebrow` is worth a note, because it is now a rule with no reachable markup.** The small uppercase caption above a heading used to appear in two places: the app header in `app.html`, and the detail panel's "Selected coin" header. The detail panel header was stripped when the redundant heading and badge rows were removed (see "Coin editor layout" below), so the only `.eyebrow` left in any template is `<p class="eyebrow">Numismatic portfolio</p>` in `app.html` — and `app.scss` does not `@use 'styles/controls'`, so that element is rendering unstyled. It is listed under "Known gaps" rather than quietly deleted, because the fix is a judgement call (either drop the rule or add the one-line `@use`) and the owner should make it.

`styles/_field.scss` is unaffected by any of this and is still shared by two components.

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
| `coin-completeness.ts` | The 2-of-3 completeness rule, shared by **all three** coin-creating paths: QIF import, CSV import and the manual "Add coin" path |
| `coin-countries.ts` | Reading a country and a foreign denomination out of a Quicken security name |
| `image-source-paths.ts` | `ImageSourcePathRegistry` — the side table mapping a displayed image to its original file's path |
| `pm-reference.ts` | "What is this coin made of?" — the composition table behind both melt values and the QIF importer's alloy prefill |
| `http-utils.ts` | `resolveApiBaseUrl` / `describeHttpError`, dependency-free so `LoggingService` can use them without dragging `HttpClient` into the test module graph |

Note that `coin-completeness.ts`, `coin-countries.ts`, `image-source-paths.ts`, `pm-reference.ts` and `http-utils.ts` are plain modules, not `@Injectable` services. `ImageSourcePathRegistry` in particular is deliberately *not* injectable: `InventoryService` has to stay constructible from an injection context providing only `ApiService`, `LoggingService` and `NotificationService`, which is how every existing test builds it, and a fourth injected dependency would break all of them. The class has no dependencies of its own, so a module-level singleton gives the same shared-instance guarantee with none of the wiring.

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
| `server/routes/app-info.ts` | `GET /api/app-info` — one host-local fact the browser cannot know; see below |
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

`routes/app-info.ts` is the other router that never touches the database, and it exists for one small job. The batch image import screen has to ask the user for the absolute folder their photos live in, because the browser refuses to tell it (see "The base-folder input"). Starting that box empty is unhelpful, and the old prefill was worse: it hard-coded `\\192.168.0.10\Coin Pictures`, which is how the library is reachable from the *developer's* workstation, not from the machine hosting the app. A path valid on the wrong machine is the single most expensive mistake that screen can make, because it does not fail loudly — it stamps every imported row with a location that resolves to nothing. So the prefill is now something only the server can know and that is guaranteed to be host-local: the folder the app itself is installed in. It is very probably not where the photos are, and the screen says so — but it is the right shape, on the right machine, with the right drive letter, and the user edits it down from there. Once they do, the choice is remembered and this endpoint's answer is never consulted again. Deliberately independent of SQL Server, too: the import screen must open even when the database is down, and a cosmetic default is never worth failing a page load over.

`routes/error-handler.ts` also fixes a real bug. It used to be four lines ending in an unconditional `res.status(500).json({ error: 'Internal server error' })`, which threw away information the error was already carrying. `express.json()` is configured with `limit: '50mb'`, and when a request body exceeds it, body-parser rejects the request with a `PayloadTooLargeError` that already has `status: 413` set on it. During a batch photo import that mattered: the real problem is "that batch of images is too big, send fewer at a time", which the user can act on, but what they saw was a generic server error suggesting the server itself was broken.

## Features

### Inventory management

- Inventory table with photo thumbnails, color-coded grade badges (mint/proof green, circulated blue, worn gold, ungraded gray), certification badges (purple), and CAC green bean accent icons
- Free-text search across name, denomination, type, country, grade, certification, variety, mint mark, notes, and coin set
- Category filter, coin set filter, and sortable column headers (click to sort, click again to reverse)
- Advanced filters: grade prefix, value range (min/max), source, country, coin set
- Collapsible column visibility picker (show/hide any tracked field)
- Sticky detail sidebar for the selected coin with inline editing of all fields
- Add / delete coins directly from the toolbar
- Export the full inventory as downloadable JSON, and re-import a previously exported file
- Selected row gets a left-border accent treatment for clear visual feedback

**Column order lives in exactly one place**, `inventoryColumnOrder` in `src/app/types/inventory-columns.ts`, and it must stay the only place it is written down. Two things read it: the "Columns" tick-box panel lists its options in that order, and `InventoryColumnsStore` sorts the visible column list into that order, which is what the table's `<th>`/`<td>` sequence follows. Re-ordering the template instead would make the two disagree, and you would end up with a tick-box panel whose order does not match the grid.

Two changes to that array:

- **Cert now sits immediately before Grade** (owner request). It used to sit between Variety and the since-removed Dealer column. The slab's certification and the grade printed on that slab are one idea, so they read as a pair. Despite the column's key being `certNumber`, the cell renders a badge built from the company *and* the number — "PCGS #12345678" — falling back to just the company when no number is recorded.
- **The `tags` and `dealer` columns are gone**, each with a comment in the array saying so and why, so the removals are not quietly re-added.

**Choosing which photo the grid shows.** The Photo column renders `coin.imagePaths[0]`, and the image gallery now has a **"Set as main"** button per photo that moves the chosen one to the front of that array.

This needed no migration and no new column, which is the point worth recording. The data model already answers the question: every `CoinImages` row carries a `SortOrder`, `GET /api/coins/:id/images` returns them `ORDER BY SortOrder`, and the grid thumbnail is the first image in that list — so "this photo is the main one" is already expressible as "this photo is at `SortOrder` 0". The information has nowhere else it could live, so there is no second place for it to disagree with itself. Adding an `IsPrimary` flag instead would have meant a schema migration, a new invariant ("exactly one row per coin has it set") that nothing enforces, and a fresh way for the gallery order and the grid thumbnail to drift apart. A pleasant side effect of doing it by re-ordering: the gallery and the full-screen viewer list photos in the same order, so the main photo is also the first one you see when you open the viewer.

Two guards in `CoinImagesStore.setMainImage`:

- If the image is unknown or already at position 0 it does **nothing**. That is important rather than merely tidy — `PUT /api/coins/:id` replaces a coin's whole image set, so a no-op PUT would still delete and re-insert every image row on the server for no reason.
- It goes through `inv.updateCoin({ imagePaths })` and must **never** call the API directly. The PUT re-inserts whatever array it is given, and an entry sent as a bare string comes back with `SourcePath NULL` — so a naive re-order would silently erase the recorded original-file location of every photo on the coin. `CoinEditor.withSourcePaths()` re-attaches the known paths on the way out. The single funnel *is* the protection. See "Where each photo came from".

The detail entry fields no longer carry placeholder/watermark text — `coin-editor-form.html` has zero `placeholder` attributes in it now. Every field has a real caption above it instead, which is what `_field.scss` is for. Placeholder-as-label reads fine until you start typing, at which point the only thing telling you what the box was for disappears — and some screen readers skip it entirely.

The Cert Company input was widened at the same time, because at its old width it clipped the final letter of "ANACS". It used to carry an inline `width: 7.5ch`; the rule now lives in `.detail-field--cert-company` in `coin-editor-form.scss` at `12ch`. Two things made `7.5ch` too narrow: `ch` is the width of the digit "0", but grader names are uppercase letters, which are wider; and the global `box-sizing: border-box` meant that width had to cover the input's 7px horizontal padding and 1px border on each side as well as the text.

### Coin editor layout

The form was rearranged so that the fields you read together sit together.

- **Row 1 is the coin's identity**: Year, Coin Type, Denomination, Mint mark. Coin Type moved up here from the Grade row because it is the field people read first. To make room, Denomination and Mint mark were narrowed and the sidebar was widened — `minmax(0, 1fr) 420px` instead of `360px`, in `styles/_layout.scss`. The four column widths are set once on `.detail-editor__row--top` in `coin-editor-form.scss` rather than as four per-field `max-width`s, so they are one decision instead of four that have to be kept in step.
- **Certification company moved onto the Grade line**, in front of the grade, because the two are read as one phrase: "PCGS MS64". The certification *number* deliberately stayed down with the other reference data further below — it is a long opaque string that nobody reads at a glance.
- **The detail panel header is now nothing but the action buttons** (Show images / Close / Delete). The eyebrow, the `<h2>` repeating coin type and denomination, and the row of grade/cert/CAC badges were all removed as redundant — see the CAC section for the reasoning.

### Typing in a number box

**The bug.** Every numeric input in the editor was wired like this:

```html
[ngModel]="formatMoneyInput(coin().purchasePrice)"
(ngModelChange)="updateSelectedCoin('purchasePrice', parseMoneyInput($event))"
```

Read the round trip carefully, because the failure is not obvious. You type `1`; `ngModelChange` fires and the coin is updated; the coin signal changes, so `[ngModel]` is re-evaluated; `formatMoneyInput(1)` returns `"$1.00"`, which is *not* the text you typed; `ngModel` writes that back into the box, and the browser parks the caret at the end of the replaced text. After one keystroke you are stranded after the decimals and can only append digits there. The owner's description was exact: the fields "allow a numeral to be entered but then automatically format and force the user to enter numerals at the end of the decimal places."

**Why one directive and not five fixes.** The bug is not in any one field, it is in the *binding shape*, and that shape had been copy-pasted onto every numeric input. Fixing them one at a time would leave the next numeric field someone adds broken again, because the obvious thing to copy would still be the broken pattern. A directive was chosen over a wrapper component because it keeps the `<input>` in the template (so the `.detail-field` label/grid CSS keeps working untouched), it does not introduce an element that would have to be taught about `maxlength`, `inputmode`, `aria-label`, `disabled` and the rest, and because the thing being fixed — focus, blur, caret — *is* element behaviour, which is what directives are for.

**The rule that must not be broken:** while the input has focus, **nothing writes to `element.value`**. That single rule is what keeps the caret still. There is deliberately exactly one assignment to `element.value` in `numeric-field.ts`, with exactly two callers, both of which only run when the field is not focused. Note also that the directive does **not** use `ngModel` at all — `ngModel`'s own model-to-view write is half of the original problem — so it drives the input directly.

Two smaller decisions inside it are load-bearing:

- The effect reads *every* input signal before the focus guard. An Angular effect only tracks the signals it actually read on its last run, so bailing out early would quietly unsubscribe it from `value`, and the box would stop updating when you selected a different coin.
- The directive emits on `input` and **never on blur**. The coin editor sends a one-field PUT per emit, and a blur-triggered emit would write a field the user never touched. Widening the save payload is a class of bug this project has been bitten by before.

The fields using it, and at what precision:

| Field | Decimals | Prefix | Thousands separators |
| --- | --- | --- | --- |
| Weight (g) | 5 | — | no |
| PM Weight (g) | 5 | — | no |
| PM % | 2 | — | no |
| Purchase Price | 2 | `$` | yes |
| Current Value | 2 | `$` | yes |

The five decimals on the two weight fields are what migration 004 exists to support — the columns were `DECIMAL(10,4)` and silently rounded the fifth digit away on save, so the form was promising precision the database would not keep.

**Why Weight kept five decimals when it moved to grams.** Grams are a coarser unit than troy ounces — one gram is about 1/31st of an ounce — so the obvious move when migration 008 changed the unit was to trim the editor to three or four places. It was kept at five for three reasons. Its sibling `PM Weight (g)` shows five, and two gram figures sitting next to each other at different precisions read as different kinds of number rather than as two measurements you can divide into one another. The column behind it is `DECIMAL(12,5)`, which is exactly what migration 004 widened it to so the form would stop promising precision the database would not keep — trimming the form now would re-open that gap from the other side. And the planned troy-ounce readout (see "Planned next steps") wants five ounce decimals, one step of which is 0.000311 g: a gram value rounded to three places cannot reproduce that fifth ounce digit, so trimming would cost precision that is about to be wanted back. The **inventory grid** is a different question and did go down, from four decimals to three, matching the `PM Weight (g)` column beside it — in a dense scanning view a tenth of a milligram is noise.

Parsing is **not** reimplemented here. `parseNumericInput` delegates to `parseNumericCell` from `src/app/services/csv/numeric-cell.ts`, the same parser CSV import uses, so `$1,250`, `26.73 g` and `1/10` behave in the editor exactly as they do on import. (Note the trap that comes with the unit change: the parser reads the number and discards whatever unit follows it, so typing `0.7734 ozt` into the gram Weight box records 0.7734 **grams**. The parser was deliberately left unit-blind — it is shared with the three money fields, and making a cell's meaning depend on text the parser is otherwise designed to throw away would be worse.) Duplicating it would mean two parsers that drift apart. It does add one thing on top: an empty box parses to `null`, not `0`, because "the user selected all, pressed delete, and is about to type a new number" must not look the same as a deliberate zero — otherwise the box fights the user by snapping back to `0.00` mid-edit.

### The "Other" boxes on Denomination and Mint mark

**The bug: you could type exactly one character.** Both fields are `<select>`s with a trailing "Other" option that is supposed to reveal a free-text box. That was implemented by storing a sentinel string *in the coin field itself*:

```html
<option value="__OTHER__">Other</option>
...
@if (coin().denomination === '__OTHER__') { <input ... /> }
```

The value was being used to remember a UI choice, and that breaks in three separate ways:

- **Typing.** The first character you type replaces the denomination with that character. `'__OTHER__'` is gone, the `@if` is now false, and the box you are typing into is destroyed mid-keystroke. The owner's report was "only one letter/number can be typed and then the box goes away".
- **Reloading.** A saved custom denomination such as "Trade Dollar" is a real value, not the sentinel, so the `@if` is false and the box never reopens. The coin comes back looking as though it has no denomination at all.
- **Saving.** Pick Other, click away without typing, and the literal string `__OTHER__` is written to the database as the coin's denomination.

**The fix** is in `src/app/components/coin-editor-form/custom-option-mode.ts`: "this field is in custom mode" becomes its own boolean signal, completely independent of the field's value. The sentinel survives only as the `<option>`'s value attribute — a token the `<select>` needs so it has something to report when Other is clicked — and is translated away the instant it reaches the component. `stripCustomSentinel()` is a last line of defence so it can never be persisted even by a future careless call. The free-text box is then bound straight to the coin field like any other text input, and typing cannot close it because typing does not touch the signal.

**The subtle part is when custom mode may be re-derived.** On load you want to infer it from the value ("this denomination is not one of the options, so it must be custom"). The tempting implementation is a `computed()` or an unguarded `effect()` over the coin signal. Do not: the coin signal changes identity on *every* field edit, so that derivation would re-run while the user is typing, and the moment they typed something matching a real option — `$1`, say — custom mode would flip to false and the box would vanish under their hands. That is the original bug wearing a different hat. So `syncForCoin()` is guarded by the coin id and runs once per coin, when a *different* coin is loaded. A second guard covers an empty option list: that means the lookup tables have not come back from the server yet, and deriving then would decide every non-blank value is custom.

One `CustomOptionMode` instance per field rather than two bespoke pairs of signals, so Denomination and Mint mark cannot drift apart — the bug was reported for Denomination but was identical for Mint mark.

Mint mark's option reads "Other…" with an ellipsis rather than "Other", because the mint mark lookup table contains a genuine mint mark whose label is literally "Other" (the catch-all for oddities like O/S). The ellipsis is what distinguishes "type your own" from that real code.

### The denomination dropdown's country headings

**The bug: the dropdown showed country headings with nothing under them.** The template looped a hard-coded `['US', 'GB']` and, inside each group, filtered the denominations down to those whose `country` matched. The Settings dialog had been stamping every denomination with `country: 'United States'`, which matches neither `'US'` nor `'GB'`, so both groups emptied out and all that was left was two labels. The owner reported it as the dropdown "doesn't list anything but the countries".

The mirror-image failure was live too: the Categories & Sets dialog offers `'CA'` when adding a denomination, and `'CA'` was not in the hard-coded pair, so such a denomination could be created and then never appear anywhere.

`denominationCountriesOf()` in `src/app/components/coin-editor-form/denomination-countries.ts` derives the headings from the data instead, which makes both failures impossible by construction: a group exists if and only if some active denomination belongs to it, so there can never be an empty heading and never an entry with no heading to live under. Inactive denominations are excluded because the template does not render them either — counting them would be the empty-heading bug all over again. Blank countries are dropped rather than becoming a nameless group (a denomination with no country is then unreachable from this dropdown, which is a real if unlikely gap, but an untitled `<optgroup>` would be a worse answer). US sorts first because this is overwhelmingly a US collection; everything else follows alphabetically.

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
- Per-coin melt value calculation from the coin's **pure** precious-metal weight (`pmWeightGrams`) and the spot price for its metal
- Shown in the grid's **Melt Value** column and in a valuation line at the top of the detail panel, next to the coin's Current Value
- Prices **persist across restarts** and a live fetch runs **once, automatically, after start-up finishes**

**Where the prices live, and the one trap in saving them.** `POST /api/spot-prices` is an INSERT into a price *history* table — it writes a new row every single time it is called. The price boxes in the modal are bound with `(ngModelChange)`, which fires per keystroke, so saving from the price setter would have written one row per character typed. The design that avoids that:

| Method | What it does | Called from |
| --- | --- | --- |
| `InventoryService.updateSpotPrices()` | In-memory only. Every melt figure on screen recalculates instantly. | Every keystroke, freely |
| `InventoryService.commitSpotPrices(source)` | Writes **one** history row | Deliberate actions only: a successful fetch, and closing the modal after hand-edits |

`commitSpotPrices` additionally refuses a save whose four numbers match the row already on disk, and refuses an all-zero set.

At start-up, `ConnectionManager.hydrate()` reads the newest saved row via `GET /api/spot-prices/latest` as part of its non-fatal `Promise.allSettled` lookup phase, so a dead price lookup can never stop the app from starting; a failure leaves the defaults and warns. Once hydration has resolved, `App` fires `InventoryService.autoRefreshSpotPrices()` **without awaiting it** — the saved prices are already applied, so melt is never blank while the network is in play, and a failed fetch changes nothing. That path deliberately bypasses `SpotPriceService` and talks to `ApiService` directly, because `SpotPriceService` reports failure with a **sticky** error toast, which is right for a button the user pressed and wrong for something that happens by itself on every launch.

**A zero is not a price — it is the absence of one.** No metal trades at zero, so throughout the app a `0` is handled exactly as a `null` would be: a zeroed fetch result is a failed fetch and is never applied, an all-zero set is never POSTed, an all-zero row read back from the database is ignored rather than believed, and `computeMeltValue` returns `null` (rendered `—`, never `$0.00`) for any metal whose price is `<= 0`. Partial data is fine and common — the four symbols are fetched independently upstream — so a set with a real gold price and a zero platinum price is perfectly good, and platinum simply has no price in it.

**Telling the two kinds of em-dash apart.** A melt cell reading `—` because nobody has ever fetched prices is two clicks from being fixed; one reading `—` because the coin is base metal is not fixable at all. `InventoryService.meltValueHint(coin)` produces a tooltip that says which, naming the field that is actually missing (**PM Weight (g)**, not the gross **Weight (g)** field, which melt does not use), and the spot price modal shows a note while no prices have been loaded.

**How melt value is actually computed, because the obvious guess is wrong.** The whole sum is:

```
(pmWeightGrams / 31.1035) * spotPricePerTroyOunce
```

That is it. Purity does **not** appear, and the coin's gross `weight` does not appear either. The two weight fields on a coin measure different things in different units and confusing them is exactly the bug described below:

| Field | What it holds | Unit |
| --- | --- | --- |
| `weight` | the coin's **gross** weight | grams |
| `pmWeightGrams` | the weight of the **pure precious metal** in it | grams |

**Both are grams now, and that is a recent change.** `weight` held **troy ounces** until `server/migrations/008-weight-to-grams.sql` multiplied every stored value by 31.1034768. The owner had been reading the field as grams all along; when the contradiction with the schema comment ("Gross weight in troy ounces") was put to him he chose to move the column rather than correct his reading, so that the two fields can be compared and divided without a conversion in the reader's head. Note that they still measure **different things** — a whole coin versus the pure metal inside it — so sharing a unit removes one of the two ways to confuse them, not both. The decisive one is that **melt value uses `pmWeightGrams` and nothing else**, which was as true before the unit change as after it: the conversion touched no input to `computeMeltValue`, so every melt value in the app reads identically either side of migration 008.

`pm-reference.ts` states this outright and gives the worked example: a 1927 $20 Saint-Gaudens weighs 33.436 g and is 90% gold, so its `pmWeightGrams` is 30.09 — which *is* the 0.9675 oz AGW the trade quotes. The purity has already been applied in getting to that number.

**The bug: every melt value in the app was understated.** `computeMeltValue` used to end with

```
(pmWeight / GRAMS_PER_TROY_OZ) * (pmPct / 100) * spotPerOz
```

— discounting by purity a second time. 30.09 g × 0.90 again gives 0.871 oz for a coin that holds 0.9675 oz. The error is exactly the purity factor, so it was **about 10% low on US 90% gold and silver and about 60% low on a 40% silver Kennedy half**. Nothing about the output looked wrong; it was a plausible number that was simply too small, which is the worst kind of arithmetic bug. The fix is in `src/app/services/inventory/inventory-metrics.ts` and the reasoning is written into the function's header so it cannot be "corrected" back.

A second, smaller change came with it: **`pmPercent` is no longer required for a melt value to be produced.** It is not an input to the arithmetic any more, so demanding it would refuse an answer for a coin whose pure weight and metal are both known — a .999 bullion round recorded without a percentage, say. `pmPercent` stays on the record because it is genuinely useful information (it is what "90% Silver" means, and it is how `pmWeightGrams` was derived in the first place) — it just must not appear in this calculation.

**Three reference weights in `pm-reference.ts` were factually wrong** and were corrected at the same time. These were data errors, not code errors, and they produced wrong melt values on top of the wrong formula:

| Entry | Was | Is | Why |
| --- | --- | --- | --- |
| US `50¢`, 1965-1970 (Kennedy half) | 9.20 g of silver | **4.60 g** | The 40% silver clad half weighs 11.50 g gross; 11.50 × 0.40 = 4.60 g = 0.1479 oz ASW. The old figure was the number you get by forgetting that it is 40% and not 80% |
| GB `Shilling`, 1920-1946 | the sterling pure weight | **2.83 g** | The 50% entries had been given the 92.5% sterling figures. Gross weight was unchanged across 1920 — only the fineness moved — so the correct pure weight is gross × 0.50: 5.66 × 0.50 |
| GB `Florin`, 1920-1946 | the sterling pure weight | **5.66 g** | Same mistake, same correction: 11.31 × 0.50 |

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

**One thing to know before you go looking for the number on screen: nothing currently displays it.** `InventoryService.meltValue(coin)` is correct and tested, but it has no caller in any template. The inventory grid *has* a "Melt Value" column, and its formatter in `src/app/types/inventory-columns.ts` is still a stub carrying a `TODO` — it returns an em-dash for every coin, whether or not the coin has a pure weight and a metal. So the arithmetic described above is right, and the fix above is real, but the result is not yet reachable from the UI. This is recorded under "Known gaps" as the next obvious thing to finish.

### Category and coin set administration (modal)

- Add or remove category names from the managed list
- Add or remove named coin sets
- Quicken-imported coins default their category to the Quicken account name
- Removing a category does not touch coins already assigned to it

**Coin sets were never actually saved, and the old comment in the code defended it.** `addCoinSet` / `removeCoinSet` in `src/app/services/inventory/lookup-manager.ts` only updated a signal. The comment claimed the omission was deliberate — "a coin set exists because some coin references it, so it is saved as part of the coin, not as its own row" — and that reasoning does not survive contact with the rest of the system:

- there **is** a `CoinSets` table, with `GET`/`POST`/`DELETE /api/coin-sets` routes behind `ApiService.getCoinSets` / `createCoinSet` / `deleteCoinSet`;
- hydration already **reads** from it (`ConnectionManager.hydrate` calls `getCoinSets` and only falls back to deriving the list from the coins when that call fails); and
- the UI offers "Add set" with no coin attached, which under a derive-from-coins model cannot persist at all.

So the write path was the only half missing. The user would add a set, watch it appear, reload, and find it gone — because the next hydration replaced the local list with the database's, which had never been told. An empty set created ahead of filing coins into it vanished every single time. Both methods now mirror the category pattern exactly: update the signal immediately so the UI stays responsive, then persist in the background and report a failure rather than silently diverging from the database. `addCoinSet` returns early on a name it already has, which also stops a duplicate POST the backend would reject as a primary-key clash. `coin-set-persistence.spec.ts` pins it.

### Settings dialog

The Settings dialog now owns the reference lists, and three things changed about it today.

**It added a Sets / Albums list**, the same type-and-Add shape as the four lists already there, with clickable chips to remove. These are the values offered by the "Set / Album" picker in the coin detail panel. They were previously only editable from the Categories & Sets dialog, and changes there did not survive a reload — see the coin-set persistence note above. Both halves of that are now fixed.

**The five bulk-edit `<textarea>`s were deleted** — one per reference list (categories, denominations, mint marks, metal content, and the newly added sets/albums). Each let you edit a whole list as lines of text and re-save it. They read as a power-user convenience and were in fact lossy: a reference record is not a string. A denomination row carries a `denominationId`, a `country` and an `isActive` flag as well as its label; a mint mark carries an id and a description. Rebuilding one of those from a line of text means inventing values for everything the line does not carry — which is exactly how every denomination ended up stamped `country: 'United States'`, which is in turn what emptied the coin editor's country-grouped dropdown (see "The denomination dropdown's country headings"). One bulk-edit box therefore broke a dropdown two components away, silently, and the connection was not obvious from either end. Add-one and remove-one cannot do that: they only ever create a record with real values or delete a record by its real id.

A secondary benefit: the textareas were the subject of a long-standing accessibility defect. Each shared a `<label>` with an `<input>` that came first, and HTML labels only the *first* labelable descendant, so the textareas were unnamed. Deleting them removed the defect along with the feature. Each of the five remaining inputs sits inside its own `<label>` with a caption `<span>`, and the Sets / Albums one additionally carries an explicit `aria-label`.

**The dialog now imports the shared modal styles and has a distinct focus border.** It has always used the `.modal-backdrop` / `.modal` / `.modal-header` class names, but nothing ever supplied their styles: the markup originally lived in `app.html`, and `app.scss` never imported `styles/_modal.scss`. When the dialog was extracted into a component the omission was carried across intentionally so the refactor would change nothing visually, and a comment recorded that as a deliberate choice.

The consequence was not cosmetic. With no `.modal-backdrop` rule the dialog had no fixed positioning, no dimmed overlay and no card chrome at all — it rendered inline in the page, so nothing told the user they had moved into a separate window. That is what the owner reported. `settings-modal.scss` now has the `@use`, plus a deliberately emphatic focused-window treatment on top of it: a darker-than-default overlay (this is the one modal that edits app-wide reference data rather than a single coin, so pushing the page further back is warranted), and a solid 2px edge in the app's primary accent brown. The chips were restyled more compactly at the same time.

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

Each `CoinRecord` tracks: denomination, year, coin type, category, country, grade, certification company, certification number, variety, mint mark, composition, purchase date, purchase price, current value, sold price, sold date, coin set, metal content, gross weight in grams, precious-metal weight in grams, precious-metal purity percent, free-text notes, image paths, a `source` marker (`manual` / `quicken` / `csv` / `import`), and `hasCacSticker`.

**`weight` used to be in troy ounces.** It is the coin's gross weight — the whole coin, alloy included — and it was the one field in the model measured in a different unit from everything around it. `server/migrations/008-weight-to-grams.sql` converted the stored data (× 31.1034768) and the label now says `Weight (g)` everywhere it appears: the editor, the grid, the CSV export and the blank template. Nothing about the *type* changed, only the meaning, which is why the migration has to carry an `AppSettings` marker row rather than inspect the schema — see "Do this after pulling this change". `pmWeightGrams` was already grams and was not touched.

There was also a `tags: string[]` field, backed by a `CoinTags` table and a Tags column in the grid. It was removed. The reason is worth recording, because the shape of the mistake is easy to repeat: tags were plumbed through every layer *except* any way to enter one. The table existed, the API read and wrote it, search looked inside it and the grid had a formatter for it — but the editor had no input, bulk edit did not offer the field, and neither importer could set one, so every code path that created a coin hard-coded an empty list. The column could only ever show a dash. Rather than build the missing UI, the concept was dropped. Older JSON exports still contain the key; importing one of those still works. The mechanism is worth spelling out because it is easy to break by accident: `normalizeImportedCoins` in `services/inventory/coin-factory.ts` spreads whatever keys the file happened to contain and then overwrites the handful it cares about, so a stray `tags` key simply rides along as an inert extra property — TypeScript never sees it (the value arrives as parsed JSON at runtime, not as a checked literal), nothing reads it, and no validation step rejects unknown keys. What *would* break it is rebuilding the object from an explicit field list **and** adding a schema check that rejects unknown keys. If that ever happens, make `tags` an explicitly ignored key rather than an error — importing an old backup must not fail. `coin-factory.spec.ts` pins it. Existing databases are cleaned up by `server/migrations/005-drop-coin-tags.sql`.

There was also a `dealer?: string` field — who the coin came from — backed by a `Coins.Dealer` column, an editor input, a Dealer grid column, a "Search dealers" box in the advanced filter panel, a bulk-edit option and a Dealer column in the CSV import/export. It was removed at the owner's request. Unlike tags it was a real, working field; it was simply redundant. The same information is already recorded per event on the **transaction** rows, and recorded better: a coin-level string can only say "this coin is associated with Heritage", while a transaction says "the purchase on 2024-01-15, for $150, was with Heritage" — and can say something different about the sale two years later. **Transactions keep their own `dealer` field; only the coin-level one is gone.** Older CSV and JSON exports still contain a Dealer column; importing one still works, the column simply has nothing to map onto and is ignored. Existing databases are cleaned up by `server/migrations/006-drop-coin-dealer.sql`, which must drop `IX_Coins_Dealer` before it can drop the column.

`imagePaths` is still a `string[]` of `data:` URLs, deliberately. Widening it to an array of objects was considered and rejected: it is bound directly to `<img [src]>` in four places (the gallery, the photo viewer, the table thumbnail, the report) and it is one of the fields the change tracker diffs, and a mistake in the change-tracking path is how the user previously lost data. The original file paths therefore live in a side table instead — see "Where each photo came from" below.

`src/app/types/coin-image.model.ts` holds the image-specific shapes: `AttachedImage` (`{ imageData, sourcePath }`), `CoinImageRecord` (what `GET /api/coins/:id/images` returns) and `ImageFileExistence` (`'present' | 'missing' | 'unknown'`).

### CAC "green bean" accent

CAC stickers a coin already graded by PCGS/NGC as meeting a tighter quality bar within its stated grade. `hasCacSticker` is a layered accent on top of `certCompany`/`certNumber`. The accent image lives at `public/CACGreenBean-trimmed.png` and renders in two places: inline in the inventory table, and as a checkbox toggle in the coin editor.

It used to render in a third — a badge row in the detail panel header, alongside summary badges for grade and certification. That whole header was removed. Every value it showed is an editable field in the form immediately below it, so the header was restating, in a form you could not correct, what was already on screen a row or two down. The grade pill and the green bean still appear where they genuinely earn their place: the inventory grid, where there is no form and you are scanning many coins at once.

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

The rule now lives in its own shared module, **`src/app/services/coin-completeness.ts`**, because all three coin-creating paths need exactly the same judgement: the QIF importer, the CSV importer and the manual "Add coin" path. It exports:

| Export | What it is |
| --- | --- |
| `MAIN_COIN_DETAILS` | The three details, in order |
| `MINIMUM_MAIN_DETAILS` | `2` — the "of 3" |
| `isCoinDetailPresent(value)` | Is one detail genuinely filled in |
| `checkMainCoinDetails(record)` | The full `CoinDetailCheck` result |
| `hasEnoughCoinDetail(record)` | The boolean verdict |
| `describeMissingCoinDetail(record)` | Human-readable "what's missing" text for the UI |

`quicken-import.service.ts` re-exports the same symbols so its own unchanged tests still work; `coin-draft-registry.ts` uses `hasEnoughCoinDetail` / `describeMissingCoinDetail` to decide when a newly added coin is legal enough to POST; and `csv-import-modal.ts` imports the same two functions directly.

The rule is also applied in exactly **one** place per importer, on purpose. In the QIF parser there is deliberately no "is this detailed enough?" test in the mid-loop filtering any more, only in the final assembly loop, so that no code path can reach `importedRecords` without passing it. The previous version tested `!year && !denomination` mid-loop, which only rejected coins missing *both* fields, and then bolted on a regex for bare "1934"-style names.

The check is deliberately strict about what counts as "present": placeholder values like `-`, `0`, `n/a`, `none`, `unknown` and `other` are treated as blank, because a naive truthiness test accepted all of them. That set is `PLACEHOLDER_DETAIL_VALUES`, which is module-private — you go through `isCoinDetailPresent()` rather than reading the set directly.

Coins that fail the rule are not silently dropped. They appear in an **"Exceptions — not imported"** panel showing the raw QIF security name, what the parser *was* able to read, and which details were missing. The fix for a row landing there is to correct its name in Quicken and export again.

**The "Import anyway" override is gone, and must stay gone.** The modal used to keep an `overriddenSecurities` list letting the user force a failing record into the import. It looked like it worked and did not: the coin appeared in the grid, so the user believed it had saved — but the backend rejects a coin with no denomination outright with `400 {"error":"denomination is required"}`, so no database row was ever created, and every later edit then targeted an id the server had never heard of. That is the "errors when trying to update the details" the owner reported. The rule now is simply: **the UI must never offer to create a coin the backend would refuse.** The whole mechanism — the state, both handlers and the styling — was deleted, and `quicken-import-modal.spec.ts` asserts that `overrideException`, `undoOverride` and `applyDetailOverrides` are all `undefined`, so it cannot be reintroduced by accident.

**What the coin is made of is now inferred too.** The QIF importer pre-fills four editor fields — Metal, Composition, PM % and PM weight — from a single `lookupCoinAlloy(denomination, year, country, metalHint)` call against the reference table in `src/app/services/pm-reference.ts`. All four come from that one lookup, so they can never disagree with each other: either we know what the coin is made of and fill all four, or we know nothing and fill none.

The year is doing most of the work. A 1964 quarter is 90% silver and a 1965 quarter has none, and the only difference between them is the date. The table is organised by country, then metal, then chronologically, and year ranges within one country + denomination **never overlap** — where two standards met, the boundary year is assigned to one side and the reasoning is written in a comment.

**The governing principle is: when in doubt, answer nothing.** This project already follows that rule for image matching, and here it has a sharper justification —

> A wrong purity silently produces a wrong melt value. A blank field is visible and the user can fix it.

So wherever a year/denomination combination genuinely had two different alloys in circulation, the table has **no entry at all** and the lookup returns `null`. Each gap is marked with a `*** DELIBERATE GAP ***` comment:

| Left blank | Why guessing is worse |
| --- | --- |
| **1942 Jefferson nickel** | Nickel was a strategic war material, so from October 1942 the five-cent piece was struck in a silver alloy instead. *Both* compositions were struck during 1942, and the only reliable way to tell them apart is the large mint mark above Monticello — which a Quicken security name does not carry. Guessing here is a 35-percentage-point error |
| **1982 Lincoln cent** | The cent switched from 95% copper bronze to copper-plated zinc partway through 1982. Both exist with the same date and the same design; they are told apart by weighing them (3.11 g vs 2.50 g) |
| **1971-1978 Eisenhower dollar** | Business strikes are copper-nickel clad; the collector issues sold by the Mint are 40% silver. Same date, same design, nothing in a security name separates them |

Two further kinds of ambiguity are handled in code rather than by omission:

- **An ambiguous `$1`.** Two entries can match the same denomination and year while naming *different* metals — the classic case is "$1" in 1849-1889, when the US struck both a silver dollar and a gold dollar. The lookup refuses to choose and returns `null`, **unless** the caller passes a `metalHint`, because the security name said "Gold" or "G$1" out loud. The importer reads that hint from the name and passes it through.
- **1992-and-later silver proof dimes and quarters.** Silver proof-set issues resumed in 1992 at the old 90% standard, and they are indistinguishable from the clad ones by year alone. Rather than omit them, those rows carry `requiresHint: true`, which makes them **invisible unless the caller supplies a matching metal hint**. So a plain "1998 25¢" gets the clad answer, and a "1998 25¢ Silver Proof" gets the silver one. The effect is the same as a gap for every name that does not say "silver": nothing is guessed.

**Foreign country and denomination detection** (`src/app/services/coin-countries.ts`) is the other new reading taken from the security name. The parser used to hard-code `country: 'United States'` on every row, and its denomination table only understood US face values. That is right for 43 of the 44 coins in this collection and wrong for the 44th — `Y1969 Peru 100 Soles - NGC MS64` parsed with a Year and nothing else, failed the 2-of-3 rule and landed in the exceptions list. With the country and denomination both read it now imports on two of three, with Coin Type legitimately blank.

It keeps the same principle as the image matcher's `denomination-units.ts` — *a bare number means nothing; a number bound to a unit means a lot* — but applies it to a world-coinage vocabulary that file deliberately does not have. There is no overlap between "100 Soles" and "$20", so nothing is duplicated.

The conservatism rule is applied to currency units specifically:

- **A unit may imply a country only when it has exactly one issuer.** "Soles" is Peru; nowhere else has ever struck a Sol. Rand and Pond are South Africa, Forint is Hungary, Zlotych is Poland, Yen is Japan, and so on — those carry `impliesCountry`.
- **A shared unit reads the denomination but leaves the country blank.** "20 Francs" could be France, Belgium, Switzerland or Luxembourg; "50 Pesos" could be Mexico, Chile, Colombia or Argentina. The denomination is unambiguous and is recorded; the country is left alone unless the name says it outright. Guessing "Mexico" for an Argentine coin would quietly attach the wrong melt reference to it, which is the exact failure mode this project keeps trying to avoid.

The country name list is deliberately broad — this is a gold collection and world gold turns up everywhere — but every entry was checked against one question: *could this word appear in a US coin's name?* Several nearly could, and those carry guards. `Panama` only counts when "Pacific" does not follow, because the 1915-S Panama-Pacific commemoratives are US coins. `Spanish` only counts when "Trail" does not follow, because of the 1935 Old Spanish Trail half dollar. `India` is written `\bindia\b` so "Indian Head" and "Indian Princess" cannot match. `Colombia` is listed only with an 'o', because the US Columbian Exposition half is spelled with a 'u'. And **Guinea is omitted entirely** — the Guinea is an English gold coin, so "1760 Guinea" means the coin, not the African republic.

The canonical country spellings must match the `country` values in `pm-reference.ts` ("Great Britain", not "UK"), or a correctly recognised country would silently lose its precious-metal lookup.

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
| Set | `coinSet` | |
| Metal Content | `metalContent` | |
| Weight (g) | `weight` | Numeric, in **grams** — a unit suffix is tolerated but not checked |
| Sold Price | `soldPrice` | Numeric — see below |
| Sold Date | `soldDate` | |
| Source | `source` | Validated against `manual` / `quicken` / `import` / `csv` |

**The `Weight (oz)` header from older exports no longer maps, deliberately.** `autoMapHeaders()` matches a header against each field's key or its label, so a file exported before migration 008 arrives with its weight column **unmapped** and nothing from it is imported. Two alternatives were considered and rejected. Mapping it straight onto `weight` would import a Morgan dollar as 0.7734 *grams* — the exact 31x understatement the migration exists to prevent, reintroduced through the back door and completely silent. Recognising the old header and multiplying by 31.1034768 on the way in is arithmetically right but makes a cell's meaning depend on the text above it, which nobody expects: a user who had already converted their spreadsheet to grams but left the heading alone would get every weight multiplied by 31 instead, and the importer has no way to tell the two files apart. An unmapped column is visible on the mapping screen and costs one dropdown selection to fix; a silent 31x error in either direction is not recoverable. This is the same precedent the removed `Dealer` column set — an unrecognised column is ignored rather than guessed at. `docs/csv-import-guide.md` tells the user what to do about it.

**Value handling**

- Empty cells are skipped entirely, leaving the field at its default rather than writing a blank.
- The four numeric fields go through `parseNumericCell()` in `src/app/services/csv/numeric-cell.ts`, which tolerates a currency symbol, thousands commas, a trailing unit (`26.73 g`), a simple fraction (`1/10` → `0.1`) and a parenthesised negative (`(1,250.00)` → `-1250`). A cell with no number in it at all still becomes `0`.
- **The unit suffix is discarded, never checked**, which is a sharper edge now that Weight is grams: `0.7734 ozt` in the weight column imports as 0.7734 *grams*, and the fraction rule — written for fractional-ounce gold — turns `1/10 oz` into a tenth of a *gram*. The parser was left unit-blind on purpose; it is shared with the three money fields and the alternative is a cell whose meaning depends on text the parser is designed to throw away. The blank template no longer offers a fractional-ounce example, and the user-facing guide warns about both forms.
- Imported coins get a freshly generated id. `source` is honoured if a `Source` column is present and holds a recognised value; otherwise it defaults to `csv`.

**A fixed bug worth not reintroducing.** Those four fields used to be parsed with `Number(value.replace(/[$,]/g, '')) || 0`. `Number()` returns `NaN` unless the *entire* string is numeric, and `|| 0` then turned that `NaN` into a zero — so `0.7734 ozt`, `1/10 oz` and `1250 USD` all imported as **0**, silently. Weight was the worst affected, because a weight figure invites its unit and people habitually type one. `numeric-cell.spec.ts` pins every one of those cases. (The original write-up of this bug added "and because melt value is derived from weight" — that part was wrong and is corrected here so it is not repeated: melt uses `pmWeightGrams`, which CSV cannot import at all.)

**The 2-of-3 completeness rule now applies here too.** It used to be QIF-only, and that inconsistency was not harmless. `importCsv()` was `addCoins(rows.map(mapRowToCoin))` — every row, no questions asked. The backend rejects a coin with no denomination, so such a row became an in-memory record with no database row behind it: it showed up in the grid, and then every edit to it failed against an id the server had never seen. That is the same symptom the owner reported on the QIF side and asked to be made impossible — the code should simply not import something it cannot identify.

So the modal now maps every row, imports only those carrying at least two of Year / Coin Type / Denomination, and reports the rest in a **"Not imported — too little detail"** panel. Each entry gives the row number as the user sees it (1-based, header excluded), a short label built from whichever of the three fields *were* read, and which details were missing. When nothing identifying was mapped at all the label falls back to the row's first non-empty cell, which usually means the mapping itself is wrong and is the most useful thing to show.

**The dialog stays open when anything was refused**, and closes immediately when nothing was. That asymmetry is deliberate: a clean import stays a single click, but a toast that disappears is not an adequate way to tell someone which lines of their file were skipped. The summary above the list also says how many coins *did* import, so the panel is a complete account of the run rather than only its failures. The Cancel button relabels itself "Done" once there is a report to read.

**Minimal example**

```csv
Coin Type,Denomination,Year,Mint Mark,Grade,Purchase Price
Morgan Dollar,Dollar,1881,S,MS63,"$1,250.00"
Mercury Dime,Dime,1916,D,VG8,$895.00
```

Each of those rows carries all three main details, so both import. A row with only a year in it does not, and will be listed in the exceptions panel instead.

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

The coin collection lives in SQL Server. A separate Express/TypeScript backend provides the REST API. The schema is created and seeded from `server/setup-database.sql`, which defines the canonical tables for coins, images, categories, denominations, mint marks, metal contents, transactions, spot prices, and app settings with proper foreign keys and indexes. Authentication defaults to Windows (trusted connection) for easy local development.

**`setup-database.sql` drops every table before creating it, so it is only for an empty or disposable database.** Changes to a database that already has coins in it go in `server/migrations/` instead, as numbered scripts following two rules: guard every statement so re-running the file is harmless (there is no migration-tracking table in this project, so "safe to run twice" is what takes its place), and never drop or rewrite a column that holds user data. The numbering starts at 002 because `setup-database.sql` is effectively migration 001 — the baseline every delta is measured against.

| Script | What it does |
| --- | --- |
| `002-add-image-source-path.sql` | Adds `CoinImages.SourcePath NVARCHAR(400) NULL`, guarded by a `COL_LENGTH` check |
| `003-multiple-images-per-coin.sql` | Adds `SourcePath` if 002 was never run, renumbers duplicate `SortOrder` values per coin, and replaces `IX_CoinImages_CoinId` with `IX_CoinImages_CoinId_SortOrder`. Prints a summary of the table when it finishes |
| `004-widen-weight-precision.sql` | `Coins.Weight` and `Coins.PmWeightGrams` from `DECIMAL(10,4)` to `DECIMAL(12,5)`, so the five decimals the editor shows are the five the database keeps |
| `005-drop-coin-tags.sql` | Drops the `CoinTags` table — but only if it is empty |
| `006-drop-coin-dealer.sql` | Drops `IX_Coins_Dealer`, then the `Coins.Dealer` column. `Transactions.Dealer` is a different column and is untouched |

003 repeats 002's column deliberately: the two changes ship together, and a database that got the index but not the column would be a confusing half state. Run them in order if you have not run either; run 003 alone if you prefer.

**Why 004 widens to `(12,5)` rather than `(10,5)`.** `DECIMAL(p,s)` splits `p` total digits into `s` after the point and `p-s` before it. The old `(10,4)` allowed six digits ahead of the point; keeping `p` at 10 while raising `s` to 5 would leave only five, which *narrows* the integer side — a stored value of 100000 or more would fail the conversion and abort the `ALTER`. Going to `(12,5)` raises the integer capacity to seven instead, which makes this a pure widening that cannot fail on any existing row, and the extra digits are free: `(10,4)` and `(12,5)` occupy the same 9-byte storage class. Increasing both precision and scale is a widening conversion, so SQL Server rewrites each value in place rather than needing a table rebuild.

**Why 006 has to drop an index first.** `setup-database.sql` creates `CREATE INDEX IX_Coins_Dealer ON Coins (Dealer);`, and SQL Server refuses to drop a column an index depends on — "The object 'IX_Coins_Dealer' is dependent on column 'Dealer'." The script therefore finds every index on `Coins` whose key includes `Dealer` and drops it by name, rather than hard-coding `DROP INDEX IX_Coins_Dealer`, so that an index added later under a different name does not make the migration fail.

**API endpoints**

| Group | Endpoints |
| --- | --- |
| Health | `GET /api/health` |
| App info | `GET /api/app-info` — host-local facts the browser cannot know; used to prefill the image importer's base-folder box |
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

- **Run the outstanding migrations in `server/migrations/`** — 004, 005 and 006; see the section at the top of this file. 002 and 003 (photo source paths and reliable image ordering) have already been run. 004 is the one with a user-visible consequence: without it the fifth decimal place the editor shows for Weight and PM Weight is rounded away on save.
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
# Frontend — 836 tests across 41 files
npm test

# Server — 154 tests across 16 files
cd server && npm test
```

The frontend suite runs as **`vitest run --root src`** (that is what `npm test` expands to). On Windows, when the project sits at or near a drive root, Vitest 4.x has a path-resolution problem that makes it find zero test files; pointing `--root` at `src` works around it. Run it that way rather than a bare `npx vitest run`.

Server specs sit next to the code they cover — `db/connection.spec.ts`, `db/coin-fields.spec.ts`, `routes/app-info.spec.ts`, `routes/coins/reads.spec.ts`, `routes/coins/writes.spec.ts`, `routes/coins/images.spec.ts`, `routes/coins/images-post.spec.ts`, `routes/coins/image-payload.spec.ts`, `routes/coins/list-query.spec.ts`, `routes/images/images.spec.ts`, `routes/lookups/lookups.spec.ts`, `routes/data/data.spec.ts`, `routes/data/spot-price-source.spec.ts`, `routes/db-error-response.spec.ts`, `routes/error-handler.spec.ts` — and they all share `server/test-support/mssql-mock.ts`. `server.spec.ts` covers the app wiring and the health endpoint. `db/connection.spec.ts` includes the regression test for the crash — it emits `'error'` on the pool and asserts the process survives.

**A recurring shape in the frontend specs is worth knowing about before you add one.** This suite runs under plain Node, with `jsdom` only for the specs that genuinely need a DOM, and a component taking a required signal `input()` cannot be constructed without `TestBed`. So the pattern throughout is to lift the decision out of the component into a plain class or pure function beside it and test *that*: `custom-option-mode.spec.ts`, `denomination-countries.spec.ts`, `numeric-field-format.spec.ts`, `coin-images-main-photo.spec.ts`, `image-path-display.spec.ts` and `selection-rules` are all this. It is why `numeric-field.ts` (which touches a real `<input>`) and `numeric-field-format.ts` (which does the arithmetic and string work) are two files: the half that can silently corrupt a coin's price or weight is the half that is covered.

`coin-set-persistence.spec.ts` and `export-import-round-trip.spec.ts` are regression pins for two bugs that were invisible until a reload: a coin set that was never written to the database, and an export column that could not be mapped back on import.

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

**No photo shows a path.** You probably have not run migrations 002 and 003, which add `CoinImages.SourcePath`. See the top of this file.

**The fifth decimal of a weight disappears when you save.** You have not run migration 004. The columns were `DECIMAL(10,4)` and the editor shows five decimals, so the fifth digit was rounded away on the way into the database: type `0.12345`, reopen the coin, read `0.1235`.

## Known gaps and rough edges

Documented honestly so they are not rediscovered as surprises.

- **Melt value is computed correctly but is not displayed anywhere.** This is the most actionable item on this list. `InventoryService.meltValue(coin)` works and is tested, but it has no caller in any template. The inventory grid has a "Melt Value" column whose formatter in `src/app/types/inventory-columns.ts` is still a stub carrying a `TODO` — it returns an em-dash for every coin regardless of whether the coin has a pure weight and a metal. The spot price modal tells the user that "coins with weight and metal content will show melt values automatically", which is currently not true. The fix is to hand the formatter the spot prices (or move the cell to a component that can reach `InventoryService`) and call the existing function. Note the `TODO` comment there still describes the **old, wrong** formula, applying `pmPercent` a second time — do not implement what it says; see "Spot prices and melt value".
- **The image gallery never imports `styles/_modal.scss`.** `_modal.scss` is where `.modal-backdrop` (`position: fixed; inset: 0`), `.modal`, `.modal--wide`, `.modal-header` and `.modal-close` are defined. Every modal `@use`s it now except the **image gallery**, whose markup uses those exact class names, so it may render without a backdrop or fixed positioning. The comment in `coin-image-gallery.scss` records that this is preserved behaviour rather than an oversight: the classes had no styling for as long as the markup lived in `app.html`, and the extraction into components changed nothing visually on purpose. The fix is a one-line `@use '../../styles/modal' as *;`. (This was the same gap the **Settings dialog** had, and there it turned out not to be cosmetic at all — see "Settings dialog". That is the reason to treat the gallery's version as a live bug rather than a quirk. The full-screen photo viewer is *not* affected; it defines its own fixed backdrop.)
- **`.eyebrow` is styled but unreachable.** The rule lives in `styles/_controls.scss`. The only markup still using it is `<p class="eyebrow">Numismatic portfolio</p>` in `app.html`, and `app.scss` does not `@use 'styles/controls'` — so that caption renders with no styling at all. The other user of the class, the detail panel's "Selected coin" header, was deleted. Either add the `@use` to `app.scss` or drop both the rule and the markup; it is a one-line change either way, but which way is the owner's call.
- **`server/schema.sql` is dead and should be deleted.** It is a legacy, superseded schema file that **contradicts** `server/setup-database.sql`: it issues `CREATE DATABASE CoinInventory`, uses lower-case table names (`coins`), and describes a structure nothing in the app matches. Nothing references it — `setup-database.sql` is the real build-from-scratch script and `server/migrations/` holds every delta. The danger is purely that someone opens it believing it is current and runs it. Deleting it is the whole fix.
- **Several fields cannot be imported from CSV at all**, because they are not in the mappable list: `hasCacSticker`, `imagePaths`, and — worth noting — `pmWeightGrams` and `pmPercent`, which melt-value calculations depend on. A CSV round-trip therefore loses CAC flags and precious-metal weights, so a CSV export is a good report and a good starting template but **not** a backup. (The `Source` column *is* importable, so provenance survives a round trip; `exportCsv()` derives its columns from `CSV_MAPPABLE_FIELDS` via `exportColumns()`, which makes an exportable-but-unimportable column structurally impossible. `export-import-round-trip.spec.ts` asserts it. That derivation is also what removed the Dealer column from the importer, the export *and* the blank template in one edit when the field was retired.)
- **One input still uses placeholder-as-label.** Just one, in the bulk edit bar: `<input #bulkValue type="text" placeholder="New value" />`, with no wrapping `<label>`, no `aria-label` and no caption span. Placeholder-as-label reads fine until you start typing, at which point the only thing telling you what the box was for disappears — and some screen readers skip it entirely. The rest of the app is clean: the Settings dialog's **five** inputs each sit inside a `<label>` with a caption `<span>` (and the Sets / Albums one also carries an explicit `aria-label`), the category modal's inputs all carry an explicit `aria-label`, the advanced filter panel's inputs sit inside `<label>`s with caption spans and use their placeholders only for *examples* (`e.g. MS, VF, AU`, `$0`, `$∞`) rather than as the label, the toolbar search box has an `aria-label`, and `coin-editor-form.html` has no `placeholder` attributes at all. One related but different defect is worth fixing while you are in there: the `<select #bulkField>` next to that input has no accessible name either — it carries no `placeholder`, so it is not the same gap, but it is the same omission. (A previous version of this note described four unnamed `<textarea>` elements in the Settings dialog. Those textareas were the bulk-edit boxes and have been deleted; see "Settings dialog".)
- **`GET /api/transactions` does `SELECT *`** including an `NVARCHAR(MAX)` Notes column, with no row bound and no pagination. Fine at the current size, but it will be the first thing to feel slow.
- **`GET /api/coins` still returns `imagePaths` by default.** That is a temporary compatibility shim. The intent is for the default to flip to `includeImages=false` once the client is migrated to fetch images per coin, so the main list stops shipping the full base64 for every coin up front.
- **`GET /api/coins/:id` returns `imagePaths` as a flat string array with no source paths.** Source paths come from `GET /api/coins/:id/images`, which is what `CoinImagePathsService` calls; the single-coin read has not been widened.

---

## Planned next steps

### 1. Flip `GET /api/coins` to `includeImages=false` by default

The server already supports it and the client already has a per-coin image fetch (`CoinImagePathsService`). What remains is migrating the last readers of `imagePaths` on the list endpoint and then changing the default, so loading the inventory stops shipping every coin's base64.

### 2. Two small cleanups already identified

Both are described in "Known gaps and rough edges" and both are a few minutes' work:

- **Delete `server/schema.sql`.** It is a dead legacy schema that contradicts `setup-database.sql`. Nothing references it; the only risk it carries is that somebody runs it.
- **Fix the last placeholder-as-label**, the bulk edit bar's "New value" input, and give the `<select>` next to it an accessible name at the same time.

### 3. Show the troy-ounce equivalent beside the gram weight

The owner's words: *"A future update might be to show the troy ounces (up to 5 decimal places) in parentheses next to gram weight."* This is **display only** and was deliberately left out of the grams conversion rather than bolted onto the field while it was already changing.

What it means in practice: the `Weight` field should read something like `30.09300 g (0.96750 ozt)`. The **gram figure stays the stored, editable value** — the ounce figure is derived for display and is never written back. The reason it is worth having at all is that grams is now what the database holds, but troy ounces is still the unit bullion is quoted, traded and advertised in, so a collector comparing a coin against a dealer's listing needs the ounce number and should not have to do the arithmetic.

Everything needed to pick this up cold:

- `Coins.Weight` is **grams**, as of `server/migrations/008-weight-to-grams.sql`. It is `DECIMAL(12,5)` and the editor shows all five decimals — which is partly why it kept five rather than being trimmed when the unit changed (see "Typing in a number box").
- The constant is **31.1034768 grams per troy ounce**, i.e. `ounces = grams / 31.1034768`. It already exists in the codebase, in `server/routes/data/spot-price-source.ts`. Note that `inventory-metrics.ts` uses the rounded `31.1035` for melt value; prefer the exact figure for a displayed conversion, and consider lifting one shared constant rather than adding a third copy.
- Five decimals on the ounce figure is what was asked for, and the gram side can support it: one step of the fifth ounce decimal is 0.000311 g, comfortably inside five gram decimals.
- The field is `src/app/components/coin-editor-form/coin-editor-form.html`, which carries a pointer comment to this entry. The input is driven by the `appNumericField` directive, which owns `element.value` and must not be fought — the ounce text belongs **outside** the `<input>` (in the `<span>` label, or a sibling element), not inside it.
- Consider whether the inventory grid's `Weight (g)` column wants the same treatment. It probably does not — the grid is a dense scanning view and already dropped from four decimals to three — but it is the obvious next question.

### 4. Certification company logos for PCGS, NGC, and ANACS

The CAC green bean accent is done. Official logos for grading companies were skipped due to trademark concerns. If revisited:
- Would need real logo assets or custom non-trademarked badges
- Data model needs a way to distinguish "raw / not certified" from "certified but certCompany is empty"

### 5. Premium feature research

Research premium coin inventory programs (PCGS CoinFacts, NGC Registry, Numismaster, etc.) and adopt the best ideas that make sense for this application.

### Longer-horizon ideas (not yet scheduled)

- Valuation-service integration (market pricing by denomination/grade)
- Fuzzy edit-distance matching for filenames the current parsers cannot read
- "Raw" coin explicit visual state
- Dashboard with charts (value over time, category breakdown)
- Server-side de-duplication of image inserts (in the insert logic, where a duplicate can be dropped without killing the batch — *not* as a unique constraint; see migration 003)
- Make `pmWeightGrams` / `pmPercent` / `hasCacSticker` CSV-mappable, so a CSV export can be a real backup rather than only a report and a template

### Done (kept here so it is not re-planned)

- **Fix the melt-value calculation** — done. `computeMeltValue` was applying purity twice to a figure that was already the pure-metal weight, understating every coin by the purity factor. Three wrong reference weights in `pm-reference.ts` were corrected at the same time.
- **Actually show the melt value** — done, and it turned out to be the plumbing around the sum rather than the sum itself. The arithmetic had been correct and tested for some time; what was missing was everything else. Spot prices were never written to the database, never read back, and so reset to zero on every launch, so every melt cell showed an em-dash for ever. Five things changed: `ApiService.getLatestSpotPrices()` for `GET /api/spot-prices/latest`; a spot price load in the non-fatal lookup phase of `ConnectionManager.hydrate()`; saves on deliberate actions only (see "Spot prices and melt value"); a real `meltValue` formatter in the grid; and a valuation line in the detail panel. The app also fetches live COMEX prices once, automatically, after start-up has finished.
- **Stop the number boxes reformatting while you type** — done. The `appNumericField` directive replaced the `[ngModel]="format(x)" (ngModelChange)="parse($event)"` pattern on all five numeric fields, and the one rule it enforces is that nothing writes to `element.value` while the field has focus.
- **Fix the "Other" denomination and mint mark boxes** — done. Custom mode is its own signal in `custom-option-mode.ts` instead of a sentinel stored in the coin's own field, so typing in the box can no longer destroy it, a saved custom value reopens it, and `__OTHER__` can never be persisted.
- **Fix the empty country headings in the denomination dropdown** — done. `denominationCountriesOf()` derives the groups from the data, so an empty heading and an ungrouped entry are both impossible by construction.
- **Persist coin sets** — done. `LookupManager.addCoinSet` / `removeCoinSet` now write through `/api/coin-sets` instead of only touching a signal; the table, the routes and the hydration read had all existed for some time.
- **Apply the 2-of-3 completeness rule on the CSV import path** — done. CSV import now refuses rows carrying fewer than two of Year / Coin Type / Denomination and lists them in a "Not imported — too little detail" panel, with the dialog staying open so the report is read.
- **Remove the QIF "import anyway" override** — done. It produced coins that appeared in the grid but had never been saved, so every later edit failed against an id the server had never seen. A record failing 2-of-3 is now simply not importable; the exceptions panel still lists what was skipped and why.
- **Infer composition on QIF import** — done. Metal, Composition, PM % and PM weight are pre-filled from year + type + denomination, with deliberate gaps where two alloys share a date and nothing in a security name tells them apart.
- **Detect foreign countries and denominations on QIF import** — done. `coin-countries.ts`, with the rule that a currency unit may imply a country only when it has exactly one issuer.
- **Fix the Settings dialog rendering inline** — done. It now imports the shared modal styles and has a distinct focus border; the lossy bulk-edit textareas were removed and a Sets / Albums list was added.
- **Rework the coin editor layout** — done. Year / Coin Type / Denomination / Mint mark on the first row, Cert company on the Grade line, the redundant heading and badge rows removed, sidebar widened to 420px.
- **Let the user choose the grid thumbnail** — done. "Set as main" in the gallery re-orders `imagePaths`, reusing `SortOrder`, so no migration was needed.
- **Retire the `tags` field** — done. Nothing could ever create one; migration 005 drops the table.
- **Retire the coin-level `dealer` field** — done. The same information is already recorded, better, per event on the transaction rows. Migration 006 drops the column. `Transactions.Dealer` is a different column and deliberately stays.
- **Fix esbuild/ng serve** — resolved via the webpack builder plus the `esbuild-wasm` override in `package.json`. The app serves and builds.
- **Wire up SQL Server backend** — done. `InventoryService` goes through `ApiService` to the Express API; IndexedDB is now only UI preferences.
- **Batch image import** — done. Point at the photo folder, match ~2,140 files on filename alone, review grouped by coin, then read and downscale only the confirmed files, sequentially.
- **Multiple images per coin** — done. `CoinImages` was always a child table; migration 003 made `SortOrder` deterministic and widened the index to match the hot query.
- **Image source paths** — done. `CoinImages.SourcePath`, the `/api/images` endpoints, `ImageSourcePathRegistry`, and a three-state path display per photo.
- **Fix the COMEX spot-price fetch** — done. metals.live was dead; replaced with COMEX/NYMEX futures symbols, with copper correctly converted from per-pound to per-troy-ounce and failures reported instead of stored as zero.
- **Fix the page-level scrollbar** — done. `src/styles.scss` was empty; it now carries the body reset, and the status bar became a normal flex row instead of a fixed overlay.
- **Remove placeholder text from the detail entry fields** — done, and the Cert Company input was widened so "ANACS" fits.
- **Share the 2-of-3 rule** — done. It lives in `src/app/services/coin-completeness.ts` and is used by all three coin-creating paths: the QIF importer, the CSV importer and the manual "Add coin" path.
- **Stronger filename normalization for image matching** — done. The `image-matching/` folder is now fourteen focused modules — seven of them new, single-purpose parsers — plus a spec that runs against verbatim real filenames from the collection.
