# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, an admin-managed category system, a Quicken (QIF) import workflow, a directory-based photo matching workflow, and persistence via IndexedDB (with an optional SQL Server backend) — all designed around an inventory-first layout where the collection table is the center of the experience.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next — rather than re-discovering the codebase from scratch.

## Current state (as of 2026-08-22)

The application is functional end-to-end: inventory CRUD, category administration, Quicken import with QIF filtering, CSV import, directory-based image import with matching, spot price tracking, melt value calculations, multi-select with bulk edit/delete, transactions, report generation, search/filter/sort, and persistence all work. 82 passing unit tests across 11 test files cover the main component and all 6 child components. Server API tests are written (pending dependency install).

## Architecture

### Layout philosophy: inventory first

The UI is organized around the principle that the inventory table *is* the application. Import workflows, category management, and other administrative functions live in modal dialogs — accessible from the toolbar but never dominating the main view. The layout is:

1. **Header** — title and summary metrics (count, total cost, current value, gain/loss)
2. **Toolbar** — search, category filter, and action buttons (Add Coin, Import QIF, Import CSV, Import Images, Categories, Reports, Spot Prices, Export/Import JSON)
3. **Advanced filters** — collapsible panel for grade, value range, source, country, coin set, dealer
4. **Main content grid** — inventory table (full width) + detail sidebar (400px, shown when a coin is selected)
5. **Bulk edit bar** — fixed bottom bar when coins are multi-selected
6. **Modal dialogs** — Quicken import, CSV import, image import, category management, reports, spot prices

### Component structure

The root component (`src/app/app.ts`, ~460 lines) handles layout, filtering, multi-select, and per-coin editing. Six modal child components handle specialized workflows:

| Component | Selector | Location |
| --- | --- | --- |
| `QuickenImportModal` | `app-quicken-import-modal` | `src/app/components/quicken-import-modal/` |
| `CsvImportModal` | `app-csv-import-modal` | `src/app/components/csv-import-modal/` |
| `ImageImportModal` | `app-image-import-modal` | `src/app/components/image-import-modal/` |
| `CategoryModal` | `app-category-modal` | `src/app/components/category-modal/` |
| `ReportModal` | `app-report-modal` | `src/app/components/report-modal/` |
| `SpotPriceModalComponent` | `app-spot-price-modal` | `src/app/components/spot-price-modal/` |

Each child component uses Angular's `inject()` pattern and `output()` to communicate back to the parent. Shared modal styles live in `src/app/styles/_modal.scss` and are imported by each child via `@use`.

### SCSS organization

App styles are split into partials under `src/app/styles/`:

| Partial | Contents |
| --- | --- |
| `_base.scss` | Host element, resets, buttons, file picker, gain/loss colors, badges, CAC green bean |
| `_layout.scss` | Shell, topbar, summary cards, toolbar, advanced filters, main grid, panels |
| `_inventory-table.scss` | Inventory header, column picker, table, rows, thumbnails |
| `_detail-panel.scss` | Detail panel, editor, valuation, notes, transactions, image gallery |
| `_overlays.scss` | Bulk edit bar, photo viewer, responsive, print media queries |
| `_modal.scss` | Shared modal backdrop/chrome, imported by child components |

`app.scss` imports the first five via `@use`. Child component SCSS files import `_modal.scss` plus their own component-specific styles.

### Services

| Service | Responsibility |
| --- | --- |
| `InventoryService` | Inventory CRUD, category/coin-set management, spot prices, transactions, persistence |
| `StorageService` | IndexedDB persistence (async get/set keyed by `StorageKeys`) |
| `QuickenImportService` | QIF parser — handles accounts, transactions, denomination inference |
| `CsvService` | CSV parsing, auto-mapping headers, export to CSV/insurance CSV |
| `ImageMatchingService` | Jaccard token similarity matching of filenames to coin names |
| `SpotPriceService` | Fetches COMEX spot prices from `metals.live` API |

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

- Manual spot price entry for gold, silver, platinum, palladium
- One-click fetch from COMEX via metals.live API
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

### CSV import (modal)

- File picker auto-detects headers and maps them to coin fields via fuzzy matching
- Manual mapping adjustment via dropdown per column
- Preview shows parsed rows before import
- Imported coins are marked with `source: 'csv'`

