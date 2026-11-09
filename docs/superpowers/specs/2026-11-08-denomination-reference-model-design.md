# Denominations as reference data — design

**Date:** 2026-11-08
**Status:** draft for owner approval
**Amends:** the data model assumed by `2026-10-31-desktop-packaging-design.md`

---

## 1. Intent

A coin's denomination is currently free text in `Coins.Denomination`, and the
`Denominations` lookup is a flat list with a two-letter `Country` column that
agrees with nothing else in the schema.

The trigger was concrete: **`8 Reales` is Mexican, and the app files it under the
United States** — because the QIF parser leaves `Country` as `United States` and
there is no Mexican denomination to file it under in the first place. The same
flat model produced `3CS` vs `3¢ Silver` failing to match, `5s` vs `5/- (Crown)`
silently landing in the custom box, and `100 Soles` with nowhere to live.

Collectors and dealers hold coins from everywhere. The model has to know that a
denomination belongs to an issuing authority.

### What research established, because it bounds the work

There is **no redistributable machine-readable dataset** of denominations by
country. Verified 2026-11-08:

- **Nomisma.org** — collection and coin-*type* RDF, not denomination lists.
  Licences are mostly CC BY-NC-SA or ODbL; non-commercial terms are unusable in
  a published application.
- **Numista** — returns HTTP 403 to automated reads. Licence and API unassessed.
  Most likely full-coverage source; entirely unverified. **Do not assume it is
  available.**
- **WorldCoinDatabase** — a useful 302-entry country list including historical
  states, but no export, no API, no stated licence.

**Consequence: the seed is authored, not imported.** That is the single biggest
driver of the scope decision in §4.3.

---

## 2. Goals, non-goals, anti-goals

### Goals
1. A denomination belongs to an issuing authority, and the UI reflects that.
2. Coins reference a denomination by id, not by a string anyone can mistype.
3. Users can still add, edit and remove denominations and issuers.
4. Removing a denomination that is in use warns, and if confirmed leaves those
   coins reading "Other" — **without losing what they said**.
5. Historical and ancient issuers are first-class, not an afterthought.

### Non-goals
- A complete world catalogue. See §4.3.
- Coin *types* (Morgan, Walking Liberty). Those stay free text on the coin.
- Currency/monetary-system modelling (a Reale is worth ⅛ of what). Out of scope.
- Automatic re-classification of coins by an algorithm. The user decides.

### Anti-goals — failure even if it works
- **Any coin losing its denomination.** 105 live coins and years of imports.
  A migration that silently nulls an unrecognised value is a failure regardless
  of how clean the resulting schema is.
- **A dropdown nobody can use.** Several thousand entries in one list is worse
  than the flat list it replaced.
- **The image matcher getting worse.** It identifies coins partly by
  denomination; a regression there means photos attaching to the wrong coin,
  which is expensive to notice and painful to undo.
- **Seeded data that is confidently wrong.** A wrong denomination shipped by the
  app is worse than a missing one the user adds correctly — they have no reason
  to doubt it.

---

## 3. Constraints

| Constraint | Consequence |
|---|---|
| **26 non-spec files read `coin.denomination`**, plus many specs | This is not a schema change with a UI attached; it reaches the matcher, both importers, melt value, statistics, reports and filters. |
| No authoritative dataset exists | The seed is authored and must be reviewable. Accuracy beats coverage. |
| The owner has live data, imported over years | Migration is the riskiest deliverable here, not the schema. |
| `Denominations.Country` holds `US`/`GB`; `Coins.Country` holds `United States` | A documented, long-standing mismatch (see `country-denomination-link.ts`). The new Issuers table is where that gets resolved once. |
| Melt value reads `(denomination, country, year)` as strings | `pm-reference.ts` must keep working exactly. A silent change here mis-prices metal. |
| Tests run under Node, no jsdom | Resolution logic goes in pure modules, as everywhere else. |

---

## 4. Decisions

### 4.1 Coins carry BOTH an id and the original text — *owner's decision*

```
Coins.DenominationId   INT NULL  FK -> Denominations
Coins.Denomination     NVARCHAR(100)   -- unchanged column, new meaning
```

`Denomination` is no longer the authority. It becomes **what the source said** —
typed by the user, or read out of a QIF, CSV or spreadsheet. `DenominationId` is
the canonical link when one could be established.

**Why both, when the owner's instinct was id-only.** Everything in this app
arrives by import. A QIF security reading `Trade Dollar`, or a spreadsheet column
reading `8 Reales` before Mexico is seeded, resolves to nothing. With an id-only
model that string is *destroyed at import*, and neither the user nor a later
smarter resolver can recover it. Keeping it costs one column.

