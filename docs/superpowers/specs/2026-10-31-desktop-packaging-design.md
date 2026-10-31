# Coin Inventory — desktop packaging design

**Date:** 2026-10-31
**Status:** draft for owner approval
**Supersedes nothing.** Builds on `2026-08-28-coin-inventory-overhaul-design.md`.

---

## 1. Intent, and why now

Coin Inventory is today a two-process development setup: an Angular dev server and
an Express backend, started by a PowerShell script, talking to a SQL Server Express
instance the owner installed and configured by hand, viewed in a browser tab.

That is fine for its only user. It is impossible for anyone else.

The owner intends to publish the application for other collectors and dealers. That
changes the install story from *"I know how to set up SQL Server"* to *"double-click
setup.exe, pick a folder, use the program."* Everything in this document follows
from that single change.

### Who this is for

The owner's description, in his words:

> "The person who will use this might not be that tech savvy but they're a standard
> Windows user. They're either a coin collector (probably not using Quicken like me,
> but will need to figure out a way to get their collection into the CSV template you
> have) or a coin dealer with the same type of inventory situation as the collector.
> I think a lot of collectors and dealers use Excel to store their coin inventories...
> They're okay with installing applications on their own PC, but don't want to think
> about anything auxiliary to the application once it's installed."

Two things in that are load-bearing:

- **"don't want to think about anything auxiliary"** — no database to install, no
  services to start, no ports to configure, no browser to open, no command line. If
  the user has to know the application has a server in it, the packaging has failed.
- **"a lot of collectors and dealers use Excel"** — the realistic on-ramp is not the
  project's CSV template, it is whatever spreadsheet the user already keeps.

---

## 2. Goals, non-goals, anti-goals

### Goals

1. One `setup.exe`. The only question it asks is where to install.
2. The application runs in its own window. No browser, no tab, no localhost URL
   visible to the user.
3. Data lives in a file. No database server, no service, no separate installer.
4. A user whose inventory is in Excel can get it in, without reformatting their
   spreadsheet by hand first.
5. An in-app Support affordance that files an issue against the GitHub repository.
6. The repository can be public — see `docs/going-public-checklist.md`.

### Non-goals

- Multi-user or networked operation. One person, one machine, one data file.
- macOS or Linux. Windows only.
- Cloud sync, accounts, or any server the owner has to operate.
- Preserving SQL Server as an option (see §4.1 — it is being deleted, not retained).
- Auto-update in v1. Worth having eventually; it is not what makes the first release
  usable, and it adds signing and hosting concerns.

### Anti-goals — what would make this a failure even if it technically worked

- **A second thing to install.** If the installer chains a MySQL or SQL Server
  installer, or requires .NET, or prompts for a runtime, the central requirement is
  broken regardless of how well the app runs afterwards.
- **A visible server.** A console window, a firewall prompt on first run, a tray icon
  for a background process, or an error that mentions a port number.
- **Silent data loss on upgrade.** A user's collection surviving reinstall is
  non-negotiable; the data file must not live inside the install directory.
- **A support channel that drops messages.** An in-app Support button that silently
  fails is worse than no button, because the user believes they have been heard.

---

## 3. Constraints

