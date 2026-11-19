# Why the code is the way it is

The reasoning behind the design decisions in this project. The code says
*what* happens and the tests say what must *keep* happening; these pages say
*why*, and in particular why an obvious-looking alternative was not taken.

This is not a changelog. If a decision is reversed, the entry is rewritten.

For how each feature behaves, see [how-it-works.md](how-it-works.md); for the
module map, see [architecture.md](architecture.md).

## How to use it

You do not need to read this to work on the code. Reach for it when you are
about to change something and the existing shape looks wrong or needlessly
complicated. Several of these rules exist because the simpler version loses
data.

A few source files carry a one-line pointer to the section that explains them.

## Contents

### [Server and database](rationale/server.md)

The Express and SQLite side.

- Where the database file lives, and why every open is idempotent
- The data layer: one handle and one lock, the checks SQLite does not make, why `withDb()` retries once
- Why decimals are REAL, widths are enforced in code, and text compares NOCASE
- The schema version
- Images: why the coin list carries none and the grid fetches thumbnails one at a time
- `SourcePath`: why the rescue lives on the server; the `imagePaths` payload shape
- Original files: why the server streams them, and the security trade-off
- Backup and restore: snapshot pinning, metadata in the copy, no cancel on restore
- Problem reports: a Desktop file rather than an upload, no zip, redaction before writing
- The denomination seed and the Wikidata lookup

### [Core services](rationale/services-core.md)

Precious metals, importing, spreadsheets and the inventory store.

- Why the precious-metal data is a table and not a formula
- Why metal inference is a separate, coarser module
- Why one adapter sits between the reference data and a coin record
- Why the importer flags a guess instead of refusing or dropping
- What the importer tolerates, and the few things it refuses
- Why the spreadsheet import became its own subsystem; header synonyms
- Why the inventory store is split into plain helper classes; drafts; photos; failure stages
- Cached denomination index, HTTP retries, IndexedDB keys
- Why the statistics module is hand-rolled SVG

### [Image matching and denominations](rationale/image-and-denominations.md)

The photo matcher, the batch image import, and the denomination model.

- Why the matcher is so suspicious
- Numismatics the code depends on; filename conventions in this collection
- Silence is a statement, but only about strike and authenticity
- Why the strike is its own field and not part of the grade
- Why the score is damped; the margin gate and disqualified coins; Tier 3's escape hatch
- Sibling inference and photo sets: containment versus equality
- Two kinds of "not a coin"
- Progress and double-click safety; why the base folder has no default
- Re-importing a folder; sequential attach; why photos are downscaled
- Denominations: two fields, null as a result, the cleanup screen
- Things that are deliberately not done

### [User interface](rationale/ui.md)

Components, the domain model and the screens.

- The domain model and shared types; collection status
- The coin editor
- Reference data, Settings and spot prices
- The inventory grid and detail panels
- Reports and statistics
- Import screens
- Shared state, testing and fixtures

## Two conventions worth knowing before you read

**"Fails open" and "fails closed"** appear throughout. A check that *fails
open* lets the operation continue when it cannot reach an answer; one that
*fails closed* refuses. Which one a check uses is always a deliberate choice,
and the reason is given where it is made.

**A blank is better than a wrong number.** A figure the app cannot work out is
rendered as an em dash, never as `0`. A wrong number looks like a fact; a blank
is visible and the user can fix it.
