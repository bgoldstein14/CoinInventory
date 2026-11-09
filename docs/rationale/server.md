# Server rationale

Why the Express backend is shaped the way it is. The code carries the rules
you must not break; this file carries the reasoning behind the shapes those
rules live in, for someone new to the codebase who wants to know why an
obvious-looking simplification was not taken.

## The database layer

The pool code in `db/pool.ts` looks defensive out of proportion to its size.
It is: a `mssql` `ConnectionPool` is a Node `EventEmitter`, and an
`EventEmitter` with no `'error'` listener *throws* when something emits
`'error'` on it. Because that emit happens on an internal socket callback,
nothing catches the throw, and the whole Express process dies without writing
a line to the log. Every other piece of the pool's design — the single-flight
connect, the generation counter, the one retry — exists to make recovery from
a dropped connection cheap enough that nobody is tempted to work around it.

The rule that no route may call `resetPool()` comes from the same place. An
earlier shape called it from every `catch` block, which meant a constraint
violation or an over-long string tore down the pool shared by the entire
process and broke every other request in flight. `withDb()` exists so a route
cannot express that mistake: it hands over a healthy pool and retries exactly
once, and only for connection-class errors.

Two pure modules sit alongside it for the same reason — `db/errors.ts` and
`routes/failure-report.ts`. The decisions they make ("is the connection dead?",
"which of three things do we tell the user?") are the ones that must never be
wrong, and a pure function of an error is the easiest thing in the backend to
test exhaustively.

## Images: why the list has none and the grid fetches one at a time

Photos are stored as base64 text in `CoinImages.ImageData`, roughly 250 KB per
image. Once a collection passes about a hundred coins, a `GET /api/coins` that
inlines every photo of every coin cannot be serialised at all: `JSON.stringify`
throws `RangeError: Invalid string length` because the concatenated string
exceeds V8's hard maximum. There is no gradual phase. It works at one coin
count and is impossible at the next.

Three ways to give the grid its thumbnails back were available:

1. **No thumbnails at all**, using the `imageCount` the list already carries to
   draw a placeholder. Free, and a real loss — the grid is how a collection is
   looked at.
2. **A batched JSON endpoint**, one image per coin. This is the shape of the
   other batched endpoints here (`/api/images/exists`,
   `/api/coins/image-source-paths`), and it is wrong for this data: it rebuilds
   the identical over-long string and moves the outage rather than fixing it.
   Batching is right for short values — paths, booleans, counts — and wrong for
   blobs.
3. **One binary response per coin**, which is what `GET /api/coins/:id/thumbnail`
   is.

The third option is cheaper than the batch, which is backwards from the usual
instinct about round trips, for four reasons. Nothing is concatenated, so the
maximum-string-length wall is not expressible at any collection size. The grid
renders the images with `loading="lazy"`, so rows below the fold cost nothing
until they are scrolled to, where a batch pays for every coin to show the
twenty that are visible. Coins with no photos cost nothing at all, because the
client already knows `imageCount` and does not render an `<img>`. And caching
is per coin — with `Cache-Control: no-cache` plus Express's ETag, scrolling
back up costs a 304 with an empty body, where one batched blob is a single
cache entry that the first changed photograph invalidates entirely.

Serving the bytes decoded rather than as the stored base64 makes each response
a third smaller and is what `<img src>` wants anyway. There is no resizing
step; that is a limitation rather than a choice, since the stored copy is
already downscaled and the server has no image library.

## SourcePath: why the rescue is on the server

`CoinImages.SourcePath` records where a photo's original full-resolution file
lives on the host. `PUT /api/coins/:id` replaces a coin's whole image set, and
every operation that touches photos re-sends the full array — usually as bare
base64 strings that carry no path. Without a rescue step, editing one photo
silently erases the recorded location of every other photo on the coin.

There is a client-side mitigation (`src/app/services/image-source-paths.ts`, a
session registry that enriches outgoing arrays with paths it has been told
about), and it is not sufficient. It only helps when this browser session
either ran the import that computed the path or opened the coin in the viewer.
A reload, a second tab, a different client, a replayed request or a re-imported
JSON export all leave the registry empty, and the paths go to NULL anyway. The
server owns the data and is the last code to run before it is destroyed, so the
guarantee belongs there; with it in place the client registry is an
optimisation that saves a read, not something correctness depends on.

