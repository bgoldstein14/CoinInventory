import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import { QuickenImportService } from '../../services/quicken-import.service';
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
  protected readonly quickenWarnings = signal<string[]>([]);
  protected readonly quickenAccounts = signal<string[]>([]);
  protected readonly selectedAccounts = signal<string[]>([]);
  protected readonly qifDateFrom = signal<string>('');
  protected readonly qifDateTo = signal<string>('');
  protected readonly qifPriceMin = signal<string>('');
  protected readonly qifPriceMax = signal<string>('');
  protected readonly qifDenominationFilter = signal<string>('');

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

  protected previewImport(): void {
    const result = this.quickenImportService.parse(this.quickenText(), this.selectedAccounts());
    const filtered = this.applyQifFilters(result.importedRecords);
    this.importedRecords.set(filtered);
    this.quickenWarnings.set(result.warnings);
  }

  protected async handleQuickenFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    this.quickenText.set(text);
    this.selectedAccounts.set([]);
    this.refreshQuickenAccounts();

    const result = this.quickenImportService.parse(text, this.selectedAccounts());
    const filtered = this.applyQifFilters(result.importedRecords);
    this.importedRecords.set(filtered);
    this.quickenWarnings.set(result.warnings);
  }

  protected importQuicken(): void {
    const result = this.quickenImportService.parse(this.quickenText(), this.selectedAccounts());
    const filtered = this.applyQifFilters(result.importedRecords);
    this.importedRecords.set(filtered);
    this.quickenWarnings.set(result.warnings);

    const newCoins: CoinRecord[] = filtered.map((record): CoinRecord => ({
      id: record.id, name: record.name, denomination: record.denomination,
      year: null, type: record.type,
      category: this.categoryFromQuickenAccount(record.account),
      country: record.country, grade: 'Unknown', certCompany: '', certNumber: '',
      variety: '', mintMark: '', composition: '',
      purchaseDate: record.purchaseDate ?? '', purchasePrice: record.purchasePrice,
      currentValue: record.currentValue, notes: record.notes,
      imagePaths: [], tags: [], source: 'quicken', hasCacSticker: false
    }));

    this.imported.emit(newCoins);
    this.closed.emit();
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
