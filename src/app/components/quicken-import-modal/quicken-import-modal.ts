import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import {
  QuickenImportService,
  QuickenRejectedRecord
} from '../../services/quicken-import.service';
import { AmbiguousReading, CoinRecord, QuickenImportRecord } from '../../types/coin.model';
// Shared denomination resolver (also used by the editor picker and CSV/Excel import).
import { resolveDenominationId } from '../../services/denominations/denomination-index';
// Shared wording, so the dialog always describes the rule the code applies.
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
  /** Coins held out by the "only coins not marked Sold" tick box; empty while unticked. */
  protected readonly skippedRecords = signal<QuickenImportRecord[]>([]);
  /** Security names the QIF says are no longer held (sold or transferred out). */
  protected readonly soldSecurityNames = signal<string[]>([]);
  /**
     * "Import only coins I still own." Off by default so sold coins keep their
     * history; held-out coins are listed in `skippedRecords`. A QIF has no sold
     * columns, so the parser detects disposal from net quantity
     * (see `QuickenParseOptions.excludeSold`).
     */
  protected readonly onlyUnsoldCoins = signal(false);

  /** Shared with the CSV / Excel dialog. */
  protected readonly soldRuleSentence = SOLD_RULE_SENTENCE;
  /** Records rejected for having fewer than 2 of Year / Coin Type / Denomination; shown as exceptions. */
  protected readonly rejectedRecords = signal<QuickenRejectedRecord[]>([]);
  /* No "import anyway" option: the backend rejects a coin with no denomination,
     * so a forced record would appear saved but never exist. Rejected records are
     * reported so the user can fix the Quicken name and re-import. */
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

  /* User decisions on uncertain readings (see `AmbiguousReading`): a replacement
     * denomination, or a cancelled row. Both are keyed on the security name, not
     * `record.id`, because ids are regenerated on every parse (including the
     * final one in `importQuicken`). Dropped rows stay visible, struck through, with Undo. */
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
     * Rows that will actually be imported: the preview minus cancelled rows
     * (`importedRecords` keeps them so they can be shown struck through).
     */
  protected readonly recordsToImport = computed(() =>
    this.importedRecords().filter(record => !this.isDropped(record))
  );

  /** How many preview rows carry a reading the parser was not sure about. */
  protected readonly ambiguousCount = computed(
    () => this.importedRecords().filter(record => this.ambiguity(record) !== null).length
  );

  /**
     * The denomination ambiguity on a row, or null. Looked up by field rather
     * than `ambiguities[0]` so other flagged fields are not rendered here.
     */
  protected ambiguity(record: QuickenImportRecord): AmbiguousReading | null {
    return record.ambiguities?.find(a => a.field === 'denomination') ?? null;
  }

  /** True when the user has cancelled this row out of the import. */
  protected isDropped(record: QuickenImportRecord): boolean {
    const key = record.securityName;
    return key !== undefined && this.droppedSecurities().includes(key);
  }

  /** Cancel a row, or put it back. */
  protected toggleDropped(record: QuickenImportRecord): void {
    const key = record.securityName;
    if (key === undefined) return;
    const current = this.droppedSecurities();
    this.droppedSecurities.set(
      current.includes(key) ? current.filter(name => name !== key) : [...current, key]
    );
  }

  /** Re-point a flagged row at another denomination; survives the re-parse on import. */
  protected chooseDenomination(record: QuickenImportRecord, denomination: string): void {
    const key = record.securityName;
    if (key === undefined) return;
    this.denominationChoices.set({ ...this.denominationChoices(), [key]: denomination });
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
     * Re-parses the QIF text and refreshes every preview signal. Preview, file
     * load and Import all go through here so they agree.
     * @returns the records that would be imported right now.
     */
  private refreshPreview(text: string = this.quickenText()): QuickenImportRecord[] {
    /* Corrections go into the parser rather than onto its output, because coin
         * type, composition and weight are all derived from the denomination. */
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

  /** The tick box. Re-previews so the Import button count stays accurate. */
  protected setOnlyUnsoldCoins(value: boolean): void {
    this.onlyUnsoldCoins.set(value);
    this.refreshPreview();
  }

  /** True when the coin is no longer held. Keyed on security name, like the user's choices. */
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
      /* A new file means new rows, so clear choices made for the previous file. */
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
    // Re-parse through the same path that enforces the 2-of-3 detail rule.
        // Denomination corrections are re-applied there; cancellations are applied
        // here via `recordsToImport`.
    this.refreshPreview();
    const filtered = this.recordsToImport();

    /* Read once: the resolver indexes the list by array identity. An empty list
         * (not loaded yet) just links nothing. */
    const denominations = this.inv.denominations();

    const newCoins: CoinRecord[] = filtered.map((record): CoinRecord => ({
      id: record.id,
      coinType: record.coinType,
      denomination: record.denomination,
      /* Canonical denomination link; `record.denomination` keeps the parsed text.
             * Pass the record's own country, since the resolver scopes by country.
             * Null (no unambiguous match) is normal and imports as "Other (...)". */
      denominationId: resolveDenominationId(
        record.denomination,
        record.country,
        denominations
      ),
      year: record.year,
      category: this.categoryFromQuickenAccount(record.account),
      country: record.country,
      grade: record.grade,
      // Grading service comes from the security name; Quicken names never carry a cert number.
      certCompany: record.certCompany,
      certNumber: '',
      variety: record.variety,
      mintMark: record.mintMark,
      // Derived during the parse from country + denomination + year (see pm-reference.ts).
      composition: record.composition ?? '',
      purchaseDate: record.purchaseDate ?? '',
      purchasePrice: record.purchasePrice,
      currentValue: record.currentValue,
      // Quicken memo (`M`) column only, or blank.
      notes: record.notes,
      /* Sold coins import as Sold so they are not counted in totals or the insurance
             * schedule. Setting the initial status of a new record from the source file
             * is allowed; collection-status.ts only forbids deriving it on existing records. */
      collectionStatus: this.isSold(record) ? 'sold' : 'owned',
      /* From the Sell / SellX / ShrsOut block. Undefined for coins still held, and
             * soldPrice is undefined (not 0) for transfers, which state no amount. */
      soldDate: record.soldDate,
      soldPrice: record.soldPrice,
      imagePaths: [],
      source: 'quicken',
      // Parsed from the security name (e.g. "PCGS/CAC AU58"). Must be a boolean:
            // the backend column is BIT NOT NULL.
      hasCacSticker: record.hasCacSticker,
      metalContent: record.metalContent,
      pmWeightGrams: record.pmWeightGrams,
      pmPercent: record.pmPercent,
      // Gross weight in grams; undefined (never 0) when the reference has no weight.
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
