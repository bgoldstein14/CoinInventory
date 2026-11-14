# Sample import files

Six hand-testing files — three `.csv` and three `.xlsx` — built to exercise the
importer's automatic column-to-field mapping at three different difficulty
levels. They are **documentation and hand-test material**. Nothing in the test
suite loads them, and nothing should: a fixture that is also a demo stops being
free to change.

Open the import dialog (Import → CSV / Excel), pick a file, and look at the
mapping grid. The number of dropdowns that come up pre-filled is the thing
being tested.

## The data

All six files carry the **same 25 synthetic coins**, so you can compare one
tier's mapping against another's without the data moving underneath you.
Nothing in them is real — not the coins, not the dealers, not the certificate
numbers, not the prices.

The rows are chosen to include the cases this project has been bitten by:

| Line | What it is there for |
| --- | --- |
| 2 | `½¢` — a non-ASCII denomination (the encoding path) |
| 3 | `£1` — a non-ASCII denomination from another issuer |
| 8 | **Sold Price `0`** — a coin given away. Counts as sold: the rule tests *presence*, not truthiness |
| 9 | **`Sold To` of three spaces** — does **not** count as sold; the text fields are trimmed before they are tested |
| 10 | A **sold date with no price and no buyer** — still sold |
| 11 | A **buyer with no date and no price** — still sold |
| 12 | A description carrying **FAKE** (`Three Cent Silver - FAKE`) alongside a populated `Variety` of `Type 3` |
| 13 | **No denomination at all** — the server refuses this row with `denomination is required` |
| 14 | **Fails the 2-of-3 completeness rule** — a year and nothing else |
| 15 | Fails it a second way — `-` and `n/a`, which *look* populated but are placeholders |

Dates are deliberately written differently from file to file, so the importer
meets more than one format:

| File | Dates written as |
| --- | --- |
| `1-careful-collector.csv` | `4/12/2019` (M/D/YYYY) |
| `1-careful-collector.xlsx` | real Excel date serials, currency-formatted money cells, and one formula cell (`Current Value`, row 1) with a cached result |
| `2-real-world-spreadsheet.csv` / `.xlsx` | `2019-04-12` (ISO) |
| `3-inherited-file.csv` / `.xlsx` | `02.05.2024` (DD.MM.YYYY) |

The CSVs are **UTF-8 with a byte-order mark**, so Excel opens them without
turning `½¢` into `Â½Â¢`. See `src/app/services/csv/byte-order-mark.ts` for why
that matters and why the importer strips the mark back off.

The `.xlsx` files were produced with the repo's own SpreadsheetML writer
(`src/app/testing/xlsx-fixture.ts`), not an added dependency.

## Measured hit rates

**Definition of "rate": matched columns ÷ distinct columns present in the
file.** Not ÷ all 28 mappable fields — a narrow file would score as a failure
under that reading even when it mapped everything it had.

The numbers below were measured by running the app's real matcher
(`CsvService.autoMapHeaders` → `mapHeadersToFields` in
`src/app/services/csv/header-synonyms.ts`) over each file's header row, with
the same value evidence the import dialog supplies. They are not estimates.

| File | Tier | Matched / columns | Rate | Sheets | Rows |
| --- | --- | --- | --- | --- | --- |
| `1-careful-collector.csv` | ~80% | 19 / 23 | **82.6%** | 1 | 25 |
| `1-careful-collector.xlsx` | ~80% | 19 / 23 | **82.6%** | 1 | 25 |
| `2-real-world-spreadsheet.csv` | ~50% | 15 / 28 | **53.6%** | 1 | 25 |
| `2-real-world-spreadsheet.xlsx` | ~50% | 15 / 28 | **53.6%** | **2** | 13 + 12 |
| `3-inherited-file.csv` | ≤20% | 2 / 16 | **12.5%** | 1 | 25 |
| `3-inherited-file.xlsx` | ≤20% | 2 / 16 | **12.5%** | 1 | 25 |

`2-real-world-spreadsheet.xlsx` is the multi-sheet one. Its second worksheet
carries **the same headings in a different order**, which is worth watching:
one mapping decision covers both tabs because the mapping is keyed by header
text, not by column position.

## Tier 1 — "the careful collector" (82.6%)

Real field labels and a few honest near-misses. This is the happy path: open
it and almost every dropdown is already right.

**Deliberately unmatchable (4):**

| Header | Why it does not match |
| --- | --- |
| `Weight (oz)` | Refused on purpose. The field is grams; mapping ounces onto it would understate a Morgan dollar by 31×, silently. See the long note in `mappable-fields.ts`. |
| `Qty` | There is no quantity field. A coin record is one coin. |
| `Sold By` | Refused on purpose. It means the buy side, but it *reads* like the sale side next to `Sold For` / `Sold To`. A blank dropdown costs two seconds; a wrong one costs the import. |
| `Storage Box` | The field is labelled `Storage`; `storage box` is not one of its spellings. |

