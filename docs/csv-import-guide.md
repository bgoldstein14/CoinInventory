# Preparing a CSV to import into Coin Inventory

This guide explains how to build a spreadsheet of coins that Coin Inventory
can read. You do not need to know anything about the application's code.

## The short version

**There is no required format.** You are not filling in a rigid template.
Pick any comma-separated file that has a header row, and the app will show
you a screen where you match each of your columns to a coin field.

The fastest ways to get started, in order:

1. **Starting from nothing?** Open **Import → CSV** and click
   **Download blank template**. You get a file with the correct header row —
   every column the app recognises, in order, apart from **Source**, which is
   deliberately left out because a row you type by hand came from you — and two
   example coins to edit. All of its columns match automatically.
2. **Already have coins in the app?** Use **Export → CSV**. Every column the
   export writes re-imports with its mapping matched automatically, so the file
   round-trips completely. That includes the **Source** column, which records
   where each coin's data originally came from — so a coin that arrived from
   Quicken still says Quicken after a round trip, rather than being relabelled
   as a CSV import.
3. **Got a file from a dealer, an auction house, or another program?** Just
   import it as-is. Whatever the columns are called, you can map them by hand.

## What the file must look like

- The **first row must be the header row** — the names of your columns.
- Values must be separated by **commas**. Semicolons will not work. (If you
  are in a European Excel locale, your CSV may be semicolon-separated by
  default; use *Save As → CSV UTF-8* or change the list separator.)
- One coin per row after the header.
- Quotes work the normal way: wrap a value in `"` if it contains a comma or a
  line break, and use `""` for a literal quote mark inside it.
- **There must be at least one coin.** A file containing nothing but a header
  row is ignored without a message, which looks like the file button did
  nothing. Completely blank rows further down are fine — they are skipped, not
  imported as empty coins.

A minimal file is perfectly valid:

```csv
Coin Type,Denomination,Year,Mint Mark,Grade,Purchase Price
Morgan Dollar,Dollar,1881,S,MS63,"$1,250.00"
Mercury Dime,Dime,1916,D,VG8,$895.00
```

## Columns the app recognises automatically

If you use these names, the app matches them for you. Anything else is left for
you to map manually — which is fine, just an extra click.

Capitalisation does not matter and neither do spaces around the name, so
`purchase price`, `Purchase Price` and ` PURCHASE PRICE ` all match. What does
matter is the wording: `Purchase Cost` or `Price Paid` will not be recognised,
and you map them yourself.

| Column name | What it holds |
| --- | --- |
| Coin Type | e.g. `Morgan Dollar`, `Lincoln Cent` |
| Denomination | e.g. `Dollar`, `Quarter`, `Half Dollar` |
| Year | Free text, so `1878-S` or `1917 Type 1` are fine |
| Category | Your own grouping, e.g. `Silver Dollars` |
| Country | Defaults to `United States` if left blank |
| Grade | e.g. `MS63`, `AU50`, `VF20` |
| Cert Company | e.g. `PCGS`, `NGC`, `ANACS` |
| Cert Number | The slab serial number |
| Variety | e.g. `VAM-1A`, `DDO` |
| Mint Mark | e.g. `S`, `D`, `CC` |
| Composition | e.g. `90% Silver` |
| Purchase Date | |
| Purchase Price | `$` signs and commas are fine |
| Current Value | `$` signs and commas are fine |
| Notes | Free text |
| Set | Set membership |
| Metal Content | `Gold`, `Silver`, `Platinum`, `Copper` |
| Weight (g) | The coin's total weight in **grams** — see the note below |
| Sold Price | |
| Sold Date | |
| Source | Where the coin's data came from. Only `Manual`, `Quicken`, `Import` or `CSV` are understood; anything else, or a blank, is read as `CSV`. You will normally only meet this column in a file the app exported |

**Column order does not matter**, and you can leave any column out entirely.

**A `Dealer` column is no longer recognised.** Coins used to carry a dealer name
and older exports still have that column. The field was removed — who a coin
came from is recorded on its transactions instead — so the column has nothing
left to map onto. An old file still imports perfectly well; the Dealer column is
simply ignored, along with the rest of the row importing as normal.

### ⚠ The weight column changed from troy ounces to grams

**If you have a CSV you exported before this change, read this before importing
it.** Weight used to be recorded in troy ounces and the column was headed
`Weight (oz)`. It is now recorded in **grams** and the column is headed
`Weight (g)`.

One troy ounce is 31.1 grams, so the same number means two very different
coins depending on which unit it is in:

| The number `0.7734` | Means |
| --- | --- |
| read as troy ounces (the old way) | 24.1 g — a Morgan silver dollar |
| read as grams (the new way) | 0.77 g — about a third of a cent coin |

**What happens if you import an old file.** The old `Weight (oz)` heading is no
longer recognised, so the column arrives on the mapping screen with **no field
selected**, and nothing from it is imported. That is deliberate. The app will
not guess, because guessing wrong would quietly record every coin at a
thirty-first of its real weight and nothing on screen would look odd.

Everything else in the file imports exactly as before — only the weight column
is left out.

**What to do about it.** You have three choices, and all of them are fine:

- **Ignore it.** Import the file as it is and leave the weight column unmapped.
  Nothing else is affected. If your collection is already in the app, its
  weights are already in grams and nothing is lost.
