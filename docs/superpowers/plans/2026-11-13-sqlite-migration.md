# SQLite migration — execution plan

Implements §4.1, §4.3, §4.9, §4.9a and §4.10b of
`../specs/2026-10-31-desktop-packaging-design.md`. Read that first; this file
says only how the work is broken up and in what order.

## Driver decision — resolved

§4.3 left the driver open pending verification. **Resolved: `node:sqlite`.**

Verified present in Node v24.19.0 (`DatabaseSync`, `StatementSync`, `Session`,
`backup`). It is core, so there is no native module, nothing for
`electron-rebuild` to do, and no toolchain needed for `npm install` — which
matters on a machine where native builds are blocked by group policy.

The spec's caveat still stands: Electron bundles its own Node and may not
expose it. Electron is not yet chosen (sequencing step 6), so rather than
guess, the driver sits behind **one adapter file**. If Electron's Node turns
out to lack `node:sqlite`, swapping to `better-sqlite3` is that one file, not
the data layer.

## Why this is cheaper than it looks

The data layer is already a boundary: routes never import `mssql`, they go
through `server/db/` (`withDb`, `DB_BINDINGS`, `COIN_FIELDS`, `row-mappers`).
Measured dialect surface across all non-spec server code:

| T-SQL construct | occurrences |
|---|---|
| `OUTPUT INSERTED` | 6 |
| `SELECT TOP` | 4 |
| `MERGE` | 1 |
| `ISNULL` | 1 |
| `GETDATE()`, `SCOPE_IDENTITY`, `OFFSET…FETCH` | 0 |

81 `.input(...)` parameter bindings, 20 route files touching the database.
That is the whole job on the query side.

## The test-fidelity win

25 specs currently run against `server/test-support/mssql-mock.ts`, a 164-line
hand-written fake. SQLite can run **in memory**, so those specs can execute
against a real database with the real schema instead of a mock that only
behaves as its author imagined. This is a substantial improvement in what the
suite actually proves, and it is a side effect of the move rather than extra
work.

## Stages

Each stage ends green on all four gates. No stage is allowed to leave the tree
in a state where the suite cannot run.

### Stage 1 — the cutover (atomic)
Data layer, schema and tests move together. Splitting them would create an
intermediate state that cannot pass gates, which is worse than one large step.

- `server/db/driver.ts` — the only file that names the SQLite package
- `server/db/` reimplemented, **public API preserved** so routes barely change
- `server/db/schema.sql` — the 12 tables at their current post-migration shape,
  collapsed; migrations 002–014 are history, not a sequence to replay
- Reference data **re-seeded** from `seed-data/issuers-denominations.json`
  (§4.10b: seeded rows are not migrated, they are regenerated)
- Database at `%LOCALAPPDATA%\CoinInventory\`, overridable for tests
- Dialect fixes at the sites listed above
- `mssql-mock` replaced by real in-memory SQLite

### Stage 2 — the one-time migration — BUILT, not yet run against live data
A standalone script the owner runs once and then discards. Reads the live SQL
Server, writes the SQLite file. It lives in `server/migrate-sqlserver/`,
nothing in the application imports it, and `tsconfig.build.json` excludes it
so it cannot reach `dist/`.

Verification is **not** a row count and a spot check. §4.1 is explicit: compare
`Weight`, `PmWeightGrams`, `PmPercent` and the three price columns value by
value, because SQLite has no decimal type and precision is the thing most
likely to drift silently. A wrong weight looks exactly like a right one.

`mssql` and `msnodesqlv8` stay installed until this has been run successfully,
and `setup-database.sql` stays in the tree, marked legacy. They are deleted
after the owner confirms the migration, not before.

#### THE COMMAND

Connection details come from `server/.env` (`DB_SERVER`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD` — the block that is still there and that the
application itself no longer reads). Any of them can be overridden on the
command line.

```
cd server
npm run migrate:from-sqlserver -- --dry-run      # look first; writes nothing
npm run migrate:from-sqlserver                   # then do it
npm run migrate:from-sqlserver -- --help         # every flag
```

**Run `--dry-run` first.** It opens the SQL Server read-only, checks that every
column the SQLite schema has a place for exists, checks the DECIMAL precision
of the weight columns, looks for migration 008's marker, and stops. Nothing is
written on either side.