It also makes the owner's own requirement work properly: delete a denomination
and the coin reads **`Other (8 Reales)`** rather than a bare `Other`. The user
can see what it was and re-map it.

**Display rule, to be implemented in exactly one place:**

```
DenominationId set    -> the denomination's Label  (authoritative)
id null, text present -> "Other (<text>)"
both empty            -> "—"
```

**Write rule:** picking a denomination in the editor sets *both* — the id, and
the label as text. They agree from then on. Only imports and deletions create
the divergent state, and that state is visible in the UI by design.

### 4.2 A new Issuers table, replacing the `Country` string

"Issuer" rather than "Country", because the Roman Republic, the Papal States and
German states are not countries, and ancients are explicitly in scope.

```
Issuers
  IssuerId     INT IDENTITY PK
  Name         NVARCHAR(100)   'Mexico', 'Roman Empire', 'Great Britain'
  IsoCode      CHAR(2) NULL    'MX' where one exists; null for ancients/historical
  Kind         NVARCHAR(20)    'modern' | 'historical' | 'ancient'
  ValidFrom    INT NULL        year, for historical entities
  ValidTo      INT NULL
  SortOrder    INT
  IsActive     BIT

Denominations
  DenominationId  INT IDENTITY PK
  IssuerId        INT NOT NULL FK -> Issuers
  Label           NVARCHAR(100)   '8 Reales', 'Denarius', '50¢'
  FaceValue       DECIMAL(18,6) NULL   for sorting; null where meaningless
  SortOrder       INT
  IsActive        BIT
```

`Coins.Country` stays as it is for now. Re-pointing it at `IssuerId` is a second,
separable migration and bundling the two doubles the risk. The denomination's
issuer is the authoritative one; the coin's country text becomes a display and
search field. **Flagged as deliberate debt**, with a note in the schema.

### 4.3 Seed scope: most-collected issuers plus ancients — *owner's decision*

Roughly 40 issuers and an estimated 800–1,500 denominations, every entry
reviewable:

- **Modern:** US, Great Britain (incl. pre-decimal), Canada, Mexico, Australia,
  New Zealand, Ireland, France, Germany (incl. Empire and the major states),
  Austria, Switzerland, Netherlands, Belgium, Spain, Portugal, Italy (incl.
  Papal States), Scandinavia, Russia, Poland, China, Japan, Korea, India,
  South Africa, Brazil, Argentina, Peru, Chile, Colombia, Israel.
- **Colonial / historical:** Spanish Colonial (the 8 Reales case), British
  Colonial, German States, Italian States, Confederate States.
- **Ancient:** Roman Republic and Empire (As, Dupondius, Sestertius, Denarius,
  Antoninianus, Aureus, Solidus, Follis, Nummus), Greek (Stater, Tetradrachm,
  Drachm, Obol, Hemiobol), Byzantine, Judaea (Prutah, Shekel), Celtic, Persia.

**Accuracy over coverage, explicitly.** Where the author is unsure of a
denomination's existence, dates or spelling, it is left out. A user adding a
missing denomination is a normal action; a user trusting a wrong one that shipped
with the app is a silent error.

The seed is **data, not code** — a `.sql` migration plus a reviewable source
file, so it can be diffed and corrected.

### 4.4 Deleting a denomination that is in use

1. Count the coins using it. Say the number plainly.
2. If confirmed: soft-delete (`IsActive = 0`) and **null the `DenominationId`**
   on those coins. `Denomination` text is untouched.
3. Those coins then display `Other (8 Reales)` per §4.1.
4. Re-selecting a denomination for them re-links; nothing has been lost.

Soft-delete, not hard, matching today's behaviour — and it means a mistaken
deletion is recoverable by reactivating the row.

### 4.5 Catalogue references — a proper field, lookup deferred

Ancients and world coins are identified by catalogue reference far more than by
denomination: `Sear 6819`, `Hendin 1234`, `RIC I 100`, `KM# 110`.

**This already happens, in the wrong place.** `coin-signature.ts` documents a
record whose **`variety`** reads `Sear 6819`, and the matcher already carries 14
catalogue prefixes in `filename-vocabulary.ts` (`sear`, `ric`, `hendin`, `rpc`,
`svoronos`, `bmc`, `sng`, `crawford`, `sydenham`, `cohen`, `rsc`, `meshorer`,
`tjc`, `kraay`). The data is being entered; it has nowhere to go.

