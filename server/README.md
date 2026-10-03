# Coin Inventory Server

SQL Server-backed API layer for the Coin Inventory Angular application.

## Prerequisites

- Node.js 22+
- SQL Server Express or a reachable local SQL Server instance
- Windows authentication is the default development path

## Database setup

Use the project SQL setup script to create the database and seed the canonical reference data:

```powershell
sqlcmd -S localhost -d master -E -i .\setup-database.sql
```

This script creates the database, tables, categories, denominations, mint marks, metal contents, and related seed data. It is the authoritative source for database initialization; the app no longer relies on runtime seeding logic.

> **`setup-database.sql` drops every table before it creates them.** It is only for building an empty database. To change the schema of a database that already holds coins, add an idempotent script under `migrations/` instead — see `migrations/003-multiple-images-per-coin.sql` for the pattern.

`setup-database.sql` is also the reference the code is checked against: `db/coin-fields.ts` and `db/bindings.ts` declare an mssql parameter type per column, and `db/coin-fields.spec.ts` asserts they match this script. **If you change a column here, change the binding too.** A parameter declared shorter than its column silently truncates the user's data; one declared longer makes SQL Server raise error 8152 and abort the statement. Both bugs were live before the refactor — `Year` was bound `NVarChar(10)` against an `NVARCHAR(50)` column, the coin-level `Dealer` at 255 against a 200-char column, and `PurchaseDate`/`SoldDate` as `sql.Date` against `NVARCHAR(30)` text columns. **The `Dealer` one is history only — that column no longer exists.** It is kept here because it is the clearest illustration of the mismatch, not because there is anything left to fix; `Coins.Dealer` and its binding are both gone (migration `006`). `Transactions.Dealer` is a *different* column, still present and still bound, as `transactionDealer` in `db/bindings.ts`.

The current shape of `Coins` reflects three recent removals/changes, so do not be surprised by what is absent: there is **no `Coins.Dealer`**, there is **no `CoinTags` table** (the tags feature is gone end to end), and `Weight` and `PmWeightGrams` are **`DECIMAL(12,5)`**, bound as `sql.Decimal(12, 5)` to match.

### Migrations — you must run these on an existing database

> **Current status: `002` and `003` have been applied. `004`, `005`, `006`, `007` and `008` have NOT been run yet.**
>
> Those five are outstanding and are the most actionable item in this file. Nothing is broken while they are pending — the app does not read `CoinTags` or `Coins.Dealer` any more, so both are simply inert — but until each is applied:
>
> - **without `004`**, `Coins.Weight` and `Coins.PmWeightGrams` are still `DECIMAL(10,4)`, so the fifth decimal place the coin editor offers is silently rounded away on save;
> - **without `005`**, the dead `CoinTags` table is still sitting in the database;
> - **without `006`**, the dropped-from-the-code `Coins.Dealer` column (and `IX_Coins_Dealer`) is still there, holding values nothing can read or edit;
> - **without `007`**, most coins still have no `MetalContent`, `Composition`, `PmWeightGrams` or `PmPercent`, so the melt-value column shows a dash for almost the whole inventory;
> - **without `008`**, `Coins.Weight` is still in troy ounces.
>
> **Run `004` before `007`.** `007` writes precious-metal weights, and on an un-widened `DECIMAL(10,4)` column the fifth decimal of each one is rounded away on the way in — the exact bug `004` exists to fix, arriving through a different door. `007` detects this and prints a warning, but it does not stop.

If your `CoinInventory` database already has coins in it, **running `setup-database.sql` is not the upgrade path — it would delete them.** The schema changes live in `server/migrations/` and have to be applied by hand:

