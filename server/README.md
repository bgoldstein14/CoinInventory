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

It is also the reference the code is checked against: `db/coin-fields.ts` and `db/bindings.ts` declare an mssql parameter type per column, and `db/coin-fields.spec.ts` asserts they match this script. **If you change a column here, change the binding too.** A parameter declared shorter than its column silently truncates the user's data; one declared longer makes SQL Server raise error 8152 and abort the statement. Both bugs were live before the refactor — `Year` was bound `NVarChar(10)` against an `NVARCHAR(50)` column, `Dealer` at 255 against a 200-char column, and `PurchaseDate`/`SoldDate` as `sql.Date` against `NVARCHAR(30)` text columns.

## Configuration

Create or update your `.env` file in the `server` folder with:

```env
DB_SERVER=localhost
DB_NAME=CoinInventory
DB_USER=
DB_PASSWORD=
PORT=3000
```

For named instances, use the full server name, such as:

```env
DB_SERVER=BRUCE_PC\SQLEXPRESS
```

`db/config.ts` is the only place that reads these.

## Running

```powershell
cd server
npm install
npx tsx server.ts
```

The server listens on port 3000 by default. Normal startup is the root `launch-coin-inventory.cmd`; run `tsx` directly when you want to see startup errors in your own console.

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
| `routes/coins/` | `index`, `reads`, `writes`, `write-helpers`, `images` — mounted at `/api/coins` |
| `routes/lookups/` | `categories`, `coin-sets`, `denominations`, `metal-contents`, `mint-marks` — mounted at `/api` |
| `routes/data/` | `transactions`, `spot-prices`, `settings`, `frontend-log` — mounted at `/api` |
| `routes/db-error-response.ts` | SQL error to HTTP status translation |
| `routes/param-utils.ts` | Shared request-parameter helpers |
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

## Logging

`logger.ts` appends timestamped lines to `logs/app.log` (synchronously, so writes are ordered) and echoes to the console. Every `/api` request is logged, along with all warnings and errors.

`POST /api/log` lets the Angular app write into the same file, so frontend and backend messages appear in one timeline. It always returns 204 and never fails the caller.

`process-safety.ts` installs `unhandledRejection` and `uncaughtException` handlers at module load. They log the full message and stack and deliberately keep the process running. They are a diagnostic backstop, not a substitute for handling errors properly — the real fix for the crash above is the pool `'error'` listener. Before these handlers existed, a crash wrote nothing at all; if you find a log that just stops mid-session with no error line, that is what you are looking at.

## Tests

```powershell
cd server
npm test
```

61 tests across 8 files. Specs sit next to the code they cover:

| Spec | Covers |
| --- | --- |
| `server.spec.ts` | App wiring and the health endpoint |
| `db/connection.spec.ts` | Config, pool lifecycle, the crash regression, `withDb` |
| `db/coin-fields.spec.ts` | `COIN_FIELDS` against `setup-database.sql` |
| `routes/coins/reads.spec.ts` | `GET /api/coins` |
| `routes/coins/writes.spec.ts` | `POST` / `PUT` / `DELETE /api/coins` |
| `routes/lookups/lookups.spec.ts` | `/api/categories`, `/api/mintmarks`, and friends |
| `routes/data/data.spec.ts` | `/api/transactions`, `/api/spot-prices`, `/api/settings` |
| `routes/db-error-response.spec.ts` | SQL error to HTTP status translation |

They all mock `mssql` through `test-support/mssql-mock.ts`, so no database is needed to run them.

## Notes

- Categories, denominations, mint marks, and metal contents are loaded from SQL and kept in sync with the app.
- Start the frontend and backend through the project launcher (`launch-coin-inventory.cmd` in the project root) when possible; use the direct `tsx` command for troubleshooting or manual startup.
