import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import {
  QuickenImportService,
  QuickenRejectedRecord
} from '../../services/quicken-import.service';
import { CoinRecord, QuickenImportRecord } from '../../types/coin.model';

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

  protected readonly groupedImportedRecords = computed(() => {
    return this.importedRecords().reduce<Record<string, QuickenImportRecord[]>>((acc, record) => {
      const account = record.account ?? 'Unassigned';
      acc[account] ??= [];
      acc[account].push(record);
      return acc;
    }, {});
  });

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
    const result = this.quickenImportService.parse(text, this.selectedAccounts());
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
    const filtered = this.refreshPreview();

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
