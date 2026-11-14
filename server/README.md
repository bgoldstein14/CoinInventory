# Coin Inventory Server

SQLite-backed API layer for the Coin Inventory Angular application.

## Prerequisites

- Node.js 22+. The driver is `node:sqlite`, which is core from Node 22, so there is no native module, nothing for a rebuild step to do, and `npm install` needs no C++ toolchain — which is the reason it was chosen on a machine where native builds are blocked by group policy. See `db/driver.ts`.
- Nothing else. There is no database server to install, no Windows service, and nothing running in the background.

## The database

**There is no setup step.** `db/pool.ts` opens the file the first time something asks for it, applies `db/schema.sql` — every statement is `CREATE ... IF NOT EXISTS`, so opening an existing database is a no-op and opening a new one builds it — and then runs `db/seed.ts`. A fresh install creates its own database; an existing one is left alone. Read `db/index.ts` first: it is the written-up story of the whole layer.

The seed runs on **every** open, so it has to be safe a thousand times. Every insert is guarded on the row not already being there, and nothing is ever UPDATEd or DELETEd. That is what keeps the three states a user can create: a row he edited keeps the edit rather than being reset to the seed, a row he soft-deleted (`IsActive = 0`) stays deleted rather than being resurrected on next launch — the bug a naive `INSERT OR REPLACE` would introduce — and a row he added himself is never touched.

### Where the data file lives, and why it is not in the install directory

```
Program Files\Coin Inventory\     the application. Chosen at install.
%LOCALAPPDATA%\CoinInventory\     the database. Not chosen, not asked.
```

Design §4.10a. The first reason is a Windows constraint rather than a preference: **`Program Files` is not writable by a standard user account without elevation**, so a SQLite file there would fail to open for writing on an ordinary run — and it would fail *intermittently*, because an admin install followed by a standard-user launch is exactly the common case. The second is that §4.7's rule "uninstall must not remove the collection silently" becomes structurally true when the uninstaller's target directory simply does not contain the data.

`db/config.ts` is the only file that answers the question, and it reads two variables:

| Variable | Effect |
| --- | --- |
| `COIN_INVENTORY_DB_PATH` | Absolute path to the database file, or `:memory:`. Read **first**, before any platform logic, so it overrides everything |
| `COIN_INVENTORY_DATA_DIR` | Directory to put the default `coin-inventory.db` in, for "two collections side by side" without having to know the file name |

`COIN_INVENTORY_DB_PATH` is not a convenience. `test-support/sqlite-test-db.ts` sets it to `:memory:` as that module loads, before `db/config.ts` is ever asked where the file is, because **every spec now runs against a real database** and a suite that resolved the production path would truncate the owner's collection on every `npm test`.

The resolved path is logged at startup. That line is the quickest answer both to "where is my collection?" and to "why is this one empty?".

### How numbers are stored (`DECIMAL` became `REAL`)

SQLite has no fixed-point type. The six quantity columns on `Coins`, plus the four `SpotPrices` columns and `Denominations.FaceValue`, are **`REAL`** — IEEE-754 binary64. **The full argument, including why scaled `INTEGER` and `TEXT` were rejected, is in the header of `db/schema.sql`; read it before changing anything numeric.** The short version is that `tedious` handed a `DECIMAL` column to JavaScript as a `number`, so every value this application has ever read or written was already a double, and `REAL` stores a double bit-for-bit.

What `REAL` does not reproduce on its own is SQL Server's behaviour at the parameter boundary: it **rounded** a value to the column's scale on the way in, and **refused** one too large for its precision. Both are reapplied by `db/bind-values.ts`, driven by the precision and scale recorded in `db/column-types.ts` — which is why the type table was re-expressed rather than deleted when SQL Server went away. Without it the identical HTTP request would store a different number than it used to.

`db/numeric-storage.spec.ts` is the test, and it exists instead of a comment because **a wrong weight is indistinguishable from a right one.** Both 0.7734 and 24.05582 are plausible for a Morgan dollar, so neither the UI, nor the melt-value calculation, nor the owner looking at the screen can detect that a number went through a lossy step. There is no symptom; the only defence is comparing the number out against the number in.

### Text comparison is case-insensitive on purpose

SQL Server's collation on this database was case-**in**sensitive. SQLite's default is `BINARY`, which is case-**sensitive**, so translating the schema without saying anything would have changed the meaning of every text comparison and every `ORDER BY` in the application, quietly: `DELETE FROM Categories WHERE CategoryName = 'gold'` would stop deleting the row called `Gold`, a coin filed under `morgan set` would stop matching the set called `Morgan Set` and the usage count on the maintenance screen would read 0 as "safe to delete".

