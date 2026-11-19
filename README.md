# Coin Inventory

**A complete home for a coin collection: every coin, every photograph, what it
cost, what it's worth, and what you're still hunting for.**

Built for collectors and dealers who have outgrown a spreadsheet. Your data
lives on your own machine — no account, no subscription, no cloud.

---

## What it does

### 📷 Photographs that look after themselves

The feature most collections need most, and the one most software does worst.

- **Point it at a folder and it matches the photos to your coins by filename.**
  Not one at a time — a whole library in one pass. It reads the year, mint
  mark, denomination, grade and grading service out of the names you already
  use.
- **Review before anything is written.** Confident matches, near matches and
  "couldn't tell" are shown separately, with the reason. Nothing is attached
  until you say so, and anything it skipped can still be attached by hand.
- **Obverse, reverse, slab label and retakes of one coin are one set.** The
  set shows as one row with a chip per shot, and answering for one photo
  answers for the rest of its set.
- **Counterfeits are matched too, and kept apart.** A photo named "fake" or
  "counterfeit" only goes to a coin recorded as one, and a plain photo never
  goes to a fake.
- **Many photographs per coin**, with the full-resolution original a click away.
- **Import the same folder again safely** — photos already attached are skipped,
  so adding three new pictures attaches three, not three hundred. You choose
  whether coins that already have photos are left alone, replaced or added to.
- **Keep a copy or just a link.** Store a compact copy of each photo in the
  collection (the default), or record only where the original file lives.

### 🪙 An inventory that fits how you collect

- Sortable, filterable grid; **you choose which columns to show**.
- **Group by any column** — country, grade, set — with a count and value per
  group, in an order you can drag into place.
- Search every field at once.
- Your own categories, sets, denominations, issuers, mint marks and
  catalogues — not a fixed list. Over a thousand world denominations come built in.
- Grading service, certification number and CAC sticker tracked per coin.
- Varieties, mint marks, year ranges and catalogue references ("Sear 6819"),
  including ancients.
- Bulk-edit many coins at once.
- **Record where each coin physically is** — safe deposit box, album, page.
- Fully usable from the keyboard.

### 🔎 A want list, not just a holdings list

Every coin carries a status: **owned · wanted · ordered · for sale · sold**.

- Keep the coins you're hunting for in the same place as the ones you have.
- **Coins you don't have in hand are left out of your collection's value** and
  out of your insurance schedule — so neither ever overstates what's in the house.
- A sold coin keeps its photographs, price and history instead of being deleted.

### 💰 Valuation you can trust

- Purchase price, current value, and gain or loss.
- **Live melt value** from precious-metal spot prices, using each coin's actual
  pure-metal weight. Metal, fineness and weight are filled in for you for
  catalogued coins.
- **It never invents a number.** A coin whose weight isn't recorded shows a
  dash, not `$0.00`, and every total tells you how many coins it had to leave
  out. A blank you can see beats a figure you can't trust.

### 📊 Know your collection at a glance

- Total value, cost and unrealised gain; realised proceeds on what you've sold.
- Breakdowns by denomination, country, grade, category and metal.
- **Pure gold, silver and platinum held**, in grams and troy ounces.
- Cumulative spend over time.

### 🖨️ Reports worth printing

- **An insurance and appraisal schedule — with photographs.** Dated, titled,
  and explaining itself to a reader who has never seen the software.
- A full inventory listing that follows your current filter and prints what
  that filter was.
- CSV, JSON and insurance CSV export.

### 📥 Getting your collection in

- **Excel import.** Drop in a workbook and it maps your columns to its fields
  for you — `Cost`, `Paid`, `Yr`, `Grader`, `Cert #` and dozens more are
  recognised on sight. Anything it isn't sure about it leaves blank for you to
  set rather than guessing.
- **Multiple worksheets at once**, with a warning when their columns don't
  agree — or one sheet at a time if you'd rather.
- **CSV import** through the same screen, with a blank template provided.
- **Quicken (QIF) import** for collections tracked as securities.
- Nothing is created until you've seen a preview and a count.

### 💾 Backup, restore and help

- **Back up the whole collection to one file** while you keep working, and
  restore it on this or another PC. A restore keeps your previous collection
  beside it, so it can be undone.
- **Help → Report a problem** writes a redacted report to your Desktop and
  opens a pre-filled issue. Nothing is sent without you; see
  [what it collects](docs/what-support-collects.md).

---

## Status

Working and in daily use. Today it runs from source — see the setup steps below.

**Coming next:** a single-file Windows installer, so there's nothing to set up
but a folder to install into.

---

## Documentation