The reconciliation matches on the base64 blob because there is no image id in
the `imagePaths` array — the blob is the only identity an incoming entry
carries. Rows are loaded into a `Map` keyed by that string, making the whole
pass O(n) in the number of photos rather than O(n²) string comparisons over
multi-hundred-kilobyte values. The real cost is the read itself: a coin with
eight to ten photos means a few megabytes of `NVARCHAR(MAX)` coming back, which
is the same order as the body the client just uploaded in the same request, and
it happens once per save of one coin. Two things keep it off the common path —
`WHERE SourcePath IS NOT NULL` skips the blobs of every image with nothing
worth preserving, and the caller skips the read entirely when no incoming entry
needs rescuing. Hashing the blobs in SQL to avoid moving them was considered
and rejected: it buys little at one-coin scale and adds a correctness surface
for nothing.

## The `imagePaths` payload shape

Despite its name, `imagePaths` holds base64 image data. When images gained a
source path, the choice was between making the array polymorphic — each element
either a bare string or `{ imageData, sourcePath }` — and adding a second
parallel `imageSourcePaths` array.

The single polymorphic array won on two grounds. Two parallel arrays can fall
out of alignment: different lengths, or a skipped empty entry shifting every
path by one, and the result is the wrong path attached to the wrong photo with
nothing reporting it. And one array keeps one replacement semantic — sending
`imagePaths` means "these are now the coin's images, in this order", with no
second key that could be present or absent independently. The bare-string form
is permanent, not transitional: a JSON inventory exported before the feature
existed contains plain base64 strings, and re-importing one has to keep working.

## Support bundles

The bundle is a file on the user's Desktop rather than an upload because GitHub
has no API for issue attachments — a human dragging the file into the comment
box is the only route. Uploading would mean shipping a credential inside a
public desktop application, where any token that can file an issue can be
extracted from the binary. That is not a solvable problem, only a deferrable
one, and nothing in this feature authenticates to anything.

The ZIP writer in `support/zip.ts` is hand-written rather than a dependency.
Node ships `zlib` (raw DEFLATE) but no archiver, the server tree keeps its
runtime dependency list deliberately small, and the container format has not
changed since 1993 — roughly 120 lines, verified by handing the bytes to
Windows' own ZIP reader in `zip.spec.ts`.

Redaction runs before anything is written, not on the way out. Once an
unredacted copy exists on disk, somebody will attach *that* one. The report is
redacted a second time inside `buildBundleZip`, because between the preview and
the bundle the user has edited the text — typing a path into that box is
entirely natural, and the pass is idempotent on text that is already clean.

## Migrations

The migrations are operator runbooks as much as scripts: there is no SQL Server
in the development environment and no harness anywhere that executes a `.sql`
file, so they are verified by *reading* them (`migration-0NN.spec.ts` parses
the text and asserts against `setup-database.sql`). Treat a green spec run as
"this file says the right things", never as "this migration has been run".

Data migrations and schema migrations are kept in separate files on purpose.
Migration 007 fills in blank metal columns and refuses to touch `Coins.Weight`;
migration 008 converts that column from troy ounces to grams. Bundling them
would mean a cautious blank-filler and a one-way destructive unit conversion
could only ever be rolled back together — and a doubled conversion is
undetectable afterwards, because nothing in the row reveals which unit it is
in.

The seed in migration 013 is generated from reviewable JSON rather than written
as T-SQL by hand. There is no redistributable, machine-readable dataset of
denominations by issuer: Nomisma is coin-type data under non-commercial terms,
Numista answers 403 to automated reads, and WorldCoinDatabase has no export. So
the data is authored — hundreds of entries somebody had to be sure about — and
the only way a file that size survives is if the author reviews and diffs data,
not statements. The generator's validation exists because a file of that size
goes wrong quietly: an unknown issuer key drops a row from the generated JOIN
with nothing reported, and a label duplicated under one issuer makes every
resolution of that text ambiguous, which resolves to NULL — so a duplicated
seed row does not add a denomination, it deletes one.
