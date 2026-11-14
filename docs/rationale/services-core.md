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
that produces one wrong digit nobody notices. Two guards exist because of
that. The first is the identity `grossWeightGrams × pmPercent / 100 =
pmWeightGrams`, asserted on every row that carries all three, which turns a
transposed digit into a red test rather than a melt value that is quietly
$100 out. The second is `sql-pm-reference-parity.spec.ts`, which exists
because migration 007 needs the same table in T-SQL and SQL cannot import a
TypeScript module; the table is therefore written twice, and that spec reads
both files off disk and compares them.

The governing rule of the whole area — a wrong purity silently produces a
wrong melt value, a blank field is visible and the user can fix it — is why
there are deliberate gaps in the table rather than best guesses. The 1942
nickel, the 1982 cent and the 1971-78 Eisenhower dollar were each struck in
two alloys in the same year, and nothing in a Quicken security name or a
spreadsheet row distinguishes them.

## Why the metal inference is a separate, coarser module

For a long time `composePmFields` was all-or-nothing: it asked the reference
table for the complete four-field answer and, the moment no catalogued row
matched, returned nothing. A coin whose exact weight and purity were unknown
therefore ended up with no METAL recorded either, even where the metal was
never in doubt — a US $20 is gold whether or not the table has a row for that
particular issue.

`metal-inference.ts` is the coarse half of that question, split out so it can
answer on its own. It only ever runs after the table has declined, and all it
can supply is Metal Content. Its rules are deliberately rules that are true by
definition of the series or the face value, never rules that are usually true,
which is why it reads the coin type and the denomination but never the
category, the notes or the grade. A coin filed under a "Gold Coins" category
is a statement about the owner's filing cabinet, not about the coin.

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
never from the full record. A whole-record write blanks columns the user never
touched, which is a failure this project has already had once.

### Why a new coin is a local draft

Clicking "Add coin" used to POST an empty record, and the backend answered
`400 {"error":"denomination is required"}` — a red error toast before the user
had typed a character. The fix was not a Save button, because saving
aggressively is a property worth keeping; it was to delay only the first
write. A new coin is local until it satisfies the same 2-of-3 rule the
importer applies, at which point it saves itself and behaves like every other
coin from then on.

Drafts are not persisted anywhere. An empty row is not data, and remembering
it would mean inventing a second, client-only storage format for coins.

### Why photographs are fetched one coin at a time

`GET /api/coins` used to inline every photograph of every coin. Past roughly a
hundred coins the response could not be built at all: `JSON.stringify` threw
`RangeError: Invalid string length`, the client saw a 500, and the message on
screen blamed the database — which had in fact handed over every row. The list
now returns `imageCount` and no `imagePaths` key, and the photographs come
back per coin, on demand.

That makes `imagePaths` a three-state field — loaded, loaded-and-empty, and
not-loaded — and the distinction is load-bearing rather than pedantic.
`PUT /api/coins/:id` replaces a coin's whole image set, and several UI actions
build that array out of whatever is in memory. Treating "not loaded" as "no
photographs" deletes pictures. That is why the hydrator rejects on failure
instead of resolving with an empty array, and why `coin-photos.ts` exists at
all: nine call sites asking the same question needed one answer.

The same episode is why the app now distinguishes a connection failure from a
delivery failure. One bare error string had to mean both "what went wrong" and
"is my collection all right", and it got the second one wrong. The server
classifies its own failures into stages and the client words the banner from
that.

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
