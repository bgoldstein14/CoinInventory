# UI rationale

Background on the Angular side of the app: the grid, the panels, the modals,
the shared stores and the types behind them. The rules live beside the code
they constrain; this file collects the reasoning behind the ones a newcomer
would otherwise have to rediscover.

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
normal start-up condition. Conflating it with `[]` is destructive:
`PUT /api/coins/:id` carrying an `imagePaths` key replaces the coin's whole
image set, so writing "not loaded" as an empty array erases every photograph
on that coin, silently, with a 200 response.

Read the field through `coinPhotoCount()` / `coinHasPhotos()` in
`services/coin-photos.ts`, which fall back to the `imageCount` the list sends.
The compiler cannot catch an unguarded read (`strictNullChecks` and
`strictTemplates` are off), so `no-unguarded-image-paths.spec.ts` scans the
source instead.

`imagePaths` stays `string[]` rather than an array of objects because it is
bound straight to `<img [src]>` in several places and diffed by the change
tracker; the original file paths live in a side registry
(`image-source-paths.ts`) instead.

### Fields you will find in old data but not in the code

Old exports and backups carry names the app no longer has. None are bugs:

- **`tags`** — there was never a way to enter one.
- **`dealer`** — replaced by two fields, `purchasedFrom` and `soldTo`, because
  one string cannot describe a coin bought from one dealer and sold to another.
  A `Dealer` column in a spreadsheet now maps to Purchased From.
- **`Weight (oz)`** — the gross weight column is grams, so it can be compared
  with `pmWeightGrams` directly; an ounce column is never auto-mapped.

`services/inventory/coin-factory.ts` drops unknown keys, so old files still
load, without those values.

### Melt value: the formula that looks right and is not

    (pmWeightGrams * pmPercent / 100) * spotPricePerGram   // WRONG

This applies purity twice. `pmWeightGrams` is already the weight of the pure
metal: a $20 Saint-Gaudens is 33.44 g gross at 90% fine, so `pmWeightGrams` is
30.09 g, the 0.9675 oz AGW the trade quotes. Discounting again understates
every figure by the purity factor: about 10% on 90% gold and silver, 60% on a
40% silver Kennedy half.

`computeMeltValue()` in `services/inventory/inventory-metrics.ts` is the one
place the arithmetic is written. A `null` from it renders as `—`, never
`$0.00`, which would be a claim.

### Collection status, and why there is no separate want list

A want-list entry is a coin description (year, mint mark, denomination, the
grade you are hunting, what you will pay), which is precisely a `CoinRecord`.
A second object type would duplicate every field, importer, editor control and
column, and the day the coin arrived you would copy it across and lose the notes.

- **`ordered` is separate from `wanted`** because they are handled
  differently, though neither is in hand.
- **`ordered` is not held.** A schedule must not list a coin still in the
  post, and counting it would count both the coin and the money spent on it.
- **`sold`** lets a coin stop counting without deleting its row, photos and history.
- **Status is never derived from the sold date.** A sale may have fallen
  through, a coin may be gone with no price recorded, and auto-deriving would
  silently change existing totals. Importers may set the initial status of a
  new record; they never change an existing one.
- **Unknown values read as Owned**, so a spreadsheet typo or a status written
  by a future version never removes a coin from the collection.
- **`isHeldInCollection` exists once**, so totals and schedules cannot diverge.
- **No "Duplicate" status.** A duplicate is a coin you own; making it a status
  would make it exclusive with For Sale, the most likely thing to be true of a duplicate.

### No per-denomination special cases

A rule that applies to one coin is written to apply across the board, which is
why `AmbiguousReading.field` is a union rather than a hard-coded
`'denomination'`: the next ambiguous reading uses the same channel.

---

## The coin editor

### Why the denomination field has both an id and a free-text column

The id is the **answer** (which denomination this coin is); the text is the
**evidence** (what the source said). A coin whose id says `8 Reales` while its
text reads `Pillar Dollar` is a correctly linked import that kept its
provenance. Nothing rewrites the text, which is why so much of the picker is
about showing a resolution rather than saving one. A coin stored as `Half
Dollar` displays as `50¢` and stays `Half Dollar` until the user picks `50¢`.

