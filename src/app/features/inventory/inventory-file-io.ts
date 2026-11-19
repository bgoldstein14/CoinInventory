import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { heldCoins } from '../../types/collection-status';


/**
 * Exports the whole collection as a file (JSON or CSV download).
 * Created by the App shell, which owns CsvService; the toolbar's Export menu
 * calls into it.
 */
export class InventoryFileIo {
  constructor(
    private readonly inv: InventoryService,
    private readonly csv: CsvService
  ) {}

  /**
   * Saves the inventory as a .json file via a throwaway download link.
   * Contains coin records only, not photos: `GET /api/coins` carries no image
   * payloads, and inlining base64 photos would exceed the max string length.
   * A photo backup is a database backup or a copy of the original files.
   */
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

  /** Full CSV backup of every coin, regardless of status (the file has its own Status column). */
  exportCsv(): void { this.csv.exportCsv(this.inv.inventory(), this.inv.catalogs()); }

  /**
   * Insurance-schedule CSV containing only coins actually held (see
   * `isHeldInCollection()`): want-list and ordered coins are excluded, for-sale
   * coins included. Filtered here so CsvService stays a plain formatter.
   */
  exportInsuranceCsv(): void { this.csv.exportInsuranceCsv(heldCoins(this.inv.inventory())); }
}
