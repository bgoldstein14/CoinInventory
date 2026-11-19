import { signal } from '@angular/core';
import { InventoryService } from '../inventory.service';
import { ImageMatchingService } from '../image-matching.service';
import { parsedChips, searchCoins } from './row-decisions';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';

/**
 * CoinLookup — manual coin search for the batch import review screen: coin
 * labels by id, inventory search, and per-photo search box text.
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
   * Display label for a coin id. 'None' for no selection, 'Unknown' for an id
   * no longer in the inventory (e.g. deleted in another tab mid-review).
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