| Constraint | Consequence |
|---|---|
| Existing backend is Express 4 + TypeScript on Node | The shell must be able to host a Node process, or the backend gets rewritten. See §4.2. |
| Existing frontend is Angular 22, built to static files | Any webview can serve it; this is not a constraint on the choice. |
| `esbuild.exe` is blocked by corporate group policy on the owner's machine | Already routed around: `angular.json` uses the **webpack** builder and `package.json` maps `esbuild` → `esbuild-wasm`. Production builds work. **Do not migrate to `@angular/build:application`** — it uses esbuild and would reintroduce the block. See §7. |
| Build/test happens on `C:\Users\...\source\dev`; the git repo is the `I:\` network share | Packaging scripts must not assume repo root == build root. |
| Owner's own collection is already in SQL Server | A one-time migration path is required for him specifically. See §4.1. |
| Node 22+ ships `node:sqlite` in core | Removes the usual native-module packaging problem — if the shell's Node is new enough. See §4.3. |

---

## 4. Decisions

### 4.1 Database: SQLite, and SQL Server is deleted

**Decided by the owner.** SQL Server support is removed outright rather than kept
alongside SQLite.

The original suggestion was MySQL, on the understanding that it "can be represented
as a file." That is not accurate — MySQL is a background service with its own
installer and Windows service registration, the same shape as SQL Server Express and
only smaller. SQLite is the engine that is genuinely a single file with nothing
running in the background. Once that was clear the owner chose SQLite, and chose to
migrate his own collection rather than keep a second data layer alive for himself:

> "Yeah, I guess it's better if I get off of SQL Server also."

This is the single most consequential decision in the document. Keeping both would
have meant every query and every migration written and tested twice, in two dialects,
forever.

**Where the file lives:** `%LOCALAPPDATA%\CoinInventory\` — *not* the install
directory, so uninstall/reinstall cannot destroy a collection, and so the app needs no
write access to Program Files.

**What makes this cheaper than it looks:** the data layer is already isolated. Routes
do not talk to `mssql` directly; they go through `server/db/` (`withDb`, `getPool`,
`COIN_FIELDS`, `DB_BINDINGS`, `row-mappers`). The boundary that has to be reimplemented
already exists and is already documented. The work is real but it is bounded, and
`server/db/index.ts`'s header explains the invariants the replacement must preserve.

**Migration for the owner:** a one-time export/import, run once, discarded after. It
does not need to be pretty and it does not ship in the installer.

**Confirmed with the owner: migrations 004 through 008 have all been run** against
his live database. That matters, and the question was worth asking, because of what
the alternative would have meant:

- `008-weight-to-grams.sql` multiplies every `Coins.Weight` by 31.1034768. Had it not
  run, the source weights would still be troy ounces while the UI labels them grams —
  and **a row-count-and-spot-check verification cannot detect that**, because both
  `0.7734` and `24.05582` are entirely plausible coin weights. The error would have
  migrated silently into SQLite and surfaced much later as wrong melt values.
- `004-widen-weight-precision.sql` is what makes the weight columns `DECIMAL(12,5)`.

Since all five have run, the source is already `DECIMAL(12,5)` in grams and the
migration is a straight copy. Verification is therefore: row counts per table, plus
an explicit **numeric precision check** on `Weight`, `PmWeightGrams`, `PmPercent` and
the three price columns — compare values before and after, do not eyeball them. SQLite
has no decimal type (see §6), so precision is the one thing most likely to drift.

### 4.2 Shell: Electron — *this is the author's call, not the owner's*

The owner asked for "its own web view application/container" and noted there are good
free ones. He did not pick one. **Recommendation: Electron, packaged with
electron-builder's NSIS target.**

| Option | Size | Fit |
|---|---|---|
| **Electron** | ~150–200 MB | The existing Express backend runs **unchanged** in the main process. electron-builder's NSIS target produces exactly the required installer — one exe, asks for a directory — with no bespoke work. |
| Tauri | ~10 MB | Rust shell over the system WebView2. Expects a Rust backend; the Node backend would ship as a sidecar binary with IPC plumbing. More work, more failure modes, for a size win that does not matter here. |
| Photino.NET | small | Requires a .NET runtime — violates the "nothing auxiliary" anti-goal unless self-contained, which erases the size advantage. |
| Node SEA + raw WebView2 | ~60 MB | Technically attractive (Node 24 supports single-executable apps, WebView2 ships with Windows 10/11). But every piece of window management, installer integration and lifecycle handling is hand-rolled. |

The deciding factor is not size, it is that **Electron is the only option where the
existing backend is not rewritten or re-plumbed.** 200 MB is unremarkable for a desktop
application, the owner's users have said they are happy to install software, and the
alternative spends the project's scarcest resource — a single developer's attention —
on shell engineering rather than on the coin application.

Revisit if install size turns out to matter to real users. It is a contained change
later; it is a large distraction now.

**How the pieces fit:** the Express server keeps running, bound to `127.0.0.1` on an
**ephemeral port** (`listen(0)`, then read the assigned port), inside Electron's main
process. The `BrowserWindow` loads that origin. Binding to loopback with a random port
avoids both the firewall prompt and the "port 3000 is already in use" class of
failure, which is precisely the kind of auxiliary thing the user must never see.

### 4.3 SQLite driver — builder's choice, with a caveat

`node:sqlite` (core since Node 22) avoids native modules entirely and would be ideal.
**But Electron bundles its own Node, and the bundled version may predate it or may not
expose the module.** The builder must verify this against the actual Electron version
chosen, early, because the fallback changes the build:

- If `node:sqlite` is available → use it. No native dependency, nothing to rebuild.
- If not → `better-sqlite3`, which is native and needs `electron-rebuild` wired into
  the build. Workable and extremely well-trodden, just more moving parts.

Resolve this before writing the data layer, not after. Note also that
**`msnodesqlv8` must be removed** from both `package.json` files — it is a native
module and it is the reason a plain `npm install` currently needs a toolchain.

### 4.4 Images: keep referencing originals

**Decided by the owner**, choosing against copying photos into an app-managed folder.
The database continues to store a path to wherever the user's photos already live.

The trade-off was put explicitly and accepted: referencing means that moving or
renaming a photo folder silently breaks the links — which is the exact failure the
owner hit during this session ("4 image paths are missing"). The benefit is no
duplication and no migration of his existing share.

**Therefore the design must compensate**, because the target user is less equipped to
diagnose this than the owner was:

- The missing-path log now names each unreadable file rather than counting them
  (`server/routes/images/exists.ts`, done).
- **A "my photos moved" repair tool is required.** Given an old root and a new root,
  re-point every affected path in bulk. Without it, a user who reorganises their
  pictures folder has no route back except editing coins one at a time.
- Missing images must degrade visibly but harmlessly in the UI — a placeholder that
  explains, never a broken icon and never an error dialog.

### 4.5 Excel import: auto-detect with manual override

**Decided by the owner.** The user drops in any `.xlsx`; the app reads the header row,
guesses which column maps to which field, shows its guesses, and lets the user correct
them before importing.

Guessing is worthwhile because the vocabulary is fairly standard across collectors
(`Year`, `Grade`, `Denomination`, `Mint`, `Cost`, `Value`), and a correct guess turns a
chore into a confirmation. The override exists because the guess will sometimes be
wrong and a wrong silent mapping is worse than no mapping.

Notes for the builder:
- This should converge with the existing CSV importer rather than duplicating it.
  Parse Excel → the same intermediate row shape the CSV path already produces → one
  validation and insertion path.
- Preview before commit. Show what will be created, with a count, and let the user back
  out. An import that cannot be previewed will be run twice by someone.
- Remember the mapping. A dealer importing monthly should not re-map every time.
- Dates and currency are where spreadsheet imports go wrong: Excel serial dates,
  text-formatted numbers, `$` and thousands separators, and empty-vs-zero. The existing
  `services/csv/numeric-cell.ts` already has opinions about some of this — reuse them.

### 4.6 Support: GitHub issues

An in-app Support control (icon plus tooltip) through which users submit ideas and
problems.

**The constraint the owner named:** the repository is private today and will become
public once `docs/going-public-checklist.md` is complete. The design should not block
on that.

**Recommended approach — deep link, do not embed a token.** The Support control opens
the user's browser at a pre-filled GitHub issue URL
(`https://github.com/<owner>/<repo>/issues/new?title=...&body=...`), with the body
pre-populated with app version, Windows version, and — *with the user's visible
consent* — recent log lines.