### Why the picker biases by country instead of filtering

There are over a thousand denominations under dozens of issuers, so a flat
list is unusable, and filtering by the coin's country fails the case that most
needs fixing: Mexican `8 Reales` coins imported from Quicken are stored with
`Country = 'United States'`. A country-scoped list would offer no route to the
right row until the user corrected the country, which is the thing they are
trying to fix. Hence bias-not-filter plus type-ahead.

### The "two issuers, one label" problem

`Crown` is a British coin and an Australian one. So every `<option>` carries
the denomination id rather than the label, and the alias layer and the
resolver both refuse to answer when a spelling is ambiguous. Inventing an
answer files the coin under an issuer nobody chose, invisibly and for good.
"Other" is visible.

### Numismatic distinctions the code refuses to collapse

These look like synonyms and are not. Each is an omission from the alias table:

- **Nickel vs Half Dime** — a silver Half Dime (1794–1873) and a Nickel (1866–)
  merely share a face value; folding them would stop the image matcher telling
  their photographs apart.
- **Trade Dollar vs $1** — 420 grains, struck for trade with the Orient, not the
  412.5-grain standard dollar. (Alloy inference does fold them, because both are
  90% silver; that is a different question.)
- **Penny** — the US cent to an American, the British penny to everyone else.
- **Eagle** — Gold Eagle, Silver Eagle and the classic $10 Eagle are three coins
  in three metals. The qualified forms (`half eagle`, `double eagle`) are safe.
- **"3 cent"** — covers both the silver trime and the three-cent nickel.

### Why the Metal dropdown re-runs autofill

Metal is the one field that can turn an unanswerable coin into an answerable
one. An 1855 "$1" is a 26.73 g silver dollar or a 1.672 g gold dollar; the
reference table refuses to choose, and the user's metal settles it.

### Why autofill fires on `change`, not on input

Inferring from a half-typed value would fill fields from the wrong coin and
then ask to overwrite them a keystroke later. Text key fields trigger on
commit (blur or Enter); selects trigger immediately because their value is
already complete.

### Where the catalogue reference sits, and why nothing is looked up

For an ancient coin (no year, denomination or grade) the catalogue reference
is often the only identification, so it sits on the certification row next to
the slab number: both answer "what does an outside authority call this coin?".
Nothing is migrated out of Variety automatically; only a person can tell a
catalogue reference from a variety.

Entering a reference looks nothing up. Of the seeded catalogues only RIC and
Crawford have an open machine-readable source; numismatics.org answers 403 to
automated requests, and Sear, Hendin and Krause have no queryable source. A
lookup that silently fills nothing for most catalogues is worse than none.
The seeded order puts the catalogues this collection uses first (taken from
the photo filenames), because alphabetical order would put BMC on top.

### Layout decisions that are easy to undo by accident

- Weight is **grams**, unit in the label, five decimals, so a derived ounce
  figure can be correct in its fifth decimal.
- The cert-company input is 12ch: `ch` is the width of `0`, grader names are
  uppercase, and `box-sizing: border-box` means the width also pays for padding
  and border. Anything tighter clips "ANACS".
- Hidden spacer inputs keep some rows the same grid shape as their neighbours.
- `notes` and `transactionNotes` sit side by side, so their captions, hints and
  sizes differ; writing to the wrong one silently overwrites the coin description.

---

## Reference data, Settings and spot prices

### Why reference lists have exactly one editor

A reference record is not a string. A denomination is owned by an issuer and
carries a country the editor's dropdown groups by; a mint mark has an id and a
description. An editor that rebuilds records from text, or that cannot ask for
those fields, creates invalid rows or re-derives ids that no longer match the
database. And a second, weaker editor for the same list is a way to enter
data the better one would have refused, or to delete an entry without the
in-use count and confirmation the better one shows. So every reference list is
edited only on the Reference Data screen, one entry at a time, through
`InventoryService`.

