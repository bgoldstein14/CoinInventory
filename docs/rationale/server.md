# Server rationale

Why the Express backend is shaped the way it is. The code carries the rules
you must not break; this file carries the reasoning behind them, for someone
who wants to know why an obvious-looking simplification was not taken.

## Where the database file lives

The collection is one SQLite file at
`%LOCALAPPDATA%\CoinInventory\coin-inventory.db`. It is not beside the
application because an installed app lives under Program Files, which a
standard user cannot write to, and because uninstalling the app must never
delete the collection. `COIN_INVENTORY_DB_PATH` and `COIN_INVENTORY_DATA_DIR`
exist for tests and unusual setups.

Every open applies the schema with `IF NOT EXISTS`, seeds missing reference
rows and stamps the version. Because all of it is idempotent there is no
"first run" code path to get wrong: an empty file and a ten-year-old file go
through the same steps.

## The data layer

### One handle, one lock

`node:sqlite` is built into Node 22+, so there is no native module to build
or ship. Only `db/driver.ts` imports it, and `driver-isolation.spec.ts`
enforces that; if a future host lacks it, one file changes.

There is a single database handle. A transaction spans `await`s, so two
requests interleaving on the handle would run each other's statements inside
the wrong transaction. `sql-api.ts` therefore serialises all access through one
FIFO lock, and `BEGIN IMMEDIATE` holds it until commit or rollback. Throughput
is not a concern for a single-user app; correctness is.

### Checks SQLite does not make

The routes use a request API of the form
`db.request().input(name, type, value).query(sql)`. Two behaviours of SQLite
under that API would fail silently, so `sql-api.ts` refuses them:

- a string with several statements, because `node:sqlite` runs only the first
  and ignores the rest without error;
- a `@name` with no bound value, because SQLite binds NULL and the write
  succeeds with a blank column.

### Why `withDb()` retries once, and why no route may reset it

`withDb()` is the only way a route reaches the database. It opens the handle
single-flight, retries exactly once, and only for connection-class errors.
Retrying anything else would repeat a write. A generation counter stops a late
failure from closing a handle that has since been reopened.

No route may call `resetPool()`. A constraint violation or an over-long string
is a fault in one request; tearing down the shared handle for it breaks every
other request in flight. `withDb()` exists so a route cannot express that mistake.