## Tier 2 — "the real-world spreadsheet" (53.6%)

This is the real test of the synonym table. It is built from the abbreviations
the table's own header comment names (`Yr`, `Denom`, `MM`, `Cond`, `TPG`,
`Cost`, `FMV`), plus genuine typos, plus headings the table refuses by design.
Some hit, some miss, and the misses are the informative part.

**Matched (15):** `Series`, `Denom`, `Yr`, `Mintmark`, `Ctry`, `Cond`, `TPG`,
`KM`, `Var`, `Dealer`, `FMV`, `Memo`, `Sold For`, `Date Sold`, `Buyer`.

**Missed (13), and why:**

| Header | Why |
| --- | --- |
| `Cert Numbr` | Typo. `cert`, `cert no`, `cert num` are all known; `cert numbr` is not. |
| `Aquired` | Typo. `acquired` is a known spelling of Purchase Date; the misspelling is not. |
| `Purchse Price` | Typo. `purchase price` is the exact label; one missing letter drops it. |
| `Aloy` | Typo. `alloy` maps to Composition; `aloy` does not. |
| `Date` | **The value-checked heading.** On its own `Date` means the coin's year, but this column holds `2023-01-01`-style calendar dates, so the matcher *withdraws the claim entirely* rather than guessing which calendar date it is. Note the knock-on effect: with `Date` out of the way, `Yr` wins Year outright instead of tying with it. |
| `Price` | Ambiguous on purpose — could be purchase price, current value or sale price. Never guessed. |
| `Weight (oz)` | Wrong unit; see tier 1. |
| `Location` | The field is labelled `Storage`. `Location` is not a spelling of it — deliberately, because a sheet with a Country column next to "Location" reads as something else entirely. |
| `Holder Type` | `holder` alone means the grading service; `holder type` is a different thing and is not claimed. |
| `Sold By` | See tier 1. |
| `Ref #` | A bare `Ref` is refused by design — over a column of slab numbers it is a certification reference, not a catalogue one. `Reference` spelled out *would* match. |
| `Lot` | No field for it. |
| `Qty` | No field for it. |

**The one that surprises people:** `Mintmark` — a plausible "typo" of
`Mint Mark` — **does** match. The field's key is `mintMark`, and header
normalisation lower-cases and strips punctuation, so `mintmark` is an *exact*
key hit, not a synonym. The same trick means `purchaseprice` or `soldto` would
match too.

## Tier 3 — "the inherited file" (12.5%)

The spreadsheet somebody else kept, inherited without the person who built it.
The point of this file is that the mapping screen stays usable when the matcher
can tell you nothing: 14 of 16 dropdowns come up blank and have to be set by
hand.

**Matched (2):** `Note` (→ Notes), `Grd` (→ Grade).

**Deliberately unmatchable (14):** `Item`, `Desc`, `Jahr` (German for "year"),
`Ref`, `Val`, `A`, `B`, `Col 7`, `Qty`, `#`, `Rem.`, `Out`, `Recd`, `To`.

Worth noticing:

* `Desc` misses although `description` is a known spelling of Coin Type, and
  `Val` misses although `value`, `est val` and `current val` are all known.
  Abbreviations are matched only where they are listed; nothing is prefix-matched.
* `#` normalises to the empty string, which matches nothing by construction.
* `To` misses even though `Sold To` is an exact label — the word on its own
  says nothing about which side of the deal it is.

## Two behaviours to be aware of when testing

* **`FAKE` is not extracted on these paths, and that is correct — not a gap.**
  Fake, counterfeit and replica coins import on **every** path; nothing in the
  CSV or Excel code rejects or filters them. What is QIF-only is the rule that
  *lifts* the word out of a description and joins it into Variety
  (`quicken-import.service.ts`).

  The reason is the shape of the file, not an inconsistency in the importers.
  A QIF security is a **single string** with everything crammed into it —
  `1859 3CS - XF - FAKE` — so there is no other column for the descriptor to
  go in and the importer has to pull it out. A spreadsheet has a Variety
  column, and the owner's expectation (2026-11-14) is the right one: *"I'd
  assume that such a descriptor would be in a Variety column in Excel/CSV."*
  It maps straight through.

  Line 12 here deliberately puts `Three Cent Silver - FAKE` in Coin Type with
  `Type 3` in Variety — a **badly filled-in spreadsheet**, not the normal
  case. It imports verbatim, which is the honest outcome: the app records
  what the file said rather than guessing which column the author meant.
  Treat it as a test of that, not of extraction.
* **A whitespace-only cell does not survive the Excel path.** The
  three-spaces `Sold To` on line 9 arrives as `"   "` from the CSV but as `""`
  from the `.xlsx`, because the workbook reader trims every string cell
  (`xlsx/workbook-cell-text.ts`). Both reach the same answer — the coin is not
  sold — but by different routes, so test the whitespace case against the CSV
  if you want to see the trim-then-test rule actually doing the work.
