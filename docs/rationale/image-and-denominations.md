# Image matching, image import and denominations — the background

This file holds the longer explanations behind three subsystems:
`src/app/services/image-matching/`, `src/app/services/image-import/` and
`src/app/services/denominations/`. It is background reading, not
documentation of the current API — the rules that constrain an edit still live
beside the code they constrain, and the code is the authority wherever the two
appear to differ.

It exists because the same arguments were previously written out in full in
three or four files each. Everything below is the version you would want if
you were new to the codebase and wondered *why on earth* some of these rules
are shaped the way they are.

---

## Why the matcher is so suspicious

A coin photograph identifies itself by its filename and nothing else. The
names are written by a human with a camera, so nearly every rule in
`image-matching/` exists to REFUSE something rather than to accept it:
`IMG_2024` is not a 2024 coin, the "s" in "reverse side" is not a mint mark,
the "25" inside a cert number is not a quarter, and `Stamp - 11 - 3 cent.jpg`
is not a three-cent coin.

The cost model behind that caution is asymmetric and it decides every
judgement call in the subsystem. A photograph the matcher refuses is still
listed, still explained, and still attachable in one click — it costs a
person a few seconds. A photograph attached to the wrong coin is silent, and
in a collection of two thousand photographs it may never be noticed. So the
automated process is deliberately very discriminatory, and the escape hatch
is always manual attachment.

Two consequences are worth stating plainly, because they look like bugs until
you know the reasoning:

- a coin whose ONLY photograph is a slab-label shot is never attached
  automatically;
- a second shot of a proof coin whose filename omits "PF" is refused against
  its own record (see "Silence is a statement" below).

Both were weighed and accepted.

## Numismatics the code depends on

These are facts about United States coinage, not facts about this program.
They are the reason several of the tables are shaped awkwardly.

**The same face value, two different coins.** The mint repeatedly struck two
or three quite different coins at one face value, and the periods overlap, so
a date cannot separate them:

| Face value | Coins | Overlap |
| --- | --- | --- |
| 1¢ | Large Cent 1793–1857 (copper, 28–29mm) / Small Cent 1856– | 1856–57 |
| 3¢ | 3CS "trime" 1851–1873 (silver) / 3CN 1865–1889 (copper-nickel) | 1865–73 |
| 5¢ | Half Dime 1792–1873 (silver, tiny) / Nickel 1866– (copper-nickel) | 1866–73 |
| $1 | Gold Dollar 1849–1889 / Silver Dollar 1794– / Trade Dollar 1873–1885 | 1873–85 |

A denomination FIELD records the face value; a PHOTOGRAPH shows the coin.
They are not the same fact, which is why `reference-tables.ts` has generic
keys standing over specific ones rather than one key per face value.

**The Eagle is two unrelated coin families fifty years apart.** The classic
gold Eagle ($10), Double Eagle ($20), Half Eagle ($5) and Quarter Eagle
($2.50) all end in 1933 with President Roosevelt's gold recall — no US gold
coin was struck for circulation after it. The modern American Gold Eagle
bullion series begins in 1986 in four sizes (1/10 oz $5, 1/4 oz $10,
1/2 oz $25, 1 oz $50). Between 1934 and 1985 there is nothing at all.

That 52-year gap is the only reason reading a year is safe for the Eagle when
it would be reckless for every pair in the table above. Do not generalise the
technique.

**Silver Eagle is a dollar.** The American Silver Eagle (1986–) is one ounce
of silver and worth far more than a dollar in metal, but its FACE VALUE — the
only thing a denomination field records — is one dollar. It is not the $10
gold Eagle and it is not a Morgan. Collapsing it into `eagle` would file a
bullion photograph under a five-figure gold coin.

**Prooflike is not a proof.** PL, DMPL, DPL and "prooflike" describe an
ORDINARY CIRCULATION COIN whose fields came out of the press with a mirror
finish because the dies were fresh. The designation exists precisely to say
"this looks like a proof but is not one", and it is commonest on the Morgan
dollar — which this collection is full of. The obvious implementation,
`text.includes('proof')`, therefore gets it exactly backwards and would
disqualify every PL Morgan from its own record.

