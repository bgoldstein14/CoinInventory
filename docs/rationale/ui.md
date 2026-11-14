# UI rationale

Background on the Angular side of the app — the grid, the panels, the modals,
the shared stores and the types behind them. The *rules* live in comments
beside the code they constrain. What is collected here is the reasoning behind
a handful of those rules: things a newcomer will otherwise have to rediscover,
and a few traps that have already been walked into once.

This is not a changelog. If a section reads like history, it is here because
the history explains a constraint that is still live.

---

## The domain model and shared types

### Photographs are the awkward part of `CoinRecord`

`imagePaths` has three states and only two of them are obvious:

| value | meaning |
| --- | --- |
| `['data:...', ...]` | loaded, and the coin has these photographs |
| `[]` | loaded, and the coin genuinely has none |
| key absent | **not loaded — we do not know** |

`GET /api/coins` returns the third state for every coin, so "absent" is the
normal startup condition rather than an edge case. Conflating it with `[]` is
destructive: `PUT /api/coins/:id` carrying an `imagePaths` key *replaces* the
coin's whole image set, so writing "not loaded" as an empty array erases every
photograph on that coin, silently, with a 200 response.

Read the field through `coinPhotoCount()` / `coinHasPhotos()` in
`services/coin-photos.ts`, which fall back to the `imageCount` the list sends
for free. Never `coin.imagePaths.length`.

### Fields you will find in old data but not in the code

Grepping the schema or an old export turns up names the app no longer has.
None of them are bugs:

- **`tags`** — was plumbed end to end except for any way to enter one, so
  every coin carried an empty array and the column could only render a dash.
- **coin-level `dealer`** — superseded by the dealer on each transaction row,
  which survives a coin being bought from one dealer and sold to another.
  **`TransactionRecord.dealer` is a different field and it stays**; if you are
  grepping for `dealer`, check which of the two you have found.
- **a "Certified By" grid column** — showed the grading company alone, which
  `certBadgeLabel()` already leads with, so with both switched on the grid read
  "NGC" beside "NGC #2599001". The *report* field label "Certified By" is a
  different thing and is live.
- **`Weight (oz)`** — the gross weight column was troy ounces under a unit-less
  label, which is how it came to be misread. Stored values were multiplied by
  31.1034768 when it changed. Both weight columns are now grams so they can be
  divided into one another without conversion.

The import normaliser in `services/inventory/coin-factory.ts` does not copy
unknown keys across, so an old JSON or CSV file still loads — just without
those values.

### Melt value: the formula that looks right and is not

    (pmWeightGrams * pmPercent / 100) * spotPricePerGram   // WRONG

This applies purity twice. `pmWeightGrams` is *already* the weight of the pure
precious metal, not the coin's gross weight — a $20 Saint-Gaudens is 33.44 g
gross at 90% fine, so `pmWeightGrams` is 30.09 g, which *is* the 0.9675 oz AGW
the trade quotes. Discounting again understates every figure by the purity
factor: about 10% on 90% gold and silver, 60% on a 40% silver Kennedy half.

`computeMeltValue()` in `services/inventory/inventory-metrics.ts` is the one
place the arithmetic is written. A `null` from it means "we cannot say", which
renders as an em-dash — never `$0.00`, which would be a claim.

### Collection status, and why there is no separate want list

The alternative design is a wish list that is its own collection of its own
objects. A want-list entry is a coin description — year, mint mark,
denomination, the grade you are hunting, what you will pay — which is precisely
a `CoinRecord`. A second object type would duplicate every field, every
importer, every editor control and every column, and the day the coin arrives
you would copy it across by hand and lose the notes you had been keeping.

"Duplicate" is deliberately *not* one of the five values. A duplicate is a coin
you own; the word describes your holding of it, not its state. Making it a
status would make it mutually exclusive with For Sale — and a duplicate being
for sale is the single most likely thing to be true about a duplicate.

### No per-denomination special cases

There are no modules that single out one type of coin. A rule that applies to
one coin is expected to be written so it applies across the board, which is why
`AmbiguousReading.field` is a union rather than a hard-coded `'denomination'`:
the next ambiguous reading uses the same channel instead of inventing a second
one.

---

## The coin editor

### Why the denomination field has both an id and a free-text column

`Coins.Denomination` (NVARCHAR) came first and holds whatever any source ever
put there — a QIF memo, a CSV cell, a hand-typed note. `Coins.DenominationId`
was added later as a link into the `Denominations` reference table.