The alternative, posting to the GitHub API from inside the app, requires shipping a
credential in a public desktop application. Any token that can file an issue can be
extracted and abused; this is not a solvable problem, only a deferrable one. Deep
linking costs the user one browser click, requires no secret, and has the side benefit
that the user sees exactly what they are submitting before it is sent.

**Never attach logs silently.** Show the content, let them edit it, let them decline.
Log lines from this application can contain full paths to a user's photo library.

---

### 4.7 Backup and restore: in v1

**Decided by the owner.** A real Backup/Restore affordance ships in the first release.

The reasoning that settled it: **CSV export is not a backup here.** `hasCacSticker`,
`pmWeightGrams`, `pmPercent` and image data are not CSV-mappable, and
`export-import-round-trip.spec.ts` actively enforces that the exporter can only emit
importable columns. So without this feature a user's only recovery path is a file
they were told about in documentation and did not copy. For a non-technical user
whose collection *is* the value of the application, that is the worst available
outcome.

**The correctness detail that will bite whoever builds it:** SQLite in WAL mode keeps
state in `-wal` and `-shm` sidecar files. Copying only the main `.db` produces a
*torn* backup that may restore to a stale or inconsistent state. Use SQLite's own
backup API or `VACUUM INTO`, which produce a single consistent file — do not
hand-roll a file copy.