**Cameo and deep cameo are different claims.** CAM/CAMEO describe contrast
between a proof's frosted design and its mirrored field; DCAM/UCAM describe a
stronger contrast that holds up over a run of strikes, and a 1960s proof in
DCAM can be worth several times the same coin in plain CAM. Likewise the
copper colour codes RD (full red), RB (red-brown) and BN (brown) are a
hierarchy, not synonyms. The rule of thumb when extending the synonym table:
two spellings belong in one group only when a grading service would print
either of them on the same slab.

## Filename conventions in this collection

The photographs follow a consistent shape, and the parsers are built around
it:

```
1875-CC 20-cent Choice F - Obverse.jpg
1870 1-cent NGC PF65RB - Obverse 2.jpg
1867 3CS - NGC PF65 Cameo - Reverse.jpg
1904 $20 - PCGS MS63 - small.jpg
Caracalla Denarius - Sear 6819 - Obverse.jpg
```

Things worth knowing before editing a parser:

- **A filename cannot contain a forward slash.** It is the path separator, so
  fractions are written "1-2 oz", "1_2 oz" or with the single glyph "½". A
  coin RECORD's columns are ordinary text and do keep their slashes, which is
  why several patterns accept both forms.
- **Directory names are never read.** `baseName()` throws away every path
  component but the last, so a folder called "Early Proofs" cannot make its
  contents look like proofs.
- **Grades are written six ways** — numeric ("MS63"), numeric plus a
  designation ("PF65RB", "PF64Cameo", "PF69 DCAM"), a range ("XF-AU"),
  adjectival ("Choice VF"), signed ("VF+") and bare ("VG") — and tokenizing
  destroys the "+" and the hyphen, so grades are read from the raw string.
- **Trailing markers describe the photograph, not the coin**: Obverse,
  Reverse, Label/Slab, and a variant word (Photo, Orig, Sharpened, Small,
  Large) with an optional shot number. "Photo" is the ORIGINAL full-size
  camera shot and is not a derivative; Small/Orig/Sharpened are alternate
  renderings of a shot you already have.
- **Ancients have no year and no denomination.** They are identified by a
  catalogue citation — "Sear 6819", "RIC 34", "Hendin 736" — and sometimes an
  era date ("67-68 CE"). An era date must never be compared against a mint
  year, or a 67 AD coin would match a record reading 1967.
- **"Price" is deliberately not a catalogue prefix** even though it is the
  standard reference for Alexander tetradrachms: it collides with the
  ordinary English word, and "lot 10 price 5.00" would yield the reference
  "price5".

## Silence is a statement — but only about the strike

The general rule across the matcher is "absence is not agreement", applied in
both directions: an attribute only one side states is left out of the score
entirely, and it can never cause a veto. A second shot that omits the grade,
the service or the variety is ordinary and expected.

The STRIKE is the single carve-out. The proof designation is always written
into both the image file name and the inventory description, so a filename
that says nothing about the strike is not a filename that forgot — it is a
filename about a coin with nothing to say. `detectStrike` therefore resolves
silence to `business` before either signature is built, and a quiet filename
then contradicts a proof record exactly as "MS65" would. The same argument
applies to SP/Specimen.

This rests on a fact about the DATA, not on logic: one person writes all of
these names and all of these records, and writes the designation every time
it is true. It does NOT transfer to the year, the denomination or the coin
type, where real filenames leave the attribute out all the time. Do not
extend the carve-out without separate evidence about how the files are named.

## Why the strike is its own field and not just the grade

`PF65` and `MS65` differ in their base letters, and `compareGrades` already
calls that "different", so it is reasonable to ask why `StrikeKind` exists at
all. The question was settled by measurement rather than argument: across
2,435 plausible pairs (same year, agreeing denomination) in the real
accounts, 89 were disqualified by the strike veto, and for 79 of those (89%)
`compareGrades` said "missing" rather than "different" — because it returns
"missing" the moment either side lacks a grade. You cannot express "absence
is evidence" through a function whose answer for absence is "no evidence".

