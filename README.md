# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, an admin-managed category system, a Quicken (QIF) import workflow, and a filename-based photo matching workflow - all persisted locally in the browser via IndexedDB.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next - rather than re-discovering the codebase from scratch.

## Current state (as of this writing)

The application is functional end-to-end: inventory CRUD, category administration, Quicken import, image matching, search/filter/sort, and persistence all work and are covered by passing unit tests. The sections below describe what exists today; **Planned next steps** describes what's queued up but not yet built.

## Features

### Inventory management

- Inventory table with a photo thumbnail column, color-coded grade badges (mint/proof, circulated, worn, ungraded tiers), a certification badge (e.g. "NGC #255481-016"), and a CAC "green bean" accent icon shown inline
- Free-text search across name, denomination, type, country, grade, certification company/number, variety, mint mark, notes, and tags
- Category filter and sortable column headers (click to sort, click again to reverse direction)
- User-configurable column visibility (show/hide any of the tracked fields in the table)
- A detail panel for the selected coin covering every tracked trait: name, grade, category, denomination, country, year, mint mark, variety, certification company, certification number, purchase price, current value, a CAC green bean toggle, and free-text notes
- Add / delete coins directly from the UI
- Export the full inventory as a downloadable, human-readable JSON file, and re-import a previously exported (or hand-edited) JSON file

### Category administration

Category is now a controlled dropdown, not free text, backed by an admin-managed list (`categoryOptions` in `app.ts`, persisted to IndexedDB under `StorageKeys.CategoryOptions`):

- A "Manage categories" panel lets the user add a new category name or remove one from the list. Removing a category does **not** touch coins already assigned to it - they keep their stored value, they just won't see it (or be able to re-pick it) in the dropdown going forward.
- A newly added coin (`addBlankCoin`) defaults to a **blank** category (not a placeholder like "Uncategorized"), same as an ungraded coin has no fake grade.
- **Quicken-imported coins default their category to the Quicken account name they came from** (e.g. "Coin Collection"), not a generic "Imported" label - and that account name is automatically folded into the admin-managed category list so it's immediately selectable for any coin, not just the ones just imported. A record with no account (or the parser's internal "Unassigned" placeholder) gets a blank category, same as a manually added coin.
- Importing a full inventory JSON file similarly folds any categories it contains into the admin list.

### Coin data model (`src/app/types/coin.model.ts`)

Each `CoinRecord` tracks: denomination, year, type, category, country, grade, certification company, certification number, variety, mint mark, composition, purchase date, purchase price, current value, free-text notes, image paths, tags, a `source` marker (`manual` / `quicken` / `import`), and an optional `hasCacSticker` boolean for the CAC green bean accent.

### CAC "green bean" accent

