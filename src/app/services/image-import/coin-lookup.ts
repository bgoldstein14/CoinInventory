import { signal } from '@angular/core';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { parsedChips, searchCoins } from './row-decisions';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';

/**
 * CoinLookup — "which coin is this?", for the batch import review screen.
 *
 * WHY THIS FILE EXISTS
 * When the matcher cannot place a photo, the user has to find the coin
 * himself. That needs three things which have nothing to do with the rest of
 * the import flow:
 *
 *   1. a display label for a coin id ("Morgan Dollar 1881-S"),
 *   2. a free-text search over the inventory,
 *   3. one search box PER unresolved photo, each with its own text.
 *
 * Point 3 is the reason this is a class and not three loose functions: the
 * search text is per-file state that has to survive re-renders. Keeping it
 * here leaves BatchImportSession to worry only about the import itself.
 */
export class CoinLookup {
  /** Per-file search text ("filename" -> "search text"). */
  private readonly searches = signal<Record<string, string>>({});

  constructor(
    private readonly inv: InventoryService,
    private readonly matching: ImageMatchingService
  ) {}

  /** Record what the user typed in one photo's search box. */
  setTerm(fileName: string, term: string): void {
    this.searches.set({ ...this.searches(), [fileName]: term });
  }

  /** Current text in one photo's search box. */
  term(fileName: string): string {
    return this.searches()[fileName] ?? '';
  }

  /** Forget every search box (used when the modal is reset). */
  clear(): void {
    this.searches.set({});
  }

  /** Up to 8 inventory coins matching what was typed for this photo. */
  results(fileName: string): CoinRecord[] {
    return searchCoins(
      this.inv.inventory(),
      this.term(fileName),
      coin => this.matching.describeCoin(coin)
    );
  }

  /**
   * Display label for a coin id.
   * 'None' for no selection, 'Unknown' for an id that is no longer in the
   * inventory (possible if another tab deleted the coin mid-review).
   */
  nameById(coinId: string | null): string {
    if (!coinId) return 'None';
    const coin = this.inv.inventory().find(c => c.id === coinId);
    if (!coin) return 'Unknown';
    return this.matching.describeCoin(coin);
  }

  /** "What we read from the file name", as chips the user can sanity-check. */
  chips(row: BatchImageRow): string[] {
    return parsedChips(row);
  }
}