The other two reasons are smaller but real: a record whose coin type reads
"Proof Gold" with no grade at all, and the prooflike trap, where
`compareGrades('PROOFLIKE', 'MS63')` reports "different" and the strike layer
is what rescues the match.

A related question: why does a strike conflict VETO while a grade conflict
only SCORES? Of the same 2,435 pairs, 802 had `compareGrades` say "different"
and only 10 of those were strike conflicts. The asymmetry is not about proofs
being special; it is about which part of a grade is a statement of fact and
which part is a judgement. The base letters are a fact — a grading service
never prints a proof on an MS label. The number is a judgement, and real
filenames and real records disagree about it constantly ("XF" against "XF45")
because one was typed from memory and the other copied off a slab.

## The margin gate and disqualified coins

The runner-up margin exists to express one idea: "two coins fit this filename
and I cannot tell which it is." It is measured over the coins that SURVIVED
the vetoes, not over the full ranked list, and the worked example is why.

The collection holds five 1861 Three Cent Silver records — one PCGS/CAC PF64
proof and four business strikes (AU, EF, XF, XF45) that differ from it in
nothing but grade. A photo named `1861 3CS - PCGS PF64 - Obverse.jpg` scores
0.88 against the proof and 0.82 against each business strike, because grade
carries the smallest weight in the scorer (0.03). Measured over the full list
the gap is 0.06, under the 0.15 bar, so the auto-match is refused — even
though all four runners-up were already disqualified by the strike veto.

Counting a disqualified coin in the denominator does not make the matcher
careful, it makes it incoherent: it refuses to decide between one coin and
four it has already decided against. Narrowing the set cannot mis-attach
anything, because the only row it can promote is one where exactly one coin
survived every veto and cleared the score and corroboration bars on its own
merits.

## Tier 3's escape hatch

The four-attribute near-match bar (year, coin type, denomination and grade,
all four present and all four agreeing) is strict on purpose. A census over
the real filenames showed what that costs: of 32 files in tier 3, 13 were
genuine junk but 19 were real single-coin photos, and only 2 of those 19 were
wrong matches. The other 17 failed because a piece of information was ABSENT,
not because anything contradicted. The starkest case was
`1881 Morgan Dollar NGC 2599001.jpg`, which the matcher ranks first at 97%
and the bar refuses only because the filename states no grade.

Lowering the bar would move those 17 into tier 2, where each costs a
question, and would drag the 2 genuinely wrong ones along dressed as
plausible suggestions. So the bar stayed exactly where it was and tier 3
gained an opt-in "Attach anyway" panel instead: nothing expands, nothing is
asked, and a row nobody touches contributes nothing to the attach run.

## How the import came to look frozen

The batch import had a progress bar and still read as a hung screen, for two
independent reasons that both had to be fixed:

1. **The indicator did not cover the slow parts.** Picking a folder ran the
   extension filter over ~2,140 File handles with nothing on screen; the
   attach run reported nothing until the first file had been read, decoded and
   downscaled (seconds, for a 46 MB JPEG over SMB); and the longest wait of
   all — Angular building the review screen out of 2,140 finished rows —
   happened after the indicator had already come down.
2. **Setting a signal does not draw anything.** JavaScript is single
   threaded, so a write to `progress` only becomes pixels when the current
   task ends. Setting the matching progress and then running the first
   200-filename chunk in the same task (~1.1 s against a 2,000-coin
   inventory) means the bar's first appearance is already a second late.

Hence the three-beat pattern throughout `batch-import-session.ts` and
`attach-runner.ts`: set the stage, `await yieldToBrowser()`, then do the slow
thing. The middle line is easy to delete and fatal to delete.

There was a third, worse symptom: because `busy()` is derived from
`progress`, the window with no indicator was also a window with the Save
button still live — and an impatient second click ran the entire import
again and wrote every photo twice. That is why `progress` is now set
synchronously, on the click's own tick, before any `await`.

The Save button carries its own label for a related reason: the bar is at the
top of a dialog whose review list runs to hundreds of rows, and by the time
you have scrolled to Save the bar is several screens away. An indicator that
cannot be seen from where the user is standing is not an indicator.