### Why the screen is shaped around the denomination list

Roughly a thousand denominations drive most choices: groups by issuer that
collapse; search across all issuers, because a label does not say who owns it;
the dialog opens on Categories so a quick visit does not pay for the big pane;
the pane scrolls, not the dialog. The sidebar is not a tab strip because the
type names are long, each entry carries a second line of counts, and the big
pane needs height more than width; at narrow widths it does become a strip.

### Why counts come from the server

The number in a removal prompt must be the number of coins the delete will
touch, so it comes from the same database the delete runs against
(`GET /api/reference-usage`) and is re-read after every change. Keys are
strings because a count stored under `103` and read with `'103'` would return 0
and suggest the entry is unused.

### Why the issuer list is local to the dialog

Nothing else in the app reads issuers, so the list is loaded when the dialog
opens and dropped when it closes. The other lists go through `InventoryService`
because the editor's dropdowns share them. An issuer's denomination count is
derived from the live denominations, never from a cached count.

### Why removed issuers revive rather than duplicate

`UQ_Issuers_Name` blocks a second row with the same name, and a new id would
orphan the old row's denominations. Re-adding the name revives the original
row. Coins unlinked by the removal stay unlinked, because relinking them
silently would undo a decision the user made.

### Why the online lookup is consented, proposed, and run after saving

It is a request that leaves the machine, so it needs a visible, persistent
choice. Its results are proposals because a wrong or duplicate label under one
issuer makes coin resolution ambiguous. The issuer is saved first so a failed
lookup cannot lose it, and "no results" and "unavailable" are normal outcomes
reported differently, because the user can act on "unavailable".

### Why the unlinked-denomination banner is amber

An unlinked coin is valid data, not a fault, so the banner is `role="status"`
and amber rather than error red, silent at zero, and silent until the
denomination lookup has loaded (otherwise every coin would briefly count as unlinked).

### Why spot-price edits are not saved per keystroke

`POST /api/spot-prices` inserts a history row on every call, and the price
boxes fire on every keystroke. So edits update memory and one row is written
on a deliberate action. The automatic start-up fetch reports failure quietly,
because a sticky error toast is right for a button the user pressed and wrong
for something that happens on every launch.

---

## The inventory grid and detail panels

### Photographs never travel in the coin list

`GET /api/coins` returns no image bytes because a list that inlines photos
cannot be serialised for a real collection (see [server.md](server.md)). So
`imageCount` decides whether to render an `<img>` at all, and `loading="lazy"`
keeps the cost on load to one screenful. A spec asserts the attribute is still
on the real tag, because deleting it degrades nothing visibly and everything
quietly.

### An empty grid has three meanings, not two

"No coins" and "nothing matches your filters" are the obvious two. The third
is "not fetched yet", and it is the dangerous one: during the initial load the
array really is empty, so a naive check tells a user with a full collection
they own nothing and invites them to import it again. `connected()` and
`connectionError()` make the third case expressible, and statistics and
reports hide their totals for the same reason, so they never show $0.00 for an
unloaded collection.

### Column order has one source of truth

`inventoryColumnOrder` is read by both the column picker and the store that
sorts visible columns. Re-ordering the template instead makes them disagree.
Stored column lists and sort columns are validated on load, which is what lets
the canonical order change without a migration.

### Why the row opens the panel but does not toggle it

Re-activating the open row must not close it, because keyboard users press
Enter to "go to" a row, not to dismiss it. Only the panel's Close button
closes it. Arrow keys move focus, not the selection, so browsing does not load
every coin's details.

### Why group order is stored as names

A saved order of positions breaks the moment a filter hides a group or an
import adds one. Names let a hidden group keep its place and new groups fall in
alphabetically after the placed ones. At restore time a deleted group cannot be
told from a filtered one, so unknown names are kept. Plain arrow keys are not
used on headings because the grid ignores keys pressed on buttons; Alt+Arrow is
the usual "move item" shortcut, and the live region announces the new position
because keyboard users get no visual feedback.

