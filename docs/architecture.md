# Architecture

How Coin Inventory is put together: the layout philosophy, the component
boundaries, the stores, and the backend structure.

For what each feature does and *why* it behaves the way it does, see
[how-it-works.md](how-it-works.md). For running and building, see the
[README](../README.md).

## Architecture

### Layout philosophy: inventory first

The UI is organized around the principle that the inventory table *is* the application. Import workflows, category management, and other administrative functions live in modal dialogs — accessible from the toolbar but never dominating the main view. The layout is:

1. **Header** — title and the toolbar
2. **Toolbar** — action buttons (Add Coin, Import, Export, Settings)
3. **Filter bar** — search, category filter, and a collapsible advanced panel for grade, value range, source, country, coin set
4. **Main content grid** — inventory table (full width) + detail sidebar (shown when a coin is selected)
5. **Bulk edit bar** — fixed bottom bar when coins are multi-selected
6. **Modal dialogs** — Quicken (QIF) import, CSV import, image import (Import ▾ → Images from folder), category management, reports, spot prices, settings
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

Two components exist only to keep the image-import modal's template from running away with itself, one per tier that needs buttons. Both are "dumb" — every piece of state arrives as an input and every decision leaves as an output, and the modal owns the row list:

| Component | Selector | What it draws |
| --- | --- | --- |
| `CoinImageGroup` | `app-coin-image-group` | **Tier 1.** One coin and every photo the matcher attached to it — tick boxes, bulk rules and Skip |
| `NearMatchReview` | `app-near-match-review` | **Tier 2.** One coin and the photos that are a single yes/no away from it: parsed-attribute chips, Attach / a dropdown of the other near candidates / Skip per photo, and an "Attach all" that settles the whole coin at once |

(There is no component for **tier 3**: files with no apparent match are skipped automatically and listed as a plain read-only table in the modal itself, with no buttons on them. The old `ImageMatchResolver` card, which asked the user to resolve every unplaced photo by hand, was removed with the two-bucket screen it belonged to.)

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
| `server/logger.ts` | Appends timestamped lines to a rotated daily log under `server/logs/` |
| `server/log-rotation.ts` | Daily log naming, the 5 MB per-file cap, ~14-day retention |
| `server/support/` | The problem-report bundle: redaction, report text, zip writer |
| `server/test-support/mssql-mock.ts` | The shared mssql mock used by every server spec |

`routes/images/` is worth a note because it is unlike everything else in this backend: neither endpoint touches the database or the connection pool at all. `withDb()` and `sendDbError()` make no appearance there. They are about files on disk, which is why they live outside `/api/coins`.

`routes/app-info.ts` is the other router that never touches the database, and it exists for one small job. The batch image import screen has to ask the user for the absolute folder their photos live in, because the browser refuses to tell it (see "The base-folder input"). Starting that box empty is unhelpful, and the old prefill was worse: it hard-coded `\\NAS\Coin Pictures`, which is how the library is reachable from the *developer's* workstation, not from the machine hosting the app. A path valid on the wrong machine is the single most expensive mistake that screen can make, because it does not fail loudly — it stamps every imported row with a location that resolves to nothing. So the prefill is now something only the server can know and that is guaranteed to be host-local: the folder the app itself is installed in. It is very probably not where the photos are, and the screen says so — but it is the right shape, on the right machine, with the right drive letter, and the user edits it down from there. Once they do, the choice is remembered and this endpoint's answer is never consulted again. Deliberately independent of SQL Server, too: the import screen must open even when the database is down, and a cosmetic default is never worth failing a page load over.

`routes/error-handler.ts` also fixes a real bug. It used to be four lines ending in an unconditional `res.status(500).json({ error: 'Internal server error' })`, which threw away information the error was already carrying. `express.json()` is configured with `limit: '50mb'`, and when a request body exceeds it, body-parser rejects the request with a `PayloadTooLargeError` that already has `status: 413` set on it. During a batch photo import that mattered: the real problem is "that batch of images is too big, send fewer at a time", which the user can act on, but what they saw was a generic server error suggesting the server itself was broken.

