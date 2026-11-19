# How it works

Feature-by-feature reference: what each part of the application does and the
rules it follows. Written for anyone changing this code.

For the shape of the codebase see [architecture.md](architecture.md); for the
reasoning behind the less obvious rules see [rationale.md](rationale.md); for
running and building see the [README](../README.md).

Two rules recur throughout:

- **A blank beats a wrong number.** A figure the app cannot work out is shown
  as `—`, never `0` or `$0.00`, and totals say how many coins they had to
  leave out.
- **Absent is not empty.** Data that has not loaded (photos, lookups, spot
  prices) is never treated as "none", because several writes replace whole
  sets.

---

## The inventory grid

### Columns

`inventoryColumnOrder` in `src/app/types/inventory-columns.ts` is the only
definition of column order; the column picker and the grid both follow it.

- **Order.** Year, Mint Mark and Denomination come first and read like a
  holder ("1881-S Dollar"), matching the editor's first row. Cert sits
  immediately before Grade. Status is the first column about the user's
  relationship to the coin, followed by category, country and the money
  columns. Catalogue Ref. sits next to Variety; Storage sits next to Set.
- **Off by default:** Cert, Catalogue Ref., Storage. Status is on.
- **Saved preferences.** Visible columns are stored as a set and re-sorted
  from `inventoryColumnOrder` on load, and merged with `defaultVisibleColumns`,
  so a reordered or newly-default column reaches existing users without a
  migration.
- **`source`** (quicken / csv / manual / import) is not a grid column. It is
  stored, filterable and exported to CSV, and withheld from the insurance report.
- **Labels.** "Storage" rather than "Location" (which reads as country of
  origin); "Catalogue Ref." rather than "Cat." (which reads as Category). Both
  weight columns are grams, with the unit in the header.

### Cells

- Unknown values show `—`. Status never does: no status means Owned.
- Melt value is `—` when unknown, never `$0.00`; its tooltip says whether spot
  prices are missing or the coin has no PM weight.
- Weights show 3 decimals in the grid (the editor keeps 5).
- Cert shows "PCGS #12345678", or just the company when there is no number.
- Catalogue Ref. shows "Sear 6819", the number alone when the catalogue is
  unknown, or the catalogue alone when no number is entered.
- Cells that need lookups receive them as extra arguments to
  `formatInventoryCell`: spot prices (melt), catalogues, denominations.
- **Grade badges.** Leading qualifiers (Choice, Gem, Select, Near, About…) are
  stripped and the leading letter run is matched whole, so VF never matches F.
  PF/SP gold, MS green, AU teal, XF/VF blue, F/VG tan, G and AG/FR/PO brown;
  grey only for "no grade recorded". Colours are in `styles/_controls.scss`.
- The CAC green bean (`public/CACGreenBean-trimmed.png`) shows in the grid and
  as a toggle in the editor. CAC is a sticker applied to a PCGS/NGC slab; it is
  separate from the grading company and from CAC's own grading service, CACG.

### Search, filters and status

- **Search** covers coin type, displayed and recorded denomination, country,
  grade, cert company and number, variety, mint mark, notes, set, storage
  location and the catalogue reference as displayed ("Sear 6819"). Optional
  fields use `?? ''` so "undefined" never enters the haystack.
- **Status filter**: one tick box per status, all ticked by default, with
  All/None. Nothing ticked shows no coins, and the filter bar says so. Options
  come from `collectionStatusOptions`, so the filter, editor and grid agree.
- **Advanced filters**: grade prefix, value range, source, country, coin set.
- Every filter is a signal wrapped by `remembered()`, which saves on every
  write. `StorageService` is optional; without it nothing persists and nothing breaks.

### Restoring saved state

The shell restores sort, filters, grouping and columns during start-up.
Defaults show first and are replaced when IndexedDB answers, so the grid never
waits on storage. Each stored field is validated on its own and anything invalid
(a removed column, a status that no longer exists) falls back to its default.
A restored advanced filter forces the advanced panel open. Writes are
fire-and-forget and suppressed while restoring.

### Grouping

- **Group by** offers every text column, visible or not. Numeric columns
  (prices, weights) are excluded; `GROUPING_COLUMN_KINDS` must have an entry for
  every column, so the build fails if a new column has no kind.
- Each group has a heading button with its coin count and held value
  (`sumCurrentValue`, held coins only). Counts and totals follow the current filters.
- Group keys are the formatted cell text, so headings match the column.
- Coins with no value go in **"(No <Column>)"**, muted and always last; it
  cannot be dragged, dropped on, or stored in an order.
- Groups sort alphabetically; rows inside keep the chosen sort. When the sort
  column is the grouping column, the sort direction reorders the groups.
- Choosing a grouping collapses every group. Expansion is stored as a default
  plus exceptions.
- **Custom order.** Drag a heading (native HTML5 drag and drop, no
  `@angular/cdk`) or press Alt+Up / Alt+Down on it. Orders are saved per
  column as lists of heading names: a group hidden by a filter keeps its place,
  never-placed groups go after placed ones alphabetically, and moves are
  computed against the saved order merged with the visible headings. "Reset
  order" appears only when the current column has a custom order. A polite live
  region announces "X moved to position 3 of 12".
- Grouping column, expansion and per-column orders are one blob under
  `StorageKeys.GridGrouping`; anything invalid on restore means no grouping.
- The template is one `@for` over `gridRows()`, mixing heading and coin rows,
  so coin-row markup exists once.

### Keyboard

Rules live in `features/inventory/grid-keyboard.ts` (pure).

- The row is the control: click or Enter/Space opens the Details panel. It is
  not a toggle.
- Roving tabindex: exactly one row has `tabindex="0"` (last focused row if
  still present, else the selected coin, else the first row), so Tab enters and
  leaves the grid in one press.
- Arrow Up/Down move focus only, stop at the ends, and follow
  `renderedInventory()`, so collapsed groups are skipped. Headings are reached
  with Tab; Enter/Space toggles them.
- Keys pressed in a control (checkbox, Images button, inputs, links) are
  ignored, so Space still ticks the checkbox.
- `focusin` is used because `focus` does not bubble from the row's checkbox.
  Rows are found by `data-coin-row` / `data-group-heading` attributes.

### Thumbnails

- `GET /api/coins` carries no image data, only `imageCount`; coins without
  photos make no request.
- Each thumbnail is its own `GET /api/coins/:id/thumbnail` (the photo at
  SortOrder 0), `loading="lazy"`, cacheable with an ETag. The URL carries a
  revision that changes when a save with images is acknowledged.
- Unsaved drafts show "Unsaved" rather than "No photo".
- The Images button is never disabled: the gallery is where a coin's first
  photo is attached.

### Empty grid and not-ready states

`collection-zero-state.ts` chooses between "Loading your collection…", a
pointer to the error banner after a failed load, "No coins yet" (only once the
list has arrived and is empty) and "your filters hid them".
`InventoryService.connected()` is set when the coin fetch returns. Statistics
and Reports use `collectionNotReadyNotice()` to hide totals until coins load.

### Drafts (Add Coin)

