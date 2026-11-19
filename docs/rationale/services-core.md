# Rationale: core frontend services

Background reasoning for `src/app/services/` — the Quicken and spreadsheet
importers, the precious-metal reference data, the inventory store, and the
statistics module. It exists so that the source files can carry the rules a
developer needs while reading them, and leave the longer "why we ended up
here" story in one place.

Nothing here is required reading to change the code. It is here for the
moments when a rule looks arbitrary and you are about to simplify it.

## Why the precious-metal data is a table and not a formula

A coin's alloy follows from its country, its denomination and its year, and
from nothing else that is reliably present in an import. There is no formula:
US gold went through three statutory standards between 1795 and 1933, the
subsidiary silver went through four, and the Coinage Act of 1965 removed
silver from the dime and the quarter outright with no transition at all. So
`pm-reference.ts` is a table of catalogued issues, and every row of it was
transcribed by hand.

Hand transcription of a few hundred decimal numbers is exactly the activity
that produces one wrong digit nobody notices. The guard is the identity
`grossWeightGrams × pmPercent / 100 = pmWeightGrams`, asserted on every row
that carries all three, which turns a transposed digit into a red test rather
than a melt value that is quietly $100 out.

The governing rule of the whole area — a wrong purity silently produces a
wrong melt value, a blank field is visible and the user can fix it — is why
there are deliberate gaps in the table rather than best guesses. The 1942
nickel, the 1982 cent and the 1971-78 Eisenhower dollar were each struck in
two alloys in the same year, and nothing in a Quicken security name or a
spreadsheet row distinguishes them.

## Why the metal inference is a separate, coarser module

The reference table gives a complete answer or none. Without a fallback, a
coin whose exact weight and purity are unknown would get no metal either, even
where the metal is never in doubt: a US $20 is gold whether or not the table
has a row for that issue.

`metal-inference.ts` is that coarse fallback. It runs only after the table has
declined, and all it can supply is Metal Content. Its rules are deliberately rules that are true by
definition of the series or the face value, never rules that are usually true,
which is why it reads the coin type and the denomination but never the
category, the notes or the grade. A coin filed under a "Gold Coins" category
is a statement about the collector's filing, not about the coin.

## Why one adapter sits between the reference data and a coin record

Three features need the alloy written into a coin: the Quicken import, the
CSV/Excel import, and the Settings maintenance backfill. They write the same
five fields, from the same lookups, under slightly different rules about what
they are allowed to overwrite.

`pm-fill.ts` is the single place the reference table's vocabulary is renamed
into a coin record's. Two hand-written copies of that mapping is how an
imported coin and a backfilled coin come to disagree about the same physical
object: someone adds a sixth field, or changes which lookup is called, fixes
one caller and not the other. The callers differ only in what they may write,
never in what they believe.

## Why the importer flags a guess instead of refusing or dropping

A bare "3¢" in a Quicken security name is either a three-cent silver or a
three-cent nickel, and between 1865 and 1873 the date cannot tell you which.
Three options were on the table: refuse to read it, drop the record, or guess.

The first two were rejected because a record that does not import is a record
the user has to find and re-enter by hand, and the importer has enough
information to make a good guess (within the overlap, three-cent silver
business strikes are very scarce while the nickel was struck in the millions,
with proofs as the standing exception). The third is only acceptable if the
guess cannot be mistaken for a fact — which is what `AmbiguousReading` is
for. The row imports, the preview shows both candidates and the reasoning, and
the user re-points or drops it.

The channel is general rather than three-cent-specific on purpose. There is
deliberately no per-denomination machinery anywhere in this project: the rules
are general, and a file per denomination would be noise.

The user's answer goes back in through the parser rather than being painted
onto its output, because the coin type and all five alloy and weight fields
are derived from the denomination. Flipping "3CN" to "3CS" in the caller
leaves a trime carrying the nickel's composition and weight.

## Why the importer tolerates so much, and refuses in a few places

Quicken security names are hand-typed free text, so almost every rule in
`quicken-import.service.ts` is a tolerance: case-insensitive matching, several
spellings per concept, whole-token anchoring so a grading company cannot be
found inside a longer word. The refusals are the interesting part.

