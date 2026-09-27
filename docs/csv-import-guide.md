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
   every column the app recognises, in order — and two example coins to edit.
   This is the one file where *all* the columns match automatically.
2. **Already have coins in the app?** Use **Export → CSV**. Every column
   re-imports with its mapping matched automatically, including the **Source**
   column that records where each coin's data originally came from — so a coin
   that arrived from Quicken still says Quicken after a round trip, rather than
   being relabelled as a CSV import.
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
| Dealer | Who you bought it from |
| Set | Set membership |
| Metal Content | `Gold`, `Silver`, `Platinum`, `Copper` |
| Weight (oz) | Troy ounces |
| Sold Price | |
| Sold Date | |

**Column order does not matter**, and you can leave any column out entirely.

## Things worth knowing

**Blank cells are skipped.** An empty cell leaves that field at its default
rather than writing an empty value over it.

**Four columns are treated as numbers**, and the app is forgiving about how you
write them: Purchase Price, Current Value, Sold Price and **Weight (oz)**. All
of these work:

| You write | It reads as |
| --- | --- |
| `$1,250.00` | 1250 |
| `1250 USD` | 1250 |
| `(1,250.00)` | −1250 (the way spreadsheets show a negative) |
| `0.7734` | 0.7734 |
| `0.7734 ozt` | 0.7734 |
| `1/10 oz` | 0.1 |

In short: currency symbols, thousands commas and a trailing unit are all
ignored, and a fraction like `1/10` is worked out for you — useful for
fractional-ounce gold. A cell with no number in it at all, such as `n/a`, still
comes in as `0`.

Every other column is stored as the text you typed.

**Year is stored as text, not a number.** That is deliberate, so date ranges
and type designations survive.

## Current limitations

These are real gaps, not warnings to work around:

- **Five things cannot be imported by CSV at all.** There is no column for any
  of them, and no way to map one:
  - the **CAC sticker** flag
  - **tags**
  - **photos**
  - the **precious-metal weight in grams**
  - the **precious-metal percentage** (the fineness, e.g. 90%)

  The last two matter more than they look. **Melt value is calculated from the
  precious-metal weight and percentage**, so a coin brought in by CSV shows no
  melt value at all until you fill those two in by hand in the detail panel.
  Note the consequence for round-tripping: exporting your collection to CSV and
  importing it back does **not** preserve them. Nor does it preserve your tags,
  your photos, or the CAC flag. A CSV export is a good report and a good
  starting template; it is **not** a backup.

  Also worth knowing: the general **Weight (oz)** column *can* be imported, but
  it is the coin's total weight and is not what melt value uses. Filling it in
  will not produce a melt value on its own.
- **Semicolon-separated files are not supported**, only commas.
- **Incomplete rows are not caught before import.** When importing from
  Quicken, a coin is refused unless it has at least two of Year / Coin Type /
  Denomination, and you are shown a list of exactly which records were skipped
  and why. CSV import does not do that check — every row is sent, and a row too
  sparse to be a real coin record is rejected by the database instead. You do
  get a summary afterwards ("Added 40 coins, but 3 failed to save"), so nothing
  fails silently, but it tells you *how many* failed rather than *which ones*.
  The rejected rows also stay visible in the table until you reload, at which
  point they disappear, because they were never actually saved.

  In practice: give every coin at least two of Year, Coin Type and Denomination
  and this will not come up.

## If an import goes wrong

Nothing is written until you click the **Import** button on the mapping screen,
so you can always back out. The preview shows the first five rows with your
mapping applied — check that the columns line up before importing.

If coins import but look wrong, the most likely cause is a mis-mapped column.
Delete them and re-import; imported coins are tagged with a source of `csv`,
which makes them easy to find.