Useful flags:

| flag | what it does |
|---|---|
| `--dry-run` | check everything, write nothing |
| `--target <path>` | write somewhere other than the real database — a rehearsal |
| `--force` | the target already holds rows: **delete them** and migrate. Never merges |
| `--weights-are-grams` | proceed although AppSettings has no `migration-008-weight-grams` row |
| `--allow-extra-source-columns` | the source has columns SQLite cannot hold: abandon them deliberately |

Rehearse against a scratch file first if you want to see the whole thing run
without touching `%LOCALAPPDATA%`:

```
cd server
npm run migrate:from-sqlserver -- --target C:\temp\rehearsal.db
```

#### WHAT THE SHAPE OF IT GUARANTEES

- **The source is never written to.** Every statement is built by one function
  from a validated table and column list and then passed through
  `assertReadOnlySql()`, which refuses anything that is not a bare SELECT. The
  login is still `db_owner`, so for a guarantee from the *server* rather than
  from the program, run `ALTER DATABASE CoinInventory SET READ_ONLY` first.
- **Verify before commit.** The clear, the reference reconciliation, the copy
  and the value-by-value verification all happen inside ONE SQLite
  transaction, and the COMMIT only happens if the verification passed. A run
  that finds a single differing weight leaves the SQLite file exactly as it
  was. (Cost: the `-wal` grows to roughly the size of the data before the
  commit checkpoints it. That is deliberate — see `migrate.ts`'s header.)
- **Peak memory is one photograph.** Rows stream one at a time; the ~2,140
  base64 images are never an array.
- **Seeded reference rows are reconciled, not copied**, against
  `seed-data/issuers-denominations.json` and the lists in `db/seed.ts`, by
  identity (issuer Name; denomination (issuer Name, Label); the rest by their
  one text column). Reference row counts are therefore EXPECTED to differ
  between the two databases; what is checked is that nothing of the owner's
  is missing.
- **`DenominationId` and `CatalogId` are re-resolved, not carried.** A source
  id with no identity match is a hard refusal, never a NULL and never the
  source integer.

#### WHAT IT CANNOT PROVE — migration 008

`008-weight-to-grams.sql` multiplies every `Coins.Weight` by 31.1034768, and
§4.1 says no row count or spot check can detect whether it ran. That is still
true of the *data*. Two things the spec did not account for make it partly
checkable anyway, and the tool reports exactly what each is worth:

- **The marker.** 008 writes `AppSettings['migration-008-weight-grams']` in the
  same transaction as its UPDATE, so its presence is evidence the conversion
  committed. **Absent, the tool refuses to run** unless the owner types
  `--weights-are-grams`, and then records that it was his assertion.
- **The backup.** 008 also leaves `Coins_Weight_TroyOz_Backup`. If the owner
  has not dropped it, every weight can be checked arithmetically against
  `prior x 31.1034768`. A mismatch is expected for any coin edited since, so
  it is reported as something to look at, not as a failure.

Neither is proof that the column holds grams today. The summary says so.

### Stage 3 — images in the database
Only after Stage 2. §4.10b: doing §4.9a first would turn a 50 MB migration into
a 5 GB one.

- §4.9 — `ImageData` base64 TEXT → BLOB (drops ~25% of the file size)
- §4.9a — Settings option to embed full-resolution originals, with the four
  properties the spec requires of the backfill: progress, cancellation,
  resumability, and a report of originals it could not find. Originals must
  **stream**; a 46 MB row must never be read whole and base64-encoded.
- Re-saving an image back out to a file, which §4.9a notes is worth having
  regardless of storage mode.

## Not in scope here

Backup/restore (§4.7), the Electron shell (§4.2), the installer, and the
photo-relocation repair tool (§4.4). They follow in the spec's own sequence.

---

## Queued: support-reporter fixes (after Stage 1)

Found when the owner tried to attach a photo to a problem report and it did
not arrive. None of these are SQLite work; they are queued behind Stage 1
only because that agent owns the whole tree.

1. **Per-file attachment limit → 5 MB.** Owner's decision. It is currently
   10 MB in `support-modal.ts` (`ATTACHMENT_LIMITS.maxFileBytes`), and the
   server enforces its own copy — both must move together or the client will
   accept a file the server then refuses.

   **Refuse outright above 5 MB. Do not substitute anything.** Offering the
   downscaled copy the database already holds was proposed and the owner
   declined it: the user can save a smaller version themselves. Do not add it
   back — quietly attaching a different file from the one someone picked is
   exactly the kind of helpfulness that makes a privacy-sensitive feature
   untrustworthy, and it was considered and rejected rather than overlooked.

   The refusal must be ACTIONABLE, since a full-resolution coin photo is
   routinely over 5 MB (the owner's largest original is 46 MB). Name the file,
   give its size and the limit, and say what to do about it — save a smaller
   copy and attach that. A bare "too large" leaves the user stuck.

2. **Put the zip's full path in the GitHub issue body.** The user is on the
   GitHub page when they need it, not on the dialog that currently shows it.

3. **Say on the done screen that nothing was uploaded** and the zip has to be
   attached by hand. The flow currently implies more automation than exists.

4. **Disambiguate the two "too large" messages.** The per-file attachment
   limit and the 8,000-character URL fallback produce similar-sounding
   complaints in the same flow and were read as the same thing.

5. **Surface a rejected attachment before submitting**, not only afterwards.

6. **Log the full bundle path**, not just the file name. The log currently
   records `Support bundle written: <name>` and cannot answer "where did it
   go" — which mattered, because the server runs on the host machine and the
   zip was not where anyone was looking.

---

## Queued: Issuer maintenance rework (after Stage 1)

Owner's feedback: the Issuer form makes the user classify something they
should not have to think about, and gives no sign of what happens to
denominations after an issuer is added.

### 1. Remove `kind` from the form; derive it

**`kind` drives no behaviour anywhere.** It is stored, validated, and rendered
as a tag. Nothing branches on it. Since issuers now sort A-Z, even the
sort-order bands it fed no longer affect display.

**The year span already carries it.** Measured against the real seed:

```
ancient    := validFrom < 500
historical := validTo is not null
modern     := otherwise
```

reproduces **61 of 62** seeded issuers. The single miss is `British Colonial`,
a catch-all with no dates at all — not a dated issuer, and the reason the rule
needs a defined answer when both years are blank.

So: drop the picker. Ask for name, optional ISO code, and the year span. Derive
`kind` on save. BC years already work — the seed holds `Roman Republic` at
`-300..-27` and 11 issuers have negative `validFrom` — so an ancient
city-state is just a name and a span, which is the owner's point: for Miletos
the classification was never a real question.

Keep the column (it is `NOT NULL`, and the tag is useful to read). Derive it,
do not ask for it. Do not silently rewrite the seeded value for
`British Colonial`.

### 2. Tell the user what will happen to denominations

Today `POST /issuers` inserts one row and stops — **there is no denomination
lookup of any kind.** Adding an issuer leaves it with nothing and says nothing.
An indicator alone would therefore advertise something that does not happen;
the behaviour has to exist first.

### 3. Build the lookup — seed expansion AND an online attempt

**Decided by the owner**, both together.

**a. Expand the bundled seed.** Research and add well-documented ancient
issuers — Greek city-states, Judaean, Persian, and similar — to
`seed-data/issuers-denominations.json`, the same reviewed, offline route by
which the British Mandate for Palestine was added. Verify against real
numismatic sources and cite them; do not invent denominations.

**b. Attempt an online lookup on the name the user typed.** If nothing comes
back the user retries — a typo is theirs to notice, and that is acceptable.

Design constraints, which are not optional:

- **A checkbox to refuse the lookup.** Owner's call. The lookup sends the
  issuer name the user typed to an outside service, which is the app's only
  unsolicited outbound request, so it must be declinable without hunting
  through Settings. Put it on the issuer form, label it so it is obvious the
  request leaves the machine (not merely "look up denominations"), default it
  ON because the owner asked for the feature, and **remember the last
  choice** — a user who turns it off once means it. Unchecked must skip the
  request entirely, not make it and discard the answer.
- **Propose, never auto-insert.** Results are shown for the user to confirm
  before anything is written. A wrong denomination list is worse than an empty
  one: denominations are reference data that coins link to by id.
- **Prefer a structured, openly-licensed source.** Wikidata (CC0, SPARQL) is
  the realistic candidate; scraping prose pages is fragile and
  licence-murky. Coverage of ancient denominations is patchy — expect misses
  and make a miss a normal outcome, not an error.
- **Degrade honestly.** No network, no results, or a failed query must land on
  the offline path below, not on an error dialog.
- **Always state the outcome.** After saving, say how many denominations were
  added and by what route, and drop the user into adding them manually with
  the issuer preselected. An issuer that silently has none is the current bug.

---

## SUPERSEDES the support-reporter items above: no automatic zip

Owner's decision. **The app must not create a zip.** Zipping a JPG gains
nothing — it is already compressed — and it actively hides the file: GitHub
renders a dragged-in image inline in the issue, where the same image inside a
zip is invisible until someone downloads and extracts it. If a reporter has a
lot to send, they can zip it themselves.

### What follows from this, and must not be half-done

**In-app attachment has no destination any more and is removed.** The app
cannot upload to GitHub — it holds no credentials and never will — so the only
place an attached file was ever going was into the zip. With no zip, staging
files in the dialog would collect them and then drop them. Remove the picker,
the staging list, the base64 upload to `/api/support/bundle`, the per-file and
total size caps, and `server/support/zip.ts`.

**This makes the 5 MB limit moot.** It was agreed earlier in this session and
is overtaken, not forgotten: there is no in-app attachment left to limit, and
GitHub enforces its own 25 MB. Do not reinstate a cap for a feature that no
longer exists.

**Keep the acknowledgement warning, re-aimed.** The reason it existed — a QIF
or spreadsheet can carry far more than coins, and the issue is public — is
unchanged by who does the attaching. It becomes guidance shown next to the
"drag your files into the issue" instruction rather than a gate on a picker.

### What the app does instead

1. Builds the report, redacted exactly as now. **Redaction is untouched**;
   every canary test still applies.
2. Writes it as a **plain `.md` file** to the Desktop — not an archive — so it
   can be dragged straight into the issue, or opened and read.
3. Opens the pre-filled issue, or falls back to the clipboard as now.
4. Says plainly: nothing was uploaded; drag the report file in, and drag in
   any screenshots or exports you want to include — images display inline.

Retain from the earlier list: the report file's full path goes **in the issue
body** (the user is on GitHub when they need it), the done screen states that
nothing was uploaded, and the log records the full path rather than the bare
file name.

### Submission mechanism — settled: no token, no OAuth

The owner was offered a local-token path (API-created issues for him, browser
for everyone else) and OAuth device flow, and chose neither. **The app keeps
opening a pre-filled GitHub issue and the user presses Submit there.** No
credential is held, shipped or requested.

Why this is the right shape and not just the easy one: a token in a
distributed installer is extractable and would grant write access to the
owner's repo to anyone who downloads the app; OAuth would require every
collector friend to hold a GitHub account.

**Attachments are a GitHub-side action, and the dialog must say so with a
CLICKABLE LINK**, not prose the user has to act on from memory:

- State plainly that files are attached on GitHub, by dragging them into the
  issue, and that images display inline there.
- Offer the repository/issue URL as a real clickable link in the dialog —
  both before submitting and on the done screen. The user should never have
  to retype or hunt for it.
- This is the whole reason the in-app picker was removed: the app cannot
  upload (no official GitHub attachment API exists — only undocumented routes
  that disagree about whether a token even works), so pointing at GitHub is
  not a consolation prize, it is the only route that actually works.
- The report `.md` on the Desktop is for dragging in when the body is too
  long for a URL. Give its full path next to the same link.

---

## Backup/restore: CUT. Reverses spec §4.7

**Owner's decision.** §4.7 put backup and restore in v1; it is now out. Users
look after their own copies, and it becomes a feature if someone asks for it.

This is reasonable under SQLite in a way it was not under SQL Server — the
collection is a single file, so backing up means copying one file rather than
running an export.

Two things that are NOT backup features and should still be done, because
without them "copy the file" is not actionable:

1. **Show the database file's full path in the UI** (Settings or About), with
   a way to open its folder. A user cannot copy a file whose location the app
   has never told them, and §4.10a deliberately puts it somewhere they would
   never think to look (`%LOCALAPPDATA%`), with no installer prompt.

2. **Say that the app must be closed first** — or that the `-wal` and `-shm`
   siblings must be copied too. SQLite in WAL mode keeps recent writes in the
   `-wal` file, so copying only `coin-inventory.db` from a running app yields
   a database missing its most recent changes, silently and with no error.
   This session already saw a stray `coin-inventory.db` with a 98 KB `-wal`
   beside it, which is exactly the shape of that trap.

Both belong wherever the install location is documented. Neither is a feature;
they are the difference between a usable instruction and a misleading one.

### Queued: a checkbox to include the log

**Owner's decision.** Removing the zip also removed the only *redacted* log
the user could share: the report body carries 150 lines, and the 2,000-line
`logs/recent.log` that used to sit in the archive is gone. That left the raw
`app.log` — full of the username, machine name and photo paths — as the only
thing available to drag into a public issue. A safety gap, not just a missing
feature.

The owner's framing is the better one: *"otherwise we're just assuming they
have a bug to report."* A feature request does not need a log.

**Build:** a checkbox on the describe step, "Include recent log".

- Ticked → write a SECOND plain file beside the report,
  `coin-inventory-log-<timestamp>.txt`, **redacted by the same `Redactor`
  instance as the report** so a path replaced in one reads identically in the
  other. Two draggable files, still no archive.
- Unticked → **no log content at all**, including the 150 lines currently
  embedded in the report body. "Include the log" has to mean all of it;
  leaving the body tail behind would make the unticked state a half-truth.
- Default **ticked**, because this dialog is reached from "Report a problem"
  and a log is the single most useful thing in a bug report — but it is one
  click to turn off, and the summary of what will be sent must change when it
  is, so the state is never ambiguous.
- Say the file is written and where, the same way the report file is.

---

## Queued: clicking a grid row opens the Details panel

**Owner's observation**, and it is correct: with the panel closed, clicking a
row calls `selectCoin()` and nothing visible happens beyond a highlight. There
is no reason for a user to click a row at all.

Today:
- row click -> `coinSelected` -> `selectCoin()`: highlight, close the gallery
- **Details** button -> `openCoinDetail()`: select AND toggle the panel

### Build
- **Row click opens the panel.** Selection and "show me this coin" stop being
  two different gestures.
- **Remove the Details button.** It becomes redundant, and the actions column
  gets its width back. `coin-detail-panel.html:24` already has a **Close**
  button, so there is still a way out.
- **Do NOT make re-clicking the same row close the panel.** The current button
  toggles, which is right for a button and wrong for a row: clicking the row
  you are already reading should not make the information vanish. Close is the
  way out; clicking another row moves the panel to it.

### Two things not to break
1. **Keyboard access.** A `<tr>` with a `(click)` handler is not reachable by
   keyboard, and the Details button is currently the only keyboard-operable
   way to open the panel. Removing it without making the row focusable and
   Enter/Space-activatable is a straight accessibility regression. Give the
   row `tabindex`, a `(keydown.enter)`/`(keydown.space)` handler and an
   appropriate role, or keep a focusable control in the row.
2. **The existing `$event.stopPropagation()` calls.** The checkbox cell, the
   checkbox itself and the Images button all stop propagation today. Once the
   row handler does something consequential, any control that must not open
   the panel needs the same treatment -- otherwise ticking a box for a bulk
   action also throws the sidebar open.

Note the Images button stays: it does something different, and for a coin with
no photos it reads "Add images".

---

## Queued: an in-progress coin is not an error

**Owner:** typing a Year into a new coin immediately produced a red error box
saying it could not be saved because there was not enough data.

First, check whether this still reproduces. `canCreateCoin`
(`services/inventory/coin-create-requirements.ts`) now refuses to POST until
2-of-3 AND a denomination are present, so the doomed request that produced
that toast should no longer be sent. The report may predate a rebuild.

**If it still fires, or wherever this shape remains, the presentation is
wrong and should change anyway:**

- A new row that is still being typed is an **expected state**, not a failure.
  It must never raise an error toast. `showError` is for something that went
  wrong; "you have not finished typing" did not go wrong.
- The row already carries an `Unsaved` chip with a `draftHint` tooltip
  (`inventory-table.html:98`). That is the right channel -- make it carry the
  whole message. A tooltip alone is too hidden for the primary signal, so the
  chip should read clearly at a glance and the detail panel should say what is
  still needed, calmly and in place.
- Reserve the red toast for a save that was **attempted and refused** -- a
  real backend failure, which is a genuinely different event.
- Say what to do, never just what is wrong: "Needs a Denomination before it
  can be saved" beats "not enough data".

## Queued: full keyboard operation of the grid

**Owner's request**, and it resolves the accessibility gap flagged in the
row-click item above -- build the two together, not separately.

- **Arrow Up/Down move between rows.** `preventDefault()`, or the page
  scrolls as well as the selection moving.
- **Space opens the Details panel** for the focused row. Also bind **Enter**:
  Enter is the conventional activation key and costs nothing to support.
  Space scrolls by default, so it too needs `preventDefault()`.
- **Roving tabindex** (one row tabbable at a time, arrows move focus within),
  which is the standard grid pattern -- not `tabindex` on all 105 rows, which
  would make Tab useless for leaving the table.
- **Do not hijack keys inside controls.** The row has a selection checkbox,
  where Space must keep toggling the checkbox, and the grid holds other
  interactive controls. Key handling must no-op when the event target is an
  input, button or select.
- Focus must be visible, and must follow the panel: opening Details for a row
  should not throw focus away from the grid.

### Add Coin must open the Details panel

**Owner's request**, and it belongs with the row-click work rather than after
it. `app.ts:283 addBlankCoin()` creates the draft row and closes the image
gallery; it never opens the panel. So "Add Coin" produces an empty row with no
visible place to type, and the user has to discover that a second click is
needed before they can enter anything.

Open the panel on the new row and put focus in its first field. Note this is
the same gesture as the row-click change -- a new coin is just a row you
immediately want to look at -- so one code path should serve both.

Confirmed by the owner: the red "not enough data" toast no longer reproduces
after a rebuild, so `canCreateCoin` already fixed it. The presentation work
above stands on its own merits; there is no live bug to chase.

---

## Cross-platform: decided to keep the door open, not to walk through it yet

**Owner:** *"I'd hate to have this as a PC only type of app"*, and he has no
Mac, so a Mac build will mean enlisting a friend.

The application is already portable — Angular, Express and `node:sqlite` all
run unchanged on macOS and Linux, and `node:sqlite` being core Node means
there is no per-platform native build. What is Windows-specific is packaging,
plus two concrete pieces of debt below.

### Do these while building the Electron shell. They are free now and awkward later.

1. **Use `app.getPath('userData')`, never `process.env['LOCALAPPDATA']`.**
   The only coupling in the server is one read in `server/db/config.ts`, plus
   the Desktop resolution in the support reporter and the log directory.
   Electron resolves all three correctly per platform. Retrofitting this after
   release means real users have data at a Windows-shaped path.

2. **Fix `src/app/services/image-import/source-path.ts:69`,
   `const SEPARATOR = '\'`.** This is app logic, not packaging: a hardcoded
   Windows separator in the image-import path builder. On a Mac every imported
   photo path would be malformed, and it would not be obvious until someone
   tried. Note `image-file-filter.ts` already splits on `/[\/]/` and gets this
   right — follow that.

3. Keep a `mac` target in the electron-builder config even though it cannot be
   run here. An unused, reviewed target is a one-command favour to ask of a
   friend; an absent one is a config exercise they have to work out.

### What a friend with a Mac actually has to do

Build and test — no Apple account required for that. They will hit Gatekeeper
("cannot be opened because the developer cannot be verified", with no visible
override; right-click → Open is the way past it).

**That may be perfectly acceptable.** §4.11 already accepts the equivalent
SmartScreen warning on Windows for the same reason: these are friends who
trust the author. Apple's Developer Program ($99/year) buys notarization and a
clean first run, and is only worth it for strangers. Do not treat it as a
prerequisite for letting one friend try it on a Mac.

### What NOT to do
Do not let any of this delay the Windows release. Windows is where every
known user is today.