### Angular scopes styles to the component that declares them

A rule in `app.scss` cannot reach markup inside a child component, and a
component using shared class names must `@use` the shared partial itself.
Moving markup out of the shell is the easy way to get this wrong: the markup
keeps working and the classes match nothing. A dialog without `_modal.scss`
renders inline under the table with no backdrop.

### Photo sizes differ per screen on purpose

| screen | size | question |
| --- | --- | --- |
| near-match review rows | 88px | is this photo this coin? |
| batch-import tiles | 128px | scan a folder quickly |
| coin gallery tiles | 220px tile, 200px photo | look at one coin properly |

The `<img>` already points at the full file, so the size buys only legibility.
`object-fit` is always `contain`: coins are round, and cropping to fill a
square shaves off the rim, date and mint mark a user looks at.

### The gallery is also the uploader

It holds the only per-coin picker and drop target, so it opens for a coin with
no photos and shows an empty state. A `imagePaths.length > 0` gate would make
a coin's first photo impossible to add.

### Why the viewer prefers the original

The stored copy is downscaled to about 1600 px; the original can be many times
that. The viewer shows the original only once the backend confirms it is
readable, and otherwise the stored copy with a caption saying so. "Unknown"
existence is never shown as "missing", or the photo library would appear to
vanish every time the server restarted.

---

## Reports and statistics

### How a printed document stays in step with the screen

Three columns cannot be rendered from a `CoinRecord` alone: melt value needs
spot prices, the catalogue reference needs the Catalogs lookup, and the
denomination needs the Denominations lookup. Reports render cells through the
grid's own `formatInventoryCell`, which only works if the lookups are passed as
well. A call site that forgets one still compiles and prints a different value
("6819" instead of "Sear 6819"). So `toRows` takes the whole `ReportInput`,
and `denomination-lookup-wiring.spec.ts` asserts the lookups are present at
every call site.

### Why reports downscale photographs again

The stored copies are about 250 KB each. Embedding them for 300 coins × 2
photos is about 150 MB of HTML handed to a print renderer, which stops
responding. So reports re-encode to 480 px, load one coin at a time (a
`Promise.all` reintroduces the peak), and cap the total.

### Why print rather than generate a PDF

The browser's Save as PDF makes a real PDF with no dependency; a PDF library
would break the bundle budget. The print window is blank with inline styles so
app styles cannot leak into the printout.

### Why the statistics are hand-written SVG

The bundle is near its hard budget, and a chart library would need lazy
loading behind a spinner. More importantly, the frontend suite runs under Node
without a DOM, so the only assertion available against a library would be "we
called it". Pure geometry functions make every coordinate testable. Charts
have a fixed pixel width (no viewBox scaling) so the pointer's `offsetX` is
the SVG x coordinate; on a narrow window the dialog scrolls instead.

### Why every total carries its gaps

`inv.reduce((s, c) => s + c.currentValue, 0)` over a collection where 31 of 125
coins were never appraised produces a number that looks like the value of 125
coins. So every measure is `{ total, knownCount, unknownCount }`, and `total`
is null when nothing is known. A non-positive price is read as "not recorded",
because the columns are non-nullable and nobody keeps a coin believed worthless.
Gain is computed coin by coin, because value and cost totals are sums over
different coins.

### Picking a colour for a chart

The chart bronze `#a9742f` is brighter than the app's accent browns, which
fall below the data-viz chroma floor against white and read as grey as a large
fill. Check any new colour against the real white surface, not a generic
default. One hue is enough: the bars are magnitudes of one measure. The folded "Other"
bar takes the de-emphasis grey. There is no dark mode because the app has no
dark theme.

### Insurance-schedule semantics

The money totals and the schedule test **possession, not title**. A for-sale
coin is on the shelf and insured; an ordered coin is paid for but in the post.
A money field of zero prints blank rather than `$0.00`, because `$0.00` in a
schedule is a written claim that the coin is worthless. Fixtures that omit
`collectionStatus` read as Owned and exercise none of this.

---

## Import screens

### Why an import screen never offers to force a row in

