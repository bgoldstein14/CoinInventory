# Coin Inventory Server

Express API and static host for the Coin Inventory Angular app, backed by a
single SQLite file through Node's built-in `node:sqlite`.

Related documentation:

| Document | Covers |
| --- | --- |
| [README.md](../README.md) | Running the app, the launcher, configuration, troubleshooting |
| [docs/architecture.md](../docs/architecture.md#back-end-server) | Data layer, route modules, full endpoint list |
| [docs/rationale/server.md](../docs/rationale/server.md) | Why the server is shaped the way it is |
| [docs/how-it-works.md](../docs/how-it-works.md#persistence) | Persistence, backup engine, error stages |

## Prerequisites

- Node.js 22.5+ (`node:sqlite` is built in; no native module, no C++ toolchain).
- No database server. The database file is created on first start.

## Running

```powershell
cd server
npm install
npx tsx server.ts      # listens on http://localhost:3000
```

Day to day, start everything through the launcher in the project root
(`launch-coin-inventory.cmd` or `start-coin-inventory.ps1`); see
[README.md](../README.md#the-launcher). Run `tsx` directly to see start-up
errors in your own console.

| Script | Runs |
| --- | --- |
| `npm run dev` | `tsx watch server.ts`; used by the root `npm start` |
| `npm start` | `node dist/server.js`; needs `npm run build` first |
| `npm run build` | `tsc -p tsconfig.build.json` (excludes specs and `test-support/`) |
| `npm run typecheck` | `tsc --noEmit`, including the specs |
| `npm test` | `vitest run` |

`npm start` runs whatever is in `dist/`, so rebuild after pulling changes.

## The database

| Item | Where |
| --- | --- |
| Data file | `%LOCALAPPDATA%\CoinInventory\coin-inventory.db` (logged at start-up) |
| Location logic | `db/config.ts` |
| Schema | `db/schema.sql`, applied by `db/schema.ts` |
| Schema version | `SCHEMA_VERSION` in `db/schema.ts` (currently 2), stored in `PRAGMA user_version` |
| Reference data | `db/seed.ts`, from `db/seed-data/issuers-denominations.json` |
| Seed validation | `db/seed-file.ts` |
| Connection lifecycle | `db/pool.ts` (`getPool`, `resetPool`, `withDb`, `withDatabaseOffline`) |

### What happens on open

`db/pool.ts` opens the file on first use and, every time, in this order:

1. Creates the data folder if missing.
2. Enables WAL (file databases only).
3. Applies `db/schema.sql`. Every statement is `CREATE ... IF NOT EXISTS`, so an
   existing database is unchanged.
4. Stamps `SCHEMA_VERSION` if the file carries a lower one; logs a warning if it
   carries a higher one.
5. Seeds missing reference rows: issuers, denominations, catalogues,
   categories, metal contents, mint marks.

There is no separate setup or first-run step.

### Changing the schema

- Add or change columns in `db/schema.sql`. There is no migration runner;
  `IF NOT EXISTS` does not alter an existing table, so a change to an existing
  table needs its own upgrade step.
- Keep the trailing `-- NVARCHAR(n)` / `-- DECIMAL(p,s)` comment on each column.
  `test-support/schema-columns.ts` parses it, and the parity specs
  (`db/schema.spec.ts`, `db/coin-fields.spec.ts`, `db/catalog-columns.spec.ts`,
  `db/coin-status-columns.spec.ts`, `db/denomination-column.spec.ts`) compare
  it with `db/coin-fields.ts` and `db/bindings.ts`. Change the binding with the
  column.
- Bump `SCHEMA_VERSION` only when an older build could not read the new file;
  restore refuses files with a higher version.
- Use `COLLATE NOCASE` on text that is compared, grouped, ordered or unique;
  leave payload text (notes, cert and catalogue numbers, paths, image data)
  binary.

The reasoning behind `REAL` for decimals, widths enforced in code, collation
and `AUTOINCREMENT` keys is in
[rationale/server.md](../docs/rationale/server.md#the-data-layer).

### Tables

| Table | Holds |
| --- | --- |
| `Coins` | One row per coin, including purchase and sale details (`PurchasedFrom`, `SoldTo`, `TransactionNotes`) |
| `CoinImages` | One row per photo: downscaled `ImageData`, `SortOrder`, host `SourcePath` |
| `CoinCatalogRefs` | A coin's catalogue references, in `SortOrder`; `CatalogId` may be null |
| `Issuers`, `Denominations`, `Catalogs` | Seeded reference data, user-editable, soft-deleted (`IsActive`) |
| `Categories`, `CoinSets`, `MintMarks`, `MetalContents` | Lookup lists |
| `SpotPrices` | Stored metal prices |
| `AppSettings` | Key/value settings |

`Weight` and `PmWeightGrams` are grams. `TransactionNotes` is the note on the
deal and is separate from `Notes`.

### Reference data seed

`db/seed.ts` inserts only rows that are missing, matched by natural key
(issuer name, issuer + denomination label, lookup text; case-insensitive). It
never updates or deletes, so user edits, soft deletes and additions survive
every start. To change the issuers or denominations, edit
`db/seed-data/issuers-denominations.json`; `db/seed-file.ts` rejects unknown
issuer keys, duplicates and over-long values with one error listing every
problem. The catalogue list in `CATALOG_SEED` must match
`src/app/types/catalog-reference.ts` (checked by
`src/app/types/catalog-seed-parity.spec.ts`).

## Data layer rules

- Routes reach the database only through `withDb()` and must not call
  `resetPool()`.
- Only `db/driver.ts` imports `node:sqlite`.
- Queries use `db.request().input(name, type, value).query(sql)` from
  `db/sql-api.ts`. It rejects multi-statement strings and unbound `@name`
  parameters, and serialises all access through one lock.
- Transactions use `BEGIN IMMEDIATE`; pair them with `try`/`catch` and
  `safeRollback()` (`routes/coins/write-helpers.ts`).
- Values are checked against the declared width, precision and scale in
  `db/bind-values.ts`; an over-long value is a 400, not a truncation.

## Catalogue references

A coin can have any number of catalogue references (`CoinCatalogRefs`),
handled by `routes/coins/catalog-refs.ts`:

- The API sends and receives them as `catalogRefs`: an ordered array of
  `{ catalogId, catalogNumber }`.
- Incoming entries are trimmed; entries with no number and exact duplicates
  are dropped.
- `POST /api/coins` inserts the list. `PUT /api/coins/:id` replaces the whole
  list when `catalogRefs` is present and leaves it alone when the key is absent.
- Deleting a coin deletes its references.

## Layout

| Path | Contents |
| --- | --- |
| `server.ts` | Middleware, static Angular bundle, route mounting, SPA fallback, error handler |
| `db/` | Data layer; start with `db/index.ts`. File table in [architecture.md](../docs/architecture.md#data-layer-serverdb) |
| `routes/` | One module per area; table in [architecture.md](../docs/architecture.md#routes-serverroutes) |
| `backup/` | Backup jobs, restore, file inspection and verdicts |
| `support/` | Problem report text, redaction, log extract, file writing |
| `logger.ts`, `log-rotation.ts` | Daily log files |
| `process-safety.ts` | Logs unhandled rejections and uncaught exceptions |
| `test-support/` | In-memory test database, file-backed test database, schema-column parser, Vitest setup |
| `.env.example` | Annotated list of optional environment variables |

## Endpoints

The full list is in [architecture.md](../docs/architecture.md#endpoints).
Points worth knowing when changing the server:

- **`GET /api/health`** runs `SELECT 1` and returns
  `200 { status: 'ok', database: 'connected' }` or
  `503 { status: 'error', database: 'disconnected', message }`. The launcher
  (`start-coin-inventory.ps1`) checks the body, because the SPA fallback
  answers unknown GETs with `index.html` and a 200. Change the shape only with
  the launcher.
- **`/api/app-info`, `/api/images` and `/api/support`** keep working when the
  database is unavailable (support reads counts best-effort).
- **`GET /api/images/file`** streams any image-extension file on the host, with
  no root folder. Paths in `CoinImages.SourcePath` are host paths with a drive
  letter. If the app is ever exposed beyond localhost, lock this route down
  first.
- **`sourcePath`** in image responses is a string or `null`, never `""`; the
  frontend relies on the difference.
- **`GET /api/spot-prices/fetch`** reads COMEX/NYMEX front-month futures
  (`GC=F`, `SI=F`, `PL=F`, `HG=F`). Copper is converted from per pound to per
  troy ounce. A missing price is reported in `failed` and never stored as 0.
- **Restore** closes the shared handle (`withDatabaseOffline`), swaps the file
  and reopens it; the backup router is mounted last for that reason.

## Configuration

Nothing is required. All variables are optional; omit one rather than setting
it empty (`PORT=` parses to `NaN`).

| Variable | Read by | Default |
| --- | --- | --- |
| `COIN_INVENTORY_DB_PATH` | `db/config.ts` | Unset. A file path, or `:memory:`; overrides everything |
| `COIN_INVENTORY_DATA_DIR` | `db/config.ts` | `%LOCALAPPDATA%\CoinInventory` (home folder if `LOCALAPPDATA` is unset) |
| `PORT` | `server.ts` | `3000`; the launcher expects 3000 |
| `SPOT_PRICE_BASE_URL` | `routes/data/spot-price-source.ts` | Yahoo Finance chart endpoint |
| `APP_BASE_FOLDER` | `routes/app-info.ts` | Folder containing `angular.json` |
| `SUPPORT_REPO_URL` | `routes/support/index.ts` | Placeholder; the API reports it as not configured |
| `COIN_SUPPORT_OUTPUT_DIR` | `routes/support/index.ts` | Desktop, else home folder |
| `COIN_LOG_DIR` | `logger.ts` | `server/logs` |

Values can also go in `server/.env` (loaded by `dotenv`).

## Logging

- `logs/app-YYYY-MM-DD.log`, one file per UTC day, 5 MB cap per file (overflow
  goes to `app-YYYY-MM-DD.1.log`), about 14 days kept. Policy in
  `log-rotation.ts`.
- Every `/api` request, warning and error is logged. The Angular app writes to
  the same file through `POST /api/log` (always 204).
- `process-safety.ts` logs unhandled rejections and uncaught exceptions with
  their stacks and keeps the process running.

## Tests

```powershell
cd server
npm test
```

- Specs sit next to the code they cover and run against a real in-memory
  SQLite database built from `db/schema.sql` and the real seed
  (`test-support/sqlite-test-db.ts`).
- `test-support/vitest-setup.ts` forces `COIN_INVENTORY_DB_PATH=':memory:'`
  for every test and fails any test that changes it, so tests never touch the
  real collection.
- `resetTestDatabase()` clears user-data tables between tests;
  `rebuildTestDatabase()` also restores the seeded tables. Use it in tests that
  modify `Issuers`, `Denominations`, `Catalogs` or the lookup tables.
- Prefer `withTestDb()` / `queryRows()` to check what a route wrote over
  inspecting the SQL it ran.
- Backup and restore specs use `test-support/real-file-db.ts` (a file in a temp
  directory) and must call `releaseFileDatabase()`.
- `routes/images/images.spec.ts` writes fixtures to a temp directory.