| File | What it does |
| --- | --- |
| `002-add-image-source-path.sql` | Adds `CoinImages.SourcePath` |
| `003-multiple-images-per-coin.sql` | Re-adds `SourcePath` if absent, renumbers `SortOrder`, replaces the per-coin index |
| `004-widen-weight-precision.sql` | Widens `Coins.Weight` and `Coins.PmWeightGrams` from `DECIMAL(10,4)` to `DECIMAL(12,5)` so they keep the fifth decimal the editor displays |
| `005-drop-coin-tags.sql` | Removes the `CoinTags` table with the tags feature. **Stops without dropping anything if the table holds rows**, and prints what to do next |
| `006-drop-coin-dealer.sql` | Removes the coin-level dealer field. **The index has to go first:** an index is a persisted, sorted copy of its key, so `IX_Coins_Dealer` physically *contains* `Coins.Dealer`, and SQL Server refuses the `DROP COLUMN` with Msg 5074 while it exists. So the script drops the index, then any default constraint, then the column. **Destroys data by design** — unlike `005` it never refuses; it reports how many dealer values it is about to discard and proceeds, because the owner chose to drop the field unconditionally. Does **not** touch `Transactions.Dealer`, which is a different column and stays |
| `007-infer-coin-metal-data.sql` | Fills in `MetalContent`, `Composition`, `PmWeightGrams` and `PmPercent` for existing coins, inferred from the detail each row already carries. A **data** migration — it changes no column, only values, and only ones that are currently blank. It never overwrites, it prints a full preview (per metal, per *kind of evidence*, and what it is skipping and why) **before** it writes, and it backs every affected row up into `Coins_MetalData_Backup` first. It does **not** touch `Coins.Weight` — that is `008`. See [How `007` knows what a coin is made of](#how-007-knows-what-a-coin-is-made-of) |
| `008-weight-to-grams.sql` | **Reinterprets `Coins.Weight` from troy ounces to grams**, multiplying every stored value by 31.1034768, then derives any still-blank gross weight as `PmWeightGrams / (PmPercent / 100)`. **Must run after `007`**, which is what populates those two inputs. **Not idempotent, and not self-describing:** the column type is identical before and after and no stored value can reveal which unit it is in, so unlike every other script here it cannot guard itself from the system catalog. It writes a marker row into `AppSettings` (`migration-008-weight-grams`) **in the same transaction as the conversion** and skips entirely if it finds one — running it twice would otherwise multiply twice. It snapshots the whole column into `Coins_Weight_TroyOz_Backup` (every row, `NULL`s included) first; the file's header gives the restore statements |

Apply them in order:

```powershell
cd server
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\002-add-image-source-path.sql   # already applied
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\003-multiple-images-per-coin.sql # already applied
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\004-widen-weight-precision.sql   # OUTSTANDING
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\005-drop-coin-tags.sql           # OUTSTANDING
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\006-drop-coin-dealer.sql         # OUTSTANDING
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\007-infer-coin-metal-data.sql    # OUTSTANDING
sqlcmd -S localhost -d CoinInventory -E -i .\migrations\008-weight-to-grams.sql          # OUTSTANDING
```

Re-running `002` and `003` is harmless if you prefer to just paste the whole block — every step is guarded — but only the last five have anything left to do.

**`008` is the one exception to "running it twice is harmless", and it protects itself rather than relying on you.** It rewrites values rather than schema, and multiplying a weight by 31.1034768 twice produces a number that still looks like a weight. Its `AppSettings` marker is the only thing that can tell the two states apart, so **do not delete that row** unless you have genuinely restored the originals from `Coins_Weight_TroyOz_Backup`. Read the file's header before running it.

(Use your real instance name if it is not the default — e.g. `-S "BRUCE_PC\SQLEXPRESS"`. You can also just open each file in SSMS or Azure Data Studio with `CoinInventory` selected and press Execute.)

Every step of every migration is guarded by an existence check, so running one twice is harmless — the second run prints "nothing to do" for each step and changes nothing. In this particular case `003` also adds `002`'s column if it is missing, so running `003` alone is sufficient — but keep the habit of applying them in sequence. **Restart the API server afterwards** so it is not holding a cached query plan built against the old index.

Until `003` is applied you will see two symptoms: the image gallery can return a coin's photos in a different order on each page load, and no photo has a source-file link. The API itself keeps working either way (see the `sourcePath` note under [Coin images](#coin-images-many-photos-per-coin-coinimages)).

### How `007` knows what a coin is made of

`007-infer-coin-metal-data.sql` does **not** contain hand-written numismatic rules. It transcribes the alloy table out of `src/app/services/pm-reference.ts` into a temp table, and then reimplements that file's `resolveEntry` function in SQL: match on denomination and country, prefer the entry whose year range contains the coin's year, fall back to undated entries, and **answer nothing if more than one metal survives**.

Copying the data that way copies the refusals for free. Every case the owner asked to be left alone is an absence or an overlap in `PM_REFERENCE_DATA` rather than a special case in the SQL — the 1942 nickel (no 1942 row), the 1982 cent, the 1971-78 Eisenhower dollar, a bare `$1` in the gold-dollar era (two rows match, one Gold and one Silver), the 1856-57 cent and the 1866-73 five-cent piece. Nobody had to list them.

What the script adds over the in-app backfill is the **metal hint**. `pmFieldsToFill` in `pm-fill.ts` passes a coin's existing `MetalContent` into the lookup to break the gold-dollar/silver-dollar tie and to unhide the 1992+ silver proof issues — but on a coin whose `MetalContent` is blank there is no hint to pass, so the in-app backfill cannot resolve those coins *at all*. `007` derives a hint from the rest of the row (an explicit metal word in the coin type, a design name that only ever existed in one metal, the category) and hands that to the lookup. **So run `007` first, then the Settings backfill** — the script unlocks rows the backfill would otherwise decline forever.

> **`Composition` is nearly empty in the real database, so it is not what classifies most rows.** The column only started being populated recently, on import. Almost everything predating that has it blank for the same reason `MetalContent` is blank. The composition rules are kept because they are the best evidence *when a value is there*, but **denomination, year, coin type and category do nearly all the work.** The script's preview and summary therefore break the result down **by kind of evidence**, so you can see how much of it rests on a denomination and a year versus a category name before you trust several hundred updated rows.

**The duplication is tested, not trusted.** `src/app/services/sql-pm-reference-parity.spec.ts` reads both `pm-reference.ts` and the `.sql` file off disk on every `npm test` run and asserts they agree: same entries in the same order, composition strings character for character, weights to five decimal places, and — via a sweep of every denomination against every year from 1700 to 2030 — that the SQL's *resolution* matches `lookupCoinAlloy`, including everywhere it refuses. One wrong digit turns the suite red. **If you change `pm-reference.ts`, re-run the tests and regenerate the SQL block from the TypeScript rather than hand-patching it.**

A few consequences worth knowing:

- **`PmWeightGrams` and `PmPercent` are expected to lag the other two columns.** A bronze cent has a metal and a composition but genuinely has no precious-metal weight, and writing `0` there would be a recorded fact rather than an absence.
- **Zero counts as a value, not a blank**, for the two numeric columns — matching `isPmFieldBlank` in `pm-fill.ts`. Only `NULL` is refilled.
- **A row whose stored metal contradicts the lookup is skipped entirely** and listed at the end of the run, rather than having a composition written onto it that disagrees with its own metal.
- **A `Category` can narrow the lookup but can never be the whole answer.** `metal-inference.ts` refuses to read the category at all ("a statement about the owner's filing cabinet, not about the coin"); `007` lets it act as a hint, because the reference table then has to corroborate it, but never lets it supply a metal on its own.
- **Undo:** every changed row is copied to `Coins_MetalData_Backup` first, and both the script's own output and its header print the single `UPDATE ... FROM` statement that puts all four columns back.

**Neither `007` nor its output has been executed against a database.** The *data* in it is verified by the parity spec; the *SQL* has never been run. Read the preview it prints before letting it write.

## Configuration

Create or update your `.env` file in the `server` folder with:

```env
# SQL Server connection
DB_SERVER=localhost
DB_PORT=
DB_NAME=CoinInventory

# Leave DB_USER blank for Windows / Integrated authentication
DB_USER=
DB_PASSWORD=

# Port the API listens on
PORT=3000
```

For named instances, use the full server name, such as:

```env
DB_SERVER=BRUCE_PC\SQLEXPRESS
```

`DB_PORT` is optional and normally left empty. A named instance is resolved by SQL Browser, so `db/config.ts` omits `port` from the config entirely when it is not set. It also accepts the SSMS-style `DB_SERVER=localhost,1433` form and splits the port out of it, because some environments persist a comma-suffixed server value.

There are two further, entirely optional variables:

```env
# Override the spot-price provider's base URL (see "Spot prices" below)
SPOT_PRICE_BASE_URL=

# Override the folder GET /api/app-info reports (see "App info" below)
APP_BASE_FOLDER=
```

`APP_BASE_FOLDER` is an escape hatch and is normally left blank. `GET /api/app-info` works out where the app is installed by walking up from its own module until it finds `angular.json`, which is correct both under `tsx` and from a compiled `dist/`. Set this variable only if that answer is wrong for an unusual deployment — the app unpacked somewhere odd, reached through a symlink, or started as a service — in which case give it the absolute path of the folder the app lives in, e.g. `APP_BASE_FOLDER=D:\CoinInventory`. Forward slashes and a trailing separator are tolerated; the value is normalised before it is returned.

`db/config.ts` reads all the `DB_*` variables and is the only place that builds the `sql.config`. It is not, however, the only file that touches `process.env`: `server.ts` reads `PORT` (and `DB_SERVER` / `DB_NAME` again, purely to print them at startup), `routes/data/spot-price-source.ts` reads `SPOT_PRICE_BASE_URL`, and `routes/app-info.ts` reads `APP_BASE_FOLDER`. Nothing else does.

## Running

```powershell
cd server
npm install
npx tsx server.ts
```

The server listens on port 3000 by default.

Normal startup is **`start-coin-inventory.ps1` in the project root** — that is the real launcher, and it starts the backend and the Angular dev server together, waits for both, and opens the browser. `launch-coin-inventory.cmd` (also in the project root) exists only so the launcher can be started by double-clicking in Explorer; it does nothing but invoke that `.ps1` and keep the window open if it fails. See `setup/README.md` for the full list of entry points.

Run `tsx` directly, as above, when you want to see the backend's startup errors in your own console.

Scripts:

| Script | What it does |
| --- | --- |
| `npm run dev` | `tsx watch server.ts` — what the launcher uses |
| `npm start` | `node dist/server.js` — requires a build first |
| `npm run build` | `tsc -p tsconfig.build.json` |
| `npm run typecheck` | `tsc --noEmit` — type-checks the specs too |
| `npm test` | `vitest run` |

`build` uses `tsconfig.build.json` rather than `tsconfig.json`, because that config excludes `**/*.spec.ts` and `test-support/`. `tsconfig.json` includes everything on purpose so `typecheck` covers the tests, but compiled tests must never land in `dist/`: Vitest discovers them and fails with "Vitest cannot be imported in a CommonJS module using require()".

**A stale `dist/` is dangerous.** `npm start` runs `node dist/server.js`, so a `dist/` built before the connection-pool fix will silently run the old crashing code. If the old symptoms come back, delete `dist/` and rebuild.

## Layout

`server.ts` is wiring only — middleware, static files, route mounting, the SPA fallback, and the global error handler.

| Path | Contents |
| --- | --- |
| `db/index.ts` | Barrel, and the written-up story of the crash. **Read this first.** |
| `db/pool.ts` | `getPool` / `resetPool` / `withDb`. The most important file in the backend. |
| `db/config.ts` | Builds the `sql.config` from `.env` |
| `db/errors.ts` | `isConnectionError` / `sqlErrorNumber` |
| `db/coin-fields.ts` | `COIN_FIELDS` — the Coins column map (types, max lengths, normalizers) |
| `db/bindings.ts` | `DB_BINDINGS` — parameter types for every other table |
| `db/value-normalizers.ts` | JSON value to SQL parameter value helpers |
| `db/row-mappers.ts` | SQL row to JSON for the Angular app |
| `routes/health.ts` | `GET /api/health` |
| `routes/app-info.ts` | `GET /api/app-info` — where the app is installed on the host |
| `routes/coins/` | `index`, `reads`, `list-query`, `writes`, `write-helpers`, `images`, `image-payload` — mounted at `/api/coins` |
| `routes/lookups/` | `categories`, `coin-sets`, `denominations`, `metal-contents`, `mint-marks` — mounted at `/api` |
| `routes/data/` | `index`, `transactions`, `spot-prices`, `spot-price-source`, `settings`, `frontend-log` — mounted at `/api` |
| `routes/images/` | `file`, `exists`, `allowed-types` — serving the ORIGINAL image files off disk, mounted at `/api/images` |
| `routes/db-error-response.ts` | SQL error to HTTP status translation |
| `routes/error-handler.ts` | The app-wide Express error handler (honours `err.status`, so a 413 stays a 413) |
| `routes/param-utils.ts` | Shared request-parameter helpers |
| `migrations/` | Idempotent schema changes for a database that already has data in it |
| `process-safety.ts` | `unhandledRejection` / `uncaughtException` handlers |
| `logger.ts` | Appends timestamped lines to `logs/app.log` |
| `test-support/mssql-mock.ts` | The shared mssql mock used by every spec |

## The connection pool (read before changing `db/pool.ts`)

The backend used to die, roughly once per session, in a way that looked like a database problem. It was not.

1. `mssql`'s `ConnectionPool` is a Node `EventEmitter`.
2. When SQL Server drops or errors an idle pooled connection, mssql calls `pool.emit('error', err)`.
3. An `EventEmitter` with **zero** `'error'` listeners *throws* when you emit `'error'` on it. That throw happened inside a tedious socket callback, so nothing caught it — uncaught exception, process gone.

The old `db.ts` never attached that listener. The visible symptom was: pause for a while, edit a coin, get "Failed to update coin", refresh the browser and it still fails because the *server* is gone, restart the app and everything works. Nothing appeared in `app.log` because the process died before any logging ran.

The fix is the `pool.on('error', ...)` listener in `createPooledConnection()` in `db/pool.ts`, attached **before** `connect()` is called so there is never a window with no listener. Everything else in the layer exists to make recovery cheap and safe:

- **Single-flight connect** — the Angular app fires about seven API calls in parallel on load. Without the guard each one saw "no pool" and opened a competing one.
- **Generation counter** — every pool gets an increasing id and callers remember theirs, so a request failing at 10:00:05 cannot destroy a healthy pool created at 10:00:04.
- **No per-request `SELECT 1`** — the old health check halved throughput and could close the pool mid-query for other requests.
- **`withDb()` retries once, and only for connection-class errors.**

Two rules follow from this:

- Nothing outside `db/pool.ts` may construct a `ConnectionPool`.
- **No route handler may call `resetPool()`.** The old `routes/coins.ts` called it in every `catch`, so an ordinary validation error tore down the shared pool and broke every other in-flight request. Route code uses `withDb()` and lets ordinary query errors propagate.

`db/connection.spec.ts` carries the regression test: it emits `'error'` on the pool and asserts the process survives.

## Health endpoint

`GET /api/health` is the launcher's readiness probe. It runs a `SELECT 1` and reports:

```
200  { "status": "ok",    "database": "connected" }
503  { "status": "error", "database": "disconnected", "message": "..." }
```

The launcher polls this in a loop and checks the **body**, not just the status code, because the SPA catch-all (`app.get('*')`) returns `index.html` with a 200 for any unmatched GET. **The response shape is part of that contract — do not change it without updating `start-coin-inventory.ps1`.** The route is mounted before the others so it is registered first.

This is also the first thing to check by hand when something is wrong:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/health | Select-Object -ExpandProperty Content
```

## App info

`GET /api/app-info` reports the folder this app is installed in:

```
200  { "appFolder": "D:\\CoinInventory", "source": "module" }
```

It exists for one screen: the batch image import has to ask the user for the absolute folder their coin photos live in, because a browser never reveals a file's real location (it gives only `File.webkitRelativePath`, the path relative to the folder that was picked). That box used to be prefilled with the UNC path the photo library is reachable at from a developer workstation, which was wrong on the host — the host keeps the photos on a local drive. It is now prefilled with this endpoint's answer: not where the photos are, but a real path on the right machine with a drive letter that machine really has, which the user edits once and which is then remembered in their app settings.

Resolution order, most explicit first:

1. `APP_BASE_FOLDER` if set (see [Configuration](#configuration)) — `source: "env"`.
2. The project root, found by walking up from the module until a directory contains `angular.json` — `source: "module"`. **This is why the marker search exists rather than a fixed `../..`:** the file runs from `server/routes` under `tsx` and from `server/dist/routes` when compiled, so any fixed number of levels is wrong in one of the two. `angular.json` is the marker because it exists at the root and *not* in `server/`, unlike `package.json`.
3. `process.cwd()` — `source: "cwd"`. Last resort, and weaker than it looks: the launcher starts the backend from `server/`, so this answers one folder too deep. It also writes a warning to `app.log`.

Like `/api/images`, this route **never touches the database**, so it keeps answering when SQL Server does not. The import screen must open in a half-broken state, and a cosmetic default is not worth failing a page load over. On the frontend side `ApiService.getAppFolder()` maps every failure to `''`, which simply leaves the box empty and its existing warning showing.

## Logging

`logger.ts` appends timestamped lines to `logs/app.log` (synchronously, so writes are ordered) and echoes to the console. Every `/api` request is logged, along with all warnings and errors.

`POST /api/log` lets the Angular app write into the same file, so frontend and backend messages appear in one timeline. It always returns 204 and never fails the caller.

`process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load. They log the full message and stack and deliberately keep the process running. They are a diagnostic backstop, not a substitute for handling errors properly — the real fix for the crash above is the pool `'error'` listener. Before these handlers existed, a crash wrote nothing at all; if you find a log that just stops mid-session with no error line, that is what you are looking at.

## Tests

```powershell
cd server
npm test
```

154 tests across 16 files (verified by running `npx vitest run` in `server/` — it takes about two seconds). Specs sit next to the code they cover, and all sixteen are listed here:

| Spec | Covers |
| --- | --- |
| `server.spec.ts` | App wiring and the health endpoint |
| `db/connection.spec.ts` | Config, pool lifecycle, the crash regression, `withDb` |
| `db/coin-fields.spec.ts` | `COIN_FIELDS` against `setup-database.sql` |
| `routes/app-info.spec.ts` | `GET /api/app-info` — `normaliseWindowsPath`, the `APP_BASE_FOLDER` override, that the marker walk finds the project root from either depth, and that the route never touches the database |
| `routes/coins/reads.spec.ts` | `GET /api/coins` |
| `routes/coins/list-query.spec.ts` | `imageCount`, the `includeImages=false` switch, and `shouldIncludeImages()` |
| `routes/coins/writes.spec.ts` | `POST` / `PUT` / `DELETE /api/coins`, `imagePaths` + `SourcePath` |
| `routes/coins/images.spec.ts` | `GET /api/coins/:id/images`, including `sourcePath` |
| `routes/coins/images-post.spec.ts` | `POST /api/coins/:id/images` — `sourcePath` round trip, legacy string form, batch rollback |
| `routes/coins/image-payload.spec.ts` | The legacy-string vs `{ imageData, sourcePath }` normalizer |
| `routes/images/images.spec.ts` | `/api/images/file` and `/api/images/exists` (uses a real temp directory) |
| `routes/lookups/lookups.spec.ts` | `/api/categories`, `/api/mintmarks`, and friends |
| `routes/data/data.spec.ts` | `/api/transactions`, `/api/spot-prices`, `/api/settings` |
| `routes/data/spot-price-source.spec.ts` | `fetchSpotPrices()` — the copper per-pound conversion, and that a missing price fails rather than becoming 0 |
| `routes/db-error-response.spec.ts` | SQL error to HTTP status translation |
| `routes/error-handler.spec.ts` | Oversized uploads report 413, not 500 |

They all mock `mssql` through `test-support/mssql-mock.ts`, so no database is needed to run them. `routes/images/images.spec.ts` is the one exception to "no I/O": it writes fixture files into an OS temp directory (created in `beforeAll`, removed in `afterAll`), because whether a file is on disk is exactly what it tests.

## Coin images: many photos per coin (`CoinImages`)

This is the part of the schema most worth understanding before you touch anything image-related, so it is written up here as well as in the comment block above `CREATE TABLE CoinImages` in `setup-database.sql`.

**One ROW per photo, not one column per photo.** `CoinImages` has been a child table since the baseline schema: each photo gets its own `ImageId` identity and points back at its coin through `CoinId`. A coin with ten photos is ten rows sharing one `CoinId`. There is deliberately **no limit** on how many a coin may have, and nothing about the design changes between one photo and twenty — there is no single-image column to widen and no one-image-per-coin constraint to remove. "Multiple pictures per coin" was never a feature to add; it is just what a child table does.

In practice the photo library holds 8-10 files for a typical coin: obverse and reverse, the slab label, plus derivative renderings (Small / Orig / Sharpened) and the occasional retake.

| Column | Purpose |
| --- | --- |
| `ImageId` | `IDENTITY` primary key. This is what `DELETE /api/coins/:id/images/:imageId` takes. |
| `CoinId` | Owning coin. `ON DELETE CASCADE`, so deleting a coin deletes its photos rather than orphaning them. |
| `ImageData` | A **downscaled** base64 data URL, sized for display. |
| `SortOrder` | Zero-based position within *this coin's* photos. |
| `SourcePath` | Absolute path of the original full-resolution file **on the host machine**, with a drive letter (not a UNC path) — see [Stored paths must be valid on the HOST](#stored-paths-must-be-valid-on-the-host-with-a-drive-letter). Nullable. |

### `SortOrder` is the only thing deciding display order

The app always reads images as `WHERE CoinId = @id ORDER BY SortOrder`, so that column is the entire ordering mechanism. New inserts assign `MAX(SortOrder) + 1` (see `routes/coins/images.ts`), which is read *inside* the transaction so a concurrent insert cannot invalidate it.

**The latent bug migration 003 fixes.** Nothing ever stopped two photos of the same coin sharing a `SortOrder`. The column defaults to 0 and older insert paths did not always assign one, so a coin can easily hold several rows all claiming position 0. `ORDER BY SortOrder` then leaves their relative order entirely up to the query plan. With one or two photos per coin this was invisible. With eight it is not: the gallery is free to show Reverse first today and Obverse first tomorrow, and the user sees photos that "move around by themselves".

`003` renumbers each coin's photos 0, 1, 2, … using `ROW_NUMBER() OVER (PARTITION BY CoinId ORDER BY SortOrder, ImageId) - 1`. The two-part sort is the important detail:

- **`SortOrder` first** preserves every ordering choice that was already unambiguous — photos deliberately placed at 0, 1, 2 keep those positions and are not rewritten at all.
- **`ImageId` second** only breaks ties among rows that already collided, and because it is an ascending identity it resolves them to *insertion order*: the photo added first stays first. That is both the least surprising outcome and a stable one, so a second run produces identical numbering.

The `UPDATE` is filtered by `WHERE SortOrder <> NewOrder`, so on an already-correct database zero rows are written. The script prints how many rows it renumbered, which is genuinely useful: 0 means ordering was already sound, and a large number explains any shuffling you had noticed.

### The index changed

`IX_CoinImages_CoinId` became **`IX_CoinImages_CoinId_SortOrder`**. The old index got the engine to the right rows but said nothing about their order, so the plan had to sort them after fetching. With `(CoinId, SortOrder)` the rows come off the index already in display order and the sort step disappears from the plan entirely. Barely measurable at two rows per coin; worth having at ten across a few thousand coins.

The new index is created *before* the old one is dropped, so there is never a moment when `CoinId` lookups have no index. Dropping the old one is safe because `CoinId` is the leading column of the replacement — anything the narrow index could answer, the wider one answers too — and keeping both would only add write cost on every photo inserted or deleted.

### Why there is no unique index on `(CoinId, SourcePath)`

It is tempting: it would stop the same file being attached to one coin twice. It was considered and deliberately rejected, and the reasoning is written into `003` itself so it does not get "fixed" later.

A `UNIQUE` constraint turns any duplicate that slips through into a hard SQL error. Because the image insert runs as **one transaction**, a single duplicate would abort the entire batch — a 200-photo import failing at file 150 and rolling all of it back. Silently re-attaching one photo is a far smaller problem than that. The import already de-duplicates on the client; if server-side de-duplication is wanted, it belongs in the **insert logic**, where a duplicate can be skipped without killing the batch.

### `sourcePath` is `null`, never `""` — that is an API contract

`GET /api/coins/:id/images` maps each row with `?? null`:

```ts
sourcePath: (row['SourcePath'] as string | null | undefined) ?? null,
```

That normalisation covers two separate cases — SQL `NULL`, and a driver that omits the column entirely (which is what happens against a database where migration 002/003 has not been run yet) — and collapses both to JSON `null`. **Do not "simplify" this to an empty string or to omitting the key.** The frontend distinguishes three states and needs them kept apart:

1. **no path recorded** — `sourcePath` is `null`; there is nothing to link to.
2. **path recorded but the file is missing** — a path came back, but `POST /api/images/exists` said `false`; the link is shown greyed out.
3. **could not check** — the existence probe itself failed; neither of the above can be asserted.

An empty string would collapse (1) into a falsy-but-present path, and a missing key would make (1) and (3) indistinguishable. The key is always present and is either a non-empty string or `null`.

## Original image files (`/api/images`)

`CoinImages.ImageData` holds a downscaled base64 copy of each photo — that is what the app displays. `CoinImages.SourcePath` records where the **original** full-resolution file (up to ~46 MB) lives on the machine hosting the app, so the UI can show the user the file's location and offer a link that opens the real photo. It is nullable: every image imported before the column existed has no known path, and those rows keep working.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/images/file?path=<absolute path>` | Streams the original file with a `Content-Type` from its extension. 404 if it is gone, 400 if `path` is missing or is not an allowed image type. |
| `POST /api/images/exists` | `{ paths: string[] }` in, `{ results: { [path]: boolean } }` out. One request per coin, not one per image. Capped at 500 paths. |

### Stored paths must be valid on the HOST, with a drive letter

Both endpoints above resolve `path` against the filesystem of **the machine running the server process**, not the machine running the browser. `SourcePath` is therefore a host path, and on the host the photo library sits on a **local drive under a drive letter** — something like:

```
D:\Coin Pictures\1921-morgan-obverse.jpg
```

That is an **illustrative example, not a configured value.** The actual drive letter is whatever the host happens to use, and is deliberately not fixed anywhere in this README.

**Use drive letters, not UNC paths.** If you have seen the photo library referred to as `\\<server>\Coin Pictures`, that is the *development-time* location — how the pictures are reachable over the network from a developer's workstation. It is not how the app addresses them. The host reads them from its own local disk.

**The failure mode this causes, which is the one someone will actually hit:** a database populated with paths that are only valid on a *different* machine will report **every single image as missing**. There is no error and nothing in the log to suggest a configuration problem — the links simply all come back greyed out. That is because `POST /api/images/exists` is answered by the host's filesystem, so a path that resolves perfectly on the workstation that did the import is just a non-existent file as far as the host is concerned. If every image reports missing at once, suspect the paths before you suspect the endpoint: read one `SourcePath` out of `CoinImages` and check whether that exact string exists on the host.

Note that this only affects the *link to the original file*. `ImageData` is a self-contained base64 copy stored in the database, so the photos themselves still display normally — which is exactly why the problem can go unnoticed.

**Why the backend has to serve the file at all:** Chrome and Edge refuse to navigate from an `http` page to a `file://` URL — the click is dropped silently, with no error and no tab. So the link has to point at an `http` origin, and the Express server is already running on the machine that has the file.

**The security tradeoff, stated plainly:** `GET /api/images/file` will read any file on the host whose name ends in an image extension. There is no root directory it is confined to, because the whole point is that the user's pictures live wherever he put them. That is acceptable for a single-user app on its owner's own PC and nowhere else. What it does do: restrict to the extension allowlist in `routes/images/allowed-types.ts` (so it cannot read `.env`, `app.log` or source), and log every access. **If this app is ever exposed beyond localhost, this route is the first thing to lock down.**

It streams with `fs.createReadStream().pipe(res)` rather than `fs.readFile()` — a 46 MB original read into the heap first would be slow to first byte, and several concurrent clicks could push the process into an out-of-memory kill.

## Spot prices (`routes/data/spot-price-source.ts`)

This is the **only outbound HTTP call in the whole backend**, which is why it gets its own file and its own section.

**Why it was rewritten.** The old implementation called `https://api.metals.live/v1/spot`. That free API has been discontinued — the hostname still resolves (to a CloudFront address) but the TLS connection is refused, so every fetch failed. The route deliberately answers 200 with zeroed prices on failure, so nothing surfaced as an error: the prices simply stayed at $0 forever. That is what the user experienced as "the COMEX PM prices fetch does not work". **A silent zero is the worst possible failure mode here, and avoiding it is the design principle of this file.**

**What it reads now.** COMEX/NYMEX front-month futures, which is precisely what "COMEX prices" means, from an endpoint that needs no API key or signup:

| Symbol | Metal | Exchange |
| --- | --- | --- |
| `GC=F` | Gold | COMEX |
| `SI=F` | Silver | COMEX |
| `PL=F` | Platinum | NYMEX |
| `HG=F` | Copper | COMEX |

Each symbol is fetched independently and concurrently, with a 10-second timeout, so one dead symbol cannot take the other three down with it.

**Copper is quoted per POUND, not per troy ounce.** Gold, silver and platinum come back in dollars per troy ounce; `HG` comes back in dollars per pound. The conversion constant lives in this file:

```ts
const TROY_OUNCES_PER_POUND = 453.59237 / 31.1034768;   // ≈ 14.5833
```

The frontend's melt-value calculation (`inventory-metrics.ts`) divides a coin's gram weight by 31.1035 and multiplies by the spot price — i.e. it assumes *every* price is per troy ounce. Storing copper per pound therefore overstates copper melt values by a factor of about **14.58x**. The conversion is done here, at the single point where the unit is actually known, rather than being left to callers. Copper also gets rounded to four decimal places instead of two, because per troy ounce it works out to well under a dollar.

**A missing price is a FAILURE, and is never stored as 0.** If `regularMarketPrice` is absent, non-numeric, non-finite, or `<= 0`, the metal is treated as failed:

- `fetchSpotPrices()` returns `{ prices, source, failed }`, where `failed` lists the metals it could not retrieve.
- `GET /api/spot-prices/fetch` adds `error` and `failed` keys to its JSON **only** when something went wrong, so existing callers that just check for `error` keep working. The caller can then tell the user *which* metals are missing instead of presenting a zero as though it were a real price.

**The base URL is overridable**, via the `SPOT_PRICE_BASE_URL` environment variable:

```ts
const BASE_URL =
  process.env['SPOT_PRICE_BASE_URL'] ?? 'https://query1.finance.yahoo.com/v8/finance/chart';
```

That exists for two reasons: the upstream endpoint is undocumented and could be swapped without a code change, and — more usefully day to day — it is what makes `routes/data/spot-price-source.spec.ts` able to test the whole path (unit conversion, failure handling, partial success) against a local stub instead of hitting the live internet.

One further quirk worth knowing: the request sends an explicit `User-Agent` header, because the upstream endpoint rejects requests that have no recognisable one.

## Notes

- Categories, denominations, mint marks, and metal contents are loaded from SQL and kept in sync with the app.
- Start the frontend and backend through the project launcher when possible — `start-coin-inventory.ps1` in the project root, or double-click `launch-coin-inventory.cmd` next to it, which just forwards to that script. Use the direct `tsx` command for troubleshooting or manual startup.
