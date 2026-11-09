 /*
 * mappable-fields.ts — the one list of coin fields an import can target.
 * ---- WHY THIS IS ITS OWN FILE ----
 * This list drives FOUR things at once: the mapping dropdown, the importer's
 * auto-mapping, the Export -> CSV header row, and the blank template. It used
 * to live inside csv.service.ts, which was fine until header-synonyms.ts
 * needed it too -- csv.service.ts imports the synonym matcher and the synonym
 * matcher needs the field list, so the two modules formed an import cycle and
 * the synonym lookup was built while `CSV_MAPPABLE_FIELDS` was still in its
 * temporal dead zone. The symptom is a `ReferenceError: Cannot access
 * 'CSV_MAPPABLE_FIELDS' before initialization` thrown at application start,
 * not at the point of use, which is a thoroughly unpleasant thing to debug.
 *
 * Data in a leaf module with no imports of its own cannot take part in a
 * cycle. csv.service.ts re-exports the symbol, so every existing
 * `import { CSV_MAPPABLE_FIELDS } from '../csv.service'` keeps working.
  */

export const CSV_MAPPABLE_FIELDS: { key: string; label: string }[] = [
  { key: '', label: '(skip)' },
  { key: 'coinType', label: 'Coin Type' },
  { key: 'denomination', label: 'Denomination' },
  { key: 'year', label: 'Year' },
  { key: 'category', label: 'Category' },
  { key: 'country', label: 'Country' },
  { key: 'grade', label: 'Grade' },
  { key: 'certCompany', label: 'Cert Company' },
  { key: 'certNumber', label: 'Cert Number' },
  { key: 'variety', label: 'Variety' },
   /*
   * THE CATALOGUE REFERENCE, IN TWO COLUMNS, AND THEY ARE NOT EQUALS.
   *
   * A coin stores `catalogId` (a foreign key into the Catalogs table) plus
   * `catalogNumber` (free text: "1A", "6819", "II.1 234", "RRC 44/5"). Only
   * the second is meaningful to a human with a spreadsheet.
   *
   * `Catalog Number` IS THE ONE THAT MATTERS. It is free text, so a
   * stranger's column holding `Sear 6819` lands in it harmlessly and ends up
   * somewhere the user can see, search and tidy -- which is already better
   * than where those references live today (the Variety box). Every
   * human-sounding synonym in csv/header-synonyms.ts points here.
   *
   * `Catalog Id` IS HERE ONLY SO THE APP'S OWN EXPORT ROUND-TRIPS, exactly
   * like `source` at the bottom of this list. The integer means something
   * only inside THIS database; carried to another machine it is noise.
   *
   * *** WHY THE LABEL IS `Catalog Id` AND NOT `Catalog`. ***
   * The label is also an exact auto-map target. A column headed `Catalog` in
   * somebody's workbook holds a catalogue NAME ("Sear"), not a row id, and
   * the importer copies a mapped cell VERBATIM -- so that column auto-mapped
   * onto this field would produce `catalogId: "Sear"` on its way to an INT
   * parameter. The server normalises that to NULL rather than failing the
   * save (see server/db/coin-fields.ts), which means the attribution would
   * be lost SILENTLY, under a mapping screen that said it was handled.
   * `Catalog Id` is a phrase nobody writes by accident, and
   * header-synonyms.ts deliberately gives this field no synonyms at all.
   *
   * A file from another database therefore arrives with its `Catalog Id`
   * column unmapped, which is the honest outcome -- the same precedent the
   * `Weight (oz)` and `Dealer` notes below and above set. The reference text
   * still imports, via the number column.
    */
  { key: 'catalogId', label: 'Catalog Id' },
  { key: 'catalogNumber', label: 'Catalog Number' },
  { key: 'mintMark', label: 'Mint Mark' },
  { key: 'composition', label: 'Composition' },
  { key: 'purchaseDate', label: 'Purchase Date' },
  { key: 'purchasePrice', label: 'Purchase Price' },
  { key: 'currentValue', label: 'Current Value' },
  { key: 'notes', label: 'Notes' },
  // A `{ key: 'dealer', label: 'Dealer' }` entry sat here. The coin-level
  // dealer field was removed, and because this one list drives the importer's
  // auto-mapping, the Export -> CSV columns AND the blank template, deleting it
  // here removes the Dealer column from all three at once. An older file that
  // still carries a Dealer column simply has no field to map it onto now, so it
  // is left unmapped and ignored -- the rest of the row imports normally.
  /*
  *
   * The two "how and where do I hold this coin" columns, either side of Set.
   *
   * Status is a CLOSED SET of five tokens (types/collection-status.ts), not
   * free text, and it is the one field in this list besides `source` whose
   * cell value is validated rather than copied -- see the `collectionStatus`
   * branch in mapRowToCoin(). An unrecognised word becomes 'owned', which is
   * also what a blank cell and an absent column mean, so a spreadsheet that
   * has never heard of this feature imports as a collection of coins the
   * owner HAS. That default is the whole safety property of the feature; a
   * file that imported as coins he does not own would be silently worthless.
   *
   * *** THE EXPORT WRITES THE TOKEN, NOT THE LABEL. ***
   * exportCsv() emits `coin[key]` verbatim, so a For Sale coin exports as the
   * cell `for-sale`. That round-trips exactly. The normaliser ALSO accepts
   * "For Sale" and "for sale", which is not for the export's benefit but for
   * the human who types the words he sees in the grid into his own sheet.
   *
   * Storage is the opposite: free text, no validation, no lookup, stored as
   * typed. The label is 'Storage' rather than 'Location' because a sheet
   * being imported usually already has a Country column and "Location" next
   * to it reads as the wrong thing entirely.
   *
   * NOTE ON WHAT WILL *NOT* AUTO-MAP ONTO Storage: `Album`, `Folder` and
   * `Collection` are already synonyms of `Set` in csv/header-synonyms.ts and
   * stay that way. A sheet headed `Album` therefore lands on Set, not here.
   * That is a judgement call rather than an oversight -- those words have
   * meant Set in this app since before Storage existed, and silently
   * re-aiming them would move data between two fields for every user who has
   * mapped such a column before. An unrecognised heading arrives at the
   * mapping screen blank and the user points it where he wants it, which is
   * the precedent the `Weight (oz)` and `Dealer` notes set above.
   */
  { key: 'collectionStatus', label: 'Status' },
  { key: 'coinSet', label: 'Set' },
  { key: 'storageLocation', label: 'Storage' },
  { key: 'metalContent', label: 'Metal Content' },
  // GRAMS, not troy ounces (server/migrations/008-weight-to-grams.sql).
  // Because this one list drives three things at once -- the Export -> CSV
  // header, the blank template, and the importer's auto-mapping -- changing
  // the label here changes all three.
  //
  // *** OLD EXPORTS WILL NOT AUTO-MAP, AND THAT IS THE INTENDED BEHAVIOUR. ***
  //
  // autoMapHeaders() matches a header against each field's key or its label,
  // case-insensitively. A file exported before the switch has a column headed
  // `Weight (oz)`, which matches neither `weight` nor `Weight (g)`, so it
  // arrives at the mapping screen UNMAPPED. (A header of plain `Weight` still
  // maps, via the key.)
  //
  // Two alternatives were considered and rejected:
  //
  //   Recognise `Weight (oz)` and map it straight onto `weight`.
  //     This is the worst option available. The numbers under that header are
  //     troy ounces, so it would import a Morgan dollar as 0.7734 GRAMS -- a
  //     31x understatement that looks entirely plausible, silently, with no
  //     warning anywhere. It is the exact failure the migration exists to
  //     prevent, reintroduced through the back door.
  //
  //   Recognise `Weight (oz)` and multiply by 31.1034768 on the way in.
  //     Arithmetically right, and still rejected: it makes the meaning of a
  //     cell depend on the text in the header, which nobody expects. Somebody
  //     who has already converted their spreadsheet to grams but left the old
  //     header alone would get every weight multiplied by 31 instead, and
  //     there is no way for the importer to tell the two files apart. A
  //     silent 31x error in either direction is worse than a column the user
  //     has to look at.
  //
  // Leaving it unmapped is the honest option, and the cost is small and
  // visible: the mapping screen shows the column with no field chosen, and the
  // user either picks `Weight (g)` by hand (if the numbers are already grams)
  // or fixes the numbers first. Nothing else about the row is affected -- the
  // rest of it imports normally. This is the same precedent the removed
  // `Dealer` column set above: an unrecognised column is ignored, loudly
  // enough to be noticed on the mapping screen, rather than guessed at.
  { key: 'weight', label: 'Weight (g)' },
  { key: 'soldPrice', label: 'Sold Price' },
  { key: 'soldDate', label: 'Sold Date' },
  // `Source` is here so that Export -> CSV actually round-trips. exportCsv()
  // writes a Source column; leaving it off this list makes that column
  // unmappable -- not by auto-mapping and not by hand, because the mapping
  // dropdown is built from this same list -- so the one file advertised as a
  // ready-made template would be the one file with an unmappable column.
  //
  // Importing it also PRESERVES provenance rather than flattening it: a coin
  // that originally came from Quicken stays marked 'quicken' through an export
  // and re-import, instead of every row being relabelled 'csv'. Unrecognised
  // or blank values still fall back to 'csv' -- see mapRowToCoin().
  { key: 'source', label: 'Source' }
];