So every text column that is compared, grouped or ordered against another text value carries `COLLATE NOCASE`, and the ones that are pure payload do not — `Notes`, `CertNumber`, `CatalogNumber`, `StorageLocation`, `ImageData`, `SourcePath` and the two id columns. **`CatalogNumber` in particular must stay `BINARY`:** it is a key into a printed book, and `Ia` is not `1A`. The full list of what would otherwise have broken, and the one thing `NOCASE` does *not* do (it folds A–Z only, not accents), is in `db/schema.sql`'s header.

### `db/schema.sql` is the reference the bindings are checked against

`db/coin-fields.ts` and `db/bindings.ts` declare a parameter type per column, and the parity specs — `db/coin-fields.spec.ts`, `db/catalog-columns.spec.ts`, `db/coin-status-columns.spec.ts`, `db/denomination-column.spec.ts`, `db/schema.spec.ts` — read `db/schema.sql` off disk and fail the build when the two disagree. **If you change a column there, change the binding too.**

**That check got more important when the engine became SQLite, not less.** Under SQL Server the declared widths were a second opinion: the column enforced them, and a binding that disagreed produced either silent truncation (bound shorter) or error 8152 (bound longer). Either way the database had the last word. SQLite has no opinion at all — a column `COIN_FIELDS` calls `NVarChar(50)` will hold four thousand characters without complaint. The binding table is now the only thing enforcing a width, through `db/bind-values.ts`, so a drift is not a disagreement any more, it is a hole.

Writing `NVARCHAR(50)` as a SQLite column type would parse and enforce nothing, which is worse than useless because the next reader would believe it. The declared width therefore lives in `db/schema.sql` as a trailing comment, which is honest about what SQLite stores while keeping the intent machine-readable:

```sql
Grade               TEXT        NULL     COLLATE NOCASE,   -- NVARCHAR(50)
Weight              REAL        NULL,                      -- DECIMAL(12,5)
```

`test-support/schema-columns.ts` is the single parser for that format, so a change to the convention breaks in one place rather than five. **Keep the comment format.**

One behaviour deliberately changed in the move. `mssql` trimmed an over-long value to the declared length before sending it and told nobody; `db/bind-values.ts` raises the 8152 equivalent instead, which `routes/db-error-response.ts` already turns into an HTTP 400. Silently storing three quarters of a user's note is worse than refusing it — a refused value can be retyped, a truncated one cannot be recovered.

The current shape of `Coins` reflects some removals, so do not be surprised by what is absent: there is **no `Dealer` column anywhere** (migration `006` dropped `Coins.Dealer`; `Transactions.Dealer` outlived it until the whole `Transactions` table was dropped on 2026-11-14), and there is **no `CoinTags` table**, the tags feature having gone end to end. The deal's counterparty is now two columns on `Coins`, `PurchasedFrom` and `SoldTo`, alongside `TransactionNotes` — which is **not** `Coins.Notes` and must never be merged with it. `Weight` and `PmWeightGrams` are **grams**, declared `DECIMAL(12,5)` and stored as `REAL`.

## `migrations/` and `setup-database.sql` are SQL SERVER history

> **Nothing here is replayed against SQLite and nothing here runs at install
> time.** `server/migrations/*.sql` and `server/setup-database.sql` describe
> the owner's SQL Server database, which still holds his collection. They are
> kept in the tree for two reasons: they are the only surviving description of
> the schema **Stage 2's one-time import has to read**, and `db/schema.sql`
> refers back to `setup-database.sql` for *why* each column exists rather than
> repeating it. `setup-database.sql` carries the same warning at the top of the
> file itself.

`db/schema.sql` is their **destination**, not their replacement: it is the twelve tables with migrations 002 through 014 already applied, written as SQLite DDL. **Do not edit `setup-database.sql` or add a migration to match a schema change** — a new column goes in `db/schema.sql`.

`db/schema.ts` applies that file and is deliberately **not** a migration runner. A SQLite database will need its own migrations eventually, when a release changes the schema under a user who already has a collection; the right shape is `PRAGMA user_version` plus numbered steps, and the right time to build it is when there is a first one to write — not speculatively, against a schema no user has yet.

The scripts are summarised below because several of them record decisions that are still load-bearing, and because the Stage 2 author has to understand what each one did to the source data. `010` through `014` are not tabulated: they add `Coins.CollectionStatus` and `StorageLocation` (`010`), the `Issuers` table with `Denominations.IssuerId` / `FaceValue` and `Coins.DenominationId` (`011`), the `Catalogs` table with `Coins.CatalogId` / `CatalogNumber` (`012`), the 70 issuers and 1,207 denominations of the seed (`013`), and the resolved coin-to-denomination links (`014`). The schema changes are already in `db/schema.sql`; `013`'s rows are produced by `db/seed.ts` from the same JSON; `014` was a one-off data fix against rows that already existed and has no counterpart here.