The two columns answer different questions and both are kept on purpose. The id
is the **answer** — which denomination this coin is. The text is the
**evidence** — what the source actually said. A coin whose id says `8 Reales`
while its text reads `Pillar Dollar` is not corrupt; it is a correctly linked
import that preserved its provenance. Nothing in the app rewrites the text
column, which is why so much of the picker's logic is about *showing* a
resolution rather than *saving* one.

A consequence worth internalising: a coin stored as `Half Dollar` will display
as `50¢` and stay stored as `Half Dollar`. Only the user picking `50¢` from the
dropdown writes the canonical label.

### Why the denomination control was rebuilt

It used to be a flat `<select>` grouped by country and **filtered** to the
coin's country. Two things broke that:

- The reference table grew to over a thousand denominations under dozens of
  issuers. A single flat list of that size is unusable, and "a dropdown nobody
  can use" counts as a failure even when it technically works.
- Filtering by country fails the very case the rebuild existed for. Mexican
  `8 Reales` coins are stored with `Country = 'United States'` because the QIF
  parser never set one. A country-scoped list offers every US denomination and
  no route at all to the row the user wants — and they would have to correct
  the country first, which is the thing they are trying to fix.

Hence bias-not-filter, plus a type-ahead. Everything else in
`denomination-picker.ts` follows from those two constraints.

### The "two issuers, one label" problem

`Crown` is a British coin and an Australian one. This is why every `<option>`
in the denomination select carries `String(denominationId)` rather than the
label, and why the alias layer and the resolver both refuse to answer when a
spelling is ambiguous. Inventing an answer files the coin under an issuer the
user never chose — invisibly, and for good. "Other", by contrast, is visible.

### Numismatic distinctions the code refuses to collapse

These look like synonyms and are not. Each is an omission from the alias table
with a reason:

- **Nickel vs Half Dime** — a Half Dime (1794–1873, silver) and a Nickel
  (1866–) are different coins that merely share a face value. While they were
  folded together, the image matcher could not tell a photograph of one from
  the other.
- **Trade Dollar vs $1** — 420 grains, struck for trade with the Orient, not
  the 412.5-grain standard dollar. (Alloy-inference code *does* fold them,
  because both are 90% silver; that is a different question.)
- **Penny** — the US cent to an American, the British penny to everyone else,
  and their alloys part company in 1943.
- **Eagle** — a Gold Eagle, a Silver Eagle and the classic $10 Eagle are three
  different coins in three metals. The qualified forms (`half eagle`,
  `quarter eagle`, `double eagle`) are safe; the bare word is not.
- **"3 cent"** — the 1851–1889 three-cent span covers both the silver trime and
  the three-cent nickel. A bare "3¢" does not say which, and the importer goes
  out of its way to flag it.

### Why the Metal dropdown has its own handler

Metal is the one field that can turn an unanswerable coin into an answerable
one on its own. An 1855 "$1" is either a 26.73 g silver dollar or a 1.672 g
gold dollar; the reference table refuses to choose, and the user's choice of
metal is the only evidence that settles it. Picking a metal therefore re-runs
the weight/composition inference.

### Where the catalogue reference came from

Collectors were typing references like "Sear 6819" into the Variety box for
want of anywhere else to put them. The Catalogue / Catalogue Number pair gives
them a home. For an ancient coin — no year, no denomination, no grade — the
catalogue reference is frequently the only identification there is, which is
why it sits on the certification row next to the slab number: both answer "what
does an outside authority call this coin?"

Nothing is migrated out of Variety automatically. Only a human can tell a
catalogue reference from a real variety.

Entering a reference also looks nothing up, and that is a decision rather than
an omission: of the seeded catalogues only RIC and Crawford have an open
machine-readable source, and numismatics.org answers HTTP 403 to automated
requests. A lookup that silently fills nothing for three catalogues out of five
is worse than no lookup.

### Layout decisions that are easy to undo by accident

- The weight column is **grams** and the unit is in the label. Five decimals
  are kept so a derived troy-ounce figure can be correct in its own fifth
  decimal.
- The cert-company input is 12ch, not the ~7.5ch that looks right. `ch` is the
  width of the digit `0`, grader names are uppercase (wider), and the global
  `box-sizing: border-box` means the width must also pay for padding and
  border. Anything tighter clips "ANACS".
