import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';

/** DOM id of the hidden <input type="file"> at the bottom of app.html. */
const jsonImportInputId = 'inventory-json-import-input';

/**
 * InventoryFileIo — reading and writing the whole collection as a file.
 *
 * WHY THIS FILE EXISTS
 * Getting data in and out of the browser is all awkward DOM plumbing: there is
 * no "open file" API, so importing means clicking a hidden file input, and
 * saving means building a Blob and clicking an invisible link. None of that is
 * about the layout of the page, so it does not belong in the App shell.
 *
 * The App shell creates one of these (it needs CsvService, which only it has)
 * and the toolbar's Import/Export menus end up here.
 */
export class InventoryFileIo {
  constructor(
    private readonly inv: InventoryService,
    private readonly csv: CsvService
  ) {}

  /**
   * There is no "open file" API, so JSON import works by programmatically
   * clicking the hidden <input type="file"> that lives in app.html.
   */
  triggerJsonImport(): void {
    const input = document.getElementById(jsonImportInputId) as HTMLInputElement | null;
    input?.click();
  }

  /**
   * Handles the file the user picked. The input's value is cleared afterwards
   * so that picking the *same* file again still fires a change event.
   */
  handleInventoryImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    file.text().then(text => { this.inv.importInventoryData(text); input.value = ''; });
  }

  /** Saves the whole inventory as a .json file via a throwaway download link. */
  downloadInventoryJson(): void {
    const payload = JSON.stringify(this.inv.inventory(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'coin-inventory.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  exportCsv(): void { this.csv.exportCsv(this.inv.inventory()); }

  /** A cut-down CSV aimed at an insurance schedule rather than a full backup. */
  exportInsuranceCsv(): void { this.csv.exportInsuranceCsv(this.inv.inventory()); }
}
