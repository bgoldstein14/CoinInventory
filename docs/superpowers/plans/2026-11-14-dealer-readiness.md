# 2026-11-14 — dealer-readiness batch

A single list of work the owner asked for after reviewing the app. Several
items are schema-level, so the order below is not arbitrary.

**The owner has accepted a database reset.** The Transactions change alters
the schema and there is no migration runner; he will delete his database and
redo his imports. **Do not build a one-time migration for this.**

## Wave 1

### 1. Transactions rework — schema
Drop the `Transactions` table. Its fields move onto `Coins`.

Already on `Coins` and REUSED, not duplicated: `PurchaseDate`,
`PurchasePrice` (shown as **Cost**), `SoldPrice`, `SoldDate`.
**New columns:** `PurchasedFrom`, `SoldTo`, and a transaction-specific notes
column — kept separate from `Coins.Notes`, which stays the coin's own notes.

32 files currently reference the Transactions table; all of it goes.

### 2. Details panel
Remove **Price**, **Purchase Date** and the **Original Images** section.
Price and Purchase Date reappear inside the optional Transactions section,
which moves to sit **above** the Details Notes section. Two notes fields are
now adjacent — they must not read as duplicates of each other.
`Value` and `Melt` stay where they are.

### 3. Imports
- **Stop rejecting fakes / counterfeits / "not genuine".** That wording
  belongs in the **Variety** field when it arrives from an import.
- **Checkbox: import only coins not marked Sold.** Default OFF — everything
  comes in, so historical transactions on coins the user no longer owns are
  reportable. This REVERSES today's behaviour.
- **QIF Notes must be the Quicken Note/Memo column and nothing else.** Blank
  when that column is empty. No synthesised text.
- **Remove JSON from the import menu.**
- **Split "Excel or CSV" into two separate menu entries.**

### 4. Filters and columns
- Status becomes **multi-select, all selected by default**. The "all statuses"
  option is removed — it no longer means anything.
- **Drop `Source` from the column chooser.** It stays in the database and is
  reportable from there.

### 5. Denominations and Reference Data
- **Collapse / expand all** on the Denominations pane.
- After adding an issuer the screen currently shows ONLY that issuer with no
  way back to the others. Keep the focus — land on the new issuer, expanded,
  everything else collapsed — but the rest must remain reachable.
- **Alphabetise the Reference Data menu.**

## Wave 2

### 6. Grid grouping — the headline feature
Group the main grid by any column **except boolean and numeric ones**
(Country is the expected favourite). Nothing selected = today's flat grid.
One button expands/collapses all groups; **after choosing a grouping, all
groups start collapsed.**

### 7. Remember the user's choices
Persist UI state across sessions — grouping, expansion, columns, sort,
filters. **Except the details panel**, which opens closed as it does today.
`StorageKeys` in `services/storage.service.ts` is the existing mechanism.

### 8. Images: two storage modes
Let the user choose **referenced paths** (as now) **or stored in the
database**. In Settings add a **maximum image size**, defaulting to the
current behaviour, capped at 10 MB.

### 9. Settings tidy
- Remove the Reference Data notice/button added on 2026-11-13 — redundant,
  there is already an obvious button on screen.
- Put "Show transactions…" and its checkbox on one line.

### 10. Help
- Replace the `? Help` text with a standard help icon.
- At the foot of the Help screen: **Author: Bruce Goldstein**,
  **ANA #: 3124621**.
- Below that, in small type and deliberately understated: the app is free for
  everyone; if someone wants to send a little something, Venmo/PayPal
  **@bgoldstein14**. Humble, not a pitch, and never a blocking prompt.

## Afterwards, NOT in the repo
Written instructions for protecting `main`: no direct commits, changes land
by PR, and only the owner may merge. Deliver as a file outside the repo.

---

## Import refinements — owner's answers, 2026-11-14

1. **Extra information in the imported coin description goes to Variety OR
   Notes, and the USER CHOOSES WHICH.** A top-level choice offered before or
   after the import, not a per-row decision. Today it always lands in
   Variety (the FAKE wording work). Make the destination the user's call and
   remember it.