```
Catalogs
  CatalogId  INT IDENTITY PK
  Name       NVARCHAR(60)    'Sear', 'Hendin', 'RIC', 'Crawford', 'Krause (KM)'
  SortOrder  INT
  IsActive   BIT

Coins
  CatalogId      INT NULL  FK -> Catalogs
  CatalogNumber  NVARCHAR(50) NULL
```

Maintainable exactly like Denominations — the user adds catalogues the seed
missed. **Seed it from `CATALOG_PREFIXES`**, which is already the list of
catalogues this collection actually uses, plus Krause/KM for world coins.

`NVARCHAR(50)`: generous for `1A`, `6819`, `II.1 234`, `RRC 44/5`, without being
a text area. The input should be sized to the data, not to the column.

**One reference per coin.** Ancients frequently carry several (`RIC 123` *and*
`Cohen 45` *and* `Sear 6819`), so a child table is the eventually-correct model.
Deliberately not now: it multiplies the UI and the matcher work, and one
reference is a large improvement over a free-text `variety`. Recorded as a known
limitation with a clear path.

#### Auto-fill from the reference — deliberately NOT in this change

The owner asked whether entering a catalogue and number could fill in year,
type, denomination and composition. Investigated 2026-11-08; **deferred, on
availability grounds rather than licensing.**

Using a catalogue number as a lookup key is referencing, not reproducing, and
the facts returned are not the catalogue's expression — the owner's position on
that is accepted. The blocker is that the data mostly does not exist in
queryable form:

| Catalogue | Open source | Types |
|---|---|---|
| **RIC** (Roman Imperial) | OCRE via Nomisma, ODC-ODbL | 56,113 |
| **Crawford / RRC** | CRRO, ODC-ODbL | 2,602 |
| Greek (PELLA, Seleucid, Ptolemaic) | ODC-ODbL, **numbering system unconfirmed** | ~19,000 |
| **Sear** | none found | — |
| **Hendin** | none found | — |
| **Krause / KM** | none found | — |

So the two catalogues the owner named first are the two with no source. Also
note `numismatics.org` returns **HTTP 403 to automated requests**; Nomisma's own
host answered, and its SPARQL endpoint is the only realistic route, but that
needs proving with a real query before anything depends on it.

**If it is built later, the shape is a pluggable resolver** tried in order:

1. **Online** — Nomisma SPARQL for RIC and Crawford.
2. **The user's own history** — when a coin is saved with a catalogue reference,
   remember what that reference meant. The next coin with the same reference
   fills itself. After fifty Judaean coins the user has a working Hendin lookup
   that no external source could have provided, and it is exportable — a
   community reference file becomes possible.
3. **Manual** — always available. No source means no auto-fill, never an error.

Whatever fills a field must say where the value came from, and must follow the
same rule as §4.1 of the packaging design: **a visible blank beats a silently
wrong value.**

#### What this buys the matcher

`docs/ancients-matching-plan.md` exists because the matcher cannot identify
ancient coins — they have no year, no denomination and no grade, so three of its
four attributes are absent. A real catalogue field changes that: a filename
reading `Bar Kochba - Hendin 736` could match on the reference alone, which is
exactly how the owner identifies those coins. **Out of scope here**, but this
field is the prerequisite, and that plan should be revisited once it exists.

### 4.5a Adding an issuer: attempt a lookup, fall back to manual

**Owner's decision.** When a user adds an issuer the seed missed, the app should
try to find its denominations rather than hand them an empty list.

Subject to the same honesty rule as §4.5, and the availability picture is the
same: Nomisma's ODbL datasets cover **ancient and Hellenistic** issuers well
(OCRE, CRRO, PELLA, Seleucid, Ptolemaic) and modern world coinage essentially
not at all. So the lookup will succeed for Parthia and fail for Burma.

Three requirements, because a lookup that fails is the normal case here:

1. **Failure is not an error.** "No denominations found for Burma — add them
   below" is a correct outcome, not a problem to report.
2. **Never block.** The issuer is created whether or not the lookup returns
   anything. Manual entry is always available and never feels like the fallback
   path it technically is.
3. **Show the source.** A denomination that arrived from a lookup is marked as
   such, so the user knows which entries they vouched for and which the app
   guessed. They must be editable and deletable like any other.

Build the manual path first and completely; the lookup is an enhancement layered
on top of a screen that already works without it.

### 4.6 The maintenance screen

The current flat list does not survive this. It needs:

- Grouping by issuer, with issuers themselves maintainable.
- Search, because a flat scroll of 1,500 entries is unusable.
- A visible in-use count per denomination, so the consequence of deleting one is
  known before the dialog appears.