The denomination ladder is an if/else over substring tests, so a shorter cent
spelling that happens to sit inside a longer one wins whenever it is tried
first. "25¢" contains "5¢" and "½10¢" contains "10¢", and both mis-reads are
silent and both do damage downstream: a wrong denomination collides with the
real coins of that denomination in the same account, and the image matcher
then cross-files the photographs. Longest spelling first is the whole rule.

A multi-coin set gets no denomination at all. Assigning nothing requires its
own branch rather than merely skipping one, because an if/else ladder that
skips a branch carries on down and the generic eagle test below would label
the set a $10 gold piece.

## Why the spreadsheet import became its own subsystem

The CSV path already owned everything an Excel import needs — a mapping
screen, the 2-of-3 completeness rule, a preview and an exceptions list — and
all of it is built on `headers: string[]` plus `rows: string[][]`. So the
whole job of the `.xlsx` path is to produce those two arrays. Nothing below
the mapping grid learns that a workbook was involved. The alternative was a
second import modal, which would have drifted from the first within a release
or two.

`read-excel-file` was chosen over SheetJS and ExcelJS. SheetJS's distribution
moved off npm, so `npm install xlsx` resolves to a build with two unfixed
advisories, both triggered by reading a crafted file — which is precisely what
this module does, with a file the user chose. ExcelJS is maintained but is
built for Node, and its browser dist is about a megabyte against a 1 MB hard
bundle budget. `read-excel-file` is browser-first, read-only, and understands
number formats, which is the one capability that actually matters: it is how a
cell holding 45678 is known to be 21 January 2025.

### Why header synonyms exist, and why there are so few of them

Comparing a header to each field's key or label with `===` is provably
complete for the app's own export — those columns are derived from the same
list — and close to useless for a spreadsheet somebody else built. `Yr`,
`Cost`, `MM`, `TPG` and `Cert #` all arrive unmapped, so a thirty-column
workbook means thirty dropdowns before the first coin can be imported. That is
the single biggest obstacle to a non-technical collector adopting the app.

The opposite failure is worse, and it is what keeps the synonym table small. A
user re-checks a dropdown that says "(skip)". They do not re-check one that
already says "Purchase Price". So `Price`, `Amount` and `Total` have no
synonyms at all, an exact match always beats a synonym, and two headers
claiming one field with equal confidence leave both blank.

`Weight (oz)` is refused outright, and it is worth knowing why the two obvious
kindnesses were both rejected. Mapping it straight onto `weight` imports a
Morgan dollar's 0.7734 troy ounces as 0.7734 grams — a 31× understatement that
looks entirely plausible in a grid. Converting it on the way in is
arithmetically right but makes a cell's meaning depend on the text in the
header, so a spreadsheet already converted to grams but left with the old
heading is multiplied by 31 instead. An unmapped column costs one dropdown and
is visible; neither silent error is recoverable.

## Why the inventory store is split into plain helper classes

`InventoryService` is the single front door to the collection, and it owns the
signals every component reads. The work is delegated to focused classes under
`inventory/` — change tracking, drafts, field edits, whole-coin operations,
lookups, connection handling, metrics.

Those helpers are ordinary classes created with `new`, not Angular services.
The constraint that produced that choice is that `InventoryService` must stay
constructible from an injection context providing only `ApiService`,
`LoggingService` and `NotificationService`, which is how every test builds it.
The signals are created in the service and passed in, so there is exactly one
copy of each piece of state regardless of who writes to it.

### Why edits diff against the server, not the screen

The UI updates optimistically: the moment the user types, the on-screen value
changes, and the PUT follows a second later. That means two versions of every
coin exist, and the one a new edit is compared against decides whether a
failed save can ever be retried. Diffing against the optimistic copy looks
fine until a save fails — the optimistic copy already holds the new value, so
re-typing the same value produces an empty diff and the edit is lost for good.
`CoinChangeTracker` therefore holds what the server has confirmed, separately
from what the screen shows.

The related rule is that a PUT body is built from the dirty-field set and
never from the full record. `PUT /api/coins/:id` writes every field it is
given, so a whole-record write blanks or reverts columns the user never
touched. The same reason makes every editor write carry one field, and makes
the PM backfill send only the fields that were blank.

### Why a new coin is a local draft

The backend refuses a coin without a denomination (400). Posting an empty
record on Add Coin would therefore show an error before the user had typed
anything. Saving aggressively is worth keeping, so only the first write is
delayed: a new coin stays local until it satisfies the same 2-of-3 rule the
importers apply, then saves itself and behaves like every other coin.