A new coin is a local draft until it satisfies the 2-of-3 rule (see
[Completeness](#the-2-of-3-completeness-rule)); then it saves itself. The row
shows an "Unsaved" chip and a calm "needs …" line (`draft-row-status.ts`,
`role="status"`); red appears only after the server refuses a save. Drafts are
not persisted.

### Multi-select and bulk edit

Tick boxes with shift-click ranges are separate from the single selected coin.
The header checkbox and shift ranges act on visible rows only. The bottom bar
bulk-updates a field or deletes the ticked coins.

---

## The coin editor

### Saving model

- No Save button. Each control is one-way bound (`[ngModel]` +
  `(ngModelChange)`) and writes through `InventoryService.updateCoin()`, which
  debounces (1 s) and sends one PUT carrying only the dirty fields.
- Every write carries one field. Multi-field changes (denomination id + label,
  autofill results) are separate single-field updates, so untouched fields are
  never overwritten.
- `CoinChangeTracker` diffs against what the server last confirmed, not the
  optimistic screen copy, so a failed save can be retried by typing again.
- `updateSelectedCoin` is the single funnel: it upper-cases the certification
  company and keeps at most 5 characters, and strips the `__OTHER__` sentinel
  from denomination and mint mark.

### Number boxes (`appNumericField`)

While the input has focus, nothing writes to `element.value`, so the caret
stays where the user put it; the value is normalised on blur. The directive
does not use `ngModel` and emits on `input`, never on blur (a blur emit would
write a field the user never touched). Its effect reads every input signal
before the focus guard so it keeps tracking `value`.

| Field | Decimals | Prefix | Thousands separators |
| --- | --- | --- | --- |
| Weight (g) | 5 | — | no |
| PM Weight (g) | 5 | — | no |
| PM % | 2 | — | no |
| Purchase Price (Cost) | 2 | `$` | yes |
| Current Value | 2 | `$` | yes |

Parsing delegates to `parseNumericCell` (`services/csv/numeric-cell.ts`), so
the editor and the CSV import read `$1,250`, `26.73 g` and `1/10` the same way.
Units are discarded, not converted: `0.7734 ozt` typed into Weight (g) records
0.7734 grams. An emptied box does not snap back to `0` while editing; it is
stored as 0 because the columns are NOT NULL.

### "Other" (custom value) on Denomination and Mint mark

- Both selects end with an "Other…" option. Whether the free-text box is open
  is its own signal (`CustomOptionMode`), never inferred from the field value;
  otherwise typing would close the box, a saved custom value would not reopen
  it, and the sentinel could be saved.
- Custom mode is derived once per coin (guarded by coin id), and only after the
  lookups have loaded.
- In custom mode the select shows "Other" while the field holds the user's text.
- Mint mark's option reads "Other…" because a real mint mark is labelled "Other".

### Denomination picker

About 1,160 denominations under 61 issuers.

- A search box (local, never saved) filters a grouped `<select>`. Groups are
  issuers derived from `Denominations.Country` (ISO code or issuer name) via
  `services/denominations/denomination-index.ts`.
- The coin's country only **orders** the list (its issuer first); it never
  filters, so a coin with the wrong country can still reach the right row.
- The list is never empty: an unknown country or a search with no matches
  falls back to everything and says so.
- The coin's current denomination always appears exactly once (in an "On this
  coin" group if needed), because a `<select>` whose value matches no option
  renders blank and reads as "cleared".
- Option values are ids, not labels ("Crown" exists for several issuers).
  Picking writes both the id and the label text.
- `denominationPickerBase` (country resolution, alias folding) is memoised;
  the per-keystroke filter is a cheap substring match, capped at 200 rendered
  options while a query is typed.

**What a coin resolves to.** A coin with an id sits on that row. A coin with
text but no id (normal after imports) is resolved for display with the shared
resolver; "Other" opens only when the text names no single denomination.
Nothing is saved until the user picks. Picking "Other" clears the id and keeps
the text as the record of what the source said.

**Spellings.** `denominationKey` folds symbols (¢ → c, ½ → half, £ → gbp), case
and whitespace, then applies an alias table, so "Half Dollar", "trime" and "5s"
compare with canonical labels like `50¢`, `3CS`, `5/- (Crown)`. Ambiguous
spellings are deliberately not aliased: penny, bare eagle, trade dollar,
nickel / half dime vs 5¢, bare "3 cent".

**Country link.** `Denominations.Country` stores codes (`US`, `GB`);
`Coins.Country` stores names. Every comparison goes through
`resolveCountryName` / `isSameCountry` (`services/coin-countries.ts`), which also
understand `uk`, `British` and so on; an unrecognised country resolves to `''`
("no opinion"). Picking a denomination fills Country only when Country is
blank, only with the canonical full name, and only when the label maps to
exactly one country. Country stays a free-text input with a datalist.

### Metal and weight autofill

Rules live in `services/pm-autofill.ts`. Text key fields trigger on `change`
(blur or Enter), never per keystroke; select changes (denomination, metal)
trigger immediately with the new values passed in. Blanks are filled silently.
When values would be overwritten the user is asked once; declining writes
nothing, and the field just edited is never overwritten. Metal can settle an
otherwise ambiguous coin (an 1855 "$1" is a silver or a gold dollar).

### Other fields

- **Status** has no "(none)" option; a missing status displays as Owned
  (never written back).
- **Weight** is gross weight; **PM Weight** is the pure metal. Both grams, 5
  decimals. **Melt** is read-only.
- **Catalogue reference**: a catalogue select (numeric id) plus a number
  (max 50 characters, stored as typed, outer whitespace trimmed; catalogue
  names max 60). Inactive catalogues are not offered but coins keep them and
  still show the name. Nothing is looked up. Lookups compare `catalogId`
  loosely, because CSV import can deliver it as a string. The seeded list is
  the image matcher's catalogue prefixes (`filename-vocabulary.ts`) in the same
  order with Krause last; it is kept in `types/catalog-reference.ts` and
  `server/db/seed.ts`, and a parity spec checks them.
- **Transactions** (optional, Settings toggle): Cost, purchase date and
  Purchased from; Sold for, sold date and Sold to; and deal notes. It sits
  above the coin's Notes, and the two notes boxes differ in caption, hint and
  size. A coin has one purchase and at most one sale; there is no transaction history.
- Every field has a real caption; the form has no placeholder-as-label.

### Layout

Row 1 is identity: Year (64px), Coin Type (flexible), Denomination (132px),
Mint mark (68px), in fixed grid tracks for the 420px sidebar, proportional
below 900px. Certification company sits in front of the grade ("PCGS MS64");
the cert number sits lower with the other reference data. The cert-company
input is 12ch wide so "ANACS" is not clipped. Some rows contain hidden spacer
inputs to keep the grid shape. The detail panel header is just the action buttons.

---

## The coin record

Defined in `src/app/types/coin.model.ts`. Notable fields:

| Field | Notes |
| --- | --- |
| `denomination`, `denominationId` | Source text (never rewritten) and canonical link (often null). See below |
| `weight`, `pmWeightGrams`, `pmPercent` | Gross grams, pure-metal grams, fineness. Melt uses `pmWeightGrams` only |
| `collectionStatus` | `owned`, `wanted`, `ordered`, `for-sale`, `sold`. NOT NULL DEFAULT `owned` in the database |
| `notes`, `transactionNotes` | Coin description vs deal note; named so a search for one never finds the other |
| `purchaseDate/Price`, `purchasedFrom`, `soldDate/Price`, `soldTo` | The one purchase and the one sale |
| `storageLocation` | Free text; a coin can be in a set and in a physical place |
| `catalogId`, `catalogNumber` | One catalogue reference per coin |
| `certCompany`, `certNumber`, `hasCacSticker` | `hasCacSticker` is always a boolean (BIT NOT NULL) |
| `imagePaths`, `imageCount` | See [Photos](#photos-in-the-app) |
| `source` | manual / quicken / csv / import |

The import normaliser (`services/inventory/coin-factory.ts`) drops unknown keys,
so old JSON or CSV files carrying `dealer` or `tags` still load.

### Collection status

- One status field rather than a separate want list; a want-list entry is a
  full coin description.
- **Held in collection** (`isHeldInCollection`, defined once) = owned and
  for-sale. Wanted, ordered and sold coins are excluded from money totals,
  melt totals and the insurance schedule. Per-coin melt value still shows for any status.
- Missing, empty, unknown or misspelled status reads as Owned everywhere.
- Status is never derived from sold fields on existing records.
- Stored as lowercase tokens; imports accept "For Sale" as well as `for-sale`.
- There is no "Duplicate" status: a duplicate is owned, and may be for sale.

### Denomination: two fields and one display rule

- `denomination` is what the source or user said and is never rewritten
  except with a label the user picks. `denominationId` links to the
  Denominations table; NULL is normal (unresolved import, deleted
  denomination). Deleting a denomination nulls the id and keeps the text.
- **Display** is built only by `denominationDisplay()` /
  `coinDenominationDisplay()` (`services/denominations/denomination-display.ts`);
  a spec fails if any other file builds it. It shows the linked label, or
  `Other (<text>)` when unlinked, or `—` when nothing is recorded.
- With a null id, the text is resolved with the editor's own resolver, so a
  coin reads the same before and after ids are backfilled. Display never writes.
- Every display site must pass the Denominations lookup: the grid
  (`formatInventoryCell`), statistics breakdown, both printed reports, the
  Reports summary and the search haystack. Without it the call still compiles
  and shows the raw text.
- Resolution rules (`denomination-resolution.ts`): spellings fold through the
  alias table; the coin's country is a preference and the search widens to all
  issuers when it matches nothing; ambiguity gives null; "nothing recorded" and
  "no row names it" are separate outcomes. Example: "8 Reales" filed under
  United States resolves to Mexico by widening; a bare "Crown" resolves to nothing.
- The client has no Issuers table: each `Denominations.Country` holds the
  issuer's ISO code or name. The server also sends inactive rows; every
  consumer filters them. Importers cache their index per lookup array, so
  reuse the same array instance.

### Melt value

```
melt = (pmWeightGrams / 31.1035) × spot price per troy ounce
```

`pmWeightGrams` is already pure metal: a $20 Saint-Gaudens weighs 33.44 g at
90%, so `pmWeightGrams` is 30.09 g (0.9675 oz). Purity and gross weight do not
appear. The formula exists only in `computeMeltValue()`
(`services/inventory/inventory-metrics.ts`), which returns null (shown `—`) when
the weight, the metal or that metal's price is missing or zero.

---

## Spot prices

- Gold, silver, platinum and copper. Fetched through the backend from Yahoo
  Finance futures quotes (no key; undocumented, so best-effort; override with
  `SPOT_PRICE_BASE_URL`):

  | Symbol | Metal | Exchange |
  | --- | --- | --- |
  | `GC=F` | Gold | COMEX |
  | `SI=F` | Silver | COMEX |
  | `PL=F` | Platinum | NYMEX |
  | `HG=F` | Copper | COMEX |

- Copper is quoted per pound and converted to per troy ounce in
  `spot-price-source.ts`, rounded to 4 decimals.
- Each symbol is fetched independently with a 10 s timeout. The fetch always
  answers 200; a missing or non-positive price is listed in `failed` with an
  `error` message, never returned as a real zero.
- `GET /api/spot-prices/fetch` never touches the database.
  `GET /api/spot-prices/latest` reads the last saved row (200 with zeros and a
  null `fetchedAt` on an empty table, which tells the client to keep its defaults).
- `POST /api/spot-prices` inserts a history row on every call. So the price
  boxes update memory only (`updateSpotPrices`), and one row is written
  (`commitSpotPrices`) after a successful fetch or when the dialog closes after
  hand edits. Duplicate and all-zero sets are skipped; partial sets are fine.
- Zero, empty or NaN all mean "no price".

---

## Reference Data screen (`category-modal`)

A sidebar of reference types with one pane each, defined as data in
`REFERENCE_SECTIONS`: adding a type is one entry plus one `@case`. List panes
sort A–Z by title, then diagnostic panes (Unlinked Coins). Section ids are
kebab-case DOM ids; an unknown id falls back to Categories. At narrow widths the
sidebar becomes a strip above the pane. It is opened by the filter bar's
"Reference Data" button and by the unlinked-denomination banner, and it is the
only editor for reference lists.

### Counts and removal

- In-use counts come from `GET /api/reference-usage`, the same place the
  removal runs, and are re-read after every change. Usage keys are strings, so
  `103` and `'103'` find the same count.
- **Categories, sets, mint marks, metal content** are text on the coin:
  removing one only removes it from the dropdown. Adding or removing a category
  or set updates the list immediately and persists in the background; a failure
  is reported.
- **Denominations**: soft delete (IsActive = 0) and the linked coins'
  `DenominationId` set to NULL, in one transaction. Coins keep their text and
  show `Other (…)` until re-linked.
- **Issuers**: removal cascades to the issuer's denominations (coins unlinked
  first, then denominations and issuer deactivated, in one transaction). The
  confirmation is routine with no coins affected and serious when it quotes a
  coin count; afterwards the screen reports what the server says it did.
- **Catalogues**: soft delete; coins keep their attribution. Catalogues have
  Rename (in place, id kept); the text-keyed lists do not need it.
- Removals use `confirmAction` (see [Confirmation prompts](#confirmation-prompts)).

### Issuers

- Name unique, max 100 characters. ISO code exactly two letters or blank.
  Years are integers and may be negative (BC). Validation reports the first
  error in field order.
- **Kind** is derived, never entered: ancient if valid-from < 500 (checked
  first, so the Byzantine Empire is ancient), historical if valid-to is set,
  else modern. With no years a new issuer is modern and an edited one keeps its
  stored kind. The rule is duplicated in `server/routes/lookups/issuer-kind.ts`;
  `issuer-kind.spec.ts` checks they match. The client never sends `kind`.
- Editing is in place (denominations reference issuers by id); the issuer's own
  name is excluded from the duplicate check, so a capitalisation fix is allowed.
- **Revival.** Re-adding a removed issuer's name revives the original row (same
  id, `revived: true`) and its denominations; the user is told "Restored".
  Coins unlinked by the removal stay unlinked. An active duplicate is 409.
- The issuer list is local to the dialog, loaded on open. If it fails, every
  denomination appears under "No issuer yet" with a retry banner.

### Online denomination lookup (Wikidata)

After an issuer is created (saved first, so a failed lookup cannot lose it),
the app can ask Wikidata for its denominations.

- Controlled by a consent checkbox, on by default, saved immediately
  (`StorageKeys.IssuerLookupOnline`); unticked means no request at all. The
  label says the request leaves the machine.
- Only the issuer name is sent, with a generic User-Agent and an 8 s timeout.
  The server always answers 200 with `outcome`: `results`, `none` or
  `unavailable`, reported differently because the user can act on "unavailable".
- Results are proposals: ticked by default, labels the issuer already has are
  filtered out, and only the chosen labels are written. Expect thin results for ancients.
- The lookup runs for a revived issuer only if it came back with no
  denominations (duplicate labels under one issuer would make resolution ambiguous).
- Afterwards the Denominations pane opens with only the new issuer's group
  expanded and the issuer preselected in the add form.

### Denominations pane

- Grouped by issuer, groups A–Z (case-insensitive, accent-sensitive, `en`
  locale, id tiebreak); rows by SortOrder then label (FaceValue is not
  comparable across currencies). Null issuer → "No issuer yet".
- Search: labels match as substrings across all issuers; an issuer-name match
  brings its whole group; ISO codes match exactly; text is normalised (accents
  stripped, lower-cased, whitespace collapsed).
- Expansion is a default plus exceptions; one collapse/expand-all control;
  nothing collapses during a search; adding a row opens its group.
- Adding requires an issuer; rows get a SortOrder gap of 10; Country is kept in
  step with the issuer.

### Unlinked Coins pane

Lists coins whose denomination text never resolved or whose row was deleted,
grouped by alias key plus resolved id (`unlinked-denominations.ts`), with
reasons resolvable, ambiguous, unknown or nothing-recorded. One group is open
at a time; only a resolvable group with one answer is preselected. "Set
Country" is opt-in. Updates run one coin at a time through `updateCoinNow`, and
failures are listed. "Add to list" prefills the label for unknown groups.

---

## Settings

Settings holds app-level settings only: the Transactions display toggle,
photograph storage, the precious-metal backfill, and backup/restore.
Reference lists are edited only on the Reference Data screen. Save
persists the toggle and the two photo settings; everything else acts when its
button is pressed. `StorageKeys.AppSettings` is one object shared with the image
import, so every writer does read-modify-write. If the user touches a photo
control before the saved values arrive, the late values are dropped.

### Photograph storage

| Mode | Stored | Notes |
| --- | --- | --- |
| `stored` (default) | Downscaled copy in the database plus the original path | The copy survives if the original is moved or deleted |
| `referenced` | Only the path | The user's file is the only copy |

Changing mode affects future imports only. The size limit (MB on screen, bytes
in storage) applies to the stored copy: default 1 MB, floor 64 KB, cap 10 MB.
Originals are never resized or refused. Unrecognised values read as the
default.

### Precious-metal backfill

A one-off job over the whole collection: preview (writes nothing) → confirm
(writes exactly the previewed plan) → report (including failures). It fills
only blank PM fields, sends only those fields, and writes one coin at a time
with `updateCoinNow()`. Coins whose alloy cannot be told from date and
denomination (1942 nickel, 1982 cent, 1971–78 Eisenhower dollar) are skipped.

### Backup and restore

**Getting a path.** The server reads and writes the files, so it needs a real
host path, which a browser cannot supply. A directory pick yields only the
folder name; `picked-folder.ts` assumes it sits inside the path already in the
box (which starts as the Desktop) and says that is a guess. Typed or pasted
paths, including UNC paths, always work. `GET /api/backup/files` lists the
`*.db` files in a folder, so a wrong guess shows before anything is replaced.
The server prefills the backup folder, file name and database size; prefill
never overwrites a box the user has typed in, and the restore path is never prefilled.

**Backup.** `POST /api/backup/jobs` starts a server-side job (202) and returns
an id; `BackupRunner` polls every 400 ms, tolerates 4 failed polls before
reporting "lost contact", and reports success only when the server says done.
Cancel is a separate call. One backup at a time. Closing the dialog stops
polling but not the backup. Destination problems are refused as 400s with a
sentence the panel shows as-is. Existing files are never overwritten (` (2)` is
appended). Names: `coin-inventory-backup-YYYY-MM-DD-HHMM.db`, local time.

**Restore** is two steps. **Check** (`POST /api/restore/inspect`) shows the
coin count, date taken and a photo warning, and changes nothing; the Restore
button appears only when the check accepts the file. Editing the path clears
the result; picking from the list only fills the box. The server re-validates
on restore.

| Verdict | Meaning |
| --- | --- |
| ok | Accepted |
| unversioned | Schema version 0; accepted if the tables are right |
| missing, not-sqlite, unreadable | Refused |
| not-this-app | A required table is missing; refused |
| newer-schema | Made by a newer build; refused (no downgrade path) |

The current database is renamed aside in the same folder
(`coin-inventory.replaced-YYYY-MM-DD-HHMMSS.db`, with its `-wal`/`-shm`), not
deleted, and the outcome shows that path as the user's undo. No server restart
is needed; the Reload button refreshes the page's data. Photos stored as
references do not travel with the file; the warning is shown before and after.
All wording is in `services/backup/backup-messages.ts`, and every disabled
button explains why.

---

## Reports

`buildInsuranceReport` / `buildInventoryReport` (pure) → `ReportDocument`
(pre-formatted strings) → `renderReportHtml` (pure) → `openPrintWindow`.

- Printed through the browser (Save as PDF) in a separate blank window with
  inline styles; no PDF library. `thead` repeats, rows avoid breaks, `@page`
  margins are fixed. A blocked pop-up shows a warning. All data is escaped.
- **Insurance schedule**: the whole collection narrowed to held coins, with
  excluded coins counted by status. Fixed columns; melt only when spot prices
  are loaded; notes, source, sold price and sold date are withheld.
- **Inventory listing**: `filteredInventory()` in grid order with the visible
  columns, plus a scope line (active filters, "Showing N of M coins", sort).
- A price or value of 0 means "not recorded": totals print the count used and
  a caveat, and an all-unknown total prints `—`.
- Cells use `formatInventoryCell`, so a printout matches the grid.
- **Photographs** (optional, on by default): up to 2 per coin, 480 px JPEG
  q0.72, loaded one coin at a time, capped at 24 MB per report; failures are
  counted by reason.
- Content is hidden until the collection has loaded.

## Statistics

All figures come from pure modules in `services/statistics/`; charts are
hand-written SVG from `chart-geometry.ts`. Statistics always cover the whole
collection, not the filtered grid.

- Every total is `{ total, knownCount, unknownCount }`; unknown shows `—` with
  "Not recorded for N of M coins". A non-positive price or value is "not recorded".
- Gain/loss is per coin, over coins with both cost and value.
- Breakdowns never draw a bar for blank values (they are counted below the
  chart); categories past the 10th fold into "Other", drawn last.
- PM holdings use `pmWeightGrams` and the same metal matching as `computeMeltValue`.
- Spend over time is cumulative purchase spend. Purchase dates are free text;
  only `YYYY-MM-DD` and `M/D/YYYY` real dates are read, and undated coins are reported.
- There is no value-over-time chart: Current Value has no history.
- Chart SVGs have a fixed pixel width so `offsetX` equals SVG x for the crosshair.

## Exports

| Export | Contains |
| --- | --- |
| JSON | Coin records only, no photos |
| CSV | Every coin regardless of status, with a Status column; round-trips through CSV import |
| Insurance CSV | Held coins only (`isHeldInCollection`) |

A photo backup is a database backup (Settings) or a copy of the original files.

---

## Excel and CSV import

Both Import menu entries open `CsvImportModal`; `mode` changes only wording and
suggested extensions, and the file extension picks the reader. A workbook is
converted to the same `headers` + `rows` arrays as a CSV, so everything from
the mapping grid down is shared. User guide: [csv-import-guide.md](csv-import-guide.md).

### Reading files

- **CSV**: header row first, comma-delimited, `\n` or `\r\n`, standard quoting.
  A leading UTF-8 BOM is stripped. Exports start with a BOM so Excel shows `¢` and `½`.
- **Excel**: `read-excel-file`, loaded as a lazy chunk; parsing is in the
  browser, so there is no upload route. The header row is the first row with at
  least two filled cells (skipping title banners); blank headings from merged
  cells are named by column letter; blank rows and empty trailing columns are
  dropped. Dates are read with UTC getters (the parser returns UTC midnight).
  Numbers are written unformatted so `numeric-cell.ts` is the one money/weight parser.
- **Sheets**: shown only for workbooks with more than one importable sheet.
  Every sheet is listed (unusable ones with a reason); sheets with recognised
  columns are pre-ticked. Header differences between ticked sheets are reported
  by name, ignoring case, punctuation and order.

### Mapping

`CSV_MAPPABLE_FIELDS` (`csv/mappable-fields.ts`) drives the dropdowns, the
auto-mapping, the export header row and the blank template, so an export
re-imports with every column mapped.

Header matching (`csv/header-synonyms.ts`) follows one rule: a wrong guess is
worse than a blank dropdown.

- Exact key or label beats a synonym; a tie leaves both blank.
- `Price`, `Amount`, `Total` have no synonym.
- `Weight (oz)` never maps; the weight column is grams.
- A heading of just `Date` is decided by its values (`csv/date-column-shape.ts`):
  coin years map to Year; calendar dates are left unmapped.
- `catalogId` maps only by exact label; catalogue spellings go to `catalogNumber`.
- One mapping is keyed by header text and applied to each ticked sheet's own
  headers; re-mapping after ticking sheets keeps manual choices.

### Values

- Empty cells leave the field at its default.
- Numeric cells tolerate currency symbols, thousands commas, units, simple
  fractions and accounting negatives (`(1,250.00)`). Units are ignored, not
  converted. A cell with no number becomes 0 (not yet reported to the user).
- Status outside the closed set imports as `owned`; Source outside its set becomes `csv`.
- Country defaults to United States when blank.
- `denomination` text is copied unchanged; `denominationId` is resolved,
  scoped by the row's own country. Unresolved rows still import; the preview
  shows a "linked" count as a mapping check.

### Plan, completeness, sold, enrichment

- `planImport` (`csv/import-plan.ts`) runs on every change; the preview, the
  button count and the import all use the same plan.
- Rows failing the 2-of-3 rule are listed (sheet, row number, what was read,
  what was missing) and never sent. Row numbers restart per sheet. The dialog
  stays open when rows were refused.
- "Import only coins I still own" (off by default, shared with QIF): a row is
  sold if it has a sold date, a sold price (0 counts) or a buyer (spaces do not
  count). If none of those columns is mapped, the dialog says the option has no
  effect. The rule only decides whether a row is imported, never a coin's status.
- After acceptance, `pmFieldsToFill` fills only blank Metal, Composition, PM %,
  PM weight and Weight, using any Metal value in the file as a hint. Ambiguous
  coins stay blank.

## The 2-of-3 completeness rule

A record is a coin only if at least two of Year, Coin Type and Denomination
are really filled in (`services/coin-completeness.ts`). Blank strings,
whitespace and placeholders (`-`, `0`, `n/a`, `none`, `unknown`, `other`…) do
not count. It is used by the QIF import, the CSV/Excel import and the Add Coin
draft. The backend separately requires a denomination (400 otherwise), so no
import screen offers to force a row in.

## Quicken (QIF) import

- **Reading the file.** QIF exports are windows-1252; the modal decodes with
  `TextDecoder('windows-1252')` (as UTF-8, `¢` and `½` are lost). The importer
  reads `!Account` blocks (which fill the account picker) and `!Type:Invst`
  transactions with a `Y` (security name) line. `!Type:Prices` is skipped by
  name; Security, Cat, Tag and Bank blocks are dropped for having no `Y` line;
  `NXIn`/`NXOut` cash transfers are skipped; `!Option:` and
  `!Clear:AutoSwitch` are ignored. Non-coin investment accounts are kept out
  only by the account filter.
- Field codes: D date, N action, Y security name, I price, Q quantity, T/U
  amount, M memo, L category, O commission, C cleared.
- **Pure parser.** `QuickenImportService.parse` is text in, records out. Preview,
  file load and Import go through `refreshPreview`, and Import re-parses, so
  nothing reaches the inventory without the parser's rules. One record per
  security name.
- **Filters**: date range, minimum price, denomination; category defaults to
  the account name.

### What is read from the security name

E.g. "1875S 20c-XF", "1921 Morgan Dollar MS63":

- year (including overdates) and mint mark;
- **grade** with designations (`PF65RB`, `PF64Cameo`, `MS64DMPL`, `MS70-FS`,
  `MS64+`), read from the raw string so `+` and `/` survive;
- **grading company** as a whole token: CACG, PCGS, NGC, ANACS, ICG, SEGS, NNC.
  CACG (CAC's grading service) does not set the CAC sticker;
- **CAC sticker** (`PCGS/CAC`, `CAC'd`, `w/CAC`, `(CAC)`, …);
- **denomination**, normalised to symbols;
- variety keywords; counterfeit wording ("FAKE", "Counterfeit", "Replica",
  "not genuine") is kept in Variety and the coin imports normally;
- **country and foreign denomination** (`coin-countries.ts`, consulted first
  for non-US coins): "1969 Peru 100 Soles" → Peru, "100 Soles". A unit only one
  country issued (Soles, Pond, Forint…) implies the country; shared units
  (Pesos, Francs) give the denomination only. Country words that occur in US
  coin names are guarded (Panama-Pacific, Old Spanish Trail, Indian Head,
  Columbian); Guinea is omitted (it is an English coin). Canonical spellings
  must match `pm-reference.ts`;
- a **metal hint** ("Gold", "G$1"; "CAC Gold" is a sticker tier and is removed first).

### Denomination ladder

The denomination reader is a substring ladder: **longest spelling first**
("25¢" contains "5¢", "½10¢" contains "10¢"). Special cases:

| Name says | Reads as |
| --- | --- |
| `Silver Eagle`, `ASE` | `$1` (asked before any gold eagle) |
| `Gold Eagle`, 1986 or later | `$50` |
| `… Eagle … Set` (multi-coin) | no denomination (its own branch) |
| classic `Eagle` | `$10`; Quarter/Half/Double Eagle as named |
| `$50`, `$25` | as written (modern bullion) |
| `SBA` | `$1` |
| `ATB` | `25¢` (including 5 oz pieces) |
| `Israel … 5S` | `5 Sheqalim` |

`ASE`, `ATB`, `SBA` match case-sensitively.

**Bare "3¢"**: 1864 or earlier is 3CS, 1874 or later is 3CN; for 1865–1873 the
parser guesses (proof means silver) and records an `AmbiguousReading`. The row
imports by default; the user can switch to the other candidate or drop the row
(reversibly). Corrections go back through the parser, because coin type,
composition and weight derive from the denomination. Choices are keyed on the
security name.

### Fields, sold coins, exceptions

- Composition, metal, PM % and PM weight come from `pm-fill.ts`: the reference
  table (country + denomination + year) first, metal inference as fallback.
  Weight is left undefined, never 0, when unknown. Where one date had two
  alloys the table has no row (1942 nickel, 1982 cent, 1971–78 Eisenhower
  dollar); an ambiguous `$1` (1849–1889) needs a metal hint; 1992-and-later
  silver proof dimes and quarters match only with a "silver" hint.
- Notes come only from the memo (`M`); Quicken's generated `Xfr From:` /
  `Xfr To:` memo is dropped. The payee (`P`) is never read, so Purchased From,
  Sold To and Transaction Notes stay blank.
- **Sold coins.** Net quantity is tracked per security (buys minus Sell / SellX
  / ShrsOut); a net of zero means not owned. The latest disposal's date and
  proceeds become Sold Date and Sold Price (a transfer has no price). By default
  sold coins still import, with status Sold; "Import only coins I still own"
  holds them back and lists them.
- **Denomination link.** `resolveDenominationId` is called with the record's
  own parsed country; the lookup list is read once per batch. A null link is
  normal (8 Reales has six issuers).
- Records failing the 2-of-3 rule appear under "Exceptions — not imported" with
  the raw security name and what was read. Ancients (no year, denomination or
  grade) land there; see [ancients-matching-plan.md](ancients-matching-plan.md).

---

## Batch image import

**Import ▾ → Images from folder.** It reads a folder of photographs and matches
them to existing coins by filename. All state lives in `BatchImportSession`
(`services/image-import/batch-import-session.ts`); the component owns one
session per modal instance, so reopening starts clean.

### Flow

1. **Filter** (`image-file-filter.ts`). Keeps `jpg`, `jpeg`, `png`, `webp`,
   `gif`, `bmp` by extension (Windows `File.type` is unreliable); drops RAW,
   PSD, TIFF, HEIC, `Thumbs.db` and the like with a tallied reason. Never opens a file.
2. **Match** on filenames only, in chunks of 200 with a yield between chunks.
   No bytes are read and no thumbnails are made. The denominations lookup is
   snapshotted once per run. Existing source paths are fetched for the skip
   check (`POST /api/coins/image-source-paths`, chunks of 500 coin ids, fails open).
3. **Review** in three tiers (below).
4. **Attach**: read, downscale and save only the ticked photos. Originals are
   never modified. Nothing is written before this step.

The summary line ("N need attention, N will attach, N skipped") gives the size
of the job; rescued photos count as "will attach", and ticked photos held back
by "Leave them alone" are called out. The summary, the Save count and the
held-back count all come from one `readyToAttach` set.

### The three tiers

Tier rules live in `image-matching/near-match.ts`, which runs after the
auto-assign decision and writes only `tier`, `nearMatch` and `skipReason`.
Tiers change how the user is asked, not what is auto-attached.

| Tier | Rule | What the user does |
| --- | --- | --- |
| **1. Matched** | The auto-assign gates passed (or sibling inference attached it) | Grouped by coin (`CoinImageGroup`): ticked by default, bulk rules, Skip this coin |
| **2. Near match** | Year, coin type, denomination and grade are present on both sides and agree, but something else is off (mint mark, cert number or company, wording, or several coins fit) | One yes/no per coin (`NearMatchReview`): Attach, a dropdown of other coins that also passed the test, or Skip; "Attach all" settles the coin |
| **3. Not imported** | Everything else, with a reason | Read-only list; optional "Attach anyway" |

- Tier 1 groups are collapsed by default; object URLs are created only for
  opened groups and revoked when the dialog closes. Photos are grouped
  Obverse / Reverse / Label / Other, weakest matches first. "Skip this coin"
  removes the coin; "None" only unticks.
- Tier 2 grade tolerance: same grade however spelled, or one side saying more
  (`MS64` vs `MS64 CAC`, `XF` vs `XF40`); never `MS64` vs `MS63`, nor
  contradictory designations. A filename with no grade cannot be a near match.
  A near match has no coin until the user acts.
- Tier 3 reasons, in priority order: excluded from automated import; not a
  coin; nothing parsed; no candidates (with the decider's reason); label shot
  only; otherwise "closest coin X at N%, but …". Most single-coin photos here
  are fixed in the data (add the record's grade, or rename the file).
- Long lists are paged 25 at a time.

### "Attach anyway" (tier 3)

A photo that fails only because a detail is missing (typically no grade in the
filename) can be placed by hand without loosening the near-match bar.

- Opt-in: nothing expands until the row's link is clicked, and the panel exists
  only for the open row. It offers the matcher's ranked candidates for that file
  (only those ids are accepted) and the free-text `CoinLookup` search (up to 8 results).
- A rescued row uses the ordinary attach path. It never changes the file's
  tier, `status` or `matchedRecordId`; it keeps its place in the list. Undo
  returns it to skipped.
- Confidence is the matcher's score for a candidate pick, 1 for a search pick.
- Rescue works only on tier-3 rows. Photos excluded from the automated import
  (multi-coin shots) get no link but stay listed with their reason.
- Any file can always be attached by hand from the coin's gallery.

### Photo sets

The shots of one coin are handled as one set.

- **What forms a set** (`image-import/photo-sets.ts`): files whose identifying
  words are equal once the side (Obverse / Reverse / Label / Slab), the variant
  (Small / Orig / Sharpened / Photo / Large) and the shot number are removed:

  ```
  1881 Morgan Dollar NGC 2599001 - Obverse.jpg
  1881 Morgan Dollar NGC 2599001 - Slab Label.jpg
  1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg
  ```

  The words must be equal, not merely contained, so a quiet name like
  "1884 3CN - Obverse 2" does not absorb every 1884 3CN file. Names with a
  single identifying word, and photos excluded from the automated import, are
  never grouped.
- **Not imported** shows one row per set, with a chip per shot. The set's lead
  file (obverse first) supplies the parse, the reason and the candidates.
  "Attach anyway" and Undo act on the whole set.
- **Near matches**: attaching one photo, or picking another coin for it, also
  settles the still-untouched photos of its set, including a member that landed
  in Not imported (usually the label shot). Photos the user has already
  answered are left alone.
- Set actions are built from single-row decisions (`rescueSet`,
  `followPhotoSet` in `row-decisions.ts`), so every per-row guard still applies.
- A label shot never attaches on its own; it rides along with a coin photo.

### Selection rules (tier 1)

`selection-rules.ts`, pure `rows → rows` functions returning new objects.
Every matched row starts ticked; only rows with a coin can be ticked.

| Rule | Effect |
| --- | --- |
| Select / deselect all | All rows with a coin, optionally per coin |
| Keep only Obverse + Reverse | Ticks the two faces (including their retakes), unticks the rest |
| Deselect retakes | Unticks take 2+ and derivatives (Small, Orig, Sharpened) |
| Deselect labels | Unticks label shots |

`photo-variant.ts` reads side, variant and take from the filename: "Photo" is
the original shot; Small / Orig / Sharpened are derivatives only in the last
two segments (so the "Small Eagle" design is not misread); a take is a trailing
separator plus 1–2 digits.

### The photo folder (base folder)

A browser never reveals a file's absolute location; a directory pick gives
only `webkitRelativePath` (forward slashes, starting with the picked folder's
name). The absolute prefix comes from the base-folder box, and the joined path
is stored in `CoinImages.SourcePath`.

- The box is saved to IndexedDB as soon as it is edited and restored on open;
  with nothing saved it starts **empty**. There is no default and no fallback
  to the app's install folder. `D:\Coin Pictures` is placeholder text only.
  Whitespace-only counts as empty.
- The path must be valid **on the machine hosting the app** (a local drive
  letter there), because the server opens the file. A drive mapped only on a
  workstation stores fine and then reads as missing.
- The screen shows a live example of the stored path built from the first
  selected file.
- **Pre-flight check** (`base-folder-check.ts`): up to 5 paths spread across the
  selection are checked with `POST /api/images/exists`. Only a total failure
  blocks the import, and the message names a real failing path. If the check
  itself fails, the import proceeds. No base folder means paths are recorded as
  null, except in referenced mode, where the run is refused.
- **Joining** (`source-path.ts`): one separator at the seam; a UNC `\\` prefix
  kept; a folder name repeated at the seam collapsed; `D:` gets its `\` back.
  Individually picked files fall back to `file.name`.
- **Comparison form** for paths: case-insensitive, `/` = `\`, repeated and
  trailing separators collapsed, UNC prefix kept; an empty form never matches.

### Coins that already have photos

Shown only when at least one matched coin already has photos; applies to the
whole run; counts cover this run's coins only and do not change with the answer.

| Mode | Effect |
| --- | --- |
| Leave (default) | Those coins are not written; their files are not read |
| Replace | Existing photos deleted first; confirmed with the exact photo count. Declining writes nothing |
| Keep both | Existing photos kept, new ones appended, files already attached skipped |

- "Already attached" compares by **original source path**, never by filename
  (names repeat across folders) or bytes. Ambiguous cases count as "not attached".
  Photos with no recorded path are not indexed.
- `PUT /api/coins/:id` replaces the whole image set, so Keep both needs the
  existing photos: use them if in memory; if `imageCount` is 0 use `[]`;
  otherwise fetch them, and if that fails skip the coin and report each file as
  a failure. It never treats "not loaded" as "none".
- Skipped files are excluded from the progress total and reported as skipped.
- The mode resets to Leave when the screen resets.

### Attach

`attach-runner.ts` is the only code that reads files or writes the inventory.

- Strictly sequential with a yield after each file (an 8000×6000 photo decodes
  to about 190 MB of RGBA); each file has its own `try`/`catch`.
- One `attach` call per coin, because saves are debounced per coin.
- Filters run before any read: ticked → existing-photo mode → already attached.
- The `imageSourcePaths` registry is filled before `updateCoin`, so the PUT
  carries `{ imageData, sourcePath }`.
- The in-run dedup only catches byte-identical data URLs; re-import duplicates
  are caught by the source-path skip.
- Order inside `applyConfirmedMatches`: set progress synchronously (so a second
  click is disabled), clear the blocked reason, re-read storage settings,
  refuse referenced mode without a base folder, run the pre-flight check,
  confirm Replace, attach.

### Downscaling and referenced mode

- In the browser with a canvas: long edge 1600 px, JPEG q0.85 (about 250 KB,
  about 333 KB as base64); never upscaled; white backdrop (JPEG has no alpha);
  `createImageBitmap` off the main thread with `<img>` as fallback; a failed
  decode yields 1×1 so encoding cannot throw.
- **Size budget** (`encode-budget.ts`): encode down a ladder of size/quality
  rungs until one fits, decoding once. Rung 0 is 1600 px / 0.85, so the budget
  only makes photos smaller; if nothing fits the smallest rung is kept and
  flagged over budget.
- **Referenced mode**: the referenced encoder never opens the file and plugs
  into the same runner. In `imagePaths` such a photo is carried as the URL
  `/api/images/file?path=<encoded>` (absolute under `ng serve`); the database
  stores SourcePath with ImageData NULL. The URL is a transport form only; the
  server converts both ways (`image-payload.ts`, `reference-url.ts`, mirrored
  on the client).

### Progress and busy state

- Progress is set synchronously when the picker fires and when Save is
  clicked, so `busy()` disables a second click before the first slow step.
- Each stage sets its label, yields to the browser, then does the work.
  Stages with no countable work (reading the folder, building the review list)
  show an indeterminate bar; the indicator stays up while Angular renders the
  review rows. Labels are one-based ("Processing 1 of 317").
- The progress block is sticky, and the Save button shows its own count
  ("Saving 42 of 317…") because the top indicator may be scrolled away.
- Pickers are disabled and `close()` is ignored while busy (the runner is
  still reading the File handles). Wording lives in `import-progress.ts`.

---

## Image matching engine

`src/app/services/image-matching/`. The guiding rule: a photo on the wrong
coin is much worse than a question, so the matcher is pessimistic and every
refused photo stays listed and attachable by hand. Background:
[rationale/image-and-denominations.md](rationale/image-and-denominations.md).

### Pipeline

| Stage | Module | Notes |
| --- | --- | --- |
| 1. Parse | `filename-parser.ts` | Filename → signature |
| 2. Score | `match-scorer.ts` `scorePair` | One filename against one coin |
| 3. Decide | `match-decider.ts` `decideOneImage` | Sets `status` / `matchedRecordId` |
| 4. Tier | `near-match.ts` `assignImportTier` | Advisory; never changes the decision |
| 5. Siblings | `sibling-inference.ts` `inferFromSiblings` | Once per batch, after every image is decided |

Only stages 3 and 5 may set `status` or `matchedRecordId`. Scoring and gates
are in separate files so a scoring change cannot quietly weaken a gate. All
tuning constants are in `matching-thresholds.ts`.

### Parsing filenames

- Only the basename is parsed: folder names ("Early Proofs/") never affect
  parsing, strike or exclusion. A slash in a name leaves only the text after it.
- Filename and coin record share one tokenizer (`text-tokens.ts`). Matching is
  on exact tokens, never a joined string, so the "25" in "1925" is not a quarter.
  `singularize` leaves cert-company acronyms alone.
- **Order**: the non-coin check runs first; words are read before unit-bound
  numbers (which still win, but need the words as context); catalogue
  references ("Sear 6819") are folded into one token before bare numbers are discarded.
- **Denominations**: bare digits never mean a denomination. A number counts
  only with a unit (`$20`, `50¢`, `20-cent`). US dollar face values are a closed
  set ($1, $2.50, $3, $5, $10, $20, and bullion $25 and $50); any other amount,
  or one written with cents or thousands separators ("$20.00", "$1,250"), is a
  price. A spaced cent form ("3 cent") is read only once the file is cleared as
  a single coin. If the words name a more specific form of the same value
  (3-cent silver vs 3 cent), the words win. A bare "cent" after a count other
  than 1 or after a year is skipped. Plural denominations ("Canada 5 Cents") are
  read as group shots.
- **Eagle** is resolved by year: classic $10 (1795–1933) vs modern bullion
  (1986+, size from "1 oz", "1/4 oz"…); undated stays the vague `gold eagle`.
  Silver Eagle is $1 and never agrees with `eagle`.
- **Year and mint mark** (`year-mint-parser.ts`): glued forms like `1875CC`
  are one token, so both parsers agree on legal glued shapes. Year-shaped
  numbers after a camera prefix (`IMG_2024`) are rejected. A mint mark is read
  only from unambiguous positions (glued to the year, fenced by `-`/`_`, spelled
  out, or labelled); two different codes mean none.
- **Grades** (`grade-parser.ts`): numeric, range, adjectival, signed, bare,
  single-letter segment, tried in that order. F and G alone count only after a
  modifier or as their own segment. `normalizeGrade` drops a hyphen only next to
  a digit (`MS-63` → `ms63`, `XF-AU` kept).
- **Photo markers** (`photo-markers.ts`): side, take and variant are reported
  for grouping and never scored.
- **Coin-type tokens** are what remains after removing denomination, grade,
  cert numbers, year, mint mark and city names, and stop words (including
  photo-noise words).
- **Ancients** (`catalog-refs.ts`): era dates ("67-68 CE") are displayed, never
  compared to mint years; catalogue references fold into one coin-type token on
  both sides. "Price" is not a catalogue prefix.

### Non-coin and excluded photos

`non-coin-detector.ts`. About one image in ten on the share is not a single coin.

| Verdict | Triggered by | Effect |
| --- | --- | --- |
| `isNonCoin` | Group shots ("set", "boxes", plurals), stamps, fractional currency, bonds, camera default names (`IM000025.JPG`, `Coin_026.JPG`) | Hard veto: no auto-match, no candidates; "Attach anyway" still offered |
| `excludedFromAutoImport` | Multi-coin markers: "collage", "montage", "hoard", "group" | Also no "Attach anyway"; still listed with its reason |

Both affect only the automated matcher; the gallery never consults them.
Deliberately not markers: "close-up", "cleaned", "copy" (Windows duplicates).

### Counterfeits

Counterfeit coins are matched like any other coin. "fake", "counterfeit" and
"replica" (whole words) mark a filename or a record as counterfeit; on the
record side `isCounterfeitRecord` reads coin type, variety, denomination,
category, set, grade and the Quicken `securityName` (often the only place
"FAKE" appears), not `notes`. The **authenticity veto** keeps a fake photo off
a genuine record and a genuine photo off a fake record. Silence means genuine
on both sides.

### Scoring

```
score = (weighted agreement / comparable weight) × (0.70 + 0.30 × comparable weight / total weight)
```

| Attribute | Weight |
| --- | --- |
| Year | 0.30 |
| Denomination | 0.26 |
| Coin type (Dice coefficient) | 0.22 |
| Cert number | 0.13 |
| Mint mark | 0.09 |
| Cert company | 0.05 |
| Grade | 0.03 |

- An attribute counts only when both sides have a value; missing is never agreement.
- Mint mark is light so coins differing only by mint mark score about 0.10
  apart, inside the margin, and go to review.
- Cert company and grade together count as at most one strong attribute, and
  only when both agree. Grade "exact" can be strong; "extra detail" scores full
  weight but is never strong.
- Without a year a match never auto-assigns (denomination + type caps at
  0.833). Ancients cap near 0.76 and always go to review.

### Auto-assign gates (`match-decider.ts`)

1. Excluded photos and non-coins return 'none' with no candidates. An empty
   parse or inventory returns 'none'.
2. Vetoed coins are removed. If all are vetoed, the closest is reported with its reasons.
3. Auto-assign only when **score ≥ 0.85**, **≥ 2 strong attributes**, and
   **lead over the runner-up ≥ 0.15**, the margin measured over non-vetoed coins.
4. A generic denomination with two or more specific forms among the survivors
   never auto-attaches and offers no candidates.
5. A vague filename (no year, or survivors disagreeing on denomination) offers
   candidates only if the top coin leads by 0.15.
6. Label shots never auto-attach alone.

Everything else is ranked with up to five candidates for review.

### Hard vetoes (`match-vetoes.ts`)

A veto means "not this coin" whatever else agrees. One implementation serves
the scorer (reports it), the decider (drops the coin) and the near-match test
(uses the reasons as blockers).

| Veto | Silence |
| --- | --- |
| Stated year conflict (records may hold a range) | No conflict |
| Denomination conflict (`denominationsAgree`; generic "3¢" agrees with 3CS or 3CN) | No conflict |
| Strike: proof / business / specimen | Silence = business strike |
| Authenticity: counterfeit / genuine | Silence = genuine |

- `proof-strike.ts` resolves a silent strike to business; "unknown" (no
  descriptive text or grade at all) never conflicts. PL, DMPL, DPL and
  "prooflike" are business strikes. Specimen vetoes against both others.
- Consequence: "1870 10-cent - Obverse.jpg" (no PF) is vetoed against its own
  proof record and needs a manual attach.
- `denominationsAgree` (`reference-tables.ts`) is the single source of truth
  and is not transitive (silver eagle = dollar ≈ trade dollar, but silver eagle
  ≠ trade dollar).
- Reason phrases DISQUALIFIED / UNIDENTIFIED / LABEL_ONLY are defined in
  `match-vetoes.ts` so `near-match.ts` can recognise them without an import cycle.

### Sibling inference

Once one shot of a coin is matched on its own, its other shots can follow.

- Siblings share identifying text: filename tokens minus photo words (Obverse,
  Reverse, Label, Slab, Small…) and the shot number (`parsed.take`). Folders are
  never used. Containment, not equality: every token of the quieter name must
  appear in the louder one.
- Gates: the row is not already matched; it is a real single-coin photo, not
  excluded, with more than a bare year; all siblings point at one coin; year and
  coin type agree (type only when both name one); no veto; no rival coin fits equally well.
- Only rows matched on their own may vouch, so inference never chains. An
  inferred row gets status 'auto' and tier 'matched'.

### Grade tolerance (`grade-tolerance.ts`)

Shared by the scorer and the near-match test. Relations: exact, extra-detail,
different, missing.

- Base letters and number must match after canonicalising (PR = PF, EF = XF).
  Decorations may come from one side only; extras on both sides contradict. A
  number on one side only ("XF" vs "XF40") is extra detail.
- Synonym groups: CAM = CAMEO, but CAM, DCAM and UCAM are separate; PL and
  DMPL/DPL separate; RD, RB, BN separate. Lookup is longest first.
- Unrecognised leftovers ("MS64Details") make the grade unparseable → different.
- Extra designations (cac, pq, dmpl, fbl…) are recognised only here, not in the
  filename grade regex.

### Coin side of the comparison (`coin-signature.ts`)

- The matcher reads the denomination label for the coin's id from a snapshot
  taken once per batch, only as input to the denomination readers; the source
  text still feeds the tokens because filenames echo it. An empty snapshot is
  plain text-only matching. Soft-deleted rows are left out; an id with blank
  text is treated as silent.
- The seed has one five-cent row (`5¢`), so Half Dime and Nickel coins read as
  generic 'five cent' and agree with either kind of photo.
- `describeCoin` (the review-group header) includes grade and company so
  same-date records can be told apart.

### Tests

- `real-filenames.spec.ts` uses verbatim filenames (unless marked
  CONSTRUCTED); `testing/real-filenames.fixture.ts` must list every name it uses.
- `import-tiers.spec.ts` prints the tier census over that fixture.
- `inventory-accounts.spec.ts` runs every suite over every account in the
  synthetic QIF corpus with `describe.each`; add a collection by adding a row to
  `QIF_ACCOUNTS`, not a spec file. It uses a derived photo corpus (obverse +
  reverse repeating the record text) and a silent one (year, mint mark and
  denomination only), which shows the cost of reading silence as business strike.
- Many `match-vetoes.spec.ts` cases check the must-not-veto side, because an
  over-eager veto hides the correct coin.

---

## Photos in the app

### Loading

- `GET /api/coins` omits photos and sends `imageCount`. `imagePaths` has three
  states: loaded (array), loaded and empty (`[]`), not loaded (absent).
  "Absent" must never be treated as `[]`, because a PUT with `imagePaths`
  replaces the whole set. Read through `coinPhotoCount()` / `photos()` /
  `services/coin-photos.ts`; templates never reference `imagePaths` directly,
  and code reads it only with `?? []`, `Array.isArray` or `?.`. A spec scans the
  source for unguarded reads.
- `loadCoinImages()` fetches the selected coin's photos (`GET /api/coins/:id/images`),
  uses memory first, skips `imageCount` 0, caches per coin, and rethrows a
  failed fetch. A "Loading photos…" state stops users adding duplicates.

### Gallery and main photo

- Opens for any coin, including one with no photos; it holds the only per-coin
  Add images picker and drop target.
- File-to-base64 is done in 32 KB chunks (spreading a large photo into
  `String.fromCharCode` exceeds the argument limit).
- The main photo (grid thumbnail) is `imagePaths[0]`; the server writes array
  index into `SortOrder`. "Set as main" moves a photo to the front; choosing
  the photo already first does nothing.
- Every write goes through `inv.updateCoin` with only `imagePaths`, needs the
  full loaded set, and does nothing if loading failed.
- Photos always use `object-fit: contain`. Display sizes: 88px in near-match
  rows, 128px in import tiles, 200px in the gallery.

### Full-size viewer

Shows the original file when the backend has confirmed it is readable
(streamed from `GET /api/images/file?path=`), otherwise the stored copy, with
a caption saying which. While the check is pending it shows the stored copy and
swaps up. The window opens at the photo's aspect ratio within half the screen,
never enlarges a small photo, can be resized by its corner (CSS `resize: both`)
up to the image's native size, and has a 240 px minimum.

### Original-file paths

`CoinImages.SourcePath` records where the original lives on the host. Paths
load lazily per coin (`CoinImagePathsService`: one `POST /api/images/exists`
per coin, cached per session, existence cached per path).

| State | Rendering |
| --- | --- |
| present | Link opening in a new tab (through the backend; browsers block `file://` from an http page) |
| missing | Muted, non-clickable text, kept as a record |
| unknown | Plain text; the server did not answer. Never shown as missing |
| none | Nothing |

Long paths are shortened from the middle (58 characters) so the share and the
filename stay visible; the full path is in the tooltip. `CoinImagePathLink`
renders this in the gallery, viewer and sidebar.

### Keeping SourcePath through edits

- `ImageSourcePathRegistry` maps each data URL to its path. `CoinEditor`
  re-attaches known paths to outgoing PUTs as `{ imageData, sourcePath }`; the
  on-screen array stays plain strings for `<img [src]>`.
- The server is the real safeguard: a PUT replace deletes and re-inserts image
  rows, and an entry without a path inherits the recorded path for the same
  ImageData (read in the same transaction). For duplicate data the lowest
  SortOrder's path wins. `sourcePath: null` means unknown, not clear, so a path
  cannot currently be cleared through the API.
- Image ids change on every PUT replace. A stale id in the single-image DELETE
  matches nothing.
- Payload forms (`image-payload.ts`): a bare base64 string (permanent
  compatibility form), `{ imageData, sourcePath }`, or a referenced photo
  (`/api/images/file?path=…` URL or `{ imageData: null, sourcePath }`). Entries
  with neither picture nor path are dropped.

### Original-file endpoints

- `GET /api/images/file?path=` streams any image-extension file on the host
  (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.bmp`, `.tif`, `.tiff`), inline,
  with `Content-Length`; every access is logged with the resolved path. There
  is no root confinement, acceptable only for a single-user local app; it is the
  first thing to lock down if the app is ever exposed beyond localhost.
- `POST /api/images/exists` checks up to 500 paths, never throws (any failure
  is false), uses async `fs` so a dead drive cannot block the server, and logs
  missing paths (capped).

---

## Problem reports (Help → Report a problem)

User-facing description: [what-support-collects.md](what-support-collects.md).

- Two steps: describe, then done. Nothing is written until the button is
  pressed. The "what will be sent" summary is the consent disclosure; the exact
  report text is an optional read-only view of the same cached build that is written.
- The server builds and redacts the report and writes a `.md` file to the
  Desktop (OneDrive Desktop detected first; override `COIN_SUPPORT_OUTPUT_DIR`),
  plus an optional redacted `.txt` of the last 2,000 log lines. The server reads
  the log itself, so unredacted lines never pass through the browser. File
  names share one timestamp: `coin-inventory-problem-report-YYYY-MM-DD-HHMMSS.md`
  and `coin-inventory-log-….txt`.
- "Include recent log" is ticked by default and always sent explicitly.
  Unticking removes all log content, including the tail in the report body; log
  file names and sizes are still sent.
- Redaction: account names → `<USER>`, `<USER2>`…; machine names →
  `<MACHINE>`…; secrets → `<REDACTED>`; emails → `<EMAIL>`. Placeholders are
  stable and distinct, the receipt lists counts and never values, and loopback
  hosts are never aliased. Rule order matters (Authorization header first,
  secrets before identity, email before username, paths before bare tokens).
- The collection appears as counts only (the server's only database access, best-effort).
- The app opens a pre-filled new-issue URL and ships no GitHub token. If the
  encoded URL is too long (about 8 KB), the body goes to the clipboard. The issue
  body lists the saved paths in redacted form, and the log path only if the
  server wrote it. No link is shown while the repository is unconfigured
  (`SUPPORT_REPO_URL`).
- A browser-side buffer of recent errors (50, repeats collapsed) records what
  the user saw, including errors that never reached the server.
- Report caching: a fingerprint of description, error count and the log choice
  decides whether a build is reused; simultaneous show and send share one build.
- `busy` is set before the first `await`, so a double click cannot save two
  files or open two tabs. The repository config is fetched when the dialog
  opens. The done step links to the issue actually opened, in case a pop-up
  blocker stopped the tab, and warns that attached QIF or spreadsheet files can
  hold far more than coin data.
- **Help screen**: a short toolbar guide, then "Report a problem" (the shell
  closes Help and opens the reporter), then the author and a small support
  note. The note appears only on the Help screen and is never a prompt, link or
  button; `help-modal.spec.ts` enforces this.

---

## Persistence

### The database (SQLite)

- **File**: `%LOCALAPPDATA%\CoinInventory\coin-inventory.db` (a home-directory
  folder off Windows). Not the install folder: Program Files is not writable by
  a standard user, and uninstalling must not remove the collection. Overrides:
  `COIN_INVENTORY_DB_PATH` (a file, or `:memory:`) and `COIN_INVENTORY_DATA_DIR`.
- **Schema**: `server/db/schema.sql`, applied on every open (`IF NOT EXISTS`).
- **Schema version**: `PRAGMA user_version` = `SCHEMA_VERSION`. Bump it only when
  an older build could not read the file. 0 means "made before stamping" and is
  accepted; restore refuses a higher version; the stamp is never lowered.
- **Seeding**: issuers, denominations and the other reference lists come from
  `issuers-denominations.json` and `server/db/seed.ts`, insert-if-missing by
  natural key, in one transaction. Nothing is updated or deleted, so user edits
  and soft deletes survive.
- **Decimals are REAL.** Values were always JS doubles, and REAL round-trips
  them exactly. Rounding to the declared scale (half away from zero) and range
  checks are applied in `db/bind-values.ts`.
- **Widths are enforced in code.** SQLite ignores declared widths, so
  `COIN_FIELDS` / `DB_BINDINGS` lengths are the limit, and an over-long value is
  refused (HTTP 400), never truncated. The trailing `-- NVARCHAR(n)` /
  `-- DECIMAL(p,s)` comments in `schema.sql` record the declared type and are
  parsed by parity specs.
- **Collation.** Compared, grouped, ordered or unique text columns use
  `COLLATE NOCASE` (A–Z only, not accents). Payload columns (Notes, CertNumber,
  CatalogNumber, StorageLocation, ImageData, SourcePath, ids) stay BINARY.
- **AUTOINCREMENT** on every integer key, so deleted ids are never reused.
- **Foreign keys** are enabled per connection in `db/driver.ts`.
- **Error numbers.** SQLite errors are translated to the numbers the routes
  classify (2627, 547, 515, 8152, 8114).
- **CollectionStatus** is NOT NULL and validated in `db/collection-status.ts`;
  a spec checks it matches the client's list.
- **CatalogId / DenominationId from imports** arrive as `"3"` or as a mis-mapped
  name; they are normalised to integer-or-NULL so the save never fails.

### Partial updates

`PUT /api/coins/:id` writes only the keys present in the body (filtered
through `COIN_FIELDS`). `imagePaths` present means "replace the whole image
set". The image POST is transactional.

### Backup engine

- Backup uses SQLite's online backup API through a separate read-only
  connection, so the app keeps writing during the copy. The copy holds a read
  transaction so it is not restarted by every write (the WAL grows meanwhile).
  It runs in batches of 512 pages (~2 MB) for progress and cancel; a cancelled or
  failed backup deletes the partial file.
- Backup metadata is written into the finished copy's AppSettings under `backup.*`.
- Inspecting a candidate file is read-only; `-wal`/`-shm` files created by
  opening it are removed, pre-existing ones kept. It reports photo counts and
  distinct folders for referenced photos.
- Restore: validate → close the database (`withDatabaseOffline`) → rename the
  current file aside → write the backup through the online backup API (one
  self-contained file, including any hot WAL) → verify tables and coin count →
  on failure delete the partial file and rename the original back. There is no cancel.
- The folder listing returns only `*.db` regular files from one named folder,
  no recursion, each listing logged; it has no root confinement and should be
  locked down if the app is exposed beyond localhost.

### IndexedDB (`StorageService`)

UI preferences only: columns, sort, filters, grouping, app settings (including
the image-import base folder) and the issuer-lookup consent, keyed by
`StorageKeys`. IndexedDB rather than localStorage because of size. Filter state
and the lookup consent use their own keys, so a failed settings read cannot
leave the grid filtered or silently re-enable the outbound lookup. The launcher
opens Edge with the normal profile so these survive.

---

## Errors and failure stages

- **Stages** (`routes/failure-report.ts`): `connection` (never reached the
  database), `database` (the database returned an error), `delivery` (rows
  retrieved, then sending failed). Only `delivery` carries "your data is safe".
  `sendJson()` marks `retrieved: true`, which overrides other classification.
- **Status mapping** (`db-error-response.ts`): 2627/2601/547 → 409;
  8152/2628/245/241/8114 and validation errors → 400; connection → 503; else
  500. Body `{ error, stage, detail }`.
- **Global handler** (`error-handler.ts`): honours an error's own 400–599
  status (notably 413 for a body over the 50 MB limit, with a "send fewer images"
  message); otherwise a generic 500 message, since error text can contain paths or SQL.
- **Client**: the start-up banner's text comes from `load-failure.ts` by stage;
  the status bar shows the short label and a second Retry. Retry re-runs
  hydration without a reload.
- **Retries** (`http-utils.ts`): writes are retried twice (500 ms, 1000 ms)
  for status 0, 408, 429 and 5xx only. Backup and restore calls are not retried.
- **API base URL**: the page's own origin when Express serves the built app;
  `http://localhost:3000` under `ng serve`.

## Logging and notifications

- Every frontend log line goes to the console and to `POST /api/log`, landing
  in the server's daily log beside server entries. If a post fails, backend
  logging pauses 30 s.
- The server log is `server/logs/app-YYYY-MM-DD.log` (UTC day, 5 MB cap,
  about 14 days kept; override `COIN_LOG_DIR`). Every API request, every
  original-file access and all warnings and errors are logged, and
  `process-safety.ts` logs fatal errors before exit.
- Info and warning toasts dismiss themselves; error toasts stay until closed,
  so background tasks do not raise error toasts.

## Confirmation prompts

| Function | Used for | When `window.confirm` is unavailable |
| --- | --- | --- |
| `confirmAction()` | Actions the user pressed (deletes, removals) | Proceeds |
| `confirmOverwrite()` | Overwrites the app proposes (metal/weight autofill) | Declines |

---

## Known gaps

- **Metal content is not persisted.** `/api/metalcontents` is read-only, so
  adding or removing a metal in Reference Data changes only the in-memory list
  until reload. Adding POST/DELETE on the server is the fix.
- **Unreadable numeric cells** in a CSV/Excel import become 0 without a warning.
- **SourcePath cannot be cleared** through the API (`null` means unknown).
- **Image ids change** on every image-set replace; a reconciling PUT (match on
  ImageData, update SortOrder, insert new, delete removed) would fix it.
- **No SQLite migration runner** yet; schema changes rely on `IF NOT EXISTS`
  and the schema version stamp.
- `Denomination.country` still drives the editor's issuer grouping; moving it
  to issuers is outstanding.