- Several rows contain a hidden spacer input purely to keep the CSS grid the
  same shape as the rows around them. They look like dead markup and are not.

---

## Reference data, Settings and spot prices

### The scale of the denomination list drives the whole Reference Data screen

There are roughly a thousand denominations across dozens of issuers. The screen
that preceded `category-modal` rendered them as one flat list of chips, which
was workable at a few dozen rows and unusable at this size.

Almost every design choice there follows from the number:

- denominations are grouped under their issuer, and groups collapse;
- search spans all issuers, because a label alone does not say which issuer
  owns it;
- the dialog opens on **Categories**, not Denominations, so a visit that only
  wanted to add a category does not pay for the big pane;
- Settings deliberately has no denomination editor at all (see below);
- the pane scrolls, not the dialog, so the sidebar never scrolls away.

### Why Settings has no denomination editor

Settings used to carry a chip list for denominations alongside the other
reference lists. It hard-coded `country: 'US'` on everything it created and
could not set an issuer at all, so adding "8 Reales" from Settings filed a
Mexican denomination under the United States — precisely the confusion the
issuer model exists to prevent.

The general lesson, which applies to any future convenience editor: a
denomination is not a bare string. It is owned by an issuer and carries a
country the coin editor's dropdown groups by. A control that cannot ask for
those fields cannot create a valid row, and a second, weaker editor for the
same data is a way to enter data the better one would have refused.

**That argument turned out to apply to the other four lists as well, and they
have now gone the same way.** Categories, sets/albums, mint marks and metal
contents are each a single string with no foreign key, so a chip list *could*
create a valid row for them — but the Settings chips still removed an entry on
one click with no in-use count and no confirmation, while the Reference Data
pane named the number of coins affected and asked first. Three of the four
existed in both places and drifted; metal content existed only in Settings, so
it was given a pane rather than deleted. Settings now edits no reference list
at all and carries one button that opens the screen that does. The general
lesson stands and generalises: the problem was never that a denomination is
complicated, it was that one list had two editors with different standards of
care.

### Why bulk textarea editing of reference lists was removed

Each reference list in Settings once had two editors: chips that applied
immediately, and a newline-separated textarea applied on Save. The textareas
were removed rather than fixed, because rebuilding a reference *record* from a
line of *text* discards everything the record carries beyond its label:

- denominations lost their country, which emptied the coin editor's
  country-grouped dropdown;
- ids were re-derived from line position, so they stopped matching the database
  rows they stood for and a later delete could hit the wrong record;
- labels were read back from *display* text, so prettified forms (`1/-`
  rendered as `1 sh`) were stored as the real label;
- some lists were applied with a plain `signal.set()`, which changed the list in
  memory and never told the backend, so the edit reverted on reload.

Chips avoid all of this by adding or removing one entry at a time through
`InventoryService`, which persists the change and leaves the rest of the record
alone. Worth knowing before anyone proposes a "quick bulk edit" box again.

### Why the Reference Data sidebar is not a tab strip