Restore must confirm destructively ("this will replace your current collection"), and
should refuse a file that is not a valid database of the expected schema version
rather than failing halfway.

### 4.8 Spot prices: user-supplied, with fetch optional

**Decided by the owner**, against keeping the current automatic source.

Today `server/routes/data/spot-price-source.ts` fetches from
`https://query1.finance.yahoo.com/v8/finance/chart` — undocumented, unauthenticated,
and the backend's only outbound call. One developer hitting that endpoint is a very
different proposition from an unknown number of installed copies: if Yahoo
rate-limits, blocks, or changes its response shape, **melt value degrades to
em-dashes for every user simultaneously**, and melt value is a headline feature.

The decision is to let the user enter spot prices themselves. This removes the
external dependency as a correctness concern, works offline, and is unremarkable for
the audience — a collector checking melt value already knows roughly what silver is
doing.

An automatic fetch may remain as a convenience, but it must be **optional and
clearly secondary**: never the only way to get a price, and its failure must never
present as the application being broken. Note that `computeMeltValue` already returns
`null` (rendering an em-dash, never `$0.00`) when a price is unavailable — that
honest-unknown behaviour is correct and must be preserved.

### 4.9 Downscaled image data: BLOB in SQLite — *author's call*

Not raised by the owner; flagged by review and decided here.

`CoinImages.ImageData` currently holds a **downscaled base64 copy of every photo** —
that is what the application actually displays, with `SourcePath` only pointing at
the original. At roughly 2,140 photos these blobs are the overwhelming majority of
the data by volume, so where they live materially changes the size of what §4.1 puts
in `%LOCALAPPDATA%`.

**Decision: keep them in the database, but store as BLOB rather than base64 TEXT.**

- Base64 carries ~33% overhead for no benefit once the data is not travelling in
  JSON. Converting during the migration is close to free and shrinks the file by
  about a quarter.
- Keeping them in the database means **one file to back up**, which matters now that
  §4.7 is in scope. Splitting thumbnails into a cache folder would make the backup
  story two things instead of one.
- They are *not* purely a cache. §4.4 keeps originals as references, so if a user
  moves or deletes an original, the downscaled copy is the only surviving image.
  Treating it as discardable would lose data.

Consequence the builder must handle: do **not** read image blobs on the coin-list
query. README already flags that `GET /api/coins` returning `imagePaths` by default
is a compatibility shim to be removed; the SQLite move is the natural moment.

### 4.10 Local API access control — *author's call*

`GET /api/images/file?path=<absolute path>` serves any file the path names, and
`server.ts` applies a blanket `app.use(cors())`. On the owner's own machine that was
explicitly accepted as a non-issue. In a shipped application it is an unauthenticated
arbitrary-file reader reachable by **any other local process**, and §4.2's
ephemeral-port choice does nothing about that — it addresses firewall prompts, not
access control.

**Decision: a per-launch bearer token**, generated at startup, handed to the renderer,
and required by every `/api` route. Plus an Origin check, and drop the blanket CORS.

This is cheap to build in from the start and genuinely awkward to retrofit once the
routes and `ApiService` have settled. The honest risk for a single-user desktop app is
low, but the cost of doing it now is close to zero, which settles it.

### 4.11 Code signing: not in v1

**Decided by the owner.** The installer ships unsigned for the first release and the
SmartScreen warning is accepted.