2. **Do NOT write Quicken's transfer boilerplate into Notes.** Measured: 66
   of 457 imported records carry a note and every one is auto-generated
   `Xfr From: …` / `Xfr To: …` text the owner never typed. *"It's not really
   helpful."* Strip that pattern. A real memo is used verbatim; **anything
   else leaves Notes blank.** Strip only the boilerplate shape — do not
   invent a broader filter that could eat a genuine memo.

3. **The "only unsold" option applies to EVERY import**, not just QIF, and
   **"sold" means the record has a Sold Date.** That replaces Quicken's
   net-quantity notion as the definition the user sees, and it is a
   source-agnostic rule a CSV or Excel sheet can satisfy by mapping a Sold
   Date column. QIF import must therefore POPULATE `SoldDate` for coins it
   detects as sold — wave 1 deliberately left that to the transactions work,
   and it is now needed.

4. **Confirmed: no status boxes ticked shows nothing; default is all ticked.**
   Already built that way; no change.

### CORRECTION, same day: no Variety/Notes choice

Item 1 above is **withdrawn by the owner**: *"The extra information probably
should just go in the Variety field....forget about what I said for the
choice. That's too confusing."*

Extra descriptive information from an import goes to **Variety**, always. No
choice, no setting, no remembered preference. This is what the code already
did, so the correct action was to build nothing.

Recorded as a decision rather than deleted, so nobody reinstates it from the
paragraph above. Items 2 and 3 of that section stand unchanged.

### REFINEMENT: "sold" means Sold Price AND/OR Sold Date

Owner: *"The sold coins should key off of either sold price and/or date.
It's possible that the user might recall one or the other."*

A record is sold if it carries **either** a Sold Date **or** a Sold Price.
Keying on the date alone would silently treat a row as still owned when
someone entering a sheet from memory recorded only the price.

**Test for presence, not truthiness.** A Sold Price of `0` is a real value —
a coin given away, written off, or traded at no cash value — and `if (price)`
classifies it as never sold. Null/blank checks only, with an explicit test on
the zero case.

For QIF, net quantity may remain the honest DETECTION mechanism; a detected
sale must then populate Sold Date and/or Sold Price so the record satisfies
the same rule as a CSV or Excel row. One user-facing sentence, true of all
three paths.

Extended again the same day: **Sold To counts too.** The predicate is
**Sold Date OR Sold Price OR Sold To** — someone may remember only the buyer.

The three fields do not agree on what "present" means, and both directions
are worth a test:
- `SoldPrice` is numeric — **`0` is present** and means sold.
- `SoldTo` / `SoldDate` are text — **whitespace-only is absent**; trim first,
  or a stray space in a spreadsheet cell silently hides a coin from the
  default import.

User-facing wording names all three ("has a sold date, price or buyer"),
one sentence, true of QIF, CSV and Excel alike.

---

## Round 3 — owner feedback after trying wave 2

### 11. Issuer maintenance is broken, and the root cause is NOT the delete

Three separate faults, in the order they matter:

**a. There is no way to RENAME an issuer.** The owner typed a name in lower
case and had no way to correct it, which is why he reached for delete at all.
`PUT /issuers/:id` already exists on the server (`issuers.ts:331`) and the UI
never calls it — the issuer row offers only **Remove**. Add editing. This is
the actual fix for his problem; the rest is damage from working around it.

**b. The denomination count goes stale, so Remove refuses forever.**
`removeIssuer` refuses CLIENT-side via `describeIssuerRemoval(name,
issuer.denominationCount)` and never reaches the server.
`denominationCount` is set when issuers load and incremented when the lookup
adds rows (`category-modal.ts:558`), but `removeDenomination` decrements
nothing and reloads nothing. So after removing the denominations the cached
count still refuses. **"I tried removing the denominations first, but that
didn't work"** is this bug, exactly.