`db/errors.ts` and `routes/failure-report.ts` are pure functions of an error
because the decisions they make ("is the connection dead?", "which of three
things do we tell the user?") must never be wrong, and a pure function is the
easiest thing in the backend to test exhaustively.

### Why decimals are REAL

Money and weights were only ever handled as JavaScript doubles. SQLite's REAL
stores a double bit for bit, so every value round-trips exactly. Two
alternatives were rejected:

- **Scaled INTEGER** (store grams × 100000): a conversion at every read and
  write site, and one missed site produces a plausible-looking wrong weight.
- **TEXT**: casts everywhere, and numeric comparison and sorting break.

The declared scale's rounding (half away from zero) and range checks are
applied in `db/bind-values.ts`, so stored values have the precision the schema
comment promises.

### Why widths are enforced in code

SQLite ignores declared column widths. The `COIN_FIELDS` / `DB_BINDINGS`
lengths are therefore the only limit, and an over-long value is refused with a
400 rather than truncated: a truncated cert number or note is silent data loss.
The trailing `-- NVARCHAR(n)` comments in `schema.sql` record the declared type
so parity specs can check the code limits against it.

### Collation and keys

SQLite compares text case-sensitively by default. Every column that is
compared, grouped, ordered or must be unique (category names, usage counts,
deletes by name) uses `COLLATE NOCASE`, so "Gold" and "gold" are one category.
Payload columns (notes, cert and catalogue numbers, image data, paths, ids)
stay binary because their exact bytes matter. NOCASE folds A–Z only.

Every integer key is `AUTOINCREMENT`, so a deleted row's id is never reused
and a stale id in a client can never hit a different coin.

SQLite errors are translated to a small set of error numbers
(2627 unique, 547 foreign key, 515 not null, 8152 too long, 8114 bad value), so
the HTTP mapping in `db-error-response.ts` is one table rather than one per engine.

### The schema version

`PRAGMA user_version` is bumped only when an older build could not read the
file. Restore refuses a file with a higher version because there is no
downgrade path; it accepts version 0 (stamped before versioning existed) when
the tables are right. The stamp is never lowered.

## Images: why the list has none and the grid fetches one at a time

Photos are stored as base64 text in `CoinImages.ImageData`, roughly 250 KB per
image. Once a collection passes about a hundred coins, a `GET /api/coins` that
inlines every photo cannot be serialised at all: `JSON.stringify` throws
`RangeError: Invalid string length` because the string exceeds V8's maximum.
It works at one coin count and is impossible at the next.

Three ways to give the grid its thumbnails were available:

1. **No thumbnails**, drawing a placeholder from `imageCount`. A real loss: the
   grid is how a collection is looked at.
2. **A batched JSON endpoint**, one image per coin. This rebuilds the same
   over-long string. Batching is right for short values (paths, booleans,
   counts) and wrong for blobs.
3. **One binary response per coin**: `GET /api/coins/:id/thumbnail`.

The third is cheaper than the batch. Nothing is concatenated, so the string
limit cannot be reached at any size. `loading="lazy"` means rows below the fold
cost nothing until scrolled to. Coins with no photos cost nothing, because the
client knows `imageCount`. Caching is per coin: with `Cache-Control: no-cache`
plus an ETag, scrolling back costs a 304, where one batched blob is invalidated
by the first changed photo.

The bytes are served decoded rather than as base64, a third smaller and what
`<img src>` wants. There is no resizing step; the stored copy is already
downscaled and the server has no image library.

`imagePaths: []` is never returned for photos that were not loaded, because a
PUT carrying `[]` deletes them.

## SourcePath: why the rescue is on the server

`CoinImages.SourcePath` records where a photo's original file lives on the
host. `PUT /api/coins/:id` replaces a coin's whole image set, and every
operation that touches photos re-sends the full array, often as bare base64
strings with no path. Without a rescue step, editing one photo erases the
recorded location of every other photo on the coin.

The client-side registry (`src/app/services/image-source-paths.ts`) only helps
when this browser session ran the import or opened the coin. A reload, a
second tab, a replayed request or a re-imported JSON export leaves it empty.
The server owns the data and is the last code to run before it is destroyed,
so the guarantee belongs there; the registry is an optimisation.

The reconciliation matches on the base64 blob because the `imagePaths` array
has no image id. Rows are loaded into a `Map` keyed by that string, so the pass
is O(n). The cost is the read itself (a few megabytes for a coin with eight to
ten photos, once per save of one coin). `WHERE SourcePath IS NOT NULL` skips
images with nothing to preserve, and the read is skipped entirely when no
incoming entry needs rescuing.

`sourcePath: null` means "unknown" rather than "clear", because the client
sends null for every entry whose path it does not know.

## The `imagePaths` payload shape

`imagePaths` holds image data, not paths. When images gained a source path,
the choice was between a polymorphic array (each element a bare string or
`{ imageData, sourcePath }`) and a second parallel array.

The polymorphic array won. Two parallel arrays can fall out of alignment and
attach the wrong path to the wrong photo with nothing reporting it. One array
also keeps one meaning: sending `imagePaths` means "these are now the coin's
images, in this order". The bare-string form is permanent: an old JSON export
contains plain base64 strings, and re-importing one must keep working.

## Original files: why the server streams them

Chrome and Edge silently refuse to navigate from an `http` page to a `file://`
URL, so a link to the original must arrive over http. The Express server is on
the same machine and can read the disk.

`GET /api/images/file` reads any image-extension file on the host with no
root confinement. That is acceptable only because this is a single-user local
app whose photos live wherever the user put them; a confined root would defeat
the feature. The extension allow-list stops it reading `.env`, logs or source,
and every access is logged. If the app is ever exposed beyond localhost, this
route is the first thing to lock down (a configured root, or serve by
`ImageId`). The same applies to the backup folder listing.

The route streams because originals reach ~46 MB and several concurrent
`readFile`s could exhaust the heap. `POST /api/images/exists` uses async `fs`
because a synchronous check against a disconnected drive blocks the whole
server, including the launcher's health probe, for seconds.

## Backup and restore

- **Online backup API through a second, read-only connection.** The app keeps
  writing during a copy (WAL readers do not block writers), and the shared lock
  is not held for minutes.
- **The copy pins a snapshot.** Without a read transaction SQLite restarts the
  backup whenever another connection writes, so a busy database's backup might
  never finish (measured: 62 restarts and unfinished after 10 s, against 0
  restarts and 102 ms with the pin). The cost is WAL growth during the copy.
- **Batches of 512 pages** (~2 MB) balance progress granularity, cancel latency
  and throughput.
- **Metadata lives inside the copy** (AppSettings `backup.*`), not in a sidecar
  file or the file's mtime, which can be separated or rewritten.
- **Polling rather than server-sent events**: simpler, and a lost poll is
  harmless. Finished jobs are kept in memory only.
- **Inspect and restore are separate calls**, so the user sees counts, date and
  photo warnings before anything changes; restore re-validates on its own.
- **Restore has no cancel**, because stopping halfway would leave a half-swapped
  state. The current file is renamed aside, not deleted, so the undo is a copy.
  Writing the backup through the online backup API folds any hot WAL into one
  self-contained file.
- **The database is closed before the swap** (`withDatabaseOffline`) because
  Windows cannot rename an open file. The server reopens it afterwards, so no
  restart is needed.

## Problem reports

The report is a file on the user's Desktop rather than an upload because
GitHub has no API for issue attachments; a person dragging the file into the
issue is the only route. Uploading would mean shipping a credential inside a
public desktop application, where any token that can file an issue can be
extracted. Nothing in this feature authenticates to anything.

There is no zip. The report is already text, and GitHub shows an image dragged
onto an issue inline, where the same image inside a zip is invisible until
someone downloads and extracts it.

Redaction runs before anything is written, not on the way out: once an
unredacted copy exists on disk, somebody will attach that one. The text is
redacted again at the file boundary because it comes from the renderer. The
report and the log share one redactor so their placeholders match. The server
reads the log itself, so unredacted lines never pass through the browser.

## The denomination seed

The issuers and denominations are authored data in `issuers-denominations.json`,
not generated from an external source. There is no redistributable,
machine-readable dataset of denominations by issuer: Nomisma is coin-type data
under non-commercial terms, Numista answers 403 to automated reads, and
WorldCoinDatabase has no export. A file of hundreds of hand-checked entries
survives only if it is reviewed and diffed as data.

Seeding is insert-if-missing by natural key and never updates or deletes, so a
user's edits and soft deletes survive every start. The seed is validated
because a file that size goes wrong quietly: a label duplicated under one
issuer makes every resolution of that text ambiguous, which resolves to NULL,
so a duplicated row does not add a denomination, it removes one.

## The Wikidata denomination lookup

It is one of two outbound requests (spot prices are the other), so it sends
only the issuer name, uses a generic User-Agent, and never writes to the
database: results are proposals the user confirms. It uses Wikidata's entity
search plus a fixed list of currency classes, because a label scan with a
transitive subclass walk timed out. It always answers 200 with an `outcome`,
so "no network" is a normal result rather than an error.
