import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import {
  QuickenImportService,
  QuickenParseResult,
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
  /**
   * Security names the user has explicitly chosen to import anyway.
   *
   * We key overrides by security name rather than record id because every
   * re-parse generates fresh `crypto.randomUUID()` ids -- a record id would
   * stop matching the moment the user pressed Preview again. The security
   * name is the stable identity of the QIF row.
   */
  protected readonly overriddenSecurities = signal<string[]>([]);
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
    const { imported, rejected } = this.applyDetailOverrides(result);
    const filtered = this.applyQifFilters(imported);

    this.importedRecords.set(filtered);
    this.skippedRecords.set(result.skippedRecords); // Sold/transferred coins
    this.rejectedRecords.set(rejected); // Not enough detail to import
    this.quickenWarnings.set(result.warnings);

    return filtered;
  }

  /**
   * Moves any exception the user has chosen to override out of the rejected
   * list and into the import list.
   */
  private applyDetailOverrides(result: QuickenParseResult): {
    imported: QuickenImportRecord[];
    rejected: QuickenRejectedRecord[];
  } {
    const overridden = this.overriddenSecurities();
    if (overridden.length === 0) {
      return { imported: result.importedRecords, rejected: result.rejectedRecords };
    }

    const imported = [...result.importedRecords];
    const rejected: QuickenRejectedRecord[] = [];
    for (const exception of result.rejectedRecords) {
      if (overridden.includes(exception.securityName)) {
        imported.push(exception.record);
      } else {
        rejected.push(exception);
      }
    }
    return { imported, rejected };
  }

  /** User pressed "Import anyway" on an exception row. */
  protected overrideException(securityName: string): void {
    if (!this.overriddenSecurities().includes(securityName)) {
      this.overriddenSecurities.set([...this.overriddenSecurities(), securityName]);
    }
    this.refreshPreview();
  }

  /** User changed their mind about an overridden exception. */
  protected undoOverride(securityName: string): void {
    this.overriddenSecurities.set(
      this.overriddenSecurities().filter(name => name !== securityName)
    );
    this.refreshPreview();
  }

  /** Security names the user has forced into the import, for the UI to list. */
  protected overriddenSecurityNames(): string[] {
    return this.overriddenSecurities();
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
      // A brand new file means any overrides from the previous file no longer
      // apply -- clear them so nothing is imported behind the user's back.
      this.overriddenSecurities.set([]);
      this.refreshQuickenAccounts();

      this.refreshPreview(text);
    } finally {
      this.parsing.set(false);
    }
  }

  protected importQuicken(): void {
    this.importing.set(true);
    // Re-parse rather than trusting the preview signal: the import list is
    // rebuilt from the same choke point that enforces the detail rule, so an
    // under-detailed coin cannot reach the inventory unless it was explicitly
    // overridden.
    const filtered = this.refreshPreview();

    const newCoins: CoinRecord[] = filtered.map((record): CoinRecord => ({
      id: record.id,
      coinType: record.coinType,
      denomination: record.denomination,
      year: record.year,
      category: this.categoryFromQuickenAccount(record.account),
      country: record.country,
      grade: record.grade,
      certCompany: '', certNumber: '',
      variety: record.variety,
      mintMark: record.mintMark,
      composition: '',
      purchaseDate: record.purchaseDate ?? '',
      purchasePrice: record.purchasePrice,
      currentValue: record.currentValue,
      notes: record.notes,
      imagePaths: [], tags: [],
      source: 'quicken',
      hasCacSticker: false,
      pmWeightGrams: record.pmWeightGrams,
      pmPercent: record.pmPercent
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