Tabs look like the obvious shape and were rejected for reasons specific to this
screen: the type names are long ("Collection Sets / Albums") and will not fit
one row inside a modal; each entry carries a second line of text ("how many
entries, how many coins") that tabs have no room for; and the denominations
pane needs vertical space more than horizontal. At a narrow viewport the
sidebar collapses into a horizontal strip above the pane — the tab layout, kept
as the fallback rather than the default.

---

## The inventory grid and detail panels

### Photographs never travel in the coin list

`GET /api/coins` returns one row per coin and no image bytes. This is a hard
limit, not a preference: when photographs were inlined as `data:` URLs the list
response for a real collection (around a hundred coins, each with eight to ten
shots) could no longer be turned into a string at all — `JSON.stringify` threw
`RangeError: Invalid string length`. The endpoint did not get slow, it stopped
working.

Two consequences run through every component that touches a photo:

- `coin.imagePaths` is **absent**, not empty, on a coin straight from the list.
  Components use a computed that falls back to `[]`, and `imageCount` — a
  `COUNT(*)` the list sends for free — to answer "does this coin have photos?"
  without a request.
- Anything that re-collects many images into one response rebuilds the same
  failure. A batched "one thumbnail per coin" endpoint was considered and
  refused for exactly that reason; each thumbnail is its own cacheable HTTP
  response instead.

The lazy-loading rules in the grid follow from the second point: `imageCount`
decides whether to render an `<img>` at all, and `loading="lazy"` keeps the cost
on load to one screenful rather than one collection. A grep test asserts the
attribute is still on the real tag, because deleting it degrades nothing visibly
and everything quietly.

### An empty grid has three meanings, not two

"No coins" and "no coins match your filters" are the obvious two. The third is
"we have not fetched them yet", and it is the dangerous one: during the initial
load the array really is empty, so a naive `inventory().length === 0` tells a
user with a full collection that they own nothing and invites them to import —
which, accepted, duplicates the whole collection. `connected()` and
`connectionError()` exist to make the third case expressible, and the choice
between the three lives in a pure module so it can be tested.

The same principle governs the startup failure banner: the database can answer
perfectly while the server fails to *build* the response, so the banner takes
its heading from a classified failure rather than hard-coding "Database
unavailable" and sending the user hunting a connection problem that does not
exist.

### Column order has one source of truth

`src/app/types/inventory-columns.ts` holds `inventoryColumnOrder`, and both the
column-picker panel and the store that sorts the visible columns read it.
Re-ordering the template instead makes those two disagree, which is how you get
a tick-box panel whose order does not match the grid.

### Angular scopes styles to the component that declares them

A rule written in `app.scss` cannot reach markup inside a child component, and a
component that uses shared class names must `@use` the shared partial itself.
This is easy to get wrong when markup is moved out of the app shell into a
component: the markup keeps working, the classes keep matching nothing.

The attached-photos gallery once shipped this way. Without `_modal.scss` there
was no `.modal-backdrop` rule, so the "overlay" had no fixed positioning, no
dimmed background and no card chrome — it rendered inline, underneath the
inventory table. Since that table has a Photo column of its own, what the user
saw was every coin's thumbnail with a strip of one coin's photos tacked below
it, and the reasonable conclusion was "this dialog shows me all the images". A
missing stylesheet import read as a data-scoping bug.

### Photo sizes differ per screen on purpose

| screen | size | question |
| --- | --- | --- |
| near-match review rows | 88px | is this photo this coin? |
| batch-import tiles | 128px | scan a folder quickly |
| coin gallery tiles | 220px tile, 200px photo | look at one coin properly |

None of these cost extra bandwidth — the `<img>` already points at the full
original via `createObjectURL`, so the browser decoded it regardless of the box
it is painted into. The size only buys legibility.

`object-fit` is always `contain`, never `cover`. Coins are round and
photographed centred, so filling a square box by cropping shaves the rim off
every one of them — and the rim, the date, the mint mark and the toning are
precisely what a user is looking at to decide whether a photo belongs to a coin.

### The gallery is also the uploader

The gallery began as a viewer, and opening it required the coin to already have
photos. That is coherent right up to the moment the gallery becomes the only
per-coin place to attach a photo — it owns both the file picker and the drop
target — at which point a coin with no photos can never get its first one. The
gate is gone; the empty state is the replacement. Anyone re-adding an
`imagePaths.length > 0` check will recreate the trap.

---

## Reports and statistics

### How a printed document comes to disagree with the screen

Three of the grid's columns cannot be rendered from a `CoinRecord` alone.
`meltValue` needs today's spot prices, `catalogReference` needs the Catalogs
lookup, and `denomination` needs the Denominations lookup — the coin stores only
an id in the last two cases, and the label behind it lives on
`InventoryService`.

Reports render their cells by delegating to the grid's own
`formatInventoryCell`, which is what keeps a page and the screen it came from in
agreement. That only works if the *arguments* are forwarded as well as the coin,
and each lookup arrived as a new positional parameter threaded through
`ReportModal -> buildInsuranceReport/buildInventoryReport -> toRows ->
formatReportCell`. Every time one was added, a call site that failed to pass it
on still compiled. The catalogue reference shipped exactly that way: the grid
showed "Sear 6819" and the printed schedule showed "6819", with nothing failing
and no way to tell which document was complete.

Two defences came out of that and are worth understanding before touching the
builders: `toRows` takes the whole `ReportInput` object rather than the pieces
it currently needs, so the next lookup reaches both reports or neither; and the
grep tests in `src/app/types/denomination-lookup-wiring.spec.ts` assert that the
lookups are literally present at the call sites.

### Why the client downscales photographs a second time

`CoinRecord.imagePaths` already holds downscaled copies — roughly 1600px, about
250 KB of base64 each — sized for a full-screen viewer. Embedding those in a
report is 300 coins x 2 photographs x 250 KB, about 150 MB in a single HTML
string handed to a print renderer. That does not make a big PDF; it makes a
browser that stops responding. The image pass is also sequential on purpose: a
`Promise.all` is faster and reintroduces the same peak.

### Picking a colour for a chart

The chart palette in `statistics-modal.scss` is not the app's accent brown. The
primary-button brown `#7a5b35` and the Settings dialog border `#8e5b2d` both
fall under the data-viz chroma floor against the dialog's white surface
(measured 0.067 and 0.091 against a floor of 0.10), which means that as a large
flat fill they read as grey rather than as a colour. `#a9742f` is the same
bronze family stepped up until it passes. If you add a colour, validate it
against the real surface rather than a generic default:

    node scripts/validate_palette.js "#a9742f" --mode light --surface "#ffffff"

One hue is all the statistics view needs: the ranked bars are magnitudes of one
measure and the spend chart is one series, so there is no identity for a second
hue to carry. The folded "Other" bar takes the de-emphasis grey, which is a
de-emphasis and not a second series. There is deliberately no dark mode — the
application has no dark theme, and a chart that flipped on its own inside a
cream dialog would look broken.

### Insurance-schedule semantics

The money totals and the insurance schedule are built on
`isHeldInCollection()`, which tests **possession, not title**. A coin that is
`for-sale` is still on the shelf and still insured; a coin that is `ordered` is
paid for but in the post, and a schedule listing it is a claim waiting to be
denied. A want-list coin must never inflate the value of a collection that does
not exist.

A report also deliberately disagrees with the grid in one place: a money field
that is zero prints blank rather than `$0.00`, because a `$0.00` row in a
schedule is a written claim that the coin is worth nothing, and the totals count
it as unknown.

Note for fixtures: a coin record with no `collectionStatus` reads as `owned`, so
a fixture that omits the field exercises none of this logic.

---

## Import screens

### Why an import screen never offers to force a row in

Both the QIF and the CSV importers once had, or nearly had, an escape hatch that
let the user push a record past the "at least two of Year / Coin Type /
Denomination" check. It appeared to work and did not. The backend answers
`400 {"error":"denomination is required"}`, so the coin showed up in the grid as
an in-memory record with no database row behind it, and every subsequent edit
failed against an id the server had never issued.

The resulting rule, asserted in both components' specs, is that the UI must
never offer to create a coin the backend would refuse. The replacement for the
hatch is reporting: a refused row is listed with its raw security name and
everything the parser did read, so the user can fix the name at source and
re-import.

### Why the import paths share their rules

The three import paths (QIF, CSV, Excel) diverged twice, and both times the
divergence was invisible until a user hit it. First the completeness rule: QIF
enforced it while CSV did not, so the same under-specified row was accepted on
one screen and refused on the other. Then the alloy inference: a coin imported
from Quicken had its Metal, Composition, PM % and PM weight worked out from
country + denomination + year, while the same coin imported from a spreadsheet
got nothing and showed a blank melt value for ever after.

Both are now single shared modules — `services/csv/import-plan.ts` for the
2-of-3 verdict, `pmFieldsToFill` / `composePmFields` for the inference — called
from every path. Excel is not a separate importer at all: `services/xlsx/`
converts a workbook into the `headers: string[]` + `rows: string[][]` pair the
CSV path already consumes. If you are tempted to add a fourth path, add a
converter to that shape instead.

### Why the preview and the button are computed by the same call

The CSV import button used to read "Import 412 rows" and then report afterwards
that 37 had been skipped. An import whose preview cannot be trusted is one that
somebody eventually runs twice. `importCsv` imports `importPlan().accepted`
rather than re-mapping the rows, so the number on the button and the rows that
land come from one `planImport` call and cannot disagree.

### Why the image review is three tiers and not a queue

The photo share is roughly 2,140 files. An earlier two-bucket review meant a
file with no apparent match sat in a queue waiting for a decision whose only
honest answer was "yes, skip it" — hundreds of pointless clicks before reaching
anything that mattered.

The split is therefore by *what question can be asked*, not by how confident the
matcher was: matched (tick boxes), near match (one yes/no per coin), and not
imported (read-only report). Tier 3 later gained one opt-in "Attach anyway"
link, after a census of real filenames showed that of 32 skipped files 19 were
genuine single-coin photos and only 2 were actually wrong matches — the other 17
failed because a detail was *absent* rather than contradictory. The near-match
bar itself was not relaxed to fix that, deliberately.

### The attachment policy is asymmetric, and that is the point

Automatic matching excludes counterfeits and group shots, and those rows get no
rescue link at all. A **manual** attach is unconditional: no picture file is
ever off limits for a human choosing to attach it to a coin, however irrelevant
its name. Implement the exclusion in the matcher's signature-building step, not
in the coin search, or the manual side breaks silently.

### Why the progress indicator is pinned, and why the session yields

A busy indicator was built, shipped, and still reported as missing. Two separate
causes, both worth knowing:

- The indicator renders near the top of the dialog, the Save button is at the
  bottom, and `.modal` is the scrolling container — so the user pressed Save and
  watched a frozen screen while the indicator animated several screens above the
  viewport. Hence `position: sticky` on the progress block *and* a live count in
  the Save button's own label.
- Nothing paints at all unless the session yields to the event loop before each
  stage. The markup is written either way; without the yields the browser never
  gets a frame in which to show it.

There are four working phases rather than two because there are four places the
main thread goes away for a noticeable time. One of them — Angular building the
review screen — is not application code, which makes it easy to forget: do not
clear `progress` in the same task that hands the rows over, or the indicator
comes down immediately before the longest render of the whole flow.

---

## Shared state, testing and fixtures

### Columns, sort order and stored preferences

Both the visible-column list and the sort state are persisted to IndexedDB under
fixed keys with no version stamp. Neither stored value is trusted: the column
list is read as a *set* and re-sorted from the canonical order, and a stored
sort column that no longer exists falls back to the default. That is what lets
the canonical column order change without a migration — existing users pick it
up on their next load. Columns in this project genuinely have come and gone,
which is why the validation is not theoretical.

### The denomination sort table

`parseDenominationValue` holds a table of denomination spellings and face
values, written in ascending face-value order for readability. It used to scan
the table and take the first pattern found anywhere in the label, which let
short patterns shadow long ones: `$10` matched `$1`, `$2.50` matched `$2`, `25¢`
matched `5¢`. Nothing threw; rows were just sorted into the wrong place. The
two-pass exact-then-longest match means the table's order can never affect an
answer again.

### Why the QIF test corpus is synthetic

The importer was originally tested against a real set of Quicken exports: eight
large files holding several hundred securities, only about half of them coins.
The rest was an entire financial profile — stock and fund positions, a
retirement account, savings bonds, options, bank and credit-card registers,
income categories, and a street address Quicken had stored in a tag. None of
that can live in a repository.

`src/app/testing/qif-corpus/` holds a generated stand-in. What matters is that
it was not simplified in the process: the generator reproduces the original's
collision density group for group, and derives security names from the real ones
through per-attribute bijections (year, mint, denomination, grade) rather than
inventing them. That is why `generate-corpus.mjs` is as careful as it is, and
why "tidy up the fixture" is the one change that would quietly destroy it.

### The real-filenames fixture is not the real photo share

`real-filenames.fixture.ts` reads as a survey of an actual image share, and
about half of it is. The other half is constructed probes. The census in
`import-tiers.spec.ts` therefore measures a *test corpus*, and treating its
numbers as a statement about the real share has already produced a false "this
change costs two matched files" report where the true cost was zero. To measure
the share, enumerate the share.

Relatedly, QIF fixtures must use realistic security names. A placeholder like
"Old Coin" carries none of the three main details, so the parser never produces
a record at all and a test aimed at, say, the date filter quietly asserts over
an empty list and passes for the wrong reason.

### Grep tests on templates must strip comments first

Several tests read a `.html` or `.ts` file from disk and assert on its text,
because the frontend suite runs under Node with **no jsdom** and templates
cannot be rendered. This is a weak instrument for a strong requirement, and it
is the only one available.

It has one specific failure mode. The first version of the `loading="lazy"`
test read the raw file — and the comment above the `<img>` explaining why lazy
loading matters contains the string `loading="lazy"`. Deleting the attribute
from the real tag left the test green. **A test its own documentation satisfies
is not a test.** Every such test now strips comments before matching and anchors
on the tag rather than the file.

The same constraint shapes the components themselves: logic that needs testing
lives in pure modules taking plain data, not in methods that touch the DOM. The
support dialog's `addFiles` takes a `FileLike` rather than a `FileList` for
exactly this reason.
