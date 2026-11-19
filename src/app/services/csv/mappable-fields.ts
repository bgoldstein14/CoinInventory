 /*
  * The coin fields an import can target. Drives the mapping dropdown,
  * auto-mapping, the Export -> CSV header row and the blank template.
  * A leaf module with no imports, to avoid an import cycle with
  * header-synonyms.ts; csv.service.ts re-exports it.
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
  // All of a coin's references in one cell: "Sear 6819; RIC 123".
  { key: 'catalogRefs', label: 'Catalog References' },
  { key: 'mintMark', label: 'Mint Mark' },
  { key: 'composition', label: 'Composition' },
  { key: 'purchaseDate', label: 'Purchase Date' },
  { key: 'purchasePrice', label: 'Purchase Price' },
   /*
    * The seller (buy-side counterparty; mirror of `Sold To`). Hand-kept
    * spreadsheets often have a Dealer/Seller column; Quicken imports leave this
    * blank (see quicken-import.service.ts). `dealer` is a synonym in
    * header-synonyms.ts. Labelled `Purchased From` because private sales, estates
    * and gifts also apply.
    */
  { key: 'purchasedFrom', label: 'Purchased From' },
  { key: 'currentValue', label: 'Current Value' },
  { key: 'notes', label: 'Notes' },
  /*
   * Status is a closed set of tokens (types/collection-status.ts), validated in
   * mapRowToCoin(). An unrecognised word, a blank cell or a missing column means
   * 'owned'. The export writes the token (`for-sale`); import also accepts the
   * grid labels ("For Sale").
   *
   * Storage is free text, stored as typed. `Album`, `Folder` and `Collection`
   * stay synonyms of Set, not Storage.
   */
  { key: 'collectionStatus', label: 'Status' },
  { key: 'coinSet', label: 'Set' },
  { key: 'storageLocation', label: 'Storage' },
  { key: 'metalContent', label: 'Metal Content' },
  // Grams, not troy ounces (server/migrations/008-weight-to-grams.sql).
  // Old exports headed `Weight (oz)` deliberately don't auto-map: mapping them
  // would import ounces as grams, and converting by header text would
  // double-convert sheets already in grams. The user maps the column by hand.
  { key: 'weight', label: 'Weight (g)' },
  { key: 'soldPrice', label: 'Sold Price' },
  { key: 'soldDate', label: 'Sold Date' },
  // The buyer: part of the "sold" rule (sold date, sold price or buyer).
  { key: 'soldTo', label: 'Sold To' },
   /*
    * Notes about the transaction ("18% buyer's premium"), separate from `notes`,
    * which describes the coin itself. Separate database columns (see
    * server/db/coin-fields.ts); do not merge. Synonyms are kept apart in
    * header-synonyms.ts.
    */
  { key: 'transactionNotes', label: 'Transaction Notes' },
  // Listed so Export -> CSV round-trips and provenance (e.g. 'quicken') is
  // preserved. Unrecognised or blank values fall back to 'csv' (see mapRowToCoin()).
  { key: 'source', label: 'Source' }
];