## Why the import knows where a file came from

A browser never tells JavaScript where a file really lives on disk; that is a
deliberate platform rule. A directory picker supplies only
`File.webkitRelativePath`, the path relative to the folder that was picked.
The absolute prefix therefore comes from exactly one place: the base-folder
box the user fills in.

That box must never be seeded with a hardcoded path, and — after a real
incident — must not be seeded with the app's own install directory either. A
wrong base folder does not fail loudly; it stamps every imported row with a
location that resolves to nothing, and you find out ~1,700 rows later when
every photo reports "file is missing". The app's own folder is a
*plausible-looking* path that is **never** the right answer, which is worse
than a blank box because nothing prompts anyone to look at it. It does not
improve when packaged, where it becomes `C:\Program Files\...`.

It also caused a second-order bug worth remembering: when an empty saved
value read as "nothing saved" and fell through to the app folder, CLEARING
THE BOX — the exact thing a user does on discovering the path is wrong —
brought the wrong path straight back on the next open.

Three defences now stand behind the box: a live preview of the finished path
built from the first selected file, a pre-flight existence check against the
disk (`base-folder-check.ts`) that refuses an import where every sampled path
is unreadable, and an empty default that demands attention.

## Re-importing a folder

An append-only, blind attach takes the coin's existing photos, puts the new
ones on the end, and has no way to notice that 290 of the 300 "new" ones are
files it stored last time. Re-importing a folder then re-read, re-decoded and
re-saved everything in it and gave each coin its photos twice.

Two separate things fix it, and they are independent:

- **A choice**, because the program cannot guess the intent. `leave` (the
  default, and the only answer that can neither delete nor duplicate),
  `replace` or `add`.
- **A skip**, because even under `add` a file already on the coin must not be
  attached twice. The comparison is on the ORIGINAL file's absolute path —
  filename is hopeless ("Obverse.jpg" is in every subfolder) and comparing
  image bytes would mean reading the file to decide whether to read it.

Both are evaluated BEFORE a byte is read, which is the point: the cost being
removed is the read, JPEG decode and canvas downscale of a file that can be
46 MB, over SMB, for a photo already held.

The existing source paths are not derivable in the browser —
`CoinRecord.imagePaths` holds only the downscaled `data:` URLs — so they are
fetched in one batched request from `POST /api/coins/image-source-paths`.

## Why photos are downscaled

The share holds 4.2 GB of JPEGs (~2.5 MB average, largest 46 MB). Images are
stored in SQL Server as base64 TEXT, and base64 inflates bytes by 4/3, so
attaching them untouched would mean about 5.6 GB of text in the database for
pictures displayed in a gallery a few hundred pixels wide. Capping the long
edge at 1600 px and re-encoding at JPEG quality 0.85 lands around 250 KB per
photo, so roughly 0.5 GB for ~1,700 photos — an order of magnitude smaller,
at a resolution that still looks sharp full-screen on a 1080p monitor.

## Denominations: why a coin carries two fields

Since migration 011 a coin carries both, and they are allowed to disagree:

- `Coins.DenominationId` — the canonical link. NULL is ordinary, not an error.
- `Coins.Denomination` — what the SOURCE said. Never rewritten by anything.

They diverge in two intended, visible situations: an import whose text
resolved to nothing, and a denomination the user deleted (§4.4 nulls the id
and leaves the text alone).

Both are kept because each answers a question the other cannot. The id says
which coin this is; the text is the only surviving record of what the file or
the user actually wrote, and it is the evidence the photograph filenames
carry. A record typed as "1753 Pillar Dollar (8 Reales)" is photographed as
`1753 Pillar Dollar (8 Reales) - Obverse.jpg` — never as a bare "8 Reales" —
so replacing the text with the label would delete the only words still tying
the photograph to the record.

`Other (8 Reales)` rather than a bare "Other" is the display rule for the
unresolved case: a bare "Other" says something has been lost without saying
what, on a row the user can then do nothing with.

## Denominations: null is a result