| | |
|---|---|
| [How it works](docs/how-it-works.md) | Feature-by-feature reference: what each part does and the rules it follows |
| [Architecture](docs/architecture.md) | How the codebase is put together, and the API |
| [Why the code is the way it is](docs/rationale.md) | The reasoning behind the non-obvious rules |
| [CSV import guide](docs/csv-import-guide.md) | Column reference for importing a spreadsheet |
| [What "Report a problem" collects](docs/what-support-collects.md) | Exactly what a problem report contains |

---

## Tech stack

- Angular 22 (standalone components, signals, `@if`/`@for` control flow, `inject()`, `output()`)
- TypeScript 6 (frontend), TypeScript 5.7 (server)
- SCSS with partials
- Express on Node, with SQLite through Node's built-in `node:sqlite` (no database server, no native build)
- Vitest 4.x (frontend with `fake-indexeddb` and `jsdom` where needed; server against in-memory SQLite)
- Supertest for Express API testing

## Prerequisites

- Node.js 22.22+ (provides `node:sqlite` and is required by the Angular CLI)
- npm 10+

Nothing else: there is no database server to install.

## Where your data lives

The collection is one file:

```
%LOCALAPPDATA%\CoinInventory\coin-inventory.db
```

It is created, with the built-in reference data, the first time the server
starts. It is deliberately not in the project or install folder, so updating or
uninstalling the app never touches it. Back it up from **Settings → Backup and
restore** rather than copying it while the app runs.

UI preferences (columns, filters, the photo folder) live in the browser's
IndexedDB for your normal Edge profile.

## Run locally

```powershell
npm install                     # once, front end
cd server; npm install; cd ..   # once, server
npm start                       # API on :3000 and the Angular dev server on :4200
```

Then open `http://localhost:4200`.

| Command | What it runs |
| --- | --- |
| `npm start` | Both servers (frees ports 3000 and 4200 first) |
| `npm run start:server` | The API only, with reload on change |
| `npm run start:app` | The Angular dev server only |

### The launcher

For everyday use, the launcher in the project root does all of this for you:

| File | What it is |
| --- | --- |
| `launch-coin-inventory.cmd` | **Double-click this.** A wrapper that forwards to `start-coin-inventory.ps1`. Explorer may show it as "launch-coin-inventory" with a gear icon. |
| `start-coin-inventory.ps1` | The real launcher. |
| `run-coin-inventory.ps1` | Started by the launcher; runs `npm start`. Not an entry point. |
| `setup\start-coin-inventory.ps1` | Forwards to the root launcher, so there is only one lock file. |

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

What the launcher does:

- Refuses to start twice (PID lock file `.coin-inventory.lock`; a stale lock is
  cleaned up). Only the launcher creates and removes the lock.
- Runs `npm install` only when `node_modules` is missing.
- Starts both servers and waits until **both** are ready before opening the browser:
  - the Angular dev server on **4200** returns 200, and
  - `GET http://localhost:3000/api/health` returns 200 with
    `{"status":"ok","database":"connected"}`. The body is checked, not just the
    status, because the SPA catch-all answers any unknown GET with `index.html`
    and a 200.
- Opens Edge with your normal profile (so your preferences are there) and stops
  the servers when you close the window.

### Configuration

All optional, set as environment variables (or in `server/.env`):

| Variable | Effect |
| --- | --- |
| `COIN_INVENTORY_DB_PATH` | Use this database file instead (or `:memory:`) |
| `COIN_INVENTORY_DATA_DIR` | Use this folder for `coin-inventory.db` |
| `COIN_LOG_DIR` | Write logs here instead of `server/logs/` |
| `SPOT_PRICE_BASE_URL` | Override the spot-price endpoint |
| `APP_BASE_FOLDER` | Override the install folder reported by `/api/app-info` |
| `SUPPORT_REPO_URL` | GitHub repository that problem reports open an issue on |
| `COIN_SUPPORT_OUTPUT_DIR` | Write problem reports here instead of the Desktop |

## Build for production

```powershell
# Frontend
npm run build

# Server
cd server
npm run build      # tsc -p tsconfig.build.json
npm run typecheck  # tsc --noEmit, type-checks the specs too
npm start          # node dist/server.js
```

- **The bundle lands in `dist/coin-inventory-app/browser/`.** `server.ts`
  serves that folder and sends its `index.html` for every non-API route;
  `server/dist-path.spec.ts` fails if `angular.json` and the server disagree,
  because otherwise the browser just gets an empty page.
