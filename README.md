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
  until you say so.
- **Obverse, reverse and retakes are recognised** and grouped per coin.
- **Many photographs per coin**, with the full-resolution original a click away.
- **Import the same folder again safely** — photos already attached are skipped,
  so adding three new pictures attaches three, not three hundred.

### 🪙 An inventory that fits how you collect

- Sortable, filterable grid; **you choose which columns to show**.
- Search every field at once.
- Your own categories, sets, denominations and mint marks — not a fixed list.
- Grading service, certification number and CAC sticker tracked per coin.
- Varieties, mint marks and year ranges, including ancients.
- Bulk-edit many coins at once.
- **Record where each coin physically is** — safe deposit box, album, page.

### 🔎 A want list, not just a holdings list

Every coin carries a status: **owned · wanted · ordered · for sale · sold**.

- Keep the coins you're hunting for in the same place as the ones you have.
- **Coins you don't own are left out of your collection's value** and out of
  your insurance schedule — so neither ever overstates what's in the house.
- A sold coin keeps its photographs, price and history instead of being deleted.

### 💰 Valuation you can trust

- Purchase price, current value, and gain or loss.
- **Live melt value** from precious-metal spot prices, using each coin's actual
  pure-metal weight and fineness.
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
  and explaining itself to a reader who has never seen the software. This is
  the document an insurer actually asks for, and a spreadsheet cannot be it.
- A full inventory listing that follows your current filter and prints what
  that filter was.
- CSV export for anything else you want to do with your data.

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
| [Architecture](docs/architecture.md) | How the codebase is put together |
| [CSV import guide](docs/csv-import-guide.md) | Column reference for importing a spreadsheet |

---

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


So:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-coin-inventory.ps1
```

`setup\start-coin-inventory.ps1` forwards to the root launcher rather than implementing its own. Two launchers with separate lock files would each start a copy of the servers, and the copies would then fight over ports 3000 and 4200.

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

- **Schema changes live in `server/migrations/`**, numbered and safe to run twice. A database built from `server/setup-database.sql` is already current; an older one should have the numbered scripts applied in order.
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
# Frontend — 2,656 tests across 97 files
npm test

# Server — 226 tests across 20 files
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

**Check the log.** `server/logs/app-YYYY-MM-DD.log` — one file per UTC day, capped at 5 MB, about a fortnight kept — holds every API request plus all warnings and errors, and the Angular app posts its own messages there too via `POST /api/log`, so frontend and backend appear in one timeline. Thanks to the `unhandledRejection` / `uncaughtException` handlers in `server/process-safety.ts`, a fatal error is now written to the log; before those handlers existed a crash wrote nothing at all and the log simply stopped mid-session. If you see the log end abruptly with no error line, you are looking at an old crash from before the fix.

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

**No photo shows a path.** The database is missing `CoinImages.SourcePath`. Run the scripts in `server/migrations/` in numerical order against your database.

**The import refuses to run and names a path that does not exist.** That is working as intended. The folder box at the top of the import screen supplies the absolute prefix of every stored path, and the folder you choose in the file picker *cannot* set it — a browser never reveals where a file really lives, only a path relative to what you picked. Correct the box so the example path shown beneath it matches where your photos actually are, then import again.