- Add/edit/remove for both issuers and denominations.

### 4.7 The editor's denomination picker

Today it filters by the coin's country and falls back to showing everything
grouped (`country-denomination-link.ts`, whose two rules — never show an empty
dropdown, never silently drop the coin's existing value — **both still apply and
must be preserved**).

With 1,500 entries it additionally needs type-ahead. The coin's country should
bias the list, never hard-limit it: a US collector holding one Mexican coin must
be able to find `8 Reales` without first changing the country field.

---

## 5. The migration — the riskiest deliverable

Four steps, in order, each independently verifiable:

1. **Create** `Issuers`, extend `Denominations`, add `Coins.DenominationId`.
   Nothing reads it yet. Entirely reversible.
2. **Seed** issuers and denominations.
3. **Resolve** existing coins: for each distinct `Coins.Denomination` value, find
   the matching denomination and set the id. **Reuse
   `src/app/components/coin-editor-form/denomination-aliases.ts`** — it already
   folds `3CS`/`3¢ Silver`/`Three Cent Silver` onto one key and was built for
   exactly this. Do not write a second alias table.
   - Match within the coin's country first; fall back to **any** issuer.
     The owner's `8 Reales` coins say `United States`, so a country-scoped-only
     match would resolve nothing for precisely the case that prompted this work.
   - An ambiguous match across issuers (two `Crown`s) leaves the id **null**
     rather than guessing. `Other (Crown)` is honest; the wrong country is not.
4. **Report**, do not assume. The migration prints every distinct value it could
   not resolve, with a count. That list is the review artefact.

**`Coins.Denomination` is never written by the migration.** Read-only throughout.
That single rule is what makes every step above recoverable.

---

## 6. Blast radius — what each area needs

| Area | Change |
|---|---|
| **Image matcher** (`coin-signature`, `match-scorer`, `match-vetoes`, `near-match`, `filename-parser`, `sibling-inference`) | **Highest risk.** It compares the coin's denomination text with a filename's parsed denomination. Smallest safe change: resolve the coin's id to its label and feed the *existing* string logic unchanged. Comparing ids on both sides would be better eventually; it is not this change. `denominationsAgree` (generic vs specific — `3¢` agrees with `3CS`) must keep working. |
| **Melt value** (`pm-reference`, `pm-fill`, `metal-inference`) | Must behave **identically**. It looks up `(denomination, country, year)` as strings; feed it the resolved label. Any change here mis-prices metal — verify against the owner's real collection before and after. |
| **QIF / CSV / Excel import** | Write the text as today, then resolve to an id via the alias layer. Unresolved is normal and visible, not an error. |
| **Editor** | Picker per §4.6; sets both fields. |
| **Filters, statistics, reports** | Group by id where set; fall back to text. Statistics must not treat `Other (8 Reales)` and `Other (100 Soles)` as one bucket. |
| **CSV export** | Export the resolved label, so a round-trip re-imports cleanly. |
| **`denomination-sort.ts`** | Can use `FaceValue` where present instead of parsing labels — an improvement, but optional and separable. |

---

## 7. Sequencing

1. Schema + seed, nothing reading it. Verifiable alone.
2. Resolution + migration + the unresolved report. **Stop and review the report
   against the real collection before continuing.**
3. Display and the one resolution helper.
4. Editor picker, then the maintenance screen.
5. Importers.
6. Matcher — last, deliberately, and with the full matcher suite green before and
   after.

**Catalogue references (§4.5) are independent of all of the above** and can be
built in parallel or first: a new `Catalogs` table, two nullable columns on
`Coins`, an editor control, and a maintenance screen that is a near-copy of the
denominations one. Nothing in the denomination work depends on it, and nothing
in it depends on the denomination work. If the denomination migration needs to
pause for review, this is the useful thing to do meanwhile.

---

## 8. Left to the builder

- Whether `Issuers` and the existing `Countries` handling in
  `services/coin-countries.ts` merge or stay separate. They overlap; that file
  already holds canonical spellings and matching patterns built for the QIF
  importer, and a second vocabulary would be a second thing to keep in step.
- The exact seed file format.
- Whether the maintenance screen is a rework of the existing modal or a new one.
- Indexing on `Coins.DenominationId` and `Denominations.IssuerId`.
- How `FaceValue` is expressed for non-decimal systems (⅛ of a dollar, 12 pence
  to a shilling). It may be simplest to leave it null outside decimal currencies
  and keep `denomination-sort.ts` as the authority.
