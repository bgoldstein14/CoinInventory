# Image import: photo sets, and fakes back in the matcher

Approved 2026-11-18. Small change.

## Intent

When photos do not attach automatically, the several shots of one coin
(Obverse, Reverse, slab Label, numbered retakes, Small/Orig renderings) must
not each need their own click. One decision covers the set; the user can still
see which shots the set contains.

Separately, the owner reversed the counterfeit policy: fakes are coins like
any other. The "FAKE / Counterfeit / Replica" wording ends up in the record's
Variety field (the Quicken importer already puts it there).

## Goals

- A **photo set** = files whose identifying words are identical once the
  photo words (side, variant) and the shot number are removed. Order of words
  does not matter. Same rule the sibling-inference stage uses for "which
  words identify the coin", but equality instead of containment (a UI
  grouping must never merge two coins).
- **Not imported** table: one row per set, showing the shared descriptor and a
  chip per shot (`Obverse`, `Reverse #2`, `Label`, `Obverse · Small`).
  "Attach anyway" and Undo act on every file in the set.
- **Near matches**: Attach or "pick another" on one photo also settles the
  still-waiting photos of the same set, including set members that landed in
  the Not imported list (typically the slab label). Skip stays per photo.
- **Fakes**: no longer excluded from the automated import; fake inventory
  records rejoin the candidate pool. New hard veto: a photo that says
  fake/counterfeit/replica never matches a record that does not, and vice
  versa. Absence of the word means genuine, on both sides -- the same
  "silence is a statement" carve-out the strike veto uses, justified the same
  way (the owner always writes the word when it is true).

## Non-goals

- No change to the near-match bar or the auto-attach gates.
- Multi-coin shots stay excluded exactly as before.
- No change to how tier 1 (matched) is grouped.

## Approaches considered

1. **Group in the UI by a set key (chosen).** Pure function over the parsed
   filename; no matcher change; decisions fan out over the set.
2. Make sibling inference place tier-3 siblings automatically. Rejected: it
   attaches without a click, which is what the strict bar exists to prevent.
3. Store the key on every row. Rejected: churns every hand-built test row for
   no gain; it is cheap to compute.
