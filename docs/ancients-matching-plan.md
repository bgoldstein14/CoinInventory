# Matching photographs to ancient coins — a plan, not yet built

**Status: deferred.** Written 2026-10-17 at the owner's request — *"Let's not worry
about ancients for now, maybe just create a future plan for them."* Nothing in
this document is implemented. It exists so the reasoning behind it is not lost,
because most of it came from the owner and could not be recovered from the code.

**Who this is for:** whoever picks the work up later. It assumes you have read
`README.md`'s "Batch image import" section and have looked at
`src/app/services/image-matching/`, but it does not assume you know anything
about ancient coins.

---

## Why the existing matcher cannot do this

The matcher identifies a coin from four attributes — **year, coin type,
denomination and grade** — and the near-match tier requires all four to be
present and to agree. For a US coin that is reasonable: the year is stamped on
it, the denomination is one of a short known list, and it is usually slabbed
with a numeric grade.

An ancient coin supplies almost none of that.

| Attribute | Why it is unavailable |
|---|---|
| **Year** | `MIN_COIN_YEAR` in `matching-thresholds.ts` is **1600**, so any earlier date is discarded as implausible. A first-century coin therefore contributes no year at all — and BC dates, reign spans and approximations like `c. 103-76 BC` are not four-digit years in the first place, so they would not parse even if the floor were lowered. |
| **Denomination** | `DENOMINATION_RULES` has no vocabulary for prutah, drachm, tetradrachm, denarius, antoninianus, follis and the rest. Denomination contributes nothing in either direction — it cannot confirm a match and cannot veto one. (The seeded *British* denominations have exactly the same gap; see the note at the end.) |
| **Grade** | Ancients are frequently raw, or slabbed with descriptive grades rather than the numeric Sheldon scale the grade parser is built around. |

Three of the four attributes are therefore silent, so the four-attribute test can
essentially never pass and every ancient photograph lands in the read-only
skipped tier — regardless of how good the actual evidence is.

**This is the key point: ancients need their own route through the matcher, not
a loosening of the existing one.** Relaxing the general rules to accommodate
them would weaken identification for the several hundred US coins that work
well today, which is the opposite of the owner's standing instruction that
*"the automated process should be very descriminatory."*

---

## What the owner says identifies an ancient coin

Two things, both from him directly.

### 1. The catalog number — decisive

> "the Notes section of the coin details will likely be useful for matches as
> the catalog number such as a Hendon number or Seer number should be in the
> notes as well as the image description to aid with matches. If that catalog
> ID matches from inventory to image, then assume you have a match. The Hendon
> and Seer number might not preface themselves with the type of catalog
> identifier just the identifier itself."

So a catalog identifier appearing on **both** sides should be treated as proof
of identity — the same weight the scorer already gives a matching certification
number, which it treats as near-conclusive.

Two things make this harder than it sounds:

- **The record's `Notes` field is not currently read at all.** `parseCoin` in
  `coin-signature.ts` builds its signature from the structured columns. Notes
  would be a new evidence source, and it is free text of unbounded length.
- **The identifier may be bare.** "Might not preface themselves with the type of
  catalog identifier just the identifier itself" means the note may read `1234`
  rather than `Hendin 1234`. Matching bare numbers across two free-text fields
  is exactly the kind of rule that produces confident wrong answers — a bare
  four-digit number is indistinguishable from a year, and could also collide
  with a cert number, a price, or a lot number.

### 2. The type description

> "Other things for ancients can help with identifying, most likely the Type
> description."

Ancient coin types are descriptive and distinctive in a way US types are not —
the text itself carries the identity. The matcher already compares
`coinTypeTokens` with `diceSimilarity`, so the mechanism exists; what changes is
that for ancients it would be carrying most of the weight rather than
supporting the year and denomination.

---

## Suggested shape

Offered as a starting point, not a specification.

1. **Detect that a coin is ancient** rather than applying this path to
   everything. Candidate signals: a catalog reference in Notes, a denomination
   the tables do not recognise combined with a missing year, or an explicit
   category. Decide this deliberately — the path must not capture an ordinary
   US coin whose filename happens to be sparse.

2. **Parse catalog references from Notes and from the filename** into a
   comparable form. Accept the prefixed forms first, since they are
   unambiguous, and treat a bare number as a candidate only when the other side
   carries one too.

3. **A catalog match short-circuits to a confident match**, in the manner of the
   existing certification-number handling in `match-scorer.ts`.

4. **Otherwise fall back to type-description similarity**, with a bar high
   enough to be meaningful given that nothing else is corroborating it.

5. **Leave the four-attribute near-match test alone.** Ancients should bypass
   it, not dilute it.

### Guards worth building in from the start

- A bare number equal to the coin's own year is a date, not a catalog
  reference.
- A bare number matching something already consumed as a cert number, a price
  or a grade should not be reused as a catalog reference.
- Require a minimum number of digits before a bare number counts at all.
- When two ancient coins in the inventory share a catalog number, refuse rather
  than choose — the standing rule.

---

## Open questions for the owner

These were asked and not yet answered; the work should not start without them.

1. **Catalog spellings.** The standard references are almost certainly
   **Hendin** (David Hendin, *Guide to Biblical Coins*) and **Sear** (David
   Sear, *Greek/Roman Coins and Their Values*); he wrote "Hendon" and "Seer",
   which may be how he types them. Any implementation should accept both
   spellings of each plus the common `S.` short form. **Does he use other
   catalogs** — RIC, RPC, SNG, Crawford, BMC?

2. **A real example pair.** One actual `Notes` value and the filename of one of
   that coin's photographs would settle the format question completely: whether
   the number is prefixed, bare, or sometimes each; how many digits his
   references run to; and what else numeric shares the field.

3. **How he records ancient dates.** `c. 103-76 BC`? `1st century AD`? A
   reign? Blank? Today anything before 1600 is discarded silently, so if he
   does record dates they are currently being thrown away, and it is worth
   knowing whether they could be made useful instead.

---

## Related gap, same shape, also unbuilt

The **British** denominations seeded in `server/setup-database.sql` —
`Farthing`, `½d`, `3d`, `1/-`, `2/6 (Half Crown)`, `£1`, `Sovereign`,
`½ Sovereign` and the rest — are likewise absent from `DENOMINATION_RULES`, so
denomination contributes nothing for any GB coin either. That is missing
vocabulary rather than a design problem, and it is a smaller job than the
ancients path, but the two are worth considering together: both are cases where
the matcher's US-centric assumptions quietly reduce it to guessing from year
and type alone.
