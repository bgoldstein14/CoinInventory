import { CsvService } from '../../services/csv.service';
import { InventoryService } from '../../services/inventory.service';
import { heldCoins } from '../../types/collection-status';


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

  /*
   * JSON IMPORT USED TO LIVE HERE. Removed 2026-11-14.
   *
   * `triggerJsonImport()` clicked a hidden <input type="file"> in app.html,
   * and `handleInventoryImportFile()` read the file the user picked. Both
   * were reachable only from Import > JSON, and that menu entry was removed
   * the same day — so the pair, and the input, were unreachable code that
   * no test covered.
   *
   * Export > JSON is unaffected (`downloadInventoryJson`, below).
   * `CoinCollection.importInventoryData(json)` is also untouched and still
   * tested: it is the actual capability, and a future JSON import would
   * call it directly rather than resurrect the DOM plumbing.
   */

  /**
   * Saves the whole inventory as a .json file via a throwaway download link.
   *
   * *** THIS FILE DOES NOT CONTAIN THE PHOTOGRAPHS, AND CANNOT. ***
   *
   * `GET /api/coins` does not carry image payloads, so the records in memory
   * have no `imagePaths` key and neither does this export. Nor could it: a
   * single `JSON.stringify` over inlined base64 photos throws `RangeError:
   * Invalid string length` at around a hundred coins (see
   * server/routes/coins/list-query.ts) — an exception, not a backup.
   *
   * So the honest statement is: this is a backup of the COIN RECORDS. The
   * photographs live in the CoinImages table and a real photo backup is a
   * database backup, or a copy of the original files whose locations are
   * recorded in CoinImages.SourcePath. A JSON export that genuinely carried
   * the photographs would need to stream per coin to a file rather than
   * build one string, which is a separate piece of work.
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

  /**
   * The full CSV backup — EVERY coin, want list and all.
   *
   * Deliberately not filtered by collection status. This file is how a
   * collection moves to another machine, and it carries a Status column of
   * its own, so there is nothing to protect the reader from: dropping the
   * want list would just lose months of work with no warning.
   */
  exportCsv(): void { this.csv.exportCsv(this.inv.inventory()); }

  /**
   * A cut-down CSV aimed at an insurance schedule rather than a full backup.
   *
   * *** ONLY COINS THE OWNER ACTUALLY HAS. ***
   * This is the one export where including a coin that is not in the house is
   * actively harmful rather than merely untidy. A schedule listing want-list
   * coins at the prices he hopes to pay buys cover on property he does not
   * own — a premium paid every year for nothing, and a claim that collapses
   * the first time an adjuster asks to see the coin. Coins still in the post
   * ('ordered') are out for the same reason; coins listed for sale are IN,
   * because they are on the shelf until somebody buys them.
   *
   * The rule itself is `isHeldInCollection()` in types/collection-status.ts,
   * shared with the money totals so the schedule and the valuation can never
   * disagree about what "my collection" means.
   *
   * The filter is applied HERE rather than inside CsvService.exportInsuranceCsv(),
   * which formats whatever list it is handed and should keep doing exactly
   * that. Which coins belong in an insurance schedule is a question about the
   * collection, and this class is where the app answers it.
   */
  exportInsuranceCsv(): void { this.csv.exportInsuranceCsv(heldCoins(this.inv.inventory())); }
}