CAC does not grade coins independently - it "stickers" a coin already graded by PCGS/NGC as meeting a tighter quality bar within its stated grade. So `hasCacSticker` is a layered accent on top of `certCompany`/`certNumber`, never a replacement: a coin can be "NGC MS64" **and** carry a green bean at once. The accent image lives at `public/CACGreenBean-trimmed.png` (a user-supplied, pre-trimmed asset - Angular copies everything under `public/` to the built app's root, so the path resolves with no build config changes) and renders in three places: a small inline icon next to the grade badge in the inventory table, a labeled badge in the detail panel's badge row, and a checkbox-plus-icon toggle in the coin editor (`toggleCacSticker()`).

The other four grading companies' own logos (PCGS, NGC, ANACS) were deliberately **not** added as images - see Planned next steps.

### Quicken (QIF) import (`src/app/services/quicken-import.service.ts`)

Parses real Quicken Interchange Format investment-transaction exports - not a guessed format. QIF's investment field codes are single letters with specific, easy-to-misread meanings; this parser follows the actual spec:

| Code | Meaning |
| --- | --- |
| `D` | Date |
| `N` | Action (`Buy`, `Sell`, `ShrsIn`, `ReinvDiv`, ...) |
| `Y` | Security name (where the coin's description lives) |
| `I` | Price per share/unit |
| `Q` | Quantity |
| `T` / `U` | Transaction amount |
| `M` | Memo |
| `O` | Commission |

Behavior:

- Acquisitions (`Buy`, `BuyX`, `ShrsIn`, `ReinvDiv`, etc.) are imported as new coin records
- Dispositions (`Sell`, `SellX`, `ShrsOut`, etc.) are **skipped with a warning** rather than imported as current holdings, since a sale means the coin is no longer in the collection
- Unrecognized action codes are imported but flagged with a warning so the cost basis can be manually verified
- Falls back to price x quantity + commission when no explicit transaction amount is present
- Tolerates comma-formatted amounts (`2,450.00`) and 2-digit years (`93` -> `1993`, `24` -> `2024`)
- Supports multiple `!Account` blocks in one file, with a UI account picker to import only selected accounts
- Best-effort denomination inference from the security name/memo text (half dime, dime, quarter, half dollar, dollar, eagle, double eagle, etc.)
- Each imported coin's Category defaults to its Quicken account name (see Category administration above)

### Image matching (`src/app/services/image-matching.service.ts`)

Filename-token similarity matching (Jaccard-style overlap on normalized filename tokens) against inventory coin names. Produces a confidence score per image; anything below threshold (or with no match at all) surfaces in a manual-review queue where the user picks the correct coin from a dropdown. Unmatched images are listed separately.

### Persistence (`src/app/services/storage.service.ts`)

All inventory data, UI preferences (column visibility), and the admin-managed category list persist to **IndexedDB**, not `localStorage`. This was a deliberate fix: coin photos are stored as base64 data URLs, and `localStorage`'s ~5-10MB per-origin cap would silently fail once a collection accumulates more than a few dozen photographed coins. IndexedDB has no comparable practical ceiling. The service exposes a small async `get`/`set` API keyed by `StorageKeys` (`Inventory`, `VisibleColumns`, `CategoryOptions`) so the rest of the app never touches the IndexedDB transaction API directly.

### Image handling notes

Image-to-data-URL conversion (`app.ts`, `readFileAsDataUrl`) deliberately avoids the browser-only `FileReader` API, which does not exist in the Node-based Vitest test environment this project's tests run under. It instead reads bytes via `File.arrayBuffer()` and encodes them to base64 manually - this works identically in the browser and under Node, so image handling stays unit-testable without a DOM.

## Tech stack

- Angular 22 (standalone components, signals, new `@if`/`@for` control-flow syntax)
- TypeScript
- SCSS
- Vitest for unit testing (with `fake-indexeddb` to exercise the storage service without a real browser)

## Prerequisites

- Node.js 20+ recommended
- npm 10+

## Run locally

```powershell
npm install
npm start -- --host 0.0.0.0
```

Then open the local URL shown in the Angular CLI output (commonly `http://localhost:4200`).

## Build for production

```powershell
npm run build
```

## Test

```powershell
npm test
```

All unit tests pass as of this writing (component - including category-administration and Quicken-category-default coverage - both import/matching services, and the storage service).

---

## Planned next steps

### 1. Certification company logos for PCGS, NGC, and ANACS

The CAC green bean accent is done (see above). The user decided to **skip** adding official logo images for the four grading companies (PCGS/NGC/ANACS were never done; CAC's own wordmark logo was also skipped) because they are registered trademarks and this app is for private use only - the green bean was the one exception, since it has become a widely-recognized, informally-used visual shorthand rather than a strictly-guarded company mark. If this is revisited:

- Would need real logo assets (user-supplied, same as the CAC green bean was) or custom non-trademarked badges (colored monogram/initials) if the app is ever shared or distributed publicly.
- Data model would need a way to distinguish "raw / not certified" from "certified but the certCompany field is just empty" - right now those two states are indistinguishable in the data. This is still an open gap independent of the logo question, since many coins in this collection are raw (not in a graded holder) and currently just show an empty cert badge rather than an explicit "Raw" indicator.

### 2. General visual polish ("add a bit more class")

Raised alongside the logo work as a broader ask - refined color palette/typography pass, tighter spacing consistency, and possibly a subtle card-hover/selection treatment beyond the current background-highlight. Open-ended follow-up, not a fixed checklist.

### Longer-horizon ideas (not yet scheduled)

Carried over from earlier project notes - still valid, not yet prioritized:

- Real backend/database instead of client-side IndexedDB (would enable multi-device access, backups, sharing)
- Valuation-service integration (e.g. pulling current market pricing by denomination/grade rather than manual entry)
- Stronger filename normalization for image matching (currently pure token-overlap; could incorporate cert numbers embedded in filenames, fuzzy edit-distance, etc.)
- Bulk edit / bulk tagging operations across multiple selected coins
- "Raw" coin explicit visual state (see item 1 above)