- **`npm run build`, `npm run watch` and `npm run start:app` go through
  `scripts/ng-wasm-safe.mjs`.** Where group policy blocks native binaries,
  `esbuild` is overridden to `esbuild-wasm` (see `overrides` in
  `package.json`). Under wasm, esbuild's Windows detection races when Angular
  starts two bundling contexts, failing with `The working directory "...": is
  not an absolute path`. The wrapper runs one tiny esbuild build first, then
  the normal CLI. Running `ng build` directly on such a machine fails; use the
  npm scripts. The wrapper can go when the override does.
- **The server build excludes specs.** `tsconfig.build.json` extends
  `tsconfig.json` but leaves out `**/*.spec.ts` and `test-support/`; compiled
  specs in `dist/` would be picked up by Vitest and fail.
- `server/npm start` runs `dist/`, so rebuild after pulling changes.

### Version number

The displayed version is four-part (`1.0.0.0`). npm accepts only three-part
versions, so `package.json` holds `version` (`1.0.0` until a real release) and
a separate `buildNumber`. `npm run bump-build` increments the build number and
writes it into `src/app/version.ts` (`version.spec.ts` checks they agree). It
is not part of `npm run build`. The version appears in problem reports.

## Test

```powershell
npm test               # frontend
cd server; npm test    # server
```

The frontend suite runs as **`vitest run --root src`**. On Windows, when the
project sits at or near a drive root, Vitest 4.x can find zero test files;
pointing `--root` at `src` avoids it. Use `npm test` rather than a bare
`npx vitest run`.

Server specs sit next to the code they cover and run against a real in-memory
SQLite database built from the real schema and seed. A setup file forces
`COIN_INVENTORY_DB_PATH=':memory:'` for every test and fails any test that
changes it, so tests can never touch your collection.

Most frontend specs run under plain Node, and a component with a required
signal `input()` cannot be built without `TestBed`. So decisions are lifted
out of components into plain classes or pure functions beside them and tested
there (for example `custom-option-mode`, `numeric-field-format`,
`selection-rules`). `numeric-field.ts` (touches a real `<input>`) and
`numeric-field-format.ts` (the arithmetic) are two files for this reason.

## Troubleshooting

**Start here: is the backend alive and can it open the database?**

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health | Select-Object -ExpandProperty Content
```

- `{"status":"ok","database":"connected"}` — backend and database are fine; the
  problem is in the browser or the dev server.
- `{"status":"error","database":"disconnected","message":"..."}` (HTTP 503) —
  the backend is running but could not open the database file. The message and
  the log say why: usually the folder under `%LOCALAPPDATA%\CoinInventory` is
  not writable, or `COIN_INVENTORY_DB_PATH` points somewhere that does not exist.
- Connection refused — the backend is not running. Start it and watch the
  console: `cd server; npx tsx server.ts`.
- HTML instead of JSON — you are hitting the SPA catch-all, so the health route
  is not registered; you are probably running a stale `server/dist/`. Rebuild.

**Check the log.** `server/logs/app-YYYY-MM-DD.log` (one file per UTC day,
5 MB cap, about two weeks kept) holds every API request plus all warnings and
errors, and the Angular app posts its own messages there too, so front end and
back end share one timeline. Fatal errors are written before the process exits.
Every `GET /api/images/file` access is logged with the resolved path.

**Run the backend on its own** to see start-up errors the launcher hides in a
separate window:

```powershell
cd server
npx tsx server.ts
```

You should see `Coin Inventory server listening on http://localhost:3000`.

**"Coin Inventory is already running."** `.coin-inventory.lock` exists and its
PID is alive. If you are sure nothing is running, delete the file and relaunch.

**Start-up times out after 180 seconds.** The launcher prints which side it
was waiting for. If it was the API, check the log.

**Spot prices all come back as $0, or some metals are missing.** The fetch
response carries an `error` message and a `failed` list naming the metals that
could not be retrieved; the log has a `Spot price fetch for <metal>` warning
per symbol. A zero is never stored for a metal that failed.

**A photo's path shows but is not clickable.** That is the *missing* state: the
backend looked for the file and could not read it. It was moved or deleted, or
the path only makes sense on another machine. Paths are resolved by the server
against the host's own drives, so a whole folder of missing entries usually
means the photo folder given at import time was a path from a different PC.
Re-import those photos with the host's own path.

**Every photo's path is plain text with no link.** That is the *unknown* state:
the existence check did not come back, almost always because the backend is
unreachable. Check `/api/health` first.

**The image import refuses to run and names a path that does not exist.** That
is intended. The folder box at the top of the import screen supplies the start
of every stored path; the folder picker cannot, because a browser never reveals
where a file really lives. Correct the box so the example path beneath it
matches where your photos are, then import again.

**After a restore the screen shows the old data.** Press **Reload** in the
restore result; the server has already switched to the restored file.
