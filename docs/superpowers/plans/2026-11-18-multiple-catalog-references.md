# Multiple Catalogue References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coin carry any number of catalogue references, with Sear as the main one where a single value is shown.

**Architecture:** New `CoinCatalogRefs` child table (modelled on `CoinImages`) replaces `Coins.CatalogId/CatalogNumber`. The coin carries `catalogRefs[]`, saved replace-all with the coin's own POST/PUT and always returned on reads. The main reference is derived on the client by one helper in `catalog-reference.ts`, which every display goes through.

**Tech Stack:** Angular 22 (signals), Express + `node:sqlite`, vitest (front end: `npx vitest run --root src <filter>`; server: `cd server; npx vitest run <filter>`).

**Spec:** `docs/superpowers/specs/2026-11-18-multiple-catalog-references-design.md`

## Global Constraints

- No git in this checkout: a task's "checkpoint" is its tests plus `npx tsc -p tsconfig.app.json --noEmit` (front end) or the server type check passing. Backup of the pre-change tree: `C:\Users\BR651094\source\dev-backup-before-comment-cleanup`.
- Live schema is `server/db/schema.sql` only. Do not edit `server/migrations/*.sql`.
- `CatalogNumber` width 50 (`-- NVARCHAR(50)` trailing comment, parsed by specs); catalogue name width 60.
- Main reference: first ref whose catalogue name is `sear` (case-insensitive, trimmed), else the first ref.
- Numbers stored as typed, trimmed at the ends only.
- Comment style: short, practical; no history, no essays (see the owner's standing rule).

## Review Focus

1. Same reference entered twice (same catalogue + same number, any case of spaces at the ends) → saved once. Test in Task 3.
2. A number over 50 characters → save rejected with the existing width error, not silently truncated. Test in Task 3.
3. A catalogue removed while coins still use it → those coins still show `Sear 6819`, and the picker no longer offers it. Test in Task 4.
4. CSV cell with stray separators/spaces (`" Sear 6819 ;; RIC 123; "`) → exactly two refs. Test in Task 6.
5. Deleting a coin deletes its refs (cascade); the catalogue's usage count drops. Test in Task 3.

---

### Task 1: Front-end reference helpers

**Files:**
- Modify: `src/app/types/catalog-reference.ts`
- Test: `src/app/types/catalog-reference.spec.ts`

**Interfaces:**
- Produces:
  - `interface CatalogRef { catalogId: number | null; catalogNumber: string }`
  - `mainCatalogRef(catalogs: readonly CatalogOption[] | undefined, refs: readonly CatalogRef[] | undefined): CatalogRef | null`
  - `formatCatalogRefs(catalogs, refs): string` — all refs via `formatCatalogReference`, joined `"; "`, `''` when none.
  - `formatMainCatalogRef(catalogs, refs): string` — main ref formatted, plus ` (+N)` when N other refs exist; `''` when none.
  - `normalizeCatalogRefs(refs): CatalogRef[]` — trim numbers, drop empty numbers, drop exact duplicates (same `Number(catalogId)` or both null, same trimmed number), keep order.
  - `parseCatalogRefs(text: string, catalogs: readonly CatalogOption[]): CatalogRef[]` — for CSV import (algorithm below).

- [ ] **Step 1: Write failing tests** in `catalog-reference.spec.ts`:
  - `mainCatalogRef` with `[RIC 123, Sear 6819]` → the Sear ref; `[RIC 123, Cohen 45]` → RIC; two Sear refs → the first Sear; `[]`/`undefined` → `null`; catalogue named ` SEAR ` still counts.
  - `formatMainCatalogRef` of `[RIC 123, Sear 6819, Cohen 45]` → `'Sear 6819 (+2)'`; single ref → no suffix; ref with `catalogId: null` → number alone.
  - `formatCatalogRefs` of the same three → `'RIC 123; Sear 6819; Cohen 45'`.
  - `normalizeCatalogRefs([{1,' 6819 '},{1,'6819'},{2,''}])` → `[{1,'6819'}]`.
  - `parseCatalogRefs(' Sear 6819 ;; RIC 123; Krause (KM) 110; Foo 9 ', catalogs)` → `[{sear,'6819'},{ric,'123'},{km,'110'},{null,'Foo 9'}]`.
  - Round trip: `parseCatalogRefs(formatCatalogRefs(c, refs), c)` deep-equals `refs` for a 3-ref list including a null-catalogue ref.
- [ ] **Step 2:** `npx vitest run --root src app/types/catalog-reference` → FAIL (not defined).
- [ ] **Step 3: Implement** in `catalog-reference.ts` (keep the file import-free). `parseCatalogRefs`: split on `;`, trim, drop empties; for each part, try catalogue names sorted longest-first, case-insensitive, matching `name` followed by whitespace or end; on match number = rest trimmed (if empty, keep catalogue with empty number → then dropped by `normalizeCatalogRefs`); else `{catalogId: null, catalogNumber: part}`. Return `normalizeCatalogRefs(result)`. Match against ALL catalogues including inactive.
- [ ] **Step 4:** same command → PASS. Checkpoint.

### Task 2: Schema

**Files:**
- Modify: `server/db/schema.sql` (Coins block ~:300–340, add table after `CoinImages` ~:361, indexes near ~:433), `server/db/schema.ts` (`SCHEMA_VERSION` → `2`), `server/backup/verdict.ts:54–66` (`REQUIRED_TABLES` += `'CoinCatalogRefs'`), `server/db/coin-fields.ts` (remove `catalogId` and `catalogNumber` entries ~:196–212), `server/db/row-mappers.ts:95–96` (remove the two fields).
- Test: `server/db/schema.spec.ts`, `server/db/catalog-columns.spec.ts` (rewrite for the child table), `server/db/coin-fields.spec.ts`, `server/db/bind-values.spec.ts` (drop catalog cases that no longer apply).

**Interfaces:**
- Produces: table `CoinCatalogRefs(RefId INTEGER PK AUTOINCREMENT, CoinId TEXT NOT NULL FK→Coins ON DELETE CASCADE, CatalogId INTEGER NULL FK→Catalogs, CatalogNumber TEXT NOT NULL -- NVARCHAR(50), SortOrder INTEGER NOT NULL DEFAULT 0)`, indexes `IX_CoinCatalogRefs_CoinId_SortOrder(CoinId, SortOrder)` and `IX_CoinCatalogRefs_CatalogId(CatalogId)`. `Coins` no longer has `CatalogId`/`CatalogNumber`/`FK_Coins_Catalog`.

- [ ] **Step 1: Failing tests:** `catalog-columns.spec.ts` asserts (via `PRAGMA table_info`/`foreign_key_list` on an in-memory DB from `test-support/sqlite-test-db.ts`) the table, columns, both FKs (CoinId cascade, CatalogId no cascade), both indexes, that `Coins` lacks the two old columns, `user_version = 2`, and the width-50 comment is present. `schema.spec.ts` parity with `REQUIRED_TABLES` keeps passing with the new table.
- [ ] **Step 2:** `cd server; npx vitest run db` → FAIL.
- [ ] **Step 3:** Make the schema/constant edits listed under Files.
- [ ] **Step 4:** `cd server; npx vitest run db backup` → PASS; server type check passes. Checkpoint.

### Task 3: Server read/write of `catalogRefs`

**Files:**
- Modify: `server/routes/coins/write-helpers.ts` (add next to `insertImages`/`replaceImages`), `server/routes/coins/writes.ts` (POST :56–122, PUT :125–204), `server/routes/coins/reads.ts:84–109`, `server/routes/coins/list-query.ts:84–159`
- Test: `server/routes/coins/writes.spec.ts`, new `server/routes/coins/catalog-refs.spec.ts`

**Interfaces:**
- Consumes: Task 2 table.
- Produces:
  - `insertCatalogRefs(tx, coinId: string, refs: unknown): void` — validates each item `{catalogId: number|string|null, catalogNumber: string}`, normalizes `catalogId` with the existing `normalizeForeignKeyId`, applies server-side equivalent of `normalizeCatalogRefs` (trim, drop empty, dedupe), enforces width 50 via the existing bind-values path (400 on overflow), writes `SortOrder` = index.
  - `replaceCatalogRefs(tx, coinId, refs)` — delete then insert, same transaction.
  - POST: always calls `insertCatalogRefs(tx, id, body.catalogRefs ?? [])`. PUT: only when `'catalogRefs' in body`.
  - GET `/api/coins` and `/api/coins/:id`: every coin has `catalogRefs: {catalogId: number|null, catalogNumber: string}[]` ordered by `SortOrder` (list: one `SELECT ... ORDER BY CoinId, SortOrder` grouped into a Map; coins with none get `[]`).

- [ ] **Step 1: Failing tests** (`catalog-refs.spec.ts`): POST with 3 refs → GET returns them in order; PUT with a new list replaces it; PUT without the key leaves refs alone; PUT `[]` clears; duplicate pair saved once; `catalogId: "3"` stored as 3; number of 51 chars → 400 and nothing written; DELETE coin → `SELECT COUNT(*) FROM CoinCatalogRefs WHERE CoinId=?` is 0; list GET includes `catalogRefs: []` for a coin with none.
- [ ] **Step 2:** `cd server; npx vitest run routes/coins` → FAIL.
- [ ] **Step 3:** Implement as above.
- [ ] **Step 4:** PASS; server type check. Checkpoint.

### Task 4: Catalogues lookup — inactive rows and usage counts

**Files:**
- Modify: `server/routes/lookups/catalogs.ts:59–64` (GET returns all rows with `isActive`), `server/routes/lookups/reference-usage.ts:77–115` (catalog usage from the child table), `src/app/services/inventory/lookup-manager.ts:307–317` (`removeCatalog` marks `isActive: false` instead of filtering out), `src/app/components/coin-editor-form/coin-editor-form.ts:117–119` (`activeCatalogs` stays active-only), `src/app/components/category-modal/category-modal.ts`/`.html:591–599` (list only active catalogues).
- Test: `server/routes/lookups/catalogs.spec.ts`, `server/routes/lookups/reference-usage.spec.ts`, `src/app/services/inventory/lookup-manager` spec (find the existing one; else add `lookup-manager-catalogs.spec.ts`), `src/app/components/category-modal/category-modal.spec.ts`.

**Interfaces:**
- Produces: `GET /api/catalogs` → `{catalogId, name, sortOrder, isActive: boolean}[]`, ordered `SortOrder, CatalogId`. Usage: `COUNT(DISTINCT CoinId)` per `CatalogId`.

- [ ] **Step 1: Failing tests:** server GET includes a soft-deleted row with `isActive: false`; usage counts a coin with two refs to the same catalogue once and a coin with refs to two catalogues once in each; client: after `removeCatalog(id)` the signal still holds the row with `isActive: false`, `catalogNameById` still returns its name, editor `activeCatalogs()` and the maintenance list exclude it.
- [ ] **Step 2:** run server `routes/lookups` and front end `app/services/inventory app/components/category-modal` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Checkpoint.

### Task 5: Front-end model, grid, search, grouping, reports

**Files:**
- Modify: `src/app/types/coin.model.ts:222–248` (replace `catalogId`/`catalogNumber` with `catalogRefs?: CatalogRef[]`), `src/app/types/inventory-columns.ts:472–473` (`formatMainCatalogRef(catalogs, coin.catalogRefs) || '—'`), `src/app/features/inventory/grid-grouping.ts:313–327` (group key = main ref without the `(+N)` suffix — use `formatCatalogReference` of `mainCatalogRef`), `src/app/features/inventory/inventory-filter.store.ts:355` (`formatCatalogRefs` — all refs), reports (`report-fields.ts:236–245` keep reusing the grid formatter), `src/app/testing/test-helpers.ts:39–54`.
- Test: `src/app/types/catalog-column.spec.ts`, `src/app/features/inventory/inventory-filter.store.spec.ts`, grid-grouping spec, `report-fields.spec.ts`, `build-report.spec.ts`.

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `CoinRecord.catalogRefs?: CatalogRef[]`; no other code may read `catalogId`/`catalogNumber` on a coin (grep must find none outside the SQL Server tool).

- [ ] **Step 1: Failing tests:** grid cell for `[RIC 123, Sear 6819]` is `'Sear 6819 (+1)'`; search `'123'` finds that coin (non-main ref); grouping puts it under `'Sear 6819'`; report cell equals grid cell.
- [ ] **Step 2:** run the listed specs → FAIL.
- [ ] **Step 3:** Implement; fix every compile error the type change exposes (`npx tsc -p tsconfig.app.json --noEmit`).
- [ ] **Step 4:** full front-end `npx vitest run --root src` PASS. Checkpoint.

### Task 6: Editor and CSV

**Files:**
- Modify: `src/app/components/coin-editor-form/coin-editor-form.html:430–481`, `coin-editor-form.ts:133–136, :457–462`, `coin-editor-form.scss`; `src/app/services/inventory/coin-editor.ts:75–79, :174–176` (arrays are compared by value and always sent whole when changed); `src/app/services/csv/mappable-fields.ts:63–64` (one field `{ key: 'catalogRefs', label: 'Catalog References' }`), `src/app/services/csv/header-synonyms.ts:184–190` (synonyms → `catalogRefs`), `src/app/services/csv.service.ts:268–282` (export value `formatCatalogRefs`), the CSV import mapping step (where a mapped cell is written onto the record — locate via `CSV_MAPPABLE_FIELDS` usages) to call `parseCatalogRefs(cell, inv.catalogs())`.
- Test: `src/app/components/coin-editor-form/` spec (existing or new `catalog-refs-editor.spec.ts`), `src/app/services/csv-catalog-columns.spec.ts`, `src/app/services/csv/header-synonyms.spec.ts`, `src/app/components/csv-import-modal/csv-import-modal.spec.ts`, `field-widths.spec.ts`.

**Interfaces:**
- Consumes: Task 1 (`normalizeCatalogRefs`, `parseCatalogRefs`, `formatCatalogRefs`), Task 5 type.
- Produces (editor component): `addCatalogRef(): void`, `removeCatalogRef(index: number): void`, `updateCatalogRef(index: number, patch: Partial<CatalogRef>): void`; each calls `updateSelectedCoin('catalogRefs', next)`.

- [ ] **Step 1: Failing tests:** editor — add two refs, edit, remove one → saved coin has the remaining one; removing the last → PUT body carries `catalogRefs: []` (this is bug 1's regression test); number input `maxlength` = `CATALOG_NUMBER_MAX_LENGTH`; picker shows active catalogues only. CSV — export of a 3-ref coin has a `Catalog References` column `'RIC 123; Sear 6819; Cohen 45'`; importing that file reproduces the list; header `Catalog No.` (an existing synonym) maps to `catalogRefs`; Review Focus 4 cell → two refs.
- [ ] **Step 2:** run the listed specs → FAIL.
- [ ] **Step 3:** Implement. Editor layout: a "Catalogue references" block on its own row below the certification row; each ref row = select + number input + remove (×) button; an "Add reference" button below. Short labels, existing field classes.
- [ ] **Step 4:** front end full suite + `npm run build` PASS. Checkpoint.

### Task 7: Delete the SQL Server tooling (owner decision D11, 2026-11-18)

The one-time SQL Server migration is abandoned, so the tool is removed rather than updated.

**Files:**
- Delete: `server/migrate-sqlserver/`, `server/migrations/`, `server/setup-database.sql`, `server/db/driver-isolation.spec.ts` (it enforces keeping the drivers), any `migrate:from-sqlserver` script in `server/package.json` and the root `package.json`.
- Modify: `server/package.json` (remove `mssql`, `msnodesqlv8`, and their `@types`), root `package.json` (remove `msnodesqlv8`), any spec that reads `setup-database.sql` or the migration files for parity (find with a search for `setup-database` and `migrations/` under `server/` and `src/`) — repoint to `server/db/schema.sql` or delete the check if it only existed for SQL Server.
- Also: README / docs references to running the SQL Server migration.

- [ ] **Step 1:** Search for every import of or reference to the deleted paths; list them.
- [ ] **Step 2:** Delete and update as above; reinstall server packages (`cd server; npm install`) so the lock file drops the drivers.
- [ ] **Step 3:** `cd server; npx vitest run` and the server type check PASS; `npx vitest run --root src` PASS. Checkpoint.

### Task 8: Run it

- [ ] Start with a throwaway DB: `$env:COIN_INVENTORY_DB_PATH = "<scratchpad>\catalog-test.db"; npm start`.
- [ ] In the browser at `http://localhost:4200`: add a coin with RIC 123, Sear 6819, Cohen 45 → grid shows `Sear 6819 (+2)` (turn the column on); reload → unchanged; search `45` finds it; remove Sear → grid shows `RIC 123 (+1)`; remove all → `—`, and after reload still `—`.
- [ ] Remove the Cohen catalogue in maintenance while a coin uses it → coin still reads `Cohen 45`; picker no longer lists Cohen.
- [ ] Export CSV → re-import into a fresh DB → same references.
- [ ] Final: `npx vitest run --root src`, `cd server; npx vitest run`, `npm run build` all green; grep shows no `catalogNumber`/`catalogId` on coins anywhere.