**c. Removing an issuer should CASCADE, after a warning.** Owner's
instruction. Today both the client and the server (409,
`issuers.ts:430`) refuse while any active denomination remains. Replace the
refusal with a confirmation that states what will go — name the issuer and
the number of denominations — and then remove both.
Coins keep their recorded denomination text; only the link is nulled, which
is what `DELETE /denominations/:id` already does (`Coins SET DenominationId
= NULL`). Say that in the warning: the user needs to know coins are not
being deleted.

### 12. Help screen
- **Wording.** *"if not, enjoy it anyway"* reads snide. Owner suggests
  *"regardless...enjoy!"* or similar. Keep it warm and brief; free still
  comes first.
- **The icon must be bigger and carry colour** — a standard, recognisable
  help look, not a thin mono glyph.
- **Report a problem must NOT be at the top.** Guide information first, then
  a visual separator (a rule or dashes), then the report section below it
  with space above.

### 13. Grid groupings must be re-orderable
The owner wants to drag a group to the top, or anywhere. Today groups are
ordered by heading. Keep that as the default, let a drag override it, and
persist the custom order with the rest of the UI state. Decide what happens
to a dragged order when the grouping column changes, and what a keyboard
user does instead of dragging.

### 14. Settings: the checkbox belongs AFTER the label, on the same line
It was put on one line in wave 2 but still reads awkwardly and wastes space.
Label first, control after it, one row.

### 11d. Coins using a removed denomination fall back to OTHER, after a strong warning

Owner's addition: *"If removing an Issuer and denominations, give strong
warning if there are coins with any of those denominations. If the user still
continues, then automatically reassociate the affected coins to OTHER for
denomination."*

- The confirmation must **count the affected coins** and say the number. A
  warning that cannot say "and 23 of your coins use them" is not a strong
  warning, it is a scary one.
- Two different magnitudes deserve two different warnings: removing an
  issuer whose denominations no coin uses is housekeeping; removing one that
  43 coins depend on is not. Escalate the wording accordingly.
- **"OTHER" means the EXISTING null-link behaviour, not a literal string.**
  `DELETE /denominations/:id` already does `Coins SET DenominationId = NULL`
  and leaves the recorded text alone, which `denomination-display.ts` renders
  as `Other (8 Reales)`. That is the whole mechanism — the coin keeps what it
  always said and simply stops pointing at a row that no longer exists.
  **Do NOT write `__OTHER__`, `OTHER` or any sentinel into `Coins.Denomination`.**
  A literal `__OTHER__` reaching that column is a real bug this project has
  already had once; `denomination-display.ts` still carries a guard listing it
  as non-denomination text.
- Say in the warning that **no coin is deleted** and that each keeps its
  recorded denomination text. The user is being asked to accept a re-link,
  not data loss, and the sentence should make that obvious.

---

## 15. Every import path should be able to fill the transaction fields

Owner: *"Make sure all import types will be able to fill in the transaction
fields. Generally the QIF file might not have that information because of the
way transactions are entered. If the buyer/seller information is just basic
account name information, then just leave blank since that will be less than
useless and force the user to remove that information. Probably CSV and Excel
files will have this information more explicitly, if at all."*

**Measured gap.** `Coins` carries `purchaseDate`, `purchasePrice`,
`purchasedFrom`, `soldDate`, `soldPrice`, `soldTo`, `transactionNotes`.
CSV/Excel can map only five of the seven — **`purchasedFrom` and
`transactionNotes` are not in `mappable-fields.ts` at all.** QIF fills
`soldDate`/`soldPrice` and writes neither buyer nor seller (verified: no
reference to `purchasedFrom`, `soldTo` or a payee in
`quicken-import.service.ts`).

### CSV / Excel
Add the two missing fields to the mapping, with sensible header synonyms,
and make sure they round-trip through export the way `soldTo` already does.
This is where the information realistically exists.

### QIF — the rule that matters
**Do not fill a buyer or seller from a Quicken account or payee name.** In an
investment account the payee is routinely the account itself ("Misc. Coins",
"Odd Type Set"), which is not who anyone bought from. Writing it into
"Purchased From" produces a field the user must then go and clear on every
coin — *"less than useless"*.