Drafts are not persisted anywhere. An empty row is not data, and remembering
it would mean a second, client-only storage format for coins.

### Why photographs are fetched one coin at a time

A list response that inlined every photograph cannot be built past roughly a
hundred coins (`JSON.stringify` throws `RangeError: Invalid string length`;
see [server.md](server.md)). So the list carries `imageCount` and no
`imagePaths`, and photographs come per coin, on demand.

That makes `imagePaths` a three-state field (loaded, loaded and empty, not
loaded), and the distinction matters: `PUT /api/coins/:id` replaces a coin's
whole image set, and several UI actions build that array from whatever is in
memory. Treating "not loaded" as "no photographs" deletes pictures. That is
why the hydrator rejects on failure instead of resolving with an empty array,
and why `coin-photos.ts` gives the many call sites one answer.

### Why failures are classified by stage

The database can hand over every row and the server still fail to send the
response. One error string cannot say both "what went wrong" and "is my
collection all right", so the server labels each failure `connection`,
`database` or `delivery`, and the client words the banner from that. Only a
delivery failure says the data is safe.

### Why debounced edits are not used for bulk jobs

`updateCoin()` debounces per coin, so a loop over many coins fires every PUT at
once when the timers expire. Bulk jobs (the PM backfill, the unlinked-coins
fix) use `updateCoinNow()` and await each write in turn, and can report which
coins failed.

## Why importers resolve through a cached index

Resolving a denomination folds its spelling through the alias table and
searches every issuer. A 2,000-row sheet re-planned on every mapping change
would do that millions of times, so importers build an index once per lookup
array (`denomination-index.ts`) and reuse it while the array is the same
instance. The index rebuilds issuers from `Denominations.Country` and must
never map a historical issuer onto the modern country containing it.

## Why the HTTP layer retries only some writes

Writes are retried twice with backoff only for failures that are transient by
nature (status 0, 408, 429, 5xx). A 4xx is a refusal that will repeat. Backup
and restore calls are never retried: a retried restore would replace the
collection twice, and a swallowed failure could leave the user believing a
backup exists.

## Why preferences live in IndexedDB under separate keys

localStorage has a small size limit. Filter state and the online-lookup
consent are stored under their own keys rather than inside `AppSettings`, so a
failed read of the shared settings object cannot leave the grid filtered or
quietly turn the outbound lookup back on.

## Why the statistics module is hand-rolled SVG

Two reasons, and the second is the stronger one.

The production bundle is already past the warning budget and under a 1 MB hard
error. Chart.js is around 200 kB minified and ECharts around a megabyte; both
would have to be lazy-loaded behind a dynamic import, which means a spinner on
a dialog that otherwise opens instantly. Bar, line and donut geometry is a few
dozen lines of arithmetic.

More importantly, the frontend suite runs under Node with no jsdom. Nothing
renders, nothing can be screenshotted, and `getBoundingClientRect` does not
exist, so the only assertion available against a charting library would be "we
called the library". Pulling every number that ends up in an SVG attribute out
into pure functions over numbers makes the chart testable to the pixel with no
DOM at all. That constraint — logic in pure modules, components reduced to
wiring — shapes most of this directory and is the reason so many files here
take their dependencies as parameters rather than importing them.

### Why every total carries its gaps

The obvious way to write a totals panel is `inv.reduce((s, c) => s +
c.currentValue, 0)`. On a collection where 31 of 125 coins have never been
appraised, that produces a number that looks like the value of 125 coins and
is actually the value of 94, understated by an unknown amount, with nothing on
screen saying so. So every measure is `{ total, knownCount, unknownCount }`
and `total` is null — not zero — when nothing is known.

The judgement call underneath it is that a non-positive price is read as
absent. `purchasePrice` and `currentValue` are non-optional number columns, so
there is no null to read, and the schema cannot tell "never priced" from
"genuinely free". Nobody keeps a coin they believe to be worth nothing, so the
ambiguity is resolved towards "not recorded". The cost is that a genuinely
free coin reports as "cost not recorded"; that is the safer of the two errors,
because it invites someone to look.

Gain is computed coin by coin rather than as value minus cost, because those
two totals are sums over different populations and subtracting them is not the
gain on anything.