The backend refuses a coin without a denomination. A forced row would appear in
the grid as an in-memory record with no database row, and every later edit
would fail against an id the server never issued. So the UI never offers to
create a coin the backend would refuse; a refused row is listed with what was
read, so the user can fix it at the source and re-import.

### Why the import paths share their rules

The completeness rule (`csv/import-plan.ts` and `coin-completeness.ts`), the
alloy inference (`pmFieldsToFill` / `composePmFields`) and the sold rule
(`import-sold.ts`) are single modules called from every path, because two
copies of an import rule drift and the same row then behaves differently on two
screens. Excel is not a separate importer: `services/xlsx/` converts a workbook
into the `headers` + `rows` pair the CSV path consumes. A fourth path should be
another converter to that shape.

### Why the preview and the button come from one plan

An import whose preview cannot be trusted is one somebody runs twice.
`importCsv` imports `importPlan().accepted` rather than re-mapping, so the
number on the button and the rows that land cannot disagree.

### Why the sold filter never sets a status

"Import only coins I still own" decides only whether a new record is
imported. Status belongs to the user; deriving it from sold fields would
silently move coins out of totals.

### Why the image review is three tiers, not a queue

The share holds about 2,140 files. A review that asks about every unplaced
file means hundreds of clicks whose only honest answer is "skip", before
reaching anything that matters. The split is by what question can be asked:
matched (tick boxes), near match (one yes/no per coin), not imported
(read-only report, with an opt-in "Attach anyway"). Photo sets go one step
further and ask once per coin rather than once per shot.

### Automatic and manual attachment follow different rules

Automatic matching excludes only multi-coin shots (no rescue link) and applies
the non-coin veto; counterfeits are matched normally and kept apart from
genuine coins by the authenticity veto. A manual attach is unconditional: no
file is ever off limits for a person choosing a coin for it. Exclusions belong
in the matcher, never in the coin search, or the manual side breaks silently.

### Why the progress indicator is pinned, and why the session yields

The indicator is near the top of the dialog, Save is at the bottom, and
`.modal` is the scrolling container; so the progress block is sticky and the
Save button carries its own count. Nothing paints unless the session yields to
the event loop before each slow stage. One stage, Angular building the review
screen, is not application code: do not clear `progress` in the task that
hands the rows over.

---

## Shared state, testing and fixtures

### The denomination sort table

`parseDenominationValue` matches a label exactly if it can, else by the
longest matching pattern, so short patterns never shadow long ones ("$10" is
not "$1", "25¢" is not "5¢") and the table's order cannot affect an answer.

### Why the QIF test corpus is synthetic

Real Quicken exports hold an entire financial profile, not only coins, and
cannot live in a repository. `src/app/testing/qif-corpus/` is generated by
`generate-corpus.mjs`, which reproduces the real files' collision density
(many coins share a year and denomination and differ only by grade, which is
where matcher bugs show) and derives security names through per-attribute
bijections. Do not "tidy" it to one coin per year and denomination. It also
carries synthetic copies of every section the importer ignores (tickers
starting "ZQ"), so the ignore logic stays tested. QIF fixtures must use
realistic names: a placeholder such as "Old Coin" produces no record, and a
test over it passes for the wrong reason.

### The real-filenames fixture is not the real photo share

`real-filenames.fixture.ts` is part survey, part constructed probes, so the
census in `import-tiers.spec.ts` measures a test corpus. To measure the share,
enumerate the share. Multi-coin exclusions are deliberately not in the fixture.

### Grep tests on templates must strip comments first

Several specs read a `.html` or `.ts` file and assert on its text, because
templates cannot be rendered under Node. A comment explaining a rule often
contains the rule's own text (`loading="lazy"`), so a test that reads the raw
file can be satisfied by its documentation. Every such test strips comments and
anchors on the tag.

The same constraint shapes the components: logic that needs testing lives in
pure modules taking plain data, and browser APIs sit behind a service (the
support dialog reaches the browser only through `SupportService.openIssue` /
`copyToClipboard`).