Leave it **blank** unless the file genuinely names a counterparty. The same
judgement as the `Xfr From:` boilerplate decision, applied to a different
field: a plausible-looking wrong value is worse than an empty one, because
an empty field is obviously empty and a wrong one has to be noticed first.

If a QIF genuinely does carry a dealer somewhere, say where and how you
tell it apart from an account name — and if that cannot be done reliably,
fill nothing and say so. Measure against the real corpus either way.

---

## 16. Backup / restore — REINSTATED, and reframed as portability

The owner cut §4.7 earlier ("let the user deal with that") and has now
reversed it: *"let's revisit your idea to allow the user to backup the
database. I think that's a good idea and allows the database to essentially
be portable...another feature essentially."*

**Portability is a stronger requirement than backup** and changes the design.
A backup is restored onto the same machine by the same build. A portable file
is opened on another machine, possibly by another build, possibly next year.

### Do this first, whatever else is scoped

**Stamp `PRAGMA user_version`.** It is currently never set, so a file that
leaves this machine carries no record of which schema it is, and a restore
has no way to refuse one it cannot understand. Every backup taken before this
exists is permanently unidentifiable. `db/schema.ts` already names
`user_version` as the right mechanism for the migrations that do not exist
yet; setting it now costs nothing and is the only part that cannot be added
retrospectively.

### Backup
Use **`node:sqlite`'s `backup` API**, not a file copy and not
`VACUUM INTO`. It is an online backup, so it is consistent while the app is
running — which removes the `-wal` trap the earlier plan had to warn about.
The user picks where it goes.

### Restore — the dangerous half
- **Validate before replacing anything.** Is it SQLite, is it this
  application's schema, what `user_version` does it carry. A restore that
  half-works is worse than one that refuses.
- **Refuse a newer schema outright.** There is no migration runner, so a file
  from a later build cannot be read down.
- **Keep the current database.** Move it aside, do not overwrite it. The
  single most likely mistake is restoring the wrong file over a good
  collection.
- Say what is in the file before committing: coin count, date taken.

### Two consequences of portability to handle, not discover
1. **Referenced image paths break on another machine.** In referenced mode
   `SourcePath` points at a folder that may not exist on the new PC. Say so
   at restore. The photo-relocation tool (§4.4, unbuilt) is the companion
   feature and this strengthens the case for it.
2. **A database with embedded originals is multi-gigabyte** (§4.9a). Backup
   cannot be a frozen window with no progress and no cancel.

---

## 17. Dependency currency — one major at a time

Owner, 2026-11-14: *"before we go live, I want to ensure we have the latest
packages. Whenever we do changes, it might be a good idea to do a check
especially for bigger version jumps."* And on how: *"Go safe...I know that
these package upgrades can be very tricky."*

**One major per step, four gates after each, stop at the first red.** A batch
of four majors that turns 200 tests red teaches nothing about which one did
it, and with Express 5 in the mix "revert and bisect" means redoing all of it.

### Order
0. **Same-major tier first** (`npm update`): Angular 22.1.x→22.2.x, prettier,
   tslib, fake-indexeddb, read-excel-file, vitest 4.1.11→4.1.12, express
   4.22.2→4.22.3, supertest, tsx, @types/node 22.20.x. Establishes a green
   baseline on current minors before any major moves.
1. **Remove `jsdom`.** Not an upgrade — a deletion. Nothing imports it; every
   occurrence is a comment saying the tests run WITHOUT it.
2. **TypeScript 6.0.3 → 7.0.2.** Two moves, not one: **the server is on
   5.7.3**, so the halves already disagree. Align them.
3. **Vitest 4.1 → 5.1.** 5,320 tests plus a custom setup ride on it — the
   global `COIN_INVENTORY_DB_PATH` pin, its `afterEach` guard, and
   `fake-indexeddb`.
