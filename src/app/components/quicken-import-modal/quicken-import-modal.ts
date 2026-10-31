import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import {
  QuickenImportService,
  QuickenRejectedRecord
} from '../../services/quicken-import.service';
import { AmbiguousReading, CoinRecord, QuickenImportRecord } from '../../types/coin.model';

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
  protected readonly skippedRecords = signal<QuickenImportRecord[]>([]); // Sold/transferred coins
  /**
   * Coins the parser refused to import because they carry fewer than 2 of the
   * 3 main details (Year / Coin Type / Denomination). Shown to the user as an
   * "exceptions" list -- never silently discarded.
   */
  protected readonly rejectedRecords = signal<QuickenRejectedRecord[]>([]);
  /* -------------------------------------------------------------------------
   * THERE IS NO "IMPORT ANYWAY" ESCAPE HATCH, AND THERE MUST NOT BE ONE.
   *
   * This modal used to keep an `overriddenSecurities` list letting the user
   * force a record that fails the 2-of-3 rule into the import. It looked like
   * it worked and did not:
   *
   *   - the coin appeared in the grid, so the user thought it had saved;
   *   - but the backend rejects a coin with no denomination outright --
   *         400 {"error":"denomination is required"}
   *     -- so no database row was ever created;
   *   - every later edit then targeted an id the server had never heard of,
   *     which is the "errors when trying to update the details" the owner
   *     reported.
   *
   * The rule is now simply: THE UI MUST NEVER OFFER TO CREATE A COIN THE
   * BACKEND WOULD REFUSE. A record that fails the check is reported in the
   * exceptions panel -- with its raw security name and everything the parser
   * did manage to read, so the user can fix the Quicken name and re-import --
   * and that is the only outcome available.
   * ---------------------------------------------------------------------- */
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

  /* -------------------------------------------------------------------------
   * THE TWO THINGS THE USER CAN DO ABOUT A GUESS.
   *
   * The parser flags a reading it was not sure about (see `AmbiguousReading`
   * in coin.model.ts). The owner asked for three outcomes, and these two
   * signals carry the first two of them; the third -- "fix it later" -- needs
   * nothing here at all, because the coin editor already lets him change a
   * denomination after the import.
   *
   *   1. CHANGE IT NOW   `denominationChoices`, security name -> the
   *                      denomination he picked instead.
   *   2. CANCEL IT       `droppedSecurities`, the names he does not want
   *                      imported at all. His words: "or just cancel the
   *                      match".
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
   * would make the action irreversible from the screen that offered it.
   * ---------------------------------------------------------------------- */
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
      this.denominationChoices()
    );
    const filtered = this.applyQifFilters(result.importedRecords);

    this.importedRecords.set(filtered);
    this.skippedRecords.set(result.skippedRecords); // Sold/transferred coins
    this.rejectedRecords.set(result.rejectedRecords); // Not enough detail to import
    this.quickenWarnings.set(result.warnings);

    return filtered;
  }

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
    // survive this re-parse). What it does NOT do is remove the rows he
    // cancelled -- those stay in the preview, struck through -- so the
    // cancellation is applied here, via `recordsToImport`.
    this.refreshPreview();
    const filtered = this.recordsToImport();

    const newCoins: CoinRecord[] = filtered.map((record): CoinRecord => ({
      id: record.id,
      coinType: record.coinType,
      denomination: record.denomination,
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
      // Composition and metalContent are now worked out during the parse from
      // country + denomination + year (see pm-reference.ts). They used to be
      // hard-coded blank here, which is why every imported coin arrived with
      // an empty Metal and Composition no matter what it was.
      composition: record.composition ?? '',
      purchaseDate: record.purchaseDate ?? '',
      purchasePrice: record.purchasePrice,
      currentValue: record.currentValue,
      notes: record.notes,
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
