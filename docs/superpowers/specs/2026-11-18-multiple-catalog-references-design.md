# Multiple catalogue references per coin

Status: design, 2026-11-18. Follow-up: matching ancient-coin photos on these
references (separate design, builds on this one).

## Intent

Ancient and world coins are identified by catalogue reference, and one coin
often carries several (`Sear 6819`, `RIC 123`, `Cohen 45`). Today a coin can
hold only one (`Coins.CatalogId` + `Coins.CatalogNumber`). Store any number of
references per coin, show one "main" reference where a single value is
needed, and make all of them searchable.

## Goals

- A coin has an ordered list of zero or more references, each a catalogue
  (from the Catalogs lookup, or none) plus a number.
- **Main reference** = the first reference whose catalogue is **Sear**
  (case-insensitive name match), otherwise the first reference in the list.
  Owner's choice. It is computed wherever it is shown, never stored.
- Grid column "Catalogue Ref.", grouping and sorting use the main reference.
  Reports use the main reference too.
- Free-text search matches every reference on the coin, not just the main one.
- Editor: one row per reference (catalogue picker, number, remove), plus an
  "Add reference" button. Removing all rows clears the coin's references.
- Catalog maintenance: "in use by N coins" counts coins that have at least one
  reference to that catalogue.
- Fix two existing bugs found while mapping the old field (verify each with a
  failing test first):
  1. Choosing "(none)" for the catalogue on an existing coin did not clear it
     (the save path dropped the `undefined` value). The new list-based editor
     removes this path; a test pins that removing a reference really removes it.
  2. Removing (soft-deleting) a catalogue made its name vanish from the grid
     for coins still pointing at it. `GET /api/catalogs` returns inactive rows
     too, with `isActive`; the picker and the maintenance list filter to
     active, and name lookup (`catalogNameById`) keeps working for inactive.

## Non-goals

- Auto-fill from a reference (dropped by the owner).
- Using references in the photo matcher (next design).
- Preserving existing data: the owner is rebuilding the database from fresh
  test imports, so no back-fill of the old two columns is needed.

## Approaches considered

- **A. Child table, list on the coin (chosen by the owner).** New
  `CoinCatalogRefs` table modelled on `CoinImages`; the two `Coins` columns
  are removed; the coin carries `catalogRefs[]`; main reference derived.
- B. Keep the two columns as the main reference plus a child table for the
  rest. Rejected: references in two places, every save must re-rank, search
  and usage counts must read both.
- C. JSON text column on `Coins`. Rejected: no foreign key to Catalogs, usage
  counts and renames have to parse text, unlike anything else in the schema.

## Data model

`server/db/schema.sql` (the live SQLite schema; the old `server/migrations/`
files are SQL Server history and are not touched):

```
CoinCatalogRefs
  RefId          INTEGER PRIMARY KEY AUTOINCREMENT
  CoinId         TEXT NOT NULL  -> Coins(CoinId) ON DELETE CASCADE
  CatalogId      INTEGER NULL   -> Catalogs(CatalogId)   (no cascade; soft delete only)
  CatalogNumber  TEXT NOT NULL  -- NVARCHAR(50)
  SortOrder      INTEGER NOT NULL DEFAULT 0
  INDEX IX_CoinCatalogRefs_CoinId_SortOrder (CoinId, SortOrder)
  INDEX IX_CoinCatalogRefs_CatalogId (CatalogId)
```

- `Coins.CatalogId`, `Coins.CatalogNumber` and `FK_Coins_Catalog` are removed.
- A reference with an empty number is not stored (a picked catalogue with no
  number yet is dropped on save). The number is stored exactly as typed,
  trimmed at the ends only (existing rule).
- Bump `SCHEMA_VERSION` to 2. Opening a version-1 file (or restoring a
  version-1 backup) copies each coin's single reference into `CoinCatalogRefs`
  (`upgradeSchema` in db/schema.ts); the backup verifier does not require the
  new table, since opening the file creates it.

Front-end type (`CoinRecord`):

```ts
interface CatalogRef { catalogId: number | null; catalogNumber: string; }
catalogRefs?: CatalogRef[];   // replaces catalogId / catalogNumber
```

`catalog-reference.ts` gains `mainCatalogRef(catalogs, refs)` and
`formatCatalogRefs(catalogs, refs)` (all, joined with `; `); every display and
the search text go through these.

## API

- `POST /api/coins` and `PUT /api/coins/:id` accept `catalogRefs`; when the key
  is present it replaces the coin's whole list in the same transaction
  (same semantics as `imagePaths` / `replaceImages`). Widths validated by the
  existing bind-values rules.
- `GET /api/coins` (list) and `GET /api/coins/:id` always include
  `catalogRefs`, ordered by `SortOrder` — one extra grouped query for the list,
  as the image count already does.
- `GET /api/catalogs` returns all rows including inactive, with `isActive`.
- Reference usage: `SELECT CatalogId, COUNT(DISTINCT CoinId) FROM CoinCatalogRefs
  WHERE CatalogId IS NOT NULL GROUP BY CatalogId`.

## CSV import / export

- Export: one column **"Catalog References"**, value = all references formatted
  and joined with `; ` (e.g. `Sear 6819; RIC 123`). The old `Catalog Id` /
  `Catalog Number` export columns go away.
- Import: the mappable field becomes `catalogRefs` ("Catalog References").
  Existing header synonyms that pointed at `catalogNumber` now point here.
  A cell is split on `;`; each part is matched by a leading catalogue name
  against the Catalogs list (case-insensitive, longest name first, so
  `Krause (KM) 110` works) and the rest is the number; a part with no known
  catalogue name becomes a reference with no catalogue and the whole part as
  the number. Round-trip export -> import must reproduce the same list.

## SQL Server migration tool (`server/migrate-sqlserver/`)

Owner decision (2026-11-18): the SQL Server migration is abandoned. The tool,
the old SQL Server migration files and the SQL Server drivers are deleted
rather than updated.

## Testing

- Server: schema parity, write/replace/read of refs, cascade on coin delete,
  usage counts, catalogs GET including inactive, widths.
- Front end: main-reference rule (Sear first, else first; Sear later in the
  list; two Sear refs; none), formatting, search hits a non-main reference,
  grid/grouping/report use main, editor add/remove/clear, CSV split/round-trip,
  both bug fixes.
- Run in the browser locally (throwaway DB via `COIN_INVENTORY_DB_PATH`): add a
  coin with three references, reload, check grid, search, edit, remove,
  CSV export -> import.

## Left to the builder

Exact editor layout within the existing certification row area; whether the
grid cell shows a "+N" hint for extra references (suggested: yes, e.g.
`Sear 6819 (+2)`); spec renames.