**One consequence of re-seeding that Stage 2 must handle, recorded here so it is not discovered:** because the reference data is regenerated rather than migrated, `DenominationId` and `CatalogId` on this side are **not the same numbers** as on the owner's SQL Server. His `Coins.DenominationId` has to be re-resolved by (issuer name, label) during the import; copying the integer across would attach his Morgan dollars to whatever happens to occupy that id here. `db/seed.ts`'s header says the same thing at the one place that could cause it.

| File | What it does |
| --- | --- |
| `002-add-image-source-path.sql` | Adds `CoinImages.SourcePath` |
| `003-multiple-images-per-coin.sql` | Re-adds `SourcePath` if absent, renumbers `SortOrder`, replaces the per-coin index |
| `004-widen-weight-precision.sql` | Widens `Coins.Weight` and `Coins.PmWeightGrams` from `DECIMAL(10,4)` to `DECIMAL(12,5)` so they keep the fifth decimal the editor displays |
| `005-drop-coin-tags.sql` | Removes the `CoinTags` table with the tags feature. **Stops without dropping anything if the table holds rows**, and prints what to do next |
| `006-drop-coin-dealer.sql` | Removes the coin-level dealer field. **The index has to go first:** an index is a persisted, sorted copy of its key, so `IX_Coins_Dealer` physically *contains* `Coins.Dealer`, and SQL Server refuses the `DROP COLUMN` with Msg 5074 while it exists. So the script drops the index, then any default constraint, then the column. **Destroys data by design** — unlike `005` it never refuses; it reports how many dealer values it is about to discard and proceeds, because the owner chose to drop the field unconditionally. Did **not** touch `Transactions.Dealer`, which was a different column; that whole table has since been dropped |
| `007-infer-coin-metal-data.sql` | Fills in `MetalContent`, `Composition`, `PmWeightGrams` and `PmPercent` for existing coins, inferred from the detail each row already carries. A **data** migration — it changes no column, only values, and only ones that are currently blank. It never overwrites, it prints a full preview (per metal, per *kind of evidence*, and what it is skipping and why) **before** it writes, and it backs every affected row up into `Coins_MetalData_Backup` first. It does **not** touch `Coins.Weight` — that is `008`. See [How `007` knows what a coin is made of](#how-007-knows-what-a-coin-is-made-of) |
| `008-weight-to-grams.sql` | **Reinterprets `Coins.Weight` from troy ounces to grams**, multiplying every stored value by 31.1034768, then derives any still-blank gross weight as `PmWeightGrams / (PmPercent / 100)`. **Must run after `007`**, which is what populates those two inputs. **Not idempotent, and not self-describing:** the column type is identical before and after and no stored value can reveal which unit it is in, so unlike every other script here it cannot guard itself from the system catalog. It writes a marker row into `AppSettings` (`migration-008-weight-grams`) **in the same transaction as the conversion** and skips entirely if it finds one — running it twice would otherwise multiply twice. It snapshots the whole column into `Coins_Weight_TroyOz_Backup` (every row, `NULL`s included) first; the file's header gives the restore statements |
| `009-add-bullion-denominations.sql` | Adds the US `$25` and `$50` denomination rows. The seed stopped at `$20`, the top of the classic gold series, so a **half-ounce or one-ounce American Gold Eagle could not be recorded at all** — the matcher understood a coin the inventory had no room for. A pure data migration: two lookup rows, no schema change. Lets the identity column assign the ids (specifying them would collide with whatever a live database has already issued) and sets `SortOrder` 17/18 so they land after `$20` in the dropdown. Guarded per row on the label not already existing for `US`, so re-running is harmless |

There are no `sqlcmd` instructions here any more, because nothing in this application applies these scripts. Every step of every one of them is guarded by an existence check, and each file's own header documents its guard, its backup table and its undo — read that before running one by hand against the owner's remaining SQL Server database.

**The one row in that table Stage 2 must check rather than assume is `008`.** It rewrote values rather than schema, and *no stored value can reveal which unit it is in*: the column type is identical before and after, and both `0.7734` and `24.05582` are plausible coin weights. The `AppSettings` marker row it writes (`migration-008-weight-grams`) is the only thing that can tell troy ounces from grams, so **do not delete that row**, and have the import confirm it is present before it trusts a single weight. Design §4.1 makes the same point, and records that `004` through `008` have all been run against the owner's database — which is why the import is a straight copy rather than a conversion.

A fresh SQLite install needs none of this: `db/schema.sql` has the `DECIMAL(12,5)` weight columns `004` produced, the seed already contains the `$25` and `$50` denominations `009` added, and a database built from that file has never held troy ounces.

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

**There is nothing to configure.** Every variable below is optional, and all of them absent is the correct state for a normal install — which is the whole point of the SQLite move: no server, no instance name, no credentials. `server/.env.example` is the annotated list; copy it to `.env` only if you need one of these.

| Variable | Read by | Absent means |
| --- | --- | --- |
| `COIN_INVENTORY_DB_PATH` | `db/config.ts` | `%LOCALAPPDATA%\CoinInventory\coin-inventory.db`. Set to an absolute file path, or `:memory:` |
| `COIN_INVENTORY_DATA_DIR` | `db/config.ts` | `%LOCALAPPDATA%\CoinInventory` |
| `PORT` | `server.ts` | 3000 |
| `SPOT_PRICE_BASE_URL` | `routes/data/spot-price-source.ts` | The live Yahoo chart endpoint |
| `APP_BASE_FOLDER` | `routes/app-info.ts` | The folder found by walking up to `angular.json` |
| `SUPPORT_REPO_URL` | `routes/support/index.ts` | A placeholder repository, and the response says so |
| `COIN_LOG_DIR` | `logger.ts` | `server/logs` |
| `COIN_SUPPORT_OUTPUT_DIR` | `routes/support/index.ts` | The user's Desktop, else their home folder |

**The `DB_SERVER` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` block that used to be here is gone.** Nothing reads any of them. If they are still in your `.env` they do nothing at all; delete them rather than leaving something that looks like configuration.

**Omit a variable rather than setting it empty.** The two are not the same thing everywhere: `db/config.ts` trims and treats blank as absent, but `PORT=` parses to `NaN` rather than 3000, and `SPOT_PRICE_BASE_URL=` would send every price request to an empty URL rather than falling back to the default.

`APP_BASE_FOLDER` is an escape hatch and is normally absent. `GET /api/app-info` works out where the app is installed by walking up from its own module until it finds `angular.json`, which is correct both under `tsx` and from a compiled `dist/`. Set this variable only if that answer is wrong for an unusual deployment — the app unpacked somewhere odd, reached through a symlink, or started as a service — in which case give it the absolute path of the folder the app lives in, e.g. `APP_BASE_FOLDER=D:\CoinInventory`. Forward slashes and a trailing separator are tolerated; the value is normalised before it is returned.

The table above is the complete list — those eight variables and the files named beside them are every `process.env` read in the backend, plus `LOCALAPPDATA` itself, which `db/config.ts` reads from the environment rather than deriving because that is where Windows publishes it and a redirected profile has a different answer from the one `os.homedir()` would guess.

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

**A stale `dist/` is dangerous.** `npm start` runs `node dist/server.js`, so a `dist/` built before the SQLite move will silently run the old `mssql` code and try to reach a SQL Server that is no longer part of this application. If you see a connection error naming a server or an instance, delete `dist/` and rebuild before investigating anything else.

## Layout

`server.ts` is wiring only — middleware, static files, route mounting, the SPA fallback, and the global error handler.

| Path | Contents |
| --- | --- |
| `db/index.ts` | Barrel, and the written-up story of why the layer looks the way it does. **Read this first.** |
| `db/driver.ts` | **The only file that may name a SQLite package.** Structural interfaces over `node:sqlite`, and `openSqliteDatabase()` |
| `db/pool.ts` | `getPool` / `resetPool` / `withDb`. The most important file in the backend. |
| `db/config.ts` | Where the database file lives, and the two overrides. Opens nothing |
| `db/schema.sql` | The live schema — twelve tables as SQLite DDL, with every translation decision argued in the header |
| `db/schema.ts` | Applies `schema.sql`; enables WAL. **Not** a migration runner |
| `db/seed.ts` | The reference data, re-seeded idempotently on every open |
| `db/sql-api.ts` | The `.input(...).query(...)` adapter over SQLite — the API the routes already spoke |
| `db/column-types.ts` | The parameter type vocabulary (`NVarChar`, `Char`, `Int`, `Bit`, `Decimal`) |
| `db/bind-values.ts` | JSON value to bound value, and the width / range / rounding rules SQLite does not enforce |
| `db/errors.ts` | `isConnectionError` / `sqlErrorNumber` |
| `db/coin-fields.ts` | `COIN_FIELDS` — the Coins column map (types, max lengths, normalizers) |
| `db/bindings.ts` | `DB_BINDINGS` — parameter types for every other table |
| `db/value-normalizers.ts` | JSON value to SQL parameter value helpers |
| `db/row-mappers.ts` | SQL row to JSON for the Angular app |
| `routes/health.ts` | `GET /api/health` |
| `routes/app-info.ts` | `GET /api/app-info` — where the app is installed on the host |
| `routes/coins/` | `index`, `reads`, `list-query`, `writes`, `write-helpers`, `images`, `image-payload` — mounted at `/api/coins` |
| `routes/lookups/` | `categories`, `coin-sets`, `denominations`, `metal-contents`, `mint-marks` — mounted at `/api` |
| `routes/data/` | `index`, `spot-prices`, `spot-price-source`, `settings`, `frontend-log` — mounted at `/api` |
| `routes/images/` | `file`, `exists`, `allowed-types` — serving the ORIGINAL image files off disk, mounted at `/api/images` |
| `routes/db-error-response.ts` | SQL error to HTTP status translation |
| `routes/error-handler.ts` | The app-wide Express error handler (honours `err.status`, so a 413 stays a 413) |
| `routes/param-utils.ts` | Shared request-parameter helpers |
| `migrations/` | SQL SERVER history, not replayed here. Kept for Stage 2's import — see above. `migrations/seed-data/` holds the JSON `db/seed.ts` reads |
| `process-safety.ts` | `unhandledRejection` / `uncaughtException` handlers |
| `logger.ts` | Appends timestamped lines to a rotated daily log in `logs/` |
| `log-rotation.ts` | Daily log naming, the per-file size cap, and retention |
| `support/` | The problem-report bundle: redaction, report text, zip writer |
| `test-support/sqlite-test-db.ts` | The real in-memory database every spec runs against, and the statement recorder |
| `test-support/schema-columns.ts` | Reads `db/schema.sql` as data, for the parity specs |
| `setup-database.sql` | LEGACY. The SQL Server schema, frozen. Nothing runs it |

## The connection lifecycle (read before changing `db/pool.ts`)

There is no pool any more, and this section is mostly history. Read it anyway, because the history is the only thing that explains why `db/pool.ts` is as careful as it is about a file handle.

### The crash this layer was built around, and why its mechanism is gone

The backend used to die, roughly once per session, in a way that looked like a database problem. It was not.

1. `mssql`'s `ConnectionPool` is a Node `EventEmitter`.
2. When SQL Server dropped or errored an idle pooled connection, mssql called `pool.emit('error', err)`.
3. An `EventEmitter` with **zero** `'error'` listeners *throws* when you emit `'error'` on it. That throw happened inside a tedious socket callback, so nothing caught it — uncaught exception, process gone.

The old `db.ts` never attached that listener. The visible symptom was: pause for a while, edit a coin, get "Failed to update coin", refresh the browser and it still fails because the *server* is gone, restart the app and everything works. Nothing appeared in `app.log` because the process died before any logging ran. The fix was one `pool.on('error', ...)` listener attached before `connect()`.

**Every noun in that paragraph is gone.** There is no pool, because SQLite is a file and a second handle on the same file buys contention rather than throughput. There is no socket, so there is nothing to drop. There is no `EventEmitter` anywhere in `db/`, so there is no emit-with-no-listener rule to violate. The listener was therefore **deleted, not re-created in a fake form** — a guard against a mechanism that is absent is a comment pretending to be code.

The regression test went with it, and `db/connection.spec.ts`'s header records the deletion at length rather than leaving the next reader to wonder where it went. Keeping a version of it would have meant giving `DbConnection` an `EventEmitter` it does not otherwise need purely so a test could emit on it — a test that exercises scaffolding built for the test, and one that would read as evidence that a real hazard is covered.

### What was kept, because the reasons outlive the engine

- **Single-flight open** — the Angular app fires about seven API calls in parallel on load. Without the guard each one would see "no handle", and each would open the file, apply the schema and run the seed — seven times, concurrently, against one file.
- **Generation counter** — every handle gets an increasing id and callers remember theirs, so a request failing at 10:00:05 cannot close a healthy handle opened at 10:00:04.
- **No per-request health check** — the old `SELECT 1` halved throughput and could close the connection mid-query for other requests. It would be even more pointless here, where the "connection" is a file descriptor.
- **`withDb()` retries once, and only for connection-class errors.** A locked or momentarily unavailable file is worth one retry. A constraint violation is not: retrying it would run the caller's function, including its writes, a second time.

All four are tested in `db/connection.spec.ts`.

### Two rules that did not change

- Nothing outside `db/pool.ts` may open a database, and **nothing outside `db/driver.ts` may name a SQLite package.** `db/driver-isolation.spec.ts` enforces the second one by walking every `.ts` file under `server/`.
- **No route handler may call `resetPool()`.** The old `routes/coins.ts` called it in every `catch`, so an ordinary validation error tore down the shared connection and broke every other in-flight request. Route code uses `withDb()` and lets ordinary query errors propagate.

### One thing SQLite added: access is serialised

`mssql` handed each `sql.Transaction` its own pooled connection. There is one SQLite handle and SQLite has no nested transactions, so without a lock two concurrent POSTs would interleave `BEGIN`/`COMMIT` on the same handle and one request would commit the other's half-finished work. `DbTransaction` in `db/sql-api.ts` takes the connection lock for the duration.

`db/sql-api.ts` also **refuses a multi-statement query**, because `node:sqlite`'s `prepare()` compiles the first statement of a string and discards the rest silently — a batch reading `UPDATE a; UPDATE b;` would run half of itself and report success. Use an explicit transaction instead. It likewise **refuses a statement naming a parameter nobody bound**, which SQLite would otherwise bind to `NULL`, turning a typo in `WHERE CoinId = @coinid` into "no rows" rather than an error. The reverse is allowed: an `.input()` the statement does not mention is ignored, which `routes/coins/writes.ts` relies on.

### `mssql` and `msnodesqlv8` are still in `package.json`, on purpose

Nothing imports them. They stay installed because Stage 2's one-time migration script needs them to read the owner's live SQL Server, and they are removed only once he has confirmed his collection has moved. `db/driver-isolation.spec.ts` enforces **both halves**: no file under `server/` may import either package, *and* both must still be declared in `package.json`. Removing them early would strand the only route the owner's data has out of SQL Server, which is exactly the kind of tidying-up that looks harmless in a diff.

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

Like `/api/images`, this route **never touches the database**, so it keeps answering when the database does not. The import screen must open in a half-broken state, and a cosmetic default is not worth failing a page load over. On the frontend side `ApiService.getAppFolder()` maps every failure to `''`, which simply leaves the box empty and its existing warning showing.

## Logging

`logger.ts` appends timestamped lines to `logs/app-YYYY-MM-DD.log` (synchronously, so writes are ordered) and echoes to the console. Every `/api` request is logged, along with all warnings and errors.

**Rotation.** One file per UTC day, each capped at 5 MB — overflow rolls to `app-YYYY-MM-DD.1.log` — and roughly fourteen days kept. The policy lives in `log-rotation.ts`.

The single unbounded `app.log` this replaced reached 7.9 MB and 42,772 lines in ordinary use, which is two problems at once: nobody can attach an unbounded file to a support issue, and every path in it carries the Windows user name, so an append-only log accumulates those forever. Retention is the privacy control, not housekeeping.

A pre-rotation `app.log` is renamed into the dated scheme on first write, so the retention rule finally applies to it rather than leaving it on disk indefinitely. Set `COIN_LOG_DIR` to write logs somewhere other than `server/logs` — §4.10a of the packaging design puts them under `%LOCALAPPDATA%` in the packaged build.

`POST /api/log` lets the Angular app write into the same file, so frontend and backend messages appear in one timeline. It always returns 204 and never fails the caller.

`process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load. They log the full message and stack and deliberately keep the process running. They are a diagnostic backstop, not a substitute for handling errors properly — the real fix for the crash above is the pool `'error'` listener. Before these handlers existed, a crash wrote nothing at all; if you find a log that just stops mid-session with no error line, that is what you are looking at.

## Tests

```powershell
cd server
npm test
```

### They run against a real database now, and that is the biggest improvement in the SQLite change

`test-support/mssql-mock.ts` **has been deleted.** It was a 164-line hand-written fake whose behaviour was whatever its author imagined SQL Server did, and twenty-five spec files drove it by queueing canned recordsets. What those specs proved was that a route called the mock in the expected order — **not** that the SQL was valid, not that the schema had the column, not that the constraint fired, and not that the row came back looking the way the route assumed.

SQLite runs in memory, so the suite now uses the **real `db/schema.sql`, the real seed, the real parameter binding and the real constraint enforcement**. A passing spec means something it did not mean before. This came free with the engine change rather than being extra work.

`test-support/sqlite-test-db.ts` is the harness:

- `resetTestDatabase()` in `beforeEach` clears the tables a test can write to and restarts the statement recorder. It keeps the handle, and therefore the seeded reference data, so a 40-case file pays for one schema build rather than forty. A full build (schema plus 1,274 seeded rows) is around 10 ms.
- `rebuildTestDatabase()` throws the whole database away. Needed by any test that modifies a **seeded** table — `Issuers`, `Denominations`, `Catalogs`, `MintMarks`, `Categories`, `CoinSets`, `MetalContents` — which `resetTestDatabase()` deliberately leaves alone.
- `withTestDb()` / `queryRows()` read the raw handle. **Prefer them:** reading the row a route wrote proves more than inspecting the SQL that wrote it.
- `executedQueries` / `capturedInputs()` still record statements and bindings, but grouped per statement. The mock's flat `capturedInputs` could not tell you which statement a binding belonged to, so a spec asserting "the UPDATE bound `@weight`" was really asserting "something, somewhere, bound `@weight`".

**The production database is never touched.** Importing that module sets `COIN_INVENTORY_DB_PATH` to `:memory:` at module scope, before `db/config.ts` is ever asked where the file is — which is why specs that only want the recorder still import it for the side effect. A suite that resolved the real path would truncate the owner's collection on every `npm test`.

`routes/images/images.spec.ts` is still the one exception to "no file I/O": it writes fixtures into an OS temp directory, because whether a file is on disk is exactly what it tests.

### The specs the migration added

| Spec | Covers |
| --- | --- |
| `db/driver-isolation.spec.ts` | That only `db/driver.ts` names a SQLite package, that it really does, that no file imports `mssql` or `msnodesqlv8`, and that both are **still declared** in `package.json` |
| `db/numeric-storage.spec.ts` | `DECIMAL` to `REAL`: a value read back is the identical double, is rounded to the column's scale as SQL Server rounded it, and is refused when it overflows the declared precision |
| `db/bind-values.spec.ts` | Null and undefined, text width, the one `CHAR(2)` column, integers, `BIT`, and the types the driver cannot bind at all |
| `db/sql-api.spec.ts` | The adapter: statement inspection, the multi-statement refusal, the unbound-parameter refusal, the SQL Server error numbers, `rowsAffected`, and that transactions serialise access to the one handle |
| `db/schema.spec.ts` | The twelve tables; that foreign keys are **enforced and not decorative**; that `COLLATE NOCASE` really does fold case; that `AUTOINCREMENT` does not reuse an id a bare `INTEGER` key would; and what SQLite does *not* enforce, recorded so nobody assumes it does |
| `db/seed.spec.ts` | The first seed, that re-seeding is idempotent, that it runs in one transaction, and what Stage 2 must know about the seeded ids |
| `db/catalog-columns.spec.ts`, `db/coin-status-columns.spec.ts`, `db/denomination-column.spec.ts` | The columns migrations `010`–`012` added: binding against schema, normalisation on the way in, and a round trip over HTTP against a real row |

### The longer-standing specs

| Spec | Covers |
| --- | --- |
| `server.spec.ts` | App wiring and the health endpoint |
| `db/connection.spec.ts` | Config, the connection lifecycle, `withDb`. **Its header records the crash regression that was deleted and why** |
| `db/coin-fields.spec.ts` | `COIN_FIELDS` against `db/schema.sql` |
| `routes/app-info.spec.ts` | `GET /api/app-info` — `normaliseWindowsPath`, the `APP_BASE_FOLDER` override, that the marker walk finds the project root from either depth, and that the route never touches the database |
| `routes/coins/reads.spec.ts` | `GET /api/coins` |
| `routes/coins/list-query.spec.ts` | `imageCount`, the `includeImages=false` switch, and `shouldIncludeImages()` |
| `routes/coins/writes.spec.ts` | `POST` / `PUT` / `DELETE /api/coins`, `imagePaths` + `SourcePath` |
| `routes/coins/images.spec.ts` | `GET /api/coins/:id/images`, including `sourcePath` |
| `routes/coins/images-post.spec.ts` | `POST /api/coins/:id/images` — `sourcePath` round trip, legacy string form, batch rollback |
| `routes/coins/image-payload.spec.ts` | The legacy-string vs `{ imageData, sourcePath }` normalizer |
| `routes/images/images.spec.ts` | `/api/images/file` and `/api/images/exists` (uses a real temp directory) |
| `routes/lookups/lookups.spec.ts` | `/api/categories`, `/api/mintmarks`, and friends |
| `routes/data/data.spec.ts` | `/api/spot-prices`, `/api/settings`, and that `/api/transactions` is gone |
| `routes/data/spot-price-source.spec.ts` | `fetchSpotPrices()` — the copper per-pound conversion, and that a missing price fails rather than becoming 0 |
| `routes/db-error-response.spec.ts` | SQL error to HTTP status translation |
| `routes/error-handler.spec.ts` | Oversized uploads report 413, not 500 |

**Neither table is exhaustive** — there are 45 spec files under `server/`, and the rest sit next to the code they cover: the lookup routes, the support bundle, the log rotation, and the three SQL Server migration specs that still guard `migrations/`.

## Coin images: many photos per coin (`CoinImages`)

This is the part of the schema most worth understanding before you touch anything image-related, so it is written up here as well as in the comment block above `CREATE TABLE CoinImages` in `db/schema.sql`.

**One ROW per photo, not one column per photo.** `CoinImages` has been a child table since the baseline schema: each photo gets its own `ImageId` identity and points back at its coin through `CoinId`. A coin with ten photos is ten rows sharing one `CoinId`. There is deliberately **no limit** on how many a coin may have, and nothing about the design changes between one photo and twenty — there is no single-image column to widen and no one-image-per-coin constraint to remove. "Multiple pictures per coin" was never a feature to add; it is just what a child table does.

In practice the photo library holds 8-10 files for a typical coin: obverse and reverse, the slab label, plus derivative renderings (Small / Orig / Sharpened) and the occasional retake.

| Column | Purpose |
| --- | --- |
| `ImageId` | `INTEGER PRIMARY KEY AUTOINCREMENT`. This is what `DELETE /api/coins/:id/images/:imageId` takes. **`AUTOINCREMENT` is not noise:** a bare `INTEGER PRIMARY KEY` is SQLite's rowid and picks `max(rowid) + 1`, so deleting the highest row and inserting another *reuses* the id. `IDENTITY` never reused one, and nor does this. |
| `CoinId` | Owning coin. `ON DELETE CASCADE`, so deleting a coin deletes its photos rather than orphaning them. |
| `ImageData` | A **downscaled** base64 data URL, sized for display. |
| `SortOrder` | Zero-based position within *this coin's* photos. |
| `SourcePath` | Absolute path of the original full-resolution file **on the host machine**, with a drive letter (not a UNC path) — see [Stored paths must be valid on the HOST](#stored-paths-must-be-valid-on-the-host-with-a-drive-letter). Nullable. |

### `SortOrder` is the only thing deciding display order

The app always reads images as `WHERE CoinId = @id ORDER BY SortOrder`, so that column is the entire ordering mechanism. New inserts assign `MAX(SortOrder) + 1` (see `routes/coins/images.ts`), which is read *inside* the transaction so a concurrent insert cannot invalidate it.

**Nothing in the schema stops two photos of the same coin sharing a `SortOrder`**, and the column defaults to 0. Where several rows claim position 0, `ORDER BY SortOrder` leaves their relative order entirely up to the query plan: with one or two photos per coin that is invisible, with eight it is not — the gallery is free to show Reverse first today and Obverse first tomorrow, and the user sees photos that "move around by themselves". The insert path assigning `MAX(SortOrder) + 1` is what prevents it; a new write path that forgets to is how it comes back.

That was a live bug on the owner's SQL Server database, and migration `003` renumbered his rows with `ROW_NUMBER() OVER (PARTITION BY CoinId ORDER BY SortOrder, ImageId) - 1`. The two-part sort is worth knowing because Stage 2 inherits its result: `SortOrder` first preserved every ordering choice that was already unambiguous, and `ImageId` second broke ties among rows that had collided, resolving them to *insertion order* — the photo added first stays first, which is both the least surprising outcome and a stable one.

### The index is `(CoinId, SortOrder)`, not `(CoinId)`

`IX_CoinImages_CoinId_SortOrder` is the only index on the table. A `CoinId`-only index would get the engine to the right rows but say nothing about their order, so the plan would have to sort them after fetching; with the composite, rows come off the index already in display order and the sort step disappears. Barely measurable at two rows per coin, worth having at ten across a few thousand. There is no separate `CoinId` index because `CoinId` is the leading column of this one — anything a narrow index could answer, this answers too — and a second one would only add write cost on every photo inserted or deleted.

### Why there is no unique index on `(CoinId, SourcePath)`

It is tempting: it would stop the same file being attached to one coin twice. It was considered and deliberately rejected, and the reasoning is recorded both here and in migration `003` so it does not get "fixed" later.

A `UNIQUE` constraint turns any duplicate that slips through into a hard SQL error. Because the image insert runs as **one transaction**, a single duplicate would abort the entire batch — a 200-photo import failing at file 150 and rolling all of it back. Silently re-attaching one photo is a far smaller problem than that. The import already de-duplicates on the client; if server-side de-duplication is wanted, it belongs in the **insert logic**, where a duplicate can be skipped without killing the batch.

### `sourcePath` is `null`, never `""` — that is an API contract

`GET /api/coins/:id/images` maps each row with `?? null`:

```ts
sourcePath: (row['SourcePath'] as string | null | undefined) ?? null,
```

That normalisation covers two separate cases — SQL `NULL`, and a driver that omits the column entirely — and collapses both to JSON `null`. **Do not "simplify" this to an empty string or to omitting the key.** The frontend distinguishes three states and needs them kept apart:

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

- Categories, denominations, mint marks, catalogues and metal contents are reference data: seeded by `db/seed.ts` on every open, read from the database by the app, and never overwritten once a user has edited or soft-deleted one.
- Start the frontend and backend through the project launcher when possible — `start-coin-inventory.ps1` in the project root, or double-click `launch-coin-inventory.cmd` next to it, which just forwards to that script. Use the direct `tsx` command for troubleshooting or manual startup.
