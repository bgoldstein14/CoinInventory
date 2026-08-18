# Coin Inventory

A polished Angular coin inventory and valuation application built for coin collectors and dealers. It combines a searchable, sortable inventory table with a detailed per-coin editor, a Quicken (QIF) import workflow, and a filename-based photo matching workflow - all persisted locally in the browser via IndexedDB.

This README doubles as the project's living plan. Keep it current as features land so a future session (human or AI) can resume work from an accurate picture of what exists, why it's built the way it is, and what's next - rather than re-discovering the codebase from scratch.

## Current state (as of this writing)

The application is functional end-to-end: inventory CRUD, Quicken import, image matching, search/filter/sort, and persistence all work and are covered by passing unit tests. The sections below describe what exists today; **Planned next steps** describes what's queued up but not yet built.

## Features

### Inventory management

- Inventory table with a photo thumbnail column, color-coded grade badges (mint/proof, circulated, worn, ungraded tiers), and a certification badge (e.g. "NGC #255481-016") shown inline
- Free-text search across name, denomination, type, country, grade, certification company/number, variety, mint mark, notes, and tags
- Category filter and sortable column headers (click to sort, click again to reverse direction)
- User-configurable column visibility (show/hide any of the tracked fields in the table)
- A detail panel for the selected coin covering every tracked trait: name, grade, category, denomination, country, year, mint mark, variety, certification company, certification number, purchase price, current value, and free-text notes
- Add / delete coins directly from the UI
- Export the full inventory as a downloadable, human-readable JSON file, and re-import a previously exported (or hand-edited) JSON file

### Coin data model (`src/app/types/coin.model.ts`)

Each `CoinRecord` tracks: denomination, year, type, category, country, grade, certification company, certification number, variety, mint mark, composition, purchase date, purchase price, current value, notes, image paths, tags, and a `source` marker (`manual` / `quicken` / `import`) recording how the record entered the inventory.

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

### Image matching (`src/app/services/image-matching.service.ts`)

Filename-token similarity matching (Jaccard-style overlap on normalized filename tokens) against inventory coin names. Produces a confidence score per image; anything below threshold (or with no match at all) surfaces in a manual-review queue where the user picks the correct coin from a dropdown. Unmatched images are listed separately.

### Persistence (`src/app/services/storage.service.ts`)

All inventory data and UI preferences (column visibility) persist to **IndexedDB**, not `localStorage`. This was a deliberate fix: coin photos are stored as base64 data URLs, and `localStorage`'s ~5-10MB per-origin cap would silently fail once a collection accumulates more than a few dozen photographed coins. IndexedDB has no comparable practical ceiling. The service exposes a small async `get`/`set` API keyed by `StorageKeys` so the rest of the app never touches the IndexedDB transaction API directly.

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

All unit tests pass as of this writing (component, both import/matching services, and the storage service).

---

## Planned next steps

The items below are the agreed next round of work. They are ordered roughly by dependency (data model changes first, since the visual work depends on them).

### 1. Certification company logos + "raw" coin support

Goal: replace the current text-only certification badge (e.g. "NGC #255481-016") with the actual grading-company logo/icon, shown on the inventory table row (space permitting) and always on the coin detail panel.

Grading/certification services to support, each needs a small icon/logo asset:

- **PCGS** (Professional Coin Grading Service)
- **NGC** (Numismatic Guaranty Company)
- **ANACS** (oldest US third-party grading service)
- **CAC** (Certified Acceptance Corporation) - note CAC does not grade independently; it "stickers" a coin already graded by PCGS or NGC as meeting a higher quality bar within its stated grade
- **CAC green bean sticker** specifically - a large portion of this collection has CAC-stickered coins, and the green bean deserves its own distinct badge/icon layered alongside (not instead of) the underlying PCGS/NGC badge, since a coin can be e.g. "PCGS MS64 + CAC green bean"
- **Raw / ungraded** - many coins in this collection are NOT in a third-party grading holder at all. This needs its own explicit visual treatment (not just an empty/missing badge), since "raw" is a first-class, common state for a real collection, not an edge case

Data model implications (`coin.model.ts`):

- `certCompany` currently accepts any free-text string. Consider constraining it to a known union (`'PCGS' | 'NGC' | 'ANACS' | 'CAC' | 'Other' | ''`) plus a display fallback for anything typed outside that set, so the badge-rendering logic has a reliable key to match against.
- Add a boolean or enum field to distinguish "raw / not certified" from "certified but the certCompany field is just empty/unset" - right now those two states are indistinguishable in the data, and they need different visual treatment (raw coins should show a clear "Raw" indicator, not just an absent badge).
- Add a separate field for the CAC green bean sticker (e.g. `cacSticker: boolean` or `cacSticker: 'none' | 'green' | 'gold'` if gold-bean support is ever wanted), since it layers on top of an existing PCGS/NGC cert rather than replacing it.

UI implications:

- Source or create small logo/icon assets for PCGS, NGC, ANACS, and CAC (green bean). Likely as SVGs under a new `public/logos/` or `src/assets/logos/` folder, referenced from a small lookup map in the component (e.g. `certCompanyLogo(company: string): string | null`).
- Decide table-row treatment: a small icon-only badge is likely the right call for the table (limited horizontal space), with the fuller text label ( company + number) reserved for the detail panel.
- The detail panel's `.detail-badges` area (already exists) is the natural home for the larger, clearer cert-company logo + CAC green bean badge + grade badge together.
- "Raw" coins need a badge of their own in both places - something like a neutral outline/no-holder icon - so the absence of a cert company reads as an intentional, recognized state rather than a blank spot.

### 2. General visual polish ("add a bit more class")

Raised alongside the logo work as a broader ask - once the grading-company badges land, revisit overall visual polish: refined color palette/typography pass, tighter spacing consistency, and possibly a subtle card-hover/selection treatment beyond the current background-highlight. Treat this as an open-ended follow-up rather than a fixed checklist; specific direction to be defined when the logo work is further along.

### Longer-horizon ideas (not yet scheduled)

Carried over from earlier project notes - still valid, not yet prioritized:

- Real backend/database instead of client-side IndexedDB (would enable multi-device access, backups, sharing)
- Valuation-service integration (e.g. pulling current market pricing by denomination/grade rather than manual entry)
- Stronger filename normalization for image matching (currently pure token-overlap; could incorporate cert numbers embedded in filenames, fuzzy edit-distance, etc.)
- Bulk edit / bulk tagging operations across multiple selected coins