4. **Express 4.22 → 5.3.** Genuinely breaking; routing and middleware changed.
5. The small majors: dotenv 16→18, @types/node 22→26, concurrently 9→10,
   @types/supertest 6→7.

### Deliberately NOT upgraded
- **`mssql` 11→12 and `msnodesqlv8` 5→6.** Both are deleted once the owner
  confirms the SQL Server migration. Negative-value work.
- **Angular.** No major is pending (22.1→22.2 is routine), which is
  fortunate: `angular.json` still uses the deprecated
  `@angular-devkit/build-angular:browser` webpack builder and `package.json`
  overrides `"esbuild": "npm:esbuild-wasm@0.28.1"`, because `esbuild.exe` is
  blocked by group policy on this machine. An Angular major that drops the
  webpack builder forces `@angular/build:application` and walks straight back
  into that wall. Note `npm outdated` reports
  `@angular-devkit/build-angular` **Latest 21.2.30, BELOW the installed
  22.1.6** — the deprecated package's versioning has diverged, which is its
  own warning sign.

### Rule for next time
`npm outdated` on BOTH packages at every release. Same-major updates are
routine; every major is its own step with its own gate run.

### The three build-time overrides, and why each exists

```json
"esbuild":       "npm:esbuild-wasm@0.28.1",
"sass":          "1.101.0",
"sass-embedded": "npm:sass@1.101.0"
```

**All three are accommodations for ONE machine — the author's corporate
laptop, where group policy blocks the execution of native binaries. They are
not project constraints and the owner's host has no such restriction
("I'm wide open on my host").**

- `esbuild` → `esbuild-wasm`: pre-existing. `esbuild.exe` cannot run here,
  which is also why `angular.json` still uses the deprecated webpack builder
  rather than `@angular/build:application`.
- `sass` pinned to 1.101.0: **1.104.1 spawns a native process and fails with
  `spawn UNKNOWN`.** Found on 2026-11-14 when a routine `npm update` moved
  290 packages and broke the build. The culprit was not the scary major we
  were braced for — it was a transitive bump from a **patch** release.
- `sass-embedded` aliased to plain `sass`: `sass-loader` 17.0.1 declares
  `sass-embedded: "*"` as a peer dependency, so npm installs it and
  sass-loader then prefers it. The alias keeps the pure-JS path.

**Remove all three the day builds move off this laptop.** Verify on the host
rather than assuming; the esbuild one in particular also governs whether the
modern Angular builder becomes available.

**What this does NOT affect: anything a user installs.** These are
build-time only. The shipped artefact is compiled JS/CSS plus the Node
server, and `node:sqlite` is part of Node — verified 2026-11-14 that the
built output contains no `.node` or `.exe` at all. The only native code that
reaches a user is Electron's own prebuilt binaries.

### The bundle budget was never tuned — fixed 2026-11-14

`maximumWarning` was `500kB`, which is the Angular CLI's **scaffold
default**, not a number anyone chose for this app. The initial bundle has
been over it for weeks, so the warning fired on every single build.

That is worse than having no warning. It is the signal that would tell you
the bundle had grown, and it had become something to scroll past — the
owner reasonably queried it as if it were new.

Now **650kB warning / 1MB error**, against a current initial total of
**577.51 kB**. That gives about 72 kB of growth before the warning speaks
and 422 kB before the build fails, so the warning fires early enough to act
on and rarely enough to be believed.

For context on why under 500 kB was never realistic: the Angular framework
plus the always-visible shell is most of that figure. The `@defer` work on
2026-11-13 already took the initial bundle from **938.61 kB to 563.33 kB**
by moving 13 modals into lazy chunks; what is left is largely irreducible
without gutting the app.

**Host verification, same day:** the owner removed all three build-time
overrides on his host, ran `npm install` and a production build, and
everything installed, built and reverted cleanly. So the `esbuild`, `sass`
and `sass-embedded` pins are confirmed as accommodations for the author's
laptop alone, not project constraints. They are kept for now because they
are what lets the build gate run during development; the right moment to
remove them is the move to `@angular/build:application`, which needs host
verification anyway.
