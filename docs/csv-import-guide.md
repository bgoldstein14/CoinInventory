# Preparing a CSV to import into Coin Inventory

This guide explains how to build a spreadsheet of coins that Coin Inventory
can read. You do not need to know anything about the application's code.

## The short version

**There is no required format.** You are not filling in a rigid template.
Pick any comma-separated file that has a header row, and the app will show
you a screen where you match each of your columns to a coin field.

The fastest ways to get started, in order:

1. **Already have coins in the app?** Use **Export → CSV**. The file it
   produces re-imports with every column matched automatically, so it doubles
   as a perfect template.
2. **Starting from nothing?** Open **Import → CSV** and click
   **Download blank template**. You get a file with the correct header row and
   two example coins to edit.
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

A minimal file is perfectly valid:

```csv
Coin Type,Denomination,Year,Mint Mark,Grade,Purchase Price
Morgan Dollar,Dollar,1881,S,MS63,"$1,250.00"
Mercury Dime,Dime,1916,D,VG8,$895.00
```

## Columns the app recognises automatically

If you use these exact names, the app matches them for you. Anything else is
left for you to map manually — which is fine, just an extra click.

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

**Prices are cleaned up for you.** `$1,250.00` and `1250` both work. Anything
that still is not a number becomes `0`.

**Year is stored as text, not a number.** That is deliberate, so date ranges
and type designations survive.

## Current limitations

These are real gaps, not warnings to work around:

- **Five fields cannot be imported by CSV at all**: CAC sticker, tags, images,
  and the two precious-metal fields (`PmWeightGrams` and `PmPercent`). The
  precious-metal ones matter because **melt value is calculated from them** —
  so a coin imported by CSV will not show a melt value until you fill those in
  by hand in the detail panel. This also means exporting to CSV and re-importing
  loses that data.
- **Semicolon-separated files are not supported**, only commas.
- **Incomplete rows are not caught before import.** The Quicken (QIF) importer
  refuses a coin unless it has at least two of Year / Coin Type / Denomination,
  and shows you the rejects. CSV import does not do this yet — a row missing a
  denomination will be sent to the database and rejected there, showing an
  error rather than a helpful summary.

## If an import goes wrong

Nothing is written until you click the **Import** button on the mapping screen,
so you can always back out. The preview shows the first five rows with your
mapping applied — check that the columns line up before importing.

If coins import but look wrong, the most likely cause is a mis-mapped column.
Delete them and re-import; imported coins are tagged with a source of `csv`,
which makes them easy to find.