### Image import from directories (modal)

Supports selecting an entire folder (`webkitdirectory`) or individual image files:

1. Images are matched against inventory coin names using Jaccard token similarity
2. Results are classified into three tiers:
   - **Auto-matched** (confidence >= 60%): shown with Confirm/Reject buttons
   - **Needs review** (confidence > 0 but < 60%): shown with a reassignment dropdown
   - **Unmatched** (no match): shown with a manual assignment dropdown
3. Users can confirm, reject, or reassign any match before applying
4. "Apply" reads confirmed files as base64 data URLs and attaches them to the matched coins

### Per-coin image management

- Add images via file picker or drag-and-drop in the detail panel
- Click thumbnails to open a full-screen photo viewer with prev/next navigation
- Delete individual images from the gallery

### Persistence

#### IndexedDB (default: `src/app/services/storage.service.ts`)

All inventory data, column visibility, and category list persist to IndexedDB (not `localStorage`, which caps at ~5-10MB — too small for base64 coin photos). The service exposes a small async `get`/`set` API keyed by `StorageKeys`.

#### SQL Server (optional: `server/`)

A separate Express/TypeScript backend provides a REST API backed by a local SQL Server database. The schema (`server/schema.sql`) includes tables for coins, images, tags, categories, transactions, spot prices, and app settings with proper foreign keys and indexes. Authentication defaults to Windows (trusted connection) for easy local development.

API endpoints: `GET/POST/PUT/DELETE /api/coins`, `/api/categories`, `/api/coinsets`, `/api/transactions`, `/api/spot-prices`, `/api/settings`.

## Tech stack

- Angular 22 (standalone components, signals, `@if`/`@for` control-flow syntax, `inject()`, `output()`)
- TypeScript 6
- SCSS with partials
- Vitest 4.x for unit testing (with `fake-indexeddb` for storage tests)
- Express + mssql (optional SQL Server backend)
- Supertest for Express API testing

## Prerequisites

- Node.js 22.22+ recommended (required for Angular CLI `ng` commands)
- npm 10+
- SQL Server Express (optional, for the `server/` backend — host at 192.168.0.10 or configure in `server/server.ts`)

## Run locally

```powershell
npm install
npm start -- --host 0.0.0.0
```

Then open the local URL shown in the Angular CLI output (commonly `http://localhost:4200`).

**Known issue:** `ng build` / `ng serve` may fail on Windows due to esbuild-wasm's Go WASM binary using POSIX path semantics. A patch that strips the drive letter and converts backslashes has been prototyped but not yet verified. See the esbuild-wasm workaround notes in the project for details.

## Build for production

```powershell
npm run build
```

## Test

```powershell
# Frontend tests (82 tests across 11 files)
npm test

# Server API tests
cd server && npm test
```

**Note:** On Windows, if the project is at a drive root (e.g., `I:\`), the test command uses `--root src` to work around a Vitest 4.x path resolution issue with drive root directories.

---

## Planned next steps

### 1. Fix esbuild/ng serve

The esbuild-wasm Go WASM binary rejects Windows paths. A `__toUnix` patch has been prototyped but needs verification. Until fixed, the app can't be served or built — only tests run.

### 2. Wire up SQL Server backend

Replace IndexedDB persistence with the SQL Server backend for production use. The Express API (`server/server.ts`) is built; the Angular `StorageService` needs to be swapped to HTTP calls. This enables multi-device access, backups, and sharing.

### 3. Certification company logos for PCGS, NGC, and ANACS

The CAC green bean accent is done. Official logos for grading companies were skipped due to trademark concerns. If revisited:
- Would need real logo assets or custom non-trademarked badges
- Data model needs a way to distinguish "raw / not certified" from "certified but certCompany is empty"

### 4. Premium feature research

Research premium coin inventory programs (PCGS CoinFacts, NGC Registry, Numismaster, etc.) and adopt the best ideas that make sense for this application.

### Longer-horizon ideas (not yet scheduled)

- Valuation-service integration (market pricing by denomination/grade)
- Stronger filename normalization for image matching (cert numbers, fuzzy edit-distance)
- "Raw" coin explicit visual state
- Dashboard with charts (value over time, category breakdown)
