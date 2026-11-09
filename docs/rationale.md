# Why the code is the way it is

This is the reasoning behind the design decisions in this project — the
arguments that used to live in long comment blocks in the source files.

The code says *what* happens. The tests say what must *keep* happening. This
document says *why*, and in particular why some obvious-looking alternative was
rejected. Most of what is here is the second kind: a record of roads not taken,
so that nobody has to walk down them again to find out they are closed.

It is not a changelog and not a history of the project. If a decision has since
been reversed, the entry should be rewritten, not annotated.

## How to use it

You do not need to read this to work on the code. Reach for it when you are
about to change something and the existing shape looks wrong or needlessly
complicated — that is exactly the situation these sections were written for.
Several of them exist because the simpler-looking version was tried and caused
data loss.

A handful of source files carry a one-line pointer to the section that explains
them. Everything else is navigable from the contents below.

## Contents

### [Server and database](rationale/server.md)

How the Express/SQL Server side is put together.

- The database layer — why the pool code is defensive, and why no route may reset it
- Images — why the coin list carries none and the grid fetches them one at a time
- `SourcePath` — why the rescue lives on the server rather than the client
- The `imagePaths` payload shape
- Support bundles — why a Desktop file rather than an upload, and a hand-written ZIP rather than a dependency
- Migrations — read-don't-run verification, and why schema and data changes stay in separate files

### [Core services](rationale/services-core.md)

Precious metals, importing, spreadsheets and the inventory store.

- Why the precious-metal data is a table and not a formula
- Why metal inference is a separate, coarser module
- Why one adapter sits between the reference data and a coin record
- Why the importer flags a guess instead of refusing or dropping
- What the importer tolerates, and the few things it refuses
- Why the spreadsheet import became its own subsystem
- Why the inventory store is split into plain helper classes
- Why the statistics module is hand-rolled SVG

### [Image matching and denominations](rationale/image-and-denominations.md)

The photo matcher, the import pipeline, and the denomination reference model.

- Why the matcher is so suspicious
- Numismatics the code depends on
- Filename conventions in this collection
- Silence is a statement — but only about the strike
- Why the strike is its own field and not part of the grade
- The margin gate, disqualified coins, and Tier 3's escape hatch
- How the import came to look frozen, and why it knows where a file came from
- Re-importing a folder; why photos are downscaled
- Denominations — why a coin carries two fields

### [User interface](rationale/ui.md)

Components, the domain model, and the screens.

- The domain model and shared types
- The coin editor
- Reference data, Settings and spot prices
- The inventory grid and detail panels
- Reports and statistics
- Import screens
- Shared state, testing and fixtures

## Two conventions worth knowing before you read

**"Fails open" and "fails closed"** appear throughout. A check that *fails open*
lets the operation continue when it cannot reach an answer; one that *fails
closed* refuses. Which one a given check uses is always a deliberate choice, and
the reasoning is given where it is made.

**A blank is better than a wrong number.** This recurs in the precious-metal
code, the statistics panel and the grid. A figure the app cannot work out is
rendered as an em dash, never as `0`. A wrong number silently looks like a fact;
a blank is visible and the user can fix it.