`resolveDenomination` answers null rather than guessing whenever more than
one issuer could be meant. Great Britain and Australia both struck a Crown;
the authored seed lists "8 Reales" under six issuers (Mexico, Spain, Peru,
Chile, Colombia and Spanish Colonial) because all six struck one. Inventing
an answer files the coin under a country nobody chose — invisibly, and for
good. `Other (Crown)` is honest; a wrong issuer is not.

The coin's country is a PREFERENCE, not a filter. The QIF parser never set a
country, so Mexican 8-Reales coins are all stored as "United States":
scoping the search to the coin's country would resolve nothing for precisely
the case the design exists to fix. The country breaks ties, and when it
matches nothing the search widens to every issuer.

## Denominations: the cleanup screen

Migration 014's unresolved report is SQL output, and a packaged user will
never see it. Without an in-app equivalent they simply have coins reading
`Other (8 Reales)` with no explanation, no list of which ones and no route to
fixing them.

The screen groups coins by the QUESTION they ask rather than listing them,
because four separate edits for one decision is what makes people abandon a
cleanup half-finished. The grouping key is the alias key of the recorded text
*and the resolution it produces* — the resolution half is the safety
property, because "Penny" is one id under Great Britain and another under
Australia, and grouping on text alone would let one click file the Australian
penny under Great Britain.

## Things that are deliberately NOT done

Each of these looks like an obvious improvement and is not. If you are about
to make one of them, read the comment beside the code first.

- **Do not alias `nickel` or `half dime` to `5c`.** They are generic/specific,
  not equivalent: `five cent` agrees with either, and the two specifics must
  never agree with each other.
- **Do not add bare-digit patterns to `DENOMINATION_RULES`.** "25", "10" and
  "5" alone could be a price, a lot number or part of a date. Digits only
  count with a unit attached.
- **Do not build an `Other (...)` label anywhere but `denomination-display.ts`.**
  A second implementation is a FORK, not a duplicate, and a grep test fails
  the build if one appears.
- **Do not copy the grade comparison back into the scorer.** Two
  implementations of "are these the same grade?" would drift, and the day
  they drifted the scorer would reward a pairing the near-match test refuses.
- **Do not add "copy" to the counterfeit markers.** It is a word the hobby
  uses, and it is also the suffix Windows puts on a duplicated file.
- **Do not add "set" to the multi-coin markers.** The inventory holds many
  records that genuinely are sets, and the files that need catching carry
  "Montage" or are already flagged by the group-shot words.
- **Do not read `coin.imagePaths` to find out what a coin already has.**
  `GET /api/coins` no longer inlines photographs, so the array is absent on a
  freshly loaded coin — and because `add` mode PUTs the complete array, a
  `?? []` fallback does not mean "appended to the wrong place", it means
  DELETED.
- **Do not push the counterfeit filter below `buildCoinSignatures`.** It must
  stay invisible to the automated matcher and entirely ordinary everywhere
  else; the manual search is the escape hatch the whole rule depends on.
- **Do not let the matcher perform the denominations lookup itself.** It is
  handed a snapshot taken once, because `buildRows` matches in chunks of 200
  and a response landing between two chunks would match one folder under two
  sets of rules.
- **Do not run a long `Denominations.Country` value through
  `countryDisplayName`.** That function resolves a place to the modern country
  containing it, which renames three issuers on top of three others and costs
  52 of 457 coins their link.

## A note on testing

Every module in these three directories is a pure function over plain data
wherever it can be, with no Angular, no HTTP and no DOM. That is not
fastidiousness: the unit suite runs under Node with **no jsdom**, so a
template cannot be rendered and a spinner cannot be asserted on. Pulling the
rules out into plain functions is what makes the wording of a progress line,
the width of a bar and the enabled state of a button into ordinary tests.

Collections are DATA, never files. There is no spec file per coin type;
`QIF_ACCOUNTS` in `qif-accounts.fixture.ts` is the list and the suites run
over all of it with `describe.each`. Adding a collection is adding a row to
that table.

Where a test measures the real corpus, it prints rather than asserts the
exact numbers, because they move whenever a rule changes and the useful thing
is seeing the shape and noticing when it lurches. The assertions that do
carry numbers are deliberately loose bounds in the direction that would catch
a regression.
