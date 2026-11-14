import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import {
  QuickenImportService,
  QuickenRejectedRecord
} from '../../services/quicken-import.service';
import { AmbiguousReading, CoinRecord, QuickenImportRecord } from '../../types/coin.model';
// The ONE resolver, shared with the editor's picker, the CSV/Excel importer
// and (transcribed into T-SQL, with a parity spec over it) migration 014.
import { resolveDenominationId } from '../../services/denominations/denomination-index';
// The wording of the sold rule, taken from the module that implements it so
// the dialog cannot describe a rule the code does not apply.
import { SOLD_RULE_SENTENCE } from '../../services/import-sold';

const unassignedQuickenAccount = 'Unassigned';

@Component({
  selector: 'app-quicken-import-modal',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './quicken-import-modal.html',
  styleUrl: './quicken-import-modal.scss'
})
export class QuickenImportModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly quickenImportService = inject(QuickenImportService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();
  readonly imported = output<CoinRecord[]>();

  protected readonly quickenText = signal<string>('');
  protected readonly importedRecords = signal<QuickenImportRecord[]>([]);
  /** Coins the "only coins not marked Sold" tick box is holding out. Empty
   *  while it is unticked, which is its default. */
  protected readonly skippedRecords = signal<QuickenImportRecord[]>([]);
  /**
   * The security names the QIF says are no longer held -- sold, or
   * transferred out. Populated whether or not they are being imported.
   */
  protected readonly soldSecurityNames = signal<string[]>([]);
  /**
   * "Import only coins I still own."
   *
   * The same tick box, with the same meaning, now sits on the CSV and Excel
   * import too: a record counts as sold when it has a sold date, a sold
   * price or a buyer (services/import-sold.ts). A QIF has none of those as
   * columns, so the parser detects the disposal from the net quantity and
   * then writes the date and proceeds onto the record -- see
   * `QuickenParseOptions.excludeSold`.
   *
   * *** OFF BY DEFAULT, AND THAT IS A REVERSAL. *** This importer used to
   * drop every sold coin unconditionally and never even show the list; over
   * the QIF corpus that is 379 of 484 coin records gone without a word. A
   * coin the owner no longer has is still a coin he had: the cost, the
   * grade and the photographs are the record of a transaction he wants to
   * be able to report on. So the default is "bring everything in", and
   * narrowing to the current holding is the deliberate act.
   *
   * The coins it would hide are not hidden silently -- `skippedRecords`
   * lists them under the preview.
   */
  protected readonly onlyUnsoldCoins = signal(false);

  /** The one sentence, shared with the CSV / Excel dialog so the two cannot
   *  drift apart on what the tick box means. */
  protected readonly soldRuleSentence = SOLD_RULE_SENTENCE;
  /**
   * Coins the parser refused to import because they carry fewer than 2 of the
   * 3 main details (Year / Coin Type / Denomination). Shown to the user as an
   * "exceptions" list -- never silently discarded.
   */
  protected readonly rejectedRecords = signal<QuickenRejectedRecord[]>([]);
  /* THERE IS NO "IMPORT ANYWAY" ESCAPE HATCH, AND THERE MUST NOT BE ONE.
   *
   * THE UI MUST NEVER OFFER TO CREATE A COIN THE BACKEND WOULD REFUSE. The
   * backend rejects a coin with no denomination outright --
   * `400 {"error":"denomination is required"}` -- so a forced record appears
   * in the grid as if it saved, no database row is ever created, and every
   * later edit targets an id the server has never heard of.
   *
   * A record that fails the check is reported in the exceptions panel, with
   * its raw security name and everything the parser did manage to read, so
   * the user can fix the Quicken name and re-import. That is the only
   * outcome available. */
  protected readonly quickenWarnings = signal<string[]>([]);
  protected readonly quickenAccounts = signal<string[]>([]);
  protected readonly selectedAccounts = signal<string[]>([]);
  protected readonly qifDateFrom = signal<string>('');
  protected readonly qifDateTo = signal<string>('');
  protected readonly qifPriceMin = signal<string>('');
  protected readonly qifPriceMax = signal<string>('');
  protected readonly qifDenominationFilter = signal<string>('');
  protected readonly importing = signal(false);
  protected readonly parsing = signal(false);

  /* The two things the user can do about a reading the parser was not sure
   * about (see `AmbiguousReading` in coin.model.ts):
   *
   *   1. CHANGE IT NOW   `denominationChoices`, security name -> the
   *                      denomination they picked instead.
   *   2. CANCEL IT       `droppedSecurities`, the names not to import.
   *
   * ("Fix it later" needs nothing here: the coin editor can change a
   * denomination after the import.)
   *
   * BOTH ARE KEYED ON THE QUICKEN SECURITY NAME, NOT ON `record.id`.
   * `id` is a fresh `crypto.randomUUID()` on every parse, and `refreshPreview`
   * re-parses the text each time -- including one final time inside
   * `importQuicken`, deliberately, so nothing can reach the inventory without
   * passing the parser's rules. A choice keyed on `id` would therefore be
   * forgotten the instant the user pressed Import. The security name survives,
   * and the parser produces exactly one record per distinct security name
   * (its net-quantity map is keyed on it), so it is a true row identity.
   *
   * A DROPPED ROW IS STILL SHOWN, struck through, with an Undo. Hiding it
   * would make the action irreversible from the screen that offered it. */
  protected readonly denominationChoices = signal<Record<string, string>>({});
  protected readonly droppedSecurities = signal<string[]>([]);

  protected readonly groupedImportedRecords = computed(() => {
    return this.importedRecords().reduce<Record<string, QuickenImportRecord[]>>((acc, record) => {
      const account = record.account ?? 'Unassigned';
      acc[account] ??= [];
      acc[account].push(record);
      return acc;
    }, {});
  });

  /**
   * The rows that will actually be imported: everything in the preview minus
   * anything the user cancelled.
   *
   * `importedRecords` deliberately still HOLDS the cancelled rows so the table
   * can show them struck through with an Undo button. This is the list the
   * Import button counts and sends.
   */
  protected readonly recordsToImport = computed(() =>
    this.importedRecords().filter(record => !this.isDropped(record))
  );

  /** How many preview rows carry a reading the parser was not sure about. */
  protected readonly ambiguousCount = computed(
    () => this.importedRecords().filter(record => this.ambiguity(record) !== null).length
  );

  /**
   * The denomination ambiguity on a row, or null when the parse was certain.
   *
   * Looks the entry up BY FIELD rather than taking `ambiguities[0]`, because
   * the list is general: a future parse could flag a coin type on the same
   * record and this cell must not start rendering it.
   */
  protected ambiguity(record: QuickenImportRecord): AmbiguousReading | null {
    return record.ambiguities?.find(a => a.field === 'denomination') ?? null;
  }

  /** True when the user has cancelled this row out of the import. */
  protected isDropped(record: QuickenImportRecord): boolean {
    const key = record.securityName;
    return key !== undefined && this.droppedSecurities().includes(key);
  }

  /** Cancel a row, or put it back. Same button, both directions. */
  protected toggleDropped(record: QuickenImportRecord): void {
    const key = record.securityName;
    if (key === undefined) return;
    const current = this.droppedSecurities();
    this.droppedSecurities.set(
      current.includes(key) ? current.filter(name => name !== key) : [...current, key]
    );
  }

  /**
   * Re-point a flagged row at the other candidate denomination.
   *
   * Remembered against the security name and re-applied after every parse, so
   * the correction survives the re-parse that `importQuicken` performs.
   */
  protected chooseDenomination(record: QuickenImportRecord, denomination: string): void {
    const key = record.securityName;
    if (key === undefined) return;
    this.denominationChoices.set({ ...this.denominationChoices(), [key]: denomination });
    // Re-run the preview so the filters, the grouping and the row itself all
    // see the corrected value immediately.
    this.refreshPreview();
  }

  protected onQuickenTextChange(value: string): void {
    this.quickenText.set(value);
    this.refreshQuickenAccounts();
  }

  protected refreshQuickenAccounts(): void {
    const text = this.quickenText();
    if (!text.trim()) { this.quickenAccounts.set([]); return; }
    const result = this.quickenImportService.parse(text);
    this.quickenAccounts.set(result.accounts);
    if (result.accounts.length > 0 && this.selectedAccounts().length === 0) {
      this.selectedAccounts.set([...result.accounts]);
    }
  }

  protected toggleAccount(account: string): void {
    const next = this.selectedAccounts();
    this.selectedAccounts.set(
      next.includes(account) ? next.filter(a => a !== account) : [...next, account]
    );
  }

  protected toggleAllAccounts(): void {
    const accounts = this.quickenAccounts();
    const selected = this.selectedAccounts();
    this.selectedAccounts.set(selected.length === accounts.length ? [] : [...accounts]);
  }

  /**
   * Re-parses the QIF text and refreshes every preview signal.
   *
   * Preview, file-load and Import all funnel through here so they can never
   * disagree about what is about to be imported.
   *
   * @returns the records that would be imported right now.
   */
  private refreshPreview(text: string = this.quickenText()): QuickenImportRecord[] {
    /* The user's corrections are handed to the PARSER rather than painted
     * onto its output, and that is not a detail. A denomination is not an
     * isolated field: the coin type and all five alloy / weight fields are
     * derived from it (an 1870 three-cent silver is 90% silver weighing
     * 0.75 g; the three-cent nickel of the same year is copper-nickel with no
     * precious metal at all). Overwriting just the denomination in this
     * component would leave a 3CS row still claiming the nickel's
     * composition. Feeding the choice in at the top means every derived field
     * is recomputed by the one code path that knows how. */
    const result = this.quickenImportService.parse(
      text,
      this.selectedAccounts(),
      this.denominationChoices(),
      { excludeSold: this.onlyUnsoldCoins() }
    );
    const filtered = this.applyQifFilters(result.importedRecords);

    this.importedRecords.set(filtered);
    this.skippedRecords.set(result.skippedRecords); // Held out by the tick box
    this.soldSecurityNames.set(result.soldSecurityNames);
    this.rejectedRecords.set(result.rejectedRecords); // Not enough detail to import
    this.quickenWarnings.set(result.warnings);

    return filtered;
  }

  /** The tick box. Re-previews immediately, because it changes the count on
   *  the Import button and a button that lies is worse than no preview. */
  protected setOnlyUnsoldCoins(value: boolean): void {
    this.onlyUnsoldCoins.set(value);
    this.refreshPreview();
  }

  /**
   * Is this preview row a coin the owner has already parted with?
   *
   * Keyed on the security name for the same reason the user's denomination
   * choices and cancellations are: `record.id` is a fresh UUID on every
   * re-parse and the security name is the row's true identity.
   */
  protected isSold(record: QuickenImportRecord): boolean {
    const key = record.securityName;
    return key !== undefined && this.soldSecurityNames().includes(key);
  }

  /** How many rows about to be imported are coins no longer held. */
  protected readonly soldImportCount = computed(
    () => this.recordsToImport().filter(record => this.isSold(record)).length
  );

  protected previewImport(): void {
    this.refreshPreview();
  }

  protected async handleQuickenFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.parsing.set(true);
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder('windows-1252').decode(buffer);
      this.quickenText.set(text);
      this.selectedAccounts.set([]);
      /* A new file is a new set of rows, so the answers the user gave about
       * the LAST file's guesses have to go with it. (The parser would ignore
       * a stale entry anyway -- it only honours a choice for a security it
       * actually flagged -- but leaving them behind would let a Drop silently
       * follow a security name across two different exports.) */
      this.denominationChoices.set({});
      this.droppedSecurities.set([]);
      this.refreshQuickenAccounts();

      this.refreshPreview(text);
    } finally {
      this.parsing.set(false);
    }
  }

  protected importQuicken(): void {
    this.importing.set(true);
    // Re-parse rather than trusting the preview signal: the import list is
    // rebuilt from the same choke point that enforces the 2-of-3 detail rule,
    // so an under-detailed coin cannot reach the inventory by any route.
    //
    // `refreshPreview` re-applies the user's denomination corrections on the
    // way through (they are keyed on the security name precisely so they can
    // survive this re-parse). What it does NOT do is remove the cancelled
    // rows -- those stay in the preview, struck through -- so the
    // cancellation is applied here, via `recordsToImport`.
    this.refreshPreview();
    const filtered = this.recordsToImport();

    /* The lookup is read ONCE for the whole batch. `resolveDenominationId`
     * indexes the list on its ARRAY IDENTITY, so holding the array here
     * means the labels are folded once for the import rather than once per
     * coin. An empty list -- the lookup has not arrived yet -- links nothing
     * and reports nothing, which is the honest outcome and not a reason to
     * delay or refuse the import. */
    const denominations = this.inv.denominations();

    const newCoins: CoinRecord[] = filtered.map((record): CoinRecord => ({
      id: record.id,
      coinType: record.coinType,
      denomination: record.denomination,
      /* The canonical link, written alongside the text above.
       * `record.denomination` -- what the PARSER read out of the Quicken
       * security name -- is kept unchanged; this resolves it to a
       * Denominations row when one can be established.
       *
       * Pass `record.country`, NOT A CONSTANT. The parser reads a country out
       * of the security name where one is named ("1967 Peru 100 Soles") and
       * falls back to this collection's 'United States' default where none
       * is. Both are the right answer FOR THAT COIN, and the resolver needs
       * the real one: the country scopes the search before it widens, so a
       * constant would resolve a Peruvian coin by luck and a Mexican one not
       * at all.
       *
       * NULL IS ORDINARY. An `8 Reales` recorded as 'United States' was
       * struck by six issuers, so it links to nothing, imports normally, and
       * reads `Other (8 Reales)`. Over the whole QIF corpus 449 of 457 coins
       * link; the eight that do not are five genuinely ambiguous values and
       * three coins with no denomination at all. See
       * services/denominations/qif-corpus-denomination-links.spec.ts. */
      denominationId: resolveDenominationId(
        record.denomination,
        record.country,
        denominations
      ),
      year: record.year,
      category: this.categoryFromQuickenAccount(record.account),
      country: record.country,
      grade: record.grade,
      // The grading service comes straight from the parsed security name
      // (e.g. "PCGS" out of "1927 $20 - PCGS MS64"). The certificate NUMBER
      // is still blank on purpose -- Quicken names never carry one.
      certCompany: record.certCompany,
      certNumber: '',
      variety: record.variety,
      mintMark: record.mintMark,
      // Composition and metalContent are worked out during the parse from
      // country + denomination + year (see pm-reference.ts).
      composition: record.composition ?? '',
      purchaseDate: record.purchaseDate ?? '',
      purchasePrice: record.purchasePrice,
      currentValue: record.currentValue,
      /* STRAIGHT FROM THE QUICKEN MEMO (`M`) COLUMN, OR BLANK.
       * The parser writes nothing else into it and neither does this
       * mapping -- see the `notes:` comment in quicken-import.service.ts. */
      notes: record.notes,
      /* SOLD COINS COME IN MARKED SOLD.
       *
       * They import by default now (see `onlyUnsoldCoins`), and importing
       * one as Owned would be worse than not importing it at all: the money
       * totals and the insurance schedule count Owned coins, so a coin the
       * owner sold in 2013 would be added to what his collection is worth
       * and put in front of an insurer. The QIF already says which coins
       * those are -- it is the net-quantity answer -- so the status follows
       * from the file rather than from a guess.
       *
       * This is NOT the thing collection-status.ts forbids. That rule says
       * nothing may derive `collectionStatus` from `soldDate` on an
       * EXISTING record, because a sold date can outlive a sale that fell
       * through and the owner's dropdown must stay the only thing that
       * moves a coin out of his collection. This is a brand-new record
       * being given its initial value from the source document. */
      collectionStatus: this.isSold(record) ? 'sold' : 'owned',
      /* WHEN, AND FOR HOW MUCH -- read off the Sell / SellX / ShrsOut block
       * the parser found, not invented here.
       *
       * These are what make a QIF-imported sold coin satisfy the same rule
       * a CSV row satisfies: "it has a sold date, a sold price or a buyer"
       * (services/import-sold.ts). Without them the importer knew a coin
       * was gone, said so in the status, and left the user with no date to
       * report on and nothing for the next import's filter to key on.
       *
       * Both stay UNDEFINED on a coin still held, and `soldPrice` is also
       * undefined for a transfer between Quicken accounts, which states no
       * amount. Not 0 -- 0 would mean "given away", which is a different
       * and perfectly real thing. */
      soldDate: record.soldDate,
      soldPrice: record.soldPrice,
      imagePaths: [],
      source: 'quicken',
      // Green CAC sticker, also parsed from the security name (e.g.
      // "PCGS/CAC AU58"). Kept as a plain boolean -- the backend binds this
      // to a BIT NOT NULL column, so `undefined` must never reach it.
      hasCacSticker: record.hasCacSticker,
      metalContent: record.metalContent,
      pmWeightGrams: record.pmWeightGrams,
      pmPercent: record.pmPercent,
      // The coin's GROSS weight in grams, worked out during the parse from
      // the same reference row as the four fields above. Left undefined --
      // never 0 -- when the table has no weight for that issue, so the editor
      // shows an honest dash rather than a weightless coin.
      weight: record.weight
    }));

    this.imported.emit(newCoins);
    setTimeout(() => {
      this.importing.set(false);
      this.closed.emit();
    }, 500);
  }

  protected groupedAccountNames(): string[] {
    return Object.keys(this.groupedImportedRecords());
  }

  private applyQifFilters(records: QuickenImportRecord[]): QuickenImportRecord[] {
    const dateFrom = this.qifDateFrom();
    const dateTo = this.qifDateTo();
    const priceMin = this.qifPriceMin() ? Number(this.qifPriceMin()) : null;
    const priceMax = this.qifPriceMax() ? Number(this.qifPriceMax()) : null;
    const denom = this.qifDenominationFilter().trim().toLowerCase();

    return records.filter(r => {
      if (r.purchasePrice < 0 || r.currentValue < 0) return false;
      if (dateFrom && (r.purchaseDate ?? '') < dateFrom) return false;
      if (dateTo && (r.purchaseDate ?? '') > dateTo) return false;
      if (priceMin !== null && r.purchasePrice < priceMin) return false;
      if (priceMax !== null && r.purchasePrice > priceMax) return false;
      if (denom && !r.denomination.toLowerCase().includes(denom)) return false;
      return true;
    });
  }

  private categoryFromQuickenAccount(account: string | undefined): string {
    if (!account || account === unassignedQuickenAccount) return '';
    return account;
  }
}
