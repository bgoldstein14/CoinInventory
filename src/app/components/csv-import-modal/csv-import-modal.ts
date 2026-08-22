import { Component, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InventoryService } from '../../services/inventory.service';
import { CsvService, CSV_MAPPABLE_FIELDS } from '../../services/csv.service';

@Component({
  selector: 'app-csv-import-modal',
  imports: [FormsModule],
  templateUrl: './csv-import-modal.html',
  styleUrl: './csv-import-modal.scss'
})
export class CsvImportModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly csvService = inject(CsvService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();

  readonly csvMappableFields = CSV_MAPPABLE_FIELDS;

  protected readonly csvHeaders = signal<string[]>([]);
  protected readonly csvRows = signal<string[][]>([]);
  protected readonly csvFieldMapping = signal<Record<string, string>>({});

  protected readonly csvPreviewCount = computed(() => this.csvRows().length);

  protected async handleCsvFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const rows = this.csvService.parseCsv(text);
    if (rows.length < 2) return;

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim()));

    this.csvHeaders.set(headers);
    this.csvRows.set(dataRows);
    this.csvFieldMapping.set(this.csvService.autoMapHeaders(headers));
    input.value = '';
  }

  protected updateCsvMapping(csvHeader: string, coinField: string): void {
    this.csvFieldMapping.set({ ...this.csvFieldMapping(), [csvHeader]: coinField });
  }

  protected importCsv(): void {
    const headers = this.csvHeaders();
    const mapping = this.csvFieldMapping();
    const newCoins = this.csvRows().map(row => this.csvService.mapRowToCoin(row, headers, mapping));
    this.inv.addCoins(newCoins);
    this.close();
  }

  close(): void {
    this.csvHeaders.set([]);
    this.csvRows.set([]);
    this.csvFieldMapping.set({});
    this.closed.emit();
  }
}