The README must tell users what they will see and what to click ("More info → Run
anyway"), in plain language and without apology. This is the single most likely point
at which a stranger abandons the install, so it is worth testing on a clean machine
(§7) and writing the guidance against what the warning *actually* says.

Revisit if the application finds an audience beyond people who already trust the
author. An OV certificate is roughly $200–400/year.

## 5. Sequencing

The dependencies are real; this order is not arbitrary.

1. **Replace the QIF test corpus.** *In progress.* Gates taking the repo public.
2. **Privacy sweep.** *In progress.* Gates taking the repo public.
3. **SQLite migration**, including the §4.9 base64→BLOB conversion. Do this *before*
   publishing — it deletes `create-sql-login.sql`, `setup-database.sql` and every
   `MYSERVER\SQLEXPRESS` reference, which would otherwise need sanitising by hand and
   then deleting anyway.
4. **Backup / restore** (§4.7). Immediately after the SQLite move, while the data
   layer is fresh in mind and before there is a second place to touch.
5. **Purge history, publish the repo.** Per the checklist.
6. **Electron shell**, including the §4.10 token. The app, running in its own window.
7. **Installer.** electron-builder → NSIS. Needs a clean VM to verify (§7).
8. **Excel import** (§4.5). Independent of 6–7; can proceed in parallel.
9. **Spot-price entry** (§4.8). Small, independent.
10. **Support control** (§4.6). Needs the repo public (step 5) to be useful.
11. **Photo-relocation repair tool** (§4.4). Independent; can proceed in parallel.

The build is **not** a sequencing item — it already works (§7).

---

## 6. Left to the builder

Deliberately unspecified, because a competent builder will decide these better in
contact with the code:

- The internal shape of the SQLite data layer behind `server/db/`'s existing exports.
  The *boundary* is fixed; what is behind it is not.
- Whether the Express layer survives at all inside Electron, or whether routes are
  eventually called directly over IPC. Keeping Express is the obvious first move
  (nothing changes); collapsing it later is an optimisation, not a requirement.
- Schema translation specifics: SQL Server `NVARCHAR`/`DECIMAL(12,5)`/`IDENTITY` →
  SQLite's type affinities. **`DECIMAL(12,5)` deserves care** — SQLite has no decimal
  type, and the melt-value and precious-metal-weight calculations are sensitive to
  precision. Decide explicitly between REAL and an integer-scaled representation, and
  write down why.
- The existing numbered migration system (`server/migrations/001..009`) — whether it
  carries over, is replaced, or is collapsed into a fresh baseline schema. Note that
  **collapsing is now the obvious choice**: all nine have been run against the only
  existing database (§4.1), so they have no remaining work to do and SQLite would need
  them rewritten anyway. A fresh baseline plus a schema-version row is cleaner than
  porting history nobody will ever replay.
- Installer niceties: Start Menu entry, desktop shortcut, uninstaller behaviour,
  whether uninstall offers to remove `%LOCALAPPDATA%\CoinInventory` (**it must not do
  so silently**).
- Excel parsing library, and how the §4.5 mapping UI is laid out.

---

## 7. The build — verified working, not a blocker

An earlier draft of this document led with the esbuild group-policy block as the
thing outranking everything else. **That was stale.** Verified on 2026-10-31 in
`C:\dev\coin-inventory`:

```
npx ng build --configuration production     →  exit 0

main.f392b30e23005424.js   | main    | 722.64 kB | 157.79 kB transfer
Initial total                        | 724.02 kB | 158.51 kB
Build at: 2026-10-31T18:09:49Z - Time: 16369ms
```

Hashed filenames, real production output. The only complaint is a soft bundle-budget
warning (500 kB) — the `maximumError` threshold is 1 MB, so it does not fail.

Two things to carry forward:

- **Do not accept the deprecation notice.** The webpack builder warns that Angular
  wants `@angular/build:application`. That builder uses `esbuild.exe`, which is the
  blocked binary. Taking the migration on this machine would break builds.
- The bundle budget warning is worth tidying eventually but blocks nothing.

### What IS still unprovided: a clean test machine

The document's acceptance criterion is "double-click setup.exe on a machine with no
Node, no SQL Server and no dev tooling." Nothing in the current setup provides such a
machine. A throwaway Windows VM is needed to verify the installer honestly — and, per
§4.11, to see how bad the unsigned-installer warning actually looks. Without one, the
installer can be built but not meaningfully tested.