- **Convert the column first.** In your spreadsheet, multiply the weight column
  by **31.1034768**, rename the heading to `Weight (g)`, and import. The column
  will then map on its own.
- **Map it by hand anyway** — but only if you already know the numbers in it
  are grams. On the mapping screen, pick `Weight (g)` from the dropdown next to
  the column. If the numbers are still troy ounces, do not do this.

**Export is already in grams.** Anything you export from the app today is
headed `Weight (g)` and holds gram figures, so a fresh export re-imports
cleanly with no work at all.

## Things worth knowing

**Every coin needs at least two of Year, Coin Type and Denomination.** A row
with fewer than two of them is not a coin record, it is a fragment, and the app
will not import it. This is the same rule the Quicken import uses.

A few details about how that is enforced, because it is easy to trip over:

- Placeholder text does not count as filled in. `-`, `?`, `0`, `n/a`, `none`,
  `unknown`, `TBD` and similar are treated as blank, so a row whose Year reads
  `unknown` has only whatever its other two columns hold.
- Rows that fail are **not** imported and **not** silently dropped. After you
  click Import you get a panel headed **"Not imported — too little detail"**,
  listing each refused row by its row number — counting the coin rows after the
  header, with blank rows not counted — together with what the app did manage
  to read from it and which of the three details were missing.
- The import dialog **stays open** when anything was refused, so that list is
  actually readable; it closes by itself only when every row went in. The
  remaining good rows are imported either way, and the panel tells you how
  many.

So the usual fix is to correct those lines in your file, or map the column you
forgot to map, and import again.

**Blank cells are skipped.** An empty cell leaves that field at its default
rather than writing an empty value over it.

**Four columns are treated as numbers**, and the app is forgiving about how you
write them: Purchase Price, Current Value, Sold Price and **Weight (g)**. All
of these work:

| You write | It reads as |
| --- | --- |
| `$1,250.00` | 1250 |
| `1250 USD` | 1250 |
| `(1,250.00)` | −1250 (the way spreadsheets show a negative) |
| `26.73` | 26.73 |
| `26.73 g` | 26.73 |
| `26.73 grams` | 26.73 |

In short: currency symbols, thousands commas and a trailing unit are all
ignored. A cell with no number in it at all, such as `n/a`, still comes in
as `0`.

**A warning about the weight column specifically.** Only the *number* is read —
whatever unit you type after it is thrown away, and nothing checks that it says
grams. So `0.7734 ozt` imports as **0.7734 grams**, not as the 24.06 grams that
figure actually describes. Put grams in the weight column.

The same applies to fractions. A cell like `1/10` is worked out for you (it
reads as `0.1`), which is useful in a price column but is a trap in the weight
column: `1/10 oz` is a perfectly normal way to describe a tenth-ounce gold
coin, and it will import as a tenth of a **gram**. A 1/10 oz Gold Eagle weighs
**3.393 g** — write that.

Every other column is stored as the text you typed.

**Year is stored as text, not a number.** That is deliberate, so date ranges
and type designations survive.

## Current limitations

These are real gaps, not warnings to work around:

- **Four things cannot be imported by CSV at all.** There is no column for any
  of them, and no way to map one:
  - the **CAC sticker** flag
  - **photos**
  - the **precious-metal weight in grams**
  - the **precious-metal percentage** (the fineness, e.g. 90%)

  The precious-metal pair matters more than it looks. **Melt value is worked
  out from the precious-metal weight in grams together with the Metal Content** —
  that gram figure is the weight of the *pure* metal in the coin, and it is the
  one of the two that CSV cannot carry. So a coin brought in by CSV shows no
  melt value at all until you type its precious-metal weight by hand in the
  detail panel, even though its Metal Content imported fine. (The
  precious-metal **percentage** is worth recording and is shown in the detail
  panel, but it is not part of the melt sum — the gram weight already describes
  pure metal only, so applying the percentage again would discount it twice.)

  Note the consequence for round-tripping: exporting your collection to CSV and
  importing it back does **not** preserve the precious-metal weight or
  percentage, your photos, or the CAC flag. Every column the export *writes*
  comes back intact, but those four were never in it. A CSV export is a good
  report and a good starting template; it is **not** a backup.

  Also worth knowing: the general **Weight (g)** column *can* be imported, but
  it is the coin's total gross weight, not its precious-metal content, and melt
  value does not use it. Filling it in will not produce a melt value on its own.
  Both columns are now in grams, which makes them easier to compare but no
  harder to confuse — the one melt value needs is the *precious-metal* weight,
  and that one still cannot come in by CSV.
- **Semicolon-separated files are not supported**, only commas.

## If an import goes wrong

Nothing is written until you click the **Import** button on the mapping screen,
so you can always back out. The preview shows the first five rows with your
mapping applied — check that the columns line up before importing.

If coins import but look wrong, the most likely cause is a mis-mapped column.
Delete them and re-import; unless your file carried its own Source column,
imported coins are marked with a source of `csv`, which makes them easy to
find.

If the dialog does not close after you click Import, that is not a failure —
it means some rows were refused for lack of detail, and it is holding the
**"Not imported — too little detail"** list open for you to read. The coins
that were accepted have already been saved; close the dialog with **Done** when
you have finished with the list.
